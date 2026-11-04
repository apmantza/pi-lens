/**
 * #5231: every spawn site is pinned to the install kill switch, or classified.
 *
 * ## The recurrence this guards
 *
 * `PI_LENS_DISABLE_TOOL_INSTALL=1` was read by the managed installer only. The
 * lazy installer (`gem install rubocop`, `rustup component add`) and
 * govulncheck's `go install` checked project trust and spawned anyway, and
 * Biome's presence probe ran `npx @biomejs/biome --version` with no spawn
 * options, so the registry saw a download with the switch set. The `#1759 F2`
 * comment in `clients/installer/index.ts` records the same shape one layer up:
 * a kill switch skipped by another install path. Guarding callers one at a
 * time cannot converge.
 *
 * The first version of this census enumerated installer SPELLINGS (`install`,
 * `rustup`, shell lines). Review found the next spelling twice running (`npm
 * i`, `go get`, a parenthesised concatenation, a `\x69` template, `inst${""}all`,
 * `String.fromCharCode`), the "second round finds a new spelling" trigger of
 * defect shape 34/69, so it was redesigned instead of patched.
 *
 * ## Fail closed: the population is every spawn, not every installer word
 *
 * A start is a call into the spawn seam (`safeSpawn`, `safeSpawnAsync`,
 * `safeSpawnBatch`, `probeToolAsync`, `spawnCollectStdoutResult`) or into a
 * FORWARDER of it. `tests/config/spawn-chokepoint-sweep.test.ts` already
 * proves the other half: every raw `node:child_process` start in the runtime
 * is one of its admitted sites (the chokepoint's own children and fixed
 * `taskkill`/process-table literals), so the seam's callers ARE the population.
 *
 * Review r2 found the next gap one level down: only argv[0] was judged, so
 * `go vet -exec "curl x | sh"`, `git -c core.pager="npm i x" log` and
 * `powershell.exe -NoProfile -Command "npm i x"` passed. Every argv element is
 * now judged against the command's own inert-word set.
 *
 * ## STATE TABLE (written before the detector)
 *
 * | form of a seam call                                    | read as            |
 * | ------------------------------------------------------ | ------------------ |
 * | command literal in KNOWN_GOOD, argv an array literal   | clean (no hit)     |
 * |   whose EVERY element is a word in that command's set  |                    |
 * | command literal not in KNOWN_GOOD (`npm`, `gem`, `sh`, | HIT                |
 * |   `env`, `powershell.exe`, ...)                        |                    |
 * | command in KNOWN_GOOD, any element (any position) a    | HIT                |
 * |   word outside its set (`get`, `-exec`, `-c`, `-Command`)|                  |
 * | command computed (variable, call, member, `${}`        | HIT                |
 * |   template, `String.fromCharCode`, `process.env`)      |                    |
 * | argv absent or not an array literal, or any element    | HIT (known-good    |
 * |   computed or spread                                   | command only)      |
 * | concatenated, parenthesised or escaped literal         | folded, then read  |
 * |                                                        | as a literal       |
 * | a seam name read any other way (alias, `const sp =`,   | HIT (reference)    |
 * |   passed as a value, `.call`, object key, string name)|                    |
 * | a function whose parameter reaches a seam's command    | a FORWARDER: its   |
 * |   (found by fixpoint, by name)                         | callers are sites  |
 * | everything else                                        | HIT: not admitted  |
 *
 * A call of a forwarder is judged only when its command is a literal; a
 * computed one inherits the forwarder's own (registered) site.
 *
 * Every hit is ACCOUNTED: its `file#callee` row pins the exact number of hits
 * (`rel#callee@N`), so a new site, a removed site and a stale row each red. A
 * row is GATED (the file's entry functions are verified to consult the shared
 * check before their first spawn token, on comment-and-string-blanked text) or
 * carries a reason.
 *
 * ## Stated bounds
 *
 * - Names are matched by NAME, not by binding resolution. A same-named
 *   unrelated function can add a hit (over-closed); it cannot hide one.
 * - A computed command at a registered site is admitted once for every value
 *   that can reach it. The census proves a new site cannot appear unclassified,
 *   not that every value reaching an old site is benign; the value-level
 *   guarantee for package runners is the seam itself (`getSpawnEnvironment`
 *   sets `npm_config_offline` for `npx` under the switch), pinned below.
 * - A file is parsed when it spells a seam name, a seam module
 *   (`safe-spawn`, `tool-probe`, `child-unref`) or any escape. A specifier built
 *   at run time (`import(name)`) is not a literal and no reader of source sees
 *   it. A forwarder is followed only as a bare `name(` call and not through an
 *   escaped spelling.
 * - `scripts/` (build and smoke tooling) is not shipped runtime.
 */

import * as path from "node:path";
import type { SgNode } from "@ast-grep/napi";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { parseNodes } from "../support/ast-census.js";
import { cookedIdentifier, cookedString } from "../support/cooked-literal.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	matchingCloseIndex,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const RUNTIME_ROOTS = ["clients", "tools", "mcp"] as const;

/** The spawn seam: every runtime start that is not a chokepoint-internal child. */
const SEAMS: readonly string[] = [
	"probeToolAsync",
	"safeSpawn",
	"safeSpawnAsync",
	"safeSpawnBatch",
	"spawnCollectStdoutResult",
];

/**
 * The modules that export the seams. A file reaches a seam only by importing
 * its module, so one that spells the module is parsed even when it never
 * spells a seam name whole (`ns["safe" + "SpawnAsync"]`).
 */
const SEAM_MODULES: readonly string[] = [
	"child-unref",
	"safe-spawn",
	"tool-probe",
];

/**
 * Commands whose literal use cannot install anything, each with the argv
 * WORDS it admits. A call is clean only when every argv element is a literal
 * in its command's set; a command not named here, a word outside the set at
 * any position, or a computed element is a hit, so the table holds known-good
 * forms only and a new spelling can never pass.
 *
 * A word joins a set only when it is a fixed token that is neither an
 * install, fetch or run verb nor an option taking a value (unless that value
 * is itself a set word). A nested-command carrier (`-c`, `-C`, `-e`, `-x`,
 * `-exec`, `--exec`, `-Command`, `/c`, `--config`, `--upload-pack`) is never
 * one: its payload is a command. Each word is one a live site spells; a site
 * with a computed operand is a classified row, never a wider set.
 */
const KNOWN_GOOD: Readonly<Record<string, readonly string[]>> = {
	brew: ["--prefix", "ast-grep"],
	cargo: [
		"--version",
		"clippy",
		"--fix",
		"--allow-dirty",
		"--allow-staged",
		"-q",
	],
	cl: [],
	dart: ["--version", "fix", "--apply"],
	dotnet: ["csharpier", "--version"],
	gh: ["auth", "token"],
	git: [
		"--exclude-standard",
		"--ignored",
		"--is-inside-work-tree",
		"--name-only",
		"--no-renames",
		"--others",
		"--porcelain",
		"--short",
		"--show-toplevel",
		"--untracked-files=all",
		"--verify",
		"-q",
		"-z",
		"HEAD",
		"diff",
		"ls-files",
		"rev-parse",
		"status",
	],
	go: ["env", "GOROOT", "version"],
	govulncheck: ["-version"],
	mix: ["credo", "--version", "--format", "json", "--strict"],
	vp: ["--version"],
};

const SHARED_CHECK =
	/\b(?:isToolInstallDisabled|acquireManagedInstallGate)\s*\(/g;

/** A node's identity within one parse (byte range and kind). */
function nodeId(node: SgNode): string {
	const { start, end } = node.range();
	return `${start.index}:${end.index}:${String(node.kind())}`;
}

type Kids = (node: SgNode) => SgNode[];

const kindOf = (node: SgNode | null | undefined): string =>
	String(node?.kind());

/** A string or template with no substitution, folded across `+` and parens. */
function literalValue(node: SgNode, kids: Kids): string | undefined {
	const kind = kindOf(node);
	if (kind === "string") return cookedString(node.text());
	if (kind === "template_string") {
		return node.text().includes("${") ? undefined : cookedString(node.text());
	}
	if (kind === "parenthesized_expression") {
		const inner = kids(node).find((child) => child.isNamed());
		return inner ? literalValue(inner, kids) : undefined;
	}
	if (kind === "binary_expression") {
		if (node.field("operator")?.text() !== "+") return undefined;
		const left = node.field("left");
		const right = node.field("right");
		if (!left || !right) return undefined;
		const a = literalValue(left, kids);
		const b = literalValue(right, kids);
		return a === undefined || b === undefined ? undefined : a + b;
	}
	return undefined;
}

const IDENT_KINDS = new Set([
	"identifier",
	"property_identifier",
	"shorthand_property_identifier",
	"shorthand_property_identifier_pattern",
]);
const FUNCTION_LIKE = new Set([
	"function_declaration",
	"generator_function_declaration",
	"method_definition",
	"arrow_function",
	"function_expression",
	"generator_function",
]);
const DECLARATION_NAMES = new Set([
	"function_declaration",
	"generator_function_declaration",
	"method_definition",
	"class_declaration",
	"variable_declarator",
	"abstract_method_signature",
	"method_signature",
	"public_field_definition",
]);

/** A seam call that is not clean, or a way of reading a seam name that is not a call. */
interface Hit {
	line: number;
	callee: string;
	why: string;
}

interface Forward {
	/** The enclosing function whose parameter reaches a seam's command. */
	fn: string;
	/** That parameter's position, which is where its callers pass a command. */
	index: number;
}

interface FileScan {
	hits: Hit[];
	forwards: Forward[];
}

/** The reason one command/argv pair is not known-good, or `undefined` if it is. */
function whyNotKnownGood(
	command: SgNode | undefined,
	argv: SgNode | undefined,
	kids: Kids,
	inheritComputed: boolean,
): string | undefined {
	const value = command ? literalValue(command, kids) : undefined;
	if (value === undefined)
		return inheritComputed ? undefined : "a computed command";
	if (!Object.hasOwn(KNOWN_GOOD, value)) return `command ${value}`;
	const admitted = KNOWN_GOOD[value] as readonly string[];
	if (!argv || kindOf(argv) !== "array") return `${value} with a computed argv`;
	// Every element, not the first: a carrier (`-exec`, `-c`, `-Command`) or a
	// computed operand anywhere in argv can run or fetch something.
	for (const element of kids(argv)) {
		if (!element.isNamed() || kindOf(element) === "comment") continue;
		const word = literalValue(element, kids);
		if (word === undefined) return `${value} with a computed argument`;
		if (!admitted.includes(word)) return `${value} with the argument ${word}`;
	}
	return undefined;
}

/**
 * Seam calls, seam references and forwarders in one source. `names` maps each
 * seam or forwarder name to the position of its command parameter.
 */
function scanFile(
	source: string,
	names: ReadonlyMap<string, number>,
): FileScan {
	const nodes = parseNodes(source.replace(/\r\n/g, "\n"));
	const kidsOf = new Map<string, SgNode[]>();
	for (const node of nodes) {
		const parent = node.parent();
		if (!parent) continue;
		const id = nodeId(parent);
		const siblings = kidsOf.get(id) ?? [];
		siblings.push(node);
		kidsOf.set(id, siblings);
	}
	const kids: Kids = (node) => kidsOf.get(nodeId(node)) ?? [];
	const named = (node: SgNode): SgNode[] =>
		kids(node).filter(
			(child) => child.isNamed() && kindOf(child) !== "comment",
		);
	const lineOf = (node: SgNode): number => node.range().start.line + 1;
	const cooked = (node: SgNode): string => cookedIdentifier(node.text());

	const hits: Hit[] = [];
	const forwards: Forward[] = [];
	const calleeIds = new Set<string>();

	/** The name node a call spells: `f(...)` or `ns.f(...)`. */
	const calleeName = (call: SgNode): SgNode | undefined => {
		const fn = call.field("function");
		if (!fn) return undefined;
		if (IDENT_KINDS.has(kindOf(fn))) return fn;
		if (kindOf(fn) === "member_expression") {
			const property = fn.field("property");
			return property && IDENT_KINDS.has(kindOf(property))
				? property
				: undefined;
		}
		return undefined;
	};

	const enclosingFunction = (node: SgNode): SgNode | undefined => {
		for (let at = node.parent(); at; at = at.parent())
			if (FUNCTION_LIKE.has(kindOf(at))) return at;
		return undefined;
	};

	const functionName = (fn: SgNode): string | undefined => {
		const own = fn.field("name");
		if (own) return cooked(own);
		const parent = fn.parent();
		const label =
			parent?.field("name") ??
			(kindOf(parent) === "pair" ? parent?.field("key") : null);
		return label ? cooked(label) : undefined;
	};

	/** The position of the parameter that binds `root`, or -1. */
	const parameterIndex = (fn: SgNode, root: string): number => {
		const binds = (top: SgNode): boolean => {
			const seen = new Set<string>();
			const pending = [top];
			for (let at = pending.pop(); at; at = pending.pop()) {
				if (seen.has(nodeId(at))) continue;
				seen.add(nodeId(at));
				if (IDENT_KINDS.has(kindOf(at)) && cooked(at) === root) return true;
				pending.push(...kids(at));
			}
			return false;
		};
		const single = fn.field("parameter");
		if (single) return binds(single) ? 0 : -1;
		const list = fn.field("parameters");
		return list ? named(list).findIndex(binds) : -1;
	};

	for (const node of nodes) {
		if (kindOf(node) !== "call_expression") continue;
		const nameNode = calleeName(node);
		if (!nameNode) continue;
		const name = cooked(nameNode);
		const index = names.get(name);
		if (index === undefined) continue;
		// A forwarder is followed only as a plain `name(...)` call: a method or
		// property of the same name (`flight.run(...)`) is a different function.
		if (!SEAMS.includes(name) && kindOf(nameNode) !== "identifier") continue;
		calleeIds.add(nodeId(nameNode));
		const args = named(node.field("arguments") as SgNode);
		const why = whyNotKnownGood(
			args[index],
			args[index + 1],
			kids,
			!SEAMS.includes(name),
		);
		if (why !== undefined) hits.push({ line: lineOf(node), callee: name, why });
		// A parameter reaching the command makes the enclosing function a
		// forwarder: its callers' literal commands are judged too.
		const root =
			args[index] && kindOf(args[index]) === "identifier"
				? cooked(args[index] as SgNode)
				: undefined;
		const fn = root ? enclosingFunction(node) : undefined;
		const fnName = fn ? functionName(fn) : undefined;
		if (fn && fnName && root) {
			const at = parameterIndex(fn, root);
			if (at >= 0) forwards.push({ fn: fnName, index: at });
		}
	}

	for (const node of nodes) {
		const kind = kindOf(node);
		if (IDENT_KINDS.has(kind)) {
			const name = cooked(node);
			if (!SEAMS.includes(name) || calleeIds.has(nodeId(node))) continue;
			const parent = node.parent();
			const parentKind = kindOf(parent);
			if (
				parentKind === "import_specifier" ||
				parentKind === "export_specifier"
			) {
				// `{ safeSpawnAsync }` only; `{ safeSpawnAsync as run }` hides the name.
				if (
					parent?.field("alias") &&
					parent.field("name")?.text() === node.text()
				)
					hits.push({
						line: lineOf(node),
						callee: name,
						why: "an aliased import",
					});
				continue;
			}
			// `typeof safeSpawnAsync` in a type starts nothing and is erased.
			if (parentKind === "type_query") continue;
			if (
				DECLARATION_NAMES.has(parentKind) &&
				parent?.field("name")?.text() === node.text()
			)
				continue;
			hits.push({ line: lineOf(node), callee: name, why: "read as a value" });
		} else if (
			kind === "binary_expression" ||
			((kind === "string" || kind === "template_string") &&
				/^["'`]/.test(node.text()))
		) {
			const value = literalValue(node, kids);
			if (value !== undefined && SEAMS.includes(value))
				hits.push({
					line: lineOf(node),
					callee: value,
					why: "named by a string",
				});
		}
	}
	return { hits, forwards };
}

/**
 * Whether `source` may hold one of `names`. The first pass looks for the seam
 * names, as plain text and through any escape (an escape can spell a seam name
 * the plain text does not hold). Later passes look for the forwarders found so
 * far, which are followed only as bare `name(` calls (stated bound), so the
 * narrowing is exactly that shape.
 */
function mayMention(
	source: string,
	names: ReadonlySet<string>,
	first: boolean,
): boolean {
	if (first)
		return (
			/\\[ux]/.test(source) ||
			[...names, ...SEAM_MODULES].some((name) => source.includes(name))
		);
	return new RegExp(`(?<![\\w$.])(?:${[...names].join("|")})\\s*\\(`).test(
		source,
	);
}

interface Census {
	/** `rel#callee` → the hits it holds. */
	hits: Map<string, Hit[]>;
	names: ReadonlyMap<string, number>;
	scanned: number;
}

/** Yield to the event loop between files so native trees are released (shape 81). */
const yieldTurn = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

/**
 * Scan `sources` to a fixpoint: a function whose parameter reaches a seam's
 * command joins the seam names, and files that mention it are rescanned.
 */
async function census(
	sources: ReadonlyArray<{ rel: string; source: string }>,
): Promise<Census> {
	const names = new Map<string, number>(SEAMS.map((name) => [name, 0]));
	const scans = new Map<string, FileScan>();
	let fresh = new Set<string>(SEAMS);
	let scanned = 0;
	let pass = 0;
	while (fresh.size > 0) {
		const added = new Set<string>();
		for (const { rel, source } of sources) {
			if (!mayMention(source, fresh, pass === 0)) continue;
			const scan = scanFile(source, names);
			scans.set(rel, scan);
			scanned += 1;
			for (const forward of scan.forwards)
				if (!names.has(forward.fn)) {
					names.set(forward.fn, forward.index);
					added.add(forward.fn);
				}
			await yieldTurn();
		}
		fresh = added;
		pass += 1;
	}
	const hits = new Map<string, Hit[]>();
	for (const [rel, scan] of scans)
		for (const hit of scan.hits) {
			const key = `${rel}#${hit.callee}`;
			const held = hits.get(key) ?? [];
			held.push(hit);
			hits.set(key, held);
		}
	return { hits, names, scanned };
}

/**
 * The text of `symbol`'s DECLARATION body in comment-and-string-blanked
 * source: the first `symbol(...)` whose parameter list is followed by a block,
 * so a call of the same name (`symbol(x);`) is not mistaken for it.
 */
function bodyOf(blanked: string, symbol: string): string | undefined {
	const pattern = new RegExp(`(?<![.\\w$])${symbol}\\s*\\(`, "g");
	for (let at = pattern.exec(blanked); at; at = pattern.exec(blanked)) {
		const open = at.index + at[0].length - 1;
		const close = matchingCloseIndex(blanked, open, "(", ")");
		if (close < 0) continue;
		const brace = /^\s*(?::[^;{}]*)?\{/.exec(blanked.slice(close + 1));
		if (!brace) continue;
		const start = close + 1 + brace[0].length - 1;
		const end = matchingCloseIndex(blanked, start, "{", "}");
		return end < 0 ? undefined : blanked.slice(start, end + 1);
	}
	return undefined;
}

interface GatedFile {
	/** Functions that must consult the shared check before the named tokens. */
	entries: Array<{
		symbol: string;
		/** Tokens (in blanked code) that must come AFTER the first consult. */
		before: string[];
		/** Minimum consults in the body. */
		consults: number;
	}>;
}

/**
 * Files whose install spawns the tool switch governs, with the entry that
 * answers "unavailable" before any spawn-shaped token.
 */
const GATED_FILES: Readonly<Record<string, GatedFile>> = {
	"clients/dispatch/runners/utils/lazy-installer.ts": {
		entries: [
			{ symbol: "runLazyInstall", before: ["performInstall("], consults: 1 },
		],
	},
	"clients/govulncheck-client.ts": {
		entries: [
			{
				symbol: "doEnsureAvailable",
				before: ["probeToolAsync(", "safeSpawnAsync("],
				consults: 1,
			},
		],
	},
	"clients/installer/managed-tool-refresh.ts": {
		entries: [
			{ symbol: "refreshNpmOne", before: ["performNpmRefresh("], consults: 1 },
		],
	},
	"clients/installer/index.ts": {
		entries: [
			{
				symbol: "acquireManagedInstallGate",
				before: ["acquireInstallLock("],
				consults: 1,
			},
			{
				symbol: "installTool",
				before: ["switch (", "installNpmTool("],
				consults: 1,
			},
			{
				symbol: "ensureToolResolved",
				before: ["acquireInstallLock("],
				consults: 2,
			},
		],
	},
};

/** Entry-function problems for one gated file's blanked code. */
function entryProblems(
	file: string,
	source: string,
	gated: GatedFile,
): string[] {
	const blanked = stripSource(source, { strings: "blank" });
	const problems: string[] = [];
	for (const entry of gated.entries) {
		const body = bodyOf(blanked, entry.symbol);
		if (body === undefined) {
			problems.push(`${file}: entry ${entry.symbol} not found`);
			continue;
		}
		const consults = [...body.matchAll(SHARED_CHECK)].map((m) => m.index ?? 0);
		if (consults.length < entry.consults) {
			problems.push(
				`${file}: ${entry.symbol} consults the shared check ${consults.length}x, needs ${entry.consults}`,
			);
			continue;
		}
		for (const token of entry.before) {
			const at = body.indexOf(token);
			// A token the entry no longer holds is a stale row, not a pass: the
			// order it pinned is no longer being checked (M2).
			if (at < 0)
				problems.push(
					`${file}: ${entry.symbol} no longer holds the token ${token}; the order it pinned is unchecked`,
				);
			else if (at < (consults[0] as number))
				problems.push(
					`${file}: ${entry.symbol} reaches ${token} before its first consult`,
				);
		}
	}
	return problems;
}

type Row = { sites: number } & ({ gated: true } | { reason: string });

/** Everything this census judges, for one set of sources. */
async function judge(
	sources: ReadonlyArray<{ rel: string; source: string }>,
	rows: Readonly<Record<string, Row>>,
	gatedFiles: Readonly<Record<string, GatedFile>>,
) {
	const found = await census(sources);
	const flagged: Array<{ key: string; detail: string }> = [];
	for (const [key, hits] of found.hits)
		flagged.push({
			key: `${key}@${hits.length}`,
			detail: hits.map((hit) => `${hit.line} ${hit.why}`).join("; "),
		});
	const registered: string[] = [];
	const exemptions: Record<string, string> = {};
	for (const [key, row] of Object.entries(rows)) {
		const id = `${key}@${row.sites}`;
		if ("gated" in row) registered.push(id);
		else exemptions[id] = row.reason;
	}
	const audit = auditRegistry({
		sweepName: "install kill-switch census (#5231)",
		flagged,
		registered,
		exemptions,
		minFlagged: 0,
		scannedCount: found.scanned,
		minScanned: 1,
		remediation:
			"A spawn site is unclassified or its count moved. Route an install through " +
			"isToolInstallDisabled() (clients/env-utils.ts) and register the row as gated " +
			"with a GATED_FILES entry, or give the row the reason it cannot install.",
	});
	const problems = [...audit.problems];
	// auditRegistry tolerates a registered id the scan no longer flags (a
	// registry may cover state a heuristic cannot see). A gated row is a live
	// claim about a site, so one with no live site is stale (M2).
	const live = new Set(flagged.map((entry) => entry.key));
	for (const id of registered)
		if (!live.has(id))
			problems.push(`${id}: a gated row matches no live site count (stale)`);
	const sourceByRel = new Map(sources.map((s) => [s.rel, s.source]));
	const gatedRowFiles = new Set(
		Object.entries(rows)
			.filter(([, row]) => "gated" in row)
			.map(([key]) => key.split("#")[0] as string),
	);
	for (const rel of gatedRowFiles)
		if (!Object.hasOwn(gatedFiles, rel))
			problems.push(`${rel}: a gated row has no GATED_FILES entry`);
	for (const [rel, gated] of Object.entries(gatedFiles)) {
		if (!gatedRowFiles.has(rel))
			problems.push(`${rel}: a GATED_FILES entry has no gated row`);
		const source = sourceByRel.get(rel);
		if (source === undefined) problems.push(`${rel}: gated file not scanned`);
		else problems.push(...entryProblems(rel, source, gated));
	}
	return { problems, flagged, found };
}

const GATED = (sites: number): Row => ({ sites, gated: true });
const because = (reason: string, table: Record<string, number>) =>
	Object.fromEntries(
		Object.entries(table).map(([key, sites]): [string, Row] => [
			key,
			{ sites, reason },
		]),
	);

const TOOL =
	"spawns the tool binary a resolver chose, with that tool's own check, lint, format or version argv (the argv literals at every row were read: none names an installer verb); a package-runner command (npx) runs offline at the seam under the switch, pinned by tests/clients/install-kill-switch-npx-5231.test.ts";
const SEAM =
	"the spawn chokepoint's own forwarding between its entry points, its tool-probe wrapper, or a fixed process-table query (ps/wmic), which take their command from a caller already counted here";
const PM =
	"a package-manager query or run-script (config get prefix, bin -g, the repo's rebuild script), not an install verb";
const LSP =
	"language-server launch and install code: its installs follow PI_LENS_DISABLE_LSP_INSTALL (canInstall in clients/lsp/server.ts, a separate switch), and its probes (java finder, --version) install nothing";
const NPX_NO =
	"npx --no: the package runner is told to use the local or cached copy and never download, and the seam runs it offline under the switch as well";
const OPERAND =
	"a known-good command and literal words plus one computed operand the census cannot fold: mix credo's file argument is path.resolve(cwd, file), an absolute path that cannot read as an option, and git diff's two operands are commit ids readGitHead read from git rev-parse; neither tool installs anything";
const REGISTRY_PATH =
	"a PowerShell -Command whose script is one fixed string literal reading the Machine and User Path variables (readWindowsRegistryPath); it starts no installer, and a changed script is a reviewed edit of this one line";

const ROWS: Readonly<Record<string, Row>> = {
	// ROWS-BEGIN
	// -- gated: the install spawns the tool switch governs (entries verified) --
	"clients/dispatch/runners/utils/lazy-installer.ts#safeSpawnAsync": GATED(1),
	"clients/govulncheck-client.ts#safeSpawnAsync": GATED(2),
	"clients/installer/index.ts#probeToolAsync": GATED(3),
	"clients/installer/index.ts#run": GATED(2),
	"clients/installer/index.ts#runCommand": GATED(3),
	"clients/installer/index.ts#safeSpawnAsync": GATED(7),
	"clients/installer/managed-tool-refresh.ts#safeSpawnAsync": GATED(2),
	// -- the rest: classified, each count pinned --
	...because(LSP, {
		"clients/lsp/jvm-runtime.ts#safeSpawnAsync": 1,
		"clients/lsp/launch.ts#safeSpawn": 1,
		"clients/lsp/server.ts#safeSpawnAsync": 4,
	}),
	...because(OPERAND, {
		"clients/dispatch/runners/credo.ts#safeSpawnAsync": 1,
		"clients/opaque-mutation-scan.ts#safeSpawnAsync": 1,
	}),
	...because(REGISTRY_PATH, {
		"clients/lsp/launch.ts#runStderrGuardedProbe": 1,
	}),
	...because(NPX_NO, {
		"clients/dispatch/runners/utils/runner-helpers.ts#probeAstGrepCommandAsync": 1,
	}),
	...because(PM, {
		"clients/mcp/review.ts#safeSpawnAsync": 1,
		"clients/package-manager.ts#probeToolAsync": 1,
		"clients/package-manager.ts#safeSpawnAsync": 1,
	}),
	...because(SEAM, {
		"clients/process-snapshot.ts#spawnCollectStdoutResult": 2,
		"clients/safe-spawn.ts#safeSpawn": 2,
		"clients/safe-spawn.ts#safeSpawnAsync": 3,
		"clients/tool-probe.ts#safeSpawnAsync": 1,
	}),
	...because(TOOL, {
		"clients/biome-client.ts#probeToolAsync": 1,
		"clients/biome-client.ts#safeSpawnAsync": 1,
		"clients/dead-code-client.ts#probeToolAsync": 1,
		"clients/dead-code-client.ts#safeSpawnAsync": 1,
		"clients/dependency-checker.ts#safeSpawnAsync": 2,
		"clients/dispatch/dispatcher.ts#probeToolAsync": 1,
		"clients/dispatch/runners/actionlint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/biome-check.ts#safeSpawnAsync": 2,
		"clients/dispatch/runners/cpp-check.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/cue-vet.ts#safeSpawnAsync": 3,
		"clients/dispatch/runners/dart-analyze.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/detekt.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/dotnet-build.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/elixir-check.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/eslint.ts#safeSpawnAsync": 2,
		"clients/dispatch/runners/fish-indent.ts#safeSpawnAsync": 2,
		"clients/dispatch/runners/gleam-check.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/go-vet.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/golangci-lint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/hadolint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/helm-lint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/helm-render.ts#safeSpawnAsync": 2,
		"clients/dispatch/runners/htmlhint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/javac.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/ktlint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/markdownlint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/mypy.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/oxlint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/php-lint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/phpstan.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/prisma-validate.ts#resolveLocalFirstAsync": 1,
		"clients/dispatch/runners/prisma-validate.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/psscriptanalyzer.ts#probeToolAsync": 2,
		"clients/dispatch/runners/psscriptanalyzer.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/pyright.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/rubocop.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/ruff.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/rust-clippy.ts#safeSpawnAsync": 2,
		"clients/dispatch/runners/shellcheck.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/shfmt.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/spellcheck.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/spotbugs.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/sqlfluff.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/stylelint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/swiftlint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/taplo.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/terragrunt.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/tflint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/trivy-config.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/utils/candidate-probe.ts#probeToolAsync": 1,
		"clients/dispatch/runners/utils/runner-helpers.ts#probeToolAsync": 2,
		"clients/dispatch/runners/utils/runner-helpers.ts#safeSpawnAsync": 4,
		"clients/dispatch/runners/vale.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/yamllint.ts#safeSpawnAsync": 1,
		"clients/dispatch/runners/zig-check.ts#safeSpawnAsync": 1,
		"clients/file-utils.ts#safeSpawnAsync": 1,
		"clients/formatters.ts#probeToolAsync": 1,
		"clients/formatters.ts#safeSpawnAsync": 2,
		"clients/gitleaks-client.ts#safeSpawnAsync": 1,
		"clients/jscpd-client.ts#safeSpawnAsync": 1,
		"clients/knip-client.ts#safeSpawnAsync": 1,
		"clients/opengrep-client.ts#safeSpawnAsync": 1,
		"clients/pipeline.ts#safeSpawnAsync": 1,
		"clients/ruff-client.ts#safeSpawnAsync": 2,
		"clients/security-scan-client.ts#probeToolAsync": 1,
		"clients/sg-runner.ts#probeToolAsync": 1,
		"clients/sg-runner.ts#safeSpawnAsync": 4,
		"clients/test-runner-client.ts#safeSpawn": 1,
		"clients/test-runner-client.ts#safeSpawnAsync": 1,
		"clients/trivy-client.ts#safeSpawnAsync": 1,
	}),
	// ROWS-END
};

describe("install kill-switch census (#5231)", () => {
	let sources: Array<{ rel: string; source: string }>;
	let verdict: Awaited<ReturnType<typeof judge>>;
	beforeAll(async () => {
		const files = [
			...RUNTIME_ROOTS.flatMap((root) =>
				listSourceFiles(path.join(REPO_ROOT, root), { skipTests: true }),
			),
			path.join(REPO_ROOT, "index.ts"),
		];
		sources = readWalkedFiles(files).map(({ file, source }) => ({
			rel: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
			source,
		}));
		assertNonEmptyScan("install census files", sources.length, 100);
		verdict = await judge(sources, ROWS, GATED_FILES);
	}, 180_000);

	it("pins every spawn site to the gate or a reason", () => {
		expect(verdict.problems).toEqual([]);
	});

	it("keeps every row's reason a real sentence", () => {
		const reasons = Object.values(ROWS).flatMap((row) =>
			"reason" in row ? [row.reason] : [],
		);
		expect(reasons.length).toBeGreaterThan(0);
		for (const reason of reasons) expect(reason.length).toBeGreaterThan(30);
	});

	// H1: the value-level guarantee for package runners lives in the seam. A
	// computed command at a registered site may be `npx`; getSpawnEnvironment
	// must still consult the switch before it hands the environment back.
	it("the spawn seam consults the switch before returning an environment", () => {
		const source = sources.find((s) => s.rel === "clients/safe-spawn.ts");
		expect(source).toBeDefined();
		expect(
			entryProblems("clients/safe-spawn.ts", source?.source ?? "", {
				entries: [
					{
						symbol: "getSpawnEnvironment",
						before: ["return merged", "return stripped"],
						consults: 1,
					},
				],
			}),
		).toEqual([]);
	});
});

// Planted spellings (AGENTS.md shape 69): each is a bypass its author did not
// design the census for, and each must be a finding, not a pass. The first ten
// are the ones review found passing the spelling-enumerating version.
describe("install kill-switch census: planted bypasses (#5231)", () => {
	const HEAD = `import { safeSpawnAsync } from "./safe-spawn.js";\n`;
	const plant = (source: string) => [{ rel: "clients/planted.ts", source }];
	const problemsOf = async (
		source: string,
		rows: Readonly<Record<string, Row>> = {},
		gated: Readonly<Record<string, GatedFile>> = {},
	) => (await judge(plant(source), rows, gated)).problems.join("\n");
	const call = (args: string) =>
		`${HEAD}export const go = () => safeSpawnAsync(${args});`;

	it.each([
		["npm i", `"npm", ["i", "left-pad"]`],
		["go get", `"go", ["get", "x/y"]`],
		["pnpm i", `"pnpm", ["i"]`],
		["gem i", `"gem", ["i", "x"]`],
		["npm exec", `"npm", ["exec", "x"]`],
		["run-time argv", `"go", [process.env.V as string, "x"]`],
		["a parenthesised concatenation", `"go", [("in") + ("stall"), "x"]`],
		["a \\x69 escape", `"go", ["\\x69nstall", "x"]`],
		["an empty template splice", `"go", [\`inst\${""}all\`, "x"]`],
		["String.fromCharCode", `"go", [String.fromCharCode(105, 110, 115, 116)]`],
		["a spread argv", `"go", [...process.argv]`],
		["a computed command", `process.env.TOOL as string, ["x"]`],
		["a templated command", "`np${'x'}`, []"],
		// Review r2: argv[0] alone was judged, so a nested command passed.
		[
			"powershell -Command",
			`"powershell.exe", ["-NoProfile", "-Command", "npm i left-pad"]`,
		],
		["go vet -exec", `"go", ["vet", "-exec", "curl x | sh"]`],
		["git -c core.pager", `"git", ["-c", "core.pager=npm i x", "log"]`],
		// Unplanned spellings of the same gap (shape 69).
		["a joined carrier", `"go", ["vet", "-exec=curl x | sh"]`],
		[
			"a carrier after an admitted first word",
			`"go", ["env", "-w", "GOFLAGS=-toolexec=sh"]`,
		],
		[
			"a computed operand after admitted words",
			`"git", ["diff", "--name-only", process.env.REV as string]`,
		],
	])("%s is a finding", async (_label, args) => {
		expect(await problemsOf(call(args))).toMatch(
			/clients\/planted\.ts#safeSpawnAsync@1/,
		);
	});

	it("a known-good command with a known-good argv is clean", async () => {
		expect(await problemsOf(call(`"gh", ["auth", "token"]`))).not.toMatch(
			/planted/,
		);
		expect(
			await problemsOf(call(`"git", ["rev-parse", "--short", "HEAD"]`)),
		).not.toMatch(/planted/);
		expect(await problemsOf(call(`"go", ["version"]`))).not.toMatch(/planted/);
		expect(await problemsOf(call(`"go", ["ver" + "sion"]`))).not.toMatch(
			/planted/,
		);
	});

	it("an aliased import, an indirect binding and a seam read as a value are findings", async () => {
		expect(
			await problemsOf(
				`import { safeSpawnAsync as run } from "./safe-spawn.js";\nexport const go = () => run("gh", ["auth"]);`,
			),
		).toMatch(/planted\.ts#safeSpawnAsync@1/);
		expect(
			await problemsOf(
				`${HEAD}export function go() { const sp = safeSpawnAsync; return sp("gh", ["auth"]); }`,
			),
		).toMatch(/planted\.ts#safeSpawnAsync@1/);
		expect(
			await problemsOf(`${HEAD}export const go = safeSpawnAsync.bind(null);`),
		).toMatch(/planted\.ts#safeSpawnAsync@1/);
	});

	it("a value reached through another binding is a finding", async () => {
		expect(
			await problemsOf(
				`${HEAD}export function go() { const verb = "install"; const cmd = "pip"; return safeSpawnAsync(cmd, [verb, "x"]); }`,
			),
		).toMatch(/planted\.ts#safeSpawnAsync@1/);
		// A value-taking flag bound first, between two set words: only the
		// binding is outside the set.
		expect(
			await problemsOf(
				`${HEAD}export function go() { const flag = "-w"; return safeSpawnAsync("go", ["env", flag, "GOROOT"]); }`,
			),
		).toMatch(/planted\.ts#safeSpawnAsync@1/);
	});

	it("a seam named by a string is a finding", async () => {
		expect(
			await problemsOf(
				`import * as ns from "./safe-spawn.js";\nexport const go = () => (ns as Record<string, Function>)["safe" + "SpawnAsync"]("npm", []);`,
			),
		).toMatch(/planted\.ts#safeSpawnAsync@1/);
	});

	it("a forwarder is followed: its caller's literal installer command is a finding", async () => {
		const forwarder = `${HEAD}export function launch(command: string) { return safeSpawnAsync(command, []); }\n`;
		expect(
			await problemsOf(`${forwarder}export const go = () => launch("npm");`),
		).toMatch(/planted\.ts#launch@1/);
		// A known-good literal through the same forwarder stays clean.
		expect(
			await problemsOf(
				`${forwarder}export const go = () => launch("gh", ["auth"]);`,
			),
		).not.toMatch(/planted\.ts#launch/);
	});

	it("a count that moves is a finding: a second site in a classified file", async () => {
		const row = {
			"clients/planted.ts#safeSpawnAsync": {
				sites: 1,
				reason: "a reason that is long enough to count",
			},
		};
		const one = `${HEAD}export const a = (c: string) => safeSpawnAsync(c, []);`;
		expect(await problemsOf(one, row)).not.toMatch(/planted/);
		expect(
			await problemsOf(
				`${one}\nexport const b = (c: string) => safeSpawnAsync(c, []);`,
				row,
			),
		).toMatch(/planted\.ts#safeSpawnAsync@2/);
	});

	it("a row whose site is gone is stale, gated or not (M2)", async () => {
		const reason = "a reason that is long enough to count";
		const quiet = `${HEAD}export const go = () => safeSpawnAsync("gh", ["auth"]);`;
		expect(
			await problemsOf(quiet, {
				"clients/planted.ts#safeSpawnAsync": { sites: 1, reason },
			}),
		).toMatch(/planted\.ts#safeSpawnAsync@1/);
		const gated = {
			"clients/planted.ts": {
				entries: [{ symbol: "go", before: ["safeSpawnAsync("], consults: 1 }],
			},
		};
		expect(
			await problemsOf(
				quiet,
				{ "clients/planted.ts#safeSpawnAsync": { sites: 1, gated: true } },
				gated,
			),
		).toMatch(/matches no live site count/);
	});

	it("a gated file whose entry never consults the shared check is a finding", async () => {
		const gated = {
			"clients/planted.ts": {
				entries: [{ symbol: "go", before: ["safeSpawnAsync("], consults: 1 }],
			},
		};
		const rows = {
			"clients/planted.ts#safeSpawnAsync": { sites: 1, gated: true },
		} as const;
		const run = (body: string) =>
			problemsOf(
				`${HEAD}export function go(c: string) { ${body} }`,
				rows,
				gated,
			);
		// No consult at all.
		expect(await run(`return safeSpawnAsync(c, []);`)).toMatch(
			/go consults the shared check 0x/,
		);
		// A consult that exists only in a comment.
		expect(
			await run(`/* isToolInstallDisabled() */ return safeSpawnAsync(c, []);`),
		).toMatch(/go consults the shared check 0x/);
		// A consult AFTER the spawn.
		expect(
			await run(`safeSpawnAsync(c, []); return isToolInstallDisabled();`),
		).toMatch(/reaches safeSpawnAsync\( before its first consult/);
		// The honest shape is clean.
		expect(
			await run(
				`if (isToolInstallDisabled()) return false; return safeSpawnAsync(c, []);`,
			),
		).toBe("");
	});

	it("a renamed ordering token is a finding, not a silent pass (M2)", async () => {
		const gated = {
			"clients/planted.ts": {
				entries: [{ symbol: "go", before: ["performInstall("], consults: 1 }],
			},
		};
		expect(
			await problemsOf(
				`${HEAD}export function go(c: string) { if (isToolInstallDisabled()) return false; return safeSpawnAsync(c, []); }`,
				{ "clients/planted.ts#safeSpawnAsync": { sites: 1, gated: true } },
				gated,
			),
		).toMatch(/no longer holds the token performInstall\(/);
	});
});

/**
 * Properties over generated source text, through the SAME entry the census
 * uses (`judge`), so the recognizer is exercised, not restated (AGENTS.md
 * shape 57: the generators include every input shape review found passing an
 * earlier version: alias verbs, a parenthesised concatenation, a `\\x`
 * escape, an empty template splice, `String.fromCharCode`, a binding).
 *
 * A: every installer spawn, spelled any way, is a finding.
 * B: every known-good spawn, spelled any way that folds to its literal, is
 * clean. A failure prints fast-check's seed and the shrunk counterexample;
 * `numRuns` is bounded because each run parses a tiny file (RSS stays flat).
 */
describe("install kill-switch census: generated spellings (#5231)", () => {
	const HEAD = `import { safeSpawnAsync } from "./safe-spawn.js";\n`;
	const RUNS = 120;

	/** Spellings that fold to the literal, and ones that are computed. */
	const FOLDING = [
		"plain",
		"single",
		"template",
		"concat",
		"paren",
		"hex",
		"unicode",
	] as const;
	const COMPUTED = ["splice", "charcode"] as const;
	type Form = (typeof FOLDING)[number] | (typeof COMPUTED)[number];
	interface Slot {
		value: string;
		form: Form;
		cut: number;
		indirect: boolean;
	}

	const quote = (text: string): string => JSON.stringify(text);
	const spell = ({ value, form, cut }: Slot): string => {
		const at = value.length > 1 ? 1 + (cut % (value.length - 1)) : 0;
		const [head, tail] = [value.slice(0, at), value.slice(at)];
		const code = (index: number): number => value.charCodeAt(index);
		const hex = (width: number): string =>
			code(at).toString(16).padStart(width, "0");
		switch (form) {
			case "plain":
				return quote(value);
			case "single":
				return `'${value}'`;
			case "template":
				return `\`${value}\``;
			case "concat":
				return `${quote(head)} + ${quote(tail)}`;
			case "paren":
				return `(${quote(head)}) + (${quote(tail)})`;
			case "hex":
				return `"${value.slice(0, at)}\\x${hex(2)}${value.slice(at + 1)}"`;
			case "unicode":
				return `"${value.slice(0, at)}\\u${hex(4)}${value.slice(at + 1)}"`;
			case "splice":
				return `\`${head}\${""}${tail}\``;
			case "charcode":
				return `String.fromCharCode(${[...value].map((_, i) => code(i)).join(", ")})`;
		}
	};

	/** The planted file: every `indirect` slot is bound to a const first. */
	const plantOf = (command: Slot, argv: Slot[]): string => {
		const bindings: string[] = [];
		const use = (slot: Slot, name: string): string => {
			if (!slot.indirect) return spell(slot);
			bindings.push(`const ${name} = ${spell(slot)};`);
			return name;
		};
		const cmd = use(command, "cmd");
		const args = argv.map((slot, i) => use(slot, `arg${i}`)).join(", ");
		return `${HEAD}export function go() {\n${bindings.join("\n")}\nreturn safeSpawnAsync(${cmd}, [${args}]);\n}`;
	};
	const slotOf = (
		value: string,
		forms: readonly Form[],
		indirect: boolean,
	): fc.Arbitrary<Slot> =>
		fc.record({
			value: fc.constant(value),
			form: fc.constantFrom(...forms),
			cut: fc.nat(32),
			indirect: indirect ? fc.boolean() : fc.constant(false),
		});

	/** Installer programs with the verbs and aliases that install or download. */
	const INSTALLERS: ReadonlyArray<readonly [string, readonly string[][]]> = [
		["npm", [["install"], ["i"], ["add"], ["ci"], ["exec"], ["update"]]],
		["pnpm", [["install"], ["i"], ["add"], ["dlx"], ["exec"]]],
		["yarn", [["install"], ["add"], ["dlx"], ["up"]]],
		["bun", [["install"], ["i"], ["add"], ["x"]]],
		["gem", [["install"], ["i"], ["update"]]],
		["go", [["install"], ["get"]]],
		["pip", [["install"]]],
		["cargo", [["install"], ["add"]]],
		["rustup", [["component", "add"], ["toolchain", "install"], ["update"]]],
	];
	const installer = fc
		.tuple(
			fc.constantFrom(...INSTALLERS),
			fc.nat(8),
			fc.constantFrom("x", "left-pad", "clippy"),
		)
		.chain(([[program, verbs], pick, extra]) => {
			const verb = verbs[pick % verbs.length] as string[];
			return fc.tuple(
				slotOf(program, [...FOLDING, ...COMPUTED], true),
				fc.tuple(
					...[...verb, extra].map((word) =>
						slotOf(word, [...FOLDING, ...COMPUTED], true),
					),
				),
			);
		});

	/** Words drawn from one command's inert set, in any order. */
	const inertWords = (admitted: readonly string[]) =>
		admitted.length === 0
			? fc.constant([] as string[])
			: fc.array(fc.constantFrom(...admitted), { maxLength: 4 });
	/** A known-good command with an argv of its inert words only. */
	const knownGood = fc
		.constantFrom(...Object.entries(KNOWN_GOOD))
		.chain(([command, admitted]) =>
			fc.tuple(
				slotOf(command, FOLDING, false),
				inertWords(admitted).chain((words) =>
					fc.tuple(...words.map((w) => slotOf(w, FOLDING, false))),
				),
			),
		);
	/**
	 * A known-good command whose argv holds ONE word outside its set, at any
	 * position, among inert words: a nested-command carrier with its payload,
	 * an installer verb, or an arbitrary option (review r2: `go vet -exec`,
	 * `git -c core.pager=`, `powershell -Command`).
	 */
	const CARRIERS = [
		"-c",
		"-C",
		"-e",
		"-x",
		"-exec",
		"--exec",
		"-Command",
		"-EncodedCommand",
		"/c",
		"--config",
		"--upload-pack",
		"core.pager=npm i x",
		"-exec=curl x | sh",
		"install",
		"get",
	];
	const outsider = (admitted: readonly string[]) =>
		fc
			.oneof(
				fc.constantFrom(...CARRIERS),
				fc.stringMatching(/^-{0,2}[a-zA-Z][a-zA-Z0-9.=-]{0,10}$/),
			)
			.filter((value) => !admitted.includes(value));
	const smuggled = fc
		.constantFrom(...Object.entries(KNOWN_GOOD))
		.chain(([command, admitted]) =>
			fc.tuple(
				slotOf(command, FOLDING, false),
				fc
					.tuple(inertWords(admitted), outsider(admitted), fc.nat(8))
					.map(([words, extra, at]) => {
						const cut = words.length === 0 ? 0 : at % (words.length + 1);
						return [...words.slice(0, cut), extra, ...words.slice(cut)];
					})
					.chain((words) =>
						fc.tuple(
							...words.map((w) => slotOf(w, [...FOLDING, ...COMPUTED], true)),
						),
					),
			),
		);

	const verdictOf = async (command: Slot, argv: Slot[]): Promise<string> =>
		(
			await judge(
				[{ rel: "clients/planted.ts", source: plantOf(command, argv) }],
				{},
				{},
			)
		).problems.join("\n");

	it("A: every generated installer spawn is a finding", async () => {
		await fc.assert(
			fc.asyncProperty(installer, async ([command, argv]) => {
				expect(await verdictOf(command, argv)).toMatch(
					/clients\/planted\.ts#safeSpawnAsync@1/,
				);
			}),
			{ numRuns: RUNS },
		);
	});

	it("A2: a known-good command with any argument outside its set, at any position, is a finding", async () => {
		await fc.assert(
			fc.asyncProperty(smuggled, async ([command, argv]) => {
				expect(await verdictOf(command, argv)).toMatch(
					/clients\/planted\.ts#safeSpawnAsync@1/,
				);
			}),
			{ numRuns: RUNS },
		);
	});

	it("B: every generated known-good spawn is clean", async () => {
		await fc.assert(
			fc.asyncProperty(knownGood, async ([command, argv]) => {
				expect(await verdictOf(command, argv)).not.toMatch(/planted/);
			}),
			{ numRuns: RUNS },
		);
	});
});

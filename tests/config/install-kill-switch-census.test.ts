/**
 * #5231: every install path is pinned to the shared kill-switch check.
 *
 * ## The recurrence this guards
 *
 * `PI_LENS_DISABLE_TOOL_INSTALL=1` was read by the managed installer only. The
 * lazy installer (`gem install rubocop`, `rustup component add`) and
 * govulncheck's `go install` checked project trust and spawned anyway
 * (alignment probe 2026-11-03: `execve("/opt/ruby-3.3.6/bin/gem", ["gem",
 * "install", "rubocop", ...])` with the switch set). The `#1759 F2` comment in
 * `clients/installer/index.ts` records the same shape one layer up: a kill
 * switch skipped by another install path. Guarding callers one at a time
 * cannot converge, so this census enumerates the population.
 *
 * ## STATE TABLE (written before the detector)
 *
 * Population: every string literal in `clients/`, `tools/`, `mcp/` and
 * `index.ts` (comments are not code; strings are kept, because the evidence IS
 * a string) whose COOKED value is install vocabulary, read off the parse tree:
 *
 * | literal form                                   | read as                  |
 * | ---------------------------------------------- | ------------------------ |
 * | `"gem"` `'install'` `` `install` ``            | cooked value             |
 * | `"inst\x61ll"` `"install"`                | cooked value (a hit)     |
 * | `"inst" + "all"`, `("a" + "b")` chains         | folded, then cooked      |
 * | `"pip install x"`, `` `npm install ${x}` ``    | shell line (a hit)       |
 * | an escape this reader cannot decode            | counts as a hit          |
 * | a name reached through an alias or a binding   | the literal still sits   |
 * |                                                | in the file: a hit       |
 * | the same words in a comment                    | not code: no hit         |
 *
 * Every hit must be ACCOUNTED: registered as gated, or exempt with a reason.
 * An unaccounted hit is a finding, so a new `gem`/`go install`/`rustup`/`npm
 * install`/`pip install` spawn anywhere in the shipped runtime reds this file
 * until its author classifies it. A registered row whose literal is gone is
 * stale and reds too.
 *
 * "Gated" is verified, not claimed. A gated file must carry its named ENTRY
 * functions, and each entry must call the shared check (`isToolInstallDisabled`
 * or `acquireManagedInstallGate`) BEFORE its first spawn-shaped token, on
 * comment-and-string-blanked text, so a consult that exists only in a comment
 * or after the spawn does not count.
 *
 * ## Stated bounds (not silent)
 *
 * - The vocabulary is a bound: it names the installer programs and verbs the
 *   tree uses (`gem`, `rustup`, `pipx`, `npx`, ..., `install`, `update`,
 *   `upgrade`, `add`, `ci`, `component`). An installer spelled outside it
 *   (`npm i`, `go get`) is outside the census. `i` and `get` are not literal
 *   tokens here because `"i"` is a regex flag and `"get"` a config verb all
 *   over the tree (measured 4 and 2 non-install hits).
 * - A command assembled at run time from non-literal parts (read from config
 *   or the environment) holds no literal to read. The tree builds every
 *   installer argv from literals today; the census does not claim more.
 * - `scripts/` (build and smoke tooling) is not shipped runtime and is not
 *   scanned. LSP server installs follow `PI_LENS_DISABLE_LSP_INSTALL`, a
 *   different switch, and are exempt here with that reason.
 * - The npx package-runner fallbacks (`formatters.ts`, `dependency-checker.ts`,
 *   `jscpd-client.ts`, ...) can download a package and do NOT consult the
 *   tool switch today. They are registered below as `KNOWN UNGATED`, a
 *   baseline that shrinks on purpose; the PR body names the follow-up.
 */

import * as path from "node:path";
import type { SgNode } from "@ast-grep/napi";
import { beforeAll, describe, expect, it } from "vitest";
import { parseNodes } from "../support/ast-census.js";
import { cookedString } from "../support/cooked-literal.js";
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

/** Installer programs and verbs: a literal that spells one is a hit. */
const VOCABULARY: ReadonlySet<string> = new Set([
	"add",
	"apt",
	"apt-get",
	"asdf",
	"brew",
	"bunx",
	"choco",
	"ci",
	"component",
	"dlx",
	"install",
	"mise",
	"npx",
	"pipx",
	"pnpx",
	"rustup",
	"scoop",
	"update",
	"upgrade",
	"uvx",
	"winget",
]);

/** Programs that, followed by an install verb inside ONE string, are a shell line. */
const SHELL_PROGRAMS: ReadonlySet<string> = new Set([
	"apt",
	"apt-get",
	"brew",
	"bun",
	"cargo",
	"choco",
	"dotnet",
	"gem",
	"go",
	"npm",
	"pip",
	"pip3",
	"pipx",
	"pnpm",
	"rustup",
	"scoop",
	"uv",
	"winget",
	"yarn",
]);
const SHELL_VERBS: ReadonlySet<string> = new Set([
	"add",
	"ci",
	"get",
	"i",
	"install",
	"update",
	"upgrade",
]);

const SHARED_CHECK =
	/\b(?:isToolInstallDisabled|acquireManagedInstallGate)\s*\(/g;

interface Hit {
	/** 1-based line. */
	line: number;
	/** The cooked word or shell line that matched. */
	word: string;
	/** The enclosing `Class.method` / function / const, or `<module>`. */
	symbol: string;
}

const FUNCTION_NODES = new Set([
	"function_declaration",
	"generator_function_declaration",
	"method_definition",
]);
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression"]);

/**
 * The enclosing declaration chain of a node, read off the parse tree:
 * `GovulncheckClient.doEnsureAvailable`, `installTool`, `LAZY_INSTALL_SPECS`.
 * A text heuristic only sees column-zero declarations, so every method of a
 * class would share the class name and a new method would inherit its row.
 */
function symbolOf(node: SgNode): string {
	const names: string[] = [];
	let constName: string | undefined;
	for (let at = node.parent(); at; at = at.parent()) {
		const kind = String(at.kind());
		const name = at.field("name")?.text();
		if (!name) continue;
		if (FUNCTION_NODES.has(kind) || kind === "class_declaration")
			names.unshift(name);
		else if (kind === "variable_declarator") {
			const value = at.field("value");
			if (value && FUNCTION_VALUES.has(String(value.kind())))
				names.unshift(name);
			else constName = name;
		}
	}
	if (names.length > 0) return names.join(".");
	return constName ?? "<module>";
}

const COMPARISONS = new Set(["===", "!==", "==", "!="]);
const MEMBERSHIP_CALLS = /\.(?:includes|has|startsWith|endsWith|indexOf)$/;

/**
 * Contexts that can never start a process: a comparison operand, a `case`
 * label, the argument of a membership test, a string-literal TYPE. A literal
 * anywhere else (an array element, a property value, a variable, an argument)
 * is not proven benign and counts.
 */
function isBenignContext(node: SgNode): boolean {
	const parent = node.parent();
	if (!parent) return false;
	const kind = String(parent.kind());
	if (kind === "literal_type" || kind === "switch_case") return true;
	if (kind === "binary_expression")
		return COMPARISONS.has(parent.field("operator")?.text() ?? "");
	if (kind === "arguments") {
		const callee = parent.parent()?.field("function")?.text() ?? "";
		return MEMBERSHIP_CALLS.test(callee);
	}
	return false;
}

/**
 * A node's identity within one parse: its byte range and kind (a parent and
 * its only child can share a range, never a kind).
 */
function nodeId(node: SgNode): string {
	const { start, end } = node.range();
	return `${start.index}:${end.index}:${String(node.kind())}`;
}

/** Direct children by parent link, so no traversal accessor is spelled here. */
type Kids = (node: SgNode) => SgNode[];

/** A string or template with no substitution, cooked; else `undefined`. */
function literalValue(node: SgNode, kids: Kids): string | undefined {
	const kind = String(node.kind());
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

function isFoldedInto(node: SgNode, kids: Kids): boolean {
	let parent = node.parent();
	while (parent) {
		const kind = String(parent.kind());
		if (kind === "parenthesized_expression") {
			parent = parent.parent();
			continue;
		}
		return (
			kind === "binary_expression" && literalValue(parent, kids) !== undefined
		);
	}
	return false;
}

function wordsOf(value: string): string[] {
	const hits: string[] = [];
	if (VOCABULARY.has(value.trim())) hits.push(value.trim());
	const tokens = value.trim().split(/\s+/);
	const verb = tokens.slice(1).find((token) => SHELL_VERBS.has(token));
	if (tokens.length > 1 && SHELL_PROGRAMS.has(tokens[0] as string) && verb)
		hits.push(`${tokens[0]} ${verb}`);
	return hits;
}

/**
 * Cheap narrowing, never the decision: a file with no quoted word that starts
 * a vocabulary token or a shell line, no literal concatenation and no escaped
 * literal cannot hold a hit, and skipping its parse keeps native trees off the
 * census's memory budget.
 */
const QUOTED_WORD = new RegExp(
	`["'\`]\\s*(?:${[...new Set([...VOCABULARY, ...SHELL_PROGRAMS])].join("|")})(?![\\w-])`,
);
function mayHoldVocabulary(source: string): boolean {
	const code = stripSource(source, { strings: "keep" });
	return (
		QUOTED_WORD.test(code) ||
		/["'`]\s*\+\s*["'`]/.test(code) ||
		/["'`][^"'`\n]*\\[xu0-9]/.test(code)
	);
}

/** Install-vocabulary literals in one source, by cooked value. */
function scanHits(source: string): Hit[] {
	if (!mayHoldVocabulary(source)) return [];
	const hits = new Map<string, Hit>();
	const nodes = parseNodes(source.replace(/\r\n/g, "\n"));
	const kidsOf = new Map<string, SgNode[]>();
	for (const node of nodes) {
		const parent = node.parent();
		if (!parent) continue;
		const id = nodeId(parent);
		kidsOf.set(id, [...(kidsOf.get(id) ?? []), node]);
	}
	const kids: Kids = (node) => kidsOf.get(nodeId(node)) ?? [];
	for (const node of nodes) {
		const kind = String(node.kind());
		// `string` is also the anonymous type keyword; only a quoted node is a literal.
		if (
			(kind !== "string" &&
				kind !== "template_string" &&
				kind !== "binary_expression") ||
			(kind !== "binary_expression" && !/^["'`]/.test(node.text()))
		)
			continue;
		if (isFoldedInto(node, kids) || isBenignContext(node)) continue;
		const line = node.range().start.line + 1;
		const record = (at: SgNode, word: string): void => {
			const symbol = symbolOf(at);
			const key = `${symbol}:${word}`;
			if (!hits.has(key)) hits.set(key, { line, word, symbol });
		};
		const value = literalValue(node, kids);
		if (value === undefined) {
			if (kind === "template_string") {
				// A template with a substitution: read it as a shell line with each
				// `${...}` as one opaque word, so `npm install ${pkg}` counts and a
				// prose message that merely says "install" does not.
				const words = wordsOf(
					node
						.text()
						.slice(1, -1)
						.replace(/\$\{[^}]*\}/g, "\0"),
				);
				if (words.length > 0) record(node, words[0] as string);
			} else if (kind === "string") {
				// A string this reader cannot decode (a legacy octal escape): it
				// may spell anything, so it counts (fail closed).
				record(node, "undecodable");
			}
			continue;
		}
		const words = wordsOf(value);
		if (words.length > 0) record(node, words[0] as string);
	}
	return [...hits.values()].sort((a, b) => a.line - b.line);
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
			if (at >= 0 && at < (consults[0] as number)) {
				problems.push(
					`${file}: ${entry.symbol} reaches ${token} before its first consult`,
				);
			}
		}
	}
	return problems;
}

/** Everything this census judges, for one set of sources. */
function judge(
	sources: ReadonlyArray<{ rel: string; source: string }>,
	rows: Readonly<Record<string, string>>,
	gatedFiles: Readonly<Record<string, GatedFile>>,
) {
	const flagged: Array<{ key: string; detail: string }> = [];
	let scanned = 0;
	for (const { rel, source } of sources) {
		scanned += 1;
		const hits = scanHits(source);
		if (hits.length === 0) continue;
		for (const hit of hits)
			flagged.push({
				key: `${rel}#${hit.symbol}:${hit.word}`,
				detail: `${rel}:${hit.line}`,
			});
	}
	const registered: string[] = [];
	const exemptions: Record<string, string> = {};
	for (const [key, value] of Object.entries(rows)) {
		if (value === GATED) registered.push(key);
		else exemptions[key] = value;
	}
	const audit = auditRegistry({
		sweepName: "install-kill-switch census (#5231)",
		flagged,
		registered,
		exemptions,
		minFlagged: 1,
		scannedCount: scanned,
		minScanned: 1,
		remediation:
			"A literal spells an installer. Route the install through isToolInstallDisabled() " +
			"(clients/env-utils.ts) and register its row as GATED in a GATED_FILES entry, or " +
			"exempt it with the reason it is not an install spawn.",
	});
	const problems = [...audit.problems];
	const sourceByRel = new Map(sources.map((s) => [s.rel, s.source]));
	for (const key of registered) {
		const rel = key.split("#")[0] as string;
		if (!Object.hasOwn(gatedFiles, rel))
			problems.push(
				`${key}: registered GATED but ${rel} has no GATED_FILES entry`,
			);
	}
	for (const [rel, gated] of Object.entries(gatedFiles)) {
		const source = sourceByRel.get(rel);
		if (source === undefined) problems.push(`${rel}: gated file not scanned`);
		else problems.push(...entryProblems(rel, source, gated));
	}
	return { problems, flagged };
}

const GATED = "GATED";

const BUILDER =
	"an argv builder that starts nothing: its callers (installNpmTool behind installTool, performNpmRefresh behind acquireManagedInstallGate) spawn";
const LSP_SWITCH =
	"an LSP server install: governed by PI_LENS_DISABLE_LSP_INSTALL (canInstall in clients/lsp/server.ts), a separate switch this census does not pin";
const NPX_UNGATED =
	"KNOWN UNGATED: an npx package-runner fallback that can download a package and does not consult PI_LENS_DISABLE_TOOL_INSTALL; baseline that shrinks on purpose (PR body names the follow-up)";
const NPX_NO =
	"npx --no: the package runner is told to use the local/cached copy and never download, so nothing is installed";
const LABEL =
	"a log subsystem, hint or message string, a tag, or a candidate name: data, never an argv handed to a process";
const PROBE_ONLY =
	"a presence or prefix probe that installs nothing; any install it precedes is a gated row above";

/** Row value: GATED, or the reason the literal is not a gated install spawn. */
const ROWS: Readonly<Record<string, string>> = {
	// ROWS-BEGIN
	// -- gated: the install spawns the tool switch governs (entries verified) --
	"clients/dispatch/runners/utils/lazy-installer.ts#LAZY_INSTALL_SPECS:add":
		GATED,
	"clients/dispatch/runners/utils/lazy-installer.ts#LAZY_INSTALL_SPECS:component":
		GATED,
	"clients/dispatch/runners/utils/lazy-installer.ts#LAZY_INSTALL_SPECS:install":
		GATED,
	"clients/dispatch/runners/utils/lazy-installer.ts#LAZY_INSTALL_SPECS:rustup":
		GATED,
	"clients/govulncheck-client.ts#GovulncheckClient.doEnsureAvailable:install":
		GATED,
	"clients/installer/index.ts#installGemTool:install": GATED,
	"clients/installer/index.ts#installPipTool:install": GATED,
	"clients/installer/index.ts#installPipTool:pipx": GATED,
	"clients/installer/index.ts#installPipTool:upgrade": GATED,
	// -- argv builders: the spawn is in a gated caller --
	"clients/package-manager.ts#installArgs:add": BUILDER,
	"clients/package-manager.ts#installArgs:install": BUILDER,
	"clients/package-manager.ts#updateArgs:update": BUILDER,
	"clients/package-manager.ts#updateArgs:upgrade": BUILDER,
	// -- LSP server installs: PI_LENS_DISABLE_LSP_INSTALL, a separate switch --
	"clients/lsp/server.ts#tryDotnetToolInstall:install": LSP_SWITCH,
	"clients/lsp/server.ts#tryDotnetToolInstall:update": LSP_SWITCH,
	"clients/lsp/server.ts#tryGemInstall:install": LSP_SWITCH,
	"clients/lsp/server.ts#tryGoInstallGopls:install": LSP_SWITCH,
	// -- KNOWN UNGATED: npx fallbacks that can download (baseline, shrinks) --
	"clients/biome-client.ts#BiomeClient.getBiomeBinary:npx": NPX_UNGATED,
	"clients/dependency-checker.ts#DependencyChecker.doResolveMadge:npx":
		NPX_UNGATED,
	"clients/formatters.ts#biomeFormatter:npx": NPX_UNGATED,
	"clients/formatters.ts#prettierFormatter:npx": NPX_UNGATED,
	"clients/jscpd-client.ts#JscpdClient.runScan:npx": NPX_UNGATED,
	"clients/test-runner-client.ts#RUNNERS:npx": NPX_UNGATED,
	// -- cache-only npx (--no): never downloads --
	"clients/dispatch/runners/utils/runner-helpers.ts#getSgCommand:npx": NPX_NO,
	"clients/dispatch/runners/utils/runner-helpers.ts#isSgAvailableAsync:npx":
		NPX_NO,
	"clients/dispatch/runners/utils/runner-helpers.ts#resolveLocalFirstAsync:npx":
		NPX_NO,
	"clients/sg-runner.ts#SgRunner.doEnsureAvailable:npx": NPX_NO,
	// -- not a process start --
	"clients/dispatch/runners/utils/lazy-installer.ts#performInstall:install":
		LABEL,
	"clients/dispatch/runners/utils/lazy-installer.ts#runLazyInstall:install":
		LABEL,
	"clients/formatters.ts#detect:rustup": PROBE_ONLY,
	"clients/govulncheck-client.ts#GovulncheckClient.doEnsureAvailable:go install":
		LABEL,
	"clients/installer/index.ts#installPipTool:pip install": LABEL,
	"clients/knip-client.ts#KnipClient.unavailableResult:npm install": LABEL,
	"clients/lsp/server.ts#rubyBinCandidates:mise": LABEL,
	"clients/out-of-band-changes.ts#lookOnce:install": LABEL,
	"clients/out-of-band-changes.ts#outOfBandChange:install": LABEL,
	"clients/python-provenance.ts#PYTHON_SQLALCHEMY_STATEMENT_BUILDERS:update":
		LABEL,
	"clients/sg-runner.ts#SgRunner.probeHomebrew:brew": PROBE_ONLY,
	// ROWS-END
};

describe("install kill-switch census (#5231)", () => {
	let sources: Array<{ rel: string; source: string }>;
	let verdict: ReturnType<typeof judge>;
	beforeAll(() => {
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
		verdict = judge(sources, ROWS, GATED_FILES);
	}, 120_000);

	it("pins every install-vocabulary literal to the gate or a reason", () => {
		expect(verdict.problems).toEqual([]);
	});

	it("keeps every row's reason a real sentence and every GATED row inside a gated file", () => {
		const reasons = Object.values(ROWS).filter((value) => value !== GATED);
		expect(reasons.length).toBeGreaterThan(0);
		for (const reason of reasons) expect(reason.length).toBeGreaterThan(30);
	});
});

// Planted spellings (AGENTS.md shape 69): each is a bypass its author did not
// design the vocabulary for, and each must be a finding, not a pass.
describe("install kill-switch census: planted bypasses (#5231)", () => {
	const plant = (source: string) => [{ rel: "clients/planted.ts", source }];
	const flaggedBy = (source: string) =>
		judge(plant(source), {}, {}).problems.join("\n");

	it("a new unregistered gem install spawn is a finding", () => {
		expect(
			flaggedBy(
				`import { safeSpawnAsync } from "./safe-spawn.js";\nexport const go = () => safeSpawnAsync("gem", ["install", "rubocop"]);`,
			),
		).toMatch(/clients\/planted\.ts#go:install/);
	});

	it("an aliased import is a finding", () => {
		expect(
			flaggedBy(
				`import { safeSpawnAsync as run } from "./safe-spawn.js";\nexport function go() { return run("rustup", ["component", "add", "x"]); }`,
			),
		).toMatch(/planted\.ts#go:rustup/);
	});

	it("an indirect call through a local binding is a finding", () => {
		expect(
			flaggedBy(
				`import { safeSpawnAsync } from "./safe-spawn.js";\nexport function go() { const sp = safeSpawnAsync; return sp("pipx", ["run", "x"]); }`,
			),
		).toMatch(/planted\.ts#go:pipx/);
	});

	it("a value reached through another binding is a finding", () => {
		expect(
			flaggedBy(
				`export function go(run: Function) { const verb = "install"; const cmd = "pip"; return run(cmd, [verb, "x"]); }`,
			),
		).toMatch(/planted\.ts#go:install/);
	});

	it("an escape-spelled literal is a finding", () => {
		expect(flaggedBy(`export const argv = ["inst\\x61ll", "x"];`)).toMatch(
			/planted\.ts#argv:install/,
		);
		expect(flaggedBy(`export const argv = ["\\u0069nstall", "x"];`)).toMatch(
			/planted\.ts#argv:install/,
		);
	});

	it("a concatenated literal is a finding", () => {
		expect(flaggedBy(`export const argv = ["inst" + "all", "x"];`)).toMatch(
			/planted\.ts#argv:install/,
		);
		expect(
			flaggedBy(`export const argv = [("in" + "st") + ("al" + "l")];`),
		).toMatch(/planted\.ts#argv:install/);
	});

	it("a shell line and a templated shell line are findings", () => {
		expect(flaggedBy(`export const cmd = "pip install x";`)).toMatch(
			/planted\.ts#cmd:pip install/,
		);
		expect(
			flaggedBy("export function go(p: string) { return `npm install ${p}`; }"),
		).toMatch(/planted\.ts#go:npm install/);
	});

	it("an undecodable string is a finding, not a pass", () => {
		expect(flaggedBy(`export const odd = "\\07";`)).toMatch(
			/planted\.ts#odd:undecodable/,
		);
	});

	it("words in a comment or a comparison are not findings", () => {
		const quiet = `// gem install rubocop; rustup component add\n/* "install" */\nexport function go(cmd: string) { return cmd === "npx" || ["a"].includes("install"); }`;
		expect(scanHits(quiet)).toEqual([]);
	});

	it("a gated file whose entry never consults the shared check is a finding", () => {
		const gated = {
			"clients/planted.ts": {
				entries: [{ symbol: "go", before: ["spawn("], consults: 1 }],
			},
		};
		const run = (source: string) =>
			judge(plant(source), { "clients/planted.ts#go:install": GATED }, gated)
				.problems;
		// No consult at all.
		expect(
			run(`export function go() { return spawn("gem", ["install"]); }`),
		).toContainEqual(expect.stringMatching(/go consults the shared check 0x/));
		// A consult that exists only in a comment.
		expect(
			run(
				`export function go() { /* isToolInstallDisabled() */ return spawn("gem", ["install"]); }`,
			),
		).toContainEqual(expect.stringMatching(/go consults the shared check 0x/));
		// A consult AFTER the spawn.
		expect(
			run(
				`export function go() { spawn("gem", ["install"]); return isToolInstallDisabled(); }`,
			),
		).toContainEqual(
			expect.stringMatching(/reaches spawn\( before its first consult/),
		);
		// The honest shape is clean.
		expect(
			run(
				`export function go() { if (isToolInstallDisabled()) return false; return spawn("gem", ["install"]); }`,
			),
		).toEqual([]);
	});

	it("a row whose literal is gone is stale", () => {
		expect(
			judge(
				plant(
					`export const argv = ["gem", "x"];\nexport const w = ["install"];`,
				),
				{
					"clients/planted.ts#gone:install":
						"a reason that is long enough to count",
				},
				{},
			).problems.join("\n"),
		).toMatch(/no longer flags/);
	});
});

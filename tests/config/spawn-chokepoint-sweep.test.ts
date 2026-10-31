/**
 * #4530: every runtime process start goes through the spawn chokepoint, or
 * carries a reasoned admission.
 *
 * ## The recurrence this guards
 *
 * `safeSpawnAsync`/`safeSpawn` (`clients/safe-spawn.ts`) judge every start
 * against project trust before they resolve or start anything: the child's
 * search path loses the session repository's own directories, and a bare
 * lookup that still resolves into the project is refused. A raw
 * `node:child_process` start never reaches that judgment. #4566 met that
 * nineteen times, one review per caller (a lazy `gem install`, `rustup
 * component add`, an interpreter's `-m site --user-base` probe, the pip
 * follow-up probe, the archive extraction), because guarding callers one by
 * one cannot converge: a new caller is a new hole. This sweep enumerates the
 * population instead, and makes every member either routed or admitted here
 * with a reason, a pinned site count and liveness evidence.
 *
 * ## Fail closed (defect shape 69)
 *
 * The population is derived from the `child_process` module binding itself,
 * read off the parsed source (`@ast-grep/napi`, through the AST census seam),
 * never from a list of spellings. Every literal that names the module must sit
 * in an ADMITTED binding form (see `scanProcessStarts`); any other form that
 * names it (a string-named specifier, a re-export, a require inside an
 * expression, a dynamic `import()`) is reported. Then every reference to a
 * bound name must be a CALL (`spawn(`, `cp.spawn(`). A bound name used any
 * other way (`const run = spawn`, passed as an argument, a property read off
 * the namespace) is reported as unclassified. Comments are not code and a
 * string's text is not a binding, so neither can add or hide a start (#4776
 * review H2: the text reader this replaced missed a string-named specifier and
 * a require inside template text, the second round of missed spellings).
 *
 * Each admission pins its site count, compared to the live count in both
 * directions, and names evidence the file's CODE must still carry (comments
 * blanked; strings kept, because a fixed system literal such as `taskkill` is
 * the evidence for some of them).
 */

import * as path from "node:path";
import type { SgNode } from "@ast-grep/napi";
import { beforeAll, describe, expect, it } from "vitest";
import { parseNodes } from "../support/ast-census.js";
import { cookedIdentifier, cookedString } from "../support/cooked-literal.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** The shipped runtime, the only population the invariant governs. */
const RUNTIME_ROOTS = ["clients", "tools", "mcp"] as const;

/** `node:child_process` members that start a process. */
const PROCESS_MEMBERS = [
	"fork",
	"spawn",
	"spawnSync",
	"exec",
	"execFile",
	"execFileSync",
	"execSync",
] as const;

/**
 * The unref'd collector (`clients/child-unref.ts`) starts a process on its
 * caller's behalf, so a call of it is a start too.
 */
const WRAPPER_CALLEE = "spawnCollectStdoutResult";

interface Admission {
	/** Why this start does not route through the chokepoint. */
	reason: string;
	/** How many start sites the file has under this key, compared exactly. */
	sites: number;
	/** Code the file must still carry (comments blanked, strings kept). */
	evidence: string;
}

/**
 * Reasoned exceptions, keyed `repo-relative path#callee`. Each answers a
 * question the chokepoint does not ask, or cannot be reached by it.
 */
const ADMITTED: Readonly<Record<string, Admission>> = {
	"clients/safe-spawn.ts#spawn": {
		reason:
			"the chokepoint's own child start (safeSpawnAsync runs admitSpawn before it resolves or starts anything) and its taskkill teardown, whose System32 path now resolves through `windowsExe`",
		sites: 2,
		evidence: "admitSpawn(",
	},
	"clients/safe-spawn.ts#spawnSync": {
		reason:
			"the chokepoint's own synchronous start (safeSpawn runs admitSpawn first) plus its taskkill and chcp teardowns, whose System32 paths now resolve through `windowsExe`",
		sites: 4,
		evidence: "admitSpawn(",
	},
	"clients/lsp/launch.ts#nodeSpawn": {
		reason:
			"the LSP launcher's own starts (trySpawn's shell and direct arms): its PATH scan and child PATH are trust-scoped (trustScopedEnvironment), a bare command resolving into the project is refused (refuseProjectLookup), and the served-root project-local gate (#4248) runs on top; plus its taskkill teardown, whose System32 path now resolves through `windowsExe`",
		sites: 3,
		evidence: "refuseProjectLookup(command, spawnCommand, cwd, env)",
	},
	"clients/lsp/client.ts#nodeSpawn": {
		reason:
			"a taskkill teardown of a language server this process already started, whose System32 path now resolves through `windowsExe`",
		sites: 1,
		evidence: "taskkill",
	},
	"clients/instance-reaper.ts#nodeSpawn": {
		reason:
			"a fixed system taskkill literal in the reaper's failure path, which already reports an unverified kill",
		sites: 1,
		evidence: "taskkill",
	},
	"clients/child-unref.ts#nodeSpawn": {
		reason:
			"the unref'd collector cannot import the seam (safe-spawn depends on it), and its callers pass only fixed system process-table queries",
		sites: 1,
		evidence: "export function spawnCollectStdoutResult(",
	},
	"clients/process-snapshot.ts#spawnCollectStdoutResult": {
		reason:
			"process-table queries through the unref'd collector with fixed ps/wmic/PowerShell literals; a refused query yields no rows, never a wrong kill",
		sites: 2,
		evidence: "buildProcessQuery",
	},
	"clients/mcp/review.ts#spawn": {
		reason:
			"the analyze worker's interpreter is the running node (`process.execPath`), an absolute file this process already runs, never a search-path lookup",
		sites: 1,
		evidence: "spawn(process.execPath",
	},
};

/**
 * Files whose code names the module in a way that binds nothing, with how many
 * such mentions each has (compared exactly) and why.
 */
const UNBOUND_MENTIONS: Readonly<
	Record<string, { mentions: number; reason: string }>
> = {
	"clients/tree-sitter-client.ts": {
		mentions: 1,
		reason:
			"a tree-sitter rule compares a captured import specifier with the text child_process; it reads analysed code and binds no module",
	},
};

const MODULE_NAMES: ReadonlySet<string> = new Set([
	"child_process",
	"node:child_process",
]);

interface ScanResult {
	/** `callee` (the local name, or `namespace.member`) → 1-based lines. */
	sites: Map<string, number[]>;
	/** References this reader could not place, with a line. */
	unclassified: string[];
	/** Module mentions no admitted form places. */
	unboundMentions: number;
}

/**
 * A node's identity within one parse: its byte range and kind (a parent and
 * its only child can share a range, never a kind).
 */
function nodeId(node: SgNode): string {
	const { start, end } = node.range();
	return `${start.index}:${end.index}:${String(node.kind())}`;
}

function lineOf(node: SgNode): number {
	return node.range().start.line + 1;
}

/** Punctuation and comments: the only children a recognised form may carry besides its parts. */
const INERT_KINDS: ReadonlySet<string> = new Set([
	"{",
	"}",
	",",
	"(",
	")",
	"comment",
]);

/** The collector's module, repo-relative, without its extension. */
const WRAPPER_MODULE = "clients/child-unref";

/**
 * `text` with every escape that can spell a character decoded and every other
 * backslash dropped (#4776 verify V5). It holds every cooked spelling a
 * literal or an identifier in `text` can carry, so a name spelled through an
 * escape is still in it; an escaped backslash may make it read one name too
 * many, which costs a parse or a refusal, never a missed name. A backslash is
 * spelled `\x5c` in these patterns.
 */
function looseText(text: string): string {
	return text
		.replace(
			/\x5cu\{([0-9a-fA-F]+)\}|\x5cu([0-9a-fA-F]{4})|\x5cx([0-9a-fA-F]{2})/g,
			(whole: string, braced?: string, four?: string, two?: string) => {
				const point = Number.parseInt(braced ?? four ?? two ?? "", 16);
				return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
			},
		)
		.replace(/\x5c\r?\n/g, "")
		.replace(/\x5c/g, "");
}

/**
 * Process starts in one source file. `file` is repo-relative and only used in
 * the reported text, so the planted cases below drive this directly.
 *
 * #4776 review H2 (the second round that found a spelling the text reader
 * missed): the source is parsed, and the reader ADMITS a short list of binding
 * forms. Every other node that names the module is reported, so a spelling
 * nobody planned for fails closed:
 *
 * - `import` with a default, namespace or named clause whose specifiers are
 *   identifiers (`spawn`, `spawn as x`, `default as cp`, `type X`), a
 *   side-effect `import`, and `import type`;
 * - `const <name | { member, member: local }> = require(<module>)`;
 * - `typeof import(<module>)`, which starts nothing.
 *
 * A bound name must then be used only as a call (`spawn(`, `cp.spawn(`).
 *
 * #4776 verify V5 (the third round on one seam, so the rule, not a case):
 * every name is read by its COOKED value in every position, never by node
 * kind or source text (`nameOf`). The collector is admitted in four forms
 * only: its declaration, an unaliased import or export specifier, and a plain
 * call (a site). Every other node whose cooked value is its name is refused:
 * a member read, a string key, a computed key, a string specifier, a template,
 * a variable that holds the name. The collector's module is bound like
 * child_process's: an import (its named specifiers judged by that name rule),
 * a named re-export, or `typeof import(…)`; every other mention is refused,
 * and a namespace or default binding of it may only be read as
 * `ns.<identifier>`, so a key built at run time is refused at the subscript.
 */
function scanProcessStarts(file: string, source: string): ScanResult {
	// A cheap text narrowing, never the decision: a literal that names either
	// module, and any spelling of the collector, holds that name in the file's
	// loose text, escapes included (#4776 verify V5). A file with none binds
	// nothing, and skipping its parse keeps the census to the few files that
	// can (parsing every runtime file held a native tree per file and peaked
	// over the 2 GB worker budget in CI). Stated bound: a specifier built at
	// run time (`import(name)`, `require(name)`) is not a literal, so no
	// reader of source sees it.
	const loose = looseText(source);
	if (
		!loose.includes("child_process") &&
		!loose.includes("child-unref") &&
		!loose.includes(WRAPPER_CALLEE)
	)
		return { sites: new Map(), unclassified: [], unboundMentions: 0 };
	const nodes = parseNodes(source.replace(/\r\n/g, "\n"));
	const kidsOf = new Map<string, SgNode[]>();
	for (const node of nodes) {
		const parent = node.parent();
		if (!parent) continue;
		const id = nodeId(parent);
		const kids = kidsOf.get(id) ?? [];
		kids.push(node);
		kidsOf.set(id, kids);
	}
	const kids = (node: SgNode): SgNode[] => kidsOf.get(nodeId(node)) ?? [];
	const same = (a: SgNode | null | undefined, b: SgNode): boolean =>
		a !== null && a !== undefined && nodeId(a) === nodeId(b);
	const kindOf = (node: SgNode | null | undefined): string =>
		String(node?.kind());

	/**
	 * The name a node spells, by its cooked value: a whole string or template
	 * is its cooked string; any other leaf is its cooked identifier; the
	 * pieces inside a string or template name nothing alone. A template with a
	 * substitution keeps its `${` in that value, which no name holds, so it
	 * names nothing. A string `cookedString` cannot decode reads as its loose
	 * value, which can only add a refusal: module code refuses octal escapes,
	 * and a simple escape cooks to a control character no name holds.
	 */
	const nameOf = (node: SgNode): string | undefined => {
		const kind = kindOf(node);
		const text = node.text();
		if (kind === "string" || kind === "template_string")
			return cookedString(text) ?? looseText(text.slice(1, -1));
		if (kids(node).length > 0) return undefined;
		const parentKind = kindOf(node.parent());
		if (parentKind === "string" || parentKind === "template_string")
			return undefined;
		return cookedIdentifier(text);
	};

	/** The governed module a string or template names, by its cooked value. */
	const moduleOf = (
		node: SgNode,
	): "child_process" | "collector" | undefined => {
		const kind = kindOf(node);
		if (kind !== "string" && kind !== "template_string") return undefined;
		const value = nameOf(node);
		if (value === undefined) return undefined;
		if (MODULE_NAMES.has(value)) return "child_process";
		if (
			value.startsWith(".") &&
			path.posix
				.join(path.posix.dirname(file), value)
				.replace(/\.[cm]?[jt]s$/, "") === WRAPPER_MODULE
		)
			return "collector";
		return undefined;
	};

	const members = new Set<string>();
	const namespaces = new Set<string>();
	/** Namespace and default bindings of the collector's module. */
	const collectorNamespaces = new Set<string>();
	const bindingNodes = new Set<string>();
	const unclassified: string[] = [];
	let unboundMentions = 0;
	const refuse = (node: SgNode, what: string): void => {
		unclassified.push(`${file}:${lineOf(node)}: ${what}`);
	};
	const bind = (target: Set<string>, local: SgNode): void => {
		target.add(cookedIdentifier(local.text()));
		bindingNodes.add(nodeId(local));
	};
	const bindMember = (imported: SgNode, local: SgNode): void => {
		const name = cookedIdentifier(imported.text());
		if ((PROCESS_MEMBERS as readonly string[]).includes(name))
			bind(members, local);
		else bindingNodes.add(nodeId(local));
	};

	/**
	 * An `import … from <module>`: true when every part is a known form. For
	 * the collector's module only the namespace or default name binds; each
	 * named specifier is judged by the collector's name rule below.
	 */
	const readImport = (
		statement: SgNode,
		module: "child_process" | "collector",
	): boolean => {
		const namespaceTarget =
			module === "collector" ? collectorNamespaces : namespaces;
		const parts = kids(statement);
		if (parts.some((part) => kindOf(part) === "type")) return true;
		const clause = parts.find((part) => kindOf(part) === "import_clause");
		if (!clause) return true; // a side-effect import binds nothing
		for (const part of kids(clause)) {
			const kind = kindOf(part);
			if (kind === "identifier") bind(namespaceTarget, part);
			else if (kind === "namespace_import") {
				const local = kids(part).find(
					(child) => kindOf(child) === "identifier",
				);
				if (!local) return false;
				bind(namespaceTarget, local);
			} else if (kind === "named_imports") {
				if (module === "collector") continue;
				for (const entry of kids(part)) {
					const entryKind = kindOf(entry);
					if (INERT_KINDS.has(entryKind)) continue;
					if (entryKind !== "import_specifier") return false;
					if (kids(entry).some((k) => kindOf(k) === "type")) continue;
					const name = entry.field("name");
					const alias = entry.field("alias");
					if (kindOf(name) !== "identifier" || !name) return false;
					if (alias && kindOf(alias) !== "identifier") return false;
					const local = alias ?? name;
					if (cookedIdentifier(name.text()) === "default")
						bind(namespaces, local);
					else bindMember(name, local);
				}
			} else if (!INERT_KINDS.has(kind)) return false;
		}
		return true;
	};

	/** `const <pattern> = require(<module>)`: true when the pattern is a known form. */
	const readRequire = (call: SgNode): boolean => {
		const declarator = call.parent();
		if (kindOf(declarator) !== "variable_declarator" || !declarator)
			return false;
		if (!same(declarator.field("value"), call)) return false;
		const target = declarator.field("name");
		if (!target) return false;
		if (kindOf(target) === "identifier") {
			bind(namespaces, target);
			return true;
		}
		if (kindOf(target) !== "object_pattern") return false;
		for (const entry of kids(target)) {
			const kind = kindOf(entry);
			if (INERT_KINDS.has(kind)) continue;
			if (kind === "shorthand_property_identifier_pattern") {
				bindMember(entry, entry);
				continue;
			}
			if (kind !== "pair_pattern") return false;
			const key = entry.field("key");
			const value = entry.field("value");
			if (kindOf(key) !== "property_identifier" || !key) return false;
			if (kindOf(value) !== "identifier" || !value) return false;
			bindMember(key, value);
		}
		return true;
	};

	for (const node of nodes) {
		const module = moduleOf(node);
		if (module === undefined) continue;
		const parent = node.parent();
		const parentKind = kindOf(parent);
		const isSource = parent !== null && same(parent.field("source"), node);
		if (parent && parentKind === "import_statement") {
			if (!isSource || !readImport(parent, module))
				refuse(
					parent,
					`an import of ${module === "collector" ? "the collector's module" : "child_process"} with a binding this reader cannot follow`,
				);
			continue;
		}
		const call = parent?.parent();
		const isSoleArgument =
			parent !== null &&
			parentKind === "arguments" &&
			kids(parent).every(
				(kid) => same(kid, node) || INERT_KINDS.has(kindOf(kid)),
			);
		if (call && isSoleArgument && kindOf(call) === "call_expression") {
			const callee = call.field("function");
			const calleeKind = kindOf(callee);
			if (
				module === "child_process" &&
				calleeKind === "identifier" &&
				callee?.text() === "require"
			) {
				if (!readRequire(call))
					refuse(
						call,
						"a require of child_process bound to a pattern this reader cannot follow",
					);
				continue;
			}
			if (calleeKind === "import" && kindOf(call.parent()) === "type_query")
				continue; // `typeof import(…)` starts nothing
		}
		if (module === "collector") {
			// A named re-export: each specifier is judged by the name rule.
			if (
				parentKind === "export_statement" &&
				isSource &&
				kids(parent).some((kid) => kindOf(kid) === "export_clause")
			)
				continue;
			refuse(
				node,
				"a reference to the collector's module this reader cannot follow",
			);
			continue;
		}
		unboundMentions += 1;
	}
	const unbound = unboundMentions;
	if (UNBOUND_MENTIONS[file]?.mentions !== unbound) {
		for (let index = 0; index < unbound; index += 1) {
			unclassified.push(
				`${file}: an unplaceable child_process reference: bind the module (import, namespace import, or require) so the scan can follow it`,
			);
		}
	}

	const sites = new Map<string, number[]>();
	const add = (callee: string, node: SgNode): void => {
		const lines = sites.get(callee) ?? [];
		lines.push(lineOf(node));
		sites.set(callee, lines);
	};
	const isCallee = (node: SgNode): boolean => {
		const parent = node.parent();
		return (
			kindOf(parent) === "call_expression" &&
			same(parent?.field("function"), node)
		);
	};
	for (const node of nodes) {
		const name = nameOf(node);
		if (name === undefined) continue;
		const kind = kindOf(node);
		// #4776 verify V1 and V5: any node whose cooked value is the
		// collector's name, in the four admitted forms or refused.
		if (name === WRAPPER_CALLEE) {
			const parent = node.parent();
			const parentKind = kindOf(parent);
			if (kind === "identifier" && isCallee(node)) add(WRAPPER_CALLEE, node);
			else if (
				kind === "identifier" &&
				parentKind === "function_declaration" &&
				same(parent?.field("name"), node)
			)
				continue;
			else if (
				kind === "identifier" &&
				(parentKind === "import_specifier" ||
					parentKind === "export_specifier") &&
				!parent?.field("alias")
			)
				continue;
			else refuse(node, `${WRAPPER_CALLEE} is used other than by a call`);
			continue;
		}
		// A local binding is referenced only through these two kinds in the
		// grammar: a `property_identifier` is a property's name, a
		// `type_identifier` a type, and a string a value, none a reference.
		if (kind !== "identifier" && kind !== "shorthand_property_identifier")
			continue;
		if (bindingNodes.has(nodeId(node))) continue;
		if (members.has(name)) {
			if (kind === "identifier" && isCallee(node)) add(name, node);
			else
				refuse(
					node,
					`${name} (a child_process start) is used other than by a call; an alias or a passed reference hides its starts`,
				);
			continue;
		}
		const access = node.parent();
		const property = access?.field("property");
		const isMemberObject =
			kind === "identifier" &&
			kindOf(access) === "member_expression" &&
			same(access?.field("object"), node);
		if (collectorNamespaces.has(name)) {
			// The property itself is judged by the collector's name rule above.
			if (!isMemberObject)
				refuse(
					node,
					`${name} (the collector's module) is used other than by a member read`,
				);
			continue;
		}
		if (!namespaces.has(name)) continue;
		const member = property ? cookedIdentifier(property.text()) : "";
		if (
			isMemberObject &&
			access &&
			(PROCESS_MEMBERS as readonly string[]).includes(member) &&
			isCallee(access)
		)
			add(`${name}.${member}`, node);
		else
			refuse(
				node,
				`${name} (the child_process module) is used other than by a start call`,
			);
	}
	return { sites, unclassified, unboundMentions: unbound };
}

/**
 * Whether `source`'s code still carries `evidence`: comments blanked, so a
 * comment quoting the evidence cannot keep an admission alive; strings kept,
 * because a fixed literal is the evidence for some admissions.
 */
function carriesEvidence(source: string, evidence: string): boolean {
	return stripSource(source, { strings: "keep" }).includes(evidence);
}

function runtimeFiles(): string[] {
	const files = RUNTIME_ROOTS.flatMap((root) =>
		listSourceFiles(path.join(REPO_ROOT, root), {
			extensions: [".ts"],
			skipTests: true,
		}),
	);
	files.push(path.join(REPO_ROOT, "index.ts"));
	return files.sort();
}

async function census(files: readonly string[]): Promise<{
	counts: Map<string, number>;
	details: Map<string, string>;
	unclassified: string[];
	scanned: number;
	sources: Map<string, string>;
	unbound: Map<string, number>;
}> {
	const counts = new Map<string, number>();
	const unbound = new Map<string, number>();
	const details = new Map<string, string>();
	const sources = new Map<string, string>();
	const unclassified: string[] = [];
	let scanned = 0;
	for (const { file, source } of readWalkedFiles(files)) {
		scanned += 1;
		const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
		sources.set(relative, source);
		const result = scanProcessStarts(relative, source);
		// AGENTS shape 81 (#4776 verify V3): a parsed tree is freed only when
		// the event loop turns, so the census turns it once per file.
		await new Promise<void>((resolve) => setImmediate(resolve));
		unclassified.push(...result.unclassified);
		if (result.unboundMentions > 0)
			unbound.set(relative, result.unboundMentions);
		for (const [callee, lines] of result.sites) {
			const key = `${relative}#${callee}`;
			counts.set(key, lines.length);
			details.set(key, `${key} at ${lines.join(", ")}`);
		}
	}
	return { counts, details, unclassified, scanned, sources, unbound };
}

describe("spawn chokepoint sweep (#4530)", () => {
	let live: Awaited<ReturnType<typeof census>>;
	beforeAll(async () => {
		live = await census(runtimeFiles());
	});

	it("routes every runtime process start, or admits it with a reason", () => {
		assertNonEmptyScan("spawn chokepoint sweep", live.scanned, 300);
		const audit = auditRegistry({
			sweepName: "spawn chokepoint sweep",
			flagged: [...live.details].map(([key, detail]) => ({ key, detail })),
			registered: [],
			exemptions: Object.fromEntries(
				Object.entries(ADMITTED).map(([key, value]) => [key, value.reason]),
			),
			scannedCount: live.scanned,
			minScanned: 300,
			minFlagged: Object.keys(ADMITTED).length,
			remediation:
				"route the start through safeSpawnAsync/safeSpawn, or add a reasoned entry to ADMITTED with its site count and evidence",
		});
		expect(audit.problems).toEqual([]);
		// An unplaceable reference is a hole the scan cannot see through.
		expect(live.unclassified).toEqual([]);
	});

	it("pins each admission's site count, so an added or removed start reds", () => {
		const drift = Object.entries(ADMITTED)
			.filter(([key, admission]) => live.counts.get(key) !== admission.sites)
			.map(
				([key, admission]) =>
					`${key}: pinned ${admission.sites}, found ${live.counts.get(key) ?? 0}`,
			);
		expect(drift).toEqual([]);
	});

	it("keeps every unbound-mention admission live and exact", () => {
		const drift = Object.entries(UNBOUND_MENTIONS)
			.filter(
				([file, admitted]) => live.unbound.get(file) !== admitted.mentions,
			)
			.map(
				([file, admitted]) =>
					`${file}: admitted ${admitted.mentions}, found ${live.unbound.get(file) ?? 0}`,
			);
		expect(drift).toEqual([]);
	});

	it("keeps every admission's evidence in its file's code", () => {
		const missing: string[] = [];
		for (const [key, admission] of Object.entries(ADMITTED)) {
			expect(admission.reason.length, key).toBeGreaterThan(40);
			const file = key.slice(0, key.indexOf("#"));
			const source = live.sources.get(file);
			if (source === undefined) {
				missing.push(`${file}: admitted but not in the runtime population`);
				continue;
			}
			if (!carriesEvidence(source, admission.evidence))
				missing.push(`${file}: evidence "${admission.evidence}" is gone`);
		}
		expect(missing).toEqual([]);
	});

	it("runs the admission in both chokepoint bodies before their start", () => {
		// Liveness of the rule itself: the judgment sits where the seam starts
		// processes, so a refactor cannot leave the sweep screening a seam that
		// no longer judges anything.
		const source = stripSource(live.sources.get("clients/safe-spawn.ts") ?? "");
		for (const seam of [
			"export async function safeSpawnAsync(",
			"export function safeSpawn(",
		]) {
			const start = source.indexOf(seam);
			expect(start, seam).toBeGreaterThan(-1);
			const body = source.slice(
				start,
				source.indexOf("\nexport ", start + seam.length),
			);
			const admit = body.indexOf("admitSpawn(");
			const spawnAt = body.search(/\b(?:spawn|spawnSync)\(/);
			expect(admit, `${seam} runs admitSpawn`).toBeGreaterThan(-1);
			expect(spawnAt, `${seam} starts a child`).toBeGreaterThan(-1);
			expect(admit, `${seam} admits before it starts`).toBeLessThan(spawnAt);
		}
	});

	describe("planted sources (defect shape 69)", () => {
		const scan = (lines: string[]): ScanResult =>
			scanProcessStarts("clients/planted.ts", lines.join("\n"));
		// A planted `require` line, built from parts: the flake-shape scan keeps
		// string text, and a literal require of the module in this file would
		// count as this file's own real-process import.
		const requireCall = `require(${JSON.stringify("node:child_process")})`;
		const requireLine = (binding: string): string =>
			`const ${binding} = ${requireCall};`;

		it("flags a raw start in a file with no admission", () => {
			const result = scan([
				'import { spawn } from "node:child_process";',
				"export function run() { return spawn(process.execPath, []); }",
			]);
			expect([...result.sites]).toEqual([["spawn", [2]]]);
			expect(result.unclassified).toEqual([]);
		});

		it("follows aliased, namespace, default and required bindings", () => {
			const cases: Array<[string, string[], string]> = [
				[
					"aliased",
					[
						'import { spawn as nodeSpawn } from "node:child_process";',
						'nodeSpawn("a", []);',
					],
					"nodeSpawn",
				],
				[
					"namespace",
					[
						'import * as cp from "node:child_process";',
						'cp.spawnSync("a", []);',
					],
					"cp.spawnSync",
				],
				[
					"default",
					['import cp from "child_process";', 'cp.exec("a");'],
					"cp.exec",
				],
				[
					"destructured require",
					[requireLine("{ spawn: run }"), 'run("a", []);'],
					"run",
				],
				["required namespace", [requireLine("cp"), 'cp.fork("a");'], "cp.fork"],
				[
					"require in a function",
					[
						"export function probe() {",
						` ${requireLine("{ execFileSync }")}`,
						' return execFileSync("a", []);',
						"}",
					],
					"execFileSync",
				],
			];
			for (const [name, lines, callee] of cases) {
				const result = scan(lines);
				expect([...result.sites.keys()], name).toEqual([callee]);
				expect(result.unclassified, name).toEqual([]);
			}
		});

		it("reports an alias or a passed reference instead of losing its starts", () => {
			for (const lines of [
				[
					'import { spawn } from "node:child_process";',
					"const run = spawn;",
					'run("a", []);',
				],
				['import { spawn } from "node:child_process";', "launch(spawn);"],
				[
					'import * as cp from "node:child_process";',
					"const { spawn } = cp;",
					'spawn("a", []);',
				],
			]) {
				const result = scan(lines);
				expect(result.unclassified.length, lines.join(" ")).toBeGreaterThan(0);
			}
		});

		// #4776 review G3: these entries consumed the module reference and
		// registered nothing, so `cp.spawn` below was neither a site nor a report.
		it("reports a destructured require entry it cannot follow", () => {
			for (const binding of [
				"{ ...cp }",
				"{ spawn, ...rest }",
				"{ spawn: { call } }",
			]) {
				const result = scan([
					requireLine(binding),
					"cp.spawn(process.execPath, []);",
				]);
				expect(result.unclassified, binding).toEqual([
					"clients/planted.ts:1: a require of child_process bound to a pattern this reader cannot follow",
				]);
			}
		});

		// #4776 review H2: the text reader claimed each of these forms (or blanked
		// the code inside it) and registered nothing, so the start below it was
		// neither a site nor a report. The parsed reader admits only its known
		// binding forms, so each is refused.
		it("refuses every other form that names the module", () => {
			const cases: Array<[string, string[], string]> = [
				[
					"string-named import specifier",
					[
						'import { "spawn" as nodeSpawn } from "node:child_process";',
						"nodeSpawn(process.execPath, []);",
					],
					"clients/planted.ts:1: an import of child_process with a binding this reader cannot follow",
				],
				[
					"require inside template text",
					[`const shown = \`\${${requireCall}.spawn(process.execPath, [])}\`;`],
					"clients/planted.ts:1: a require of child_process bound to a pattern this reader cannot follow",
				],
				[
					"import-shaped template text around a real require",
					[
						`const shown = \`import \${${requireCall}.spawn(process.execPath, [])} from "node:child_process"\`;`,
					],
					"clients/planted.ts:1: a require of child_process bound to a pattern this reader cannot follow",
				],
				[
					"destructured require with a default",
					[requireLine("{ spawn = fallback }"), "spawn(process.execPath, []);"],
					"clients/planted.ts:1: a require of child_process bound to a pattern this reader cannot follow",
				],
				[
					"re-export",
					['export { spawn } from "node:child_process";'],
					"clients/planted.ts: an unplaceable child_process reference: bind the module (import, namespace import, or require) so the scan can follow it",
				],
				[
					"shorthand property passing a bound start",
					['import { spawn } from "node:child_process";', "launch({ spawn });"],
					"clients/planted.ts:2: spawn (a child_process start) is used other than by a call; an alias or a passed reference hides its starts",
				],
			];
			for (const [name, lines, report] of cases) {
				const result = scan(lines);
				expect(result.unclassified, name).toContain(report);
			}
		});

		// #4776 verify V1: both forms reached the collector with no site and
		// no report.
		it("refuses the collector under an aliased import", () => {
			const result = scan([
				'import { spawnCollectStdoutResult as collect } from "./child-unref.js";',
				'collect("ps", []);',
			]);
			expect(result.unclassified).toEqual([
				"clients/planted.ts:1: spawnCollectStdoutResult is used other than by a call",
			]);
		});

		it("refuses the collector as a namespace member call", () => {
			const result = scan([
				'import * as unref from "./child-unref.js";',
				'unref.spawnCollectStdoutResult("ps", []);',
			]);
			expect(result.unclassified).toEqual([
				"clients/planted.ts:2: spawnCollectStdoutResult is used other than by a call",
			]);
		});

		it("follows a plain call of the collector", () => {
			const result = scan([
				'import { spawnCollectStdoutResult } from "./child-unref.js";',
				'spawnCollectStdoutResult("ps", []);',
			]);
			expect([...result.sites]).toEqual([["spawnCollectStdoutResult", [2]]]);
			expect(result.unclassified).toEqual([]);
		});

		// #4776 verify V5: the collector branch matched node KINDS, so a name
		// spelled as a string, an escape or a computed key, and a start reached
		// through the module object, were neither a site nor a report. The
		// reader now names the collector by its cooked text in every position
		// and follows the collector's module binding like child_process's.
		const namespace = 'import * as unref from "./child-unref.js";';
		const refusedName = (line: number): string =>
			`clients/planted.ts:${line}: spawnCollectStdoutResult is used other than by a call`;
		// A planted subscript call, built from parts: the AST census guard keeps
		// string text, and `x[k](` spelled in one literal reads to it as a
		// traversal site (tests/support/ast-census.test.ts).
		const collectorCall = (callee: string): string => `${callee}("ps", []);`;
		const refusedModule = (line: number): string =>
			`clients/planted.ts:${line}: unref (the collector's module) is used other than by a member read`;
		const refusedCases: Array<[string, string[], string[]]> = [
			[
				"subscript call on the module namespace",
				[namespace, collectorCall('unref["spawnCollectStdoutResult"]')],
				[refusedModule(2), refusedName(2)],
			],
			[
				"string-named import specifier",
				[
					'import { "spawnCollectStdoutResult" as collect } from "./child-unref.js";',
					'collect("ps", []);',
				],
				[refusedName(1)],
			],
			[
				"element access through a variable holding the name",
				[
					namespace,
					'const name = "spawnCollectStdoutResult";',
					collectorCall("unref[name]"),
				],
				[refusedName(2), refusedModule(3)],
			],
			[
				"a key built at run time",
				[namespace, collectorCall('unref["spawnCollect" + "StdoutResult"]')],
				[refusedModule(2)],
			],
			[
				"computed key destructuring the namespace",
				[
					namespace,
					"const { [`spawnCollectStdoutResult`]: run } = unref;",
					'run("ps", []);',
				],
				[refusedName(2), refusedModule(2)],
			],
			[
				"escaped member name",
				[namespace, 'unref.spawnCollect\x5cu0053tdoutResult("ps", []);'],
				[refusedName(2)],
			],
			[
				"escaped string key",
				[namespace, collectorCall('unref["spawnCollect\x5cx53tdoutResult"]')],
				[refusedModule(2), refusedName(2)],
			],
			[
				"identity-escaped string key",
				[namespace, collectorCall('unref["spawnCollect\x5cStdoutResult"]')],
				[refusedModule(2), refusedName(2)],
			],
			[
				"require of the module",
				[
					`const unref = require(${JSON.stringify("./child-unref.js")});`,
					'unref.spawnCollectStdoutResult("ps", []);',
				],
				[
					"clients/planted.ts:1: a reference to the collector's module this reader cannot follow",
					refusedName(2),
				],
			],
			[
				"star re-export of the module",
				['export * from "./child-unref.js";'],
				[
					"clients/planted.ts:1: a reference to the collector's module this reader cannot follow",
				],
			],
			[
				"dynamic import of the module",
				[
					'void import("../clients/child-unref.js").then((m) => m.spawnCollectStdoutResult("ps", []));',
				],
				[
					"clients/planted.ts:1: a reference to the collector's module this reader cannot follow",
					refusedName(1),
				],
			],
		];
		for (const [name, lines, report] of refusedCases)
			it(`refuses the collector: ${name}`, () => {
				const result = scan(lines);
				expect([...result.sites]).toEqual([]);
				expect(result.unclassified).toEqual(report);
			});

		it("follows the collector's module through a named import and a member read", () => {
			const result = scan([
				'import { spawnCollectStdoutResult, unrefChildAndPipes } from "./child-unref.js";',
				'import * as unref from "./child-unref.js";',
				'export { spawnCollectStdoutResult } from "./child-unref.js";',
				"unref.unrefChildAndPipes(child);",
				'spawnCollectStdoutResult("ps", []);',
				'const note = "child-unref.js names a package, not the module";',
				'const file = "child-unref.js";',
				'type Unref = typeof import("./child-unref.js");',
			]);
			expect([...result.sites]).toEqual([["spawnCollectStdoutResult", [5]]]);
			expect(result.unclassified).toEqual([]);
		});

		const escapedCases: Array<[string, string[], string]> = [
			[
				"escaped module specifier",
				[
					'import { spawn } from "node:child\x5cx5fprocess";',
					'spawn("a", []);',
				],
				"spawn",
			],
			[
				"escaped imported member",
				[
					'import { sp\x5cu0061wn as run } from "node:child_process";',
					'run("a", []);',
				],
				"run",
			],
			[
				"escaped local binding",
				[
					'import { spawn as r\x5cu0075n } from "node:child_process";',
					'run("a", []);',
				],
				"run",
			],
			[
				"escaped default specifier",
				[
					'import { d\x5cu0065fault as cp } from "node:child_process";',
					'cp.spawn("a", []);',
				],
				"cp.spawn",
			],
			[
				"escaped call of a bound member",
				[
					'import { spawn } from "node:child_process";',
					'sp\x5cu0061wn("a", []);',
				],
				"spawn",
			],
			[
				"escaped namespace member",
				[
					'import * as cp from "node:child_process";',
					'cp.sp\x5cu0061wnSync("a", []);',
				],
				"cp.spawnSync",
			],
		];
		for (const [name, lines, callee] of escapedCases)
			it(`reads an escaped child_process spelling by its cooked name: ${name}`, () => {
				const result = scan(lines);
				expect([...result.sites.keys()]).toEqual([callee]);
				expect(result.unclassified).toEqual([]);
			});

		it("reads import-shaped text in a string or template as prose", () => {
			const result = scan([
				'const doc = `import { spawn } from "node:child_process"; spawn("a")`;',
				`const note = '${requireCall}.spawn("a")';`,
			]);
			expect([...result.sites]).toEqual([]);
			expect(result.unclassified).toEqual([]);
		});

		it("reports a dynamic import it cannot bind", () => {
			const result = scan([
				'const loader = () => import("node:child_process");',
				"loader().then((m) => m.spawn(process.execPath, []));",
			]);
			expect(result.unclassified).toHaveLength(1);
			expect(result.unclassified[0]).toContain(
				"unplaceable child_process reference",
			);
		});

		it("never counts a comment or a string as a start or a binding", () => {
			const result = scan([
				'// import { spawn } from "node:child_process"; spawn("a", [])',
				'const text = "spawn(node:child_process)";',
			]);
			expect([...result.sites]).toEqual([]);
			expect(result.unclassified).toEqual([]);
		});

		it("keeps a type-only import out of the population", () => {
			const result = scan([
				'import type { ChildProcess } from "node:child_process";',
				'import { type SpawnOptions } from "node:child_process";',
				'type Cp = typeof import("node:child_process");',
			]);
			expect([...result.sites]).toEqual([]);
			expect(result.unclassified).toEqual([]);
		});

		it("cannot keep an admission alive with a comment that quotes its evidence", () => {
			expect(
				carriesEvidence("// admitSpawn(\nexport const x = 1;\n", "admitSpawn("),
			).toBe(false);
			expect(carriesEvidence('const k = "taskkill";\n', "taskkill")).toBe(true);
		});
	});
});

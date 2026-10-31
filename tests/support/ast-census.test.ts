/**
 * The census seam's own guard (#4606 S0).
 *
 * `tests/support/ast-census.ts` is the ONE place the AST governance sweeps
 * parse a source text, walk an AST, and enumerate the census files. Its
 * consumers keep separate predicates:
 *
 * - `tests/config/bounded-eviction-idiom-sweep.test.ts` asks "is this an
 *   eviction program?" (#2442);
 * - `tests/config/bounded-container-guard.test.ts` asks "is this long-lived
 *   container bounded?" (#2981);
 * - `tests/clients/socket-error-listener-sweep.test.ts` and
 *   `tests/support/silent-catch-scan.ts` are further folds of the same walk
 *   (#4603, #4596);
 * - `tests/support/worker-message-scan.ts` folds it too (#4402);
 * - `tests/config/runner-group-id-census.test.ts` resolves literal runner ids
 *   against the live registry (#4312).
 *
 * Each sweep keeps its own root list; they share the seam and nothing else.
 * The tests below are the properties that make that sharing real rather than
 * nominal:
 *
 * 1. **One traversal, one module instance, one derived population.** A second
 *    copy of the pre-order walk is behaviourally invisible (two identical
 *    recursions visit the same nodes in the same order), so a runtime
 *    assertion cannot see it — this is the case AGENTS.md's "prefer a runtime
 *    probe" rule excepts. The population is the seam plus every file that
 *    LOADS it, derived from the parsed declarations (#4618 V1, V4), and the
 *    sites inside those files are derived from the child-accessor family
 *    (`children()`, `namedChildren()`, `descendants()`, `child(i)`,
 *    `childCount()`, `nextAll()`, `prevAll()`), never from a list of known-bad
 *    loop spellings. Every line that reaches a node's children is a candidate:
 *    a member call, a string subscript, a bare or destructured name, a
 *    reflective read of the name, or a call through a computed subscript key.
 *    The seam admits exactly one (its own `walkAst`), and a consumer site is
 *    admitted only by a reasoned row that names how many live sites carry it,
 *    so a verbatim copy of an admitted line is a second unadmitted site
 *    (#4618 V2). An unlisted site reports its file and line and fails closed,
 *    and a row whose live count no longer matches fails too (AGENTS.md shape
 *    69). Each consumer must also resolve the SAME module file, so a local copy
 *    that re-exports a private walk is not mistaken for the seam.
 * 2. **One parse, one walk per source text** (#3058). `parseNodes` returns the
 *    node array its single `walkAst` visit produced, checked against a kind
 *    sequence authored from the source text and the grammar — not from
 *    `walkAst`, which would agree with itself. #3058's measurement is the
 *    reason the seam exists: the predicates used to take a source STRING and
 *    re-parse and re-walk each file, once per container occurrence (~1,800
 *    whole-file passes, 9,207 MB peak RSS against 62 MB of V8 heap).
 * 3. **The `.js`-twin census rule.** `npm run build` emits a compiled `.js`
 *    beside every source `.ts` outside `tests/`, so a census that requests
 *    `.js` reads the same code twice under two identities: two occurrence
 *    rows, two content keys, and an admission that can only cover one of them.
 *    The rule is "skip a `.js` only when its `.ts` twin is on disk" — a
 *    hand-written `.mjs` tool script with no `.mts` twin stays in the census.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { censusSourceFiles, parseNodes } from "./ast-census.js";
import { readWalkedFile, relativePosix, stripSource } from "./sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const SEAM = "tests/support/ast-census.ts";
const GUARD = "tests/support/ast-census.test.ts";
const SEAM_PATH = path.join(REPO_ROOT, SEAM);

/**
 * Every file that loads the seam, declared. The population itself is DERIVED
 * from the code ({@link derivedCensusConsumers}) and compared with this list in
 * both directions: a file that imports the seam without joining the list reds,
 * and a listed file that stops importing it reds instead of quietly leaving the
 * census (#4618 V1).
 */
const CONSUMERS = [
	"tests/clients/abort-listener-release-sweep.test.ts",
	"tests/clients/socket-error-listener-sweep.test.ts",
	"tests/config/bounded-container-guard.test.ts",
	"tests/config/bounded-eviction-idiom-sweep.test.ts",
	"tests/config/flag-read-registry-sweep.test.ts",
	"tests/config/lsp-override-copy-census.test.ts",
	"tests/config/runner-group-id-census.test.ts",
	"tests/config/spawn-chokepoint-sweep.test.ts",
	"tests/config/tree-census-timeout.test.ts",
	"tests/support/eviction-programs.ts",
	"tests/support/factory-flag-read-scan.ts",
	"tests/support/flag-read-scan.ts",
	"tests/support/silent-catch-scan.ts",
	"tests/support/worker-message-scan.ts",
];

/**
 * Every `SgNode` member that reaches a node's children or siblings. A walk is
 * spelled through one of these, so the population is the accessor family, with
 * no ordering requirement and no iteration token: a spelling this test never
 * names — `namedChildren().forEach(…)`, a `child(i)`/`childCount()` loop, an
 * accessor bound to a local before it is called — still lands in it.
 */
const CHILD_ACCESSOR =
	/\.(?:child|children|childCount|namedChildren|descendants|nextAll|prevAll)\b/;

/**
 * The same family reached through a quoted subscript key, `node["child"](i)`.
 * The family name is the same; the quoted key is the spelling.
 */
const SUBSCRIPT_ACCESSOR =
	/\[\s*["'`](?:child|children|childCount|namedChildren|descendants|nextAll|prevAll)["'`]\s*\]/;

/**
 * The same family reached without a member token: a destructured accessor
 * (`const { children } = node`), a bare name bound then called, or a name the
 * source never spells in one token (`Reflect.get(node, "children")`). Strings
 * are kept for the accessor scan, so the quoted name in a reflective or
 * subscript read lands here too; a commented-out accessor does not, because
 * comments are blanked.
 */
const BARE_ACCESSOR =
	/\b(?:children|childCount|namedChildren|descendants|nextAll|prevAll)\b/;

/**
 * `child` alone is an ordinary variable name in a traversal (`visit(child)`), so
 * it needs its own forms: called as a bare name (`child(i)`) or destructured out
 * of a node (`const { child } = node`). The member and quoted-key spellings are
 * the two patterns above.
 */
const BARE_CHILD = /\bchild\s*\(|[{,]\s*child\s*[,}]/;

/**
 * A call through a computed subscript key, `node[key]()`: the key is a runtime
 * value, so no needle can name the accessor. The bracket's first key byte is
 * not a quote (a quoted key is {@link SUBSCRIPT_ACCESSOR}), and the call form
 * itself is the site (#4618 V3, #4619).
 */
const COMPUTED_SUBSCRIPT_CALL = /\[\s*[^"'`\s\]]+[^\]]*\]\s*\(/;

const ACCESSOR_PATTERNS = [
	CHILD_ACCESSOR,
	SUBSCRIPT_ACCESSOR,
	BARE_ACCESSOR,
	BARE_CHILD,
	COMPUTED_SUBSCRIPT_CALL,
] as const;

type AccessorSite = { file: string; line: number; text: string };

/** A consumer's child-accessor site that is NOT a pre-order walk, with why. */
interface AccessorAdmission {
	file: string;
	/** Exact (whitespace-collapsed) source text of the site line. */
	text: string;
	/**
	 * How many live sites in `file` carry exactly this text. Admission is per
	 * site, never per text: a verbatim copy of an admitted line is one more
	 * live site than the row names, so it reds with its own line (#4618 V2).
	 */
	count: number;
	reason: string;
}

/**
 * The classified consumer sites. Every one of them reaches children without
 * walking the tree, or walks it under a stop rule `walkAst` cannot express
 * (it stops at function boundaries, or collects one kind of declaration), so
 * folding it onto the seam would change what the sweep sees. A row names its
 * file, its exact line text, and its live count; an unlisted site reds, a
 * count that is no longer met reds, and a row that no longer describes
 * anything reds too.
 */
const ADMITTED_ACCESSOR_SITES: readonly AccessorAdmission[] = [
	{
		file: "tests/support/flag-read-scan.ts",
		text: 'call.field("arguments")?.namedChildren()[0];',
		count: 1,
		reason:
			"#4946: `firstArgument` indexes ONE call's argument list; nothing is visited",
	},
	{
		file: "tests/support/flag-read-scan.ts",
		text: "const inner = current.namedChildren()[0];",
		count: 1,
		reason:
			"#4946: `unwrap` steps through one parenthesized or asserted expression to its single child",
	},
	{
		file: "tests/support/flag-read-scan.ts",
		text: 'for (const param of fn.field("parameters")?.namedChildren() ?? []) {',
		count: 1,
		reason:
			"#4946: `parameterNames` reads one function's parameter list; nothing is visited",
	},
	{
		file: "tests/clients/abort-listener-release-sweep.test.ts",
		text: "if (node.children().length > 0) return undefined;",
		count: 1,
		reason:
			"a leaf test on one node (no children means a token); nothing is visited",
	},
	{
		file: "tests/clients/abort-listener-release-sweep.test.ts",
		text: 'const second = node.field("arguments")?.namedChildren()[1];',
		count: 1,
		reason: "indexes the second argument of a call; nothing is visited",
	},
	{
		file: "tests/clients/socket-error-listener-sweep.test.ts",
		text: 'const handler = node.field("arguments")?.namedChildren()[0];',
		count: 1,
		reason: "unwraps the listener call's first argument; nothing is visited",
	},
	{
		file: "tests/clients/socket-error-listener-sweep.test.ts",
		text: '? (handler.field("parameters")?.namedChildren()[0] ??',
		count: 1,
		reason: "unwraps the handler's single parameter to its pattern",
	},
	{
		file: "tests/config/bounded-container-guard.test.ts",
		text: ".namedChildren()",
		count: 1,
		reason:
			"the second line of `!node.namedChildren().some(…)`: a kind filter over one node's children, no recursion",
	},
	{
		file: "tests/config/bounded-container-guard.test.ts",
		text: 'const key = node.field("arguments")?.namedChildren()[0];',
		count: 1,
		reason: "indexes the first argument of a call; nothing is visited",
	},
	{
		file: "tests/config/bounded-container-guard.test.ts",
		text: 'expression = node.field("arguments")?.namedChildren()[0]?.text();',
		count: 1,
		reason: "reads one argument's text; nothing is visited",
	},
	{
		file: "tests/config/bounded-container-guard.test.ts",
		text: "const expressionNode = root.namedChildren()[0]?.namedChildren()[0];",
		count: 1,
		reason:
			"unwraps the single expression of a parsed key, one or two levels deep",
	},
	{
		file: "tests/config/bounded-container-guard.test.ts",
		text: '(value.field("arguments")?.namedChildren().length ?? 0) >= 2',
		count: 1,
		reason: "measures a call's argument count; nothing is visited",
	},
	{
		file: "tests/config/tree-census-timeout.test.ts",
		text: "const named = args.children().filter((node) => node.isNamed());",
		count: 1,
		reason:
			"enumerates one call's direct argument nodes to find its callback and budget; no recursive traversal",
	},
	{
		file: "tests/config/runner-group-id-census.test.ts",
		text: "? raw.children().find((node) => node.isNamed())",
		count: 1,
		reason: "unwraps one computed property key; no recursive traversal",
	},
	{
		file: "tests/config/runner-group-id-census.test.ts",
		text: "const elements = value.children().filter((node) => node.isNamed());",
		count: 1,
		reason:
			"enumerates one runnerIds array's direct elements for classification",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "for (const child of node.children()) {",
		count: 1,
		reason:
			"`walkOwnBody`: the stop rule excludes nested function bodies, so it is not the pre-order walk",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "for (const child of current.children()) {",
		count: 1,
		reason:
			"`nestedFunctionSpans`: records each nested function's range and stops there",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "return pattern.namedChildren().some((child: SgNode) => binding(child));",
		count: 1,
		reason: "tests a destructuring pattern's parts for one binding name",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "for (const child of node.namedChildren()) collect(child);",
		count: 1,
		reason:
			"the scope lookup's `collect`: stops at function, block and catch boundaries",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "for (const child of scope.namedChildren()) collect(child);",
		count: 1,
		reason: "seeds the same stopped `collect` at the scope's own children",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "return rejectionMemberOf(node.namedChildren()[0], raw, callSite);",
		count: 1,
		reason: "unwraps a parenthesized expression to its single child",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: 'const args = node.field("arguments")?.namedChildren() ?? [];',
		count: 1,
		reason: "reads a call's argument list; nothing is visited",
	},
	{
		file: "tests/support/eviction-programs.ts",
		text: "return argumentsNode.namedChildren();",
		count: 1,
		reason:
			"#4606 S1: reads ONE call's argument list by index (the count of a truncation); nothing is visited",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "value = value.namedChildren()[0];",
		count: 1,
		reason: "unwraps a parenthesized expression to its single child",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: "for (const child of node.children()) {",
		count: 1,
		reason:
			"`walkOwnBody`: the stop rule excludes nested function bodies, so it is not the pre-order walk",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: ".namedChildren()",
		count: 4,
		reason:
			"the first line of a chained `node.namedChildren().some(…)`/`.find(…)`: a kind filter over one node's children, no recursion",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: "const parts = node.namedChildren();",
		count: 1,
		reason: "`isMessageLiteral` reads the parts of one string or template node",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: 'return fn.child(0)?.text() === "async";',
		count: 1,
		reason: "`isAsync` reads the first child's text (the `async` keyword)",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: 'parent?.kind() === "unary_expression" && parent.child(0)?.text() === "void"',
		count: 1,
		reason: "`isVoided` reads the operator's first child; nothing is visited",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: "current = current.namedChildren()[0];",
		count: 1,
		reason: "`unwrapParens` steps through one parenthesized child",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: 'return (fn.field("parameters")?.namedChildren() ?? []).map((p: SgNode) => {',
		count: 1,
		reason: "`parameters` maps a function's parameter list",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: 'const pattern = p.field("pattern") ?? p.namedChildren()[0];',
		count: 1,
		reason: "unwraps one parameter's pattern",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: "type: annotation?.namedChildren()[0]?.text(),",
		count: 1,
		reason: "reads the type annotation's single child text",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: "const statements = body.namedChildren();",
		count: 1,
		reason:
			"`body` counts and indexes the body's top-level statements; nothing is walked",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: "const expression = only.namedChildren()[0];",
		count: 1,
		reason: "unwraps a single expression statement to its child",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: 'call.child(0)?.text() === "void"',
		count: 1,
		reason: "reads the operand of a unary expression; nothing is visited",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: "call = unwrapParens(call.namedChildren()[0]);",
		count: 1,
		reason: "unwraps a unary expression's operand",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: 'const args = call.field("arguments")?.namedChildren() ?? [];',
		count: 2,
		reason:
			"reads a call's argument list in two delegations; nothing is visited",
	},
	{
		file: "tests/support/worker-message-scan.ts",
		text: 'const args = node.field("arguments")?.namedChildren() ?? [];',
		count: 1,
		reason: "reads a listener call's argument list; nothing is visited",
	},
];

/** Collapse whitespace so a row survives indentation and in-line spacing. */
function collapse(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function siteKey(file: string, text: string): string {
	return `${file}\u0000${collapse(text)}`;
}

function sourceOf(file: string): string {
	const source = readWalkedFile(path.join(REPO_ROOT, file));
	// Fail closed: a vanished member of the population is not a clean census.
	if (source === undefined)
		throw new Error(`census population member is missing: ${file}`);
	return source;
}

/**
 * Every child-accessor line in one source text. Comments are blanked (a
 * commented-out walk is not a walk) and strings are kept, because a reflective
 * or subscript spelling reaches the accessor through a string literal.
 */
function accessorSitesIn(source: string, file: string): AccessorSite[] {
	return stripSource(source, { strings: "keep" })
		.split("\n")
		.flatMap((text, index) => {
			const line = text.trim();
			return ACCESSOR_PATTERNS.some((pattern) => pattern.test(line))
				? [{ file, line: index + 1, text: line }]
				: [];
		});
}

function accessorSites(file: string): AccessorSite[] {
	return accessorSitesIn(sourceOf(file), file);
}

/** Strip the quotes a string-literal node's own text carries. */
function unquote(text: string): string {
	return text.replace(/^["'`]/, "").replace(/["'`]$/, "");
}

/**
 * The census module paths one source text loads: its static imports, its
 * re-exports, and the argument of a dynamic `import()` or `require()`. The
 * DECLARATION decides, so a string literal that merely spells an import
 * declares nothing (#4618 V4: the r1 check matched `/from "…"/` over
 * strings-kept source, and `const EXAMPLE = 'import … from "./ast-census.js"'`
 * satisfied it).
 *
 * `base` is the tree the file's specifier resolves against: the repository for
 * the live census, a fixture root for the derivation's own test.
 */
function censusImportTargets(
	source: string,
	file: string,
	base = REPO_ROOT,
): string[] {
	const targets = new Set<string>();
	const dir = path.dirname(path.join(base, file));
	const add = (specifier: string): void => {
		if (!specifier.includes("ast-census")) return;
		const resolved = path.resolve(dir, specifier);
		// `tests/` is excluded from the build, so a `.js` specifier names the
		// `.ts` source: compare the file a consumer actually loads.
		const onDisk = specifier.endsWith(".js")
			? [resolved.replace(/\.js$/, ".ts"), resolved].find((candidate) =>
					fs.existsSync(candidate),
				)
			: resolved;
		if (onDisk === undefined)
			throw new Error(`${file}: census import does not resolve: ${specifier}`);
		targets.add(onDisk);
	};
	for (const node of parseNodes(source)) {
		const kind = node.kind();
		if (kind === "import_statement" || kind === "export_statement") {
			const specifier = node.field("source")?.text();
			if (specifier !== undefined) add(unquote(specifier));
			continue;
		}
		if (kind !== "call_expression") continue;
		const callee = node.field("function");
		if (callee === undefined || callee === null) continue;
		if (callee.kind() !== "import" && callee.text() !== "require") continue;
		const argument = node.field("arguments")?.namedChildren()[0];
		if (argument === undefined) continue;
		const argumentKind = argument.kind();
		// A string literal and a substitution-free template are both constants.
		const specifier =
			argumentKind === "string" ||
			(argumentKind === "template_string" && !argument.text().includes("${"))
				? unquote(argument.text())
				: undefined;
		if (specifier !== undefined) {
			add(specifier);
			continue;
		}
		// Fail closed: a load of THIS module that the census cannot read is an
		// unclassified population member, not a file outside the census.
		if (argument.text().includes("ast-census"))
			throw new Error(
				`${file}: unclassified census load form: ${argument.text()}`,
			);
	}
	return [...targets];
}

/**
 * Every `tests/` source file that loads the seam, derived from the code. The
 * candidate set is a cheap text narrowing (a static import specifier is a
 * literal string, so it always contains `ast-census`); the decision is the
 * parse, so a file that only mentions the seam in a comment or a string is not
 * a consumer. The guard is excluded: it loads the seam to guard it, and its
 * own probe strings are not census sites.
 *
 * `base` defaults to the repository; a fixture root makes the derivation
 * itself testable, so replacing it with a hard-coded list reds.
 */
function derivedCensusConsumers(base = REPO_ROOT): string[] {
	const guard = path.join(base, GUARD);
	const seam = path.join(base, SEAM);
	const consumers: string[] = [];
	for (const file of censusSourceFiles([path.join(base, "tests")], {
		extensions: [".ts", ".mts", ".mjs"],
		skipTests: false,
	})) {
		if (file === guard) continue;
		const source = readWalkedFile(file);
		if (source === undefined || !source.includes("ast-census")) continue;
		const relative = relativePosix(base, file);
		if (censusImportTargets(source, relative, base).includes(seam))
			consumers.push(relative);
	}
	return consumers.sort();
}

function describeSite(site: AccessorSite): string {
	return `${site.file}:${site.line} ${site.text}`;
}

interface SiteAudit {
	/** Every live site no row admits, one line each, with its own file:line. */
	unclassified: string[];
	/** Every row whose live site count no longer matches, with both counts. */
	stale: string[];
}

/**
 * Classify live accessor sites against the admission rows. Live sites are
 * GROUPED, never deduped: a row admits `count` sites carrying its text, so a
 * verbatim copy of an admitted line is one live site too many and reds on its
 * own line (#4618 V2). A row that claims more sites than it has is stale, so
 * removing admitted code takes its row with it.
 */
function auditAccessorSites(
	sites: readonly AccessorSite[],
	rows: readonly AccessorAdmission[],
): SiteAudit {
	const live = new Map<string, AccessorSite[]>();
	for (const site of sites) {
		const key = siteKey(site.file, site.text);
		const group = live.get(key);
		if (group === undefined) live.set(key, [site]);
		else group.push(site);
	}
	const rowByKey = new Map<string, AccessorAdmission>();
	for (const row of rows) {
		const key = siteKey(row.file, row.text);
		if (rowByKey.has(key))
			throw new Error(
				`duplicate accessor admission row: ${row.file} ${row.text}`,
			);
		rowByKey.set(key, row);
	}
	const unclassified: string[] = [];
	for (const [key, group] of live) {
		const row = rowByKey.get(key);
		if (row === undefined) {
			unclassified.push(...group.map(describeSite));
			continue;
		}
		// The copy, not the first live site, is what an over-count exposes.
		if (group.length > row.count)
			unclassified.push(
				...group
					.slice(row.count)
					.map(
						(site) =>
							`${describeSite(site)} (${group.length} live sites carry this text, the row admits ${row.count})`,
					),
			);
	}
	const stale = rows.flatMap((row) => {
		const siteCount = live.get(siteKey(row.file, row.text))?.length ?? 0;
		// An over-count is the copy case above; only a row that now promises
		// more sites than exist is stale.
		return siteCount >= row.count
			? []
			: [
					`${row.file} ${row.text} — ${row.reason} (the row admits ${row.count}, ${siteCount} live)`,
				];
	});
	return { unclassified, stale };
}

describe("one census seam for the AST sweeps (#4606 S0)", () => {
	it("derives its consumer population from the seam's imports", () => {
		const derived = derivedCensusConsumers();
		const unlisted = derived.filter((file) => !CONSUMERS.includes(file));
		expect(
			unlisted,
			"a file that loads the census seam joins the population: add it to CONSUMERS and give its accessor sites a reasoned row",
		).toEqual([]);
		const stopped = CONSUMERS.filter((file) => !derived.includes(file));
		expect(
			stopped,
			"a listed consumer that no longer loads the census seam leaves the population with its rows",
		).toEqual([]);
		// A consumer that loads a COPY of the seam is not the seam.
		const seamAbsolute = path.join(REPO_ROOT, SEAM);
		for (const consumer of CONSUMERS)
			expect(
				censusImportTargets(sourceOf(consumer), consumer),
				`${consumer} must load the census seam`,
			).toContain(seamAbsolute);
	});

	it("derives the population from a tree, not from a list", () => {
		const fixture = setupTestEnvironment("pi-lens-ast-census-population-");
		try {
			for (const [relative, content] of Object.entries({
				// A stub seam: the fixture asks who loads it, not what it does.
				"tests/support/ast-census.ts": "export function walkAst(): void {}\n",
				"tests/support/consumer.ts":
					'import { walkAst } from "./ast-census.js";\nexport const load = walkAst;\n',
				"tests/config/re-export.ts":
					'export { walkAst } from "../support/ast-census.js";\n',
				"tests/config/dynamic.ts":
					'export const load = () => import("../support/ast-census.js");\n',
				// Neither a string nor a comment is a declaration.
				"tests/support/string-only.ts":
					"export const EXAMPLE = 'import { walkAst } from \"./ast-census.js\";';\n",
				"tests/support/comment-only.ts":
					'// import { walkAst } from "./ast-census.js";\nexport const y = 1;\n',
				"tests/support/unrelated.ts":
					'import { stripSource } from "./sweep-kit.js";\n',
			})) {
				const target = path.join(fixture.tmpDir, relative);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, content);
			}
			expect(
				derivedCensusConsumers(fixture.tmpDir),
				"the population is what the tree declares, not what a list claims",
			).toEqual([
				"tests/config/dynamic.ts",
				"tests/config/re-export.ts",
				"tests/support/consumer.ts",
			]);
		} finally {
			fixture.cleanup();
		}
	});

	it("reads a declaration, not a string that spells one", () => {
		const file = "tests/support/probe.ts";
		expect(
			censusImportTargets('import { walkAst } from "./ast-census.js";', file),
		).toEqual([SEAM_PATH]);
		expect(
			censusImportTargets(
				'export { parseNodes } from "./ast-census.js";',
				file,
			),
		).toEqual([SEAM_PATH]);
		expect(
			censusImportTargets(
				'const seam = await import("./ast-census.js");',
				file,
			),
		).toEqual([SEAM_PATH]);
		// The r1 escape: a string literal is an expression, not a declaration.
		expect(
			censusImportTargets(
				"const CENSUS_IMPORT_EXAMPLE = 'import { walkAst } from \"./ast-census.js\";';",
				file,
			),
			"a string literal that spells an import declares nothing",
		).toEqual([]);
		// A comment is not a declaration either.
		expect(
			censusImportTargets(
				'// import { walkAst } from "./ast-census.js";',
				file,
			),
		).toEqual([]);
		// A substitution-free template specifier is one constant (#4619).
		expect(
			censusImportTargets(
				"const seam = await import(`./ast-census.js`);",
				file,
			),
		).toEqual([SEAM_PATH]);
		// A load the census cannot read is refused, not silently outside it.
		expect(() =>
			censusImportTargets(
				"const seam = await import(`./ast-census.${extension}`);",
				file,
			),
		).toThrow(/unclassified census load form/);
		// A dynamic import of some other module stays outside this population.
		expect(
			censusImportTargets("const other = await import(specifier);", file),
		).toEqual([]);
	});

	it("keeps one walk in the seam and no traversal of its own in a consumer", () => {
		// Exactly one child-accessor site in the seam, and it is the walk: a
		// private copy beside `walkAst`, or a read that hides a second
		// recursion, reds here with its own line.
		const seamSites = accessorSites(SEAM);
		expect(
			seamSites.map(describeSite),
			`${SEAM} owns exactly one pre-order traversal`,
		).toHaveLength(1);
		expect(seamSites[0]?.text).toContain("walkAst(");

		// A second walk in a consumer is the duplicate this seam exists to
		// prevent, and it is behaviourally invisible, so it is caught here.
		const audit = auditAccessorSites(
			CONSUMERS.flatMap(accessorSites),
			ADMITTED_ACCESSOR_SITES,
		);
		expect(
			audit.unclassified,
			"a sweep may not define its own AST traversal: import walkAst from the census seam, or admit the site with a reason",
		).toEqual([]);
		expect(
			audit.stale,
			"a stale accessor admission row must go with the site it described",
		).toEqual([]);
	});

	it("admits one live site per row so a copied walk cannot reuse it", () => {
		const file = "tests/support/probe.ts";
		const text =
			"for (const child of node.children()) walkAgain(child, visit);";
		const row: AccessorAdmission = {
			file,
			text,
			count: 1,
			reason: "a stop rule walkAst cannot express",
		};
		const site = (line: number): AccessorSite => ({ file, line, text });
		expect(
			auditAccessorSites([site(3)], [row]),
			"one live site, one admission",
		).toEqual({ unclassified: [], stale: [] });
		// A verbatim copy of the admitted line is a second site, and it reds on
		// its own line; the first site stays admitted.
		expect(auditAccessorSites([site(3), site(12)], [row])).toEqual({
			unclassified: [
				`${file}:12 ${text} (2 live sites carry this text, the row admits 1)`,
			],
			stale: [],
		});
		expect(
			auditAccessorSites([site(3), site(12)], [{ ...row, count: 2 }]),
			"a row may admit both sites explicitly",
		).toEqual({ unclassified: [], stale: [] });
		expect(
			auditAccessorSites([], [row]).stale,
			"a row whose site is gone must go",
		).toHaveLength(1);
	});

	it("classifies a second traversal whatever spelling it uses", () => {
		// Each plant is a walk written a different way; the detector reads the
		// accessor family, so none of them needs its own needle.
		const traversals = [
			"for (const child of node.children()) walkAgain(child, visit);",
			"for (const child of node.namedChildren()) walkAgain(child, visit);",
			"node.namedChildren().forEach((child) => walkAgain(child, visit));",
			"for (let index = 0; index < node.childCount(); index++) walkAgain(node.child(index), visit);",
			"node.descendants().map(visit);",
			"const kids = node.namedChildren; kids().forEach(visit);",
			'const kids = node["namedChildren"]; kids().forEach(visit);',
			// #4618 V3: the accessor reached without a member token.
			"const { children } = node;",
			"children().forEach(visit);",
			'const accessor = Reflect.get(node, "children");',
			// #4618 V3: called through a key no token names.
			"node[key]();",
			// #4619: the quoted key and the `child` forms the family skipped.
			'node["child"](index)',
			"const { child } = node;",
			"child(index)",
		];
		expect(
			traversals.map((line) => accessorSitesIn(line, "plant.ts").length),
			"every spelling of a second traversal is a candidate site",
		).toEqual(traversals.map(() => 1));

		// A destructuring line and the call it enables are two sites, and the
		// second is not hidden by the first.
		expect(
			accessorSitesIn(
				"const { children } = node;\nchildren().forEach(visit);",
				"plant.ts",
			).length,
			"a destructured accessor and its call are two sites",
		).toBe(2);

		// A node read is not a traversal: the detector classifies, it does not
		// blanket-ban `kind()`/`text()`/`field()`.
		const reads = [
			"const kind = node.kind();",
			'if (first.kind() === "identifier") return first.text();',
			"visit(node);",
		];
		expect(
			reads.flatMap((line) => accessorSitesIn(line, "plant.ts")),
			"a node read is not a traversal",
		).toEqual([]);
	});

	it("parses once and walks every node exactly once in document order", () => {
		const source = "if (a) { b(c); } else { d(); }";
		// Authored from this source text and the TypeScript grammar, NOT from
		// `walkAst`: the expected side is independent, so a walk that shrinks
		// (drops a node's last child, or its leaf punctuation) reds instead of
		// agreeing with itself.
		const expectedKinds = [
			"program",
			"if_statement",
			"if",
			"parenthesized_expression",
			"(",
			"identifier",
			")",
			"statement_block",
			"{",
			"expression_statement",
			"call_expression",
			"identifier",
			"arguments",
			"(",
			"identifier",
			")",
			";",
			"}",
			"else_clause",
			"else",
			"statement_block",
			"{",
			"expression_statement",
			"call_expression",
			"identifier",
			"arguments",
			"(",
			")",
			";",
			"}",
		];
		const nodes = parseNodes(source);
		expect(nodes.map((node) => node.kind())).toEqual(expectedKinds);

		// One walk, not two: a second traversal inside `parseNodes` returns the
		// same nodes a second time (a longer array, and repeats).
		expect(new Set(nodes).size).toBe(nodes.length);

		// Pre-order: visited in document order, so node start offsets never
		// decrease (a parent shares its first child's start). A post-order walk
		// reds here because a parent would follow a child that starts later.
		const starts = nodes.map((node) => node.range().start.index);
		for (let index = 1; index < starts.length; index++)
			expect(starts[index]).toBeGreaterThanOrEqual(starts[index - 1]!);
		const textPosition = (text: string): number =>
			nodes.findIndex((node) => node.text() === text);
		expect(textPosition("c")).toBeGreaterThan(textPosition("b"));
		expect(textPosition("c")).toBeLessThan(textPosition("d"));
	});

	it("skips a .js twin only when its .ts twin is on disk", () => {
		const fixture = setupTestEnvironment("pi-lens-ast-census-");
		try {
			const files: Record<string, string> = {
				"a.ts": "export const a = 1;\n",
				"a.js": "exports.a = 1;\n",
				"b.js": "exports.b = 1;\n",
				"c.mjs": "export const c = 1;\n",
				"c.mts": "export const c: number = 1;\n",
				"d.ts": "export const d = 1;\n",
				"nested/e.ts": "export const e = 1;\n",
				"nested/e.js": "exports.e = 1;\n",
				"x.test.ts": "// a test file, excluded by skipTests\n",
			};
			for (const [relative, content] of Object.entries(files)) {
				const target = path.join(fixture.tmpDir, relative);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, content);
			}
			const census = (skipTests: boolean) =>
				censusSourceFiles([fixture.tmpDir], {
					extensions: [".ts", ".mjs", ".js"],
					skipTests,
				}).map((file) => relativePosix(fixture.tmpDir, file));

			// `a.js` and `nested/e.js` have a `.ts` twin and are the same code.
			// `b.js` is a hand-written script with no twin and stays. `c.mjs` is
			// kept: the twin rule derives `c.ts`, and `c.mjs`'s own `.d.mts`
			// declaration is excluded by `skipDeclarations`, not by this rule.
			expect(census(true)).toEqual([
				"a.ts",
				"b.js",
				"c.mjs",
				"d.ts",
				"nested/e.ts",
			]);
			expect(census(false)).toEqual([
				"a.ts",
				"b.js",
				"c.mjs",
				"d.ts",
				"nested/e.ts",
				"x.test.ts",
			]);
		} finally {
			fixture.cleanup();
		}
	});

	it("admits a file root as its own census entry", () => {
		const fixture = setupTestEnvironment("pi-lens-ast-census-file-");
		try {
			for (const [relative, content] of Object.entries({
				"only.ts": "export const only = 1;\n",
				"twinned.ts": "export const twinned = 1;\n",
				"twinned.js": "exports.twinned = 1;\n",
				"sibling.ts": "export const sibling = 1;\n",
			})) {
				fs.writeFileSync(path.join(fixture.tmpDir, relative), content);
			}
			// A root that is a file is the census entry itself, not a directory
			// to list: `index.ts` in the live roots depends on this branch.
			expect(
				censusSourceFiles([path.join(fixture.tmpDir, "only.ts")], {
					extensions: [".ts"],
				}),
			).toEqual([path.join(fixture.tmpDir, "only.ts")]);
			// A file root goes through the `.js`-twin rule like any other entry.
			expect(
				censusSourceFiles([path.join(fixture.tmpDir, "twinned.js")], {
					extensions: [".ts", ".js"],
				}),
			).toEqual([]);
			expect(
				censusSourceFiles([path.join(fixture.tmpDir, "sibling.ts")], {
					extensions: [".ts"],
				}),
			).toEqual([path.join(fixture.tmpDir, "sibling.ts")]);
		} finally {
			fixture.cleanup();
		}
	});

	it("keeps the live census floor and never returns a compiled twin", () => {
		const roots = [
			"clients",
			"tools",
			"mcp",
			"scripts",
			"tests/support",
			"index.ts",
		].map((root) => path.join(REPO_ROOT, root));
		const files = censusSourceFiles(roots, {
			extensions: [".ts", ".mjs", ".js"],
			skipTests: true,
		});
		// Calibration: 787 files on 2026-10-18 (#4606's measurement at
		// 55b3651a7 plus the seam, on the merge with origin/master c7219849f);
		// 700 keeps a real floor while a root that stops resolving reds instead
		// of reading as clean.
		expect(files.length).toBeGreaterThanOrEqual(700);
		// The `index.ts` root is a file, not a directory: it must be listed.
		expect(files).toContain(path.join(REPO_ROOT, "index.ts"));
		const twins = files.filter(
			(file) =>
				file.endsWith(".js") && fs.existsSync(file.slice(0, -3) + ".ts"),
		);
		expect(twins.map((file) => relativePosix(REPO_ROOT, file))).toEqual([]);
	});
});

/**
 * #4281: in-process module doubles must use the module's real test seam.
 * Recurrence: a project-trust mock hid a newly-added export and let callers
 * exercise a second module instance instead of the process singleton.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
} from "../support/sweep-kit.js";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";
import {
	isViMockCall,
	mockSpecifier,
	unwrapExpression,
} from "../support/vi-mock-export-gate.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");

export const SEAM_MODULES = [
	{
		module: "clients/project-trust.js",
		seam: ["setProjectTrustState", "resetProjectTrust"],
	},
];

const BASELINE: Record<string, number> = {
	"clients/project-trust.js": 1,
};

/**
 * Strings that resolve to a seam module as data, not as a specifier, keyed by
 * `<file>: <trimmed line>`, each with its reason (#4429 round 3). The
 * liveness case stale-checks them.
 */
const ADMITTED_DATA: Record<string, string> = {
	'tests/scripts/ci-changed-files.test.ts: previous_filename: "clients/project-trust.ts",':
		"a GitHub PR-files fixture row: the repo path as data for the changed-files matcher",
	'tests/config/pr-smoke-paths.test.ts: "clients/project-trust.ts",':
		"the PR smoke path filter list names the source file as a repo path",
	'tests/config/glossary-synonym-sweep.test.ts: "clients/project-trust.ts": 1,':
		"a per-file glossary baseline count keyed by repo path",
	'tests/scripts/astgrep-self-scan.test.ts: "clients/project-trust.js",':
		"a fixture's list of compiled modules it links into a scratch tree (#4530): a repo path, never a mock specifier",
	'tests/config/project-trust-seam-ratchet.test.ts: module: "clients/project-trust.js",':
		"this ratchet's own SEAM_MODULES row names the module it scans for",
	'tests/config/project-trust-seam-ratchet.test.ts: "clients/project-trust.js": 1,':
		"this ratchet's own BASELINE row, keyed by the module it scans for",
};

/**
 * This file passes each seam module name to its own scanner in the planted
 * cases, so its calls count like any other. It is scanned (#4457 verify G3:
 * a skip hid a real `vi.doMock` here) and its count is pinned exactly, so an
 * added site reds.
 */
const SELF = path.relative(REPO_ROOT, __filename).split(path.sep).join("/");
/** One per planted case that hands the module name to `scanViMockSites` or `countViMockSites`. */
const SELF_SITES = 10;

/**
 * Resolve a module specifier to its module identity: posix separators, any
 * relative depth, and a `.js`/`.ts`/extensionless spelling all name the same
 * module. Comparing the trailing `clients/<name>` path (never a raw
 * `endsWith("…js")`) keeps a nested same-named file from counting.
 */
function resolvesToModule(specifier: string, moduleName: string): boolean {
	const strip = (value: string) =>
		value.replace(/\\/g, "/").replace(/\.(?:[cm]?[jt]s)$/, "");
	const candidate = strip(specifier);
	const modulePath = strip(moduleName);
	return candidate === modulePath || candidate.endsWith(`/${modulePath}`);
}

/** Nodes an argument passes through on its way to a call's `arguments`. */
const ARGUMENT_WRAPPERS = new Set([
	"array",
	"as_expression",
	"non_null_expression",
	"parenthesized_expression",
	"satisfies_expression",
	"spread_element",
]);

/** Node kinds a `const` initializer may contain and still be inert data. */
const DATA_KINDS = new Set([
	"array",
	"escape_sequence",
	"false",
	"null",
	"number",
	"object",
	"pair",
	"property_identifier",
	"string",
	"string_fragment",
	"template_string",
	"true",
]);

/** Parents whose named field binds the identifier it holds. */
const BINDING_FIELDS: Record<string, readonly string[]> = {
	abstract_class_declaration: ["name"],
	arrow_function: ["parameter"],
	catch_clause: ["parameter"],
	class: ["name"],
	class_declaration: ["name"],
	enum_declaration: ["name"],
	for_in_statement: ["left"],
	function_declaration: ["name"],
	function_expression: ["name"],
	generator_function_declaration: ["name"],
	internal_module: ["name"],
	optional_parameter: ["pattern"],
	required_parameter: ["pattern"],
	variable_declarator: ["name"],
};

/** Destructuring parents: every identifier directly under one is bound. */
const PATTERN_PARENTS = new Set([
	"array_pattern",
	"assignment_pattern",
	"object_pattern",
	"pair_pattern",
	"rest_pattern",
]);

function sameNode(a: SgNode | null | undefined, b: SgNode): boolean {
	return (
		a?.range().start.index === b.range().start.index &&
		a?.range().end.index === b.range().end.index
	);
}

function isBindingOccurrence(node: SgNode): boolean {
	const parent = node.parent();
	if (!parent) return false;
	const kind = String(parent.kind());
	if (kind === "import_specifier") {
		const alias = parent.field("alias");
		return sameNode(alias ?? parent.field("name"), node);
	}
	if (kind === "namespace_import" || kind === "import_clause") return true;
	if (PATTERN_PARENTS.has(kind)) return true;
	return (BINDING_FIELDS[kind] ?? []).some((field) =>
		sameNode(parent.field(field), node),
	);
}

/** Every named node in `node` is a literal data kind (no identifier, call or function). */
function isInertData(node: SgNode): boolean {
	return (
		(!node.isNamed() || DATA_KINDS.has(String(node.kind()))) &&
		node.children().every(isInertData)
	);
}

/**
 * The binding facts the scan reads for one parsed file, built once (#4457
 * review F8): which names are bound exactly once, by a declaration whose
 * value cannot be vitest's utils object. Proven: a vitest import other than
 * `vi`/`vitest` (`expect`, `describe`, …), any import from a `node:` builtin,
 * and a `const` whose initializer is inert literal data. Every other binding
 * (a parameter, an import from any other module, a function, a class, a
 * `let`, a destructure, a second declaration of the name) proves nothing.
 */
function provenNames(root: SgNode): Set<string> {
	const candidates = new Set<string>();
	for (const statement of root.findAll({
		rule: { kind: "import_statement" },
	})) {
		const source = mockSpecifier(statement.field("source") ?? undefined);
		if (source?.startsWith("node:")) {
			for (const local of statement.findAll({ rule: { kind: "identifier" } }))
				if (isBindingOccurrence(local)) candidates.add(local.text());
			continue;
		}
		if (source !== "vitest") continue;
		for (const specifier of statement.findAll({
			rule: { kind: "import_specifier" },
		})) {
			const imported = specifier.field("name")?.text() ?? "";
			const local = specifier.field("alias")?.text() ?? imported;
			if (imported !== "vi" && imported !== "vitest") candidates.add(local);
		}
	}
	for (const declarator of root.findAll({
		rule: { kind: "variable_declarator" },
	})) {
		const name = declarator.field("name");
		const value = declarator.field("value");
		const constant = declarator.parent()?.children()[0]?.text() === "const";
		if (!constant || name?.kind() !== "identifier" || !value) continue;
		const inert = isInertData(value);
		if (inert) candidates.add(name.text());
	}
	const bindings = new Map<string, number>();
	for (const node of root.findAll({
		rule: {
			any: [
				{ kind: "identifier" },
				{ kind: "shorthand_property_identifier_pattern" },
			],
		},
	})) {
		if (!candidates.has(node.text())) continue;
		if (node.kind() === "identifier" && !isBindingOccurrence(node)) continue;
		bindings.set(node.text(), (bindings.get(node.text()) ?? 0) + 1);
	}
	return new Set([...candidates].filter((name) => bindings.get(name) === 1));
}

/** The callee's root: through members, subscripts, call results and casts. */
function calleeRoot(callee: SgNode): SgNode {
	let current = unwrapExpression(callee);
	for (;;) {
		const kind = current.kind();
		const next =
			kind === "member_expression" || kind === "subscript_expression"
				? current.field("object")
				: kind === "call_expression"
					? current.field("function")
					: null;
		if (!next) return current;
		current = unwrapExpression(next);
	}
}

type Flow =
	| { kind: "import" }
	| { kind: "argument"; call: SgNode }
	| { kind: "unclassified" };

/**
 * Where a seam string sits. An `import(S)` hands the walk to the import
 * call: awaited or under `typeof` it is a module object; as an argument it
 * is vitest's typed specifier form.
 */
function flowOf(node: SgNode): Flow {
	let current = node;
	for (let up = current.parent(); up; current = up, up = up.parent()) {
		const kind = String(up.kind());
		if (kind === "import_statement" || kind === "export_statement")
			return { kind: "import" };
		if (kind === "arguments") {
			const call = up.parent();
			if (!call) return { kind: "unclassified" };
			if (call.field("function")?.kind() !== "import")
				return { kind: "argument", call };
			const holder = call.parent();
			const holderKind = String(holder?.kind());
			if (
				holderKind === "await_expression" ||
				(holderKind === "unary_expression" &&
					holder?.children()[0]?.text() === "typeof")
			)
				return { kind: "import" };
			up = call;
			continue;
		}
		if (!ARGUMENT_WRAPPERS.has(kind)) return { kind: "unclassified" };
	}
	return { kind: "unclassified" };
}

/**
 * Whole-module mocks of `moduleName` in one test file, and every spelling the
 * scan cannot classify (#4429: a population-deriving scanner fails closed).
 *
 * The needle is the specifier, not the callee (#4429 round 3, the state
 * table in PR #4457): every string or substitution-free template in the AST
 * whose value resolves to the module (a comment or a string quoting one is
 * not such a node). A static import or export source, an awaited
 * `import(S)` and a `typeof import(S)` are imports. A string in argument
 * position (through parentheses, casts, an array, a spread or an
 * `import(S)` wrapper) counts unless the callee's root is proven non-vitest
 * by {@link provenNames}: an unknown callee counts, which is the fail-closed
 * direction. Every other position, and a template or `+` concatenation that
 * spells the module's base name around a computed part, is UNCLASSIFIED,
 * reported with its line, unless {@link ADMITTED_DATA} names it. A direct
 * `vi.mock`/`vi.doMock` whose specifier is not a literal (`path.join(…)`, a
 * concatenation, a template with a substitution, `[…].join()`) is
 * UNCLASSIFIED too (round 1's rule, #4457 verify G1): its value may be the
 * module even where no string spells it.
 *
 * Residual (#4457 verify G2, not built): a mock written onto a root the scan
 * proved, such as `api.mock = vi.doMock`, `Object.assign(fs, { m: vi.doMock })`,
 * `Object.defineProperty(path, "m", …)` or an inert array's `push`, keeps the
 * proof, so a later `fs.m(S)` does not count. None exists in the tree.
 */
function scanViMockSites(
	file: string,
	source: string,
	moduleName: string,
): { count: number; unclassified: string[] } {
	const lines = source.split("\n");
	const root = parse(Lang.TypeScript, source).root();
	let proven: Set<string> | undefined;
	const result = { count: 0, unclassified: [] as string[] };
	const counted = new Set<number>();
	const report = (node: SgNode) => {
		const line = node.range().start.line + 1;
		const text = lines[line - 1]?.trim() ?? "";
		if (Object.hasOwn(ADMITTED_DATA, `${file}: ${text}`)) return;
		const entry = `unclassified spelling at ${file}:${line}: ${text}`;
		if (!result.unclassified.includes(entry)) result.unclassified.push(entry);
	};
	const baseName = seamBaseName(moduleName);
	for (const node of root.findAll({
		rule: { any: [{ kind: "string" }, { kind: "template_string" }] },
	})) {
		const value = mockSpecifier(node);
		if (value === undefined || !resolvesToModule(value, moduleName)) {
			const computed =
				node.text().includes(baseName) &&
				(node.kind() === "template_string" ||
					node.ancestors().some((up) => {
						const kind = up.kind();
						return (
							kind === "template_substitution" || kind === "binary_expression"
						);
					}));
			if (computed) report(node);
			continue;
		}
		const flow = flowOf(node);
		if (flow.kind === "import") continue;
		if (flow.kind === "unclassified") {
			report(node);
			continue;
		}
		const callee =
			flow.call.field("function") ?? flow.call.field("constructor");
		const calleeRootNode = callee ? calleeRoot(callee) : undefined;
		proven ??= provenNames(root);
		if (
			calleeRootNode?.kind() === "identifier" &&
			proven.has(calleeRootNode.text())
		)
			continue;
		const at = flow.call.range().start.index;
		if (!counted.has(at)) {
			counted.add(at);
			result.count++;
		}
	}
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		if (!isViMockCall(call.field("function"), ["mock", "doMock"])) continue;
		const first = call.field("arguments")?.namedChildren()[0];
		if (mockSpecifier(first) === undefined) report(call);
	}
	return result;
}

function countViMockSites(source: string, moduleName: string): number {
	return scanViMockSites("fixture.ts", source, moduleName).count;
}

function seamBaseName(module: string): string {
	return module.replace(/^.*\//, "").replace(/\.(?:js|ts)$/, "");
}

async function counts(): Promise<{
	counts: Record<string, number>;
	unclassified: string[];
	selfSites: number;
}> {
	const files = listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith("fixtures/"),
	});
	assertNonEmptyScan("#4281 project-trust seam ratchet", files.length, 900);
	const result = Object.fromEntries(
		SEAM_MODULES.map(({ module }) => [module, 0]),
	);
	const unclassified = new Set<string>();
	let selfSites = 0;
	for (const { file, source } of readWalkedFiles(files)) {
		// Parse only files that name a seam module: every mock spelling the
		// liveness case pins carries the module's base name as text, so the
		// substring test keeps the population exact and skips ~900 AST parses
		// (the unfiltered loop timed out in CI at 5000 ms, #4285 verify). A
		// file that mocks the module through a specifier it never spells is
		// outside this needle; the flake-shape ratchet's in-process-mock
		// detector counts every unreadable specifier in tests/ (#4429).
		const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
		const named = SEAM_MODULES.filter(({ module }) =>
			source.includes(seamBaseName(module)),
		);
		if (named.length === 0) continue;
		for (const { module } of named) {
			const scan = scanViMockSites(relative, source, module);
			if (relative === SELF) selfSites += scan.count;
			else result[module] += scan.count;
			for (const entry of scan.unclassified) unclassified.add(entry);
		}
		// Turn the loop between files so `@ast-grep/napi` can free each parsed
		// tree from its finalizer before the next one is built (the
		// `vi-mock-export-sweep` memory bound, #3565).
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return { counts: result, unclassified: [...unclassified], selfSites };
}

describe("project-trust real seam ratchet (#4281)", () => {
	it(
		"keeps every seam module's whole-module mock population at or below baseline",
		async () => {
			const live = await counts();
			for (const { module } of SEAM_MODULES) {
				expect(live.counts[module]).toBeLessThanOrEqual(BASELINE[module]);
			}
			// Recurrence: #4411 review F3, a population scanner that skipped
			// spellings it did not recognise and passed (#4429).
			expect(live.unclassified).toEqual([]);
			// Recurrence: #4457 verify G3, a skip of this file hid a real doMock.
			expect(live.selfSites).toBe(SELF_SITES);
			// Budget: this case walks the whole tests/ tree, so it takes the same
			// explicit, lane-scaled budget as its sibling tree scans instead of
			// vitest's 5000 ms default. Recurrence: the Windows timeout on master
			// run 39953813640 (#4799), "Test timed out in 5000ms" at this case.
		},
		scaledTestTimeout(30_000),
	);

	// Liveness: a detector that silently counts zero would pass the shrink-only
	// assertion above, so the known sites are pinned here. The comment and the
	// string literal must not count; each executable spelling must (shape 34:
	// the unlisted `doMock`/`.ts`/backtick/bracket forms are the point).
	it("detects executable mocks and ignores comments and strings", () => {
		const source = [
			'// vi.mock("../clients/project-trust.js")',
			"const text = 'vi.mock(\"../clients/project-trust.js\")';",
			'vi.mock("../clients/project-trust.js", () => ({}));',
			'vi.doMock("../clients/project-trust.js", () => ({}));',
			'vi.mock("../clients/project-trust.ts", () => ({}));',
			"vi.mock(`../clients/project-trust.js`, () => ({}));",
			'vi["mock"]("../clients/project-trust.js", () => ({}));',
			'vi.doMock("../clients/other.js", () => ({}));',
		].join("\n");
		expect(countViMockSites(source, "clients/project-trust.js")).toBe(5);
	});

	it("counts the typed import() specifier form (#4429)", () => {
		// `vi.mock(import("…"))` is vitest's typed spelling; the old reader
		// returned nothing for it, so the mock was neither counted nor reported.
		expect(
			countViMockSites(
				'vi.mock(import("../clients/project-trust.js"), () => ({}));',
				"clients/project-trust.js",
			),
		).toBe(1);
	});

	it.each([
		[
			"vitest.mock",
			'import { vitest } from "vitest";\nvitest.mock(S, () => ({}));',
		],
		[
			"an import alias",
			'import { vi as v } from "vitest";\nv.doMock(S, () => ({}));',
		],
		["a const alias", "const v = vi;\nv.doMock(S, () => ({}));"],
		["a const method alias", "const late = vi.doMock;\nlate(S, () => ({}));"],
		["a destructured method", "const { doMock } = vi;\ndoMock(S, () => ({}));"],
		[
			"a renamed destructure",
			"const { doMock: dm } = vitest;\ndm(S, () => ({}));",
		],
		[
			"a namespace import",
			'import * as V from "vitest";\nV.vi.mock(S, () => ({}));',
		],
		["parentheses", "(vi).doMock(S, () => ({}));"],
		["a cast", "(vi as any).doMock(S, () => ({}));"],
		["a non-null assertion", "vi!.mock(S, () => ({}));"],
		[".call", "vi.doMock.call(vi, S, () => ({}));"],
		[".apply", "vi.doMock.apply(vi, [S, () => ({})]);"],
	])(
		"counts a seam mock spelled through %s (#4429 review F2)",
		(_name, body) => {
			// Recurrence: #4457 review F2, each of these mocked the seam module and
			// the `vi`-identifier needle neither counted nor reported it.
			const source = body.replaceAll("S", '"../clients/project-trust.js"');
			expect(
				scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
			).toEqual({ count: 1, unclassified: [] });
		},
	);

	it.each([
		[
			"a helper's typed parameter",
			"function m(v: typeof vi) { v.doMock(S); }\nm(vi);",
		],
		["a helper's untyped parameter", "const m = (v) => v.doMock(S);\nm(vi);"],
		[
			"a parameter called directly",
			"function apply(f) { f(S); }\napply(vi.doMock);",
		],
		[
			"a re-exported alias",
			'import { vv } from "../support/vitest-reexport.js";\nvv.doMock(S);',
		],
		[
			"a re-exporting namespace",
			'import * as h from "../support/helpers.js";\nh.vi.doMock(S);',
		],
		[
			"a namespace destructure",
			'import * as v from "vitest";\nconst { vi: w } = v;\nw.doMock(S);',
		],
		["an object member", "const api = { mock: vi.doMock };\napi.mock(S);"],
		["an object holding vi", "const api = { vi };\napi.vi.doMock(S);"],
		["a class static", "class H { static m = vi.doMock; }\nH.m(S);"],
		[
			"a namespace member",
			"namespace N { export const m = vi.doMock; }\nN.m(S);",
		],
		[".bind", "vi.doMock.bind(vi)(S);"],
		["Reflect.apply", "Reflect.apply(vi.doMock, vi, [S, () => ({})]);"],
		["a sequence", "(0, vi.doMock)(S);"],
		["an array index", "[vi][0].doMock(S);"],
		["a reassigned let", "let v = undefined as any;\nv = vi;\nv.doMock(S);"],
		["a hoisted value", "const m = vi.hoisted(() => vi.doMock);\nm(S);"],
		[
			"a renamed destructure of an unknown owner",
			"const { doMock: dm } = getVitest();\ndm(S);",
		],
		[
			"a shadowed node: import",
			'import * as path from "node:path";\nfunction f(path) { path.doMock(S); }\nf(vi);',
		],
	])(
		"counts a seam specifier passed through %s (#4457 verify F2-r2)",
		(_name, body) => {
			// Recurrence: #4457 verify F2-r2, the round-2 resolver bound each of
			// these callees as provably not vitest, and the helper-parameter
			// spelling replaced the module at runtime with the ratchet green.
			const source = body.replaceAll("S", '"../clients/project-trust.js"');
			expect(
				scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
			).toEqual({ count: 1, unclassified: [] });
		},
	);

	it("counts a spread seam argument and reports its unreadable first argument (#4429)", () => {
		// A spread is an argument wrapper (the string counts) and, as a direct
		// vi.doMock's first argument, not a readable specifier (round 1's rule).
		const source = 'vi.doMock(...["../clients/project-trust.js", () => ({})]);';
		expect(
			scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
		).toEqual({
			count: 1,
			unclassified: [`unclassified spelling at fake.test.ts:1: ${source}`],
		});
	});

	it.each([
		[
			"path.join",
			'vi.doMock(path.join(__dirname, "../clients", "project-trust.js"));',
		],
		["a concatenation", 'vi.doMock("../clients/project-" + "trust.js");'],
		["a template substitution", 'vi.mock(`../clients/project-${"trust"}.js`);'],
		[
			"an array join",
			'vi.doMock(["..", "clients", "project-trust.js"].join("/"));',
		],
	])(
		"reports a direct mock whose specifier is computed through %s (#4457 verify G1)",
		(_name, source) => {
			// Recurrence: #4457 verify G1, round 3 dropped round 1's rule and the
			// path.join spelling replaced the seam at runtime with the ratchet green.
			expect(
				scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
			).toEqual({
				count: 0,
				unclassified: [`unclassified spelling at fake.test.ts:1: ${source}`],
			});
		},
	);

	it("does not count a seam string under a callee proven non-vitest (#4429)", () => {
		// The one exemption in the state table: a root bound once, by a vitest
		// export other than vi, a node: builtin, or inert literal data.
		const source = [
			'import { expect } from "vitest";',
			'import * as path from "node:path";',
			'const ids = ["a", { b: 1 }];',
			"expect(value).toBe(S);",
			"path.join(dir, S);",
			"ids.includes(S);",
			"ids[0].startsWith(S);",
			'path.join("a", "b");',
		]
			.join("\n")
			.replaceAll("S", '"../clients/project-trust.js"');
		expect(
			scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
		).toEqual({ count: 0, unclassified: [] });
	});

	it("proves nothing through a reassignable, shadowed or non-literal binding (#4429)", () => {
		// Each root below looks like an exempt one, but its value can change.
		for (const body of [
			'let ids = ["a"];\nids.includes(S);',
			'const ids = ["a", vi];\nids.includes(S);',
			'import { expect } from "vitest";\nconst f = (expect) => expect(S);',
			'import { expect } from "./not-vitest.js";\nexpect(S);',
		]) {
			const source = body.replaceAll("S", '"../clients/project-trust.js"');
			expect(
				scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
				body,
			).toEqual({ count: 1, unclassified: [] });
		}
	});

	it("reports a seam string it cannot place, with its line (#4429)", () => {
		// The fail-closed branch: a seam string outside an import or an
		// argument, or a computed spelling of the seam, may reach a mock through
		// a value the scan does not follow, so each reds. An unknown callee
		// counts instead (lines 4 to 6).
		const source = [
			'const target = "../clients/project-trust.js";',
			"vi.mock(target, () => ({}));",
			"vi.doMock(`../clients/${'project-trust'}.js`, () => ({}));",
			'vi["mo" + "ck"]("../clients/project-trust.js", () => ({}));',
			'getVitest().doMock("../clients/project-trust.js", () => ({}));',
			'jest.mock("../clients/project-trust.js");',
			'const table = { seam: "../clients/project-trust.js" };',
			'vi.doMock(flag ? "../clients/project-trust.js" : other);',
			'const pending = import("../clients/project-trust.js");',
			'vi.doMock("../clients/" + "project-trust" + ".js");',
		].join("\n");
		expect(
			scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
		).toEqual({
			count: 3,
			unclassified: [
				'unclassified spelling at fake.test.ts:1: const target = "../clients/project-trust.js";',
				"unclassified spelling at fake.test.ts:3: vi.doMock(`../clients/${'project-trust'}.js`, () => ({}));",
				'unclassified spelling at fake.test.ts:7: const table = { seam: "../clients/project-trust.js" };',
				'unclassified spelling at fake.test.ts:8: vi.doMock(flag ? "../clients/project-trust.js" : other);',
				'unclassified spelling at fake.test.ts:9: const pending = import("../clients/project-trust.js");',
				'unclassified spelling at fake.test.ts:10: vi.doMock("../clients/" + "project-trust" + ".js");',
				"unclassified spelling at fake.test.ts:2: vi.mock(target, () => ({}));",
			],
		});
	});

	it("keeps each admitted data string live and reasoned (#4429)", () => {
		// A stale admission would excuse a future line with the same text.
		for (const [key, reason] of Object.entries(ADMITTED_DATA)) {
			const at = key.indexOf(": ");
			const file = key.slice(0, at);
			const text = key.slice(at + 2);
			const lines = readFileSync(path.join(REPO_ROOT, file), "utf8")
				.split("\n")
				.map((line) => line.trim());
			// One occurrence: a duplicate line would share the admission (#4457
			// verify LOW: `PATHS[0]` beside the admitted list entry).
			expect(
				lines.filter((line) => line === text),
				key,
			).toHaveLength(1);
			expect(reason.length, key).toBeGreaterThan(30);
		}
	});

	it("ignores an unclassifiable spelling inside a comment or a string (#4429)", () => {
		const source = [
			"// vi.mock(target, () => ({}));",
			"const text = 'vi.mock(target) vi[key](\"../clients/project-trust.js\")';",
		].join("\n");
		expect(
			scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
		).toEqual({ count: 0, unclassified: [] });
	});
});

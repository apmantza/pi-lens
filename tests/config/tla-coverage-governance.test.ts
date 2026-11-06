import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	changedHookAnchors,
	evaluateTlaCoverage,
	findHookRanges,
	hookAnchorsFromRanges,
	loadCoverageMap,
	matchGlob,
	parseChangedFiles,
	validateCoverageMap,
	withoutDeclaredFamilies,
} from "../../scripts/lib/tla-coverage.mjs";
import {
	lintLocalPrBody,
	lintTlaCoverage,
	parseRuntimeHunks,
} from "../../scripts/check-pr-body.mjs";
import {
	loadAstGrepNapi,
	type SgNode,
} from "../../clients/deps/ast-grep-napi.js";
import {
	assertNonEmptyScan,
	escapeRegExp,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

// #3902: the PR-body lint cases inject a fake git, so none may spawn a real
// one. The child-process boundary records every `execFileSync` spawn and
// refuses it; a case asserts the record stayed empty. It does not see the
// `execSync` form, which `check-pr-body.mjs` does not import today (a p3
// residual in the PR body). A real spawn plus a lex of every matching runtime
// file took 235 ms solo and over 5 s on a loaded Windows runner.
const realGit = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFileSync: (_file: string, args: string[]) => {
		realGit.calls.push(args);
		throw new Error("a real git spawn in a fake-git lint case (#3902)");
	},
}));

// #3802 rule 2: a PR that changes a mapped runtime file must move its model
// (a .tla/.cfg under the family) or say "TLA+ unaffected: <family> — <reason>".
// The recurrence this prevents is #3524/#3525's class: a lifecycle seam changed
// while its TLA+ model kept describing the old behaviour, so TLC stayed green
// and proved nothing about the new code. A row is ANY-OF (one listed family's
// model move or declaration satisfies it): PR #3864 r1 demanded every family,
// which reddened 81 of the last 200 merged PRs (40.5%), 17 of the 22 that did
// move a model. The map-drift half (#3864 F4) is the same #3279/#3283 class as
// an exact-count pin: a tree that grows a family the map never learns.
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const map = loadCoverageMap(REPO_ROOT);

// #5330: the 2026-11-04 marker audit missed three large state machines because
// it ranked prose markers instead of the helpers that actually retain state.
// Rounds 2 and 3 scanned blanked text and kept missing spellings (an object
// literal after any arrow, a field placed after a method, `import.meta`
// followed by `Array.from`), so the census parses each file instead.
//
// Module scope is decided on the syntax tree: a reference is per call when it
// sits in the body or parameters of a function, arrow or method, and per
// instance when it is the value of a non-static class field. Everything else
// runs once at module load, and a helper reference there is a hit. Static
// fields, static blocks, decorators, computed keys and module-level blocks
// all count. The census admits five forms, each a node kind or a binding
// form and never a spelling: a type position (`type_identifier`, `typeof` in
// a type), an import, a function declaration's name, and the source of a
// derivation (`class C extends H`, `const A = H`, an export specifier,
// `export * as N`). A derivation's product is tracked in every file, so the
// chain is followed instead of admitted. Every other reference is a hit.
//
// Not followed (#5330 F2, accepted p3): a helper built inside a function and
// handed to a module-scope caller, as getProcessSingleton and sessionCell do.
const STATE_HELPERS = [
	"BoundedFifoMap",
	"PathKeyedMap",
	"createSingleFlight",
	"createAvailabilityLatch",
] as const;
const ALL_STATE_HELPERS = [
	"BoundedFifoMap",
	"PathKeyedMap",
	"createSingleFlight",
	"createAvailabilityLatch",
] as const;

const napi = await loadAstGrepNapi();

type StateHelperHit = { file: string; helper: string; line: number };
type CensusSource = { file: string; source: string };

const FUNCTION_KINDS = new Set([
	"function_declaration",
	"generator_function_declaration",
	"function_expression",
	"generator_function",
	"arrow_function",
	"method_definition",
]);
const PER_CALL_FIELDS = ["body", "parameters", "parameter"];

const isFieldOf = (parent: SgNode, child: SgNode, field: string) =>
	parent.field(field)?.id() === child.id();

/** True unless a function boundary or an instance field encloses the node. */
function atModuleScope(node: SgNode): boolean {
	let child = node;
	for (let parent = node.parent(); parent; parent = parent.parent()) {
		const kind = String(parent.kind());
		if (
			FUNCTION_KINDS.has(kind) &&
			PER_CALL_FIELDS.some((field) => isFieldOf(parent, child, field))
		)
			return false;
		if (
			kind === "public_field_definition" &&
			isFieldOf(parent, child, "value") &&
			!parent.children().some((part) => part.kind() === "static")
		)
			return false;
		child = parent;
	}
	return true;
}

/** The repo-relative `.ts` file a relative specifier names, if any. */
function resolveModule(file: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const joined = path.posix.join(path.posix.dirname(file), specifier);
	return `${joined.replace(/\.[cm]?[jt]s$/, "")}.ts`;
}

const unquote = (node: SgNode | null) => node?.text().slice(1, -1) ?? "";

const decodeEscapes = (text: string) =>
	text.replace(
		/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g,
		(_, braced, plain) =>
			String.fromCodePoint(Number.parseInt(braced ?? plain, 16)),
	);

type ModuleFacts = {
	derived: string[];
	helperModule: boolean;
	hits: StateHelperHit[];
};

function analyzeModule(
	root: SgNode,
	file: string,
	tracked: ReadonlySet<string>,
	helperModules: ReadonlySet<string>,
): ModuleFacts {
	const fromHelperModule = (specifier: string) => {
		const target = resolveModule(file, specifier);
		return target !== undefined && helperModules.has(target);
	};
	const local = new Set(tracked);
	const admitted = new Set<number>();
	const derived: string[] = [];
	let helperModule = false;
	const derive = (product: SgNode | null, source: SgNode) => {
		admitted.add(source.id());
		if (!product) return;
		admitted.add(product.id());
		derived.push(product.text());
	};
	for (const statement of root.findAll({
		rule: { kind: "import_statement" },
	})) {
		const source = statement.field("source");
		for (const fragment of source?.findAll({
			rule: { kind: "string_fragment" },
		}) ?? [])
			admitted.add(fragment.id());
		const fromHelper = fromHelperModule(unquote(source));
		for (const binding of statement.findAll({
			rule: {
				any: [
					{ kind: "import_specifier" },
					{ kind: "namespace_import" },
					{ kind: "identifier", inside: { kind: "import_clause" } },
				],
			},
		})) {
			const kind = String(binding.kind());
			if (kind === "import_specifier") {
				const name = binding.field("name")?.text() ?? "";
				if (tracked.has(name))
					local.add(binding.field("alias")?.text() ?? name);
			} else if (fromHelper && kind === "namespace_import") {
				const name = binding.find({ rule: { kind: "identifier" } });
				if (name) local.add(name.text());
			} else if (fromHelper && kind === "identifier") {
				local.add(binding.text());
			}
		}
	}
	for (const node of root.findAll({
		rule: {
			any: [
				{ kind: "class_declaration" },
				{ kind: "abstract_class_declaration" },
				{ kind: "function_declaration" },
				{ kind: "generator_function_declaration" },
				{
					kind: "variable_declarator",
					has: { field: "value", kind: "identifier" },
				},
				{ kind: "export_statement" },
			],
		},
	})) {
		if (!atModuleScope(node)) continue;
		const kind = String(node.kind());
		const name = node.field("name");
		if (kind.endsWith("class_declaration")) {
			if (name && tracked.has(name.text())) helperModule = true;
			const heritage = node
				.children()
				.find((part) => part.kind() === "class_heritage")
				?.children()
				.find((part) => part.kind() === "extends_clause")
				?.field("value");
			if (heritage?.kind() === "identifier" && local.has(heritage.text()))
				derive(name, heritage);
		} else if (kind.endsWith("function_declaration")) {
			if (!name) continue;
			admitted.add(name.id());
			if (tracked.has(name.text())) helperModule = true;
		} else if (kind === "variable_declarator") {
			const value = node.field("value");
			if (
				value?.kind() === "identifier" &&
				local.has(value.text()) &&
				name?.kind() === "identifier"
			)
				derive(name, value);
		} else {
			const source = node.field("source");
			for (const fragment of source?.findAll({
				rule: { kind: "string_fragment" },
			}) ?? [])
				admitted.add(fragment.id());
			const fromHelper = source !== null && fromHelperModule(unquote(source));
			for (const specifier of node.findAll({
				rule: { kind: "export_specifier" },
			})) {
				const exported = specifier.field("name");
				const alias = specifier.field("alias");
				if (!exported || !local.has(exported.text())) continue;
				helperModule = true;
				if (alias?.text() === "default") continue;
				derive(alias, exported);
			}
			const namespace = node
				.children()
				.find((part) => part.kind() === "namespace_export");
			if (namespace && fromHelper)
				derive(namespace.find({ rule: { kind: "identifier" } }), namespace);
			else if (
				fromHelper &&
				node.children().some((part) => part.kind() === "*")
			)
				helperModule = true;
		}
	}
	const hits: StateHelperHit[] = [];
	const hit = (node: SgNode, helper: string) =>
		hits.push({ file, helper, line: node.range().start.line + 1 });
	const names = [...local].map(escapeRegExp).join("|");
	for (const leaf of root.findAll({
		rule: { regex: `^(?:${names})$|\\\\u` },
	})) {
		const text = decodeEscapes(leaf.text());
		if (!leaf.isLeaf() || !local.has(text) || admitted.has(leaf.id())) continue;
		if (leaf.kind() === "type_identifier" || !atModuleScope(leaf)) continue;
		const ancestors = leaf.ancestors().map((node) => String(node.kind()));
		if (
			ancestors.includes("type_query") ||
			ancestors.includes("import_statement")
		)
			continue;
		hit(leaf, text);
	}
	for (const fragment of root.findAll({
		rule: { kind: "string_fragment", regex: "^\\." },
	})) {
		if (admitted.has(fragment.id()) || !fromHelperModule(fragment.text()))
			continue;
		if (atModuleScope(fragment)) hit(fragment, fragment.text());
	}
	for (const call of root.findAll({
		rule: {
			kind: "call_expression",
			has: { field: "function", kind: "import" },
		},
	})) {
		if (!atModuleScope(call)) continue;
		const args = call.field("arguments")?.namedChildren() ?? [];
		const literal = args.length === 1 && args[0].kind() === "string";
		if (!literal) hit(call, call.text());
	}
	return { derived, helperModule, hits };
}

/**
 * Hits over a set of sources. Tracked names and helper modules grow to a fixed
 * point, so the final pass reads every file with the final sets.
 */
async function stateHelperCensus(
	sources: readonly CensusSource[],
): Promise<StateHelperHit[]> {
	const tracked = new Set<string>(STATE_HELPERS);
	const helperModules = new Set<string>();
	for (;;) {
		const before = tracked.size + helperModules.size;
		const hits: StateHelperHit[] = [];
		for (const { file, source } of sources) {
			const root = napi.parse(napi.Lang.TypeScript, source).root();
			const facts = analyzeModule(root, file, tracked, helperModules);
			for (const name of facts.derived) tracked.add(name);
			if (facts.helperModule) helperModules.add(file);
			hits.push(...facts.hits);
			// #4736: a dropped tree's native arena is freed only once the loop
			// turns, so the walk yields between files.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		if (tracked.size + helperModules.size === before) return hits;
	}
}

function unmappedStateHelperHits(
	hits: StateHelperHit[],
	coverageMap: { map?: Record<string, unknown> },
) {
	return hits.filter((hit) => !Object.hasOwn(coverageMap.map ?? {}, hit.file));
}

/** Every non-test runtime source the census reads. */
function censusSources(): CensusSource[] {
	const files = ["clients", "mcp", "tools"].flatMap((entry) =>
		listSourceFiles(path.join(REPO_ROOT, entry), {
			extensions: [".ts"],
			skipTests: true,
		}),
	);
	files.push(path.join(REPO_ROOT, "index.ts"));
	assertNonEmptyScan("module state-helper source files", files.length, 100);
	return readWalkedFiles(files).map(({ file, source }) => ({
		file: relativePosix(REPO_ROOT, file),
		source,
	}));
}

/** The hits as sorted `file:line helper` rows, so a case reads as one list. */
async function censusRows(sources: Record<string, string>): Promise<string[]> {
	const hits = await stateHelperCensus(
		Object.entries(sources).map(([file, source]) => ({ file, source })),
	);
	return hits.map((hit) => `${hit.file}:${hit.line} ${hit.helper}`).sort();
}

/** A one-file fixture's hit rows. */
const fixtureRows = (source: string) =>
	censusRows({ "clients/fixture.ts": source });

/** BoundedFifoMap's definition module, reduced to its declaration. */
const DEFINITION_STUBS = {
	"clients/bounded-cache.ts": "export class BoundedFifoMap {}",
};

describe("module-level state-helper coverage census (#5330)", () => {
	// The tree walk is the census itself: real files through the real parse,
	// checked against the checked-in map.
	it(
		"requires every module-level helper hit to have a map row",
		async () => {
			const hits = await stateHelperCensus(censusSources());
			expect(hits.length).toBeGreaterThan(0);
			const unmapped = unmappedStateHelperHits(hits, map);
			expect(
				unmapped,
				unmapped
					.map((hit) => `${hit.file}:${hit.line} ${hit.helper}`)
					.join("\n"),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("reds a new helper file until its row is admitted", async () => {
		const hits = await stateHelperCensus([
			{
				file: "clients/fixture.ts",
				source: "const f = new BoundedFifoMap(1);",
			},
		]);
		const withoutRow = { map: {} };
		const withRow = { map: { "clients/fixture.ts": "unmodelled" } };
		expect(unmappedStateHelperHits(hits, withoutRow)).toHaveLength(1);
		expect(unmappedStateHelperHits(hits, withRow)).toEqual([]);
	});

	// #5330 F1: an independent list, so dropping a name from STATE_HELPERS
	// reds here instead of shrinking the loop with it.
	it("keeps every helper name live in the fixture arm", async () => {
		for (const helper of ALL_STATE_HELPERS) {
			expect(STATE_HELPERS, helper).toContain(helper);
			const expression =
				helper[0] === helper[0].toUpperCase()
					? `new ${helper}(1)`
					: `${helper}()`;
			expect(await fixtureRows(`const state = ${expression};`), helper).toEqual(
				[`clients/fixture.ts:1 ${helper}`],
			);
		}
	});

	// #5330 F3, F3c, F3d and the round-1 list: every one of these returned no
	// hit from a text scan in rounds 2 and 3. Each holds a helper reference
	// that runs once at module load.
	it.each([
		[
			"object literal after an arrow",
			"const f = () => 1;\nconst s = { cache: new BoundedFifoMap(1) };",
		],
		[
			"object literal after `classes`",
			"const classes = 1;\nconst s = { cache: new BoundedFifoMap(1) };",
		],
		[
			"object literal after `functionName`",
			"const functionName = 1;\nconst s = { c: new PathKeyedMap(n) };",
		],
		[
			"multi-line object after `subclassCount`",
			"const subclassCount = 3;\nconst s = {\n  cache: new BoundedFifoMap(1),\n};",
		],
		[
			"module `if` block after an arrow",
			"const f = () => 1;\nif (process.env.X) { var c = new BoundedFifoMap(1); }",
		],
		[
			"module `try` block after an arrow",
			"const f = () => 1; let c; try { c = new createSingleFlight(); } catch {}",
		],
		[
			"`import.meta` then `Array.from`",
			"const here = import.meta.dirname; const c = new BoundedFifoMap(1); Array.from(y);",
		],
		[
			"dynamic import then `Array.from`",
			"const m = import('./x.js'); const c = new BoundedFifoMap(1); Array.from(y);",
		],
		["ternary second branch", "const a = flag ? x : BoundedFifoMap;"],
		["ternary first branch", "const a = flag ? BoundedFifoMap : Other;"],
		["object value", "const o = { make: BoundedFifoMap };"],
		["object shorthand", "const o = { BoundedFifoMap };"],
		["object-literal field", "const a = { cache: new BoundedFifoMap(1) };"],
		["call argument", "register(BoundedFifoMap);"],
		["export default", "export default BoundedFifoMap;"],
		["array element", "const a = [BoundedFifoMap, PathKeyedMap];"],
		["comma expression", "const a = (0, createAvailabilityLatch)();"],
		["class expression heritage", "const K = class extends BoundedFifoMap {};"],
		["static field", "class A { static cache = new BoundedFifoMap(1); }"],
		[
			"static field after a method",
			"class A { m() {} static cache = new PathKeyedMap(1); }",
		],
		[
			"static block",
			"class A { static { register(createAvailabilityLatch()); } }",
		],
		["computed method key", "class A { [createSingleFlight.name]() {} }"],
		[
			"namespace body",
			"namespace N { export const c = new BoundedFifoMap(1); }",
		],
		["destructured key", "const { BoundedFifoMap: B } = ns;"],
		["string member key", "const c = new ns['BoundedFifoMap'](1);"],
		["escaped identifier", "const c = new Bounded\\u0046ifoMap(1);"],
		[
			"`import D, { X as A }` alias",
			"import D, { PathKeyedMap as A } from './map.js'; const a = new A(1);",
		],
		[
			"alias with an inline comment",
			"import { BoundedFifoMap /* cache */ as Cache } from './map.js'; const a = new Cache(1);",
		],
		[
			"use after a multi-line export list",
			"export {\n BoundedFifoMap,\n}; const a = new BoundedFifoMap(1);",
		],
		["default re-export", "export { BoundedFifoMap as default };"],
		["computed dynamic import", "const m = await import(`./${name}.js`);"],
	])("counts a module-scope reference: %s", async (_label, source) => {
		expect(await fixtureRows(source)).not.toEqual([]);
	});

	// #5330 F3b: a per-call or per-instance construction is not module state,
	// and the verdict does not depend on member order.
	it.each([
		["function body", "function f() { return new BoundedFifoMap(1); }"],
		["arrow body", "const f = () => new BoundedFifoMap(1);"],
		[
			"function expression body",
			"const f = function () { return createSingleFlight(); };",
		],
		[
			"default parameter",
			"function f(c = new BoundedFifoMap(1)) { return c; }",
		],
		[
			"object method body",
			"const o = { m() { return new PathKeyedMap(1); } };",
		],
		[
			"constructor body",
			"class A { constructor() { this.c = new BoundedFifoMap(1); } }",
		],
		[
			"instance field before a method",
			"class A { private readonly l = createAvailabilityLatch(); m() {} }",
		],
		[
			"instance field after a method",
			"class A { m() {} private readonly l = createAvailabilityLatch(); }",
		],
		[
			"comment and inexact string",
			"// new BoundedFifoMap(1)\nconst t = 'new BoundedFifoMap(2)';",
		],
	])(
		"does not count a per-call or per-instance reference: %s",
		async (_label, source) => {
			expect(await fixtureRows(source)).toEqual([]);
		},
	);

	// The admissions, one node kind or binding form each. A type position or an
	// import binds no value; a declaration or a derivation names a helper and
	// the derived name is tracked instead (the next case).
	it.each([
		["type annotation", "let c: BoundedFifoMap<string, number> | undefined;"],
		["`as` type", "const y = x as PathKeyedMap<number>;"],
		[
			"`typeof` in a type",
			"type Flight = ReturnType<typeof createSingleFlight>;",
		],
		[
			"import specifier",
			"import { BoundedFifoMap } from './bounded-cache.js';",
		],
		["function declaration name", "export function createSingleFlight() {}"],
		["subclass declaration", "class Sub extends BoundedFifoMap {}"],
		["identifier alias", "const Alias = BoundedFifoMap;"],
		[
			"re-export specifier",
			"export { BoundedFifoMap as Cache } from './bounded-cache.js';",
		],
	])("admits a non-use: %s", async (_label, source) => {
		expect(await fixtureRows(source)).toEqual([]);
	});

	// Alias resolution: every form that gives a helper a new name, in its own
	// file or across files, is followed to the module-scope use.
	it.each([
		[
			"a subclass",
			{
				"clients/lru.ts":
					"import { BoundedFifoMap } from './bounded-cache.js';\nexport class Lru extends BoundedFifoMap {}",
				"clients/user.ts":
					"import { Lru } from './lru.js';\nconst c = new Lru(1);",
			},
			["clients/user.ts:2 Lru"],
		],
		[
			"a re-export alias",
			{
				"clients/barrel.ts":
					"export { BoundedFifoMap as Cache } from './bounded-cache.js';",
				"clients/user.ts":
					"import { Cache } from './barrel.js';\nconst c = new Cache(1);",
			},
			["clients/user.ts:2 Cache"],
		],
		[
			"an exported identifier alias",
			{
				"clients/alias.ts":
					"import { PathKeyedMap } from './path-keyed-map.js';\nexport const Keyed = PathKeyedMap;",
				"clients/user.ts":
					"import { Keyed as K } from './alias.js';\nconst c = new K(1);",
			},
			["clients/user.ts:2 K"],
		],
		[
			"a namespace import with a computed member",
			{
				...DEFINITION_STUBS,
				"clients/user.ts":
					"import * as bc from './bounded-cache.js';\nconst c = new bc[name](1);",
			},
			["clients/user.ts:2 bc"],
		],
		[
			"a default import of a helper module",
			{
				...DEFINITION_STUBS,
				"clients/user.ts":
					"import Cache from './bounded-cache.js';\nconst c = new Cache(1);",
			},
			["clients/user.ts:2 Cache"],
		],
		[
			"a namespace import of a star re-export",
			{
				...DEFINITION_STUBS,
				"clients/barrel.ts": "export * from './bounded-cache.js';",
				"clients/user.ts":
					"import * as barrel from './barrel.js';\nconst c = new barrel[name](1);",
			},
			["clients/user.ts:2 barrel"],
		],
		[
			"a namespace re-export",
			{
				...DEFINITION_STUBS,
				"clients/barrel.ts": "export * as caches from './bounded-cache.js';",
				"clients/user.ts":
					"import { caches } from './barrel.js';\nconst c = new caches[name](1);",
			},
			["clients/user.ts:2 caches"],
		],
		[
			"a dynamic import of a helper module",
			{
				...DEFINITION_STUBS,
				"clients/user.ts": "const m = await import('./bounded-cache.js');",
			},
			["clients/user.ts:1 ./bounded-cache.js"],
		],
	])("follows %s to its module-scope use", async (_label, sources, rows) => {
		expect(await censusRows(sources)).toEqual(rows);
	});
});

const READ_GUARD_MAP = {
	families: ["read-guard"],
	map: { "clients/read-guard.ts": ["read-guard"] },
};

const TWO_FAMILY_MAP = {
	families: ["read-guard", "session-lifecycle", "file-locks"],
	map: { "clients/read-guard.ts": ["read-guard", "session-lifecycle"] },
};

const hubMap = (count: number) => {
	const families = ["alpha", "beta", "gamma", "delta", "epsilon"].slice(
		0,
		count,
	);
	return { families, map: { "clients/hub.ts": families } };
};

// A structurally valid PR body with no code citations and no test references,
// so the only error under test is the coverage rule.
const BASE_BODY = [
	"## Why",
	"The coverage rule keeps a model tied to the code it models.",
	"",
	"## Notes for the reviewer",
	"- None.",
	"",
	"## Change outline",
	"- clients/read-guard.ts",
	"",
	"## Summary",
	"Extend the read guard.",
	"",
	"## Proof and checks",
	"The proof sections follow.",
	"",
	"## Tests",
	"Targeted tests pass.",
	"",
	"## Blast radius",
	"clients/read-guard.ts.",
	"",
	"## Class sweep",
	"Defect shape: a mapped runtime file changed without its model. Search: `rg -n read-guard formal`. Verdict: none outside this fixture.",
	"Alignment: none: this fixture touches no family.",
	"",
	"## Fold check",
	"#4711 folded: the same body-lint seam, so the section lands here. Closes #4711.",
	"",
	"## Observability",
	"No new failure path; no record added.",
].join("\n");

const READ_GUARD_DIFF = [
	"diff --git a/clients/read-guard.ts b/clients/read-guard.ts",
	"@@ -1,0 +1,1 @@",
	"+// touched",
].join("\n");

// The runtime post-image must match the diff's added lines (#3906 r3), so a
// synthetic diff supplies its own post-image instead of the real file.
const READ_GUARD_HEAD_FILES = new Map([
	["clients/read-guard.ts", "// touched"],
]);

function compareStrings(a: string, b: string) {
	return a < b ? -1 : a > b ? 1 : 0;
}

describe("TLA+ coverage map (#3802)", () => {
	it("names every listed family in at least one map row", () => {
		// Derived from the map, never pinned: a count pin reds every legitimate
		// map edit. The tree-to-map half (every formal/<dir> is listed) is the
		// validateCoverageMap case below, run against the real tree.
		const named = new Set(
			Object.values(map.map ?? {}).flatMap((value) =>
				Array.isArray(value)
					? value
					: typeof value === "object"
						? value.families
						: [],
			),
		);
		// A TLA lane that adds a family adds its map row in the same PR.
		expect((map.families ?? []).filter((family) => !named.has(family))).toEqual(
			[],
		);
	});

	it("matches every glob to a file and every family to a model", () => {
		expect(validateCoverageMap(map, REPO_ROOT)).toEqual([]);
	});

	describe("tree-to-map validation", () => {
		let root: string | undefined;
		afterEach(() => {
			if (root) fs.rmSync(root, { recursive: true, force: true });
			root = undefined;
		});

		function fixtureTree() {
			root = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-tla-coverage-tree-"),
			);
			fs.mkdirSync(path.join(root, "clients"));
			fs.writeFileSync(path.join(root, "clients", "a.ts"), "");
			fs.mkdirSync(path.join(root, "formal"));
			// A non-directory entry under formal/ is never a family.
			fs.writeFileSync(path.join(root, "formal", "coverage-map.json"), "{}");
			return root;
		}

		it("errors on a formal/<dir> the map does not list", () => {
			const tree = fixtureTree();
			for (const dir of ["fam-a", "fam-b"]) {
				fs.mkdirSync(path.join(tree, "formal", dir), { recursive: true });
				fs.writeFileSync(path.join(tree, "formal", dir, "Model.cfg"), "");
			}
			const errors = validateCoverageMap(
				{ families: ["fam-a"], map: { "clients/a.ts": ["fam-a"] } },
				tree,
			);
			expect(errors).toEqual([expect.stringContaining("formal/fam-b/")]);
		});

		it("accepts a tree whose every formal/<dir> is listed", () => {
			const tree = fixtureTree();
			fs.mkdirSync(path.join(tree, "formal", "fam-a"), { recursive: true });
			fs.writeFileSync(path.join(tree, "formal", "fam-a", "Model.cfg"), "");
			expect(
				validateCoverageMap(
					{ families: ["fam-a"], map: { "clients/a.ts": ["fam-a"] } },
					tree,
				),
			).toEqual([]);
		});
	});

	it("matches a nested ** glob to files under its directory", () => {
		expect(
			matchGlob(
				"clients/dispatch/runners/**",
				"clients/dispatch/runners/biome-check.ts",
			),
		).toBe(true);
		expect(
			matchGlob("clients/dispatch/runners/**", "clients/dispatch/runners"),
		).toBe(false);
	});

	it("keeps both sides of a rename as changed paths", () => {
		const diff =
			"diff --git a/clients/read-guard.ts b/clients/read-guard-branch.ts";
		expect(parseChangedFiles(diff).sort(compareStrings)).toEqual([
			"clients/read-guard-branch.ts",
			"clients/read-guard.ts",
		]);
	});
});

describe("TLA+ coverage rule", () => {
	it("errors on a mapped change with no model change and no body line", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("formal/read-guard/");
		expect(result.errors[0]).toContain("TLA+ unaffected: read-guard");
	});

	it("passes when a .cfg under the family changes", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/read-guard/Guarded.cfg"],
			body: "",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("passes when the PR body carries the unaffected line", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "TLA+ unaffected: read-guard — only a local helper moved.",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("does not accept an unaffected line with no reason", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "TLA+ unaffected: read-guard — ",
		});
		expect(result.errors).toHaveLength(1);
	});

	it("passes a multi-family row when any one family's model moved", () => {
		const result = evaluateTlaCoverage({
			map: TWO_FAMILY_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/read-guard/Guarded.cfg"],
			body: "",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("passes a multi-family row when any one family is declared unaffected", () => {
		const result = evaluateTlaCoverage({
			map: TWO_FAMILY_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "TLA+ unaffected: session-lifecycle — only a local helper moved.",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("names every family on an unmet multi-family row in one error", () => {
		const result = evaluateTlaCoverage({
			map: TWO_FAMILY_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("formal/read-guard/");
		expect(result.errors[0]).toContain("formal/session-lifecycle/");
	});

	it("does not let a model move or declaration for a family off the row satisfy it", () => {
		const result = evaluateTlaCoverage({
			map: TWO_FAMILY_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/file-locks/Locks.cfg"],
			body: "TLA+ unaffected: file-locks — unrelated.",
		});
		expect(result.errors).toHaveLength(1);
	});

	it("turns an unmet hub row (4+ families) into a note, not an error", () => {
		const result = evaluateTlaCoverage({
			map: hubMap(4),
			changedFiles: ["clients/hub.ts"],
			body: "",
		});
		expect(result.errors).toEqual([]);
		expect(result.advisories).toHaveLength(1);
		expect(result.advisories[0]).toContain("TLA+ note: clients/hub.ts");
	});

	it("keeps an unmet 3-family row an error (hub threshold boundary)", () => {
		const result = evaluateTlaCoverage({
			map: hubMap(3),
			changedFiles: ["clients/hub.ts"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
		expect(result.advisories).toEqual([]);
	});

	it("prints no note for a hub row whose model moved or is declared", () => {
		const moved = evaluateTlaCoverage({
			map: hubMap(5),
			changedFiles: ["clients/hub.ts", "formal/gamma/Model.tla"],
			body: "",
		});
		const declared = evaluateTlaCoverage({
			map: hubMap(5),
			changedFiles: ["clients/hub.ts"],
			body: "TLA+ unaffected: delta — a comment moved.",
		});
		expect(moved).toEqual({ errors: [], advisories: [] });
		expect(declared).toEqual({ errors: [], advisories: [] });
	});

	it("reports only the unknown family, not an unmet-row error, for a corrupt row", () => {
		const hub = evaluateTlaCoverage({
			map: {
				families: ["alpha"],
				map: { "clients/hub.ts": hubMap(4).families },
			},
			changedFiles: ["clients/hub.ts"],
			body: "",
		});
		expect(hub.errors).toHaveLength(3);
		expect(hub.errors.join(" ")).toContain("unknown family beta");
		expect(hub.advisories).toEqual([]);
		const pair = evaluateTlaCoverage({
			map: {
				families: ["alpha"],
				map: { "clients/hub.ts": ["alpha", "ghost"] },
			},
			changedFiles: ["clients/hub.ts"],
			body: "",
		});
		expect(pair.errors).toEqual([
			"coverage map row clients/hub.ts names unknown family ghost",
		]);
	});

	it("does not count a non-model file under the family directory", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/read-guard/README.md"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
	});

	it("does not let a family name match another family it prefixes", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "TLA+ unaffected: read-guard-foo — not this family.",
		});
		expect(result.errors).toHaveLength(1);
	});

	it.each([
		["a backtick fence", "```\nTLA+ unaffected: read-guard — hidden.\n```"],
		["a tilde fence", "~~~\nTLA+ unaffected: read-guard — hidden.\n~~~"],
		[
			"a fence the inner shorter marker does not close",
			"````\n```\nTLA+ unaffected: read-guard — hidden.\n```\n````",
		],
		["an HTML comment", "<!-- TLA+ unaffected: read-guard — hidden. -->"],
		[
			"a multi-line HTML comment",
			"<!--\nTLA+ unaffected: read-guard — hidden.\n-->",
		],
		["an unterminated HTML comment", "<!--\nTLA+ unaffected: read-guard — x"],
	])("does not accept a declaration inside %s", (_label, hidden) => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: hidden,
		});
		expect(result.errors).toHaveLength(1);
	});

	// Recurrence (#4448 round 3): folding this blanker onto the shared one made
	// the 4-space code-block rule hide a declaration written as a list
	// continuation, which GitHub renders as list text. The fold keeps the rule
	// off here (`indentedCode: false`).
	it("accepts a declaration written as an indented list continuation", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "- Notes\n\n    TLA+ unaffected: read-guard — only a local helper moved.",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("accepts a declaration that follows a closed fence and comment", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "```\ncode\n```\n<!-- note -->\n- TLA+ unaffected: read-guard — real reason.",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("reports unmodelled seams as advisories, never errors", () => {
		const result = evaluateTlaCoverage({
			map: { families: [], map: { "clients/lsp-mutation.ts": "unmodelled" } },
			changedFiles: ["clients/lsp-mutation.ts"],
			body: "",
		});
		expect(result.errors).toEqual([]);
		expect(result.advisories).toHaveLength(1);
		expect(result.advisories[0]).toContain("lsp-mutation.ts");
	});

	it("ignores an unmapped changed file", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/other.ts"],
			body: "",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});
});

beforeEach(() => {
	realGit.calls.length = 0;
});

describe("TLA+ coverage in the PR-body lint (#3802)", () => {
	it("fails a mapped runtime change with no model change and no body line", () => {
		const git = (args: string[]) =>
			args.includes("--name-only")
				? "clients/read-guard.ts\n"
				: READ_GUARD_DIFF;
		const result = lintLocalPrBody(BASE_BODY, REPO_ROOT, git as never, {
			headFiles: READ_GUARD_HEAD_FILES,
		});
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("formal/read-guard/");
		expect(realGit.calls).toEqual([]);
	});

	// #3902: the declarations end the body, under "## Observability". Their
	// family names are not record mentions, so no runtime-tree `git grep` and
	// lex runs for them.
	const DECLARATIONS =
		"TLA+ unaffected: read-guard — only a local helper moved.\nTLA+ unaffected: session-lifecycle — the change does not touch session state.";

	const spyGit = (calls: string[][]) => (args: string[]) => {
		calls.push(args);
		return args.includes("--name-only")
			? "clients/read-guard.ts\n"
			: READ_GUARD_DIFF;
	};

	it("passes the same diff when the body carries the unaffected line", () => {
		const calls: string[][] = [];
		const body = `${BASE_BODY}\n\n${DECLARATIONS}`;
		const result = lintLocalPrBody(body, REPO_ROOT, spyGit(calls) as never, {
			headFiles: READ_GUARD_HEAD_FILES,
		});
		expect(result.valid).toBe(true);
		expect(calls.filter((args) => args[0] === "grep")).toEqual([]);
		expect(realGit.calls).toEqual([]);
	});

	it("still harvests a real record named in the same section", () => {
		const calls: string[][] = [];
		const body = `${BASE_BODY}\n\nSee \`tool-cwd-resolution\`.\n${DECLARATIONS}`;
		lintLocalPrBody(body, REPO_ROOT, spyGit(calls) as never, {
			headFiles: READ_GUARD_HEAD_FILES,
		});
		const grep = calls.find((args) => args[0] === "grep") ?? [];
		expect(grep).toContain("tool-cwd-resolution");
		expect(grep).not.toContain("read-guard");
		expect(grep).not.toContain("session-lifecycle");
		expect(realGit.calls).toEqual([]);
	});
});

describe("withoutDeclaredFamilies (#3902)", () => {
	const FAMILIES = ["read-guard", "session-lifecycle"];

	it("drops the family token of a declaration and keeps its reason", () => {
		expect(
			withoutDeclaredFamilies(
				"- **TLA+ unaffected: read-guard — emits `tool-cwd-resolution`.",
				FAMILIES,
			),
		).toBe("- **TLA+ unaffected:  — emits `tool-cwd-resolution`.");
		expect(
			withoutDeclaredFamilies(
				"TLA+ unaffected: read-guard — a.\nSee read-guard and `kind-one`.",
				FAMILIES,
			),
		).toBe("TLA+ unaffected:  — a.\nSee read-guard and `kind-one`.");
	});

	// F1 (#3902 review, round 1): only a known family is a declared slot. A
	// malformed declaration, or a token that merely starts with a family name,
	// keeps its token so the #4597 read-back still sees it.
	it("keeps the token of a declaration that names no known family", () => {
		expect(
			withoutDeclaredFamilies("TLA+ unaffected: probe-kind-3902", FAMILIES),
		).toBe("TLA+ unaffected: probe-kind-3902");
		expect(
			withoutDeclaredFamilies("TLA+ unaffected: read-guard-foo — a.", FAMILIES),
		).toBe("TLA+ unaffected: read-guard-foo — a.");
	});
});

describe("lintTlaCoverage seam (#3802)", () => {
	// Recurrence: the Mutation diff of #3864 showed the empty-diff guard, the
	// map-unavailable error and the local advisory print survived neutering --
	// no test reached them, so a missing map or a dropped note passed silently.
	const missingRoot = path.join(os.tmpdir(), "pi-lens-tla-no-map-root");

	it("returns nothing for an empty diff, even with an unreadable map", () => {
		expect(lintTlaCoverage("", { diff: "", cwd: missingRoot })).toEqual({
			errors: [],
			advisories: [],
		});
		expect(lintTlaCoverage()).toEqual({ errors: [], advisories: [] });
	});

	it("reports an unreadable map as one lint error, never a pass", () => {
		expect(
			lintTlaCoverage("", { diff: READ_GUARD_DIFF, cwd: missingRoot }),
		).toEqual({
			errors: [
				expect.stringMatching(
					/^TLA\+ coverage map unavailable: cannot read formal\/coverage-map\.json: /,
				),
			],
			advisories: [],
		});
	});

	it("prints a hub-row note through the local lint without failing it", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const git = (args: string[]) =>
				args.includes("--name-only")
					? "clients/lsp/client.ts\n"
					: [
							"diff --git a/clients/lsp/client.ts b/clients/lsp/client.ts",
							"@@ -1,0 +1,1 @@",
							"+// touched",
						].join("\n");
			lintLocalPrBody(BASE_BODY, REPO_ROOT, git as never);
			expect(warn.mock.calls.flat().join("\n")).toContain(
				"TLA+ note: clients/lsp/client.ts",
			);
			expect(realGit.calls).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});
});

// #3906 AC2: the #3799 delivery decision in clients/dispatch/dispatcher.ts is a
// lifecycle/delivery seam the seam record rule gates. #4484 modelled the
// file's delta split (formal/blocker-pending), so the row now names that
// family and gates on the TLA axis; the coverage notice stays unmodelled and
// its note says so. The #3799 corpus that exercises the refusal is in
// tests/scripts/check-pr-body.test.ts.
describe("dispatcher seam row (#3906 AC2, #4484)", () => {
	it("maps clients/dispatch/dispatcher.ts to blocker-pending and names the unmodelled coverage notice", () => {
		expect(map.map?.["clients/dispatch/dispatcher.ts"]).toEqual([
			"blocker-pending",
		]);
		const reason = map.notes?.["clients/dispatch/dispatcher.ts"];
		expect(typeof reason).toBe("string");
		expect(reason).toContain("filterDelta");
		expect(reason).toContain("buildCoverageNotice");
		expect(reason).toMatch(/no formal family|unmodelled/i);
	});

	it("removes dispatch/dispatcher from the unlisted note but keeps its siblings", () => {
		const unlisted = String(map.notes?.unlisted ?? "");
		expect(unlisted).not.toContain("dispatch/dispatcher");
		expect(unlisted).toContain("dispatch/types");
		expect(unlisted).toContain("dispatch/utils/format-utils");
	});

	// Recurrence: #4484. The delta split decided what a blocker record keeps,
	// and no model saw it; a dispatcher change that moves the split must now
	// touch the family or say why it is unaffected.
	it("gates a dispatcher change on the blocker-pending family", () => {
		const bare = evaluateTlaCoverage({
			map,
			changedFiles: ["clients/dispatch/dispatcher.ts"],
			body: "",
		});
		expect(bare.errors).toHaveLength(1);
		expect(bare.errors[0]).toContain("TLA+ unaffected: blocker-pending");
		const withModel = evaluateTlaCoverage({
			map,
			changedFiles: [
				"clients/dispatch/dispatcher.ts",
				"formal/blocker-pending/ClearOnCurrent.cfg",
			],
			body: "",
		});
		expect(withModel.errors).toEqual([]);
	});
});

// #3803 F4 / #3878: index.ts holds every lifecycle hook handler, so its map row
// is judged per hook, from the handler a changed hunk lands in. `git diff
// --unified=0` (the lint's diff) carries no hook name for a hunk inside a
// handler, so the first version of this row matched the hook word in the
// changed line itself and fired for 0 of the last 25 index.ts commits while 19
// of them edited a handler; the hub note it replaced was silent for all 19.
const INDEX_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "index.ts"), "utf8");
const INDEX_ROW = map.map?.["index.ts"] as {
	families: string[];
	anchors: Record<string, string[]>;
};
const HOOKS = Object.keys(INDEX_ROW.anchors);

// A U0 diff that rewrites post-image line `line` of index.ts, as git prints it.
function indexLineDiff(source: string, line: number) {
	const text = source.split("\n")[line - 1];
	return [
		"diff --git a/index.ts b/index.ts",
		`@@ -${line} +${line} @@`,
		"-// old",
		`+${text}`,
	].join("\n");
}

function indexErrors(diff: string, source: string, body = "") {
	return lintTlaCoverage(body, {
		diff,
		headFiles: new Map([["index.ts", source]]),
	});
}

describe("index.ts hook anchors (#3878)", () => {
	// Recurrence: a hook list kept both in the map keys and in a regex drifted
	// (agent_end was in neither), and an anchor key the file never registers
	// would never fire. The registered hooks are read from the file.
	it("finds a handler range for every anchored hook and no other lifecycle hook", () => {
		const ranges = findHookRanges(INDEX_SOURCE);
		const lines = INDEX_SOURCE.split("\n");
		for (const hook of HOOKS) expect(ranges.has(hook), hook).toBe(true);
		expect([...ranges.keys()].sort()).toEqual(
			[...HOOKS, "resources_discover"].sort(),
		);
		// A range starts at the registration or at a named handler the
		// registration passes by identifier (`wrapSessionEventHandler("turn_end",
		// onTurnEnd, ...)`), never at anything else: an inline handler's body
		// arguments are not handlers.
		const starts = (hook: string) =>
			(ranges.get(hook) ?? []).map(([start]) =>
				lines[start - 1]
					.trim()
					.replace(/^(\(pi as any\)|pi)\.on\(.*/, "on")
					.replace(/^const (\w+) =.*/, "$1"),
			);
		expect(
			Object.fromEntries(HOOKS.map((hook) => [hook, starts(hook)])),
		).toEqual({
			session_start: ["on"],
			session_shutdown: ["on"],
			session_tree: ["on"],
			turn_start: ["on", "onTurnStart"],
			turn_end: ["on", "onTurnEnd"],
			agent_end: ["on", "onAgentEnd"],
			agent_settled: ["on", "onAgentSettled"],
			tool_call: ["on"],
			tool_result: ["on", "onToolResult"],
			tool_execution_end: ["on"],
			context: ["on"],
			// #4631: the pi 0.87+ request hook, an inline registration like `context`.
			context_with_system: ["on"],
			// #4687: the model-switch re-plan of the lazy-tools posture.
			model_select: ["on"],
		});
	});

	it.each(HOOKS)(
		"fires %s for an edit to the first body line of its handler",
		(hook) => {
			const ranges = findHookRanges(INDEX_SOURCE).get(hook) ?? [];
			// The widest range is the handler body (or the inline handler).
			const [start, end] = [...ranges].sort(
				(a, b) => b[1] - b[0] - (a[1] - a[0]),
			)[0];
			const result = indexErrors(
				indexLineDiff(INDEX_SOURCE, Math.min(start + 2, end)),
				INDEX_SOURCE,
			);
			expect(result.errors).toHaveLength(1);
			for (const family of INDEX_ROW.anchors[hook])
				expect(result.errors[0], family).toContain(`formal/${family}/`);
			expect(result.advisories).toEqual([]);
		},
	);

	it("restores format-drain on index.ts through the agent_end anchor", () => {
		// Recurrence: the first anchor table dropped format-drain's index.ts link
		// (the old 7-family row named it) and had no agent_end anchor.
		expect(INDEX_ROW.anchors.agent_end).toContain("format-drain");
		const ranges = findHookRanges(INDEX_SOURCE).get("agent_end") ?? [];
		const body = ranges.find(([start, end]) => end - start > 5);
		expect(body).toBeDefined();
		const result = indexErrors(
			indexLineDiff(INDEX_SOURCE, (body as [number, number])[0] + 1),
			INDEX_SOURCE,
			"TLA+ unaffected: format-drain — the drain order is unchanged.",
		);
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("prints a note, not an error, for an edit outside every handler", () => {
		const lines = INDEX_SOURCE.split("\n");
		const importLine =
			lines.findIndex((line) => line.startsWith("import ")) + 1;
		const result = indexErrors(
			indexLineDiff(INDEX_SOURCE, importLine),
			INDEX_SOURCE,
		);
		expect(result.errors).toEqual([]);
		expect(result.advisories).toEqual([
			expect.stringContaining("index.ts changed outside its lifecycle hook"),
		]);
	});

	it("counts every hook as changed when the post-image cannot place the hunk", () => {
		// Direction chosen from the user-facing harm: a lint that cannot read the
		// image asks for one any-of declaration; silence would pass a handler edit.
		const drifted = INDEX_SOURCE.replace("import ", "import  ");
		const diff = indexLineDiff(INDEX_SOURCE, 1);
		const result = lintTlaCoverage("", {
			diff,
			headFiles: new Map([["index.ts", drifted]]),
		});
		expect(result.errors).toHaveLength(1);
		expect(result.advisories).toEqual([
			expect.stringContaining("could not be read against the diff"),
		]);
		const unreadable = lintTlaCoverage("", { diff, sourceCwd: "/nonexistent" });
		expect(unreadable.errors).toHaveLength(1);
		expect(
			changedHookAnchors(INDEX_SOURCE, parseRuntimeHunks(diff)[0], HOOKS),
		).not.toBeNull();
	});

	it("places a pure deletion by the post-image line it follows", () => {
		// Recurrence: under --unified=0 a deletion has no added line, so a matcher
		// that reads only added lines never sees a block removed from a handler.
		const turnEndRange = findHookRanges(INDEX_SOURCE)
			.get("turn_end")
			?.find(([from, to]) => to - from > 5);
		expect(turnEndRange).toBeDefined();
		const [start, end] = turnEndRange ?? [0, 0];
		const deletion = (after: number) =>
			[
				"diff --git a/index.ts b/index.ts",
				`@@ -${after + 1} +${after},0 @@`,
				"-// removed",
			].join("\n");
		const inside = indexErrors(deletion(start + 3), INDEX_SOURCE);
		expect(inside.errors).toEqual([
			expect.stringContaining("formal/late-aux-drain/"),
		]);
		const importLine = INDEX_SOURCE.split("\n").findIndex((line) =>
			line.startsWith("import "),
		);
		expect(indexErrors(deletion(importLine + 1), INDEX_SOURCE).errors).toEqual(
			[],
		);
		expect(end).toBeGreaterThan(start);
	});

	it("gates a diff that fires two hooks on the union of their families", () => {
		// Recurrence: a fired anchored row must never fall into the 4+ family hub
		// note; session_start + turn_end reach 5 families and still gate.
		const ranges = findHookRanges(INDEX_SOURCE);
		const bodyLine = (hook: string) => {
			const [start] = (ranges.get(hook) ?? []).find(
				([from, to]) => to - from > 5,
			) as [number, number];
			return start + 2;
		};
		const diff = [
			indexLineDiff(INDEX_SOURCE, bodyLine("session_start")),
			...indexLineDiff(INDEX_SOURCE, bodyLine("turn_end")).split("\n").slice(1),
		].join("\n");
		const result = indexErrors(diff, INDEX_SOURCE);
		expect(result.advisories).toEqual([]);
		expect(result.errors).toHaveLength(1);
		for (const family of [
			"session-registry",
			"late-aux-drain",
			"dispatch-pipeline",
		])
			expect(result.errors[0]).toContain(`formal/${family}/`);
	});

	describe("hunk placement", () => {
		const ranges = new Map([["turn_end", [[10, 20]]]]) as never;
		const hunk = (
			added: number[],
			deletedAfter: number[],
			removed: string[] = [],
		) => ({
			added: new Map(added.map((line) => [line, "x"])),
			deletedAfter: new Set(deletedAfter),
			removed,
		});
		const fires = (...args: Parameters<typeof hunk>) =>
			hookAnchorsFromRanges(ranges, hunk(...args), ["turn_end"]).length === 1;

		it("fires on an added line at either end and not one past it", () => {
			expect([9, 10, 20, 21].map((line) => fires([line], []))).toEqual([
				false,
				true,
				true,
				false,
			]);
		});

		it("fires on a deletion strictly inside the range only", () => {
			// A deletion after post line N sits between N and N+1.
			expect([9, 10, 19, 20].map((line) => fires([], [line]))).toEqual([
				false,
				true,
				true,
				false,
			]);
		});

		it("fires on a removed or added registration line", () => {
			expect(fires([], [3], ['\tpi.on("turn_end", wrap(onTurnEnd));'])).toBe(
				true,
			);
			expect(fires([], [3], ['\t\t"turn_end",'])).toBe(true);
			expect(
				fires([], [3], ['\tpi.on("turn_start", wrap(onTurnStart));']),
			).toBe(false);
		});
	});

	describe("replay of the last 25 index.ts commits", () => {
		const replay = JSON.parse(
			fs.readFileSync(
				path.join(
					REPO_ROOT,
					"tests/fixtures/tla-hook-anchors/index-ts-replay.json",
				),
				"utf8",
			),
		) as {
			commits: {
				sha: string;
				diff: string;
				ranges: Record<string, [number, number][]>;
				expected: string[];
			}[];
		};

		it("fires on the lifecycle-handler commits and notes the rest", () => {
			const hits = replay.commits.map((commit) =>
				hookAnchorsFromRanges(
					new Map(Object.entries(commit.ranges)),
					parseRuntimeHunks(commit.diff)[0],
					HOOKS,
				).sort(),
			);
			expect(replay.commits).toHaveLength(25);
			expect(hits).toEqual(replay.commits.map((commit) => commit.expected));
			// 0 of 25 on ff1b0ce1f (the word match), 19 here.
			expect(hits.filter((hook) => hook.length).length).toBe(19);
		});

		it("gates a real turn_end handler diff end to end, and a declaration clears it", () => {
			const commit = replay.commits.find((entry) =>
				entry.sha.startsWith("2e4848dd5"),
			);
			const source = fs.readFileSync(
				path.join(
					REPO_ROOT,
					"tests/fixtures/tla-hook-anchors/index-ts-2e4848dd5.txt",
				),
				"utf8",
			);
			const result = indexErrors(commit?.diff ?? "", source);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toContain("formal/late-aux-drain/");
			expect(result.errors[0]).not.toContain("formal/session-registry/");
			expect(
				indexErrors(
					commit?.diff ?? "",
					source,
					"TLA+ unaffected: late-aux-drain — the cadence is paced per session turn.",
				).errors,
			).toEqual([]);
			const git = (args: string[]) =>
				args.includes("--name-only") ? "index.ts\n" : (commit?.diff ?? "");
			const local = lintLocalPrBody(BASE_BODY, REPO_ROOT, git as never, {
				headFiles: new Map([["index.ts", source]]),
			});
			expect(local.errors.join(" ")).toContain("formal/late-aux-drain/");
		});
	});
});

describe("hub rows without anchors stay advisory (#3802 hub threshold)", () => {
	// Recurrence: dropping the 4-family threshold turned the hub rows of
	// runtime-tool-result (6 families), runtime-coordinator (4), lsp/index (6) and
	// lsp/client (5) from a note into a gate for every PR that touches them.
	const hubs = Object.entries(map.map ?? {}).filter(
		([, value]) => Array.isArray(value) && value.length >= 4,
	);

	it.each(hubs.map(([glob]) => [glob]))(
		"%s prints the hub note and never fails an empty body",
		(glob) => {
			const result = evaluateTlaCoverage({
				map,
				changedFiles: [glob],
				body: "",
			});
			expect(result.errors).toEqual([]);
			expect(result.advisories).toEqual([
				expect.stringContaining(`TLA+ note: ${glob} maps to`),
			]);
		},
	);
});

describe("validateCoverageMap anchors (#3878 F11)", () => {
	let root: string | undefined;
	afterEach(() => {
		if (root) fs.rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function anchoredTree() {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-tla-anchors-"));
		fs.writeFileSync(
			path.join(root, "host.ts"),
			'pi.on("turn_end", wrap(handler));\n',
		);
		for (const dir of ["fam-a", "fam-b"]) {
			fs.mkdirSync(path.join(root, "formal", dir), { recursive: true });
			fs.writeFileSync(path.join(root, "formal", dir, "M.cfg"), "");
		}
		return root;
	}

	const row = (anchors: Record<string, string[]>) => ({
		families: ["fam-a", "fam-b"],
		map: { "host.ts": { families: ["fam-a"], anchors } },
	});

	it("accepts anchors that name a registered hook and a subset of the row's families", () => {
		expect(
			validateCoverageMap(row({ turn_end: ["fam-a"] }), anchoredTree()),
		).toEqual([]);
	});

	it.each([
		[
			"a hook the file never registers",
			{ session_start: ["fam-a"] },
			"is not registered",
		],
		[
			"a family outside the row",
			{ turn_end: ["fam-b"] },
			"not in the row's families",
		],
		[
			"an empty family list",
			{ turn_end: [] },
			"needs a non-empty family array",
		],
		[
			"a key that is not a hook name",
			{ "turn-end": ["fam-a"] },
			"is not a hook name",
		],
	])("rejects %s", (_label, anchors, message) => {
		const errors = validateCoverageMap(
			{ ...row(anchors), families: ["fam-a", "fam-b"] },
			anchoredTree(),
		);
		expect(errors).toEqual([expect.stringContaining(message)]);
	});
});

describe("map file hygiene (#3803 F4 F7)", () => {
	// Recurrence: JSON.parse keeps the last of two equal keys, so `notes."index.ts"`
	// was written twice and the first note was dead text no test could see.
	it("has no duplicate key in the map or notes objects", () => {
		const raw = fs.readFileSync(
			path.join(REPO_ROOT, "formal/coverage-map.json"),
			"utf8",
		);
		const [head, notes] = raw.split(/^ {2}"notes": \{/m);
		const keys = (text: string) =>
			[...text.matchAll(/^ {4},?"([^"]+)": /gm)].map((match) => match[1]);
		for (const section of [head, notes]) {
			const found = keys(section);
			expect(found.length).toBeGreaterThan(10);
			expect(found.filter((key, at) => found.indexOf(key) !== at)).toEqual([]);
		}
	});
});

/**
 * #4828: every census that walks the repo tree carries a timeout
 * budget. #4967: the census covers all of `tests/`; a member outside
 * `tests/config` that predates the widening is admitted by identity in
 * `tests/config/tree-census-timeout.baseline.json`, and no other member is.
 * A census declared with vitest's 5 s default reds on the Windows unit
 * leg (`Unit tests Windows`): the walk costs several times its Linux time
 * there (the 2026-10-24 #4823 run timed out `pi-mock-importer-sweep` at
 * 5000 ms, whose Linux time is 711 ms).
 *
 * A census is a test whose callback walks the tree, or reads a binding that a
 * walk produced at module or describe scope (a suite-level `files` list is a
 * walk even though the callback never names the walker), or an `it.each` /
 * `it.for` over such a table. The gate enforces one rule on every census: its
 * third argument is an identifier named `TREE_WALK_TIMEOUT_MS`
 * (the shared constant in `tests/support/test-timeout-scale.ts`; the gate reads
 * the name, not the binding), or a `scaledTestTimeout(...)` call
 * for a census that needs more than the shared ceiling (name the reason in a
 * comment; the gate does not read it). The default two arguments, a raw number, a
 * file-local constant, an options object or any other expression is refused,
 * because only the scaled forms follow the lane's `PI_LENS_TEST_TIMEOUT_SCALE`.
 *
 * The detector admits known-good forms and refuses the rest (AGENTS.md shape
 * 69, shape 85). It reads the parsed AST, so a name in a comment, a title or
 * an expectation makes nothing.
 *
 * - Test declaration: a call whose callee chain starts at a binding of
 *   vitest's `it` or `test` (derived from the file's `import ... from
 *   "vitest"` specifiers, aliases and a namespace import included), through
 *   any member, string-subscript or call segments (`.only`, `.skipIf(c)`,
 *   `.each(table)`).
 * - Unclassified test callee: a call at module or describe scope whose second
 *   argument is a function that walks the tree and whose callee root is
 *   neither a declaration nor a vitest suite. It is a census too, so a
 *   wrapper, an `it.extend` alias or an un-imported `it` is refused rather
 *   than skipped.
 * - Walker: a call whose callee is a binding of `listSourceFiles`,
 *   `censusSourceFiles` or `listTrackedFiles` (import aliases, `const`
 *   aliases and destructured renames included) or a member call of one of
 *   those names, plus a recognised spawn call (`gitExecFileSync`,
 *   `execFileSync`, `execFile`, `execSync`, `spawnSync`, `spawn`, aliases
 *   included) given `ls-files` as a string, an array element, or a binding
 *   of either.
 *
 * Not read (accepted residual, backstop `Unit tests Windows`, which reds on the
 * first census that times out there): a walker reached only through a helper in
 * another module (measured 2026-10-30 with 11 helper names taken as walkers: 83
 * members in 13 files, 22 of them in tests/config; a follow-up owns them); a
 * recursive walker spelled as a variable-bound arrow function; a walker or spawner
 * reached through a local wrapper function; and a walk named by an enclosing
 * `describe.each` table or `for...of` loop instead of by the case. The budget
 * is admitted by name, not by binding (accepted residual, live population 0
 * each way): a same-named local `const TREE_WALK_TIMEOUT_MS = 5000` is
 * admitted, and an import alias of the shared constant is refused.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SgNode } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { parseRoot } from "../support/ast-census.js";
import {
	assertNonEmptyScan,
	assertSortedRegistry,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TESTS_DIR = path.join(ROOT, "tests");
/** #4967: the admitted members outside `tests/config`, one row per identity. */
const BASELINE_PATH = path.join(
	ROOT,
	"tests",
	"config",
	"tree-census-timeout.baseline.json",
);

const WALKERS = new Set([
	"listSourceFiles",
	"censusSourceFiles",
	"listTrackedFiles",
]);
const SPAWNERS = new Set([
	"gitExecFileSync",
	"execFileSync",
	"execFile",
	"execSync",
	"spawnSync",
	"spawn",
]);
const DECLARATIONS = new Set(["it", "test"]);
const SUITES = new Set(["describe", "suite"]);
const TABLE_MODIFIERS = new Set(["each", "for"]);
const FUNCTION_KINDS = new Set<string>([
	"arrow_function",
	"function_expression",
	"function",
]);

/** The names one file binds, derived from its imports and aliases. */
interface Scope {
	/** Local names bound to vitest's `it` / `test`. */
	declarations: Set<string>;
	/** Local names bound to vitest's `describe` / `suite`. */
	suites: Set<string>;
	/** Local names bound to the whole vitest namespace (`import * as v`). */
	namespaces: Set<string>;
	/** Local names that call a whole-tree walker. */
	walkers: Set<string>;
	/** Local names that spawn a process. */
	spawners: Set<string>;
	/** Bindings whose value mentions `ls-files` (an array or a string). */
	lsFiles: Set<string>;
}

function namedArgs(call: SgNode): SgNode[] {
	const args = call.field("arguments");
	if (!args) return [];
	const named = args.children().filter((node) => node.isNamed());
	return named.filter((node) => node.kind() !== "comment");
}

function unquote(text: string): string {
	return text.replace(/^["'`]|["'`]$/g, "");
}

/** Does this node (or a segment of it) name `ls-files`? */
function mentionsLsFiles(node: SgNode, scope: Scope): boolean {
	if (node.kind() === "identifier") return scope.lsFiles.has(node.text());
	if (node.kind() === "string") return /\bls-files\b/.test(node.text());
	if (node.kind() !== "array") return false;
	return node
		.findAll({ rule: { kind: "string" } })
		.some((text) => /\bls-files\b/.test(text.text()));
}

/** Build the per-file name table from its imports and aliases. */
function scopeOf(root: SgNode): Scope {
	const scope: Scope = {
		declarations: new Set(),
		suites: new Set(),
		namespaces: new Set(),
		walkers: new Set(WALKERS),
		spawners: new Set(SPAWNERS),
		lsFiles: new Set(),
	};
	for (const statement of root.findAll({
		rule: { kind: "import_statement" },
	})) {
		const vitest =
			unquote(statement.field("source")?.text() ?? "") === "vitest";
		for (const specifier of statement.findAll({
			rule: { kind: "import_specifier" },
		})) {
			const name = specifier.field("name")?.text() ?? "";
			const local = specifier.field("alias")?.text() ?? name;
			if (vitest && DECLARATIONS.has(name)) scope.declarations.add(local);
			if (vitest && SUITES.has(name)) scope.suites.add(local);
			if (WALKERS.has(name)) scope.walkers.add(local);
			if (SPAWNERS.has(name)) scope.spawners.add(local);
		}
		if (vitest) {
			for (const space of statement.findAll({
				rule: { kind: "namespace_import" },
			})) {
				const local = space.find({ rule: { kind: "identifier" } })?.text();
				if (local) scope.namespaces.add(local);
			}
		}
	}
	const declarators = root.findAll({ rule: { kind: "variable_declarator" } });
	let grown = true;
	while (grown) {
		grown = false;
		for (const declarator of declarators) {
			const name = declarator.field("name");
			const value = declarator.field("value");
			if (!name || !value) continue;
			const add = (set: Set<string>, local: string) => {
				if (local && !set.has(local)) {
					set.add(local);
					grown = true;
				}
			};
			if (name.kind() === "identifier") {
				if (walkerRef(value, scope)) add(scope.walkers, name.text());
				if (spawnerRef(value, scope)) add(scope.spawners, name.text());
				if (mentionsLsFiles(value, scope)) add(scope.lsFiles, name.text());
			} else if (name.kind() === "object_pattern") {
				// `const { listSourceFiles: walk } = kit;`
				for (const pair of name.findAll({ rule: { kind: "pair_pattern" } })) {
					const key = unquote(pair.field("key")?.text() ?? "");
					const local = pair.field("value")?.text() ?? "";
					if (WALKERS.has(key)) add(scope.walkers, local);
					if (SPAWNERS.has(key)) add(scope.spawners, local);
				}
			}
		}
	}
	return scope;
}

/** The property name of `obj.name` or `obj["name"]`, else undefined. */
function propertyName(node: SgNode): string | undefined {
	if (node.kind() === "member_expression")
		return node.field("property")?.text();
	if (node.kind() === "subscript_expression") {
		const index = node.field("index");
		return index?.kind() === "string" ? unquote(index.text()) : undefined;
	}
	return undefined;
}

/** Is this expression a reference to a walker (a binding or a member)? */
function walkerRef(node: SgNode, scope: Scope): boolean {
	if (node.kind() === "identifier") return scope.walkers.has(node.text());
	const property = propertyName(node);
	return property !== undefined && WALKERS.has(property);
}

function spawnerRef(node: SgNode, scope: Scope): boolean {
	if (node.kind() === "identifier") return scope.spawners.has(node.text());
	const property = propertyName(node);
	return property !== undefined && SPAWNERS.has(property);
}

/**
 * The root a callee chain starts at: `it` for `it.skipIf(c).each(t)`, a
 * `vitest:it` for the namespaced `v.it`, undefined for a chain that does not
 * start at a name (`(a ? b : c)(...)`).
 */
function rootOf(node: SgNode, scope: Scope): string | undefined {
	switch (node.kind()) {
		case "identifier":
			return node.text();
		case "call_expression": {
			const fn = node.field("function");
			return fn ? rootOf(fn, scope) : undefined;
		}
		case "member_expression":
		case "subscript_expression": {
			const object = node.field("object");
			if (!object) return undefined;
			if (object.kind() === "identifier" && scope.namespaces.has(object.text()))
				return `vitest:${propertyName(node) ?? ""}`;
			return rootOf(object, scope);
		}
		default:
			return undefined;
	}
}

function isDeclarationRoot(root: string | undefined, scope: Scope): boolean {
	if (root === undefined) return false;
	if (root.startsWith("vitest:")) return DECLARATIONS.has(root.slice(7));
	return scope.declarations.has(root);
}

function isSuiteRoot(root: string | undefined, scope: Scope): boolean {
	if (root === undefined) return false;
	if (root.startsWith("vitest:")) return SUITES.has(root.slice(7));
	return scope.suites.has(root);
}

/** The table argument lists of every `.each(...)` / `.for(...)` in a chain. */
function tableArguments(callee: SgNode): SgNode[] {
	const tables: SgNode[] = [];
	let node: SgNode | null = callee;
	while (node) {
		if (node.kind() === "call_expression") {
			const fn: SgNode | null = node.field("function");
			const modifier = fn ? propertyName(fn) : undefined;
			const args = node.field("arguments");
			if (modifier !== undefined && TABLE_MODIFIERS.has(modifier) && args)
				tables.push(args);
			node = fn ?? null;
		} else if (
			node.kind() === "member_expression" ||
			node.kind() === "subscript_expression"
		) {
			node = node.field("object");
		} else node = null;
	}
	return tables;
}

/** Module scope, or the body of a `describe` callback. */
function atSuiteScope(node: SgNode, scope: Scope): boolean {
	let owner = node.parent();
	while (owner) {
		if (
			owner.kind() === "arrow_function" ||
			owner.kind() === "function_expression" ||
			owner.kind() === "function_declaration"
		) {
			const call = owner.parent()?.parent();
			const fn = call?.kind() === "call_expression" && call.field("function");
			return !!fn && isSuiteRoot(rootOf(fn, scope), scope);
		}
		owner = owner.parent();
	}
	return true;
}

/**
 * A directory walk that recurses: a function that reads a directory and calls a
 * function declared inside it (the shape of `git-fixture-governance`'s
 * `walkFiles`, whose nested `walk` descends into itself). A loop over one
 * directory's entries is not a tree walk.
 */
function recursiveDirectoryWalk(node: SgNode): boolean {
	if (node.kind() !== "function_declaration") return false;
	const declared = new Set(
		node
			.findAll({ rule: { kind: "function_declaration" } })
			.map((fn) => fn.field("name")?.text() ?? ""),
	);
	const calls = node.findAll({ rule: { kind: "call_expression" } });
	const readsDirectory = calls.some((call) =>
		/(^|\.)readdir(Sync)?$/.test(
			(call.field("function")?.text() ?? "").replace(/\s/g, ""),
		),
	);
	const descends = calls.some((call) =>
		declared.has(call.field("function")?.text() ?? ""),
	);
	return readsDirectory && descends;
}

/** Does this subtree call a whole-tree walker, or spawn `git ls-files`? */
function walksTree(node: SgNode, scope: Scope): boolean {
	const calls = node.findAll({ rule: { kind: "call_expression" } });
	return (
		calls.some((call) => {
			const fn = call.field("function");
			if (!fn) return false;
			if (walkerRef(fn, scope)) return true;
			// `git ls-files` only as an argument of a recognised spawn call, never
			// as a literal in an expectation or a fixture.
			return (
				spawnerRef(fn, scope) &&
				namedArgs(call).some((arg) => mentionsLsFiles(arg, scope))
			);
		}) || recursiveDirectoryWalk(node)
	);
}

/**
 * The only third arguments the gate admits: the shared constant, or a call to
 * `scaledTestTimeout(...)` for a census that truly needs more than the shared
 * ceiling (the call site names the reason in a comment). A raw number, a
 * file-local constant, an options object or any other expression is refused,
 * because only the scaled forms follow the lane's `PI_LENS_TEST_TIMEOUT_SCALE`.
 */
function admittedBudget(node: SgNode | undefined): boolean {
	if (!node) return false;
	if (node.kind() === "identifier")
		return node.text() === "TREE_WALK_TIMEOUT_MS";
	if (node.kind() !== "call_expression") return false;
	return node.field("function")?.text() === "scaledTestTimeout";
}

interface Census {
	title: string;
	argCount: number;
	/** The census has no third argument (the default budget) or one that is
	 *  not an admitted scaled budget. */
	refused: boolean;
	/** `declaration`, or `unclassified` for a test-shaped call the detector
	 *  could not trace to a vitest `it`/`test` binding. */
	how: "declaration" | "unclassified";
}

/** Every census declaration in one test file's source (one parse). */
function censuses(source: string): Census[] {
	const root = parseRoot(source);
	const scope = scopeOf(root);
	// A suite-scope binding is a walk when its initializer walks, or reads a walk
	// binding (`const walked = files.map(...)`); iterate to a fixed point. A
	// local in a case or a helper is not the census.
	const decls = root
		.findAll({
			rule: {
				any: [
					{ kind: "variable_declarator" },
					{ kind: "function_declaration" },
				],
			},
		})
		.filter((decl) => atSuiteScope(decl, scope))
		.map((decl) => ({ name: decl.field("name")?.text() ?? "", decl }))
		.filter((entry) => entry.name !== "");
	const walked = new Set<string>();
	let grown = true;
	while (grown) {
		grown = false;
		for (const { name, decl } of decls) {
			if (walked.has(name)) continue;
			const reads = decl
				.findAll({ rule: { kind: "identifier" } })
				.some((id) => walked.has(id.text()));
			if (walksTree(decl, scope) || reads) {
				walked.add(name);
				grown = true;
			}
		}
	}
	const walks = (node: SgNode) =>
		walksTree(node, scope) ||
		node
			.findAll({ rule: { kind: "identifier" } })
			.some((id) => walked.has(id.text()));
	const found: Census[] = [];
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function");
		if (!callee) continue;
		const args = namedArgs(call);
		if (args.length < 2) continue;
		const calleeRoot = rootOf(callee, scope);
		const body = args[1];
		if (isDeclarationRoot(calleeRoot, scope)) {
			// `it.each(table)(title, fn)`: the table is walked even when the case
			// never names it (its rows are the walked population).
			if (walks(body) || tableArguments(callee).some(walks))
				found.push({
					title: args[0].text(),
					argCount: args.length,
					refused: !admittedBudget(args[2]),
					how: "declaration",
				});
			continue;
		}
		// Fail closed: a test-shaped call the detector cannot trace to a vitest
		// binding that walks the tree is a census, not a skip.
		if (
			!isSuiteRoot(calleeRoot, scope) &&
			FUNCTION_KINDS.has(String(body.kind())) &&
			atSuiteScope(call, scope) &&
			walks(body)
		)
			found.push({
				title: args[0].text(),
				argCount: args.length,
				refused: !admittedBudget(args[2]),
				how: "unclassified",
			});
	}
	return found;
}

/** One admitted census member (#4967): its test file and case title as written. */
interface BaselineRow {
	file: string;
	title: string;
	reason: string;
}

/**
 * #4967: the census verdict for one scan. A refused member is admitted only
 * when a baseline row names its identity, `file: title`. `unadmitted`: a refused
 * member no row names. `stale`: a row no refused member matches, so a fixed or
 * deleted member drops its row. `duplicated`: an identity two refused members
 * share, which one row would admit twice (AGENTS.md shape 36: match identity,
 * never a count). `unreasoned`: a row with a blank reason (shape 38).
 */
function admissionVerdict(
	refused: readonly string[],
	rows: readonly BaselineRow[],
) {
	const keys = rows.map((row) => `${row.file}: ${row.title}`);
	assertSortedRegistry("tree census baseline", keys);
	const admitted = new Set(keys);
	const found = new Set(refused);
	return {
		unadmitted: refused.filter((key) => !admitted.has(key)),
		stale: keys.filter((key) => !found.has(key)),
		duplicated: refused.filter((key, index) => refused.indexOf(key) !== index),
		unreasoned: rows
			.filter((row) => row.reason.trim() === "")
			.map((row) => `${row.file}: ${row.title}`),
	};
}

/** One file's census count and the censuses whose budget the gate refuses. */
function flagCensuses(
	rel: string,
	source: string,
): { census: number; flagged: string[] } {
	const found = censuses(source);
	return {
		census: found.length,
		flagged: found
			.filter((entry) => entry.refused)
			.map((entry) => `${rel}: ${entry.title}`),
	};
}

describe("tree census timeout (#4828)", () => {
	// Recurrence (#4828 review r1 F1, F6): the first detector listed `it.each`
	// and an array-element `ls-files`, so an `it.skipIf` census, an aliased
	// walker and an `it.each` over a walked table were not seen, and an
	// `expect(["ls-files"])` fixture was read as a walk.
	const defaultBudget = (source: string) =>
		censuses(source)
			.filter((census) => census.refused)
			.map((census) => census.title);
	const VITEST = 'import { it, test, describe } from "vitest";\n';
	const KIT = 'import { listSourceFiles } from "../support/sweep-kit.js";\n';

	it("plants: refuses a default-budget walk and admits a budgeted one, a binding walk, and prose", () => {
		// #4828: the four members were red on Windows with the default 5 s budget.
		expect(
			defaultBudget(`${VITEST}it("direct", () => { listSourceFiles(ROOT); });`),
		).toEqual(['"direct"']);
		expect(
			defaultBudget(
				`${VITEST}const files = listSourceFiles(ROOT);\nit("via binding", () => { expect(files.length).toBeGreaterThan(0); });`,
			),
		).toEqual(['"via binding"']);
		expect(
			defaultBudget(
				`${VITEST}it("budgeted", () => { listSourceFiles(ROOT); }, TREE_WALK_TIMEOUT_MS);`,
			),
		).toEqual([]);
		expect(
			defaultBudget(
				`${VITEST}it("prose", () => { /* listSourceFiles(ROOT) */ const s = "git ls-files"; expect(s).toBe("x"); });`,
			),
		).toEqual([]);
	});

	it.each([
		["it.skipIf", 'it.skipIf(cond)("c", () => { listSourceFiles(ROOT); });'],
		["it.runIf", 'it.runIf(cond)("c", () => { listSourceFiles(ROOT); });'],
		[
			"test.skipIf",
			'test.skipIf(cond)("c", () => { listSourceFiles(ROOT); });',
		],
		["it.only", 'it.only("c", () => { listSourceFiles(ROOT); });'],
		[
			"it chained",
			'it.concurrent.only("c", () => { listSourceFiles(ROOT); });',
		],
		["it subscript", 'it["only"]("c", () => { listSourceFiles(ROOT); });'],
		[
			"it.each over an inline walk",
			'it.each(listSourceFiles(ROOT))("c", (file) => { expect(file).toBeTruthy(); });',
		],
		[
			"it.each over a walked table the body never names",
			'const table = listSourceFiles(ROOT);\nit.each(table)("c", (file) => { expect(file).toBeTruthy(); });',
		],
		[
			"it.skipIf then it.each over a walked table",
			'const table = listSourceFiles(ROOT);\nit.skipIf(cond).each(table)("c", (file) => { expect(file).toBeTruthy(); });',
		],
		[
			"an aliased vitest import",
			'import { it as check } from "vitest";\ncheck("c", () => { listSourceFiles(ROOT); });',
		],
		[
			"a namespace vitest import",
			'import * as v from "vitest";\nv.it.skipIf(cond)("c", () => { listSourceFiles(ROOT); });',
		],
		[
			"an unclassified test wrapper",
			'censusTest("c", () => { listSourceFiles(ROOT); });',
		],
		[
			"a walker alias import",
			'import { listSourceFiles as walkTree } from "../support/sweep-kit.js";\nit("c", () => { walkTree(ROOT); });',
		],
		[
			"a walker namespace member",
			'import * as kit from "../support/sweep-kit.js";\nit("c", () => { kit.listSourceFiles(ROOT); });',
		],
		[
			"a walker bound to a const",
			'const walk = listSourceFiles;\nit("c", () => { walk(ROOT); });',
		],
		[
			"a walker destructured under a new name",
			'import * as kit from "../support/sweep-kit.js";\nconst { listSourceFiles: walk } = kit;\nit("c", () => { walk(ROOT); });',
		],
		[
			"an aliased vitest import declared in a helper",
			'import { it as check } from "vitest";\nconst register = () => check("c", () => { listSourceFiles(ROOT); });',
		],
		[
			"a namespace vitest import declared in a helper",
			'import * as v from "vitest";\nconst register = () => v.it.skipIf(cond)("c", () => { listSourceFiles(ROOT); });',
		],
		[
			"it.for over a walked table",
			'const table = listSourceFiles(ROOT);\nit.for(table)("c", (file) => { expect(file).toBeTruthy(); });',
		],
		[
			"a git ls-files array bound before the spawn",
			'const args = ["ls-files", "-z"];\nit("c", () => { gitExecFileSync(bin, args); });',
		],
		["an ls-files command string", 'it("c", () => { execSync("ls-files"); });'],
		[
			"a recursive directory walk helper",
			'function walkFiles(dir) {\n\tconst out = [];\n\tfunction walk(current) {\n\t\tfor (const entry of readdirSync(current)) walk(entry);\n\t}\n\twalk(dir);\n\treturn out;\n}\nit("c", () => { walkFiles(ROOT); });',
		],
		[
			"a git ls-files spawn",
			'it("c", () => { gitExecFileSync(bin, ["ls-files", "-z"]); });',
		],
		[
			"a spawn bound to a const",
			'const run = execFileSync;\nit("c", () => { run(bin, ["ls-files"]); });',
		],
		[
			"a spawn destructured under a new name",
			'import * as cp from "node:child_process";\nconst { execFileSync: run } = cp;\nit("c", () => { run(bin, ["ls-files"]); });',
		],
		[
			"an aliased child_process spawn of git ls-files",
			'import { execFileSync as run } from "node:child_process";\nit("c", () => { run(bin, ["ls-files"]); });',
		],
	])("plants: refuses a default-budget census through %s", (_name, body) => {
		const source = `${VITEST}${KIT}${body}`;
		expect(defaultBudget(source)).toEqual(['"c"']);
		// The same spelling with a third argument is still seen and is admitted.
		const budgeted = source.replace(/\}\);\s*$/, "}, TREE_WALK_TIMEOUT_MS);");
		expect(budgeted).not.toBe(source);
		expect(censuses(budgeted)).toHaveLength(1);
		expect(defaultBudget(budgeted)).toEqual([]);
	});

	// Recurrence (#4828 verify r3 F8): the gate recorded only the argument count,
	// so `it(..., 5000)` passed while the catalogue said "never a per-file
	// number"; 29 live censuses carried their own number, 27 of them unscaled.
	it.each([
		["a raw number", "5000"],
		["a numeric separator literal", "30_000"],
		["a file-local constant", "CENSUS_TIMEOUT_MS"],
		["an options object", "{ timeout: 5000 }"],
		["the shared constant scaled again", "TREE_WALK_TIMEOUT_MS * 2"],
		["a member of another module", "other.TREE_WALK_TIMEOUT_MS"],
		["an unscaled call", "Math.max(5000, 1)"],
	])("plants: refuses a third argument that is %s", (_name, budget) => {
		const source = `${VITEST}${KIT}it("c", () => { listSourceFiles(ROOT); }, ${budget});`;
		expect(censuses(source)).toHaveLength(1);
		expect(defaultBudget(source)).toEqual(['"c"']);
	});

	it("plants: reports a refused budget with its file and title", () => {
		// Recurrence (#4828 verify r3 F8): the gate that the real-tree test calls
		// must name the file and the census, or a refusal reads as a pass.
		const source = `${VITEST}${KIT}it("c", () => { listSourceFiles(ROOT); }, 5000);`;
		expect(flagCensuses("tests/config/x.test.ts", source)).toEqual({
			census: 1,
			flagged: ['tests/config/x.test.ts: "c"'],
		});
	});

	it("plants: refuses a third argument on an unclassified census", () => {
		// Recurrence (#4828 verify r4 F9): the unclassified branch took the budget
		// rule with no witness, so `args.length === 2` there stayed green.
		const source = `${VITEST}censusTest("c", () => { listSourceFiles(ROOT); }, 5000);`;
		expect(censuses(source)).toHaveLength(1);
		expect(defaultBudget(source)).toEqual(['"c"']);
	});

	it.each([
		["the shared constant", "TREE_WALK_TIMEOUT_MS"],
		["a scaled call with a reason", "scaledTestTimeout(60_000)"],
	])("plants: admits a third argument that is %s", (_name, budget) => {
		const source = `${VITEST}${KIT}it("c", () => { listSourceFiles(ROOT); }, ${budget});`;
		expect(censuses(source)).toHaveLength(1);
		expect(defaultBudget(source)).toEqual([]);
	});

	it.each([
		[
			"a suite alias",
			'import { describe as group } from "vitest";\ngroup("s", () => { listSourceFiles(ROOT); });',
		],
		["a describe body", 'describe("s", () => { listSourceFiles(ROOT); });'],
		[
			"a nested helper call inside a budgeted case",
			'it("c", () => { run(x, () => listSourceFiles(ROOT)); }, TREE_WALK_TIMEOUT_MS);',
		],
		[
			"a one-directory listing helper",
			'function listDir(dir) {\n\treturn readdirSync(dir);\n}\nit("c", () => { listDir(ROOT); });',
		],
		[
			"an ls-files literal inside an expectation",
			'it("c", () => { expect(["ls-files"]).toEqual(["ls-files"]); });',
		],
		[
			"an ls-files array passed to a non-spawn call",
			'it("c", () => { record(["ls-files", "-z"]); });',
		],
		[
			"a walker named only in a string",
			'it("c", () => { const s = "listSourceFiles(ROOT)"; expect(s).toBe("x"); });',
		],
	])("plants: admits %s", (_name, body) => {
		expect(defaultBudget(`${VITEST}${KIT}${body}`)).toEqual([]);
	});

	// Recurrence (#4967): the baseline admits pre-existing members by identity, so
	// each verdict it can reach is planted: a refused member no row names (what the
	// widened census reports for a new walk), a row whose member is gone, two
	// members that share one identity, and a blank reason or an unsorted baseline.
	const KEY = 'tests/clients/a.test.ts: "c"';
	const ROW: BaselineRow = {
		file: "tests/clients/a.test.ts",
		title: '"c"',
		reason: "pre-existing, census widened in #4967",
	};
	it("plants: flags a refused member no baseline row names, admits one a row names", () => {
		expect(admissionVerdict([KEY], []).unadmitted).toEqual([KEY]);
		expect(admissionVerdict([KEY], [ROW]).unadmitted).toEqual([]);
	});
	it("plants: flags a baseline row whose member is gone", () => {
		expect(admissionVerdict([], [ROW]).stale).toEqual([KEY]);
		expect(admissionVerdict([KEY], [ROW]).stale).toEqual([]);
	});
	it("plants: flags two refused members that share one identity", () => {
		expect(admissionVerdict([KEY, KEY], [ROW]).duplicated).toEqual([KEY]);
		expect(admissionVerdict([KEY], [ROW]).duplicated).toEqual([]);
	});
	it("plants: flags a blank reason and an unsorted baseline", () => {
		expect(
			admissionVerdict([KEY], [{ ...ROW, reason: "  " }]).unreasoned,
		).toEqual([KEY]);
		expect(() => admissionVerdict([], [{ ...ROW, title: '"z"' }, ROW])).toThrow(
			/sorted/,
		);
	});

	// Recurrence (#4967, detection audit 2026-10-29): the census read tests/config
	// only, so refused tree-walk cases elsewhere (#4931, #4832, #4800, #4852, and
	// possibly #4797) shipped at vitest's 5 s default and timed out on loaded
	// runners. The root is every test file under tests/. Pre-existing refused
	// members outside tests/config are admitted by identity in the baseline; a new
	// one without a budget reds here. Budget: the walk over 1,711 files took 23.3 s
	// on Linux (2026-10-30), so this census takes 120 s (about 5x), not the shared
	// 30 s ceiling; the lane's scale still applies.
	it(
		"every census under tests/ with a tree walk carries a timeout budget or a baseline row",
		async () => {
			const files = listSourceFiles(TESTS_DIR, {
				extensions: [".ts"],
				skipTests: false,
			}).filter((file) => file.endsWith(".test.ts"));
			// Calibration 2026-10-30: 1,711 .test.ts files under tests/; half rounds to 855.
			assertNonEmptyScan("tests test files", files.length, 855);
			const flagged: string[] = [];
			let census = 0;
			for (const { file, source } of readWalkedFiles(files)) {
				const rel = relativePosix(ROOT, file);
				const scanned = flagCensuses(rel, source);
				census += scanned.census;
				flagged.push(...scanned.flagged);
				// Shape 81: turn the loop once per file so each parsed native tree is
				// freed before the next file is parsed.
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			// Calibration 2026-10-30: 244 census tests under tests/ (154 in
			// tests/config, all budgeted since #4828; 90 outside it, of which 87
			// are refused and admitted by the baseline since #4967 and 3 are
			// budgeted). The floor is the measured count, shrink-only: a
			// regression in binding propagation (measured 52 in tests/config)
			// drops the count and reds here, where a floor of 30 stayed green. A
			// root narrowed back to tests/config counts 154 and reds here.
			assertNonEmptyScan("tree census tests", census, 244);
			const rows = JSON.parse(
				fs.readFileSync(BASELINE_PATH, "utf8"),
			) as BaselineRow[];
			const verdict = admissionVerdict(flagged, rows);
			expect(verdict.unadmitted).toEqual([]);
			expect(verdict.stale).toEqual([]);
			expect(verdict.duplicated).toEqual([]);
			expect(verdict.unreasoned).toEqual([]);
		},
		scaledTestTimeout(120_000),
	);
});

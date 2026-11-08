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
 * budget (the third argument, or the `timeout` pair of the options object in
 * vitest's `it(title, { timeout }, fn)` form, #5430 review F1) is an
 * identifier named `TREE_WALK_TIMEOUT_MS`
 * (the shared constant in `tests/support/test-timeout-scale.ts`; the gate reads
 * the name, not the binding), or a `scaledTestTimeout(...)` call
 * for a census that needs more than the shared ceiling (name the reason in a
 * comment; the gate does not read it). The default two arguments, a raw number, a
 * file-local constant, an options object third, an options object without a
 * `timeout` pair, an options binding or spread, or any other expression is
 * refused,
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
 *   of either — and a call of a same-subtree wrapper that hands its own
 *   arguments to one of those spawners (#4967: `tests/support/vitest-setup.ts`
 *   runs every git command through a local `run`, so the literal and the spawn
 *   sit on different lines).
 * - Helper (#4967): a call to a name the file imports from a module under
 *   `tests/` is a walk when that module's own definition reaches a walker,
 *   followed through that module's local helpers, its namespace-import
 *   members, its re-exports and its own imports. A default import reads as
 *   the module's `default` export (#5430 review F2). Verdicts settle to a fixed
 *   point over the whole helper graph, so a verdict never depends on which
 *   file asked and a module cycle converges. The verdict is derived from
 *   source once per module per run, never from a name list, so it cannot rot;
 *   the helper-table pin below re-asserts the verdicts the #4967 audit read by
 *   hand, so a helper that stops walking reds there instead of quietly leaving
 *   the census. A call the detector cannot resolve — a relative module it
 *   cannot read, or a name that module does not make available — is a walk
 *   (fail closed), so it needs a budget or a baseline row rather than passing
 *   silently. A name from a package (`vitest`, `node:child_process`) or from
 *   runtime source (`clients/`, `tools/`, `mcp/`, `scripts/`) is a boundary,
 *   not a failure: the census follows helpers under `tests/` only.
 *
 * Not read (accepted residual, backstop `Unit tests Windows`, which reds on the
 * first census that times out there): a walker reached through runtime source
 * outside `tests/`, or through a wrapper the TEST file itself declares (the
 * resolver follows a helper module's own wrappers, not a test file's);
 * a recursive walker spelled as a variable-bound arrow function, or a
 * `readdirSync(dir, { recursive: true })`; a walk named by an enclosing
 * `describe.each` table or `for...of` loop instead of by the case; and these
 * indirect forms (#5430 review F3, live population 0 each): a dynamic
 * `import()` of a helper (in a case, at module scope, or through `.then`); a
 * call through an object property or array element (`api.w(R)`, `fns[0](R)`);
 * a walker passed as a callback (`[R].map(walk)`) or called through `.call`;
 * a class or object-literal member of a helper (`kit.walk(R)`, `K.run(R)`);
 * and a helper that aliases, destructures or re-binds an imported walker
 * (`const run = walk`, `const { walk: w } = ns`, `export const f = walk`),
 * because a helper's definitions are read with an import-blind scope. Two
 * further accepted residuals: a quiet name behind two levels of `export *`
 * reads `unknown` and asks for a budget (over-refusal, the safe direction,
 * #5430 review B3); and runtime source outside `tests/` stays a boundary even
 * where a test walks through it (`tests/clients/git-tracked-ignore.test.ts`
 * runs the production `git ls-files` helper; #5430 review F8). The budget
 * is admitted by name, not by binding (accepted residual, live population 0
 * each way): a same-named local `const TREE_WALK_TIMEOUT_MS = 5000` is
 * admitted, and an import alias of the shared constant is refused.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SgNode } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import {
	isWithinForm,
	normalizeEphemeralMapKey,
} from "../../clients/path-utils.js";
import { jsTsCandidatePaths } from "../../clients/review-graph/import-resolvers.js";
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

/**
 * #4967: what the detector knows about one helper name. Its definition reaches
 * a walk (`"walks"`), does not (`"quiet"`), or could not be read (`"unknown"`,
 * which fails closed).
 */
type HelperVerdict = "walks" | "quiet" | "unknown";

/** Where the detector reads a helper module's source from. The real-tree run
 *  reads the checkout; a plant passes a table so it stays hermetic. */
interface HelperSources {
	read(absolute: string): string | undefined;
}

/** Where one call's target lives: a name of the same module, another module's
 *  export, a module the census does not follow (a package, or runtime source
 *  outside `tests/`), or nothing readable behind a `tests/` path. */
type HelperCall =
	| { local: string }
	| { module: string; name: string }
	| { boundary: true }
	| { unreadable: true };

/** What one name's definition reaches, read off the source once: its own body,
 *  plus the targets of every call in it. No syntax node is retained, so the run
 *  holds no native tree between files (shape 81). */
interface HelperShape {
	/** The definition itself calls a listed walker or a `git ls-files` spawner. */
	reaches: boolean;
	/** The names whose verdict the fixed point still has to decide. */
	calls: HelperCall[];
}

/** The verdicts of the helper modules one census run touches, derived once.
 *  `ref` answers where a specifier's definition lives; `verdict` and `table`
 *  answer what a module's names do. */
interface HelperResolver {
	ref(fromFile: string, specifier: string): NamespaceRef;
	verdict(moduleFile: string, name: string): HelperVerdict;
	table(moduleFile: string): Map<string, HelperVerdict>;
}

/**
 * Where a specifier's definition lives, for the census's purposes.
 *
 * A `tests/` module is `module`, so its names are read. A `tests/` path with
 * nothing readable behind it is `unreadable`, so a call through it fails
 * closed. A package or runtime source outside `tests/` (`clients/`, `tools/`,
 * `mcp/`, `scripts/`) is `external`: a boundary the census does not follow,
 * not a failure. That last arm is #4967's accepted residual — it keeps the
 * gate's population the tests tree, and `Unit tests Windows` backstops it.
 */
type NamespaceRef =
	| { module: string }
	| { external: true }
	| { unreadable: true };

/**
 * Is this file inside `tests/`, the only tree whose helpers the census reads?
 * The owner's text-only form check (`clients/path-utils.ts`) and not
 * `isUnderDir`: these paths include plant modules that never exist on disk, so
 * the identity axis has nothing to resolve. Both operands take the owner's
 * slash form first, because `path.resolve` spells a win32 helper as
 * `C:\checkout\tests\config\helper.ts` and `isWithinForm` compares forward
 * slashes: on the Windows leg that spelling read as a boundary, every helper
 * import went `quiet`, and the helper plants found nothing (#4967).
 */
function underTestsForm(child: string, testsDir: string): boolean {
	return isWithinForm(
		normalizeEphemeralMapKey(child),
		normalizeEphemeralMapKey(testsDir),
	);
}

function underTests(absolute: string): boolean {
	return underTestsForm(absolute, TESTS_DIR);
}

/**
 * The source file a specifier names, or `null` when nothing readable is there.
 * The candidates are the review graph's own `jsTsCandidatePaths`, the repo's one
 * `./x.js` to source-twin mapping (#694; `tests/support/hook-await-scan.mjs`
 * folded its copy the same way, #2557). Only the existence check stays here,
 * because a plant reads a virtual module table, not the disk (#5430 review F9).
 */
function resolveSpecifier(
	sources: HelperSources,
	fromFile: string,
	specifier: string,
): string | null {
	if (!specifier.startsWith(".")) return null;
	for (const candidate of jsTsCandidatePaths(fromFile, specifier)) {
		// The twin order maps `./x.mjs` to `x.ts` first, and the `tests/support/`
		// facades are exactly that pair (`x.ts` holds `export * from "./x.mjs"`),
		// so a facade would resolve to itself. A module never imports itself.
		if (candidate === fromFile) continue;
		if (sources.read(candidate) !== undefined) return candidate;
	}
	return null;
}

function namespaceRef(
	sources: HelperSources,
	fromFile: string,
	specifier: string,
): NamespaceRef {
	const resolved = resolveSpecifier(sources, fromFile, specifier);
	if (resolved === null)
		return specifier.startsWith(".") &&
			underTests(path.resolve(path.dirname(fromFile), specifier))
			? { unreadable: true }
			: { external: true };
	return underTests(resolved) ? { module: resolved } : { external: true };
}

/** The same three arms for one name imported or re-exported from `specifier`. */
function helperCall(
	sources: HelperSources,
	fromFile: string,
	specifier: string,
	name: string,
): HelperCall {
	const ref = namespaceRef(sources, fromFile, specifier);
	if ("module" in ref) return { module: ref.module, name };
	return "external" in ref ? { boundary: true } : { unreadable: true };
}

/** The local name of an import's default binding (`import walk from`,
 *  `import walk, { x } from`), else undefined. #5430 review F2: it reads as the
 *  module's `default` export, so a missing one fails closed like a named one. */
function defaultImportName(statement: SgNode): string | undefined {
	const clause = statement
		.children()
		.find((child) => child.kind() === "import_clause");
	return clause
		?.children()
		.find((child) => child.kind() === "identifier")
		?.text();
}

/** The names a module-scope declaration introduces: `function f`, `const a`,
 *  `const { b, c: d }`. Only module scope: a nested helper is reached through
 *  the enclosing definition's own body, which `walksTree` already reads whole. */
const NAMED_DECLARATION_KINDS = new Set<string>([
	"identifier",
	"type_identifier",
	"property_identifier",
]);

function declarationNames(node: SgNode): string[] {
	const name = node.field("name");
	if (name && NAMED_DECLARATION_KINDS.has(String(name.kind())))
		return [name.text()];
	if (name?.kind() === "object_pattern" || name?.kind() === "array_pattern")
		return boundNames(name);
	const names: string[] = [];
	for (const child of node.children()) {
		if (child.kind() !== "variable_declarator") continue;
		names.push(...boundNames(child.field("name")));
	}
	return names;
}

/** The module-scope declaration kinds whose names a module makes available.
 *  Types and interfaces are in the list because a name the table does not carry
 *  at all reads as unresolvable, and importing a type must not fail closed. */
const DECLARATION_KINDS = new Set<string>([
	"function_declaration",
	"generator_function_declaration",
	"class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"function_signature",
	"lexical_declaration",
	"variable_declaration",
]);

/** Only ever a promotion: `walks` outranks `unknown` outranks `quiet`, so the
 *  fixed point terminates and a walk never gets downgraded by a later pass. */
const VERDICT_RANK: Record<HelperVerdict, number> = {
	quiet: 0,
	unknown: 1,
	walks: 2,
};

/** A name the pass has seen is always recorded, `quiet` included: a name ABSENT
 *  from a table is a name the module does not make available, and the lookup
 *  fails closed on that. */
function promote(
	table: Map<string, HelperVerdict>,
	name: string,
	verdict: HelperVerdict,
): boolean {
	const known = table.get(name);
	if (known !== undefined && VERDICT_RANK[verdict] <= VERDICT_RANK[known])
		return false;
	table.set(name, verdict);
	return true;
}

/** The source of one file, or `undefined` when there is nothing to read. */
const CHECKOUT_SOURCES: HelperSources = {
	read(absolute: string): string | undefined {
		try {
			return fs.readFileSync(absolute, "utf8");
		} catch {
			return undefined;
		}
	},
};

/**
 * Derive what each name of each helper module under `tests/` does.
 *
 * A name walks when its definition calls a listed walker, a name of the same
 * module that walks, or an exported name of another module that walks. Verdicts
 * settle to a fixed point over the WHOLE helper graph instead of following a
 * chain to a depth cap, so a verdict never depends on which test file asked,
 * and a module cycle converges instead of failing closed. Promotions only climb,
 * so the settle terminates.
 *
 * Each module is read and parsed once, and only its call targets and one boolean
 * are kept, so the run holds neither source text nor native trees between files
 * (#4212: a per-call walk of the corpus is the cost, not the parse). A re-export
 * carries the verdict of the definition it points at, so the `export * from
 * "./x.mjs"` shims under `tests/support/` do not hide a walker.
 */
function createResolver(sources: HelperSources): HelperResolver {
	/** Each module's shape, and the verdicts settled from it. */
	const shapes = new Map<string, Map<string, HelperShape>>();
	const verdicts = new Map<string, Map<string, HelperVerdict>>();
	/** Modules named by a call but not read yet. */
	const pending: string[] = [];
	const queued = new Set<string>();
	/** `export *` targets per module, folded once the target is read. */
	const stars = new Map<string, string[]>();
	const folded = new Set<string>();
	let dirty = true;

	function requireModule(moduleFile: string): void {
		if (shapes.has(moduleFile) || queued.has(moduleFile)) return;
		queued.add(moduleFile);
		pending.push(moduleFile);
	}

	/** Read one module: its names, and for each what its definition reaches. */
	function derive(moduleFile: string): void {
		const made = new Map<string, HelperShape>();
		const source = sources.read(moduleFile);
		if (source !== undefined) {
			try {
				readShape(source, moduleFile, made);
			} catch {
				// Unparseable: the module answers for no name, so every call
				// through it reads `unknown` and fails closed.
			}
		}
		shapes.set(moduleFile, made);
		verdicts.set(
			moduleFile,
			new Map([...made.keys()].map((name) => [name, "quiet" as HelperVerdict])),
		);
		dirty = true;
	}

	function readShape(
		source: string,
		moduleFile: string,
		made: Map<string, HelperShape>,
	): void {
		const root = parseRoot(source);
		const scope = scopeOf(root);
		const defs = new Map<string, SgNode>();
		/** Names an import or a re-export stands for, and where they come from. */
		const imports = new Map<string, HelperCall>();
		const reExported: string[] = [];
		/** `import * as ns` bindings. */
		const namespaces = new Map<string, NamespaceRef>();
		for (const statement of root.children()) {
			if (!statement.isNamed()) continue;
			const exportsDefault =
				statement.kind() === "export_statement" &&
				statement.children().some((child) => child.kind() === "default");
			// #5430 review F2: `export default <declaration | expression>` defines
			// the name `default`; `export default name` points at `name`.
			const value = exportsDefault ? statement.field("value") : null;
			if (value?.kind() === "identifier") {
				reExported.push(`default\n${value.text()}`);
				continue;
			}
			if (value && !defs.has("default")) defs.set("default", value);
			const node =
				statement.kind() === "export_statement"
					? statement.field("declaration")
					: statement;
			if (!node || !DECLARATION_KINDS.has(String(node.kind()))) continue;
			if (exportsDefault && !defs.has("default")) defs.set("default", node);
			for (const name of declarationNames(node))
				if (!defs.has(name)) defs.set(name, node);
		}
		for (const statement of root.findAll({
			rule: { kind: "import_statement" },
		})) {
			const specifier = unquote(statement.field("source")?.text() ?? "");
			const byDefault = defaultImportName(statement);
			if (byDefault)
				imports.set(
					byDefault,
					helperCall(sources, moduleFile, specifier, "default"),
				);
			for (const imported of statement.findAll({
				rule: { kind: "import_specifier" },
			})) {
				const name = imported.field("name")?.text() ?? "";
				const local = imported.field("alias")?.text() ?? name;
				if (local)
					imports.set(local, helperCall(sources, moduleFile, specifier, name));
			}
			for (const space of statement.findAll({
				rule: { kind: "namespace_import" },
			})) {
				const local = space.find({ rule: { kind: "identifier" } })?.text();
				if (local)
					namespaces.set(local, namespaceRef(sources, moduleFile, specifier));
			}
		}
		for (const statement of root.findAll({
			rule: { kind: "export_statement" },
		})) {
			const sourceNode = statement.field("source");
			const specifier = sourceNode ? unquote(sourceNode.text()) : undefined;
			if (/^\s*export\s+\*/.test(statement.text())) {
				if (specifier === undefined) continue;
				const call = helperCall(sources, moduleFile, specifier, "");
				if ("module" in call) {
					const targets = stars.get(moduleFile) ?? [];
					targets.push(call.module);
					stars.set(moduleFile, targets);
					requireModule(call.module);
				}
				continue;
			}
			for (const exported of statement.findAll({
				rule: { kind: "export_specifier" },
			})) {
				const name = exported.field("name")?.text() ?? "";
				const local = exported.field("alias")?.text() ?? name;
				if (!local || !name) continue;
				if (specifier !== undefined) {
					imports.set(local, helperCall(sources, moduleFile, specifier, name));
					continue;
				}
				const def = defs.get(name);
				if (def && local !== name) defs.set(local, def);
				else if (local !== name) reExported.push(`${local}\n${name}`);
			}
		}
		for (const [name, def] of defs) {
			const calls: HelperCall[] = [];
			for (const call of def.findAll({ rule: { kind: "call_expression" } })) {
				const fn = call.field("function");
				if (!fn) continue;
				if (fn.kind() === "identifier") {
					calls.push({ local: fn.text() });
					continue;
				}
				const property = propertyName(fn);
				const object = fn.field("object");
				if (property === undefined || object?.kind() !== "identifier") continue;
				const ref = namespaces.get(object.text());
				if (!ref) continue;
				calls.push(
					"module" in ref
						? { module: ref.module, name: property }
						: "external" in ref
							? { boundary: true }
							: { unreadable: true },
				);
			}
			made.set(name, { reaches: walksTree(def, scope), calls });
		}
		for (const [local, target] of imports) {
			if (!made.has(local))
				made.set(local, { reaches: false, calls: [target] });
		}
		for (const pair of reExported) {
			const [local, name] = pair.split("\n");
			if (local && name && !made.has(local))
				made.set(local, { reaches: false, calls: [{ local: name }] });
		}
	}

	/** Fold one module's `export *` targets into its table, once they are read. */
	function foldStars(): void {
		for (const [moduleFile, targets] of stars) {
			const made = shapes.get(moduleFile);
			const table = verdicts.get(moduleFile);
			if (!made || !table) continue;
			for (const target of targets) {
				const key = `${moduleFile}\n${target}`;
				if (folded.has(key)) continue;
				if (!shapes.has(target)) {
					requireModule(target);
					continue;
				}
				folded.add(key);
				for (const name of verdicts.get(target)?.keys() ?? []) {
					if (made.has(name)) continue;
					made.set(name, {
						reaches: false,
						calls: [{ module: target, name }],
					});
					table.set(name, "quiet");
					dirty = true;
				}
			}
		}
	}

	/** The verdict one name reaches given what is settled so far. */
	function evaluate(
		shape: HelperShape,
		table: Map<string, HelperVerdict>,
	): HelperVerdict {
		if (shape.reaches) return "walks";
		let verdict: HelperVerdict = "quiet";
		for (const call of shape.calls) {
			if ("local" in call) {
				const reached = table.get(call.local);
				if (reached === "walks") return "walks";
				if (reached === "unknown") verdict = "unknown";
				continue;
			}
			if ("boundary" in call) continue;
			if ("unreadable" in call) {
				verdict = "unknown";
				continue;
			}
			if (!shapes.has(call.module)) {
				// Not read yet: say nothing this round rather than fail a name
				// closed on a module the next round settles.
				requireModule(call.module);
				continue;
			}
			const reached = verdicts.get(call.module)?.get(call.name);
			if (reached === "walks") return "walks";
			if (reached === undefined || reached === "unknown") verdict = "unknown";
		}
		return verdict;
	}

	/** Read every module a call named and settle every verdict, until nothing
	 *  moves. */
	function settle(): void {
		while (pending.length || dirty) {
			while (pending.length) {
				const next = pending.shift();
				if (!next) continue;
				queued.delete(next);
				derive(next);
			}
			if (!dirty) break;
			dirty = false;
			foldStars();
			for (const [moduleFile, shape] of shapes) {
				const table = verdicts.get(moduleFile);
				if (!table) continue;
				for (const [name, def] of shape) {
					if (promote(table, name, evaluate(def, table))) dirty = true;
				}
			}
		}
	}

	function tableOf(moduleFile: string): Map<string, HelperVerdict> {
		requireModule(moduleFile);
		settle();
		return verdicts.get(moduleFile) ?? new Map();
	}

	return {
		ref: (fromFile, specifier) => namespaceRef(sources, fromFile, specifier),
		verdict: (moduleFile, name) => tableOf(moduleFile).get(name) ?? "unknown",
		table: tableOf,
	};
}

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
	/** #4967: local names imported from a `tests/` module whose verdict the
	 *  detector could not derive. A call to one fails closed as a walk. */
	unresolved: Set<string>;
	/** #4967: `import * as ns` bindings of a `tests/` module, to that module's
	 *  verdict table (`null`: the module could not be read, so every member of
	 *  it is unresolvable). */
	helperNamespaces: Map<string, Map<string, HelperVerdict> | null>;
}

/** The file under test, so a relative import resolves against it, and where
 *  its helper verdicts come from. A plant that
 *  exercises helper resolution passes both; omitting them keeps the file's
 *  own imports the only source of a walker name. */
interface HelperScope {
	resolver: HelperResolver;
	file: string;
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
function scopeOf(root: SgNode, helpers?: HelperScope): Scope {
	const scope: Scope = {
		declarations: new Set(),
		suites: new Set(),
		namespaces: new Set(),
		walkers: new Set(WALKERS),
		spawners: new Set(SPAWNERS),
		lsFiles: new Set(),
		unresolved: new Set(),
		helperNamespaces: new Map(),
	};
	for (const statement of root.findAll({
		rule: { kind: "import_statement" },
	})) {
		const specifier = unquote(statement.field("source")?.text() ?? "");
		const vitest = specifier === "vitest";
		// #4967: only a helper module under `tests/` is read; a package or runtime
		// source outside it is a boundary that answers `quiet` for every name.
		const ref = helpers
			? helpers.resolver.ref(helpers.file, specifier)
			: undefined;
		const table =
			ref === undefined
				? undefined
				: "module" in ref
					? helpers!.resolver.table(ref.module)
					: "unreadable" in ref
						? null
						: undefined;
		for (const imported of statement.findAll({
			rule: { kind: "import_specifier" },
		})) {
			const name = imported.field("name")?.text() ?? "";
			const local = imported.field("alias")?.text() ?? name;
			if (vitest && DECLARATIONS.has(name)) scope.declarations.add(local);
			if (vitest && SUITES.has(name)) scope.suites.add(local);
			if (WALKERS.has(name)) scope.walkers.add(local);
			if (SPAWNERS.has(name)) scope.spawners.add(local);
			const verdict =
				table === undefined ? undefined : (table?.get(name) ?? "unknown");
			if (verdict === "walks") scope.walkers.add(local);
			if (verdict === "unknown") scope.unresolved.add(local);
		}
		const byDefault = defaultImportName(statement);
		if (byDefault && table !== undefined) {
			const verdict = table?.get("default") ?? "unknown";
			if (verdict === "walks") scope.walkers.add(byDefault);
			if (verdict === "unknown") scope.unresolved.add(byDefault);
		}
		for (const space of statement.findAll({
			rule: { kind: "namespace_import" },
		})) {
			const local = space.find({ rule: { kind: "identifier" } })?.text();
			if (!local) continue;
			if (vitest) scope.namespaces.add(local);
			if (table !== undefined) scope.helperNamespaces.set(local, table ?? null);
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
				// `const { listSourceFiles: walk } = kit;`, and #4967 the shorthand
				// spelling `const { testSourceFiles } = kit;` of the same binding.
				for (const pair of name.findAll({ rule: { kind: "pair_pattern" } })) {
					const key = unquote(pair.field("key")?.text() ?? "");
					const local = pair.field("value")?.text() ?? "";
					if (WALKERS.has(key)) add(scope.walkers, local);
					if (SPAWNERS.has(key)) add(scope.spawners, local);
					const verdict = helperMemberVerdict(value, key, scope);
					if (verdict === "walks") add(scope.walkers, local);
					if (verdict === "unknown") add(scope.unresolved, local);
				}
				for (const short of name.findAll({
					rule: { kind: "shorthand_property_identifier_pattern" },
				})) {
					const local = short.text();
					if (WALKERS.has(local)) add(scope.walkers, local);
					if (SPAWNERS.has(local)) add(scope.spawners, local);
					const verdict = helperMemberVerdict(value, local, scope);
					if (verdict === "walks") add(scope.walkers, local);
					if (verdict === "unknown") add(scope.unresolved, local);
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

/**
 * The verdict of `key` read off the helper module `value` names (an
 * `import * as kit` binding, or the object of a destructured binding).
 * `undefined`: `value` is not a helper module, so nothing is known here.
 */
function helperMemberVerdict(
	value: SgNode,
	key: string,
	scope: Scope,
): HelperVerdict | undefined {
	if (value.kind() !== "identifier") return undefined;
	const table = scope.helperNamespaces.get(value.text());
	if (table === undefined) return undefined;
	return table === null ? "unknown" : (table.get(key) ?? "unknown");
}

/** Is this expression a reference to a walker (a binding or a member)? */
function walkerRef(node: SgNode, scope: Scope): boolean {
	if (node.kind() === "identifier")
		return scope.walkers.has(node.text()) || scope.unresolved.has(node.text());
	const property = propertyName(node);
	if (property === undefined) return false;
	if (WALKERS.has(property)) return true;
	const object = node.field("object");
	if (!object) return false;
	const verdict = helperMemberVerdict(object, property, scope);
	return verdict === "walks" || verdict === "unknown";
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
	// A module-local wrapper that hands its own arguments to a spawner: the
	// `ls-files` literal sits at the call, the spawn sits inside the wrapper, so
	// neither the call alone nor the wrapper alone reads as a walk (#4967:
	// `tests/support/vitest-setup.ts` runs every git command, `ls-files` included,
	// through `run`). A wrapper that spawns for another reason is not in the set.
	const spawnWrappers = new Set<string>();
	for (const holder of node.findAll({
		rule: {
			any: [{ kind: "variable_declarator" }, { kind: "function_declaration" }],
		},
	})) {
		const body = holder.field("value") ?? holder;
		const names = holder.field("name");
		if (
			!names ||
			!body.findAll({ rule: { kind: "call_expression" } }).some((call) => {
				const fn = call.field("function");
				return fn !== null && spawnerRef(fn, scope);
			})
		)
			continue;
		for (const bound of boundNames(names)) spawnWrappers.add(bound);
	}
	return (
		calls.some((call) => {
			const fn = call.field("function");
			if (!fn) return false;
			if (walkerRef(fn, scope)) return true;
			// `git ls-files` only as an argument of a recognised spawn call, never
			// as a literal in an expectation or a fixture.
			return (
				(spawnerRef(fn, scope) ||
					(fn.kind() === "identifier" && spawnWrappers.has(fn.text()))) &&
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

/**
 * The case body and the budget of one test-shaped call. Vitest takes a budget
 * either third, `it(title, fn, budget)`, or in an options object second,
 * `it(title, { timeout }, fn)` (#5430 review F1). In the options form the body
 * is the third argument and the budget is the object's `timeout` pair; any
 * other second argument (a binding, a spread, an object without that pair)
 * leaves no budget, so the case is refused.
 */
function bodyAndBudget(args: SgNode[]): {
	body: SgNode;
	budget: SgNode | undefined;
} {
	const second = args[1];
	const third = args[2];
	if (FUNCTION_KINDS.has(String(second.kind())) || !third)
		return { body: second, budget: third };
	if (!FUNCTION_KINDS.has(String(third.kind())))
		return { body: second, budget: third };
	if (second.kind() !== "object") return { body: third, budget: undefined };
	const timeout = second
		.children()
		.find(
			(pair) =>
				pair.kind() === "pair" &&
				unquote(pair.field("key")?.text() ?? "") === "timeout",
		);
	return { body: third, budget: timeout?.field("value") ?? undefined };
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

/**
 * Every local name a binding introduces: `x`, `{ a, b: c }`, `[d]`. #4967: a
 * suite-scope `const { occurrences } = findWalk();` binds `occurrences`, not the
 * pattern's text, so reading `occurrences` in a case is reading the walk.
 */
function boundNames(pattern: SgNode | null | undefined): string[] {
	if (!pattern) return [];
	if (
		pattern.kind() === "identifier" ||
		pattern.kind() === "shorthand_property_identifier_pattern"
	)
		return [pattern.text()];
	const names: string[] = [];
	for (const child of pattern.children())
		if (child.isNamed()) names.push(...boundNames(child));
	return names;
}

/**
 * Does `node` read a walked name that no binding of the same name shadows at
 * the read? A subtree's own `const`, `let`, parameter or catch binding is never
 * a read of the same-named suite-scope binding (#4967: `collectUses` declares
 * its own `pin` from a regex match, and that is not the `pin` a sibling case
 * takes out of the walked `pins`). #5430 review B1: the binding hides only the
 * reads inside its own scope, so a nested callback's `(files) => files` no
 * longer hides the case's own read of the walked `files` beside it.
 */
const BLOCK_SCOPE_KINDS = new Set<string>([
	"statement_block",
	"for_statement",
	"for_in_statement",
	"switch_body",
	"program",
]);

function scopeOwner(node: SgNode, kinds: ReadonlySet<string>): SgNode | null {
	let owner = node.parent();
	while (owner && !kinds.has(String(owner.kind()))) owner = owner.parent();
	return owner;
}

/** Each name a subtree binds, to the source ranges of the scopes it binds in. */
function bindingScopes(node: SgNode): Map<string, Array<[number, number]>> {
	const scopes = new Map<string, Array<[number, number]>>();
	const bind = (names: string[], owner: SgNode | null) => {
		if (!owner) return;
		const { start, end } = owner.range();
		for (const name of names) {
			const ranges = scopes.get(name) ?? [];
			ranges.push([start.index, end.index]);
			scopes.set(name, ranges);
		}
	};
	for (const holder of node.findAll({
		rule: {
			any: [
				{ kind: "variable_declarator" },
				{ kind: "formal_parameters" },
				{ kind: "catch_clause" },
				{ kind: "arrow_function" },
				{ kind: "for_in_statement" },
			],
		},
	})) {
		switch (holder.kind()) {
			case "variable_declarator":
				bind(
					boundNames(holder.field("name")),
					scopeOwner(holder, BLOCK_SCOPE_KINDS),
				);
				break;
			case "formal_parameters":
				for (const parameter of holder.children())
					if (parameter.isNamed())
						bind(
							boundNames(parameter.field("pattern") ?? parameter),
							holder.parent(),
						);
				break;
			case "catch_clause":
				bind(boundNames(holder.field("parameter")), holder);
				break;
			case "arrow_function":
				// `files => files`: a lone parameter with no parentheses.
				bind(boundNames(holder.field("parameter")), holder);
				break;
			case "for_in_statement":
				// `for (const file of files)`: `left` binds only under a keyword.
				if (holder.field("kind"))
					bind(boundNames(holder.field("left")), holder);
				break;
		}
	}
	return scopes;
}

function readsWalked(node: SgNode, walked: ReadonlySet<string>): boolean {
	const reads = node
		.findAll({ rule: { kind: "identifier" } })
		.filter((id) => walked.has(id.text()));
	if (reads.length === 0) return false;
	const scopes = bindingScopes(node);
	return reads.some((id) => {
		const { start, end } = id.range();
		return !(scopes.get(id.text()) ?? []).some(
			([from, to]) => from <= start.index && end.index <= to,
		);
	});
}

/** Every census declaration in one test file's source (one parse). */
function censuses(source: string, helpers?: HelperScope): Census[] {
	const root = parseRoot(source);
	const scope = scopeOf(root, helpers);
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
		.map((decl) => ({ names: boundNames(decl.field("name")), decl }))
		.filter((entry) => entry.names.length > 0);
	// #4967: an unresolvable import from a `tests/` module fails closed, and a
	// case that merely MENTIONS the name is a census too: the file cannot show
	// the call does not walk.
	const walked = new Set<string>(scope.unresolved);
	let grown = true;
	while (grown) {
		grown = false;
		for (const { names, decl } of decls) {
			if (names.every((name) => walked.has(name))) continue;
			if (walksTree(decl, scope) || readsWalked(decl, walked)) {
				for (const name of names) walked.add(name);
				grown = true;
			}
		}
	}
	const walks = (node: SgNode) =>
		walksTree(node, scope) || readsWalked(node, walked);
	const found: Census[] = [];
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function");
		if (!callee) continue;
		const args = namedArgs(call);
		if (args.length < 2) continue;
		const calleeRoot = rootOf(callee, scope);
		const { body, budget } = bodyAndBudget(args);
		if (isDeclarationRoot(calleeRoot, scope)) {
			// `it.each(table)(title, fn)`: the table is walked even when the case
			// never names it (its rows are the walked population).
			if (walks(body) || tableArguments(callee).some(walks))
				found.push({
					title: args[0].text(),
					argCount: args.length,
					refused: !admittedBudget(budget),
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
				refused: !admittedBudget(budget),
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
	helpers?: HelperScope,
): { census: number; flagged: string[] } {
	const found = censuses(source, helpers);
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

	// Recurrence (#5430 review F1): vitest's `it(title, options, fn)` form put
	// the body third, and the detector read the options object as the body, so
	// `tests/scripts/ci-shuffle-census.test.ts` walked every tracked test file
	// at an unscaled `{ timeout: 60_000 }` outside the census.
	it.each([
		["an options object with a raw timeout", "{ timeout: 5000 }"],
		["an options object with no timeout", "{ retry: 1 }"],
		["an empty options object", "{}"],
		["a shorthand timeout", "{ timeout }"],
		["an options object with a file-local constant", "{ timeout: CENSUS_MS }"],
		["options through a binding", "opts"],
		[
			"a spread of the admitted budget",
			"{ ...{ timeout: TREE_WALK_TIMEOUT_MS } }",
		],
	])(
		"plants: refuses a census in the options form with %s",
		(_name, options) => {
			for (const declaration of ["it", "test", "it.skipIf(cond)"]) {
				const source = `${VITEST}${KIT}${declaration}("c", ${options}, () => { listSourceFiles(ROOT); });`;
				expect(censuses(source)).toHaveLength(1);
				expect(defaultBudget(source)).toEqual(['"c"']);
			}
			const unclassified = `${VITEST}${KIT}censusTest("c", ${options}, () => { listSourceFiles(ROOT); });`;
			expect(censuses(unclassified).map((entry) => entry.how)).toEqual([
				"unclassified",
			]);
			expect(defaultBudget(unclassified)).toEqual(['"c"']);
		},
	);

	it.each([
		["the shared constant", "{ timeout: TREE_WALK_TIMEOUT_MS }"],
		["a scaled call", "{ retry: 1, timeout: scaledTestTimeout(60_000) }"],
	])(
		"plants: admits a census in the options form with %s",
		(_name, options) => {
			const source = `${VITEST}${KIT}it("c", ${options}, () => { listSourceFiles(ROOT); });`;
			expect(censuses(source)).toHaveLength(1);
			expect(defaultBudget(source)).toEqual([]);
		},
	);

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

	// Recurrence (#4967, detection audit 2026-10-29): a walk reached through a
	// helper the file imports was outside the census, so a case that pays a
	// whole-tree walk inside `clientSourceFiles()` or `testSourceFiles()` shipped
	// at vitest's 5 s default and timed out on a loaded runner. The verdict is
	// read off the helper's source, so every arm of that reading is planted here
	// against a virtual module table: a helper that walks, one that does not, a
	// re-export shim, a namespace member, an unresolvable name (fail closed), a
	// package, and runtime source outside `tests/`.
	const PLANT_DIR = path.join(TESTS_DIR, "config");
	const plantSources = (files: Record<string, string>): HelperSources => {
		const made = new Map<string, string>();
		for (const [name, source] of Object.entries(files))
			made.set(path.join(PLANT_DIR, name), source);
		return { read: (file) => made.get(file) };
	};
	const plantCensuses = (body: string, files: Record<string, string>) =>
		censuses(`${VITEST}${body}`, {
			file: path.join(PLANT_DIR, "plant.test.ts"),
			resolver: createResolver(plantSources(files)),
		});
	const WALKING_HELPER =
		"export function walkHere(dir) { return listSourceFiles(dir); }\n";
	const QUIET_HELPER = "export function countUpTo(n) { return n + 1; }\n";
	it.each([
		[
			"a helper that walks",
			'import { walkHere } from "./helper.js";\nit("c", () => { walkHere(ROOT); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a helper two modules deep",
			'import { outer } from "./outer.js";\nit("c", () => { outer(ROOT); });',
			{
				"outer.ts": 'export { walkHere as outer } from "./helper.js";\n',
				"helper.ts": WALKING_HELPER,
			},
		],
		[
			"a helper reached through an `export *` shim",
			'import { walkHere } from "./shim.js";\nit("c", () => { walkHere(ROOT); });',
			{
				"shim.ts": 'export * from "./helper.js";\n',
				"helper.ts": WALKING_HELPER,
			},
		],
		[
			"a walking member of a namespace import",
			'import * as kit from "./helper.js";\nit("c", () => { kit.walkHere(ROOT); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a helper bound through a destructured rename",
			'import * as kit from "./helper.js";\nconst { walkHere: walk } = kit;\nit("c", () => { walk(ROOT); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a suite-scope local wrapper around a walking helper",
			'import { walkHere } from "./helper.js";\nconst files = walkHere(ROOT);\nit("c", () => { expect(files).toBeTruthy(); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a helper that walks through its own local helper",
			'import { entry } from "./helper.js";\nit("c", () => { entry(ROOT); });',
			{
				"helper.ts":
					"function inner(dir) { return listSourceFiles(dir); }\nexport function entry(dir) { return inner(dir); }\n",
			},
		],
		[
			// The spawner arm reads the spawn call plus the `ls-files` argument, never
			// the binary, so the fixture binds the command name: a literal
			// `("git"` in a test source is the bare spawn
			// `tests/config/git-fixture-governance.test.ts` refuses.
			"a `git ls-files` spawner in the helper",
			'import { tracked } from "./helper.js";\nit("c", () => { tracked(ROOT); });',
			{
				"helper.ts":
					'import { execFileSync } from "node:child_process";\nconst BIN = "git";\nexport function tracked(dir) { return execFileSync(BIN, ["ls-files"], { cwd: dir }); }\n',
			},
		],
		[
			"a helper that runs git through its own local wrapper",
			'import { tracked } from "./helper.js";\nit("c", () => { tracked(ROOT); });',
			{
				"helper.ts":
					'import { spawnSync } from "node:child_process";\nconst BIN = "git";\nexport function tracked(dir) {\n\tconst run = (args) => spawnSync(BIN, args, { cwd: dir });\n\treturn run(["ls-files", "-z"]);\n}\n',
			},
		],
		[
			"a name the helper module does not export (fail closed)",
			'import { mystery } from "./helper.js";\nit("c", () => { mystery(ROOT); });',
			{ "helper.ts": QUIET_HELPER },
		],
		[
			"a relative module with nothing behind it (fail closed)",
			'import { walkHere } from "./gone.js";\nit("c", () => { walkHere(ROOT); });',
			{},
		],
		[
			// Absent-name arm one module down: `other.ts` exports `countUpTo`, not
			// `fromOther`, so the helper's own import is unresolvable.
			"a name a helper imports that its source does not export (fail closed)",
			'import { fromHelper } from "./helper.js";\nit("c", () => { fromHelper(ROOT); });',
			{
				"helper.ts":
					'import { fromOther } from "./other.js";\nexport function fromHelper(dir) { return fromOther(dir); }\n',
				"other.ts": QUIET_HELPER,
			},
		],
		[
			// #5430 review F5: a real cycle, `a` and `b` import each other, and the
			// walk sits on the far side. The fixed point converges to `walks`.
			"a module cycle whose far side walks",
			'import { fromA } from "./a.js";\nit("c", () => { fromA(ROOT); });',
			{
				"a.ts":
					'import { fromB } from "./b.js";\nexport function fromA(dir) { return fromB(dir); }\nexport function quietA(n) { return n; }\n',
				"b.ts":
					'import { quietA } from "./a.js";\nexport function fromB(dir) { quietA(1); return listSourceFiles(dir); }\n',
			},
		],
		[
			// #5430 review F4: a helper that walks through its own namespace import
			// of another `tests/` module (`readShape`'s namespace-member arm).
			"a helper that walks through a namespace member of another helper",
			'import { outer } from "./helper.js";\nit("c", () => { outer(ROOT); });',
			{
				"helper.ts":
					'import * as inner from "./inner.js";\nexport function outer(dir) { return inner.walkHere(dir); }\n',
				"inner.ts": WALKING_HELPER,
			},
		],
		[
			// #5430 review F2: a default import takes the same verdict path as a
			// named one.
			"a default import of a walking default export",
			'import walk from "./helper.js";\nit("c", () => { walk(ROOT); });',
			{
				"helper.ts":
					"export default function (dir) { return listSourceFiles(dir); }\n",
			},
		],
		[
			"a default import of a walking binding exported as default",
			'import walk from "./helper.js";\nit("c", () => { walk(ROOT); });',
			{ "helper.ts": `${WALKING_HELPER}export default walkHere;\n` },
		],
		[
			"a default import beside a named one",
			'import walk, { countUpTo } from "./helper.js";\nit("c", () => { countUpTo(1); walk(ROOT); });',
			{
				"helper.ts": `${QUIET_HELPER}export default function (dir) { return listSourceFiles(dir); }\n`,
			},
		],
		[
			"a default import from a module with no default export (fail closed)",
			'import walk from "./helper.js";\nit("c", () => { walk(ROOT); });',
			{ "helper.ts": QUIET_HELPER },
		],
		[
			"a default import from a relative module with nothing behind it (fail closed)",
			'import walk from "./gone.js";\nit("c", () => { walk(ROOT); });',
			{},
		],
		[
			// #5430 review B1: a nested callback that binds the walked name does
			// not hide the case's own read of the suite binding.
			"a walked read beside a nested parameter of the same name",
			'import { walkHere } from "./helper.js";\nconst files = walkHere(ROOT);\nit("c", () => { expect(files.length).toBe(1); [1].map((files) => files); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a walked read beside a sibling block that binds the same name",
			'import { walkHere } from "./helper.js";\nconst files = walkHere(ROOT);\nit("c", () => { { const files = []; void files; } expect(files).toBeTruthy(); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a helper that walks through a default import of another helper",
			'import { outer } from "./helper.js";\nit("c", () => { outer(ROOT); });',
			{
				"helper.ts":
					'import inner from "./inner.js";\nexport function outer(dir) { return inner(dir); }\n',
				"inner.ts":
					"export default function (dir) { return listSourceFiles(dir); }\n",
			},
		],
		[
			// A parameter's default value is a read, not a binding: calling `f()`
			// evaluates it (the `ownerIndex()` default in tmp-fixture-hygiene).
			"a walked read in a parameter default",
			'import { walkHere } from "./helper.js";\nconst files = walkHere(ROOT);\nit("c", () => { const f = (x = files) => x; expect(f()).toBeTruthy(); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a walked read in a suite binding beside a nested parameter of the same name",
			'import { walkHere } from "./helper.js";\nconst files = walkHere(ROOT);\nconst keys = files.map((files) => files);\nit("c", () => { expect(keys).toBeTruthy(); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a walked binding destructured at describe scope",
			'import { walkHere } from "./helper.js";\ndescribe("s", () => {\n\tconst { files } = walkHere(ROOT);\n\tit("c", () => { expect(files.length).toBeGreaterThan(0); });\n});',
			{
				"helper.ts":
					"export function walkHere(dir) { return { files: listSourceFiles(dir) }; }\n",
			},
		],
		[
			"a walked binding destructured under a new name",
			'import { walkHere } from "./helper.js";\ndescribe("s", () => {\n\tconst { files: found } = walkHere(ROOT);\n\tit("c", () => { expect(found.length).toBeGreaterThan(0); });\n});',
			{
				"helper.ts":
					"export function walkHere(dir) { return { files: listSourceFiles(dir) }; }\n",
			},
		],
		[
			"a walked binding read through a derived binding",
			'import { walkHere } from "./helper.js";\ndescribe("s", () => {\n\tconst { files } = walkHere(ROOT);\n\tconst keys = files.map((f) => f);\n\tit("c", () => { expect(keys.length).toBeGreaterThan(0); });\n});',
			{
				"helper.ts":
					"export function walkHere(dir) { return { files: listSourceFiles(dir) }; }\n",
			},
		],
		[
			"a suite-scope wrapper around a walking helper",
			'import { walkHere } from "./helper.js";\nconst all = () => walkHere(ROOT);\nit("c", () => { expect(all()).toBeTruthy(); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"an unresolvable name the case only mentions",
			'import { mystery } from "./helper.js";\nit("c", () => { expect(typeof mystery).toBe("function"); });',
			{ "helper.ts": QUIET_HELPER },
		],
		[
			"a table of walked paths under `it.each`",
			'import { walkHere } from "./helper.js";\nit.each(walkHere(ROOT))("c", (file) => { expect(file).toBeTruthy(); });',
			{ "helper.ts": WALKING_HELPER },
		],
	])(
		"plants: refuses a default-budget census reached through %s",
		(_name, body, files) => {
			const found = plantCensuses(
				String(body),
				files as Record<string, string>,
			);
			expect(found.map((entry) => entry.title)).toEqual(['"c"']);
			expect(found[0]?.refused).toBe(true);
		},
	);

	it.each([
		[
			"a helper that does not walk",
			'import { countUpTo } from "./helper.js";\nit("c", () => { expect(countUpTo(1)).toBe(2); });',
			{ "helper.ts": QUIET_HELPER },
		],
		[
			"a type imported from a helper module",
			'import { countUpTo } from "./helper.js";\nimport { SomeType } from "./types.js";\nit("c", () => { expect(typeof SomeType).toBe("object"); });',
			{
				"helper.ts": QUIET_HELPER,
				"types.ts":
					"export interface SomeType { a: string }\nexport type B = string;\nexport class C {}\n",
			},
		],
		[
			"a quiet name reached through an `export *` shim",
			'import { countUpTo } from "./shim.js";\nit("c", () => { expect(countUpTo(1)).toBe(2); });',
			{
				"shim.ts": 'export * from "./helper.js";\n',
				"helper.ts": QUIET_HELPER,
			},
		],
		[
			"a same-file helper that binds the walked name itself",
			'import { walkHere } from "./helper.js";\nfunction collect(node) {\n\tconst files = [];\n\tfor (const item of node) files.push(item);\n\treturn files;\n}\nconst { files } = walkHere(ROOT);\nit("c", () => { expect(collect([1, 2])).toEqual([1, 2]); });',
			{
				"helper.ts":
					"export function walkHere(dir) { return { files: listSourceFiles(dir) }; }\n",
			},
		],
		[
			"a package import",
			'import { expectTypeOf } from "vitest";\nit("c", () => { expectTypeOf(1).toBeNumber(); });',
			{},
		],
		[
			"runtime source outside `tests/`",
			'import { clientWalker } from "../../clients/foo.js";\nit("c", () => { clientWalker(); });',
			{},
		],
		[
			"a case that binds the walked name itself",
			'import { walkHere } from "./helper.js";\nconst { files } = walkHere(ROOT);\nit("c", () => { const files = []; expect(files).toEqual([]); });',
			{
				"helper.ts":
					"export function walkHere(dir) { return { files: listSourceFiles(dir) }; }\n",
			},
		],
		[
			"a module cycle where neither side walks",
			'import { fromA } from "./a.js";\nit("c", () => { expect(fromA(1)).toBe(1); });',
			{
				"a.ts":
					'import { fromB } from "./b.js";\nexport function fromA(n) { return fromB(n); }\nexport function quietA(n) { return n; }\n',
				"b.ts":
					'import { quietA } from "./a.js";\nexport function fromB(n) { return quietA(n); }\n',
			},
		],
		[
			"a default import of a quiet default export",
			'import count from "./helper.js";\nit("c", () => { expect(count(1)).toBe(2); });',
			{ "helper.ts": "export default function (n) { return n + 1; }\n" },
		],
		[
			"a nested parameter that binds the walked name the case reads only there",
			'import { walkHere } from "./helper.js";\nconst files = walkHere(ROOT);\nit("c", () => { expect([1].map((files) => files)).toEqual([1]); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a default import of a quiet binding exported as default",
			'import count from "./helper.js";\nit("c", () => { expect(count(1)).toBe(2); });',
			{ "helper.ts": `${QUIET_HELPER}export default countUpTo;\n` },
		],
		[
			"a default import of a quiet named default function",
			'import count from "./helper.js";\nit("c", () => { expect(count(1)).toBe(2); });',
			{ "helper.ts": "export default function named(n) { return n + 1; }\n" },
		],
		[
			// The `tests/support/` facade pair: `x.ts` holds `export * from
			// "./x.mjs"`, and the twin order lists `x.ts` for `./x.mjs` first.
			"a quiet name behind a `.ts` facade of a `.mjs` module",
			'import { countUpTo } from "./helper.js";\nit("c", () => { expect(countUpTo(1)).toBe(2); });',
			{
				"helper.ts": 'export * from "./helper.mjs";\n',
				"helper.mjs": QUIET_HELPER,
			},
		],
		[
			"a quiet `.mts` helper behind a `.mjs` specifier",
			'import { countUpTo } from "./helper.mjs";\nit("c", () => { expect(countUpTo(1)).toBe(2); });',
			{ "helper.mts": QUIET_HELPER },
		],
		[
			"a nested lone parameter that binds the walked name",
			'import { walkHere } from "./helper.js";\nconst files = walkHere(ROOT);\nit("c", () => { expect([1].map(files => files)).toEqual([1]); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a loop binding of the walked name",
			'import { walkHere } from "./helper.js";\nconst files = walkHere(ROOT);\nit("c", () => { for (const files of [1]) expect(files).toBe(1); });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a catch binding of the walked name",
			'import { walkHere } from "./helper.js";\nconst files = walkHere(ROOT);\nit("c", () => { try { throw 1; } catch (files) { expect(files).toBe(1); } });',
			{ "helper.ts": WALKING_HELPER },
		],
		[
			"a walking helper named only in a comment",
			'import { walkHere } from "./helper.js";\nit("c", () => { /* walkHere(ROOT) */ expect(1).toBe(1); });',
			{ "helper.ts": WALKING_HELPER },
		],
	])("plants: admits a census through %s", (_name, body, files) => {
		expect(
			plantCensuses(String(body), files as Record<string, string>).map(
				(entry) => entry.title,
			),
		).toEqual([]);
	});

	// Recurrence (#4967): the helper verdicts are DERIVED, so nothing rots the
	// way a named list does — but the derivation itself can. This pins the audit
	// table of #4967: the helpers the detection audit read by hand, with the
	// verdict the audit recorded (12 name verdicts across 8 helper modules). A helper that stops walking, moves, or
	// changes its import path reds here, where a reader can re-read the body.
	// `no-walk` helpers are pinned too: a helper that starts walking joins the
	// census, and that must be a decision, not a surprise.
	const AUDITED_HELPERS: ReadonlyArray<{
		file: string;
		name: string;
		walk: "walks" | "quiet";
		why: string;
	}> = [
		{
			file: "tests/support/ast-census.ts",
			name: "censusSourceFiles",
			walk: "walks",
			why: "calls listSourceFiles per root",
		},
		{
			file: "tests/support/module-instance-scan.ts",
			name: "testSourceFiles",
			walk: "walks",
			why: "returns listSourceFiles(dir)",
		},
		{
			file: "tests/support/flake-shape-scan.ts",
			name: "testSourceFiles",
			walk: "walks",
			why: "module-local twin: returns listSourceFiles(dir)",
		},
		{
			file: "tests/support/session-state-scan.ts",
			name: "clientSourceFiles",
			walk: "walks",
			why: "returns listSourceFiles(dir)",
		},
		{
			file: "tests/support/vacuous-skip-scan.ts",
			name: "listTestFiles",
			walk: "walks",
			why: "returns listSourceFiles(tests)",
		},
		{
			file: "tests/support/vitest-setup.ts",
			name: "untrackedUnignoredEntries",
			walk: "walks",
			why: "spawns git ls-files",
		},
		{
			file: "tests/support/vitest-setup.ts",
			name: "unadmittedRepoRootEntries",
			walk: "walks",
			why: "calls untrackedUnignoredEntries in the same module",
		},
		{
			file: "tests/support/session-state-scan.ts",
			name: "scanScopeCellKeys",
			walk: "walks",
			why: "calls listSourceFiles per root",
		},
		{
			file: "tests/helpers/captured-runner-output.ts",
			name: "listCapturedOutputs",
			walk: "quiet",
			why: "one non-recursive readdirSync per captured runner id, which the census's own walker list does not count as a tree walk",
		},
		{
			file: "tests/support/vitest-setup.ts",
			name: "tmpHygieneExcludeLiveOwnerEntries",
			walk: "quiet",
			why: "a pure filter over the entries it is handed",
		},
		{
			file: "tests/support/availability-gate.ts",
			name: "analyzeAvailabilityUnits",
			walk: "quiet",
			why: "parses the source string it is handed",
		},
		{
			file: "tests/helpers/captured-runner-output.ts",
			name: "provenanceProblems",
			walk: "quiet",
			why: "validates the fixture object it is handed",
		},
	];
	it.each(AUDITED_HELPERS)(
		"the derived verdict of $name is $walk ($file)",
		({ file, name, walk }) => {
			const resolver = createResolver(CHECKOUT_SOURCES);
			expect(resolver.verdict(path.join(ROOT, file), name)).toBe(walk);
		},
	);

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
	it("keeps a win32-spelled helper module inside the tests/ tree (#4967)", () => {
		// `path.resolve` spells a win32 helper with backslashes and
		// `isWithinForm` compares forward slashes, so the raw host form read as
		// a boundary and every helper import went quiet. Pinned as text, so a
		// posix lane catches it too.
		const dir = "C:\\checkout\\tests";
		expect(underTestsForm(`${dir}\\config\\helper.ts`, dir)).toBe(true);
		expect(underTestsForm("C:\\checkout\\clients\\lsp.ts", dir)).toBe(false);
	});

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
			// Calibration 2026-11-08: 1,821 .test.ts files under tests/; half rounds to 855.
			assertNonEmptyScan("tests test files", files.length, 855);
			const flagged: string[] = [];
			let census = 0;
			// #4967: one resolver per run, so each helper module is parsed once, not
			// once per file that imports it.
			const resolver = createResolver(CHECKOUT_SOURCES);
			for (const { file, source } of readWalkedFiles(files)) {
				const rel = relativePosix(ROOT, file);
				const helpers = { file, resolver };
				const scanned = flagCensuses(rel, source, helpers);
				census += scanned.census;
				flagged.push(...scanned.flagged);
				// Shape 81: turn the loop once per file so each parsed native tree is
				// freed before the next file is parsed.
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			// Calibration 2026-11-08: 399 census tests under tests/ (158 in
			// tests/config, 241 outside it; 87 refused and admitted by the
			// baseline, every other one budgeted). Master's detector counts 259
			// on the same tree. The floor is the measured count, shrink-only: a
			// regression in binding propagation (measured 52 in tests/config)
			// drops the count and reds here, where a floor of 30 stayed green. A
			// root narrowed back to tests/config counts 158 and reds here.
			assertNonEmptyScan("tree census tests", census, 399);
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

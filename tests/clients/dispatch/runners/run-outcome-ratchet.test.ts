import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import type { SgNode } from "../../../../clients/deps/ast-grep-napi.js";
import {
	NODE_SPAWN_NAMES,
	SPAWN_NAMES as SEAM_SPAWN_NAMES,
} from "../../../support/spawn-cwd-scan.js";
import { TREE_WALK_TIMEOUT_MS } from "../../../support/test-timeout-scale.js";
import {
	auditRegistry,
	codeMatches,
	listSourceFiles,
	relativePosix,
} from "../../../support/sweep-kit.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const RUNNERS_DIR = fileURLToPath(
	new URL("../../../../clients/dispatch/runners", import.meta.url),
);
const CLIENTS_DIR = fileURLToPath(
	new URL("../../../../clients", import.meta.url),
);

/** Files in the runners directory that are not runner definitions. */
const NOT_A_RUNNER = new Set(["index.ts", "utils.ts"]);

/**
 * Every runner that does NOT yet route its spawn through `classifyRunOutcome`
 * carries a reason here (#1816). This is the population sweep, kept honest by
 * the test below: a new runner file that neither uses the primitive nor
 * appears here fails, and an entry that no longer matches a real file fails
 * too. Migrating the rest is #1737's strangler work, deliberately not this PR.
 */
const NOT_YET_ON_PRIMITIVE: Record<string, string> = {
	// No child process at all — there is no spawn outcome to classify.
	"ast-grep-literal-anchors.ts":
		"in-process rule-text prefilter, no child process",
	"ast-grep-napi.ts": "in-process NAPI analysis, no child process",
	"fact-rules.ts": "in-process FactRule pipeline, no child process",
	"lsp.ts": "language-server requests, no child process of its own",
	"tree-sitter.ts": "in-process tree-sitter parse, no child process",
	"yaml-rule-parser.ts": "in-process YAML rule evaluation, no child process",

	// Spawning runners that already consult the spawn outcome with their own
	// per-tool check. Correct today, not yet unified. #1737.
	"psscriptanalyzer.ts": "reads its own exit status; #1737 strangler",
	"spotbugs.ts": "reads its own exit status; #1737 strangler",
};

function runnerFiles(): string[] {
	return fs
		.readdirSync(RUNNERS_DIR)
		.filter((name) => name.endsWith(".ts") && !NOT_A_RUNNER.has(name))
		.sort();
}

function readRunner(name: string): string {
	return fs.readFileSync(path.join(RUNNERS_DIR, name), "utf8");
}

/** The primitive's modules, as runner-relative module paths. */
const PRIMITIVE_MODULES = new Set([
	"utils/spawn-outcome",
	"utils/tool-failure",
]);
const PRIMITIVE_BASENAMES = new Set(
	[...PRIMITIVE_MODULES].map((module) => path.posix.basename(module)),
);
const SPAWNS = /safeSpawn/;

/**
 * The importer directory a relative primitive import resolves against.
 *
 * The runners scan keeps `runners` so its fixtures keep their existing
 * spellings; a census root (#5308) passes its own repo-relative directory, so
 * one resolver serves both instead of a second scanner next to this one.
 */
const RUNNER_IMPORT_ROOT = "runners";

/**
 * Map a resolved import path onto the runners-relative primitive module key.
 * `clients/dispatch/` is the primitive's home on disk, so a path that reaches
 * it from another directory (`../dispatch/runners/utils/spawn-outcome.js`
 * from `clients/lsp`) names the same module as `./utils/spawn-outcome.js`
 * from a runner. Stripping both prefixes keeps one key space.
 */
function primitiveModuleKey(resolved: string): string {
	return resolved.replace(/^clients\/dispatch\//, "").replace(/^runners\//, "");
}

/** A string or substitution-free template's value; anything else is opaque. */
function literalValue(node: SgNode): string | undefined {
	if (node.kind() === "string") return node.text().slice(1, -1);
	if (
		node.kind() === "template_string" &&
		!node.children().some((child) => child.kind() === "template_substitution")
	) {
		return node.text().slice(1, -1);
	}
	return undefined;
}

/**
 * How a runner reaches the primitive (#4429: the scan fails closed).
 *
 * The needle is every string literal in code whose last path segment, minus
 * its extension, names a primitive module (`spawn-outcome`, `tool-failure`).
 * Classified forms, decided from the AST:
 *
 * - the source of a static `import { … }` that resolves to the module from
 *   the runners directory (any relative spelling or extension). Each
 *   specifier is then classified against the module's own exports, read from
 *   its AST: an imported interface or type alias is a TYPE (a type cannot
 *   classify an outcome); an imported function, class, variable or enum is
 *   a VALUE.
 * - the runner USES the primitive only when it calls a value it imported this
 *   way somewhere outside the import and outside a type position. An import
 *   alone is not evidence that the runner classifies its spawn result; the
 *   call requirement closes that false admission (#4540 F-4540-3). A
 *   `type`-marked specifier needs no rule of its own: TypeScript admits it
 *   only in type positions.
 *
 * Every other needle hit (a namespace or default import, a bare side-effect
 * import, `export … from`, a dynamic `import()` or `require`, a specifier
 * that does not resolve to the module, an imported name the module does not
 * declare as a value or a type, or the name in a data string) is an
 * UNCLASSIFIED spelling, reported with its file and line, never skipped and
 * never counted as use. A comment or string quoting an import is not a node.
 */
/** Where a reference to an imported value is not a runtime use of it. */
const NON_USE_CONTEXTS: ReadonlySet<string> = new Set([
	"export_specifier",
	"import_statement",
	"type_query",
]);

export function primitiveUse(
	file: string,
	source: string,
	resolveDir = RUNNER_IMPORT_ROOT,
): { uses: boolean; unclassified: string[] } {
	const result = { uses: false, unclassified: [] as string[] };
	const lines = source.split("\n");
	const root = parse(Lang.TypeScript, source).root();
	const valueLocals = new Set<string>();
	const report = (node: SgNode) => {
		const line = node.range().start.line + 1;
		result.unclassified.push(
			`unclassified spelling at ${file}:${line}: ${lines[line - 1]?.trim() ?? ""}`,
		);
	};
	const literals = root.findAll({
		rule: { any: [{ kind: "string" }, { kind: "template_string" }] },
	});
	for (const literal of literals) {
		const value = literalValue(literal);
		if (value === undefined) continue;
		const stem = path.posix.basename(value).replace(/\.[cm]?[jt]s$/, "");
		if (!PRIMITIVE_BASENAMES.has(stem)) continue;
		const imported = importedSpecifiers(literal, value, resolveDir);
		if (imported === undefined) {
			report(literal);
			continue;
		}
		for (const specifier of imported.specifiers) {
			const kind = primitiveExports(imported.module).get(specifier.name);
			if (kind === "value") valueLocals.add(specifier.local);
			else if (kind === undefined) report(literal);
		}
	}
	result.uses = root
		.findAll({ rule: { kind: "call_expression" } })
		.some((call) => {
			const callee = call.namedChildren()[0];
			return (
				callee !== undefined &&
				valueLocals.has(callee.text()) &&
				!call.ancestors().some((up) => NON_USE_CONTEXTS.has(String(up.kind())))
			);
		});
	return result;
}

/** The specifiers of a static named import of a primitive module, or undefined. */
function importedSpecifiers(
	literal: SgNode,
	value: string,
	resolveDir = RUNNER_IMPORT_ROOT,
):
	| {
			module: string;
			specifiers: { name: string; local: string }[];
	  }
	| undefined {
	const statement = literal.parent();
	if (statement?.kind() !== "import_statement") return undefined;
	if (!value.startsWith(".")) return undefined;
	const module = primitiveModuleKey(
		path.posix
			.normalize(path.posix.join(resolveDir, value))
			.replace(/\.[cm]?[jt]s$/, ""),
	);
	if (!PRIMITIVE_MODULES.has(module)) return undefined;
	const clause = statement.children().find((c) => c.kind() === "import_clause");
	const parts = clause?.namedChildren() ?? [];
	if (parts.length !== 1 || parts[0].kind() !== "named_imports")
		return undefined;
	return {
		module,
		specifiers: parts[0]
			.namedChildren()
			.filter((child) => child.kind() === "import_specifier")
			.map((specifier) => {
				const name = specifier.field("name")?.text() ?? "";
				return {
					name,
					local: specifier.field("alias")?.text() ?? name,
				};
			}),
	};
}

const VALUE_DECLARATIONS = new Set([
	"abstract_class_declaration",
	"class_declaration",
	"enum_declaration",
	"function_declaration",
	"generator_function_declaration",
	"lexical_declaration",
	"variable_declaration",
]);
const TYPE_DECLARATIONS = new Set([
	"interface_declaration",
	"type_alias_declaration",
]);

const exportsByModule = new Map<string, Map<string, "value" | "type">>();

/**
 * Each primitive module's exported names, by kind, read from its source. An
 * export form this does not read (`export { x }`, `export *`) adds no name,
 * so a runner importing through it reports unclassified rather than passing.
 */
function primitiveExports(module: string): Map<string, "value" | "type"> {
	const cached = exportsByModule.get(module);
	if (cached) return cached;
	const source = fs.readFileSync(
		path.join(RUNNERS_DIR, `${module}.ts`),
		"utf8",
	);
	const kinds = new Map<string, "value" | "type">();
	for (const statement of parse(Lang.TypeScript, source)
		.root()
		.findAll({ rule: { kind: "export_statement" } })) {
		const declaration = statement.field("declaration");
		if (!declaration) continue;
		const kind = String(declaration.kind());
		if (TYPE_DECLARATIONS.has(kind)) {
			const name = declaration.field("name")?.text();
			if (name) kinds.set(name, "type");
		} else if (VALUE_DECLARATIONS.has(kind)) {
			const names = declaration.field("name")
				? [declaration.field("name")?.text()]
				: declaration
						.findAll({ rule: { kind: "variable_declarator" } })
						.map((declarator) => declarator.field("name")?.text());
			for (const name of names) if (name) kinds.set(name, "value");
		}
	}
	exportsByModule.set(module, kinds);
	return kinds;
}

export function usesPrimitive(source: string): boolean {
	return primitiveUse("fixture.ts", source).uses;
}

describe("run-outcome primitive ratchet", () => {
	it("every runner either uses the primitive or carries a reason", () => {
		const unlisted = runnerFiles().filter(
			(name) => !usesPrimitive(readRunner(name)) && !NOT_YET_ON_PRIMITIVE[name],
		);
		expect(
			unlisted,
			"add these to NOT_YET_ON_PRIMITIVE with a reason, or route them through classifyRunOutcome",
		).toEqual([]);
	});

	it("classifies every primitive-module reference in every runner (#4429)", () => {
		// Recurrence: #4411 review F3, a population scanner that skipped
		// spellings it did not recognise and passed silently.
		const unclassified = runnerFiles().flatMap(
			(name) => primitiveUse(name, readRunner(name)).unclassified,
		);
		expect(unclassified).toEqual([]);
	});

	it("carries no stale exemptions", () => {
		const present = new Set(runnerFiles());
		const stale = Object.keys(NOT_YET_ON_PRIMITIVE).filter(
			(name) => !present.has(name),
		);
		expect(stale, "these files no longer exist").toEqual([]);
	});

	it("does not exempt a runner that already migrated", () => {
		const migrated = Object.keys(NOT_YET_ON_PRIMITIVE).filter(
			(name) => present(name) && usesPrimitive(readRunner(name)),
		);
		expect(migrated, "drop these exemptions").toEqual([]);
	});

	function present(name: string): boolean {
		return fs.existsSync(path.join(RUNNERS_DIR, name));
	}

	// The nine #1816 migrated, plus phpstan, which #1948 pulled onto the
	// primitive while closing the parsed-nothing hole. Pinning them by name
	// means a revert cannot pass by quietly adding an exemption instead.
	it("pins the runners already on the primitive", () => {
		for (const name of [
			"biome-check.ts",
			"go-vet.ts",
			"oxlint.ts",
			"phpstan.ts",
			"pyright.ts",
			"shellcheck.ts",
			"markdownlint.ts",
			"mypy.ts",
			"spellcheck.ts",
			"sqlfluff.ts",
			"stylelint.ts",
			"swiftlint.ts",
			"vale.ts",
			"yamllint.ts",
			"dart-analyze.ts",
			"elixir-check.ts",
			"cpp-check.ts",
			"zig-check.ts",
			"rubocop.ts",
			"ruff.ts",
			"eslint.ts",
			"golangci-lint.ts",
			"ktlint.ts",
			"php-lint.ts",
			// #5411: their timeout verdict comes from the primitive.
			"helm-lint.ts",
			"helm-render.ts",
			"rust-clippy.ts",
		]) {
			expect(usesPrimitive(readRunner(name)), `${name}`).toBe(true);
			expect(NOT_YET_ON_PRIMITIVE[name]).toBeUndefined();
		}
	});

	it("every exempted spawning runner still reads its spawn outcome", () => {
		const blind = Object.keys(NOT_YET_ON_PRIMITIVE).filter((name) => {
			const source = readRunner(name);
			// Code only (#4429): a comment naming `safeSpawn` or `.status` is not
			// a spawn or an outcome read.
			if (codeMatches(source, SPAWNS).length === 0) return false;
			return (
				codeMatches(
					source.replace(/status:\s*"[a-z]+"/g, ""),
					/\.(status|error)\b/,
				).length === 0
			);
		});
		expect(blind, "these runners are exit-blind and must be migrated").toEqual(
			[],
		);
	});

	it("reports a primitive-module spelling it cannot classify (#4429)", () => {
		// The fail-closed branch: each of these reaches a primitive module in a
		// form the scan does not classify, so it reds with its line instead of
		// passing as use or skipping.
		const source = [
			'import { finishParsedRun } from "./utils/tool-failure.js";',
			'import * as outcome from "./utils/spawn-outcome.js";',
			'export { parseToolRun } from "./utils/tool-failure.js";',
			'const lazy = await import("./utils/spawn-outcome.js");',
			'import { parseToolRun } from "./utils/tool-failure-legacy.js";',
			'import { classifyOutcomeV2 } from "./utils/spawn-outcome.js";',
			"return finishParsedRun(input);",
		].join("\n");
		expect(primitiveUse("fake.ts", source)).toEqual({
			uses: true,
			unclassified: [
				'unclassified spelling at fake.ts:2: import * as outcome from "./utils/spawn-outcome.js";',
				'unclassified spelling at fake.ts:3: export { parseToolRun } from "./utils/tool-failure.js";',
				'unclassified spelling at fake.ts:4: const lazy = await import("./utils/spawn-outcome.js");',
				'unclassified spelling at fake.ts:6: import { classifyOutcomeV2 } from "./utils/spawn-outcome.js";',
			],
		});
	});

	it("does not count a type-only import as use (#4429)", () => {
		// The regex scan read `import { type X }` as use; round 1 still read an
		// unmarked `import { ToolExitCodes }` (an interface) as use (#4457
		// review F4). Kind comes from the module's own exports.
		for (const source of [
			'import { type ToolExitCodes } from "./utils/spawn-outcome.js";\nconst c: ToolExitCodes = codes;',
			'import type { ToolExitCodes } from "./utils/spawn-outcome.js";\nconst c: ToolExitCodes = codes;',
			'import { ToolExitCodes } from "./utils/spawn-outcome.js";\nconst c: ToolExitCodes = codes;',
			'import { ParsedToolRun as Run } from "./utils/tool-failure.js";\nlet r: Run;',
			// A value referenced only in a type position classifies nothing.
			'import { type classifyRunOutcome } from "./utils/spawn-outcome.js";\ntype Classify = typeof classifyRunOutcome;',
			'import { classifyRunOutcome } from "./utils/spawn-outcome.js";\nlet c: typeof classifyRunOutcome;',
		]) {
			expect(primitiveUse("fake.ts", source), source).toEqual({
				uses: false,
				unclassified: [],
			});
		}
		expect(
			usesPrimitive(
				'import { type ToolExitCodes, parseToolRun } from "../runners/utils/tool-failure.ts";\nparseToolRun(input);',
			),
		).toBe(true);
	});

	it("counts only a classifier call, not an import-only plant (#4429)", () => {
		// Recurrence: an import-only plant must not satisfy the ratchet. A
		// renamed value is admitted only when the runner actually calls it.
		expect(
			usesPrimitive('import { parseToolRun } from "./utils/tool-failure.js";'),
		).toBe(false);
		expect(
			usesPrimitive(
				'import { parseToolRun } from "./utils/tool-failure.js";\nexport { parseToolRun };',
			),
		).toBe(false);
		expect(
			usesPrimitive(
				'import { classifyRunOutcome as classify } from "./utils/spawn-outcome.js";\nconst o = classify(input);',
			),
		).toBe(true);
	});

	it("ignores an unclassifiable spelling inside a comment or a string (#4429)", () => {
		expect(
			primitiveUse(
				"fake.ts",
				[
					'// import * as outcome from "./utils/spawn-outcome.js";',
					"const prose = `import * as outcome from './utils/spawn-outcome.js'`;",
				].join("\n"),
			),
		).toEqual({ uses: false, unclassified: [] });
	});

	it("does not count a commented-out primitive import", () => {
		expect(
			usesPrimitive(
				'// import { classifyRunOutcome } from "./utils/tool-failure.js"',
			),
		).toBe(false);
		expect(
			usesPrimitive(
				'import { classifyRunOutcome } from "./utils/spawn-outcome.js";\nclassifyRunOutcome(input);',
			),
		).toBe(true);
		expect(
			usesPrimitive(
				"const prose = \"import { classifyRunOutcome } from './utils/tool-failure.js'\";",
			),
		).toBe(false);
		expect(
			usesPrimitive(
				"const prose = `import { classifyRunOutcome } from './utils/tool-failure.js'`;",
			),
		).toBe(false);
		expect(
			usesPrimitive(
				'// import { classifyRunOutcome } from "./utils/tool-failure.js"\n' +
					"const prose = \"import { classifyRunOutcome } from './utils/tool-failure.js'\";",
			),
		).toBe(false);
	});
});

describe("shared cascade TTL", () => {
	// #1816: two modules each declared their own 240_000. A split pair reads as
	// two independent policies and drifts.
	it("is declared exactly once", () => {
		const declarations: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (entry.name.endsWith(".ts")) {
					const source = fs.readFileSync(full, "utf8");
					if (/CASCADE_[A-Z_]*TTL_MS\s*=\s*240_000/.test(source)) {
						declarations.push(path.relative(CLIENTS_DIR, full));
					}
				}
			}
		};
		walk(CLIENTS_DIR);
		expect(declarations).toEqual(["cascade-types.ts"]);
	});
});

/* ------------------------------------------------------------------ *
 * Spawn sites outside the dispatch runners (#5308)
 * ------------------------------------------------------------------ */

// The plant sources name the two spawn modules they import. The flake-shape
// `real-process-spawn` detector keeps string contents when it reads a test
// file, so a fixture that spells a `require` of the child-process module on one
// line counts as a child this test starts. Interpolating the module id leaves
// one line in the file that spells it, and the census parses the assembled
// plant exactly as it parses a real one.
const CHILD_MODULE = '"node:child_process"';
const SEAM_MODULE = '"../clients/safe-spawn.js"';

/**
 * The roots beyond `clients/dispatch/runners` that spawn child processes:
 * the CI/governance scripts and the LSP client stack. The #1816 primitive
 * ratchet in this file enumerates the runner directory, and the sibling
 * `tests/config/spawn-chokepoint-sweep.test.ts` enumerates `clients`, `tools`
 * and `mcp` for a different question (which chokepoint a raw `spawn(` goes
 * through). Neither asked whether a failed child is read as a failure or as an
 * empty result, and no layer enumerated `scripts/` at all (#5308).
 */
const SPAWN_CENSUS_ROOTS = ["clients/lsp", "scripts"] as const;

/** Modules whose exports start child processes, by basename stem. */
const CHILD_MODULE_STEMS = new Set(["child_process"]);
const SAFE_SPAWN_MODULE_STEMS = new Set(["safe-spawn"]);
// One vocabulary (#2927): the spawn names belong to
// `tests/support/spawn-cwd-scan.ts`, not to this census. Deriving them here is
// what keeps a name added there from being invisible on this side — the #2902
// probe added a name to that tuple and 140 sweep tests stayed green because the
// population predicate carried its own copy.
const SPAWN_NAMES: Record<"child" | "safe", ReadonlySet<string>> = {
	child: new Set<string>(NODE_SPAWN_NAMES),
	safe: new Set<string>(SEAM_SPAWN_NAMES),
};
/** The forms that throw on a nonzero exit or a signal instead of returning. */
const THROWING_SPAWN_NAMES = new Set(["execFile", "execFileSync", "execSync"]);
/** Reading any of these means a failure cannot read as an empty result. */
const OUTCOME_FIELD = /\.(status|exitCode|killed|signal|error|code)\b/;

interface SpawnSite {
	line: number;
	/** The spawn function the call reaches, after alias resolution. */
	name: string;
	/** How the name reaches the call: direct, through an alias, or a hand-off. */
	via: "call" | "hand-off" | "namespace";
}

interface SpawnScan {
	sites: SpawnSite[];
	unclassified: string[];
}

/** The local spelling of a module specifier's quoted source. */
function specifierValue(literal: SgNode): string {
	return literal.text().slice(1, -1);
}

/**
 * Two ast-grep handles for the same node are not `===`; compare node ids.
 */
function sameNode(
	a: SgNode | null | undefined,
	b: SgNode | null | undefined,
): boolean {
	return a != null && b != null && a.id() === b.id();
}

/** Which spawn family a module specifier names, or undefined. */
function spawnModuleFamily(value: string): "child" | "safe" | undefined {
	// `node:child_process` and a relative `../safe-spawn.js` name the same
	// modules, so strip the URL scheme and the extension before the stem.
	const stem = path.posix
		.basename(value)
		.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, "")
		.replace(/\.[cm]?[jt]s$/, "");
	if (CHILD_MODULE_STEMS.has(stem)) return "child";
	if (SAFE_SPAWN_MODULE_STEMS.has(stem)) return "safe";
	return undefined;
}

/**
 * Every place a file can start a child process (#5308).
 *
 * `safeSpawn` is not one name: a site reaches a child through `spawn`,
 * `spawnSync`, `exec`, `execFile`, `execFileSync`, `execSync`, `fork`, or the
 * `safeSpawn*` wrappers, under any local spelling. The scan resolves the
 * import binding, the alias an injected default binds (`function run({ spawn
 * = spawnSync })`, `const run = deps.spawn ?? spawnSync`), the namespace
 * member (`cp.spawn(...)`), and a hand-off that passes the function into
 * another function in the same file. A spawn value it can see but cannot
 * follow — `require("node:child_process")`, a dynamic `import()`, a re-export
 * from a spawn module, a spawn value stored in an object literal — is an
 * UNCLASSIFIED spelling with its file and line, never a pass.
 */
/** Per-file scan state: the spawn bindings the scanner has resolved. */
interface SpawnBindings {
	/** Local name -> the spawn export it reaches. */
	spawnable: Map<string, string>;
	/** Namespace import locals (`import * as cp from "node:child_process"`). */
	namespaces: Set<string>;
}

/**
 * The static imports of a spawn module: named specifiers keep their local
 * spelling, a namespace import is recorded by its local, and a default import
 * is reported because the scan cannot see which spawn function it reaches.
 */
function collectSpawnBindings(
	root: SgNode,
	report: (node: SgNode, what: string) => void,
): SpawnBindings {
	const spawnable = new Map<string, string>();
	const namespaces = new Set<string>();
	for (const statement of root.findAll({
		rule: { kind: "import_statement" },
	})) {
		const literal = statement
			.children()
			.find((child) => child.kind() === "string");
		if (!literal) continue;
		const family = spawnModuleFamily(specifierValue(literal));
		if (!family) continue;
		const clause = statement
			.children()
			.find((child) => child.kind() === "import_clause");
		for (const part of clause?.namedChildren() ?? []) {
			if (part.kind() === "namespace_import") {
				const name =
					part.field("name")?.text() ??
					part
						.text()
						.replace(/^\*\s*as\s+/, "")
						.trim();
				if (name) namespaces.add(name);
				continue;
			}
			if (part.kind() !== "named_imports") {
				report(part, "default import of a spawn module");
				continue;
			}
			for (const specifier of part.namedChildren()) {
				if (specifier.kind() !== "import_specifier") continue;
				const imported = specifier.field("name")?.text() ?? "";
				if (!SPAWN_NAMES[family].has(imported)) continue;
				spawnable.set(specifier.field("alias")?.text() ?? imported, imported);
			}
		}
	}
	return { spawnable, namespaces };
}

/**
 * Spawn-module spellings the scan cannot open: `require`, a dynamic `import()`,
 * and a re-export. Each is reported, never skipped (#5308).
 */
function reportOpaqueSpawnModules(
	root: SgNode,
	report: (node: SgNode, what: string) => void,
): void {
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const args = call.children().find((child) => child.kind() === "arguments");
		const argument = args?.namedChildren()[0];
		if (argument?.kind() !== "string") continue;
		if (!spawnModuleFamily(specifierValue(argument))) continue;
		// `require` is an ordinary identifier; the dynamic `import()` keyword is
		// its own node kind.
		const callee = call.field("function");
		if (callee?.kind() === "identifier" && callee.text() === "require")
			report(call, "require of a spawn module");
		else if (callee?.kind() === "import" || callee?.text() === "import")
			report(call, "dynamic import of a spawn module");
	}
	for (const statement of root.findAll({
		rule: { kind: "export_statement" },
	})) {
		const literal = statement
			.children()
			.find((child) => child.kind() === "string");
		if (literal && spawnModuleFamily(specifierValue(literal)))
			report(statement, "re-export from a spawn module");
	}
}

/** The spawn export a bound value reaches, through `x` or `dep ?? x`. */
function aliasedSpawnName(
	node: SgNode,
	spawnable: Map<string, string>,
): string | undefined {
	if (node.kind() === "identifier") return spawnable.get(node.text());
	if (node.kind() !== "binary_expression") return undefined;
	const fallback = node
		.children()
		.some((child) => child.text() === "??" || child.text() === "||");
	if (!fallback) return undefined;
	for (const operand of node.namedChildren()) {
		const reached = aliasedSpawnName(operand, spawnable);
		if (reached) return reached;
	}
	return undefined;
}

/** The node kinds that name a binding target for a spawn alias. */
const BINDING_TARGET_KINDS = new Set([
	"identifier",
	"shorthand_property_identifier",
	"shorthand_property_identifier_pattern",
]);

/**
 * Close the alias loop: an injected or reassigned spawn binding is still a
 * spawn binding (`function run({ spawn = spawnSync })`,
 * `const run = deps.spawn ?? spawnSync`). Iterates to a fixpoint so a chain
 * (`a = spawn; b = a`) resolves.
 */
function closeSpawnAliasLoop(
	root: SgNode,
	spawnable: Map<string, string>,
): void {
	for (let round = 0; round < 4; round++) {
		let added = false;
		for (const node of root.findAll({
			rule: {
				any: [
					{ kind: "variable_declarator" },
					{ kind: "assignment_pattern" },
					{ kind: "object_assignment_pattern" },
				],
			},
		})) {
			const target = node.field("left") ?? node.field("name");
			const value = node.field("right") ?? node.field("value");
			// A destructured parameter default binds through a shorthand pattern
			// node (`{ spawn = spawnSync }`), not a plain identifier.
			if (!target || !value || !BINDING_TARGET_KINDS.has(String(target.kind())))
				continue;
			const name = target.text();
			if (spawnable.has(name)) continue;
			const reached = aliasedSpawnName(value, spawnable);
			if (!reached) continue;
			spawnable.set(name, reached);
			added = true;
		}
		if (!added) return;
	}
}

/**
 * A reference in a binding position: the alias loop owns it. Both sides count.
 * The right (the spawn value being aliased) is how the binding was made, and
 * the left (the name being bound) is a fresh local that shadows anything the
 * file's other functions call by the same name — a parameter named `exec` is
 * not a use of the `exec` another function defaults to `execFileSync`.
 */
function isBindingPosition(node: SgNode): boolean {
	const parent = node.parent();
	if (!parent) return false;
	if (
		(parent.kind() === "assignment_pattern" ||
			parent.kind() === "object_assignment_pattern") &&
		(sameNode(parent.field("right"), node) ||
			sameNode(parent.field("left"), node))
	)
		return true;
	if (
		parent.kind() === "variable_declarator" &&
		(sameNode(parent.field("value"), node) ||
			sameNode(parent.field("name"), node))
	)
		return true;
	return parent.kind() === "binary_expression" && isBindingPosition(parent);
}

/**
 * Every place a file can start a child process (#5308).
 *
 * `safeSpawn` is not one name: a site reaches a child through `spawn`,
 * `spawnSync`, `exec`, `execFile`, `execFileSync`, `execSync`, `fork`, or the
 * `safeSpawn*` wrappers, under any local spelling. The scan resolves the
 * import binding, the alias an injected default binds (`function run({ spawn
 * = spawnSync })`, `const run = deps.spawn ?? spawnSync`), the namespace
 * member (`cp.spawn(...)`), and a hand-off that passes the function to
 * another function in the same file. A spawn value it can see but cannot
 * follow — stored in an object literal or an array, returned, or reached
 * through `require`, a dynamic `import()`, or a re-export — is an
 * UNCLASSIFIED spelling with its file and line, never a pass.
 */
function spawnOutcomeScan(file: string, source: string): SpawnScan {
	const lang: Lang = /\.m?ts$/.test(file) ? Lang.TypeScript : Lang.JavaScript;
	const root = parse(lang, source).root();
	const lines = source.split("\n");
	const unclassified: string[] = [];
	const report = (node: SgNode, what: string) => {
		const line = node.range().start.line + 1;
		unclassified.push(
			`unclassified spawn spelling at ${file}:${line} (${what}): ` +
				`${lines[line - 1]?.trim() ?? ""}`,
		);
	};
	const bindings = collectSpawnBindings(root, report);
	reportOpaqueSpawnModules(root, report);
	closeSpawnAliasLoop(root, bindings.spawnable);

	const sites: SpawnSite[] = [];
	for (const id of root.findAll({ rule: { kind: "identifier" } })) {
		const text = id.text();
		const bound = bindings.spawnable.get(text);
		const isNamespace = bindings.namespaces.has(text);
		if (!bound && !isNamespace) continue;
		const parent = id.parent();
		const kind = String(parent?.kind());
		// The import declaration itself, and a `typeof safeSpawnAsync` type
		// position, do not start a child process.
		// A bare parameter is its own binding: in the JavaScript grammar a plain
		// parameter is an `identifier` directly under `formal_parameters`, so a
		// function's `exec` parameter is a fresh local, not the `exec` another
		// function defaults to `execFileSync`. Only its CALL counts.
		if (
			kind === "import_specifier" ||
			kind === "import_statement" ||
			kind === "formal_parameters" ||
			kind === "type_query"
		)
			continue;
		if (isBindingPosition(id)) continue;
		const namespaceSite = namespaceMemberCall(id, isNamespace, report);
		if (namespaceSite !== undefined) {
			if (namespaceSite) sites.push(namespaceSite);
			continue;
		}
		if (!bound) {
			report(id, "spawn namespace import outside a spawn call");
			continue;
		}
		if (kind === "call_expression" && sameNode(parent?.field("function"), id)) {
			sites.push({ line: id.range().start.line + 1, name: bound, via: "call" });
			continue;
		}
		if (kind === "arguments") {
			// The function is handed to a callee that invokes it in this file.
			sites.push({
				line: id.range().start.line + 1,
				name: bound,
				via: "hand-off",
			});
			continue;
		}
		report(id, `spawn value reached through a "${kind}" position`);
	}
	return { sites, unclassified };
}

/**
 * Classify a namespace-import reference (`cp.spawn(...)`). Returns a site,
 * `undefined` when the node is not a namespace member at all, or `null` when
 * it is one the scan has reported.
 */
function namespaceMemberCall(
	id: SgNode,
	isNamespace: boolean,
	report: (node: SgNode, what: string) => void,
): SpawnSite | undefined | null {
	if (!isNamespace) return undefined;
	const member = id.parent();
	if (
		!member ||
		String(member.kind()) !== "member_expression" ||
		!sameNode(member.field("object"), id)
	)
		return null;
	const call = member.parent();
	const methodName = member.field("property")?.text() ?? "";
	if (
		call?.kind() !== "call_expression" ||
		!sameNode(call.field("function"), member)
	) {
		report(id, "namespace spawn import outside a call");
		return null;
	}
	const line = call.range().start.line + 1;
	if (!SPAWN_NAMES.child.has(methodName)) {
		report(id, `namespace member call of "${methodName}"`);
		return null;
	}
	return { line, name: methodName, via: "namespace" };
}

/** Every census-root source file, repo-relative, compiled twins excluded. */
function censusSourceFiles(rootRelative: string): string[] {
	const absolute = path.join(REPO_ROOT, rootRelative);
	return listSourceFiles(absolute, {
		extensions: [".ts", ".mts", ".mjs", ".cjs", ".js"],
		// An in-place compiled `.js` twin of a `.ts` source is the same site.
		exclude: (relative) =>
			relative.endsWith(".js") &&
			fs.existsSync(path.join(absolute, relative.replace(/\.js$/, ".ts"))),
	}).map((full) => relativePosix(REPO_ROOT, full));
}

interface CensusRow {
	file: string;
	dir: string;
	source: string;
	sites: SpawnSite[];
	unclassified: string[];
	usesPrimitive: boolean;
}

let censusCache: CensusRow[] | undefined;

/** The census is a read-only scan of the tree, so one walk per worker fork. */
function census(): CensusRow[] {
	censusCache ??= censusRows();
	return censusCache;
}

function censusRows(): CensusRow[] {
	const rows: CensusRow[] = [];
	for (const root of SPAWN_CENSUS_ROOTS) {
		for (const file of censusSourceFiles(root)) {
			const dir = path.posix.dirname(file);
			const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
			const scan = spawnOutcomeScan(file, source);
			const use = primitiveUse(file, source, dir);
			if (scan.sites.length === 0 && scan.unclassified.length === 0) continue;
			rows.push({
				file,
				dir,
				source,
				sites: scan.sites,
				unclassified: scan.unclassified,
				usesPrimitive: use.uses,
			});
		}
	}
	return rows.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Every census site outside the dispatch runners that does not route through
 * `classifyRunOutcome`, with why its failure still cannot read as clean.
 * `auditRegistry` keeps the table honest: a new spawn file that is neither
 * migrated nor listed fails, and a row whose file has migrated or gone away
 * fails as a stale exemption.
 */
const OUT_OF_TREE_SPAWN_BASELINE: Record<string, string> = {
	// clients/lsp: 4 spawn-capable files, 10 sites. Each row is the population
	// #5308 brought in from outside the dispatch runners: none routes through
	// the primitive yet, so each states the channel through which a failed
	// child still reaches the file.
	"clients/lsp/client.ts":
		"the Windows taskkill tree-killer: reads exitCode/signal/killed/status on the killer, never treats absence of a result as a kill; #1737",
	"clients/lsp/jvm-runtime.ts":
		"java locator: reads error/status on safeSpawnAsync, so a failed locator is not a usable JVM; #1737",
	"clients/lsp/launch.ts":
		"probes each candidate server and reads status/error/killed/exitCode before choosing one, so a dead probe is not a working server; #1737",
	"clients/lsp/server.ts":
		"reads code/error on each safeSpawnAsync outcome before it treats an update as applied; #1737",
	// scripts: 73 spawn-capable files, 142 sites. Same population and same
	// requirement as the `clients/lsp` rows above.
	"scripts/audit-prod-deps.mjs":
		"reads code,error,exitCode on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/backfill-github-releases.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/backfill-release-thanks.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/bench-snapshot-persist.mjs":
		"reads status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/benchmark-biome.ts":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/build-dist-tsc.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/bundle-dist.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/capture-runner-fixtures.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/capture-runner-output.mjs":
		"reads error,exitCode,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/check-ci-job-p90.mjs":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/check-close-keywords.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 (its catch returns a sentinel or an ok:false pair at lines 155,170,299)",
	"scripts/check-extensions.mjs":
		"execSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/check-grammar-corpus.mjs":
		"reads error,exitCode,signal,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/check-grammar-load.mjs":
		"reads error,signal,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/check-hot-path-latency.mjs":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/check-pr-body.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/check-tla-models.mjs":
		"reads error,exitCode,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/ci-changed-files.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/ci-shuffle-changed-tests.mjs":
		"reads code,error,exitCode,signal,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/ci-test-diff.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/ci-verdict.mjs":
		"reads code,error,exitCode,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/compat-contracts.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/compat-smoke-behavioral.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/download-test-history-artifacts.mjs":
		"reads error,exitCode,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/guard-bash-probe.mjs":
		"reads error,exitCode,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/install-selftest.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/lane-check.mjs":
		"reads error,exitCode,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/lib/astgrep-self-scan.mjs":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/lib/git-fixture-env.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/lib/knip-runner.mjs":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/lib/knip-sibling-purge.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/lib/lockfile-completeness.mjs":
		"reads status/error and maps ETIMEDOUT to its own failure reason, so the lockfile probe cannot report complete on a dead child; #1737",
	"scripts/lib/mcp-stdio-client.mjs":
		"reads error on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/lib/mutation-test-selection.mjs":
		"reads status and turns a nonzero probe into an explicit { unknown } reason, so an unrunnable probe is not a clean selection; #1737",
	"scripts/lib/process-scan.mjs":
		"reads code on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 (its catch returns a sentinel or an ok:false pair at line 754)",
	"scripts/lib/server-provenance.mjs":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 (its catch returns a sentinel or an ok:false pair at line 71)",
	"scripts/lib/test-history-selection.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/lib/test-runner-smoke.mjs":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/lint-js-advisory.mjs":
		"reads status/exitCode/error on the advisory lint run, so a lint child that dies is not a clean lint; #1737",
	"scripts/mutate.mjs":
		"reads code,error,exitCode,signal,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/notify-clean-signal-drift.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/notify-install-smoke-drift.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/notify-tool-smoke-red.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/npm-retry.mjs":
		"reads code,error,exitCode on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/playground-chrome.mjs":
		"reads error on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 (its catch returns a sentinel or an ok:false pair at lines 86,132,152,264)",
	"scripts/playground-verify-rule.mjs":
		"reads code,error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/pr-worktree.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/pre-push-targeted-tests.mjs":
		"reads code,error,exitCode,signal,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 (its catch returns a sentinel or an ok:false pair at line 902)",
	"scripts/probe-pi-host-tiers.mjs":
		"reads code,error,exitCode,signal,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/pr-preflight.mjs":
		"maps a check status to pass/inconclusive/FAIL and a missing status to 1, so a child that dies fails the preflight; #1737",
	"scripts/prune-actions-cache.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/prune-agent-worktrees.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 (its catch returns a sentinel or an ok:false pair at line 766)",
	"scripts/red-on-base.mjs":
		"reads error,exitCode,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/regen-test-baseline.mjs":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/release-qa.mjs":
		"reads error,exitCode,killed,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/resolve-newest-in-range-host.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/rpc-load-check.mjs":
		"reads code,error,signal on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/run-all-ts-rules-posthog.mjs":
		"execSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 (its catch returns a sentinel or an ok:false pair at line 43)",
	"scripts/run-harness.mjs":
		"reads error,exitCode,signal,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/run-ts-rules-pi-lens.mjs":
		"execSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/setup-git-hooks.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/smoke-availability-lifecycle.mjs":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/smoke-gitleaks-scratch-exclusion.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 (its catch returns a sentinel or an ok:false pair at line 102)",
	"scripts/smoke-psscriptanalyzer-classification.mjs":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/smoke-tools.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 (its catch returns a sentinel or an ok:false pair at lines 229,2126,2148)",
	"scripts/strictness-report.mjs":
		"reads error,exitCode,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/stryker-diff.mjs":
		"reads error,status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 (its catch returns a sentinel or an ok:false pair at line 271)",
	"scripts/trace-validate-session-lifecycle.mjs":
		"reads status on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/update-contributors.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/upsert-tracking-issue.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
	"scripts/with-memory-watch.mjs":
		"reads code on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/with-test-lock.mjs":
		"reads error,exitCode,killed on the spawn outcome, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737",
	"scripts/worktree-remove.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737",
};

/** The outcome fields a file reads, from its code (comments excluded). */
function outcomeFieldsRead(source: string): string[] {
	const matched = new Set<string>();
	for (const match of codeMatches(source, OUTCOME_FIELD))
		matched.add(match[0].slice(1));
	return [...matched].sort();
}

/**
 * Baseline rows whose file now routes through `classifyRunOutcome` (#5308):
 * the exemption is stale the moment the migration lands, whether or not the
 * file still spawns anything.
 */
function migratedSpawnRows(
	rows: CensusRow[],
	baseline: Record<string, string>,
): string[] {
	const primitiveFiles = new Set(
		rows.filter((row) => row.usesPrimitive).map((row) => row.file),
	);
	return Object.keys(baseline).filter((file) => primitiveFiles.has(file));
}

describe("spawn sites outside the dispatch runners (#5308)", () => {
	// The floors sit under the measured walk (clients/lsp and scripts each scan
	// over a hundred sources) so a file moving does not red, but a root dropping
	// out of the walk does: the whole population of that root falls at once.
	const SCANNED_FLOOR: Record<string, number> = {
		"clients/lsp": 20,
		scripts: 150,
	};
	// Measured 2026-11-12 through this seam: 77 files with 152 spawn sites
	// (clients/lsp 4 files / 10 sites, scripts 73 files / 142 sites), none on
	// the primitive. The floor sits under that so a file losing its spawn does
	// not red, but one root dropping out of the flagged population does.
	const FLAGGED_FLOOR = 70;

	// Every census below walks two whole subtrees, so each carries the shared
	// tree-walk budget (`tests/config/tree-census-timeout.test.ts` #4828).
	it(
		"censuses every source file under both roots (#5308)",
		() => {
			const thin = SPAWN_CENSUS_ROOTS.filter(
				(root) => censusSourceFiles(root).length < SCANNED_FLOOR[root],
			);
			expect(
				thin,
				`the census walk lost a root (${SPAWN_CENSUS_ROOTS.join(", ")}): ` +
					`${thin.join(", ")} scanned below its floor`,
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every spawn site outside the runners is classified or carries a reason (#5308)",
		() => {
			const rows = census();
			const audit = auditRegistry({
				sweepName: "run-outcome ratchet, out-of-tree spawn sites (#5308)",
				flagged: rows
					.filter((row) => !row.usesPrimitive)
					.map((row) => ({
						key: row.file,
						detail: `${row.sites.length} site(s): ${row.sites
							.map((site) => `${site.name}@${site.line}`)
							.join(", ")}`,
					})),
				registered: rows
					.filter((row) => row.usesPrimitive)
					.map((row) => row.file),
				exemptions: OUT_OF_TREE_SPAWN_BASELINE,
				scannedCount: SPAWN_CENSUS_ROOTS.reduce(
					(total, root) => total + censusSourceFiles(root).length,
					0,
				),
				minScanned: Object.values(SCANNED_FLOOR).reduce((a, b) => a + b, 0),
				minFlagged: FLAGGED_FLOOR,
				minReasonLength: 40,
			});
			expect(audit.problems, audit.problems.join("\n")).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"does not exempt a spawn file that has migrated onto the primitive (#5308)",
		() => {
			// The live census has no migrated file yet, so the rule is proven with a
			// planted migration: a row that routes through the primitive while still
			// carrying a baseline entry. The fix there is to delete the row and keep
			// the migration, not to re-baseline the primitive user.
			const planted: CensusRow[] = [
				{
					file: "scripts/planted.mjs",
					dir: "scripts",
					source: "",
					sites: [{ line: 1, name: "spawnSync", via: "call" }],
					unclassified: [],
					usesPrimitive: true,
				},
			];
			expect(
				migratedSpawnRows(planted, {
					"scripts/planted.mjs": "planted row; #1737",
				}),
			).toEqual(["scripts/planted.mjs"]);
			// A migrated row is reported whether or not it still spawns: the table
			// entry, not the scan, is what goes stale.
			expect(
				migratedSpawnRows([{ ...planted[0], sites: [] }], {
					"scripts/planted.mjs": "planted row; #1737",
				}),
			).toEqual(["scripts/planted.mjs"]);
			expect(migratedSpawnRows(census(), OUT_OF_TREE_SPAWN_BASELINE)).toEqual(
				[],
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every baselined spawn site can see its own failure (#5308)",
		() => {
			// The fault channel per form. `execFile`, `execFileSync`, and `execSync`
			// raise on a nonzero exit, on a signal kill, and on a spawn error, so the
			// failure travels to the caller as an exception. `spawn`, `spawnSync`,
			// `fork`, and the `safeSpawn*` wrappers RETURN, so the file has to read
			// status/exitCode/signal/killed/error off the result or nothing shows the
			// child failed at all. A file that neither throws nor reads is the
			// original defect: a dead child that reads as an empty clean run.
			// A catch that returns a sentinel (`null`, `ok: false`) is a deliberate
			// second channel, so this gate does not judge catch bodies; a site that
			// swallows into a bare empty value is a #1737 migration, not this ratchet.
			const blind = census()
				.filter((row) => row.sites.length > 0)
				// A file that routes the child through the primitive has its fault
				// channel there: `classifyRunOutcome` reads the status, the signal,
				// and the spawn error, so a migrated file is not blind.
				.filter((row) => !row.usesPrimitive)
				.filter(
					(row) =>
						row.sites.some((site) => !THROWING_SPAWN_NAMES.has(site.name)) &&
						outcomeFieldsRead(row.source).length === 0,
				)
				.map(
					(row) => `${row.file}: ${row.sites.map((s) => s.name).join(", ")}`,
				);
			expect(blind, "these files cannot see a failed child").toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"classifies every spawn-capable reference in both roots (#5308)",
		() => {
			// Fail closed (#4429's rule for a population scanner): a spawn-module
			// import the scanner cannot follow reds with its file and line.
			const unclassified = census().flatMap((row) => row.unclassified);
			expect(unclassified).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("counts an alias, an injected default, and a namespace member as a site (#5308)", () => {
		// Shape 69: a detector is proven against the spellings it does not get
		// from a name match. Each of these reaches a child process through a
		// binding, not through the imported name at the call. The command name is
		// a placeholder: `git` here would read as a real Git fixture to
		// `tests/config/git-fixture-governance.test.ts`, and this census starts no
		// child at all.
		const plants: [string, string[]][] = [
			[
				"import { spawnSync } from " +
					CHILD_MODULE +
					';\nconst run = spawnSync;\nrun("probe", ["run"]);',
				["spawnSync"],
			],
			[
				"import { spawnSync } from " +
					CHILD_MODULE +
					';\nfunction status({ spawn = spawnSync }) {\n\treturn spawn("probe", ["run"]);\n}\n' +
					"status({});",
				["spawnSync"],
			],
			[
				"import { spawnSync } from " +
					CHILD_MODULE +
					';\nconst run = deps.spawn ?? spawnSync;\nrun("probe", ["run"]);',
				["spawnSync"],
			],
			[
				"import * as cp from " +
					CHILD_MODULE +
					';\ncp.execFileSync("probe", ["run"]);',
				["execFileSync"],
			],
			[
				"import { execFileSync as runSync } from " +
					CHILD_MODULE +
					';\nrunSync("probe", ["run"]);',
				["execFileSync"],
			],
			[
				"import { safeSpawnAsync } from " +
					SEAM_MODULE +
					';\nawait safeSpawnAsync("probe", ["x.js"]);',
				["safeSpawnAsync"],
			],
			[
				// A hand-off: the function is invoked by the callee in this file.
				"import { spawn } from " + CHILD_MODULE + ';\nrunChild(spawn, ["x"]);',
				["spawn"],
			],
		];
		for (const [source, names] of plants) {
			const scan = spawnOutcomeScan("fixture.mjs", source);
			expect(
				scan.sites.map((site) => site.name),
				source,
			).toEqual(names);
			// The alias binding is neither a second site nor an unclassified
			// spelling: a spawn value the loop resolves is accounted for.
			expect(scan.unclassified, source).toEqual([]);
		}
	});

	it("reports a spawn-module spelling it cannot open (#5308)", () => {
		// Each spelling reaches a child process through a form the scan cannot
		// resolve, so it reds instead of passing as classified-or-baselined.
		const plants = [
			"const { spawnSync } = require(" +
				CHILD_MODULE +
				');\nspawnSync("probe", ["run"]);',
			"const cp = await import(" +
				CHILD_MODULE +
				');\ncp.spawnSync("probe", ["run"]);',
			"export { execFileSync } from " + CHILD_MODULE + ";",
			"import { spawnSync } from " +
				CHILD_MODULE +
				';\nconst toolkit = { run: spawnSync };\ntoolkit.run("probe", ["run"]);',
			"import { safeSpawn } from " + SEAM_MODULE + ";\nexport { safeSpawn };",
		];
		for (const source of plants) {
			const scan = spawnOutcomeScan("fixture.mjs", source);
			expect(scan.unclassified, source).not.toEqual([]);
		}
	});
});

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
import { expectPlantedStaleRow } from "../../../support/baseline-staleness.js";

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
): { uses: boolean; unclassified: string[]; locals: string[] } {
	const result = {
		uses: false,
		unclassified: [] as string[],
		locals: [] as string[],
	};
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
	// The value names the file imported: a spawn call handed to one of them has
	// its outcome read by the primitive, which is what makes a site classified.
	result.locals = [...valueLocals];
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
			// Only the value the file imported as a named, resolving import.
			locals: ["finishParsedRun"],
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
			const { uses, unclassified } = primitiveUse("fake.ts", source);
			expect({ uses, unclassified }, source).toEqual({
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
		).toEqual({ uses: false, unclassified: [], locals: [] });
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
const SCAN_ROOTS = ["clients/lsp", "scripts"] as const;
type CensusRoot = (typeof SCAN_ROOTS)[number];

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

/**
 * The spawn forms whose failed child reaches the caller as a throw (#5308 F3).
 *
 * `execSync` and `execFileSync` raise on a nonzero exit, on a signal kill, and
 * on a spawn error. `execFile` raises only when no callback is handed to it:
 * the callback form returns a ChildProcess and reports the failure through that
 * callback, so it is a quiet site and its file has to read the callback's
 * error. `spawn`, `spawnSync`, `fork`, and the `safeSpawn*` wrappers always
 * return, so those files have to read the outcome at all.
 */
const THROWING_SPAWN_NAMES = new Set(["execFile", "execFileSync", "execSync"]);

/** The node kinds that carry a callback a spawn call invokes with its outcome. */
const CALLBACK_KINDS = new Set([
	"arrow_function",
	"function_expression",
	"function",
]);

/**
 * Reading one of these off a spawn result means a failed child cannot read as
 * an empty one (#5308 F3). `stdout`/`stderr` are deliberately absent: an empty
 * buffer is what a dead child produces, so reading them proves nothing.
 */
const OUTCOME_FIELDS = new Set([
	"status",
	"exitCode",
	"killed",
	"signal",
	"error",
	"code",
]);

/** `child.on("error" | "exit" | "close", …)` is a detached child's outcome channel. */
const OUTCOME_EVENTS = new Set(["error", "exit", "close"]);

interface SpawnSite {
	line: number;
	/** The spawn function the call reaches, after alias resolution. */
	name: string;
	/** How the name reaches the call: direct, through an alias, or a hand-off. */
	via: "call" | "hand-off" | "namespace";
	/** True when a failed child reaches this caller as a throw (#5308 F3). */
	throws: boolean;
	/**
	 * True when that throw lands in a `catch` that neither rethrows nor exits,
	 * so the failure becomes whatever that catch produces (#5308 F4).
	 */
	swallowed: boolean;
	/**
	 * True when the call is handed to a classifier the file imported from the
	 * primitive, which reads the status, the signal, and the spawn error for it
	 * (#5308 B3). An open site is one this file still owns.
	 */
	classified: boolean;
}

interface SpawnScan {
	sites: SpawnSite[];
	unclassified: string[];
	/**
	 * The outcome fields this file reads off ITS OWN spawn results, as
	 * `field@line` (#5308 F3). Empty means nothing in the file can tell a dead
	 * child from a clean empty run.
	 */
	outcomeReads: string[];
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

/**
 * Which spawn family a module specifier names, or undefined.
 *
 * `node:child_process` and a relative `../safe-spawn.js` name the same modules,
 * so strip the URL scheme and the extension before the stem. A `safe-spawn`
 * basename inside a longer path that is not a relative specifier — the
 * `dist/clients/safe-spawn.js` component a bundling script builds — is a file
 * path, not a module id, and cannot start a child by itself, so only a
 * `.`-, `/`-, or `file:`-prefixed spelling names the seam module.
 */
function spawnModuleFamily(value: string): "child" | "safe" | undefined {
	const trimmed = value.trim();
	const schemeless = trimmed.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, "");
	const stem = path.posix.basename(schemeless).replace(/\.[cm]?[jt]s$/, "");
	if (CHILD_MODULE_STEMS.has(stem)) return "child";
	if (!SAFE_SPAWN_MODULE_STEMS.has(stem)) return undefined;
	return /^\.{1,2}[\\/]|^[\\/]|^file:/.test(trimmed) ? "safe" : undefined;
}

/**
 * The module id a literal spells, with a `${}` hole deleted rather than the
 * literal skipped (#5308 F2): a specifier the file builds at runtime still
 * names the module through the text the scan can see, and that is exactly the
 * spelling a fail-closed scan must not walk past.
 */
function moduleLiteralText(literal: SgNode): string | undefined {
	const kind = String(literal.kind());
	if (kind === "string") return literal.text().slice(1, -1);
	if (kind !== "template_string") return undefined;
	return literal
		.text()
		.slice(1, -1)
		.replace(/\$\{[\s\S]*?\}/g, "");
}

/**
 * Which spawn family a string or template literal names, failing closed on a
 * specifier the scan cannot resolve (#5308 F2).
 *
 * `import("node:" + "child_process")` and `` require(`node:child_proc${"ess"}`) ``
 * carry only a fragment of the id in any one literal, so a literal that holds
 * the OS module's name anywhere in it is a spawn-module reference even when no
 * resolution succeeds. The seam module keeps the exact-specifier rule, because
 * CI scripts spell its path in build strings that are not module loads.
 */
function spawnModuleReference(value: string): "child" | "safe" | undefined {
	const family = spawnModuleFamily(value);
	if (family) return family;
	return value.includes("child_process") ? "child" : undefined;
}

/** Per-file scan state: the spawn bindings the scanner has resolved. */
interface SpawnBindings {
	/** Local name -> the spawn export it reaches. */
	spawnable: Map<string, string>;
	/** Namespace import locals (`import * as cp from "node:child_process"`). */
	namespaces: Set<string>;
}

/**
 * The static imports of a spawn module: named specifiers keep their local
 * spelling, a namespace import and `{ default as x }` (the module object) are
 * recorded by their local, and a default import is reported because the scan
 * cannot see which spawn function it reaches.
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
				// `{ default as cp }` binds the module object, as `* as cp` does, so
				// its members are read as namespace members (#5530 verify r2 V1).
				if (imported === "default") {
					const local = specifier.field("alias")?.text();
					if (local) namespaces.add(local);
					continue;
				}
				if (!SPAWN_NAMES[family].has(imported)) continue;
				spawnable.set(specifier.field("alias")?.text() ?? imported, imported);
			}
		}
	}
	return { spawnable, namespaces };
}

/**
 * Every reference to a spawn module the scan did not open, reported with its
 * line (#5308 F2).
 *
 * A static `import … from` is the one form the scan reads bindings from, so it
 * is the one form this pass passes. Every other spelling that names a spawn
 * module — `require`, a dynamic `import()` whose specifier may be built at
 * runtime, `createRequire(...)(…)`, `process.getBuiltinModule`, an
 * `export … from`, a module id parked in a variable, a template-literal
 * specifier — is reported, never skipped. `process.getBuiltinModule(…)` and a
 * `createRequire` result called with the id land in the "loaded by" branch
 * because their callee is not the module load the scan can follow.
 *
 * The one shape this pass does not report is the RELATIVE seam module named in
 * a position that is not a module load: `createRequire(x)("./safe-spawn.js")`
 * and the `path.join(repoRoot, "dist", "clients", "safe-spawn.js")` a bundling
 * script builds are the same string, and the second is not a spawn. A
 * `child_process` id in ANY position reds, which is the family that can start a
 * child the scan cannot attribute. No census file loads the seam through a call
 * today (`grep -rn "createRequire" scripts clients/lsp` answers six module-load
 * sites, none of them a spawn module).
 */
function reportUnopenedSpawnModules(
	root: SgNode,
	report: (node: SgNode, what: string) => void,
): void {
	for (const literal of root.findAll({
		rule: { any: [{ kind: "string" }, { kind: "template_string" }] },
	})) {
		const value = moduleLiteralText(literal);
		if (value === undefined || spawnModuleReference(value) === undefined)
			continue;
		// A specifier built by concatenation lives under a binary expression; climb
		// it so the report names the load the parts build, not the `+`.
		let holder: SgNode = literal;
		while (String(holder.parent()?.kind()) === "binary_expression")
			holder = holder.parent() as SgNode;
		const parent = holder.parent();
		const parentKind = String(parent?.kind());
		// The static import is the form collectSpawnBindings follows; a default
		// import of it is reported there, where the clause says so.
		if (parentKind === "import_statement") continue;
		if (parentKind === "export_statement") {
			report(literal, "re-export from a spawn module");
			continue;
		}
		if (parentKind === "arguments") {
			const call = parent?.parent();
			const callee = call?.field("function");
			const calleeText = callee ? callee.text().replace(/\s+/g, " ") : "?";
			if (callee?.kind() === "identifier" && callee.text() === "require") {
				report(literal, "require of a spawn module");
			} else if (callee?.kind() === "import" || calleeText === "import") {
				report(literal, "dynamic import of a spawn module");
			} else {
				report(
					literal,
					`spawn module loaded by ${calleeText}(...), which the scan cannot follow`,
				);
			}
			continue;
		}
		report(literal, `spawn module id held in a "${parentKind}" position`);
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
 * Whether this call's failed child reaches the caller as a throw (#5308 F3).
 *
 * `execFile` with a callback argument is the async form: the child is returned
 * and the failure arrives as the callback's `error`, so the site is quiet and
 * the file is on the hook for reading it.
 */
function throwsOnFailure(name: string, call: SgNode): boolean {
	if (!THROWING_SPAWN_NAMES.has(name)) return false;
	const args = call.field("arguments");
	return !(args?.namedChildren() ?? []).some((child) =>
		CALLBACK_KINDS.has(String(child.kind())),
	);
}

/**
 * Does a throwing call land in a `catch` that neither rethrows nor exits? Then
 * the failed child does not abort anything: the catch body's own value is what
 * the caller continues with, and an empty list is the usual one. This is the
 * shape #5308's defect title names — a nonzero exit read as an empty result —
 * reached through an exec call rather than through an unread status.
 */
function failureCaughtNotRethrown(call: SgNode): boolean {
	let tryStatement: SgNode | undefined;
	for (const up of call.ancestors()) {
		if (String(up.kind()) === "try_statement") {
			tryStatement = up;
			break;
		}
	}
	const handler = tryStatement?.field("handler");
	if (!handler) return false;
	return !catchRethrows(handler);
}

const EXIT_CALL = /\bprocess\.exit\b|\bexitProcess\b/;

/**
 * Whether a `catch` hands the failure back to the caller (#5530 verify r2 V3).
 *
 * Code only: `codeMatches` blanks comments and strings, so "do not throw" in a
 * comment is not a rethrow. The catch must also be unable to return a value: a
 * throw or exit on its top level, and no `return` anywhere in it. A throw under
 * an `if` leaves the other path returning, so it swallows the failure the same
 * way `catch { return []; }` does.
 */
function catchRethrows(handler: SgNode): boolean {
	if (codeMatches(handler.text(), /\breturn\b/).length > 0) return false;
	const body = handler.field("body");
	return (body?.namedChildren() ?? []).some(
		(statement) =>
			statement.kind() === "throw_statement" ||
			(statement.kind() === "expression_statement" &&
				codeMatches(statement.text(), EXIT_CALL).length > 0),
	);
}

/**
 * Whether the call sits inside a call to a classifier the file imported from
 * the primitive (#5308 B3). A classified site's outcome is read by
 * `classifyRunOutcome`/`finishParsedRun`, so the file no longer owns the
 * question of whether its child failed.
 */
function classifiedBy(
	call: SgNode,
	classifierLocals: ReadonlySet<string>,
): boolean {
	if (classifierLocals.size === 0) return false;
	for (const up of call.ancestors()) {
		if (String(up.kind()) !== "call_expression") continue;
		const callee = up.field("function");
		if (!callee) continue;
		if (callee.kind() === "identifier" && classifierLocals.has(callee.text()))
			return true;
	}
	return false;
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
 * another function in the same file.
 *
 * It fails closed on what it cannot follow (#5308 F2): a spawn-module spelling
 * (`require`, a dynamic `import()`, `createRequire`, a module id held in a
 * variable, a re-export), and a spawn namespace or bound value reaching a child
 * through a position that starts nothing the scan can attribute — destructured
 * (`const { spawnSync } = cp`), rebound (`const cp2 = cp`), computed
 * (`cp["spawnSync"](…)`), extracted without a call (`const f = cp.spawn`), or
 * stored in an object (`{ cp }`). Each is a report with its file and line.
 *
 * `classifierLocals` are the value names the file imported from the primitive;
 * a spawn call handed to one is classified rather than open.
 */
function spawnOutcomeScan(
	file: string,
	source: string,
	classifierLocals: ReadonlySet<string> = new Set(),
): SpawnScan {
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
	reportUnopenedSpawnModules(root, report);
	closeSpawnAliasLoop(root, bindings.spawnable);

	const references = spawnSitesOf(root, bindings, report);
	return {
		sites: references.map((site) => ({
			line: site.call.range().start.line + 1,
			name: site.name,
			via: site.via,
			throws: throwsOnFailure(site.name, site.call),
			swallowed:
				throwsOnFailure(site.name, site.call) &&
				failureCaughtNotRethrown(site.call),
			classified: classifiedBy(site.call, classifierLocals),
		})),
		unclassified,
		outcomeReads: outcomeReadsOf(
			root,
			references.map((site) => site.call),
		),
	};
}

/** A reference to a spawn binding, resolved to the child it starts. */
interface SpawnSiteRef {
	call: SgNode;
	name: string;
	via: SpawnSite["via"];
}

/**
 * Resolve every reference to a spawn binding in the file into the child process
 * it starts: a direct call, a hand-off to a callee of this file, or a namespace
 * member call. A reference the scan cannot place is reported, so it reaches the
 * census as an unclassified spelling rather than a site it did not see (#5308 F2).
 */
function spawnSitesOf(
	root: SgNode,
	bindings: SpawnBindings,
	report: (node: SgNode, what: string) => void,
): SpawnSiteRef[] {
	const found: SpawnSiteRef[] = [];
	for (const id of root.findAll({
		rule: {
			any: [{ kind: "identifier" }, { kind: "shorthand_property_identifier" }],
		},
	})) {
		const text = id.text();
		const reference = spawnReferenceTo(text, bindings);
		if (!reference) continue;
		const isNamespace = reference.kind === "namespace";
		const parent = id.parent();
		const kind = String(parent?.kind());
		// The import declaration itself, and a `typeof safeSpawnAsync` type
		// position, do not start a child process.
		// A bare parameter is its own binding: in the JavaScript grammar a plain
		// parameter is an `identifier` directly under `formal_parameters`, so a
		// function's `exec` parameter is a fresh local, not the `exec` another
		// function defaults to `execFileSync`. Only its CALL counts.
		if (NON_SPAWN_REFERENCE_KINDS.has(kind)) continue;
		if (isBindingPosition(id)) {
			// The alias loop resolves a spawn VALUE. A namespace handed to a new
			// name or destructured is not one: `{ spawnSync } = cp` and
			// `const cp2 = cp` reach children no binding of this scan owns.
			if (isNamespace)
				report(id, `spawn namespace ${text} rebound without a spawn call`);
			continue;
		}
		if (isNamespace) {
			const site = namespaceSpawnCall(id, report);
			if (site)
				found.push({ call: site.call, name: site.name, via: "namespace" });
			continue;
		}
		if (kind === "call_expression" && sameNode(parent?.field("function"), id)) {
			found.push({ call: parent as SgNode, name: reference.name, via: "call" });
			continue;
		}
		// The function is handed to a callee that invokes it in this file: as a
		// positional argument, or packed in an options object literal that a call
		// of this file receives (`watchOpenPrs({ ghExec, gitExec })`).
		const handOff = handOffCall(id, kind);
		if (handOff && handOff.kind() === "call_expression") {
			found.push({ call: handOff, name: reference.name, via: "hand-off" });
			continue;
		}
		if (kind === "export_specifier") {
			report(id, "spawn value re-exported by name");
			continue;
		}
		report(id, `spawn value reached through a "${kind}" position`);
	}
	return found;
}

/**
 * Classify a namespace-import reference (`cp.spawn(...)`), reporting every use
 * of the namespace the scan cannot turn into a site (#5308 F2): a computed
 * member, a member extracted without a call, and any other use of the namespace
 * object all reach a child the scan would otherwise never see.
 */
function namespaceSpawnCall(
	id: SgNode,
	report: (node: SgNode, what: string) => void,
): { call: SgNode; name: string } | undefined {
	const member = id.parent();
	if (
		!member ||
		String(member.kind()) !== "member_expression" ||
		!sameNode(member.field("object"), id)
	) {
		report(
			id,
			String(member?.kind()) === "subscript_expression"
				? "spawn namespace member reached through a computed subscript"
				: `spawn namespace ${id.text()} used outside a spawn call`,
		);
		return undefined;
	}
	const methodName = member.field("property")?.text() ?? "";
	const call = member.parent();
	if (
		!call ||
		String(call.kind()) !== "call_expression" ||
		!sameNode(call.field("function"), member)
	) {
		report(id, `namespace spawn member ${methodName} extracted without a call`);
		return undefined;
	}
	if (!SPAWN_NAMES.child.has(methodName)) {
		report(id, `namespace member call of "${methodName}"`);
		return undefined;
	}
	return { call, name: methodName };
}

/** How a reference names a child-process primitive: a bound call, or a namespace. */
type SpawnReference = { kind: "bound"; name: string } | { kind: "namespace" };

/** What a local spelling reaches: a spawn function, a spawn namespace, or nothing. */
function spawnReferenceTo(
	text: string,
	bindings: SpawnBindings,
): SpawnReference | undefined {
	if (bindings.namespaces.has(text)) return { kind: "namespace" };
	const name = bindings.spawnable.get(text);
	return name === undefined ? undefined : { kind: "bound", name };
}

/**
 * Positions where a spawn name or bound value binds or names a type instead of
 * starting a child process.
 */
const NON_SPAWN_REFERENCE_KINDS = new Set([
	"import_specifier",
	"namespace_import",
	"import_statement",
	"formal_parameters",
	"type_query",
]);

/**
 * The call a spawn value is handed to: as a positional argument, or packed in an
 * object literal that some call of the file receives. Undefined when the
 * position holds no such call, which is the report case.
 */
function handOffCall(id: SgNode, parentKind: string): SgNode | undefined {
	if (parentKind === "arguments") return id.parent()?.parent() ?? undefined;
	if (parentKind === "object" || parentKind === "pair")
		return nearestCallAncestor(id);
	return undefined;
}

/**
 * The nearest enclosing call, for a spawn value handed through an object bag.
 */
function nearestCallAncestor(node: SgNode): SgNode | undefined {
	for (const up of node.ancestors()) {
		if (String(up.kind()) === "call_expression") return up;
	}
	return undefined;
}

/**
 * The node a binding or a member read sees in place of a call.
 *
 * `await`, parens, and the branches of a conditional or a `??` fallback all
 * stand for the same call to the code that reads them, so a result bound out of
 * one of them (`const child = ready ? spawn(a) : spawn(b)`) is still that
 * call's result.
 */
function wrappedCall(call: SgNode): SgNode {
	let node = call;
	for (;;) {
		const parent = node.parent();
		const kind = String(parent?.kind());
		if (kind === "await_expression" || kind === "parenthesized_expression") {
			node = parent as SgNode;
			continue;
		}
		if (kind === "ternary_expression") {
			node = parent as SgNode;
			continue;
		}
		if (kind === "binary_expression" && hasFallbackOperator(parent as SgNode)) {
			node = parent as SgNode;
			continue;
		}
		return node;
	}
}

/** Whether a binary expression combines its operands with `??` or `||`. */
function hasFallbackOperator(binary: SgNode): boolean {
	return binary
		.children()
		.some((child) => ["??", "||"].includes(String(child.kind())));
}

/** Whether any call below this node is one of the tracked spawn calls. */
function subtreeHasCallId(node: SgNode, callIds: ReadonlySet<number>): boolean {
	if (callIds.has(node.id())) return true;
	return node.children().some((child) => subtreeHasCallId(child, callIds));
}

/** The local name a function is reachable by, for a helper that returns a result. */
function functionBindingName(fn: SgNode): string | undefined {
	if (fn.kind() === "function_declaration") return fn.field("name")?.text();
	const declarator = fn.parent();
	if (
		declarator &&
		String(declarator.kind()) === "variable_declarator" &&
		sameNode(declarator.field("value"), fn)
	)
		return declarator.field("name")?.text();
	return undefined;
}

/**
 * The file-local functions that hand a spawn result back to their caller.
 *
 * `const result = spawnAstGrep(args, root)` then `if (result.error) throw` reads
 * a child's outcome as surely as the `safeSpawn` call inside the helper does, so
 * a function that returns a spawn result — or returns the result of another such
 * helper — makes its OWN calls results, and the reads on those count (#5308 F3).
 * Without this, a script that hides its spawn behind one wrapper of its own reads
 * blind even though it aborts on a nonzero exit.
 */
function spawnResultHelpers(
	root: SgNode,
	callIds: ReadonlySet<number>,
): Set<string> {
	const functions = new Map<string, SgNode>();
	for (const fn of root.findAll({
		rule: {
			any: [
				{ kind: "function_declaration" },
				{ kind: "function_expression" },
				{ kind: "arrow_function" },
				{ kind: "generator_function_declaration" },
				{ kind: "method_definition" },
			],
		},
	})) {
		const name = functionBindingName(fn);
		if (name) functions.set(name, fn);
	}
	const producers = new Set<string>();
	for (let round = 0; round < 4; round++) {
		let added = false;
		for (const [name, fn] of functions) {
			if (producers.has(name)) continue;
			for (const ret of fn.findAll({ rule: { kind: "return_statement" } })) {
				const value = ret.field("argument") ?? ret.namedChildren()[0];
				if (!value) continue;
				const returned =
					callIds.has(wrappedCall(value).id()) ||
					subtreeHasCallId(value, callIds);
				const calleeName =
					wrappedCall(value).kind() === "call_expression"
						? wrappedCall(value).field("function")?.text()
						: undefined;
				if (returned || (calleeName && producers.has(calleeName))) {
					producers.add(name);
					added = true;
					break;
				}
			}
		}
		if (!added) break;
	}
	return producers;
}

/**
 * Every node whose value is a spawn result: the spawn calls themselves plus the
 * calls of this file's result-returning helpers.
 */
function resultNodes(root: SgNode, spawnCalls: readonly SgNode[]): SgNode[] {
	const producers = spawnResultHelpers(
		root,
		new Set(spawnCalls.map((call) => call.id())),
	);
	if (producers.size === 0) return [...spawnCalls];
	const extra: SgNode[] = [];
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function");
		if (callee?.kind() === "identifier" && producers.has(callee.text()))
			extra.push(call);
	}
	return [...spawnCalls, ...extra];
}

/** The name a call result is bound to, or the pattern it is destructured into. */
function bindingTargetOf(call: SgNode): SgNode | undefined {
	const wrapped = wrappedCall(call);
	const declarator = wrapped.parent();
	if (!declarator) return undefined;
	if (
		String(declarator.kind()) === "variable_declarator" &&
		sameNode(declarator.field("value"), wrapped)
	)
		return declarator.field("name") ?? undefined;
	if (
		String(declarator.kind()) === "assignment_expression" &&
		sameNode(declarator.field("right"), wrapped)
	)
		return declarator.field("left") ?? undefined;
	return undefined;
}

/** The key a destructured pattern entry reads (`{ status }` and `{ status: s }`). */
function destructuredKey(entry: SgNode): string | undefined {
	const kind = String(entry.kind());
	if (kind === "shorthand_property_identifier_pattern") return entry.text();
	if (kind === "pair_pattern") return entry.field("left")?.text();
	return undefined;
}

/** The field a member read names, for `r.status`, `r?.status`, and `r["code"]`. */
function outcomeFieldOf(member: SgNode): string | undefined {
	if (member.kind() === "member_expression")
		return member.field("property")?.text();
	if (member.kind() === "subscript_expression") {
		const index = member.field("index");
		return index ? literalContent(index) : undefined;
	}
	return undefined;
}

/** A string node's contents, quotes stripped. */
function literalContent(node: SgNode | undefined): string | undefined {
	return node !== undefined && String(node.kind()) === "string"
		? node.text().slice(1, -1)
		: undefined;
}

/** A callback parameter's name, without its type annotation. */
function parameterNames(callback: SgNode): string[] {
	const parameters = callback.field("parameters");
	return (parameters?.namedChildren() ?? []).map(
		(parameter) => parameter.field("pattern")?.text() ?? parameter.text(),
	);
}
/**
 * The names this file's spawn results are reachable under: the locals (or
 * `this.child`-style members) bound from a result, and the parameters of the
 * callbacks a spawn call was handed. Matched by text, which is how a member read
 * on `this.child` reaches the `this.child = spawn(...)` that made it.
 */
function resultValueNames(results: readonly SgNode[]): Set<string> {
	const names = new Set<string>();
	for (const call of results) {
		// An async spawn hands its outcome to the callback it was given.
		const args = call.field("arguments");
		for (const argument of args?.namedChildren() ?? []) {
			if (!CALLBACK_KINDS.has(String(argument.kind()))) continue;
			for (const name of parameterNames(argument)) names.add(name);
		}
		const target = bindingTargetOf(call);
		if (target && String(target.kind()) !== "object_pattern")
			names.add(target.text());
	}
	return names;
}

/** The outcome fields pulled straight out of a destructured spawn result. */
function destructuredOutcomeFields(results: readonly SgNode[]): string[] {
	const reads: string[] = [];
	for (const call of results) {
		const target = bindingTargetOf(call);
		if (!target || String(target.kind()) !== "object_pattern") continue;
		for (const entry of target.namedChildren()) {
			const key = destructuredKey(entry);
			if (key && OUTCOME_FIELDS.has(key))
				reads.push(`${key}@${entry.range().start.line + 1}`);
		}
	}
	return reads;
}

/** `child.on("error" | "exit" | "close", …)`: a detached child's outcome channel. */
function outcomeListenerOf(member: SgNode): string | undefined {
	const call = member.parent();
	if (
		!call ||
		String(call.kind()) !== "call_expression" ||
		!sameNode(call.field("function"), member)
	)
		return undefined;
	const method = member.field("property")?.text();
	if (method !== "on" && method !== "once") return undefined;
	const event = literalContent(call.field("arguments")?.namedChildren()[0]);
	return event && OUTCOME_EVENTS.has(event) ? `on:${event}` : undefined;
}

/**
 * The outcome fields this file reads off ITS OWN spawn results (#5308 F3).
 *
 * `\.error` in the source is not evidence. `console.error(...)` names the
 * console and `process.exitCode` names the process, so neither tells a caller
 * anything about a child; reading them is what let a fire-and-forget child pass
 * as a read outcome. A read counts only when its object is
 *  - a spawn call (or that call `await`ed, parenthesised, or branched on),
 *  - a local or member bound from one, including a this-file helper that
 *    returns one (`const result = spawnAstGrep(args)` then `result.status`),
 *  - the parameter of a callback the spawn call was handed,
 *  - or the target of `child.on("error" | "exit" | "close", …)`.
 * A destructured result counts when the field it pulls is an outcome field.
 *
 * The verdict is per file and names are matched by text, so a file that shadows
 * a result name in another scope can read as non-blind; the `[blind]` claim on
 * its baseline row is what pins the verdict either way.
 */
function outcomeReadsOf(root: SgNode, spawnCalls: readonly SgNode[]): string[] {
	const results = resultNodes(root, spawnCalls);
	const callIds = new Set<number>();
	for (const call of results) {
		callIds.add(call.id());
		callIds.add(wrappedCall(call).id());
	}
	const names = resultValueNames(results);
	const reads = destructuredOutcomeFields(results);
	for (const member of root.findAll({
		rule: {
			any: [{ kind: "member_expression" }, { kind: "subscript_expression" }],
		},
	})) {
		const object = member.field("object");
		if (!object || !(callIds.has(object.id()) || names.has(object.text())))
			continue;
		const field = outcomeFieldOf(member);
		if (field && OUTCOME_FIELDS.has(field)) {
			reads.push(`${field}@${member.range().start.line + 1}`);
			continue;
		}
		const listener = outcomeListenerOf(member);
		if (listener) reads.push(`${listener}@${member.range().start.line + 1}`);
	}
	return [...new Set(reads)].sort();
}

/** The open sites of a row: the ones the file still owns (#5308 B3). */
function openSites(row: CensusRow): SpawnSite[] {
	return row.scan.sites.filter((site) => !site.classified);
}

/**
 * The open sites of a file that cannot see a failed child (#5308 F3): no open
 * site throws, and nothing in the file reads an outcome field off its own spawn
 * results, so a dead child looks exactly like a clean empty run. A throw that a
 * `catch` swallows is the same result by another road, and the scan names it on
 * the site (`[swallowed]`, #5308 F4). A quiet site's sentinel catch (`null`,
 * `ok: false`) is the channel left unjudged; the blind row describes it.
 */
function blindOpenSites(scan: SpawnScan): SpawnSite[] {
	const quiet = scan.sites.filter((site) => !site.classified && !site.throws);
	return quiet.length > 0 && scan.outcomeReads.length === 0 ? quiet : [];
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
	scan: SpawnScan;
	usesPrimitive: boolean;
}

/** One census row from the real detectors: used by the census and by plants. */
function scanCensusRow(file: string, source: string): CensusRow {
	const use = primitiveUse(file, source, path.posix.dirname(file));
	const scan = spawnOutcomeScan(file, source, new Set(use.locals));
	// A spawn-outcome spelling this file reaches in a form the scan cannot
	// classify is a finding of the same census, not of a separate one.
	scan.unclassified.push(...use.unclassified);
	return { file, scan, usesPrimitive: use.uses };
}

const censusCache = new Map<CensusRoot, CensusRow[]>();

/** The census is a read-only scan of the tree, so one walk per root per fork. */
function census(root: CensusRoot): CensusRow[] {
	const cached = censusCache.get(root);
	if (cached) return cached;
	const rows: CensusRow[] = [];
	for (const file of censusSourceFiles(root)) {
		const row = scanCensusRow(
			file,
			fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
		);
		if (row.scan.sites.length === 0 && row.scan.unclassified.length === 0)
			continue;
		rows.push(row);
	}
	const sorted = rows.sort((a, b) => a.file.localeCompare(b.file));
	censusCache.set(root, sorted);
	return sorted;
}

/** Every census row, both roots, in file order. */
let censusRows: CensusRow[] | undefined;

/** Every census row, scanned once: the tree is static for the run. */
function allCensusRows(): CensusRow[] {
	censusRows ??= SCAN_ROOTS.flatMap((root) => census(root));
	return censusRows;
}

/** What a baseline row claims about its file (#5308 B1, B3). */
interface RowClaim {
	openSites: number | undefined;
	blind: boolean;
	swallowed: boolean;
}

/**
 * The two claims a row makes about the file it excuses. `[open-sites:N]` is
 * required in every row; `[blind]` states that the file has a site that does not
 * throw and reads no outcome field, so a dead child reads as a clean empty run.
 */
function rowClaim(reason: string): RowClaim {
	const pinned = /\[open-sites:(\d+)\]/.exec(reason);
	return {
		openSites: pinned ? Number(pinned[1]) : undefined,
		blind: /\[blind\]/.test(reason),
		swallowed: /\[swallowed\]/.test(reason),
	};
}

/**
 * Rows whose pinned site count disagrees with the scan (#5308 B1).
 *
 * A new site — however it is written, and including one that reads an outcome
 * field elsewhere in the file — moves the count, so the row cannot be left
 * behind. A file with no baseline row is not a problem here: `auditRegistry`
 * reports an unaccounted flagged file.
 */
function siteCountMismatches(
	rows: CensusRow[],
	baseline: Record<string, string>,
): string[] {
	const problems: string[] = [];
	for (const row of rows) {
		const reason = baseline[row.file];
		if (reason === undefined) continue;
		const claim = rowClaim(reason);
		const sites = openSites(row);
		if (claim.openSites === undefined) {
			problems.push(
				`${row.file}: baseline row pins no [open-sites:N]; the scan finds ` +
					`${sites.length} open site(s)`,
			);
		} else if (claim.openSites !== sites.length) {
			problems.push(
				`${row.file}: baseline row pins [open-sites:${claim.openSites}], the ` +
					`scan finds ${sites.length} open site(s): ` +
					`${sites.map((site) => `${site.name}@${site.line}`).join(", ")}`,
			);
		}
	}
	return problems;
}

/**
 * Rows whose `[blind]` claim disagrees with the scan, in either direction
 * (#5308 F3). A file that cannot see a failed child must say so, and a row that
 * still claims blindness for a file that now reads its outcome is stale.
 */
function blindClaimMismatches(
	rows: CensusRow[],
	baseline: Record<string, string>,
): string[] {
	const problems: string[] = [];
	for (const row of rows) {
		const reason = baseline[row.file];
		if (reason === undefined) continue;
		const blind = blindOpenSites(row.scan);
		const claims = rowClaim(reason).blind;
		if (blind.length > 0 && !claims) {
			problems.push(
				`${row.file}: no open site throws and nothing reads an outcome field ` +
					`off its own spawn result, so a dead child reads as a clean empty ` +
					`run (${blind.map((site) => `${site.name}@${site.line}`).join(", ")}); ` +
					`the row must declare [blind] and say what the code does instead`,
			);
		} else if (blind.length === 0 && claims) {
			problems.push(
				`${row.file}: row claims [blind], but the file throws on its open ` +
					`sites or reads an outcome field off its own spawn result ` +
					`(${row.scan.outcomeReads.join(", ") || "no open quiet site"})`,
			);
		}
	}
	return problems;
}

/**
 * Rows whose `[swallowed]` claim disagrees with the scan, in either direction
 * (#5308 F4). A file whose throwing site lands in a `catch` that does not
 * rethrow may not be excused with "the child failure aborts the caller": the
 * failure becomes the catch's own value, and an empty result is what a script
 * usually returns there. The claim is checked both ways, so a row cannot keep
 * the strong wording after the catch starts swallowing, and cannot drop the
 * marker while the swallow is still there.
 */
function swallowClaimMismatches(
	rows: CensusRow[],
	baseline: Record<string, string>,
): string[] {
	const problems: string[] = [];
	for (const row of rows) {
		const reason = baseline[row.file];
		if (reason === undefined) continue;
		const swallowed = openSites(row).filter((site) => site.swallowed);
		const claims = rowClaim(reason).swallowed;
		if (swallowed.length > 0 && !claims) {
			problems.push(
				`${row.file}: ${swallowed.map((site) => `${site.name}@${site.line}`).join(", ")} ` +
					`throws, but the failure lands in a catch that neither rethrows nor ` +
					`exits, so a failed child becomes that catch's own value; the row must ` +
					`declare [swallowed] rather than say the caller aborts`,
			);
		} else if (swallowed.length === 0 && claims) {
			problems.push(
				`${row.file}: row claims [swallowed], but no open site throws into a ` +
					`catch that keeps going (it reads ` +
					`${row.scan.outcomeReads.join(", ") || "no swallowing site"})`,
			);
		}
	}
	return problems;
}

/**
 * Split census rows for `auditRegistry` (#5308 B3). A file is FLAGGED while it
 * has an open site — one that does not route through the primitive — and
 * REGISTERED (so it must carry no row) once every site does. Deciding it on the
 * count rather than on `usesPrimitive` is what keeps a file that routes one of
 * two sites through the classifier flagged.
 */
function spawnAuditInput(rows: CensusRow[]): {
	flagged: { key: string; detail: string }[];
	registered: string[];
} {
	return {
		flagged: rows
			.filter((row) => openSites(row).length > 0)
			.map((row) => ({
				key: row.file,
				detail: `${row.scan.sites.length} site(s): ${row.scan.sites
					.map((site) => `${site.name}@${site.line}`)
					.join(", ")}`,
			})),
		registered: rows
			.filter((row) => openSites(row).length === 0)
			.map((row) => row.file),
	};
}

/**
 * Baseline rows whose file now has no open site (#5308 B3): the exemption is
 * stale the moment the last site routes through the primitive, whether or not
 * the file still spawns anything.
 */
function migratedSpawnRows(
	rows: CensusRow[],
	baseline: Record<string, string>,
): string[] {
	const migratedFiles = new Set(
		rows.filter((row) => openSites(row).length === 0).map((row) => row.file),
	);
	return Object.keys(baseline).filter((file) => migratedFiles.has(file));
}

/**
 * Every census file with a spawn site this file does not route through the
 * primitive, with what its code does instead of classifying the outcome.
 *
 * Each row pins its site count with `[open-sites:N]` (#5308 B1): a new spawn in
 * one of these files moves the count and fails the census, so a row excuses the
 * sites it counted and not the file forever, and a file that reads its outcome
 * elsewhere cannot hide a new blind site behind that read.
 *
 * A row says one of three things, and the second carries a `[swallowed]` marker
 * when a `catch` takes the failure back:
 *  - `reads … on its own spawn result` — the file looks at the status, signal,
 *    or error of the child it started (#5308 F3),
 *  - `throws on a nonzero exit` — the site is `execSync`/`execFileSync`, so a
 *    failed child aborts the caller instead of returning an empty result. With
 *    `[swallowed]` the throw lands in a `catch` that neither rethrows nor exits,
 *    so what the caller continues with is that catch's own value (#5308 F4),
 *  - `[blind]` — no site throws and nothing reads an outcome field off its own
 *    result, so a dead child reads as a clean empty run: the original defect,
 *    declared rather than excused. `scripts/playground-chrome.mjs` is that file;
 *    it spawns Chrome detached with `stdio: "ignore"`, `unref()`s it, and finds
 *    out whether it came up by polling its debug port, so the port poll is the
 *    only failure channel and a spawn error never reaches a decision (#5308 F4).
 *
 * The last form is accepted for now, not blessed: a blind script that starts a
 * required child can be repaired by reading its result or by routing through
 * `safeSpawnAsync`, and its row then goes stale in the good direction.
 */
export const OUT_OF_TREE_SPAWN_BASELINE: Record<string, string> = {
	"clients/lsp/client.ts":
		"spawn reads close,error on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"clients/lsp/jvm-runtime.ts":
		"safeSpawnAsync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"clients/lsp/launch.ts":
		"safeSpawn, spawn reads close,error,exit,exitCode,killed,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:4]",
	"clients/lsp/server.ts":
		"safeSpawnAsync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:4]",
	"scripts/audit-prod-deps.mjs":
		"spawn reads close,error on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:2]",
	"scripts/backfill-github-releases.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/backfill-release-thanks.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/bench-snapshot-persist.mjs":
		"spawnSync reads status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/benchmark-biome.ts":
		"safeSpawnAsync reads status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/build-dist-tsc.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@234 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:1]",
	"scripts/bundle-dist.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@225 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:1]",
	"scripts/capture-runner-fixtures.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@664, execFileSync@702 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:2]",
	"scripts/capture-runner-output.mjs":
		"spawnSync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/check-ci-job-p90.mjs":
		"spawnSync reads status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/check-close-keywords.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@136, execFileSync@162, execFileSync@283 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:4]",
	"scripts/check-extensions.mjs":
		"execSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/check-grammar-corpus.mjs":
		"spawnSync reads error,signal,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/check-grammar-load.mjs":
		"spawnSync reads error,signal,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/check-hot-path-latency.mjs":
		"spawnSync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/check-pr-body.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:6]",
	"scripts/check-tla-models.mjs":
		"spawn reads close,error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/ci-changed-files.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/ci-shuffle-changed-tests.mjs":
		"spawnSync reads error,signal,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/ci-test-diff.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error; the first call's catch retries once and rethrows the retry's failure, so the caller gets the retry's output or an error, never an empty result; #1737 [open-sites:2] [swallowed]",
	"scripts/ci-verdict.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@3065, execFileSync@3123 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:7]",
	"scripts/compat-contracts.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/compat-smoke-behavioral.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:2]",
	"scripts/download-test-history-artifacts.mjs":
		"spawnSync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/guard-bash-probe.mjs":
		"spawn reads close,error on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/install-selftest.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@199 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:1]",
	"scripts/lane-check.mjs":
		"spawnSync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/lib/astgrep-self-scan.mjs":
		"safeSpawn reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/lib/git-fixture-env.mjs":
		"execFileSync, execSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:2]",
	"scripts/lib/knip-runner.mjs":
		"spawnSync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/lib/knip-sibling-purge.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/lib/lockfile-completeness.mjs":
		"spawnSync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/lib/mcp-stdio-client.mjs":
		"spawn reads exit on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/lib/mutation-test-selection.mjs":
		"safeSpawnAsync reads status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/lib/process-scan.mjs":
		"spawn reads close,error on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/lib/server-provenance.mjs":
		"spawnSync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/lib/test-history-selection.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/lib/test-runner-smoke.mjs":
		"spawnSync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:4]",
	"scripts/lint-js-advisory.mjs":
		"spawnSync reads status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/mutate.mjs":
		"spawn, spawnSync reads close,code,error,signal,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:3]",
	"scripts/notify-clean-signal-drift.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/notify-install-smoke-drift.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/notify-tool-smoke-red.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/npm-retry.mjs":
		"spawn reads close,code,error on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/playground-chrome.mjs":
		"execSync throws on a nonzero exit, and at execSync@80, execSync@120, execSync@127, execSync@263 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [blind] [open-sites:6]",
	"scripts/playground-verify-rule.mjs":
		"safeSpawnAsync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:2]",
	"scripts/pr-preflight.mjs":
		"spawnSync reads status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:2]",
	"scripts/pr-worktree.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:2]",
	"scripts/pre-push-targeted-tests.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@414, execFileSync@499, execFileSync@529, execFileSync@900, execFileSync@1026 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:9]",
	"scripts/probe-pi-host-tiers.mjs":
		"spawnSync reads error,signal,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/prune-actions-cache.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/prune-agent-worktrees.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@757 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:1]",
	"scripts/red-on-base.mjs":
		"execFileSync, spawn reads close,error on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:2]",
	"scripts/regen-test-baseline.mjs":
		"spawnSync reads status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/release-qa.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@1502, execFileSync@2339, execFileSync@2706, execFileSync@2961, execFileSync@3000, execFileSync@3193 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:11]",
	"scripts/resolve-newest-in-range-host.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@64 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:1]",
	"scripts/rpc-load-check.mjs":
		"spawn reads exit on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/run-all-ts-rules-posthog.mjs":
		"execSync throws on a nonzero exit, and at execSync@35 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:1]",
	"scripts/run-harness.mjs":
		"spawnSync reads error on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/run-ts-rules-pi-lens.mjs":
		"execSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/setup-git-hooks.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@141, execFileSync@147 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:3]",
	"scripts/smoke-availability-lifecycle.mjs":
		"spawnSync reads status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/smoke-gitleaks-scratch-exclusion.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@100 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:1]",
	"scripts/smoke-psscriptanalyzer-classification.mjs":
		"spawnSync reads error,status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:3]",
	"scripts/smoke-tools.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@224, execFileSync@2027, execFileSync@2124, execFileSync@2146 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:4]",
	"scripts/strictness-report.mjs":
		"spawnSync reads status on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/stryker-diff.mjs":
		"execFileSync throws on a nonzero exit, and at execFileSync@268 the throw lands in a catch that neither rethrows nor exits, so a failed child there becomes that catch's own value (an empty list is the usual one); #1737 [swallowed] [open-sites:9]",
	"scripts/trace-validate-session-lifecycle.mjs":
		"spawn reads close,error on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/update-contributors.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:3]",
	"scripts/upsert-tracking-issue.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
	"scripts/with-memory-watch.mjs":
		"spawn reads error,exit on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:1]",
	"scripts/with-test-lock.mjs":
		"spawn reads error,exit,killed on its own spawn result, so a nonzero exit, a signal, or a spawn error is not a clean run; #1737 [open-sites:3]",
	"scripts/worktree-remove.mjs":
		"execFileSync throws on a nonzero exit, a signal, or a spawn error, so the caller aborts rather than reading an empty result; #1737 [open-sites:1]",
};

describe("spawn sites outside the dispatch runners (#5308)", () => {
	// The floors sit under the measured walk (clients/lsp and scripts each scan
	// over a hundred sources) so a file moving does not red, but a root dropping
	// out of the walk does: the whole population of that root falls at once.
	const SCANNED_FLOOR: Record<string, number> = {
		"clients/lsp": 20,
		scripts: 150,
	};
	// Measured 2026-11-13 through this seam: 77 files with 153 open spawn sites
	// (clients/lsp 4 files / 10 sites, scripts 73 files / 143 sites), none of
	// them routed through the primitive. The floor sits under that so a file
	// losing a site does not red the population check, while one root dropping
	// out of the walk does.
	const FLAGGED_FLOOR = 70;

	// Every census below walks two whole subtrees, so each carries the shared
	// tree-walk budget (`tests/config/tree-census-timeout.test.ts` #4828).
	it(
		"censuses every source file under both roots (#5308)",
		() => {
			const thin = SCAN_ROOTS.filter(
				(root) => censusSourceFiles(root).length < SCANNED_FLOOR[root],
			);
			expect(
				thin,
				`the census walk lost a root (${SCAN_ROOTS.join(", ")}): ` +
					`${thin.join(", ")} scanned below its floor`,
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every spawn site outside the runners is classified or carries a reason (#5308)",
		() => {
			const audit = auditRegistry({
				sweepName: "run-outcome ratchet, out-of-tree spawn sites (#5308)",
				...spawnAuditInput(allCensusRows()),
				exemptions: OUT_OF_TREE_SPAWN_BASELINE,
				scannedCount: SCAN_ROOTS.reduce(
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
		"pins the open-site count every baseline row claims (#5308)",
		() => {
			// B1: a row excuses the sites it counted, not the file forever. The
			// count is per file, so a new spawn in a baselined file reds even when
			// the file reads an outcome field somewhere else and the flagged/
			// registered split is unchanged.
			expect(
				siteCountMismatches(allCensusRows(), OUT_OF_TREE_SPAWN_BASELINE),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("reds a planted baseline row no open spawn site backs (#5072)", () => {
		// The B1 direction on a row this cell invents: a file with one open spawn
		// site, excused by a row that pins nine. The pin count is the ledger's
		// whole claim about the file, so the mismatch names the row.
		const planted = "scripts/5072-planted-spawn.mjs";
		const row = scanCensusRow(
			planted,
			[
				'import { spawn } from "node:child_process";',
				'const child = spawn("true");',
				"void child;",
			].join("\n"),
		);
		const stale = siteCountMismatches([row], {
			[planted]: "a planted row for the cell; #5072 [open-sites:9]",
		});
		expect(stale, stale.join("\n")).toHaveLength(1);
		expectPlantedStaleRow({
			baseline:
				"tests/clients/dispatch/runners/run-outcome-ratchet.test.ts#OUT_OF_TREE_SPAWN_BASELINE",
			rowKey: planted,
			direction: "extra-row",
			verdict: stale,
		});
	});

	it(
		"a file that cannot see a failed child declares itself blind (#5308)",
		() => {
			// F3, in both directions. `execSync` and `execFileSync` raise, so their
			// files abort; `spawn`, `spawnSync`, `fork`, the `safeSpawn*` wrappers,
			// and an async `execFile` return, so the file has to read
			// status/exitCode/signal/killed/error/code off ITS OWN RESULT — not
			// `console.error` and not `process.exitCode`, which name the console and
			// the process. A file that neither throws nor reads is the original
			// defect; the row says so with `[blind]` and a description of what the
			// code does instead. A row that still claims blindness after the file
			// learned to read its outcome is stale.
			expect(
				blindClaimMismatches(allCensusRows(), OUT_OF_TREE_SPAWN_BASELINE),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"a row for a swallowed child failure says so (#5308 F4)",
		() => {
			// An `execSync` whose throw lands in a `catch` that neither rethrows nor
			// exits does not abort the caller, so a row for such a file may not
			// excuse it with "the child failure aborts". The scan finds the shape
			// and the row carries `[swallowed]`; both directions are checked.
			expect(
				swallowClaimMismatches(allCensusRows(), OUT_OF_TREE_SPAWN_BASELINE),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"tells a swallowed child failure from an aborting one (#5308 F4)",
		() => {
			// The two exec shapes the vocabulary separates, planted rather than
			// inferred from the tree: one aborts, one keeps going on the catch's
			// own value, and a rethrow or an exit is not a swallow.
			const file = "scripts/zzplant-swallow.mjs";
			const head = `import { execFileSync } from ${CHILD_MODULE};\n`;
			const swallowing = scanCensusRow(
				file,
				head +
					"function found() {\n" +
					"  try { return execFileSync('probe', ['find']).toString(); }\n" +
					"  catch { return []; }\n}\n",
			);
			const aborting = scanCensusRow(
				file,
				head + "const found = execFileSync('probe', ['find']).toString();\n",
			);
			const rethrowing = scanCensusRow(
				file,
				head +
					"function found() {\n" +
					"  try { return execFileSync('probe', ['find']).toString(); }\n" +
					"  catch (e) { throw e; }\n}\n",
			);
			expect(openSites(swallowing).map((site) => site.swallowed)).toEqual([
				true,
			]);
			expect(openSites(aborting).map((site) => site.swallowed)).toEqual([
				false,
			]);
			expect(openSites(rethrowing).map((site) => site.swallowed)).toEqual([
				false,
			]);
			// The verify's plants (#5530 r2 V3). A comment that says "throw" is not a
			// rethrow, and a throw under an `if` leaves the other path returning a
			// value, so both swallow. A return ahead of a top-level throw swallows
			// too. Only a top-level throw or exit with no return rethrows.
			const caught = (handler: string) =>
				openSites(
					scanCensusRow(
						file,
						head +
							"function found() {\n" +
							"  try { return execFileSync('probe', ['find']).toString(); }\n" +
							`  ${handler}\n}\n`,
					),
				).map((site) => site.swallowed);
			expect(
				caught(
					"catch {\n    // we deliberately do not throw here\n    return []; }",
				),
			).toEqual([true]);
			expect(caught("catch (e) { if (e) { throw e; } return []; }")).toEqual([
				true,
			]);
			expect(
				caught("catch (e) { if (e.code === 'ENOENT') return []; throw e; }"),
			).toEqual([true]);
			expect(
				caught("catch (e) { if (e) process.exit(1); return []; }"),
			).toEqual([true]);
			expect(
				caught("catch (e) { console.error(e); process.exit(1); }"),
			).toEqual([false]);
			// Comment-blanking on the two checks that read text: an exit and a return
			// that exist only inside a comment do not count (`codeMatches`).
			expect(
				caught("catch (e) { console.error(/* process.exit(1) */ e); }"),
			).toEqual([true]);
			expect(caught("catch (e) { /* return [] */ throw e; }")).toEqual([false]);
			// A swallowing file cannot be excused by the abort wording, and its row
			// with the marker is accepted; the reverse pair checks the other way.
			expect(
				swallowClaimMismatches([swallowing], {
					[file]: "execFileSync throws; #1737 [open-sites:1]",
				}),
			).toHaveLength(1);
			expect(
				swallowClaimMismatches([aborting], {
					[file]:
						"execFileSync throws, but a catch keeps going; #1737 [open-sites:1] [swallowed]",
				}),
			).toHaveLength(1);
			expect(
				swallowClaimMismatches([swallowing], {
					[file]:
						"execFileSync throws into a catch; #1737 [open-sites:1] [swallowed]",
				}),
			).toEqual([]);
			// A swallowing file is not `[blind]`: it does look at the child, it just
			// throws the answer away into an empty list.
			expect(blindOpenSites(swallowing.scan)).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"reads only a spawn result as an outcome read (#5308 F3)",
		() => {
			// The gate's own vocabulary, planted rather than inferred from the tree.
			// `console.error` and `process.exitCode` are the spellings that let a
			// fire-and-forget child pass, and `stdout` is what a dead child produces.
			const plants: { source: string; blind: boolean; why: string }[] = [
				{
					why: "a console line says nothing about the child",
					source:
						"import { spawn } from " +
						CHILD_MODULE +
						';\nconst child = spawn("probe");\nconsole.error("done");\nconsole.log(child.pid);',
					blind: true,
				},
				{
					why: "process.exitCode is the process's own, not the child's",
					source:
						"import { spawnSync } from " +
						CHILD_MODULE +
						';\nconst r = spawnSync("probe");\nprocess.exitCode = 1;\nreturn r.stdout;',
					blind: true,
				},
				{
					why: "reading stdout alone is what a dead child also produces",
					source:
						"import { spawnSync } from " +
						CHILD_MODULE +
						';\nconst r = spawnSync("probe");\nreturn r.stdout + r.stderr;',
					blind: true,
				},
				{
					why: "an async execFile whose callback ignores the error",
					source:
						"import { execFile } from " +
						CHILD_MODULE +
						';\nexecFile("probe", () => {});',
					blind: true,
				},
				{
					why: "a listener for an event that is not an outcome",
					source:
						"import { spawn } from " +
						CHILD_MODULE +
						';\nconst child = spawn("probe");\nchild.on("foo", () => {});',
					blind: true,
				},
				{
					why: "status read off the result local",
					source:
						"import { spawnSync } from " +
						CHILD_MODULE +
						';\nconst r = spawnSync("probe");\nif (r.status !== 0) throw new Error("dead");',
					blind: false,
				},
				{
					why: "status read straight off the call",
					source:
						"import { spawnSync } from " +
						CHILD_MODULE +
						';\nif (spawnSync("probe").status !== 0) process.exit(1);',
					blind: false,
				},
				{
					why: "status destructured out of the result",
					source:
						"import { spawnSync } from " +
						CHILD_MODULE +
						';\nconst { status } = spawnSync("probe");\nreturn status;',
					blind: false,
				},
				{
					why: "the async execFile callback reads its error",
					source:
						"import { execFile } from " +
						CHILD_MODULE +
						';\nexecFile("probe", (err) => { if (err?.code) process.exit(1); });',
					blind: false,
				},
				{
					why: "a detached child listening for its exit",
					source:
						"import { spawn } from " +
						CHILD_MODULE +
						';\nconst child = spawn("probe");\nchild.on("exit", (code) => { if (code) process.exit(1); });',
					blind: false,
				},
				{
					why: "the awaited result read through a subscript",
					source:
						"import { spawnSync } from " +
						CHILD_MODULE +
						';\nconst r = await (spawnSync("probe"));\nreturn r["error"];',
					blind: false,
				},
				{
					why: "a throwing child aborts the caller",
					source:
						"import { execFileSync } from " +
						CHILD_MODULE +
						';\nexecFileSync("probe");',
					blind: false,
				},
				{
					why: "status read off an awaited call in place",
					source:
						"import { spawnSync } from " +
						CHILD_MODULE +
						';\nreturn (await spawnSync("probe")).status;',
					blind: false,
				},
				{
					why: "exitCode read off a `??` fallback between two spawns",
					source:
						"import { spawnSync } from " +
						CHILD_MODULE +
						';\nreturn (spawnSync("probe") ?? spawnSync("other")).exitCode;',
					blind: false,
				},
				{
					why: "an error listener on a ternary of two spawns",
					source:
						"import { spawn } from " +
						CHILD_MODULE +
						';\nconst ready = true;\n(ready ? spawn("probe") : spawn("other")).on("error", () => process.exit(1));',
					blind: false,
				},
			];
			for (const plant of plants) {
				const scan = spawnOutcomeScan("fixture.mjs", plant.source);
				expect(
					scan.sites.length,
					`${plant.why}\n${plant.source}`,
				).toBeGreaterThan(0);
				expect(
					blindOpenSites(scan).length > 0,
					`${plant.why}\n${plant.source}\nreads=${scan.outcomeReads.join(",")}`,
				).toBe(plant.blind);
			}
			// A classified site is the primitive's question, not the file's.
			const classified = spawnOutcomeScan(
				"fixture.mjs",
				"import { spawnSync } from " +
					CHILD_MODULE +
					';\nimport { classifyRunOutcome } from "./utils/spawn-outcome.js";\nclassifyRunOutcome(spawnSync("probe"));',
				new Set(["classifyRunOutcome"]),
			);
			expect(classified.sites.every((site) => site.classified)).toBe(true);
			expect(blindOpenSites(classified)).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"a new spawn site in a baselined file moves its pinned count (#5308 B1)",
		() => {
			// The plant is the reviewer's B1 shape: one spawn in a file the table
			// already excuses, reading an outcome field elsewhere so the old gate
			// stayed green. Rows keyed to the plant are exact, then the file grows.
			const file = "scripts/planted-site.mjs";
			const before = scanCensusRow(
				file,
				"import { spawnSync } from " +
					CHILD_MODULE +
					';\nimport { classifyRunOutcome } from "../clients/dispatch/runners/utils/spawn-outcome.js";\nif (classifyRunOutcome(spawnSync("probe")).status !== 0) process.exit(1);\nspawnSync("extra");',
			);
			const baseline: Record<string, string> = {
				[file]: "reads status on its own spawn result; #1737 [open-sites:1]",
			};
			expect(siteCountMismatches([before], baseline)).toEqual([]);
			const after = scanCensusRow(
				file,
				"import { spawn, spawnSync } from " +
					CHILD_MODULE +
					';\nimport { classifyRunOutcome } from "../clients/dispatch/runners/utils/spawn-outcome.js";\nif (classifyRunOutcome(spawnSync("probe")).status !== 0) process.exit(1);\nspawnSync("extra");\nspawn("late");',
			);
			const problems = siteCountMismatches([after], baseline);
			expect(problems.length, problems.join("\n")).toBe(1);
			expect(problems[0]).toContain("[open-sites:1]");
			expect(problems[0]).toContain("2 open site(s)");
			// The blind claim carries the same weight in the other direction: a file
			// that becomes blind must move from no claim to `[blind]`.
			const readsOutcomes = scanCensusRow(
				file,
				"import { spawn } from " +
					CHILD_MODULE +
					';\nconst c = spawn("probe");\nc.on("exit", () => {});',
			);
			expect(
				blindClaimMismatches([readsOutcomes], {
					[file]: "blind row; #1737 [blind]",
				}),
			).toEqual([expect.stringContaining(file)]);
			const goesBlind = scanCensusRow(
				file,
				"import { spawn } from " +
					CHILD_MODULE +
					';\nconst c = spawn("probe");\nconsole.error(c.pid);',
			);
			expect(
				blindClaimMismatches([goesBlind], { [file]: "blind row; #1737" }),
			).toEqual([expect.stringContaining(file)]);
			expect(
				blindClaimMismatches([goesBlind], {
					[file]: "declared blind; #5308 [blind]",
				}),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"registers only a file whose every site routes through the primitive (#5308 B3)",
		() => {
			// A file that classifies one of two sites is still flagged, with its one
			// open site counted; only a fully routed file drops out of the table,
			// and its row then reads as stale.
			const imported =
				'import { spawnSync } from "node:child_process";\n' +
				'import { classifyRunOutcome } from "../clients/dispatch/runners/utils/spawn-outcome.js";\n';
			const fully = scanCensusRow(
				"src/all-migrated.mjs",
				imported + 'classifyRunOutcome(spawnSync("probe"));',
			);
			const partially = scanCensusRow(
				"src/partial-migrated.mjs",
				imported +
					'classifyRunOutcome(spawnSync("probe"));\nspawnSync("late");',
			);
			expect(fully.usesPrimitive, "the plant must reach the primitive").toBe(
				true,
			);
			const audit = spawnAuditInput([fully, partially]);
			expect(audit.flagged.map((entry) => entry.key)).toEqual([
				"src/partial-migrated.mjs",
			]);
			expect(audit.registered).toEqual(["src/all-migrated.mjs"]);
			expect(openSites(partially).map((site) => site.line)).toEqual([4]);
			// The stale direction: the row of a file that has finished migrating.
			expect(
				migratedSpawnRows([fully], {
					"src/all-migrated.mjs": "planted; #1737",
				}),
			).toEqual(["src/all-migrated.mjs"]);
			expect(
				migratedSpawnRows([partially], {
					"src/partial-migrated.mjs": "planted; #1737",
				}),
			).toEqual([]);
			// A migrated row is reported whether or not the file still spawns: the
			// table entry, not the scan, is what goes stale.
			expect(
				migratedSpawnRows([{ ...fully, scan: { ...fully.scan, sites: [] } }], {
					"src/all-migrated.mjs": "planted; #1737",
				}),
			).toEqual(["src/all-migrated.mjs"]);
			expect(
				migratedSpawnRows(allCensusRows(), OUT_OF_TREE_SPAWN_BASELINE),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"classifies every spawn-capable reference in both roots (#5308)",
		() => {
			// Fail closed (#4429's rule for a population scanner): a spawn-module
			// import the scanner cannot follow reds with its file and line.
			const unclassified = allCensusRows().flatMap(
				(row) => row.scan.unclassified,
			);
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
				// `{ default as cp }` binds the module object, as `* as cp` does
				// (#5530 verify r2 V1). Read as a named import, the scan skipped it.
				"import { default as cp } from " +
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

	it("resolves a primitive import against its own census directory (#5308)", () => {
		// Recurrence: #5530 verify r2 V5. Mutating the directory `scanCensusRow`
		// passes to `primitiveUse` left this suite green. A `scripts/lib` file
		// reaches the classifier as `../../clients/...`: resolved against the
		// runners directory that path leaves the repo, so only the file's own
		// directory finds the classifier.
		const row = scanCensusRow(
			"scripts/lib/zzplant-resolve.mjs",
			"import { spawnSync } from " +
				CHILD_MODULE +
				';\nimport { classifyRunOutcome } from "../../clients/dispatch/runners/utils/spawn-outcome.js";\nclassifyRunOutcome(spawnSync("probe"));',
		);
		expect(
			row.usesPrimitive,
			"the file's directory reaches the classifier",
		).toBe(true);
		expect(row.scan.unclassified).toEqual([]);
		expect(openSites(row)).toEqual([]);
	});

	it("reports a spawn reference it cannot open (#5308 F2)", () => {
		// Each spelling reaches a child process through a form the scan cannot
		// resolve, so it reds instead of passing as classified-or-baselined. The
		// expected phrase pins WHICH branch reports it, so a widened or removed
		// check turns this table red rather than re-routing the plant silently.
		const plants: [string, string][] = [
			[
				"const { spawnSync } = require(" +
					CHILD_MODULE +
					');\nspawnSync("probe", ["run"]);',
				"require of a spawn module",
			],
			[
				"const cp = await import(" +
					CHILD_MODULE +
					');\ncp.spawnSync("probe", ["run"]);',
				"dynamic import of a spawn module",
			],
			[
				"export { execFileSync } from " + CHILD_MODULE + ";",
				"re-export from a spawn module",
			],
			[
				"import { spawnSync } from " +
					CHILD_MODULE +
					';\nconst toolkit = { run: spawnSync };\ntoolkit.run("probe", ["run"]);',
				'"pair" position',
			],
			[
				"import { safeSpawn } from " + SEAM_MODULE + ";\nexport { safeSpawn };",
				"re-exported by name",
			],
			// The module id built at runtime: neither half resolves, and the scan
			// still reports the half that names the OS module.
			[
				'const cp = await import("node:" + "child_process");\ncp.spawnSync("probe");',
				"dynamic import of a spawn module",
			],
			[
				'const cp = process.getBuiltinModule("node:child_process");\ncp.spawn("probe");',
				"the scan cannot follow",
			],
			[
				'const MOD = "node:child_process";\nconst cp = await import(MOD);\ncp.spawn("probe");',
				'"variable_declarator" position',
			],
			// A namespace the scan opened, then lost track of.
			[
				"import * as cp from " + CHILD_MODULE + ";\nconst { spawnSync } = cp;",
				"rebound without a spawn call",
			],
			[
				"import * as cp from " + CHILD_MODULE + ';\ncp["spawnSync"]("probe");',
				"computed subscript",
			],
			// The default-as spelling is the namespace, so the same report applies
			// (#5530 verify r2 V1).
			[
				"import { default as cp } from " +
					CHILD_MODULE +
					';\ncp["spawnSync"]("probe");',
				"computed subscript",
			],
			[
				"import * as cp from " + CHILD_MODULE + ";\nconst run = cp.spawn;",
				"extracted without a call",
			],
			[
				"import * as cp from " +
					CHILD_MODULE +
					';\nconst cp2 = cp;\ncp2.spawn("probe");',
				"rebound without a spawn call",
			],
			[
				"import * as cp from " + CHILD_MODULE + ";\nstart({ cp });",
				"used outside a spawn call",
			],
			[
				"import cp from " + CHILD_MODULE + ';cp.spawn("probe");',
				"default import",
			],
		];
		for (const [source, phrase] of plants) {
			const scan = spawnOutcomeScan("fixture.mjs", source);
			expect(scan.unclassified.join("\n"), source).toContain(phrase);
		}
	});
});

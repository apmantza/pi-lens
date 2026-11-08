import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import type { SgNode } from "../../../../clients/deps/ast-grep-napi.js";
import { codeMatches } from "../../../support/sweep-kit.js";

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
		const imported = importedSpecifiers(literal, value);
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
):
	| {
			module: string;
			specifiers: { name: string; local: string }[];
	  }
	| undefined {
	const statement = literal.parent();
	if (statement?.kind() !== "import_statement") return undefined;
	if (!value.startsWith(".")) return undefined;
	const module = path.posix
		.normalize(path.posix.join("runners", value))
		.replace(/\.[cm]?[jt]s$/, "")
		.replace(/^runners\//, "");
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

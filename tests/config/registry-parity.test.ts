/**
 * Registry parity (#5418): the tool registries and the docs must name the same
 * tools.
 *
 * pi-lens answers "does this tool exist" in five places — the runner registry
 * (`RunnerRegistry`), `TOOL_EXECUTION_POLICY` (TEP), `TOOL_COMMAND_SPECS` (TCS),
 * `AUTO_INSTALLABLE_DEFAULT_FORMATTERS` (AUTO) and the installer registry
 * (`clients/installer/index.ts` TOOLS) — plus two prose surfaces
 * (`docs/language-coverage.md`'s Dispatch Runners column, the autofix tool list
 * in `docs/features.md`). Before this test nothing compared them, so an id could
 * point at nothing and a doc could name a runner that was never registered.
 *
 * EVERY direction here is derived from the registries themselves: the id sets
 * come from the live runner registry and from the exported tables, and the docs
 * names come from the table cells / list text, never from a hand-copied id. The
 * only hand-written content is the exemption tables, and `auditRegistry` reds an
 * exemption whose hit went away and an exemption under 15 characters of reason.
 *
 * FAIL CLOSED. A check that finds nothing is a broken check, so each one carries
 * a floor (`assertNonEmptyScan`). A doc cell that is neither a runner list nor an
 * exempted prose cell is a violation; a reference to `createAvailabilityChecker`
 * that is not a classified direct call, a plain import, its definition or a
 * `typeof` is a violation, and so is a call argument that is neither a string
 * literal nor the bound command-spec form. The known-bad spellings are never
 * enumerated — the good set is admitted and everything else is refused.
 *
 * RIVAL CONSIDERED (the issue's): generate the docs tables from the registries.
 * Rejected — `docs/language-coverage.md` interleaves prose in the same cells it
 * would have to emit (the Java + Lombok launch row, the Lean 4 Lake note), so a
 * generator either loses that prose or grows a prose escape hatch of its own;
 * this guard catches the same drift with no writer to maintain.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { RunnerRegistry } from "../../clients/dispatch/dispatcher.js";
import { registerDefaultRunners } from "../../clients/dispatch/runners/index.js";
import { TOOLS } from "../../clients/installer/index.js";
import { ALL_FORMATTERS } from "../../clients/formatters.js";
import {
	AUTO_INSTALLABLE_DEFAULT_FORMATTERS,
	listSafePipelineAutofixTools,
	TOOL_COMMAND_SPECS,
	TOOL_EXECUTION_POLICY,
} from "../../clients/tool-policy.js";
import type { SgNode } from "@ast-grep/napi";
import { censusSourceFiles, parseNodes } from "../support/ast-census.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	readWalkedFiles,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Live registries, never a copy: a rename in one of these tables moves this
// test's population the same moment it moves production's.
const registry = new RunnerRegistry();
registerDefaultRunners(registry);
const runnerIds = new Set(registry.list().map((runner) => runner.id));
const installerIds = new Set(TOOLS.map((tool) => tool.id));
const formatterNames = new Set(
	ALL_FORMATTERS.map((formatter) => formatter.name),
);

/** Every name a tool id may legitimately answer to, outside the installer. */
function isKnownToolName(id: string): boolean {
	return runnerIds.has(id) || installerIds.has(id) || formatterNames.has(id);
}

describe("Tool registry parity (#5418)", () => {
	it("every TOOL_EXECUTION_POLICY row names a runner, an installer tool or a formatter", () => {
		// A policy row for a tool none of the registries has is a policy that
		// governs nothing, and the drift is invisible from either side.
		assertNonEmptyScan(
			"TOOL_EXECUTION_POLICY rows",
			TOOL_EXECUTION_POLICY.size,
			30,
		);
		const dangling = [...TOOL_EXECUTION_POLICY.keys()].filter(
			(id) => !isKnownToolName(id),
		);
		expect(
			dangling,
			`TOOL_EXECUTION_POLICY rows with no runner, installer entry or formatter: ${dangling.join(", ")}`,
		).toEqual([]);
	});

	it("every auto-install policy row has an installer entry", () => {
		// `shouldAutoInstallTool` is the policy's only reader, so a row that says
		// `autoInstall: true` with no installer entry promises a repair that
		// cannot run.
		const rows = [...TOOL_EXECUTION_POLICY.entries()].filter(
			([, policy]) => policy.autoInstall,
		);
		assertNonEmptyScan("auto-install policy rows", rows.length, 20);
		const dangling = rows
			.filter(([id]) => !installerIds.has(id))
			.map(([id]) => id);
		expect(
			dangling,
			`policy rows that promise auto-install with no installer entry: ${dangling.join(", ")}`,
		).toEqual([]);
	});

	it("every auto-installable default formatter has a policy row", () => {
		// AUTO is the formatter auto-install seam; TEP is the policy table. A
		// formatter in one and not the other is the two tables disagreeing about
		// the same tool.
		assertNonEmptyScan(
			"AUTO_INSTALLABLE_DEFAULT_FORMATTERS entries",
			AUTO_INSTALLABLE_DEFAULT_FORMATTERS.size,
			5,
		);
		const dangling = [...AUTO_INSTALLABLE_DEFAULT_FORMATTERS.entries()]
			.filter(([, toolId]) => !TOOL_EXECUTION_POLICY.has(toolId))
			.map(([formatterName, toolId]) => `${formatterName}->${toolId}`);
		expect(
			dangling,
			`auto-installable formatters with no TOOL_EXECUTION_POLICY row: ${dangling.join(", ")}`,
		).toEqual([]);
	});

	it("every command-spec install pointer resolves to an installer entry or a reason", () => {
		// `resolveToolCommandWithInstallFallback` asks the installer for exactly
		// `spec.managedToolId ?? toolId`, so a dangling pointer is a silent
		// no-op repair path, not an error.
		const pointers = [...TOOL_COMMAND_SPECS.entries()].map(
			([toolId, spec]) => [toolId, spec.managedToolId ?? toolId] as const,
		);
		assertNonEmptyScan("command specs", pointers.length, 15);
		const audit = auditRegistry({
			sweepName: "registry-parity:command-spec-install-pointer",
			flagged: pointers
				.filter(([, managedToolId]) => !installerIds.has(managedToolId))
				.map(([toolId, managedToolId]) => ({
					key: `${toolId}->${managedToolId}`,
					detail: `spec ${toolId} asks the installer for "${managedToolId}"`,
				})),
			registered: [],
			exemptions: COMMAND_SPEC_INSTALL_REASONS,
			remediation:
				"Point the spec at a real installer entry, drop the pointer, or record the install story in COMMAND_SPEC_INSTALL_REASONS.",
		});
		expect(audit.problems).toEqual([]);
	});

	it(
		"every CLI a dispatch runner probes is installable or carries a written skip reason",
		() => {
			const { names, problems, scanned } = runnerCliCommands();
			assertNonEmptyScan("runner CLI probe sites", names.size, 25);
			const notInstallable = [...names.entries()]
				.filter(([cli]) => !installerIds.has(cli))
				.map(([cli, files]) => ({
					key: cli,
					detail: `${cli} probed by ${[...files].sort((a, b) => a.localeCompare(b)).join(", ")}`,
				}));
			expect(
				problems,
				`unclassified CLI probe arguments:\n${problems.join("\n")}`,
			).toEqual([]);
			const audit = auditRegistry({
				sweepName: "registry-parity:runner-cli",
				flagged: notInstallable,
				registered: [],
				exemptions: RUNNER_CLI_SKIP_REASONS,
				scannedCount: scanned,
				minScanned: 20,
				remediation:
					"Add the installer entry, or record why pi-lens does not install this CLI in RUNNER_CLI_SKIP_REASONS.",
			});
			expect(audit.problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// Runner CLI population
// ---------------------------------------------------------------------------

/**
 * The CLIs a dispatch runner probes through `createAvailabilityChecker`, with
 * the files that probe each one, plus every reference the classifier refused.
 */
function runnerCliCommands(): {
	names: Map<string, Set<string>>;
	problems: string[];
	scanned: number;
} {
	const names = new Map<string, Set<string>>();
	const problems: string[] = [];
	const files = censusSourceFiles(
		[path.join(ROOT, "clients/dispatch/runners")],
		{ extensions: ["ts"] },
	);
	for (const { file, source } of readWalkedFiles(files)) {
		const relative = path.relative(ROOT, file).split(path.sep).join("/");
		const result = classifyAvailabilityProbes(source, relative);
		problems.push(...result.problems);
		for (const cli of result.clis) {
			const seen = names.get(cli) ?? new Set<string>();
			seen.add(relative);
			names.set(cli, seen);
		}
	}
	return { names, problems, scanned: files.length };
}

const CHECKER = "createAvailabilityChecker";
const CHECKER_HOME = "clients/dispatch/runners/utils/runner-helpers.ts";

/**
 * Classify every reference to `createAvailabilityChecker` in one source file
 * (shape 69: fail closed on the reference, not only on the argument).
 *
 * The population is every AST leaf whose text is exactly the name, so a comment
 * never counts and a string that only quotes a call never counts, while an
 * identifier, a member name or a bare `"createAvailabilityChecker"` key does.
 * Admitted: a direct call with a bare callee whose first argument is a string
 * literal (its CLI) or the command-spec form; a plain import specifier; the
 * definition in its home file; `typeof` in a type position. Every other
 * reference (an import-as alias, a const alias, a namespace member, a
 * parenthesized callee, `.call`, a re-export) is a problem.
 */
function classifyAvailabilityProbes(
	source: string,
	relative: string,
): { clis: string[]; problems: string[] } {
	const clis: string[] = [];
	const problems: string[] = [];
	for (const leaf of parseNodes(source)) {
		if (!leaf.isLeaf() || leaf.text() !== CHECKER) continue;
		const parent = leaf.parent();
		const at = `${relative}:${leaf.range().start.line + 1}`;
		const isField = (name: string) =>
			parent?.field(name)?.range().start.index === leaf.range().start.index;
		if (parent?.kind() === "call_expression" && isField("function")) {
			const verdict = classifyProbeArgument(parent);
			if (typeof verdict === "string") clis.push(verdict);
			else if (verdict === null) {
				problems.push(
					`${at}: unclassified ${CHECKER} argument ${parent.field("arguments")?.text() ?? "()"}`,
				);
			}
			continue;
		}
		if (parent?.kind() === "import_specifier" && !parent.field("alias")) {
			continue;
		}
		if (
			parent?.kind() === "function_declaration" &&
			isField("name") &&
			relative === CHECKER_HOME
		) {
			continue;
		}
		if (parent?.kind() === "type_query") continue;
		problems.push(
			`${at}: unclassified reference to ${CHECKER} (${parent?.kind() ?? "root"}): ${parent?.text() ?? leaf.text()}`,
		);
	}
	return { clis, problems };
}

/**
 * A direct call's first argument: its CLI for a string literal, `true` for the
 * command-spec form (the command-spec pointer test owns that population), or
 * `null` for anything else. The spec form counts only where every `spec`
 * binding in the enclosing function is `const spec = getToolCommandSpec(...)`,
 * so a local object literal named `spec` is refused.
 */
function classifyProbeArgument(call: SgNode): string | true | null {
	const [argument] =
		call
			.field("arguments")
			?.children()
			.filter((node) => node.isNamed()) ?? [];
	if (argument?.kind() === "string")
		return JSON5.parse<string>(argument.text());
	if (argument?.text() !== "spec.command") return null;
	let scope = call.parent();
	while (scope && !FUNCTION_KINDS.has(String(scope.kind())))
		scope = scope.parent();
	if (!scope) return null;
	const bindings = scope.findAll({
		rule: {
			kind: "variable_declarator",
			has: { field: "name", regex: "^spec$" },
		},
	});
	const fromSpecs = scope.findAll({
		rule: { pattern: "const spec = getToolCommandSpec($$$)" },
	});
	return bindings.length > 0 && bindings.length === fromSpecs.length
		? true
		: null;
}

const FUNCTION_KINDS = new Set([
	"function_declaration",
	"function_expression",
	"arrow_function",
	"method_definition",
]);

/**
 * A CLI a runner probes that the installer registry has no entry for is a
 * written decision, not an oversight. `auditRegistry` reds a reason whose hit
 * disappeared, so this table cannot grow into a screen that screens nothing.
 */
const HOST_TOOLCHAIN =
	"Host toolchain the project or image provides; pi-lens never installs a compiler, interpreter or shell.";

const NO_INSTALLER_ENTRY =
	"No installer entry exists today and the runner skips while the CLI is absent; whether pi-lens installs it is an open install-opt-in decision with no owning issue.";

const RUNNER_CLI_SKIP_REASONS: Record<string, string> = {
	cl: HOST_TOOLCHAIN,
	clang: HOST_TOOLCHAIN,
	"clang++": HOST_TOOLCHAIN,
	gcc: HOST_TOOLCHAIN,
	"g++": HOST_TOOLCHAIN,
	"c++": HOST_TOOLCHAIN,
	cc: HOST_TOOLCHAIN,
	javac: HOST_TOOLCHAIN,
	dotnet: HOST_TOOLCHAIN,
	dart: HOST_TOOLCHAIN,
	flutter: HOST_TOOLCHAIN,
	zig: HOST_TOOLCHAIN,
	php: HOST_TOOLCHAIN,
	fish: HOST_TOOLCHAIN,
	fish_indent: HOST_TOOLCHAIN,
	mix: HOST_TOOLCHAIN,
	elixirc: HOST_TOOLCHAIN,
	// #5418's two rows: both runners skip while their CLI is absent, and the
	// installer registry has no entry for either name (`typos-lsp` is the
	// separate LSP server binary, not the `typos` CLI).
	phpstan: NO_INSTALLER_ENTRY,
	typos: NO_INSTALLER_ENTRY,
};

/**
 * A command spec whose install pointer the installer registry cannot answer.
 * `minFlagged: 0` would let an empty pointer population pass, so the audit
 * floor is the 15-spec scan above and every dangling pointer must appear here.
 */
const COMMAND_SPEC_INSTALL_REASONS: Record<string, string> = {
	"eslint->eslint":
		"The runner resolves the project's own node_modules/.bin eslint first; pi-lens has no eslint installer entry, and whether it should is an open install-opt-in decision.",
	"phpstan->phpstan": NO_INSTALLER_ENTRY,
	// #5410 moved both runners' checkers onto the registry, so these two rows
	// carry the reasons the runner-CLI table held for them.
	"detekt->detekt":
		"Standalone detekt-cli the user installs (Homebrew, SDKMAN or the release archive); the installer registry has no detekt entry and the runner skips without it.",
	"java->java": HOST_TOOLCHAIN,
};

describe("Runner CLI scanner (#5418)", () => {
	const FIXTURE = "clients/dispatch/runners/fixture.ts";
	const IMPORT = `import { createAvailabilityChecker } from "./utils/runner-helpers.js";`;

	// Shape 69: each spelling below reaches the probe without the bare call the
	// first version matched (review r1 F1 planted every one and saw 11 passed).
	it.each([
		[
			"an import-as alias",
			`import { createAvailabilityChecker as cac } from "./utils/runner-helpers.js";\ncac("phantom");`,
		],
		[
			"a const alias",
			`${IMPORT}\nconst make = createAvailabilityChecker;\nmake("phantom");`,
		],
		[
			"a namespace member",
			`import * as h from "./utils/runner-helpers.js";\nh.createAvailabilityChecker("phantom");`,
		],
		[
			"a parenthesized callee",
			`${IMPORT}\n(createAvailabilityChecker)("phantom");`,
		],
		[
			"a .call indirection",
			`${IMPORT}\ncreateAvailabilityChecker.call(null, "phantom");`,
		],
		[
			"a local spec object",
			`${IMPORT}\nfunction f() { const spec = { command: "phantom" }; return createAvailabilityChecker(spec.command); }`,
		],
		[
			"a spec parameter",
			`${IMPORT}\nfunction f(spec: { command: string }) { return createAvailabilityChecker(spec.command); }`,
		],
		[
			"an identifier argument",
			`${IMPORT}\nconst a = "phantom";\ncreateAvailabilityChecker(a, ".exe");`,
		],
		[
			"a call argument",
			`${IMPORT}\nconst get = () => "phantom";\ncreateAvailabilityChecker(get(), ".exe");`,
		],
		[
			"a member argument",
			`${IMPORT}\nconst holder = { cli: "phantom" };\ncreateAvailabilityChecker(holder.cli, ".exe");`,
		],
		[
			"a re-export",
			`export { createAvailabilityChecker } from "./utils/runner-helpers.js";`,
		],
		[
			"a quoted key",
			`import * as h from "./utils/runner-helpers.js";\nh["createAvailabilityChecker"]("phantom");`,
		],
	])("refuses %s", (_label, source) => {
		const { clis, problems } = classifyAvailabilityProbes(source, FIXTURE);
		expect(problems).toHaveLength(1);
		expect(clis).toEqual([]);
	});

	it("admits the literal call, the command-spec form and typeof", () => {
		expect(
			classifyAvailabilityProbes(
				`${IMPORT}
				const phantom = createAvailabilityChecker("phantom", ".exe");
				type Checker = ReturnType<typeof createAvailabilityChecker>;
				function byId(toolId: string) {
					const spec = getToolCommandSpec(toolId);
					if (!spec) return null;
					return createAvailabilityChecker(spec.command);
				}`,
				FIXTURE,
			),
		).toEqual({ clis: ["phantom"], problems: [] });
	});

	it("admits the definition only in its home file", () => {
		const source =
			"export function createAvailabilityChecker(command: string) {}";
		expect(classifyAvailabilityProbes(source, CHECKER_HOME).problems).toEqual(
			[],
		);
		expect(classifyAvailabilityProbes(source, FIXTURE).problems).toHaveLength(
			1,
		);
	});

	it("counts neither a comment nor a string that only quotes the call", () => {
		expect(
			classifyAvailabilityProbes(
				`
				// createAvailabilityChecker("phantom")
				const prose = 'createAvailabilityChecker("phantom")';
			`,
				FIXTURE,
			),
		).toEqual({ clis: [], problems: [] });
	});
});

// ---------------------------------------------------------------------------
// Docs surfaces
// ---------------------------------------------------------------------------

/** One parsed documentation table cell, keyed by its row's first cell. */
interface DocCell {
	label: string;
	cell: string;
	line: number;
}

/**
 * Every cell of every markdown table in `text` under `column`.
 *
 * Structure, not spelling: a cell counts only inside a real markdown table
 * (a header naming `column`, a separator row, then data rows of the same cell
 * count), so a paragraph or a comment quoting a runner name satisfies nothing.
 * A data row whose cell count differs from its header's is reported as
 * malformed instead of being skipped.
 */
function tableColumnCells(
	text: string,
	column: string,
): { cells: DocCell[]; malformed: string[] } {
	const lines = text.split("\n");
	const cells: DocCell[] = [];
	const malformed: string[] = [];
	for (let i = 0; i + 1 < lines.length; i++) {
		if (!isTableRow(lines[i])) continue;
		const header = markdownCells(lines[i]);
		const index = header.findIndex((cell) => cell.trim() === column);
		if (index < 0) continue;
		if (!isTableRow(lines[i + 1]) || !/^[|\s:-]+$/.test(lines[i + 1])) continue;
		for (let row = i + 2; row < lines.length && isTableRow(lines[row]); row++) {
			const rowCells = markdownCells(lines[row]);
			if (rowCells.length !== header.length) {
				malformed.push(
					`line ${row + 1}: ${rowCells.length} cells for a ${header.length}-cell header`,
				);
				continue;
			}
			cells.push({
				label: rowCells[0].trim(),
				cell: rowCells[index],
				line: row + 1,
			});
		}
	}
	return { cells, malformed };
}

function isTableRow(line: string | undefined): boolean {
	return !!line && line.trim().startsWith("|");
}

/**
 * A markdown row's cells. An escaped `\|` inside a cell is not supported and
 * would read as an extra cell: the row count check above turns that into a
 * visible malformed row rather than a silently shifted column.
 */
function markdownCells(line: string): string[] {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
}

/**
 * A dispatch-runner cell's name candidates, at comma/semicolon depth 0 outside
 * parentheses, with any parenthetical qualifier dropped. Backtick markers go,
 * their content stays, so a name in code font is still checked.
 */
function dispatchNameCandidates(cell: string): {
	names: string[];
	prose: string[];
} {
	const flat = cell.replaceAll("`", "");
	const names: string[] = [];
	const prose: string[] = [];
	for (const segment of splitAtDepthZero(flat)) {
		const bare = segment
			.replace(/\([^()]*\)/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!bare) continue;
		if (/^[-—–\s]*$/.test(bare)) continue;
		if (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(bare)) names.push(bare);
		else prose.push(bare);
	}
	return { names, prose };
}

function splitAtDepthZero(text: string): string[] {
	const segments: string[] = [];
	let current = "";
	let depth = 0;
	for (const character of text) {
		if (character === "(") depth++;
		else if (character === ")") depth = Math.max(0, depth - 1);
		if (depth === 0 && (character === "," || character === ";")) {
			segments.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	segments.push(current);
	return segments;
}

/**
 * Every markdown file in `docs/`, derived from the directory: a new doc that
 * grows a Dispatch Runners table, or copies the autofix tool list, is covered
 * the moment it is written, with no list here to keep current.
 */
const DOC_FILES = fs
	.readdirSync(path.join(ROOT, "docs"))
	.filter((name) => name.endsWith(".md"))
	.sort((a, b) => a.localeCompare(b))
	.map((name) => `docs/${name}`);

/** One doc file's text, read fresh so no check inherits another's content. */
function readDoc(relative: string): string {
	return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/**
 * A Dispatch Runners cell that is prose rather than a runner list. Keyed by file
 * and row label, so it survives a reword and reds when the row goes away.
 */
const DOC_PROSE_CELLS: Record<string, string> = {
	"docs/language-coverage.md#Java + Lombok":
		"Prose cell describing the JDT LS `-javaagent` launch, not a dispatch runner list.",
	"docs/language-coverage.md#Lean 4":
		"Mixed cell: `lsp` is checked, the tail is prose about the project's Lake toolchain.",
};

describe("Docs dispatch-runner tables (#5418)", () => {
	it("every Dispatch Runners name is a registered runner", () => {
		const flagged: { key: string; detail: string }[] = [];
		const proseCells: { key: string; detail: string }[] = [];
		const malformed: string[] = [];
		let scanned = 0;
		for (const relative of DOC_FILES) {
			const { cells, malformed: rows } = tableColumnCells(
				readDoc(relative),
				"Dispatch Runners",
			);
			scanned += cells.length;
			malformed.push(...rows.map((row) => `${relative} ${row}`));
			for (const { label, cell, line } of cells) {
				const { names, prose } = dispatchNameCandidates(cell);
				for (const name of names) {
					if (runnerIds.has(name)) continue;
					flagged.push({
						key: `${relative}#${label}#${name}`,
						detail: `${relative}:${line}: "${name}" is not a registered runner`,
					});
				}
				for (const text2 of prose) {
					proseCells.push({
						key: `${relative}#${label}`,
						detail: `${relative}:${line}: prose cell "${text2}"`,
					});
				}
			}
		}
		assertNonEmptyScan("dispatch-runner doc cells", scanned, 30);
		expect(
			malformed,
			`markdown rows whose cell count does not match their header: ${malformed.join("; ")}`,
		).toEqual([]);
		// Prose cells are exempted by key (they hold no runner name to check);
		// a name in a prose-free cell is flagged and must resolve.
		const audit = auditRegistry({
			sweepName: "registry-parity:docs-dispatch",
			flagged: [...flagged, ...proseCells],
			registered: [],
			exemptions: DOC_PROSE_CELLS,
			remediation:
				"Name a registered runner, fix the table row, or record the prose cell in DOC_PROSE_CELLS.",
		});
		expect(audit.problems).toEqual([]);
	});
});

describe("Docs autofix tool list (#5418)", () => {
	it("every docs autofix tool list names the pipeline's safe autofix tools", () => {
		// Every docs list of the shape `dispatch autofix (a/b/c)` must name the
		// pipeline's own autofix tools, so a copy in another doc drifts too.
		const lists = DOC_FILES.flatMap((relative) =>
			[...readDoc(relative).matchAll(/dispatch autofix \(([^)]*)\)/g)].map(
				(match) => ({ source: relative, body: match[1] }),
			),
		);
		assertNonEmptyScan("docs autofix tool lists", lists.length, 1);
		const real = new Set(listSafePipelineAutofixTools());
		const violations: string[] = [];
		for (const { source, body } of lists) {
			const documented = body
				.split("/")
				.map((entry) => entry.trim().split(/\s+/)[0])
				.filter(Boolean);
			assertNonEmptyScan(
				`documented autofix tools (${source})`,
				documented.length,
				10,
			);
			for (const name of documented.filter((name) => !real.has(name))) {
				violations.push(`${source} invents "${name}"`);
			}
			for (const name of [...real].filter(
				(name) => !documented.includes(name),
			)) {
				violations.push(`${source} omits "${name}"`);
			}
		}
		expect(
			violations,
			`docs autofix lists vs the pipeline's safe autofix tools: ${violations.join("; ")}`,
		).toEqual([]);
	});
});

describe("Doc table parser (#5418)", () => {
	it("reads only real table cells, never a paragraph that quotes a name", () => {
		const { cells, malformed } = tableColumnCells(
			`
Prose mentions ts-lsp and similarity outside any table.

| Language | LSP | Dispatch Runners |
| --- | --- | --- |
| Example | ✓ | lsp, phantom-runner |
| Prose | ✓ | launched with a project toolchain |
| Short | ✓
`,
			"Dispatch Runners",
		);
		expect(cells.map((cell) => cell.label)).toEqual(["Example", "Prose"]);
		expect(malformed).toHaveLength(1);
		expect(dispatchNameCandidates(cells[0].cell)).toEqual({
			names: ["lsp", "phantom-runner"],
			prose: [],
		});
		expect(dispatchNameCandidates(cells[1].cell)).toEqual({
			names: [],
			prose: ["launched with a project toolchain"],
		});
	});

	it("keeps a name in code font and drops a parenthetical qualifier", () => {
		expect(
			dispatchNameCandidates(
				"`lsp`, trivy-config (opt-in; Kubernetes manifests, CloudFormation), —",
			),
		).toEqual({
			names: ["lsp", "trivy-config"],
			prose: [],
		});
	});
});

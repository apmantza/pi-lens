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
 * exempted prose cell is a violation; a CLI argument that is neither a string
 * literal nor the one spec-driven form is a violation. The known-bad spellings
 * are never enumerated — the good set is admitted and everything else is refused.
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
import { censusSourceFiles, parseRoot } from "../support/ast-census.js";
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

	it("every command-spec managed tool id resolves to an installer entry", () => {
		// `resolveToolCommandWithInstallFallback` asks the installer for exactly
		// `spec.managedToolId ?? toolId`, so a dangling pointer is a silent
		// no-op repair path, not an error.
		const pointers = [...TOOL_COMMAND_SPECS.entries()].map(
			([toolId, spec]) => [toolId, spec.managedToolId ?? toolId] as const,
		);
		assertNonEmptyScan("command specs", pointers.length, 15);
		const dangling = pointers
			.filter(([, managedToolId]) => !installerIds.has(managedToolId))
			.map(([toolId, managedToolId]) => `${toolId}->${managedToolId}`);
		expect(
			dangling,
			`command specs whose managed tool id has no installer entry (drop the field, or make the install story a written reason): ${dangling.join(", ")}`,
		).toEqual([]);
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
					detail: `${cli} probed by ${[...files].sort().join(", ")}`,
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
 * the files that probe each one, plus every argument the scanner could not
 * classify (shape 69: an alias, an indirect call, a value through another
 * binding must red, never be skipped).
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
		for (const call of parseRoot(source).findAll({
			rule: { pattern: "createAvailabilityChecker($$$)" },
		})) {
			const [argument] =
				call
					.field("arguments")
					?.children()
					.filter((node) => node.isNamed()) ?? [];
			if (!argument) {
				problems.push(
					`${relative}: createAvailabilityChecker with no argument`,
				);
				continue;
			}
			if (argument.kind() === "string") {
				const cli = JSON5.parse<string>(argument.text());
				const seen = names.get(cli) ?? new Set<string>();
				seen.add(relative);
				names.set(cli, seen);
				continue;
			}
			// The one non-literal form: the id-keyed checker built from a
			// TOOL_COMMAND_SPECS entry. Its CLI is `spec.command`, and the
			// command-spec parity check above owns that population.
			if (argument.text() === "spec.command") continue;
			problems.push(
				`${relative}: unclassified createAvailabilityChecker argument ${argument.text()}`,
			);
		}
	}
	return { names, problems, scanned: files.length };
}

/**
 * A CLI a runner probes that the installer registry has no entry for is a
 * written decision, not an oversight. `auditRegistry` reds a reason whose hit
 * disappeared, so this table cannot grow into a screen that screens nothing.
 */
const HOST_TOOLCHAIN =
	"Host toolchain the project or image provides; pi-lens never installs a compiler, interpreter or shell.";

const RUNNER_CLI_SKIP_REASONS: Record<string, string> = {
	cl: HOST_TOOLCHAIN,
	clang: HOST_TOOLCHAIN,
	"clang++": HOST_TOOLCHAIN,
	gcc: HOST_TOOLCHAIN,
	"g++": HOST_TOOLCHAIN,
	"c++": HOST_TOOLCHAIN,
	cc: HOST_TOOLCHAIN,
	java: HOST_TOOLCHAIN,
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
};

describe("Runner CLI scanner (#5418)", () => {
	it("refuses a CLI argument that is not a literal or the spec form", () => {
		// Shape 69: an alias, an indirect call and a value through another
		// binding must reach the census as unclassified, not as a miss.
		expect(
			cliProblems(`
				const a = "phantom";
				createAvailabilityChecker(a, ".exe");
				const get = () => "phantom";
				createAvailabilityChecker(get(), ".exe");
				const holder = { cli: "phantom" };
				createAvailabilityChecker(holder.cli, ".exe");
			`),
		).toHaveLength(3);
	});

	it("counts neither a comment nor a string that only quotes the call", () => {
		expect(
			cliProblems(
				`
				// createAvailabilityChecker("phantom")
				const prose = 'createAvailabilityChecker("phantom")';
			`,
			),
		).toEqual([]);
	});
});

function cliProblems(source: string): string[] {
	const problems: string[] = [];
	for (const call of parseRoot(source).findAll({
		rule: { pattern: "createAvailabilityChecker($$$)" },
	})) {
		const [argument] =
			call
				.field("arguments")
				?.children()
				.filter((node) => node.isNamed()) ?? [];
		if (argument?.kind() === "string" || argument?.text() === "spec.command") {
			continue;
		}
		problems.push(argument?.text() ?? "<none>");
	}
	return problems;
}

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

const DOC_FILES = [
	"docs/language-coverage.md",
	"docs/features.md",
	"docs/agent-guide.md",
	"docs/agent-tools.md",
	"docs/configuration.md",
];

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
			const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
			const { cells, malformed: rows } = tableColumnCells(
				text,
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
			minFlagged: proseCells.length,
			remediation:
				"Name a registered runner, fix the table row, or record the prose cell in DOC_PROSE_CELLS.",
		});
		expect(audit.problems).toEqual([]);
	});
});

describe("Docs autofix tool list (#5418)", () => {
	it("the bus-event autofix list names exactly the safe pipeline autofix tools", () => {
		const text = fs.readFileSync(path.join(ROOT, "docs/features.md"), "utf8");
		const lists = [...text.matchAll(/dispatch autofix \(([^)]*)\)/g)].map(
			(match) => match[1],
		);
		assertNonEmptyScan("docs autofix tool lists", lists.length, 1);
		const documented = new Set(
			lists
				.flatMap((list) => list.split("/"))
				.map((entry) => entry.trim().split(/\s+/)[0])
				.filter(Boolean),
		);
		assertNonEmptyScan("documented autofix tools", documented.size, 10);
		const real = new Set(listSafePipelineAutofixTools());
		const invented = [...documented].filter((name) => !real.has(name));
		const undocumented = [...real].filter((name) => !documented.has(name));
		expect(
			[...invented, ...undocumented],
			`docs/features.md autofix list vs AUTOFIX_CAPABILITIES — invented: ${invented.join(", ")}; missing: ${undocumented.join(", ")}`,
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

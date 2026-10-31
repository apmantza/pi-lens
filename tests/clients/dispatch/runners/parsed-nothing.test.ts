/**
 * #1948: a runner whose parser reads NOTHING out of non-empty tool output must
 * leave a bounded record naming the tool, the exit status, the output length,
 * and the first output line.
 *
 * #1816 closed the adjacent hole — the tool produced no output at all. The one
 * left open hid five parser bugs for months: vale (#1933), taplo, stylelint,
 * phpstan (#1946), sqlfluff. Each received a real report, extracted zero
 * diagnostics, and recorded "succeeded, 0 diagnostics" — byte-for-byte what a
 * genuinely clean file records.
 *
 * The vale case is the reproduction here: `vale --output JSON` exits 1, writes
 * a full JSON report to stdout, and the pre-#1933 parser read a
 * `{ Data: { Files: [...] } }` envelope no vale binary emits. That fixture is
 * still unreadable by the CURRENT parser, so it reproduces the shape without
 * reverting the parser fix.
 *
 * Every assertion below is paired with its negative: a clean run must record
 * NOTHING, or a row per clean save would drown the ledger.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, getLinterPolicyForCwd } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	getLinterPolicyForCwd: vi.fn(),
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

vi.mock("../../../../clients/tool-policy.js", () => ({
	getLinterPolicyForCwd,
	markdownlintConfigArgs: () => [],
	hasMypyConfig: () => true,
	hasSqlfluffConfig: () => true,
	hasStylelintConfig: () => true,
	hasYamllintConfig: () => true,
	getAutofixCapability: () => ({
		toolSupportsFix: false,
		safePipelineAutofix: false,
		fixKind: "none",
	}),
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => true,
			isAvailableAsync: async () => true,
			getCommand: () => command,
		}),
		resolveToolCommandWithInstallFallback: async (
			_cwd: string,
			toolId: string,
		) => toolId,
		findLocalBinUpwards: () => null,
		lspPrimaryCoversFile: () => false,
		resolveAvailableOrInstall: async (_checker: unknown, toolId: string) =>
			toolId,
	}),
);

function createCtx(kind: string, filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

/**
 * The envelope the pre-#1933 vale parser expected and no vale binary emits.
 * Real-looking JSON, meaningful length, unreadable by the parser.
 */
const UNREADABLE_VALE_REPORT = JSON.stringify({
	Data: {
		Files: [
			{
				Path: "doc.md",
				Alerts: [{ Line: 1, Column: 1, Severity: "error", Message: "Wordy" }],
			},
		],
	},
});

/** A real vale report: flat map keyed by the linted path. */
const READABLE_VALE_REPORT = JSON.stringify({
	"doc.md": [
		{
			Line: 1,
			Span: [1, 6],
			Severity: "warning",
			Message: "Wordy",
			Check: "Vale.Terms",
		},
	],
});

/** A real vale report with nothing in it — the clean run. */
const CLEAN_VALE_REPORT = JSON.stringify({ "doc.md": [] });

// `vi.resetModules()` gives each test a FRESH module graph, so the ledger the
// runner writes to is only the same instance when it is imported from inside
// the same test.
async function ledger() {
	const mod = await import("../../../../clients/degradation-ledger.js");
	mod.resetDegradationLedger();
	return mod;
}

function parsedNothingRow(
	summary: {
		getDegradationSummary(): Array<{
			kind: string;
			count: number;
			latestReasons: Array<{ subject: string; reason: string }>;
		}>;
	},
	tool: string,
) {
	const group = summary
		.getDegradationSummary()
		.find((entry) => entry.kind === "runner-parsed-nothing");
	return {
		group,
		row: group?.latestReasons.find((entry) => entry.subject === tool),
	};
}

async function runVale(
	env: { tmpDir: string },
	spawn: { stdout?: string; stderr?: string; status: number | null },
) {
	fs.writeFileSync(path.join(env.tmpDir, ".vale.ini"), "StylesPath = styles\n");
	const filePath = path.join(env.tmpDir, "doc.md");
	fs.writeFileSync(filePath, "Some prose.\n");
	safeSpawnAsync.mockResolvedValue({
		stdout: spawn.stdout ?? "",
		stderr: spawn.stderr ?? "",
		status: spawn.status,
	});
	const runner = (await import("../../../../clients/dispatch/runners/vale.js"))
		.default;
	return runner.run(createCtx("markdown", filePath, env.tmpDir) as never);
}

describe("runner-parsed-nothing (#1948)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue(null);
	});

	it("records when vale fails and its report parses to zero alerts", async () => {
		const env = setupTestEnvironment("pi-lens-1948-vale-");
		try {
			const summary = await ledger();
			await runVale(env, { status: 1, stdout: UNREADABLE_VALE_REPORT });

			const { row } = parsedNothingRow(summary, "vale");
			expect(
				row,
				"expected a runner-parsed-nothing row for vale",
			).toBeDefined();
			// The reason must answer "which tool, how did it exit, how much did
			// it say, and what did it say first".
			expect(row?.reason).toContain("vale");
			expect(row?.reason).toContain("exited 1");
			expect(row?.reason).toContain(String(UNREADABLE_VALE_REPORT.length));
			expect(row?.reason).toContain("Data");
		} finally {
			env.cleanup();
		}
	});

	// Guard 2 (`if (!status)`). Deleting it makes this red: every clean save of
	// every markdown file would then write a ledger row.
	it("records NOTHING when vale exits 0 with a genuinely clean report", async () => {
		const env = setupTestEnvironment("pi-lens-1948-vale-clean-");
		try {
			const summary = await ledger();
			const result = await runVale(env, {
				status: 0,
				stdout: CLEAN_VALE_REPORT,
			});

			expect(result.status).toBe("succeeded");
			expect(result.diagnostics).toEqual([]);
			expect(parsedNothingRow(summary, "vale").group).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("records NOTHING when vale exits 0 with no output at all", async () => {
		const env = setupTestEnvironment("pi-lens-1948-vale-silent-");
		try {
			const summary = await ledger();
			const result = await runVale(env, { status: 0, stdout: "" });

			expect(result.status).toBe("succeeded");
			expect(parsedNothingRow(summary, "vale").group).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// Guard 1 (`if (parsedCount > 0)`). Deleting it makes this red.
	it("records NOTHING when a failing run DOES yield findings", async () => {
		const env = setupTestEnvironment("pi-lens-1948-vale-findings-");
		try {
			const summary = await ledger();
			const result = await runVale(env, {
				status: 1,
				stdout: READABLE_VALE_REPORT,
			});

			expect(result.diagnostics.length).toBeGreaterThan(0);
			expect(parsedNothingRow(summary, "vale").group).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// Blast radius: a permanently broken parser must cost ONE ledger row, not
	// one per dispatched file.
	it("keeps one bounded row per tool across repeated unparsable runs", async () => {
		const env = setupTestEnvironment("pi-lens-1948-vale-bound-");
		try {
			const summary = await ledger();
			for (let i = 0; i < 25; i += 1) {
				await runVale(env, { status: 1, stdout: UNREADABLE_VALE_REPORT });
			}
			const { group, row } = parsedNothingRow(summary, "vale");
			expect(
				group?.latestReasons.filter((entry) => entry.subject === "vale"),
			).toHaveLength(1);
			expect(group?.count).toBe(25);
			expect(row?.reason).toContain("(count: 25)");
		} finally {
			env.cleanup();
		}
	});

	// The record does NOT displace #1816's: a tool that produced nothing at all
	// still lands under `runner-empty-result`, so the two questions stay
	// separable in the ledger.
	it("leaves the no-output case with runner-empty-result, not this kind", async () => {
		const env = setupTestEnvironment("pi-lens-1948-vale-empty-");
		try {
			const summary = await ledger();
			const result = await runVale(env, {
				status: 1,
				stderr: "E100 [vale] runtime error",
			});

			expect(result.status).toBe("skipped");
			expect(parsedNothingRow(summary, "vale").group).toBeUndefined();
			expect(
				summary
					.getDegradationSummary()
					.find((entry) => entry.kind === "runner-empty-result"),
			).toBeDefined();
		} finally {
			env.cleanup();
		}
	});

	// taplo opts into `skipWhenParsedNothing`: its exit 1 means "this file is
	// INVALID", so claiming clean would be an outright lie. This replaced a
	// hand-rolled per-runner copy of the rule that wrote its own row.
	it("taplo skips AND records when its failing output parses to nothing", async () => {
		const env = setupTestEnvironment("pi-lens-1948-taplo-");
		try {
			const summary = await ledger();
			const filePath = path.join(env.tmpDir, "config.toml");
			fs.writeFileSync(filePath, "a = 1\n");
			safeSpawnAsync.mockResolvedValue({
				stdout: "",
				// Real taplo tracing output for a schema it could not load: no
				// codespan block, so the parser draws nothing from it.
				stderr:
					"WARN failed to load schema `https://example.invalid/s.json`: request failed\n",
				status: 1,
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/taplo.js")
			).default;
			const result = await runner.run(
				createCtx("toml", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
			const { row } = parsedNothingRow(summary, "taplo");
			expect(row?.reason).toContain("exited 1");
			expect(row?.reason).toContain("failed to load schema");
		} finally {
			env.cleanup();
		}
	});
});

/**
 * Round 2, finding F1. The first sweep watched `skipUnlessToolRan` alone, so
 * six runners on `spawnFailedWithNoOutput` opted out silently. Two of them
 * carried the live hole. These two cases pin the hole shut with real output
 * shapes, not with the sweep's static scan.
 */
describe("runners that reached the gate through spawnFailedWithNoOutput (#1948 F1)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue(null);
	});

	// Real `tflint --format=json` payload for a plugin or config failure: the
	// report IS valid JSON with an empty `issues` array and a populated
	// `errors` array the parser never reads. Exit 1, 0 diagnostics, reported
	// clean Terraform.
	const TFLINT_ERROR_REPORT = JSON.stringify({
		issues: [],
		errors: [
			{
				message:
					'Failed to load plugin "aws"; plugin binary not found in .tflint.d',
			},
		],
	});

	it("tflint records when its JSON carries errors the parser never reads", async () => {
		const env = setupTestEnvironment("pi-lens-1948-tflint-");
		try {
			const summary = await ledger();
			const filePath = path.join(env.tmpDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "null_resource" "a" {}\n');
			safeSpawnAsync.mockResolvedValue({
				stdout: TFLINT_ERROR_REPORT,
				stderr: "",
				status: 1,
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/tflint.js")
			).default;
			const result = await runner.run(
				createCtx("terraform", filePath, env.tmpDir) as never,
			);

			// #1839: the parsed-nothing degradation record still fires, AND the
			// result is no longer silently clean — a nonzero exit whose report
			// carries errors our parser never read surfaces as failed with an
			// explicit parse-error diagnostic.
			expect(result.status).toBe("failed");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toMatchObject({
				id: "tflint:parse-error:1",
				severity: "warning",
				semantic: "warning",
			});
			const { row } = parsedNothingRow(summary, "tflint");
			expect(
				row,
				"expected a runner-parsed-nothing row for tflint",
			).toBeDefined();
			expect(row?.reason).toContain("exited 1");
			expect(row?.reason).toContain("Failed to load plugin");
		} finally {
			env.cleanup();
		}
	});

	it("tflint records NOTHING on a clean exit-0 report", async () => {
		const env = setupTestEnvironment("pi-lens-1948-tflint-clean-");
		try {
			const summary = await ledger();
			const filePath = path.join(env.tmpDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "null_resource" "a" {}\n');
			safeSpawnAsync.mockResolvedValue({
				stdout: JSON.stringify({ issues: [], errors: [] }),
				stderr: "",
				status: 0,
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/tflint.js")
			).default;
			const result = await runner.run(
				createCtx("terraform", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(parsedNothingRow(summary, "tflint").group).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// #4522 review F2: exit 1 is admitted and skipWhenParsedNothing skips it
	// when the parser reads nothing, so the record is runner-parsed-nothing.
	it("detekt records when a config failure yields no parsable finding", async () => {
		const env = setupTestEnvironment("pi-lens-1948-detekt-");
		try {
			const summary = await ledger();
			fs.writeFileSync(path.join(env.tmpDir, "detekt.yml"), "build:\n");
			const filePath = path.join(env.tmpDir, "Main.kt");
			fs.writeFileSync(filePath, "fun main() {}\n");
			safeSpawnAsync.mockResolvedValue({
				stdout: "",
				stderr:
					'Exception in thread "main" InvalidConfig: Run failed with 1 invalid config property.\n',
				status: 1,
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/detekt.js")
			).default;
			const result = await runner.run(
				createCtx("kotlin", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
			const { row } = parsedNothingRow(summary, "detekt");
			expect(
				row,
				"expected a runner-parsed-nothing row for detekt",
			).toBeDefined();
			expect(row?.reason).toContain("invalid config property");
		} finally {
			env.cleanup();
		}
	});
});

describe("recordParsedNothing rule (#1948)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	async function helper() {
		const summary = await ledger();
		const mod =
			await import("../../../../clients/dispatch/runners/utils/tool-failure.js");
		return { summary, recordParsedNothing: mod.recordParsedNothing };
	}

	// Guard 3 (`if (!text.trim())`). Deleting it makes this red: the no-output
	// case would be recorded twice, once here and once as runner-empty-result.
	it("returns false and records nothing when the output is empty", async () => {
		const { summary, recordParsedNothing } = await helper();
		expect(
			recordParsedNothing({
				tool: "ruff",
				status: 2,
				output: "   \n  ",
				parsedCount: 0,
			}),
		).toBe(false);
		expect(summary.getDegradationSummary()).toEqual([]);
	});

	it("returns false when no exit status ever arrived", async () => {
		const { summary, recordParsedNothing } = await helper();
		expect(
			recordParsedNothing({
				tool: "ruff",
				status: null,
				output: "something",
				parsedCount: 0,
			}),
		).toBe(false);
		expect(summary.getDegradationSummary()).toEqual([]);
	});

	it("carries extra identity fields into the reason", async () => {
		const { summary, recordParsedNothing } = await helper();
		expect(
			recordParsedNothing({
				tool: "ruff",
				status: 2,
				output: "ruff said something we cannot read",
				parsedCount: 0,
				fields: { source: "managed" },
			}),
		).toBe(true);
		const { row } = parsedNothingRow(summary, "ruff");
		expect(row?.reason).toContain("source=managed");
	});
});

/**
 * #4522 matrix cells for detekt, fed by captured bytes through the production
 * runner. Exit 2 is detekt's findings class and exit 1 is its tool-error class
 * (a malformed config, an exception): `detekt --input … --config …` with an
 * invalid detekt.yml exits 1, prints nothing on stdout, and writes the
 * InvalidConfigurationError on stderr. The exit-1 bytes are
 * `tests/fixtures/runner-exit-codes/detekt/broken-config.captured.json`.
 *
 * Recurrence: exit 1 was admitted in the `ran` set and read clean (the
 * "an unanswered tool read clean" red of the tool-state matrix, #4522).
 */
describe("detekt captured exit-code matrix (#4522)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue(null);
	});

	function fixtureUrl(relative: string): URL {
		return new URL(relative, import.meta.url);
	}

	it("skips, never reads clean, when detekt exits 1 on a malformed config", async () => {
		const env = setupTestEnvironment("pi-lens-4522-detekt-exit1-");
		try {
			const summary = await ledger();
			const captured = JSON.parse(
				fs.readFileSync(
					fixtureUrl(
						"../../../fixtures/runner-exit-codes/detekt/broken-config.captured.json",
					),
					"utf8",
				),
			) as { exitCode: number; stdout: string; stderr: string };
			expect(captured.exitCode).toBe(1);
			fs.cpSync(
				fileURLToPath(
					fixtureUrl("../../../fixtures/runner-exit-codes/detekt/workspace/"),
				),
				env.tmpDir,
				{ recursive: true },
			);
			const filePath = path.join(env.tmpDir, "Bad.kt");
			safeSpawnAsync.mockResolvedValue({
				stdout: captured.stdout.split("__WORKSPACE__").join(env.tmpDir),
				stderr: captured.stderr.split("__WORKSPACE__").join(env.tmpDir),
				status: captured.exitCode,
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/detekt.js")
			).default;
			const result = await runner.run(
				createCtx("kotlin", filePath, env.tmpDir) as never,
			);

			expect(
				result.status,
				"detekt exit 1 on a malformed config reads as a completed analysis: an unanswered tool read clean",
			).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
			// #4522 T4: the skip's own record, not any degradation row. A different
			// kind (another tool's, or a different detekt record) must red here.
			const { group, row } = parsedNothingRow(summary, "detekt");
			expect(
				group,
				"the skip is recorded as runner-parsed-nothing",
			).toBeDefined();
			expect(row, "the record names detekt").toBeDefined();
		} finally {
			env.cleanup();
		}
	});

	it("keeps exit 2 with findings as a completed analysis", async () => {
		const env = setupTestEnvironment("pi-lens-4522-detekt-exit2-");
		try {
			const captured = JSON.parse(
				fs.readFileSync(
					fixtureUrl(
						"../../../fixtures/runner-output/detekt/real.captured.json",
					),
					"utf8",
				),
			) as { stdout: string; stderr: string };
			fs.cpSync(
				fileURLToPath(fixtureUrl("../../../fixtures/tool-smoke/detekt/")),
				env.tmpDir,
				{ recursive: true },
			);
			const filePath = path.join(env.tmpDir, "Bad.kt");
			safeSpawnAsync.mockResolvedValue({
				stdout: captured.stdout.split("__WORKSPACE__").join(env.tmpDir),
				stderr: captured.stderr.split("__WORKSPACE__").join(env.tmpDir),
				status: 2,
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/detekt.js")
			).default;
			const result = await runner.run(
				createCtx("kotlin", filePath, env.tmpDir) as never,
			);

			expect(result.status).not.toBe("skipped");
			expect(result.diagnostics.length).toBeGreaterThan(0);
			// #4522 F1: exit 2 is the complete findings class, so it is never flagged.
			expect(result.inconclusive).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

describe("detekt findings on stderr (#4522)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue(null);
	});

	// Moved here from nonzero-exit-no-output.test.ts: the witness ratchet reads
	// status literals per matrix file, so a detekt status here must not count as
	// a hadolint cell there. Exit 2 is detekt's measured findings class.
	it("detekt still parses findings that arrive on stderr with a nonzero exit", async () => {
		const env = setupTestEnvironment("pi-lens-detekt-stderr-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "detekt.yml"),
				"build:\n  maxIssues: 0\n",
			);
			const filePath = path.join(env.tmpDir, "Main.kt");
			fs.writeFileSync(filePath, 'fun main() { println("hi") }\n');
			safeSpawnAsync.mockResolvedValue({
				status: 2,
				stdout: "",
				stderr: `${filePath}:1:1: warning: This expression contains a magic number [MagicNumber]\n`,
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/detekt.js")
			).default;
			const result = await runner.run(
				createCtx("kotlin", filePath, env.tmpDir) as never,
			);

			expect(result.status).not.toBe("skipped");
			expect(result.diagnostics.length).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #4522 review F2: detekt can print a finding and then exit 1, when a
 * configuration value fails after the report is written. The captured bytes
 * are `tests/fixtures/runner-exit-codes/detekt/findings-then-exit1.captured.json`
 * (detekt 1.23.8, a non-numeric `build.weights` entry). The finding must
 * survive: a run that already printed findings is not an unanswered tool.
 *
 * Recurrence: exit 1 was rejected as a tool error before the parser ran, so
 * the printed finding was dropped (`skipped`, 0 diagnostics).
 */
describe("detekt findings printed before exit 1 (#4522 F2)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue(null);
	});

	it("keeps the finding when detekt prints it and then exits 1", async () => {
		const env = setupTestEnvironment("pi-lens-4522-detekt-findings-exit1-");
		try {
			const captured = JSON.parse(
				fs.readFileSync(
					new URL(
						"../../../fixtures/runner-exit-codes/detekt/findings-then-exit1.captured.json",
						import.meta.url,
					),
					"utf8",
				),
			) as { exitCode: number; stdout: string; stderr: string };
			expect(captured.exitCode).toBe(1);
			fs.cpSync(
				fileURLToPath(
					new URL(
						"../../../fixtures/runner-exit-codes/detekt/findings-workspace/",
						import.meta.url,
					),
				),
				env.tmpDir,
				{ recursive: true },
			);
			const filePath = path.join(env.tmpDir, "Bad.kt");
			safeSpawnAsync.mockResolvedValue({
				stdout: captured.stdout.split("__WORKSPACE__").join(env.tmpDir),
				stderr: captured.stderr.split("__WORKSPACE__").join(env.tmpDir),
				status: captured.exitCode,
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/detekt.js")
			).default;
			const result = await runner.run(
				createCtx("kotlin", filePath, env.tmpDir) as never,
			);

			expect(
				result.status,
				"detekt exit 1 after printing a finding read as skipped: the printed finding was dropped",
			).not.toBe("skipped");
			expect(result.diagnostics.map((d) => d.rule)).toContain(
				"ForbiddenComment",
			);
			// #4522 T1: a tool error after printed findings is an incomplete read, flagged
			// inconclusive, the existing "reached no verdict" shape (tree-sitter query-run-threw).
			expect(result.inconclusive).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});

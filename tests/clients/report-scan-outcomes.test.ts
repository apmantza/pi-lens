/**
 * One report-file scan lifecycle, four real scanners (#5411).
 *
 * `runReportScan` (`clients/report-scan.ts`) is the one scan body behind
 * GitleaksClient, TrivyClient, OpengrepClient and JscpdClient: the private
 * report directory, the spawn, the three failure outcomes, the exit-status
 * discrimination for a missing report, the parse, and the directory's removal.
 * Before this, gitleaks and trivy shared one copy (#4984) while opengrep and
 * jscpd each hand-rolled their own, so the same CLI outcome read as a clean
 * scan for one scanner and as a refusal for another — the shape #5411 was
 * filed over.
 *
 * What is pinned here is the AGREEMENT, not each client's wording: for every
 * cell, all four land on the same normalized verdict, each records the failure
 * exactly once in its OWN ledger lane, and each removes the report directory it
 * handed its CLI. Each client's own result fields, ledger kind and subject stay
 * its own (asserted in its own test file); what must not diverge is which
 * outcome is a run, which is an empty run, and which is a failure.
 *
 * Every case drives the client's real public `scan()` through the real
 * lifecycle; only the CLI process (`safeSpawnAsync`, the process boundary) is
 * faked, and it writes the report to the path the client itself put in argv.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeSpawn = {
	error?: Error;
	status: number | null;
	signal?: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

const safeSpawnAsync = vi.hoisted(() =>
	vi.fn(async (..._args: unknown[]): Promise<FakeSpawn> => {
		throw new Error("safeSpawnAsync double not configured");
	}),
);
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { GitleaksClient } from "../../clients/gitleaks-client.js";
import { JscpdClient } from "../../clients/jscpd-client.js";
import { OpengrepClient } from "../../clients/opengrep-client.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { TrivyClient } from "../../clients/trivy-client.js";
import { setupTestEnvironment } from "./test-utils.js";

/** The jscpd client of the running case, so teardown can drain its scan. */
let JSCPD: { shutdown: () => Promise<void> } | undefined;

const GITLEAKS_REPORT = JSON.stringify([
	{
		Description: "AWS Access Key",
		StartLine: 3,
		EndLine: 3,
		File: "src/config.ts",
		RuleID: "aws-access-token",
		Fingerprint: "src/config.ts:aws-access-token:3",
		Tags: [],
	},
]);
const TRIVY_REPORT = JSON.stringify({
	Results: [
		{
			Target: "package-lock.json",
			Vulnerabilities: [
				{
					VulnerabilityID: "CVE-2026-11111",
					PkgName: "left-pad",
					InstalledVersion: "1.0.0",
					Severity: "CRITICAL",
				},
			],
		},
	],
});
const OPENGREP_REPORT = JSON.stringify({
	results: [
		{
			check_id: "eval-probe",
			path: "src/a.js",
			start: { line: 1, col: 1 },
			end: { line: 1, col: 10 },
			extra: { message: "eval", severity: "WARNING", metadata: {} },
		},
	],
	errors: [],
	paths: { scanned: ["src/a.js"] },
});
const JSCPD_REPORT = JSON.stringify({
	duplicates: [
		{
			firstFile: { name: "src/a.ts", start: 1 },
			secondFile: { name: "src/b.ts", start: 1 },
			lines: 12,
			tokens: 60,
		},
	],
	statistics: { total: { duplicatedLines: 12, lines: 200, percentage: 6 } },
});

/** What the faked CLI does with the report path it was handed. */
type Cli = {
	write: "report" | "nothing" | "directory";
	status: number | null;
	signal?: NodeJS.Signals | null;
	stderr?: string;
	error?: Error;
};

/** The three verdicts an outcome may read as, for any of the four scanners. */
type Verdict = "analysed" | "empty-success" | "failed";

type Scanner = {
	name: "gitleaks" | "trivy" | "opengrep" | "jscpd";
	/** The argv flag that carries where the report lands. */
	reportFlag: string;
	/** jscpd hands its CLI a DIRECTORY and reads `<dir>/jscpd-report.json`. */
	reportFileInArgvValue: boolean;
	/** A report each client's own parser turns into exactly one result. */
	report: string;
	/** The ledger lane this client records its own scan failures in. */
	recordKind: string;
	/** A client whose missing-report reason names the command it ran (#1816). */
	namesCommandInReason?: boolean;
	/** A client that passes its own gates with the CLI double in place. */
	scan: (root: string) => Promise<unknown>;
	/** Wait for work this case started, so teardown cannot strand it. */
	drain?: () => Promise<void>;
};

const SCANNERS: Scanner[] = [
	{
		name: "gitleaks",
		reportFlag: "--report-path",
		reportFileInArgvValue: false,
		report: GITLEAKS_REPORT,
		recordKind: "security-scan-report-failed",
		scan: async (root) => {
			const client = new GitleaksClient(false);
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			return client.scan(root, { requireSignal: false });
		},
	},
	{
		name: "trivy",
		reportFlag: "--output",
		reportFileInArgvValue: false,
		report: TRIVY_REPORT,
		recordKind: "security-scan-report-failed",
		scan: async (root) => {
			fs.writeFileSync(
				path.join(root, ".pi-lens.json"),
				JSON.stringify({ trivy: { enabled: true } }),
			);
			fs.writeFileSync(path.join(root, "package.json"), "{}");
			resetProjectLensConfigCache();
			const client = new TrivyClient(false);
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			return client.scan(root);
		},
	},
	{
		name: "opengrep",
		reportFlag: "--json-output",
		reportFileInArgvValue: false,
		report: OPENGREP_REPORT,
		recordKind: "opengrep-scan-refused",
		scan: async (root) => {
			const client = new OpengrepClient(false);
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			return client.scan(root);
		},
	},
	{
		name: "jscpd",
		reportFlag: "--output",
		reportFileInArgvValue: true,
		report: JSCPD_REPORT,
		recordKind: "runner-empty-result",
		namesCommandInReason: true,
		scan: async (root) => {
			const client = new JscpdClient(false);
			JSCPD = client;
			// Same arm as the other three: the client's own gate is answered, the
			// spawn is the double's. jscpd resolves no project-local binary in the
			// fixture, so the run falls back to the `npx` form, which is what the
			// missing-report row names.
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			return client.scan(root, 5, 50, false);
		},
		drain: async () => {
			await JSCPD?.shutdown();
			JSCPD = undefined;
		},
	},
];

/**
 * Normalize one client's result shape onto the shared verdict. A successful
 * result that claims coverage (`analyzed: true`) is an analysed run; one that
 * claims none must be empty, or it is an empty run asserting findings it has no
 * evidence for.
 */
function verdictOf(result: unknown): Verdict {
	const r = result as {
		success?: boolean;
		analyzed?: boolean;
		findings?: unknown[];
		clones?: unknown[];
	};
	if (r.success !== true) return "failed";
	if (r.analyzed === true) return "analysed";
	expect(r.findings ?? r.clones ?? []).toEqual([]);
	return "empty-success";
}

/** How many rows each ledger kind holds, kinds with zero rows omitted. */
function recordCounts(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const row of getDegradationSummary()) {
		counts[row.kind] = (counts[row.kind] ?? 0) + 1;
	}
	return counts;
}

/** Every reason text the ledger holds, so a cell can name WHY it failed. */
function reasonText(): string {
	return getDegradationSummary()
		.flatMap((row) => row.latestReasons.map((entry) => JSON.stringify(entry)))
		.join("\n");
}

/**
 * The cells. `analysed` also asserts the parse ran (one result), so a client
 * that skipped its parse cannot pass the cell by reporting an empty success.
 */
const CELLS: Array<{
	name: string;
	cli: Cli;
	verdict: Verdict;
	/** True when the client's parser must have produced one result. */
	parsed?: boolean;
	/** Text the one ledger row of a failed cell must name (#31: the row says WHY). */
	expectReason?: string;
	/** A missing-report row, the one kind that carries #1816's `fields`. */
	missingReportRow?: boolean;
}> = [
	{
		name: "report present, exit 0",
		cli: { write: "report", status: 0 },
		verdict: "analysed",
		parsed: true,
	},
	{
		// #5411 acceptance: opengrep and trivy agree on a complete report with
		// a non-zero exit. `--no-error`/`--exit-code 0` do not make the exit a
		// verdict; the report's own content is.
		name: "complete report, exit 2",
		cli: { write: "report", status: 2, stderr: "warning text\n" },
		verdict: "analysed",
		parsed: true,
	},
	{
		name: "spawn error",
		cli: {
			write: "nothing",
			status: null,
			error: new Error("spawn exploded"),
			stderr: "",
		},
		verdict: "failed",
		expectReason: "spawn exploded",
	},
	{
		name: "non-zero exit, no report",
		cli: { write: "nothing", status: 1, stderr: "boom\nsecond line\n" },
		verdict: "failed",
		expectReason: "boom",
		missingReportRow: true,
	},
	{
		// A killed CLI wrote no report either: the shared reason names the
		// signal, which is the one explanation a null exit leaves (#5411).
		name: "killed by a signal, no report",
		cli: { write: "nothing", status: null, signal: "SIGKILL", stderr: "" },
		verdict: "failed",
		expectReason: "SIGKILL",
		missingReportRow: true,
	},
	{
		// The cell that divided the scanners: a zero exit that wrote no report
		// is an empty run for gitleaks/trivy/jscpd and was a refusal for
		// opengrep. One verdict, whatever its own wording.
		name: "exit 0, no report",
		cli: { write: "nothing", status: 0, stderr: "nothing to report\n" },
		verdict: "empty-success",
	},
	{
		// The read of the report throws (EISDIR), so the failure lands in the
		// lifecycle's guard, not in a client's own catch.
		name: "report path is a directory",
		cli: { write: "directory", status: 0, stderr: "" },
		verdict: "failed",
	},
];

describe.each(SCANNERS)("the shared report scan through $name", (scanner) => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let root: string;
	let reportParent: string;
	/** Report directories the client handed its CLI, in call order. */
	let reportDirs: string[];

	beforeEach(() => {
		env = setupTestEnvironment(`pi-lens-scan-align-${scanner.name}-`);
		root = path.join(env.tmpDir, "project");
		reportParent = path.join(env.tmpDir, "report-parent");
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		// jscpd only scans a root that has source files of its own.
		fs.writeFileSync(
			path.join(root, "src", "a.ts"),
			"export const value = 1;\nexport const other = 2;\n",
		);
		fs.mkdirSync(reportParent, { recursive: true });
		vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", reportParent);
		safeSpawnAsync.mockReset();
		reportDirs = [];
		resetDegradationLedger();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		resetProjectLensConfigCache();
		await scanner.drain?.();
		env.cleanup();
	});

	/** The CLI double: records the report path out of the client's own argv. */
	function fakeCli(cli: Cli): void {
		safeSpawnAsync.mockImplementation(async (_bin, argv) => {
			const args = argv as string[];
			if (!args.includes(scanner.reportFlag)) {
				return { error: undefined, status: 0, stdout: "", stderr: "" };
			}
			const value = args[args.indexOf(scanner.reportFlag) + 1]!;
			const reportPath = scanner.reportFileInArgvValue
				? path.join(value, `${scanner.name}-report.json`)
				: value;
			reportDirs.push(path.dirname(reportPath));
			expect(path.basename(reportPath)).toBe(`${scanner.name}-report.json`);
			expect(path.basename(path.dirname(reportPath))).toMatch(
				new RegExp(`^pi-lens-${scanner.name}-`),
			);
			expect(path.dirname(path.dirname(reportPath))).toBe(reportParent);
			if (cli.write === "report") fs.writeFileSync(reportPath, scanner.report);
			else if (cli.write === "directory") fs.mkdirSync(reportPath);
			return {
				error: cli.error,
				status: cli.status,
				signal: cli.signal ?? null,
				stdout: "",
				stderr: cli.stderr ?? "",
			};
		});
	}

	it.each(CELLS)(
		"reads $name as $verdict, once in its own lane",
		async (cell) => {
			fakeCli(cell.cli);

			const result = await scanner.scan(root);

			expect(verdictOf(result)).toBe(cell.verdict);
			if (cell.parsed) {
				const r = result as { findings?: unknown[]; clones?: unknown[] };
				expect(r.findings ?? r.clones).toHaveLength(1);
			}
			expect(recordCounts()).toEqual(
				cell.verdict === "failed" ? { [scanner.recordKind]: 1 } : {},
			);
			if (cell.expectReason) {
				expect(reasonText()).toContain(cell.expectReason);
			}
			if (scanner.namesCommandInReason && cell.missingReportRow) {
				// #1816's discriminating identity survives the shared reason builder:
				// the row names which jscpd the run was (`npx` fallback vs a binary).
				expect(reasonText()).toContain("command");
			}
			// The report directory the client created is gone on every path.
			expect(reportDirs).toHaveLength(1);
			expect(fs.existsSync(reportDirs[0]!)).toBe(false);
			expect(fs.readdirSync(reportParent)).toEqual([]);
		},
	);
});

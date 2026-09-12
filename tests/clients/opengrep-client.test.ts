import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as safeSpawn from "../../clients/safe-spawn.js";
import {
	OpengrepClient,
	parseOpengrepReport,
} from "../../clients/opengrep-client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

beforeEach(() => resetDegradationLedger());

describe("opengrep report outcomes (#2943)", () => {
	const finding = {
		check_id: "eval-probe",
		path: "src/a.js",
		start: { line: 1, col: 1 },
		end: { line: 1, col: 10 },
		extra: { message: "eval", severity: "WARNING", metadata: {} },
	};
	const clean = (results: unknown[] = [finding]) =>
		JSON.stringify({ results, errors: [], paths: { scanned: ["src/a.js"] } });
	const report = (errors: unknown[], results: unknown[] = [finding]) =>
		JSON.stringify({ results, errors, paths: { scanned: ["src/a.js"] } });

	type Expected = {
		success: boolean;
		reason?: string;
		partial?: true;
		findingCount: number;
		coverageCount: number;
		recordKind: "none" | "partial" | "refused";
		recordReason?: string;
	};
	type Row = {
		name: string;
		exitCode: number | null;
		report?: string | "directory";
		error?: Error;
		symlinkRoot?: boolean;
		expected: Expected;
	};
	const refused = (reason: string, recordReason?: string): Expected => ({
		success: false,
		reason,
		partial: undefined,
		findingCount: 0,
		coverageCount: 0,
		recordKind: "refused",
		...(recordReason ? { recordReason } : {}),
	});
	const usable = (partial = false): Expected => ({
		success: true,
		reason: undefined,
		...(partial ? { partial: true as const } : {}),
		...(!partial ? { partial: undefined } : {}),
		findingCount: 1,
		coverageCount: 1,
		recordKind: partial ? "partial" : "none",
		...(partial ? { recordReason: "invalid UTF-8" } : {}),
	});

	const outcomeRows: Row[] = [
		{
			name: "clean findings",
			exitCode: 0,
			report: clean(),
			expected: usable(),
		},
		{
			name: "clean findings through symlink root",
			exitCode: 0,
			report: clean(),
			symlinkRoot: true,
			expected: usable(),
		},
		{
			name: "clean empty results",
			exitCode: 0,
			report: clean([]),
			expected: { ...usable(), findingCount: 0, coverageCount: 1 },
		},
		{
			name: "warn PartialParsing",
			exitCode: 0,
			report: report([
				{ level: "warn", type: "PartialParsing", message: "invalid UTF-8" },
			]),
			expected: usable(true),
		},
		{
			name: "warn Out-of-memory",
			exitCode: 0,
			report: report([
				{ level: "warn", type: "Out-of-memory", message: "memory pressure" },
			]),
			expected: { ...usable(true), recordReason: "memory pressure" },
		},
		{
			name: "error SemgrepError",
			exitCode: 0,
			report: report([
				{ level: "error", type: "SemgrepError", message: "config failed" },
			]),
			expected: refused("refused", "config failed"),
		},
		{
			name: "warn then error",
			exitCode: 0,
			report: report([
				{ level: "warn", message: "warning" },
				{ level: "warn", message: "warning 2" },
				{ level: "error", message: "fatal error" },
			]),
			expected: refused("refused", "fatal error"),
		},
		{
			name: "null error entry",
			exitCode: 0,
			report: report([null]),
			expected: refused("refused", "unrecognised opengrep error entry"),
		},
		{
			name: "unclassified object",
			exitCode: 0,
			report: report([{ code: 2, type: "SemgrepError" }]),
			expected: refused("refused", "unrecognised opengrep error entry"),
		},
		{
			name: "bare string error",
			exitCode: 0,
			report: report(["failure text"]),
			expected: refused("refused", "failure text"),
		},
		{
			name: "info error",
			exitCode: 0,
			report: report([{ level: "info", message: "informational" }]),
			expected: refused("refused", "informational"),
		},
		{
			name: "fatal error",
			exitCode: 0,
			report: report([{ level: "fatal", message: "fatal" }]),
			expected: refused("refused", "fatal"),
		},
		{
			name: "uppercase WARN",
			exitCode: 0,
			report: report([{ level: "WARN", message: "uppercase warning" }]),
			expected: refused("refused", "uppercase warning"),
		},
		{
			name: "truncated JSON",
			exitCode: 0,
			report: '{"results":[',
			expected: refused("refused", "unparseable opengrep report"),
		},
		{
			name: "missing result and error arrays",
			exitCode: 0,
			report: "{}",
			expected: refused("refused", "unparseable opengrep report"),
		},
		{
			name: "clean report exit 2",
			exitCode: 2,
			report: clean(),
			expected: refused("refused", "opengrep exited with status 2"),
		},
		{
			name: "clean report exit 1",
			exitCode: 1,
			report: clean(),
			expected: refused("refused", "opengrep exited with status 1"),
		},
		{
			name: "exit 137 without report",
			exitCode: 137,
			expected: { ...refused("no-report"), recordReason: "no report produced" },
		},
		{
			name: "missing report",
			exitCode: 0,
			expected: { ...refused("no-report"), recordReason: "no report produced" },
		},
		{
			name: "spawn ENOENT",
			exitCode: null,
			error: new Error("spawn opengrep ENOENT"),
			expected: {
				...refused("spawn-failed"),
				recordReason: "spawn: spawn opengrep ENOENT",
			},
		},
		{
			name: "directory report path",
			exitCode: 0,
			report: "directory",
			expected: {
				...refused("crashed"),
				recordReason: "EISDIR: illegal operation on a directory, read",
			},
		},
	];

	it.each(outcomeRows)(
		"classifies $name through the real client",
		async (row) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "p2943-client-"));
			const scanRoot = row.symlinkRoot ? `${root}-link` : root;
			if (row.symlinkRoot) fs.symlinkSync(root, scanRoot, "dir");
			vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
				async (_command, args: string[]) => {
					if (row.symlinkRoot) expect(args.at(-1)).toBe(root);
					const reportPath = args[args.indexOf("--json-output") + 1];
					if (row.report === "directory") fs.mkdirSync(reportPath);
					else if (row.report) fs.writeFileSync(reportPath, row.report);
					return {
						status: row.exitCode,
						stdout: "",
						stderr: row.name.includes("report") ? "no report produced" : "",
						...(row.error
							? { error: row.error, failure: "spawn" as const }
							: {}),
					};
				},
			);
			try {
				const client = new OpengrepClient();
				client.ensureAvailable = vi.fn().mockResolvedValue(true);
				const result = await client.scan(scanRoot);
				const records = getDegradationSummary();
				const actual = {
					success: result.success,
					reason: result.reason,
					partial: result.partial,
					findingCount: result.findings.length,
					coverageCount: result.analyzedFiles?.length ?? 0,
					recordKind:
						records.length === 0
							? "none"
							: records[0].kind === "opengrep-partial-scan"
								? "partial"
								: "refused",
					recordReason: records[0]?.latestReasons[0]?.reason,
				};
				expect(actual).toEqual(row.expected);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
				if (row.symlinkRoot) fs.rmSync(scanRoot, { force: true });
			}
		},
	);
});

/**
 * #591 review: opengrep's LSP mode does NOT honor `// nosemgrep` natively
 * (that's exactly why `isNosemgrepSuppressed`/`applyAuxiliarySuppressions`
 * exist — #441/#586/#587 — as pi-lens's own filter for the LSP path). Before
 * assuming the CLI `scan --json` path is fine "because it's the real engine",
 * this was verified empirically against the real installed opengrep 1.25.0
 * binary: a fixture with a `subprocess.call(cmd, shell=True)`/`eval(cmd)`
 * finding annotated `# nosemgrep` / `// nosemgrep`, and an identical
 * unannotated twin below it. Ran `opengrep scan --config auto --json
 * --json-output <file>` for real; the raw JSON below is the CAPTURED,
 * unedited report — only the annotated line's finding is absent from
 * `results`. Conclusion: the CLI scan engine suppresses `nosemgrep`-annotated
 * findings itself, before they ever reach `--json` output, so
 * `opengrepResultToProjectDiagnostics` needs no suppression filtering of its
 * own (unlike the LSP path).
 */
describe("opengrep CLI honors `nosemgrep` natively — no pi-lens-side filtering needed (#584/#591)", () => {
	it("Python fixture: `subprocess.call(cmd, shell=True)  # nosemgrep` (line 4) is absent; the unannotated twin (line 7) is the only result", () => {
		// Captured verbatim from a real `opengrep scan --config auto --json
		// --json-output` run against:
		//   import subprocess
		//   def run_flagged(cmd):
		//       subprocess.call(cmd, shell=True)  # nosemgrep
		//   def run_unflagged(cmd):
		//       subprocess.call(cmd, shell=True)
		const raw =
			'{"version":"1.25.0","results":[{"check_id":"python.lang.security.audit.subprocess-shell-true.subprocess-shell-true","path":"fixture\\\\nosemgrep_test.py","start":{"line":7,"col":32,"offset":147},"end":{"line":7,"col":36,"offset":151},"extra":{"metavars":{"$FUNC":{"start":{"line":7,"col":16,"offset":131},"end":{"line":7,"col":20,"offset":135},"abstract_content":"call"},"$TRUE":{"start":{"line":7,"col":32,"offset":147},"end":{"line":7,"col":36,"offset":151},"abstract_content":"True"}},"message":"Found \'subprocess\' function \'call\' with \'shell=True\'. This is dangerous because this call will spawn the command using a shell process. Doing so propagates current shell settings and variables, which makes it much easier for a malicious actor to execute commands. Use \'shell=False\' instead.","fix":"False","metadata":{"cwe":["CWE-78: Improper Neutralization of Special Elements used in an OS Command (\'OS Command Injection\')"]},"severity":"ERROR","fingerprint":"563338bfedb79060e8af35a7cdfc9bfbb14142a1cbac24b9526a443e8dde76ee59b35bc235e7b56ccc37f7181e9a680f36c8aa5292976f40490ca7087f9f82b6_1","lines":"    subprocess.call(cmd, shell=True)","is_ignored":false,"validation_state":"NO_VALIDATOR","engine_kind":"OSS"}}],"errors":[],"paths":{"scanned":["fixture\\\\nosemgrep_test.py"]},"interfile_languages_used":[],"skipped_rules":[]}';
		const findings = parseOpengrepReport(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0].startLine).toBe(7); // the UNANNOTATED line — line 4 never appears
	});

	it("JS fixture: `eval(cmd); // nosemgrep` (line 2) is absent; the unannotated twin (line 5) is the only result", () => {
		// Captured verbatim from a real `opengrep scan --config auto --json
		// --json-output` run against:
		//   function run(cmd) {
		//     eval(cmd); // nosemgrep
		//   }
		//   function run2(cmd) {
		//     eval(cmd);
		//   }
		const raw =
			'{"version":"1.25.0","results":[{"check_id":"javascript.browser.security.eval-detected.eval-detected","path":"fixture\\\\nosemgrep_test.js","start":{"line":5,"col":3,"offset":71},"end":{"line":5,"col":12,"offset":80},"extra":{"metavars":{},"message":"Detected the use of eval().","metadata":{"cwe":["CWE-95: Improper Neutralization of Directives in Dynamically Evaluated Code (\'Eval Injection\')"]},"severity":"WARNING","fingerprint":"9c3a5e269ca7564bd58880de2bbd2cce77b1d667ee54660b15d77ffe26bce8b04e3b26229e2692e5c8e8fe637fccd559e3e3c36dc3ae62e2ec5fae49b72a0596_1","lines":"  eval(cmd);","is_ignored":false,"validation_state":"NO_VALIDATOR","engine_kind":"OSS"}}],"errors":[],"paths":{"scanned":["fixture\\\\nosemgrep_test.js"]},"interfile_languages_used":[],"skipped_rules":[]}';
		const findings = parseOpengrepReport(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0].startLine).toBe(5); // the UNANNOTATED line — line 2 never appears
	});
});

describe("parseOpengrepReport (#584)", () => {
	it("returns an empty list for empty / whitespace input", () => {
		expect(parseOpengrepReport("")).toEqual([]);
		expect(parseOpengrepReport("   \n\n")).toEqual([]);
	});

	it("returns an empty list for a clean scan (empty results array)", () => {
		// Real shape from a clean `opengrep scan --json` run (verified against
		// the installed 1.25.0 binary).
		const raw = JSON.stringify({
			version: "1.25.0",
			results: [],
			errors: [],
			paths: { scanned: ["fixture/test.js"] },
		});
		expect(parseOpengrepReport(raw)).toEqual([]);
	});

	it("returns [] for malformed JSON rather than throwing", () => {
		expect(parseOpengrepReport("{not valid")).toEqual([]);
	});

	it("returns [] when `results` is missing or not an array", () => {
		expect(parseOpengrepReport('{"version":"1.25.0"}')).toEqual([]);
		expect(parseOpengrepReport('{"results":"oops"}')).toEqual([]);
	});

	it("maps opengrep's real finding shape (semgrep-compatible JSON) into the structured form", () => {
		// Captured verbatim (trimmed) from a real `opengrep scan --config auto
		// --json` run against a fixture with `subprocess.call(cmd, shell=True)`.
		const raw = JSON.stringify({
			version: "1.25.0",
			results: [
				{
					check_id:
						"python.lang.security.audit.subprocess-shell-true.subprocess-shell-true",
					path: "fixture/test.py",
					start: { line: 3, col: 32, offset: 63 },
					end: { line: 3, col: 36, offset: 67 },
					extra: {
						message:
							"Found 'subprocess' function 'call' with 'shell=True'. This is dangerous.",
						severity: "ERROR",
						metadata: {
							cwe: [
								"CWE-78: Improper Neutralization of Special Elements used in an OS Command ('OS Command Injection')",
							],
							owasp: ["A01:2017 - Injection"],
						},
						fingerprint: "abc123",
					},
				},
			],
			errors: [],
			paths: { scanned: ["fixture/test.py"] },
		});
		const findings = parseOpengrepReport(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			checkId:
				"python.lang.security.audit.subprocess-shell-true.subprocess-shell-true",
			path: "fixture/test.py",
			startLine: 3,
			startCol: 32,
			endLine: 3,
			endCol: 36,
			message:
				"Found 'subprocess' function 'call' with 'shell=True'. This is dangerous.",
			severity: "ERROR",
			cwe: [
				"CWE-78: Improper Neutralization of Special Elements used in an OS Command ('OS Command Injection')",
			],
		});
	});

	it("skips entries missing the required fields (check_id / path / start.line)", () => {
		const raw = JSON.stringify({
			results: [
				{ check_id: "valid", path: "a.py", start: { line: 1 } },
				{ path: "missing-check-id.py", start: { line: 2 } },
				{ check_id: "missing-path", start: { line: 3 } },
				{ check_id: "missing-start", path: "b.py" },
				{ check_id: "non-numeric-line", path: "c.py", start: { line: "oops" } },
			],
		});
		const findings = parseOpengrepReport(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0].checkId).toBe("valid");
	});

	it("defaults severity to WARNING and message to a placeholder when extra is missing", () => {
		const raw = JSON.stringify({
			results: [{ check_id: "minimal", path: "x.py", start: { line: 1 } }],
		});
		const findings = parseOpengrepReport(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			checkId: "minimal",
			path: "x.py",
			startLine: 1,
			severity: "WARNING",
			message: "opengrep finding",
		});
		expect(findings[0].cwe).toBeUndefined();
	});

	it("preserves multiple findings in order", () => {
		const raw = JSON.stringify({
			results: [
				{ check_id: "rule-a", path: "x.py", start: { line: 1 } },
				{ check_id: "rule-b", path: "y.py", start: { line: 2 } },
				{ check_id: "rule-c", path: "z.py", start: { line: 3 } },
			],
		});
		const findings = parseOpengrepReport(raw);
		expect(findings.map((f) => f.checkId)).toEqual([
			"rule-a",
			"rule-b",
			"rule-c",
		]);
	});

	it("falls back endLine/endCol to start when `end` is absent", () => {
		const raw = JSON.stringify({
			results: [
				{ check_id: "no-end", path: "x.py", start: { line: 5, col: 3 } },
			],
		});
		const findings = parseOpengrepReport(raw);
		expect(findings[0]).toMatchObject({ endLine: 5, endCol: 1, startCol: 3 });
	});
});

describe("opengrep coverage evidence (#2887)", () => {
	it("real client transports paths.scanned as analyzedFiles", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opengrep-"));
		const client = new OpengrepClient();
		client.ensureAvailable = vi.fn().mockResolvedValue(true);
		vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
			async (_command, args: string[]) => {
				const report = args[args.indexOf("--json-output") + 1];
				fs.writeFileSync(
					report,
					JSON.stringify({ results: [], paths: { scanned: ["src/a.py"] } }),
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		);
		try {
			const result = await client.scan(root);
			expect(result.analyzed).toBe(true);
			expect(result.analyzedFiles).toEqual([path.resolve(root, "src/a.py")]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

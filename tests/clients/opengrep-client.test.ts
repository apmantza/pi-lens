import { describe, expect, it } from "vitest";
import { parseOpengrepReport } from "../../clients/opengrep-client.js";

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
		expect(findings.map((f) => f.checkId)).toEqual(["rule-a", "rule-b", "rule-c"]);
	});

	it("falls back endLine/endCol to start when `end` is absent", () => {
		const raw = JSON.stringify({
			results: [{ check_id: "no-end", path: "x.py", start: { line: 5, col: 3 } }],
		});
		const findings = parseOpengrepReport(raw);
		expect(findings[0]).toMatchObject({ endLine: 5, endCol: 1, startCol: 3 });
	});
});

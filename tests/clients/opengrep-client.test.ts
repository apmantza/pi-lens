import { describe, expect, it } from "vitest";
import { parseOpengrepReport } from "../../clients/opengrep-client.js";

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

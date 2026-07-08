import { describe, expect, it } from "vitest";
import { isNosemgrepSuppressed } from "../../../clients/dispatch/auxiliary-lsp.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";

// Minimal LSPDiagnostic for the matcher: it only reads range.start.line + code.
function diag(line0Based: number, code?: string): LSPDiagnostic {
	return {
		range: {
			start: { line: line0Based, character: 0 },
			end: { line: line0Based, character: 1 },
		},
		message: "finding",
		severity: 1,
		code,
	} as unknown as LSPDiagnostic;
}

const RULE = "python.lang.security.audit.subprocess-shell-true.subprocess-shell-true";

describe("isNosemgrepSuppressed (#441)", () => {
	it("bare `# nosemgrep` on the finding's line suppresses it", () => {
		const content = "import subprocess\nsubprocess.run('ls', shell=True)  # nosemgrep\n";
		expect(isNosemgrepSuppressed(diag(1, RULE), content)).toBe(true);
	});

	it("`# nosemgrep` on the line above suppresses the finding", () => {
		const content = "import subprocess\n# nosemgrep\nsubprocess.run('ls', shell=True)\n";
		expect(isNosemgrepSuppressed(diag(2, RULE), content)).toBe(true);
	});

	it("`# nosemgrep: <rule-id>` suppresses only that rule", () => {
		const content = `subprocess.run('ls', shell=True)  # nosemgrep: ${RULE}\n`;
		expect(isNosemgrepSuppressed(diag(0, RULE), content)).toBe(true);
		expect(isNosemgrepSuppressed(diag(0, "some.other.rule"), content)).toBe(false);
	});

	it("supports comma-separated rule ids", () => {
		const content = "x = 1  # nosemgrep: rule-a, rule-b\n";
		expect(isNosemgrepSuppressed(diag(0, "rule-b"), content)).toBe(true);
		expect(isNosemgrepSuppressed(diag(0, "rule-c"), content)).toBe(false);
	});

	it("does NOT suppress a finding on an unrelated line", () => {
		const content = "a()  # nosemgrep\nb()\n";
		expect(isNosemgrepSuppressed(diag(1, RULE), content)).toBe(false);
	});

	it("is a no-op with no nosemgrep comment", () => {
		const content = "subprocess.run('ls', shell=True)\n";
		expect(isNosemgrepSuppressed(diag(0, RULE), content)).toBe(false);
	});
});

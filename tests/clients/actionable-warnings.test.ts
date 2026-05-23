import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildActionableWarningsReport,
	createActionableWarningId,
	formatActionableWarningsAdvisory,
	recordFromDispatchDiagnostic,
} from "../../clients/actionable-warnings.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => ({
		supportsLSP: () => false,
	}),
}));

function makeWarning(filePath: string): Diagnostic {
	return {
		id: "tree:no-console:10",
		message: "console.log in test block — use proper assertions or logging",
		filePath,
		line: 10,
		column: 2,
		severity: "warning",
		semantic: "warning",
		tool: "tree-sitter",
		rule: "no-console-in-tests",
		fixable: true,
		fixKind: "suggestion",
		fixSuggestion: "remove this statement",
	};
}

describe("actionable warnings", () => {
	it("creates stable ids for equivalent diagnostics", () => {
		const cwd = path.join(os.tmpdir(), "project");
		const filePath = path.join(cwd, "src", "a.ts");
		const left = createActionableWarningId({
			cwd,
			filePath,
			tool: "tree-sitter",
			rule: "no-console",
			message: "Remove   console.log",
			line: 3,
		});
		const right = createActionableWarningId({
			cwd,
			filePath,
			tool: "tree-sitter",
			rule: "no-console",
			message: "remove console.log",
			line: 3,
		});
		expect(left).toBe(right);
		expect(left).toMatch(/^aw:[0-9a-f]{10}$/);
	});

	it("serializes dispatch fixable warnings into the turn report", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-"));
		const filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "console.log('x');\n");
		try {
			const record = recordFromDispatchDiagnostic(makeWarning(filePath), cwd);
			expect(record).toBeDefined();
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: "s1",
				turnIndex: 2,
				files: ["src/a.ts"],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: record ? [record] : [],
				includeLspCodeActions: false,
			});
			expect(report.summary).toMatchObject({
				warnings: 1,
				unsuppressed: 1,
				files: 1,
			});
			expect(report.files[0]?.warnings[0]?.fixSuggestion).toBe(
				"remove this statement",
			);
			expect(formatActionableWarningsAdvisory(report)).toContain(
				"Fixable warnings introduced this turn: 1",
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

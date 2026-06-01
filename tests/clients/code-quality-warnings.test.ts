import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendCodeQualityWarningsHistory,
	buildCodeQualityWarningsReport,
	formatCodeQualityWarningsAdvisory,
	getCodeQualityWarningsHistoryPath,
	recordFromCodeQualityDiagnostic,
} from "../../clients/code-quality-warnings.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { setupTestEnvironment } from "./test-utils.js";

function makeQualityWarning(filePath: string): Diagnostic {
	return {
		id: "quality:complexity:10",
		message: "'fn' has cyclomatic complexity 20 — consider breaking it up",
		filePath,
		line: 10,
		column: 1,
		severity: "warning",
		semantic: "warning",
		tool: "high-complexity",
		rule: "high-complexity",
	};
}

describe("code quality warnings", () => {
	it("records non-fixable warning diagnostics", () => {
		const cwd = path.join("tmp", "project");
		const filePath = path.join(cwd, "src", "a.ts");
		const record = recordFromCodeQualityDiagnostic(
			makeQualityWarning(filePath),
			cwd,
		);
		expect(record).toMatchObject({
			tool: "high-complexity",
			rule: "high-complexity",
			category: "maintainability",
			line: 10,
		});
		expect(record?.id).toMatch(/^cq:[0-9a-f]{10}$/);
	});

	it("excludes fixable diagnostics that belong in actionable warnings", () => {
		const cwd = path.join("tmp", "project");
		const filePath = path.join(cwd, "src", "a.ts");
		expect(
			recordFromCodeQualityDiagnostic(
				{
					...makeQualityWarning(filePath),
					fixable: true,
					fixSuggestion: "run fixer",
				},
				cwd,
			),
		).toBeUndefined();
	});

	it("builds a modified-range filtered report and advisory", () => {
		const cwd = path.join("tmp", "project");
		const filePath = path.resolve(cwd, "src", "a.ts");
		const included = recordFromCodeQualityDiagnostic(
			makeQualityWarning(filePath),
			cwd,
		);
		const excluded = recordFromCodeQualityDiagnostic(
			{
				...makeQualityWarning(filePath),
				id: "quality:complexity:100",
				line: 100,
			},
			cwd,
		);
		const report = buildCodeQualityWarningsReport({
			cwd,
			sessionId: "s1",
			turnIndex: 3,
			projectSeqStart: 10,
			projectSeqEnd: 12,
			fileSeqByPath: new Map([[filePath.replace(/\\/g, "/"), 2]]),
			warnings: [included!, excluded!],
			modifiedRangesByFile: new Map([
				[filePath.replace(/\\/g, "/"), [{ start: 9, end: 11 }]],
			]),
		});

		expect(report.summary).toMatchObject({ warnings: 1, files: 1 });
		expect(report).toMatchObject({ projectSeqStart: 10, projectSeqEnd: 12 });
		expect(report.files[0]?.fileSeq).toBe(2);
		expect(report.summary.topRules).toEqual([
			{ rule: "high-complexity", count: 1 },
		]);
		expect(formatCodeQualityWarningsAdvisory(report)).toContain(
			"Code-quality warnings introduced/touched this turn: 1",
		);
	});

	it("appends warnings to a project history jsonl", () => {
		const env = setupTestEnvironment("code-quality-history-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			const filePath = path.resolve(cwd, "src", "a.ts");
			const warning = recordFromCodeQualityDiagnostic(
				makeQualityWarning(filePath),
				cwd,
			);
			const report = buildCodeQualityWarningsReport({
				cwd,
				sessionId: "s-history",
				turnIndex: 9,
				warnings: [warning!],
				modifiedRangesByFile: new Map(),
			});

			appendCodeQualityWarningsHistory(cwd, report);
			appendCodeQualityWarningsHistory(cwd, report);

			const historyPath = getCodeQualityWarningsHistoryPath(cwd);
			const entries = fs
				.readFileSync(historyPath, "utf8")
				.trim()
				.split(/\r?\n/)
				.map(
					(line) =>
						JSON.parse(line) as {
							sessionId: string;
							turnIndex: number;
							warningId: string;
						},
				);
			expect(entries).toHaveLength(2);
			expect(entries[0]).toMatchObject({
				sessionId: "s-history",
				turnIndex: 9,
				warningId: warning!.id,
			});
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});
});

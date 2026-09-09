import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	_setBeforeWarningStateLockForTests,
	buildActionableWarningsReport,
	checkActionableWarningsReportFresh,
	createActionableWarningId,
	formatActionableWarningsAdvisory,
	recordFromDispatchDiagnostic,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { removeTempDirSync } from "./test-utils.js";

// PRE-#1816 id formula, reproduced here (not imported — it no longer exists
// in source) only so the migration test below can seed a suppression store
// exactly as it would have been written by a pre-fix build.
function legacyActionableWarningIdForTest(args: {
	cwd: string;
	filePath: string;
	tool?: string;
	source?: string;
	code?: string | number;
	rule?: string;
	message: string;
	line?: number;
}): string {
	const rel = path.relative(args.cwd, args.filePath).replace(/\\/g, "/");
	const legacyRelativeFile =
		rel && !rel.startsWith("..") ? rel : normalizeMapKey(args.filePath);
	const normalized = args.message.replace(/\s+/g, " ").trim().toLowerCase();
	const parts = [
		legacyRelativeFile,
		args.tool ?? "",
		args.source ?? "",
		String(args.code ?? ""),
		args.rule ?? "",
		normalized,
		String(args.line ?? ""),
	];
	return `aw:${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 10)}`;
}

vi.mock("../../clients/lsp/index.js", () => ({
	// `supportsLSP: false` short-circuits `buildActionableWarningsReport` before
	// it reaches any other service method; the rest of the surface comes from the
	// factory so a method added to the production path cannot TypeError into this
	// suite's swallow-all catch (#2592).
	getLSPService: () => makeLspServiceDouble({ supportsLSP: () => false }),
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
	it("preserves a sibling writer's concurrent suppression", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-lock-"));
		const filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "console.log('x');\n");
		const record = recordFromDispatchDiagnostic(makeWarning(filePath), cwd);
		expect(record).toBeDefined();
		try {
			_setBeforeWarningStateLockForTests(() => {
				const projectData = getProjectDataDir(cwd);
				const suppressionPath = path.join(
					projectData,
					"cache",
					"actionable-warning-state.json",
				);
				fs.mkdirSync(path.dirname(suppressionPath), { recursive: true });
				fs.writeFileSync(
					suppressionPath,
					JSON.stringify({
						warnings: {
							[record!.id]: {
								status: "suppressed",
								reason: "writer B",
							},
						},
					}),
				);
			});
			await buildActionableWarningsReport({
				cwd,
				sessionId: "writer-a",
				turnIndex: 1,
				files: [filePath],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: [record!],
				includeLspCodeActions: false,
			});
			const persisted = JSON.parse(
				fs.readFileSync(
					path.join(
						getProjectDataDir(cwd),
						"cache",
						"actionable-warning-state.json",
					),
					"utf8",
				),
			) as { warnings: Record<string, { status?: string; reason?: string }> };
			expect(persisted.warnings[record!.id]).toMatchObject({
				status: "suppressed",
				reason: "writer B",
			});
		} finally {
			_setBeforeWarningStateLockForTests(null);
			removeTempDirSync(cwd);
		}
	});

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
		// #1816: unified onto finding-identity.ts's 12-char hash length (was 10).
		expect(left).toMatch(/^aw:[0-9a-f]{12}$/);
	});

	it("detects stale actionable warning reports by project and file sequence", () => {
		const report: ActionableWarningsReport = {
			generatedAt: new Date().toISOString(),
			scope: "turn_delta",
			sessionId: "s1",
			turnIndex: 1,
			projectSeqEnd: 5,
			deltaOnly: true,
			includeLspCodeActions: true,
			files: [
				{
					filePath: path.join(os.tmpdir(), "project", "src", "a.ts"),
					displayPath: "src/a.ts",
					fileSeq: 2,
					warnings: [],
				},
			],
			summary: {
				warnings: 0,
				unsuppressed: 0,
				suppressed: 0,
				files: 1,
				actions: 0,
				autoFixEligible: 0,
			},
		};

		expect(
			checkActionableWarningsReportFresh({
				report,
				currentProjectSeq: 6,
			}),
		).toMatchObject({ fresh: false, reason: "project_seq_mismatch" });
		expect(
			checkActionableWarningsReportFresh({
				report,
				currentProjectSeq: 5,
				getFileSeq: () => 3,
			}),
		).toMatchObject({ fresh: false, reason: "file_seq_mismatch" });
		expect(
			checkActionableWarningsReportFresh({
				report,
				currentProjectSeq: 5,
				getFileSeq: () => 2,
			}),
		).toMatchObject({ fresh: true });
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
				projectSeqStart: 4,
				projectSeqEnd: 5,
				fileSeqByPath: new Map([[filePath.replace(/\\/g, "/"), 1]]),
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
			expect(report).toMatchObject({ projectSeqStart: 4, projectSeqEnd: 5 });
			expect(report.files[0]?.fileSeq).toBe(1);
			expect(report.files[0]?.warnings[0]?.fixSuggestion).toBe(
				"remove this statement",
			);
			expect(formatActionableWarningsAdvisory(report, cwd)).toContain(
				"Fixable warnings introduced this turn: 1",
			);
		} finally {
			removeTempDirSync(cwd);
		}
	});

	// #1777: the dispatch path now preserves hint and info, so the fixable-warning
	// advisory says how much of its count is style opinion rather than defect.
	it("splits the turn report by severity tier and names the quiet tiers", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-tier-"));
		const filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "console.log('x');\n");
		try {
			const records = (["warning", "hint", "hint"] as const).map(
				(severity, index) =>
					recordFromDispatchDiagnostic(
						{
							...makeWarning(filePath),
							id: `tier-${index}`,
							severity,
							line: 10 + index,
							message: `${severity} finding ${index}`,
						},
						cwd,
					),
			);
			expect(records.every(Boolean)).toBe(true);
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: "s-tier",
				turnIndex: 1,
				files: ["src/a.ts"],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: records.map((record) => record!),
				includeLspCodeActions: false,
			});
			expect(report.summary.byTier).toMatchObject({
				warning: 1,
				info: 0,
				hint: 2,
			});
			// #1799: `error` severity never reaches `warnings` (recordFromDispatchDiagnostic
			// routes it to the blocking path), so `byTier` no longer carries a vestigial
			// always-0 `error` field.
			expect(report.summary.byTier).not.toHaveProperty("error");
			expect(formatActionableWarningsAdvisory(report, cwd)).toContain(
				"2 of those are hint/info tier",
			);
		} finally {
			removeTempDirSync(cwd);
		}
	});

	it("omits the tier line when every fixable warning is warning-tier", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-tier2-"));
		const filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "console.log('x');\n");
		try {
			const record = recordFromDispatchDiagnostic(makeWarning(filePath), cwd);
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: "s-tier",
				turnIndex: 1,
				files: ["src/a.ts"],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: record ? [record] : [],
				includeLspCodeActions: false,
			});
			expect(report.summary.byTier).toMatchObject({ warning: 1, hint: 0 });
			expect(formatActionableWarningsAdvisory(report, cwd)).not.toContain(
				"hint/info tier",
			);
		} finally {
			removeTempDirSync(cwd);
		}
	});

	// `actionable-warnings.json` is read back by `clients/runtime-agent-end.ts`
	// and `tools/lens-diagnostics.ts`, which can find a file written by a build
	// that predates `byTier`. The advisory must not crash on it.
	it("formats a cached report that predates the byTier field", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-tier3-"));
		const filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "console.log('x');\n");
		try {
			const record = recordFromDispatchDiagnostic(makeWarning(filePath), cwd);
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: "s-tier",
				turnIndex: 1,
				files: ["src/a.ts"],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: record ? [record] : [],
				includeLspCodeActions: false,
			});
			const legacy: ActionableWarningsReport = {
				...report,
				summary: { ...report.summary, byTier: undefined },
			};
			expect(formatActionableWarningsAdvisory(legacy, cwd)).toContain(
				"Fixable warnings introduced this turn: 1",
			);
		} finally {
			removeTempDirSync(cwd);
		}
	});
});

describe("id path-form stability (#1816 — #533 class swept into the warning stores)", () => {
	// Before #1816, this file's `relativeFile` hashed whichever RAW path form
	// the caller passed — unlike diagnostic-dispositions.ts, which already
	// canonicalized both `cwd` and `filePath` through `normalizeMapKey`. A
	// raw mis-cased path form and its normalizeMapKey'd form of the SAME
	// on-disk file therefore hashed to two DIFFERENT `aw:` ids. Post-#1816,
	// both derive the shared `finding-identity.js` id, so they converge.
	it("computes the same id for a raw mis-cased path form and its normalized form", (ctx) => {
		const projectDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-aw-id-form-"),
		);
		try {
			const subDirOnDisk = path.join(projectDir, "sub");
			fs.mkdirSync(subDirOnDisk, { recursive: true });
			const fileOnDisk = path.join(subDirOnDisk, "a.ts");
			fs.writeFileSync(fileOnDisk, "console.log('x');\n");

			const rawFile = path.join(projectDir, "SUB", "a.ts");
			// Only aliases on a case-insensitive filesystem. Skip VISIBLY on Linux
			// CI rather than returning, which reports a pass (#2089).
			ctx.skip(
				!fs.existsSync(rawFile),
				"case-sensitive filesystem: SUB/a.ts does not alias sub/a.ts",
			);

			const identity = {
				tool: "eslint",
				rule: "no-console",
				message: "bad call",
				line: 1,
			};
			const rawId = createActionableWarningId({
				cwd: projectDir,
				filePath: rawFile,
				...identity,
			});
			const normalizedId = createActionableWarningId({
				cwd: normalizeMapKey(projectDir),
				filePath: normalizeMapKey(fileOnDisk),
				...identity,
			});
			expect(rawId).toBe(normalizedId);
		} finally {
			removeTempDirSync(projectDir);
		}
	});
});

describe("actionable-warning-state.json migration (#1816 — pre-fix id back-compat)", () => {
	// `actionable-warning-state.json` is a keyed, persisted suppression store
	// (unlike code-quality-warnings, which is ephemeral-per-turn — see that
	// file's tests). Unifying onto the canonicalized, 12-char id must not
	// orphan a warning a user already suppressed under the pre-#1816,
	// 10-char, non-canonicalized id: it must still read as suppressed, and
	// the store must migrate the entry onto the new id so the lookup doesn't
	// need the fallback forever.
	// Review-round F3: a fixture whose raw and canonical path forms COINCIDE
	// (e.g. a fresh mkdtempSync path with no mixed-case segment) makes the
	// "never canonicalize legacyActionableWarningId" guard vacuous — a
	// reviewer canonicalized it and every assertion below still passed,
	// because canonicalizing a no-op input changes nothing. Use a mis-cased
	// path form (mirrors the id-divergence fixture above and
	// diagnostic-dispositions.test.ts's "anchor path-form stability" fixture)
	// so the mutation actually reds: a pre-#1816 build never canonicalized,
	// so it would have anchored the suppression under the RAW, mis-cased
	// relative path — canonicalizing `legacyActionableWarningId` shifts its
	// output onto the canonical form and the lookup below would silently
	// miss the entry.
	it("honors and migrates a suppression recorded under the pre-#1816 id for a mis-cased path form", async (ctx) => {
		const projectDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-aw-migrate-"),
		);
		try {
			// Real on-disk casing: lowercase `sub`.
			const subDirOnDisk = path.join(projectDir, "sub");
			fs.mkdirSync(subDirOnDisk, { recursive: true });
			const fileOnDisk = path.join(subDirOnDisk, "a.ts");
			fs.writeFileSync(fileOnDisk, "console.log('x');\n");

			// WRITE form a pre-#1816 build would have anchored under: a raw,
			// mis-cased segment, never realpath-canonicalized.
			const cwd = projectDir;
			const filePath = path.join(projectDir, "SUB", "a.ts");
			// Only aliases on a case-insensitive filesystem. Skip VISIBLY on Linux
			// CI rather than returning, which reports a pass (#2089).
			ctx.skip(
				!fs.existsSync(filePath),
				"case-sensitive filesystem: SUB/a.ts does not alias sub/a.ts",
			);

			const diagnostic = makeWarning(filePath);
			const legacyId = legacyActionableWarningIdForTest({
				cwd,
				filePath,
				tool: diagnostic.tool,
				code: diagnostic.code,
				rule: diagnostic.rule,
				message: diagnostic.message,
				line: diagnostic.line,
			});
			const currentId = createActionableWarningId({
				cwd,
				filePath,
				tool: diagnostic.tool,
				code: diagnostic.code,
				rule: diagnostic.rule,
				message: diagnostic.message,
				line: diagnostic.line,
			});
			// The formulas must actually differ for this test to mean anything —
			// otherwise the assertions below would pass vacuously.
			expect(legacyId).not.toBe(currentId);

			const statePath = path.join(
				getProjectDataDir(cwd),
				"cache",
				"actionable-warning-state.json",
			);
			fs.mkdirSync(path.dirname(statePath), { recursive: true });
			fs.writeFileSync(
				statePath,
				JSON.stringify({
					warnings: {
						[legacyId]: { status: "suppressed", reason: "pre-#1816 mark" },
					},
				}),
			);

			const record = recordFromDispatchDiagnostic(diagnostic, cwd);
			expect(record?.id).toBe(currentId);
			expect(record?.suppressed).toBe(true);
			expect(record?.suppressionReason).toBe("pre-#1816 mark");

			await buildActionableWarningsReport({
				cwd,
				sessionId: "s-migrate",
				turnIndex: 1,
				files: [filePath],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: record ? [record] : [],
				includeLspCodeActions: false,
			});

			const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
				warnings: Record<string, { status?: string; reason?: string }>;
			};
			expect(persisted.warnings[currentId]).toMatchObject({
				status: "suppressed",
				reason: "pre-#1816 mark",
			});
			expect(persisted.warnings[legacyId]).toBeUndefined();
		} finally {
			removeTempDirSync(projectDir);
		}
	});
});

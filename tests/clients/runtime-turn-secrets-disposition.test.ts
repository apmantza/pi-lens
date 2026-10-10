import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { markDisposition } from "../../clients/diagnostic-dispositions.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

/** Set a file's mtime `ms` (epoch milliseconds). */
function setMtime(file: string, ms: number): void {
	const when = new Date(ms);
	fs.utimesSync(file, when, when);
}

// #1617: turn_end's own secrets gate ("🔴 STOP — hardcoded secrets detected")
// is the literal surface the dogfood incident hit — an agent marked a
// gitleaks finding false-positive via lens_diagnostic_mark, but the NEXT
// turn's gate read gitleaks's session-scan cache straight into the blocker
// report with zero disposition wiring, so the same finding re-reported on
// every turn. These prove the fix reaches this exact gate, not just
// `lens_diagnostics mode=full`'s parallel (also-fixed) surface.

/**
 * #2504: every production `addModifiedRange` caller stamps a writer id
 * (`lsp-mutation`, `mutation-bridge`, `runtime-tool-result`,
 * `runtime-agent-end`, the MCP routes) — an OWNERLESS worklist is only ever
 * the resting shape left behind by `clearTurnState`. These tests used to
 * register their range with no id, so they persisted a shape production never
 * writes, and #2504's stale-worklist gate (correctly) evicted it as carried
 * over from a session that ended before this one began.
 */
const TURN_STATE_SESSION_ID = "turnend-secrets-session";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
) {
	return {
		ctxCwd: cwd,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		sessionId: TURN_STATE_SESSION_ID,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

describe("turn_end secrets gate honors dispositions (#1617)", () => {
	it("re-reports a gitleaks finding as a 🔴 STOP blocker when unmarked, then drops it once marked false-positive", async () => {
		const env = setupTestEnvironment("pi-lens-turnend-secrets-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "a.ts");
			const content = "const clientId = 'not-a-real-secret';\n";
			fs.writeFileSync(filePath, content);

			const cacheManager = new CacheManager(false);
			// handleTurnEnd short-circuits (schedules an idle LSP reset and
			// returns) when no file was touched this turn — register a modified
			// range so it runs the full findings pipeline, same as the existing
			// cascade turn-end tests do.
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					findings: [
						{
							ruleId: "generic-api-key",
							file: filePath,
							startLine: 1,
						},
					],
					scannedAt: new Date().toISOString(),
				},
				cwd,
			);

			// Baseline: unmarked finding IS a blocker.
			const runtimeBefore = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeBefore, cacheManager, cwd));
			const before = consumeTurnEndFindings(cacheManager, cwd);
			expect(before?.messages[0]?.content ?? "").toContain(
				"STOP — hardcoded secrets detected",
			);

			// Mark it false-positive using the SAME identity
			// `gitleaksFindingToProjectDiagnostic` derives (tool="gitleaks",
			// rule="gitleaks:<ruleId>", the exact "Potential secret: …" message)
			// — what an agent would have gotten from lens_diagnostics and fed
			// straight into lens_diagnostic_mark.
			markDisposition(
				cwd,
				{
					cwd,
					filePath,
					tool: "gitleaks",
					rule: "gitleaks:generic-api-key",
					message: "Potential secret: generic-api-key",
					line: 1,
					content,
				},
				"false-positive",
			);

			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			const runtimeAfter = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeAfter, cacheManager, cwd));
			const after = consumeTurnEndFindings(cacheManager, cwd);
			const afterContent = after?.messages[0]?.content ?? "";
			expect(afterContent).not.toContain("STOP — hardcoded secrets detected");
			// #1616 suppressed-bucket rule: the drop must stay visible as a trace.
			expect(afterContent).toContain("suppressed by disposition");
		} finally {
			env.cleanup();
		}
	});
});

// #1628: trivy's own *secret* findings (`TrivyResult.secrets`) never passed
// through the same fix — they were never adapted to a `ProjectDiagnostic` at
// all, so an agent had nothing to anchor a `lens_diagnostic_mark` call
// against and a mark could never suppress one. Mirrors the #1617 gitleaks
// case above, exercising a trivy-only secret (no gitleaks corroboration) so
// the disposition anchor under test is genuinely `trivySecretFindingToProjectDiagnostic`'s,
// not `gitleaksFindingToProjectDiagnostic`'s.
describe("turn_end secrets gate honors dispositions for trivy secrets (#1628)", () => {
	it("re-reports a trivy-secret finding as a 🔴 STOP blocker when unmarked, then drops it once marked false-positive", async () => {
		const env = setupTestEnvironment("pi-lens-turnend-trivy-secrets-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "b.ts");
			const content = "const apiKey = 'not-a-real-secret';\n";
			fs.writeFileSync(filePath, content);

			const cacheManager = new CacheManager(false);
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			cacheManager.writeCache(
				"trivy",
				{
					success: true,
					scannedAt: new Date().toISOString(),
					findings: [],
					secrets: [
						{
							ruleId: "aws-access-key-id",
							file: filePath,
							line: 1,
						},
					],
					licenses: [],
				},
				cwd,
			);

			// Baseline: unmarked finding IS a blocker.
			const runtimeBefore = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeBefore, cacheManager, cwd));
			const before = consumeTurnEndFindings(cacheManager, cwd);
			expect(before?.messages[0]?.content ?? "").toContain(
				"STOP — hardcoded secrets detected",
			);

			// Mark it false-positive using the SAME identity
			// `trivySecretFindingToProjectDiagnostic` derives (tool="trivy",
			// rule="trivy-secret:<ruleId>", the exact "Potential secret: …"
			// message) — what an agent would have gotten from lens_diagnostics
			// and fed straight into lens_diagnostic_mark.
			markDisposition(
				cwd,
				{
					cwd,
					filePath,
					tool: "trivy",
					rule: "trivy-secret:aws-access-key-id",
					message: "Potential secret: aws-access-key-id",
					line: 1,
					content,
				},
				"false-positive",
			);

			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			const runtimeAfter = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeAfter, cacheManager, cwd));
			const after = consumeTurnEndFindings(cacheManager, cwd);
			const afterContent = after?.messages[0]?.content ?? "";
			expect(afterContent).not.toContain("STOP — hardcoded secrets detected");
			// #1616 suppressed-bucket rule: the drop must stay visible as a trace.
			expect(afterContent).toContain("suppressed by disposition");
		} finally {
			env.cleanup();
		}
	});
});

// #1694 residual 1: the #1617/#1625/#1691 disposition filtering above is
// proven only for the LIVE arm — every finding in those tests sits in a file
// untouched since the scan. #1622's freshness gate demotes findings whose
// cited file changed after the scan into a SEPARATE `.stale` arm
// (`gitleaksGate.stale` / `trivySecretsGate.stale`), reported through its own
// "🔑 ACTION NEEDED" tier. `filterFindingsByDisposition` is applied to that
// arm too (`gitleaksStaleFiltered` / `trivySecretsStaleFiltered`), but nothing
// proved it: mutating `trivySecretsStaleFiltered.kept` back to the raw
// `trivySecretsGate.stale` (and the gitleaks equivalent) left the full suite
// green. These pin the stale arm the same way the tests above pin the live
// arm — mark a stale finding false-positive and prove it stops reappearing in
// the ACTION NEEDED tier, with the suppression staying visible as a trace.
describe("turn_end secrets gate honors dispositions on the STALE arm (#1694)", () => {
	it("re-reports a stale gitleaks finding as ACTION NEEDED when unmarked, then drops it once marked false-positive", async () => {
		const env = setupTestEnvironment("pi-lens-turnend-secrets-stale-gitleaks-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "a.ts");
			const content = "const clientId = 'not-a-real-secret';\n";
			fs.writeFileSync(filePath, content);

			// Scan happened 60s ago; the file's mtime is 5s AFTER that — edited
			// since the scan, so `gateFindingsByPathFreshness` routes this finding
			// into the `.stale` arm, not `.live`.
			const scannedAtMs = Date.now() - 60_000;
			setMtime(filePath, scannedAtMs + 5_000);

			const cacheManager = new CacheManager(false);
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					findings: [
						{
							ruleId: "generic-api-key",
							file: filePath,
							startLine: 1,
						},
					],
					scannedAt: new Date(scannedAtMs).toISOString(),
				},
				cwd,
			);

			// Baseline: unmarked stale finding IS an ACTION NEEDED entry, and
			// never a STOP blocker (the stale tier withholds the line, it never
			// escalates to the live blocker tier).
			const runtimeBefore = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeBefore, cacheManager, cwd));
			const before = consumeTurnEndFindings(cacheManager, cwd);
			const beforeContent = before?.messages[0]?.content ?? "";
			expect(beforeContent).toContain("ACTION NEEDED");
			expect(beforeContent).toContain("generic-api-key");
			expect(beforeContent).not.toContain("STOP — hardcoded secrets detected");

			// Mark it false-positive using the SAME identity
			// `gitleaksFindingToProjectDiagnostic` derives — what an agent would
			// have gotten from lens_diagnostics and fed straight into
			// lens_diagnostic_mark.
			markDisposition(
				cwd,
				{
					cwd,
					filePath,
					tool: "gitleaks",
					rule: "gitleaks:generic-api-key",
					message: "Potential secret: generic-api-key",
					line: 1,
					content,
				},
				"false-positive",
			);

			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			const runtimeAfter = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeAfter, cacheManager, cwd));
			const after = consumeTurnEndFindings(cacheManager, cwd);
			const afterContent = after?.messages[0]?.content ?? "";
			expect(afterContent).not.toContain("ACTION NEEDED");
			// #1616 suppressed-bucket rule: the drop must stay visible as a trace.
			expect(afterContent).toContain("suppressed by disposition");
		} finally {
			env.cleanup();
		}
	});
});

describe("turn_end secrets gate honors dispositions on the STALE arm for trivy secrets (#1694)", () => {
	it("re-reports a stale trivy-secret finding as ACTION NEEDED when unmarked, then drops it once marked false-positive", async () => {
		const env = setupTestEnvironment("pi-lens-turnend-secrets-stale-trivy-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "b.ts");
			const content = "const apiKey = 'not-a-real-secret';\n";
			fs.writeFileSync(filePath, content);

			const scannedAtMs = Date.now() - 60_000;
			setMtime(filePath, scannedAtMs + 5_000);

			const cacheManager = new CacheManager(false);
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			cacheManager.writeCache(
				"trivy",
				{
					success: true,
					scannedAt: new Date(scannedAtMs).toISOString(),
					findings: [],
					secrets: [
						{
							ruleId: "aws-access-key-id",
							file: filePath,
							line: 1,
						},
					],
					licenses: [],
				},
				cwd,
			);

			const runtimeBefore = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeBefore, cacheManager, cwd));
			const before = consumeTurnEndFindings(cacheManager, cwd);
			const beforeContent = before?.messages[0]?.content ?? "";
			expect(beforeContent).toContain("ACTION NEEDED");
			expect(beforeContent).toContain("aws-access-key-id");
			expect(beforeContent).not.toContain("STOP — hardcoded secrets detected");

			// Mark it false-positive using the SAME identity
			// `trivySecretFindingToProjectDiagnostic` derives.
			markDisposition(
				cwd,
				{
					cwd,
					filePath,
					tool: "trivy",
					rule: "trivy-secret:aws-access-key-id",
					message: "Potential secret: aws-access-key-id",
					line: 1,
					content,
				},
				"false-positive",
			);

			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			const runtimeAfter = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeAfter, cacheManager, cwd));
			const after = consumeTurnEndFindings(cacheManager, cwd);
			const afterContent = after?.messages[0]?.content ?? "";
			expect(afterContent).not.toContain("ACTION NEEDED");
			expect(afterContent).toContain("suppressed by disposition");
		} finally {
			env.cleanup();
		}
	});
});

// #1694 fix-round finding F1: the sweep paragraph's original claim — that
// govulncheck's disposition filter was "already covered by existing
// govulncheck disposition tests" — was wrong. `govFiltered` filters ONE
// combined `[...govGate.live, ...govGate.stale]` array (a different shape
// from the gitleaks/trivy-secrets two-arm split above, but the same defect:
// a real filter with no regression test). The reviewer proved it live:
// neutering `govFiltered.kept` back to the raw concatenated array
// (`clients/runtime-turn.ts:1306`) left 353 tests across 16 files green.
// This mirrors that exact mutant as the red proof.
describe("turn_end govulncheck advisory honors dispositions (#1694 F1)", () => {
	it("re-reports a govulncheck CVE as an advisory when unmarked, then drops it once marked false-positive", async () => {
		const env = setupTestEnvironment("pi-lens-turnend-govulncheck-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "main.go");
			const content = "package main\n\nfunc main() {}\n";
			fs.writeFileSync(filePath, content);

			const cacheManager = new CacheManager(false);
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			cacheManager.writeCache(
				"govulncheck",
				{
					success: true,
					scannedAt: new Date().toISOString(),
					findings: [
						{
							osv: "GO-2024-1234",
							module: "example.com/vuln",
							packageName: "example.com/vuln/pkg",
							fixedVersion: "1.2.3",
							summary: "test vulnerability",
							trace: [{ filename: filePath, line: 1 }],
						},
					],
				},
				cwd,
			);

			// Baseline: unmarked finding IS an advisory.
			const runtimeBefore = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeBefore, cacheManager, cwd));
			const before = consumeTurnEndFindings(cacheManager, cwd);
			const beforeContent = before?.messages[0]?.content ?? "";
			expect(beforeContent).toContain("GO-2024-1234");
			expect(beforeContent).toContain("govulncheck");

			// Mark it false-positive using the SAME identity
			// `govulncheckFindingToProjectDiagnostic` derives (tool="govulncheck",
			// rule="govulncheck:<osv>") — what an agent would have gotten from
			// lens_diagnostics and fed straight into lens_diagnostic_mark.
			markDisposition(
				cwd,
				{
					cwd,
					filePath,
					tool: "govulncheck",
					rule: "govulncheck:GO-2024-1234",
					message:
						"Vulnerability GO-2024-1234: test vulnerability (fixed in 1.2.3)",
					line: 1,
					content,
				},
				"false-positive",
			);

			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			const runtimeAfter = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeAfter, cacheManager, cwd));
			const after = consumeTurnEndFindings(cacheManager, cwd);
			const afterContent = after?.messages[0]?.content ?? "";
			expect(afterContent).not.toContain("GO-2024-1234");
			// #1616 suppressed-bucket rule: the drop must stay visible as a trace,
			// with per-lane attribution (#1625 review round F4).
			expect(afterContent).toContain("suppressed by disposition");
			expect(afterContent).toContain("govulncheck 1");
		} finally {
			env.cleanup();
		}
	});
});

// #1813: trivy's own dependency-CVE lane (`TrivyResult.findings`, distinct
// from the trivy-secret lane covered by #1628 above) has the SAME
// `filterFindingsByDisposition` wiring (`trivyFindingsFiltered`,
// runtime-turn.ts:1516-1523) but was never pinned. The #1798 delta-verify
// proved the gap: neutering `trivyFindingsFiltered.kept` back to the raw
// `trivyCacheEntry?.data?.findings ?? []` left 407 tests across 18 files
// green. Unlike the five lanes already covered, this one carries no
// freshness gate (#1634 — a CVE names a package, not a `file:line`, so
// `gateFindingsByPathFreshness` has nothing to stat) and can render at
// either the CRITICAL blocker tier or the advisory tier; this test drives
// the CRITICAL blocker tier since that is the sharper regression to miss.
describe("turn_end trivy CVE advisory honors dispositions (#1813)", () => {
	it("re-reports a trivy CVE as a CRITICAL blocker when unmarked, then drops it once marked false-positive", async () => {
		const env = setupTestEnvironment("pi-lens-turnend-trivy-cve-");
		try {
			const cwd = env.tmpDir;
			// The CVE finding itself anchors on a manifest/lockfile (`target`),
			// not a source file — but handleTurnEnd short-circuits when nothing
			// was touched this turn, so a real edited file still has to be
			// registered to run the findings pipeline (same technique the
			// gitleaks/govulncheck cases above use).
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const target = "package-lock.json";
			const targetPath = path.resolve(cwd, target);

			const cacheManager = new CacheManager(false);
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			cacheManager.writeCache(
				"trivy",
				{
					success: true,
					scannedAt: new Date().toISOString(),
					findings: [
						{
							vulnerabilityId: "CVE-2024-9999",
							pkgName: "left-pad",
							installedVersion: "1.0.0",
							fixedVersion: "1.0.1",
							severity: "CRITICAL",
							target,
						},
					],
					secrets: [],
					licenses: [],
				},
				cwd,
			);

			// Baseline: unmarked finding IS a CRITICAL blocker.
			const runtimeBefore = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeBefore, cacheManager, cwd));
			const before = consumeTurnEndFindings(cacheManager, cwd);
			const beforeContent = before?.messages[0]?.content ?? "";
			expect(beforeContent).toContain("STOP — CRITICAL dependency CVEs");
			expect(beforeContent).toContain("CVE-2024-9999");

			// Mark it false-positive using the SAME identity
			// `trivyFindingToProjectDiagnostic` derives (tool="trivy",
			// rule="trivy:<vulnerabilityId>", message
			// "<severity> vulnerability <id> in <pkg>@<version> (fixed in <fixed>)")
			// — what an agent would have gotten from lens_diagnostics and fed
			// straight into lens_diagnostic_mark. No line/content: a CVE finding
			// has no source line, so the strict anchor falls back to its stable
			// empty-content hash.
			markDisposition(
				cwd,
				{
					cwd,
					filePath: targetPath,
					tool: "trivy",
					rule: "trivy:CVE-2024-9999",
					message:
						"CRITICAL vulnerability CVE-2024-9999 in left-pad@1.0.0 (fixed in 1.0.1)",
				},
				"false-positive",
			);

			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				cwd,
				TURN_STATE_SESSION_ID,
			);
			const runtimeAfter = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeAfter, cacheManager, cwd));
			const after = consumeTurnEndFindings(cacheManager, cwd);
			const afterContent = after?.messages[0]?.content ?? "";
			expect(afterContent).not.toContain("CVE-2024-9999");
			expect(afterContent).not.toContain("STOP — CRITICAL dependency CVEs");
			// #1616 suppressed-bucket rule: the drop must stay visible as a
			// trace, with per-lane attribution (#1625 review round F4).
			expect(afterContent).toContain("suppressed by disposition");
			expect(afterContent).toContain("trivy 1");
		} finally {
			env.cleanup();
		}
	});
});

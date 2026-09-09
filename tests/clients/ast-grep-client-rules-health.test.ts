import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2626 review round 2, F4 pattern: a bare `vi.spyOn(fs, "existsSync")`
// cannot redefine a node: built-in's ESM namespace export directly — wrap
// via vi.mock, default to the REAL implementation, and override per test
// (#2636 review F7's TOCTOU probe below).
const actualFsRef = vi.hoisted(() => {
	return {
		existsSync: undefined as unknown as typeof import("node:fs").existsSync,
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	actualFsRef.existsSync = actual.existsSync;
	return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

// #2626 review round 2, F5 pattern: capture logLatency calls to prove the
// success-path observability record fires and names the path + entry count.
const latencyEntries: Array<{
	phase?: string;
	filePath?: string;
	metadata?: Record<string, unknown>;
}> = [];
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: {
			phase?: string;
			filePath?: string;
			metadata?: Record<string, unknown>;
		}) => latencyEntries.push(entry),
	};
});

import * as fsSync from "node:fs";
import { AstGrepClient } from "../../clients/ast-grep-client.js";
import * as ruleManager from "../../clients/ast-grep-rule-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { SgRunner } from "../../clients/sg-runner.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { removeTempDirSync } from "./test-utils.js";

/**
 * #2636 (the #2626 class sweep's ast-grep leg): `AstGrepClient`'s
 * constructor falls back to the bundled `rules/`
 * (`resolvePackagePath(import.meta.url, "rules")`) with no existence check
 * when the project has none of its own — same managed-cache-relocation gap
 * #2626 fixed for `skills/`. `checkAstGrepRulesHealth` is independently
 * pinned in `ast-grep-rule-manager.test.ts`; these tests pin the
 * CONSTRUCTOR's WIRING to it — is the check only called on the bundled
 * fallback branch, does it name the resolved path, and does an unhealthy
 * result reach the degradation ledger.
 */

const notified: Array<{ message: string; level: string | undefined }> = [];
let tmpDirs: string[] = [];
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

function degradationGroup() {
	return getDegradationSummary().find(
		(g) => g.kind === "ast-grep-rules-dir-missing",
	);
}

function resolvedPhaseEntries() {
	return latencyEntries.filter(
		(entry) => entry.phase === "ast_grep_rules_resolved",
	);
}

beforeEach(() => {
	notified.length = 0;
	latencyEntries.length = 0;
	tmpDirs = [];
	resetDegradationLedger();
	vi.mocked(fsSync.existsSync).mockClear();
	vi.mocked(fsSync.existsSync).mockImplementation(actualFsRef.existsSync);
	wireUserNotifier(() => (message, level) => {
		notified.push({ message, level });
	});
});

afterEach(() => {
	cwdSpy?.mockRestore();
	cwdSpy = undefined;
	resetUserNotifier();
	resetDegradationLedger();
	vi.mocked(fsSync.existsSync).mockImplementation(actualFsRef.existsSync);
	vi.restoreAllMocks();
	for (const dir of tmpDirs) {
		removeTempDirSync(dir);
	}
});

function tempCwdWithoutRules(): string {
	const dir = fsSync.mkdtempSync(
		path.join(os.tmpdir(), "pilens-ast-grep-client-cwd-"),
	);
	tmpDirs.push(dir);
	return dir;
}

describe("AstGrepClient constructor — bundled rules health wiring (#2636)", () => {
	it("does NOT check bundled health when the project provides its own rules/ (this repo's own layout)", () => {
		// This repo's cwd (the real test-run cwd) has a real `rules/` directory,
		// so the constructor picks the PROJECT override and never reaches the
		// bundled-fallback branch — negative control mirroring #2626's
		// index-wiring negative control.
		void new AstGrepClient();
		expect(resolvedPhaseEntries()).toEqual([]);
		expect(degradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	it("checks bundled health and logs the phase record when the project has no rules/", () => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempCwdWithoutRules());

		void new AstGrepClient();

		// The real bundled rules/ (this repo's own, resolved via
		// AstGrepClient's fixed import.meta.url) IS healthy, so this proves the
		// WIRING reaches the check on the fallback branch without asserting a
		// bug that isn't present in this repo's own installed layout.
		expect(resolvedPhaseEntries()).toHaveLength(1);
		expect(resolvedPhaseEntries()[0].metadata).toMatchObject({
			status: "healthy",
		});
		expect(
			(resolvedPhaseEntries()[0].metadata as { entryCount: number }).entryCount,
		).toBeGreaterThan(0);
		expect(degradationGroup()).toBeUndefined();
	});

	it("records a bounded degradation + notify when the bundled rules/ is unhealthy", () => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempCwdWithoutRules());
		const healthSpy = vi
			.spyOn(ruleManager, "checkAstGrepRulesHealth")
			.mockReturnValue({ status: "absent" });

		void new AstGrepClient();

		expect(healthSpy).toHaveBeenCalledTimes(1);
		const group = degradationGroup();
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.reason).toContain("no such directory");
		expect(notified).toHaveLength(1);
		expect(notified[0].message).toContain(
			"ast-grep rule descriptions unavailable",
		);
		expect(resolvedPhaseEntries()[0].metadata).toMatchObject({
			status: "absent",
			entryCount: 0,
		});
	});

	it("does not re-notify on a second unhealthy construction in the same session", () => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempCwdWithoutRules());
		vi.spyOn(ruleManager, "checkAstGrepRulesHealth").mockReturnValue({
			status: "absent",
		});

		void new AstGrepClient();
		void new AstGrepClient();

		expect(notified).toHaveLength(1);
		expect(degradationGroup()?.count).toBe(2);
	});

	// #2636 review F3: AstGrepClient is a per-PROCESS singleton
	// (index.ts/mcp/server.ts/clients/mcp/session.ts each construct it once),
	// but resetDegradationLedger() wipes the ledger on EVERY session_start
	// (handleSessionStart). A report that only ever fires at construction
	// time is invisible after the first session boundary — pilens_health
	// shows nothing for a bug that is still there.
	it("re-reports on the next scan after resetDegradationLedger() (session boundary), but not again within the same generation", async () => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempCwdWithoutRules());
		vi.spyOn(ruleManager, "checkAstGrepRulesHealth").mockReturnValue({
			status: "absent",
		});
		// ensureAvailable() is the real "start of a scan" entry point every
		// tools/ast-grep-*/ast-dump handler calls before doing any work — stub
		// SgRunner's own implementation so this test never spawns a real
		// ast-grep/npx process.
		vi.spyOn(SgRunner.prototype, "ensureAvailable").mockResolvedValue(true);

		const client = new AstGrepClient();
		expect(notified).toHaveLength(1);
		expect(degradationGroup()?.count).toBe(1);

		// Same session generation: a second scan does NOT re-report.
		await client.ensureAvailable();
		expect(notified).toHaveLength(1);
		expect(degradationGroup()?.count).toBe(1);

		// Session boundary — runtime-session.ts's handleSessionStart calls
		// this first thing in production.
		resetDegradationLedger();
		expect(degradationGroup()).toBeUndefined();

		// The client instance is untouched (it lives for the process), but the
		// NEXT scan must still surface the still-present bug.
		await client.ensureAvailable();
		expect(notified).toHaveLength(2);
		expect(degradationGroup()?.count).toBe(1);
	});

	// #2636 review F7: the constructor used to call `fs.existsSync(projectRuleDir)`
	// TWICE — once to decide `usingBundledFallback`, again in the `ruleDir`
	// ternary. Between the two calls the directory can appear (a concurrent
	// watcher/installer), leaving `usingBundledFallback` true while `ruleDir`
	// ends up being the now-existing PROJECT dir — the health check would
	// then classify a project override's own directory as though it were the
	// bundled fallback.
	it("checks the project rules/ directory exactly once (immune to it appearing mid-construction)", () => {
		const tempDir = tempCwdWithoutRules();
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
		const projectRuleDir = path.join(tempDir, "rules");
		let projectDirChecks = 0;
		vi.mocked(fsSync.existsSync).mockImplementation(((
			candidate: Parameters<typeof actualFsRef.existsSync>[0],
		) => {
			if (candidate === projectRuleDir) {
				projectDirChecks++;
				// Simulate the directory appearing AFTER the first read — a
				// two-call implementation would see `false` then `true`.
				return projectDirChecks > 1;
			}
			return actualFsRef.existsSync(candidate);
		}) as typeof fsSync.existsSync);

		void new AstGrepClient();

		expect(projectDirChecks).toBe(1);
		// A SINGLE "absent" read means the bundled fallback was used — proven
		// observably by the health-check phase record firing at all (it only
		// runs on that branch).
		expect(resolvedPhaseEntries()).toHaveLength(1);
	});
});

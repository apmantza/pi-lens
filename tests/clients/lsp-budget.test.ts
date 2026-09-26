/**
 * Tests for the PURE decision logic in clients/lsp-budget.ts
 * (`decideLspBudget`) — #449 slice 2 prototype. All liveness checks are
 * injected fake predicates; no real process.kill/spawn/fs ever runs here.
 * Mirrors the test shape of tests/clients/instance-reaper.test.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkCrossProcessLspBudget,
	decideLspBudget,
	DEFAULT_LSP_BUDGET_CEILING,
	DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS,
	getLspBudgetIdleTimeoutMs,
	getLspBudgetRssCeilingBytes,
	getLspBudgetCeiling,
	isCrossProcessBudgetEnabled,
	_resetLspBudgetDecisionForTests,
	shouldDegradeAuxiliaryLsp,
	shouldPreferPullOnlyDiagnostics,
} from "../../clients/lsp-budget.js";
import {
	_resetInstanceRegistryEnabledForTests,
	type InstanceEntry,
	type LspChildEntry,
} from "../../clients/instance-registry.js";
import { removeTempDirSync } from "./test-utils.js";

function lspChild(overrides: Partial<LspChildEntry> = {}): LspChildEntry {
	return {
		pid: 1000,
		serverId: "typescript",
		command: "typescript-language-server",
		spawnedAt: new Date().toISOString(),
		...overrides,
	};
}

function instance(overrides: Partial<InstanceEntry> = {}): InstanceEntry {
	return {
		pid: 1,
		startedAt: new Date().toISOString(),
		projectRoot: "/proj",
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 0,
		heartbeatAt: new Date().toISOString(),
		...overrides,
	};
}

function alivePids(...pids: number[]): (pid: number) => boolean {
	const set = new Set(pids);
	return (pid) => set.has(pid);
}

function childrenOfCount(
	n: number,
	serverId: string,
	startPid: number,
): LspChildEntry[] {
	return Array.from({ length: n }, (_, i) =>
		lspChild({ pid: startPid + i, serverId }),
	);
}

describe("decideLspBudget", () => {
	it("under ceiling — not over budget, aux not degraded", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(3, "typescript", 100) }),
			instance({ pid: 2, lspChildren: childrenOfCount(2, "pyright", 200) }),
		];
		const decision = decideLspBudget(
			reg,
			alivePids(1, 2, 100, 101, 102, 200, 201),
			16,
		);

		expect(decision.totalLiveLspServers).toBe(5);
		expect(decision.overBudget).toBe(false);
		expect(decision.degradeAuxiliary).toBe(false);
	});

	it("at/over ceiling — over budget, aux degraded", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(10, "typescript", 100) }),
			instance({ pid: 2, lspChildren: childrenOfCount(10, "pyright", 200) }),
		];
		const decision = decideLspBudget(reg, () => true, 16);

		expect(decision.totalLiveLspServers).toBe(20);
		expect(decision.overBudget).toBe(true);
		expect(decision.degradeAuxiliary).toBe(true);
		expect(decision.ceiling).toBe(16);
	});

	it("exactly at ceiling counts as over budget (>=, not >)", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(16, "typescript", 100) }),
		];
		const decision = decideLspBudget(reg, () => true, 16);

		expect(decision.totalLiveLspServers).toBe(16);
		expect(decision.overBudget).toBe(true);
	});

	it("dead-parent instances are excluded from the live count — orphan reaper's job, not double-counted here", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(20, "typescript", 100) }), // dead parent
			instance({ pid: 2, lspChildren: childrenOfCount(2, "pyright", 300) }), // alive parent
		];
		// Only pid 2 is alive; pid 1's children don't count toward the total.
		const decision = decideLspBudget(reg, alivePids(2), 16);

		expect(decision.totalLiveLspServers).toBe(2);
		expect(decision.overBudget).toBe(false);
	});

	it("#3539 verify R2-F1: another pid namespace's entry counts only while its heartbeat is fresh, never by a pid read from here", () => {
		const HOUR = 3_600_000;
		const now = Date.parse("2026-09-26T12:00:00.000Z");
		const at = (msAgo: number) => new Date(now - msAgo).toISOString();
		const foreign = (heartbeatAgoMs: number) => ({
			...instance({
				pid: 1, // alive here, whatever it is
				heartbeatAt: at(heartbeatAgoMs),
				lspChildren: childrenOfCount(16, "typescript", 100),
			}),
			pidNamespace: "pid:[container]",
		});

		const dead = decideLspBudget(
			[foreign(7 * HOUR)],
			() => true,
			16,
			undefined,
			now,
			"pid:[own]",
		);
		const live = decideLspBudget(
			[foreign(HOUR)],
			() => false,
			16,
			undefined,
			now,
			"pid:[own]",
		);

		expect(dead.totalLiveLspServers).toBe(0);
		expect(dead.degradeAuxiliary).toBe(false);
		expect(live.totalLiveLspServers).toBe(16);
	});

	it("an entry from this pid namespace is still counted by its pid", () => {
		const now = Date.parse("2026-09-26T12:00:00.000Z");
		const own = {
			...instance({
				pid: 2,
				heartbeatAt: new Date(now - 7 * 3_600_000).toISOString(),
				lspChildren: childrenOfCount(3, "typescript", 100),
			}),
			pidNamespace: "pid:[own]",
		};

		expect(
			decideLspBudget([own], alivePids(2), 16, undefined, now, "pid:[own]")
				.totalLiveLspServers,
		).toBe(3);
		expect(
			decideLspBudget([own], alivePids(), 16, undefined, now, "pid:[own]")
				.totalLiveLspServers,
		).toBe(0);
	});

	it("empty registry — zero load, never over budget", () => {
		const decision = decideLspBudget([], () => true, 16);
		expect(decision.totalLiveLspServers).toBe(0);
		expect(decision.overBudget).toBe(false);
		expect(decision.degradeAuxiliary).toBe(false);
	});

	it("supplements count pressure with complete fresh aggregate RSS samples", () => {
		const now = Date.now();
		const reg = [
			instance({
				pid: 1,
				heartbeatAt: new Date(now).toISOString(),
				rssBytes: 40 * 1024 * 1024,
				lspChildren: [lspChild({ pid: 100, rssBytes: 70 * 1024 * 1024 })],
			}),
		];
		const decision = decideLspBudget(
			reg,
			() => true,
			16,
			100 * 1024 * 1024,
			now,
		);

		expect(decision.totalLiveLspServers).toBe(1);
		expect(decision.totalRssBytes).toBe(110 * 1024 * 1024);
		expect(decision.rssPressure).toBe(true);
		expect(decision.overBudget).toBe(true);
		expect(decision.shortenIdleTimeout).toBe(true);
		expect(decision.preferPullOnly).toBe(true);
	});

	it("fails open to count-only when RSS samples are missing or stale", () => {
		const now = Date.now();
		for (const reg of [
			[
				instance({
					heartbeatAt: new Date(now).toISOString(),
					rssBytes: 200 * 1024 * 1024,
					lspChildren: [lspChild({ rssBytes: undefined })],
				}),
			],
			[
				instance({
					heartbeatAt: "2000-01-01T00:00:00.000Z",
					rssBytes: 200 * 1024 * 1024,
				}),
			],
		]) {
			const decision = decideLspBudget(reg, () => true, 16, 1, now);
			expect(decision.totalRssBytes).toBeUndefined();
			expect(decision.rssPressure).toBe(false);
			expect(decision.overBudget).toBe(false);
		}
	});
});

describe("getLspBudgetCeiling / isCrossProcessBudgetEnabled (env config)", () => {
	const ORIGINAL_ENV = { ...process.env };

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	it("defaults to DEFAULT_LSP_BUDGET_CEILING when unset", () => {
		delete process.env.PI_LENS_LSP_BUDGET_CEILING;
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
	});

	it("honors a valid positive override", () => {
		process.env.PI_LENS_LSP_BUDGET_CEILING = "8";
		expect(getLspBudgetCeiling()).toBe(8);
	});

	it("falls back to default on a non-finite/zero/negative override (NaN guard)", () => {
		process.env.PI_LENS_LSP_BUDGET_CEILING = "not-a-number";
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
		process.env.PI_LENS_LSP_BUDGET_CEILING = "0";
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
		process.env.PI_LENS_LSP_BUDGET_CEILING = "-5";
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
	});

	it("enabled by default; PI_LENS_CROSS_PROCESS_BUDGET=0 disables", () => {
		delete process.env.PI_LENS_CROSS_PROCESS_BUDGET;
		expect(isCrossProcessBudgetEnabled()).toBe(true);
		process.env.PI_LENS_CROSS_PROCESS_BUDGET = "0";
		expect(isCrossProcessBudgetEnabled()).toBe(false);
	});

	it("keeps RSS pressure off by default and honors positive MB overrides", () => {
		delete process.env.PI_LENS_LSP_BUDGET_RSS_MB;
		expect(getLspBudgetRssCeilingBytes()).toBeUndefined();
		process.env.PI_LENS_LSP_BUDGET_RSS_MB = "512";
		expect(getLspBudgetRssCeilingBytes()).toBe(512 * 1024 * 1024);
		process.env.PI_LENS_LSP_BUDGET_RSS_MB = "invalid";
		expect(getLspBudgetRssCeilingBytes()).toBeUndefined();
	});

	it("uses a 60s pressure idle default and honors a positive override", () => {
		delete process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS;
		expect(getLspBudgetIdleTimeoutMs()).toBe(
			DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS,
		);
		process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS = "30000";
		expect(getLspBudgetIdleTimeoutMs()).toBe(30_000);
	});
});

describe("shouldDegradeAuxiliaryLsp (module-scope decision cache)", () => {
	beforeEach(() => {
		_resetLspBudgetDecisionForTests();
	});

	it("defaults to false before any check has run — fail toward today's behavior", () => {
		expect(shouldDegradeAuxiliaryLsp()).toBe(false);
	});

	it("caches pressure from a fabricated registry file at the boundary", async () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-budget-registry-"),
		);
		const previousHome = process.env.PI_LENS_HOME;
		const previousCeiling = process.env.PI_LENS_LSP_BUDGET_CEILING;
		process.env.PI_LENS_HOME = tmp;
		process.env.PI_LENS_LSP_BUDGET_CEILING = "1";
		_resetInstanceRegistryEnabledForTests();
		fs.writeFileSync(
			path.join(tmp, "instances.json"),
			JSON.stringify({
				instances: [
					instance({
						pid: process.pid,
						lspChildren: [lspChild({ pid: process.pid + 1 })],
					}),
				],
			}),
			"utf8",
		);

		try {
			await checkCrossProcessLspBudget();
			expect(shouldDegradeAuxiliaryLsp()).toBe(true);
			expect(shouldPreferPullOnlyDiagnostics()).toBe(true);
		} finally {
			_resetLspBudgetDecisionForTests();
			_resetInstanceRegistryEnabledForTests();
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			if (previousCeiling === undefined) {
				delete process.env.PI_LENS_LSP_BUDGET_CEILING;
			} else {
				process.env.PI_LENS_LSP_BUDGET_CEILING = previousCeiling;
			}
			removeTempDirSync(tmp);
		}
	});
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	classifyObservedRunner,
	COLLECT_LATER_THRESHOLD_MS,
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../../../clients/dispatch/collect-later-tier.js";
import {
	drainPendingRunnerFindings,
	deferRunnerFindings,
	dropStaleRunnerFindings,
	resetPendingRunnerFindings,
} from "../../../clients/dispatch/pending-runner-findings.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { RunnerResult } from "../../../clients/dispatch/types.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";

describe("observed runner collect-later tier (#2116)", () => {
	const projectRoot = setupTestEnvironment("pi-lens-runner-tier-").tmpDir;
	const filePath = join(projectRoot, "fixture.ts");

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-runner-tier-");
	});

	beforeEach(() => {
		resetObservedRunnerLatency();
		resetPendingRunnerFindings();
		resetDegradationLedger();
		writeFileSync(filePath, "const fixture = 1;\n");
	});

	it("moves a previously slow runner off the edit result and delivers its finding at turn end", async () => {
		observeRunnerLatency({
			projectRoot,
			runnerId: "fixture-runner",
			durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
		});
		let resolve!: (result: RunnerResult) => void;
		const completed = new Promise<RunnerResult>((r) => (resolve = r));
		const registry = new RunnerRegistry();
		registry.register({
			id: "fixture-runner",
			appliesTo: ["jsts"],
			priority: 1,
			run: async () => completed,
		});
		const ctx = createDispatchContext(
			filePath,
			projectRoot,
			{ getFlag: () => false },
			new FactStore(),
		);
		Object.defineProperty(ctx, "writeIndex", { value: 1 });
		expect(
			classifyObservedRunner(ctx.projectRoot ?? ctx.cwd, "fixture-runner"),
		).toBe("collect-later");

		const edit = await Promise.race([
			dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["fixture-runner"] }],
				registry,
			),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("edit waited for deferred runner")),
					100,
				),
			),
		]);
		expect(edit.diagnostics).toEqual([]);

		resolve({
			status: "succeeded",
			diagnostics: [
				{
					id: "fixture-finding",
					message: "late finding",
					filePath,
					tool: "fixture-runner",
					severity: "warning",
					semantic: "warning",
				},
			],
			semantic: "warning",
		});
		const late = await drainPendingRunnerFindings(100);
		expect(late).toHaveLength(1);
		expect(late[0]?.result?.diagnostics[0]?.id).toBe("fixture-finding");
	}, 20_000);

	it("recovers to inline after a fast observed run", () => {
		expect(classifyObservedRunner(projectRoot, "fixture-runner")).toBe(
			"inline",
		);
		expect(
			observeRunnerLatency({
				projectRoot,
				runnerId: "fixture-runner",
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			}),
		).toBe("collect-later");
		expect(
			observeRunnerLatency({
				projectRoot,
				runnerId: "fixture-runner",
				durationMs: 1,
			}),
		).toBe("inline");
	});

	it("keeps a deferred failure visible and delivers the affirmative failure", async () => {
		observeRunnerLatency({
			projectRoot,
			runnerId: "failed-runner",
			durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
		});
		let resolve!: (result: RunnerResult) => void;
		const registry = new RunnerRegistry();
		registry.register({
			id: "failed-runner",
			appliesTo: ["jsts"],
			priority: 1,
			run: async () => new Promise<RunnerResult>((r) => (resolve = r)),
		});
		const ctx = createDispatchContext(
			filePath,
			projectRoot,
			{ getFlag: () => false },
			new FactStore(),
		);
		Object.defineProperty(ctx, "writeIndex", { value: 1 });
		const edit = await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: ["failed-runner"] }],
			registry,
		);
		expect(edit.output).toContain("failed-runner");
		expect(edit.output).toContain("Pending runners");

		resolve({
			status: "failed",
			diagnostics: [],
			semantic: "warning",
			failureKind: "timeout",
			failureMessage: "runner timed out",
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		const late = await drainPendingRunnerFindings(0);
		expect(late[0]?.result).toMatchObject({
			status: "failed",
			failureKind: "timeout",
		});
	});

	it("does not defer a slow observation outside a write dispatch", async () => {
		observeRunnerLatency({
			projectRoot,
			runnerId: "direct-runner",
			durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
		});
		const registry = new RunnerRegistry();
		registry.register({
			id: "direct-runner",
			appliesTo: ["jsts"],
			priority: 1,
			run: async () => ({
				status: "succeeded",
				diagnostics: [
					{
						id: "direct",
						message: "direct",
						filePath,
						tool: "direct",
						severity: "warning",
						semantic: "warning",
					},
				],
				semantic: "warning",
			}),
		});
		const ctx = createDispatchContext(
			filePath,
			projectRoot,
			{ getFlag: () => false },
			new FactStore(),
		);
		const result = await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: ["direct-runner"] }],
			registry,
		);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.output).not.toContain("Pending runners");
		expect(await drainPendingRunnerFindings(0)).toEqual([]);
	});

	it("records the runner and file when the pending cap evicts an entry", () => {
		for (let i = 0; i <= 50; i++) {
			deferRunnerFindings({
				filePath: `${projectRoot}/evicted-${i}.ts`,
				cwd: projectRoot,
				projectRoot,
				runnerId: `runner-${i}`,
				markedAtMs: Date.now(),
				promise: new Promise<RunnerResult>(() => {}),
			});
		}
		const group = getDegradationSummary().find(
			(entry) => entry.kind === "runner-findings-evicted",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toContain("runner-0");
	});

	it("drops a stale completed result and records the coverage gap", async () => {
		const result: RunnerResult = {
			status: "succeeded",
			diagnostics: [
				{
					id: "stale",
					message: "stale",
					filePath,
					tool: "runner",
					severity: "warning",
					semantic: "warning",
				},
			],
			semantic: "warning",
		};
		deferRunnerFindings({
			filePath,
			cwd: projectRoot,
			projectRoot,
			runnerId: "stale-runner",
			markedAtMs: 1,
			promise: Promise.resolve(result),
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		const stale = (await drainPendingRunnerFindings(0))[0];
		dropStaleRunnerFindings(stale!);
		expect(await drainPendingRunnerFindings(0)).toEqual([]);
		expect(getDegradationSummary()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "runner-findings-stale",
					latestReasons: [
						expect.objectContaining({
							subject: `stale-runner:${filePath}`,
						}),
					],
				}),
			]),
		);
	});
});

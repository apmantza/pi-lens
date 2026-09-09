import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";

function rows(filePath: string): Record<string, unknown>[] {
	if (!fs.existsSync(filePath)) return [];
	return fs
		.readFileSync(filePath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("turn identity across observability sinks (#2815)", () => {
	let home: string;
	const previous = {
		home: process.env.PI_LENS_HOME,
		testMode: process.env.PI_LENS_TEST_MODE,
	};

	beforeAll(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-turn-id-"));
	});

	beforeEach(() => {
		process.env.PI_LENS_HOME = home;
		process.env.PI_LENS_TEST_MODE = "0";
		for (const file of [
			"latency.log",
			"extension.log",
			"review-graph.log",
			"read-guard.log",
		]) {
			fs.rmSync(path.join(home, file), { force: true });
		}
	});

	afterEach(() => {
		if (previous.home === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previous.home;
		if (previous.testMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previous.testMode;
	});

	afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

	it("stamps every real sink line with the turn that emitted it", async () => {
		const [
			{ RuntimeCoordinator },
			latency,
			extension,
			ledger,
			review,
			readGuard,
			turnContext,
		] = await Promise.all([
			import("../../clients/runtime-coordinator.js"),
			import("../../clients/latency-logger.js"),
			import("../../clients/extension-log.js"),
			import("../../clients/degradation-ledger.js"),
			import("../../clients/review-graph-logger.js"),
			import("../../clients/read-guard-logger.js"),
			import("../../clients/turn-context.js"),
		]);
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		runtime.setSessionLifecycle({ sessionId: "session-2815" });
		runtime.beginTurn();

		turnContext.runWithTurnContext("session-2815", () => {
			latency.logLatency({
				type: "phase",
				phase: "scripted_turn",
				filePath: "<test>",
				durationMs: 0,
			});
			extension.logExtension({ subsystem: "test", message: "turn one" });
			ledger.recordDegradationOnce({
				kind: "trust-refusal",
				subject: "turn-2815",
				reason: "test",
			});
			review.logReviewGraph({ cwd: home, phase: "build_started" });
			readGuard.logReadGuardEvent({
				event: "edit_blocked",
				filePath: path.join(home, "file.ts"),
			});
		});
		runtime.beginTurn();
		turnContext.runWithTurnContext("session-2815", () =>
			latency.logLatency({
				type: "phase",
				phase: "scripted_turn_two",
				filePath: "<test>",
				durationMs: 0,
			}));

		await Promise.all([
			latency.flushLatencyLog(),
			extension.flushExtensionLog(),
			review.flushReviewGraphLog(),
			readGuard.flushReadGuardLog(),
		]);
		const logDir = home;
		const latencyRows = rows(path.join(logDir, "latency.log"));
		const extensionRows = rows(path.join(logDir, "extension.log"));
		const reviewRows = rows(path.join(logDir, "review-graph.log"));
		const readGuardRows = rows(path.join(logDir, "read-guard.log"));

		expect(latencyRows.map((row) => row.turnId)).toContain("session-2815:1");
		expect(latencyRows.map((row) => row.turnId)).toContain("session-2815:2");
		expect(
			latencyRows
				.filter((row) => row.turnId === "session-2815:1")
				.map((row) => row.phase),
		).toEqual(expect.arrayContaining(["scripted_turn", "degradation_ledger"]));
		expect(extensionRows[0]?.turnId).toBe("session-2815:1");
		expect(reviewRows[0]?.turnId).toBe("session-2815:1");
		expect(readGuardRows[0]?.turnId).toBe("session-2815:1");
		expect(latencyRows.every((row) => typeof row.turnId === "string")).toBe(
			true,
		);
	});

	it("keeps interleaved secondary sessions on their own turnId prefixes (#473)", async () => {
		const [{ RuntimeCoordinator }, latency, guard] = await Promise.all([
			import("../../clients/runtime-coordinator.js"),
			import("../../clients/latency-logger.js"),
			import("../../clients/session-event-guard.js"),
		]);

		const primary = new RuntimeCoordinator();
		const secondary = new RuntimeCoordinator();
		primary.resetForSession();
		primary.setSessionLifecycle({ sessionId: "primary-2815" });
		secondary.resetForSession();
		secondary.setSessionLifecycle({ sessionId: "secondary-2815" });

		const write = guard.wrapSessionEventHandler(
			"turn_start",
			async (
				_event: unknown,
				ctx: { sessionManager: { getSessionId: () => string } },
			) => {
				const runtime =
					ctx.sessionManager.getSessionId() === "primary-2815"
						? primary
						: secondary;
				runtime.beginTurn();
				await Promise.resolve();
				latency.logLatency({
					type: "phase",
					phase: `${ctx.sessionManager.getSessionId()}_turn`,
					filePath: "<test>",
					durationMs: 0,
				});
			},
		);
		const primaryCtx = {
			sessionManager: { getSessionId: () => "primary-2815" },
		};
		const secondaryCtx = {
			sessionManager: { getSessionId: () => "secondary-2815" },
		};

		await Promise.all([write({}, primaryCtx), write({}, secondaryCtx)]);
		await latency.flushLatencyLog();
		const latencyRows = rows(path.join(home, "latency.log"));
		expect(latencyRows.map((row) => row.phase)).toEqual(
			expect.arrayContaining(["primary-2815_turn", "secondary-2815_turn"]),
		);
		expect(
			latencyRows
				.filter((row) => row.phase === "primary-2815_turn")
				.every((row) => String(row.turnId).startsWith("primary-2815:")),
		).toBe(true);
		expect(
			latencyRows
				.filter((row) => row.phase === "secondary-2815_turn")
				.every((row) => String(row.turnId).startsWith("secondary-2815:")),
		).toBe(true);
	});

	it("keeps context-free and detached writers at turn:0 (#2815 F3)", async () => {
		const [{ RuntimeCoordinator }, latency, guard, turnContext] =
			await Promise.all([
				import("../../clients/runtime-coordinator.js"),
				import("../../clients/latency-logger.js"),
				import("../../clients/session-event-guard.js"),
				import("../../clients/turn-context.js"),
			]);
		const primary = new RuntimeCoordinator();
		const secondary = new RuntimeCoordinator();
		primary.resetForSession();
		primary.setSessionLifecycle({ sessionId: "primary-probe" });
		secondary.resetForSession();
		secondary.setSessionLifecycle({ sessionId: "secondary-probe" });
		const write = guard.wrapSessionEventHandler(
			"turn_start",
			async (
				_event: unknown,
				ctx: { sessionManager: { getSessionId: () => string } },
			) => {
				const runtime =
					ctx.sessionManager.getSessionId() === "primary-probe"
						? primary
						: secondary;
				const turnId = runtime.beginTurn();
				await Promise.resolve();
				latency.logLatency({
					type: "phase",
					phase: `${ctx.sessionManager.getSessionId()}_turn`,
					filePath: "<test>",
					durationMs: 0,
					turnId,
				});
			},
		);
		await Promise.all([
			write({}, { sessionManager: { getSessionId: () => "primary-probe" } }),
			write({}, { sessionManager: { getSessionId: () => "secondary-probe" } }),
		]);

		// This is a detached batch: it starts after both host-event scopes ended.
		const outsideTurn = turnContext.getTurnId();
		latency.logLatency({
			type: "phase",
			phase: "outside_detached",
			filePath: "<test>",
			durationMs: 0,
		});
		await latency.flushLatencyLog();
		const latencyRows = rows(path.join(home, "latency.log"));
		expect(outsideTurn).toBe("turn:0");
		expect(
			latencyRows.find((row) => row.phase === "outside_detached")?.turnId,
		).toBe("turn:0");
	});

	it("restarts the per-session counter at one after session_start", async () => {
		const [{ RuntimeCoordinator }, turnContext] = await Promise.all([
			import("../../clients/runtime-coordinator.js"),
			import("../../clients/turn-context.js"),
		]);
		const runWithTurnContext = (
			turnContext as typeof turnContext & {
				runWithTurnContext?: <T>(sessionId: string, fn: () => T) => T;
			}
		).runWithTurnContext;
		expect(runWithTurnContext).toBeTypeOf("function");
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		runtime.setSessionLifecycle({ sessionId: "reset-2815" });
		runtime.beginTurn();
		runtime.beginTurn();

		runtime.resetForSession();
		runtime.setSessionLifecycle({ sessionId: "reset-2815" });
		runtime.beginTurn();
		expect(
			runWithTurnContext?.("reset-2815", () => turnContext.getTurnId()),
		).toBe("reset-2815:1");
	});
});

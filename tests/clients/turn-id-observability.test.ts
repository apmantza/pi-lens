import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-turn-id-"));
		process.env.PI_LENS_HOME = home;
		process.env.PI_LENS_TEST_MODE = "0";
	});

	afterEach(() => {
		if (previous.home === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previous.home;
		if (previous.testMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previous.testMode;
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("stamps every real sink line with the turn that emitted it", async () => {
		const [
			{ RuntimeCoordinator },
			latency,
			extension,
			ledger,
			review,
			readGuard,
		] = await Promise.all([
			import("../../clients/runtime-coordinator.js"),
			import("../../clients/latency-logger.js"),
			import("../../clients/extension-log.js"),
			import("../../clients/degradation-ledger.js"),
			import("../../clients/review-graph-logger.js"),
			import("../../clients/read-guard-logger.js"),
		]);
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		runtime.setSessionLifecycle({ sessionId: "session-2815" });
		runtime.beginTurn();

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
		runtime.beginTurn();
		latency.logLatency({
			type: "phase",
			phase: "scripted_turn_two",
			filePath: "<test>",
			durationMs: 0,
		});

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
});

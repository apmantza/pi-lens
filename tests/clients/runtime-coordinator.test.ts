import { describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.ts";

describe("RuntimeCoordinator", () => {
	it("resetForSession clears any existing read guard state", () => {
		const runtime = new RuntimeCoordinator();
		const runtimeState = runtime as any;

		runtimeState._readGuard = { sentinel: true };
		runtime.resetForSession();

		expect(runtimeState._readGuard).toBeNull();
	});

	it("tracks first-read LSP warming and suppresses duplicate warmups", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = "/tmp/example.ts";

		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(true);

		runtime.markLspReadWarmStarted(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(false);

		runtime.markLspReadWarmCompleted(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(false);

		runtime.clearLspReadWarmState(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(true);
	});
});

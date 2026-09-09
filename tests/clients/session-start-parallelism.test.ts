import { describe, expect, it } from "vitest";

/**
 * Tests that verify ensureAvailable() uses async patterns (non-blocking).
 *
 * Before the fix: ensureAvailable() used sync spawnSync, blocking the event loop.
 * After the fix: ensureAvailable() uses async safeSpawnAsync, non-blocking.
 */
describe("tool availability async patterns", () => {
	it("ruff-client ensureAvailable returns a Promise", async () => {
		const { RuffClient } = await import("../../clients/ruff-client.js");
		const client = new RuffClient();

		const result = client.ensureAvailable();
		expect(result).toBeInstanceOf(Promise);

		// Don't await full result - it spawns real process.
		// Just verify it's async by checking then() exists
		expect(typeof result.then).toBe("function");
	});

	it("biome-client ensureAvailable returns a Promise", async () => {
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();

		const result = client.ensureAvailable();
		expect(result).toBeInstanceOf(Promise);
		expect(typeof result.then).toBe("function");
	});

	it("knip-client ensureAvailable returns a Promise", async () => {
		const { KnipClient } = await import("../../clients/knip-client.js");
		const client = new KnipClient();

		const result = client.ensureAvailable();
		expect(result).toBeInstanceOf(Promise);
		expect(typeof result.then).toBe("function");
	});

	it("jscpd-client ensureAvailable returns a Promise", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const client = new JscpdClient();

		const result = client.ensureAvailable();
		expect(result).toBeInstanceOf(Promise);
		expect(typeof result.then).toBe("function");
	});

	it("dependency-checker ensureAvailable returns a Promise", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const client = new DependencyChecker();

		const result = client.ensureAvailable();
		expect(result).toBeInstanceOf(Promise);
		expect(typeof result.then).toBe("function");
	});

	it("sg-runner ensureAvailable returns a Promise", async () => {
		const { SgRunner } = await import("../../clients/sg-runner.js");
		const client = new SgRunner();

		const result = client.ensureAvailable();
		expect(result).toBeInstanceOf(Promise);
		expect(typeof result.then).toBe("function");
	});
});

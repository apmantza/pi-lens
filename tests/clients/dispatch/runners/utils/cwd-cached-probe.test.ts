import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCwdCachedProbe } from "../../../../../clients/dispatch/runners/utils/runner-helpers.js";

describe("createCwdCachedProbe (#120)", () => {
	const probeFn = vi.fn();

	beforeEach(() => {
		probeFn.mockReset();
	});

	it("runs the probe at most once per cwd across repeat callers", async () => {
		probeFn.mockResolvedValue(true);
		const probe = createCwdCachedProbe(probeFn);
		const a = await probe("/tmp/project-a");
		const b = await probe("/tmp/project-a");
		const c = await probe("/tmp/project-a");
		expect([a, b, c]).toEqual([true, true, true]);
		expect(probeFn).toHaveBeenCalledTimes(1);
	});

	it("dedupes concurrent first-time callers to a single in-flight probe", async () => {
		let resolveProbe: ((value: boolean) => void) | undefined;
		probeFn.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const probe = createCwdCachedProbe(probeFn);
		const a = probe("/tmp/project-b");
		const b = probe("/tmp/project-b");
		const c = probe("/tmp/project-b");
		expect(probeFn).toHaveBeenCalledTimes(1);
		resolveProbe?.(true);
		const results = await Promise.all([a, b, c]);
		expect(results).toEqual([true, true, true]);
		// Subsequent call hits the cache directly.
		await probe("/tmp/project-b");
		expect(probeFn).toHaveBeenCalledTimes(1);
	});

	it("scopes the cache per cwd", async () => {
		probeFn.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		const probe = createCwdCachedProbe(probeFn);
		const a = await probe("/tmp/project-c");
		const b = await probe("/tmp/project-d");
		expect(a).toBe(true);
		expect(b).toBe(false);
		expect(probeFn).toHaveBeenCalledTimes(2);
	});

	it("caches the failure outcome (no auto-retry — caller must bust the cache)", async () => {
		probeFn.mockResolvedValue(false);
		const probe = createCwdCachedProbe(probeFn);
		expect(await probe("/tmp/project-e")).toBe(false);
		expect(await probe("/tmp/project-e")).toBe(false);
		expect(await probe("/tmp/project-e")).toBe(false);
		expect(probeFn).toHaveBeenCalledTimes(1);
	});

	it("treats a thrown probe as false and still caches", async () => {
		probeFn.mockRejectedValue(new Error("probe blew up"));
		const probe = createCwdCachedProbe(probeFn);
		expect(await probe("/tmp/project-f")).toBe(false);
		expect(await probe("/tmp/project-f")).toBe(false);
		expect(probeFn).toHaveBeenCalledTimes(1);
	});
});

/**
 * Tests for the shared process-bridge registration helper
 * (clients/process-bridge.ts, #2437).
 *
 * `clients/read-bridge.ts` and `clients/mutation-bridge.ts` both delegate
 * their mount body to `registerProcessBridge`/`getProcessBridge`; this file
 * pins the helper's own contract directly, with fresh `Symbol()` keys per
 * test so it never collides with the real bridge keys other test files (or
 * this one) mount at `READ_BRIDGE_KEY`/`MUTATION_BRIDGE_KEY`.
 *
 * Verifies:
 * - registerProcessBridge mounts `build()`'s result at `globalThis[key]`
 * - Second registerProcessBridge call on the same key is a no-op: `build`
 *   is never invoked again, and the first mount is unchanged
 * - The mount is frozen, non-writable, and non-configurable
 * - getProcessBridge returns the mounted bridge when the version matches
 * - getProcessBridge returns undefined on a version mismatch, an absent key,
 *   and a non-object mount
 */
import { describe, expect, it, vi } from "vitest";
import { beginScope, retireScope } from "../../clients/session-scope.js";
import {
	getProcessBridge,
	rebindableProcessBridgeDeps,
	registerProcessBridge,
	type ProcessBridge,
} from "../../clients/process-bridge.js";

interface Probe extends ProcessBridge {
	readonly version: number;
	ping(): string;
}

describe("registerProcessBridge", () => {
	it("only accepts a newer live primary activation for a scoped cell", () => {
		const family = `pi-lens-test:process-bridge-scope-${Math.random()}`;
		const primaryA = beginScope({ role: "primary" });
		const secondary = beginScope({ role: "secondary" });
		const primaryB = beginScope({ role: "primary" });
		const staleA = primaryA;

		const get = rebindableProcessBridgeDeps(family, 1, primaryA, { id: "A" });
		rebindableProcessBridgeDeps(family, 1, secondary, { id: "B" });
		expect(get()?.id).toBe("A");
		rebindableProcessBridgeDeps(family, 1, primaryB, { id: "B" });
		expect(get()?.id).toBe("B");
		rebindableProcessBridgeDeps(family, 1, staleA, { id: "A-stale" });
		expect(get()?.id).toBe("B");
	});
	it("refuses a retired primary until a newer primary binds", () => {
		const family = `pi-lens-test:process-bridge-gap-${Math.random()}`;
		const primary = beginScope({ role: "primary" });
		const successor = beginScope({ role: "primary" });
		const get = rebindableProcessBridgeDeps(family, 1, primary, { id: "A" });

		retireScope(primary, "reload");
		expect(get()).toBeUndefined();
		rebindableProcessBridgeDeps(family, 1, successor, { id: "B" });
		expect(get()?.id).toBe("B");
	});
	it("does not let a later factory pre-session bind replace a live primary", () => {
		const family = `pi-lens-test:process-bridge-pre-session-${Math.random()}`;
		const primary = beginScope({ role: "primary" });
		const get = rebindableProcessBridgeDeps(family, 1, primary, { id: "A" });

		rebindableProcessBridgeDeps(
			family,
			1,
			{ role: "pre-session" },
			{ id: "factory" },
		);
		expect(get()?.id).toBe("A");
	});
	it("mounts build()'s result at globalThis[key]", () => {
		const key = Symbol("pi-lens-test:process-bridge-mount");
		const build = vi.fn((): Probe => ({ version: 1, ping: () => "pong" }));

		registerProcessBridge(key, build);

		expect(build).toHaveBeenCalledTimes(1);
		const mounted = (globalThis as Record<symbol, unknown>)[key] as Probe;
		expect(mounted.version).toBe(1);
		expect(mounted.ping()).toBe("pong");
	});

	it("is first-wins: a second call never invokes build and leaves the mount untouched", () => {
		const key = Symbol("pi-lens-test:process-bridge-first-wins");
		const first = vi.fn((): Probe => ({ version: 1, ping: () => "first" }));
		const second = vi.fn((): Probe => ({ version: 1, ping: () => "second" }));

		registerProcessBridge(key, first);
		const mountedAfterFirst = (globalThis as Record<symbol, unknown>)[key];

		registerProcessBridge(key, second);

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).not.toHaveBeenCalled();
		expect((globalThis as Record<symbol, unknown>)[key]).toBe(
			mountedAfterFirst,
		);
		expect((mountedAfterFirst as Probe).ping()).toBe("first");
	});

	it("mounts the bridge frozen", () => {
		const key = Symbol("pi-lens-test:process-bridge-frozen");
		registerProcessBridge(key, (): Probe => ({ version: 1, ping: () => "x" }));

		const mounted = (globalThis as Record<symbol, unknown>)[key];
		expect(Object.isFrozen(mounted)).toBe(true);
		expect(() => {
			(mounted as { ping: unknown }).ping = () => "tampered";
		}).toThrow(TypeError);
	});

	it("mounts the global property non-writable and non-configurable", () => {
		const key = Symbol("pi-lens-test:process-bridge-locked");
		registerProcessBridge(key, (): Probe => ({ version: 1, ping: () => "x" }));

		expect(() => {
			(globalThis as Record<symbol, unknown>)[key] = { version: 1 };
		}).toThrow(TypeError);
		expect(() => {
			delete (globalThis as Record<symbol, unknown>)[key];
		}).toThrow(TypeError);
		expect(key in (globalThis as object)).toBe(true);
	});
});

describe("getProcessBridge", () => {
	it("returns the mounted bridge when the version matches", () => {
		const key = Symbol("pi-lens-test:process-bridge-get-match");
		registerProcessBridge(key, (): Probe => ({ version: 3, ping: () => "v3" }));

		const bridge = getProcessBridge<Probe>(key, 3);
		expect(bridge?.ping()).toBe("v3");
	});

	it("returns undefined when the mounted version does not match", () => {
		const key = Symbol("pi-lens-test:process-bridge-get-mismatch");
		registerProcessBridge(key, (): Probe => ({ version: 1, ping: () => "v1" }));

		expect(getProcessBridge<Probe>(key, 2)).toBeUndefined();
		// The mismatch is not adopted or reset — the mount is untouched.
		expect(
			((globalThis as Record<symbol, unknown>)[key] as Probe).version,
		).toBe(1);
	});

	it("returns undefined when nothing is mounted at key", () => {
		const key = Symbol("pi-lens-test:process-bridge-get-absent");
		expect(getProcessBridge<Probe>(key, 1)).toBeUndefined();
	});

	it("returns undefined when the mounted value is not an object", () => {
		const key = Symbol("pi-lens-test:process-bridge-get-non-object");
		Object.defineProperty(globalThis, key, {
			value: "not-a-bridge",
			writable: false,
			configurable: false,
			enumerable: false,
		});
		expect(getProcessBridge<Probe>(key, 1)).toBeUndefined();
	});
});

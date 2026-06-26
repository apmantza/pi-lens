import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetTypeScriptDispatchUnitsForTests,
	ensureTypeScriptDispatchUnits,
} from "../../clients/dispatch/fact-runner.js";

// Simulate #285/#335 for the dispatch's TypeScript-backed units: one of the
// lazily-imported fact modules can't load. The single-seam lazy registration in
// runProviders must SURVIVE this — degrade + log, never throw — so the rest of
// the dispatch (non-TS providers/rules) still runs.
vi.mock("../../clients/dispatch/facts/function-facts.js", () => {
	throw new Error("simulated: Cannot find package 'typescript'");
});

describe("dispatch TypeScript units fail-soft (#285/#335)", () => {
	afterEach(() => {
		_resetTypeScriptDispatchUnitsForTests();
		vi.restoreAllMocks();
	});

	it("degrades + logs when a TS unit can't load, without throwing", async () => {
		const errs: string[] = [];
		vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
			errs.push(String(m));
		});
		_resetTypeScriptDispatchUnitsForTests();

		await expect(ensureTypeScriptDispatchUnits()).resolves.toBeUndefined();
		expect(
			errs.some((e) => /TypeScript-based dispatch analysis disabled/.test(e)),
		).toBe(true);

		// Memoized: a second call doesn't re-throw or re-log.
		const before = errs.length;
		await expect(ensureTypeScriptDispatchUnits()).resolves.toBeUndefined();
		expect(errs.length).toBe(before);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isTestMode,
	lazyEnvNumber,
	toPositiveFinite,
} from "../../clients/env-utils.js";

let previousTestMode: string | undefined;
let previousVitest: string | undefined;

beforeEach(() => {
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	previousVitest = process.env.VITEST;
});

afterEach(() => {
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
	if (previousVitest === undefined) delete process.env.VITEST;
	else process.env.VITEST = previousVitest;
});

describe("isTestMode", () => {
	it("returns true when PI_LENS_TEST_MODE=1", () => {
		process.env.PI_LENS_TEST_MODE = "1";
		delete process.env.VITEST;
		expect(isTestMode()).toBe(true);
	});

	it("returns true when VITEST is set (no explicit opt-out)", () => {
		delete process.env.PI_LENS_TEST_MODE;
		process.env.VITEST = "1";
		expect(isTestMode()).toBe(true);
	});

	it("returns false when VITEST is set but PI_LENS_TEST_MODE=0 (explicit opt-out wins)", () => {
		process.env.PI_LENS_TEST_MODE = "0";
		process.env.VITEST = "1";
		expect(isTestMode()).toBe(false);
	});

	it("returns false when neither var is set", () => {
		delete process.env.PI_LENS_TEST_MODE;
		delete process.env.VITEST;
		expect(isTestMode()).toBe(false);
	});

	it("treats PI_LENS_TEST_MODE values other than '1' as non-opt-in (without VITEST)", () => {
		process.env.PI_LENS_TEST_MODE = "true";
		delete process.env.VITEST;
		expect(isTestMode()).toBe(false);
	});
});

describe("toPositiveFinite", () => {
	it("returns the number when it is a positive finite value", () => {
		expect(toPositiveFinite(180000)).toBe(180000);
		expect(toPositiveFinite("60000")).toBe(60000);
	});

	it("returns 0 for NaN, undefined, null, infinity, and non-numeric strings", () => {
		expect(toPositiveFinite(undefined)).toBe(0);
		expect(toPositiveFinite(null)).toBe(0);
		expect(toPositiveFinite(NaN)).toBe(0);
		expect(toPositiveFinite(Number.POSITIVE_INFINITY)).toBe(0);
		expect(toPositiveFinite(Number.NEGATIVE_INFINITY)).toBe(0);
		expect(toPositiveFinite("not-a-number")).toBe(0);
		expect(toPositiveFinite("")).toBe(0);
	});

	it("returns 0 for zero and negative values", () => {
		expect(toPositiveFinite(0)).toBe(0);
		expect(toPositiveFinite(-1)).toBe(0);
		expect(toPositiveFinite("-1000")).toBe(0);
	});

	it("never returns NaN — Math.max safety guarantee", () => {
		// The whole point of this helper is to prevent NaN propagation. Sanity-check
		// every path lands at a finite number.
		for (const input of [
			undefined,
			null,
			NaN,
			Number.POSITIVE_INFINITY,
			-5,
			"garbage",
			"",
		]) {
			expect(Number.isNaN(toPositiveFinite(input))).toBe(false);
			expect(Number.isFinite(toPositiveFinite(input))).toBe(true);
		}
	});
});

describe("lazyEnvNumber", () => {
	const ENV_NAME = "PI_LENS_TEST_LAZY_ENV_NUMBER";

	afterEach(() => {
		delete process.env[ENV_NAME];
	});

	it("does not read process.env at construction time", () => {
		process.env[ENV_NAME] = "999";
		// Constructing must not memoize a value yet — only `get()` reads env.
		const knob = lazyEnvNumber(ENV_NAME, 7);
		delete process.env[ENV_NAME];
		expect(knob.get()).toBe(7);
	});

	it("defaults to fallback when the env var is unset", () => {
		const knob = lazyEnvNumber(ENV_NAME, 42);
		expect(knob.get()).toBe(42);
	});

	it("honours a positive finite env override", () => {
		process.env[ENV_NAME] = "123";
		const knob = lazyEnvNumber(ENV_NAME, 42);
		expect(knob.get()).toBe(123);
	});

	it("falls back on a non-finite/negative/zero override", () => {
		for (const bad of ["not-a-number", "-5", "0", "", "Infinity"]) {
			process.env[ENV_NAME] = bad;
			const knob = lazyEnvNumber(ENV_NAME, 42);
			expect(knob.get()).toBe(42);
		}
	});

	it("memoizes until _resetForTests is called", () => {
		const knob = lazyEnvNumber(ENV_NAME, 42);
		expect(knob.get()).toBe(42);
		process.env[ENV_NAME] = "123";
		// No reset yet — still the memoized fallback.
		expect(knob.get()).toBe(42);
		knob._resetForTests();
		expect(knob.get()).toBe(123);
	});

	it("keeps independent memo state per factory instance", () => {
		const a = lazyEnvNumber(ENV_NAME, 1);
		const b = lazyEnvNumber(ENV_NAME, 2);
		process.env[ENV_NAME] = "10";
		expect(a.get()).toBe(10);
		delete process.env[ENV_NAME];
		expect(b.get()).toBe(2);
	});
});

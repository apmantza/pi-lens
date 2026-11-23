/**
 * The byte caps of `read-guard.log` and `actionable-warnings.log` go through the
 * same limit reader as the retention and rotation limits (#5771): `0`, `off`
 * or `unlimited` is no cap, and an unusable value is named by
 * `unusableLogLimitEnv()` instead of silently becoming the default.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { unusableLogLimitEnv } from "../../clients/log-rotation-limits.js";

const FLOOR_BYTES = 128 * 1024;
const DEFAULT_BYTES = 1048576;

async function maxBytesOf(moduleName: string): Promise<number | undefined> {
	vi.resetModules();
	const created: Array<{ maxBytes?: number }> = [];
	type Options = Parameters<
		typeof import("../../clients/ndjson-logger.js").createNdjsonLogger
	>[0];
	vi.doMock("../../clients/ndjson-logger.js", async (importOriginal) => {
		const original =
			await importOriginal<typeof import("../../clients/ndjson-logger.js")>();
		return {
			...original,
			createNdjsonLogger: (options: Options) => {
				created.push(options);
				return original.createNdjsonLogger(options);
			},
		};
	});
	await import(`../../clients/${moduleName}.js`);
	return created[0]?.maxBytes;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.doUnmock("../../clients/ndjson-logger.js");
	vi.resetModules();
});

describe.each([
	["read-guard-logger", "PI_LENS_READ_GUARD_MAX_BYTES"],
	["actionable-warnings-logger", "PI_LENS_AW_LOG_MAX_BYTES"],
])("%s byte cap", (moduleName, envName) => {
	it.each(["0", "off", "Unlimited"])("is no cap when the value is %s", async (value) => {
		vi.stubEnv(envName, value);
		expect(await maxBytesOf(moduleName)).toBe(Number.POSITIVE_INFINITY);
	});

	it("keeps the default when unset", async () => {
		vi.stubEnv(envName, undefined);
		expect(await maxBytesOf(moduleName)).toBe(DEFAULT_BYTES);
	});

	it("raises a positive value below the floor to the floor", async () => {
		vi.stubEnv(envName, "5");
		expect(await maxBytesOf(moduleName)).toBe(FLOOR_BYTES);
	});

	it("uses the default for an unusable value and names it", async () => {
		vi.stubEnv(envName, "lots");
		expect(await maxBytesOf(moduleName)).toBe(DEFAULT_BYTES);
		expect(unusableLogLimitEnv()).toEqual([`${envName}=lots`]);
	});
});

describe("unusableLogLimitEnv", () => {
	it("is empty when every log-limit variable is unset or usable", () => {
		vi.stubEnv("PI_LENS_LOG_RETENTION_DAYS", "30");
		vi.stubEnv("PI_LENS_MAX_LOG_SIZE_MB", "off");
		expect(unusableLogLimitEnv()).toEqual([]);
	});

	it("names each unusable variable once", () => {
		vi.stubEnv("PI_LENS_LOG_RETENTION_DAYS", "seven");
		vi.stubEnv("PI_LENS_MAX_LOG_SIZE_MB", "-1");
		expect(unusableLogLimitEnv()).toEqual([
			"PI_LENS_LOG_RETENTION_DAYS=seven",
			"PI_LENS_MAX_LOG_SIZE_MB=-1",
		]);
	});
});

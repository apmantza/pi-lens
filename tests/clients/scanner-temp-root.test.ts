import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scannerReportParentDir } from "../../clients/scanner-temp-root.js";

afterEach(() => vi.unstubAllEnvs());

describe("scanner report root admission (#4292 r5)", () => {
	// A leaked root alone must never relocate production scanner output.
	it.each([undefined, "0", "true", "2"])(
		"rejects a production root with harness marker %s",
		(marker) => {
			vi.stubEnv("VITEST", undefined);
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			vi.stubEnv("PI_LENS_TEST_SCANNER_HARNESS", marker);
			vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", " /owned/scanner-root ");
			expect(scannerReportParentDir()).toBe(os.tmpdir());
		},
	);

	// Real-pi clears VITEST and needs logging; MCP tests may opt out of logs' test mode.
	it.each([undefined, "true"])(
		"admits an owned harness root with VITEST=%s despite logging opt-out",
		(vitest) => {
			vi.stubEnv("VITEST", vitest);
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			vi.stubEnv("PI_LENS_TEST_SCANNER_HARNESS", "1");
			vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", " /owned/scanner-root ");
			expect(scannerReportParentDir()).toBe("/owned/scanner-root");
		},
	);

	it.each([undefined, "", "   "])(
		"uses the default for an absent or blank test root %s",
		(root) => {
			vi.stubEnv("PI_LENS_TEST_MODE", "1");
			vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", root);
			expect(scannerReportParentDir()).toBe(os.tmpdir());
		},
	);

	it("admits an ordinary vitest worker root without a harness marker", () => {
		vi.stubEnv("VITEST", "true");
		vi.stubEnv("PI_LENS_TEST_MODE", undefined);
		vi.stubEnv("PI_LENS_TEST_SCANNER_HARNESS", undefined);
		vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", "/worker/scanner-root");
		expect(scannerReportParentDir()).toBe("/worker/scanner-root");
	});
});

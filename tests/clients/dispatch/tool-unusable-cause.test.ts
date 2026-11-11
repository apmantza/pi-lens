/**
 * #5258 r2 (review F1, F2, F6): the cause a tool-unusable skip states is the one
 * the availability checker found, never "not installed" for a tool that timed
 * out, rejected its probe or was refused by trust, and the install kill switch
 * is named only of a tool the installer could have supplied.
 *
 * Recurrence prevented: `toolAbsentSkip()` returned `not-installed` or
 * `install-disabled` for every unusable command (trust-refused project binary,
 * hung `--version`, non-zero `--version`), told the user to install a tool that
 * was installed, and kept the wrong cause in the session ledger; its production
 * default (switch unset) was pinned by no test because Vitest exports the switch
 * everywhere (mutating it to always `install-disabled` passed 207 tests).
 * The verdict is the typed `AvailabilityVerdict` a real checker holds; the
 * real-pi rows in `tests/real-harness/clean-verdict.test.ts` drive the same
 * outcomes through real checkers and shims.
 */

import * as os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	toolAbsentSkip,
	type AvailabilityVerdict,
} from "../../../clients/dispatch/runners/utils/runner-helpers.js";
import { withEnv } from "../../support/with-env.js";

const cwd = os.tmpdir();

const verdict = (
	outcome: AvailabilityVerdict["outcome"],
	cause: AvailabilityVerdict["cause"],
): { getVerdict: () => AvailabilityVerdict } => ({
	getVerdict: () => ({
		outcome,
		cause,
		elapsedMs: 0,
		latched: false,
		retryAtMs: 0,
	}),
});

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("a tool-unusable skip states the verdict's cause (#5258)", () => {
	it.each([
		["transient", "probe-timeout", "probe-incomplete"],
		["transient", "host-stall", "probe-incomplete"],
		["transient", "probe-rejected", "probe-incomplete"],
		["non-installable", "bad-cwd", "probe-incomplete"],
		["non-installable", "probe-rejected", "probe-rejected"],
		["missing", "policy-denied", "trust-refused"],
		["missing", "not-found", "not-installed"],
	] as const)("%s / %s reads %s", (outcome, cause, reason) => {
		restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: undefined });
		expect(
			toolAbsentSkip(cwd, {
				id: "shellcheck",
				checker: verdict(outcome, cause),
			}).skipReason,
		).toBe(reason);
	});

	it("reads a finder with no verdict as a plain absence", () => {
		restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: undefined });
		expect(toolAbsentSkip(cwd).skipReason).toBe("not-installed");
	});
});

describe("install-disabled is said only when the switch is the cause (#5258)", () => {
	// F2: the production default. Vitest exports the switch =1 for every run, so
	// the unset case needs its own row.
	it("reads not-installed when the install switch is unset", () => {
		restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: undefined });
		expect(toolAbsentSkip(cwd, { id: "shellcheck" }).skipReason).toBe(
			"not-installed",
		);
	});

	it("reads install-disabled for an installable tool when the switch is on", () => {
		restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
		expect(toolAbsentSkip(cwd, { id: "shellcheck" }).skipReason).toBe(
			"install-disabled",
		);
	});

	// F6: go-vet, cargo, javac, dart, zig and typos have no managed install, so
	// flipping the switch would not supply them.
	it("reads not-installed for a tool the installer does not own, switch on", () => {
		restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
		expect(toolAbsentSkip(cwd).skipReason).toBe("not-installed");
		expect(toolAbsentSkip(cwd, { id: "typos" }).skipReason).toBe(
			"not-installed",
		);
	});
});

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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAvailabilityChecker,
	ruff,
	toolAbsentSkip,
	type AvailabilityVerdict,
} from "../../../clients/dispatch/runners/utils/runner-helpers.js";
import {
	NODE_MODULES_BIN_DIRS,
	VENV_BIN_DIRS,
} from "../../../clients/package-manager.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { removeTempDirSync } from "../test-utils.js";
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

describe("the skip reads only the resolution the runner used (#5258 r3)", () => {
	// Recurrence prevented: #5258 r2 verify N2-N4. `toolAbsentSkip` read the
	// registry ladder for any `id`, so rubocop (its own spawn) said "not
	// installed, and the managed install is off" for a rubocop that rejected
	// `--version`; its trust lookup looked in `node_modules/.bin` for a checker
	// that never does; and a refused ancestor binary, or a Java that timed out,
	// read as an absence.
	let project: string | undefined;
	afterEach(() => {
		resetProjectTrust();
		if (project) removeTempDirSync(project);
		project = undefined;
	});

	const plant = (binDir: string, name: string): string => {
		project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5258-r3-"));
		const dir = path.join(project, binDir);
		fs.mkdirSync(dir, { recursive: true });
		for (const file of [name, `${name}.exe`, `${name}.cmd`])
			fs.writeFileSync(path.join(dir, file), "#!/bin/sh\nexit 0\n");
		return project;
	};

	it("reads trust-refused when trust refused the binary the checker's own rung looks up", () => {
		const cwd = plant(VENV_BIN_DIRS[0], "ruff");
		setProjectTrustState("untrusted");
		expect(toolAbsentSkip(cwd, { id: "ruff", checker: ruff }).skipReason).toBe(
			"trust-refused",
		);
		expect(toolAbsentSkip(cwd, { id: "htmlhint" }).skipReason).not.toBe(
			"trust-refused",
		);
	});

	it("reads the registry ladder's node_modules rung for an id alone", () => {
		const cwd = plant(NODE_MODULES_BIN_DIRS[0], "htmlhint");
		setProjectTrustState("untrusted");
		expect(toolAbsentSkip(cwd, { id: "htmlhint" }).skipReason).toBe(
			"trust-refused",
		);
	});

	it("does not read a refusal from a rung the runner's checker never looks up", () => {
		// ruff's checker looks in the venv dirs only, never `node_modules/.bin`.
		const cwd = plant(NODE_MODULES_BIN_DIRS[0], "ruff");
		setProjectTrustState("untrusted");
		restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: undefined });
		expect(toolAbsentSkip(cwd, { id: "ruff", checker: ruff }).skipReason).toBe(
			"not-installed",
		);
	});

	it("reads no refusal for a trusted project or a ladder without a project rung", () => {
		const cwd = plant(VENV_BIN_DIRS[0], "ruff");
		restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: undefined });
		setProjectTrustState("trusted");
		expect(toolAbsentSkip(cwd, { id: "ruff", checker: ruff }).skipReason).toBe(
			"not-installed",
		);
		setProjectTrustState("untrusted");
		const pathOnly = createAvailabilityChecker("ruff", ".exe", ["--version"], {
			pathOnly: true,
		});
		expect(toolAbsentSkip(cwd, { checker: pathOnly }).skipReason).toBe(
			"not-installed",
		);
		// An adopted root's checker skips the project rung (#4242).
		const noProjectRung = createAvailabilityChecker(
			"ruff",
			".exe",
			["--version"],
			{ allowProjectLocal: false },
		);
		expect(toolAbsentSkip(cwd, { checker: noProjectRung }).skipReason).toBe(
			"not-installed",
		);
	});

	it("reads a runner's own verdict and never the registry ladder beside it", () => {
		const cwd = plant(NODE_MODULES_BIN_DIRS[0], "htmlhint");
		setProjectTrustState("untrusted");
		restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
		const own = (
			outcome: AvailabilityVerdict["outcome"],
			cause: AvailabilityVerdict["cause"],
		) =>
			toolAbsentSkip(cwd, { id: "htmlhint", verdict: { outcome, cause } })
				.skipReason;
		expect(own("non-installable", "probe-rejected")).toBe("probe-rejected");
		expect(own("transient", "probe-timeout")).toBe("probe-incomplete");
		expect(own("missing", "policy-denied")).toBe("trust-refused");
		// The registry ladder would refuse the planted shim; the runner never used it.
		expect(own("missing", "not-found")).toBe("install-disabled");
		expect(
			toolAbsentSkip(cwd, { id: "htmlhint", verdict: null }).skipReason,
		).toBe("install-disabled");
	});

	it("reads a refusal from the runner's own lookup outside its checker", () => {
		expect(toolAbsentSkip(cwd, { trustRefused: true }).skipReason).toBe(
			"trust-refused",
		);
	});

	it.each([
		["missing", "not-found", "runtime-missing"],
		["transient", "probe-timeout", "probe-incomplete"],
		["non-installable", "probe-rejected", "probe-rejected"],
	] as const)(
		"reads a needed runtime's %s / %s verdict as %s",
		(outcome, cause, reason) => {
			expect(
				toolAbsentSkip(cwd, { checker: verdict(outcome, cause), runtime: true })
					.skipReason,
			).toBe(reason);
		},
	);

	// verify N4: vale and cue have a managed install but are never installed on
	// demand, so turning the switch off would not supply them.
	it("reads not-installed for vale and cue with the switch on", () => {
		restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
		for (const id of ["vale", "cue"])
			expect(toolAbsentSkip(cwd, { id }).skipReason).toBe("not-installed");
	});
});

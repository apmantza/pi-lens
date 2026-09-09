import { describe, expect, it } from "vitest";
import {
	buildInstallSmokeDriftBody,
	buildInstallSmokeDriftComment,
	decideAction,
	firstFailingStep,
	hasDrift,
	isCleanRun,
	isValidReport,
} from "../../scripts/lib/install-smoke-drift.mjs";

const cleanReport = {
	version: "0.86.0",
	steps: [
		{ name: "pin devDependency + install", outcome: "success" as const },
		{ name: "build:dist", outcome: "success" as const },
		{ name: "npm pack", outcome: "success" as const },
		{ name: "install tarball", outcome: "success" as const },
		{ name: "install-selftest", outcome: "success" as const },
	],
};

const failingReport = {
	version: "0.86.0",
	steps: [
		{ name: "pin devDependency + install", outcome: "success" as const },
		{ name: "build:dist", outcome: "failure" as const },
		{ name: "npm pack", outcome: "skipped" as const },
		{ name: "install tarball", outcome: "skipped" as const },
		{ name: "install-selftest", outcome: "skipped" as const },
	],
};

// The very first step (resolving @latest itself) failing, with everything
// after it consequently "skipped" -- this must NOT read as a clean run.
// Before the CLI included this step in its report, a total registry failure
// during resolution left every OTHER outcome "skipped" (never "failure"),
// so hasDrift() saw no failure at all and the nightly lane silently closed
// (or never opened) its tracker on the exact failure it exists to catch.
const resolveFailedReport = {
	version: "unknown",
	steps: [
		{ name: "resolve @latest", outcome: "failure" as const },
		{ name: "install deps (ci)", outcome: "skipped" as const },
		{ name: "build:dist", outcome: "skipped" as const },
	],
};

// Round-2 review F1 fixtures. Reviewer's own probe attacks, reproduced here
// as reports rather than through a spawned CLI + stubbed `gh` (that
// end-to-end reproduction lives in notify-install-smoke-drift.test.ts) --
// this file pins the DECISION, that file pins the WIRING to `gh`.

// Attack A: concurrency's cancel-in-progress interrupts a nightly MID-RUN --
// the step running at the moment of cancellation reads "cancelled", nothing
// after it ever ran ("skipped"), and everything before it kept its real
// (successful) outcome. No step is "failure".
const cancelledMidRunReport = {
	version: "0.86.0",
	steps: [
		{ name: "resolve @latest", outcome: "success" as const },
		{ name: "install deps (ci)", outcome: "cancelled" as const },
		{ name: "pin devDependency (no-save)", outcome: "skipped" as const },
		{ name: "download grammars", outcome: "skipped" as const },
		{ name: "build:dist", outcome: "skipped" as const },
		{ name: "npm pack", outcome: "skipped" as const },
		{ name: "install tarball", outcome: "skipped" as const },
		{ name: "install-selftest", outcome: "skipped" as const },
	],
};

// Attack B: cancelled before any step ran at all.
const cancelledBeforeStartReport = {
	version: "unknown",
	steps: [
		{ name: "resolve @latest", outcome: "cancelled" as const },
		{ name: "install deps (ci)", outcome: "skipped" as const },
		{ name: "pin devDependency (no-save)", outcome: "skipped" as const },
	],
};

// Attack C: the workflow step that invokes this script forgot to wire one
// (or all) of the outcome env vars -- a caller defect, not a run state.
const missingEnvReport = {
	version: "unknown",
	steps: [
		{ name: "resolve @latest", outcome: "" },
		{ name: "install deps (ci)", outcome: "" },
	],
};

describe("isCleanRun / isValidReport / decideAction (#2613 review F1)", () => {
	it("isCleanRun is true only when EVERY step succeeded", () => {
		expect(isCleanRun(cleanReport)).toBe(true);
		expect(isCleanRun(failingReport)).toBe(false);
		expect(isCleanRun(cancelledMidRunReport)).toBe(false);
		expect(isCleanRun(cancelledBeforeStartReport)).toBe(false);
	});

	it("isValidReport rejects any step whose outcome isn't one of the four real GitHub Actions values", () => {
		expect(isValidReport(cleanReport)).toBe(true);
		expect(isValidReport(cancelledMidRunReport)).toBe(true);
		expect(isValidReport(missingEnvReport)).toBe(false);
	});

	// The exact table the round-2 rail asked for, built from decideAction --
	// every (drift/clean/mixed/invalid) shape maps to exactly one action.
	it.each([
		["all success (clean)", cleanReport, "close-if-open"],
		["a real failure", failingReport, "file-or-refresh"],
		[
			"resolve itself failed, rest skipped",
			resolveFailedReport,
			"file-or-refresh",
		],
		["cancelled mid-run (attack A)", cancelledMidRunReport, "no-action"],
		[
			"cancelled before any step (attack B)",
			cancelledBeforeStartReport,
			"no-action",
		],
		["env vars missing (attack C)", missingEnvReport, "unknown"],
	] as const)("%s -> %s", (_label, report, expected) => {
		expect(decideAction(report)).toBe(expected);
	});

	// Mutation-proof, dangerous direction (round-1's actual bug): "not
	// hasDrift" is NOT a valid close condition -- reds every non-clean,
	// non-failing case that isCleanRun correctly excludes.
	it("mutation-proof: '!hasDrift' as the close condition wrongly admits both cancelled attacks", () => {
		const wronglyCloses = (report: {
			version: string;
			steps: { name: string; outcome: string }[];
		}) => !hasDrift(report);
		expect(wronglyCloses(cancelledMidRunReport)).toBe(true);
		expect(wronglyCloses(cancelledBeforeStartReport)).toBe(true);
		// The real condition correctly excludes both.
		expect(isCleanRun(cancelledMidRunReport)).toBe(false);
		expect(isCleanRun(cancelledBeforeStartReport)).toBe(false);
	});
});

describe("firstFailingStep / hasDrift (#2613)", () => {
	it("returns null and false for an all-success report", () => {
		expect(firstFailingStep(cleanReport)).toBeNull();
		expect(hasDrift(cleanReport)).toBe(false);
	});

	it("names the FIRST failing step and reports drift", () => {
		expect(firstFailingStep(failingReport)).toBe("build:dist");
		expect(hasDrift(failingReport)).toBe(true);
	});

	it("reports drift when only the FIRST step (resolve) failed and everything after it was skipped", () => {
		expect(firstFailingStep(resolveFailedReport)).toBe("resolve @latest");
		expect(hasDrift(resolveFailedReport)).toBe(true);
	});
});

describe("buildInstallSmokeDriftBody (#2613)", () => {
	it("names the installed version and the failing step", () => {
		const body = buildInstallSmokeDriftBody(failingReport);
		expect(body).toContain("@earendil-works/pi-coding-agent@0.86.0");
		expect(body).toContain("Installed version: **0.86.0**");
		expect(body).toContain("Failing step: **build:dist**");
		expect(body).toContain("| build:dist | failure |");
		expect(body).toContain("closed automatically once a nightly run");
	});

	it("includes the run link when provided", () => {
		const body = buildInstallSmokeDriftBody(failingReport, {
			runUrl: "https://example.test/run/1",
		});
		expect(body).toContain("Workflow run: https://example.test/run/1");
	});
});

describe("buildInstallSmokeDriftComment (#2613)", () => {
	it("names the installed version and failing step", () => {
		expect(buildInstallSmokeDriftComment(failingReport)).toBe(
			"Still failing: installed 0.86.0, failing step: build:dist.",
		);
	});
});

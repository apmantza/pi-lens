import { describe, expect, it } from "vitest";
import {
	spawnFailedWithNoOutput,
	spawnTimedOut,
} from "../../../../../clients/dispatch/runners/utils/spawn-outcome.js";
import type { SpawnResult } from "../../../../../clients/safe-spawn.js";

function spawnResult(partial: Partial<SpawnResult>): SpawnResult {
	return { stdout: "", stderr: "", status: 0, ...partial };
}

describe("spawnFailedWithNoOutput", () => {
	// The regression this exists for: safe-spawn resolves a normal exit with NO
	// `error` at any status, so a guard keyed only on `error` waves through the
	// unknown-subcommand / bad-flag / unloadable-config case and the runner
	// reports a clean file that the tool never looked at.
	it("is true for a nonzero exit with empty stdout and no spawn error", () => {
		expect(
			spawnFailedWithNoOutput(
				spawnResult({ status: 1, stderr: "unknown command" }),
			),
		).toBe(true);
	});

	it("is true for a spawn failure that produced nothing", () => {
		expect(
			spawnFailedWithNoOutput(
				spawnResult({
					status: null,
					error: new Error("Process timed out after 30000ms"),
					failure: "timeout",
				}),
			),
		).toBe(true);
	});

	it("is false for a clean exit, even with empty stdout", () => {
		expect(spawnFailedWithNoOutput(spawnResult({ status: 0 }))).toBe(false);
	});

	// Tools that exit nonzero *because* they found something must keep running
	// through the parser.
	it("is false when a nonzero exit carries findings on stdout", () => {
		expect(
			spawnFailedWithNoOutput(spawnResult({ status: 1, stdout: "[{}]" })),
		).toBe(false);
	});

	it("is true when a nonzero exit leaves only whitespace on stdout", () => {
		expect(
			spawnFailedWithNoOutput(spawnResult({ status: 1, stdout: "  \n" })),
		).toBe(true);
	});

	// Runners that parse stderr as well as stdout pass the string they are about
	// to parse, so "nothing to parse" means both streams.
	it("honors an explicit output string over stdout", () => {
		const result = spawnResult({ status: 1, stderr: "error: boom" });
		expect(
			spawnFailedWithNoOutput(result, `${result.stdout}${result.stderr}`),
		).toBe(false);
	});

	it("is true when the explicit output string is empty", () => {
		const result = spawnResult({ status: 1 });
		expect(
			spawnFailedWithNoOutput(result, `${result.stdout}${result.stderr}`),
		).toBe(true);
	});
});

// Recurrence (#5411): helm-lint, rust-clippy and helm-render each spelled the
// timeout test their own way and reported `failed/timeout` where the seam
// reports a skipped run. safe-spawn carries a timeout both as the legacy
// `failure` and as the typed `spawnFailure.kind`, and a runner must not need to
// know which one a given spawn path set.
describe("spawnTimedOut", () => {
	it.each([
		["the legacy failure alone", { failure: "timeout" }],
		["the typed kind alone", { spawnFailure: { kind: "timeout" } }],
	])("is true for %s", (_label, shape) => {
		expect(spawnTimedOut(shape)).toBe(true);
	});

	it.each([
		["an abort", { failure: "aborted", spawnFailure: { kind: "killed" } }],
		["a missing tool", { spawnFailure: { kind: "tool-not-found" } }],
		["a normal exit", {}],
	])("is false for %s", (_label, shape) => {
		expect(spawnTimedOut(shape)).toBe(false);
	});
});

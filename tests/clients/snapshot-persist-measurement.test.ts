/**
 * #3789 measured-constant pin (#3648): the claim "the worker persist no longer
 * clones the snapshot, and its RSS jump fell" rests on the raw before/after
 * output of `scripts/bench-snapshot-persist.mjs`, kept in
 * `tests/fixtures/snapshot-persist-measurement.json`. This file reads that
 * artifact; it never re-measures (a wall-clock or RSS assertion on a shared CI
 * runner would flake).
 *
 * Recurrences this prevents:
 *  - a hand-edited or stale artifact whose summary no longer follows from its
 *    own raw runs, so the PR body's numbers cite nothing;
 *  - the two trees measured on different inputs, which makes the ratio
 *    meaningless;
 *  - a later change that puts the clone (or the main-thread gzip) back: this
 *    file reads the committed artifact and cannot see the code, so it pins
 *    that artifact's provenance only, not the code; the behaviour tests in
 *    project-snapshot-persist-transfer.test.ts guard the code itself.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- bare-node script, no declaration file
import { buildSyntheticSnapshot } from "../../scripts/bench-snapshot-persist.mjs";

interface Run {
	persist: number;
	syncCallMs: number;
	maxEventLoopStallMs: number;
	persistWallMs: number;
	rssJumpMB: number;
}
interface Result {
	mode: "worker" | "sync";
	fileCount: number;
	rawBytes: number;
	runs: Run[];
	summary: {
		steadyPersists: number;
		medianMaxEventLoopStallMs: number;
		medianRssJumpMB: number;
		maxRssJumpMB: number;
	};
}
interface Round {
	label: string;
	command: string;
	results: Result[];
}
interface Artifact {
	schemaVersion: number;
	rounds: { before: Round[]; after: Round[] };
}

const artifact = JSON.parse(
	readFileSync(
		resolve(
			import.meta.dirname,
			"../fixtures/snapshot-persist-measurement.json",
		),
		"utf-8",
	),
) as Artifact;

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const resultOf = (round: Round, mode: "worker" | "sync") => {
	const found = round.results.find((result) => result.mode === mode);
	if (!found) throw new Error(`round ${round.label} has no ${mode} result`);
	return found;
};
const steady = (result: Result) => result.runs.filter((run) => run.persist > 0);

describe("snapshot persist measurement artifact (#3789)", () => {
	it("holds three alternating rounds per tree from one command on one input", () => {
		expect(artifact.schemaVersion).toBe(1);
		for (const tree of ["before", "after"] as const) {
			expect(artifact.rounds[tree]).toHaveLength(3);
			for (const round of artifact.rounds[tree]) {
				expect(round.label).toBe(tree);
				expect(round.command).toBe(
					"node scripts/bench-snapshot-persist.mjs --modes worker,sync --files 11500 --persists 5",
				);
				expect(round.results.map((result) => result.mode)).toEqual([
					"worker",
					"sync",
				]);
			}
		}
		// Same input: the generator is seeded, so every round serializes the same
		// worker-mode bytes, in both trees.
		const rawBytes = new Set(
			[...artifact.rounds.before, ...artifact.rounds.after].map(
				(round) => resultOf(round, "worker").rawBytes,
			),
		);
		expect(rawBytes.size).toBe(1);
		expect([...rawBytes][0]).toBeGreaterThan(66_000_000);
		expect([...rawBytes][0]).toBeLessThan(70_000_000);
	});

	it("builds the same synthetic snapshot every time", () => {
		const first = JSON.stringify(buildSyntheticSnapshot(40, "/p"));
		expect(JSON.stringify(buildSyntheticSnapshot(40, "/p"))).toBe(first);
		expect(Buffer.byteLength(first)).toBe(116_644);
	});

	it("derives every committed summary from its own raw runs", () => {
		for (const round of [...artifact.rounds.before, ...artifact.rounds.after]) {
			for (const result of round.results) {
				const runs = steady(result);
				expect(result.summary.steadyPersists).toBe(5);
				expect(runs).toHaveLength(5);
				expect(result.summary.medianRssJumpMB).toBeCloseTo(
					median(runs.map((run) => run.rssJumpMB)),
					1,
				);
				expect(result.summary.maxRssJumpMB).toBeCloseTo(
					Math.max(...runs.map((run) => run.rssJumpMB)),
					1,
				);
				expect(result.summary.medianMaxEventLoopStallMs).toBeCloseTo(
					median(runs.map((run) => run.maxEventLoopStallMs)),
					1,
				);
			}
		}
	});

	it("shows the worker RSS jump at most half the cloned one in every round", () => {
		const peaks = (rounds: Round[]) =>
			rounds.map((round) => resultOf(round, "worker").summary.maxRssJumpMB);
		const before = peaks(artifact.rounds.before);
		const after = peaks(artifact.rounds.after);
		for (const [index, afterPeak] of after.entries()) {
			expect(afterPeak).toBeLessThanOrEqual(before[index] * 0.5);
		}
		// The issue's acceptance: the worker path lands near the sync path (about
		// 300 MB against 800 MB in the field; here within 1.5x of sync's peak).
		for (const round of artifact.rounds.after) {
			expect(resultOf(round, "worker").summary.maxRssJumpMB).toBeLessThan(
				resultOf(round, "sync").summary.maxRssJumpMB * 1.5,
			);
		}
	});

	it("keeps the worker's main-thread stall a fraction of the synchronous path's", () => {
		for (const round of artifact.rounds.after) {
			const worker = resultOf(round, "worker").summary;
			const sync = resultOf(round, "sync").summary;
			expect(worker.medianMaxEventLoopStallMs).toBeLessThan(
				sync.medianMaxEventLoopStallMs / 3,
			);
		}
	});
});

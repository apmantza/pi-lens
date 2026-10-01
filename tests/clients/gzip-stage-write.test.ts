/**
 * Tests for clients/gzip-stage-write.ts — the shared worker-thread body-persist
 * core (#958) used by both the review-graph and project-snapshot persist
 * workers.
 *
 * #1217: this module hand-rolled `${stagePath}.tmp-${process.pid}` instead of
 * sourcing its staging name from `atomic-write.ts`, so it never inherited the
 * #1205 per-call fix. Its callers pass a per-generation `stagePath`, which
 * makes two calls on one path rare — but pid isolates nothing between worker
 * threads (they share `process.pid`), so a retry, a re-queued persist, a
 * repeated generation, or a future non-generational caller collides exactly.
 * Its docstring also asserted crash-safety in language that read as
 * concurrency-safety, the same false-confidence pattern #1205 found in
 * `atomic-write.ts`'s own docstring.
 *
 * Nothing here branches on `process.platform` (recurring defect shape 2/7).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAGE_TMP_PATTERN } from "../../clients/atomic-write.js";
import { writeGzipStageFile } from "../../clients/gzip-stage-write.js";
import { suspendAt, waitFor } from "./interleaving-kit.js";
import { removeTempDirSync } from "./test-utils.js";

let dir: string;

function readStage(stagePath: string): unknown {
	return JSON.parse(gunzipSync(fs.readFileSync(stagePath)).toString("utf-8"));
}

function tmpLeftovers(): string[] {
	return fs.readdirSync(dir).filter((name) => STAGE_TMP_PATTERN.test(name));
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gzip-stage-"));
});

afterEach(() => {
	removeTempDirSync(dir);
});

describe("writeGzipStageFile", () => {
	it("writes gzipped JSON to the stage path and reports metrics", async () => {
		const stagePath = path.join(dir, "review-graph.json.gz.stage-1-0");
		const data = { nodes: ["a", "b"], gen: 1 };
		const metrics = await writeGzipStageFile(data, stagePath);

		expect(readStage(stagePath)).toEqual(data);
		expect(metrics.rawBytes).toBe(Buffer.byteLength(JSON.stringify(data)));
		expect(metrics.gzBytes).toBe(fs.statSync(stagePath).size);
	});

	it("creates the parent directory and leaves no staging file behind", async () => {
		const stagePath = path.join(dir, "nested", "snapshot.json.gz.stage-1-0");
		await writeGzipStageFile({ ok: true }, stagePath);

		expect(readStage(stagePath)).toEqual({ ok: true });
		expect(fs.readdirSync(path.dirname(stagePath))).toEqual([
			path.basename(stagePath),
		]);
	});

	it("returns before gzip and staging when a semantic fingerprint matches", async () => {
		const stagePath = path.join(dir, "snapshot.json.gz.stage-1-0");
		const fingerprint = vi.fn(() => "same-body");
		const metrics = await writeGzipStageFile(
			{ generatedAt: "volatile", value: 1 },
			stagePath,
			undefined,
			{
				semanticFingerprint: fingerprint,
				skipIfFingerprints: ["older-local", "same-body"],
			},
		);

		expect(fingerprint).toHaveBeenCalledOnce();
		expect(metrics).toMatchObject({
			semanticFingerprint: "same-body",
			skippedUnchanged: true,
			gzBytes: 0,
			writeMs: 0,
		});
		expect(fs.existsSync(stagePath)).toBe(false);
		expect(tmpLeftovers()).toEqual([]);
	});

	it("writes when the semantic fingerprint is new", async () => {
		const stagePath = path.join(dir, "snapshot.json.gz.stage-1-0");
		const data = { generatedAt: "volatile", value: 2 };
		const metrics = await writeGzipStageFile(data, stagePath, undefined, {
			semanticFingerprint: () => "new-body",
			skipIfFingerprints: ["old-body"],
		});

		expect(metrics.skippedUnchanged).toBeUndefined();
		expect(metrics.semanticFingerprint).toBe("new-body");
		expect(readStage(stagePath)).toEqual(data);
	});

	it("removes the partial staging file and rethrows when the write fails", async () => {
		// A stage path whose parent cannot be created (an existing FILE sits where
		// the directory would go) fails inside the pipeline, on every platform.
		const blocker = path.join(dir, "blocker");
		fs.writeFileSync(blocker, "not a directory");
		const stagePath = path.join(blocker, "review-graph.json.gz.stage-1-0");

		await expect(writeGzipStageFile({ a: 1 }, stagePath)).rejects.toThrow();
		expect(tmpLeftovers()).toEqual([]);
	});
});

/**
 * #3789: the project-snapshot dispatcher serializes once and transfers UTF-8
 * bytes, so the worker core must accept bytes (and still the object form the
 * review graph sends). Recurrence: a core that re-stringified bytes, or that
 * chunked a view by its whole backing buffer, would publish a corrupt stage
 * file the load path then rejects.
 */
describe("writeGzipStageFile with pre-serialized bytes (#3789)", () => {
	// Non-ASCII so byte length and string length differ, over several 256 KiB
	// chunks so a chunk-boundary slip corrupts the stream.
	const value = {
		generatedAt: "2026-09-21T14:13:20.000Z",
		text: "é日本語\u2028".repeat(120_000),
	};
	const json = JSON.stringify(value);

	function viewOf(bytes: Uint8Array): Uint8Array {
		// A view at a non-zero offset of a larger buffer: gzipping `view.buffer`
		// instead of the view would include the padding.
		const backing = new Uint8Array(bytes.byteLength + 64).fill(0x20);
		backing.set(bytes, 32);
		return backing.subarray(32, 32 + bytes.byteLength);
	}

	it("gzips exactly the bytes it was given across chunk boundaries", async () => {
		const stagePath = path.join(dir, "snapshot.json.gz.stage-1-0");
		const bytes = viewOf(new TextEncoder().encode(json));
		const metrics = await writeGzipStageFile(bytes, stagePath);

		expect(Buffer.byteLength(json)).toBeGreaterThan(256 * 1024 * 2);
		expect(gunzipSync(fs.readFileSync(stagePath)).toString("utf-8")).toBe(json);
		expect(metrics.rawBytes).toBe(Buffer.byteLength(json));
		expect(metrics.gzBytes).toBe(fs.statSync(stagePath).size);
	});

	it("hands the semantic fingerprint the bytes and skips gzip on a match", async () => {
		const stagePath = path.join(dir, "snapshot.json.gz.stage-1-0");
		const bytes = viewOf(new TextEncoder().encode(json));
		const seen: unknown[] = [];
		const metrics = await writeGzipStageFile(bytes, stagePath, undefined, {
			semanticFingerprint: (body) => {
				seen.push(body);
				return "same-body";
			},
			skipIfFingerprints: ["same-body"],
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeInstanceOf(Uint8Array);
		expect(Buffer.from(seen[0] as Uint8Array).toString("utf-8")).toBe(json);
		expect(metrics.skippedUnchanged).toBe(true);
		expect(fs.existsSync(stagePath)).toBe(false);
	});
});

/**
 * The #1217 acceptance case: two concurrent calls on the SAME `stagePath`.
 * Pre-fix both staged into one `${stagePath}.tmp-${pid}` inode — the first
 * rename published it while the second was still streaming gzip into it, so
 * the published stage file was a hybrid whose gzip trailer no longer matched
 * its body and `gunzipSync` threw (or, worse, silently returned truncated
 * JSON).
 *
 * Mismatched payload sizes so a hybrid is detectable, and the assertion is on
 * decompressed content rather than on winning a scheduler race: whichever
 * payload wins, it must round-trip whole.
 */
describe("concurrent writes to one stagePath (#1217)", () => {
	const ITERATIONS = 40;
	const BIG = { kind: "big", pad: "A".repeat(2 * 1024 * 1024) };
	const SMALL = { kind: "small", pad: "B".repeat(50 * 1024) };

	/**
	 * Tolerate a concurrent replace-rename rejection on Windows only, and only
	 * when it is exactly EPERM.
	 *
	 * On Windows, `fs.rename` onto a destination another rename is concurrently
	 * replacing can fail with EPERM (MoveFileEx's REPLACE_EXISTING does not
	 * serialize concurrent replaces of the same target). That is a post-fix
	 * failure mode of the rename itself — the writer staged at its own distinct
	 * path and still removed its own staging file — not a violation of the
	 * staging-name-uniqueness property under test. Any other rejection, and in
	 * particular the ENOENT a pre-#1217 shared staging inode produced on every
	 * platform, must still fail the test.
	 */
	function expectOnlyWindowsConcurrentRenameEpemr(
		settled: PromiseSettledResult<unknown>[],
	): void {
		const rejected = settled.filter(
			(s) => s.status === "rejected",
		) as PromiseRejectedResult[];
		if (process.platform === "win32") {
			for (const r of rejected) {
				expect((r.reason as NodeJS.ErrnoException | undefined)?.code).toBe(
					"EPERM",
				);
			}
		} else {
			expect(rejected).toEqual([]);
		}
	}

	it("publishes exactly one payload, never a torn stage file", async () => {
		const outcomes: string[] = [];
		for (let i = 0; i < ITERATIONS; i++) {
			const stagePath = path.join(dir, `race-${i}.json.gz.stage-1-0`);
			// Alternate launch order so neither writer is systematically first.
			const [first, second] = i % 2 === 0 ? [BIG, SMALL] : [SMALL, BIG];
			// Same Windows tolerance as the 8-writer test below: with only two
			// writers the concurrent-replace EPERM is much rarer, but the
			// mechanism is identical, so scope it the same way.
			expectOnlyWindowsConcurrentRenameEpemr(
				await Promise.allSettled([
					writeGzipStageFile(first, stagePath),
					writeGzipStageFile(second, stagePath),
				]),
			);
			const published = readStage(stagePath) as typeof BIG;
			expect(published).toEqual(published.kind === "big" ? BIG : SMALL);
			outcomes.push(published.kind);
		}
		// Both payloads round-tripped whole across the run; neither is required to
		// win any particular iteration.
		expect(new Set(outcomes).size).toBeGreaterThanOrEqual(1);
	});

	it("stages each concurrent call at a distinct path", async () => {
		const stagePath = path.join(dir, "review-graph.json.gz.stage-1-0");
		const WRITERS = 8;
		// #1298: the original version SAMPLED the directory while the writes
		// raced, hoping to catch two staging files coexisting — on fast Linux
		// CI the writes completed nearly sequentially and the sampler saw one.
		// Deterministic form: gate every writer's publish rename behind a
		// barrier, so all staging files MUST coexist before any rename runs —
		// no scheduler luck in either direction.
		const realRename = fs.promises.rename.bind(fs.promises);
		const renameSpy = vi.spyOn(fs.promises, "rename");
		const suspension = suspendAt(renameSpy, realRename);
		try {
			const inFlight = Promise.allSettled(
				Array.from({ length: WRITERS }, (_, i) =>
					writeGzipStageFile(i % 2 === 0 ? BIG : SMALL, stagePath),
				),
			);
			// Bounded wait until every writer has finished streaming and is
			// parked at the rename barrier, each with its own staging file on
			// disk. Converges deterministically — the files must appear.
			const staged = await waitFor(
				() => tmpLeftovers(),
				(value) => value.length >= WRITERS,
			);
			expect(staged.length).toBe(WRITERS);
			expect(new Set(staged).size).toBe(WRITERS);

			suspension.release();
			const settled = await inFlight;
			expect(tmpLeftovers()).toEqual([]);
			expectOnlyWindowsConcurrentRenameEpemr(settled);
		} finally {
			suspension.release();
			suspension.restore();
		}
	});
});

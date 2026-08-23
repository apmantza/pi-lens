import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendProjectChange,
	getProjectChangeLogPath,
	getSequenceFoldCountForTests,
	type ProjectSequenceBase,
	type ProjectSequenceIndex,
	readChangesSince,
	readLatestProjectSequence,
	resetSequenceFoldCountForTests,
} from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("project change sequence", () => {
	it("bumps project and file sequences independently", () => {
		const runtime = new RuntimeCoordinator();
		const first = runtime.bumpFileSeq("src/a.ts");
		const second = runtime.bumpFileSeq("src/a.ts");
		const third = runtime.bumpFileSeq("src/b.ts");

		// bumpFileSeq returns the normalized key it recorded under (#2000
		// phase 1) so callers reuse it instead of paying realpath twice.
		expect(first.projectSeq).toBe(1);
		expect(first.fileSeq).toBe(1);
		expect(first.key).toBe(normalizeMapKey(path.resolve("src/a.ts")));
		expect(second).toMatchObject({ projectSeq: 2, fileSeq: 2 });
		expect(third).toMatchObject({ projectSeq: 3, fileSeq: 1 });
		expect(runtime.projectSeq).toBe(3);
		expect(runtime.getFileSeq("src/a.ts")).toBe(2);
		expect(runtime.getFileSeq("src/b.ts")).toBe(1);
	});

	it("persists append-only changes and reads changes since a sequence", () => {
		const env = setupTestEnvironment("project-changes-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			const firstFile = path.join(cwd, "src", "a.ts");
			const secondFile = path.join(cwd, "src", "b.ts");

			appendProjectChange(cwd, {
				seq: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				sessionId: "s1",
				turnIndex: 1,
				source: "agent-edit",
				filePath: firstFile,
				fileSeq: 1,
				changedRange: { start: 3, end: 5 },
			});
			appendProjectChange(cwd, {
				seq: 2,
				timestamp: "2026-01-01T00:00:01.000Z",
				sessionId: "s1",
				turnIndex: 1,
				source: "format",
				filePath: firstFile,
				fileSeq: 2,
			});
			appendProjectChange(cwd, {
				seq: 3,
				timestamp: "2026-01-01T00:00:02.000Z",
				sessionId: "s2",
				turnIndex: 1,
				source: "agent-write",
				filePath: secondFile,
				fileSeq: 1,
			});

			expect(getProjectChangeLogPath(cwd)).toContain("change-log.jsonl");
			expect(readChangesSince(cwd, 1).map((entry) => entry.seq)).toEqual([
				2, 3,
			]);
			const latest = readLatestProjectSequence(cwd);
			expect(latest.projectSeq).toBe(3);
			expect(latest.fileSeqByPath.get(firstFile.replace(/\\/g, "/"))).toBe(2);
			expect(latest.fileSeqByPath.get(secondFile.replace(/\\/g, "/"))).toBe(1);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});
});

// #1019: the snapshot-bounded partial replay MUST be byte-identical to a full
// replay for the same log state, and must fall back to a full replay for
// legacy/ahead/missing bases. These tests are the primary correctness proof —
// the partial path runs on the interactive session-start critical path.
describe("readLatestProjectSequence partial replay (#1019)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let previousDataDir: string | undefined;
	let cwd: string;

	// OS-agnostic file paths under the isolated tmp dir; assertions never bake in
	// a separator (keys are compared structurally as whole strings).
	const fileA = () => path.join(cwd, "src", "a.ts");
	const fileB = () => path.join(cwd, "src", "b.ts");
	const fileC = () => path.join(cwd, "src", "nested", "c.ts");

	function append(
		seq: number,
		filePath: string,
		fileSeq: number,
		source: "agent-edit" | "external" | "format" = "agent-edit",
	): void {
		appendProjectChange(cwd, {
			seq,
			timestamp: new Date(seq * 1000).toISOString(),
			sessionId: "s",
			turnIndex: 0,
			source,
			filePath,
			fileSeq,
		});
	}

	/** Structural, order-independent view for equality assertions. */
	function shape(index: ProjectSequenceIndex): {
		projectSeq: number;
		files: Array<[string, number]>;
	} {
		return {
			projectSeq: index.projectSeq,
			files: [...index.fileSeqByPath.entries()].sort((a, b) =>
				a[0].localeCompare(b[0]),
			),
		};
	}

	/**
	 * Build a base exactly as production would: the derived index of the log AS
	 * OF seq `sinceSeq`. We read the log after appending only the entries up to
	 * `sinceSeq`, which is precisely what the runtime holds (and stamps into the
	 * snapshot) at that seq.
	 */
	function baseAsOf(sinceSeq: number): ProjectSequenceBase {
		const idx = readLatestProjectSequence(cwd);
		return {
			projectSeq: idx.projectSeq,
			fileSeqByPath: [...idx.fileSeqByPath.entries()],
			sinceSeq,
		};
	}

	beforeEach(() => {
		env = setupTestEnvironment("project-changes-partial-");
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		cwd = path.join(env.tmpDir, "project");
	});

	afterEach(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		env.cleanup();
	});

	it("no new entries since S: partial == full (both == base)", () => {
		append(1, fileA(), 1);
		append(2, fileA(), 2);
		append(3, fileB(), 1);
		const base = baseAsOf(3);

		const full = readLatestProjectSequence(cwd);
		const partial = readLatestProjectSequence(cwd, base);
		expect(shape(partial)).toEqual(shape(full));
		expect(partial.projectSeq).toBe(3);
	});

	it("new entries for new + existing files: partial == full", () => {
		append(1, fileA(), 1);
		append(2, fileB(), 1);
		const base = baseAsOf(2);
		// existing file bumped + a brand-new file appears after S
		append(3, fileA(), 2);
		append(4, fileC(), 1);

		const full = readLatestProjectSequence(cwd);
		const partial = readLatestProjectSequence(cwd, base);
		expect(shape(partial)).toEqual(shape(full));
		expect(partial.projectSeq).toBe(4);
	});

	it("a file deleted/last-touched since S: partial == full", () => {
		append(1, fileA(), 1);
		append(2, fileB(), 1);
		append(3, fileC(), 1);
		const base = baseAsOf(3);
		// a later 'external' delete-style change bumps fileB's seq; the fold keeps
		// the max, so the key persists — partial must reproduce that exactly.
		append(4, fileB(), 2, "external");

		const full = readLatestProjectSequence(cwd);
		const partial = readLatestProjectSequence(cwd, base);
		expect(shape(partial)).toEqual(shape(full));
		expect(partial.projectSeq).toBe(4);
	});

	it("empty log: partial (base at seq 0) == full == empty", () => {
		const base: ProjectSequenceBase = {
			projectSeq: 0,
			fileSeqByPath: [],
			sinceSeq: 0,
		};
		const full = readLatestProjectSequence(cwd);
		const partial = readLatestProjectSequence(cwd, base);
		expect(shape(full)).toEqual({ projectSeq: 0, files: [] });
		expect(shape(partial)).toEqual(shape(full));
	});

	it("gaps / out-of-order entries after S: partial == full", () => {
		append(1, fileA(), 1);
		append(3, fileB(), 1); // gap: no seq 2
		const base = baseAsOf(3);
		// deliberately append out of seq order, and with a gap
		append(6, fileC(), 1);
		append(5, fileA(), 2);

		const full = readLatestProjectSequence(cwd);
		const partial = readLatestProjectSequence(cwd, base);
		expect(shape(partial)).toEqual(shape(full));
		expect(partial.projectSeq).toBe(6);
	});

	it("legacy snapshot (no base) folds the full log", () => {
		append(1, fileA(), 1);
		append(2, fileB(), 1);
		const full = readLatestProjectSequence(cwd);
		// undefined base is the legacy path — identical to a full replay.
		const legacy = readLatestProjectSequence(cwd, undefined);
		expect(shape(legacy)).toEqual(shape(full));
		expect(legacy.projectSeq).toBe(2);
	});

	it("snapshot seq AHEAD of log: falls back to full replay (never serves the stale seq)", () => {
		append(1, fileA(), 1);
		append(2, fileB(), 1);
		// A base whose sinceSeq is beyond the log's max seq (log truncated/rotated
		// below the snapshot, or snapshot ahead). Its bogus contents must be
		// ignored in favor of the real log.
		const aheadBase: ProjectSequenceBase = {
			projectSeq: 99,
			fileSeqByPath: [["/bogus/ghost.ts", 42]],
			sinceSeq: 99,
		};
		const full = readLatestProjectSequence(cwd);
		const guarded = readLatestProjectSequence(cwd, aheadBase);
		expect(shape(guarded)).toEqual(shape(full));
		expect(guarded.projectSeq).toBe(2);
		expect(
			[...guarded.fileSeqByPath.keys()].some((k) => k.includes("ghost")),
		).toBe(false);
	});

	it("bounds the work: partial folds strictly FEWER entries than full", () => {
		for (let seq = 1; seq <= 18; seq++) {
			append(seq, seq % 2 === 0 ? fileA() : fileB(), Math.ceil(seq / 2));
		}
		const base = baseAsOf(18);
		append(19, fileA(), 10);
		append(20, fileC(), 1);

		resetSequenceFoldCountForTests();
		readLatestProjectSequence(cwd);
		const fullFolds = getSequenceFoldCountForTests();

		resetSequenceFoldCountForTests();
		readLatestProjectSequence(cwd, base);
		const partialFolds = getSequenceFoldCountForTests();

		// full replays every entry (20); partial folds only the 2 with seq > 18.
		expect(fullFolds).toBe(20);
		expect(partialFolds).toBe(2);
		expect(partialFolds).toBeLessThan(fullFolds);
	});
});

// flake-shape: real-process-spawn — the sibling writer must be a second real
// process with its own pid: the stage-sweep liveness check (#3510) keys on a
// pid, and a second module instance in this process shares ours; the cache
// lock (#3509) orders writers that share nothing but the disk.
/**
 * Cross-process persist of the project snapshot, replayed from the
 * `formal/snapshot-promotion/` counterexamples. The parent process is one
 * writer, parked at `setProjectSnapshotPromotionSeamForTests` with its body
 * staged; a real child `node` process is the sibling writer (a pi session
 * and the MCP server's word-index writer share one project cache dir).
 *
 * Probe hygiene: `PILENS_DATA_DIR` points at a per-test temp dir, and the
 * child's `PI_LENS_HOME` at another; the real home is never touched.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const latencyRows = vi.hoisted(
	() => [] as Array<{ phase?: string; metadata?: Record<string, unknown> }>,
);
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Parameters<typeof actual.logLatency>[0]) => {
			latencyRows.push(entry as (typeof latencyRows)[number]);
			actual.logLatency(entry);
		},
	};
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	releaseGeneration,
	tryAcquireGeneration,
} from "../../clients/generation-lock.js";
import {
	_resetProjectSnapshotParseCacheForTests,
	getProjectSnapshotMetaPath,
	getProjectSnapshotPath,
	getProjectSnapshotPersistErrorForTests,
	getProjectSnapshotPersistStateForTests,
	isProjectSnapshotFresh,
	loadProjectSnapshot,
	readProjectSnapshotMeta,
	resetProjectSnapshotPersistWorkerForTests,
	saveRuntimeProjectSnapshot,
	saveProjectSnapshot,
	buildProjectSnapshotFromRuntime,
	setProjectSnapshotPromotionSeamForTests,
	terminateProjectSnapshotPersistWorkerForTests,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import {
	appendProjectChange,
	getProjectChangeLogPath,
	readLatestProjectSequence,
	readProjectChanges,
} from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { suspendAt } from "./interleaving-kit.js";
import { setupTestEnvironment } from "./test-utils.js";

const clientsDir = path.resolve(__dirname, "../../clients");
const snapshotJs = path.join(clientsDir, "project-snapshot.js");
const runtimeJs = path.join(clientsDir, "runtime-coordinator.js");

const envBefore = { ...process.env };
afterEach(async () => {
	setProjectSnapshotPromotionSeamForTests(undefined);
	await waitForProjectSnapshotPersistsForTests();
	await terminateProjectSnapshotPersistWorkerForTests();
	resetProjectSnapshotPersistWorkerForTests();
	_resetProjectSnapshotParseCacheForTests();
	resetDegradationLedger();
	latencyRows.length = 0;
	process.env = { ...envBefore };
});

function snapshotAt(cwd: string, seq: number, marker: string) {
	const runtime = new RuntimeCoordinator();
	runtime.seedProjectSequence(seq);
	runtime.cachedExports.set(marker, path.join(cwd, `${marker}.ts`));
	return buildProjectSnapshotFromRuntime({ cwd, runtime });
}

/**
 * Run `body` in a real sibling `node` process that has `snap` (the built
 * project-snapshot module) and a fresh `runtime` seeded at `seed`. It
 * prints its pid and its runtime's projectSeq when done.
 */
function runSibling(
	home: string,
	seed: number,
	body: string,
): { pid: number; seq: number } {
	const script = `
		const snap = await import(${JSON.stringify(snapshotJs)});
		const rt = await import(${JSON.stringify(runtimeJs)});
		const runtime = new rt.RuntimeCoordinator();
		runtime.seedProjectSequence(${seed});
		${body}
		console.log(JSON.stringify({ pid: process.pid, seq: runtime.projectSeq }));
	`;
	const child = spawnSync(
		process.execPath,
		["--input-type=module", "-e", script],
		{
			env: {
				...process.env,
				PI_LENS_HOME: home,
				PI_LENS_SNAPSHOT_PERSIST_SYNC: "1",
			},
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	expect(child.status, child.stderr).toBe(0);
	return JSON.parse(child.stdout.trim()) as { pid: number; seq: number };
}

/** One synchronous snapshot save in a real sibling process; returns its pid. */
function siblingSave(
	home: string,
	cwd: string,
	seq: number,
	marker: string,
): number {
	return runSibling(
		home,
		seq,
		`runtime.cachedExports.set(${JSON.stringify(marker)}, "x.ts");
		const cwd = ${JSON.stringify(cwd)};
		snap.saveProjectSnapshot(cwd, snap.buildProjectSnapshotFromRuntime({ cwd, runtime }));`,
	).pid;
}

/**
 * One logged edit in a real sibling process whose session started when the
 * log's max seq was `seed`; returns the seq it logged.
 */
function siblingEdit(
	home: string,
	cwd: string,
	seed: number,
	filePath: string,
): number {
	return runSibling(
		home,
		seed,
		`runtime.recordProjectMutation({ filePath: ${JSON.stringify(filePath)}, source: "agent-write", cwd: ${JSON.stringify(cwd)} });`,
	).seq;
}

/** One logged edit then one runtime snapshot save in a real sibling process. */
function siblingEditAndSave(
	home: string,
	cwd: string,
	seed: number,
	filePath: string,
	marker: string,
): number {
	return runSibling(
		home,
		seed,
		`const cwd = ${JSON.stringify(cwd)};
		runtime.recordProjectMutation({ filePath: ${JSON.stringify(filePath)}, source: "agent-write", cwd });
		runtime.cachedExports.set(${JSON.stringify(marker)}, "x.ts");
		snap.saveRuntimeProjectSnapshot({ cwd, runtime });`,
	).seq;
}

/** Code-unit order on the path key, so equal maps compare equal. */
function byPathKey(a: [string, number], b: [string, number]): number {
	if (a[0] < b[0]) return -1;
	return a[0] > b[0] ? 1 : 0;
}

/** What a later session_start sees: the log, the snapshot, and both replays. */
function sessionStartView(cwd: string) {
	_resetProjectSnapshotParseCacheForTests();
	const full = readLatestProjectSequence(cwd);
	const snapshot = loadProjectSnapshot(cwd);
	// The bounded-replay base, built the way runtime-session.ts's
	// snapshotSequenceBase builds it from the meta sidecar.
	const meta = readProjectSnapshotMeta(cwd);
	const bounded = readLatestProjectSequence(
		cwd,
		meta?.sequenceIndex
			? {
					projectSeq: meta.sequenceIndex.projectSeq,
					fileSeqByPath: meta.sequenceIndex.fileSeqByPath,
					sinceSeq: meta.seq,
					logEntries: meta.logEntries,
				}
			: undefined,
	);
	return {
		log: readProjectChanges(cwd).map((entry) => [
			entry.seq,
			path.basename(entry.filePath),
		]),
		fresh: isProjectSnapshotFresh(
			snapshot,
			full.projectSeq,
			full.unlockedThrough,
		),
		boundedEqualsFull:
			JSON.stringify([...bounded.fileSeqByPath].sort(byPathKey)) ===
			JSON.stringify([...full.fileSeqByPath].sort(byPathKey)),
	};
}

/** A runtime of THIS process, seeded the way session_start seeds it. */
function seededRuntime(cwd: string): RuntimeCoordinator {
	const latest = readLatestProjectSequence(cwd);
	const runtime = new RuntimeCoordinator();
	runtime.seedProjectSequence(
		latest.projectSeq,
		latest.fileSeqByPath,
		latest.logEntries,
	);
	return runtime;
}

function readDisk(cwd: string) {
	const body = JSON.parse(
		gunzipSync(fs.readFileSync(getProjectSnapshotPath(cwd))).toString(),
	) as {
		seq: number;
		incompleteSeq?: number;
		cachedExports: Array<[string, string]>;
	};
	const meta = JSON.parse(
		fs.readFileSync(getProjectSnapshotMetaPath(cwd), "utf8"),
	) as { seq: number; incompleteSeq?: number };
	// The seq as this version decodes it: an incomplete snapshot stores its
	// real seq beside the legacy field (review round 2, R2-F2).
	return {
		bodySeq: body.incompleteSeq ?? body.seq,
		bodyExports: body.cachedExports.map((entry) => entry[0]),
		metaSeq: meta.incompleteSeq ?? meta.seq,
	};
}

/**
 * Run `sibling` inside a runtime of this process's change-log critical
 * section, just before its line is appended: the sibling finds the lock held,
 * waits out the 500 ms wait and appends unlocked, having read the log before
 * our line landed. That is a lock holder slower than the wait (review round
 * 2, R2-F1: a first allocation that reads a large log whole). The hook fires
 * once, at the node:fs seam.
 */
function beforeNextChangeLogAppend(cwd: string, sibling: () => void) {
	const logPath = getProjectChangeLogPath(cwd);
	const realAppend = nodeFs.appendFileSync;
	let armed = true;
	nodeFs.appendFileSync = ((...args: Parameters<typeof realAppend>) => {
		if (armed && String(args[0]) === logPath) {
			armed = false;
			sibling();
		}
		return realAppend(...args);
	}) as typeof realAppend;
	syncBuiltinESMExports();
	return () => {
		nodeFs.appendFileSync = realAppend;
		syncBuiltinESMExports();
	};
}

function stageFiles(cwd: string): string[] {
	return fs
		.readdirSync(path.dirname(getProjectSnapshotPath(cwd)))
		.filter((name) => name.includes(".stage-"))
		.sort();
}

/** A pid the OS reports gone (ESRCH), probed rather than assumed. */
function findDeadPid(): number {
	for (let candidate = 999_983; candidate > 1000; candidate -= 7919) {
		try {
			process.kill(candidate, 0);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") return candidate;
		}
	}
	throw new Error("could not find a dead pid to test with");
}

function projectEnv() {
	const env = setupTestEnvironment("snapshot-xproc-");
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
	const cwd = path.join(env.tmpDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	return { env, cwd, home: path.join(env.tmpDir, "home") };
}

describe("project snapshot persist across processes", () => {
	it("a sibling's first-save sweep keeps a live process's staged body and removes a dead one's (#3510)", async () => {
		const { env, cwd, home } = projectEnv();
		const seam = vi.fn();
		const suspension = suspendAt(seam, async () => {}, { calls: 1 });
		try {
			setProjectSnapshotPromotionSeamForTests(async () => {
				await seam();
			});
			saveProjectSnapshot(cwd, snapshotAt(cwd, 5, "parent_seq5"));
			await suspension.admitted; // the worker staged; promotion is parked
			const [liveStage] = stageFiles(cwd);
			expect(liveStage).toBe(`project-snapshot.json.gz.stage-${process.pid}-1`);
			const deadStage = path.join(
				path.dirname(getProjectSnapshotPath(cwd)),
				`project-snapshot.json.gz.stage-${findDeadPid()}-1`,
			);
			fs.writeFileSync(deadStage, "left by a crashed process");

			const childPid = siblingSave(home, cwd, 5, "child_seq5");
			expect(childPid).not.toBe(process.pid);
			expect(stageFiles(cwd)).toEqual([liveStage]);

			setProjectSnapshotPromotionSeamForTests(undefined);
			suspension.release();
			await suspension.completed;
			await waitForProjectSnapshotPersistsForTests();
			expect(getProjectSnapshotPersistErrorForTests()).toBeUndefined();
			expect(readDisk(cwd)).toEqual({
				bodySeq: 5,
				bodyExports: ["parent_seq5"],
				metaSeq: 5,
			});
			expect(stageFiles(cwd)).toEqual([]);
		} finally {
			suspension.release();
			suspension.restore();
			env.cleanup();
		}
	});

	it("a slow worker's older view is refused over a sibling's newer body (#3509)", async () => {
		const { env, cwd, home } = projectEnv();
		const seam = vi.fn();
		const suspension = suspendAt(seam, async () => {}, { calls: 1 });
		try {
			setProjectSnapshotPromotionSeamForTests(async () => {
				await seam();
			});
			saveProjectSnapshot(cwd, snapshotAt(cwd, 5, "parent_seq5"));
			await suspension.admitted; // seq 5 is staged; promotion is parked

			siblingSave(home, cwd, 6, "child_seq6");
			expect(readDisk(cwd)).toEqual({
				bodySeq: 6,
				bodyExports: ["child_seq6"],
				metaSeq: 6,
			});

			setProjectSnapshotPromotionSeamForTests(undefined);
			suspension.release();
			await suspension.completed;
			await waitForProjectSnapshotPersistsForTests();
			expect(readDisk(cwd)).toEqual({
				bodySeq: 6,
				bodyExports: ["child_seq6"],
				metaSeq: 6,
			});
			expect(stageFiles(cwd)).toEqual([]);
			// In-process readers see the sibling's body, not our refused one.
			expect(loadProjectSnapshot(cwd)?.seq).toBe(6);
			expect(
				latencyRows.filter(
					(row) =>
						row.phase === "project_snapshot_persist_decision" &&
						row.metadata?.decision === "superseded_on_disk",
				),
			).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({ seq: 5, diskSeq: 6 }),
				}),
			]);
		} finally {
			suspension.release();
			suspension.restore();
			env.cleanup();
		}
	});

	it("admission never lowers a sibling's newer meta, and the sync writer refuses the older body (#3509)", async () => {
		const { env, cwd, home } = projectEnv();
		process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
		const seam = vi.fn();
		const suspension = suspendAt(seam, async () => {}, { calls: 1 });
		try {
			siblingSave(home, cwd, 6, "child_seq6");
			setProjectSnapshotPromotionSeamForTests(async () => {
				await seam();
			});
			saveProjectSnapshot(cwd, snapshotAt(cwd, 5, "parent_seq5"));
			await suspension.admitted; // only admission has run
			expect(readProjectSnapshotMeta(cwd)?.seq).toBe(6);

			setProjectSnapshotPromotionSeamForTests(undefined);
			suspension.release();
			await suspension.completed;
			await waitForProjectSnapshotPersistsForTests();
			expect(getProjectSnapshotPersistStateForTests(cwd).active).toBe(false);
			expect(readDisk(cwd)).toEqual({
				bodySeq: 6,
				bodyExports: ["child_seq6"],
				metaSeq: 6,
			});
			expect(
				fs
					.readdirSync(path.dirname(getProjectSnapshotPath(cwd)))
					.filter((name) => name.includes(".tmp-")),
			).toEqual([]);
		} finally {
			suspension.release();
			suspension.restore();
			env.cleanup();
		}
	});

	it("after a refusal, in-process readers and merge-writers build on the sibling's newer body (#3509)", async () => {
		const { env, cwd, home } = projectEnv();
		process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
		try {
			// The sibling's body lands BEFORE our admission, so admission takes
			// the sibling's body as its read-your-writes baseline.
			siblingSave(home, cwd, 6, "child_seq6");
			saveProjectSnapshot(cwd, snapshotAt(cwd, 5, "parent_seq5"));
			expect(loadProjectSnapshot(cwd)?.seq).toBe(6);

			// A merge-writer (the word-index and reverse-deps writers' shape)
			// rebases on what it loads, so its update lands.
			const merged = loadProjectSnapshot(cwd);
			if (!merged) throw new Error("no snapshot to merge into");
			saveProjectSnapshot(cwd, {
				...merged,
				generatedAt: new Date().toISOString(),
				cachedExports: [...merged.cachedExports, ["merged", "m.ts"]],
			});
			expect(readDisk(cwd)).toEqual({
				bodySeq: 6,
				bodyExports: ["child_seq6", "merged"],
				metaSeq: 6,
			});
			expect(
				latencyRows.filter(
					(row) => row.metadata?.decision === "superseded_on_disk",
				),
			).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("a held cache lock keeps both the admission meta write and the promotion out (#3509)", async () => {
		const { env, cwd } = projectEnv();
		process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
		try {
			saveProjectSnapshot(cwd, snapshotAt(cwd, 6, "first_seq6"));
			const lockDir = `${getProjectSnapshotPath(cwd)}.locks`;
			const hold = tryAcquireGeneration(lockDir, 5_000);
			expect(hold).toBeDefined();
			try {
				saveProjectSnapshot(cwd, snapshotAt(cwd, 7, "blocked_seq7"));
			} finally {
				if (hold) releaseGeneration(hold);
			}
			expect(readDisk(cwd)).toEqual({
				bodySeq: 6,
				bodyExports: ["first_seq6"],
				metaSeq: 6,
			});
			expect(getProjectSnapshotPersistErrorForTests()).toBe(
				"project snapshot cache lock unavailable",
			);
			expect(getDegradationSummary()).toContainEqual(
				expect.objectContaining({
					kind: "project-snapshot-lock-unavailable",
					count: 2,
				}),
			);

			saveProjectSnapshot(cwd, snapshotAt(cwd, 7, "after_seq7"));
			expect(readDisk(cwd)).toEqual({
				bodySeq: 7,
				bodyExports: ["after_seq7"],
				metaSeq: 7,
			});
		} finally {
			env.cleanup();
		}
	});

	it("a worker promotion that cannot take the cache lock drops its stage as a failed persist (#3509)", async () => {
		const { env, cwd } = projectEnv();
		const seam = vi.fn();
		const suspension = suspendAt(seam, async () => {}, { calls: 1 });
		const lockDir = `${getProjectSnapshotPath(cwd)}.locks`;
		let hold: ReturnType<typeof tryAcquireGeneration> = undefined;
		try {
			setProjectSnapshotPromotionSeamForTests(async () => {
				await seam();
			});
			saveProjectSnapshot(cwd, snapshotAt(cwd, 5, "parent_seq5"));
			await suspension.admitted;
			expect(stageFiles(cwd)).toHaveLength(1);
			hold = tryAcquireGeneration(lockDir, 5_000);
			expect(hold).toBeDefined();

			setProjectSnapshotPromotionSeamForTests(undefined);
			suspension.release();
			await suspension.completed;
			await waitForProjectSnapshotPersistsForTests();
			expect(stageFiles(cwd)).toEqual([]);
			expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(false);
			expect(getProjectSnapshotPersistErrorForTests()).toBe(
				"project snapshot cache lock unavailable",
			);
		} finally {
			if (hold) releaseGeneration(hold);
			suspension.release();
			suspension.restore();
			env.cleanup();
		}
	});
});

describe("project seq allocation across processes (#3511)", () => {
	function editEnv() {
		const setup = projectEnv();
		process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
		const file = (name: string) => path.join(setup.cwd, "src", name);
		return { ...setup, file };
	}

	it("a snapshot whose runtime missed a sibling's logged edit is never fresh", () => {
		const { env, cwd, home, file } = editEnv();
		try {
			// Both sessions start while the log is empty.
			const runtime = seededRuntime(cwd);
			expect(siblingEdit(home, cwd, 0, file("b.ts"))).toBe(1);
			runtime.recordProjectMutation({
				filePath: file("a.ts"),
				source: "agent-write",
				cwd,
			});
			runtime.cachedExports.set("fromA", file("a.ts"));
			saveRuntimeProjectSnapshot({ cwd, runtime });
			expect(sessionStartView(cwd)).toEqual({
				log: [
					[1, "b.ts"],
					[2, "a.ts"],
				],
				fresh: false,
				boundedEqualsFull: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("a sibling allocates its seq above a snapshot already stamped fresh", () => {
		const { env, cwd, home, file } = editEnv();
		try {
			const runtime = seededRuntime(cwd);
			runtime.recordProjectMutation({
				filePath: file("a.ts"),
				source: "agent-write",
				cwd,
			});
			runtime.cachedExports.set("fromA", file("a.ts"));
			saveRuntimeProjectSnapshot({ cwd, runtime });
			expect(sessionStartView(cwd).fresh).toBe(true);

			// The sibling's session started before that edit was logged.
			expect(siblingEdit(home, cwd, 0, file("b.ts"))).toBe(2);
			expect(sessionStartView(cwd)).toEqual({
				log: [
					[1, "a.ts"],
					[2, "b.ts"],
				],
				fresh: false,
				boundedEqualsFull: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("a runtime's own consecutive edits keep its view complete and unrecorded", () => {
		const { env, cwd, file } = editEnv();
		try {
			const runtime = seededRuntime(cwd);
			for (const name of ["a.ts", "a.ts", "c.ts"]) {
				runtime.recordProjectMutation({
					filePath: file(name),
					source: "agent-write",
					cwd,
				});
			}
			// Each allocation finds the log's max at our own last seq.
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			expect(snapshot.seq).toBe(3);
			expect(snapshot.incomplete).toBeUndefined();
			expect(snapshot.sequenceIndex?.projectSeq).toBe(3);
			expect(isProjectSnapshotFresh(snapshot, 3)).toBe(true);
			expect(getDegradationSummary().map((row) => row.kind)).not.toContain(
				"snapshot-view-incomplete",
			);
		} finally {
			env.cleanup();
		}
	});

	it("each allocation folds the lines a sibling appended since this process last read the log", () => {
		const { env, cwd, home, file } = editEnv();
		try {
			const runtime = seededRuntime(cwd);
			runtime.recordProjectMutation({
				filePath: file("a.ts"),
				source: "agent-write",
				cwd,
			});
			expect(siblingEdit(home, cwd, 1, file("b.ts"))).toBe(2);
			expect(
				runtime.recordProjectMutation({
					filePath: file("c.ts"),
					source: "agent-write",
					cwd,
				}).projectSeq,
			).toBe(3);
			expect(readProjectChanges(cwd).map((entry) => entry.seq)).toEqual([
				1, 2, 3,
			]);
		} finally {
			env.cleanup();
		}
	});

	it("a line still being written is read once it is complete", () => {
		const { env, cwd, file } = editEnv();
		try {
			const logPath = getProjectChangeLogPath(cwd);
			const line = JSON.stringify({
				seq: 5,
				timestamp: new Date(0).toISOString(),
				sessionId: "older-writer",
				turnIndex: 0,
				source: "agent-write",
				filePath: file("b.ts"),
				fileSeq: 1,
			});
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			// An unlocked writer is halfway through its line when session_start
			// reads the log, and still when this runtime first allocates.
			fs.writeFileSync(logPath, line.slice(0, 20));
			const runtime = seededRuntime(cwd);
			runtime.recordProjectMutation({
				filePath: file("a.ts"),
				source: "agent-write",
				cwd,
			});
			// ...and finishes it; our own line landed after the fragment.
			const after = fs.readFileSync(logPath, "utf8").slice(20);
			fs.writeFileSync(logPath, `${line}\n${after}`);
			expect(
				runtime.recordProjectMutation({
					filePath: file("c.ts"),
					source: "agent-write",
					cwd,
				}).projectSeq,
			).toBe(6);
		} finally {
			env.cleanup();
		}
	});

	it("an append that cannot take the change-log lock still logs, and its runtime stops stamping fresh", () => {
		const { env, cwd, file } = editEnv();
		try {
			const runtime = seededRuntime(cwd);
			const hold = tryAcquireGeneration(
				`${getProjectChangeLogPath(cwd)}.locks`,
				5_000,
			);
			expect(hold).toBeDefined();
			try {
				runtime.recordProjectMutation({
					filePath: file("a.ts"),
					source: "agent-write",
					cwd,
				});
			} finally {
				if (hold) releaseGeneration(hold);
			}
			runtime.cachedExports.set("fromA", file("a.ts"));
			saveRuntimeProjectSnapshot({ cwd, runtime });
			expect(sessionStartView(cwd)).toEqual({
				log: [[1, "a.ts"]],
				fresh: false,
				boundedEqualsFull: true,
			});
			expect(getDegradationSummary()).toContainEqual(
				expect.objectContaining({
					kind: "change-log-lock-unavailable",
					count: 1,
				}),
			);
			// Tagged, so a reader distrusts every snapshot whose runtime never
			// folded it, the lock holder's included (review round 2).
			expect(readProjectChanges(cwd)[0]?.unlocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("a reseed from the log, or a new session, lets the runtime vouch for its seq again", () => {
		const { env, cwd, file } = editEnv();
		const logSibling = (seq: number) =>
			appendProjectChange(cwd, {
				seq,
				timestamp: new Date(0).toISOString(),
				sessionId: "sibling",
				turnIndex: 0,
				source: "agent-write",
				filePath: file("b.ts"),
				fileSeq: seq,
			});
		const edit = (runtime: RuntimeCoordinator) =>
			runtime.recordProjectMutation({
				filePath: file("a.ts"),
				source: "agent-write",
				cwd,
			});
		const stamp = (runtime: RuntimeCoordinator) => {
			const { seq, incomplete } = buildProjectSnapshotFromRuntime({
				cwd,
				runtime,
			});
			return { seq, incomplete: incomplete === true };
		};
		try {
			const runtime = seededRuntime(cwd);
			logSibling(5);
			expect(edit(runtime).projectSeq).toBe(6);
			expect(stamp(runtime)).toEqual({ seq: 6, incomplete: true });

			const latest = readLatestProjectSequence(cwd);
			runtime.seedProjectSequence(latest.projectSeq, latest.fileSeqByPath);
			expect(stamp(runtime)).toEqual({ seq: 6, incomplete: false });

			logSibling(10);
			expect(edit(runtime).projectSeq).toBe(11);
			expect(stamp(runtime)).toEqual({ seq: 11, incomplete: true });
			runtime.resetForSession();
			expect(stamp(runtime)).toEqual({ seq: 0, incomplete: false });
		} finally {
			env.cleanup();
		}
	});

	it("the first allocation after session_start reads only the lines appended since that read", () => {
		const { env, cwd, file } = editEnv();
		const logLine = (seq: number) =>
			appendProjectChange(cwd, {
				seq,
				timestamp: new Date(0).toISOString(),
				sessionId: "sibling",
				turnIndex: 0,
				source: "agent-write",
				filePath: file("b.ts"),
				fileSeq: seq,
			});
		try {
			logLine(5);
			const runtime = seededRuntime(cwd); // session_start's full read
			// Rewrite the already-read prefix in place, at the same length: only a
			// second full scan of the log could see this 9.
			const logPath = getProjectChangeLogPath(cwd);
			const folded = fs.readFileSync(logPath, "utf8");
			fs.writeFileSync(logPath, folded.replace('"seq":5', '"seq":9'));
			logLine(7); // appended after the read: the allocation must see it
			expect(
				runtime.recordProjectMutation({
					filePath: file("a.ts"),
					source: "agent-write",
					cwd,
				}).projectSeq,
			).toBe(8);
		} finally {
			env.cleanup();
		}
	});

	it("an incomplete snapshot keeps its real seq and is never fresh, not even at that seq", () => {
		const { env, cwd, home, file } = editEnv();
		try {
			const runtime = seededRuntime(cwd);
			siblingEdit(home, cwd, 0, file("b.ts"));
			runtime.recordProjectMutation({
				filePath: file("a.ts"),
				source: "agent-write",
				cwd,
			});
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			expect(snapshot).toMatchObject({ seq: 2, incomplete: true });
			expect(snapshot.sequenceIndex).toBeUndefined();
			expect(isProjectSnapshotFresh(snapshot, 2)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("a runtime that missed a sibling's edit still persists its newer view, marked never fresh (review B2)", () => {
		const { env, cwd, home, file } = editEnv();
		try {
			const runtime = seededRuntime(cwd);
			// The sibling logs seq 1 and saves a complete snapshot at seq 1.
			expect(siblingEditAndSave(home, cwd, 0, file("b.ts"), "child_seq1")).toBe(
				1,
			);
			for (const name of ["a.ts", "c.ts"]) {
				runtime.recordProjectMutation({
					filePath: file(name),
					source: "agent-write",
					cwd,
				});
				runtime.cachedExports.set(`from_${name}`, file(name));
				saveRuntimeProjectSnapshot({ cwd, runtime });
			}
			expect(readDisk(cwd)).toEqual({
				bodySeq: 3,
				bodyExports: ["from_a.ts", "from_c.ts"],
				metaSeq: 3,
			});
			expect(readProjectSnapshotMeta(cwd)?.incomplete).toBe(true);
			expect(sessionStartView(cwd).fresh).toBe(false);
			expect(
				latencyRows.filter(
					(row) => row.metadata?.decision === "superseded_on_disk",
				),
			).toEqual([]);
			expect(getDegradationSummary()).toContainEqual(
				expect.objectContaining({
					kind: "snapshot-view-incomplete",
					count: 1,
					latestReasons: [
						expect.objectContaining({
							reason: expect.stringContaining(
								"the change log reached seq 1 while this runtime was at 0",
							),
						}),
					],
				}),
			);
		} finally {
			env.cleanup();
		}
	});
	it("a lock holder's snapshot is not fresh when a sibling that timed out on the lock logged the same seq (review round 2)", () => {
		const { env, cwd, home, file } = editEnv();
		try {
			const runtime = seededRuntime(cwd);
			let siblingSeq = 0;
			const restore = beforeNextChangeLogAppend(cwd, () => {
				siblingSeq = siblingEdit(home, cwd, 0, file("b.ts"));
			});
			try {
				runtime.recordProjectMutation({
					filePath: file("a.ts"),
					source: "agent-write",
					cwd,
				});
			} finally {
				restore();
			}
			expect(siblingSeq).toBe(1);
			runtime.cachedExports.set("fromA", file("a.ts"));
			saveRuntimeProjectSnapshot({ cwd, runtime });
			expect(sessionStartView(cwd)).toEqual({
				log: [
					[1, "b.ts"],
					[1, "a.ts"],
				],
				fresh: false,
				boundedEqualsFull: true,
			});

			// The holder's next edit takes it above the collision; the unlocked
			// entry still sits after the holder's fold point.
			runtime.recordProjectMutation({
				filePath: file("c.ts"),
				source: "agent-write",
				cwd,
			});
			saveRuntimeProjectSnapshot({ cwd, runtime });
			expect(sessionStartView(cwd)).toEqual({
				log: [
					[1, "b.ts"],
					[1, "a.ts"],
					[2, "c.ts"],
				],
				fresh: false,
				boundedEqualsFull: true,
			});

			// A session seeded after the unlocked entry has folded it.
			saveRuntimeProjectSnapshot({ cwd, runtime: seededRuntime(cwd) });
			expect(sessionStartView(cwd).fresh).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("a runtime's fold point follows its seed and a late merge, never backwards (review round 2)", () => {
		const { env, cwd } = editEnv();
		try {
			const runtime = new RuntimeCoordinator();
			const foldPoint = () =>
				buildProjectSnapshotFromRuntime({ cwd, runtime }).logEntries;
			runtime.seedProjectSequence(3, new Map(), 5);
			expect(foldPoint()).toBe(5);
			// A late read taken before the seed folded fewer entries.
			runtime.mergeProjectSequence(3, new Map(), 4);
			expect(foldPoint()).toBe(5);
			runtime.mergeProjectSequence(3, new Map(), 7);
			expect(foldPoint()).toBe(7);
			runtime.resetForSession();
			expect(foldPoint()).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it.each([
		["the sync writer", true],
		["the persist worker", false],
	])(
		"an incomplete snapshot is stored with a legacy seq no pre-#3511 reader matches, through %s (review round 2)",
		async (_writer, sync) => {
			const { env, cwd, home, file } = editEnv();
			if (!sync) delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
			try {
				const runtime = seededRuntime(cwd);
				expect(siblingEdit(home, cwd, 0, file("b.ts"))).toBe(1);
				runtime.recordProjectMutation({
					filePath: file("a.ts"),
					source: "agent-write",
					cwd,
				});
				saveRuntimeProjectSnapshot({ cwd, runtime });
				await waitForProjectSnapshotPersistsForTests();
				const raw = () => [
					JSON.parse(fs.readFileSync(getProjectSnapshotMetaPath(cwd), "utf8")),
					JSON.parse(
						gunzipSync(fs.readFileSync(getProjectSnapshotPath(cwd))).toString(),
					),
				];
				// A pre-#3511 reader compares the stored seq with the log max (never
				// negative), or with -1 after a timed-out sequence read.
				for (const stored of raw()) {
					expect(stored.seq).toBeLessThan(-1);
					expect(stored.incompleteSeq).toBe(2);
				}
				_resetProjectSnapshotParseCacheForTests();
				expect(readProjectSnapshotMeta(cwd)).toMatchObject({
					seq: 2,
					incomplete: true,
				});
				expect(loadProjectSnapshot(cwd)).toMatchObject({
					seq: 2,
					incomplete: true,
				});

				// A complete snapshot keeps its real seq there, so older readers
				// still hydrate it.
				saveRuntimeProjectSnapshot({ cwd, runtime: seededRuntime(cwd) });
				await waitForProjectSnapshotPersistsForTests();
				for (const stored of raw()) {
					expect(stored.seq).toBe(2);
					expect(stored.incompleteSeq).toBeUndefined();
				}
			} finally {
				env.cleanup();
			}
		},
	);
});

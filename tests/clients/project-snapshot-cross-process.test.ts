// flake-shape: real-process-spawn — the sibling writer must be a second real
// process with its own pid: the stage-sweep liveness check (#3510) keys on a
// pid, and a second module instance in this process shares ours.
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
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getProjectSnapshotMetaPath,
	getProjectSnapshotPath,
	getProjectSnapshotPersistErrorForTests,
	resetProjectSnapshotPersistWorkerForTests,
	saveProjectSnapshot,
	buildProjectSnapshotFromRuntime,
	setProjectSnapshotPromotionSeamForTests,
	terminateProjectSnapshotPersistWorkerForTests,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
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
	process.env = { ...envBefore };
});

function snapshotAt(cwd: string, seq: number, marker: string) {
	const runtime = new RuntimeCoordinator();
	runtime.seedProjectSequence(seq);
	runtime.cachedExports.set(marker, path.join(cwd, `${marker}.ts`));
	return buildProjectSnapshotFromRuntime({ cwd, runtime });
}

/** One synchronous save in a real sibling process; returns its pid. */
function siblingSave(
	home: string,
	cwd: string,
	seq: number,
	marker: string,
): number {
	const script = `
		const snap = await import(${JSON.stringify(snapshotJs)});
		const rt = await import(${JSON.stringify(runtimeJs)});
		const runtime = new rt.RuntimeCoordinator();
		runtime.seedProjectSequence(${seq});
		runtime.cachedExports.set(${JSON.stringify(marker)}, "x.ts");
		const cwd = ${JSON.stringify(cwd)};
		snap.saveProjectSnapshot(cwd, snap.buildProjectSnapshotFromRuntime({ cwd, runtime }));
		console.log(JSON.stringify({ pid: process.pid }));
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
	return (JSON.parse(child.stdout.trim()) as { pid: number }).pid;
}

function readDisk(cwd: string) {
	const body = JSON.parse(
		gunzipSync(fs.readFileSync(getProjectSnapshotPath(cwd))).toString(),
	) as { seq: number; cachedExports: Array<[string, string]> };
	const meta = JSON.parse(
		fs.readFileSync(getProjectSnapshotMetaPath(cwd), "utf8"),
	) as { seq: number };
	return {
		bodySeq: body.seq,
		bodyExports: body.cachedExports.map((entry) => entry[0]),
		metaSeq: meta.seq,
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
});

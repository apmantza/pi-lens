/**
 * #4937: `drainRegisteredBackgroundWritesForTests` joins the deferred writers
 * of EVERY evaluation of a registering module, not only the one the test
 * imported.
 *
 * Recurrence this prevents: master run 40967488612 (shard 2/5) leaked
 * `pi-lens-pi-session-yB7mpc` from `tests/lens-toggle-command.test.ts`. The
 * tier-2 harness loads the built extension through pi's own jiti loader
 * (`moduleCache: false`), so the extension runs its OWN copy of
 * `clients/project-snapshot.ts`, and that copy's in-flight worker write landed
 * under `<fixture>/data` AFTER the file's drain and removal, re-creating the
 * root. The drain waited on the test's copy only, whose queue was empty. The
 * installer's debounced probe-cache flush has the same shape (a 300 ms timer
 * in the loaded copy).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resetProjectSnapshotPersistWorkerForTests,
	terminateProjectSnapshotPersistWorkerForTests,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import type { ProjectSnapshot } from "../../clients/project-snapshot.js";
import { registerBackgroundWriteDrain } from "../../clients/background-write-drains.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import { drainRegisteredBackgroundWritesForTests } from "../support/background-write-drains.js";
import { setupTestEnvironment } from "./test-utils.js";

const CORPUS = path.join(
	import.meta.dirname,
	"../fixtures/snapshot-persist/released-4.3.0",
);

const PINNED_KEYS = ["PI_LENS_HOME", "PILENS_DATA_DIR"] as const;
const savedEnv: Record<string, string | undefined> = {};

function pinEnv(home: string, data: string): void {
	for (const key of PINNED_KEYS) savedEnv[key] = process.env[key];
	process.env.PI_LENS_HOME = home;
	process.env.PILENS_DATA_DIR = data;
}

afterEach(async () => {
	vi.useRealTimers();
	for (const key of PINNED_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	delete process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
	await waitForProjectSnapshotPersistsForTests();
	await terminateProjectSnapshotPersistWorkerForTests();
	resetProjectSnapshotPersistWorkerForTests();
});

describe("background write drains across module copies (#4937)", () => {
	it("joins a snapshot persist that another copy of the module has in flight", async () => {
		const env = setupTestEnvironment("bwd-snapshot-");
		try {
			pinEnv(path.join(env.tmpDir, "home"), path.join(env.tmpDir, "data"));
			// A second evaluation of the module: its queue is not the one the
			// statically imported copy above reads.
			vi.resetModules();
			const other = await import("../../clients/project-snapshot.js");
			expect(other.waitForProjectSnapshotPersistsForTests).not.toBe(
				waitForProjectSnapshotPersistsForTests,
			);
			const snapshot = JSON.parse(
				fs.readFileSync(path.join(CORPUS, "snapshot.json"), "utf-8"),
			) as ProjectSnapshot;
			const cwd = path.join(env.tmpDir, "project");
			// The worker holds the write long enough for the assertion below to
			// see it in flight; the delay is the module's own test seam.
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "400";
			other.saveProjectSnapshot(cwd, snapshot);
			expect(other.getProjectSnapshotPersistStateForTests(cwd).active).toBe(
				true,
			);

			await drainRegisteredBackgroundWritesForTests();

			expect(other.getProjectSnapshotPersistStateForTests(cwd).active).toBe(
				false,
			);
			expect(fs.existsSync(other.getProjectSnapshotPath(cwd))).toBe(true);
			await other.terminateProjectSnapshotPersistWorkerForTests();
		} finally {
			env.cleanup();
		}
	}, 30_000);

	it("joins a probe-cache flush that another copy of the installer has pending", async () => {
		const env = setupTestEnvironment("bwd-probe-cache-");
		try {
			const home = path.join(env.tmpDir, "home");
			fs.mkdirSync(home, { recursive: true });
			pinEnv(home, path.join(env.tmpDir, "data"));
			const tool = path.join(env.tmpDir, "tool.sh");
			fs.writeFileSync(tool, "#!/bin/sh\n");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			// The cache path is fixed when the module loads, so the second copy
			// is evaluated under the pinned home.
			vi.resetModules();
			const other = await import("../../clients/installer/index.js");
			await other.updateProbeCache("probe-tool", tool);
			const cacheFile = path.join(home, "probe-cache.json");
			// The write is still pending behind the debounce timer: asserted as a
			// live timer under fake timers, not by racing the clock on disk.
			expect(vi.getTimerCount()).toBe(1);

			await drainRegisteredBackgroundWritesForTests();

			expect(
				Object.keys(JSON.parse(fs.readFileSync(cacheFile, "utf-8"))),
			).toEqual(["probe-tool"]);
			expect(vi.getTimerCount()).toBe(0);
			other.resetProbeCacheStateForTesting();
		} finally {
			env.cleanup();
		}
	});

	// Recurrence: review of #5006 (F1), the drain read a deferred write as
	// settled. The snapshot wait is a bounded poll (SNAPSHOT_PERSIST_WAIT_MS, a
	// real-clock 2 s ceiling since #4865); a persist that outlives it resolved the
	// drain, and the write then re-created the fixture root. The drain must reject
	// while work remains.
	it("rejects when a snapshot persist outlives the bounded wait", async () => {
		const env = setupTestEnvironment("bwd-snapshot-slow-");
		let other: typeof import("../../clients/project-snapshot.js") | undefined;
		try {
			pinEnv(path.join(env.tmpDir, "home"), path.join(env.tmpDir, "data"));
			vi.resetModules();
			other = await import("../../clients/project-snapshot.js");
			const snapshot = JSON.parse(
				fs.readFileSync(path.join(CORPUS, "snapshot.json"), "utf-8"),
			) as ProjectSnapshot;
			const cwd = path.join(env.tmpDir, "project");
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "3500";
			other.saveProjectSnapshot(cwd, snapshot);

			await expect(drainRegisteredBackgroundWritesForTests()).rejects.toThrow(
				/still pending/,
			);
			expect(other.getProjectSnapshotPersistStateForTests(cwd).active).toBe(
				true,
			);
		} finally {
			await other?.waitForProjectSnapshotPersistsForTests();
			await other?.terminateProjectSnapshotPersistWorkerForTests();
			env.cleanup();
		}
	}, 30_000);

	// Recurrence: review of #5006 (F1), a probe-cache flush that failed (or was
	// deferred behind a lock) armed a retry timer and the drain resolved; the
	// retry then wrote under a removed root. The drain must reject and leave no
	// retry armed.
	it("rejects and disarms the retry when a probe-cache flush cannot land", async () => {
		const env = setupTestEnvironment("bwd-probe-cache-fail-");
		let other: typeof import("../../clients/installer/index.js") | undefined;
		try {
			const home = path.join(env.tmpDir, "home");
			fs.mkdirSync(home, { recursive: true });
			pinEnv(home, path.join(env.tmpDir, "data"));
			const tool = path.join(env.tmpDir, "tool.sh");
			fs.writeFileSync(tool, "#!/bin/sh\n");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			// A directory where the cache file belongs: the atomic write fails.
			fs.mkdirSync(path.join(home, "probe-cache.json"));
			vi.resetModules();
			other = await import("../../clients/installer/index.js");
			await other.updateProbeCache("probe-tool", tool);

			await expect(drainRegisteredBackgroundWritesForTests()).rejects.toThrow(
				/did not land/,
			);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			other?.resetProbeCacheStateForTesting();
			env.cleanup();
		}
	});

	// Recurrence: #5745 r10. A drain registered after the installer's queued a
	// probe-cache update once the installer's drain had run. One pass left that
	// update's debounced flush armed, to write after the fixture root was
	// removed; the installer's pending signal sends the runner round again.
	it("flushes a probe-cache update a later drain queued, in another pass", async () => {
		const env = setupTestEnvironment("bwd-probe-cache-late-");
		let other: typeof import("../../clients/installer/index.js") | undefined;
		try {
			const home = path.join(env.tmpDir, "home");
			fs.mkdirSync(home, { recursive: true });
			pinEnv(home, path.join(env.tmpDir, "data"));
			const tool = path.join(env.tmpDir, "tool.sh");
			fs.writeFileSync(tool, "#!/bin/sh\n");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			vi.resetModules();
			const installer = await import("../../clients/installer/index.js");
			other = installer;
			let queued = false;
			async function lateProbeCacheWriterForTests(): Promise<
				string | undefined
			> {
				if (!queued) {
					queued = true;
					await installer.updateProbeCache("probe-tool", tool);
				}
				return undefined;
			}
			registerBackgroundWriteDrain(lateProbeCacheWriterForTests, () => false);

			await drainRegisteredBackgroundWritesForTests();

			const cacheFile = path.join(home, "probe-cache.json");
			expect(
				Object.keys(JSON.parse(fs.readFileSync(cacheFile, "utf-8"))),
			).toEqual(["probe-tool"]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			other?.resetProbeCacheStateForTesting();
			env.cleanup();
		}
	});

	// Recurrence: #5745 r10. The runner repeats passes until no drain reports
	// pending work, so a pending signal that never clears would hold a file's
	// teardown until the hook timeout cut it, with no record of why. The
	// deadline ends the passes, rejects, and records the event once.
	it("a fixed point the deadline cuts rejects, stops its passes and records once", async () => {
		let stuck = true;
		let pendingReads = 0;
		async function neverIdleWriterForTests(): Promise<string | undefined> {
			return undefined;
		}
		registerBackgroundWriteDrain(neverIdleWriterForTests, () => {
			pendingReads += 1;
			return stuck;
		});
		try {
			await expect(
				drainRegisteredBackgroundWritesForTests({ deadlineMs: 50 }),
			).rejects.toThrow(
				/^background-write drains did not reach a fixed point within 50 ms; still pending: .*neverIdleWriterForTests/,
			);
			// The abandoned passes stop: nothing reads the signal any more.
			const readsAtDeadline = pendingReads;
			for (let turn = 0; turn < 3; turn += 1)
				await new Promise<void>((resolve) => setImmediate(resolve));
			expect(pendingReads).toBe(readsAtDeadline);

			await expect(
				drainRegisteredBackgroundWritesForTests({ deadlineMs: 50 }),
			).rejects.toThrow(/did not reach a fixed point/);
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "background-write-drain-deadline",
			);
			expect(group?.count).toBe(1);
			expect(group?.latestReasons.map((entry) => entry.subject)).toEqual([
				"fixed-point",
			]);
		} finally {
			stuck = false;
		}
	});
});

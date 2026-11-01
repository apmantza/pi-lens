/**
 * #2518, second door: index.ts's `ensureLSPConfigInitialized` memo.
 *
 * `_lspConfigInitializedCwds` is a process-lifetime memo of cwds this
 * extension has initialized. It is NOT the session-root registry, and it never
 * sees the registry's other production writers — `clients/runtime-session.ts`
 * and `clients/lens-engine.ts` both call `initLSPConfig` directly — so the
 * registry can drop a root at its cap while the memo still reports it
 * initialized. The dropped entry carries that root's `lsp.disabledServers`
 * denial with it, and a memo-only check means nothing ever loads it again:
 * the operator's denial is lifted for the rest of the process.
 *
 * `mcp/server.ts`'s `ensureReady` has consulted `shouldInitializeSessionRoot`
 * since #2052 R1 for exactly this reason; this file pins the extension's own
 * entry point to the same seam, through the REAL activation and the real
 * `session_start` emit rather than a hand call to a private function.
 *
 * #5024: the hosts' `session_start` leaves three writes in flight — the
 * project-snapshot persist worker, the installer's debounced probe-cache
 * flush, and the instance-registry mutation tail — and each resolves its path
 * under `PI_LENS_HOME`, which this file points at a fixture home. `afterEach`
 * therefore settles them (`settleExtensionWriters`) BEFORE it removes that
 * home; removing first let a late write re-create
 * `pi-lens-2518-idx-home-*`, which the serialized tmp-fixture hygiene owner
 * reds on a shard (master run 41051641094).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.js";
import {
	initLSPConfig,
	isServerDisabled,
	resetLSPConfigStateForTests,
} from "../clients/lsp/config.js";
import { isSessionRootRegistered } from "../clients/lsp/session-roots.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { waitForProjectSnapshotPersistsForTests } from "../clients/project-snapshot.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { drainRegisteredBackgroundWritesForTests } from "./support/background-write-drains.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

const DENIED_SERVER = "typos";
const dirs: string[] = [];
let previousStartupMode: string | undefined;
let previousHome: string | undefined;
let previousPersistDelay: string | undefined;

function tempRoot(prefix: string): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-2518-idx-${prefix}-`)),
	);
	dirs.push(dir);
	return dir;
}

/** A project whose operator config denies {@link DENIED_SERVER}. */
function denyingRoot(): string {
	const dir = tempRoot("deny");
	fs.writeFileSync(
		path.join(dir, ".pi-lens.json"),
		JSON.stringify({ lsp: { disabledServers: [DENIED_SERVER] } }),
	);
	fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n");
	return dir;
}

beforeEach(() => {
	previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
	// Minimal mode so `ensureLSPConfigInitialized` is the ONLY thing in this
	// activation that resolves LSP config — the seam under test, with no
	// warm-up timer or bootstrap load resolving it by a side door.
	process.env.PI_LENS_STARTUP_MODE = "minimal";
	previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = tempRoot("home");
	// #5024: the leak is a persist that lands after teardown. A 200 ms worker
	// delay plants that late write in every case, so the settle is what the
	// file observes instead of a race with the worker's own timing. Set before
	// `session_start`, which reads it when it posts the persist.
	previousPersistDelay =
		process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
	process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "200";
	_resetSessionLifecycleForTests();
	resetLSPConfigStateForTests();
});

/**
 * #5024: settle the session's background writers before the file removes the
 * fixture home. The settle is the `clients/background-write-drains.ts` registry
 * runner that `tests/support/pi-session.ts`'s `drainPiSessionWrites` also joins;
 * the project-snapshot persist worker and the installer's debounced probe-cache
 * flush join there.
 *
 * WHY IT MATTERS: `session_start` hands a project-snapshot persist to a
 * `worker_threads` worker, and that worker holds the snapshot root it was
 * given — a path under this file's `PI_LENS_HOME`. It writes the body when the
 * snapshot arrives, which is after the `session_start` emit resolves, so a home
 * removed first was re-created as `pi-lens-2518-idx-home-*` and the serialized
 * tmp-fixture hygiene owner redded the shard (master run 41051641094).
 *
 * The instance-registry tail is deliberately NOT joined: its writers resolve
 * the machine-state directory when they land (`clients/instance-registry.ts`'s
 * `registryPath`), and by then this file has restored `PI_LENS_HOME` to the
 * worker's home, so a late registry write cannot re-create the removed fixture
 * directory; the worker's own teardown joins that tail (#3617).
 *
 * Idempotent, so the guard case below can run it inside its own body.
 */
async function settleExtensionWriters(): Promise<void> {
	await drainRegisteredBackgroundWritesForTests();
}

afterEach(async () => {
	// The restores run even when a writer outlives the bounded settle: a
	// rejected settle reds this file without leaving module or env state behind
	// for the next case in the worker.
	try {
		await settleExtensionWriters();
	} finally {
		if (previousStartupMode === undefined)
			delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		if (previousPersistDelay === undefined)
			delete process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
		else
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS =
				previousPersistDelay;
		try {
			// #5146: end the sessions once `PI_LENS_HOME` is restored and before the
			// lifecycle resets under them. The instance-registry deregistration a
			// shutdown queues resolves the machine-state directory when it lands, so
			// with the fixture home still pinned it would re-create that home after
			// its removal (tmp-fixture-hygiene, #4591).
			await endMockSessions();
		} finally {
			_resetSessionLifecycleForTests();
			resetLSPConfigStateForTests();
		}
	}
	await settleExtensionWriters();
	// Removed only after a settle that returned: a root a writer may still
	// re-create stays in `dirs`, because the splice never runs on a throw.
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("index.ts ensureLSPConfigInitialized vs the session-root registry (#2518)", () => {
	it("re-initializes a root the registry evicted while its memo still names it", async () => {
		const root = denyingRoot();
		const file = path.join(root, "notes.md");
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		const firstCtx = makeCtx({ cwd: root, sessionId: "host-session-1" });
		await pi.emit("session_start", makeSessionStartEvent(), firstCtx);
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);

		// The registry's other production writers: `runtime-session.ts` and
		// `lens-engine.ts` call `initLSPConfig` for a turn's cwd without ever
		// touching index.ts's memo, so the registry advances past it.
		for (let index = 0; index < 128; index++) {
			await initLSPConfig(tempRoot(`other-${index}`));
		}
		expect(isSessionRootRegistered(root)).toBe(false);
		expect(
			isServerDisabled(DENIED_SERVER, file),
			"an evicted root has no config, so its denial is not applied",
		).toBe(false);

		// The next session for that root must load it again. A memo-only check
		// returns early here and leaves the denial lifted for the process.
		_resetSessionLifecycleForTests();
		const secondCtx = makeCtx({ cwd: root, sessionId: "host-session-2" });
		await pi.emit(
			"session_start",
			makeSessionStartEvent({ reason: "new" }),
			secondCtx,
		);
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);
		expect(isSessionRootRegistered(root)).toBe(true);
	}, 120_000);

	/**
	 * #5024 red-first: the file's own teardown, driven inside a case so the leak
	 * window is observed instead of raced. The `session_start` above leaves the
	 * project-snapshot persist worker holding the fixture home, so teardown that
	 * only resets, restores `PI_LENS_HOME` and removes the directory hands the
	 * worker a path it then creates again; the bounded persist wait below is
	 * where that write lands, and the home must still be gone afterwards.
	 */
	it("removes the fixture home only after the session's writers settle", async () => {
		const root = denyingRoot();
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const ctx = makeCtx({ cwd: root, sessionId: "host-session-teardown" });
		await pi.emit("session_start", makeSessionStartEvent(), ctx);
		const home = process.env.PI_LENS_HOME as string;

		await settleExtensionWriters();
		// What teardown would remove, removed here so the case observes the leak
		// window instead of racing it. This is the bounded join for the persist
		// that window exists for, not a sleep: it resolves when the persist
		// settles, the moment at which the home must still be gone.
		for (const dir of dirs.splice(0)) removeTempDirSync(dir);
		await waitForProjectSnapshotPersistsForTests();

		expect(
			fs.existsSync(home),
			"a deferred writer re-created the fixture home the teardown removed",
		).toBe(false);
	}, 120_000);
});

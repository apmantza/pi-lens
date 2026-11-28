import { LSP_SERVERS } from "../../clients/lsp/server.js";
/**
 * #1153 — the orphan reaper's fire-and-forget enumeration/kill spawns must be
 * `.unref()`'d (child handle AND piped stdio) so a completed one-shot
 * `pi --print` process can exit at settle without waiting for the best-effort
 * sweep's PowerShell/`ps` child to close.
 *
 * Member of the "completed one-shot process retained alive by a REFERENCED
 * libuv handle at settle" class (#1097/#1110 timers, #1148/#1149 worker ports).
 *
 * `node:child_process.spawn` and the instance registry are mocked so the sweep
 * runs cross-platform (the CI job is Linux; dev is Windows) without touching
 * the real OS process table — every spawned child is a fake that records
 * whether `unref()` was called on the child and its stdout. Fail-then-pass:
 * on pre-fix code (no `unrefReaperChild` calls) `child.unref()` is never
 * invoked and these assertions fail; post-fix they pass.
 *
 * Mocking `node:child_process` and `instance-registry.js` is NOT enough to
 * make the sweep hermetic: `sweepUntrackedOrphans` reaches the real
 * `<PI_LENS_HOME>/orphan-backstop.{json,lock}` (cooldown stamp + cross-process
 * sweep lock) BEFORE it enumerates anything, and since #2912 that home is ONE
 * directory shared by the whole Vitest run — see the per-case `PI_LENS_HOME`
 * pin below (#3042 shape; master 038e28b's Unit red).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

interface FakeChild {
	unref: ReturnType<typeof vi.fn>;
	stdout: { on: (...a: unknown[]) => unknown; unref: ReturnType<typeof vi.fn> };
	stderr: null;
	stdin: null;
	on: (...a: unknown[]) => FakeChild;
	once: (ev: string, cb: (...a: unknown[]) => void) => FakeChild;
}

const h = vi.hoisted(() => {
	const spawned: FakeChild[] = [];
	// A mutable registry/enabled state the mocked instance-registry reads at
	// call time (property access on `state`, so per-test reassignment works).
	const state: { registry: unknown[]; enabled: boolean } = {
		registry: [],
		enabled: true,
	};
	function makeFakeChild(): FakeChild {
		const stdout = {
			on: () => stdout,
			unref: vi.fn(),
		};
		const child: FakeChild = {
			stdout,
			stderr: null,
			stdin: null,
			unref: vi.fn(),
			on: () => child,
			once: (ev, cb) => {
				// Resolve every sweep promise: fire `close` with empty output so
				// enumerate/query resolve to "nothing found" and the sweep returns.
				if (ev === "close") setImmediate(() => cb(0, null));
				return child;
			},
		};
		spawned.push(child);
		return child;
	}
	return { spawned, state, makeFakeChild };
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => h.makeFakeChild()),
}));

// #3917 opt-in: the sweep's enumeration spawn is the subject. The setup's
// default scope answers the backstop's `Name`-filtered table query with an
// empty table before any spawn; `node:child_process` is mocked above, so the
// real table is never read.
vi.unmock("../../clients/process-snapshot.js");
vi.mock("../../clients/instance-registry.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/instance-registry.js")
	>()),
	isInstanceRegistryEnabled: () => h.state.enabled,
	readInstanceRegistry: async () => h.state.registry,
}));

import {
	sweepOrphans,
	sweepUntrackedOrphans,
} from "../../clients/instance-reaper.js";

function expectAllChildrenUnrefd() {
	expect(h.spawned.length).toBeGreaterThanOrEqual(1);
	for (const child of h.spawned) {
		// The child handle itself must be detached from the loop...
		expect(child.unref).toHaveBeenCalled();
		// ...and so must its piped stdout (a `data`-listener-attached pipe
		// re-references the loop even after `child.unref()`).
		expect(child.stdout.unref).toHaveBeenCalled();
	}
}

describe("instance-reaper: fire-and-forget spawns are unref'd (#1153)", () => {
	// #3042 shape, caught by master 038e28b's Unit lane: `sweepUntrackedOrphans`
	// takes `<PI_LENS_HOME>/orphan-backstop.lock` and reads the
	// `orphan-backstop.json` cooldown stamp (30 min) BEFORE it enumerates, so
	// against the run-shared home (#2912: one `.probe-home` for the whole run,
	// not a per-worker temp dir) ANY sibling fork's real `session_start` —
	// measured: `tests/index-integration.test.ts` arms 37 real
	// `scheduleUntrackedOrphanSweep()` timers through `index.js` — leaves a
	// fresh stamp that makes this file's sweep return `cooldown` with ZERO
	// spawns ("expected 0 to be greater than or equal to 1"). The same stamp is
	// what THIS file used to leave behind for the next reader. A private home
	// per case is the seam production already resolves the stamp through
	// (`clients/file-utils.ts` `getGlobalPiLensDir`), and the idiom
	// `instance-reaper-backstop.test.ts` (#3066) and
	// `instance-reaper-prune-concurrency.test.ts` already use.
	let previousHome: string | undefined;
	let caseHome: string;

	beforeEach(() => {
		previousHome = process.env.PI_LENS_HOME;
		caseHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-unref-"));
		process.env.PI_LENS_HOME = caseHome;
		h.spawned.length = 0;
		h.state.registry = [];
		h.state.enabled = true;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		removeTempDirSync(caseHome);
		vi.clearAllMocks();
	});

	it("sweepUntrackedOrphans unrefs the enumerateManagedProcesses child + stdout", async () => {
		// Guaranteed ≥1 enumeration spawn on every session_start when the
		// registry is enabled (the Windows-guaranteed-PowerShell case in #1153).
		await sweepUntrackedOrphans({ getServers: async () => LSP_SERVERS });
		expectAllChildrenUnrefd();
	});

	it("sweepOrphans unrefs the queryCommandLines child + stdout", async () => {
		// A recorded child pid makes `candidatePids` non-empty, so
		// `queryCommandLines` actually spawns its command-line probe.
		h.state.registry = [
			{
				pid: 999_991,
				startedAt: new Date().toISOString(),
				projectRoot: "/proj",
				lspChildren: [
					{
						pid: 999_992,
						serverId: "ast-grep",
						command: "ast-grep",
						spawnedAt: new Date().toISOString(),
					},
				],
				lspChildCount: 1,
				rssBytes: 0,
				heartbeatAt: new Date().toISOString(),
			},
		];
		await sweepOrphans();
		expectAllChildrenUnrefd();
	});

	it("does not spawn (nothing to unref) when the registry is disabled", async () => {
		h.state.enabled = false;
		await sweepUntrackedOrphans({ getServers: async () => LSP_SERVERS });
		await sweepOrphans();
		expect(h.spawned).toHaveLength(0);
	});
});

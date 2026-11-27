/**
 * #3917: no test reaches the HOST process table through the orphan backstop.
 *
 * `index.ts` arms `scheduleUntrackedOrphanSweep` on every real primary
 * `session_start`. The sweep enumerates the machine's whole process table and
 * kills a foreign orphan whose owner is dead, and the #2042 kill guard then
 * fails the file at teardown although every test passed (the #3521 fork-tree
 * file, 2026-09-30). `tests/support/vitest-setup.ts` scopes the backstop's
 * `Name`-filtered table query to an empty table for every file; a suite that
 * needs the real table opts in with `vi.unmock("…/process-snapshot.js")`
 * (tests/clients/instance-reaper-unref.test.ts, whose real enumeration spawn
 * reds without it, is the no-drop witness for that arm).
 *
 * Recurrence this file pins: the scope silently stops covering the sweep (the
 * setup mock deleted, or `enumerateManagedProcesses` changing the column it
 * filters on) and the next real `session_start` in any of the 36 files that arm
 * the sweep enumerates the host again.
 *
 * This drives the real `index.ts` `session_start` and the real sweep body (lock,
 * stamp, enumeration, partition, outcome). The delay seam is the
 * scheduler's own: a wrapper hands the sweep a zero delay and its documented
 * `onComplete` observer. The only fake sits at the process boundary
 * (`child-unref.js`'s spawn): a process-listing spawn is recorded and answers
 * an empty table, so even a broken scope cannot hand a real host process to the
 * sweep's kill.
 *
 * #5267 adds the arm the setup mock cannot reach. pi loads the extension by
 * path, on its own module graph, so the tier-2 harness session (`
 * tests/support/pi-session.ts`) runs a SECOND copy of the reaper that the empty
 * table above does not cover: its `session_start` arms a real sweep against the
 * machine's real process table. The second case plants the population that copy
 * would kill, and pins the harness opt-out that keeps it from arming at all.
 */
// flake-shape: real-process-spawn — the #5267 case plants two real fixture
// processes carrying dead-owner tags, because its claim is that the loaded
// copy's backstop never signals them; an empty mocked table cannot answer what
// a real sweep does to a real candidate.
// flake-shape: raw-timer-wait — the #5267 case holds the real 30 s arm delay
// and the real 60 s spawn grace, because its claim is that no sweep ran inside
// that window. The timer belongs to the loaded copy, so a fake clock on this
// side cannot advance it or prove it never fired.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: {
			recordToolCall: () => {},
			formatWarnings: () => "",
		},
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: () => null,
		},
	}));
});
// The sweep is armed by index.ts itself, not by the session handler.
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async () => {},
}));

const seam = vi.hoisted(() => {
	let complete: (outcome: string) => void = () => {};
	return {
		/** Settles with the backstop sweep's outcome, via its `onComplete` seam. */
		completed: new Promise<string>((resolve) => {
			complete = resolve;
		}),
		complete: (outcome: string) => complete(outcome),
		/** Every process-listing spawn that reached the process boundary. */
		listings: [] as string[],
	};
});

vi.mock("../clients/instance-reaper.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../clients/instance-reaper.js")>();
	return {
		...original,
		scheduleUntrackedOrphanSweep: (
			_delayMs?: number,
			options: import("../clients/instance-reaper.js").BackstopSweepOptions = {},
		) =>
			original.scheduleUntrackedOrphanSweep(0, {
				...options,
				onComplete: (outcome) => {
					seam.complete(outcome);
					options.onComplete?.(outcome);
				},
			}),
	};
});

vi.mock("../clients/child-unref.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../clients/child-unref.js")>();
	return {
		...original,
		spawnCollectStdoutResult: (
			...args: Parameters<typeof original.spawnCollectStdoutResult>
		) => {
			const image = path.basename(args[0]).toLowerCase();
			if (image !== "ps" && image !== "powershell.exe") {
				return original.spawnCollectStdoutResult(...args);
			}
			seam.listings.push(image);
			return Promise.resolve({ stdout: "", status: "ok" as const });
		},
	};
});

import extension from "../index.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { readProcessStart } from "../clients/process-snapshot.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./clients/test-utils.js";
import { takeKillGuardViolationsForTest } from "./support/kill-guard.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { piSessionFixture, startPiSession } from "./support/pi-session.js";
import { isProcessAlive, killProcessTree } from "./support/process-tree.js";

const TMP_PREFIX = "pi-lens-3917-scope-";

describe("#3917 the default scope keeps the orphan sweep off the host process table", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let previousHome: string | undefined;
	let previousDataDir: string | undefined;
	let previousOptOut: string | undefined;

	beforeEach(() => {
		_resetSessionLifecycleForTests();
		// The #5267 case below arms the harness opt-out through `startPiSession`,
		// and that pin outlives its case until the harness's `afterAll`. In a
		// shuffled file an early #5267 run would hand THIS case an opted-out
		// process, `original.scheduleUntrackedOrphanSweep(0, …)` would return
		// undefined, `onComplete` would never fire and the case would time out
		// (CI "Changed tests shuffled (advisory)", seed 202 — the recurrence).
		// This case arms the sweep in-process and needs the key unset; save it,
		// delete it, and hand it back so the harness pin stays intact for the
		// rest of the worker.
		previousOptOut = process.env.PI_LENS_DISABLE_ORPHAN_BACKSTOP;
		delete process.env.PI_LENS_DISABLE_ORPHAN_BACKSTOP;
		env = setupTestEnvironment(TMP_PREFIX);
		// The stamp, lock and registry of this file's sweep live in its own home:
		// a sibling's fresh stamp would answer `cooldown` with no scan at all.
		previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = path.join(env.tmpDir, "home");
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	});

	afterEach(async () => {
		// #5146: end the session before the lifecycle state and the root go.
		await endMockSessions();
		if (previousOptOut === undefined)
			delete process.env.PI_LENS_DISABLE_ORPHAN_BACKSTOP;
		else process.env.PI_LENS_DISABLE_ORPHAN_BACKSTOP = previousOptOut;
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		_resetSessionLifecycleForTests();
		env.cleanup();
		await cleanupTestEnvironmentsDrained(TMP_PREFIX);
	});

	it("a real session_start's sweep runs to its end without reaching the process table", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			{ reason: "startup" },
			makeCtx({ cwd: env.tmpDir, sessionId: "s-3917" }),
		);

		expect({ outcome: await seam.completed, listings: seam.listings }).toEqual({
			outcome: "clean",
			listings: [],
		});
	});
});

// ---------------------------------------------------------------------------
// #5267 — the arm the setup mock cannot reach: a host session's own copy.
// ---------------------------------------------------------------------------

/**
 * pi loads the extension by path (`EXTENSION_ENTRY`), so a tier-2 harness
 * session runs a SECOND copy of `clients/instance-reaper.js`, on the host's
 * module graph. The empty table this file installs above — and the one in
 * `tests/support/vitest-setup.ts` — are scoped to the vitest graph, so the
 * copy's `session_start` arms a real sweep against the real process table.
 *
 * The copy's sweep is not hypothetical. Its candidate rule is
 * "pi-lens-managed binary, untracked by this registry, owner tag whose pid is
 * dead", and a harness session manufactures all three: every fixture process it
 * spawns carries an owner tag, and the harness reaps its children long before
 * the tag's pid stops existing. On the dev box and on a runner, the process the
 * sweep then SIGKILLs belongs to whoever is running the suite. That is defect
 * shape 50 and the #2042 kill-guard shape; #5294 answered it by seeding the
 * machine-wide cooldown stamp, and this case pins the narrow backstop beneath
 * that: `PI_LENS_DISABLE_ORPHAN_BACKSTOP`, read at arm time.
 *
 * The case therefore REMOVES the stamp right after the start, so the only thing
 * standing between the sweep and the planted population is the opt-out. That is
 * also the state the primary defense cannot hold: the production cooldown is 30
 * minutes, so any host that lives past one (a long-running editor session, a
 * home restored from a fixture) reaches it on its own.
 *
 * What is planted, and why it is the right shape:
 *  - the owner is a real process that exits, leaving a real dead pid, and its
 *    OS start spelling is read while it is alive — the same tag production
 *    writes (`<pid>:<start>`, `clients/process-snapshot.ts`);
 *  - the orphan is a real `sleep` whose argv0 names a managed binary, hanging
 *    off a shell this worker owns rather than off the worker itself. The
 *    grandchild position is deliberate: the kill guard's ownership oracle is
 *    `PPid == this pid`, so a direct child would be one the guard LOVES to see
 *    killed and the incident would go unrecorded. A real orphan whose owner died
 *    is exactly a process this pid does not own.
 *
 * Red on master, in one assertion: the recorded kill violation (the #2042
 * report's own record, `site: "kill"`, at the planted pid and its process-group
 * mirror), the `orphan_backstop_reaped` row the copy writes with its counts, the
 * cooldown stamp it claims to have swept, and — on a platform without the
 * guard's swallow — the body count itself. Every one of those is empty after the
 * opt-out, on every platform, because nothing runs.
 */
const fixture = piSessionFixture();

/** `clients/instance-reaper.ts` keeps these module-private; the case names them. */
const BACKSTOP_ARM_DELAY_MS = 30_000; // BACKSTOP_START_DELAY_MS
const BACKSTOP_SPAWN_GRACE_MS = 60_000; // BACKSTOP_SPAWN_GRACE_MS
/** Margin so a late timer or a slow enumeration cannot land the read before the sweep. */
const OBSERVE_MARGIN_MS = 8_000;
/** Longer than the case needs, short enough that a leaked decoy is gone in minutes. */
const DECOY_LIFE_S = 300;
/** argv0 only: the binary is `/bin/sleep`, so nothing here can run a real analyzer. */
const DECOY_ARGV0 = "ast-grep-5267-decoy";

interface PlantedDecoy {
	/** The shell this worker spawned; owns `pid` as its child. */
	readonly shell: ChildProcess;
	/** The planted orphan: a grandchild, so the guard sees an unowned pid. */
	readonly pid: number;
}

/** Real wall-clock time, because the timer under test belongs to the copy. */
function realWait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * A tag whose owner is a pid this case has watched die. The start is read from
 * the OS while the owner is alive, exactly as `ownerTagForChildren` reads it for
 * a child it is about to spawn.
 */
async function plantDeadOwnerTag(): Promise<string> {
	const owner = spawn("/bin/sleep", ["0.2"], { stdio: "ignore" });
	const ownerPid = owner.pid;
	if (ownerPid === undefined)
		throw new Error("decoy owner: the spawn reported no pid");
	const start = await readProcessStart(ownerPid, { timeoutMs: 5_000 });
	await once(owner, "exit");
	if (start === undefined)
		throw new Error(
			`decoy owner ${ownerPid}: no OS start spelling to tag with`,
		);
	if (isProcessAlive(ownerPid))
		throw new Error(`decoy owner ${ownerPid}: still alive after exit`);
	return `${ownerPid}:${start}`;
}

/**
 * Plant one orphan carrying `ownerTag`: a `sleep` execed under a managed-binary
 * argv0, backgrounded off a shell this worker owns so its parent is not this
 * worker. The shell prints the child's pid, which is what the sweep sees.
 */
function plantDecoy(ownerTag: string): Promise<PlantedDecoy> {
	return new Promise((resolve, reject) => {
		// The name rides in the environment, never in a shell's argv: a shell
		// whose command line spells the managed binary is a candidate itself, and
		// the sweep would then kill this worker's OWN shells beside the planted
		// orphans. Only the execed leaf carries the name.
		const shell = spawn(
			"/bin/bash",
			[
				"-c",
				`bash -c 'exec -a "$DECOY_ARGV0" sleep "$DECOY_LIFE_S"' & echo $!; wait`,
			],
			{
				stdio: ["ignore", "pipe", "ignore"],
				env: {
					...process.env,
					PI_LENS_OWNER: ownerTag,
					DECOY_ARGV0,
					DECOY_LIFE_S: String(DECOY_LIFE_S),
				},
			},
		);
		let out = "";
		shell.stdout.setEncoding("utf8");
		shell.stdout.on("data", (chunk: string) => {
			out += chunk;
			const reported = /^\s*(\d+)\s*$/m.exec(out);
			if (reported) resolve({ shell, pid: Number(reported[1]) });
		});
		shell.once("error", reject);
		shell.once("close", (code) =>
			reject(
				new Error(
					`decoy shell exited (code ${String(code)}) before reporting its child: ${JSON.stringify(out)}`,
				),
			),
		);
	});
}

describe("#5267 the harness opts the loaded copy out of arming the backstop", () => {
	const planted: PlantedDecoy[] = [];

	afterEach(() => {
		// Each decoy leaves with its shell. `killProcessTree` snapshots the tree
		// and adopts it into the #2042 guard BEFORE it signals, which is the only
		// way this worker may signal a grandchild it planted (#4081); an adoption
		// earlier than this would have blinded the guard for the window the case
		// is watching.
		for (const decoy of planted.splice(0)) killProcessTree(decoy.shell);
	});

	it(
		"plants a killable population, and the copy never arms a sweep against it",
		async () => {
			const ownerTag = await plantDeadOwnerTag();
			const decoys = [await plantDecoy(ownerTag), await plantDecoy(ownerTag)];
			planted.push(...decoys);
			const targets = decoys.flatMap((decoy) => [decoy.pid, -decoy.pid]);

			// A candidate is eligible once it is older than the spawn grace, and
			// the sweep looks `BACKSTOP_ARM_DELAY_MS` after the start, so the
			// population ages first and the session starts inside the grace's tail.
			await realWait(BACKSTOP_SPAWN_GRACE_MS - BACKSTOP_ARM_DELAY_MS + 5_000);

			const handle = await startPiSession({
				root: fixture.root,
				responses: [],
			});
			const stampPath = path.join(fixture.root, "home", "orphan-backstop.json");
			// Take the primary defense away so the backstop is the only thing left
			// (see the header). The copy read no stamp yet: it reads one only when
			// its timer fires, 30 s from now.
			fs.rmSync(stampPath, { force: true });

			await realWait(BACKSTOP_ARM_DELAY_MS + OBSERVE_MARGIN_MS);

			// The guard's records for the planted pids. `take…` is the guard's own
			// seam for a case that provokes a violation at a named pid on purpose:
			// it returns them here, where the diff names the production kill site,
			// instead of leaving them for the file-level #2042 report.
			const violations = takeKillGuardViolationsForTest(targets);
			const rows = await handle.latencyRows();
			const backstopRows = rows.rows.filter(
				(row) => row.phase === "orphan_backstop_reaped",
			);
			const deadDecoys = decoys
				.filter((decoy) => !isProcessAlive(decoy.pid))
				.map((decoy) => decoy.pid);

			expect({
				violations,
				backstopRows,
				sweepStampWritten: fs.existsSync(stampPath),
				deadDecoys,
			}).toEqual({
				violations: [],
				backstopRows: [],
				sweepStampWritten: false,
				deadDecoys: [],
			});

			await handle.dispose();
		},
		4 * 60_000,
	);
});

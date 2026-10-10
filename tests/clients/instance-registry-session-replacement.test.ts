/**
 * #3498: this process's `instances.json` entry across a session replacement.
 *
 * pi's `switchSession` keeps the process and rebuilds the runtime in the
 * resumed session's cwd, so session 1 (root A) ends and session 2 (root B)
 * starts in one process. The registry tail and the registration intent are
 * process singletons and carry over. Each case replays one counterexample of
 * the `SessionRegistry` model (`formal/session-registry/`) on the real
 * registry, the real generation lock and a temp registry directory:
 *
 * - own hold: shutdown lands while this process's heartbeat holds the lock;
 * - late landing: a registration waiting on a peer's lock lands after
 *   shutdown removed the entry;
 * - stale intent: a registration queued before shutdown starts after it,
 *   points the heartbeat's repair at the ended root, and the live root is
 *   never repaired;
 * - peer hold: a peer holds the lock past the sync wait and one async wait.
 *
 * "A peer" is a pre-#3476 lock file owned by this worker's parent, a live pid
 * that is not this process: the generation holder backs off while it exists.
 * `getGlobalPiLensDir` points at a per-test temp dir, so nothing here touches
 * the real `~/.pi-lens/instances.json`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { waitFor } from "./interleaving-kit.js";
import { removeTempDirSync } from "./test-utils.js";

let dir: string;

vi.mock("../../clients/file-utils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/file-utils.js")>()),
	getGlobalPiLensDir: () => dir,
}));

const ROOT_A = "/repo/session-1";
const ROOT_B = "/repo/session-2";
/** A declined secondary's root (#2130), served beside session 1's. */
const ROOT_SECONDARY = "/repo/temp-sub";

type Registry = typeof import("../../clients/instance-registry.js");
type Ledger = typeof import("../../clients/degradation-ledger.js");

let registry: Registry;
let ledger: Ledger;

function registryFilePath(): string {
	return path.join(dir, "instances.json");
}

function peerLockPath(): string {
	return `${registryFilePath()}.lock`;
}

/** A live writer that is not this process takes the registry lock. */
function peerHolds(ageMs = 0): void {
	fs.writeFileSync(peerLockPath(), `${process.ppid} ${Date.now()}\n`);
	if (ageMs > 0) {
		const at = new Date(Date.now() - ageMs);
		fs.utimesSync(peerLockPath(), at, at);
	}
}

function peerReleases(): void {
	fs.rmSync(peerLockPath(), { force: true });
}

/** This process's entry, or undefined when it has none. */
function ownEntry():
	| { projectRoot: string; projectRoots: string[] }
	| undefined {
	if (!fs.existsSync(registryFilePath())) return undefined;
	const file = JSON.parse(fs.readFileSync(registryFilePath(), "utf8")) as {
		instances: Array<{
			pid: number;
			projectRoot: string;
			projectRoots: string[];
		}>;
	};
	return file.instances.find((entry) => entry.pid === process.pid);
}

function degradationCount(kind: string): number {
	return (
		ledger.getDegradationSummary().find((group) => group.kind === kind)
			?.count ?? 0
	);
}

/** Session 2 starts in root B; its entry must hold B alone. */
async function expectSessionTwoRegistersAlone(): Promise<void> {
	await registry.registerInstance(ROOT_B);
	expect(ownEntry()).toMatchObject({
		projectRoot: normalizeFilePath(ROOT_B),
		projectRoots: [normalizeFilePath(ROOT_B)],
	});
}

// Shared by both describes below: a fresh registry dir and module graph per case.
beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-instreg-"));
	vi.resetModules();
	registry = await import("../../clients/instance-registry.js");
	ledger = await import("../../clients/degradation-ledger.js");
});

afterEach(async () => {
	vi.restoreAllMocks();
	peerReleases();
	// The tail is a process singleton: settle it here so nothing queued by
	// one case lands in the next case's directory.
	await registry._settleRegistryMutationsForTests();
	removeTempDirSync(dir);
});

describe("instance registry across a session replacement (#3498)", () => {
	/**
	 * session_shutdown arrives while the heartbeat's read of the registry is in
	 * flight, i.e. while the heartbeat holds the registry lock. The sync
	 * removal cannot take a lock this process holds.
	 */
	async function shutdownDuringHeartbeat(): Promise<void> {
		const readFile = fs.promises.readFile.bind(fs.promises);
		let shutdownRan = false;
		vi.spyOn(fs.promises, "readFile").mockImplementation((async (
			...args: Parameters<typeof fs.promises.readFile>
		) => {
			if (!shutdownRan && args[0] === registryFilePath()) {
				shutdownRan = true;
				registry.deregisterInstance();
			}
			return readFile(...args);
		}) as typeof fs.promises.readFile);
		await registry.updateHeartbeat();
		vi.restoreAllMocks();
		await registry._settleRegistryMutationsForTests();
		expect(shutdownRan).toBe(true);
	}

	/**
	 * The #3587 sibling of `shutdownDuringHeartbeat`: a declined secondary's
	 * root removal is requested while the heartbeat's read of the registry is
	 * in flight. `deregisterInstanceRoot` (unlike `deregisterInstance`)
	 * already runs on the registry tail — and since #3602, so does
	 * `updateHeartbeat` — so this no longer races the heartbeat for the file
	 * lock: it queues behind it and starts its sync attempt only once the
	 * heartbeat's mutation has fully resolved (lock released). See "queues a
	 * secondary root's removal behind an in-flight heartbeat" below.
	 */
	async function rootRemovalDuringHeartbeat(root: string): Promise<void> {
		const readFile = fs.promises.readFile.bind(fs.promises);
		let removalStarted = false;
		vi.spyOn(fs.promises, "readFile").mockImplementation((async (
			...args: Parameters<typeof fs.promises.readFile>
		) => {
			if (!removalStarted && args[0] === registryFilePath()) {
				removalStarted = true;
				void registry.deregisterInstanceRoot(root, "holder-1");
			}
			return readFile(...args);
		}) as typeof fs.promises.readFile);
		await registry.updateHeartbeat();
		vi.restoreAllMocks();
		await registry._settleRegistryMutationsForTests();
		expect(removalStarted).toBe(true);
	}

	it("removes the entry when shutdown lands while this process's heartbeat holds the lock", async () => {
		await registry.registerInstance(ROOT_A);
		await shutdownDuringHeartbeat();

		expect(ownEntry()).toBeUndefined();
		// The sync removal does not wait out a lock this process holds: the
		// holder needs the event loop that wait would block.
		expect(degradationCount("instance-registry-lock-own-hold")).toBe(1);
		expect(degradationCount("instance-registry-lock-timeout")).toBe(0);
		expect(
			ledger
				.getDegradationSummary()
				.find((group) => group.kind === "instance-registry-deregister-queued")
				?.latestReasons[0]?.reason,
		).toMatch(/queued behind the holder/);
		expect(degradationCount("instance-registry-deregister-landed")).toBe(1);
		await expectSessionTwoRegistersAlone();
	});

	it("drops a registration that was waiting on a peer's lock when shutdown removed the entry", async () => {
		peerHolds();
		// session_start's `void registerInstance(cwd)`: it starts, then waits.
		const registration = registry.registerInstance(ROOT_A);
		await waitFor(
			() => degradationCount("instance-registry-lock-legacy-held"),
			(count) => count >= 1,
		);
		peerReleases();
		registry.deregisterInstance(); // the lock is free: the removal runs now
		await registration;

		expect(ownEntry()).toBeUndefined();
		// The sync removal took the lock, so nothing was queued behind it.
		expect(degradationCount("instance-registry-deregister-queued")).toBe(0);
		expect(
			ledger
				.getDegradationSummary()
				.find(
					(group) => group.kind === "instance-registry-registration-superseded",
				)?.latestReasons[0]?.subject,
		).toBe(normalizeFilePath(ROOT_A));
		await expectSessionTwoRegistersAlone();
	});

	it("does not re-create the ended session's entry from an LSP child recorded before shutdown", async () => {
		// An LSP spawn in the turn a session switch interrupts: its
		// fire-and-forget record is still queued when session 1 ends, and it
		// carries session 1's root as a service cwd (clients/lsp/client.ts).
		const recorded = registry.recordLspChild({
			pid: process.pid + 1,
			serverId: "fake-ts",
			command: "fake-tsserver",
			sessionIdentity: {
				projectRoot: ROOT_A,
				rootSource: "service-cwd",
				startedAt: new Date().toISOString(),
			},
		});
		registry.deregisterInstance();
		await recorded;

		expect(ownEntry()).toBeUndefined();
		await expectSessionTwoRegistersAlone();
	});

	it("does not point the heartbeat's repair at the ended root when a secondary's removal lands after shutdown", async () => {
		await registry.registerInstance(ROOT_A);
		await registry.registerInstanceRoot(ROOT_SECONDARY, "holder-1");
		// A peer holds the lock. A declined secondary's shutdown is queued, then
		// session 1 ends: its sync removal cannot take the lock and queues
		// behind the secondary's removal.
		peerHolds();
		const secondaryRemoval = registry.deregisterInstanceRoot(
			ROOT_SECONDARY,
			"holder-1",
		);
		registry.deregisterInstance();
		peerReleases();
		await secondaryRemoval;
		await registry._settleRegistryMutationsForTests();
		expect(ownEntry()).toBeUndefined();

		// Session 2's heartbeat, before its own registration lands.
		await registry.updateHeartbeat();
		await registry._settleRegistryMutationsForTests();
		expect(ownEntry()).toBeUndefined();
		await expectSessionTwoRegistersAlone();
	});

	// #3602: before that fix, `updateHeartbeat` took the registry lock
	// directly (off the tail), so a root removal requested while it held the
	// lock met this process's OWN hold — the #3587 shape this file's own
	// mutation table (PR #3593/#3587's R1) exercises via a peer instead below.
	// Now `updateHeartbeat` is queued through the SAME tail as
	// `deregisterInstanceRoot`, so the two can never hold the lock at once:
	// the removal simply waits its turn and takes the single async lock path
	// once it is the removal's turn.
	it("queues a secondary root's removal behind an in-flight heartbeat instead of racing it for the lock", async () => {
		await registry.registerInstance(ROOT_A);
		await registry.registerInstanceRoot(ROOT_SECONDARY, "holder-1");
		await rootRemovalDuringHeartbeat(ROOT_SECONDARY);

		// Queued behind the heartbeat's own tail slot, not contended for the
		// lock: the single async lock path lands without a retry or timeout.
		expect(degradationCount("instance-registry-lock-timeout")).toBe(0);
		expect(degradationCount("instance-registry-deregister-landed")).toBe(1);
		expect(ownEntry()?.projectRoots).toEqual([normalizeFilePath(ROOT_A)]);
	});

	it("still points the heartbeat's repair at a root the live session keeps serving", async () => {
		// The inverse of the case above: with no shutdown in between, removing
		// one root re-arms the intent on a root the host still serves (#2130),
		// so a later repair brings back the live root, not the one that left.
		await registry.registerInstance(ROOT_A);
		await registry.registerInstanceRoot(ROOT_B, "holder-1");
		await registry.deregisterInstanceRoot(ROOT_B, "holder-1");
		fs.writeFileSync(registryFilePath(), JSON.stringify({ instances: [] }));

		await registry.updateHeartbeat();
		await registry._settleRegistryMutationsForTests();
		expect(ownEntry()?.projectRoots).toEqual([normalizeFilePath(ROOT_A)]);
	});

	it("keeps another incarnation's entry on this pid when the queued removal lands", async () => {
		await registry.registerInstance(ROOT_A);
		// An entry a crashed earlier instance left on this pid (#3538): the
		// same pid, another start time. It is not this process's to remove.
		const file = JSON.parse(fs.readFileSync(registryFilePath(), "utf8")) as {
			instances: Array<Record<string, unknown>>;
		};
		file.instances.push({
			...file.instances[0],
			processStart: "another-incarnation",
			projectRoot: "/repo/crashed",
			projectRoots: ["/repo/crashed"],
		});
		fs.writeFileSync(registryFilePath(), JSON.stringify(file));

		await shutdownDuringHeartbeat();

		const left = (
			JSON.parse(fs.readFileSync(registryFilePath(), "utf8")) as {
				instances: Array<{ pid: number; processStart?: string }>;
			}
		).instances.filter((entry) => entry.pid === process.pid);
		expect(left.map((entry) => entry.processStart)).toEqual([
			"another-incarnation",
		]);
	});

	it("never points the heartbeat's repair at an ended session's root, and repairs the live one", async () => {
		// Session 1's registration is still queued when session 1 ends, so it
		// starts after the shutdown.
		const registration = registry.registerInstance(ROOT_A);
		registry.deregisterInstance();
		await registration;
		// Session 2's heartbeat runs before its own registration: nothing of
		// session 1 may come back.
		await registry.updateHeartbeat();
		await registry._settleRegistryMutationsForTests();
		expect(ownEntry()).toBeUndefined();

		// Session 2's registration is dropped by a peer's hold (#3447)...
		peerHolds();
		await registry.registerInstance(ROOT_B);
		peerReleases();
		expect(ownEntry()).toBeUndefined();
		// ...and its heartbeat repairs the live root.
		await registry.updateHeartbeat();
		await registry._settleRegistryMutationsForTests();
		expect(ownEntry()).toMatchObject({
			projectRoot: normalizeFilePath(ROOT_B),
			projectRoots: [normalizeFilePath(ROOT_B)],
		});
	});

	it("removes the entry after a peer holds the lock past the sync wait and one async wait", async () => {
		await registry.registerInstance(ROOT_A);
		// A live peer whose lock file ages out of the 5 s lease about 2 s from
		// now: longer than the 500 ms sync wait plus one 500 ms async wait.
		peerHolds(3_000);
		registry.deregisterInstance();
		await registry._settleRegistryMutationsForTests();

		expect(ownEntry()).toBeUndefined();
		await expectSessionTwoRegistersAlone();
	}, 15_000);

	it("removes a secondary root after a peer holds the lock past the sync wait and one async wait", async () => {
		await registry.registerInstance(ROOT_A);
		await registry.registerInstanceRoot(ROOT_SECONDARY, "holder-1");
		// Same shape as the whole-entry case above: the peer's lock ages out of
		// the 5 s lease about 2 s from now, but inside
		// `LOCK_WAIT_THROUGH_LEASE_MS`.
		peerHolds(3_000);
		const removal = registry.deregisterInstanceRoot(ROOT_SECONDARY, "holder-1");
		await removal;
		await registry._settleRegistryMutationsForTests();

		expect(ownEntry()?.projectRoots).toEqual([normalizeFilePath(ROOT_A)]);
		// #3618 recurrence: scoped removal must not perform a discarded
		// synchronous lock spin before its lease-waiting lock.
		expect(degradationCount("instance-registry-lock-timeout")).toBe(0);
	}, 15_000);
});

/**
 * #3780 (the #3657 mutation survivors): what a scoped root removal decides,
 * observed through the real registry, its ledger and the heartbeat's repair.
 * The recurrence guarded: `planRootRemoval` kept every branch of its decision
 * alive under mutation because each case above reads only the happy outcome
 * (the entry lost its root) and never the records, the peer entries beside it,
 * or the intent a removal of a root that was never served must leave alone.
 */
describe("a scoped root removal's decision (#3587)", () => {
	function landedReasons(): string[] {
		return (
			ledger
				.getDegradationSummary()
				.find((group) => group.kind === "instance-registry-deregister-landed")
				?.latestReasons.map((row) => row.reason) ?? []
		);
	}

	it("says the last holder freed a served root", async () => {
		await registry.registerInstance(ROOT_A);
		await registry.registerInstanceRoot(ROOT_SECONDARY, "holder-1");

		await registry.deregisterInstanceRoot(ROOT_SECONDARY, "holder-1");

		expect(landedReasons()).toEqual([
			expect.stringContaining("last holder left; root freed"),
		]);
	});

	it("records a kept root and a final free as distinct root decisions (#3849 F6)", async () => {
		await registry.registerInstance(ROOT_A);
		await registry.registerInstanceRoot(ROOT_SECONDARY, "holder-1");
		await registry.registerInstanceRoot(ROOT_SECONDARY, "holder-2");

		await registry.deregisterInstanceRoot(ROOT_SECONDARY, "holder-1");
		expect(landedReasons()).toEqual([
			expect.stringContaining("holder left; another holder keeps the root"),
		]);

		await registry.deregisterInstanceRoot(ROOT_SECONDARY, "holder-2");
		expect(landedReasons()).toEqual([
			expect.stringContaining("last holder left; root freed"),
		]);
	});

	it("says there was nothing left to remove, and writes nothing, for a root never served", async () => {
		await registry.registerInstance(ROOT_A);
		const before = fs.readFileSync(registryFilePath(), "utf8");

		await registry.deregisterInstanceRoot(ROOT_B, "holder-1");

		expect(landedReasons()).toEqual([
			expect.stringContaining("nothing left to remove"),
		]);
		expect(fs.readFileSync(registryFilePath(), "utf8")).toBe(before);
	});

	it("leaves a peer's entry alone when it rewrites this process's entry", async () => {
		await registry.registerInstance(ROOT_A);
		await registry.registerInstanceRoot(ROOT_SECONDARY, "holder-1");
		const file = JSON.parse(fs.readFileSync(registryFilePath(), "utf8")) as {
			instances: Array<Record<string, unknown>>;
		};
		const peer = {
			...file.instances[0],
			pid: process.ppid,
			processStart: "a-peer",
			projectRoot: "/repo/peer",
			projectRoots: ["/repo/peer", "/repo/peer-second"],
		};
		file.instances.push(peer);
		fs.writeFileSync(registryFilePath(), JSON.stringify(file));

		await registry.deregisterInstanceRoot(ROOT_SECONDARY, "holder-1");

		const after = JSON.parse(fs.readFileSync(registryFilePath(), "utf8")) as {
			instances: Array<{ pid: number; projectRoots: string[] }>;
		};
		expect(after.instances.find((e) => e.pid === process.ppid)).toEqual(peer);
		expect(ownEntry()?.projectRoots).toEqual([normalizeFilePath(ROOT_A)]);
	});

	describe("when this process's entry is already gone", () => {
		async function entryGoneAfterRegistering(): Promise<void> {
			await registry.registerInstance(ROOT_A);
			fs.writeFileSync(registryFilePath(), JSON.stringify({ instances: [] }));
		}

		it("stops the heartbeat from re-registering the root that was just removed", async () => {
			await entryGoneAfterRegistering();

			await registry.deregisterInstanceRoot(ROOT_A, "holder-1");
			await registry.updateHeartbeat();
			await registry._settleRegistryMutationsForTests();

			expect(ownEntry()).toBeUndefined();
		});

		it("keeps the heartbeat's repair intent when the removed root is another one", async () => {
			await entryGoneAfterRegistering();

			await registry.deregisterInstanceRoot(ROOT_B, "holder-1");
			await registry.updateHeartbeat();
			await registry._settleRegistryMutationsForTests();

			expect(ownEntry()?.projectRoots).toEqual([normalizeFilePath(ROOT_A)]);
		});

		it("lands the removal with no intent to consult", async () => {
			await registry.registerInstance(ROOT_A);
			registry.deregisterInstance();

			await registry.deregisterInstanceRoot(ROOT_B, "holder-1");

			expect(landedReasons()).toEqual([
				expect.stringContaining("nothing left to remove"),
			]);
		});
	});
});

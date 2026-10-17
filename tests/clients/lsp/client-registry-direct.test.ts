// flake-shape: service-double — LSPClientInfo is a spawned language-server process; the registry's capacity, lease and idle paths are driven by its liveness and busy answers, which a real server cannot be made to give on demand
// flake-shape: in-process-mock — the ring getRecentLoggedPhases reads keeps only phase and metadata, and test mode skips the file sink; the registry's filePath and durationMs fields are asserted from the captured call
// flake-shape: in-process-mock — createLSPClient wraps the language-server child process (JSON-RPC over stdio); the registry's spawn bookkeeping is the subject, the process is the boundary
/**
 * #4449: the extracted ClientRegistry (clients/lsp/client-registry.ts, #4374)
 * driven directly. Every other test reaches the registry through LSPService, so
 * a mutant in the registry survived unless that service path happened to assert
 * it. The Stryker per-test campaign of #4449 (run ids in the PR body) listed the
 * survivors this file pins; each test names the mutant class it keeps out.
 *
 * Real objects throughout: the registry class, its maps, the session-root
 * registry and the degradation ledger. The only fakes sit at the process
 * boundary: the LSP client (`createLSPClient`, a spawned language server) and
 * the server's `spawn()`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBoundedTelemetry } from "../../../clients/bounded-telemetry.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import type { LSPClientInfo } from "../../../clients/lsp/client.js";
import { initLSPConfig } from "../../../clients/lsp/config.js";
import {
	ClientRegistry,
	getLspClientCeiling,
	getLspIdleEvictMs,
	getLspIdleEvictMsForRoot,
	mergeInitializationOptions,
	type ClientGenerationHooks,
	type SpawnedServer,
} from "../../../clients/lsp/client-registry.js";
import {
	_markDirectLspCommandUnavailableForTests,
	resetDirectLspCommandAvailability,
	type LSPServerInfo,
} from "../../../clients/lsp/server.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import {
	registerSessionRoot,
	resetSessionRootsForTests,
} from "../../../clients/lsp/session-roots.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	_clearSuccessfulLspSpawnHistoryForTests,
	getSuccessfulLspSpawnDurationMs,
} from "../../../clients/lsp/spawn-history.js";
import {
	clearWidgetState,
	getFailedLspServerIds,
} from "../../../clients/widget-state.js";
import { removeTempDirSync } from "../test-utils.js";

process.env.PI_LENS_TEST_MODE = "1";

const createLSPClient = vi.hoisted(() => vi.fn());
const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

type FakeClient = LSPClientInfo & {
	shutdown: ReturnType<typeof vi.fn>;
	setBusy(busy: boolean): void;
	/** Dies with a recorded death time (the real client stamps it on exit). */
	die(at?: number): void;
	/** Dies without a recorded death time (defensive path in the registry). */
	kill(): void;
};

/** A language-server client: the process boundary, so a fake is allowed. */
function fakeClient(
	serverId: string,
	root: string,
	opts: { busy?: boolean } = {},
): FakeClient {
	let alive = true;
	let busy = opts.busy === true;
	let exitedAt: number | undefined;
	const client = {
		serverId,
		root,
		isAlive: () => alive,
		isBusy: () => busy,
		wasShutdownIntentional: () => false,
		kill: () => {
			alive = false;
		},
		getExitedAt: () => exitedAt,
		shutdown: vi.fn(async () => undefined),
		setBusy: (next: boolean) => {
			busy = next;
		},
		die: (at: number = Date.now()) => {
			exitedAt = at;
			alive = false;
		},
	};
	return client as unknown as FakeClient;
}

function server(
	id: string,
	extra: Record<string, unknown> = {},
): LSPServerInfo {
	return {
		id,
		name: id,
		extensions: [".fake"],
		root: async () => process.cwd(),
		spawn: async () => undefined,
		...extra,
	} as unknown as LSPServerInfo;
}

/** Records the service-side hooks the registry calls, in order. */
function makeHooks() {
	const calls: string[] = [];
	const hooks: ClientGenerationHooks = {
		releaseNotifyWrite: (key) => calls.push(`releaseNotifyWrite:${key}`),
		forgetReadiness: (key) => calls.push(`forgetReadiness:${key}`),
		forgetNotifyBacklog: (key) => calls.push(`forgetNotifyBacklog:${key}`),
		clearStallDemotion: (key) => calls.push(`clearStallDemotion:${key}`),
		rearmFirstContact: (id) => calls.push(`rearmFirstContact:${id}`),
		noteDiagnosticsPublished: (id) => calls.push(`diagnostics:${id}`),
	};
	return { calls, hooks };
}

/** The registry's private surface the survivors live on. */
type Internals = {
	clientLeases: Map<string, number>;
	clientLastUsedAt: Map<string, number>;
	adoptedClientKeys: Set<string>;
	adoptedRootLastUsedAt: Map<string, number>;
	idleEvictionTimers: Map<string, ReturnType<typeof setTimeout>>;
	admitAdoptedRoot(root: string, filePath: string): boolean;
	makeCapacityForClient(key: string): Promise<boolean>;
};

const internals = (registry: ClientRegistry) =>
	registry as unknown as Internals;

const dirs: string[] = [];
function tempProject(prefix: string, withMarker = true): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(process.cwd(), `.probe-reg4449-${prefix}-`)),
	);
	if (withMarker) fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
	dirs.push(dir);
	return dir;
}

beforeEach(() => {
	resetSessionRootsForTests();
	resetDegradationLedger();
	resetBoundedTelemetry();
	resetDirectLspCommandAvailability();
	createLSPClient.mockReset();
	logLatency.mockClear();
	clearWidgetState();
	_clearSuccessfulLspSpawnHistoryForTests();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	delete process.env.PI_LENS_LSP_CLIENT_CEILING;
	delete process.env.PI_LENS_LSP_IDLE_EVICT_MS;
	delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
	delete process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS;
	delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
	resetProjectTrust();
	resetSessionRootsForTests();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("ClientRegistry breaker cooldown (#4449)", () => {
	// Recurrence: `Date.now() + cooldownMs` flipped to `-`. The notify-stall
	// demotion would then open an already-expired window and the stalled client
	// respawned on the very next touch, which is the loop the demotion exists to
	// stop (#2356). No test read the stamp the cooldown wrote.
	it("coolDown stamps a window that ends cooldownMs from now", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const registry = new ClientRegistry(makeHooks().hooks);
		registry.coolDown("ts:/p", 30_000);
		expect(registry.broken.get("ts:/p")).toBe(1_030_000);
	});
});

/**
 * A linked worktree of the session repository, made of plain files the way git
 * lays one out (`<repo>/.git/worktrees/wt/commondir`, and a `.git` FILE in the
 * worktree naming that gitdir). No `git` process: the classifier reads files
 * only (`clients/review-graph/git-identity.ts`). The worktree sits inside the
 * repository directory, as `.claude/worktrees/*` does, so the registered-root
 * gate admits its files. `aaa-other` is a sibling project registered BEFORE
 * the session repo, so the classifier loop meets a root that calls the
 * worktree file "adopted" first.
 */
function linkedWorktreeFixture() {
	const parent = tempProject("linked-wt", false);
	const repo = path.join(parent, "zzz-repo");
	const other = path.join(parent, "aaa-other");
	const worktree = path.join(repo, "wt");
	const gitDir = path.join(repo, ".git", "worktrees", "wt");
	fs.mkdirSync(gitDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
	fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
	fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
	fs.mkdirSync(other, { recursive: true });
	fs.writeFileSync(path.join(other, "package.json"), "{}\n");
	fs.mkdirSync(worktree, { recursive: true });
	fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
	fs.writeFileSync(path.join(worktree, "package.json"), "{}\n");
	registerSessionRoot(other);
	registerSessionRoot(repo);
	return { repo, other, worktree, file: path.join(worktree, "a.ts") };
}

describe("ClientRegistry.analysisRootModeForFile (#4449)", () => {
	// Recurrence: the first-match-wins loop and its classification strings had no
	// direct test, so `mode === "session"` flipped to a literal "", to `!==`, or the
	// `||` turned `&&` and the verdict silently became "none" (every in-session file
	// refused) or the first root's verdict (a foreign root's "adopted" shadowing the
	// real session root).
	it("returns session for a file in the session cwd even when an earlier registered root calls it adopted", () => {
		// Sibling projects under one parent; "aaa" sorts first, so the loop meets the
		// root that calls the file "adopted" before it meets the session root.
		const parent = tempProject("mode-parent", false);
		const foreignRoot = path.join(parent, "aaa-foreign");
		const session = path.join(parent, "zzz-session");
		for (const dir of [foreignRoot, session]) {
			fs.mkdirSync(path.join(dir, "src"), { recursive: true });
			fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
		}
		registerSessionRoot(foreignRoot);
		registerSessionRoot(session);
		const registry = new ClientRegistry(makeHooks().hooks, undefined, session);
		const file = path.join(session, "src", "a.ts");
		expect(registry.analysisRootModeForFile(file)).toBe("session");
	});

	it("returns adopted for a file in a foreign project, and none for a vendored path", () => {
		const session = tempProject("mode-session");
		const foreign = tempProject("mode-foreign");
		registerSessionRoot(session);
		const registry = new ClientRegistry(makeHooks().hooks, undefined, session);
		expect(registry.analysisRootModeForFile(path.join(foreign, "a.ts"))).toBe(
			"adopted",
		);
		// `none` must not be upgraded to `adopted` by the accumulator.
		expect(
			registry.analysisRootModeForFile(
				path.join(session, "node_modules", "dep", "index.js"),
			),
		).toBe("none");
	});

	// Recurrence (#4449 survivors 19 and 21): `mode === "linked-worktree"` flipped
	// to `false` or its literal emptied, so the early return never fired. With a
	// second registered root the loop then answered "adopted" for a worktree of
	// the user's own repository, and every adopted-root rule applied to it (the
	// acquisition case below shows the spawn effect). With the session root alone
	// it answered "none".
	it("classifies a file in a linked worktree of the session repo as linked-worktree, even when an earlier registered root calls it adopted", () => {
		const f = linkedWorktreeFixture();
		const registry = new ClientRegistry(makeHooks().hooks, undefined, f.repo);
		expect(registry.analysisRootModeForFile(f.file)).toBe("linked-worktree");

		resetSessionRootsForTests();
		registerSessionRoot(f.repo);
		const single = new ClientRegistry(makeHooks().hooks, undefined, f.repo);
		expect(single.analysisRootModeForFile(f.file)).toBe("linked-worktree");
	});
});

/** One key `ts:<normalized root>` for a project dir. */
const keyFor = (id: string, root: string) => `${id}:${normalizeMapKey(root)}`;

/** A registry holding one live, registered client for `id` at `root`. */
function registryWithClient(id: string, root: string) {
	const { hooks, calls } = makeHooks();
	const registry = new ClientRegistry(hooks);
	const info = server(id, {
		root: async () => root,
		idleEviction: "transparent",
	});
	const client = fakeClient(id, root);
	const key = keyFor(id, root);
	registry.clients.set(key, client);
	const entry: SpawnedServer = { client, info };
	return { registry, hooks, calls, info, client, key, entry };
}

describe("ClientRegistry leases (#4449)", () => {
	// Recurrence: lease bookkeeping had no direct test. A mutant that counted
	// `- 1` instead of `+ 1`, or dropped the per-key increment, left leases at
	// zero or negative, so capacity and idle eviction (which skip leased keys)
	// would evict a client a caller had just selected and not yet used.
	it("counts one lease per acquisition and keeps the key until the last release", async () => {
		const root = tempProject("lease");
		const { registry, entry, key, info } = registryWithClient("ts", root);
		const file = path.join(root, "a.ts");

		expect(await registry.acquireClientLease(entry, file)).toBe(key);
		expect(await registry.acquireClientLease(entry, file)).toBe(key);
		expect(internals(registry).clientLeases.get(key)).toBe(2);

		registry.releaseClientLease(key, info);
		expect(internals(registry).clientLeases.get(key)).toBe(1);
		registry.releaseClientLease(key, info);
		expect(internals(registry).clientLeases.has(key)).toBe(false);
	});

	// Recurrence: the lease must bind to the CLIENT GENERATION that was selected.
	// A replaced or shut-down registry must not hand out a lease: a `false`ed or
	// `&&`-weakened guard let a caller pin a retired client (#3585 shape).
	it("refuses a lease for a replaced client, a missing key, and a destroyed registry", async () => {
		const root = tempProject("lease-refuse");
		const { registry, entry, key } = registryWithClient("ts", root);
		const file = path.join(root, "a.ts");

		registry.clients.set(key, fakeClient("ts", root)); // a replacement generation
		expect(await registry.acquireClientLease(entry, file)).toBeUndefined();
		expect(internals(registry).clientLeases.size).toBe(0);

		registry.clients.set(key, entry.client);
		registry.markDestroyed();
		expect(await registry.acquireClientLease(entry, file)).toBeUndefined();
		expect(internals(registry).clientLeases.size).toBe(0);
	});

	// Recurrence: the multi-client variant is all-or-nothing. `some` flipped to
	// `every`, or a dropped guard, leased the live clients and left the caller
	// holding a partial set whose members would never be released.
	it("leases a set all-or-nothing and counts every member", async () => {
		const rootA = tempProject("leases-a");
		const rootB = tempProject("leases-b");
		const a = registryWithClient("ts", rootA);
		const { registry } = a;
		const infoB = server("json", { root: async () => rootB });
		const clientB = fakeClient("json", rootB);
		const keyB = keyFor("json", rootB);
		registry.clients.set(keyB, clientB);
		const entries: SpawnedServer[] = [
			a.entry,
			{ client: clientB, info: infoB },
		];
		const file = path.join(rootA, "x.ts");

		const leased = await registry.acquireClientLeases(entries, file);
		expect(leased).toEqual([
			{ key: a.key, server: a.info },
			{ key: keyB, server: infoB },
		]);
		expect(internals(registry).clientLeases.get(a.key)).toBe(1);
		expect(internals(registry).clientLeases.get(keyB)).toBe(1);
		await registry.acquireClientLeases(entries, file);
		expect(internals(registry).clientLeases.get(keyB)).toBe(2);

		// One member replaced: nobody is leased, counts unchanged.
		registry.clients.set(keyB, fakeClient("json", rootB));
		expect(await registry.acquireClientLeases(entries, file)).toBeUndefined();
		expect(internals(registry).clientLeases.get(a.key)).toBe(2);

		// One member with no resolvable root: nobody is leased.
		const rootless = server("rootless", { root: async () => undefined });
		const none = await registry.acquireClientLeases(
			[a.entry, { client: fakeClient("rootless", rootA), info: rootless }],
			file,
		);
		expect(none).toBeUndefined();
		expect(internals(registry).clientLeases.get(a.key)).toBe(2);

		registry.clients.set(keyB, clientB);
		registry.markDestroyed();
		expect(await registry.acquireClientLeases(entries, file)).toBeUndefined();
		expect(internals(registry).clientLeases.get(a.key)).toBe(2);
	});

	// Recurrence: the LAST release hands the client back to the idle clock. If it
	// stopped stamping last-use or re-arming the timer, a client used only through
	// leases stayed resident forever (memory bound lost) or was evicted at once.
	it("stamps last use and re-arms idle eviction on the last release, only for a live registered client", () => {
		vi.useFakeTimers();
		vi.setSystemTime(5_000_000);
		const root = tempProject("lease-release");
		const { registry, key, info } = registryWithClient("ts", root);
		internals(registry).clientLeases.set(key, 1);

		registry.releaseClientLease(key, info);
		expect(internals(registry).clientLastUsedAt.get(key)).toBe(5_000_000);
		expect(internals(registry).idleEvictionTimers.has(key)).toBe(true);

		// A key whose client is gone is not stamped and gets no timer.
		const ghost = "ts:/ghost";
		internals(registry).clientLeases.set(ghost, 1);
		registry.releaseClientLease(ghost, info);
		expect(internals(registry).clientLastUsedAt.has(ghost)).toBe(false);
		expect(internals(registry).idleEvictionTimers.has(ghost)).toBe(false);
	});
});

describe("ClientRegistry.retireClient adopted-root bookkeeping (#4449)", () => {
	// Recurrence (#3585): retirement is the ONE place a generation's keyed state
	// is dropped. The adopted-root LRU entry is shared by every adopted client on
	// that root, so it may go only with the LAST of them; dropping it early hides a
	// live root from the cap, keeping it forever leaks a cap slot.
	it("drops the root's LRU entry only with the last adopted client on it", () => {
		const rootX = "/foreign/x";
		const { hooks, calls } = makeHooks();
		const registry = new ClientRegistry(hooks);
		const a = internals(registry);
		const tsKey = `ts:${rootX}`;
		const lintKey = `lint:${rootX}`;
		const otherKey = "ts:/foreign/y";
		for (const key of [tsKey, lintKey, otherKey]) {
			a.adoptedClientKeys.add(key);
			registry.clients.set(key, fakeClient("ts", "/x"));
			registry.clientSpawnedAt.set(key, 1);
			a.clientLastUsedAt.set(key, 1);
		}
		a.adoptedRootLastUsedAt.set(rootX, 1);
		a.adoptedRootLastUsedAt.set("/foreign/y", 1);

		registry.retireClient(tsKey);
		expect(a.adoptedClientKeys.has(tsKey)).toBe(false);
		expect(a.adoptedRootLastUsedAt.has(rootX)).toBe(true); // lintKey still there
		expect(registry.clients.has(tsKey)).toBe(false);
		expect(registry.clientSpawnedAt.has(tsKey)).toBe(false);
		expect(a.clientLastUsedAt.has(tsKey)).toBe(false);

		registry.retireClient(lintKey);
		expect(a.adoptedRootLastUsedAt.has(rootX)).toBe(false);
		expect(a.adoptedRootLastUsedAt.has("/foreign/y")).toBe(true);

		// The service-side hooks fire once per retirement, in the documented order.
		expect(calls.filter((c) => c.endsWith(tsKey))).toEqual([
			`releaseNotifyWrite:${tsKey}`,
			`forgetReadiness:${tsKey}`,
			`forgetNotifyBacklog:${tsKey}`,
		]);
	});

	// Recurrence (#4479 review F1): the "another adopted client on this root?"
	// check read the root with `candidate.endsWith(":" + root)`, a second reading
	// of the key next to `parseClientKey`. A POSIX root may hold a colon, so the
	// key of root `/foreign/w:/foreign/v` ends with `:/foreign/v`, and retiring
	// the last client of `/foreign/v` kept that root's LRU entry, holding a cap
	// slot for a root with no client.
	it("drops a root's LRU entry when another adopted root merely ends with ':' and its path", () => {
		const registry = new ClientRegistry(makeHooks().hooks);
		const a = internals(registry);
		const rootV = "/foreign/v";
		const rootW = "/foreign/w:/foreign/v";
		for (const root of [rootV, rootW]) {
			a.adoptedClientKeys.add(`ts:${root}`);
			registry.clients.set(`ts:${root}`, fakeClient("ts", root));
			a.adoptedRootLastUsedAt.set(root, 1);
		}
		registry.retireClient(`ts:${rootV}`);
		expect([...a.adoptedRootLastUsedAt.keys()]).toEqual([rootW]);
	});

	// Recurrence: a non-adopted retirement must not touch the adopted LRU.
	it("leaves the adopted-root LRU alone when the retired client was not adopted", () => {
		const registry = new ClientRegistry(makeHooks().hooks);
		const a = internals(registry);
		a.adoptedRootLastUsedAt.set("/foreign/z", 1);
		registry.clients.set("ts:/foreign/z", fakeClient("ts", "/foreign/z"));
		registry.retireClient("ts:/foreign/z");
		expect(a.adoptedRootLastUsedAt.has("/foreign/z")).toBe(true);
	});

	// Recurrence: a retired key's pending idle timer fired later against the
	// replacement generation (#1332 follow-up). Retirement clears it.
	it("cancels the retired key's idle timer", () => {
		vi.useFakeTimers();
		const root = tempProject("retire-timer");
		const { registry, key, info } = registryWithClient("ts", root);
		registry.scheduleIdleEviction(key, info);
		expect(vi.getTimerCount()).toBe(1);
		registry.retireClient(key);
		expect(vi.getTimerCount()).toBe(0);
		expect(internals(registry).idleEvictionTimers.size).toBe(0);
	});
});

describe("ClientRegistry.admitAdoptedRoot (#4449)", () => {
	// Foreign projects (adopted roots) are admitted under a cap of 2 with LRU
	// eviction. The cap itself has a service-level test; the victim choice, the
	// lease guard and the eviction record had none.
	function adoptedFixture(
		rootsUnder: (parent: string) => string[] = (parent) =>
			["f1", "f2", "f3"].map((name) => path.join(parent, `aaa-${name}`)),
	) {
		const parent = tempProject("adopt-parent", false);
		const session = path.join(parent, "zzz-session");
		fs.mkdirSync(session, { recursive: true });
		fs.writeFileSync(path.join(session, "package.json"), "{}\n");
		const roots = rootsUnder(parent).map((dir) => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
			return dir;
		});
		registerSessionRoot(session);
		const { hooks, calls } = makeHooks();
		const registry = new ClientRegistry(hooks, undefined, session);
		const normalized = roots.map((r) => normalizeMapKey(r));
		const clients = new Map<string, FakeClient>();
		/** The ensureClientForServer order: mark adopted, admit, register on spawn. */
		const adopt = (index: number, register = true): boolean => {
			const key = `ts:${normalized[index]}`;
			internals(registry).adoptedClientKeys.add(key);
			const admitted = internals(registry).admitAdoptedRoot(
				roots[index],
				path.join(roots[index], "a.ts"),
			);
			if (register && admitted) {
				const client = fakeClient("ts", roots[index]);
				clients.set(key, client);
				registry.clients.set(key, client);
			}
			return admitted;
		};
		return { registry, calls, roots, normalized, clients, adopt, session };
	}

	const evictions = () =>
		getDegradationSummary().find((g) => g.kind === "lsp-adopted-root-evicted");

	// Recurrence: victim selection was an unpinned `sort` on last-use. Dropping the
	// sort, flipping its operator or weakening `?? 0` all evicted the OLDEST
	// INSERTED root instead of the least recently USED one, so a root re-touched a
	// second ago was torn down under its caller.
	it("evicts the least recently used root, retires its clients and records the eviction", () => {
		vi.useFakeTimers();
		const f = adoptedFixture();
		const root = (i: number) => f.normalized[i];
		vi.setSystemTime(1_000);
		f.adopt(0);
		vi.setSystemTime(2_000);
		f.adopt(1);
		vi.setSystemTime(3_000);
		expect(f.adopt(0)).toBe(true); // F1 touched again: now newer than F2
		expect(evictions()).toBeUndefined();

		vi.setSystemTime(4_000);
		expect(f.adopt(2)).toBe(true);

		const a = internals(f.registry);
		expect([...a.adoptedRootLastUsedAt.keys()].sort()).toEqual(
			[root(0), root(2)].sort(),
		);
		expect(a.adoptedRootLastUsedAt.get(root(2))).toBe(4_000);
		// F2 was the victim: its client is retired and shut down with the reason.
		expect(f.registry.clients.has(`ts:${root(1)}`)).toBe(false);
		expect(f.clients.get(`ts:${root(1)}`)?.shutdown).toHaveBeenCalledWith({
			reason: "adopted-root-lru",
		});
		expect(f.registry.clients.has(`ts:${root(0)}`)).toBe(true);
		expect(f.clients.get(`ts:${root(0)}`)?.shutdown).not.toHaveBeenCalled();
		expect(f.calls).toContain(`releaseNotifyWrite:ts:${root(1)}`);
		const record = evictions();
		expect(record?.count).toBe(1);
		expect(record?.latestReasons[0]).toEqual({
			subject: root(1),
			reason: `adopted root cap 2 evicted ${root(1)} (count: 1)`,
		});
	});

	// Recurrence: eviction must not tear down a client a caller holds a lease on
	// (#4257 F4 family), and must only touch ADOPTED clients on the victim root.
	it("skips leased clients and clients that are not adopted when it evicts a root", () => {
		vi.useFakeTimers();
		const f = adoptedFixture();
		vi.setSystemTime(1_000);
		f.adopt(0);
		vi.setSystemTime(2_000);
		f.adopt(1);
		const leasedKey = `ts:${f.normalized[0]}`;
		internals(f.registry).clientLeases.set(leasedKey, 1);
		// A second server on the victim root that is NOT adopted (a session client).
		const sessionKey = `eslint:${f.normalized[0]}`;
		const sessionClient = fakeClient("eslint", f.roots[0]);
		f.registry.clients.set(sessionKey, sessionClient);

		vi.setSystemTime(3_000);
		f.adopt(2);

		expect(f.registry.clients.has(leasedKey)).toBe(true);
		expect(f.clients.get(leasedKey)?.shutdown).not.toHaveBeenCalled();
		expect(f.registry.clients.has(sessionKey)).toBe(true);
		expect(sessionClient.shutdown).not.toHaveBeenCalled();
		// The root entry itself still left the LRU: the cap is about roots.
		expect(
			internals(f.registry).adoptedRootLastUsedAt.has(f.normalized[0]),
		).toBe(false);
	});

	// Recurrence (#4479 review F1): eviction picked the victim's clients with
	// `key.endsWith(":" + victim)`, apart from `parseClientKey`. A POSIX directory
	// may hold a colon, so the key of root W = `<P>/aaa-w:<P>/aaa-v` ends with
	// `:<P>/aaa-v`, and evicting root V also retired and shut down W's client,
	// which is a different, more recently used root.
	// lane: Linux and macOS unit shards; a Windows directory name cannot hold ':'.
	it.skipIf(process.platform === "win32")(
		"evicts only the clients whose root is the victim, not a root that ends with ':' and the victim's path",
		() => {
			vi.useFakeTimers();
			const f = adoptedFixture((parent) => {
				const victim = path.join(parent, "aaa-v");
				return [
					victim,
					path.join(parent, "aaa-w:") + victim,
					path.join(parent, "aaa-x"),
				];
			});
			const keyOf = (i: number) => `ts:${f.normalized[i]}`;
			vi.setSystemTime(1_000);
			expect(f.adopt(0)).toBe(true);
			vi.setSystemTime(2_000);
			expect(f.adopt(1)).toBe(true);
			vi.setSystemTime(3_000);
			expect(f.adopt(2)).toBe(true); // V is the least recently used root

			expect(f.registry.clients.has(keyOf(0))).toBe(false);
			expect(f.clients.get(keyOf(0))?.shutdown).toHaveBeenCalledWith({
				reason: "adopted-root-lru",
			});
			expect(f.registry.clients.has(keyOf(1))).toBe(true);
			expect(f.clients.get(keyOf(1))?.shutdown).not.toHaveBeenCalled();
			expect(
				[...internals(f.registry).adoptedRootLastUsedAt.keys()].sort(),
			).toEqual([f.normalized[1], f.normalized[2]].sort());
		},
	);

	// Recurrence: a clock step backwards (NTP) makes the root being admitted the
	// "oldest". The victim filter must still exclude it; without it the registry
	// evicted the root it was admitting and left the caller with no slot.
	it("never picks the root being admitted as the victim, even when the clock stepped back", () => {
		vi.useFakeTimers();
		const f = adoptedFixture();
		vi.setSystemTime(9_000);
		f.adopt(0);
		vi.setSystemTime(9_500);
		f.adopt(1);
		vi.setSystemTime(100); // clock stepped back before the entries above
		expect(f.adopt(2)).toBe(true);
		const keys = [...internals(f.registry).adoptedRootLastUsedAt.keys()];
		expect(keys).toContain(f.normalized[2]);
		expect(keys).toHaveLength(2);
		expect(f.registry.clients.has(`ts:${f.normalized[0]}`)).toBe(false);
	});

	// Recurrence: a root whose client never registered (spawn failed or pending)
	// held a cap slot forever, so two failed adoptions starved every later one.
	it("purges roots with no live adopted client before it counts the cap", () => {
		const f = adoptedFixture();
		expect(f.adopt(0, false)).toBe(true);
		expect(f.adopt(1, false)).toBe(true);
		expect(f.adopt(2, false)).toBe(true);
		expect([...internals(f.registry).adoptedRootLastUsedAt.keys()]).toEqual([
			f.normalized[2],
		]);
		expect(evictions()).toBeUndefined();

		// A live NON-adopted client on a stale root does not keep that entry alive.
		const a = internals(f.registry);
		a.adoptedRootLastUsedAt.set(f.normalized[0], 1);
		a.adoptedClientKeys.delete(`ts:${f.normalized[0]}`);
		f.registry.clients.set(
			`ts:${f.normalized[0]}`,
			fakeClient("ts", f.roots[0]),
		);
		expect(f.adopt(1, false)).toBe(true);
		expect(a.adoptedRootLastUsedAt.has(f.normalized[0])).toBe(false);
	});

	// Recurrence: re-admitting a LIVE root is a touch, not a new slot. A full map
	// plus a re-touch used to evict a different root.
	it("refreshes a live root's timestamp without evicting when it is admitted again", () => {
		vi.useFakeTimers();
		const f = adoptedFixture();
		vi.setSystemTime(1_000);
		f.adopt(0);
		vi.setSystemTime(2_000);
		f.adopt(1);
		vi.setSystemTime(7_000);
		expect(f.adopt(1)).toBe(true);
		const a = internals(f.registry);
		expect(a.adoptedRootLastUsedAt.get(f.normalized[1])).toBe(7_000);
		expect(a.adoptedRootLastUsedAt.size).toBe(2);
		expect(evictions()).toBeUndefined();
	});

	// Recurrence: the classifier is re-checked inside the admission, so a file the
	// session root owns can never be admitted as an adopted root.
	it("declines a file the session root owns", () => {
		const f = adoptedFixture();
		expect(
			internals(f.registry).admitAdoptedRoot(
				f.session,
				path.join(f.session, "a.ts"),
			),
		).toBe(false);
		expect(internals(f.registry).adoptedRootLastUsedAt.size).toBe(0);
	});
});

describe("ClientRegistry.makeCapacityForClient (#4449)", () => {
	function capacityRegistry(ceiling: number) {
		process.env.PI_LENS_LSP_CLIENT_CEILING = String(ceiling);
		const { hooks, calls } = makeHooks();
		return { registry: new ClientRegistry(hooks), calls };
	}
	const add = (
		registry: ClientRegistry,
		key: string,
		opts: { busy?: boolean; used?: number; spawned?: number } = {},
	) => {
		const client = fakeClient(key.split(":")[0], "/r", { busy: opts.busy });
		registry.clients.set(key, client);
		if (opts.used !== undefined)
			internals(registry).clientLastUsedAt.set(key, opts.used);
		if (opts.spawned !== undefined)
			registry.clientSpawnedAt.set(key, opts.spawned);
		return client;
	};

	// Recurrence: occupancy counted every entry in `clients`, dead ones too. A
	// crashed client awaiting respawn then consumed a slot, so a healthy new
	// spawn evicted a LIVE idle client to make room for nothing.
	it("does not count a dead client toward the ceiling", async () => {
		const { registry } = capacityRegistry(2);
		const alive = add(registry, "a:/1");
		const dead = add(registry, "b:/2");
		dead.die();
		await expect(
			internals(registry).makeCapacityForClient("c:/3"),
		).resolves.toBe(true);
		expect(alive.shutdown).not.toHaveBeenCalled();
		expect(registry.clients.has("a:/1")).toBe(true);
	});

	// Recurrence: the LRU key was `lastUsedAt ?? spawnedAt ?? 0`; a `&&`, a `+` or a
	// dropped fallback sorted by the wrong clock and evicted a recently used
	// client. Last use outranks spawn time; spawn time stands in for a client
	// never used; a client with neither is the oldest.
	it("evicts by last use, then spawn time, then nothing-known first", async () => {
		const { registry } = capacityRegistry(3);
		const spawnedOnly = add(registry, "a:/1", { spawned: 500 });
		const usedLater = add(registry, "b:/2", { used: 900, spawned: 50 });
		const unknown = add(registry, "c:/3");
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(true);
		expect(unknown.shutdown).toHaveBeenCalledTimes(1);
		expect(spawnedOnly.shutdown).not.toHaveBeenCalled();
		expect(usedLater.shutdown).not.toHaveBeenCalled();
		expect(registry.clients.has("c:/3")).toBe(false);

		// Now the spawn-time stand-in (500) against a real last use (900): spawn
		// time is the older clock, so `a` goes. A sort on spawn time alone would
		// pick `b` (50).
		process.env.PI_LENS_LSP_CLIENT_CEILING = "2";
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(true);
		expect(spawnedOnly.shutdown).toHaveBeenCalledTimes(1);
		expect(usedLater.shutdown).not.toHaveBeenCalled();
	});

	// Recurrence: the victim must be idle (not busy, not leased) and never the key
	// being spawned for (a dead client's own respawn). Each dropped condition
	// shut down a client mid-request or the very key the caller was reviving.
	it("declines instead of evicting a busy, leased or own-key client", async () => {
		const { registry } = capacityRegistry(1);
		const busy = add(registry, "a:/1", { busy: true });
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(false);
		expect(busy.shutdown).not.toHaveBeenCalled();

		busy.setBusy(false);
		internals(registry).clientLeases.set("a:/1", 1);
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(false);
		expect(busy.shutdown).not.toHaveBeenCalled();

		internals(registry).clientLeases.delete("a:/1");
		await expect(
			internals(registry).makeCapacityForClient("a:/1"),
		).resolves.toBe(false);
		expect(busy.shutdown).not.toHaveBeenCalled();
		expect(registry.clients.has("a:/1")).toBe(true);
	});

	// Recurrence (#1325/#3585): the victim's notify write is released BEFORE the
	// awaited shutdown (a waiter must not park on a client going down) and the
	// retirement runs after it, with the documented shutdown reason.
	it("releases the notify write before it awaits the victim's shutdown", async () => {
		const { registry, calls } = capacityRegistry(1);
		const victim = add(registry, "a:/1", { used: 1 });
		let seenDuringShutdown: string[] = [];
		victim.shutdown.mockImplementation(async () => {
			seenDuringShutdown = [...calls];
		});
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(true);
		expect(victim.shutdown).toHaveBeenCalledWith({
			reason: "client_ceiling_lru",
		});
		expect(seenDuringShutdown).toEqual(["releaseNotifyWrite:a:/1"]);
		expect(registry.clients.has("a:/1")).toBe(false);
	});

	// Recurrence: in-flight spawns occupy a slot too. Counting only live clients
	// let N concurrent first spawns each see room and exceed the ceiling.
	it("counts an in-flight spawn as occupying a slot", async () => {
		const { registry } = capacityRegistry(1);
		registry.inFlight.set("a:/1", new Promise(() => undefined));
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(false);
	});
});

describe("ClientRegistry.scheduleIdleEviction (#4449)", () => {
	const IDLE_MS = 1_000;
	function idleFixture(info?: Record<string, unknown>) {
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = String(IDLE_MS);
		vi.useFakeTimers();
		const { hooks, calls } = makeHooks();
		const registry = new ClientRegistry(hooks);
		const serverInfo = server("ts", {
			idleEviction: "transparent",
			...info,
		});
		const client = fakeClient("ts", "/r");
		const key = "ts:/r";
		registry.clients.set(key, client);
		// Every production caller stamps last use before it arms the timer.
		internals(registry).clientLastUsedAt.set(key, Date.now());
		return { registry, client, key, serverInfo, calls };
	}
	const idleRecord = () =>
		getDegradationSummary().find((g) => g.kind === "lsp-idle-eviction");

	// Recurrence: the timer callback is the ONLY thing standing between an idle
	// language server and unbounded residency. It must retire synchronously, shut
	// down with the idle reason, forget its own timer entry and leave one record.
	it("retires, shuts down and records an idle client, and forgets its own timer", async () => {
		const f = idleFixture();
		f.registry.scheduleIdleEviction(f.key, f.serverInfo);
		expect(internals(f.registry).idleEvictionTimers.has(f.key)).toBe(true);

		await vi.advanceTimersByTimeAsync(IDLE_MS);

		expect(f.client.shutdown).toHaveBeenCalledWith({ reason: "idle_eviction" });
		expect(f.registry.clients.has(f.key)).toBe(false);
		expect(internals(f.registry).idleEvictionTimers.has(f.key)).toBe(false);
		expect(idleRecord()?.count).toBe(1);
		expect(idleRecord()?.latestReasons[0]).toEqual({
			subject: f.key,
			reason: "idle LSP client released to bound memory",
		});
	});

	// Recurrence: re-arming (every warm reuse does) left the previous timer
	// running, so each reuse added a timer and the first one evicted a client
	// that had just been used. One key, one timer.
	it("replaces the previous timer when it is re-armed", async () => {
		const f = idleFixture();
		f.registry.scheduleIdleEviction(f.key, f.serverInfo);
		await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
		f.registry.scheduleIdleEviction(f.key, f.serverInfo);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
		expect(f.client.shutdown).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
		expect(f.client.shutdown).toHaveBeenCalledTimes(1);
	});

	// Recurrence: the callback re-checks the world after the window. A destroyed
	// registry must not shut anything down again, and a client that died during
	// the window is not "released" (respawn owns it).
	it("does nothing when the registry was destroyed or the client already died", async () => {
		const destroyed = idleFixture();
		destroyed.registry.scheduleIdleEviction(
			destroyed.key,
			destroyed.serverInfo,
		);
		destroyed.registry.markDestroyed();
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(destroyed.client.shutdown).not.toHaveBeenCalled();
		expect(destroyed.registry.clients.has(destroyed.key)).toBe(true);

		const dead = idleFixture();
		dead.registry.scheduleIdleEviction(dead.key, dead.serverInfo);
		dead.client.die();
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(dead.client.shutdown).not.toHaveBeenCalled();
		expect(idleRecord()).toBeUndefined();
		// The fired timer's map entry is gone even though nothing was evicted.
		expect(internals(dead.registry).idleEvictionTimers.has(dead.key)).toBe(
			false,
		);
	});

	// Recurrence: only `transparent` servers are evicted on idle; every other
	// policy stays resident (#3645). Adopted roots are evicted regardless, on the
	// fixed adopted window rather than the configured one.
	it("arms no timer for a resident server and an adopted-window timer for an adopted key", async () => {
		const resident = idleFixture({ idleEviction: "resident" });
		resident.registry.scheduleIdleEviction(resident.key, resident.serverInfo);
		expect(vi.getTimerCount()).toBe(0);

		const adopted = idleFixture({ idleEviction: "resident" });
		internals(adopted.registry).adoptedClientKeys.add(adopted.key);
		adopted.registry.scheduleIdleEviction(adopted.key, adopted.serverInfo);
		await vi.advanceTimersByTimeAsync(IDLE_MS); // the configured window
		expect(adopted.client.shutdown).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000 - IDLE_MS);
		expect(adopted.client.shutdown).toHaveBeenCalledTimes(1);
	});
});

describe("ClientRegistry.resolveServerRoot (#4449)", () => {
	function rootServer(id: string, root: string | undefined): LSPServerInfo {
		return server(id, { root: async () => root });
	}
	const live = (root: string) =>
		({ root, isAlive: () => true }) as unknown as LSPClientInfo;

	// Recurrence: an adopted (foreign) project may only host a client at the root
	// the shared classifier picked (#4257). Dropping the equality, inverting it or
	// dropping the branch let a server-chosen nested directory become its own
	// client inside a foreign workspace.
	it("accepts an adopted root only when the server's root is the classifier's root", async () => {
		const parent = tempProject("res-adopt", false);
		const session = path.join(parent, "zzz-session");
		const foreign = path.join(parent, "aaa-foreign");
		const nested = path.join(foreign, "pkg");
		for (const dir of [session, foreign, nested]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(path.join(session, "package.json"), "{}\n");
		fs.writeFileSync(path.join(foreign, "package.json"), "{}\n");
		registerSessionRoot(session);
		const registry = new ClientRegistry(makeHooks().hooks, undefined, session);
		const file = path.join(nested, "a.ts");

		await expect(
			registry.resolveServerRoot(rootServer("ts", foreign), file),
		).resolves.toBe(foreign);
		await expect(
			registry.resolveServerRoot(rootServer("ts", nested), file),
		).resolves.toBeUndefined();
	});

	// Recurrence (#2052): a file outside every registered session root gets no
	// client, EXCEPT an adopted one (decided by the classifier, not the registry).
	// `mode !== "adopted"` flipped to `true` refused every adopted file once any
	// session root existed; flipped to a literal it admitted foreign junk.
	it("declines a file outside the session roots unless the classifier adopts it", async () => {
		const parent = tempProject("res-outside", false);
		const session = path.join(parent, "zzz-session");
		const foreign = path.join(parent, "aaa-foreign");
		const bare = path.join(parent, "bbb-bare");
		for (const dir of [session, foreign, bare]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(path.join(session, "package.json"), "{}\n");
		fs.writeFileSync(path.join(foreign, "package.json"), "{}\n");
		registerSessionRoot(session);
		const registry = new ClientRegistry(makeHooks().hooks, undefined, session);

		await expect(
			registry.resolveServerRoot(
				rootServer("ts", bare),
				path.join(bare, "a.ts"),
			),
		).resolves.toBeUndefined();
		await expect(
			registry.resolveServerRoot(
				rootServer("ts", foreign),
				path.join(foreign, "a.ts"),
			),
		).resolves.toBe(foreign);
	});

	// Recurrence (#1373): config-only nested roots join the NEAREST same-server
	// ancestor. The nearest is the longest ancestor key; `>` flipped to `<=` took
	// the farthest, dropping the `startsWith(prefix)` filter let ANOTHER server's
	// key win, and `true` took whichever key was iterated last.
	it("coalesces into the nearest ancestor of the same server only, whatever the key order", async () => {
		const project = tempProject("res-near", false);
		const mid = path.join(project, "mid");
		const leaf = path.join(mid, "deep", "leaf");
		fs.mkdirSync(leaf, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(project);
		const otherServer = `go:${normalizeMapKey(path.join(mid, "deep"))}`;
		const resolveWith = async (order: string[]) => {
			const registry = new ClientRegistry(makeHooks().hooks);
			for (const root of order) {
				registry.clients.set(keyFor("ts", root), live(root));
			}
			// A longer key of ANOTHER server (same prefix length: "go:" vs "ts:").
			registry.clients.set(otherServer, live(path.join(mid, "deep")));
			return registry.resolveServerRoot(
				rootServer("ts", leaf),
				path.join(leaf, "a.ts"),
			);
		};

		await expect(resolveWith([mid, project])).resolves.toBe(mid);
		await expect(resolveWith([project, mid])).resolves.toBe(mid);
	});

	// Recurrence (#4449 survivor 134): the ancestor test picks `path.win32` only
	// for a Windows-shaped key. `path.win32.relative` ignores case on every host
	// (`/srv/Proj` to `/srv/proj/sub` reads `sub`), so forcing it (the condition
	// flipped to `true`) made a nested root join the client of a DIFFERENT
	// directory that differs only in case, on a case-sensitive filesystem.
	it("does not coalesce a nested root into the client of a sibling that differs only in case", async (ctx) => {
		const project = tempProject("res-case", false);
		const upper = path.join(project, "Proj");
		fs.mkdirSync(upper, { recursive: true });
		ctx.skip(
			fs.existsSync(path.join(project, "proj")),
			"case-insensitive filesystem: Proj and proj cannot be two directories here",
		);
		const leaf = path.join(project, "proj", "sub");
		fs.mkdirSync(leaf, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(project);
		const registry = new ClientRegistry(makeHooks().hooks);
		registry.clients.set(keyFor("ts", upper), live(upper));

		await expect(
			registry.resolveServerRoot(
				rootServer("ts", leaf),
				path.join(leaf, "a.ts"),
			),
		).resolves.toBe(leaf);
	});

	// Recurrence (#1373): a root equal to the session cwd is returned as is, never
	// folded into a client hosted ABOVE the cwd.
	it("keeps a root equal to the cwd even when an ancestor hosts a client", async () => {
		const parent = tempProject("res-cwd", false);
		const cwd = path.join(parent, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		const registry = new ClientRegistry(makeHooks().hooks);
		registry.clients.set(keyFor("ts", parent), live(parent));

		await expect(
			registry.resolveServerRoot(rootServer("ts", cwd), path.join(cwd, "a.ts")),
		).resolves.toBe(cwd);
	});

	// Recurrence: an in-flight spawn is an ancestor too (no client yet), so the
	// answer falls back to the ancestor KEY. Reading `.root` off the missing
	// client threw a TypeError out of root resolution.
	it("falls back to the ancestor key when only a spawn is in flight there", async () => {
		const project = tempProject("res-flight", false);
		const nested = path.join(project, "nested");
		fs.mkdirSync(nested, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(project);
		const registry = new ClientRegistry(makeHooks().hooks);
		registry.inFlight.set(
			keyFor("ts", project),
			Promise.resolve<SpawnedServer | undefined>(undefined),
		);

		await expect(
			registry.resolveServerRoot(
				rootServer("ts", nested),
				path.join(nested, "a.ts"),
			),
		).resolves.toBe(normalizeMapKey(project));
	});

	// Recurrence: boundary verdicts are immutable per root and cached for the
	// service's life, negatives included, so a hot touch path does not re-stat the
	// markers on every call. Observed through the real probe: a manifest that
	// appears AFTER the first answer does not change the cached verdict, which a
	// dropped `set` or an always-recompute `if (!boundary)` would.
	it("keeps the first boundary verdict for a root for the registry's life", async () => {
		const project = tempProject("res-cache", false);
		const nested = path.join(project, "nested");
		fs.mkdirSync(nested, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(project);
		const registry = new ClientRegistry(makeHooks().hooks);
		registry.clients.set(keyFor("ts", project), live(project));
		const resolve = () =>
			registry.resolveServerRoot(
				rootServer("ts", nested),
				path.join(nested, "a.ts"),
			);

		await expect(resolve()).resolves.toBe(project); // no marker: coalesced
		fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
		await expect(resolve()).resolves.toBe(project); // verdict is cached
		await expect(
			new ClientRegistry(makeHooks().hooks).resolveServerRoot(
				rootServer("ts", nested),
				path.join(nested, "a.ts"),
			),
		).resolves.toBe(nested); // control: a fresh registry sees the manifest
	});
});

// ---------------------------------------------------------------------------
// ensureClientForServer: breaker, respawn, skip records, outcomes (#4449)
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** Ledger groups by kind, for the records the registry writes. */
const ledger = (kind: string) =>
	getDegradationSummary().find((group) => group.kind === kind);

/** The latency records of one phase, in call order. */
const latencyRecords = (phase: string) =>
	logLatency.mock.calls
		.map(([entry]) => entry as Record<string, unknown>)
		.filter((entry) => entry.phase === phase);

/** `sessionCwd` may name the registry's session root as a function of the fixture root. */
function ensureFixture(id = "ts", sessionCwd?: (root: string) => string) {
	const root = tempProject(`ensure-${id}`);
	const file = path.join(root, "a.fake");
	const { hooks, calls } = makeHooks();
	const registry = new ClientRegistry(hooks, undefined, sessionCwd?.(root));
	const spawn = vi.fn(async (_root: string, _options?: unknown) => ({
		process: {
			process: { killed: false, kill: vi.fn() },
			stdin: {},
			stdout: {},
			stderr: {},
			pid: 4242,
		},
	}));
	const info = server(id, {
		root: async () => root,
		spawn,
		idleEviction: "transparent",
	});
	const spawned: FakeClient[] = [];
	createLSPClient.mockImplementation(async () => {
		const client = fakeClient(id, root);
		spawned.push(client);
		return client;
	});
	const key = keyFor(id, root);
	const ensure = (onOutcome?: (outcome: string) => void) =>
		registry.ensureClientForServer(
			file,
			info,
			undefined,
			undefined,
			onOutcome as never,
		);
	return { root, file, registry, calls, spawn, info, spawned, key, ensure };
}

type Fixture = ReturnType<typeof ensureFixture>;

/** Put a dead client (and its spawn stamp) where the registry will find it. */
function plantDead(
	f: Fixture,
	opts: { spawnedAt?: number; exitedAt?: number },
): FakeClient {
	const dead = fakeClient(f.info.id, f.root);
	if (opts.exitedAt !== undefined) dead.die(opts.exitedAt);
	else dead.kill();
	f.registry.clients.set(f.key, dead);
	if (opts.spawnedAt !== undefined) {
		f.registry.clientSpawnedAt.set(f.key, opts.spawnedAt);
	}
	return dead;
}

const priv = (registry: ClientRegistry) =>
	registry as unknown as {
		runtimeExitCounts: Map<string, number>;
		runtimeExitWindow: Map<string, number[]>;
		failureCounts: Map<string, number>;
		lastSpawnVerdict: Map<string, "failed" | "declined">;
		generationHandoff: Promise<void> | undefined;
		inFlight: Map<string, Promise<unknown>>;
		permanentlyBroken: Set<string>;
		workspaceProbeLogged: Set<string>;
		warmStartLogged: Set<string>;
		recordRuntimeExitWindow(
			key: string,
			exitedAt: number | undefined,
			uptimeMs: number | null,
		): boolean;
		withClientSpawnGate<T>(operation: () => Promise<T>): Promise<T>;
	};

describe("ClientRegistry respawn breaker, consecutive early exits (#4449, #1127)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	// Recurrence (#1127): a server that spawns fine and dies within a minute, every
	// time, must climb the cooldown ladder 15s, 30s, 60s, 120s and be latched off at
	// the fifth early exit. The ladder, the comparison (`>=`, not `>`), the min/cap
	// and the latch were all unpinned: the existing convergence test passes through
	// the OTHER breaker (five deaths inside the 15 minute window), so removing the
	// fast path's latch left it green. These deaths are 20 minutes apart so the
	// window never holds more than one, and only the fast path can trip.
	it("climbs the cooldown ladder and latches at the fifth early exit, with no help from the window", async () => {
		const f = ensureFixture();
		const ladder = [15_000, 30_000, 60_000, 120_000];
		for (let exit = 1; exit <= 5; exit++) {
			const spawnedAt = T0 + exit * 20 * MIN;
			plantDead(f, { spawnedAt, exitedAt: spawnedAt + 5_000 });
			f.registry.broken.delete(f.key);
			await expect(f.ensure()).resolves.toBeUndefined();

			expect(priv(f.registry).runtimeExitCounts.get(f.key)).toBe(exit);
			expect(priv(f.registry).runtimeExitWindow.get(f.key)).toHaveLength(1);
			expect(f.registry.permanentlyBroken.has(f.key)).toBe(exit === 5);
			if (exit < 5) {
				expect(f.registry.broken.get(f.key)).toBe(T0 + ladder[exit - 1]);
			}
		}
		const record = ledger("lsp-breaker");
		expect(record?.latestReasons).toEqual([
			{
				subject: f.key,
				reason: "permanently disabled after 5 early post-init exits",
			},
		]);
		expect(f.spawn).not.toHaveBeenCalled();
	});

	// Recurrence (#1127): "early" means STRICTLY under the 60s threshold. A server
	// that stayed up a full minute is a working server that restarted: it clears the
	// streak and respawns at once. `<=` counted it, and `true` counted every death,
	// so a legitimate restart marched a healthy server toward permanent disablement.
	it("treats exactly the threshold as a healthy run that clears the streak and respawns", async () => {
		const f = ensureFixture();
		priv(f.registry).runtimeExitCounts.set(f.key, 3);
		plantDead(f, { spawnedAt: T0, exitedAt: T0 + MIN });
		const respawned = await f.ensure();

		expect(respawned?.client).toBe(f.spawned[0]);
		expect(priv(f.registry).runtimeExitCounts.has(f.key)).toBe(false);
		expect(f.registry.broken.has(f.key)).toBe(false);
		expect(f.registry.permanentlyBroken.has(f.key)).toBe(false);
		expect(f.spawn).toHaveBeenCalledTimes(1);

		// One millisecond less is early: it counts and cools down.
		plantDead(f, { spawnedAt: T0, exitedAt: T0 + MIN - 1 });
		priv(f.registry).runtimeExitCounts.set(f.key, 3);
		await expect(f.ensure()).resolves.toBeUndefined();
		expect(priv(f.registry).runtimeExitCounts.get(f.key)).toBe(4);
		expect(f.registry.broken.get(f.key)).toBe(T0 + 120_000);
	});

	// Recurrence (#1127): lifetime is measured from the client's recorded death, and
	// falls back to detection time only when the death time is missing. Each of the
	// three inputs the uptime ternary reads had a mutant that left the suite green.
	it("measures uptime from the recorded death, else from now, else not at all", async () => {
		// Recorded death: 5 s of life, however long ago it was detected.
		const recorded = ensureFixture();
		plantDead(recorded, {
			spawnedAt: T0 - 3_600_000,
			exitedAt: T0 - 3_595_000,
		});
		await recorded.ensure();
		expect(priv(recorded.registry).runtimeExitCounts.get(recorded.key)).toBe(1);

		// No death time: detection-time delta (spawned 5 s ago) is early...
		const lazy = ensureFixture();
		plantDead(lazy, { spawnedAt: T0 - 5_000 });
		await lazy.ensure();
		expect(priv(lazy.registry).runtimeExitCounts.get(lazy.key)).toBe(1);

		// ...and the same delta from a spawn an hour ago is not.
		const longRun = ensureFixture();
		plantDead(longRun, { spawnedAt: T0 - 3_600_000 });
		await longRun.ensure();
		expect(priv(longRun.registry).runtimeExitCounts.has(longRun.key)).toBe(
			false,
		);

		// A death time but no spawn stamp: the lifetime is unknown, so the death is
		// neither early nor recorded in the window (NaN lifetimes are not evidence).
		const stampless = ensureFixture("rs");
		plantDead(stampless, { exitedAt: T0 - 1_000 });
		await stampless.ensure();
		expect(priv(stampless.registry).runtimeExitCounts.has(stampless.key)).toBe(
			false,
		);
		expect(priv(stampless.registry).runtimeExitWindow.has(stampless.key)).toBe(
			false,
		);

		// Neither stamp: unknown lifetime is not early, and the key respawns.
		const unknown = ensureFixture();
		plantDead(unknown, {});
		const result = await unknown.ensure();
		expect(priv(unknown.registry).runtimeExitCounts.has(unknown.key)).toBe(
			false,
		);
		expect(result).toBeDefined();
	});

	// Recurrence (#1127): dead-client cleanup order. The notify write is released
	// (a waiter must not park on a dead client), the dead client is told to shut
	// down once, any old cooldown is dropped so a healthy death does not inherit it,
	// and the respawn is announced with the lifetime it measured.
	it("releases the notify write, shuts the dead client down once, clears the old cooldown and records the respawn", async () => {
		const f = ensureFixture();
		const dead = plantDead(f, {
			spawnedAt: T0 - 600_000,
			exitedAt: T0 - 1_000,
		});
		f.registry.broken.set(f.key, T0 + 10_000); // a stale cooldown from before
		let releasedBeforeShutdown: string[] = [];
		dead.shutdown.mockImplementation(async () => {
			releasedBeforeShutdown = [...f.calls];
		});
		const respawned = await f.ensure();

		expect(dead.shutdown).toHaveBeenCalledTimes(1);
		expect(releasedBeforeShutdown).toEqual([`releaseNotifyWrite:${f.key}`]);
		expect(f.registry.broken.has(f.key)).toBe(false);
		expect(respawned?.client).toBe(f.spawned[0]);
		expect(f.registry.clients.get(f.key)).toBe(f.spawned[0]);
		expect(latencyRecords("lsp_server_respawn")).toEqual([
			{
				type: "phase",
				phase: "lsp_server_respawn",
				filePath: f.file,
				durationMs: 0,
				metadata: {
					serverId: "ts",
					root: f.root,
					uptimeMs: 599_000,
					intentional: false,
				},
			},
		]);
	});
});

describe("ClientRegistry respawn breaker, windowed rate (#4449, #1142)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	// Recurrence (#1142): a server that dies just PAST the 60s threshold every
	// time never feeds the fast path; five such deaths inside 15 minutes must still
	// latch it, with a reason that says why. The reason text carries the window in
	// minutes (`Math.round(ms / 60_000)`), so an arithmetic slip printed a
	// nonsense number into the ledger that operators read.
	it("latches five slow deaths inside the window, naming the rate in the ledger", async () => {
		const f = ensureFixture();
		for (let death = 0; death < 5; death++) {
			const exitedAt = T0 + death * 2 * MIN;
			plantDead(f, { spawnedAt: exitedAt - 70_000, exitedAt });
			f.registry.broken.delete(f.key);
			const result = await f.ensure();
			// Slow deaths set no cooldown, so each respawns until the fifth latches.
			expect(result === undefined).toBe(death === 4);
			expect(f.registry.permanentlyBroken.has(f.key)).toBe(death === 4);
		}
		// The fast path saw none of them: every lifetime was 70 s.
		expect(priv(f.registry).runtimeExitCounts.has(f.key)).toBe(false);
		expect(ledger("lsp-breaker")?.latestReasons).toEqual([
			{
				subject: f.key,
				reason: "windowed runtime-exit trip: 5 deaths within 15m",
			},
		]);
		expect(f.spawn).toHaveBeenCalledTimes(4);
	});

	// Recurrence (#1183): the per-key window array is dropped once nothing in it is
	// still in-window, and only then. `some` flipped to `every` or the boundary
	// flipped to `>` dropped live evidence (a death exactly 15 minutes old still
	// counts), and never dropping it leaked an array per crashed key forever.
	it("drops a stale window array on a healthy death, but keeps one with an in-window entry", async () => {
		// A first, early death records one timestamp in the window.
		const stale = ensureFixture();
		plantDead(stale, { spawnedAt: T0 - 70_000, exitedAt: T0 - 65_000 });
		await stale.ensure();
		expect(priv(stale.registry).runtimeExitWindow.get(stale.key)).toEqual([
			T0 - 65_000,
		]);
		// A later healthy death (an hour of life: past the 10 minute ceiling, so it
		// is not recorded) anchors "now" 40 minutes after the recorded one.
		const later = T0 + 40 * MIN;
		plantDead(stale, { spawnedAt: later - 3_600_000, exitedAt: later });
		stale.registry.broken.delete(stale.key);
		await stale.ensure();
		expect(priv(stale.registry).runtimeExitWindow.has(stale.key)).toBe(false);

		// Same shape, but the recorded death sits exactly on the window edge.
		const edge = ensureFixture();
		const recorded = T0 - 65_000;
		// An ancient entry beside the edge one: one live entry is enough to keep it.
		priv(edge.registry).runtimeExitWindow.set(edge.key, [
			recorded - 3_600_000,
			recorded,
		]);
		const anchor = recorded + 15 * MIN;
		plantDead(edge, { spawnedAt: anchor - 3_600_000, exitedAt: anchor });
		await edge.ensure();
		expect(priv(edge.registry).runtimeExitWindow.get(edge.key)).toEqual([
			recorded - 3_600_000,
			recorded,
		]);
	});
});

describe("ClientRegistry skip records and cooldown expiry (#4449)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	// Recurrence (#1743): a cooling-down key is skipped with ONE record that says
	// how long is left, and a latched key says it is permanent. The fields are what
	// an operator reads to tell a 15 s blip from a dead server; both were unpinned,
	// so `Math.max(0, ...)` could become `min` or a sum and the record lied.
	it("records how long a cooldown has left and that a latch is permanent", async () => {
		const cooling = ensureFixture();
		cooling.registry.broken.set(cooling.key, T0 + 7_000);
		await expect(cooling.ensure()).resolves.toBeUndefined();
		expect(latencyRecords("lsp_client_skipped_broken")).toEqual([
			{
				type: "phase",
				phase: "lsp_client_skipped_broken",
				filePath: cooling.file,
				durationMs: 0,
				metadata: {
					serverId: "ts",
					retryInMs: 7_000,
					identity: `ts:${normalizeMapKey(cooling.file)}`,
				},
			},
		]);
		expect(ledger("lsp-client-skipped-broken")?.latestReasons).toEqual([
			{
				subject: expect.any(String),
				reason: "ts in breaker cooldown (count: 1)",
			},
		]);

		logLatency.mockClear();
		const latched = ensureFixture("go");
		latched.registry.permanentlyBroken.add(latched.key);
		await expect(latched.ensure()).resolves.toBeUndefined();
		expect(latencyRecords("lsp_client_skipped_broken")).toEqual([
			{
				type: "phase",
				phase: "lsp_client_skipped_broken",
				filePath: latched.file,
				durationMs: 0,
				metadata: {
					serverId: "go",
					permanent: true,
					identity: `go:${normalizeMapKey(latched.file)}`,
				},
			},
		]);
		expect(ledger("lsp-client-skipped-broken")?.latestReasons).toContainEqual({
			subject: expect.any(String),
			reason: "go latched permanently broken (count: 1)",
		});
	});

	// Recurrence (#1743): a command the host reported unavailable is skipped with a
	// record naming the command and the server, not spawned.
	it("skips a command that is temporarily unavailable, and says which", async () => {
		const f = ensureFixture("zz");
		(f.info as { availabilityKey?: string }).availabilityKey = "zz-lsp-bin";
		_markDirectLspCommandUnavailableForTests("zz-lsp-bin");
		await expect(f.ensure()).resolves.toBeUndefined();
		expect(f.spawn).not.toHaveBeenCalled();
		expect(latencyRecords("lsp_client_skipped_unavailable_command")).toEqual([
			{
				type: "phase",
				phase: "lsp_client_skipped_unavailable_command",
				filePath: f.file,
				durationMs: 0,
				metadata: {
					serverId: "zz",
					command: "zz-lsp-bin",
					identity: `zz-lsp-bin:${normalizeMapKey(f.file)}`,
				},
			},
		]);
		expect(
			ledger("lsp-client-skipped-unavailable-command")?.latestReasons,
		).toContainEqual({
			subject: expect.any(String),
			reason: "command zz-lsp-bin temporarily unavailable (count: 1)",
		});
	});

	// Recurrence: a cooldown that ends THIS millisecond has ended. `>=` kept the key
	// dark for one more touch; an expired entry that was not deleted made every
	// later breaker read see a stale window.
	it("treats a cooldown ending now as over, and deletes any expired entry", async () => {
		const atEdge = ensureFixture();
		atEdge.registry.broken.set(atEdge.key, T0);
		const client = await atEdge.ensure();
		expect(client?.client).toBe(atEdge.spawned[0]);
		expect(atEdge.registry.broken.has(atEdge.key)).toBe(false);

		const expired = ensureFixture("go");
		expired.registry.broken.set(expired.key, T0 - 1);
		await expect(expired.ensure()).resolves.toBeDefined();
		expect(expired.registry.broken.has(expired.key)).toBe(false);

		const live = ensureFixture("rs");
		live.registry.broken.set(live.key, T0 + 1);
		await expect(live.ensure()).resolves.toBeUndefined();
		expect(live.registry.broken.get(live.key)).toBe(T0 + 1);
		expect(live.spawn).not.toHaveBeenCalled();
	});

	// Recurrence: a warm reuse is the one touch that proves a key is healthy again.
	// It clears the "unavailable" dedupe latch (so the NEXT outage is recorded),
	// re-arms the idle timer, and reports the reuse.
	it("clears the unavailable latch and re-arms idle eviction on warm reuse", async () => {
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = "5000";
		const f = ensureFixture();
		const live = fakeClient("ts", f.root);
		f.registry.clients.set(f.key, live);
		f.registry.unavailableLogged.add(f.key);
		const outcomes: string[] = [];

		const hit = await f.ensure((outcome) => outcomes.push(outcome));

		expect(hit?.client).toBe(live);
		expect(outcomes).toEqual(["warm-reuse"]);
		expect(f.registry.unavailableLogged.has(f.key)).toBe(false);
		expect(internals(f.registry).idleEvictionTimers.has(f.key)).toBe(true);
		expect(internals(f.registry).clientLastUsedAt.get(f.key)).toBe(T0);
		expect(f.spawn).not.toHaveBeenCalled();
	});
});

describe("ClientRegistry acquisition outcomes (#4449)", () => {
	/** A spawn whose process handle the test releases by hand. */
	function gatedSpawn(f: Fixture) {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.spawn.mockImplementation(async () => {
			await gate;
			return {
				process: {
					process: { killed: false, kill: vi.fn() },
					stdin: {},
					stdout: {},
					stderr: {},
					pid: 77,
				},
			};
		});
		return release;
	}
	/** Let queued microtasks run until the spawn is published in `inFlight`. */
	async function untilInFlight(f: Fixture) {
		for (let turn = 0; turn < 200 && !f.registry.inFlight.has(f.key); turn++) {
			await Promise.resolve();
		}
		expect(f.registry.inFlight.has(f.key)).toBe(true);
	}

	// Recurrence (#2064): the caller that starts a spawn reports `cold-spawn`, one
	// that arrives while it is in flight reports `cold-spawn-joined`. The unguarded
	// read of `inFlight` is the join site the service-level tests do not reach (they
	// join inside the gate); `startedSpawn` defaulting to true made every such
	// joiner count as a second process start, the 3.0x over-count the field showed.
	it("reports a caller that arrives mid-spawn as a joiner", async () => {
		const f = ensureFixture();
		const release = gatedSpawn(f);
		const starter: string[] = [];
		const joiner: string[] = [];
		const first = f.ensure((o) => starter.push(o));
		await untilInFlight(f);
		const second = f.ensure((o) => joiner.push(o));
		release();
		const [a, b] = await Promise.all([first, second]);

		expect(a?.client).toBe(b?.client);
		expect(f.spawn).toHaveBeenCalledTimes(1);
		expect(starter).toEqual(["cold-spawn"]);
		expect(joiner).toEqual(["cold-spawn-joined"]);
		expect(f.registry.inFlight.has(f.key)).toBe(false);
	});

	// Recurrence (#1325): when the ceiling declines the spawn the caller gets
	// `undefined` and a `declined` outcome; it must not dereference the missing
	// spawn handle. Likewise a registry destroyed while the caller waited for the
	// spawn gate starts no process at all.
	it("returns undefined without spawning when capacity declines or the registry was destroyed at the gate", async () => {
		process.env.PI_LENS_LSP_CLIENT_CEILING = "1";
		const full = ensureFixture();
		const busyOther = fakeClient("other", "/elsewhere", { busy: true });
		full.registry.clients.set("other:/elsewhere", busyOther);
		const outcomes: string[] = [];
		await expect(full.ensure((o) => outcomes.push(o))).resolves.toBeUndefined();
		expect(full.spawn).not.toHaveBeenCalled();
		expect(busyOther.shutdown).not.toHaveBeenCalled();

		delete process.env.PI_LENS_LSP_CLIENT_CEILING;
		const f = ensureFixture("go");
		let openGate!: () => void;
		const held = priv(f.registry).withClientSpawnGate(
			() =>
				new Promise<void>((resolve) => {
					openGate = resolve;
				}),
		);
		const pending = f.ensure();
		for (let turn = 0; turn < 50; turn++) await Promise.resolve();
		f.registry.markDestroyed();
		openGate();
		await held;
		await expect(pending).resolves.toBeUndefined();
		expect(f.spawn).not.toHaveBeenCalled();
	});

	// Recurrence (#1934 review F1): the outcome of a spawn that produced no client
	// is read from the verdict the spawn wrote. A policy decline (the service shut
	// down mid-spawn) is `declined`; a real failure is `spawn-failure`. A literal
	// `""` or an inverted read mislabelled one as the other.
	it("names a shutdown mid-spawn `declined` and a failed spawn `spawn-failure`", async () => {
		const declined = ensureFixture();
		const release = gatedSpawn(declined);
		const declinedOutcomes: string[] = [];
		const pending = declined.ensure((o) => declinedOutcomes.push(o));
		await untilInFlight(declined);
		declined.registry.markDestroyed();
		release();
		await expect(pending).resolves.toBeUndefined();
		expect(declinedOutcomes).toEqual(["declined"]);

		const failed = ensureFixture("go");
		failed.spawn.mockRejectedValue(new Error("spawn exploded"));
		const failedOutcomes: string[] = [];
		await expect(
			failed.ensure((o) => failedOutcomes.push(o)),
		).resolves.toBeUndefined();
		expect(failedOutcomes).toEqual(["spawn-failure"]);
	});

	// Recurrence (#2064 review F2): a spawn that throws BEFORE its own try (here the
	// trust flag read, a throwing getter standing in for a host call) is an errored
	// acquisition: the caller sees the original error, with or without an outcome
	// callback. Calling an absent callback replaced the real error with a TypeError.
	it("rethrows the spawn's own error whether or not the caller passed an outcome callback", async () => {
		const f = ensureFixture();
		Object.defineProperty(f.info, "trustAllowed", {
			get() {
				throw new Error("trust read exploded");
			},
		});
		const outcomes: string[] = [];
		await expect(f.ensure((o) => outcomes.push(o))).rejects.toThrow(
			"trust read exploded",
		);
		expect(outcomes).toEqual(["spawn-failure"]);
		expect(f.registry.inFlight.has(f.key)).toBe(false);
		await expect(f.ensure()).rejects.toThrow("trust read exploded");
	});

	// Recurrence: the `finally` removes only ITS OWN promise. A shutdown clears
	// `inFlight`; a replacement spawn may then publish a new promise under the same
	// key while the old one is still settling. Deleting by key alone dropped the
	// replacement, and a third caller started a duplicate process.
	it("leaves a newer in-flight promise alone when an older spawn settles", async () => {
		const f = ensureFixture();
		const release = gatedSpawn(f);
		const pending = f.ensure();
		await untilInFlight(f);
		const replacement = Promise.resolve<SpawnedServer | undefined>(undefined);
		f.registry.inFlight.set(f.key, replacement);
		release();
		await pending;
		expect(f.registry.inFlight.get(f.key)).toBe(replacement);
	});

	// Recurrence (#850): a replacement generation waits for its predecessor's
	// teardown once. The handoff is cleared only if nobody replaced it meanwhile,
	// and a registry destroyed while it waited acquires nothing.
	it("awaits the generation handoff once, keeps a replaced handoff, and honours a destroy during the wait", async () => {
		const f = ensureFixture();
		let open!: () => void;
		const handoff = new Promise<void>((resolve) => {
			open = resolve;
		});
		priv(f.registry).generationHandoff = handoff;
		const pending = f.ensure();
		for (let turn = 0; turn < 50; turn++) await Promise.resolve();
		expect(f.spawn).not.toHaveBeenCalled(); // still waiting on the predecessor
		open();
		await expect(pending).resolves.toBeDefined();
		expect(priv(f.registry).generationHandoff).toBeUndefined();

		const swapped = ensureFixture("go");
		let openSwapped!: () => void;
		const first = new Promise<void>((resolve) => {
			openSwapped = resolve;
		});
		const second = new Promise<void>(() => undefined);
		priv(swapped.registry).generationHandoff = first;
		const waiting = swapped.ensure();
		for (let turn = 0; turn < 50; turn++) await Promise.resolve();
		priv(swapped.registry).generationHandoff = second;
		openSwapped();
		await waiting;
		expect(priv(swapped.registry).generationHandoff).toBe(second);

		const destroyed = ensureFixture("rs");
		const resolveRoot = vi.spyOn(destroyed.info, "root");
		let openDestroyed!: () => void;
		priv(destroyed.registry).generationHandoff = new Promise<void>(
			(resolve) => {
				openDestroyed = resolve;
			},
		);
		const gone = destroyed.ensure();
		for (let turn = 0; turn < 50; turn++) await Promise.resolve();
		destroyed.registry.markDestroyed();
		openDestroyed();
		await expect(gone).resolves.toBeUndefined();
		// Recurrence: the destroy check right after the wait stops the work there;
		// without it the root was still resolved for a registry nobody can use.
		expect(resolveRoot).not.toHaveBeenCalled();
		expect(destroyed.spawn).not.toHaveBeenCalled();
	});
});

describe("ClientRegistry install policy (#4449)", () => {
	// Recurrence (#1363): an untrusted project must never reach an auto-install,
	// and the operator switch is honoured on top of trust. The spawn is told, via
	// `allowInstall`, which of the two applied; the refusal is also a ledger record
	// naming the server. Dropping the trust gate or flipping the return let a
	// denied project install a language server.
	it("passes allowInstall false when trust is denied or the switch is on, true otherwise", async () => {
		const allowed = ensureFixture();
		await allowed.ensure();
		expect(allowed.spawn.mock.calls[0]?.[1]).toMatchObject({
			allowInstall: true,
		});

		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		const switched = ensureFixture("go");
		await switched.ensure();
		expect(switched.spawn.mock.calls[0]?.[1]).toMatchObject({
			allowInstall: false,
		});
		delete process.env.PI_LENS_DISABLE_LSP_INSTALL;

		setProjectTrustState("untrusted");
		const denied = ensureFixture("rs");
		// Admitted by the registry compiler, so the spawn backstop lets it through
		// and only the install decision is under test.
		(denied.info as { trustAllowed?: boolean }).trustAllowed = true;
		await denied.ensure();
		expect(denied.spawn.mock.calls[0]?.[1]).toMatchObject({
			allowInstall: false,
		});
		expect(ledger("trust-refusal")?.latestReasons[0]?.subject).toBe(
			"lsp install: rs",
		);
	});
});

describe("ClientRegistry adopted roots at acquisition (#4449)", () => {
	function adoptedEnsure(withLocalBinary: boolean) {
		const parent = tempProject("adopt-ensure", false);
		const session = path.join(parent, "zzz-session");
		const foreign = path.join(parent, "aaa-foreign");
		fs.mkdirSync(session, { recursive: true });
		fs.mkdirSync(foreign, { recursive: true });
		fs.writeFileSync(path.join(session, "package.json"), "{}\n");
		fs.writeFileSync(path.join(foreign, "package.json"), "{}\n");
		registerSessionRoot(session);
		const bin = path.join(foreign, "node_modules", ".bin", "tsls");
		if (withLocalBinary) {
			fs.mkdirSync(path.dirname(bin), { recursive: true });
			fs.writeFileSync(bin, "#!/bin/sh\n");
		}
		const { hooks } = makeHooks();
		const registry = new ClientRegistry(hooks, undefined, session);
		const spawn = vi.fn(async (_root: string, _options?: unknown) => ({
			process: {
				process: { killed: false, kill: vi.fn() },
				stdin: {},
				stdout: {},
				stderr: {},
				pid: 9,
			},
		}));
		const info = server("ts", {
			root: async () => foreign,
			spawn,
			command: bin,
		});
		createLSPClient.mockImplementation(async () => fakeClient("ts", foreign));
		const key = keyFor("ts", foreign);
		return {
			registry,
			spawn,
			info,
			key,
			foreign,
			file: path.join(foreign, "a.ts"),
		};
	}

	// Recurrence (#4257): a foreign workspace's own binary is code the user did not
	// choose to run. It is refused with one ledger record, and nothing is marked
	// adopted or spawned. `if (localBinary)` flipped to true would also have refused
	// a foreign root with NO local binary, which the next case proves still spawns.
	it("refuses a project-local binary in an adopted root, recording the decision", async () => {
		const f = adoptedEnsure(true);
		await expect(
			f.registry.ensureClientForServer(f.file, f.info),
		).resolves.toBeUndefined();
		expect(f.spawn).not.toHaveBeenCalled();
		expect(internals(f.registry).adoptedClientKeys.has(f.key)).toBe(false);
		expect(ledger("lsp-registry-decision")?.latestReasons).toEqual([
			{
				subject: f.key,
				reason: "project-local LSP binary refused for adopted root",
			},
		]);
	});

	// Recurrence (#4257): an adopted root with no project-local binary is served,
	// marked adopted (so the cap, the lease guard and the 60 s idle window apply),
	// and the server is told project code is NOT allowed.
	it("spawns for an adopted root without a local binary, marks it adopted and withholds project code", async () => {
		const f = adoptedEnsure(false);
		(f.info as { command?: string }).command = undefined;
		const result = await f.registry.ensureClientForServer(f.file, f.info);
		expect(result).toBeDefined();
		expect(internals(f.registry).adoptedClientKeys.has(f.key)).toBe(true);
		expect(f.spawn.mock.calls[0]?.[1]).toMatchObject({
			projectCodeAllowed: false,
		});
	});

	// Recurrence (#4449 survivors 19 and 21): with the linked-worktree early
	// return gone, a second registered root made a worktree of the session's own
	// repository read "adopted". An adopted client may sit only at the
	// classifier's root (#4257), which for a path inside the session repo is the
	// repo itself, so the worktree got no client at all. A linked worktree is the
	// user's code: it is served with project code allowed and is never marked
	// adopted, so the cap-2 adopted LRU cannot evict it.
	it("spawns for a linked worktree of the session repo with project code allowed and does not mark it adopted", async () => {
		const f = linkedWorktreeFixture();
		const registry = new ClientRegistry(makeHooks().hooks, undefined, f.repo);
		const spawn = vi.fn(async (_root: string, _options?: unknown) => ({
			process: {
				process: { killed: false, kill: vi.fn() },
				stdin: {},
				stdout: {},
				stderr: {},
				pid: 9,
			},
		}));
		const info = server("ts", { root: async () => f.worktree, spawn });
		createLSPClient.mockImplementation(async () =>
			fakeClient("ts", f.worktree),
		);

		await expect(
			registry.ensureClientForServer(f.file, info),
		).resolves.toBeDefined();
		expect(spawn.mock.calls[0]?.[1]).toMatchObject({
			projectCodeAllowed: true,
		});
		const a = internals(registry);
		expect(a.adoptedClientKeys.has(keyFor("ts", f.worktree))).toBe(false);
		expect(a.adoptedRootLastUsedAt.size).toBe(0);
	});
});

describe("ClientRegistry.spawnClient breaker ladder (#4449)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	/** Ensure once, forget the cooldown it set (time passed), return the outcome. */
	async function attempt(f: Fixture) {
		const outcomes: string[] = [];
		const result = await f.ensure((o) => outcomes.push(o));
		const cooldown = f.registry.broken.get(f.key);
		f.registry.broken.delete(f.key);
		return { result, outcomes, cooldown };
	}

	// Recurrence (#1127): a server that cannot be spawned at all (binary missing
	// WITH installs allowed) climbs 15s, 30s, 60s, 120s and is latched at the fifth
	// failure. The ladder base, the doubling, the `>=`, and the latch were each
	// reachable by a mutant that left the suite green because every existing
	// spawn-failure test stops at the first cooldown.
	it("climbs the unavailable-spawn ladder and latches at the fifth failure", async () => {
		const f = ensureFixture();
		f.spawn.mockResolvedValue(undefined as never);
		const expected = [15_000, 30_000, 60_000, 120_000, 240_000];
		for (let failure = 1; failure <= 5; failure++) {
			const { result, outcomes, cooldown } = await attempt(f);
			expect(result).toBeUndefined();
			expect(outcomes).toEqual(["spawn-failure"]);
			expect(priv(f.registry).failureCounts.get(f.key)).toBe(failure);
			expect(cooldown).toBe(T0 + expected[failure - 1]);
			expect(f.registry.permanentlyBroken.has(f.key)).toBe(failure === 5);
		}
		expect(ledger("lsp-breaker")?.latestReasons).toEqual([
			{
				subject: f.key,
				reason: "permanently disabled after 5 unavailable spawns",
			},
		]);
	});

	// Recurrence (#1934 review F1): with installs disabled a missing binary is a
	// POLICY decline, not a server failure. It cools down for one base interval,
	// never climbs the ladder or latches, and reports `declined`.
	it("cools a missing binary for one interval without counting it when installs are disabled", async () => {
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		const f = ensureFixture();
		f.spawn.mockResolvedValue(undefined as never);
		for (let touch = 0; touch < 6; touch++) {
			const { result, outcomes, cooldown } = await attempt(f);
			expect(result).toBeUndefined();
			expect(outcomes).toEqual(["declined"]);
			expect(cooldown).toBe(T0 + 15_000);
		}
		expect(priv(f.registry).failureCounts.has(f.key)).toBe(false);
		expect(f.registry.permanentlyBroken.has(f.key)).toBe(false);
	});

	// Recurrence (#1127): a spawn or initialize THROW is the same ladder through the
	// catch path, with its own latch reason and the cap at five minutes.
	it("climbs the throw ladder, latches at the fifth, and reports spawn-failure", async () => {
		const f = ensureFixture();
		createLSPClient.mockRejectedValue(new Error("initialize timed out"));
		const expected = [15_000, 30_000, 60_000, 120_000, 240_000];
		for (let failure = 1; failure <= 5; failure++) {
			const { result, outcomes, cooldown } = await attempt(f);
			expect(result).toBeUndefined();
			expect(outcomes).toEqual(["spawn-failure"]);
			expect(cooldown).toBe(T0 + expected[failure - 1]);
			expect(f.registry.permanentlyBroken.has(f.key)).toBe(failure === 5);
		}
		expect(ledger("lsp-breaker")?.latestReasons).toEqual([
			{
				subject: f.key,
				reason: "permanently disabled after 5 spawn/initialize failures",
			},
		]);
	});

	// Recurrence: the ladder is capped at five minutes. A sixth step would otherwise
	// double past it; `Math.min` flipped to `max` made the FIRST cooldown five
	// minutes and the cap meaningless.
	it("never cools down longer than five minutes", async () => {
		const f = ensureFixture();
		createLSPClient.mockRejectedValue(new Error("boom"));
		priv(f.registry).failureCounts.set(f.key, 7);
		const { cooldown } = await attempt(f);
		expect(cooldown).toBe(T0 + 300_000);
	});

	// Recurrence (#1934 review F1): trust refusals are declines. An untrusted host
	// reaches a raw server (no compiler admission) and the backstop refuses it
	// without cooling the key; a server that executes project code is refused with a
	// FAILED verdict and is never spawned.
	it("declines a raw server under an untrusted host and fails a project-code server", async () => {
		setProjectTrustState("untrusted");
		const raw = ensureFixture();
		const rawOutcomes: string[] = [];
		await expect(
			raw.ensure((o) => rawOutcomes.push(o)),
		).resolves.toBeUndefined();
		expect(rawOutcomes).toEqual(["declined"]);
		expect(raw.spawn).not.toHaveBeenCalled();
		expect(raw.registry.broken.has(raw.key)).toBe(false);

		const code = ensureFixture("go");
		(code.info as { trustAllowed?: boolean }).trustAllowed = true;
		(code.info as { executesProjectCode?: boolean }).executesProjectCode = true;
		const codeOutcomes: string[] = [];
		await expect(
			code.ensure((o) => codeOutcomes.push(o)),
		).resolves.toBeUndefined();
		expect(codeOutcomes).toEqual(["spawn-failure"]);
		expect(code.spawn).not.toHaveBeenCalled();
	});
});

describe("ClientRegistry.spawnClient success and shutdown guards (#4449)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	// Recurrence (#3502, #2356, #1934): publishing a client is one transaction. The
	// replacement is registered with fresh spawn and use stamps, its readiness and
	// stall-demotion markers are dropped, first contact is re-armed BEFORE the
	// process initializes, the breaker's failure streak is cleared and the idle
	// clock starts. Each step had a mutant that left every test green.
	it("registers a spawned client with fresh stamps, re-arms the service hooks and clears the failure streak", async () => {
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = "5000";
		const f = ensureFixture();
		priv(f.registry).failureCounts.set(f.key, 3);
		f.registry.unavailableLogged.add(f.key);
		const initCalls: unknown[] = [];
		createLSPClient.mockImplementation(async (args: unknown) => {
			initCalls.push({ ...(args as object), seenHooks: [...f.calls] });
			const client = fakeClient("ts", f.root);
			f.spawned.push(client);
			return client;
		});
		const result = await f.ensure();

		expect(result?.client).toBe(f.spawned[0]);
		expect(f.registry.clients.get(f.key)).toBe(f.spawned[0]);
		expect(f.registry.clientSpawnedAt.get(f.key)).toBe(T0);
		expect(internals(f.registry).clientLastUsedAt.get(f.key)).toBe(T0);
		expect(priv(f.registry).failureCounts.has(f.key)).toBe(false);
		expect(f.registry.unavailableLogged.has(f.key)).toBe(false);
		expect(internals(f.registry).idleEvictionTimers.has(f.key)).toBe(true);
		// Hooks: first contact re-armed before the client was created; readiness and
		// stall markers cleared after it was registered.
		expect((initCalls[0] as { seenHooks: string[] }).seenHooks).toEqual([
			"rearmFirstContact:ts",
		]);
		expect(f.calls).toEqual([
			"rearmFirstContact:ts",
			`forgetReadiness:${f.key}`,
			`clearStallDemotion:${f.key}`,
		]);
		// What the client factory was handed, and the diagnostics callback wiring.
		const handed = initCalls[0] as Record<string, unknown> & {
			onDiagnosticsPublished(serverId: string): void;
		};
		expect(handed).toMatchObject({
			serverId: "ts",
			root: f.root,
			sessionCwd: undefined,
		});
		handed.onDiagnosticsPublished("ts");
		expect(f.calls.at(-1)).toBe("diagnostics:ts");
		// The one record that says a process started, with its two path fields.
		expect(latencyRecords("lsp_server_spawned")).toEqual([
			{
				type: "phase",
				phase: "lsp_server_spawned",
				filePath: f.root,
				durationMs: 0,
				metadata: {
					serverId: "ts",
					source: "unknown",
					launchVariant: "default",
					triggerFilePath: f.file,
				},
			},
		]);
	});

	// Recurrence (#4299, #3502): what the registry hands the server's spawn() is a
	// policy decision, not plumbing. A file the session root owns may run project
	// code; the session root is the registry's own cwd, else the process cwd. A
	// mutant that withheld project code everywhere, or dropped the session root,
	// still spawned a server and passed every other test.
	it("hands spawn() project-code permission and the session root", async () => {
		const bare = ensureFixture("ts");
		await bare.ensure();
		expect(bare.spawn).toHaveBeenCalledWith(bare.root, {
			allowInstall: true,
			projectCodeAllowed: true,
			sessionRoot: process.cwd(),
		});

		const owned = ensureFixture("go", (root) => root);
		await owned.ensure();
		expect(owned.spawn).toHaveBeenCalledWith(owned.root, {
			allowInstall: true,
			projectCodeAllowed: true,
			sessionRoot: owned.root,
		});
	});

	// Recurrence (#1934 review F1, #2064): a success is the last word on the
	// attempts before it. The previous failed verdict is dropped so the map never
	// outlives what it describes, the spawn duration enters the process-lifetime
	// history the LSP readiness budget reads, and the widget's server record turns
	// from "spawning" to "ready" rather than staying failed. Each step survived
	// its removal.
	it("retires the failed verdict, records the spawn duration and marks the widget record ready", async () => {
		const f = ensureFixture();
		f.spawn.mockResolvedValueOnce(undefined as never);
		await expect(f.ensure()).resolves.toBeUndefined();
		expect(priv(f.registry).lastSpawnVerdict.get(f.key)).toBe("failed");
		expect(getFailedLspServerIds()).toEqual(["ts"]);

		vi.setSystemTime(T0 + 60 * MIN);
		f.spawn.mockImplementationOnce(async () => {
			vi.setSystemTime(T0 + 60 * MIN + 120);
			return {
				process: {
					process: { killed: false, kill: vi.fn() },
					stdin: {},
					stdout: {},
					stderr: {},
					pid: 4243,
				},
			};
		});
		await expect(f.ensure()).resolves.toBeDefined();

		expect(priv(f.registry).lastSpawnVerdict.has(f.key)).toBe(false);
		expect(getSuccessfulLspSpawnDurationMs("ts")).toBe(120);
		expect(getFailedLspServerIds()).toEqual([]);
	});

	// Recurrence (#1937 widget audit): the widget shows "LSP↑" only for a server in
	// spawning state. A start record whose status string was wrong landed the
	// server in the failed list while it was still starting, so /lens-health
	// reported a healthy cold start as a failed server.
	it("keeps a spawning server out of the failed list until the spawn settles", async () => {
		const f = ensureFixture();
		let release!: (value: never) => void;
		f.spawn.mockImplementationOnce(
			() => new Promise<never>((resolve) => (release = resolve)),
		);
		const pending = f.ensure();
		await vi.advanceTimersByTimeAsync(0);
		expect(getFailedLspServerIds()).toEqual([]);
		release(undefined as never);
		await pending;
		expect(getFailedLspServerIds()).toEqual(["ts"]);
	});

	// Recurrence (#4299): a launch variant decides who wins a config conflict. The
	// default launch lets the user's `serverOverrides` override the server's own
	// initializationOptions; the classic launch (the compiler owner's admitted
	// path) must survive config merging, so the server's options win there. No
	// override at all must not throw. Both orders, and the absent override, had
	// surviving mutants.
	it("merges a configured init override under the launch variant's precedence", async () => {
		setProjectTrustState("trusted");
		const initFor = async (
			variant: string | undefined,
			withOverride: boolean,
		) => {
			const f = ensureFixture("ts");
			if (withOverride) {
				fs.mkdirSync(path.join(f.root, ".pi-lens"), { recursive: true });
				fs.writeFileSync(
					path.join(f.root, ".pi-lens/lsp.json"),
					JSON.stringify({
						serverOverrides: {
							ts: {
								initializationOptions: { shared: "override", fromOverride: 1 },
							},
						},
					}),
				);
				await initLSPConfig(f.root);
			}
			f.spawn.mockImplementation(async () => ({
				process: {
					process: { killed: false, kill: vi.fn() },
					stdin: {},
					stdout: {},
					stderr: {},
					pid: 4244,
				},
				launchVariant: variant,
				initialization: { shared: "server", fromServer: 1 },
			}));
			await f.ensure();
			const handed = createLSPClient.mock.calls.at(-1)?.[0] as
				| { initialization: unknown }
				| undefined;
			return handed?.initialization;
		};
		expect(await initFor("classic", true)).toEqual({
			shared: "server",
			fromServer: 1,
			fromOverride: 1,
		});
		expect(await initFor(undefined, true)).toEqual({
			shared: "override",
			fromServer: 1,
			fromOverride: 1,
		});
		resetSessionRootsForTests();
		expect(await initFor("classic", false)).toEqual({
			shared: "server",
			fromServer: 1,
		});
	});

	// Recurrence (#1127 review): a service shut down WHILE the process was spawning
	// has no client yet; the raw process is killed, the key is NOT marked broken
	// (this is not a server failure) and nothing is registered. If the shutdown
	// lands during the initialize handshake instead, the live client is shut down
	// fast and not registered. Dropping either guard leaked a language server past
	// `lsp_service_reset`.
	it("kills a process spawned after shutdown, and shuts a client down fast when shutdown hit the handshake", async () => {
		const midSpawn = ensureFixture();
		const kill = vi.fn();
		midSpawn.spawn.mockImplementation(async () => {
			midSpawn.registry.markDestroyed();
			return {
				process: {
					process: { killed: false, kill },
					stdin: {},
					stdout: {},
					stderr: {},
					pid: 5,
				},
			};
		});
		await expect(midSpawn.ensure()).resolves.toBeUndefined();
		expect(kill).toHaveBeenCalledTimes(1);
		expect(midSpawn.registry.clients.size).toBe(0);
		expect(midSpawn.registry.broken.has(midSpawn.key)).toBe(false);
		expect(priv(midSpawn.registry).failureCounts.has(midSpawn.key)).toBe(false);

		const midInit = ensureFixture("go");
		const lateClient = fakeClient("go", midInit.root);
		createLSPClient.mockImplementation(async () => {
			midInit.registry.markDestroyed();
			return lateClient;
		});
		await expect(midInit.ensure()).resolves.toBeUndefined();
		expect(lateClient.shutdown).toHaveBeenCalledWith({ fast: true });
		expect(midInit.registry.clients.size).toBe(0);
		expect(midInit.registry.broken.has(midInit.key)).toBe(false);
		expect(midInit.calls).toEqual(["rearmFirstContact:go"]);
	});
});

describe("ClientRegistry status snapshots (#4449)", () => {
	// Recurrence (#4449 campaign finding): a client key is `<serverId>:<root>` and
	// the root can carry colons of its own (a Windows drive `c:/work/proj`, or a
	// POSIX directory named `a:b`). `getStatus` split the key at EVERY colon and
	// kept the second piece, so /lens-health and the engine status read the root
	// as `c` or `/srv/a`. `getBrokenStatus` always cut at the first colon only.
	// Both must read the same key the same way.
	it("reads a key as the server id before the first colon and the whole root after it", () => {
		const { hooks } = makeHooks();
		const registry = new ClientRegistry(hooks);
		const keys = [
			["typescript", "c:/work/proj"],
			["typescript", "/srv/a:b/proj"],
			// A key that opens with its separator reads as an empty server id.
			["", "/work/empty-id"],
		] as const;
		for (const [id, root] of keys) {
			registry.clients.set(`${id}:${root}`, fakeClient(id, root));
			registry.broken.set(`${id}:${root}`, T0);
		}

		expect(
			registry.getStatus().map(({ serverId, root }) => [serverId, root]),
		).toEqual(keys.map(([id, root]) => [id, root]));
		expect(
			registry.getBrokenStatus().map(({ serverId, root }) => [serverId, root]),
		).toEqual(keys.map(([id, root]) => [id, root]));
	});
});

describe("ClientRegistry status snapshots, shapes (#4449)", () => {
	// Recurrence (#1127): the `/lens-health` breaker line sums spawn failures with
	// the LARGER of the two runtime-exit streams. `+` for `-`, or `min` for `max`,
	// would show a permanent disable as fewer failures than its own counters hold.
	it("reports the breaker state of a key, summing failures with the larger exit stream", () => {
		const { hooks } = makeHooks();
		const registry = new ClientRegistry(hooks);
		const key = "ts:/work/a";
		registry.broken.set(key, T0 + 5);
		priv(registry).failureCounts.set(key, 2);
		priv(registry).runtimeExitCounts.set(key, 1);
		priv(registry).runtimeExitWindow.set(key, [T0, T0, T0]);
		priv(registry).permanentlyBroken.add("go:/work/b");
		priv(registry).failureCounts.set("go:/work/b", 5);
		priv(registry).runtimeExitCounts.set("go:/work/b", 4);
		registry.broken.set("bare", T0);

		expect(registry.getBrokenStatus()).toEqual([
			{
				serverId: "ts",
				root: "/work/a",
				failures: 5,
				permanentlyBroken: false,
				cooldownUntil: T0 + 5,
			},
			{
				serverId: "bare",
				root: "",
				failures: 0,
				permanentlyBroken: false,
				cooldownUntil: T0,
			},
			{
				serverId: "go",
				root: "/work/b",
				failures: 9,
				permanentlyBroken: true,
				cooldownUntil: 0,
			},
		]);
	});

	// Recurrence (#1127): `getStatus` is the surface that feeds the health line, so
	// an unbounded server message was a telemetry leak. Messages are cut to 200
	// characters on a copy (the client keeps its own history), a client without a
	// history reads as empty, and a dead client reads as disconnected.
	it("reports liveness and copies the pull-failure history with messages cut to 200 characters", () => {
		const { hooks } = makeHooks();
		const registry = new ClientRegistry(hooks);
		const longMessage = "x".repeat(300);
		const history = [
			{
				timestamp: 7,
				method: "textDocument/diagnostic" as const,
				code: 1,
				message: longMessage,
			},
		];
		const alive = Object.assign(fakeClient("ts", "/work/a"), {
			getPullFailureHistory: () => history,
		});
		const dead = fakeClient("go", "/work/b");
		dead.kill();
		registry.clients.set("ts:/work/a", alive);
		registry.clients.set("go:/work/b", dead);

		expect(registry.getStatus()).toEqual([
			{
				serverId: "ts",
				root: "/work/a",
				connected: true,
				pullFailureHistory: [
					{
						timestamp: 7,
						method: "textDocument/diagnostic",
						code: 1,
						message: "x".repeat(200),
					},
				],
			},
			{
				serverId: "go",
				root: "/work/b",
				connected: false,
				pullFailureHistory: [],
			},
		]);
		expect(history[0].message).toHaveLength(300);
	});

	// Recurrence (#267): the alive count and the alive-id list feed the footer and
	// the readiness widget. A dead client must not count, one server serving two
	// roots collapses to one id, and cross-cutting scanners (opengrep) sort after
	// the language servers whatever order they spawned in.
	it("counts only live clients and lists server ids primary-first, deduped across roots", () => {
		const { hooks } = makeHooks();
		const registry = new ClientRegistry(hooks);
		const add = (id: string, root: string, live = true) => {
			const client = fakeClient(id, root);
			if (!live) client.kill();
			registry.clients.set(`${id}:${root}`, client);
		};
		add("opengrep", "/work/a");
		add("typescript", "/work/a");
		add("typescript", "/work/b");
		add("go", "/work/a", false);
		add("python", "/work/a");

		expect(registry.getAliveClientCount()).toBe(4);
		expect(registry.getAliveServerIds()).toEqual([
			"typescript",
			"python",
			"opengrep",
		]);
	});
});

describe("ClientRegistry.recordRuntimeExitWindow (#4449)", () => {
	// Recurrence (#1142): the windowed-rate breaker only counts deaths that carry
	// a known, short lifetime. A sleep-gap (a lifetime past ten minutes) or a
	// death with no recorded time is not churn; a lifetime of exactly ten minutes
	// still is. The window is anchored on the newest death and keeps an entry
	// exactly one window old; the retained array never holds more than the trip
	// count (drop-oldest).
	it("ignores unmeasured and long-lived deaths, keeps the window edge and caps the retained array", () => {
		const { hooks } = makeHooks();
		const registry = new ClientRegistry(hooks);
		const record = (at: number | undefined, uptime: number | null) =>
			priv(registry).recordRuntimeExitWindow("ts:/r", at, uptime);
		const window = () => priv(registry).runtimeExitWindow.get("ts:/r");

		expect(record(undefined, 1000)).toBe(false);
		expect(record(T0, null)).toBe(false);
		expect(record(T0, 10 * MIN + 1)).toBe(false);
		expect(window()).toBeUndefined();

		expect(record(T0, 10 * MIN)).toBe(false);
		expect(window()).toEqual([T0]);
		// Exactly 15 minutes older than the newest death: still inside the window.
		expect(record(T0 + 15 * MIN, 1000)).toBe(false);
		expect(window()).toEqual([T0, T0 + 15 * MIN]);
		// One millisecond older than the window: dropped.
		expect(record(T0 + 15 * MIN + 1, 1000)).toBe(false);
		expect(window()).toEqual([T0 + 15 * MIN, T0 + 15 * MIN + 1]);

		// Fill to the trip count: the fifth death trips, the sixth is capped.
		expect(record(T0 + 15 * MIN + 2, 1000)).toBe(false);
		expect(record(T0 + 15 * MIN + 3, 1000)).toBe(false);
		expect(record(T0 + 15 * MIN + 4, 1000)).toBe(true);
		expect(window()).toHaveLength(5);
		expect(record(T0 + 15 * MIN + 5, 1000)).toBe(true);
		expect(window()).toEqual([
			T0 + 15 * MIN + 1,
			T0 + 15 * MIN + 2,
			T0 + 15 * MIN + 3,
			T0 + 15 * MIN + 4,
			T0 + 15 * MIN + 5,
		]);
	});
});

describe("ClientRegistry shutdown (#4449)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	// Recurrence (#1127 review, lsp_service_reset): a reset waits for spawns that
	// are still in flight so the client they produce is shut down fast and not
	// leaked, then hands every registered client the caller's options. Dropping
	// the wait, the fast shutdown or the options leaked a language server past
	// `lsp_service_reset`.
	it("shuts down a client that finishes spawning during the reset, then hands every client the caller's options", async () => {
		const f = ensureFixture();
		let release!: (value: never) => void;
		f.spawn.mockImplementationOnce(
			() => new Promise<never>((resolve) => (release = resolve)),
		);
		const pending = f.ensure();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.registry.inFlight.size).toBe(1);

		const reset = f.registry.shutdownClients({ fast: false });
		// The pending set is taken and emptied before the wait, so a spawn that
		// starts during it cannot be shut down twice or be re-awaited.
		expect(f.registry.inFlight.size).toBe(0);
		release({
			process: {
				process: { killed: false, kill: vi.fn() },
				stdin: {},
				stdout: {},
				stderr: {},
				pid: 7,
			},
		} as never);
		await pending;
		await reset;

		expect(f.registry.inFlight.size).toBe(0);
		expect(f.spawned[0].shutdown.mock.calls).toEqual([
			[{ fast: true }],
			[{ fast: false }],
		]);
	});

	// Recurrence (#1127 review): an in-flight spawn that came back empty or threw
	// has no client to shut down; the reset must neither throw nor stall on it.
	it("tolerates an in-flight spawn that returned nothing or failed", async () => {
		for (const outcome of ["empty", "throws"] as const) {
			const f = ensureFixture();
			let settle!: () => void;
			f.spawn.mockImplementationOnce(
				() =>
					new Promise<never>((resolve, reject) => {
						settle = () =>
							outcome === "empty"
								? resolve(undefined as never)
								: reject(new Error("spawn exploded"));
					}),
			);
			const pending = f.ensure().catch(() => undefined);
			await vi.advanceTimersByTimeAsync(0);
			const reset = f.registry.shutdownClients({});
			settle();
			await pending;
			await expect(reset).resolves.toBe(0);
			expect(f.registry.inFlight.size).toBe(0);
			expect(f.spawned).toHaveLength(0);
		}
	});

	// Recurrence (#1127 review, lsp_service_reset): the count the reset reports is
	// what was alive BEFORE teardown, a snapshot that would always read zero
	// after it. A client whose shutdown rejects must not stop the others, every
	// idle-eviction timer is dropped, and the dead client is told to shut down
	// too (its process tree can outlive the connection).
	it("reports the pre-teardown alive count, survives a rejecting client and drops the idle timers", async () => {
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = "5000";
		const f = ensureFixture("ts");
		await f.ensure();
		const other = ensureFixture("go");
		const stay = fakeClient("go", other.root);
		const dead = fakeClient("py", other.root);
		dead.kill();
		for (const [id, c] of [
			["go", stay],
			["py", dead],
		] as const) {
			f.registry.clients.set(`${id}:${other.root}`, c);
		}
		for (const c of [f.spawned[0], stay]) {
			c.shutdown.mockImplementation(async () => {
				c.kill();
			});
		}
		dead.shutdown.mockRejectedValue(new Error("already gone"));
		expect(internals(f.registry).idleEvictionTimers.size).toBe(1);

		const aliveBefore = await f.registry.shutdownClients({ fast: true });

		expect(aliveBefore).toBe(2);
		expect(f.registry.getAliveClientCount()).toBe(0);
		for (const c of [f.spawned[0], stay, dead]) {
			expect(c.shutdown).toHaveBeenCalledWith({ fast: true });
		}
		expect(internals(f.registry).idleEvictionTimers.size).toBe(0);
	});

	// Recurrence (#1127 review): when the host process itself is exiting the event
	// loop is closing and the reset must not block on a spawn that may never
	// settle. The in-flight map is dropped, not awaited.
	it("does not wait for an in-flight spawn when the process is exiting", async () => {
		const f = ensureFixture();
		let release!: (value: never) => void;
		f.spawn.mockImplementationOnce(
			() => new Promise<never>((resolve) => (release = resolve)),
		);
		const pending = f.ensure();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.registry.inFlight.size).toBe(1);

		await expect(
			f.registry.shutdownClients({ processExiting: true }),
		).resolves.toBe(0);
		expect(f.registry.inFlight.size).toBe(0);
		release(undefined as never);
		await pending;
	});

	// Recurrence (#1934 review F1): `clearAfterShutdown` is the second half of a
	// reset. Every per-generation map is emptied; a map left behind held a verdict
	// or a log latch for a client generation that no longer exists.
	it("empties every per-generation map after a reset", () => {
		const f = ensureFixture();
		f.registry.clients.set(f.key, fakeClient("ts", f.root));
		f.registry.broken.set(f.key, T0);
		priv(f.registry).lastSpawnVerdict.set(f.key, "failed");
		priv(f.registry).workspaceProbeLogged.add(f.key);
		priv(f.registry).warmStartLogged.add(f.key);

		f.registry.clearAfterShutdown();

		expect(f.registry.clients.size).toBe(0);
		expect(f.registry.broken.size).toBe(0);
		expect(priv(f.registry).lastSpawnVerdict.size).toBe(0);
		expect(priv(f.registry).workspaceProbeLogged.size).toBe(0);
		expect(priv(f.registry).warmStartLogged.size).toBe(0);
	});
});

describe("client-registry environment limits (#4449)", () => {
	// Recurrence (#3645): the idle window has a generic spelling and a legacy
	// TypeScript one. The generic wins; an unset, zero, negative, fractional-only
	// or unsafe value is ignored and the next spelling, then the 20 minute default,
	// answers. A `>= 0` comparison let a zero window evict every client at once.
	it("reads the idle window from the generic spelling, then the legacy one, else 20 minutes", () => {
		expect(getLspIdleEvictMs()).toBe(20 * MIN);
		process.env.PI_LENS_TS_IDLE_EVICT_MS = "30000";
		expect(getLspIdleEvictMs()).toBe(30_000);
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = "45000";
		expect(getLspIdleEvictMs()).toBe(45_000);
		for (const bad of ["0", "-5", "abc", "", "99999999999999999999"]) {
			process.env.PI_LENS_LSP_IDLE_EVICT_MS = bad;
			expect(getLspIdleEvictMs()).toBe(30_000);
		}
		process.env.PI_LENS_TS_IDLE_EVICT_MS = "0";
		expect(getLspIdleEvictMs()).toBe(20 * MIN);
	});

	// Recurrence (#1129 F6): only a git checkout inside the host temp directory
	// takes the aggressive window; its own variable falls back to 60 seconds on a
	// zero, negative or unparsable value, never to the generic window.
	it("gives a temporary checkout its own idle window, defaulting to 60 seconds", () => {
		const checkout = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-reg4449-eph-"),
		);
		dirs.push(checkout);
		fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
		fs.writeFileSync(
			path.join(checkout, ".git", "HEAD"),
			"ref: refs/heads/m\n",
		);
		const plain = tempProject("plain");
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = "120000";

		expect(getLspIdleEvictMsForRoot(checkout)).toBe(60_000);
		process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS = "1000";
		expect(getLspIdleEvictMsForRoot(checkout)).toBe(1000);
		expect(getLspIdleEvictMsForRoot(plain)).toBe(120_000);
		for (const bad of ["0", "-1", "soon"]) {
			process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS = bad;
			expect(getLspIdleEvictMsForRoot(checkout)).toBe(60_000);
		}
	});

	// Recurrence (#267): the client ceiling bounds how many language servers a
	// session holds. Unset or unusable values keep the default of 24.
	it("reads the client ceiling, ignoring zero, negative and unparsable values", () => {
		expect(getLspClientCeiling()).toBe(24);
		process.env.PI_LENS_LSP_CLIENT_CEILING = "3";
		expect(getLspClientCeiling()).toBe(3);
		for (const bad of ["0", "-2", "many", "99999999999999999999"]) {
			process.env.PI_LENS_LSP_CLIENT_CEILING = bad;
			expect(getLspClientCeiling()).toBe(24);
		}
	});
});

describe("mergeInitializationOptions (#4449)", () => {
	// Recurrence (#4299): a user override reaches into nested server settings. A
	// plain object merges key by key at every depth; an array, a primitive, a
	// null, or a plain object landing on a non-object REPLACES the base value.
	// Each guard in the recursion condition had a surviving mutant.
	it("merges plain objects recursively and replaces everything else", () => {
		const base = {
			keep: 1,
			nested: { a: 1, deep: { x: 1, y: 2 } },
			list: [1, 2],
			obj: { k: 1 },
			str: "text",
			nul: null,
			num: 5,
		};
		const override = {
			nested: { b: 2, deep: { y: 9 } },
			list: [3],
			obj: [7],
			str: { now: "object" },
			nul: { was: "null" },
			num: { n: 1 },
			fresh: { z: 1 },
		};
		expect(mergeInitializationOptions(base, override)).toEqual({
			keep: 1,
			nested: { a: 1, b: 2, deep: { x: 1, y: 9 } },
			list: [3],
			obj: [7],
			str: { now: "object" },
			nul: { was: "null" },
			num: { n: 1 },
			fresh: { z: 1 },
		});
		expect(
			mergeInitializationOptions(
				{ a: { x: 1 }, b: { x: 1 }, c: { x: 1 } },
				{ a: 5, b: null, c: [1] },
			),
		).toEqual({ a: 5, b: null, c: [1] });
		expect(base.nested.deep).toEqual({ x: 1, y: 2 });
	});

	// Recurrence (#4299): one-sided input is returned as it came, never merged
	// into an empty object, so a server that sends no options stays optionless.
	it("returns the only defined side untouched", () => {
		const side = { a: { b: 1 } };
		expect(mergeInitializationOptions(undefined, undefined)).toBeUndefined();
		expect(mergeInitializationOptions(side, undefined)).toBe(side);
		expect(mergeInitializationOptions(undefined, side)).toBe(side);
	});
});

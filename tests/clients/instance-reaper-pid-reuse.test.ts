// flake-shape: real-process-spawn — the defect is a SIGKILL landing on a process the reaper misidentified, so each case needs a real pid whose command line and kernel start time are the reaper's actual evidence; a double would encode the very identity guess #3538 is about.
/**
 * #3538 — the orphan reaper kills a live process when a recorded pid is
 * reused.
 *
 * `sweepOrphans` identified a recorded child by the BASENAME of its command
 * line, queried once per sweep, and then killed pid after pid. Three
 * replays of the TLA+ counterexamples (`formal/instance-reaper/`) against
 * the built code:
 *
 * - RecheckOnly: a dead instance's record names a pid that now belongs to a
 *   live instance's typescript-language-server. The basename matched.
 * - RecheckOnlyNodeCmd: the recorded command is `node` (the Windows `.ps1`
 *   bypass), which a live pi-lens host matches.
 * - ReuseToctou: the pid changes identity after the sweep's query and before
 *   its kill.
 *
 * The fix records each child's OS start time (and the host's), kills only
 * while (pid, start) still matches, and asks again immediately before each
 * signal. Every process here is a real child of this test, so the kill guard
 * (`tests/support/kill-guard.ts`) admits the reaper's signals. The process
 * table the reaper sees is the real one, filtered to this test's own pids,
 * so no kill can reach a process the test did not start. A pid reused by
 * the kernel cannot be arranged on demand: a reused pid is stood for by a
 * record naming a live process with a start that is not its own, which is
 * exactly what the reaper would read after a real reuse.
 *
 * #3539 — on POSIX a lost registry record leaked the orphan for good. The
 * #658 backstop judged ownership by "the ppid is dead", and a POSIX orphan
 * is reparented to init or a subreaper, which is alive. The replays
 * PosixFootprint, PosixScanFail, PosixStaleMcp and PosixLateRecord below
 * lose the record four ways; PosixSamePid, above, is the fifth. Every LSP
 * child now carries its owner's incarnation (`PI_LENS_OWNER=<pid>:<start>`)
 * and the POSIX backstop reaps by whether that incarnation is dead. Each
 * orphan's ppid here is this live test process, standing for init.
 *
 * lane: Unit tests (ubuntu). Linux only (`describe.skipIf`): the start-time
 * oracle below reads `/proc/<pid>/stat` directly rather than through the
 * helper under test, and the kill guard that polices these signals is
 * Linux-only too.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const h = vi.hoisted(() => ({
	dir: "",
	/** Every pid this file spawned: the only rows the reaper may see. */
	mine: new Set<number>(),
	/** Runs once, after the first identity query returns. */
	afterFirstIdentityQuery: undefined as undefined | (() => Promise<void>),
	/** The next identity query times out (one shot). */
	failNextIdentityQuery: false,
	/** Runs once, after the first owner-tag read returns. */
	afterFirstTagRead: undefined as undefined | (() => Promise<void>),
	latency: [] as Array<{ phase?: string; metadata?: Record<string, unknown> }>,
}));

vi.mock("../../clients/file-utils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/file-utils.js")>()),
	getGlobalPiLensDir: () => h.dir,
}));

vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency: (entry: {
		phase?: string;
		metadata?: Record<string, unknown>;
	}) => {
		h.latency.push(entry);
	},
}));

function takeIdentityFailure(): boolean {
	const fail = h.failNextIdentityQuery;
	h.failNextIdentityQuery = false;
	return fail;
}

async function runIdentityHook(): Promise<void> {
	const hook = h.afterFirstIdentityQuery;
	h.afterFirstIdentityQuery = undefined;
	h.afterFirstTagRead = undefined;
	if (hook) await hook();
}

// The backstop's enumeration sees only this file's pids, so nothing else is
// ever a candidate. Identity reads (a pid's command line and start) see the
// real table, as in production: an owner or host pid the reaper judges may
// be any process. The identity hook sits on both doors an identity query can
// take: the pid-filtered table query the reaper made before #3538, and the
// identity query it makes since.
vi.mock("../../clients/process-snapshot.js", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("../../clients/process-snapshot.js")>();
	return {
		...real,
		queryProcessTable: async (
			request: Parameters<typeof real.queryProcessTable>[0],
			options: Parameters<typeof real.queryProcessTable>[1],
		) => {
			if (request.filter?.column === "ProcessId" && takeIdentityFailure())
				return {
					rows: [],
					status: "timeout" as const,
					serverSideFiltered: true,
				};
			const result = await real.queryProcessTable(request, options);
			const identity = request.filter?.column === "ProcessId";
			const rows = identity
				? result.rows
				: result.rows.filter((row) => h.mine.has(row.pid));
			if (identity) await runIdentityHook();
			return { ...result, rows };
		},
		queryProcessIdentities: async (
			pids: readonly number[],
			options: Parameters<typeof real.queryProcessIdentities>[1],
		) => {
			if (takeIdentityFailure())
				return { identities: new Map(), status: "timeout" as const };
			const result = await real.queryProcessIdentities(pids, options);
			await runIdentityHook();
			return result;
		},
		readOwnerTags: async (
			pids: readonly number[],
			options: Parameters<typeof real.readOwnerTags>[1],
		) => {
			const result = await real.readOwnerTags(pids, options);
			const hook = h.afterFirstTagRead;
			h.afterFirstTagRead = undefined;
			if (hook) await hook();
			return result;
		},
	};
});

const { sweepOrphans, sweepUntrackedOrphans } =
	await import("../../clients/instance-reaper.js");
const { getResourceFootprint, _settleRegistryMutationsForTests } =
	await import("../../clients/instance-registry.js");

const TSLS = "/opt/fake/node_modules/typescript-language-server/lib/cli.mjs";
const TSLS_BIN = "/opt/fake/node_modules/.bin/typescript-language-server";
const children: ChildProcess[] = [];

/** Every non-probe signal the code under test sends. */
const signals: string[] = [];
const kill = process.kill;
function recordSignals(): void {
	const inner = process.kill;
	process.kill = ((pid: number, signal?: string | number) => {
		if (signal !== 0 && signal !== "0")
			signals.push(`${String(signal ?? "SIGTERM")}->${pid}`);
		return inner(pid, signal as never);
	}) as typeof process.kill;
}
const signalledPids = () =>
	new Set(signals.map((s) => Math.abs(Number(s.split("->")[1]))));

function track(child: ChildProcess): ChildProcess {
	children.push(child);
	h.mine.add(child.pid as number);
	return child;
}
/**
 * A live node process whose command line looks like a node-launched LSP.
 * `owner` sets the tag a pi-lens owner gives the children it spawns
 * (#3539); its ppid is always this test, standing for the live init or
 * subreaper a POSIX orphan is reparented to.
 */
function spawnLsp(owner?: string): ChildProcess {
	const env = { ...process.env };
	delete env.PI_LENS_OWNER;
	if (owner !== undefined) env.PI_LENS_OWNER = owner;
	return track(
		spawn(
			process.execPath,
			["-e", "setInterval(()=>{},1e6)", TSLS, "--stdio"],
			{ stdio: "ignore", detached: true, env },
		),
	);
}
/** A live node process standing for a pi-lens host. */
function spawnHost(): ChildProcess {
	return track(
		spawn(
			process.execPath,
			["-e", "setInterval(()=>{},1e6)", "/opt/fake/pi/dist/cli.js"],
			{ stdio: "ignore", detached: true },
		),
	);
}
/** A pid that is confirmed dead: a child that ran and was reaped. */
function deadPid(): number {
	return spawnSync("true").pid as number;
}
/**
 * The kernel's start time for `pid`, qualified by this boot:
 * `/proc/<pid>/stat` field 22 and `/proc/sys/kernel/random/boot_id`.
 */
function startOf(pid: number): string {
	const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	const boot = fs
		.readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
		.trim();
	return `${ticks}@${boot}`;
}
/**
 * A start of THIS boot that is not any test process's: stands for "the pid
 * was reused". A start from another boot is not a reuse but an unjudgeable
 * read (#3538 review R3-F1). The file's cases run on Linux only.
 */
const OTHER_START = `1@${
	process.platform === "linux"
		? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
		: ""
}`;

interface Kid {
	pid: number;
	command?: string;
	processStart?: string;
}
function entry(
	pid: number,
	kids: Kid[],
	options: { processStart?: string; heartbeatAgoMs?: number } = {},
) {
	const at = new Date(Date.now() - (options.heartbeatAgoMs ?? 0)).toISOString();
	return {
		pid,
		...(options.processStart ? { processStart: options.processStart } : {}),
		startedAt: at,
		projectRoot: "/repo/x",
		projectRoots: ["/repo/x"],
		lspChildren: kids.map((kid) => ({
			pid: kid.pid,
			serverId: "typescript",
			command: kid.command ?? TSLS_BIN,
			spawnedAt: at,
			...(kid.processStart ? { processStart: kid.processStart } : {}),
		})),
		lspChildCount: kids.length,
		rssBytes: 0,
		heartbeatAt: at,
	};
}
function writeRegistry(instances: unknown[]): void {
	fs.writeFileSync(
		path.join(h.dir, "instances.json"),
		JSON.stringify({ instances }),
	);
}
function registryEntries(): Array<{ pid: number; processStart?: string }> {
	return JSON.parse(fs.readFileSync(path.join(h.dir, "instances.json"), "utf8"))
		.instances;
}
function sweepRecord(): Record<string, unknown> | undefined {
	return h.latency.find((r) => r.phase === "orphan_lsp_reaped")?.metadata;
}

beforeEach(() => {
	h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-reuse-"));
	h.afterFirstIdentityQuery = undefined;
	h.latency.length = 0;
	signals.length = 0;
	recordSignals();
});
afterEach(() => {
	process.kill = kill;
	removeTempDirSync(h.dir);
});
afterAll(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
	}
});

describe.skipIf(process.platform !== "linux")(
	"#3538: a kill by pid lands only on the process that was recorded",
	() => {
		it("[RecheckOnly] a dead instance's record naming a live server's pid under another start is not killed", async () => {
			const hostB = spawnHost();
			const server = spawnLsp();
			const pid = server.pid as number;
			writeRegistry([
				entry(deadPid(), [{ pid, processStart: OTHER_START }]),
				entry(hostB.pid as number, [{ pid, processStart: startOf(pid) }], {
					processStart: startOf(hostB.pid as number),
				}),
			]);

			await sweepOrphans();

			expect(signals).toEqual([]);
			expect(server.exitCode ?? server.signalCode).toBeNull();
			expect(registryEntries().map((e) => e.pid)).toEqual([hostB.pid]);
		});

		it("[RecheckOnlyNodeCmd] a recorded node child whose pid is now a live host is not killed", async () => {
			const hostB = spawnHost();
			const pid = hostB.pid as number;
			writeRegistry([
				entry(deadPid(), [
					{ pid, command: process.execPath, processStart: OTHER_START },
				]),
				entry(pid, [], { processStart: startOf(pid) }),
			]);

			await sweepOrphans();

			expect(signals).toEqual([]);
			expect(hostB.exitCode ?? hostB.signalCode).toBeNull();
		});

		it("a record with no start (an older pi-lens, a failed read) is never killed by pid", async () => {
			const server = spawnLsp();
			writeRegistry([entry(deadPid(), [{ pid: server.pid as number }])]);

			await sweepOrphans();

			expect(signals).toEqual([]);
			expect(server.exitCode ?? server.signalCode).toBeNull();
		});

		it("[ReuseToctou] a pid that changes identity after the sweep's query is not signalled", async () => {
			// The recorded orphan becomes another program on the same pid once
			// the sweep has queried it: `exec` stands for the kernel handing the
			// pid to a new process between the decision and the kill.
			const orphan = track(
				spawn("sh", ["-c", "read x; exec sleep 1000", "sh", TSLS], {
					stdio: ["pipe", "ignore", "ignore"],
					detached: true,
				}),
			);
			const pid = orphan.pid as number;
			writeRegistry([entry(deadPid(), [{ pid, processStart: startOf(pid) }])]);
			const cmdline = () =>
				fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
			h.afterFirstIdentityQuery = async () => {
				orphan.stdin?.write("go\n");
				while (!cmdline().startsWith("sleep")) {
					await new Promise((resolve) => setImmediate(resolve));
				}
			};

			await sweepOrphans();

			expect(signalledPids().has(pid)).toBe(false);
			expect(orphan.exitCode ?? orphan.signalCode).toBeNull();
			expect(sweepRecord()).toMatchObject({ killed: 0, identityChanged: 1 });
		});

		it("an orphan that still has its recorded start is reaped (control)", async () => {
			const orphan = spawnLsp();
			const pid = orphan.pid as number;
			writeRegistry([entry(deadPid(), [{ pid, processStart: startOf(pid) }])]);
			const exited = once(orphan, "exit");

			await sweepOrphans();

			expect(signalledPids().has(pid)).toBe(true);
			const [, signal] = await exited;
			expect(signal).toBe("SIGKILL");
			expect(sweepRecord()).toMatchObject({ killed: 1, identityChanged: 0 });
			expect(registryEntries()).toEqual([]);
		});

		it("a live host pid under another start is a dead instance: its orphan is reaped", async () => {
			const stranger = spawnHost(); // took the dead host's pid
			const orphan = spawnLsp();
			const pid = orphan.pid as number;
			writeRegistry([
				entry(stranger.pid as number, [{ pid, processStart: startOf(pid) }], {
					processStart: OTHER_START,
				}),
			]);
			const exited = once(orphan, "exit");

			await sweepOrphans();

			expect(signalledPids().has(pid)).toBe(true);
			expect((await exited)[1]).toBe("SIGKILL");
			expect(signalledPids().has(stranger.pid as number)).toBe(false);
			expect(registryEntries()).toEqual([]);
		});

		it("a live host whose entry has no start is judged by its pid alone and left alone", async () => {
			const host = spawnHost();
			const server = spawnLsp();
			const pid = server.pid as number;
			writeRegistry([
				entry(host.pid as number, [{ pid, processStart: startOf(pid) }]),
			]);

			await sweepOrphans();

			expect(signals).toEqual([]);
			expect(registryEntries().map((e) => e.pid)).toEqual([host.pid]);
		});

		it("recordLspChild records the child's start and the host's", async () => {
			const { recordLspChild, _settleRegistryMutationsForTests } =
				await import("../../clients/instance-registry.js");
			const server = spawnLsp();
			const pid = server.pid as number;

			await recordLspChild({ pid, serverId: "typescript", command: TSLS_BIN });
			await _settleRegistryMutationsForTests();

			expect(registryEntries()).toEqual([
				expect.objectContaining({
					pid: process.pid,
					processStart: startOf(process.pid),
					pidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
					lspChildren: [
						expect.objectContaining({ pid, processStart: startOf(pid) }),
					],
				}),
			]);
		});

		it("an entry this process wrote before #3538 (no start) is still its own: registering refreshes it", async () => {
			const { registerInstance, _settleRegistryMutationsForTests } =
				await import("../../clients/instance-registry.js");
			writeRegistry([entry(process.pid, [{ pid: 4242 }])]);

			await registerInstance("/repo/x");
			await _settleRegistryMutationsForTests();

			expect(registryEntries()).toEqual([
				expect.objectContaining({
					pid: process.pid,
					processStart: startOf(process.pid),
					lspChildren: [expect.objectContaining({ pid: 4242 })],
				}),
			]);
		});

		it("[PosixSamePid] an instance on a crashed instance's pid neither adopts its children nor loses its own entry to their reap", async () => {
			const { registerInstance, _settleRegistryMutationsForTests } =
				await import("../../clients/instance-registry.js");
			const orphan = spawnLsp();
			const pid = orphan.pid as number;
			h.mine.add(process.pid); // the reaper must see this live host
			// The crashed instance ran on the pid this process now has.
			writeRegistry([
				entry(process.pid, [{ pid, processStart: startOf(pid) }], {
					processStart: OTHER_START,
					heartbeatAgoMs: 3_600_000,
				}),
			]);

			await registerInstance("/repo/new");
			await _settleRegistryMutationsForTests();
			const own = registryEntries().find(
				(e) => e.pid === process.pid && e.processStart !== OTHER_START,
			) as { lspChildren: unknown[] } | undefined;
			expect(own?.lspChildren).toEqual([]);

			const exited = once(orphan, "exit");
			await sweepOrphans();

			expect(signalledPids().has(pid)).toBe(true);
			expect((await exited)[1]).toBe("SIGKILL");
			expect(registryEntries()).toEqual([
				expect.objectContaining({
					pid: process.pid,
					processStart: startOf(process.pid),
				}),
			]);
		});
	},
);

/** One backstop sweep, now: no cooldown, no grace, no follow-up. */
function backstop() {
	return sweepUntrackedOrphans({
		force: true,
		cooldownMs: 0,
		graceMs: 0,
		allowGraceRetry: false,
		verifyIntervalMs: 0,
	});
}
/** The tag an owner that is `pid` with `start` gives its children. */
const tag = (pid: number, start: string) => `${pid}:${start}`;

describe.skipIf(process.platform !== "linux")(
	"#3539: an orphan whose registry record is lost is still reaped on POSIX",
	() => {
		it("[PosixLateRecord] an orphan whose owner died before recording it is reaped through its owner tag", async () => {
			const orphan = spawnLsp(tag(deadPid(), OTHER_START));
			const pid = orphan.pid as number;
			const exited = once(orphan, "exit");

			await backstop();

			expect(signalledPids().has(pid)).toBe(true);
			expect((await exited)[1]).toBe("SIGKILL");
		});

		it("a child whose owner is alive under the tagged start is not reaped", async () => {
			h.mine.add(process.pid); // the owner's start must be readable
			const child = spawnLsp(tag(process.pid, startOf(process.pid)));

			await backstop();

			expect(signalledPids().has(child.pid as number)).toBe(false);
		});

		it("an owner pid now held by a process with another start is a dead owner", async () => {
			const stranger = spawnHost();
			const orphan = spawnLsp(tag(stranger.pid as number, OTHER_START));
			const exited = once(orphan, "exit");

			await backstop();

			expect(signalledPids().has(orphan.pid as number)).toBe(true);
			expect((await exited)[1]).toBe("SIGKILL");
			expect(signalledPids().has(stranger.pid as number)).toBe(false);
		});

		it("a malformed tag naming pid 0 is no owner, never a dead one", async () => {
			const server = spawnLsp(tag(0, OTHER_START));

			await backstop();

			expect(signalledPids().has(server.pid as number)).toBe(false);
		});

		it("a server pi-lens did not spawn (no tag) is never reaped", async () => {
			const server = spawnLsp();

			await backstop();

			expect(signalledPids().has(server.pid as number)).toBe(false);
		});

		it("[PosixFootprint] a health read keeps a dead instance's entry while it lists children, and the next sweep reaps them", async () => {
			const owner = deadPid();
			const orphan = spawnLsp(tag(owner, OTHER_START));
			const pid = orphan.pid as number;
			writeRegistry([
				entry(owner, [{ pid, processStart: startOf(pid) }], {
					processStart: OTHER_START,
				}),
			]);

			await getResourceFootprint();
			// The health read prunes fire-and-forget on the registry's mutation
			// queue; wait for that prune itself before reading the file.
			await _settleRegistryMutationsForTests();
			expect(registryEntries().map((e) => e.pid)).toEqual([owner]);

			const exited = once(orphan, "exit");
			await sweepOrphans();
			expect(signalledPids().has(pid)).toBe(true);
			expect((await exited)[1]).toBe("SIGKILL");
		});

		it("[PosixScanFail] a failed identity query keeps the dead entry, and the next sweep reaps its children", async () => {
			const owner = deadPid();
			const orphan = spawnLsp(tag(owner, OTHER_START));
			const pid = orphan.pid as number;
			writeRegistry([
				entry(owner, [{ pid, processStart: startOf(pid) }], {
					processStart: OTHER_START,
				}),
			]);

			h.failNextIdentityQuery = true;
			await sweepOrphans();
			expect(signals).toEqual([]);
			expect(registryEntries().map((e) => e.pid)).toEqual([owner]);

			const exited = once(orphan, "exit");
			await sweepOrphans();
			expect(signalledPids().has(pid)).toBe(true);
			expect((await exited)[1]).toBe("SIGKILL");
		});

		it("[PosixStaleMcp] a stale entry dropped while its host lived: the host's children are reaped after it dies", async () => {
			const host = spawnHost(); // an MCP host: never heartbeats
			const hostPid = host.pid as number;
			const orphan = spawnLsp(tag(hostPid, startOf(hostPid)));
			const pid = orphan.pid as number;
			writeRegistry([
				entry(hostPid, [{ pid, processStart: startOf(pid) }], {
					processStart: startOf(hostPid),
					heartbeatAgoMs: 7 * 3_600_000,
				}),
			]);

			await sweepOrphans();
			expect(signals).toEqual([]);
			expect(registryEntries()).toEqual([]);

			const hostExited = once(host, "exit");
			host.kill("SIGKILL"); // the MCP host dies
			await hostExited;

			const exited = once(orphan, "exit");
			await sweepOrphans();
			await backstop();
			expect(signalledPids().has(pid)).toBe(true);
			expect((await exited)[1]).toBe("SIGKILL");
		});

		it("launchLSP gives every LSP child this process's owner tag", async () => {
			const { launchLSP } = await import("../../clients/lsp/launch.js");
			const handle = await launchLSP("/bin/sh", ["-c", "sleep 30"], {
				cwd: process.cwd(),
			});
			children.push(handle.process);
			const environ = fs
				.readFileSync(`/proc/${handle.pid}/environ`, "utf8")
				.split("\0");

			expect(environ).toContain(
				`PI_LENS_OWNER=${tag(process.pid, startOf(process.pid))}`,
			);
			handle.process.kill("SIGKILL");
		});
	},
);

/**
 * Whether this host can start a process in a new pid namespace, and how: as
 * root directly, else inside a new user namespace. Neither is a given (an
 * unprivileged CI runner may forbid user namespaces), so the namespace case
 * below skips with the reason instead of passing vacuously.
 */
function probeUnshare(): { args: string[] } | { reason: string } {
	const base = ["--pid", "--fork", "--mount-proc", "--kill-child"];
	const reasons: string[] = [];
	for (const extra of [[], ["--user", "--map-root-user"]]) {
		const probe = spawnSync("unshare", [...extra, ...base, "true"], {
			encoding: "utf8",
		});
		if (probe.status === 0) return { args: [...extra, ...base] };
		reasons.push(
			`unshare ${[...extra, ...base].join(" ")}: ${probe.error?.message ?? probe.stderr.trim() ?? `exit ${probe.status}`}`,
		);
	}
	return { reason: reasons.join("; ") };
}

/** A process's direct children, as this namespace sees them. */
function childrenOf(pid: number): number[] {
	try {
		return fs
			.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map(Number);
	} catch {
		return [];
	}
}

describe.skipIf(process.platform !== "linux")(
	"#3538/#3539 review round 1: identity is only judged where it means something",
	() => {
		it("[F1] a live session's server in another pid namespace is never reaped, whatever pid its tag names", async (ctx) => {
			const unshare = probeUnshare();
			if (!("args" in unshare)) {
				ctx.skip(`no pid namespace available here: ${unshare.reason}`);
				return;
			}
			// A live pi-lens owner inside its own pid namespace spawns a server
			// tagged with ITS pid and start. Seen from here that pid is some
			// other process (or none), which read as a dead owner.
			const marker = `ns-marker-${process.pid}-${Date.now()}`;
			const script = [
				'const fs = require("node:fs");',
				'const { spawn } = require("node:child_process");',
				'const stat = fs.readFileSync("/proc/self/stat", "utf8");',
				'const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];',
				'const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();',
				"const env = { ...process.env, PI_LENS_OWNER: `${process.pid}:${start}@${boot}` };",
				// Joined at run time, so only the server's own command line
				// carries the marker, never the owner's script.
				`const marker = ${JSON.stringify(marker.slice(0, 4))} + ${JSON.stringify(marker.slice(4))};`,
				`spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)", ${JSON.stringify(TSLS)}, "--stdio", marker], { env, stdio: "ignore" });`,
				"setInterval(() => {}, 1e6);",
			].join("\n");
			const owner = track(
				spawn("unshare", [...unshare.args, process.execPath, "-e", script], {
					stdio: "ignore",
				}),
			);
			// unshare -> the namespace's first process (the owner) -> the server,
			// followed down the chain of children as this namespace sees them,
			// until the server has exec'd (between fork and exec it still shows
			// the owner's command line). Bounded: a namespace that never produces
			// its server fails here rather than hanging the file.
			const deadline = Date.now() + 30_000;
			const cmdline = (pid: number) => {
				try {
					return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
				} catch {
					return "";
				}
			};
			let server: number | undefined;
			while (server === undefined) {
				if (owner.exitCode !== null || Date.now() > deadline)
					throw new Error(
						`no server appeared in the owner's namespace (owner exit ${owner.exitCode})`,
					);
				const [nsOwner] = childrenOf(owner.pid as number);
				const found =
					nsOwner === undefined ? undefined : childrenOf(nsOwner)[0];
				if (found !== undefined && cmdline(found).includes(marker))
					server = found;
				else await new Promise((resolve) => setImmediate(resolve));
			}
			const tagged = fs
				.readFileSync(`/proc/${server}/environ`, "utf8")
				.split("\0")
				.find((item) => item.startsWith("PI_LENS_OWNER="));
			h.mine.add(server);
			expect(fs.readlinkSync(`/proc/${server}/ns/pid`)).not.toBe(
				fs.readlinkSync("/proc/self/ns/pid"),
			);
			expect(tagged).toMatch(/^PI_LENS_OWNER=\d+:\d+@[0-9a-f-]{36}$/);

			await backstop();

			expect(signalledPids().has(server)).toBe(false);
		});

		it("[F1] a registry entry from another pid namespace is neither judged dead nor pruned", async () => {
			const stranger = spawnHost(); // this namespace's view of the entry's pid
			const orphan = spawnLsp();
			const pid = orphan.pid as number;
			writeRegistry([
				{
					...entry(
						stranger.pid as number,
						[{ pid, processStart: startOf(pid) }],
						{
							processStart: OTHER_START,
						},
					),
					pidNamespace: "pid:[1]",
				},
			]);

			await sweepOrphans();

			expect(signals).toEqual([]);
			expect(registryEntries().map((e) => e.pid)).toEqual([stranger.pid]);
		});

		it("[F1] an entry from this pid namespace is still judged: its orphan is reaped", async () => {
			const orphan = spawnLsp();
			const pid = orphan.pid as number;
			writeRegistry([
				{
					...entry(deadPid(), [{ pid, processStart: startOf(pid) }], {
						processStart: OTHER_START,
					}),
					pidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
				},
			]);
			const exited = once(orphan, "exit");

			await sweepOrphans();

			expect(signalledPids().has(pid)).toBe(true);
			expect((await exited)[1]).toBe("SIGKILL");
		});

		it("[R2-F1] a stale entry from another pid namespace is removed and nothing is signalled", async () => {
			// A container that died a week ago: its pi-lens was pid 1 there, and
			// pid 1 here is alive. Only the heartbeat can tell, and #525's
			// record-only removal must still reach the entry.
			const stranger = spawnHost();
			const orphan = spawnLsp();
			const pid = orphan.pid as number;
			writeRegistry([
				{
					...entry(
						stranger.pid as number,
						[{ pid, processStart: startOf(pid) }],
						{
							processStart: OTHER_START,
							heartbeatAgoMs: 7 * 3_600_000,
						},
					),
					pidNamespace: "pid:[1]",
				},
			]);

			await sweepOrphans();

			expect(signals).toEqual([]);
			expect(registryEntries()).toEqual([]);
		});

		it("[R2-F1] removing a stale foreign entry keeps this namespace's entry with the same pid and start", async () => {
			const { registerInstance, _settleRegistryMutationsForTests } =
				await import("../../clients/instance-registry.js");
			await registerInstance("/repo/x");
			await _settleRegistryMutationsForTests();
			const own = registryEntries()[0];
			writeRegistry([
				own,
				{
					...entry(process.pid, [], {
						processStart: startOf(process.pid),
						heartbeatAgoMs: 7 * 3_600_000,
					}),
					pidNamespace: "pid:[1]",
				},
			]);

			await sweepOrphans();

			expect(registryEntries()).toEqual([own]);
		});

		it("[R2-F1] a fresh foreign entry whose pid is gone here is not judged dead", async () => {
			// The container's host runs under a pid this namespace does not have.
			const orphan = spawnLsp();
			const pid = orphan.pid as number;
			writeRegistry([
				{
					...entry(deadPid(), [{ pid, processStart: startOf(pid) }], {
						processStart: OTHER_START,
					}),
					pidNamespace: "pid:[1]",
				},
			]);

			await sweepOrphans();

			expect(signals).toEqual([]);
			expect(registryEntries()).toHaveLength(1);
		});

		it("the health read prunes a dead, childless entry of this pid namespace", async () => {
			writeRegistry([
				{
					...entry(deadPid(), []),
					pidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
				},
			]);

			await getResourceFootprint();
			// The prune is fire-and-forget on the registry's mutation queue:
			// wait for it, not for a number of turns (#3538 review R3-F3).
			await _settleRegistryMutationsForTests();

			expect(registryEntries()).toEqual([]);
		});

		it("[F1] the health read never prunes another pid namespace's entry", async () => {
			writeRegistry([{ ...entry(deadPid(), []), pidNamespace: "pid:[1]" }]);

			await getResourceFootprint();
			// The prune is fire-and-forget on the registry's mutation queue:
			// wait for it, not for a number of turns (#3538 review R3-F3).
			await _settleRegistryMutationsForTests();

			expect(registryEntries()).toHaveLength(1);
		});

		it("registerInstance records this process's pid namespace", async () => {
			const { registerInstance, _settleRegistryMutationsForTests } =
				await import("../../clients/instance-registry.js");

			await registerInstance("/repo/x");
			await _settleRegistryMutationsForTests();

			expect(registryEntries()).toEqual([
				expect.objectContaining({
					pid: process.pid,
					pidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
				}),
			]);
		});

		it("[F2] a pid whose owner tag changed after the decision is not signalled", async () => {
			// The orphan carries a dead owner's tag when the sweep reads it, then
			// becomes a live session's process on the same pid: `exec` keeps the
			// pid and the start and replaces the environment, which is what a
			// reuse between the tag read and the start read looks like.
			const liveTag = tag(process.pid, startOf(process.pid));
			const orphan = track(
				spawn(
					"sh",
					[
						"-c",
						`read x; exec env PI_LENS_OWNER=${liveTag} "${process.execPath}" -e "setInterval(()=>{},1e6)" ${TSLS} --stdio`,
						"sh",
						TSLS,
					],
					{
						stdio: ["pipe", "ignore", "ignore"],
						detached: true,
						env: { ...process.env, PI_LENS_OWNER: tag(deadPid(), OTHER_START) },
					},
				),
			);
			const pid = orphan.pid as number;
			const environ = () =>
				fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
			h.afterFirstTagRead = async () => {
				orphan.stdin?.write("go\n");
				while (!environ().includes(`PI_LENS_OWNER=${liveTag}`)) {
					await new Promise((resolve) => setImmediate(resolve));
				}
			};

			await backstop();

			expect(signalledPids().has(pid)).toBe(false);
			expect(
				h.latency.find((r) => r.phase === "orphan_backstop_reaped")?.metadata,
			).toMatchObject({ killed: 0, identityChanged: 1 });
		});
	},
);

/**
 * #3538 review R4-F1: the kernel adds the READER's time-namespace boottime
 * offset to `/proc/<pid>/stat` field 22. A reader in another time namespace
 * saw a live owner under the same boot with other ticks, took it for a
 * reused pid, and killed its child. The vitest worker cannot enter a time
 * namespace, so the whole scenario runs confined as pid 1 of a private pid
 * namespace (its own /proc): its process table holds only these processes,
 * and it can kill nothing else. Inside, a live owner tags a server; a reader
 * runs the real backstop under `unshare --time --boottime 100000`; then the
 * owner dies and the same reader must reap the server (the control).
 */
const OWNER_SCRIPT = `
import { spawn } from "node:child_process";
const { ownerTagForChildren, OWNER_TAG_ENV } = await import(process.env.R4_SNAPSHOT);
const tag = await ownerTagForChildren({ timeoutMs: 5000 });
const server = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)", process.env.R4_TSLS, "--stdio"], {
	env: { ...process.env, [OWNER_TAG_ENV]: String(tag) },
	stdio: "ignore",
});
console.log(server.pid);
setInterval(() => {}, 1e6);
`;
const READER_SCRIPT = `
const { sweepUntrackedOrphans } = await import(process.env.R4_REAPER);
// Holds the loop open: the sweep's own timers are unref'd, and a top-level
// await with nothing to keep the process alive exits 13.
const keep = setInterval(() => {}, 1e6);
await sweepUntrackedOrphans({ force: true, graceMs: 0, allowGraceRetry: false, verifyAttempts: 3, verifyIntervalMs: 100 });
clearInterval(keep);
`;
const CONFINED_SCRIPT = `
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
const owner = spawn(process.execPath, ["--input-type=module", "-e", process.env.R4_OWNER], { stdio: ["ignore", "pipe", "inherit"] });
const [line] = await once(owner.stdout, "data");
const server = Number(String(line).trim());
const state = (pid) => {
	try {
		const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
	} catch {
		return "gone";
	}
};
const sweepInTimeNamespace = async () => {
	const reader = spawn("unshare", ["--time", "--boottime", "100000", "--fork", process.execPath, "--input-type=module", "-e", process.env.R4_READER], { stdio: ["ignore", "inherit", "inherit"] });
	const [code] = await once(reader, "exit");
	if (code !== 0) throw new Error("reader exited " + code);
};
await sweepInTimeNamespace();
const live = state(server);
const exited = once(owner, "exit");
owner.kill("SIGKILL");
await exited;
await sweepInTimeNamespace();
console.log(JSON.stringify({ live, dead: state(server) }));
process.exit(0);
`;

describe.skipIf(process.platform !== "linux")(
	"#3538 review round 4: a start means the same to every reader",
	() => {
		it("[R4-F1] a reader in another time namespace leaves a live owner's server alone, and still reaps a dead owner's", async (ctx) => {
			const unshare = probeUnshare();
			if (!("args" in unshare)) {
				ctx.skip(`no pid namespace available here: ${unshare.reason}`);
				return;
			}
			const timens = spawnSync(
				"unshare",
				[
					...unshare.args,
					"unshare",
					"--time",
					"--boottime",
					"1",
					"--fork",
					"true",
				],
				{ encoding: "utf8" },
			);
			if (timens.status !== 0) {
				ctx.skip(
					`no time namespace available here: ${timens.error?.message ?? (timens.stderr.trim() || `exit ${timens.status}`)}`,
				);
				return;
			}
			const built = (file: string) =>
				pathToFileURL(path.resolve(import.meta.dirname, "../..", file)).href;
			const env = { ...process.env };
			delete env.PI_LENS_OWNER;
			const run = track(
				spawn(
					"unshare",
					[
						...unshare.args,
						process.execPath,
						"--input-type=module",
						"-e",
						CONFINED_SCRIPT,
					],
					{
						stdio: ["ignore", "pipe", "inherit"],
						env: {
							...env,
							PI_LENS_HOME: h.dir,
							PILENS_DATA_DIR: h.dir,
							R4_OWNER: OWNER_SCRIPT,
							R4_READER: READER_SCRIPT,
							R4_SNAPSHOT: built("clients/process-snapshot.js"),
							R4_REAPER: built("clients/instance-reaper.js"),
							R4_TSLS: TSLS,
						},
					},
				),
			);
			let out = "";
			run.stdout?.on("data", (chunk) => {
				out += String(chunk);
			});
			const [code] = await once(run, "exit");

			expect(code).toBe(0);
			const result = JSON.parse(out) as { live: string; dead: string };
			// The live owner's server is still running: not killed, not reaped.
			expect(result.live).toMatch(/^[RS]$/);
			// Control: with its owner dead, the same reader reaps it. The confined
			// pid 1 never reaps an adopted orphan, so a killed server is a zombie.
			expect(result.dead).toMatch(/^(Z|gone)$/);
		}, 60_000);
	},
);

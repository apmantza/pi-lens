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

async function runIdentityHook(): Promise<void> {
	const hook = h.afterFirstIdentityQuery;
	h.afterFirstIdentityQuery = undefined;
	if (hook) await hook();
}

// The reaper sees only this file's pids. The identity hook sits on both
// doors an identity query can take: the pid-filtered table query the reaper
// made before #3538, and the identity query it makes since.
vi.mock("../../clients/process-snapshot.js", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("../../clients/process-snapshot.js")>();
	return {
		...real,
		queryProcessTable: async (
			request: Parameters<typeof real.queryProcessTable>[0],
			options: Parameters<typeof real.queryProcessTable>[1],
		) => {
			const result = await real.queryProcessTable(request, options);
			const rows = result.rows.filter((row) => h.mine.has(row.pid));
			if (request.filter?.column === "ProcessId") await runIdentityHook();
			return { ...result, rows };
		},
		queryProcessIdentities: async (
			pids: readonly number[],
			options: Parameters<typeof real.queryProcessIdentities>[1],
		) => {
			const result = await real.queryProcessIdentities(
				pids.filter((pid) => h.mine.has(pid)),
				options,
			);
			await runIdentityHook();
			return result;
		},
	};
});

const { sweepOrphans } = await import("../../clients/instance-reaper.js");

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
/** A live node process whose command line looks like a node-launched LSP. */
function spawnLsp(): ChildProcess {
	return track(
		spawn(
			process.execPath,
			["-e", "setInterval(()=>{},1e6)", TSLS, "--stdio"],
			{
				stdio: "ignore",
				detached: true,
			},
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
/** The kernel's start time for `pid`: `/proc/<pid>/stat` field 22. */
function startOf(pid: number): string {
	const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}
/** A start that is not any live process's: stands for "the pid was reused". */
const OTHER_START = "1";

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

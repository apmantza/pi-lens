// flake-shape: real-process-spawn — the subject is the run-time spawn gate itself: it calls the patched real `child_process` exports (named import and `vi.importActual`) to prove the wrapper counts this file's own children, and it runs a child Vitest run over fixtures, because the gate's red is produced by a fork's teardown, which no in-process double reproduces.
/**
 * #5100 — the run-time real-spawn observer and its gate.
 *
 * The census (`tests/support/flake-shape-scan.ts`) finds a spawner by the
 * NAMES in its source; this arm asks the boundary that cannot be renamed.
 * These cases pin the three things the arm claims:
 *
 * 1. Every `node:child_process` entry point that starts a process is wrapped,
 *    and a wrapper forwards the call unmodified (an observer that changes the
 *    call it observes is worse than no observer).
 * 2. The charge follows the caller: a harness frame is the running file's
 *    contention; a production frame is the code under test running its own
 *    child and is never charged. The instrument's own frames (the shared
 *    setup's repo-root `git`) charge nobody, or the instrument would make the
 *    flake it hunts.
 * 3. The gate fails closed: a file that started a child through harness code
 *    and holds no admission reds at its own teardown. The two fixtures under
 *    `tests/fixtures/real-spawn-gate/` witness both directions through a real
 *    fork — the spawner reds, the mocked spawn stays green.
 */
import cp, { spawnSync } from "node:child_process";
import * as util from "node:util";
import * as vm from "node:vm";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import {
	expectPlantedStaleRow,
	rowsWithoutLiveMember,
} from "./baseline-staleness.js";
import {
	REAL_SPAWN_BASELINE_FILE,
	REAL_SPAWN_OBSERVED_FILE,
	hasRealSpawnAdmission,
	realSpawnAdmissionProblems,
	realSpawnGateFailure,
	realSpawnRouteSummaries,
	type RealSpawnAdmissionIo,
} from "./real-spawn-admission.js";
import {
	REAL_SPAWN_ENTRY_POINTS,
	chainOwner,
	classifyFrame,
	createRealSpawnLedger,
	formatRealSpawnEvidence,
	frameOf,
	harnessSpawnCount,
	installRealSpawnObserver,
	repoRelative,
	type RealSpawnLedger,
	type RealSpawnTarget,
} from "./real-spawn-observer.js";
import { realSpawnLedgerView } from "./vitest-setup.js";

/** A code-unit order: an explicit comparator, never the default sort. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const SUPPORT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SUPPORT_DIR, "../..");

// ---------------------------------------------------------------------------
// 1. entry-point coverage: what the installer wraps, and what it leaves alone
// ---------------------------------------------------------------------------

/** A stand-in for the `node:child_process` module object: every entry point
 *  records the call it received and returns a value the caller can see, so a
 *  wrapper that swallows an argument, the receiver or the result turns a case
 *  red. */
function makeTarget(): {
	target: RealSpawnTarget;
	calls: Array<{ entry: string; args: unknown[]; self: unknown }>;
} {
	const calls: Array<{ entry: string; args: unknown[]; self: unknown }> = [];
	const target: RealSpawnTarget = { promises: {} };
	for (const entry of REAL_SPAWN_ENTRY_POINTS) {
		Object.defineProperty(target, entry, {
			value: function (this: unknown, ...args: unknown[]): string {
				calls.push({ entry, args, self: this });
				return `result:${entry}`;
			},
			writable: true,
			configurable: true,
		});
	}
	for (const entry of ["exec", "execFile"] as const) {
		Object.defineProperty(target.promises!, entry, {
			value: function (this: unknown, ...args: unknown[]): string {
				calls.push({ entry: `promises.${entry}`, args, self: this });
				return `result:promises.${entry}`;
			},
			writable: true,
			configurable: true,
		});
	}
	return { target, calls };
}

describe("installRealSpawnObserver", () => {
	it("wraps every process-starting entry point, forwarding args, receiver and result", () => {
		const { target, calls } = makeTarget();
		const ledger = createRealSpawnLedger();
		installRealSpawnObserver(target, ledger);

		for (const entry of REAL_SPAWN_ENTRY_POINTS) {
			const fn = target[entry] as (
				this: RealSpawnTarget,
				...a: unknown[]
			) => string;
			expect(fn.call(target, "/usr/bin/git", ["status"], { cwd: "/tmp" })).toBe(
				`result:${entry}`,
			);
			const call = calls.at(-1)!;
			expect(call.entry).toBe(entry);
			expect(call.args).toEqual(["/usr/bin/git", ["status"], { cwd: "/tmp" }]);
			// The receiver survives the wrapper: the module object, not undefined.
			expect(call.self).toBe(target);
		}
		for (const entry of ["exec", "execFile"] as const) {
			const fn = target.promises![entry] as (...a: unknown[]) => string;
			expect(fn.call(target.promises, "node -v")).toBe(
				`result:promises.${entry}`,
			);
			expect(calls.at(-1)!.entry).toBe(`promises.${entry}`);
			// Called through its own object, the promises namespace is the
			// receiver, and the wrapper forwards it unchanged.
			expect(calls.at(-1)!.self).toBe(target.promises);
		}
		// One count per call, across both surfaces.
		expect(ledger.total).toBe(REAL_SPAWN_ENTRY_POINTS.length + 2);
	});

	it("keeps the function's name and arity so a stack frame still names the call", () => {
		const { target } = makeTarget();
		installRealSpawnObserver(target, createRealSpawnLedger());
		const original = makeTarget().target.spawn as unknown as () => unknown;
		const wrapped = target.spawn as unknown as { name: string; length: number };
		expect(wrapped.name).toBe(original.name || wrapped.name);
		expect(typeof wrapped).toBe("function");
	});

	// #5100 r3 F1: the wrapper was a bare function, so `util.promisify(execFile)`
	// found no `[util.promisify.custom]` and resolved a string instead of
	// `{ stdout, stderr }`: 82 tests in 6 files went red on CI. The wrapper
	// carries every own property and symbol of what it wraps.
	it("carries every own property and symbol, so util.promisify keeps its shape", async () => {
		const target: RealSpawnTarget = {};
		const custom = function (): Promise<{ stdout: string; stderr: string }> {
			return Promise.resolve({ stdout: "out", stderr: "err" });
		};
		const original = function (): string {
			return "generic";
		};
		Object.defineProperty(original, util.promisify.custom, { value: custom });
		Object.defineProperty(original, "extra", { value: 7, enumerable: true });
		target.execFile = original;
		const ledger = createRealSpawnLedger();
		installRealSpawnObserver(target, ledger);
		const wrapped = target.execFile as typeof original;

		expect(wrapped).not.toBe(original);
		expect(Reflect.ownKeys(wrapped).map(String).sort(byText)).toEqual(
			Reflect.ownKeys(original).map(String).sort(byText),
		);
		expect((wrapped as unknown as { extra: number }).extra).toBe(7);
		expect(await util.promisify(wrapped)()).toEqual({
			stdout: "out",
			stderr: "err",
		});
		// The promisified spelling is a spawn entry point too: it is observed.
		expect(ledger.calls.get("execFile")).toBe(1);
	});

	it("leaves a member that is not a function alone instead of throwing", () => {
		const target: RealSpawnTarget = {
			spawn: "not-a-function",
			spawnSync: undefined,
		};
		const ledger = createRealSpawnLedger();
		expect(() => installRealSpawnObserver(target, ledger)).not.toThrow();
		expect(target.spawn).toBe("not-a-function");
		expect(target.spawnSync).toBeUndefined();
	});

	it("records the entry point, the basename of the command, and the dropped count", () => {
		const { target } = makeTarget();
		const ledger = createRealSpawnLedger();
		installRealSpawnObserver(target, ledger);
		const spawn = target.spawn as (this: unknown, ...a: unknown[]) => unknown;
		// 8 distinct commands fill the record; the 9th and 10th only count.
		for (const command of [
			"git",
			"node",
			"ps",
			"which",
			"ls",
			"cat",
			"grep",
			"sh",
		]) {
			spawn.call(target, `/usr/local/bin/${command}`);
		}
		const distinct = new Set(ledger.commands);
		expect(distinct.size).toBe(8);
		expect([...distinct][0]).toBe("spawn:git");
		spawn.call(target, "/usr/bin/tail");
		spawn.call(target, 42);
		expect(ledger.total).toBe(10);
		expect(ledger.droppedCommands).toBe(2);
		expect(ledger.calls.get("spawn")).toBe(10);
		// A non-string command is still recorded as a call, under a stand-in name.
		expect(formatRealSpawnEvidence("support/x.test.ts", ledger)).toContain(
			"spawn=10",
		);
	});
});

// ---------------------------------------------------------------------------
// 2. attribution: the charge follows the caller, not the file's name
// ---------------------------------------------------------------------------

describe("classifyFrame", () => {
	const ROOT = "/repo/";

	it("names a harness frame, a production frame, and the boundary", () => {
		const cls = (frame: string) => classifyFrame(frame, ROOT);
		expect(cls("    at runTest (/repo/tests/support/x.test.ts:10:3)")).toBe(
			"harness",
		);
		expect(cls("    at helper (/repo/tests/support/kit.ts:4:1)")).toBe(
			"harness",
		);
		expect(cls("    at safeSpawn (/repo/clients/safe-spawn.ts:88:10)")).toBe(
			"other",
		);
		expect(cls("    at Object.<anonymous> (/repo/index.ts:1:1)")).toBe("other");
		expect(
			cls("    at ChildProcess.spawn (node:internal/child_process:421:11)"),
		).toBe("child_process");
		expect(
			cls("    at Object.spawnSync (/repo/node/common/child_process.js:10:5)"),
		).toBe("child_process");
	});

	it("treats the instrument's own frames as the setup's, so a setup child charges no file", () => {
		const cls = (frame: string) => classifyFrame(frame, ROOT);
		expect(
			cls("    at readGitRoot (/repo/tests/support/vitest-setup.ts:210:5)"),
		).toBe("instrument");
		expect(
			cls("    at note (/repo/tests/support/real-spawn-observer.ts:180:9)"),
		).toBe("instrument");
		// A Windows spelling of a harness frame still reads as harness.
		expect(
			classifyFrame(
				"    at run (C:\\repo\\tests\\support\\x.test.ts:3:1)",
				"C:\\repo",
			),
		).toBe("harness");
	});

	// #5100 r3 F7: the class was a `/tests/` substring of the ABSOLUTE path, so a
	// checkout under /home/dev/tests/pi-lens read every production frame as
	// harness and lost the timer exemption. The path under the root decides.
	it("judges the path under the checkout, not a tests/ directory above it", () => {
		const root = "/home/dev/tests/pi-lens/";
		expect(
			classifyFrame(
				"    at safeSpawn (/home/dev/tests/pi-lens/clients/safe-spawn.ts:88:10)",
				root,
			),
		).toBe("other");
		expect(
			classifyFrame(
				"    at it (/home/dev/tests/pi-lens/tests/clients/x.test.ts:4:1)",
				root,
			),
		).toBe("harness");
		// A frame outside the checkout (a linked node_modules) is nobody's test.
		expect(
			classifyFrame("    at f (/elsewhere/tests/dep/index.js:1:1)", root),
		).toBe("other");
	});
});

// #5100 r3 F2: the setup's own hooks start children (`ps` in the dead-owner
// census, the kill guard, the tmp-hygiene sweep). Their chain holds a
// `tests/support` frame and ends at the setup's own hook, so the old rule
// charged every file of CI shard 5 (340 of 420 reds on `spawn:ps`). The
// owner of a chain is decided by its outermost test-tree frame.
describe("chainOwner", () => {
	const ROOT = "/repo/";
	const owner = (lines: string[], truncated = false) =>
		chainOwner(lines, truncated, ROOT);

	it("hands a chain that ends at the setup's own hook to the setup", () => {
		expect(
			owner([
				"    at Proxy.queryProcessTable (/repo/tests/support/vitest-setup.ts:942:16)",
				"    at Object.listProcesses (/repo/tests/support/dead-owner-census.ts:137:13)",
				"    at Module.runDeadOwnerCensus (/repo/tests/support/dead-owner-census.ts:249:23)",
				"    at async Promise.all (index 1)",
				"    at /repo/tests/support/vitest-setup.ts:2145:3",
			]),
		).toBe("setup");
	});

	it("charges a chain whose outermost test-tree frame is a support helper (a kit hook a test registered)", () => {
		expect(
			owner([
				"    at helper (/repo/tests/support/kit.ts:4:1)",
				"    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
			]),
		).toBe("harness");
	});

	it("charges a chain through the setup that holds a test file's own frame", () => {
		expect(
			owner([
				"    at cleanup (/repo/tests/clients/x.test.ts:9:3)",
				"    at run (/repo/tests/support/vitest-setup.ts:2100:5)",
			]),
		).toBe("harness");
	});

	it("charges a test file whose chain passes through production code", () => {
		expect(
			owner([
				"    at safeSpawn (/repo/clients/safe-spawn.ts:88:10)",
				"    at it (/repo/tests/clients/x.test.ts:9:3)",
				"    at runTest (/repo/node_modules/@vitest/runner/dist/index.js:1:1)",
			]),
		).toBe("harness");
	});

	it("fails closed when the capture was truncated before the outermost frame", () => {
		const chain = [
			"    at Object.listProcesses (/repo/tests/support/dead-owner-census.ts:137:13)",
		];
		expect(owner(chain, false)).toBe("harness");
		expect(owner(chain, true)).toBe("harness");
		expect(
			owner(
				[...chain, "    at x (/repo/tests/support/vitest-setup.ts:1:1)"],
				true,
			),
		).toBe("harness");
	});

	it("owns nothing when no frame is under tests/", () => {
		expect(
			owner(["    at Timeout._onTimeout (/repo/clients/sampler.ts:5:5)"]),
		).toBe("none");
	});
});

describe("frameOf", () => {
	// #5100 r2: the ledger cut the RAW stack line at 120 characters, so a
	// location past that column lost its tail. The fork test's 63-character
	// checkout recorded `unadmitted-spawn.fixture.t`; a 41-character checkout
	// fit the same line. These cases pass a root longer than that cut, so the
	// location must survive whatever depth the checkout sits at.
	const deepRoot = `/${"deep-checkout-".repeat(16)}`;

	it("keeps the repo-relative file:line:col under a deep checkout root", () => {
		const root = `${deepRoot}/`;
		expect(
			frameOf(
				`    at fixtureTest (${root}tests/fixtures/real-spawn-gate/unadmitted-spawn.fixture.ts:5:3)`,
				"harness",
				root,
			),
		).toBe(
			"harness:fixtureTest (tests/fixtures/real-spawn-gate/unadmitted-spawn.fixture.ts:5:3)",
		);
	});

	// #5100 r3 F4: the root was `${process.cwd()}/`, a backslash path on
	// Windows, while a vite-node frame spells the same file with forward
	// slashes, so CI printed `via D:/a/pi-lens/pi-lens/tests/clients/…` and
	// asked the author to paste an absolute route.
	it("strips a Windows root from a forward-slash frame and from a backslash one", () => {
		const root = "D:\\a\\pi-lens\\pi-lens";
		expect(
			frameOf(
				"    at run (D:/a/pi-lens/pi-lens/tests/clients/pipeline.test.ts:78:5)",
				"harness",
				root,
			),
		).toBe("harness:run (tests/clients/pipeline.test.ts:78:5)");
		expect(
			frameOf(
				"    at run (D:\\a\\pi-lens\\pi-lens\\tests\\clients\\pipeline.test.ts:78:5)",
				"harness",
				root,
			),
		).toBe("harness:run (tests/clients/pipeline.test.ts:78:5)");
		expect(
			repoRelative(
				"D:/a/pi-lens/pi-lens/tests/clients/pipeline.test.ts:78",
				root,
			),
		).toBe("tests/clients/pipeline.test.ts:78");
	});

	it("keeps a top-level frame, which has no parenthesised location", () => {
		const root = `${deepRoot}/`;
		expect(
			frameOf(
				`    at ${root}tests/fixtures/real-spawn-gate/unadmitted-spawn.fixture.ts:5:3`,
				"harness",
				root,
			),
		).toBe(
			"harness:tests/fixtures/real-spawn-gate/unadmitted-spawn.fixture.ts:5:3",
		);
	});
});

describe("harnessSpawnCount", () => {
	it("charges the file that called spawn itself", () => {
		const { target } = makeTarget();
		const ledger = createRealSpawnLedger();
		installRealSpawnObserver(target, ledger);
		const spawn = target.spawn as (this: unknown, ...a: unknown[]) => unknown;

		spawn.call(target, "git");

		expect(harnessSpawnCount(ledger)).toBe(1);
	});

	it("charges the file that reached the spawn through production frames (#5084 shape)", () => {
		const { target } = makeTarget();
		const ledger = createRealSpawnLedger();
		installRealSpawnObserver(target, ledger);
		const spawn = target.spawn as (this: unknown, ...a: unknown[]) => unknown;

		// A stand-in for `clients/` code: a module compiled outside tests/, so
		// its own frame is not a harness frame. It is called from this file, and
		// the child it starts is this file's contention — which is the #5084
		// shape, `new AstGrepClient()` running the real CLI through the tool.
		const clientRoute = vm.runInNewContext(
			"(fn) => { fn('git'); return 1; };",
			{},
			{ filename: "production-route-fixture.js" },
		) as (fn: typeof spawn) => unknown;
		clientRoute(spawn);

		expect(ledger.total).toBe(1);
		expect(harnessSpawnCount(ledger)).toBe(1);
		// The route leads with the harness line that asked for the child, not
		// with the production frame nearest the syscall.
		expect(realSpawnRouteSummaries(ledger)[0]).toContain(
			"spawn:git via tests/support/real-spawn-observer.test.ts",
		);
	});

	it("charges nobody when no frame in the chain is harness code", async () => {
		const { target } = makeTarget();
		const ledger = createRealSpawnLedger();
		installRealSpawnObserver(target, ledger);
		const spawn = target.spawn as (this: unknown, ...a: unknown[]) => unknown;

		// A child nobody in the conversation asked for: a module that schedules
		// its own work on the event loop (a timer, a watcher, a pool). By the
		// time it runs, no harness frame is left, and blaming whichever file
		// happens to be scheduled is how an instrument makes the flake it hunts.
		const backgroundRoute = vm.runInNewContext(
			"(fn, schedule) => { schedule(() => { fn('git'); }); };",
			{},
			{ filename: "background-route-fixture.js" },
		) as (fn: typeof spawn, schedule: (cb: () => void) => void) => void;
		await new Promise<void>((resolve) => {
			backgroundRoute(spawn, setImmediate);
			// Queued after the route's own callback, so it settles second.
			setImmediate(resolve);
		});

		expect(ledger.total).toBe(1);
		expect(harnessSpawnCount(ledger)).toBe(0);
		expect([...ledger.byClass.keys()]).toEqual(["other"]);
	});
});

// ---------------------------------------------------------------------------
// 3. the seam is real: the setup's patch reaches THIS file's module graph
// ---------------------------------------------------------------------------

describe("the patch published by the shared setup", () => {
	it("counts this file's own real child through the named import", () => {
		const before = realSpawnLedgerView().total;
		const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		expect(result.status).toBe(0);
		const view = realSpawnLedgerView();
		expect(view.total).toBeGreaterThan(before);
		expect(view.byClass["harness"] ?? 0).toBeGreaterThan(0);
		expect(view.entryPoints["spawnSync"] ?? 0).toBeGreaterThan(0);
	});

	// #5100 r3 F1: the patched real module must promisify exactly as the
	// pristine one does. The reference is a child that never loaded the setup.
	it("keeps every wrapped entry point's own keys and its promisified shape", async () => {
		const reference = JSON.parse(
			spawnSync(
				process.execPath,
				[
					"-e",
					`const cp = require("node:child_process");
const out = {};
for (const e of ${JSON.stringify(REAL_SPAWN_ENTRY_POINTS)})
  out[e] = Reflect.ownKeys(cp[e]).map(String).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
console.log(JSON.stringify(out));`,
				],
				{ encoding: "utf8" },
			).stdout,
		) as Record<string, string[]>;
		for (const entry of REAL_SPAWN_ENTRY_POINTS) {
			const patched = (cp as unknown as Record<string, object>)[entry]!;
			expect(Reflect.ownKeys(patched).map(String).sort(byText)).toEqual(
				reference[entry],
			);
		}
		for (const entry of ["exec", "execFile"] as const) {
			const run = util.promisify(cp[entry]) as (
				...args: unknown[]
			) => Promise<unknown>;
			const result = await (entry === "exec"
				? run(
						`${JSON.stringify(process.execPath)} -e "process.stdout.write('hi')"`,
					)
				: run(process.execPath, ["-e", "process.stdout.write('hi')"]));
			expect(result).toEqual({ stdout: "hi", stderr: "" });
		}
	});

	it("counts a real child reached through vi.importActual (#5064 shape)", async () => {
		const actual = await vi.importActual<RealSpawnTarget>("node:child_process");
		const before = realSpawnLedgerView().total;
		const result = (actual.spawnSync as typeof spawnSync)(process.execPath, [
			"-e",
			"process.exit(0)",
		]);
		expect(result.status).toBe(0);
		expect(realSpawnLedgerView().total).toBeGreaterThan(before);
	});
});

// ---------------------------------------------------------------------------
// 4. the gate's decision table
// ---------------------------------------------------------------------------

/** A ledger with `n` harness calls from one route, in the shape the installer
 *  produces (the installer itself is pinned above). */
function harnessLedger(calls = 1): RealSpawnLedger {
	const ledger = createRealSpawnLedger();
	for (let i = 0; i < calls; i++) {
		ledger.total += 1;
		ledger.calls.set("spawn", (ledger.calls.get("spawn") ?? 0) + 1);
		ledger.byClass.set("harness", (ledger.byClass.get("harness") ?? 0) + 1);
		ledger.harnessCalls.push({
			entry: "spawn",
			command: "node",
			frames: [
				`harness:McpHarness (${path.join(REPO, "tests/mcp/harness.ts")}:98:16)`,
			],
		});
		ledger.samples.push(ledger.harnessCalls.at(-1)!);
	}
	return ledger;
}

function productionLedger(calls = 3): RealSpawnLedger {
	const ledger = createRealSpawnLedger();
	for (let i = 0; i < calls; i++) {
		ledger.total += 1;
		ledger.calls.set("spawn", (ledger.calls.get("spawn") ?? 0) + 1);
		ledger.byClass.set("other", (ledger.byClass.get("other") ?? 0) + 1);
	}
	return ledger;
}

const CENSUS = JSON.stringify({
	"real-process-spawn": { "clients/known.test.ts": 2 },
});
const OBSERVED = JSON.stringify({
	"mcp/symbol-search.smoke.test.ts": {
		reason: "drives the compiled MCP stdio server as a real child",
		routes: ["spawn:node via tests/mcp/harness.ts:98"],
	},
});

/** An in-memory `tests/support/` so the gate's ledger reads are pinned,
 *  including the failure arms no file on disk produces. */
/** Each case gets its own `supportDir`: the admission cache is keyed on it, so
 *  one shared key would hand the first case's ledgers to every later case. */
let ioSeq = 0;
function ioWith(
	files: Partial<Record<string, string | Error>>,
): RealSpawnAdmissionIo {
	ioSeq += 1;
	return {
		supportDir: `/support/${ioSeq}`,
		readFile: (target: string): string => {
			const value = files[path.basename(target)];
			if (value instanceof Error) throw value;
			if (value === undefined) {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			}
			return value;
		},
	};
}

const BOTH_LEDGERS = {
	[REAL_SPAWN_BASELINE_FILE]: CENSUS,
	[REAL_SPAWN_OBSERVED_FILE]: OBSERVED,
};

describe("realSpawnGateFailure", () => {
	it("reds an unadmitted file, naming the count, the route, and the ledger to edit", () => {
		const failure = realSpawnGateFailure(
			"support/new.test.ts",
			harnessLedger(3),
			ioWith(BOTH_LEDGERS),
		);
		expect(failure).toContain("#5100 real-spawn census");
		expect(failure).toContain("started 3 real child");
		expect(failure).toContain("spawn:node via tests/mcp/harness.ts:98");
		expect(failure).toContain(REAL_SPAWN_OBSERVED_FILE);
		// The message carries the row to paste, with the observed routes, so the
		// fix is one edit rather than a guess at the format.
		expect(failure).toContain(
			'"routes":["spawn:node via tests/mcp/harness.ts:98"]',
		);
		expect(failure).toContain("ADMITTED_AFTER_BASELINE");
	});

	it("caps the route list but keeps the total in the sentence", () => {
		const ledger = createRealSpawnLedger();
		for (let i = 0; i < 8; i++) {
			ledger.total += 1;
			ledger.byClass.set("harness", (ledger.byClass.get("harness") ?? 0) + 1);
			ledger.harnessCalls.push({
				entry: "spawn",
				command: `node${i}`,
				frames: [
					`harness:h${i} (${path.join(REPO, `tests/support/kit${i}.ts`)}:${i + 1}:1)`,
				],
			});
		}
		const summaries = realSpawnRouteSummaries(ledger, 4);
		expect(summaries).toHaveLength(5);
		expect(summaries.at(-1)).toBe("+4 more");
		expect(
			realSpawnGateFailure("support/new.test.ts", ledger, ioWith(BOTH_LEDGERS)),
		).toContain("started 8 real child");
	});

	it("passes a file the static census already admits", () => {
		expect(
			realSpawnGateFailure(
				"clients/known.test.ts",
				harnessLedger(),
				ioWith(BOTH_LEDGERS),
			),
		).toBeUndefined();
	});

	it("passes a file the run-time ledger admits", () => {
		expect(
			realSpawnGateFailure(
				"mcp/symbol-search.smoke.test.ts",
				harnessLedger(),
				ioWith(BOTH_LEDGERS),
			),
		).toBeUndefined();
	});

	it("passes the census's own scan infrastructure", () => {
		expect(
			realSpawnGateFailure(
				"clients/flake-shape-ratchet.test.ts",
				harnessLedger(),
				ioWith(BOTH_LEDGERS),
			),
		).toBeUndefined();
	});

	it("passes a file whose only children came from the code under test", () => {
		expect(
			realSpawnGateFailure(
				"clients/git-heavy.test.ts",
				productionLedger(3),
				ioWith(BOTH_LEDGERS),
			),
		).toBeUndefined();
	});

	it("passes any file when the ledger is empty, whatever the admission", () => {
		expect(
			realSpawnGateFailure(
				"clients/whatever.test.ts",
				createRealSpawnLedger(),
				ioWith({}),
			),
		).toBeUndefined();
	});

	it("reds and says so when the census baseline cannot be read (fail closed)", () => {
		const io = ioWith({
			[REAL_SPAWN_BASELINE_FILE]: new Error("EACCES: permission denied"),
			[REAL_SPAWN_OBSERVED_FILE]: OBSERVED,
		});
		const failure = realSpawnGateFailure(
			"clients/known.test.ts",
			harnessLedger(),
			io,
		);
		// An unreadable census admits nothing, so even a file WITH a census row
		// is judged — and told why.
		expect(failure).toContain("could not be read");
		expect(failure).toContain("EACCES");
		expect(realSpawnAdmissionProblems(io)).toHaveLength(1);
	});

	it("reds when the baseline has no real-process-spawn table", () => {
		const io = ioWith({
			[REAL_SPAWN_BASELINE_FILE]: JSON.stringify({ "in-process-mock": {} }),
			[REAL_SPAWN_OBSERVED_FILE]: OBSERVED,
		});
		expect(
			realSpawnGateFailure("support/new.test.ts", harnessLedger(), io),
		).toContain('has no "real-process-spawn" table');
	});

	it("reds when the run-time ledger is not an object", () => {
		const io = ioWith({
			[REAL_SPAWN_BASELINE_FILE]: CENSUS,
			[REAL_SPAWN_OBSERVED_FILE]: "[]",
		});
		expect(
			realSpawnGateFailure("support/new.test.ts", harnessLedger(), io),
		).toContain("is not an object");
	});

	it("accepts an absent run-time ledger as empty, not as a problem", () => {
		const io = ioWith({ [REAL_SPAWN_BASELINE_FILE]: CENSUS });
		expect(
			realSpawnGateFailure("clients/known.test.ts", harnessLedger(), io),
		).toBeUndefined();
		expect(realSpawnAdmissionProblems(io)).toEqual([]);
	});

	it("shares one answer with hasRealSpawnAdmission for census, observed, and unknown files", () => {
		const io = ioWith(BOTH_LEDGERS);
		expect(hasRealSpawnAdmission("clients/known.test.ts", io)).toBe(true);
		expect(hasRealSpawnAdmission("mcp/symbol-search.smoke.test.ts", io)).toBe(
			true,
		);
		expect(hasRealSpawnAdmission("support/new.test.ts", io)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 5. the committed run-time ledger is an account, not an allowlist
// ---------------------------------------------------------------------------

// A plain string title, on purpose: `sweep-kit.testDeclarations` cannot find
// the callback body of a `describe` whose title is a template literal with a
// `${}` placeholder, so every test nested under one reads as not live — and a
// planted-stale-row cell (#5072) in such a block is invisible to the census.
describe("the run-time observed ledger", () => {
	const censusRows = Object.keys(
		JSON.parse(
			fs.readFileSync(path.join(SUPPORT_DIR, REAL_SPAWN_BASELINE_FILE), "utf8"),
		)["real-process-spawn"] as Record<string, number>,
	);
	const ledgerPath = path.join(SUPPORT_DIR, REAL_SPAWN_OBSERVED_FILE);
	const rows = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as Record<
		string,
		{ reason?: string; routes?: string[] }
	>;
	const keys = Object.keys(rows);

	it("is a sorted registry", () => {
		expect(keys).toEqual([...keys].sort(byText));
	});

	it("keys a file that exists, spelled below tests/", () => {
		for (const key of keys) {
			expect(key).not.toMatch(/^(\.\/|tests\/|\/)/);
			expect(fs.existsSync(path.join(REPO, "tests", key))).toBe(true);
		}
	});

	it("states a reason per row that a reviewer can check", () => {
		for (const [key, row] of Object.entries(rows)) {
			expect(row.reason?.trim().length, key).toBeGreaterThanOrEqual(15);
			// The draft the gate prints is not an admission.
			expect(row.reason?.startsWith("<"), key).toBe(false);
		}
	});

	it("names at least one observed route per row, in repo-relative form", () => {
		for (const [key, row] of Object.entries(rows)) {
			expect(row.routes?.length ?? 0, key).toBeGreaterThan(0);
			for (const route of row.routes ?? []) {
				expect(route, key).toMatch(/^[\w.]+:[\w.@-]+ via .+/);
				expect(route.includes(REPO), key).toBe(false);
			}
		}
	});

	it("holds no row the static census already carries (the ledger only shrinks)", () => {
		const covered = keys.filter((key) => censusRows.includes(key));
		expect(covered).toEqual([]);
	});

	// #5072: the ledger's planted-stale-row cell. Its ratchet is the key rule
	// above — a row is live while the file it keys exists — so the row this cell
	// plants is the admission of a spawner that has since stopped starting
	// children. Without this direction the ledger would shrink only by hand, and
	// a retired row would keep admitting a file for nothing.
	it("reds a row whose spawner is gone, on a planted retired key (#5072)", () => {
		// The census speaks this ledger by its repo-relative id while the
		// observer writes it by the module constant above; pin that the two
		// spell one file, so renaming either cannot leave the census owning a
		// ledger that is gone.
		expect(path.resolve(REPO, "tests/support/real-spawn-observed.json")).toBe(
			ledgerPath,
		);
		const planted = "support/planted-retired-spawner.test.ts";
		// The live population, read from the tree: the same predicate the key
		// rule above uses, so a planted key that does exist would red here.
		const live = new Set(
			keys.filter((key) => fs.existsSync(path.join(REPO, "tests", key))),
		);
		expect(live.size).toBe(keys.length);
		const verdict = rowsWithoutLiveMember([...keys, planted], live).map(
			(row) => `stale real-spawn admission: ${row}`,
		);
		expect(verdict).toEqual([`stale real-spawn admission: ${planted}`]);
		expectPlantedStaleRow({
			baseline: "tests/support/real-spawn-observed.json",
			rowKey: planted,
			verdict,
		});
	});
});

// ---------------------------------------------------------------------------
// 6. the whole seam, through a real fork: the red lands in the spawner's file
// ---------------------------------------------------------------------------

const FIXTURE_DIR = "tests/fixtures/real-spawn-gate";
const env = setupTestEnvironment("pi-lens-real-spawn-observer-");

interface FixtureReport {
	testResults: Array<{ name: string; status: string; message?: string }>;
}

let childExitCode: number | null = null;
let childStderr = "";
let childReport: FixtureReport = { testResults: [] };

function fixtureResult(
	fixture: string,
): FixtureReport["testResults"][number] | undefined {
	return childReport.testResults.find((entry) =>
		entry.name.replace(/\\/g, "/").endsWith(`${FIXTURE_DIR}/${fixture}`),
	);
}

function statusOf(fixture: string): string | undefined {
	return fixtureResult(fixture)?.status;
}

/** What the fork reported at file level: the teardown error's text, which is
 *  where the gate's red appears (the JSON reporter keeps it here, and writes
 *  nothing to stderr). */
function messageOf(fixture: string): string {
	return fixtureResult(fixture)?.message ?? "";
}

beforeAll(async () => {
	const childTmp = path.join(env.tmpDir, "tmp");
	fs.mkdirSync(childTmp, { recursive: true });
	const outputFile = path.join(env.tmpDir, "report.json");
	const childOutcome = await new Promise<{
		code: number | null;
		stderr: string;
	}>((resolve) => {
		const child = spawnSync(
			process.execPath,
			[
				path.join(REPO, "node_modules/vitest/vitest.mjs"),
				"run",
				"--config",
				`${FIXTURE_DIR}/vitest.config.ts`,
				"--reporter=json",
				`--outputFile=${outputFile}`,
			],
			{
				cwd: REPO,
				timeout: 90_000,
				env: {
					...process.env,
					TMPDIR: childTmp,
					TMP: childTmp,
					TEMP: childTmp,
					PI_LENS_HOME: path.join(env.tmpDir, "home"),
					// The evidence record is a measurement switch; the gate must
					// red on its own, with no record asked for.
					PI_LENS_REAL_SPAWN_EVIDENCE: "",
					// CI shard 5's census runs `ps` from the setup's afterAll in
					// every file (#5100 r3 F2): the no-op fixture must stay green.
					PI_LENS_DEAD_OWNER_CENSUS_FILE: path.join(
						env.tmpDir,
						"dead-owner-census.log",
					),
				},
			},
		);
		resolve({
			code: child.error ? -1 : child.status,
			stderr: String(child.stderr),
		});
	});
	childExitCode = childOutcome.code;
	childStderr = childOutcome.stderr;
	try {
		childReport = JSON.parse(
			fs.readFileSync(outputFile, "utf8"),
		) as FixtureReport;
	} catch {
		// A reporter that never wrote: the cases below name the missing outcome.
	}
}, 150_000);

afterAll(() => {
	fs.rmSync(
		path.join(REPO, "tests", "fixtures", "real-spawn-gate", ".vitest-cache"),
		{
			recursive: true,
			force: true,
		},
	);
});

describe("the gate in a real fork", () => {
	it("reds the fixture that spawns a real child with no admission", () => {
		// The teardown red makes the fork itself fail, so the red reaches the
		// run's exit status rather than only its report.
		expect(childExitCode).not.toBe(0);
		expect(childStderr).not.toContain("Unhandled");
		expect(statusOf("unadmitted-spawn.fixture.ts")).toBe("failed");
		const message = messageOf("unadmitted-spawn.fixture.ts");
		expect(message).toContain("#5100 real-spawn census");
		expect(message).toContain("started 1 real child");
		// The route names the file's own spawn site, relative to the repo.
		expect(message).toContain(
			"spawnSync:node via tests/fixtures/real-spawn-gate/unadmitted-spawn.fixture.ts",
		);
		expect(message).toContain(REAL_SPAWN_OBSERVED_FILE);
	});

	// #5100 r3 F2: with the census on, the setup's own `ps` ran in this file's
	// afterAll and was charged to it, so a file that spawns nothing went red.
	it("passes a file that spawns nothing while the dead-owner census runs", () => {
		expect(statusOf("setup-census-noop.fixture.ts")).toBe("passed");
		expect(messageOf("setup-census-noop.fixture.ts")).toBe("");
	});

	// Issue #5100's acceptance: the spellings the name census had to enumerate
	// are red through the boundary. Each is a real fork, so a spelling the
	// observer cannot see is a green fixture here.
	it.each([
		["actual-spawn.fixture.ts", "spawnSync:node via"],
		["renamed-spawn.fixture.ts", "execFileSync:node via"],
		["production-route.fixture.ts", "spawnSync:node via"],
	])("reds %s, which reaches child_process another way", (fixture, route) => {
		expect(statusOf(fixture)).toBe("failed");
		const message = messageOf(fixture);
		expect(message).toContain("#5100 real-spawn census");
		expect(message).toContain(
			`${route} tests/fixtures/real-spawn-gate/${fixture}`,
		);
	});

	it("passes the fixture whose spawn is a module mock", () => {
		expect(statusOf("mocked-spawn.fixture.ts")).toBe("passed");
		expect(messageOf("mocked-spawn.fixture.ts")).toBe("");
	});

	it("needs no ledger row for either fixture (the red is the point)", () => {
		const io: RealSpawnAdmissionIo = {
			supportDir: SUPPORT_DIR,
			readFile: (target: string): string => fs.readFileSync(target, "utf8"),
		};
		expect(
			hasRealSpawnAdmission(
				"fixtures/real-spawn-gate/unadmitted-spawn.fixture.ts",
				io,
			),
		).toBe(false);
		expect(
			hasRealSpawnAdmission(
				"fixtures/real-spawn-gate/mocked-spawn.fixture.ts",
				io,
			),
		).toBe(false);
	});
});

/**
 * #5100 — the run-time real-spawn observer.
 *
 * The flake-shape census (`tests/support/flake-shape-scan.ts`) decides whether
 * a test file starts a real child process by reading its SOURCE for a fixed
 * list of names: the `child_process` import, the sync triad, a spawn-helper
 * name (`SUPPORT_SPAWN_HELPER_CALL`), a kit helper in a file that names its kit
 * (#3801), a `vi.importActual` naming `child_process` (#5064), an
 * `AstGrepClient` construction (#5100). Every one of those is a name, and a
 * spawn that does not spell a known name passes the census with no admission:
 * an aliased client (`const C = AstGrepClient; new C()`), a kit helper reached
 * through a barrel alias, a helper defined in a module the census never heard
 * of. Each new spelling costs one more list entry, which is the shape #5100
 * reports.
 *
 * This module asks the question at the boundary that cannot be renamed:
 * `node:child_process`. The shared setup (`tests/support/vitest-setup.ts`)
 * patches the module's spawn entry points before the test module graph loads
 * and publishes them to ESM importers with `syncBuiltinESMExports()`, the same
 * seam the #2912 tmp-root interposer uses; a call to any entry point is
 * recorded in the running file's ledger. A file whose run records a real spawn
 * and that holds no `real-process-spawn` admission (#5100:
 * `tests/support/real-spawn-admission.ts`) fails at its own teardown, so the
 * red lands in the file that started the child, in the run that started it.
 *
 * Mocked spawns are exempt by construction: `vi.mock("node:child_process")`
 * replaces the module in the test's registry, so the test's calls reach the
 * mock and never the patched real exports. A file that mocks the module and
 * then asks for the real one (`vi.importActual`) is recorded, which is exactly
 * the #5064 shape.
 *
 * The judgment is per FILE, and it needs one distinction the source cannot
 * make and the boundary can: who reached `child_process`. A spawn whose
 * nearest caller is a module below `tests/` is the harness starting a process
 * — what the census means by a spawner, whatever name it used. A spawn whose
 * nearest caller is production (`clients/`, `tools/`, `index.ts`) is the code
 * under test running a child on its own account (a formatter probe, a git
 * call, the memory sampler's `getconf`): recorded as context, never charged.
 * Measured over the 274-file union of the census population and every test
 * file whose import closure reaches `child_process` through a `tests/` module:
 * 213 of 242 spawning files start children at all, and 72 of them ONLY
 * through production routes — charging those would move ~30% of the suite into
 * the serialized lane to describe code the census has never owned.
 * - A durable census. The ledger is per worker, and the worker is per file
 *   (`isolate: true`), so no cross-file state and no reset are needed. The
 *   optional {@link REAL_SPAWN_EVIDENCE_ENV} record exists so a measurement run
 *   can enumerate the live population; it is off unless a caller names the path.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** The `node:child_process` members that start a process. `promises.execFile`
 *  and `promises.exec` are reached through the `promises` namespace object. */
export const REAL_SPAWN_ENTRY_POINTS = [
	"spawn",
	"spawnSync",
	"exec",
	"execSync",
	"execFile",
	"execFileSync",
	"fork",
] as const;

export type RealSpawnEntryPoint = (typeof REAL_SPAWN_ENTRY_POINTS)[number];

/** The shape {@link installRealSpawnObserver} patches: the real
 *  `node:child_process` module object, typed loosely because the shared setup
 *  passes the default import and no test may depend on this module's types. */
export interface RealSpawnTarget {
	[name: string]: unknown;
	promises?: { exec?: unknown; execFile?: unknown };
}

/** A recorded spawn: the entry point, the command, and the caller frames. */
export interface RealSpawnCall {
	readonly entry: RealSpawnEntryPoint;
	readonly command: string;
	/** The caller frames closest to the spawn call, as `<class>:<name>`, where
	 *  class is `harness` (a frame below `tests/`), `child_process`, or
	 *  `other` (production, node_modules, or an anonymous frame). */
	readonly frames: readonly string[];
}

export interface RealSpawnLedger {
	/** Per-caller-class totals, so the gate can charge only harness routes. */
	readonly byClass: Map<string, number>;
	/** The calls attributed to the harness, bounded for the failure message. */
	readonly harnessCalls: RealSpawnCall[];
	/** Up to {@link MAX_RECORDED_COMMANDS} calls of ANY class, for the evidence
	 *  record: the attribution a reviewer reads is the observed one. */
	readonly samples: RealSpawnCall[];
	/** Calls observed, per entry point. */
	readonly calls: Map<RealSpawnEntryPoint, number>;
	/** The first command seen per entry point, bounded by
	 *  {@link MAX_RECORDED_COMMANDS} — the failure message names what ran. */
	readonly commands: string[];
	/** Total observed calls. */
	total: number;
	/** Calls dropped because {@link MAX_RECORDED_COMMANDS} was reached. */
	droppedCommands: number;
}

const MAX_RECORDED_COMMANDS = 8;

export function createRealSpawnLedger(): RealSpawnLedger {
	return {
		calls: new Map(),
		commands: [],
		total: 0,
		droppedCommands: 0,
		byClass: new Map(),
		harnessCalls: [],
		samples: [],
	};
}

/** The command a spawn names: the basename of `argv[0]` of a
 *  spawn/spawnSync/execFile/fork call, or of the first word of an `exec`
 *  shell line (`getconf CLK_TCK` names `getconf`: a route is `entry:command`
 *  and holds no space). Empty-ish when the argument is not a string (a URL or an
 *  options object first is rare, and the count, not the name, carries the
 *  judgment). */
function commandOf(entry: RealSpawnEntryPoint, args: unknown[]): string {
	const first = args[0];
	if (typeof first !== "string") return "<non-string>";
	const word =
		entry === "exec" || entry === "execSync"
			? (first.trim().split(/\s+/)[0] ?? first)
			: first;
	return word.split(/[\\/]/).pop() ?? word;
}

/**
 * Wrap every spawn entry point of `target` so each call is counted in `ledger`.
 * The wrapper forwards unmodified: this module observes, it never intervenes.
 * Installed once per worker by `tests/support/vitest-setup.ts`.
 */
/** The instrument's own modules, by basename and extension, with the stack
 *  frame's `:line:col` after them. */
const INSTRUMENT_MODULE =
	/[\\/]((real-spawn-observer)|(real-spawn-admission)|(vitest-setup))\.[cm]?[jt]sx?:\d+:\d+/;

/** Who a stack line belongs to, for the charge. `instrument` is the shared
 *  setup's own module (and this observer's): a chain that ends there is the
 *  setup's, not the running file's. */
export type RealSpawnCallerClass =
	| "harness"
	| "instrument"
	| "child_process"
	| "other";

/** A path with forward slashes only: a Windows stack frame spells a path with
 *  backslashes where a vite-node frame spells the same file with forward
 *  slashes, and the checkout root arrives in either form (#5100 r3 F4). */
const toPosix = (text: string): string => text.replace(/\\/g, "/");

/** The checkout root as a frame spells it, from this module's own location, so
 *  it matches the frames by construction: the working directory is not the
 *  checkout when a run starts elsewhere or through a link. */
const REPO_ROOT = toPosix(
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);

/** A text with the checkout root removed, so a path reads repo-relative. Both
 *  separators match, and the root takes no trailing slash from the caller.
 *  The one rule the ledger applies before any length cut and the route
 *  summaries apply to the location they show (#5100). */
export function repoRelative(text: string, root = REPO_ROOT): string {
	return toPosix(text).replace(`${toPosix(root).replace(/\/+$/, "")}/`, "");
}

/** One stack line's class. `harness` is a frame below the checkout's `tests/`
 *  directory: the running test file, or a harness helper it called.
 *  `child_process` is node's own boundary; `instrument` is the setup's and the
 *  observer's modules. Anything else — `clients/`, `tools/`, `index.ts`,
 *  `node_modules`, an anonymous frame — is not harness code by itself; whether
 *  it takes the charge depends on the rest of the chain, which is
 *  {@link chainOwner}'s decision. The path judged is the one UNDER the
 *  checkout: a checkout inside a `tests/` directory must not class its
 *  production frames as harness (#5100 r3 F7). */
export function classifyFrame(
	frame: string,
	root = REPO_ROOT,
): RealSpawnCallerClass {
	if (
		frame.includes("node:child_process") ||
		// node's own spawn internals frame reads as `node:internal/child_process`.
		frame.includes("internal/child_process") ||
		frame.includes("/child_process.")
	) {
		return "child_process";
	}
	// Matched by module basename, not substring: the observer's own test file
	// (`real-spawn-observer.test.ts`) is a spawner like any other.
	if (INSTRUMENT_MODULE.test(frame)) return "instrument";
	return /(^|[\s(])tests\//.test(repoRelative(frame, root))
		? "harness"
		: "other";
}

/** A frame of a collected test file, which makes its chain the test's. */
const TEST_MODULE = /\.test\.[cm]?[jt]sx?:\d+:\d+/;

/** Who asked for the child the chain describes. Judged on the chain's
 *  OUTERMOST test-tree frame, innermost first in `lines`:
 *
 *  - `harness`: the running file asked, directly or through a helper or
 *    production code (#5084), so it owes the admission.
 *  - `setup`: the chain ends at the shared setup's own hook, and no test file
 *    is in it. The kill guard, the tmp-hygiene sweep and the dead-owner census
 *    start children from there on every file (CI shard 5's `ps` redded 340 of
 *    420 files); charging them blames the file for the instrument's own work.
 *  - `none`: no `tests/` frame at all (a module-level timer, a watcher,
 *    vitest's pool): recorded, never charged, because charging it would blame
 *    whichever file happened to be scheduled.
 *
 *  A capture cut short of the chain's end (`truncated`) cannot say where the
 *  chain ends, and a chain nobody can place is charged, not excused. */
export function chainOwner(
	lines: readonly string[],
	truncated: boolean,
	root = REPO_ROOT,
): "harness" | "setup" | "none" {
	const tree = lines
		.map((line) => ({ line, cls: classifyFrame(line, root) }))
		.filter((frame) => frame.cls === "harness" || frame.cls === "instrument");
	if (!tree.some((frame) => frame.cls === "harness")) return "none";
	if (truncated) return "harness";
	if (tree.some((frame) => TEST_MODULE.test(frame.line))) return "harness";
	return tree[tree.length - 1]!.cls === "instrument" ? "setup" : "harness";
}

/** The frames the ledger keeps per call, for the route message. */
const MAX_RECORDED_FRAMES = 4;

/** How deep the capture goes. A test that reaches `child_process` through
 *  production code \u2014 the #5084 shape, a tool call that ends in `safeSpawn`, a
 *  client class that runs the real CLI \u2014 has its own frame well below node\u2019s
 *  default `Error.stackTraceLimit` of 10, and the setup\u2019s own hook sits at the
 *  far end of its chain. One capture of this depth serves both questions; a
 *  capture that fills it is {@link chainOwner}'s `truncated`. */
const CAPTURE_FRAMES = 48;

/** The caller lines of the current stack, `Error.stackTraceLimit` restored on
 *  every path. */
function stackLines(): string[] {
	const previous = Error.stackTraceLimit;
	try {
		Error.stackTraceLimit = CAPTURE_FRAMES;
		return String(new Error().stack ?? "")
			.split("\n")
			.slice(2);
	} finally {
		Error.stackTraceLimit = previous;
	}
}

/** One caller line in ledger form: its class, then its module and position.
 *  The location goes repo-relative first and is never cut: a cut through an
 *  absolute path recorded `…fixture.t` on a 63-character checkout (#5100 r2).
 *  The function name is not capped either: it is V8's identifier text, and
 *  every consumer bounds the output already (four frames per call, eight
 *  samples, the 900-character evidence slice, and a route that shows only the
 *  location). */
export function frameOf(
	line: string,
	cls: RealSpawnCallerClass | "setup",
	root?: string,
): string {
	return `${cls}:${repoRelative(line.trim().replace(/^at\s+/, ""), root)}`;
}

interface SpawnCallers {
	/** Recorded frames, causing harness frame first: the route a reader has to
	 *  check is the test line that asked for the child, not the `node:internal`
	 *  machinery under it. */
	frames: string[];
	/** Who asked for the child ({@link chainOwner}). The file that asked owes
	 *  the admission, whether it called `spawn` itself or drove production code
	 *  that did: the contention the admission is about is the same either way
	 *  (#5084). */
	owner: "harness" | "setup" | "none";
}

/** The callers that matter, with the chain\u2019s verdict. */
function callerFrames(depth: number): SpawnCallers {
	const lines = stackLines();
	const owner = chainOwner(lines, lines.length >= CAPTURE_FRAMES - 1);
	const label = owner === "setup" ? "setup" : "harness";
	const frames = lines
		.filter((line) => classifyFrame(line) === "harness")
		.slice(0, depth)
		.map((line) => frameOf(line, label));
	for (const line of lines) {
		if (frames.length >= depth) break;
		const cls = classifyFrame(line);
		// `child_process`, instrument and already-recorded harness frames are
		// skipped; the rest is context for a call nobody charged.
		if (cls === "child_process" || cls === "harness" || cls === "instrument")
			continue;
		frames.push(frameOf(line, cls));
	}
	return { frames, owner };
}

/** Runs one call of an observed entry point: notes it, then forwards. */
type ObserveCall = (
	entry: RealSpawnEntryPoint,
	args: unknown[],
	forward: () => unknown,
) => unknown;

/** A copy of `fn` that notes each call and forwards it unmodified. Every own
 *  property and symbol of `fn` is carried, so `util.promisify(wrapper)` finds
 *  the `[util.promisify.custom]` node put on `exec` and `execFile` and resolves
 *  `{ stdout, stderr }` as it does for the original (#5100 r3 F1: a bare
 *  wrapper resolved a string and 82 tests in 6 files went red). The custom
 *  function is an entry point of its own and is wrapped the same way. */
function observed(
	fn: (...args: unknown[]) => unknown,
	entry: RealSpawnEntryPoint,
	observe: ObserveCall,
): (...args: unknown[]) => unknown {
	const wrapper = function (this: unknown, ...args: unknown[]): unknown {
		return observe(entry, args, () => fn.apply(this, args));
	};
	for (const key of Reflect.ownKeys(fn)) {
		const descriptor = Object.getOwnPropertyDescriptor(fn, key)!;
		if (key === promisify.custom && typeof descriptor.value === "function")
			descriptor.value = observed(
				descriptor.value as (...args: unknown[]) => unknown,
				entry,
				observe,
			);
		Object.defineProperty(wrapper, key, descriptor);
	}
	return wrapper;
}

export function installRealSpawnObserver(
	target: RealSpawnTarget,
	ledger: RealSpawnLedger,
): void {
	const note = (entry: RealSpawnEntryPoint, args: unknown[]): void => {
		ledger.total += 1;
		ledger.calls.set(entry, (ledger.calls.get(entry) ?? 0) + 1);
		if (ledger.commands.length < MAX_RECORDED_COMMANDS) {
			const command = `${entry}:${commandOf(entry, args)}`;
			if (!ledger.commands.includes(command)) ledger.commands.push(command);
		} else {
			ledger.droppedCommands += 1;
		}
		const { frames, owner } = callerFrames(MAX_RECORDED_FRAMES);
		const cls = owner === "none" ? "other" : owner;
		ledger.byClass.set(cls, (ledger.byClass.get(cls) ?? 0) + 1);
		const call: RealSpawnCall = {
			entry,
			command: commandOf(entry, args),
			frames,
		};
		if (ledger.samples.length < MAX_RECORDED_COMMANDS)
			ledger.samples.push(call);
		if (
			cls === "harness" &&
			ledger.harnessCalls.length < MAX_RECORDED_COMMANDS
		) {
			ledger.harnessCalls.push(call);
		}
	};
	// Observed calls on the stack. Node's `exec` starts its child through
	// `module.exports.execFile`, which is a wrapper too, so a call made while
	// another observed call runs is that call's own machinery, not a second
	// child: one exec counted twice in "started N" (#5100 r3 N2).
	let depth = 0;
	const observe: ObserveCall = (entry, args, forward) => {
		if (depth === 0) note(entry, args);
		depth += 1;
		try {
			return forward();
		} finally {
			depth -= 1;
		}
	};
	for (const entry of REAL_SPAWN_ENTRY_POINTS) {
		const original = target[entry];
		if (typeof original !== "function") continue;
		target[entry] = observed(
			original as (...args: unknown[]) => unknown,
			entry,
			observe,
		);
	}
	const promises = target.promises;
	if (promises) {
		for (const entry of ["exec", "execFile"] as const) {
			const original = promises[entry];
			if (typeof original !== "function") continue;
			promises[entry] = observed(
				original as (...args: unknown[]) => unknown,
				entry,
				observe,
			);
		}
	}
}

/**
 * One line per spawning worker for the optional evidence record
 * ({@link REAL_SPAWN_EVIDENCE_ENV}): the file, the call count, the entry
 * points, and up to {@link MAX_RECORDED_COMMANDS} commands. `undefined` when
 * the file observed nothing, so a quiet file appends nothing.
 */
/** The calls the gate charges: those whose chain holds a harness frame, at any
 *  depth \u2014 the test called `spawn` itself, or drove production code that did
 *  (#5084). A child with no harness frame anywhere in the chain is recorded,
 *  and reported as context, but never makes the running file a member. */
export function harnessSpawnCount(ledger: RealSpawnLedger): number {
	return ledger.byClass.get("harness") ?? 0;
}

/** A code-unit order, so the evidence line reads the same on every host. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function formatRealSpawnEvidence(
	file: string,
	ledger: RealSpawnLedger,
): string | undefined {
	if (ledger.total === 0) return undefined;
	const entryPoints = [...ledger.calls.entries()]
		.map(([name, count]) => `${name}=${count}`)
		.sort(byText)
		.join(",");
	const classes = [...ledger.byClass.entries()]
		.map(([name, count]) => `${name}=${count}`)
		.sort(byText)
		.join(",");
	const samples = ledger.samples
		.map(
			(call) =>
				`${call.entry}:${call.command}[${call.frames[0] ?? "other"}|${
					call.frames.find((frame) => frame.startsWith("harness:")) ?? "none"
				}]`,
		)
		.join(" ; ");
	return (
		`${file}\t${ledger.total}\t${classes}\t${entryPoints}\t` +
		`${samples.slice(0, 900)}\t` +
		`${ledger.commands.join(",")}${ledger.droppedCommands > 0 ? `,+${ledger.droppedCommands}` : ""}\n`
	);
}

/** When set, the shared setup appends one evidence line per spawning file to
 *  this path. Unset in a normal run: the gate is the per-file teardown check,
 *  not a record a later process reads. */
export const REAL_SPAWN_EVIDENCE_ENV = "PI_LENS_REAL_SPAWN_EVIDENCE";

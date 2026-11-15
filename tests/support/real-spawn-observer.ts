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

/** The command a spawn names: `argv[0]` of a spawn/spawnSync/exec/execFile/
 *  fork call, empty when the argument is not a string (a URL or an options
 *  object first is rare, and the count, not the name, carries the judgment). */
function commandOf(args: unknown[]): string {
	const first = args[0];
	if (typeof first === "string") return first.split(/[\\/]/).pop() ?? first;
	return "<non-string>";
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

/** Who a stack line belongs to, for the charge. */
export type RealSpawnCallerClass = "harness" | "child_process" | "other";

/** One stack line's class. `harness` is a frame below a `tests/` directory:
 *  the running test file, or a harness helper it called. `child_process` is the
 *  boundary itself plus the instrument's own modules. Anything else —
 *  `clients/`, `tools/`, `index.ts`, `node_modules`, an anonymous frame — is
 *  not harness code by itself; whether it takes the charge depends on the rest
 *  of the chain, which is {@link callerFrames}' decision. Both separators are
 *  matched: a Windows stack frame spells the path with backslashes, and a
 *  `/tests/`-only match would leave the gate blind on the Windows lane. */
export function classifyFrame(frame: string): RealSpawnCallerClass {
	if (
		frame.includes("node:child_process") ||
		// node's own spawn internals frame reads as `node:internal/child_process`.
		frame.includes("internal/child_process") ||
		frame.includes("/child_process.") ||
		// The observer's own wrapper frames sit between the caller and the real
		// function: they are part of the boundary, not a caller. So are the
		// shared setup's frames — the setup's own module-level children (its
		// repo-root `git`, its hygiene probes) run while whichever file happens
		// to be first in the worker, and charging that file for the
		// instrument's own calls would be a flake the instrument caused.
		// Matched by module basename, not substring: the observer's own test
		// file (`real-spawn-observer.test.ts`) is a spawner like any other.
		INSTRUMENT_MODULE.test(frame)
	) {
		return "child_process";
	}
	return frame.includes("/tests/") || frame.includes("\\tests\\")
		? "harness"
		: "other";
}

/** The frames the ledger keeps per call, for the route message. */
const MAX_RECORDED_FRAMES = 4;

/** How deep to look for the harness frame that caused a spawn. A test that
 *  reaches `child_process` through production code \u2014 the #5084 shape, a tool
 *  call that ends in `safeSpawn`, a client class that runs the real CLI \u2014 has
 *  its own frame below node\u2019s default `Error.stackTraceLimit` of 10. The
 *  widened capture therefore runs only when the shallow one found no harness
 *  frame at all, so a plainly harness-caused child never pays for it. */
const DEEP_SCAN_FRAMES = 48;

/** The caller lines of the current stack. `limit` of 0 keeps node\u2019s current
 *  `Error.stackTraceLimit`; a raised limit is restored on every path. */
function stackLines(limit: number): string[] {
	if (limit === 0)
		return String(new Error().stack ?? "")
			.split("\n")
			.slice(2);
	const previous = Error.stackTraceLimit;
	try {
		Error.stackTraceLimit = limit;
		return String(new Error().stack ?? "")
			.split("\n")
			.slice(2);
	} finally {
		Error.stackTraceLimit = previous;
	}
}

/** One caller line in ledger form: its class, then its module and position. */
function frameOf(line: string, cls: RealSpawnCallerClass): string {
	return `${cls}:${line
		.trim()
		.replace(/^at\s+/, "")
		.slice(0, 120)}`;
}

interface SpawnCallers {
	/** Recorded frames, causing harness frame first: the route a reader has to
	 *  check is the test line that asked for the child, not the `node:internal`
	 *  machinery under it. */
	frames: string[];
	/** Whether any caller in the chain is harness code, however deep below a
	 *  production frame. The file that asked for a real child owes the
	 *  admission, whether it called `spawn` itself or drove production code
	 *  that did: the contention the admission is about is the same either way
	 *  (#5084). What stays exempt is a child nobody in the conversation asked
	 *  for \u2014 a module-level timer, a watcher, vitest\u2019s own pool \u2014 because
	 *  charging it would blame whichever file happened to be scheduled. */
	harness: boolean;
}

/** The callers that matter, with the chain\u2019s verdict. */
function callerFrames(depth: number): SpawnCallers {
	let lines = stackLines(0);
	let harnessLines = lines.filter((line) => classifyFrame(line) === "harness");
	if (harnessLines.length === 0 && lines.length >= 10) {
		// The shallow capture ran into node\u2019s frame cap, so a harness frame
		// may sit below it: look deeper before letting the call go uncharged.
		lines = stackLines(DEEP_SCAN_FRAMES);
		harnessLines = lines.filter((line) => classifyFrame(line) === "harness");
	}
	const frames = harnessLines
		.slice(0, depth)
		.map((line) => frameOf(line, "harness"));
	for (const line of lines) {
		if (frames.length >= depth) break;
		const cls = classifyFrame(line);
		// `child_process` and already-recorded harness frames are skipped; the
		// rest is context for a call nobody charged.
		if (cls === "child_process" || cls === "harness") continue;
		frames.push(frameOf(line, cls));
	}
	return { frames, harness: harnessLines.length > 0 };
}

export function installRealSpawnObserver(
	target: RealSpawnTarget,
	ledger: RealSpawnLedger,
): void {
	const note = (entry: RealSpawnEntryPoint, args: unknown[]): void => {
		ledger.total += 1;
		ledger.calls.set(entry, (ledger.calls.get(entry) ?? 0) + 1);
		if (ledger.commands.length < MAX_RECORDED_COMMANDS) {
			const command = `${entry}:${commandOf(args)}`;
			if (!ledger.commands.includes(command)) ledger.commands.push(command);
		} else {
			ledger.droppedCommands += 1;
		}
		const { frames, harness } = callerFrames(MAX_RECORDED_FRAMES);
		const cls: RealSpawnCallerClass = harness ? "harness" : "other";
		ledger.byClass.set(cls, (ledger.byClass.get(cls) ?? 0) + 1);
		const call: RealSpawnCall = { entry, command: commandOf(args), frames };
		if (ledger.samples.length < MAX_RECORDED_COMMANDS)
			ledger.samples.push(call);
		if (
			cls === "harness" &&
			ledger.harnessCalls.length < MAX_RECORDED_COMMANDS
		) {
			ledger.harnessCalls.push(call);
		}
	};
	for (const entry of REAL_SPAWN_ENTRY_POINTS) {
		const original = target[entry];
		if (typeof original !== "function") continue;
		const fn = original as (...args: unknown[]) => unknown;
		const wrapper = function (this: unknown, ...args: unknown[]): unknown {
			note(entry, args);
			return fn.apply(this, args);
		};
		try {
			Object.defineProperty(wrapper, "name", { value: fn.name });
			Object.defineProperty(wrapper, "length", { value: fn.length });
		} catch {
			// A non-configurable name/length costs the message its label only.
		}
		target[entry] = wrapper;
	}
	const promises = target.promises;
	if (promises) {
		for (const entry of ["exec", "execFile"] as const) {
			const original = promises[entry];
			if (typeof original !== "function") continue;
			const fn = original as (...args: unknown[]) => unknown;
			promises[entry] = function (this: unknown, ...args: unknown[]): unknown {
				note(entry, args);
				return fn.apply(this, args);
			};
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

export function formatRealSpawnEvidence(
	file: string,
	ledger: RealSpawnLedger,
): string | undefined {
	if (ledger.total === 0) return undefined;
	const entryPoints = [...ledger.calls.entries()]
		.map(([name, count]) => `${name}=${count}`)
		.sort()
		.join(",");
	const classes = [...ledger.byClass.entries()]
		.map(([name, count]) => `${name}=${count}`)
		.sort()
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

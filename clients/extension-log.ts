/**
 * Terminal-safe diagnostic sink for the in-pi extension path (#1333).
 *
 * pi owns the terminal: it runs the TTY in raw mode and repaints with
 * cursor-addressed diffs, so ANY byte an extension writes to stdout/stderr
 * lands mid-frame and desyncs pi's model of the screen — the layout stays
 * broken until a full repaint. `clients/`, `tools/`, `index.ts` and `i18n.ts`
 * are all reachable from the extension entry, so none of them may call
 * `console.*` or `process.std*.write`. (`mcp/`, `scripts/` and `bin/` DO own
 * their stdout contract and keep their writes.)
 *
 * This module is the general-purpose replacement sink: one `createNdjsonLogger`
 * instance over `<global pi-lens dir>/extension.log`, per the single-writer
 * invariant in AGENTS.md. Subsystems that already own a log (tree-sitter,
 * review-graph, cascade, latency, sessionstart) route to THAT log instead —
 * this file is for the areas that had no sink at all.
 *
 * Three-channels rule (#482/#484/#485): everything written here is
 * LOG-audience. A genuinely user-facing degradation must ALSO reach the human
 * through the host's own render path (`ctx.ui.notify` / a display-only session
 * entry) — never a raw write.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { getTurnId } from "./turn-context.js";

export const EXTENSION_LOG_FILE = path.join(
	getGlobalPiLensLogDir(),
	"extension.log",
);

const writer = createNdjsonLogger({
	filePath: EXTENSION_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

/**
 * `error`/`warn` mirror the console methods they replaced; `debug` is the level
 * the previously verbose-gated client loggers write at (the gate is preserved
 * at the call site — see `createSubsystemLogger`).
 */
export type ExtensionLogLevel = "error" | "warn" | "debug";

export interface ExtensionLogEntry {
	/** Owning area, e.g. `dispatch`, `format`, `lens-config`. */
	subsystem: string;
	message: string;
	/** Defaults to `error` (the level every migrated ungated site wrote at). */
	level?: ExtensionLogLevel;
	metadata?: Record<string, unknown>;
	turnId?: string;
}

export function logExtension(entry: ExtensionLogEntry): void {
	if (isTestMode()) return;
	writer.log({
		ts: new Date().toISOString(),
		pid: process.pid,
		turnId: getTurnId(),
		level: entry.level ?? "error",
		subsystem: entry.subsystem,
		message: entry.message,
		...(entry.metadata ? { metadata: entry.metadata } : {}),
	});
}

/**
 * Drop-in replacement for the `verbose ? (msg) => console.error(...) : () => {}`
 * shape that ~20 clients hand-rolled. The returned value is CALLABLE (so the
 * `this.log = createSubsystemLogger("ruff")` migration is a one-line swap) and
 * also carries explicit `error`/`warn`/`debug` methods.
 *
 * Gating stays at the call site: `verbose ? createSubsystemLogger(x) : noop`
 * keeps the exact same "written only when verbose" semantics — what changed is
 * the SINK, not the gate, so turning verbose on can never corrupt the frame.
 */
export interface SubsystemLogger {
	(message: string, metadata?: Record<string, unknown>): void;
	error(message: string, metadata?: Record<string, unknown>): void;
	warn(message: string, metadata?: Record<string, unknown>): void;
	debug(message: string, metadata?: Record<string, unknown>): void;
}

export function createSubsystemLogger(
	subsystem: string,
	defaultLevel: ExtensionLogLevel = "debug",
): SubsystemLogger {
	const at =
		(level: ExtensionLogLevel) =>
		(message: string, metadata?: Record<string, unknown>): void => {
			logExtension({ subsystem, message, level, metadata });
		};
	const logger = at(defaultLevel) as SubsystemLogger;
	logger.error = at("error");
	logger.warn = at("warn");
	logger.debug = at("debug");
	return logger;
}

/** No-op with the `SubsystemLogger` shape, for the verbose-off branch. */
export function noopSubsystemLogger(): SubsystemLogger {
	// SAFETY: `SubsystemLogger` is a callable with `error`/`warn`/`debug`
	// properties. TypeScript cannot type a function literal that gains its
	// properties on the following lines, so the cast runs ahead of the three
	// assignments that complete the shape. Every member of the interface is
	// assigned before `noop` escapes this function.
	const noop = (() => {}) as unknown as SubsystemLogger;
	noop.error = () => {};
	noop.warn = () => {};
	noop.debug = () => {};
	return noop;
}

export function getExtensionLogPath(): string {
	return EXTENSION_LOG_FILE;
}

/** Resolve once all enqueued extension-log writes are on disk (tests/shutdown). */
export function flushExtensionLog(): Promise<void> {
	return writer.flush();
}

/** Teardown-only: force queued entries to disk before the process exits. */
export function flushExtensionLogSync(): void {
	writer.flushSync();
}

// --- Defense in depth: the console reroute -----------------------------------

const CONSOLE_METHODS = [
	"log",
	"info",
	"warn",
	"error",
	"debug",
	"trace",
	"dir",
] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

type ConsoleFn = (...args: unknown[]) => void;

let consoleGuardInstalled = false;
/** The console methods captured before the patch, for an exact restore. */
const originalConsoleMethods = new Map<ConsoleMethod, ConsoleFn>();
/** The replacements this module installed, so uninstall never clobbers a later patch. */
const installedConsoleMethods = new Map<ConsoleMethod, ConsoleFn>();

/**
 * The async capture window (#1434).
 *
 * The guard must catch pi-lens's own writes without swallowing the host's. pi's
 * one-shot CLI commands print through `console.log`, so a permanent global
 * reroute makes `pi list` print nothing in any project whose cwd loads the
 * extension first. The store answers "is pi-lens executing right now?" and
 * `AsyncLocalStorage` carries that answer into every promise, timer and
 * callback created inside the window — so an async handler still captures after
 * an `await`, while host code outside the window keeps its real sink.
 *
 * Built LAZILY (S1b, #1434 review): an active `AsyncLocalStorage` enables an
 * async_hooks init hook for every promise in the process on Node 22 — the same
 * hazard `tree-sitter-client.ts`'s `parseCacheMeasurement.disable()` comment
 * documents — so constructing one at module scope taxes every `await` in the
 * host even when the kill switch (`PI_LENS_CONSOLE_GUARD=0`) or test mode means
 * the guard never installs and nothing ever reads the store. Construction is
 * deferred to the first `runInConsoleCaptureWindow` call, and only happens once
 * `installConsoleGuard()` has actually installed (never under the kill switch
 * or test mode, since `consoleGuardInstalled` stays false in both).
 */
let consoleCaptureStorage: AsyncLocalStorage<true> | undefined;

function getConsoleCaptureStorage(): AsyncLocalStorage<true> | undefined {
	if (!consoleGuardInstalled) return undefined;
	if (consoleCaptureStorage === undefined) {
		consoleCaptureStorage = new AsyncLocalStorage<true>();
	}
	return consoleCaptureStorage;
}

/**
 * Module evaluation is the one window `AsyncLocalStorage` cannot wrap: the
 * module graph is evaluated by the loader, not by a pi-lens call. It is
 * synchronous, so a plain flag is enough (#1333's original concern — a
 * transitively loaded dependency writing during its own init).
 */
let moduleLoadWindowOpen = false;

/**
 * True while pi-lens owns execution, so console writes belong in the log.
 *
 * `consoleCaptureStorage` may not have been constructed yet (S1b) — that state
 * means "no window was ever opened through `runInConsoleCaptureWindow`", i.e.
 * the same as an empty store, so it reads as "no window" rather than throwing.
 */
export function isConsoleCaptureActive(): boolean {
	return moduleLoadWindowOpen || consoleCaptureStorage?.getStore() === true;
}

/**
 * Open the module-evaluation window. Called by `clients/console-guard-install.ts`
 * before any other pi-lens module evaluates.
 *
 * The window closes explicitly at the end of `index.ts`. The backstop below
 * closes it anyway if that never runs (an import throws, or the entry changes
 * shape), because a leaked window would capture the host's output — the very
 * bug this design fixes. Module evaluation is synchronous, so the end of the
 * current macrotask is always past it. The timer is unref'd, so it can never
 * hold a one-shot CLI process open (defect shape 4).
 */
export function openModuleLoadConsoleWindow(): void {
	if (moduleLoadWindowOpen) return;
	moduleLoadWindowOpen = true;
	const backstop = setImmediate(() => {
		moduleLoadWindowOpen = false;
	});
	backstop.unref?.();
}

/** Close the module-evaluation window. Idempotent. */
export function closeModuleLoadConsoleWindow(): void {
	moduleLoadWindowOpen = false;
}

/**
 * Run `fn` inside a capture window. Console writes from `fn`, and from anything
 * `fn` schedules, go to the extension log instead of the terminal.
 *
 * When the guard was never installed (kill switch or test mode), there is
 * nothing for a window to gate — `installConsoleGuard`'s own dispatcher is the
 * only reader of `isConsoleCaptureActive()`, and it short-circuits before that
 * call in both cases. Skip constructing the `AsyncLocalStorage` (S1b) and run
 * `fn` directly.
 */
export function runInConsoleCaptureWindow<T>(fn: () => T): T {
	const storage = getConsoleCaptureStorage();
	if (!storage) return fn();
	return storage.run(true, fn);
}

function inCaptureWindow<T extends ConsoleFn | ((...args: never[]) => unknown)>(
	fn: T,
): T {
	// SAFETY: the wrapper forwards `this` and every argument to `fn` unchanged
	// and returns its result unchanged, so it is call-compatible with `T` at
	// runtime. TypeScript cannot prove that for a generic `T` it did not
	// construct, because a variadic `(...args: unknown[]) => unknown` is not
	// assignable to an arbitrary function type. The invariant is the
	// pass-through itself: change the body to alter arguments or the return
	// value and this cast stops being true.
	return function (this: unknown, ...args: unknown[]): ReturnType<T> {
		return runInConsoleCaptureWindow(() =>
			(fn as (...a: unknown[]) => unknown).apply(this, args),
		) as ReturnType<T>;
	} as unknown as T;
}

/**
 * True for every host API member that can hand pi-lens's own functions back to
 * the host to be called later: `on(event, handler)` and any `register*`
 * method (`registerTool`, `registerCommand`, `registerMessageRenderer`,
 * `registerShortcut`, `registerFlag`, `registerMarkdownTransformer`,
 * `registerEntryRenderer`, `registerProvider`, and any the host adds later).
 *
 * This is a DENY-LIST, not an allow-list (#1434 S1a review): every member
 * matching this predicate gets its function arguments wrapped, with no
 * per-method exemption. The earlier allow-list form (only `on` and
 * `registerTool`) let the 9 `registerCommand` call sites and
 * `registerMessageRenderer` bypass the window, regressing #1333 for those
 * paths — a host callback fired for one of them would still write straight to
 * the terminal.
 */
function isCaptureSeam(prop: PropertyKey): boolean {
	return (
		prop === "on" || (typeof prop === "string" && prop.startsWith("register"))
	);
}

/**
 * Wrap every function value found in `value`, in place. Handles the two
 * shapes a `register*`/`on` call takes today: a function passed directly
 * (`on(event, handler)`, `registerMessageRenderer(type, fn)`), and a
 * function ONE level inside a plain options/definition object
 * (`options.handler`, `tool.execute`).
 *
 * Deliberately NOT recursive past that one level (#1434 perf review): a tool
 * definition's `parameters`/`schema` is a large, deeply nested TypeBox object
 * that holds no functions, but walking its full tree on every `registerTool`
 * call — across every tool, on every extension activation, across the many
 * test files that re-activate the extension per case — measurably slowed
 * activation (a wiring test tripped its 5s budget under transform load; see
 * the commit body for the measured before/after). Checking only the
 * argument's own top-level keys is O(keys), independent of how deep an
 * unrelated nested value's own structure goes, and covers every shape
 * PI-LENS actually registers (`options.handler`, `tool.execute` — never two
 * levels deep). It does NOT cover every shape the host's `ExtensionAPI` type
 * permits: `registerProvider`'s `config.oauth.*` callbacks sit two levels
 * deep and `config.models[]` sits behind a skipped array. pi-lens never
 * calls `registerProvider`; extend the descent if that changes (same known-
 * gap convention as the `pi.events` note in AGENTS.md).
 *
 * Mutates the object in place rather than copying — a spread copy would drop
 * non-enumerable or prototype-carried members of a definition object (defect
 * shape 5), and these definitions are pi-lens's own, built just above the
 * register call.
 */
function wrapFunctionsInPlace<T>(value: T): T {
	if (typeof value === "function") {
		return inCaptureWindow(value as ConsoleFn) as T;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const obj = value as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		const propValue = obj[key];
		if (typeof propValue === "function") {
			assignWrapped(obj, key, propValue as ConsoleFn);
		}
	}
	return value;
}

/**
 * Assign a wrapped function back onto `obj[key]`, degrading instead of
 * throwing or dropping the registration when the property resists (S2b).
 * ESM is always strict mode, so assigning into a non-writable data property
 * throws a `TypeError`; `Object.defineProperty` is tried next (it can
 * redefine a configurable-but-non-writable property); if both fail the
 * property is frozen solid, so the ORIGINAL unwrapped function is left in
 * place — the registration still succeeds, just without the console-capture
 * net for that one callback, which is strictly better than the tool/command
 * never registering at all.
 */
function assignWrapped(
	obj: Record<string, unknown>,
	key: string,
	fn: ConsoleFn,
): void {
	const wrapped = inCaptureWindow(fn);
	try {
		obj[key] = wrapped;
		return;
	} catch {
		// Non-writable data property — fall through to defineProperty.
	}
	try {
		Object.defineProperty(obj, key, {
			value: wrapped,
			writable: true,
			configurable: true,
			enumerable: true,
		});
	} catch {
		// Frozen solid: leave the original unwrapped function in place rather
		// than throwing (which would abort the whole register call) or silently
		// dropping it.
	}
}

/**
 * Wrap the host extension API so every pi-lens entry point runs in a capture
 * window.
 *
 * pi calls our event handlers and tool bodies from its own async context, so a
 * window opened during registration does not reach them. Wrapping every
 * `register*`/`on` seam (see `isCaptureSeam`) covers every current and future
 * handler from one place, instead of a hand-maintained list of call sites.
 * Everything else forwards untouched, except it is bound to `target` (S3a) so
 * a destructured reference (`const { getFlag } = pi`) keeps working, and
 * wrapper functions are memoized per-proxy in `wrapperCache` (S3b) so
 * `proxy.on === proxy.on` — code that compares handler identity, or a test
 * asserting a mock was called with a specific function reference across two
 * reads of the same property, sees a stable value.
 */
export function withConsoleCaptureWindows<T extends object>(api: T): T {
	const wrapperCache = new Map<PropertyKey, unknown>();
	const proxy: T = new Proxy(api, {
		get(target, prop) {
			// A non-configurable, non-writable OWN data property is a proxy
			// invariant: the get trap MUST return the exact value the target
			// holds, or the engine throws a TypeError on read. Degrade to the raw
			// value instead of tripping that invariant (S2a) — a frozen host API
			// loses the capture window for that member, but keeps working.
			const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
			if (
				descriptor &&
				descriptor.writable === false &&
				descriptor.configurable === false
			) {
				return descriptor.value;
			}
			const cached = wrapperCache.get(prop);
			if (cached !== undefined) return cached;
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			const method = value as (...args: unknown[]) => unknown;
			// A host that returns `this` for chaining would hand back the raw API,
			// so a chained `on(...).on(...)` would register an unwrapped handler.
			// Keep the proxy on the chain.
			const keepProxy = <TResult>(result: TResult): TResult | T =>
				Object.is(result, target) ? proxy : result;
			// Pass-through members are cached too (S3a/S3b: `proxy.getFlag ===
			// proxy.getFlag`), but the cached wrapper re-reads `target[prop]` on
			// EVERY call rather than closing over `method` -- a plain
			// `method.bind(target)` pins the function reference captured at first
			// access, so a host (or a test simulating one) that reassigns its own
			// method after registration would silently keep calling the stale one.
			// Re-reading keeps the cached wrapper's identity stable while staying
			// live to whatever `target[prop]` currently is.
			const wrapper = isCaptureSeam(prop)
				? (...args: unknown[]) => {
						const wrapped = args.map((arg) => wrapFunctionsInPlace(arg));
						return keepProxy(method.apply(target, wrapped));
					}
				: (...args: unknown[]) => {
						const current = Reflect.get(target, prop, target) as (
							...a: unknown[]
						) => unknown;
						return current.apply(target, args);
					};
			wrapperCache.set(prop, wrapper);
			return wrapper;
		},
	});
	return proxy;
}

function formatConsoleArgs(args: unknown[]): string {
	return args
		.map((arg) => {
			if (typeof arg === "string") return arg;
			if (arg instanceof Error) return arg.stack ?? arg.message;
			try {
				return JSON.stringify(arg) ?? String(arg);
			} catch {
				return String(arg);
			}
		})
		.join(" ");
}

/**
 * Patch every console method on the extension entry path so a transitively
 * loaded dependency cannot write raw bytes into pi's frame — the pi-side
 * mirror of `mcp/server.ts`'s `console.log = console.error` guard, which
 * protects the JSON-RPC stdout channel for the same structural reason.
 *
 * The patch is a DISPATCHER, not a permanent reroute (#1434). It sends a write
 * to the extension log only while pi-lens owns execution; every other write
 * goes to the original console method. pi's own one-shot CLI commands print
 * through `console.log`, so an unconditional reroute silenced them: `pi list`
 * exited 0 with no output in any project whose cwd loaded the extension first.
 *
 * This is a NET, not the fix: pi-lens's own sites are migrated to real sinks
 * with real schemas. Idempotent, and inert under test mode (vitest owns the
 * console) and under `PI_LENS_CONSOLE_GUARD=0`.
 *
 * Returns true when the patch was applied by this call.
 */
export function installConsoleGuard(): boolean {
	if (consoleGuardInstalled) return false;
	if (isTestMode()) return false;
	if (process.env.PI_LENS_CONSOLE_GUARD === "0") return false;
	consoleGuardInstalled = true;
	// SAFETY: re-views `console` as a string-keyed record so the loop below can
	// read and replace methods by name. `ConsoleMethod` is the union of keys
	// that exist on `Console`, and each read is guarded by `typeof original ===
	// "function"` before use, so a host whose console lacks a method is skipped
	// rather than patched with undefined.
	const target = console as unknown as Record<ConsoleMethod, unknown>;
	for (const method of CONSOLE_METHODS) {
		const original = target[method];
		if (typeof original !== "function") continue;
		const originalFn = original as ConsoleFn;
		originalConsoleMethods.set(method, originalFn);
		const replacement: ConsoleFn = (...args: unknown[]): void => {
			if (!isConsoleCaptureActive()) {
				originalFn.apply(console, args);
				return;
			}
			logExtension({
				subsystem: "console",
				level:
					method === "warn" ? "warn" : method === "error" ? "error" : "debug",
				message: formatConsoleArgs(args),
				metadata: { method },
			});
		};
		installedConsoleMethods.set(method, replacement);
		target[method] = replacement;
	}
	return true;
}

/**
 * Restore the exact console methods captured at install time.
 *
 * A method someone else patched after us is left alone — restoring it would
 * clobber their replacement. Returns true when this call uninstalled.
 */
export function uninstallConsoleGuard(): boolean {
	if (!consoleGuardInstalled) return false;
	consoleGuardInstalled = false;
	// SAFETY: same re-view as `installConsoleGuard`. Only keys this module
	// recorded in `originalConsoleMethods` at install time are written back,
	// and only when the current value is still the replacement this module
	// installed, so a method someone else patched afterwards is left alone.
	const target = console as unknown as Record<ConsoleMethod, unknown>;
	for (const [method, original] of originalConsoleMethods) {
		if (target[method] === installedConsoleMethods.get(method)) {
			target[method] = original;
		}
	}
	originalConsoleMethods.clear();
	installedConsoleMethods.clear();
	return true;
}

/** Test-only: uninstall the guard and close every open capture window. */
export function _resetConsoleGuardForTests(): void {
	uninstallConsoleGuard();
	consoleGuardInstalled = false;
	consoleCaptureStorage = undefined;
	moduleLoadWindowOpen = false;
}

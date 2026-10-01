/**
 * The #2506 probe-home redirect, whole: the decision, the per-process memo it
 * is cached in, and the degradation event that decision produced.
 *
 * WHAT IT DECIDES. An ad-hoc probe against the BUILT `clients/*.js` — a bare
 * `node -e`, a throwaway `.mjs`, a harness script — has no `PI_LENS_HOME` pin,
 * so every logger and ledger it touches used to write into the maintainer's
 * REAL `~/.pi-lens`. Confirmed live on 2026-09-02: two review probes left 42
 * rows of `/p/.pi-lens.json` fixture garbage in real telemetry. When
 * `PI_LENS_HOME` is unset and the process looks like a probe — `PILENS_PROBE=1`,
 * a `cwd` inside a specific agent worktree, or a `cwd` under `os.tmpdir()` —
 * `resolveProbeHomeDir()` answers with a per-probe directory instead.
 *
 * WHY IT ALL LIVES HERE and not beside its `getGlobalPiLensDir()` sibling in
 * `file-utils.ts`, where round 2 of #2516 left it. `file-utils.ts` sits on an
 * import cycle (it still does, via `safe-spawn.js` -> `resource-sampler.js` ->
 * `instance-reaper.js` -> `file-utils.js`; the shorter route through
 * `degradation-ledger.js` -> `extension-log.js` was this move's doing —
 * `extension-log.ts` imported `file-utils.ts` for THIS function and nothing
 * else, so the edge went with it, and the known-violations baseline dropped
 * from 33 pinned cycles to 12 with none added). Fifteen log-family modules
 * call `getGlobalPiLensLogDir()` at their OWN module
 * top level. Under vitest's vite-SSR transform each import becomes a
 * `__vite_ssr_import_N__` variable assigned in source order, so one of those
 * top-level calls re-enters `file-utils.ts` while its body is only PARTWAY
 * through those assignments — and a resolver sitting there then dereferences a
 * binding that has not been assigned yet, throwing `ReferenceError: Cannot
 * access '__vite_ssr_import_N__' before initialization`. Measured live: the
 * re-entry arrives through `file-utils.ts`'s FIFTH import,
 * `spawn-timeout-cooldown.js`, so every binding declared from the sixth import
 * onward is unsafe on that path — which is most of the file.
 *
 * Round 2 of #2516 papered over that with an `isTestMode()` early return placed
 * ahead of the first unsafe dereference. That was load-order luck, not a
 * design: moving `file-utils.ts`'s own `isTestMode` import from fifth to last
 * makes the GUARD LINE ITSELF throw the same error. It also DEFEATED the
 * redirect for every process that has `VITEST` set but no `PI_LENS_HOME` pin —
 * vitest's own globalSetup/child processes — sending their logs to the real
 * home: the exact hermeticity hole the redirect exists to close.
 *
 * THIS module is off that cycle. It imports only node builtins and
 * `path-utils.js`, itself a leaf (node builtins plus the vendored, zero-import
 * `deps/minimatch.js`). A module off every cycle is fully evaluated before any
 * importer's body runs — in plain ESM and under the vite-SSR transform alike —
 * so none of its own bindings can ever be observed uninitialized, wherever an
 * importer chooses to place the import. That is what makes the guard
 * unnecessary rather than merely well-placed, and it is why module-scope
 * `const`s (including the `Symbol.for` below) are ordinary here where they were
 * a hazard in `file-utils.ts`.
 *
 * `tests/config/global-dir-probe-redirect.test.ts` pins the behaviour through
 * real spawned `node` children, including the VITEST-set-but-unpinned case.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isUnderDir, normalizeFilePath } from "./path-utils.js";

/**
 * The memo lives in a process-wide `globalThis` slot rather than a plain
 * module-scope `let` so that a bundled `dist/index.js` and the loose
 * `clients/*.js` loaded into the same process — the shape #335 ships — share
 * ONE decision instead of memoizing two. A `Symbol.for` key is interned by
 * string, so both copies of this module resolve to the same slot.
 */
const RESOLUTION_SLOT = Symbol.for("pi-lens.probe-home-state.resolution");

export interface ProbeHomeRedirectEvent {
	probeHome: string;
}

export interface ProbeHomeResolution {
	/**
	 * The redirected probe home, or `undefined` when this process resolved to
	 * the real home. Storing the negative answer too is what makes this a memo:
	 * without it a non-redirected process would recompute the whole decision on
	 * every log write.
	 */
	probeHome: string | undefined;
	/** Set only when `probeHome` is set — the row the ledger folds at read time. */
	event: ProbeHomeRedirectEvent | undefined;
}

type GlobalWithProbeHomeState = typeof globalThis & {
	[key: symbol]: ProbeHomeResolution | undefined;
};

/** The memoized resolution for this process, or `undefined` before first use. */
export function getProbeHomeResolution(): ProbeHomeResolution | undefined {
	return (globalThis as GlobalWithProbeHomeState)[RESOLUTION_SLOT];
}

/**
 * The degradation row for a redirect that actually happened, or `undefined`
 * when this process was not redirected (or has not resolved yet).
 * `degradation-ledger.ts`'s `getDegradationSummary()` is the only caller — it
 * folds this at READ time rather than having the resolver push a row, because a
 * direct import between `file-utils.ts` and `degradation-ledger.ts` in EITHER
 * direction (a dynamic `import()` included) adds unpinned `no-client-cycles`
 * violations to the cycle named in this module's doc comment.
 */
export function getProbeHomeRedirectEvent():
	| ProbeHomeRedirectEvent
	| undefined {
	return getProbeHomeResolution()?.event;
}

/**
 * Where pi-lens writes its LOGS, ledger rows and debug dumps: `~/.pi-lens/` by
 * default, exactly like `getGlobalPiLensDir()` in `file-utils.ts` — but
 * redirected to a per-probe directory when this process looks like an ad-hoc
 * probe rather than a real pi session (#2506).
 *
 * Every log-family writer routes here: `latency.log`, `extension.log`,
 * `sessionstart.log`, `cascade.log`, `read-guard.log`, `tree-sitter.log`,
 * `word-index.log`, `bus-events.log`, `dispositions.log`, `dead-code.log`,
 * `ast-grep-tools.log`, `actionable-warnings.log`, `review-graph.log`, the
 * `logs/*.jsonl` diagnostic dir, the debug handle/heap dumps,
 * `log-cleanup.ts`'s sweep over all of the above, and `smells-rollup.ts`'s
 * read-side tail of `latency.log`/`bus-events.log` (a reader, but it must
 * follow the same root or it tails a file nobody is writing).
 *
 * WHY IT LIVES IN THIS MODULE and not next to its `getGlobalPiLensDir()`
 * sibling in `file-utils.ts` — see this file's header. Fifteen of the writers
 * listed above call this function at their OWN module top level, and
 * `file-utils.ts` is on an import cycle, so resolving from there could observe
 * `file-utils.ts` mid-initialization. Resolving from a module off every cycle
 * cannot.
 *
 * `PI_LENS_HOME` wins over any redirect, which is how
 * `tests/support/vitest-setup.ts` keeps test workers hermetic. Note the
 * redirect still applies under vitest for processes that setup does not cover
 * (globalSetup, and children spawned without the pin): #2516 round 2's
 * `isTestMode()` guard sent exactly those to the developer's real home.
 *
 * Deliberately does NOT write a line to the terminal when it fires. #1333 gives
 * pi sole ownership of the TTY, and
 * `tests/clients/extension-terminal-silence.test.ts` enforces that nothing
 * under `clients/` calls `process.std*.write` or `console.*` (round 2 of
 * #2506 shipped a `process.stderr.write` here and was red in CI for exactly
 * that). Nor can it log through `extension-log.ts`'s
 * `createSubsystemLogger`: that module imports THIS one, so an import back
 * the other way would close a new, unpinned `no-client-cycles` cycle — and
 * `extension.log` is itself redirected by this very function, so the line
 * would land in the probe home nobody reads. The durable signal is the
 * `global-dir-probe-redirect` degradation row instead, folded into
 * `getDegradationSummary()` at read time via
 * `getProbeHomeRedirectEvent()` above.
 */
export function getGlobalPiLensLogDir(): string {
	const override = process.env.PI_LENS_HOME?.trim();
	if (override) return path.resolve(override);
	return resolveProbeHomeDir() ?? path.join(os.homedir(), ".pi-lens");
}

/**
 * True when a vitest process is about to DESTROY a log under the REAL
 * machine-global home, `<os.homedir()>/.pi-lens` (#3721). The one rule every
 * truncating helper asks: `createNdjsonLogger`'s `truncate()` (behind
 * `clearLatencyLog`) refuses when this holds.
 *
 * The recurrence: a test that calls `clearLatencyLog()` in a checkout whose
 * home pin is missing resolves the real path at module load and cut 76 minutes
 * of rows out of a maintainer's real `latency.log` (2026-09-30). Production
 * never truncates a log (no `clients/` caller of `clearLatencyLog` exists), so
 * a test process is the only caller this can refuse.
 *
 * Deliberately `process.env.VITEST`, not `isTestMode()`: the #3521 witness runs
 * with `PI_LENS_TEST_MODE=0`, which turns `isTestMode()` off in exactly the
 * process that does the damage. `os.homedir()` is read per call (a hermetic
 * test points HOME at a fixture, and a hot-path cost does not exist: truncation
 * is rare), and both sides go through `realpath` so a linked home cannot spell
 * the same directory differently. The parent directory is resolved rather than
 * the file, so a log that does not exist yet still resolves.
 */
export function isTestProcessTargetingRealHome(file: string): boolean {
	if (!process.env.VITEST) return false;
	return isUnderRealDir(
		path.dirname(path.resolve(file)),
		path.join(os.homedir(), ".pi-lens"),
	);
}

/**
 * Resolve the probe-home redirect at most ONCE per process, caching both the
 * "yes, here" and the "no redirect" answers (#2506 round 3, F5). Round 2 read
 * `process.cwd()` live on every call, which gave a single process up to three
 * different global dirs as it chdir'd, and re-ran the whole decision on the hot
 * logging path.
 *
 * `undefined` means "no redirect applies"; `getGlobalPiLensLogDir()` above
 * falls back to the real home. This function never consults `PI_LENS_HOME` —
 * that pin is handled by its caller, ahead of this decision, so a pinned
 * process never memoizes a probe answer it would then keep after the pin
 * changed.
 */
function resolveProbeHomeDir(): string | undefined {
	const slot = globalThis as GlobalWithProbeHomeState;
	const cached = slot[RESOLUTION_SLOT];
	if (cached) return cached.probeHome;
	const cwd = process.cwd();
	const probeHome = computeProbeHomeDir(cwd);
	slot[RESOLUTION_SLOT] = {
		probeHome,
		event: probeHome ? { probeHome } : undefined,
	};
	return probeHome;
}

/**
 * Clears the memoized decision AND the event it produced, so the next
 * `getGlobalPiLensLogDir()` call re-resolves from scratch. Exercised by
 * `tests/config/global-dir-probe-redirect.test.ts`, which drives the resolver
 * repeatedly under different in-process conditions; without it the first call
 * in a worker would pin the answer for every later case in the same file.
 */
export function _resetProbeHomeRedirectStateForTests(): void {
	(globalThis as GlobalWithProbeHomeState)[RESOLUTION_SLOT] = undefined;
}

/** The redirect decision itself. */
function computeProbeHomeDir(cwd: string): string | undefined {
	// The explicit force wins first: it is how a probe run from an ordinary
	// project checkout opts in, and it must work even under a harness that has
	// set a test-mode marker but no PI_LENS_HOME.
	if (process.env.PILENS_PROBE === "1") {
		return path.join(cwd, ".pi-lens-probe-home");
	}
	const worktreeRoot = findAgentWorktreeRoot(cwd);
	if (worktreeRoot) return path.join(worktreeRoot, ".pi-lens-probe-home");
	if (isUnderRealDir(cwd, os.tmpdir())) {
		return path.join(cwd, ".pi-lens-probe-home");
	}
	return undefined;
}

/**
 * The directory of the SPECIFIC agent worktree containing `cwd`, or
 * `undefined` when `cwd` is not inside one.
 *
 * Requires at least one path segment AFTER `worktrees/`, and anchors the
 * probe home at that segment rather than at the live `cwd` (#2506 round 3,
 * F5). Round 2's trailing `(\/|$)` alternative also matched a `cwd` of
 * `.claude/worktrees` ITSELF, which would have put the probe home in the
 * SHARED worktrees parent — every concurrent agent on the box writing into
 * one directory, the cross-agent collision this redirect is supposed to
 * prevent. Anchoring at the worktree also means a probe run from a
 * subdirectory (`<worktree>/clients`) and one run from the worktree root
 * agree on a single probe home instead of scattering one per cwd.
 */
function findAgentWorktreeRoot(cwd: string): string | undefined {
	const normalized = normalizeFilePath(path.resolve(cwd));
	const match = /(?:^|\/)\.claude\/worktrees\/[^/]+(?:\/|$)/.exec(normalized);
	if (!match) return undefined;
	return normalized.slice(0, match.index + match[0].length).replace(/\/$/, "");
}

/**
 * `isUnderDir`, but with both sides resolved through `realpath` first
 * (#2506 round 3, F7).
 *
 * On macOS `os.tmpdir()` reports `/var/folders/...` while a `cwd` created
 * under it resolves to `/private/var/folders/...` (`/var` is a symlink to
 * `/private/var`), so the two NEVER prefix-match unresolved and the tmpdir
 * branch would be dead on every Mac. Windows has the same shape with 8.3
 * short names and substituted drives. Both sides go through the same
 * function, so `realpathSync.native`'s canonical Windows casing applies
 * consistently; the result is used only for this containment test, never to
 * build the returned path, so no casing change can leak into a log path.
 * Best-effort by design: a path that does not exist yet (or an EPERM) falls
 * back to its literal form rather than throwing on the logging hot path.
 */
function isUnderRealDir(child: string, parent: string): boolean {
	return isUnderDir(toRealPath(child), toRealPath(parent));
}

function toRealPath(target: string): string {
	try {
		return fs.realpathSync.native(target);
	} catch {
		return target;
	}
}

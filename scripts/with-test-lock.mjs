#!/usr/bin/env node
/**
 * scripts/with-test-lock.mjs (#1101)
 *
 * Serializes full-suite test runs across a machine: multiple concurrent
 * `npm test` invocations (several agents on parallel worktrees, plus an
 * interactive run) spawn independently-sized fork pools
 * (half the cores up to 8, 4GB/fork — vitest.config.ts) that assume a
 * dedicated machine. Run more than one at once and they fight over CPU/RAM,
 * producing vitest worker-crash cascades and timing-budget flakes that look
 * like real bugs but aren't (see AGENTS.md's testing-discipline section).
 *
 * This wrapper acquires ONE lock file before running the wrapped command,
 * and releases it after — so concurrent full-suite runs queue instead of
 * stomping on each other.
 *
 * Lock scope: MACHINE-WIDE, not per-repo. Worktrees of the same repo (or
 * entirely different repos) still contend for the same physical CPU/RAM, so
 * this deliberately does NOT key the lock to the repo root path the way
 * getProjectDataDir does for project caches — see scripts/lib/suite-lock.mjs.
 * Default location: `~/.pi-lens/test-suite.lock` (or
 * `$PI_LENS_HOME/test-suite.lock`).
 *
 * Pattern: atomic create (`fs.open(path, "wx")`) + PID-liveness staleness,
 * mirroring clients/installer/index.ts's `.install.lock` — with one
 * deliberate divergence (no age-expiry for a lock whose PID still reads as
 * alive; see scripts/lib/suite-lock.mjs's header for why). Waiting prints a
 * heartbeat line at least every 15s so a queued run never looks hung.
 *
 * SHARED SLOTS (#2435). `--shared[=N]` takes one of N concurrent slots
 * instead of the exclusive lock, for TARGETED runs (`npm run test:targeted`).
 * Targeted `vitest run <files>` batches used to bypass this wrapper entirely
 * — cheap on their own, but 4-6 agents running them at once saturate the box
 * and manufacture the same timeout/spawn-budget flakes the exclusive lock
 * exists to prevent. The exclusive mode now waits for all slots to drain
 * before running, and a shared acquisition waits while the exclusive lock is
 * held, so full runs still get the machine to themselves.
 *
 * Usage:
 *   node scripts/with-test-lock.mjs -- <command> [args...]
 *   node scripts/with-test-lock.mjs -- vitest run
 *   node scripts/with-test-lock.mjs --shared -- vitest run tests/a.test.ts
 *   node scripts/with-test-lock.mjs --shared=3 -- vitest run tests/a.test.ts
 *
 * Env:
 *   PI_LENS_TEST_NO_LOCK=1          Skip locking entirely (CI sets this —
 *                                   runners are isolated, one job per box).
 *   PI_LENS_TEST_LOCK_TIMEOUT_MS    Give up waiting after this long
 *                                   (default: wait forever).
 *   PI_LENS_TEST_SHARED_SLOTS       Concurrent shared slots (default 2).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	acquireSharedSlot,
	acquireTestLock,
	getLockPath,
	resolveSharedSlots,
} from "./lib/suite-lock.mjs";

const require = createRequire(import.meta.url);

function parseCommandArgs(argv) {
	const sepIndex = argv.indexOf("--");
	const rest = sepIndex === -1 ? argv : argv.slice(sepIndex + 1);
	return rest;
}

/**
 * Split this wrapper's OWN flags (before `--`) from the command to run
 * (after `--`). When there is no `--` at all, everything is the command —
 * preserving the pre-#2435 contract exactly, so no existing caller changes
 * meaning.
 *
 * @param {string[]} argv
 * @returns {{ shared: boolean, slots: number|null, commandArgs: string[], errors: string[] }}
 */
export function parseWrapperArgs(argv) {
	const sepIndex = argv.indexOf("--");
	const flags = sepIndex === -1 ? [] : argv.slice(0, sepIndex);
	const commandArgs = parseCommandArgs(argv);
	const result = { shared: false, slots: null, commandArgs, errors: [] };
	for (const flag of flags) {
		if (flag === "--shared") {
			result.shared = true;
		} else if (flag.startsWith("--shared=")) {
			result.shared = true;
			const raw = flag.slice("--shared=".length);
			// resolveSharedSlots clamps garbage to the default; reject it here
			// instead so `--shared=abc` is a loud usage error rather than a
			// silent 2.
			if (!/^\d+$/.test(raw) || Number(raw) < 1) {
				result.errors.push(`invalid --shared slot count: ${raw}`);
			} else {
				result.slots = resolveSharedSlots(raw);
			}
		} else {
			result.errors.push(`unknown option: ${flag}`);
		}
	}
	return result;
}

/**
 * Tokens that look like a test PATH or glob rather than a flag, a flag's
 * value, or a subcommand.
 */
const PATH_SHAPED = /[/\\*]|\.[cm]?[jt]sx?$/;

/**
 * True when a `--shared` invocation names no test files — i.e. it is a FULL
 * suite run wearing a shared slot.
 *
 * PR #2438 review S11: `npm run test:targeted` with no arguments expands to
 * `with-test-lock.mjs --shared -- vitest run`, which collects the entire
 * suite while holding one of N *concurrent* slots. Several of those can run
 * at once — precisely the contention #1101's exclusive lock exists to
 * prevent, reached through the mechanism added to relieve it. A shared slot
 * is for a batch of named files; a full run takes the exclusive lock.
 *
 * A name filter (`-t <pattern>`) still collects the whole suite, so it does
 * NOT satisfy the requirement: only a path- or glob-shaped positional does.
 * The check is deliberately conservative — it blocks, so it must be wrong
 * only in the direction of asking for an explicit path.
 *
 * @param {string[]} commandArgs Everything after `--` (argv[0] is the binary).
 * @returns {boolean}
 */
export function sharedModeRequiresPaths(commandArgs) {
	const args = (commandArgs ?? []).slice(1);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (typeof arg !== "string" || arg.startsWith("-")) continue;
		// A bare value directly after a bare flag (`-t name`, `--project x`) is
		// that flag's argument, not a path.
		const previous = args[i - 1];
		if (
			typeof previous === "string" &&
			previous.startsWith("-") &&
			!previous.includes("=")
		) {
			continue;
		}
		if (PATH_SHAPED.test(arg)) return false;
	}
	return true;
}

// Resolve vitest's own JS entry point (its package.json `bin` field) so it
// can be launched via `node <entry> <args>` — a plain argv array, `shell:
// false`, no cmd.exe/sh in the loop at all, identical on every OS. This is
// the ONLY caller-path this wrapper actually needs to support well: every
// real invocation (npm test / test:unit / test:integration) is
// `-- vitest run [...]`. Returns null if vitest can't be resolved this way
// (e.g. some future non-vitest caller), in which case runCommand falls back
// to the generic (best-effort, NOT injection-safe — see its own comment)
// shell path below.
export function resolveVitestEntry() {
	try {
		const pkgJsonPath = require.resolve("vitest/package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
		const binField = pkg.bin;
		const binRel = typeof binField === "string" ? binField : binField?.vitest;
		if (!binRel) return null;
		return path.join(path.dirname(pkgJsonPath), binRel);
	} catch {
		return null;
	}
}

// Fallback ONLY: generic passthrough for a command that isn't `vitest`
// (there is no such caller today — package.json only ever wraps `vitest
// run [...]`). Windows CreateProcess cannot exec .cmd/.bat files directly,
// which is why win32 needs `shell: true` for anything that isn't resolved
// to a plain .js/.exe the way resolveVitestEntry() does above. `shell:
// true` + an args ARRAY does NOT quote/escape for you on Windows (Node
// just space-joins argv into the command line — confirmed experimentally:
// an arg containing a space silently split into two argv entries), so this
// builds one CRT-quoted command-line string instead of an args array.
//
// This quoting is NOT shell-injection-safe: it defends against space/quote
// splitting for CRT-style argv parsing, but cmd.exe's OWN metacharacters
// (`&`, `|`, `%VAR%` expansion) still apply INSIDE a quoted argument on a
// cmd.exe command line — a quote-containing argument can flip cmd's quote
// parity and let a later `&`/`|` execute as a separate command, and
// `%VAR%` still expands regardless of quoting. `clients/safe-spawn.ts`
// covers that much larger surface for installer subprocess mutations,
// which this deliberately does not reach for: this fallback path only runs
// for a hypothetical non-vitest caller, and even then commandArgs comes
// from this process's own argv (a package.json script definition), never
// from untrusted external/user input.
export function quoteForWindowsCmd(arg) {
	if (arg === "") return '""';
	if (!/[\s"^&|<>()%!]/.test(arg)) return arg;
	let result = "";
	let backslashes = 0;
	for (const ch of arg) {
		if (ch === "\\") {
			backslashes++;
			continue;
		}
		if (ch === '"') {
			result += "\\".repeat(backslashes * 2 + 1) + '"';
			backslashes = 0;
			continue;
		}
		result += "\\".repeat(backslashes) + ch;
		backslashes = 0;
	}
	result += "\\".repeat(backslashes * 2);
	return `"${result}"`;
}

function runCommand(commandArgs) {
	return new Promise((resolve, reject) => {
		const isWin32 = process.platform === "win32";
		const vitestEntry =
			commandArgs[0] === "vitest" ? resolveVitestEntry() : null;

		let child;
		if (vitestEntry) {
			// Bypasses shell entirely, on every OS: no cmd.exe, no quoting
			// minefield, identical behavior cross-platform.
			child = spawn(process.execPath, [vitestEntry, ...commandArgs.slice(1)], {
				stdio: "inherit",
				shell: false,
			});
		} else if (isWin32) {
			child = spawn(commandArgs.map(quoteForWindowsCmd).join(" "), {
				stdio: "inherit",
				shell: true,
			});
		} else {
			child = spawn(commandArgs[0], commandArgs.slice(1), {
				stdio: "inherit",
				shell: false,
			});
		}

		const forwardSignal = (signal) => {
			if (!child.killed) child.kill(signal);
		};
		process.once("SIGINT", forwardSignal);
		process.once("SIGTERM", forwardSignal);

		child.once("error", (error) => {
			process.removeListener("SIGINT", forwardSignal);
			process.removeListener("SIGTERM", forwardSignal);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			process.removeListener("SIGINT", forwardSignal);
			process.removeListener("SIGTERM", forwardSignal);
			if (signal) {
				const signalNumber = os.constants.signals[signal];
				resolve(typeof signalNumber === "number" ? 128 + signalNumber : 1);
			} else {
				resolve(code ?? 1);
			}
		});
	});
}

async function main() {
	const { shared, slots, commandArgs, errors } = parseWrapperArgs(
		process.argv.slice(2),
	);
	for (const error of errors) console.error(`[with-test-lock] ${error}`);
	if (errors.length > 0 || commandArgs.length === 0) {
		console.error(
			"Usage: node scripts/with-test-lock.mjs [--shared[=N]] -- <command> [args...]",
		);
		process.exitCode = 2;
		return;
	}

	if (shared && sharedModeRequiresPaths(commandArgs)) {
		console.error(
			"[with-test-lock] --shared requires at least one test path or glob. " +
				"A full-suite run must take the EXCLUSIVE lock: use `npm test`.",
		);
		process.exitCode = 2;
		return;
	}

	if (process.env.PI_LENS_TEST_NO_LOCK === "1") {
		process.exitCode = await runCommand(commandArgs);
		return;
	}

	const lockPath = getLockPath();
	const log = (message) => console.error(`[with-test-lock] ${message}`);
	const lock = shared
		? await acquireSharedSlot({ lockPath, slots: slots ?? undefined, log })
		: await acquireTestLock({ lockPath, log });

	try {
		process.exitCode = await runCommand(commandArgs);
	} finally {
		await lock.release();
	}
}

// Whether `selfUrl` (a module's `import.meta.url`) is the process entry
// point. Not a lexical compare: a silent MISMATCH is a silent-success failure
// mode (`npm test` exits 0 having run zero tests, nothing printed), and a
// lexical compare mismatches whenever `scripts/` is reached through a symlink
// (#4086). Both sides go through `realpath`, so `fs.realpathSync.native` also
// canonicalises the win32 casing and 8.3 short-name spellings the old
// lexical/basename fallback handled.
//  - argv[1] that is not a real path (`node -e`, stdin, a removed file): not
//    the entry point, so importing a script never throws (#4086 review F2).
//  - `selfUrl` that cannot be resolved: throw. Returning false would silently
//    skip the CLI, the failure mode above. The `realpath` of `selfUrl` is
//    load-bearing only under `--preserve-symlinks-main`, where the main
//    module's URL keeps its symlinked spelling.
export function isEntryPoint(
	selfUrl,
	{ argv1 = process.argv[1], realpath = fs.realpathSync.native } = {},
) {
	let invoked;
	try {
		invoked = realpath(argv1);
	} catch {
		return false;
	}
	try {
		return invoked === realpath(fileURLToPath(selfUrl));
	} catch (error) {
		throw new Error(
			`[with-test-lock] cannot resolve the entry-point path of ${selfUrl}: ${error instanceof Error ? error.message : error}`,
		);
	}
}
const isMain = isEntryPoint(import.meta.url);
if (isMain) {
	main().catch((error) => {
		console.error(`[with-test-lock] ${error.message}`);
		process.exitCode = 1;
	});
}

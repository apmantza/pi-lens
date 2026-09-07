/**
 * Shared plumbing for best-effort, fire-and-forget child-process spawns
 * (shape 4 of the recurring-defect catalog in AGENTS.md: "a timer / promise /
 * worker / child that outlives its one-shot settle"). Extracted from the
 * shared, dependency-free module so every one-shot
 * `spawn(..., { stdio: ["ignore","pipe",...] })` call site in the codebase —
 * the reaper's enumeration/kill spawns AND the resource sampler's Windows
 * CIM/powershell spawns (#1155) — uses the exact same unref+collect shape
 * instead of re-deriving it (also closes the #1155 PR's SonarCloud
 * new-code-duplication finding: two near-identical spawn→collect-stdout
 * blocks in `clients/resource-sampler.ts` collapsed to one shared helper).
 *
 * Deliberately has NO imports beyond `node:child_process` types, so both
 * `clients/instance-reaper.ts` and `clients/resource-sampler.ts` (which
 * `clients/safe-spawn.ts` itself depends on) can import this without risking
 * a circular-import chain.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

/**
 * Detach a best-effort, fire-and-forget child process from the event loop.
 *
 * A piped, `data`-listener-attached stdout/stderr/stdin stream keeps the libuv
 * loop REFERENCED even after `child.unref()` — the child handle and every
 * live stdio stream must all be unref'd, or a settled one-shot process (e.g.
 * `pi --print`) cannot exit until the child `close`s. Unref only means "do
 * not keep the process alive FOR this best-effort work": in an interactive/
 * long-lived session the loop stays referenced for other reasons, so the
 * child's `data`/`close` events still fire normally and callers still collect
 * output/usage; only a genuinely-settled one-shot is allowed to exit without
 * waiting for it. Never throws.
 */
export function unrefChildAndPipes(child: ChildProcess): void {
	try {
		child.unref();
		// Child stdio pipes are `net.Socket`s at runtime (which expose `unref`),
		// but are typed as `Readable`/`Writable` (which do not) — cast to the
		// optional-`unref` shape and guard, so an un-piped ("ignore") stream is a
		// no-op rather than a crash.
		for (const stream of [child.stdout, child.stderr, child.stdin]) {
			(stream as { unref?: () => void } | null)?.unref?.();
		}
	} catch {
		// best-effort — unref must never throw out of a fire-and-forget spawn
	}
}

/**
 * Why a spawn's stdout is what it is. `""` alone cannot tell "the query ran
 * and found nothing" from "the query never ran" — the availability invariant
 * in CLAUDE.md: an empty result must distinguish clean from errored. Callers
 * that must emit a distinguishable record use `spawnCollectStdoutResult`;
 * callers that genuinely only want best-effort text keep calling
 * (one implementation, not two).
 */
export type SpawnCollectStatus =
	| "ok"
	| "spawn-error"
	| "exit-error"
	| "timeout";

export interface SpawnCollectResult {
	/** Text collected before settle. Partial output is kept on a timeout. */
	stdout: string;
	status: SpawnCollectStatus;
	/** Present only for `spawn-error`. */
	error?: unknown;
	/** Present only for `exit-error`: the process exit code, when reported. */
	exitCode?: number | null;
	/** Present only for `exit-error`: the signal that ended the process. */
	exitSignal?: NodeJS.Signals | null;
	/** Present only for `timeout`: what happened to the child that blew it. */
	timeoutKill?: SpawnTimeoutKill;
}

export interface SpawnCollectOptions {
	/**
	 * Hard upper bound on the child's wall-clock lifetime. On expiry the child
	 * is terminated, the collected partial stdout is returned, and the status
	 * is `timeout`. Omitted or non-positive means no bound (the historical
	 * behavior). The timer is `unref`'d, so it never holds a settled one-shot
	 * process open.
	 *
	 * The bound covers the CHILD, not just the caller: the promise settles
	 * only after the termination below reports its verdict, so a caller can
	 * never walk away from a still-running child. Budget accordingly — the
	 * worst case is `timeoutMs` plus the `onTimeout` handler's own budget.
	 */
	timeoutMs?: number;
	/**
	 * How to terminate a child that blew `timeoutMs`. Given the child, it must
	 * terminate it and report whether the process is verifiably gone.
	 *
	 * Without this, the default is a bare `child.kill()`: one signal to the
	 * direct child, no verification, no escalation, and on Windows no tree
	 * kill — so a `cmd`-wrapped or signal-ignoring grandchild survives. A
	 * caller that already owns tree-kill-and-verify machinery passes it here
	 * rather than having this module grow a second copy. That matters most for
	 * the orphan reaper, whose whole job is not leaking processes: a scanner
	 * child abandoned by its own sweep is the defect the sweep exists to fix.
	 *
	 * This module deliberately has no imports beyond `node:child_process`
	 * (see the file header), so the machinery is INJECTED, never imported.
	 */
	onTimeout?: (child: ChildProcess) => Promise<SpawnTimeoutKill>;
}

/**
 * Fate of a child that blew its timeout. `gone` is verified dead; `alive`
 * means termination was attempted and the process is still there; `invalid`
 * means there was no usable pid to act on; `unverified` means it was
 * signalled without any liveness check (the default handler, and the handler
 * throwing).
 */
export type SpawnTimeoutKill = "gone" | "alive" | "invalid" | "unverified";

/**
 * unref, collect, settle plumbing; the only additions are an optional hard
 * timeout and a status discriminator. Never rejects.
 */
export function spawnCollectStdoutResult(
	command: string,
	args: string[],
	options: SpawnOptions,
	collectOptions: SpawnCollectOptions = {},
): Promise<SpawnCollectResult> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const settle = (result: SpawnCollectResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};
		try {
			const child = nodeSpawn(command, args, options);
			unrefChildAndPipes(child);
			let out = "";
			child.stdout?.on("data", (chunk) => {
				out += chunk.toString();
			});
			child.once("error", (error) =>
				settle({ stdout: "", status: "spawn-error", error }),
			);
			child.once(
				"close",
				(code: number | null, signal: NodeJS.Signals | null) =>
					settle(
						code === 0 && signal === null
							? { stdout: out, status: "ok" }
							: {
									stdout: "",
									status: "exit-error",
									exitCode: code,
									exitSignal: signal,
								},
					),
			);
			const timeoutMs = collectOptions.timeoutMs;
			if (typeof timeoutMs === "number" && timeoutMs > 0) {
				timer = setTimeout(() => {
					// Settle only AFTER the child's fate is known. Killing and
					// resolving in the same tick bounds the caller and abandons the
					// child, which is the leak this timeout exists to prevent.
					void terminateTimedOutChild(child, collectOptions.onTimeout).then(
						(timeoutKill) =>
							settle({ stdout: out, status: "timeout", timeoutKill }),
					);
				}, timeoutMs);
				timer.unref();
			}
		} catch (error) {
			settle({ stdout: "", status: "spawn-error", error });
		}
	});
}

/** Run the caller's termination handler, or the bare-signal default, and
 *  never let either throw out of the timeout path. */
async function terminateTimedOutChild(
	child: ChildProcess,
	onTimeout: SpawnCollectOptions["onTimeout"],
): Promise<SpawnTimeoutKill> {
	if (onTimeout) {
		try {
			return await onTimeout(child);
		} catch {
			// A handler that threw did not verify anything.
			return "unverified";
		}
	}
	try {
		child.kill();
	} catch {
		// best-effort — the child may already be gone
	}
	return "unverified";
}

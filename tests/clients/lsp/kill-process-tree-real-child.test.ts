// flake-shape: real-process-spawn — a real, live direct child is the ONLY pid whose /proc PPid is this process, so the Linux ownership arm of `isOwnLiveChild` cannot be observed through any double; #3091 round 1 shipped a regression at exactly this site because every case that reached it stubbed the platform away.
/**
 * #2042 / PR #3091 F1 — the Linux ownership arm of `killProcessTree`, against a
 * real child.
 *
 * Round 1 gated `clients/lsp/client.ts#killPosixProcessGroup` on
 * `isOwnLiveChild(pid, site, proc)` and passed the ChildProcess handle. The
 * handle arm ("already reported exit ⇒ refuse") then fired on the
 * `processExiting` path, where `killProcessTree`'s early return at
 * `clients/lsp/client.ts:1269` is deliberately SKIPPED and an already-dead
 * direct child can reach the group kill (the code says so at
 * `clients/lsp/client.ts:1382`). That group SIGTERM is the only thing that
 * reaps surviving grandchildren at host exit (#2026), so the fix turned it off:
 * master signalled `[[-3164880,"SIGTERM"]]`, the round-1 head signalled `[]`.
 *
 * Every other case in this family stubs `process.platform`, so none of them
 * could see it. These do not stub anything: they spawn a real detached child,
 * whose `/proc/<pid>/status` really does carry `PPid: <this process>`.
 *
 * lane: ubuntu Unit tests (`describe.skipIf(process.platform !== "linux")` — the
 * ownership arm reads `/proc`, which only exists there; the Windows arm is
 * covered without a lane by the platform-stubbed case in
 * tests/clients/safe-spawn-kill-ownership.test.ts).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { killProcessTree } from "../../../clients/lsp/client.js";
import { isOwnLiveChild } from "../../../clients/safe-spawn.js";

const children: ChildProcess[] = [];

/** A real child in its OWN process group, so `-pid` is a real group id. */
function spawnDetachedSleeper(): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	});
	children.push(child);
	return child;
}

function exited(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once("exit", () => resolve());
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (children.length > 0) {
		const child = children.pop();
		if (!child?.pid) continue;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// already gone
		}
		await exited(child);
	}
});

describe.skipIf(process.platform !== "linux")(
	"killProcessTree ownership, against a real child (#2042)",
	() => {
		it("signals the process group of a live child this process really owns", async () => {
			const child = spawnDetachedSleeper();
			const pid = child.pid as number;
			// callThrough: the signal is REAL, and it is our own child — the
			// positive arm is worth nothing if the kill is mocked away.
			const killSpy = vi.spyOn(process, "kill");

			await killProcessTree(
				{ kill: () => true, unref: () => {}, exitCode: null },
				pid,
				{ fast: true },
			);

			expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
			await exited(child);
		});

		it("still group-kills at host exit when the handle already reported exit (F1)", async () => {
			// The `processExiting` path: `killProcessTree`'s exited early return
			// is skipped, and the handle can legitimately say "exited" while the
			// GROUP is still alive with grandchildren in it. Ownership must come
			// from the kernel, not from the handle.
			const child = spawnDetachedSleeper();
			const pid = child.pid as number;
			const handle = { kill: vi.fn(() => true), unref: vi.fn(), exitCode: 0 };
			const killSpy = vi.spyOn(process, "kill");

			await killProcessTree(handle, pid, {
				fast: true,
				processExiting: true,
			});

			expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
			await exited(child);
		});

		it("a leader verified while alive stays signalable once it dies; one never verified does not", async () => {
			// #2026/#2027: the 1.5s escalation SIGKILLs the GROUP after the direct
			// child has already died, which is how a SIGTERM-hardy grandchild is
			// reached. `/proc/<leader>` is gone by then, so ownership has to be
			// remembered from when it was verifiable.
			const verified = spawnDetachedSleeper();
			const verifiedPid = verified.pid as number;
			expect(isOwnLiveChild(verifiedPid, "test-memo")).toBe(true);

			const unverified = spawnDetachedSleeper();
			const unverifiedPid = unverified.pid as number;

			process.kill(-verifiedPid, "SIGKILL");
			process.kill(-unverifiedPid, "SIGKILL");
			await exited(verified);
			await exited(unverified);

			expect(isOwnLiveChild(verifiedPid, "test-memo")).toBe(true);
			expect(isOwnLiveChild(unverifiedPid, "test-memo")).toBe(false);
		});
	},
);

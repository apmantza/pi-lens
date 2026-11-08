/**
 * #3179 — the one real, cross-process reproduction of the crash: no
 * stand-in for `fs.watch`, no stand-in for the removal.
 *
 * PR #3178 (run 35154740539) died with an unhandled 'error' event
 * (`ENOENT: no such file or directory, scandir
 * '.../tests/support/.index-2992-scratch'`) when node's non-native
 * recursive watch (the JS polyfill used on Linux, where inotify has no
 * recursive primitive — lib/internal/fs/recursive_watch.js) re-scanned that
 * directory with a synchronous `readdirSync` exactly as
 * `tests/index-2992-integration.test.ts` removed it between a change event
 * and the rescan.
 *
 * The race is inherently CROSS-PROCESS: `readdirSync`/`statSync` inside
 * node's polyfill are blocking syscalls on ONE thread, so this test's own
 * process can never interleave a removal between them (measured: a tight
 * same-process create/remove loop ran 500k+ iterations across 20s without
 * ever tripping it). A genuinely separate process has to own the other side
 * — the same shape production hits, where the guard's `fs.watch` lives in
 * vitest's main globalSetup process while the producer runs in a worker
 * fork.
 *
 * `tests/support/tests-tree-write-guard.test.ts` carries the deterministic
 * fake-watcher coverage for the swallow-vs-record-once LOGIC in the
 * installed 'error' handler; this file is the one case that drives node's
 * actual internal race end-to-end. Kept in its own file because, until
 * #4362, `admissionHeader` (`tests/support/flake-shape-scan.ts`) read only a
 * file's FIRST `// flake-shape:` header, so a second header for a different
 * detector in the sibling file would have misvalidated its existing
 * raw-timer-wait admission.
 */
// flake-shape: real-process-spawn — the race is cross-process by construction (readdirSync/statSync inside node's recursive-watch polyfill are blocking syscalls on one thread); only a separately spawned process removing the watched directory can land inside that window.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { TREE_WALK_TIMEOUT_MS } from "./test-timeout-scale.js";
import { isUnderIndex2992Scratch } from "./tests-tree-write-guard-setup.js";
import { installTestsTreeWriteGuard } from "./tests-tree-write-guard.js";

describe("tests-tree write guard — real cross-process race (#3179)", () => {
	it(
		"survives a real cross-process create/remove race under an allowed prefix",
		{ timeout: TREE_WALK_TIMEOUT_MS },
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3179-race-"));
			fs.mkdirSync(path.join(root, "support"), { recursive: true });
			const guard = installTestsTreeWriteGuard(root, {
				allow: isUnderIndex2992Scratch,
			});
			const scratchDir = path.join(root, "support", ".index-2992-scratch");

			let caught: unknown;
			const onUncaught = (error: unknown) => {
				caught = error;
			};
			process.on("uncaughtException", onUncaught);

			// Bounded by the shell's own `timeout`, not by a raw setTimeout in
			// this process: the churner's real exit is the synchronization
			// point this test waits on, so it needs no timer of its own.
			const churner = spawn(
				"timeout",
				[
					"3",
					"bash",
					"-c",
					'while true; do mkdir -p "$1"; : > "$1/f.ts"; rm -rf "$1"; done',
					"_",
					scratchDir,
				],
				{ stdio: "ignore" },
			);

			try {
				await new Promise<void>((resolve) => {
					churner.once("exit", () => resolve());
					churner.once("error", () => resolve());
				});
			} finally {
				process.off("uncaughtException", onUncaught);
				guard.close();
				fs.rmSync(root, { recursive: true, force: true });
			}
			expect(caught).toBeUndefined();
		},
	);
});

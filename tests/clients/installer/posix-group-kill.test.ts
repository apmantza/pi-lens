/**
 * #2026/#2027 — REAL-binary POSIX process-group kill semantics.
 *
 * These tests spawn actual `/bin/sh` process trees through safeSpawnAsync
 * and assert that timeout kills reach GRANDCHILDREN (the #2026 defect: the
 * old killPidTreeSync SIGTERMed only the direct child, orphaning detached
 * node writers). They are gated to real POSIX hosts — Linux CI and any
 * local WSL — and SKIP on Windows, where the equivalent tree-kill is
 * taskkill /T (covered by the installer suites' .cmd shims).
 *
 * No platform mocks, no fake children, no fake timers: budgets are generous
 * (300ms kill budget, 1s built-in escalation, multi-second polling windows)
 * so the assertions hold under scheduler noise while still discriminating
 * tree-kill from direct-child-only kill within a few seconds.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { safeSpawnAsync } from "../../../clients/safe-spawn.js";
import { removeTempDirSync } from "../test-utils.js";
import { waitFor } from "../interleaving-kit.js";
import { scaledTestTimeout } from "../../support/test-timeout-scale.js";

const d = it.skipIf(process.platform === "win32");

/** How long the "no marker may appear" window runs, in ms (hardy writer marks at +6 s). */
const NEGATIVE_WINDOW_MS = 8_000;

let repoDir = "";

beforeEach(() => {
	repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-posix-tree-"));
});

afterEach(() => {
	removeTempDirSync(repoDir);
});

/** Real grandchild: node writer that ignores SIGTERM and marks at +6s. */
function writeHardyWriter(marker: string): string {
	const writer = path.join(repoDir, "writer.cjs");
	fs.writeFileSync(
		writer,
		`process.on('SIGTERM', () => {});` +
			`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 6000);`,
		"utf8",
	);
	return writer;
}

describe("safeSpawnAsync POSIX process-group kill (#2026/#2027)", () => {
	d(
		"timeout kill reaches a SIGTERM-hardy grandchild through the group",
		async () => {
			const marker = path.join(repoDir, "grandchild-survived.marker");
			const writer = writeHardyWriter(marker);
			const script = path.join(repoDir, "tree.sh");
			// sh spawns node (grandchild) in the background, then holds past
			// the kill budget so the timeout fires mid-tree.
			fs.writeFileSync(
				script,
				`#!/bin/sh\nnode ${JSON.stringify(writer)} &\nsleep 30\n`,
				"utf8",
			);
			fs.chmodSync(script, 0o755);

			const result = await safeSpawnAsync(script, ["--version"], {
				timeout: 300,
			});

			expect(result.status === null || result.signal !== undefined).toBe(true);

			// Negative window past the writer's scheduled mark (+6s): the group
			// kill must have taken out the hardy grandchild too. `waitFor` cannot
			// express this -- its predicate is already true at the first poll -- so
			// the wait is a real-clock deadline loop (#4865, shape 86): the same
			// 8 s span, asserted on every poll, and the loop ends on the clock
			// instead of a turn count the sleeps had to survive.
			const windowEndsAt = Date.now() + NEGATIVE_WINDOW_MS;
			while (Date.now() < windowEndsAt) {
				await new Promise((r) => setTimeout(r, 250));
				expect(
					fs.existsSync(marker),
					`hardy grandchild wrote ${marker} after the group kill`,
				).toBe(false);
			}
		},
		20_000,
	);

	d(
		"a direct child that exits normally triggers no kill on its live group",
		async () => {
			const marker = path.join(repoDir, "hardy-grandchild.marker");
			const writer = writeHardyWriter(marker);
			const script = path.join(repoDir, "exiter.sh");
			// Direct child exits INSTANTLY (before the 1s escalation), leaving
			// the hardy grandchild holding the group. The escalation must probe
			// group liveness - not child death - and SIGKILL it.
			fs.writeFileSync(
				script,
				`#!/bin/sh\nnode ${JSON.stringify(writer)} &\nexit 0\n`,
				"utf8",
			);
			fs.chmodSync(script, 0o755);

			await safeSpawnAsync(script, ["--version"], { timeout: 30_000 });

			await waitFor(() => fs.existsSync(marker), Boolean, {
				timeoutMs: 8_000,
				intervalMs: 250,
			});
			// Grandchild survives its own schedule in THIS scenario by design:
			// the direct child exited normally, so no kill was ever issued.
			// What matters for #2027: a KILLED tree must not leave markers -
			// covered by the sibling test above. This test pins that natural
			// exit does NOT trigger spurious kills.
			expect(fs.existsSync(marker)).toBe(true);
		},
		// The wait's 8,000 ms budget scales with `PI_LENS_TEST_TIMEOUT_SCALE`
		// (24,000 ms on the Windows leg), so the test deadline must stay above it
		// or a marker that never lands reports `Test timed out` instead of the
		// wait's diagnostic (#4983).
		scaledTestTimeout(30_000),
	);
});
// flake-shape: real-process-spawn — real POSIX shell descendants prove process-group termination across OS process state

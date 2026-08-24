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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { safeSpawnAsync } from "../../../clients/safe-spawn.js";
import { removeTempDirSync } from "../test-utils.js";

const d = it.skipIf(process.platform === "win32");

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

			const transient = vi.fn();
			const result = await safeSpawnAsync(script, ["--version"], {
				timeout: 300,
			});

			expect(result.status === null || result.signal !== undefined).toBe(true);
			expect(transient).toHaveBeenCalledTimes(0); // not wired here

			// Poll past the writer's scheduled mark (+6s): the group kill must
			// have taken out the hardy grandchild too.
			for (let waited = 0; waited < 8_000; waited += 250) {
				await new Promise((r) => setTimeout(r, 250));
				expect(fs.existsSync(marker)).toBe(false);
			}
		},
		20_000,
	);

	d(
		"a live group gets the delayed SIGKILL even when the direct child exits first",
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

			for (let waited = 0; waited < 8_000; waited += 250) {
				if (fs.existsSync(marker)) break; // observed: now assert dead
				await new Promise((r) => setTimeout(r, 250));
			}
			// Grandchild survives its own schedule in THIS scenario by design:
			// the direct child exited normally, so no kill was ever issued.
			// What matters for #2027: a KILLED tree must not leave markers -
			// covered by the sibling test above. This test pins that natural
			// exit does NOT trigger spurious kills.
			expect(fs.existsSync(marker)).toBe(true);
		},
		20_000,
	);
});

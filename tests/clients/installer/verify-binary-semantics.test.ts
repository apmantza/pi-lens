/**
 * #2015 — verifyToolBinary spawn semantics after the safeSpawnAsync
 * migration. The raw-spawn version SIGTERMed only cmd.exe on Windows,
 * orphaning the grandchild node process; the rewritten version gets
 * tree-kill + a typed `signal` from safe-spawn, and must classify:
 *
 * - exit 0 → true (with version output forwarded)
 * - nonzero exit → false, NOT transient (a real verdict from the binary)
 * - timeout kill → false + transient callback fired (a stall, not a verdict)
 *
 * Cross-platform via platform-appropriate script shims. The Windows .cmd
 * branch exercises the exact shim shape production trips over.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyToolBinary } from "../../../clients/installer/index.js";
import { removeTempDirSync } from "../test-utils.js";

let binDir = "";

function writeShim(name: string, body: string): string {
	const isWin = process.platform === "win32";
	const file = path.join(binDir, isWin ? `${name}.cmd` : name);
	if (isWin) {
		fs.writeFileSync(file, `@echo off\r\n${body}\r\n`, "utf8");
	} else {
		fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, {
			encoding: "utf8",
			mode: 0o755,
		});
	}
	return file;
}

beforeEach(() => {
	binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-verify-2015-"));
});

afterEach(() => {
	removeTempDirSync(binDir);
});

describe("verifyToolBinary (#2015)", () => {
	it("exit 0 verifies and forwards version output", async () => {
		const bin = writeShim(
			"ok-tool",
			process.platform === "win32" ? "echo v1.2.3" : 'echo "v1.2.3"',
		);
		const onVersion = vi.fn();
		const transient = vi.fn();
		await expect(
			verifyToolBinary(bin, onVersion, transient, 10_000),
		).resolves.toBe(true);
		expect(onVersion).toHaveBeenCalledTimes(1);
		expect(transient).not.toHaveBeenCalled();
	});

	it("nonzero exit is a real verdict: false, NOT transient", async () => {
		const bin = writeShim(
			"broken-tool",
			process.platform === "win32" ? "exit /b 3" : "exit 3",
		);
		const transient = vi.fn();
		await expect(
			verifyToolBinary(bin, undefined, transient, 10_000),
		).resolves.toBe(false);
		expect(transient).not.toHaveBeenCalled();
	});

	it("timeout kill fires transient AND tree-kills the grandchild (#2015)", async () => {
		// The COLLISION PROBE: cmd.exe launches a DETACHED node grandchild that
		// writes a marker at +6s, then cmd itself holds for ~3s so the timeout
		// (1.5s) fires mid-tree. Old raw-spawn killed ONLY cmd.exe -> the
		// grandchild survived and wrote the marker (RED on pre-fix code).
		// safeSpawnAsync's tree-kill kills the whole tree -> no marker.
		const marker = path.join(binDir, "grandchild-survived.marker");
		const writer = path.join(binDir, "writer.cjs");
		fs.writeFileSync(
			writer,
			`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 6000);`,
			"utf8",
		);
		const body =
			process.platform === "win32"
				? `start "" /b node "${writer}"\r\nping -n 4 127.0.0.1 >nul`
				: `node "${writer}" &\nsleep 3`;
		const bin = writeShim("slow-tool", body);
		const transient = vi.fn();
		const started = Date.now();
		await expect(
			verifyToolBinary(bin, undefined, transient, 1_500),
		).resolves.toBe(false);
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(transient).toHaveBeenCalledTimes(1);

		// Poll past the grandchild's scheduled write (+6s): no marker = the
		// whole TREE died with the budget. Windows asserts this (taskkill /T).
		// POSIX: killPidTreeSync kills only the direct child today - the
		// grandchild legitimately survives (#2026) - so scope the assertion
		// to Windows until safe-spawn gains group-kill, and never let a known
		// platform gap read as a flake.
		if (process.platform === "win32") {
			for (let waited = 0; waited < 7_000; waited += 250) {
				await new Promise((r) => setTimeout(r, 250));
				expect(fs.existsSync(marker)).toBe(false);
			}
		}
	}, 25_000);
});

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
import { safeSpawnAsync } from "../../../clients/safe-spawn.js";
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
		// The writer IGNORES SIGTERM (#2027 round-1): surviving a soft group
		// TERM proves the SIGKILL escalation reaches the group even after the
		// direct child has exited.
		// CodeQL js/bad-code-sanitization: the marker path is NOT interpolated
		// into the generated code - writer.cjs derives it from its own
		// __dirname (it lives in binDir), so no taint reaches the embedded
		// source.
		fs.writeFileSync(
			writer,
			"process.on('SIGTERM', () => {});" +
				"setTimeout(() => require('fs').writeFileSync(" +
				"require('path').join(__dirname, 'grandchild-survived.marker'), 'survived'), 6000);",
			"utf8",
		);
		// CodeQL js/bad-code-sanitization: strip every character cmd.exe / sh
		// treat as special so the interpolated paths are provably inert. Our
		// mkdtemp paths already satisfy the allowlist, so behavior is unchanged.
		const safeWriter = writer.replace(/[^A-Za-z0-9_\\/. :-]/g, "_");
		const body =
			process.platform === "win32"
				? `start "" /b node "${safeWriter}"\r\nping -n 4 127.0.0.1 >nul`
				: `node "${safeWriter}" &\nsleep 3`;
		const bin = writeShim("slow-tool", body);
		const transient = vi.fn();
		const started = Date.now();
		await expect(
			verifyToolBinary(bin, undefined, transient, 1_500),
		).resolves.toBe(false);
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(transient).toHaveBeenCalledTimes(1);

		// Poll past the grandchild's scheduled write (+6s): no marker = the
		// whole TREE died with the budget. Asserted on BOTH platforms:
		// Windows via taskkill /T, POSIX via #2026 group-kill (detached
		// spawn + negative-pid signal).
		for (let waited = 0; waited < 7_000; waited += 250) {
			await new Promise((r) => setTimeout(r, 250));
			expect(fs.existsSync(marker)).toBe(false);
		}
	}, 25_000);

	it("rescues a transport error emitted after the output cap trips", async () => {
		const writer = path.join(binDir, "late-rescue.cjs");
		fs.writeFileSync(
			writer,
			"process.on('SIGTERM', () => {});" +
				"for (let i = 0; i < 24; i++) process.stderr.write('x'.repeat(4096));" +
				"setTimeout(() => process.stderr.write('Connection input stream is not set\\n'), 500);",
			"utf8",
		);
		const safeWriter = writer.replace(/[^A-Za-z0-9_\\/. :-]/g, "_");
		const bin = writeShim("late-rescue", `node "${safeWriter}"`);
		await expect(
			verifyToolBinary(bin, undefined, undefined, 10_000, ["--version"]),
		).resolves.toBe(true);
	}, 15_000);

	it("waits for a late rescue at the deterministic 2000ms cliff", async () => {
		const writer = path.join(binDir, "late-rescue-cliff.cjs");
		fs.writeFileSync(
			writer,
			"for (let i = 0; i < 24; i++) process.stderr.write('x'.repeat(4096));" +
				"setTimeout(() => process.stderr.write('Connection input stream is not set\\n'), 2000);",
			"utf8",
		);
		const result = await safeSpawnAsync(process.execPath, [writer], {
			timeout: 10_000,
			maxOutputBytes: 64 * 1024,
			matchWhileStreaming: /Connection input stream is not set/,
		});
		expect(result.streamingMatch).toBe(true);
		expect(result.outputTruncated).toBe(true);
	}, 15_000);

	it("does not invent a kill classification when an unmatched child exits", async () => {
		const writer = path.join(binDir, "natural-exit-after-cap.cjs");
		fs.writeFileSync(
			writer,
			"for (let i = 0; i < 24; i++) process.stderr.write('x'.repeat(4096));",
			"utf8",
		);
		const result = await safeSpawnAsync(process.execPath, [writer], {
			timeout: 10_000,
			maxOutputBytes: 64 * 1024,
			matchWhileStreaming: /never-matches/,
		});
		expect(result.status).toBe(0);
		expect(result.signal).toBeUndefined();
		expect(result.error).toBeUndefined();
		expect(result.streamingMatch).toBeUndefined();
		expect(result.outputTruncated).toBe(true);
	}, 15_000);

	it("matches a rescue split across output chunks", async () => {
		const writer = path.join(binDir, "split-rescue.cjs");
		fs.writeFileSync(
			writer,
			"process.stderr.write('x'.repeat(70 * 1024));" +
				"process.stderr.write('create');" +
				"setTimeout(() => process.stderr.write('Connection\\n'), 50);",
			"utf8",
		);
		const result = await safeSpawnAsync(process.execPath, [writer], {
			timeout: 10_000,
			maxOutputBytes: 64 * 1024,
			matchWhileStreaming: /createConnection/,
		});
		expect(result.streamingMatch).toBe(true);
	}, 15_000);

	it("uses the latch when head and tail retention cannot see the rescue", async () => {
		const writer = path.join(binDir, "evicted-rescue.cjs");
		fs.writeFileSync(
			writer,
			"for (let i = 0; i < 24; i++) process.stderr.write('x'.repeat(4096));" +
				"setTimeout(() => {" +
				"process.stderr.write('Connection input stream is not set\\n' + 'y'.repeat(100 * 1024));" +
				"}, 2000);",
			"utf8",
		);
		const bin = writeShim("evicted-rescue", `node "${writer}"`);
		await expect(
			verifyToolBinary(bin, undefined, undefined, 10_000, ["--version"]),
		).resolves.toBe(true);
	}, 15_000);

	it("latches a matching chunk before retained output can discard it", async () => {
		const writer = path.join(binDir, "streaming-latch.cjs");
		fs.writeFileSync(
			writer,
			"process.on('SIGTERM', () => {});" +
				"for (let i = 0; i < 24; i++) process.stderr.write('x'.repeat(4096));" +
				"setTimeout(() => process.stderr.write('RESCUE\\n'), 500);",
			"utf8",
		);
		const result = await safeSpawnAsync(process.execPath, [writer], {
			timeout: 10_000,
			maxOutputBytes: 64 * 1024,
			matchWhileStreaming: /RESCUE/,
		});
		expect(result.outputTruncated).toBe(true);
		expect(result.streamingMatch).toBe(true);
	}, 15_000);
});
// flake-shape: real-process-spawn — this test calls a child-process helper; its boundary remains part of the contention surface

import { describe, expect, it } from "vitest";
import { safeSpawnAsync } from "../../clients/safe-spawn.js";

describe("safeSpawnAsync stdin input", () => {
	it("writes input and closes stdin", async () => {
		const result = await safeSpawnAsync(
			process.execPath,
			[
				"-e",
				"process.stdin.setEncoding('utf8'); let s=''; process.stdin.on('data', x => s += x); process.stdin.on('end', () => process.stdout.write(s));",
			],
			{ timeout: 5000, input: "round-trip" },
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("round-trip");
	});

	it("closes stdin for an empty opt-in payload", async () => {
		const result = await safeSpawnAsync(
			process.execPath,
			[
				"-e",
				"process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'));",
			],
			{ timeout: 5000, input: "" },
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("eof");
	});

	it("survives a child that ignores stdin and exits", async () => {
		const result = await safeSpawnAsync(
			process.execPath,
			["-e", "process.exit(0)"],
			{ timeout: 5000, input: "ignored" },
		);
		expect(result).toMatchObject({ status: expect.any(Number) });
		expect(result.error === undefined || result.error instanceof Error).toBe(
			true,
		);
	});

	it("settles normally for an oversized payload into a non-reading child", async () => {
		const result = await safeSpawnAsync(
			process.execPath,
			["-e", "setTimeout(() => process.exit(0), 50)"],
			{ timeout: 5000, input: "x".repeat(200 * 1024) },
		);
		expect(result).toMatchObject({ status: expect.any(Number) });
		expect(result.error === undefined || result.error instanceof Error).toBe(
			true,
		);
	});
});
// flake-shape: real-process-spawn — this test calls a child-process helper; its boundary remains part of the contention surface

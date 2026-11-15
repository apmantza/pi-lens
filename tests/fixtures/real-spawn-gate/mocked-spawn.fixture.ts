/**
 * #5100 — the other side of the gate: a file that "spawns" through a mocked
 * `node:child_process`. `vi.mock` replaces the module in this file's registry,
 * so the call never reaches the patched real exports and the run records
 * nothing. If this file ever fails the gate, the mock has stopped covering the
 * entry point the observer wraps.
 */
import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";

vi.mock("node:child_process", () => {
	const spawn = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
	return { spawnSync: spawn, default: { spawnSync: spawn } };
});

it("starts nothing: the module is a mock", () => {
	const result = spawnSync("definitely-not-a-real-binary", ["--version"]);
	expect(result.status).toBe(0);
	expect(vi.isMockFunction(spawnSync)).toBe(true);
});

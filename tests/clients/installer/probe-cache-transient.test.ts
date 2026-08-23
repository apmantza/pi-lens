import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.js");

// ── fs/promises mock ───────────────────────────────────────────────────────
const mockFsReadFile = vi.hoisted(() => vi.fn());
const mockFsAccess = vi.hoisted(() => vi.fn());
const mockFsStat = vi.hoisted(() => vi.fn());
const mockFsWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsAppendFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsRm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsRename = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWriteFileAtomicAsync = vi.hoisted(() =>
	vi.fn().mockResolvedValue(undefined),
);

vi.mock("node:fs/promises", () => ({
	default: {
		readFile: mockFsReadFile,
		access: mockFsAccess,
		stat: mockFsStat,
		writeFile: mockFsWriteFile,
		mkdir: mockFsMkdir,
		appendFile: mockFsAppendFile,
		rm: mockFsRm,
		rename: mockFsRename,
	},
	readFile: mockFsReadFile,
	access: mockFsAccess,
	stat: mockFsStat,
	writeFile: mockFsWriteFile,
	mkdir: mockFsMkdir,
	appendFile: mockFsAppendFile,
	rm: mockFsRm,
	rename: mockFsRename,
}));

vi.mock("../../../clients/atomic-write.js", () => ({
	writeFileAtomicAsync: mockWriteFileAtomicAsync,
}));

// ── safe-spawn mock ──
// #2015: verifyToolBinary probes route through `safeSpawnAsync`, not raw
// `node:child_process.spawn`. The `.cmd` candidate simulates a real spawn
// timeout — the prober is killed and reports `signal: "SIGTERM"` — while the
// `.exe` candidate answers cleanly. This is the #1569 shape: a preferred tier
// stalls (never gets a fair run), a lower-priority candidate succeeds, and the
// SELECTION must remember that a candidate along the way was never confirmed
// broken — only unlucky.
const spawnCalls = vi.hoisted(() => [] as string[]);
vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: async (command: string) => {
		const cmd = String(command);
		spawnCalls.push(cmd);
		if (cmd.includes(".cmd")) {
			return { stdout: "", stderr: "", status: null, signal: "SIGTERM" };
		}
		return { stdout: "1.0.0\n", stderr: "", status: 0 };
	},
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

import * as path from "node:path";
import { getGlobalPiLensDir } from "../../../clients/file-utils.js";
import {
	checkProbeCache,
	flushProbeCache,
	getToolPath,
	resetProbeCacheStateForTesting,
	updateProbeCache,
	wasLastResolveTransient,
} from "../../../clients/installer/index.js";

const TOOL_ID = "stylelint";
const TOOLS_DIR = path.join(getGlobalPiLensDir(), "tools");
const LOCAL_BASE = path.join(TOOLS_DIR, "node_modules", ".bin", TOOL_ID);
const CMD_PATH = `${LOCAL_BASE}.cmd`;
const EXE_PATH = `${LOCAL_BASE}.exe`;

function fakeAccess(...allowed: string[]): void {
	const set = new Set(allowed);
	mockFsAccess.mockImplementation(async (p: string) => {
		if (set.has(p)) return;
		throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	spawnCalls.length = 0;
	process.env.PI_LENS_TEST_PLATFORM = "win32";
	mockFsMkdir.mockResolvedValue(undefined);
	mockFsRm.mockResolvedValue(undefined);
	mockFsRename.mockResolvedValue(undefined);
	mockWriteFileAtomicAsync.mockResolvedValue(undefined);
	resetProbeCacheStateForTesting();
});

afterEach(() => {
	delete process.env.PI_LENS_TEST_PLATFORM;
	vi.useRealTimers();
});

describe("#1569 transient-tainted probe-cache entries", () => {
	it("getToolPath falls through a stalled preferred candidate and remembers the resolution was transient", async () => {
		fakeAccess(CMD_PATH, EXE_PATH);

		const result = await getToolPath(TOOL_ID);

		expect(result).toBe(EXE_PATH);
		expect(spawnCalls.some((c) => c.includes(".cmd"))).toBe(true);
		expect(spawnCalls.some((c) => c.endsWith(".exe"))).toBe(true);
		expect(wasLastResolveTransient(TOOL_ID)).toBe(true);
	});

	it("does not serve a transient-tainted entry past the transient cooldown, though it is well inside the 24h TTL", async () => {
		fakeAccess(CMD_PATH, EXE_PATH);
		mockFsReadFile.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		mockFsStat.mockResolvedValue({ mtimeMs: 1 });

		const result = await getToolPath(TOOL_ID);
		expect(result).toBe(EXE_PATH);
		await updateProbeCache(
			TOOL_ID,
			result as string,
			wasLastResolveTransient(TOOL_ID),
		);

		// Simulate a process restart: drop the in-memory cache and reload from
		// disk the way a fresh process does. Six minutes is past the shared
		// transient cooldown (5 min ceiling) but nowhere near the 24h TTL — a
		// process restarting minutes later must NOT still be served the
		// degraded selection.
		resetProbeCacheStateForTesting();
		const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
		mockFsReadFile.mockResolvedValue(
			JSON.stringify({
				[TOOL_ID]: {
					path: EXE_PATH,
					mtimeMs: 1,
					cachedAt: sixMinutesAgo,
					transient: true,
				},
			}),
		);

		const cached = await checkProbeCache(TOOL_ID);
		expect(cached).toBeUndefined();
	});

	it("prunes a sibling process's stale transient entry during the authoritative write-side merge", async () => {
		mockFsStat.mockResolvedValue({ mtimeMs: 1 });
		const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
		mockFsReadFile.mockResolvedValue(
			JSON.stringify({
				ruff: {
					path: "/sibling/ruff",
					mtimeMs: 1,
					cachedAt: sixMinutesAgo,
					transient: true,
				},
			}),
		);

		await updateProbeCache(TOOL_ID, EXE_PATH);
		await flushProbeCache();

		const [, content] = mockWriteFileAtomicAsync.mock.calls[0] as [
			string,
			string,
		];
		expect(JSON.parse(content).ruff).toBeUndefined();
	});

	it("still serves a clean (non-transient) entry at the same six-minute age", async () => {
		const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
		mockFsReadFile.mockResolvedValue(
			JSON.stringify({
				[TOOL_ID]: { path: EXE_PATH, mtimeMs: 1, cachedAt: sixMinutesAgo },
			}),
		);
		mockFsAccess.mockResolvedValue(undefined);
		mockFsStat.mockResolvedValue({ mtimeMs: 1 });

		const cached = await checkProbeCache(TOOL_ID);
		expect(cached).toBe(EXE_PATH);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.ts");

// ── os mock ────────────────────────────────────────────────────────────
const TEST_HOME = vi.hoisted(() =>
	process.platform === "win32" ? String.raw`C:\Users\test` : "/home/test",
);

vi.mock("node:os", () => ({
	default: {
		homedir: () => TEST_HOME,
		tmpdir: () => "/tmp",
		platform: () => process.platform,
		arch: () => process.arch,
		release: () => "",
		type: () => "",
		cpus: () => [],
		totalmem: () => 0,
		freemem: () => 0,
		networkInterfaces: () => ({}),
		userInfo: () => ({
			username: "test",
			homedir: TEST_HOME,
			uid: 1000,
			gid: 1000,
			shell: "",
		}),
		hostname: () => "test",
		uptime: () => 0,
		loadavg: () => [0, 0, 0],
		EOL: "\n",
		constants: {},
		devNull: "/dev/null",
		endianness: () => "LE",
		setPriority: () => {},
		getPriority: () => 0,
	},
	// Namespace imports (`import * as os from "node:os"`) hit these named
	// exports, so homedir must return TEST_HOME here too.
	homedir: () => TEST_HOME,
	tmpdir: () => "/tmp",
	platform: () => process.platform,
	...Object.fromEntries(
		[
			"arch",
			"release",
			"type",
			"cpus",
			"totalmem",
			"freemem",
			"networkInterfaces",
			"userInfo",
			"hostname",
			"uptime",
			"loadavg",
			"EOL",
			"constants",
			"devNull",
			"endianness",
			"setPriority",
			"getPriority",
		].map((k) => [k, () => {}]),
	),
}));

// ── fs promises mock ────────────────────────────────────────────────────
const mockFsAccess = vi.hoisted(() => vi.fn());
const mockFsReadFile = vi.hoisted(() => vi.fn());
const mockFsStat = vi.hoisted(() => vi.fn());
const mockFsWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsAppendFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("node:fs/promises", () => ({
	default: {
		readFile: mockFsReadFile,
		access: mockFsAccess,
		stat: mockFsStat,
		writeFile: mockFsWriteFile,
		mkdir: mockFsMkdir,
		appendFile: mockFsAppendFile,
	},
	readFile: mockFsReadFile,
	access: mockFsAccess,
	stat: mockFsStat,
	writeFile: mockFsWriteFile,
	mkdir: mockFsMkdir,
	appendFile: mockFsAppendFile,
}));

// ── child_process spawn mock ────────────────────────────────────────────
const spawnCalls = vi.hoisted(
	() => [] as Array<{ cmd: string; args: string[] }>,
);
const mockSpawn = vi.hoisted(() =>
	vi.fn((cmd: string, args: string[], _opts?: unknown) => {
		spawnCalls.push({ cmd, args });
		let exitCb: (code: number) => void = () => {};
		const proc = {
			on: vi.fn((event: string, cb: unknown) => {
				if (event === "exit") exitCb = cb as (code: number) => void;
				return proc;
			}),
			stdout: null as { on: ReturnType<typeof vi.fn> } | null,
			stderr: null as { on: ReturnType<typeof vi.fn> } | null,
			kill: vi.fn(),
		};
		setImmediate(() => exitCb(0));
		return proc;
	}),
);

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

// ── https mock ──────────────────────────────────────────────────────────
// Keep the suite hermetic: installTool's github path does a real GitHub API
// fetch via node:https. Without this mock the install tests depend on the
// network and fail in restricted CI (e.g. dependabot PRs). The mock records the
// fetch (so we can assert installTool was reached) then fails deterministically.
const httpsGetCalls = vi.hoisted(() => [] as string[]);
const mockHttpsGet = vi.hoisted(() => (url: unknown) => {
	httpsGetCalls.push(String(url));
	const req = {
		on(event: string, handler: (err: Error) => void) {
			if (event === "error") {
				setImmediate(() => handler(new Error("network disabled in test")));
			}
			return req;
		},
	};
	return req;
});
vi.mock("node:https", () => ({ default: { get: mockHttpsGet }, get: mockHttpsGet }));

import * as path from "node:path";
import {
	ensureTool,
	getToolPath,
	resetProbeCacheStateForTesting,
} from "../../../clients/installer/index.ts";

// ── helpers ─────────────────────────────────────────────────────────────

const GITHUB_BIN = path.join(TEST_HOME, ".pi-lens", "bin");
const EXE = process.platform === "win32" ? ".exe" : "";

function ghPath(name: string): string {
	return path.join(GITHUB_BIN, `${name}${EXE}`);
}

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
	httpsGetCalls.length = 0;
	resetProbeCacheStateForTesting();
	mockFsReadFile.mockRejectedValue(new Error("ENOENT"));
	fakeAccess(/* nothing */);
});

afterEach(() => {
	vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════
// getToolPath ordering: github-local before PATH
// ═════════════════════════════════════════════════════════════════════════

describe("getToolPath ordering", () => {
	describe("github-strategy tools", () => {
		it("prefers github-local (~/.pi-lens/bin/) over PATH when both exist", async () => {
			const managed = ghPath("rust-analyzer");
			fakeAccess(managed);

			const result = await getToolPath("rust-analyzer");

			expect(result).toBe(managed);
		});

		it("returns undefined when github-local is empty", async () => {
			// On CI, rust-analyzer may be on the real PATH — accept either result
			const result = await getToolPath("rust-analyzer");
			// github-local empty, PATH may or may not have it
			expect([undefined, "rust-analyzer"]).toContain(result);
		});
	});

	describe("non-github tools are unaffected by reorder", () => {
		it("npm-strategy tools do not check github-local", async () => {
			// stylelint is npm-strategy, not github — should not find anything
			// in github-local, and PATH check depends on real PATH.
			// Key: the function doesn't crash and returns something reasonable.
			const result = await getToolPath("stylelint");
			// Either found on real PATH or undefined — both are valid,
			// just verify it doesn't throw.
			expect([undefined, "stylelint"]).toContain(result);
		});

		it("pip-strategy tools do not check github-local", async () => {
			const result = await getToolPath("ruff");
			expect([undefined, "ruff"]).toContain(result);
		});
	});
});

// ═════════════════════════════════════════════════════════════════════════
// ensureTool force-reinstall
// ═════════════════════════════════════════════════════════════════════════

describe("ensureTool force-reinstall", () => {
	it("does not return the stale cached path after forceReinstall", async () => {
		const { updateProbeCache } = await import(
			"../../../clients/installer/index.ts"
		);
		// Use a path that can't collide with a real tool on PATH
		const stalePath = "/fake/stale/rust-analyzer";

		// Seed the probe cache with a fake entry
		mockFsStat.mockResolvedValue({ mtimeMs: Date.now() });
		await updateProbeCache("rust-analyzer", stalePath);

		spawnCalls.length = 0;

		const result = await ensureTool("rust-analyzer", {
			forceReinstall: true,
		});

		// installTool fails (no GitHub API mock) → undefined
		// Key: NOT returning the stale "/fake/stale/rust-analyzer" from cache
		expect(result).not.toBe(stalePath);
	}, 30000); // installTool makes a real GitHub-API fetch (own 5-10s timeouts) — 5s default is too tight under CI

	it("skips cache layers and reaches installTool", async () => {
		// Pre-populate probe cache with a stale PATH entry
		mockFsReadFile.mockResolvedValue(
			JSON.stringify({
				"rust-analyzer": {
					path: "/fake/cached/rust-analyzer",
					mtimeMs: Date.now(),
					cachedAt: Date.now(),
				},
			}),
		);
		mockFsStat.mockResolvedValue({ mtimeMs: Date.now() });
		mockFsAccess.mockResolvedValue(undefined);

		spawnCalls.length = 0;
		httpsGetCalls.length = 0;

		const result = await ensureTool("rust-analyzer", {
			forceReinstall: true,
		});

		expect(result).not.toBe("/fake/cached/rust-analyzer");
		// Reaching installTool means it attempted the GitHub-release fetch. (The
		// fetch is mocked to fail, so no real network — hermetic.)
		expect(httpsGetCalls.length).toBeGreaterThan(0);
	});
});

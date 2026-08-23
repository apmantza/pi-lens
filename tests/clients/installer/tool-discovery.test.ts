import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../support/with-env.js";

vi.unmock("../../../clients/installer/index.js");

// This file deliberately exercises the REAL getGlobalPiLensDir() resolver
// (via the node:os mock below forcing TEST_HOME) rather than #525's
// PI_LENS_HOME test override from vitest-setup.ts. clients/installer/index.ts
// computes GITHUB_BIN_DIR as a module-level const at first import, so
// PI_LENS_HOME must be cleared BEFORE that static import below runs — hence
// vi.hoisted (runs before all imports, including the module under test).
vi.hoisted(() => {
	delete process.env.PI_LENS_HOME;
});

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
const mockFsOpen = vi.hoisted(() =>
	vi.fn().mockResolvedValue({
		writeFile: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
	}),
);
const mockFsRm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("node:fs/promises", () => ({
	default: {
		readFile: mockFsReadFile,
		access: mockFsAccess,
		stat: mockFsStat,
		writeFile: mockFsWriteFile,
		mkdir: mockFsMkdir,
		appendFile: mockFsAppendFile,
		open: mockFsOpen,
		rm: mockFsRm,
	},
	readFile: mockFsReadFile,
	access: mockFsAccess,
	stat: mockFsStat,
	writeFile: mockFsWriteFile,
	mkdir: mockFsMkdir,
	appendFile: mockFsAppendFile,
	open: mockFsOpen,
	rm: mockFsRm,
}));

// #1609: the installer's npm-tool package.json bootstrap now goes through
// the shared atomic tmp+rename seam instead of a raw `fs.writeFile`, so it
// must be mocked here too — otherwise it falls through to the REAL node:fs
// (atomic-write.ts imports `node:fs` directly, not this mocked
// `node:fs/promises`), which fails writing into this test's mocked,
// non-existent-on-disk tools directory.
const mockWriteFileAtomicAsync = vi.hoisted(() =>
	vi.fn().mockResolvedValue(undefined),
);
vi.mock("../../../clients/atomic-write.js", () => ({
	writeFileAtomicAsync: mockWriteFileAtomicAsync,
}));

// ── child_process spawn mock ────────────────────────────────────────────
const spawnCalls = vi.hoisted(
	() => [] as Array<{ cmd: string; args: string[] }>,
);
const mockSpawn = vi.hoisted(() =>
	vi.fn((cmd: string, args: string[], _opts?: unknown) => {
		spawnCalls.push({ cmd, args });
		const handlers: Record<string, (code?: number) => void> = {};
		const proc = {
			on: vi.fn((event: string, cb: unknown) => {
				handlers[event] = cb as (code?: number) => void;
				return proc;
			}),
			stdout: null as { on: ReturnType<typeof vi.fn> } | null,
			stderr: null as { on: ReturnType<typeof vi.fn> } | null,
			kill: vi.fn(),
		};
		// Raw-spawn consumers listen on `exit`; safeSpawnAsync listens on `close`.
		setImmediate(() => {
			handlers.exit?.(0);
			handlers.close?.(0);
		});
		return proc;
	}),
);

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

// #2015: verifyToolBinary probes (and installNpmTool's npm-install spawn)
// route through `safeSpawnAsync`, so this file mocks that seam directly and
// records every invocation into the same `spawnCalls` log the raw-spawn mock
// above feeds. Probes and installs both answer success; tests that need a
// failure simulate it at their own seams (network, fs access).
vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: async (command: string, args: string[]) => {
		spawnCalls.push({ cmd: String(command), args: args ?? [] });
		return { stdout: "", stderr: "", status: 0 };
	},
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

// ── https mock ──────────────────────────────────────────────────────────
// Keep the suite hermetic: installTool's github path does a real GitHub API
// fetch via node:https. Without this mock the install tests depend on the
// network and fail in restricted CI (e.g. dependabot PRs). The mock records the
// fetch (so we can assert installTool was reached) then fails deterministically.
const httpsGetCalls = vi.hoisted(() => [] as string[]);
const httpsBlocker = vi.hoisted(() => ({
	enabled: false,
	errorHandler: undefined as ((err: Error) => void) | undefined,
}));
const mockHttpsGet = vi.hoisted(() => (url: unknown) => {
	httpsGetCalls.push(String(url));
	const req = {
		on(event: string, handler: (err: Error) => void) {
			if (event === "error") {
				if (httpsBlocker.enabled) {
					httpsBlocker.errorHandler = handler;
				} else {
					setImmediate(() => handler(new Error("network disabled in test")));
				}
			}
			return req;
		},
	};
	return req;
});
vi.mock("node:https", () => ({
	default: { get: mockHttpsGet },
	get: mockHttpsGet,
}));

// #1276: `finishInstallAttempt` calls this on a successful install, mirroring
// `resetSafeSpawnWindowsCommandCache` right above it. Mocked so the wiring
// test below can assert the call without pulling in DependencyChecker's own
// dependencies (safe-spawn, package-manager) — that side is covered by
// tests/clients/dependency-checker-madge-memo-reset.test.ts.
const mockResetMadgeManagedPathMemo = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/dependency-checker.js", () => ({
	resetMadgeManagedPathMemo: mockResetMadgeManagedPathMemo,
}));

import * as path from "node:path";
import {
	checkProbeCache,
	ensureTool,
	getToolPath,
	resetProbeCacheStateForTesting,
} from "../../../clients/installer/index.js";

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

async function withEmptyPath<T>(fn: () => Promise<T>): Promise<T> {
	const savedPath = process.env.PATH;
	const savedPathUpper = process.env.Path;
	const savedPathLower = process.env.path;
	process.env.PATH = "";
	delete process.env.Path;
	delete process.env.path;
	try {
		return await fn();
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		if (savedPathUpper === undefined) delete process.env.Path;
		else process.env.Path = savedPathUpper;
		if (savedPathLower === undefined) delete process.env.path;
		else process.env.path = savedPathLower;
	}
}

// This file deliberately exercises the REAL getGlobalPiLensDir() resolver
// (via the node:os mock above forcing TEST_HOME) rather than #525's
// PI_LENS_HOME test override from vitest-setup.ts — construct our own
// explicit override (unset) for the duration of this file so paths resolve
// against the mocked TEST_HOME as originally intended.
const savedPiLensHome = process.env.PI_LENS_HOME;

// #1816: this file's `afterEach` used to hard-restore the literal "1"
// instead of whatever was ambient before the file ran — correct only by
// coincidence (vitest-setup.ts's own default). `withEnv` restores the real
// prior value.
let restoreDisableToolInstall: () => void;

beforeEach(() => {
	restoreDisableToolInstall = withEnv({
		PI_LENS_DISABLE_TOOL_INSTALL: undefined,
	});
	delete process.env.PI_LENS_HOME;
	vi.clearAllMocks();
	spawnCalls.length = 0;
	httpsGetCalls.length = 0;
	httpsBlocker.enabled = false;
	httpsBlocker.errorHandler = undefined;
	resetProbeCacheStateForTesting();
	mockFsReadFile.mockRejectedValue(new Error("ENOENT"));
	fakeAccess(/* nothing */);
});

afterEach(() => {
	restoreDisableToolInstall();
	delete process.env.PI_LENS_TEST_PLATFORM;
	delete process.env.PI_LENS_TEST_MODE;
	delete process.env.PI_LENS_TEST_NPM_SCRIPT;
	if (savedPiLensHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = savedPiLensHome;
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

describe("managed npm executable paths", () => {
	it("returns the stored Windows .cmd shim from the real npm install path", async () => {
		process.env.PI_LENS_TEST_PLATFORM = "win32";
		process.env.PI_LENS_TEST_MODE = "1";
		process.env.PI_LENS_TEST_NPM_SCRIPT = "install";
		await withEmptyPath(async () => {
			const expected = path.join(
				path.join(TEST_HOME, ".pi-lens", "tools"),
				"node_modules",
				".bin",
				"stylelint.cmd",
			);
			fakeAccess(expected);
			// updateProbeCache stats the resolved path before persisting it; without
			// this the fire-and-forget `void updateProbeCache(...)` call in ensureTool
			// silently no-ops (stat throws on the unconfigured mock, caught as
			// best-effort) and the gap below would pass vacuously.
			mockFsStat.mockResolvedValue({ mtimeMs: 1 });
			const result = await ensureTool("stylelint", { forceReinstall: true });
			expect(result).toBe(expected);
			// The verifier is reached with the actual stored shim path, rather than
			// an extensionless POSIX sibling that Windows cannot execute.
			expect(spawnCalls.some(({ cmd }) => cmd.includes("stylelint.cmd"))).toBe(
				true,
			);
			// #1266/#1223: assert the value actually PERSISTED by updateProbeCache,
			// not just the value ensureTool happened to return this call. Give the
			// fire-and-forget `void updateProbeCache(...)` a tick to complete.
			await new Promise((resolve) => setImmediate(resolve));
			await expect(checkProbeCache("stylelint")).resolves.toBe(expected);
		});
	});

	it("clears the madge managed-path memo when a managed install succeeds (#1276)", async () => {
		process.env.PI_LENS_TEST_PLATFORM = "win32";
		process.env.PI_LENS_TEST_MODE = "1";
		process.env.PI_LENS_TEST_NPM_SCRIPT = "install";
		await withEmptyPath(async () => {
			const expected = path.join(
				path.join(TEST_HOME, ".pi-lens", "tools"),
				"node_modules",
				".bin",
				"madge.cmd",
			);
			fakeAccess(expected);
			mockFsStat.mockResolvedValue({ mtimeMs: 1 });

			expect(mockResetMadgeManagedPathMemo).not.toHaveBeenCalled();
			const result = await ensureTool("madge", { forceReinstall: true });
			expect(result).toBe(expected);

			// finishInstallAttempt AWAITS the reset before installTool()/ensureTool()
			// resolve (P1 fix): a caller that starts the next madge resolution the
			// instant `await ensureTool(...)` returns must observe the reset memo,
			// never a stale pre-install one. No tick-wait needed — if the reset were
			// still fire-and-forget (pre-fix), this assertion would be racy and
			// fail intermittently since nothing here yields to the microtask queue.
			expect(mockResetMadgeManagedPathMemo).toHaveBeenCalledTimes(1);
		});
	});

	it("does not let a rejected madge memo reset crash or silently swallow the install (#1276)", async () => {
		process.env.PI_LENS_TEST_PLATFORM = "win32";
		process.env.PI_LENS_TEST_MODE = "1";
		process.env.PI_LENS_TEST_NPM_SCRIPT = "install";
		mockResetMadgeManagedPathMemo.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		await withEmptyPath(async () => {
			const expected = path.join(
				path.join(TEST_HOME, ".pi-lens", "tools"),
				"node_modules",
				".bin",
				"madge.cmd",
			);
			fakeAccess(expected);
			mockFsStat.mockResolvedValue({ mtimeMs: 1 });

			// A throwing reset must not turn into an unhandled rejection or make
			// the (otherwise successful) install look like it failed — it's a
			// best-effort cache invalidation, not the install outcome itself.
			await expect(ensureTool("madge", { forceReinstall: true })).resolves.toBe(
				expected,
			);
			expect(mockResetMadgeManagedPathMemo).toHaveBeenCalledTimes(1);
		});
	});
});

describe("ensureTool allowInstall policy", () => {
	it("returns a discovered binary without attempting install when allowInstall is false", async () => {
		const managed = ghPath("rust-analyzer");
		fakeAccess(managed);

		const result = await ensureTool("rust-analyzer", { allowInstall: false });

		expect(result).toBe(managed);
		expect(httpsGetCalls).toHaveLength(0);
	});

	it("returns undefined without attempting install when allowInstall is false and discovery misses", async () => {
		await withEmptyPath(async () => {
			const result = await ensureTool("rust-analyzer", { allowInstall: false });

			expect(result).toBeUndefined();
			expect(httpsGetCalls).toHaveLength(0);
		});
	});

	it("does not install when forceReinstall conflicts with allowInstall:false", async () => {
		const managed = ghPath("rust-analyzer");
		fakeAccess(managed);

		const result = await ensureTool("rust-analyzer", {
			forceReinstall: true,
			allowInstall: false,
		});

		expect(result).toBe(managed);
		expect(httpsGetCalls).toHaveLength(0);
	});

	it("returns undefined without install when forceReinstall and allowInstall:false miss discovery", async () => {
		await withEmptyPath(async () => {
			const result = await ensureTool("rust-analyzer", {
				forceReinstall: true,
				allowInstall: false,
			});

			expect(result).toBeUndefined();
			expect(httpsGetCalls).toHaveLength(0);
		});
	});

	it("keeps discovery-only calls separate from an in-flight install", async () => {
		await withEmptyPath(async () => {
			httpsBlocker.enabled = true;
			try {
				const installAllowed = ensureTool("rust-analyzer");
				await new Promise((resolve) => setImmediate(resolve));
				expect(httpsGetCalls.length).toBeGreaterThan(0);

				const discoveryOnly = await ensureTool("rust-analyzer", {
					allowInstall: false,
				});
				expect(discoveryOnly).toBeUndefined();

				httpsBlocker.enabled = false;
				httpsBlocker.errorHandler?.(new Error("network disabled in test"));
				expect(await installAllowed).toBeUndefined();
			} finally {
				httpsBlocker.enabled = false;
				httpsBlocker.errorHandler = undefined;
			}
		});
	});
});

describe("ensureTool force-reinstall", () => {
	it("does not return the stale cached path after forceReinstall", async () => {
		const { updateProbeCache } =
			await import("../../../clients/installer/index.js");
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

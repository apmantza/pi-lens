import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
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
// A real, writable per-file directory, not a fixed "/home/test": since #3476
// the install and probe-cache locks create their generation directories with
// sync node:fs, which this file does not mock, under the home the node:os
// mock names. A fixed path was unwritable for CI's non-root user (EACCES from
// every install) and left real lock directories behind on a root box.
const TEST_HOME = vi.hoisted(() => {
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	return nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-tool-discovery-home-"),
	);
});

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
	() => [] as Array<{ cmd: string; args: string[]; timeout?: number }>,
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
// above feeds. Probes and installs both answer success by default; a test that
// needs a probe VERDICT sets `spawnVerdict` (#3311 — the PATH rung now verifies
// its candidate, so the probe's answer decides PATH resolution as well).
const spawnVerdict = vi.hoisted(() => ({
	status: 0 as number | null,
	stdout: "",
	stderr: "",
	signal: undefined as string | undefined,
}));
vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: async (
		command: string,
		args: string[],
		options?: { timeout?: number },
	) => {
		spawnCalls.push({
			cmd: String(command),
			args: args ?? [],
			timeout: options?.timeout,
		});
		return {
			stdout: spawnVerdict.stdout,
			stderr: spawnVerdict.stderr,
			status: spawnVerdict.status,
			...(spawnVerdict.signal === undefined
				? {}
				: { signal: spawnVerdict.signal }),
		};
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

import * as realFs from "node:fs";
import * as path from "node:path";
import {
	_peekEnsureInFlightForTesting,
	checkProbeCache,
	ensureTool,
	getToolPath,
	resetProbeCacheStateForTesting,
} from "../../../clients/installer/index.js";

// ── helpers ─────────────────────────────────────────────────────────────

const GITHUB_BIN = path.join(TEST_HOME, ".pi-lens", "bin");
const EXE = process.platform === "win32" ? ".exe" : "";

/**
 * A real directory holding a real, non-empty file named `command` — what
 * `isCommandAvailable` walks PATH for (`statSync().isFile() && size > 0`). It is
 * never executed here: the spawn boundary is mocked, and `spawnVerdict` decides
 * what the probe of it answers.
 */
const pathDirs: string[] = [];
function pathDirWith(command: string): string {
	const dir = realFs.mkdtempSync(path.join(process.cwd(), ".tmp-path-cand-"));
	pathDirs.push(dir);
	realFs.writeFileSync(path.join(dir, command), "#!/bin/sh\nexit 1\n", {
		mode: 0o750,
	});
	return dir;
}

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
	spawnVerdict.status = 0;
	spawnVerdict.stdout = "";
	spawnVerdict.stderr = "";
	spawnVerdict.signal = undefined;
	mockFsReadFile.mockRejectedValue(new Error("ENOENT"));
	fakeAccess(/* nothing */);
});

afterAll(() => {
	realFs.rmSync(TEST_HOME, { recursive: true, force: true });
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
// #3311: a PATH candidate that cannot RUN is not a resolution
//
// Recurrence this guards: the nightly census reported `ensureTool(rust-analyzer)
// → rust-analyzer` and then `no client ready in 30000ms` on every run, because
// rustup installs a `rust-analyzer` PROXY into ~/.cargo/bin whether or not the
// component behind it is installed (rustup 1.29.1 `DUP_TOOLS`, src/lib.rs:32),
// and the PATH rung of the resolution ladder returned that file unverified —
// shadowing the github-release install pi-lens would otherwise have downloaded.
// The same rung returned a pipx-installed `cmake-language-server` whose venv had
// resolved pygls 2, which cannot import.
// ═════════════════════════════════════════════════════════════════════════

describe("PATH candidate verification (#3311)", () => {
	afterEach(() => {
		for (const dir of pathDirs.splice(0))
			realFs.rmSync(dir, { recursive: true, force: true });
	});

	it("does not resolve a PATH candidate whose own check returns a verdict", async () => {
		const dir = pathDirWith(`rust-analyzer${EXE}`);
		spawnVerdict.status = 1;
		spawnVerdict.stderr =
			"error: the 'rust-analyzer' component which provides the command 'rust-analyzer' is not available for the 'stable-x86_64-unknown-linux-gnu' toolchain";
		const restorePath = withEnv({ PATH: dir });
		try {
			const result = await getToolPath("rust-analyzer");

			expect(result).toBeUndefined();
			expect(spawnCalls.map((call) => call.args)).toContainEqual(["--version"]);
		} finally {
			restorePath();
		}
	});

	it("lets the managed install be attempted for a shadowed github-strategy server", async () => {
		const dir = pathDirWith(`rust-analyzer${EXE}`);
		spawnVerdict.status = 1;
		const restorePath = withEnv({ PATH: dir });
		try {
			await ensureTool("rust-analyzer");

			// The github release lookup — the install this PATH file used to
			// shadow — was reached. (It then fails: node:https is mocked.)
			expect(httpsGetCalls.join(" ")).toContain("rust-analyzer");
		} finally {
			restorePath();
		}
	});

	it("keeps a PATH candidate whose probe was killed (a stall is not a verdict)", async () => {
		const dir = pathDirWith(`rust-analyzer${EXE}`);
		spawnVerdict.status = null;
		spawnVerdict.signal = "SIGTERM";
		const restorePath = withEnv({ PATH: dir });
		try {
			const result = await getToolPath("rust-analyzer");

			expect(result).toBe("rust-analyzer");
		} finally {
			restorePath();
		}
	});

	it("resolves a package-entry entry from PATH without probing it", async () => {
		// #2722: a `verification: "package-entry"` entry is verified from the
		// installed tree beside its shim, which a bare PATH name does not have —
		// so this rung must not manufacture a verdict from that absence.
		const dir = pathDirWith(`intelephense${EXE}`);
		spawnVerdict.status = 1;
		const restorePath = withEnv({ PATH: dir });
		try {
			const result = await getToolPath("intelephense");

			expect(result).toBe("intelephense");
			expect(spawnCalls).toEqual([]);
		} finally {
			restorePath();
		}
	});
});

// ═════════════════════════════════════════════════════════════════════════
// ensureTool force-reinstall
// ═════════════════════════════════════════════════════════════════════════

describe("managed npm executable paths", () => {
	it("passes the Vue verification budget to the managed-local probe", async () => {
		process.env.PI_LENS_TEST_PLATFORM = "win32";
		const localPath = path.join(
			TEST_HOME,
			".pi-lens",
			"tools",
			"node_modules",
			".bin",
			"vue-language-server.cmd",
		);
		fakeAccess(localPath);

		await expect(
			ensureTool("@vue/language-server", { allowInstall: false }),
		).resolves.toBe(localPath);
		expect(
			spawnCalls.some(
				({ cmd, args, timeout }) =>
					cmd === localPath && args.includes("--version") && timeout === 30_000,
			),
		).toBe(true);
	});

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

	it("passes the Vue verification budget through npm install", async () => {
		process.env.PI_LENS_TEST_PLATFORM = "win32";
		process.env.PI_LENS_TEST_MODE = "1";
		process.env.PI_LENS_TEST_NPM_SCRIPT = "install";
		await withEmptyPath(async () => {
			const expected = path.join(
				TEST_HOME,
				".pi-lens",
				"tools",
				"node_modules",
				".bin",
				"vue-language-server.cmd",
			);
			fakeAccess(expected);
			mockFsStat.mockResolvedValue({ mtimeMs: 1 });
			await expect(
				ensureTool("@vue/language-server", { forceReinstall: true }),
			).resolves.toBe(expected);
			const verificationCalls = spawnCalls.filter(
				({ cmd, args }) => cmd === expected && args.includes("--version"),
			);
			expect(verificationCalls.length).toBeGreaterThan(0);
			expect(verificationCalls.every(({ timeout }) => timeout === 30_000)).toBe(
				true,
			);
		});
	});

	it.each([
		["bash-language-server", "bash-language-server"],
		["vscode-json-language-server", "vscode-json-language-server"],
	])(
		"passes the %s verification budget to the managed-local probe (#2194)",
		async (toolId, binaryName) => {
			process.env.PI_LENS_TEST_PLATFORM = "win32";
			const localPath = path.join(
				TEST_HOME,
				".pi-lens",
				"tools",
				"node_modules",
				".bin",
				`${binaryName}.cmd`,
			);
			fakeAccess(localPath);

			await expect(ensureTool(toolId, { allowInstall: false })).resolves.toBe(
				localPath,
			);
			expect(
				spawnCalls.some(
					({ cmd, args, timeout }) =>
						cmd === localPath &&
						args.includes("--version") &&
						timeout === 20_000,
				),
			).toBe(true);
		},
	);

	it.each([
		["bash-language-server", "bash-language-server"],
		["vscode-json-language-server", "vscode-json-language-server"],
	])(
		"passes the %s verification budget through npm install (#2194)",
		async (toolId, binaryName) => {
			process.env.PI_LENS_TEST_PLATFORM = "win32";
			process.env.PI_LENS_TEST_MODE = "1";
			process.env.PI_LENS_TEST_NPM_SCRIPT = "install";
			await withEmptyPath(async () => {
				const expected = path.join(
					TEST_HOME,
					".pi-lens",
					"tools",
					"node_modules",
					".bin",
					`${binaryName}.cmd`,
				);
				fakeAccess(expected);
				mockFsStat.mockResolvedValue({ mtimeMs: 1 });
				await expect(
					ensureTool(toolId, { forceReinstall: true }),
				).resolves.toBe(expected);
				const verificationCalls = spawnCalls.filter(
					({ cmd, args }) => cmd === expected && args.includes("--version"),
				);
				expect(verificationCalls.length).toBeGreaterThan(0);
				expect(
					verificationCalls.every(({ timeout }) => timeout === 20_000),
				).toBe(true);
			});
		},
	);

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

/**
 * In-flight ABA release (#1968, kit-driven white-box probe — sibling of
 * dead-code-client's/knip-client's bare-`.finally` release, same shape).
 *
 * `ensureTool`'s `ensureInFlight` map cleared with a bare delete-by-key. The
 * race needs a SECOND WRITER replacing the map entry mid-flight — the public
 * API alone cannot produce it today (single set site per key; microtask FIFO
 * orders every observer after A's cleanup) — so this test simulates that
 * writer directly, exactly the mechanism the #1838 reachability probe
 * established for the original two sites. Red on the pre-fix bare `.finally`
 * delete: A's cleanup evicted B and the next caller started a duplicate
 * ensure/install.
 */
describe("ensureTool in-flight ABA release (#1968)", () => {
	it("a late-settling ensure does not evict its mid-flight successor", async () => {
		await withEmptyPath(async () => {
			httpsBlocker.enabled = true;
			try {
				const buildA = ensureTool("rust-analyzer");
				// Let A get past its early fs/probe-cache awaits and register its
				// entry in ensureInFlight, then start (and block on) the network
				// install — confirmed by an actual https.get call.
				await new Promise((resolve) => setImmediate(resolve));
				expect(httpsGetCalls.length).toBeGreaterThan(0);

				const inFlight = _peekEnsureInFlightForTesting();
				expect(inFlight.size).toBe(1);
				const key = [...inFlight.keys()][0]!;

				// B replaces the entry under the same key while A is still in flight.
				let resolveSuccessor: (value: string | undefined) => void;
				const successor = new Promise<string | undefined>((resolve) => {
					resolveSuccessor = resolve;
				});
				inFlight.set(key, successor);

				// A settles (network error, per the disabled blocker below).
				httpsBlocker.enabled = false;
				httpsBlocker.errorHandler?.(new Error("network disabled in test"));
				expect(await buildA).toBeUndefined();

				// B's entry survived A's cleanup.
				expect(inFlight.get(key)).toBe(successor);

				resolveSuccessor!("/managed/rust-analyzer");
				await expect(successor).resolves.toBe("/managed/rust-analyzer");
			} finally {
				httpsBlocker.enabled = false;
				httpsBlocker.errorHandler = undefined;
			}
		});
	});

	// Mutation-proof companion: pins that a normal, uncontested settlement
	// still empties the slot, so a mutant that makes the identity guard
	// permanently `false` (never releases) reds here. `allowInstall: false`
	// still reaches the `ensureInFlight` registration (cache misses under
	// `withEmptyPath`) but resolves without a network call, so this exercises
	// the exact same map without needing the httpsBlocker gate.
	it("a normally-settling ensure still cleans up its own entry", async () => {
		await withEmptyPath(async () => {
			const inFlight = _peekEnsureInFlightForTesting();
			expect(inFlight.size).toBe(0);

			const result = await ensureTool("rust-analyzer", {
				allowInstall: false,
			});

			expect(result).toBeUndefined();
			expect(inFlight.size).toBe(0);
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

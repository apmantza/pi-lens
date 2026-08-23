import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../support/with-env.js";

vi.unmock("../../../clients/installer/index.js");

// This file deliberately exercises the REAL getGlobalPiLensDir() resolver
// (mirrors tool-discovery.test.ts's setup) so TOOLS_DIR paths resolve
// deterministically against a mocked home directory.
vi.hoisted(() => {
	delete process.env.PI_LENS_HOME;
});

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

const mockFsAccess = vi.hoisted(() => vi.fn());
const mockFsReadFile = vi.hoisted(() => vi.fn());
const mockFsStat = vi.hoisted(() => vi.fn());
const mockFsWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsOpen = vi.hoisted(() =>
	vi.fn().mockResolvedValue({
		writeFile: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
	}),
);
const mockFsRm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsAppendFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsChmod = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("node:fs/promises", () => ({
	default: {
		readFile: mockFsReadFile,
		access: mockFsAccess,
		stat: mockFsStat,
		writeFile: mockFsWriteFile,
		mkdir: mockFsMkdir,
		open: mockFsOpen,
		rm: mockFsRm,
		appendFile: mockFsAppendFile,
		chmod: mockFsChmod,
	},
	readFile: mockFsReadFile,
	access: mockFsAccess,
	stat: mockFsStat,
	writeFile: mockFsWriteFile,
	mkdir: mockFsMkdir,
	open: mockFsOpen,
	rm: mockFsRm,
	appendFile: mockFsAppendFile,
	chmod: mockFsChmod,
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

// child_process spawn mock: `--version` probes resolve to a configurable
// stdout string so tests can simulate an installed binary reporting an old
// (drifted) or current (matching) version. Non-`--version` spawns (npm
// install itself) resolve success with no output, so the reinstall path
// exercised by the drift tests doesn't need a real npm.
const spawnCalls = vi.hoisted(
	() => [] as Array<{ cmd: string; args: string[] }>,
);
const versionOutput = vi.hoisted(() => ({ value: "" }));

const mockSpawn = vi.hoisted(() =>
	vi.fn((cmd: string, args: string[], _opts?: unknown) => {
		spawnCalls.push({ cmd, args });
		const handlers: Record<string, (code?: number) => void> = {};
		const isVersionProbe =
			args.includes("--version") ||
			(typeof cmd === "string" && cmd.includes("--version"));
		const stdoutHandlers: Array<(data: string) => void> = [];
		const proc = {
			on: vi.fn((event: string, cb: unknown) => {
				handlers[event] = cb as (code?: number) => void;
				return proc;
			}),
			stdout: {
				on: vi.fn((event: string, cb: (data: string) => void) => {
					if (event === "data") stdoutHandlers.push(cb);
				}),
				setEncoding: vi.fn(),
			},
			stderr: { on: vi.fn(), setEncoding: vi.fn() },
			kill: vi.fn(),
			pid: 1234,
			killed: false,
		};
		setImmediate(() => {
			if (isVersionProbe && versionOutput.value) {
				for (const cb of stdoutHandlers) cb(versionOutput.value);
			}
			handlers.exit?.(0);
			handlers.close?.(0);
		});
		return proc;
	}),
);

const mockSpawnSync = vi.hoisted(() =>
	vi.fn(() => ({ status: 0, stdout: "", stderr: "", error: undefined })),
);

vi.mock("node:child_process", () => ({
	spawn: mockSpawn,
	spawnSync: mockSpawnSync,
}));

// #2015: verifyToolBinary probes (and installNpmTool's npm-install spawn)
// route through `safeSpawnAsync`, so that seam is mocked here too and every
// invocation is recorded into the same `spawnCalls` log. `--version` probes
// resolve to the configurable `versionOutput` string so tests can simulate an
// installed binary reporting a drifted or matching version; everything else
// resolves success with no output, so the reinstall path exercised by the
// drift tests doesn't need a real npm.
vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: async (command: string, args: string[]) => {
		const cmd = String(command);
		const argv = args ?? [];
		spawnCalls.push({ cmd, args: argv });
		if (argv.includes("--version") || cmd.includes("--version")) {
			return versionOutput.value
				? { stdout: versionOutput.value, stderr: "", status: 0 }
				: { stdout: "", stderr: "cannot execute", status: 126 };
		}
		return { stdout: "", stderr: "", status: 0 };
	},
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

// isCommandAvailable (the PATH-walk used to resolve a BARE checkCommand, e.g.
// "madge") reads `node:fs`'s statSync directly — it never touches the
// `node:fs/promises` mock above. Mirrors path-walk-memo.test.ts's pattern.
// Default behavior delegates to the REAL statSync: safeSpawnAsync (used by
// installTool's npm-install spawn) also calls statSync(cwd) as a preflight,
// against a real, existing directory — overriding it wholesale would break
// every install-spawning test in this file, not just the new PATH-walk one.
const mockStatSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	mockStatSync.mockImplementation(
		(...args: Parameters<typeof actual.statSync>) => actual.statSync(...args),
	);
	return { ...actual, statSync: mockStatSync };
});

import * as path from "node:path";
import {
	ensureTool,
	getToolPath,
	resetResolvedPathCache,
	resetProbeCacheStateForTesting,
	TOOLS,
} from "../../../clients/installer/index.js";

const TOOLS_DIR = path.join(TEST_HOME, ".pi-lens", "tools");
const JSCPD_BIN = path.join(
	TOOLS_DIR,
	"node_modules",
	".bin",
	process.platform === "win32" ? "jscpd.cmd" : "jscpd",
);
const MADGE_BIN = path.join(
	TOOLS_DIR,
	"node_modules",
	".bin",
	process.platform === "win32" ? "madge.cmd" : "madge",
);

// Read the CURRENT pin straight off the TOOLS registry rather than
// hardcoding it — jscpd's pin has already moved once (#582: 3.5.10 -> 5.0.12)
// and will again; a hardcoded "matching" version silently rots into a false
// "drift" as soon as the pin changes again, which is exactly what happened
// here (CI caught a rebase that picked up a newer pin after this test was
// written against the older one). "0.0.1" as the stale probe is guaranteed to
// differ from any real semver pin pi-lens would plausibly use.
const jscpdTool = TOOLS.find((t) => t.id === "jscpd");
if (!jscpdTool?.packageName?.includes("@")) {
	throw new Error(
		"tests/clients/installer/version-drift.test.ts assumes the jscpd TOOLS entry has a pinned '<pkg>@<version>' packageName — update this fixture if that entry's shape changes.",
	);
}
const JSCPD_PINNED_VERSION = jscpdTool.packageName.slice(
	jscpdTool.packageName.lastIndexOf("@") + 1,
);
const JSCPD_STALE_VERSION = "0.0.1";

function fakeAccess(...allowed: string[]): void {
	const set = new Set(allowed);
	mockFsAccess.mockImplementation(async (p: string) => {
		if (set.has(p)) return;
		throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
	});
}

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
	versionOutput.value = "";
	resetProbeCacheStateForTesting();
	// A bare-command positive (no fs.access, no probe-cache fallback) does not
	// self-heal like a fully-qualified one does when fakeAccess() below denies
	// everything — it would otherwise leak from one test into the next.
	resetResolvedPathCache();
	mockFsReadFile.mockRejectedValue(new Error("ENOENT"));
	mockFsStat.mockResolvedValue({ mtimeMs: Date.now() });
	fakeAccess(/* nothing */);
	mockStatSync.mockClear();
});

afterEach(() => {
	restoreDisableToolInstall();
	if (savedPiLensHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = savedPiLensHome;
	vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════
// #589 — pinned-npm-tool version-drift detection
// ═════════════════════════════════════════════════════════════════════════

describe("version-pin drift detection (#589)", () => {
	it("forces reinstall when the installed jscpd version no longer matches the pin", async () => {
		fakeAccess(JSCPD_BIN);
		versionOutput.value = `${JSCPD_STALE_VERSION}\n`; // stale vs. the current TOOLS pin

		const result = await ensureTool("jscpd");

		// getToolPath's slow path spawned --version, saw a version that doesn't
		// match the pin, and ensureTool routed through forceReinstall — which
		// attempts installTool (an npm install spawn) rather than resolving
		// straight to the stale managed binary.
		const installSpawns = spawnCalls.filter(
			(c) => !c.args.includes("--version") && !c.cmd.includes("--version"),
		);
		expect(installSpawns.length).toBeGreaterThan(0);
		// forceReinstall re-probes after "install" — since the mocked binary on
		// disk still reports the stale version, it correctly does NOT resolve as
		// a fresh, matching install.
		expect(result).not.toBeUndefined();
	});

	it("resolves normally without forcing reinstall when the installed version matches the pin", async () => {
		fakeAccess(JSCPD_BIN);
		versionOutput.value = `${JSCPD_PINNED_VERSION}\n`; // matches the current TOOLS pin

		const result = await ensureTool("jscpd");

		expect(result).toBe(JSCPD_BIN);
		const installSpawns = spawnCalls.filter(
			(c) => !c.args.includes("--version") && !c.cmd.includes("--version"),
		);
		expect(installSpawns).toHaveLength(0);
	});

	it("does not spawn a second probe for a cache hit on a matching-version tool", async () => {
		fakeAccess(JSCPD_BIN);
		versionOutput.value = `${JSCPD_PINNED_VERSION}\n`;

		const first = await ensureTool("jscpd");
		expect(first).toBe(JSCPD_BIN);

		spawnCalls.length = 0;
		const second = await ensureTool("jscpd");

		expect(second).toBe(JSCPD_BIN);
		// In-memory resolvedPathCache fast path — no new spawn on the second call.
		expect(spawnCalls).toHaveLength(0);
	});

	it("clears the positive path cache so the next ensure rechecks the tool", async () => {
		fakeAccess(JSCPD_BIN);
		versionOutput.value = `${JSCPD_PINNED_VERSION}\n`;
		expect(await ensureTool("jscpd")).toBe(JSCPD_BIN);
		spawnCalls.length = 0;

		resetResolvedPathCache();
		expect(await ensureTool("jscpd")).toBe(JSCPD_BIN);
		expect(mockFsAccess).toHaveBeenCalledTimes(2);
	});

	// #1902 review: the test above only proves the reset works for a FULLY
	// QUALIFIED cached path, which takes the fs.access branch at
	// installer/index.ts:5015-5018 — a branch that never needed the reset,
	// because a stale fully-qualified positive is already evicted on its own
	// the next time fs.access rejects it. resetResolvedPathCache's actual
	// reason to exist is the BARE-command branch at :5011-5014, where a
	// checkCommand resolved off PATH (madge here — unpinned npm tool, no
	// version-drift complication) is cached and returned from the in-memory
	// session cache with NO fs.access, NO re-probe, and NO way to self-heal
	// mid-session. Neutering resetResolvedPathCache's body leaves the test
	// above green but must turn this one red.
	it("clears the positive path cache for a bare, PATH-resolved tool so the next ensure re-discovers it", async () => {
		const savedPath = process.env.PATH;
		process.env.PATH = TEST_HOME;
		const realStatSync = mockStatSync.getMockImplementation();
		try {
			mockStatSync.mockImplementation(
				() => ({ isFile: () => true, size: 1 }) as never,
			);

			const first = await ensureTool("madge");
			expect(first).toBe("madge");
			const statCallsAfterFirst = mockStatSync.mock.calls.length;
			expect(statCallsAfterFirst).toBeGreaterThan(0);

			// Same-session re-ensure: fast path 1 (session-cache) returns the bare
			// cached command directly — no fs.access, no fresh PATH walk.
			const second = await ensureTool("madge");
			expect(second).toBe("madge");
			expect(mockStatSync.mock.calls.length).toBe(statCallsAfterFirst);

			resetResolvedPathCache();

			// A fresh session must not trust the stale bare positive — it has to
			// re-walk PATH, because a bare command has no persistent probe-cache
			// fallback (updateProbeCache stats the resolved path and swallows a
			// bare command's ENOENT).
			const third = await ensureTool("madge");
			expect(third).toBe("madge");
			expect(mockStatSync.mock.calls.length).toBeGreaterThan(
				statCallsAfterFirst,
			);
		} finally {
			if (realStatSync) mockStatSync.mockImplementation(realStatSync);
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
		}
	});

	it("evicts a cached positive when the resolved binary is deleted", async () => {
		fakeAccess(JSCPD_BIN);
		versionOutput.value = `${JSCPD_PINNED_VERSION}\n`;
		expect(await ensureTool("jscpd")).toBe(JSCPD_BIN);

		fakeAccess();
		process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";
		expect(await ensureTool("jscpd")).toBeUndefined();
		expect(mockFsAccess).toHaveBeenCalledWith(JSCPD_BIN);
	});

	it("skips drift detection entirely for an unpinned npm tool (madge)", async () => {
		fakeAccess(MADGE_BIN);
		versionOutput.value = "9.9.9\n"; // any output — madge has no version pin

		const result = await ensureTool("madge");

		expect(result).toBe(MADGE_BIN);
		const installSpawns = spawnCalls.filter(
			(c) => !c.args.includes("--version") && !c.cmd.includes("--version"),
		);
		expect(installSpawns).toHaveLength(0);
	});

	it("getToolPath resolves the pinned tool regardless of drift (discovery is not gated on version)", async () => {
		fakeAccess(JSCPD_BIN);
		versionOutput.value = `${JSCPD_STALE_VERSION}\n`; // stale

		const result = await getToolPath("jscpd");

		// getToolPath itself still reports the binary as found — drift routing
		// through forceReinstall is ensureTool's responsibility, not
		// getToolPath's, per #589's design (piggyback on the existing spawn,
		// don't change what "installed" means for direct getToolPath callers).
		expect(result).toBe(JSCPD_BIN);
	});
});

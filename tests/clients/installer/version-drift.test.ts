import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.ts");

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
const mockFsAppendFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsChmod = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("node:fs/promises", () => ({
	default: {
		readFile: mockFsReadFile,
		access: mockFsAccess,
		stat: mockFsStat,
		writeFile: mockFsWriteFile,
		mkdir: mockFsMkdir,
		appendFile: mockFsAppendFile,
		chmod: mockFsChmod,
	},
	readFile: mockFsReadFile,
	access: mockFsAccess,
	stat: mockFsStat,
	writeFile: mockFsWriteFile,
	mkdir: mockFsMkdir,
	appendFile: mockFsAppendFile,
	chmod: mockFsChmod,
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

import * as path from "node:path";
import {
	ensureTool,
	getToolPath,
	resetProbeCacheStateForTesting,
	TOOLS,
} from "../../../clients/installer/index.ts";

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

beforeEach(() => {
	delete process.env.PI_LENS_HOME;
	vi.clearAllMocks();
	spawnCalls.length = 0;
	versionOutput.value = "";
	resetProbeCacheStateForTesting();
	mockFsReadFile.mockRejectedValue(new Error("ENOENT"));
	mockFsStat.mockResolvedValue({ mtimeMs: Date.now() });
	fakeAccess(/* nothing */);
});

afterEach(() => {
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

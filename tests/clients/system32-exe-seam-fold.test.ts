/**
 * Every pi-lens spawn of a System32 executable names it through `windowsExe`
 * (`scripts/lib/process-scan.mjs`, reached from `clients/` through
 * `clients/process-snapshot.ts`).
 *
 * Recurrence this guards: AGENTS.md shape 83 (a rule re-derived beside its
 * owner). Ten production sites spelled the pin by hand
 * (`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\<exe>`) next to the
 * seam that already owns it, so the rule had eleven copies. Each cell below
 * drives one former copy through its production caller on a stubbed `win32`
 * platform, with `SystemRoot` spelled the way a raw concatenation would NOT
 * read it (forward slashes, a trailing slash). The seam answers a normalized
 * Windows path; a site that still concatenates answers
 * `Z:/Sentinel Root/\System32\...` and reds. Nothing mocks the seam: only
 * the child-process boundary is doubled, so the string asserted is the one the
 * real `windowsExe` produced inside the real caller.
 *
 * The `killPidTreeSync` copy (safe-spawn's exit-time tree kill) is driven by
 * `tests/clients/safe-spawn-kill-ownership.test.ts`, whose exact-string
 * expectation also holds with the seam in place.
 */
// flake-shape: real-process-spawn — the taskkill tree-kill case needs a real live child of this process: safeSpawnAsync's ownership guard reads its /proc ppid, which no double carries; the mock beside it on the same module would otherwise hide that spawn (#5064)
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeTempDirSync } from "./test-utils.js";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Spelled so that raw concatenation and the seam's answer differ. */
const SENTINEL_SYSTEM_ROOT = "Z:/Sentinel Root/";
const system32 = (exe: string): string => `Z:\\Sentinel Root\\System32\\${exe}`;

class FakeStream extends EventEmitter {
	write() {
		return true;
	}
	end() {}
	setEncoding() {}
}

class FakeChild extends EventEmitter {
	stdin = new FakeStream();
	stdout = new FakeStream();
	stderr = new FakeStream();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
	unref() {}
	constructor(public pid: number) {
		super();
	}
}

interface SpawnCall {
	command: string;
	args: readonly string[];
}

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let savedSystemRoot: string | undefined;

function stubPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}

beforeEach(() => {
	savedSystemRoot = process.env.SystemRoot;
	process.env.SystemRoot = SENTINEL_SYSTEM_ROOT;
});

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
	if (savedSystemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = savedSystemRoot;
	vi.doUnmock("node:child_process");
	vi.doUnmock("node:fs");
	vi.resetModules();
});

/**
 * A `node:child_process` double that records every start. `spawn` answers a
 * child per `makeChild`; `spawnSync` answers a clean exit.
 */
function doubleChildProcess(makeChild: (call: SpawnCall) => FakeChild): {
	spawns: SpawnCall[];
	syncs: SpawnCall[];
} {
	const spawns: SpawnCall[] = [];
	const syncs: SpawnCall[] = [];
	vi.doMock("node:child_process", () => ({
		spawn: vi.fn((command: string, args: readonly string[]) => {
			const call = { command, args };
			spawns.push(call);
			return makeChild(call);
		}),
		spawnSync: vi.fn((command: string, args: readonly string[]) => {
			syncs.push({ command, args });
			return { status: 0, stdout: "", stderr: "", pid: 0, signal: null };
		}),
		execSync: vi.fn(() => ""),
		execFileSync: vi.fn(() => ""),
	}));
	return { spawns, syncs };
}

/** `C:\fixture\tool.cmd` and `C:\fixture\tool.exe` exist as files; every other stat is real. */
function doubleFixtureToolsOnDisk(): void {
	vi.doMock("node:fs", async (importOriginal) => {
		const actual = await importOriginal<typeof import("node:fs")>();
		return {
			...actual,
			default: actual,
			statSync: (file: unknown, ...rest: unknown[]) => {
				if (
					file === "C:\\fixture\\tool.cmd" ||
					file === "C:\\fixture\\tool.exe"
				)
					return { isFile: () => true };
				return (actual.statSync as (...args: unknown[]) => unknown)(
					file,
					...rest,
				);
			},
		};
	});
}

/** A child that closes as soon as it is started. */
function closingChild(pid: number): FakeChild {
	const child = new FakeChild(pid);
	setImmediate(() => child.emit("close", 0, null));
	return child;
}

const SHIM_ENV = { PATH: "C:\\fixture", PATHEXT: ".CMD" };
const EXE_ENV = { PATH: "C:\\fixture", PATHEXT: ".EXE" };

async function trustProject(): Promise<void> {
	// #4530: this host reads the Windows-shaped PATH as a relative directory
	// under the session cwd, so the session's trust is adopted.
	const { setProjectTrustState } =
		await import("../../clients/project-trust.js");
	setProjectTrustState("trusted");
}

describe("safe-spawn names its System32 executables through the seam", () => {
	it("pins the UTF-8 code-page switch (chcp.com) in the cmd.exe command line", async () => {
		const { buildWindowsShellCommand } =
			await import("../../clients/safe-spawn.js");
		expect(
			buildWindowsShellCommand("tool", ["a"]).startsWith(
				`${system32("chcp.com")} 65001 >nul 2>&1 & `,
			),
		).toBe(true);
	});

	it("safeSpawnAsync runs a .cmd shim through the pinned cmd.exe, never ComSpec", async () => {
		stubPlatform("win32");
		const { spawns } = doubleChildProcess(() => closingChild(4101));
		doubleFixtureToolsOnDisk();
		const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
		await trustProject();

		await safeSpawnAsync("tool", ["x"], { env: SHIM_ENV });

		expect(spawns[0]?.command).toBe(system32("cmd.exe"));
		expect(String(spawns[0]?.args[3])).toContain(
			`${system32("chcp.com")} 65001`,
		);
	});

	it("the first direct .exe spawn runs the code-page one-shot through the pinned cmd.exe", async () => {
		stubPlatform("win32");
		const { spawns, syncs } = doubleChildProcess(() => closingChild(4104));
		doubleFixtureToolsOnDisk();
		const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
		await trustProject();

		await safeSpawnAsync("tool", [], { env: EXE_ENV });

		// ensureUtf8ConsoleCodePageOnce: the first Windows spawn of the process.
		expect(syncs.map((call) => call.command)).toEqual([system32("cmd.exe")]);
		expect(syncs[0]?.args).toEqual(["/d", "/s", "/c", "chcp 65001 >nul 2>&1"]);
		expect(spawns[0]?.command).toBe("C:\\fixture\\tool.exe");
	});

	it("sync safeSpawn runs a .cmd shim through the pinned cmd.exe", async () => {
		stubPlatform("win32");
		const { syncs } = doubleChildProcess(() => new FakeChild(0));
		doubleFixtureToolsOnDisk();
		const { safeSpawn } = await import("../../clients/safe-spawn.js");
		await trustProject();

		safeSpawn("tool", ["x"], { env: SHIM_ENV });

		expect(syncs.map((call) => call.command)).toEqual([system32("cmd.exe")]);
		expect(String(syncs[0]?.args[3])).toContain(
			`${system32("chcp.com")} 65001`,
		);
	});

	it("the async timeout tree-kill spawns the pinned taskkill.exe", async () => {
		stubPlatform("win32");
		const { spawn: realSpawn } =
			await vi.importActual<typeof import("node:child_process")>(
				"node:child_process",
			);
		// A real child of this process: the pid the kill names is one we own. It
		// starts inside the try, so the finally kills it on every path.
		let owned: import("node:child_process").ChildProcess | undefined;
		try {
			owned = realSpawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
			const main = new FakeChild(owned.pid ?? 0);
			const { spawns } = doubleChildProcess((call) => {
				if (!call.command.endsWith("taskkill.exe")) return main;
				const killer = new FakeChild(4103);
				setImmediate(() => {
					killer.emit("close", 0, null);
					main.emit("close", null, "SIGKILL");
				});
				return killer;
			});
			doubleFixtureToolsOnDisk();
			const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
			await trustProject();

			await safeSpawnAsync("tool", [], { env: SHIM_ENV, timeout: 30 });

			const kill = spawns.find((call) => call.command.endsWith("taskkill.exe"));
			expect(kill?.command).toBe(system32("taskkill.exe"));
			expect(kill?.args).toEqual(["/F", "/T", "/PID", String(owned.pid)]);
		} finally {
			owned?.kill("SIGKILL");
		}
	});
});

describe("the LSP teardowns name taskkill.exe through the seam", () => {
	it("killProcessTree (clients/lsp/client.ts) spawns the pinned taskkill.exe", async () => {
		stubPlatform("win32");
		const { spawns } = doubleChildProcess(() => new FakeChild(4201));
		const { killProcessTree } = await import("../../clients/lsp/client.js");
		const proc = { kill: vi.fn(() => true), unref: vi.fn() };

		await killProcessTree(proc, 4242, { fast: true });

		expect(spawns.map((call) => call.command)).toEqual([
			system32("taskkill.exe"),
		]);
		expect(spawns[0]?.args).toEqual(["/F", "/T", "/PID", "4242"]);
	});
});

describe("the reaper names taskkill.exe through the seam", () => {
	it("terminateScannerChild tree-kills with the pinned taskkill.exe", async () => {
		stubPlatform("win32");
		const { spawns } = doubleChildProcess(() => closingChild(4401));
		const { terminateScannerChild } =
			await import("../../clients/instance-reaper.js");

		await terminateScannerChild(new FakeChild(2_147_000_001) as never, {
			kind: "orphan-backstop-scanner-escalated",
			timeoutMs: 1,
			verifyAttempts: 1,
			verifyIntervalMs: 0,
		});

		expect(spawns.map((call) => call.command)).toEqual([
			system32("taskkill.exe"),
		]);
		expect(spawns[0]?.args).toEqual(["/F", "/T", "/PID", "2147000001"]);
	});
});

// #5699 A3: a newly covered name cannot bypass Windows ownership checks.
// The real reaper and process-table parser run under win32 on every host;
// only the OS child-process and liveness boundaries are doubled.
interface WindowsRow {
	pid: number;
	command: string;
}

/**
 * One production `sweepUntrackedOrphans` on a stubbed `win32`: every row is a
 * ten-minute-old process under pid 4000, which is dead unless `alive` says
 * otherwise. Returns the pids `taskkill` was aimed at and the CIM query text.
 */
async function windowsBackstop(
	rows: readonly WindowsRow[],
	options: { alive?: boolean; parentStart?: string } = {},
): Promise<{ killed: number[]; queries: string[] }> {
	const { alive = false, parentStart = "2026-09-26T07:00:00Z" } = options;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-win-backstop-"));
	const previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = home;
	stubPlatform("win32");
	const probe = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
		if (pid === 4000 && alive) return true;
		throw Object.assign(new Error("no such process"), { code: "ESRCH" });
	}) as typeof process.kill);
	try {
		const queries: string[] = [];
		const table = rows
			.map((row) => `${row.pid}\t4000\t600000\t${row.command}\n`)
			.join("");
		const identities =
			rows
				.map((row) => `${row.pid}\t2026-09-26T08:00:00Z\t${row.command}\n`)
				.join("") + `4000\t${parentStart}\tunrelated.exe\n`;
		const { spawns } = doubleChildProcess((call) => {
			const child = new FakeChild(4402);
			setImmediate(() => {
				if (!call.command.endsWith("taskkill.exe")) {
					const script = call.args.at(-1) ?? "";
					const isTable = script.includes("TotalMilliseconds");
					if (isTable) queries.push(script);
					child.stdout.emit("data", isTable ? table : identities);
				}
				child.emit("close", 0, null);
			});
			return child;
		});
		vi.doUnmock("../../clients/process-snapshot.js");
		vi.resetModules();
		const { sweepUntrackedOrphans } =
			await import("../../clients/instance-reaper.js");
		const { LSP_SERVERS } = await import("../../clients/lsp/server.js");
		await sweepUntrackedOrphans({
			getServers: async () => LSP_SERVERS,
			force: true,
			graceMs: 0,
			allowGraceRetry: false,
			verifyAttempts: 1,
			verifyIntervalMs: 0,
		});
		const kills = spawns.filter((call) =>
			call.command.endsWith("taskkill.exe"),
		);
		expect(kills.some((call) => call.args.includes("4000"))).toBe(false);
		return { killed: kills.map((call) => Number(call.args[3])), queries };
	} finally {
		probe.mockRestore();
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
		removeTempDirSync(home);
	}
}

/** Rows numbered from 5001, and the sorted labels of the ones a sweep killed. */
async function killedLabels(
	forms: ReadonlyArray<readonly [label: string, command: string]>,
): Promise<string[]> {
	const { killed } = await windowsBackstop(
		forms.map(([, command], i) => ({ pid: 5001 + i, command })),
	);
	return killed.map((pid) => forms[pid - 5001][0]).sort();
}

describe("Windows registry-derived orphan ownership", () => {
	it.each([
		{
			state: "dead parent",
			alive: false,
			parentStart: "2026-09-26T07:00:00Z",
			reap: true,
		},
		{
			state: "live parent",
			alive: true,
			parentStart: "2026-09-26T07:00:00Z",
			reap: false,
		},
		{
			state: "reused ppid within DST margin",
			alive: true,
			parentStart: "2026-09-26T09:00:00Z",
			reap: false,
		},
		{
			state: "reused ppid beyond DST margin",
			alive: true,
			parentStart: "2026-09-26T09:00:00.001Z",
			reap: true,
		},
	])(
		"untagged server with $state preserves the ownership rule",
		async ({ alive, parentStart, reap }) => {
			const { killed } = await windowsBackstop(
				[{ pid: 5000, command: "C:\\tools\\gopls.exe" }],
				{ alive, parentStart },
			);
			expect(killed).toEqual(reap ? [5000] : []);
		},
	);
});

// #5699 review F1: Windows has no owner tag, so the command line is the whole
// proof that a process is a pi-lens server. Each LAUNCHED row is a real launch
// form of a shipped server, from how the server spawns and how its package or
// installer lays out the entry file. Recurrence it prevents: a registry marker
// matched as a substring of a directory or an argument, so a user's detached
// `node.exe C:\Users\me\ty\server.js` was killed as the `ty` server.
const LAUNCHED: ReadonlyArray<readonly [string, string]> = [
	["native own image", '"C:\\Users\\me\\go\\bin\\gopls.exe" -mode=stdio'],
	["native image with a flag", "C:\\tools\\opengrep.exe --lsp"],
	["native image, bare name", "rust-analyzer"],
	["tsgo own image", '"C:\\Program Files\\tsgo\\tsgo.exe" --lsp --stdio'],
	[
		"haskell wrapper image",
		"C:\\ghcup\\bin\\haskell-language-server-wrapper.exe --lsp",
	],
	[
		"node package directory (typescript-language-server)",
		'"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\typescript-language-server\\lib\\cli.mjs --stdio',
	],
	[
		"node package directory (pyright)",
		"node.exe C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\pyright\\langserver.index.js --stdio",
	],
	[
		"node bin file under a bare npm-shim node (yaml-language-server)",
		"node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\yaml-language-server\\bin\\yaml-language-server --stdio",
	],
	[
		"node bin file of another package (vscode-json-language-server)",
		'"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\vscode-langservers-extracted\\bin\\vscode-json-language-server" --stdio',
	],
	[
		"java launcher jar with a version (jdtls)",
		'"C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" -Declipse.application=org.eclipse.jdt.ls.core.id1 -Dosgi.bundles.defaultStartLevel=4 -jar C:\\eclipse\\plugins\\org.eclipse.equinox.launcher_1.6.900.v20240613-2009.jar -configuration C:\\eclipse\\config_win -data C:\\Users\\me\\ws',
	],
	[
		"java jar (groovy-language-server)",
		"java.exe -jar C:\\tools\\groovy-language-server\\build\\libs\\groovy-language-server-all.jar",
	],
	[
		"dotnet dll (csharp-ls)",
		'"C:\\Program Files\\dotnet\\dotnet.exe" C:\\Users\\me\\.dotnet\\tools\\.store\\csharp-ls\\0.14.0\\csharp-ls\\0.14.0\\tools\\net8.0\\any\\csharp-ls.dll',
	],
	[
		"pwsh script (PowerShellEditorServices)",
		'"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\me\\.pi-lens\\tools\\PowerShellEditorServices\\PowerShellEditorServices\\Start-EditorServices.ps1 -Stdio',
	],
	[
		"python pip launcher (jedi-language-server)",
		"python.exe C:\\Python312\\Scripts\\jedi-language-server.exe",
	],
	["ruby gem executable (ruby-lsp)", "ruby.exe C:\\Ruby33-x64\\bin\\ruby-lsp"],
];

// The review's three cases and the shapes around them: a marker that is a
// directory, an argument, a script's name under the wrong runtime, or only
// part of an image name. None may reach taskkill, however dead the parent.
const SPARED: ReadonlyArray<readonly [string, string]> = [
	[
		"ty directory",
		'"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\ty\\server.js',
	],
	["lean script under python", "python.exe lean.py"],
	["jdtls-notes directory", "java.exe -jar C:\\Users\\me\\jdtls-notes\\x.jar"],
	["dart directory", "node.exe C:\\work\\dart\\build.js"],
	["cue directory under python", "python.exe C:\\work\\cue\\gen.py"],
	["marker as an npm argument", "node.exe C:\\npm\\npm-cli.js install ty"],
	["marker as a later argument", "node.exe C:\\a\\x.js C:\\work\\ty"],
	[
		"marker inside a flag value",
		"node.exe C:\\a\\x.js --server=C:\\tools\\gopls.exe",
	],
	[
		"marker in a classpath",
		"java.exe -cp C:\\x\\org.eclipse.equinox.launcher_1.jar Main",
	],
	[
		"package name outside node_modules",
		"node.exe C:\\x\\yaml-language-server\\notes.js",
	],
	// Recurrence (#5699 F5): no spared row covered the node_modules adjacency,
	// so `parts.includes(name)` survived. A marker above a project's node_modules,
	// or inside another package, stays spared.
	[
		"project directory above its own node_modules",
		"node.exe C:\\dev\\ty\\node_modules\\vite\\bin\\vite.js",
	],
	[
		"marker directory below a package under node_modules",
		"node.exe C:\\p\\node_modules\\foo\\ty\\x.js",
	],
	["undeclared image", "C:\\Users\\me\\ty\\other.exe"],
	["image that only ends in the marker", "C:\\tools\\notgopls.exe"],
	["unbalanced quote", 'node.exe "C:\\unbalanced\\ty.js'],
	["no launched file", "node.exe"],
];

describe("Windows launch forms the backstop recognises", () => {
	it("kills an untagged orphan launched in each recognised form", async () => {
		expect(await killedLabels(LAUNCHED)).toEqual(
			LAUNCHED.map(([label]) => label).sort(),
		);
	});

	it("spares an untagged process that only mentions a marker", async () => {
		expect(await killedLabels(SPARED)).toEqual([]);
	});

	// Recurrence (#5699 F2): the CIM `Name` prefilter had no witness for a wrong
	// image set; `["node.exe"]` and `["nothing.exe"]` survived.
	it("asks the process table for the images the registry declares", async () => {
		const { queries } = await windowsBackstop([]);
		const asked = [...queries[0].matchAll(/Name = '([^']+)'/g)].map(
			(match) => match[1],
		);
		expect(asked).toEqual(
			expect.arrayContaining([
				"node.exe",
				"gopls.exe",
				"java.exe",
				"dotnet.exe",
				"pwsh.exe",
				"python.exe",
				"ruby.exe",
			]),
		);
	});
});

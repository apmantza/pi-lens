/**
 * package-manager: declaration detection (real lockfiles in temp dirs),
 * availability-aware resolution, command builders, and global-bin discovery.
 * `isCommandAvailableAsync`/`safeSpawnAsync` are mocked so the system's real
 * package managers never leak into the assertions.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	isCommandAvailableAsync: vi.fn(),
	safeSpawnAsync: vi.fn(),
}));
import {
	isCommandAvailableAsync,
	safeSpawnAsync,
} from "../../clients/safe-spawn.js";
import {
	_resetPackageManagerCache,
	allAvailableGlobalBinDirs,
	detectNodePackageManager,
	execArgs,
	findGlobalBinary,
	findNodeToolBinary,
	formatRunScript,
	globalInstallArgs,
	installArgs,
	pmBinary,
	resolveNodePackageManager,
	runScriptArgs,
} from "../../clients/package-manager.js";

const dirs: string[] = [];

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pm-"));
	dirs.push(dir);
	return dir;
}

function projectWith(files: Record<string, string>): string {
	const dir = tmpDir();
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), content);
	}
	return dir;
}

/** Make `isCommandAvailableAsync` resolve true only for the listed managers. */
function onlyAvailable(...available: string[]): void {
	const set = new Set(available);
	vi.mocked(isCommandAvailableAsync).mockImplementation(async (cmd) =>
		set.has(cmd),
	);
}

/** Override process.platform for a test; restored in afterEach. */
let savedPlatform: PropertyDescriptor | undefined;
function setPlatform(platform: NodeJS.Platform): void {
	savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform });
}

beforeEach(() => {
	_resetPackageManagerCache();
	vi.mocked(isCommandAvailableAsync).mockReset();
	vi.mocked(safeSpawnAsync).mockReset();
});

afterEach(() => {
	if (savedPlatform) {
		Object.defineProperty(process, "platform", savedPlatform);
		savedPlatform = undefined;
	}
});

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("detectNodePackageManager", () => {
	it("maps each lockfile to its manager", () => {
		expect(detectNodePackageManager(projectWith({ "bun.lock": "" }))).toBe(
			"bun",
		);
		expect(detectNodePackageManager(projectWith({ "bun.lockb": "" }))).toBe(
			"bun",
		);
		expect(
			detectNodePackageManager(projectWith({ "pnpm-lock.yaml": "" })),
		).toBe("pnpm");
		expect(detectNodePackageManager(projectWith({ "yarn.lock": "" }))).toBe(
			"yarn",
		);
		expect(
			detectNodePackageManager(projectWith({ "package-lock.json": "{}" })),
		).toBe("npm");
	});

	it("reads the corepack packageManager field when there is no lockfile", () => {
		const dir = projectWith({
			"package.json": JSON.stringify({ packageManager: "pnpm@8.15.0" }),
		});
		expect(detectNodePackageManager(dir)).toBe("pnpm");
	});

	it("prefers the lockfile over the packageManager field", () => {
		const dir = projectWith({
			"bun.lock": "",
			"package.json": JSON.stringify({ packageManager: "npm@10.0.0" }),
		});
		expect(detectNodePackageManager(dir)).toBe("bun");
	});

	it("returns undefined when nothing is declared", () => {
		expect(detectNodePackageManager(projectWith({}))).toBeUndefined();
		expect(
			detectNodePackageManager(
				projectWith({ "package.json": JSON.stringify({ name: "x" }) }),
			),
		).toBeUndefined();
	});
});

describe("resolveNodePackageManager", () => {
	it("uses the declared manager when it is installed", async () => {
		onlyAvailable("bun", "npm");
		const dir = projectWith({ "bun.lock": "" });
		expect(await resolveNodePackageManager(dir)).toBe("bun");
	});

	it("falls back by preference when the declared manager is missing", async () => {
		// Project declares bun, but only npm is installed.
		onlyAvailable("npm");
		const dir = projectWith({ "bun.lock": "" });
		expect(await resolveNodePackageManager(dir)).toBe("npm");
	});

	it("picks the only installed manager when nothing is declared (bun-only host)", async () => {
		onlyAvailable("bun");
		expect(await resolveNodePackageManager(projectWith({}))).toBe("bun");
	});

	it("prefers npm when several are installed and nothing is declared", async () => {
		onlyAvailable("npm", "pnpm", "yarn", "bun");
		expect(await resolveNodePackageManager(projectWith({}))).toBe("npm");
	});

	it("falls back to npm when no manager is installed", async () => {
		onlyAvailable();
		expect(await resolveNodePackageManager(projectWith({}))).toBe("npm");
	});
});

describe("command builders", () => {
	it("runScriptArgs is `run <script>` for every manager", () => {
		expect(runScriptArgs("build")).toEqual(["run", "build"]);
	});

	it("formatRunScript renders a bare display command", () => {
		expect(formatRunScript("pnpm", "build")).toBe("pnpm run build");
		expect(formatRunScript("bun", "test")).toBe("bun run test");
	});

	it("installArgs uses install for npm and add for the rest", () => {
		expect(installArgs("npm", "biome")).toEqual(["install", "biome"]);
		expect(installArgs("pnpm", "biome")).toEqual(["add", "biome"]);
		expect(installArgs("yarn", "biome")).toEqual(["add", "biome"]);
		expect(installArgs("bun", "biome")).toEqual(["add", "biome"]);
	});

	it("installArgs threads ignore-scripts and npm-only legacy-peer-deps", () => {
		expect(
			installArgs("npm", "biome", { ignoreScripts: true, legacyPeerDeps: true }),
		).toEqual(["install", "--ignore-scripts", "--legacy-peer-deps", "biome"]);
		// legacy-peer-deps is silently dropped for non-npm managers.
		expect(
			installArgs("bun", "biome", { ignoreScripts: true, legacyPeerDeps: true }),
		).toEqual(["add", "--ignore-scripts", "biome"]);
	});

	it("globalInstallArgs spells the global install per manager", () => {
		expect(globalInstallArgs("npm", "typescript-language-server")).toEqual([
			"install", "-g", "typescript-language-server",
		]);
		expect(globalInstallArgs("pnpm", "typescript-language-server")).toEqual([
			"add", "-g", "typescript-language-server",
		]);
		expect(globalInstallArgs("bun", "typescript-language-server")).toEqual([
			"add", "-g", "typescript-language-server",
		]);
		// yarn classic uses `global add`.
		expect(globalInstallArgs("yarn", "typescript-language-server")).toEqual([
			"global", "add", "typescript-language-server",
		]);
	});

	it("execArgs maps to each manager's package runner", () => {
		setPlatform("linux"); // pin platform — the Windows spelling is asserted below
		expect(execArgs("npm", "pkg")).toEqual({
			command: "npx",
			args: ["--no", "pkg"],
		});
		expect(execArgs("bun", "pkg", ["--stdio"])).toEqual({
			command: "bun",
			args: ["x", "pkg", "--stdio"],
		});
		expect(execArgs("pnpm", "pkg")).toEqual({
			command: "pnpm",
			args: ["dlx", "pkg"],
		});
		expect(execArgs("yarn", "pkg")).toEqual({
			command: "yarn",
			args: ["dlx", "pkg"],
		});
	});

	it("pmBinary is the bare name on Unix", () => {
		setPlatform("linux");
		expect(pmBinary("npm")).toBe("npm");
		expect(pmBinary("bun")).toBe("bun");
	});

	it("pmBinary uses .cmd/.exe on Windows", () => {
		setPlatform("win32");
		expect(pmBinary("npm")).toBe("npm.cmd");
		expect(pmBinary("pnpm")).toBe("pnpm.cmd");
		expect(pmBinary("yarn")).toBe("yarn.cmd");
		expect(pmBinary("bun")).toBe("bun.exe");
		expect(execArgs("npm", "pkg").command).toBe("npx.cmd");
	});
});

describe("allAvailableGlobalBinDirs", () => {
	it("resolves the npm prefix to its bin dir on Unix", async () => {
		setPlatform("linux");
		onlyAvailable("npm");
		vi.mocked(safeSpawnAsync).mockResolvedValue({
			stdout: "/usr/local\n",
			stderr: "",
			status: 0,
		});
		// allAvailableGlobalBinDirs path.resolve()s each dir (dedup); resolve the
		// expected too so the assertion holds on Windows (drive-prefixed) as well.
		expect(await allAvailableGlobalBinDirs()).toEqual([
			path.resolve(path.join("/usr/local", "bin")),
		]);
	});

	it("uses BUN_INSTALL/bin without spawning for bun", async () => {
		setPlatform("linux");
		onlyAvailable("bun");
		const saved = process.env.BUN_INSTALL;
		process.env.BUN_INSTALL = "/opt/bun";
		try {
			expect(await allAvailableGlobalBinDirs()).toEqual([
				path.resolve(path.join("/opt/bun", "bin")),
			]);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			if (saved === undefined) delete process.env.BUN_INSTALL;
			else process.env.BUN_INSTALL = saved;
		}
	});

	it("returns nothing when no manager is installed", async () => {
		onlyAvailable();
		expect(await allAvailableGlobalBinDirs()).toEqual([]);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});
});

describe("findGlobalBinary", () => {
	/**
	 * Point npm's global prefix at a temp dir. npm's bin dir is `<prefix>/bin` on
	 * Unix but the prefix itself on Windows — mirror `globalBinDirsFor` so the
	 * file lands where `findGlobalBinary` actually looks.
	 */
	function npmGlobalPrefix(): { prefix: string; binDir: string } {
		const prefix = tmpDir();
		const binDir =
			process.platform === "win32" ? prefix : path.join(prefix, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		onlyAvailable("npm");
		vi.mocked(safeSpawnAsync).mockResolvedValue({
			stdout: `${prefix}\n`,
			stderr: "",
			status: 0,
		});
		return { prefix, binDir };
	}

	it("finds a bare binary in a manager's global bin dir (Unix)", async () => {
		setPlatform("linux");
		const { binDir } = npmGlobalPrefix();
		fs.writeFileSync(path.join(binDir, "prisma"), "#!/bin/sh\n");
		expect(await findGlobalBinary("prisma")).toBe(
			path.resolve(path.join(binDir, "prisma")),
		);
	});

	it("prefers the .cmd shim on Windows", async () => {
		setPlatform("win32");
		const { binDir } = npmGlobalPrefix();
		fs.writeFileSync(path.join(binDir, "prisma.cmd"), "@echo off\n");
		fs.writeFileSync(path.join(binDir, "prisma"), "#!/bin/sh\n");
		expect(await findGlobalBinary("prisma")).toBe(
			path.resolve(path.join(binDir, "prisma.cmd")),
		);
	});

	it("returns undefined when the binary is absent", async () => {
		setPlatform("linux");
		npmGlobalPrefix();
		expect(await findGlobalBinary("does-not-exist")).toBeUndefined();
	});

	it("returns undefined when no manager is installed", async () => {
		onlyAvailable();
		expect(await findGlobalBinary("prisma")).toBeUndefined();
	});
});

describe("findNodeToolBinary", () => {
	it("prefers a local node_modules/.bin, walking up from cwd", async () => {
		setPlatform("linux");
		onlyAvailable(); // no global manager — proves the local hit wins
		const root = tmpDir();
		const nested = path.join(root, "packages", "app", "src");
		fs.mkdirSync(nested, { recursive: true });
		const localBin = path.join(root, "node_modules", ".bin", "jscpd");
		fs.mkdirSync(path.dirname(localBin), { recursive: true });
		fs.writeFileSync(localBin, "#!/bin/sh\n");

		expect(await findNodeToolBinary("jscpd", nested)).toBe(localBin);
	});

	it("falls back to a manager's global bin dir when no local binary exists", async () => {
		setPlatform("linux");
		const prefix = tmpDir();
		const binDir = path.join(prefix, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(path.join(binDir, "madge"), "#!/bin/sh\n");
		onlyAvailable("npm");
		vi.mocked(safeSpawnAsync).mockResolvedValue({
			stdout: `${prefix}\n`,
			stderr: "",
			status: 0,
		});

		const cwd = tmpDir(); // clean project, no node_modules
		expect(await findNodeToolBinary("madge", cwd)).toBe(
			path.resolve(path.join(binDir, "madge")),
		);
	});

	it("returns undefined when neither local nor global has it", async () => {
		setPlatform("linux");
		onlyAvailable();
		expect(await findNodeToolBinary("nope", tmpDir())).toBeUndefined();
	});
});

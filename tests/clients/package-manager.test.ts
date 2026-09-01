/**
 * package-manager: declaration detection (real lockfiles in temp dirs),
 * availability-aware resolution, command builders, and global-bin discovery.
 * `safeSpawnAsync` is mocked so the system's real package managers never leak
 * into the assertions. The availability probe now spawns `where`/`which <pm>`
 * directly (#1496), so `onlyAvailable` mocks that call rather than the old
 * `isCommandAvailableAsync` wrapper.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";
import { waitFor } from "./interleaving-kit.js";
import { gatedPromise } from "../support/fault-injection.js";

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	isCommandAvailableAsync: vi.fn(),
	safeSpawnAsync: vi.fn(),
}));
import { SpawnFailureError, safeSpawnAsync } from "../../clients/safe-spawn.js";
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
	updateArgs,
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

/**
 * The availability probe spawns `where`/`which <pm>` directly (#1496); a
 * non-probe call (e.g. `npm config get prefix`, `pnpm bin -g`) falls through
 * to `queryResponder`, which individual tests set to answer those queries.
 */
let queryResponder:
	| ((
			cmd: string,
			args: string[],
	  ) => Promise<{
			stdout: string;
			stderr: string;
			status: number | null;
			error?: Error;
	  }>)
	| null = null;
/** Every non-probe (query) call `onlyAvailable`'s mock forwarded — asserts on this, not on `safeSpawnAsync` overall, since the availability probe itself now spawns too. */
let queryCalls: Array<{ cmd: string; args: string[] }> = [];

function setQueryResponder(
	responder: (
		cmd: string,
		args: string[],
	) => Promise<{
		stdout: string;
		stderr: string;
		status: number | null;
		error?: Error;
	}>,
): void {
	queryResponder = responder;
}

/** Make the `where`/`which <pm>` probe resolve available only for the listed managers. */
function onlyAvailable(...available: string[]): void {
	const set = new Set(available);
	vi.mocked(safeSpawnAsync).mockImplementation(async (cmd, args) => {
		const finder = process.platform === "win32" ? "where" : "which";
		if (cmd === finder) {
			const pm = (args ?? [])[0];
			// A real `where`/`which` runs fine and exits 1 when it finds
			// nothing — no spawn error. That is the "genuine absence" shape.
			return set.has(pm)
				? { stdout: `${pm}\n`, stderr: "", status: 0 }
				: { stdout: "", stderr: "", status: 1 };
		}
		queryCalls.push({ cmd, args: args ?? [] });
		if (queryResponder) return queryResponder(cmd, args ?? []);
		return { stdout: "", stderr: "", status: 1 };
	});
}

/** Override process.platform for a test; restored in afterEach. */
let savedPlatform: PropertyDescriptor | undefined;
function setPlatform(platform: NodeJS.Platform): void {
	savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform });
}

beforeEach(() => {
	_resetPackageManagerCache();
	vi.mocked(safeSpawnAsync).mockReset();
	queryResponder = null;
	queryCalls = [];
});

afterEach(() => {
	if (savedPlatform) {
		Object.defineProperty(process, "platform", savedPlatform);
		savedPlatform = undefined;
	}
});

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		removeTempDirSync(dir);
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
			installArgs("npm", "biome", {
				ignoreScripts: true,
				legacyPeerDeps: true,
			}),
		).toEqual(["install", "--ignore-scripts", "--legacy-peer-deps", "biome"]);
		// legacy-peer-deps is silently dropped for non-npm managers.
		expect(
			installArgs("bun", "biome", {
				ignoreScripts: true,
				legacyPeerDeps: true,
			}),
		).toEqual(["add", "--ignore-scripts", "biome"]);
	});

	it("updateArgs re-resolves a dependency per manager", () => {
		// The command that moves a dependency the lockfile already satisfies.
		// `install`/`add` is a no-op there, which is why pi-lens's managed tools
		// tree froze on its first-install versions (#1730).
		expect(updateArgs("npm", "knip")).toEqual(["update", "knip"]);
		expect(updateArgs("pnpm", "knip")).toEqual(["update", "knip"]);
		expect(updateArgs("bun", "knip")).toEqual(["update", "knip"]);
		// yarn classic spells it `upgrade`; `yarn update` is not a command.
		expect(updateArgs("yarn", "knip")).toEqual(["upgrade", "knip"]);
	});

	it("updateArgs threads ignore-scripts", () => {
		expect(updateArgs("npm", "knip", { ignoreScripts: true })).toEqual([
			"update",
			"--ignore-scripts",
			"knip",
		]);
		expect(updateArgs("yarn", "knip", { ignoreScripts: true })).toEqual([
			"upgrade",
			"--ignore-scripts",
			"knip",
		]);
		// Omitted by default: a package whose postinstall fetches its native
		// binary has to run that postinstall on update too.
		expect(updateArgs("npm", "@biomejs/biome")).toEqual([
			"update",
			"@biomejs/biome",
		]);
	});

	it("globalInstallArgs spells the global install per manager", () => {
		expect(globalInstallArgs("npm", "typescript-language-server")).toEqual([
			"install",
			"-g",
			"typescript-language-server",
		]);
		expect(globalInstallArgs("pnpm", "typescript-language-server")).toEqual([
			"add",
			"-g",
			"typescript-language-server",
		]);
		expect(globalInstallArgs("bun", "typescript-language-server")).toEqual([
			"add",
			"-g",
			"typescript-language-server",
		]);
		// yarn classic uses `global add`.
		expect(globalInstallArgs("yarn", "typescript-language-server")).toEqual([
			"global",
			"add",
			"typescript-language-server",
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
		setQueryResponder(async () => ({
			stdout: "/usr/local\n",
			stderr: "",
			status: 0,
		}));
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
			// bun's bin dir is deterministic — no query spawn beyond the probe.
			expect(queryCalls).toEqual([]);
		} finally {
			if (saved === undefined) delete process.env.BUN_INSTALL;
			else process.env.BUN_INSTALL = saved;
		}
	});

	it("returns nothing when no manager is installed", async () => {
		onlyAvailable();
		expect(await allAvailableGlobalBinDirs()).toEqual([]);
		// No manager passed its probe, so no query spawn was ever reached.
		expect(queryCalls).toEqual([]);
	});

	/**
	 * #1585 — `isAvailable`'s boolean collapse. pnpm's `where`/`which` probe
	 * stalls (a transient host failure, not a genuine absence). Pre-fix,
	 * `allAvailableGlobalBinDirs` had no way to tell its caller the `false` it
	 * got back for pnpm was a stall, not a fact — the tool-path resolver's
	 * `onTransient` plumbing (#1569) was never invoked, so the resulting
	 * bin-dir list (missing pnpm) could get cached untainted for 24h. Must
	 * FAIL on pre-fix code, where `allAvailableGlobalBinDirs` takes no
	 * `onTransient` parameter at all (a TS compile error) — verified red by
	 * reverting the fix and confirming the build fails.
	 */
	it("reports a stalled manager probe as transient, not a clean miss", async () => {
		setPlatform("linux");
		vi.mocked(safeSpawnAsync).mockImplementation(async (cmd, args) => {
			const probeFinder = process.platform === "win32" ? "where" : "which";
			if (cmd === probeFinder) {
				const target = (args ?? [])[0];
				if (target === "npm") return { stdout: "npm\n", stderr: "", status: 0 };
				if (target === "pnpm") {
					const cause = new Error("Process timed out after 5000ms");
					return {
						stdout: "",
						stderr: "",
						status: null,
						error: cause,
						failure: "timeout" as const,
						spawnFailure: new SpawnFailureError(
							"timeout",
							cause.message,
							cause,
						),
					};
				}
				// yarn, bun: genuinely absent.
				return { stdout: "", stderr: "", status: 1 };
			}
			// npm's "config get prefix" query.
			return { stdout: "/usr/local\n", stderr: "", status: 0 };
		});

		let transientCalls = 0;
		const dirs = await allAvailableGlobalBinDirs(() => {
			transientCalls += 1;
		});

		// pnpm's stall drops it from the result (npm still resolves normally) —
		// but the caller must have been told the result may be incomplete.
		expect(dirs).toEqual([path.resolve(path.join("/usr/local", "bin"))]);
		expect(transientCalls).toBeGreaterThan(0);

		// The stall latches transiently for its cooldown: a second call within
		// that window serves the cached `false` for pnpm without re-probing.
		// The regression is specifically that this MEMO path also loses the
		// transient signal — assert it still fires here, not just on the
		// fresh-probe path above.
		transientCalls = 0;
		await allAvailableGlobalBinDirs(() => {
			transientCalls += 1;
		});
		expect(transientCalls).toBeGreaterThan(0);
	});

	/**
	 * #1585 review — the precision half of the fix. A manager that fails its
	 * probe cleanly (`where`/`which` runs fine and exits 1: a real "not
	 * installed") must NOT call `onTransient`. Without this case, a broken
	 * implementation that fires `onTransient` on every `false` — transient or
	 * not — would pass the "stalled" test above just as well, defeating the
	 * whole point: distinguishing a stall from a genuine absence, not just
	 * noticing SOME `false`.
	 */
	it("does not report a genuinely absent manager as transient", async () => {
		setPlatform("linux");
		onlyAvailable("npm");

		let transientCalls = 0;
		const dirs = await allAvailableGlobalBinDirs(() => {
			transientCalls += 1;
		});

		expect(dirs).toEqual([]);
		expect(transientCalls).toBe(0);

		// The genuine absence latches: a second call re-reads the same durable
		// memo, still no transient report.
		await allAvailableGlobalBinDirs(() => {
			transientCalls += 1;
		});
		expect(transientCalls).toBe(0);
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
		setQueryResponder(async () => ({
			stdout: `${prefix}\n`,
			stderr: "",
			status: 0,
		}));
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

	/**
	 * #1602 — `globalBinDirsFor` re-spawned `npm config get prefix` (and its
	 * pnpm/yarn equivalents) on every `findGlobalBinary` miss, even though
	 * `isAvailable` above it is latched. Two misses must spawn the prefix
	 * lookup once. Must FAIL on pre-fix code (two query spawns).
	 */
	it("memoizes the per-manager global bin dir across findGlobalBinary misses", async () => {
		setPlatform("linux");
		npmGlobalPrefix(); // available, but no binary ever written — both calls miss
		expect(await findGlobalBinary("does-not-exist")).toBeUndefined();
		expect(await findGlobalBinary("still-not-there")).toBeUndefined();
		const npmQueries = queryCalls.filter((c) => c.cmd === "npm");
		expect(npmQueries.length).toBe(1);
	});

	/**
	 * #1602 review — the memo must not latch a transient bin-dir lookup
	 * failure the way a genuine absence would: npm already passed
	 * `isAvailable`'s own probe, so a failed `config get prefix` here is
	 * evidence about this one call, not about npm. A memo that cached every
	 * result — including an empty one — would keep serving no bin dirs for
	 * npm forever.
	 */
	it("does not latch a failed bin-dir lookup forever", async () => {
		setPlatform("linux");
		const prefix = tmpDir();
		const binDir = path.join(prefix, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(path.join(binDir, "prisma"), "#!/bin/sh\n");
		onlyAvailable("npm");
		let attempt = 0;
		setQueryResponder(async () => {
			attempt += 1;
			if (attempt === 1) return { stdout: "", stderr: "", status: 1 };
			return { stdout: `${prefix}\n`, stderr: "", status: 0 };
		});

		// First call: the prefix query fails — npm's bin dir can't be resolved.
		expect(await findGlobalBinary("prisma")).toBeUndefined();

		// Second call: the prefix query now succeeds.
		expect(await findGlobalBinary("prisma")).toBe(
			path.resolve(path.join(binDir, "prisma")),
		);
	});

	it("does not repopulate the bin-dir memo with a pre-reset result", async () => {
		setPlatform("linux");
		const oldPrefix = tmpDir();
		const oldBinDir = path.join(oldPrefix, "bin");
		const newPrefix = tmpDir();
		const newBinDir = path.join(newPrefix, "bin");
		fs.mkdirSync(oldBinDir, { recursive: true });
		fs.mkdirSync(newBinDir, { recursive: true });
		fs.writeFileSync(path.join(oldBinDir, "prisma"), "old\n");
		fs.writeFileSync(path.join(newBinDir, "prisma"), "new\n");
		onlyAvailable("npm");
		await resolveNodePackageManager(tmpDir());

		let queryAttempt = 0;
		const oldQuery = gatedPromise<{
			stdout: string;
			stderr: string;
			status: number;
		}>();
		setQueryResponder(async () => {
			queryAttempt += 1;
			if (queryAttempt === 1) return oldQuery.promise;
			return { stdout: `${newPrefix}\n`, stderr: "", status: 0 };
		});
		try {
			const oldLookup = findGlobalBinary("prisma");
			await waitFor(
				() => queryAttempt,
				(count) => count === 1,
			);

			_resetPackageManagerCache();
			const newLookup = findGlobalBinary("prisma");
			await expect(newLookup).resolves.toBe(
				path.resolve(path.join(newBinDir, "prisma")),
			);
			// Release the old probe only after the replacement has cached its result.
			oldQuery.resolve({ stdout: `${oldPrefix}\n`, stderr: "", status: 0 });
			await expect(oldLookup).resolves.toBe(
				path.resolve(path.join(oldBinDir, "prisma")),
			);
			await expect(findGlobalBinary("prisma")).resolves.toBe(
				path.resolve(path.join(newBinDir, "prisma")),
			);
			expect(queryAttempt).toBe(2);
		} finally {
			oldQuery.resolve({ stdout: `${oldPrefix}\n`, stderr: "", status: 0 });
		}
	});

	it("re-probes concurrently after a rejected pre-reset lookup", async () => {
		setPlatform("linux");
		const newPrefix = tmpDir();
		const newBinDir = path.join(newPrefix, "bin");
		fs.mkdirSync(newBinDir, { recursive: true });
		fs.writeFileSync(path.join(newBinDir, "prisma"), "new\n");
		onlyAvailable("npm");
		await resolveNodePackageManager(tmpDir());

		let queryAttempt = 0;
		const oldQuery = gatedPromise<{
			stdout: string;
			stderr: string;
			status: number;
		}>();
		const newQuery = gatedPromise<{
			stdout: string;
			stderr: string;
			status: number;
		}>();
		setQueryResponder(async () => {
			queryAttempt += 1;
			if (queryAttempt === 1) return oldQuery.promise;
			if (queryAttempt === 2) return newQuery.promise;
			return { stdout: `${newPrefix}\n`, stderr: "", status: 0 };
		});
		try {
			const oldLookup = findGlobalBinary("prisma");
			await waitFor(
				() => queryAttempt,
				(count) => count === 1,
			);

			_resetPackageManagerCache();
			const postResetLookups = [
				findGlobalBinary("prisma"),
				findGlobalBinary("prisma"),
			];
			await waitFor(
				() => queryAttempt,
				(count) => count === 2,
			);
			newQuery.resolve({ stdout: `${newPrefix}\n`, stderr: "", status: 0 });
			await expect(Promise.all(postResetLookups)).resolves.toEqual([
				path.resolve(path.join(newBinDir, "prisma")),
				path.resolve(path.join(newBinDir, "prisma")),
			]);

			oldQuery.reject(new Error("pre-reset global-bin probe failed"));
			await expect(oldLookup).resolves.toBeUndefined();
			await expect(findGlobalBinary("prisma")).resolves.toBe(
				path.resolve(path.join(newBinDir, "prisma")),
			);
			expect(queryAttempt).toBe(2);
		} finally {
			oldQuery.reject(new Error("release pre-reset probe"));
			newQuery.resolve({ stdout: `${newPrefix}\n`, stderr: "", status: 0 });
		}
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
		setQueryResponder(async () => ({
			stdout: `${prefix}\n`,
			stderr: "",
			status: 0,
		}));

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

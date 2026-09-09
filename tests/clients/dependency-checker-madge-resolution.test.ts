/**
 * #766: how `DependencyChecker` resolves the madge command.
 *
 * Resolution used to fall straight from `findNodeToolBinary` to `npx madge`,
 * never consulting the tools tree pi-lens itself installs madge into — so an
 * environment whose ONLY madge is the managed one paid npx module resolution on
 * every spawn, and it ran once per file inside the batch mapper (each miss
 * re-walking node_modules and re-spawning the uncached `npm config get prefix` /
 * `pnpm bin -g` global probes).
 *
 * These tests pin the resolution ORDER, that the discovery step can never
 * install, that `kind` is classified from the resolved string rather than the
 * step that produced it, and that the whole chain runs once per project root.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const findNodeToolBinary = vi.fn();
const ensureTool = vi.fn();
// #1276: the madge staleness check now revalidates bare (non-absolute)
// resolved commands via isSpawnableCommand. Defaulted to "still spawnable" in
// beforeEach so existing cache-hit assertions in this file aren't disturbed;
// tests that care about staleness override it explicitly.
const isSpawnableCommand = vi.fn();
const MANAGED_TOOLS_DIR = path.join(os.tmpdir(), "pilens-fake-home", "tools");
// Fake absolute paths standing in for a global-bin install, OUTSIDE the
// managed tree and any project root. Must be fully qualified under the
// HOST's semantics (`isFullyQualified` in clients/path-utils.ts) — on win32
// a bare "/usr/..." literal is ambient-drive-relative, not fully qualified,
// so `classifyMadgeKind`'s `isFullyQualified(resolved)` gate silently
// classifies it as "path" instead of "global" (same defect shape as #1491).
const GLOBAL_BIN_1 =
	process.platform === "win32"
		? String.raw`C:\fake-global\local\bin\madge`
		: "/usr/local/bin/madge";
const GLOBAL_BIN_2 =
	process.platform === "win32"
		? String.raw`C:\fake-global\bin\madge`
		: "/usr/bin/madge";

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary,
}));
vi.mock("../../clients/installer/index.js", () => ({
	// #2140: the probe resolver asks the installer for a release-managed
	// binary (`~/.pi-lens/bin`) before falling back to PATH. Undefined is
	// "no managed install", which is what these tests already assumed.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool,
	getManagedToolsDir: () => MANAGED_TOOLS_DIR,
	// #1612: resolveAvailableOrInstallUnshared reads these on the install-
	// success path to derive honest evidence rather than asserting "succeeded".
	getInstallAttempt: vi.fn(() => undefined),
	// #1636: read alongside getInstallAttempt when deriving the compensating
	// row's `resolved` tag. Undefined falls back to "cache", matching this
	// suite's existing not-attempted expectations.
	getLastEnsureResolutionSource: vi.fn(() => undefined),
	getToolInstallStrategy: vi.fn(() => undefined),
	isSpawnableCommand,
}));

describe("DependencyChecker madge resolution (#766)", () => {
	let tmp: string;
	let otherRoot: string;

	beforeEach(() => {
		vi.resetAllMocks();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-madge-resolve-"));
		otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-madge-other-"));
		findNodeToolBinary.mockResolvedValue(undefined);
		ensureTool.mockResolvedValue(undefined);
		isSpawnableCommand.mockResolvedValue(true);
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") {
				return {
					status: 0,
					error: undefined,
					stdout: "madge 8.0.0",
					stderr: "",
				};
			}
			return { status: 0, error: undefined, stdout: "[]", stderr: "" };
		});
	});

	afterEach(() => {
		removeTempDirSync(tmp);
		removeTempDirSync(otherRoot);
	});

	function writeSource(name: string, imports: string[], root = tmp): string {
		const file = path.join(root, name);
		fs.writeFileSync(
			file,
			`${imports.map((i) => `import { x } from "${i}";`).join("\n")}\nexport const v = 1;\n`,
		);
		return file;
	}

	/** A real file under `root` standing in for an installed madge binary. */
	function installFakeBinary(root: string): string {
		const bin = path.join(root, "node_modules", ".bin", "madge");
		fs.mkdirSync(path.dirname(bin), { recursive: true });
		fs.writeFileSync(bin, "#!/bin/sh\n");
		return bin;
	}

	/** The madge spawns, excluding `ensureAvailable`'s `--version` probe. */
	function madgeCalls(): unknown[][] {
		return safeSpawnAsync.mock.calls.filter(
			(c) => (c[1] as string[])[0] !== "--version",
		);
	}

	it("keeps a project-pinned binary winning (#375), without consulting the installer", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const bin = installFakeBinary(tmp);
		findNodeToolBinary.mockResolvedValue(bin);

		const { stats } = await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);

		expect(stats.commandKind).toBe("local");
		expect(ensureTool).not.toHaveBeenCalled();
		expect(madgeCalls()[0][0]).toBe(bin);
	});

	it("reports a global-bin hit as `global`, not `local`", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		// findNodeToolBinary probes npm/pnpm/yarn/bun GLOBAL bins too, so the step
		// that answered says nothing about where the binary lives.
		findNodeToolBinary.mockResolvedValue(GLOBAL_BIN_1);

		const { stats } = await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);

		expect(stats.commandKind).toBe("global");
	});

	it("uses the managed install instead of npx when nothing local is found", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const managed = path.join(
			MANAGED_TOOLS_DIR,
			"node_modules",
			".bin",
			"madge",
		);
		ensureTool.mockResolvedValue(managed);
		// Exercise the off-PATH auto-install path: ensureAvailable's bare-name
		// probe fails, then resolution must reuse the installed absolute path.
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args[0] === "--version"
				? { status: 1, error: new Error("not found"), stdout: "", stderr: "" }
				: { status: 0, error: undefined, stdout: "[]", stderr: "" },
		);

		const { stats } = await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);

		expect(stats.commandKind).toBe("managed");
		const [cmd, args] = madgeCalls()[0] as [string, string[]];
		expect(cmd).toBe(managed);
		// No `npx madge` prefix — the binary is invoked directly.
		expect(args[0]).toBe("--circular");
	});

	it("classifies the resolved STRING, not the step that produced it", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");

		// The installer's discovery can hand back a bare PATH name...
		ensureTool.mockResolvedValue("madge");
		const bare = await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);
		expect(bare.stats.commandKind).toBe("path");

		// ...or an absolute path outside the managed tree.
		ensureTool.mockResolvedValue(GLOBAL_BIN_2);
		const global = await new DependencyChecker().checkFilesBatch(
			[writeSource("b.ts", ["./c.js"])],
			tmp,
		);
		expect(global.stats.commandKind).toBe("global");
	});

	it("falls back to `npx madge` only when nothing is discoverable", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");

		const { stats } = await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);

		expect(stats.commandKind).toBe("npx");
		const [cmd, args] = madgeCalls()[0] as [string, string[]];
		expect(cmd).toBe("npx");
		expect(args[0]).toBe("madge");
	});

	it("never installs from the spawn path", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");

		await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);

		// Installation stays owned by ensureAvailable(); discovery here must not
		// be able to trigger a download.
		expect(ensureTool).toHaveBeenCalledWith("madge", { allowInstall: false });
	});

	it("resolves once per project root — not per file, per batch, or for every root", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const bin = installFakeBinary(tmp);
		// The probe chain this memo exists to avoid is genuinely slow (uncached
		// `npm config get prefix` / `pnpm bin -g` spawns), so make it cost time.
		findNodeToolBinary.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return bin;
		});
		const files = [
			writeSource("a.ts", ["./x.js"]),
			writeSource("b.ts", ["./y.js"]),
			writeSource("c.ts", ["./z.js"]),
		];

		const checker = new DependencyChecker();
		const first = await checker.checkFilesBatch(files, tmp);
		expect(madgeCalls()).toHaveLength(3);
		// The cold resolution's cost is attributed, not hidden in the phase total.
		expect(first.stats.resolveMs).toBeGreaterThanOrEqual(20);

		// Re-edit the imports so the second batch is three fresh misses.
		files.forEach((f, i) =>
			fs.writeFileSync(
				f,
				`import { x } from "./x${i}.js";\nimport { y } from "./y${i}.js";\nexport const v = 1;\n`,
			),
		);
		const second = await checker.checkFilesBatch(files, tmp);

		expect(madgeCalls()).toHaveLength(6);
		expect(findNodeToolBinary).toHaveBeenCalledTimes(1);
		expect(second.stats.commandKind).toBe("local");

		// A different project root is a different resolution — the memo is keyed
		// per root, not per instance.
		await checker.checkFilesBatch(
			[writeSource("d.ts", ["./q.js"], otherRoot)],
			otherRoot,
		);
		expect(findNodeToolBinary).toHaveBeenCalledTimes(2);
		expect(findNodeToolBinary).toHaveBeenLastCalledWith("madge", otherRoot);
	});

	it("re-resolves after a resolved binary disappears", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const bin = installFakeBinary(tmp);
		findNodeToolBinary.mockResolvedValue(bin);
		const file = writeSource("a.ts", ["./b.js"]);

		const checker = new DependencyChecker();
		const first = await checker.checkFilesBatch([file], tmp);
		expect(first.stats.commandKind).toBe("local");
		expect(findNodeToolBinary).toHaveBeenCalledTimes(1);

		// madge is uninstalled mid-session. Pre-memo, resolution re-probed on
		// every spawn and healed itself; a one-way memo would instead fail every
		// remaining spawn of the session.
		fs.rmSync(bin);
		findNodeToolBinary.mockResolvedValue(undefined);
		fs.writeFileSync(
			file,
			'import { b } from "./b.js";\nimport { c } from "./c.js";\nexport const v = 1;\n',
		);
		const second = await checker.checkFilesBatch([file], tmp);

		expect(findNodeToolBinary).toHaveBeenCalledTimes(2);
		expect(second.stats.commandKind).toBe("npx");
	});

	it("coalesces concurrent stale-entry recovery into one probe", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const bin = installFakeBinary(tmp);
		findNodeToolBinary.mockResolvedValue(bin);
		const firstFile = writeSource("first.ts", ["./b.js"]);
		const secondFile = writeSource("second.ts", ["./c.js"]);

		const checker = new DependencyChecker();
		await checker.checkFilesBatch([firstFile], tmp);
		expect(findNodeToolBinary).toHaveBeenCalledTimes(1);

		// Both operations observe the same stale, already-resolved memo. Keep the
		// replacement probe pending so the old implementation's second continuation
		// can delete its replacement and start a duplicate probe.
		fs.rmSync(bin);
		fs.writeFileSync(
			firstFile,
			'import { b } from "./changed.js";\nexport const v = 1;\n',
		);
		findNodeToolBinary.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return undefined;
		});
		ensureTool.mockResolvedValue(undefined);
		const [, second] = await Promise.all([
			checker.checkFilesBatch([firstFile], tmp),
			checker.checkFilesBatch([secondFile], tmp),
		]);

		expect(findNodeToolBinary).toHaveBeenCalledTimes(2);
		expect(second.stats.commandKind).toBe("npx");
	});

	it("survives a throwing installer probe and re-attempts on the next batch", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		ensureTool.mockRejectedValue(new Error("installer exploded"));
		const file = writeSource("a.ts", ["./b.js"]);

		const checker = new DependencyChecker();
		const first = await checker.checkFilesBatch([file], tmp);
		expect(first.stats.commandKind).toBe("npx");
		expect(first.results.get(file)?.checked).toBe(true);

		// npx is never pinned, so one transient installer failure must not disable
		// managed resolution for the rest of the session.
		const managed = path.join(
			MANAGED_TOOLS_DIR,
			"node_modules",
			".bin",
			"madge",
		);
		ensureTool.mockResolvedValue(managed);
		fs.writeFileSync(
			file,
			'import { b } from "./b.js";\nimport { c } from "./c.js";\nexport const v = 1;\n',
		);
		const second = await checker.checkFilesBatch([file], tmp);

		expect(ensureTool).toHaveBeenCalledTimes(2);
		expect(second.stats.commandKind).toBe("managed");
	});

	it("revalidates a cached bare-command resolution's spawnability once, not per checkFile call (#1276 P2)", async () => {
		const { DependencyChecker, resetMadgeManagedPathMemo } =
			await import("../../clients/dependency-checker.js");
		// Nothing local/global; installer discovery hands back a bare `madge` on
		// PATH (kind "path" — not absolute, so classifyMadgeKind's existsSync
		// shortcut never applies and every cache hit goes through
		// resolvedCommandIsStale's isSpawnableCommand branch).
		findNodeToolBinary.mockResolvedValue(undefined);
		ensureTool.mockResolvedValue("madge");
		isSpawnableCommand.mockResolvedValue(true);

		const checker = new DependencyChecker();
		const files = [
			writeSource("a.ts", ["./x.js"]),
			writeSource("b.ts", ["./y.js"]),
			writeSource("c.ts", ["./z.js"]),
		];

		// First call resolves cold — no memo entry exists yet, so there is
		// nothing to revalidate and `isSpawnableCommand` is not consulted.
		await checker.checkFile(files[0], tmp);
		expect(isSpawnableCommand).toHaveBeenCalledTimes(0);

		// Two more cached-resolution hits (different files force
		// `importsChanged`, so each one reaches `resolveMadge` again). Pre-fix,
		// `resolvedCommandIsStale` re-ran `isSpawnableCommand`'s synchronous PATH
		// walk on every one of these; post-fix the answer is memoized alongside
		// the madge-command memo after the first revalidation and is not
		// re-probed again.
		await checker.checkFile(files[1], tmp);
		await checker.checkFile(files[2], tmp);
		expect(isSpawnableCommand).toHaveBeenCalledTimes(1);
		expect(ensureTool).toHaveBeenCalledTimes(1);

		// A completed install still invalidates the cached spawnability answer,
		// exactly like it invalidates the madge-command memo itself. The next
		// resolution is cold again (no isSpawnableCommand call, same as the very
		// first call above); the one after THAT hits the freshly-repopulated
		// cache and revalidates once more.
		resetMadgeManagedPathMemo();
		fs.writeFileSync(
			files[0],
			'import { query } from "./q.js";\nexport const v = 1;\n',
		);
		await checker.checkFile(files[0], tmp);
		expect(isSpawnableCommand).toHaveBeenCalledTimes(1);

		fs.writeFileSync(
			files[1],
			'import { result } from "./r.js";\nexport const v = 1;\n',
		);
		await checker.checkFile(files[1], tmp);
		expect(isSpawnableCommand).toHaveBeenCalledTimes(2);
	});
});

/**
 * #1731 sweep findings for vulture (PythonDeadCodeClient):
 *
 * - Discipline B: `ensureAvailable()` probed bare `vulture` / `python -m
 *   vulture` / `python3 -m vulture` on PATH only — no `<root>/.venv/bin/
 *   vulture` check, unlike sqlfluff's venv-first binary resolution
 *   (`runner-helpers.ts` `createVenvFinder`). A project's own venv vulture
 *   (the version its dependency set was actually resolved against) never got
 *   a look-in ahead of whatever `vulture` happened to answer on PATH.
 * - Discipline A: `runAnalyze` always passed `--min-confidence` and
 *   `--exclude`, which override `[tool.vulture]` in the project's own
 *   `pyproject.toml`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const safeSpawnAsync = vi.fn(
	async (
		..._args: unknown[]
	): Promise<{
		error: Error | null;
		status: number | null;
		stdout: string;
		stderr: string;
	}> => ({ error: null, status: 0, stdout: "", stderr: "" }),
);
vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

describe("PythonDeadCodeClient (vulture) — project-first resolution (#1731)", () => {
	const tmpDirs: string[] = [];

	beforeEach(() => {
		// This suite witnesses project-first resolution, not the trust gate; the
		// gate is covered by the dedicated trust witnesses.
		setProjectTrustState("trusted");
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockImplementation(async () => ({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		}));
	});

	afterEach(() => {
		while (tmpDirs.length > 0) {
			const dir = tmpDirs.pop();
			if (dir && fs.existsSync(dir)) removeTempDirSync(dir);
		}
	});

	it("probes the project's own .venv vulture before any bare PATH candidate (discipline B)", async () => {
		const env = setupTestEnvironment("pi-lens-vulture-venv-");
		tmpDirs.push(env.tmpDir);
		const isWin = process.platform === "win32";
		const venvBin = isWin
			? path.join(env.tmpDir, ".venv", "Scripts")
			: path.join(env.tmpDir, ".venv", "bin");
		fs.mkdirSync(venvBin, { recursive: true });
		const venvVulture = path.join(venvBin, isWin ? "vulture.exe" : "vulture");
		fs.writeFileSync(venvVulture, "");

		const { PythonDeadCodeClient } =
			await import("../../clients/dead-code-client.js");
		const client = new PythonDeadCodeClient() as unknown as {
			ensureAvailable(root?: string): Promise<boolean>;
		};

		const ok = await client.ensureAvailable(env.tmpDir);
		expect(ok).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const [cmd] = safeSpawnAsync.mock.calls[0] as [string, ...unknown[]];
		expect(cmd).toBe(venvVulture);
	});

	/**
	 * #2544 round 4 F2 (reverted). `venvCandidates` joined its venv directories
	 * onto `root` and nothing else — a third private spelling of the same four
	 * directories, with a `process.platform` branch that hid the `Scripts`
	 * half from the ubuntu lane entirely (defect shape 30, fixed and kept).
	 * Round 3 ALSO folded the resolution onto the shared ancestor walker,
	 * reasoning a monorepo package should find its repo-root venv — an
	 * unrequested behaviour change with no #2514 defect behind it. Reverted:
	 * a `.venv` at a repo root is invisible from a package subdirectory, and
	 * resolution falls through to the bare `vulture`/`python -m vulture`
	 * PATH candidates instead.
	 */
	it("does not probe a .venv vulture from an ANCESTOR of the analyzed root (#2544 round 4 F2)", async () => {
		const env = setupTestEnvironment("pi-lens-vulture-venv-ancestor-");
		tmpDirs.push(env.tmpDir);
		const isWin = process.platform === "win32";
		const repoRoot = path.join(env.tmpDir, "repo");
		const pkg = path.join(repoRoot, "services", "api");
		fs.mkdirSync(pkg, { recursive: true });
		const venvBin = isWin
			? path.join(repoRoot, ".venv", "Scripts")
			: path.join(repoRoot, ".venv", "bin");
		fs.mkdirSync(venvBin, { recursive: true });
		const venvVulture = path.join(venvBin, isWin ? "vulture.exe" : "vulture");
		fs.writeFileSync(venvVulture, "");

		const { PythonDeadCodeClient } =
			await import("../../clients/dead-code-client.js");
		const client = new PythonDeadCodeClient() as unknown as {
			ensureAvailable(root?: string): Promise<boolean>;
		};

		expect(await client.ensureAvailable(pkg)).toBe(true);
		const [cmd] = safeSpawnAsync.mock.calls[0] as [string, ...unknown[]];
		expect(cmd).not.toBe(venvVulture);
		expect(cmd).toBe("vulture");
	});

	// After #2544 round 4 F2's revert to a fixed `root`-only lookup, this
	// holds for a simpler reason than a ceiling: `project` (root) and
	// `fakeHome` are different directories, and `venvCandidates` never looks
	// anywhere but `root` — the ceiling is moot for a lookup that never climbs.
	it("never probes a .venv vulture planted at HOME (#2514)", async () => {
		const env = setupTestEnvironment("pi-lens-vulture-venv-home-");
		tmpDirs.push(env.tmpDir);
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		try {
			const isWin = process.platform === "win32";
			const fakeHome = env.tmpDir;
			const project = path.join(fakeHome, "project");
			fs.mkdirSync(project, { recursive: true });
			const venvBin = isWin
				? path.join(fakeHome, ".venv", "Scripts")
				: path.join(fakeHome, ".venv", "bin");
			fs.mkdirSync(venvBin, { recursive: true });
			const homeVulture = path.join(venvBin, isWin ? "vulture.exe" : "vulture");
			fs.writeFileSync(homeVulture, "");
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;

			const { PythonDeadCodeClient } =
				await import("../../clients/dead-code-client.js");
			const client = new PythonDeadCodeClient() as unknown as {
				ensureAvailable(root?: string): Promise<boolean>;
			};

			await client.ensureAvailable(project);

			const probed = safeSpawnAsync.mock.calls.map((call) => call[0]);
			expect(probed).not.toContain(homeVulture);
			// …and the PATH candidates still ran, so this is a ceiling, not a
			// short-circuit that skips resolution altogether.
			expect(probed).toContain("vulture");
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
		}
	});

	it("omits --min-confidence and --exclude when the project ships [tool.vulture] (discipline A)", async () => {
		const env = setupTestEnvironment("pi-lens-vulture-config-");
		tmpDirs.push(env.tmpDir);
		fs.writeFileSync(
			path.join(env.tmpDir, "pyproject.toml"),
			"[tool.vulture]\nmin_confidence = 80\nexclude = ['migrations/']\n",
		);

		const { PythonDeadCodeClient } =
			await import("../../clients/dead-code-client.js");
		const client = new PythonDeadCodeClient() as unknown as {
			runAnalyze(root: string): Promise<unknown>;
		};

		await client.runAnalyze(env.tmpDir);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const [, args] = safeSpawnAsync.mock.calls[0] as [string, string[]];
		expect(args).not.toContain(
			expect.stringMatching(/^--min-confidence=/) as unknown as string,
		);
		expect(args.some((a) => a.startsWith("--min-confidence="))).toBe(false);
		expect(args.some((a) => a.startsWith("--exclude="))).toBe(false);
	});

	it("still passes --min-confidence and --exclude with no project config", async () => {
		const env = setupTestEnvironment("pi-lens-vulture-noconfig-");
		tmpDirs.push(env.tmpDir);

		const { PythonDeadCodeClient } =
			await import("../../clients/dead-code-client.js");
		const client = new PythonDeadCodeClient() as unknown as {
			runAnalyze(root: string): Promise<unknown>;
		};

		await client.runAnalyze(env.tmpDir);
		const [, args] = safeSpawnAsync.mock.calls[0] as [string, string[]];
		expect(args.some((a) => a.startsWith("--min-confidence="))).toBe(true);
		expect(args.some((a) => a.startsWith("--exclude="))).toBe(true);
	});
});

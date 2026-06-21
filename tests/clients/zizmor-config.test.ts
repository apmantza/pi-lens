import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controllable mock for the `gh auth token` derivation.
const safeSpawnAsync = vi.fn();
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: (...args: unknown[]) => safeSpawnAsync(...args),
}));

import {
	_resetZizmorTokenCacheForTests,
	findLocalZizmorConfig,
	resolveZizmorGitHubToken,
} from "../../clients/zizmor-config.js";

describe("findLocalZizmorConfig (#272)", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "zizmor-cfg-"));
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("finds a root-level zizmor.yml", () => {
		const cfg = path.join(root, "zizmor.yml");
		fs.writeFileSync(cfg, "rules: {}\n");
		expect(findLocalZizmorConfig(root)).toBe(cfg);
	});

	it("finds a .github/zizmor.yml and prefers it over the repo root", () => {
		fs.mkdirSync(path.join(root, ".github"));
		const ghCfg = path.join(root, ".github", "zizmor.yml");
		fs.writeFileSync(ghCfg, "rules: {}\n");
		fs.writeFileSync(path.join(root, "zizmor.yml"), "rules: {}\n");
		// .github/zizmor.yml is earlier in the discovery order.
		expect(findLocalZizmorConfig(root)).toBe(ghCfg);
	});

	it("walks up from a nested start dir", () => {
		const cfg = path.join(root, "zizmor.yaml");
		fs.writeFileSync(cfg, "rules: {}\n");
		const nested = path.join(root, "a", "b");
		fs.mkdirSync(nested, { recursive: true });
		expect(findLocalZizmorConfig(nested)).toBe(cfg);
	});

	it("returns undefined when no config exists", () => {
		expect(findLocalZizmorConfig(root)).toBeUndefined();
	});
});

describe("resolveZizmorGitHubToken (#272)", () => {
	const ENV_KEYS = [
		"ZIZMOR_OFFLINE",
		"ZIZMOR_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
	] as const;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		for (const k of ENV_KEYS) delete process.env[k];
		safeSpawnAsync.mockReset();
		_resetZizmorTokenCacheForTests();
	});
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("prefers ZIZMOR_GITHUB_TOKEN over GH_TOKEN/GITHUB_TOKEN and never spawns gh", async () => {
		process.env.ZIZMOR_GITHUB_TOKEN = "zztok";
		process.env.GH_TOKEN = "ghtok";
		process.env.GITHUB_TOKEN = "ghub";
		expect(await resolveZizmorGitHubToken()).toBe("zztok");
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("falls back GH_TOKEN → GITHUB_TOKEN", async () => {
		process.env.GH_TOKEN = "ghtok";
		expect(await resolveZizmorGitHubToken()).toBe("ghtok");
		delete process.env.GH_TOKEN;
		_resetZizmorTokenCacheForTests();
		process.env.GITHUB_TOKEN = "ghub";
		expect(await resolveZizmorGitHubToken()).toBe("ghub");
	});

	it("ZIZMOR_OFFLINE forces offline even when a token is present", async () => {
		process.env.ZIZMOR_OFFLINE = "1";
		process.env.GH_TOKEN = "ghtok";
		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("derives a token via `gh auth token` when no env token is set", async () => {
		safeSpawnAsync.mockResolvedValue({
			stdout: "gho_derived\n",
			stderr: "",
			status: 0,
		});
		expect(await resolveZizmorGitHubToken()).toBe("gho_derived");
		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"gh",
			["auth", "token"],
			expect.objectContaining({ ignoreAmbientSignal: true }),
		);
	});

	it("memoizes the gh lookup (second call does not re-spawn)", async () => {
		safeSpawnAsync.mockResolvedValue({
			stdout: "gho_derived",
			stderr: "",
			status: 0,
		});
		await resolveZizmorGitHubToken();
		await resolveZizmorGitHubToken();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("returns undefined when gh is unauthenticated/missing", async () => {
		safeSpawnAsync.mockResolvedValue({
			stdout: "",
			stderr: "not logged in",
			status: 1,
		});
		expect(await resolveZizmorGitHubToken()).toBeUndefined();
	});
});

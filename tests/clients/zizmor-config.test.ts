import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

// Controllable mock for the `gh auth token` derivation.
const safeSpawnAsync = vi.fn();
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: (...args: unknown[]) => safeSpawnAsync(...args),
}));

// Controllable `os.homedir()` override — `vi.spyOn(os, "homedir")` fails
// under Vitest's ESM interop ("Cannot redefine property"), so the module is
// replaced with a thin wrapper that defers to the REAL os.homedir() unless a
// test has set an override (refs #2472 review round 3, F1). Never used to
// touch the real HOME directory — only to redirect os.homedir() to a temp
// dir for the duration of one test.
const homedirOverride = vi.hoisted(() => ({
	value: undefined as string | undefined,
}));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const homedir = () => homedirOverride.value ?? actual.homedir();
	return { ...actual, default: { ...actual, homedir }, homedir };
});

import {
	_resetZizmorTokenCacheForTests,
	findLocalZizmorConfig,
	isZizmorAuditTarget,
	resolveZizmorGitHubToken,
} from "../../clients/zizmor-config.js";

describe("isZizmorAuditTarget (#636)", () => {
	it("matches workflow YAML under .github/workflows/", () => {
		expect(isZizmorAuditTarget(".github/workflows/ci.yml")).toBe(true);
		expect(isZizmorAuditTarget(".github/workflows/release.yaml")).toBe(true);
		expect(isZizmorAuditTarget("repo\\.github\\workflows\\ci.yml")).toBe(true);
		expect(isZizmorAuditTarget("/abs/path/repo/.github/workflows/ci.yml")).toBe(
			true,
		);
	});

	it("matches action.yml/action.yaml anywhere in the repo (composite actions)", () => {
		expect(isZizmorAuditTarget("action.yml")).toBe(true);
		expect(isZizmorAuditTarget("action.yaml")).toBe(true);
		expect(isZizmorAuditTarget("actions/my-action/action.yml")).toBe(true);
		expect(isZizmorAuditTarget("ACTION.YML")).toBe(true);
	});

	it("matches .github/dependabot.yml", () => {
		expect(isZizmorAuditTarget(".github/dependabot.yml")).toBe(true);
		expect(isZizmorAuditTarget(".github/dependabot.yaml")).toBe(true);
	});

	it("does NOT match a root-level dependabot.yml (GitHub only reads it under .github/)", () => {
		expect(isZizmorAuditTarget("dependabot.yml")).toBe(false);
	});

	it("does NOT match plain, non-workflow YAML files", () => {
		expect(isZizmorAuditTarget("docker-compose.yml")).toBe(false);
		expect(isZizmorAuditTarget("k8s/deployment.yaml")).toBe(false);
		expect(isZizmorAuditTarget(".github/ISSUE_TEMPLATE/bug.yml")).toBe(false);
		expect(isZizmorAuditTarget("charts/app/values.yaml")).toBe(false);
	});
});

describe("findLocalZizmorConfig (#272)", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "zizmor-cfg-"));
	});
	afterEach(() => {
		removeTempDirSync(root);
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

	// #2472 review round 3, F1 (maintainer-decision reversal): a round-2 fold
	// made findLocalZizmorConfig's ancestor climb stop at $HOME by default,
	// but a user-level `~/zizmor.yml` (or `~/.github/zizmor.yml`) is a
	// legitimate global config — the ceiling hid it from pi-lens for no
	// benefit. The climb is unceilinged again: a config sitting exactly AT
	// `os.homedir()` resolves.
	it("finds a config sitting AT (mocked) $HOME — no default ceiling (#2472 review round 3 F1)", () => {
		const mockedHome = path.join(root, "mocked-home");
		fs.mkdirSync(mockedHome, { recursive: true });
		homedirOverride.value = mockedHome;
		try {
			const cfg = path.join(mockedHome, "zizmor.yml");
			fs.writeFileSync(cfg, "rules: {}\n");
			const startDir = path.join(mockedHome, "project", "src");
			fs.mkdirSync(startDir, { recursive: true });

			expect(findLocalZizmorConfig(startDir)).toBe(cfg);

			// Cross-form (forward-slash) startDir resolves identically.
			const crossFormStartDir = startDir.split(path.sep).join("/");
			expect(findLocalZizmorConfig(crossFormStartDir)).toBe(cfg);
		} finally {
			homedirOverride.value = undefined;
		}
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

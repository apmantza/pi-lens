/**
 * Tests for LSP server initializationOptions overrides.
 *
 * Covers:
 *  - config.ts: ServerInitOverride parsing in initLSPConfig / getServerInitOverride
 *  - index.ts: mergeInitializationOptions deep-merge helper
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.PI_LENS_TEST_MODE = "1";

vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP: vi.fn(),
}));
vi.mock("../../../clients/latency-logger.js", () => ({
	logLatency: vi.fn(),
	resetLatencyLog: vi.fn(),
}));

const dirs: string[] = [];

function tmpDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-overrides-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	vi.resetModules();
});

// ---------------------------------------------------------------------------
// mergeInitializationOptions
// ---------------------------------------------------------------------------

describe("mergeInitializationOptions", () => {
	it("returns undefined when both sides are undefined", async () => {
		const { mergeInitializationOptions } = await import(
			"../../../clients/lsp/index.js"
		);
		expect(mergeInitializationOptions(undefined, undefined)).toBeUndefined();
	});

	it("returns base when override is undefined", async () => {
		const { mergeInitializationOptions } = await import(
			"../../../clients/lsp/index.js"
		);
		const base = { cargo: { buildScripts: { enable: true } } };
		expect(mergeInitializationOptions(base, undefined)).toBe(base);
	});

	it("returns override when base is undefined", async () => {
		const { mergeInitializationOptions } = await import(
			"../../../clients/lsp/index.js"
		);
		const override = { nixpkgs: { expr: "import <nixpkgs> {}" } };
		expect(mergeInitializationOptions(undefined, override)).toBe(override);
	});

	it("deep-merges override onto base — user wins on conflicts", async () => {
		const { mergeInitializationOptions } = await import(
			"../../../clients/lsp/index.js"
		);
		const base = {
			cargo: { buildScripts: { enable: true } },
			procMacro: { enable: true },
			diagnostics: { enable: true },
		};
		const override = {
			check: { command: "clippy", allTargets: true },
			cargo: { features: "all", targetDir: true },
		};
		const result = mergeInitializationOptions(base, override);
		// Override keys are added
		expect(result).toMatchObject({ check: { command: "clippy", allTargets: true } });
		// Deep merge: cargo.features added, cargo.buildScripts preserved
		expect(result?.cargo).toEqual({
			buildScripts: { enable: true },
			features: "all",
			targetDir: true,
		});
		// Base-only keys preserved
		expect(result?.procMacro).toEqual({ enable: true });
		expect(result?.diagnostics).toEqual({ enable: true });
	});

	it("override wins when both sides have the same leaf key", async () => {
		const { mergeInitializationOptions } = await import(
			"../../../clients/lsp/index.js"
		);
		const base = { diagnostics: { enable: false } };
		const override = { diagnostics: { enable: true } };
		const result = mergeInitializationOptions(base, override);
		expect(result?.diagnostics).toEqual({ enable: true });
	});

	it("replaces arrays rather than merging them", async () => {
		const { mergeInitializationOptions } = await import(
			"../../../clients/lsp/index.js"
		);
		const base = { files: { exclude: ["**/target/**"] } };
		const override = { files: { exclude: ["**/target/**", "**/dist/**"] } };
		const result = mergeInitializationOptions(base, override);
		expect(result?.files).toEqual({ exclude: ["**/target/**", "**/dist/**"] });
	});

	it("does not mutate the base object", async () => {
		const { mergeInitializationOptions } = await import(
			"../../../clients/lsp/index.js"
		);
		const base = { cargo: { buildScripts: { enable: true } } };
		const baseCopy = JSON.parse(JSON.stringify(base)) as typeof base;
		mergeInitializationOptions(base, { cargo: { features: "all" } });
		expect(base).toEqual(baseCopy);
	});
});

// ---------------------------------------------------------------------------
// getServerInitOverride / initLSPConfig
// ---------------------------------------------------------------------------

describe("getServerInitOverride", () => {
	it("returns undefined when no config file exists", async () => {
		const { initLSPConfig, getServerInitOverride, resetLSPConfigStateForTests } =
			await import("../../../clients/lsp/config.js");
		const dir = tmpDir();
		resetLSPConfigStateForTests();
		await initLSPConfig(dir);
		expect(getServerInitOverride("rust", path.join(dir, "src/main.rs"))).toBeUndefined();
	});

	it("returns undefined for an unrecognised server ID even when config exists", async () => {
		const { initLSPConfig, getServerInitOverride, resetLSPConfigStateForTests } =
			await import("../../../clients/lsp/config.js");
		const dir = tmpDir();
		fs.mkdirSync(path.join(dir, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".pi-lens/lsp.json"),
			JSON.stringify({
				serverOverrides: {
					rust: { initializationOptions: { check: { command: "clippy" } } },
				},
			}),
		);
		resetLSPConfigStateForTests();
		await initLSPConfig(dir);
		expect(
			getServerInitOverride("go", path.join(dir, "main.go")),
		).toBeUndefined();
	});

	it("returns override for a named server when .pi-lens/lsp.json is present", async () => {
		const { initLSPConfig, getServerInitOverride, resetLSPConfigStateForTests } =
			await import("../../../clients/lsp/config.js");
		const dir = tmpDir();
		fs.mkdirSync(path.join(dir, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".pi-lens/lsp.json"),
			JSON.stringify({
				serverOverrides: {
					rust: {
						initializationOptions: {
							check: { command: "clippy", allTargets: true },
							cargo: { features: "all" },
						},
					},
				},
			}),
		);
		resetLSPConfigStateForTests();
		await initLSPConfig(dir);
		const override = getServerInitOverride("rust", path.join(dir, "src/main.rs"));
		expect(override?.initializationOptions).toEqual({
			check: { command: "clippy", allTargets: true },
			cargo: { features: "all" },
		});
	});

	it("resolves override from a parent directory (.pi-lens.json format)", async () => {
		const { initLSPConfig, getServerInitOverride, resetLSPConfigStateForTests } =
			await import("../../../clients/lsp/config.js");
		const dir = tmpDir();
		const subdir = path.join(dir, "src", "nested");
		fs.mkdirSync(subdir, { recursive: true });
		// Config sits at the project root, file is in a nested subdirectory
		fs.writeFileSync(
			path.join(dir, ".pi-lens.json"),
			JSON.stringify({
				serverOverrides: {
					nix: {
						initializationOptions: {
							nixpkgs: { expr: "import <nixpkgs> {}" },
						},
					},
				},
			}),
		);
		resetLSPConfigStateForTests();
		await initLSPConfig(subdir);
		const override = getServerInitOverride("nix", path.join(subdir, "flake.nix"));
		expect(override?.initializationOptions?.nixpkgs).toEqual({
			expr: "import <nixpkgs> {}",
		});
	});

	it("silently ignores a serverOverrides entry whose initializationOptions is not a plain object", async () => {
		const { initLSPConfig, getServerInitOverride, resetLSPConfigStateForTests } =
			await import("../../../clients/lsp/config.js");
		const dir = tmpDir();
		fs.mkdirSync(path.join(dir, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".pi-lens/lsp.json"),
			JSON.stringify({
				serverOverrides: {
					rust: { initializationOptions: "not-an-object" },
					go: { initializationOptions: ["array"] },
					nix: { initializationOptions: null },
				},
			}),
		);
		resetLSPConfigStateForTests();
		await initLSPConfig(dir);
		expect(getServerInitOverride("rust", path.join(dir, "main.rs"))).toBeUndefined();
		expect(getServerInitOverride("go", path.join(dir, "main.go"))).toBeUndefined();
		expect(getServerInitOverride("nix", path.join(dir, "flake.nix"))).toBeUndefined();
	});
});

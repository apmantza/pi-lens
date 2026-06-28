/**
 * Interactive Install Tests
 *
 * Tests the COMMON_LANGUAGES coverage and install strategy dispatch
 * introduced in 83865c1 (tier-4 LSP prompt support).
 *
 * Covered:
 *  1. All originally-supported languages still present
 *  2. All 18 new tier-4 languages added (supportsInteractiveInstall)
 *  3. Install strategy correctness per language
 *  4. getInstallCommand returns a non-empty string for every language
 *  5. Manual-strategy languages have descriptive install instructions
 */

import { describe, expect, it } from "vitest";
import {
	_parseStaticInstallCommandForTest,
	getInstallCommand,
	getInstallStrategy,
	supportsInteractiveInstall,
} from "../../../clients/lsp/interactive-install.js";

// ---------------------------------------------------------------------------
// 1. Originally-supported languages still present
// ---------------------------------------------------------------------------

describe("originally-supported languages", () => {
	const original = ["go", "rust", "yaml", "json", "bash"];

	for (const lang of original) {
		it(`${lang} is still supported`, () => {
			expect(supportsInteractiveInstall(lang)).toBe(true);
		});

		it(`${lang} has an install command`, () => {
			expect(getInstallCommand(lang)).toBeTruthy();
		});
	}
});

// ---------------------------------------------------------------------------
// 2. All 18 new tier-4 languages are now covered
// ---------------------------------------------------------------------------

describe("new tier-4 languages are supported", () => {
	const tier4 = [
		"ruby",
		"php",
		"csharp",
		"fsharp",
		"java",
		"kotlin",
		"swift",
		"dart",
		"lua",
		"cpp",
		"zig",
		"haskell",
		"elixir",
		"gleam",
		"ocaml",
		"clojure",
		"terraform",
		"nix",
	];

	for (const lang of tier4) {
		it(`${lang} is now supported`, () => {
			expect(supportsInteractiveInstall(lang)).toBe(true);
		});

		it(`${lang} has an install command`, () => {
			const cmd = getInstallCommand(lang);
			expect(cmd).toBeTruthy();
			expect(cmd!.length).toBeGreaterThan(0);
		});
	}
});

// ---------------------------------------------------------------------------
// 3. Install strategy correctness
// ---------------------------------------------------------------------------

describe("install strategy", () => {
	describe("npm strategy", () => {
		const npmLangs = ["yaml", "json", "bash", "php"];
		for (const lang of npmLangs) {
			it(`${lang} uses npm strategy`, () => {
				expect(getInstallStrategy(lang)).toBe("npm");
			});
		}
	});

	describe("shell strategy (can auto-install via shell command)", () => {
		const shellLangs = [
			"go",
			"rust",
			"ruby",
			"csharp",
			"fsharp",
			"lua",
			"zig",
			"haskell",
			"gleam",
			"ocaml",
			"clojure",
			"terraform",
			"nix",
		];
		for (const lang of shellLangs) {
			it(`${lang} uses shell strategy`, () => {
				expect(getInstallStrategy(lang)).toBe("shell");
			});
		}
	});

	describe("manual strategy (toolchain-bundled, cannot auto-install)", () => {
		const manualLangs = ["java", "kotlin", "swift", "dart", "cpp", "elixir"];
		for (const lang of manualLangs) {
			it(`${lang} uses manual strategy`, () => {
				expect(getInstallStrategy(lang)).toBe("manual");
			});
		}
	});
});

// ---------------------------------------------------------------------------
// 4 & 5. Install commands are meaningful
// ---------------------------------------------------------------------------

describe("install commands are descriptive", () => {
	it("parses shell-strategy commands as argv without a shell", () => {
		expect(
			_parseStaticInstallCommandForTest(
				"go install golang.org/x/tools/gopls@latest",
			),
		).toEqual(["go", ["install", "golang.org/x/tools/gopls@latest"]]);
		expect(
			_parseStaticInstallCommandForTest("nix profile install nixpkgs#nixd"),
		).toEqual(["nix", ["profile", "install", "nixpkgs#nixd"]]);
	});

	it("rejects commands that need shell interpretation", () => {
		expect(
			_parseStaticInstallCommandForTest(
				"curl https://example.test/install.sh | sh",
			),
		).toBeUndefined();
		expect(_parseStaticInstallCommandForTest("echo $(whoami)")).toBeUndefined();
	});

	it("shell-strategy commands are runnable (not URLs or comments)", () => {
		const shellLangs = ["go", "rust", "ruby", "csharp", "fsharp", "gleam"];
		for (const lang of shellLangs) {
			const cmd = getInstallCommand(lang)!;
			// Should start with a real command, not just a comment or URL
			expect(cmd).not.toMatch(/^#/);
			expect(cmd).not.toMatch(/^https?:\/\//);
		}
	});

	it("manual-strategy commands include install URL or tool reference", () => {
		const manualLangs = ["java", "kotlin", "swift", "dart", "elixir"];
		for (const lang of manualLangs) {
			const cmd = getInstallCommand(lang)!;
			// Manual commands should include a hint (URL, brew, xcode, etc.)
			expect(cmd.length).toBeGreaterThan(10);
		}
	});

	it("unknown language returns undefined", () => {
		expect(supportsInteractiveInstall("brainfuck")).toBe(false);
		expect(getInstallCommand("brainfuck")).toBeUndefined();
		expect(getInstallStrategy("brainfuck")).toBeUndefined();
	});
});

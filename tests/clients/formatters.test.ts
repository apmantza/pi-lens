/**
 * Formatter Tests
 *
 * Tests the venv/vendor/node_modules resolution helpers and nearest-wins
 * package.json detection logic introduced in bfc0885 and 83865c1.
 *
 * Covered:
 *  1. resolveCommand — biome/prettier prefer node_modules/.bin over npx
 *  2. resolveCommand — ruff/black prefer .venv over global
 *  3. resolveCommand — rubocop/standardrb use `bundle exec` when Gemfile.lock found
 *  4. resolveCommand — php-cs-fixer prefers vendor/bin over global
 *  5. resolveCommand walk-up — binary at project root found from deep subdir
 *  6. Nearest-wins: biome/prettier detection stops at closest package.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SKIP_FORMATTING,
	biomeFormatter,
	blackFormatter,
	clearFormatterRuntimeState,
	getFormattersForFile,
	invalidateFormatterCacheForPath,
	oxfmtFormatter,
	phpCsFixerFormatter,
	prettierFormatter,
	psscriptanalyzerFormatFormatter,
	rubocopFormatter,
	ruffFormatter,
	standardrbFormatter,
	shfmtFormatter,
} from "../../clients/formatters.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { _getSpotlessGradleReadCountForTests } from "../../clients/tool-policy.js";

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

const isWin = process.platform === "win32";

/** Create a fake executable */
function makeFakeExe(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		isWin ? "@echo off\r\n" : "#!/bin/sh\necho fake\n",
	);
	if (!isWin) fs.chmodSync(filePath, 0o755);
}

/** Platform-correct path for a venv binary */
function venvBin(root: string, binary: string): string {
	return isWin
		? path.join(root, ".venv", "Scripts", `${binary}.exe`)
		: path.join(root, ".venv", "bin", binary);
}

/** Platform-correct path for a vendor/bin binary */
function vendorBin(root: string, binary: string): string {
	return isWin
		? path.join(root, "vendor", "bin", `${binary}.bat`)
		: path.join(root, "vendor", "bin", binary);
}

/** Platform-correct path for node_modules/.bin binary */
function nodeModulesBin(root: string, binary: string): string {
	return isWin
		? path.join(root, "node_modules", ".bin", `${binary}.cmd`)
		: path.join(root, "node_modules", ".bin", binary);
}

/** Dummy file path inside a directory */
function fileIn(dir: string, name = "index.ts"): string {
	return path.join(dir, name);
}

async function withPathShim(
	binaryName: string,
	fn: () => Promise<void> | void,
): Promise<void> {
	const shimDir = path.join(tmpDir, "shims");
	const exeName = isWin ? `${binaryName}.cmd` : binaryName;
	makeFakeExe(path.join(shimDir, exeName));
	const origPath = process.env.PATH;
	process.env.PATH = `${shimDir}${path.delimiter}${origPath}`;
	try {
		await fn();
	} finally {
		process.env.PATH = origPath;
	}
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let cleanup: () => void;

beforeEach(() => {
	({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-fmt-test-"));
});

afterEach(() => {
	clearFormatterRuntimeState();
	cleanup();
});

// ---------------------------------------------------------------------------
// 1: node_modules/.bin resolution (biome, prettier)
// ---------------------------------------------------------------------------

describe("resolveCommand — node_modules/.bin", () => {
	it("biome: pins detected two-space indentation when unconfigured", async () => {
		const binPath = nodeModulesBin(tmpDir, "biome");
		makeFakeExe(binPath);
		const filePath = fileIn(tmpDir, "index.ts");
		fs.writeFileSync(filePath, "function f() {\n  return 1;\n}\n");

		const cmd = await biomeFormatter.resolveCommand!(filePath, tmpDir);

		expect(cmd).toContain("--indent-style");
		expect(cmd).toContain("space");
		expect(cmd).toContain("--indent-width");
		expect(cmd).toContain("2");
	});

	it("biome: prefers local node_modules/.bin/biome over npx", async () => {
		const binPath = nodeModulesBin(tmpDir, "biome");
		makeFakeExe(binPath);
		const filePath = fileIn(tmpDir, "index.ts");

		const cmd = await biomeFormatter.resolveCommand!(filePath, tmpDir);

		expect(cmd).not.toBeNull();
		expect(cmd![0]).toBe(binPath);
		expect(cmd).toContain("--write");
		expect(cmd).toContain(filePath);
	});

	it("prettier: prefers local node_modules/.bin/prettier over npx", async () => {
		const binPath = nodeModulesBin(tmpDir, "prettier");
		makeFakeExe(binPath);
		const filePath = fileIn(tmpDir, "app.tsx");

		const cmd = await prettierFormatter.resolveCommand!(filePath, tmpDir);

		expect(cmd).not.toBeNull();
		expect(cmd![0]).toBe(binPath);
		expect(cmd).toContain("--write");
		expect(cmd).toContain(filePath);
	});

	it("prettier: skips when indentation is undetectable and no config exists", async () => {
		const binPath = nodeModulesBin(tmpDir, "prettier");
		makeFakeExe(binPath);
		const filePath = fileIn(tmpDir, "app.tsx");
		fs.writeFileSync(filePath, "const value = 1;\n");

		expect(await prettierFormatter.resolveCommand!(filePath, tmpDir)).toBe(
			SKIP_FORMATTING,
		);
	});
});

describe("resolveCommand — shfmt style preservation", () => {
	it("pins detected two-space indentation when unconfigured", async () => {
		await withPathShim("shfmt", async () => {
			const filePath = fileIn(tmpDir, "script.sh");
			fs.writeFileSync(filePath, "if true; then\n  echo hi\nfi\n");

			const cmd = await shfmtFormatter.resolveCommand!(filePath, tmpDir);

			expect(cmd).toContain("-i");
			expect(cmd).toContain("2");
		});
	});
});

// ---------------------------------------------------------------------------
// 2: venv resolution (ruff, black)
// ---------------------------------------------------------------------------

describe("resolveCommand — .venv", () => {
	it("ruff: returns venv binary when present", async () => {
		const binPath = venvBin(tmpDir, "ruff");
		makeFakeExe(binPath);
		const filePath = fileIn(tmpDir, "main.py");

		const cmd = await ruffFormatter.resolveCommand!(filePath, tmpDir);

		expect(cmd).not.toBeNull();
		expect(cmd![0]).toBe(binPath);
		expect(cmd).toContain("format");
		expect(cmd).toContain(filePath);
	});

	// `ruff format` rejects --indent-style/--indent-width ("unexpected argument",
	// exit 2). Back when exit-code strictness was opt-in and ruff had not opted
	// in, formatFile reported that as a clean unchanged file — every unconfigured
	// Python file silently went
	// unformatted. Style must be pinned via inline TOML overrides instead.
	it("ruff: pins detected indentation via --config, never bare --indent-* flags", async () => {
		const binPath = venvBin(tmpDir, "ruff");
		makeFakeExe(binPath);
		const filePath = fileIn(tmpDir, "main.py");
		fs.writeFileSync(filePath, "def f():\n    return 1\n");

		const cmd = await ruffFormatter.resolveCommand!(filePath, tmpDir);

		expect(cmd).not.toBeNull();
		// Exact argv, not containment: containment stayed green when a review
		// probe appended an invented flag — only strict equality screens CLI
		// drift against the real ruff interface (#1336 review finding).
		expect(cmd).toEqual([
			binPath,
			"format",
			"--config",
			"indent-width=4",
			"--config",
			"format.indent-style='space'",
			filePath,
		]);
	});

	it("ruff: pins detected tab indentation via --config", async () => {
		const binPath = venvBin(tmpDir, "ruff");
		makeFakeExe(binPath);
		const filePath = fileIn(tmpDir, "main.py");
		fs.writeFileSync(filePath, "def f():\n\treturn 1\n");

		const cmd = await ruffFormatter.resolveCommand!(filePath, tmpDir);

		expect(cmd).toEqual([
			binPath,
			"format",
			"--config",
			"indent-width=1",
			"--config",
			"format.indent-style='tab'",
			filePath,
		]);
	});

	it("ruff: skips when indentation is undetectable and no config exists", async () => {
		const binPath = venvBin(tmpDir, "ruff");
		makeFakeExe(binPath);
		const filePath = fileIn(tmpDir, "main.py");
		fs.writeFileSync(filePath, "value = 1\n");

		expect(await ruffFormatter.resolveCommand!(filePath, tmpDir)).toBe(
			SKIP_FORMATTING,
		);
	});

	it("ruff: falls back to discovered global install when no venv binary", async () => {
		await withPathShim("ruff", async () => {
			const cmd = await ruffFormatter.resolveCommand!(
				fileIn(tmpDir, "main.py"),
				tmpDir,
			);
			expect(cmd).not.toBeNull();
			expect(String(cmd![0]).toLowerCase()).toContain("ruff");
			expect(cmd).toContain("format");
		});
	});

	it("black: returns venv binary when present", async () => {
		const binPath = venvBin(tmpDir, "black");
		makeFakeExe(binPath);
		const filePath = fileIn(tmpDir, "main.py");

		const cmd = await blackFormatter.resolveCommand!(filePath, tmpDir);

		expect(cmd).not.toBeNull();
		expect(cmd![0]).toBe(binPath);
		expect(cmd![1]).toBe(filePath);
	});

	it("black: returns null when no venv", async () => {
		const cmd = await blackFormatter.resolveCommand!(
			fileIn(tmpDir, "main.py"),
			tmpDir,
		);
		expect(cmd).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 3: bundle exec resolution (rubocop, standardrb)
// ---------------------------------------------------------------------------

describe("resolveCommand — bundle exec", () => {
	it("rubocop: uses bundle exec when bundle + Gemfile.lock present", async () => {
		const shimDir = path.join(tmpDir, "shims");
		const bundleName = isWin ? "bundle.cmd" : "bundle";
		makeFakeExe(path.join(shimDir, bundleName));
		const origPath = process.env.PATH;
		process.env.PATH = `${shimDir}${path.delimiter}${origPath}`;
		createTempFile(tmpDir, "Gemfile.lock", "GEM\n  specs:\n");
		const filePath = fileIn(tmpDir, "app.rb");

		try {
			const cmd = await rubocopFormatter.resolveCommand!(filePath, tmpDir);
			expect(cmd).not.toBeNull();
			expect(cmd![0]).toBe("bundle");
			expect(cmd).toContain("exec");
			expect(cmd).toContain("rubocop");
			expect(cmd).toContain(filePath);
		} finally {
			process.env.PATH = origPath;
		}
	});

	it("rubocop: returns null when no Gemfile.lock", async () => {
		const cmd = await rubocopFormatter.resolveCommand!(
			fileIn(tmpDir, "app.rb"),
			tmpDir,
		);
		expect(cmd).toBeNull();
	});

	it("standardrb: uses bundle exec when Gemfile.lock present", async () => {
		const shimDir = path.join(tmpDir, "shims");
		const bundleName = isWin ? "bundle.cmd" : "bundle";
		makeFakeExe(path.join(shimDir, bundleName));
		const origPath = process.env.PATH;
		process.env.PATH = `${shimDir}${path.delimiter}${origPath}`;
		createTempFile(tmpDir, "Gemfile.lock", "GEM\n  specs:\n");

		try {
			const cmd = await standardrbFormatter.resolveCommand!(
				fileIn(tmpDir, "app.rb"),
				tmpDir,
			);
			expect(cmd).not.toBeNull();
			expect(cmd![0]).toBe("bundle");
			expect(cmd).toContain("standardrb");
		} finally {
			process.env.PATH = origPath;
		}
	});
});

// ---------------------------------------------------------------------------
// 4: vendor/bin resolution (php-cs-fixer)
// ---------------------------------------------------------------------------

describe("resolveCommand — vendor/bin", () => {
	it("php-cs-fixer: prefers vendor/bin over global binary", async () => {
		const binPath = vendorBin(tmpDir, "php-cs-fixer");
		makeFakeExe(binPath);
		const filePath = fileIn(tmpDir, "app.php");

		const cmd = await phpCsFixerFormatter.resolveCommand!(filePath, tmpDir);

		expect(cmd).not.toBeNull();
		expect(cmd![0]).toBe(binPath);
		expect(cmd).toContain("fix");
		expect(cmd).toContain(filePath);
	});

	it("php-cs-fixer: returns null when no vendor/bin", async () => {
		const cmd = await phpCsFixerFormatter.resolveCommand!(
			fileIn(tmpDir, "app.php"),
			tmpDir,
		);
		expect(cmd).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 5: walk-up — binary at project root found from deep subdir
// ---------------------------------------------------------------------------

describe("resolveCommand — walk-up from subdirectory", () => {
	it("ruff venv at root is found when editing file in src/utils/", async () => {
		const rootVenvBin = venvBin(tmpDir, "ruff");
		makeFakeExe(rootVenvBin);

		const subdir = path.join(tmpDir, "src", "utils");
		fs.mkdirSync(subdir, { recursive: true });

		const cmd = await ruffFormatter.resolveCommand!(
			path.join(subdir, "helpers.py"),
			subdir,
		);

		expect(cmd).not.toBeNull();
		expect(cmd![0]).toBe(rootVenvBin);
	});

	it("node_modules/.bin/biome at root found from packages/ui/src", async () => {
		const rootBin = nodeModulesBin(tmpDir, "biome");
		makeFakeExe(rootBin);

		const subdir = path.join(tmpDir, "packages", "ui", "src");
		fs.mkdirSync(subdir, { recursive: true });

		const cmd = await biomeFormatter.resolveCommand!(
			path.join(subdir, "Button.tsx"),
			subdir,
		);

		expect(cmd).not.toBeNull();
		expect(cmd![0]).toBe(rootBin);
	});

	it("vendor/bin/php-cs-fixer at root found from src/Controllers/", async () => {
		const rootVendorBin = vendorBin(tmpDir, "php-cs-fixer");
		makeFakeExe(rootVendorBin);

		const subdir = path.join(tmpDir, "src", "Controllers");
		fs.mkdirSync(subdir, { recursive: true });

		const cmd = await phpCsFixerFormatter.resolveCommand!(
			path.join(subdir, "User.php"),
			subdir,
		);

		expect(cmd).not.toBeNull();
		expect(cmd![0]).toBe(rootVendorBin);
	});
});

// ---------------------------------------------------------------------------
// 6: nearest-wins package.json detection
// ---------------------------------------------------------------------------

describe("getFormattersForFile — policy selection", () => {
	it("uses biome as the smart default for unconfigured TypeScript files", async () => {
		const filePath = fileIn(tmpDir, "index.ts");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["biome"]);
	});

	it("uses biome as the smart default for unconfigured CSS files", async () => {
		const filePath = fileIn(tmpDir, "styles.css");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["biome"]);
	});

	it("uses ruff as the smart default for unconfigured Python files", async () => {
		const filePath = fileIn(tmpDir, "main.py");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["ruff"]);
	});

	it("does not force a formatter for unconfigured JSON files", async () => {
		const filePath = fileIn(tmpDir, "config.json");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	// #2384: unconfigured HTML/YAML commonly carry template markers ({{JS}}
	// embeds, Helm `{{ .Values.x }}`) that real Prettier corrupts. No
	// unconfigured formatter may be selected for these extensions.
	it.each(["page.html", "page.htm", "config.yaml", "config.yml"])(
		"does not force a formatter for unconfigured %s files (#2384)",
		async (name) => {
			const filePath = fileIn(tmpDir, name);
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters).toEqual([]);
		},
	);

	it.each(["page.html", "config.yaml"])(
		"runs prettier on %s when project has explicit prettier config (#2384)",
		async (name) => {
			createTempFile(tmpDir, ".prettierrc", "{}");
			const filePath = fileIn(tmpDir, name);
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["prettier"]);
		},
	);

	it("does not force prettier on unconfigured Markdown files", async () => {
		// Prettier's markdown defaults reflow lines and normalize emphasis markers,
		// producing noisy diffs on doc-only writes. Users opt in via project prettier config.
		const filePath = fileIn(tmpDir, "README.md");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("does not force prettier on unconfigured .mdx files", async () => {
		const filePath = fileIn(tmpDir, "page.mdx");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("runs prettier on Markdown when project has explicit prettier config", async () => {
		createTempFile(tmpDir, ".prettierrc", "{}");
		const filePath = fileIn(tmpDir, "README.md");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["prettier"]);
	});

	it("re-detects after a formatter config is added", async () => {
		const filePath = fileIn(tmpDir, "README.md");
		expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
		createTempFile(tmpDir, ".prettierrc", "{}\n");
		invalidateFormatterCacheForPath(path.join(tmpDir, ".prettierrc"));
		expect(
			(await getFormattersForFile(filePath, tmpDir)).map((f) => f.name),
		).toEqual(["prettier"]);
	});

	it("does not force a formatter for unconfigured SQL files", async () => {
		const filePath = fileIn(tmpDir, "query.sql");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables config-gated SQL formatter when sqlfluff config is present", async () => {
		createTempFile(tmpDir, ".sqlfluff", "[sqlfluff]\ndialect = postgres\n");
		const filePath = fileIn(tmpDir, "query.sql");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["sqlfluff"]);
	});

	it("enables config-gated black formatter when black config is present", async () => {
		createTempFile(
			tmpDir,
			"pyproject.toml",
			"[tool.black]\nline-length = 88\n",
		);
		const filePath = fileIn(tmpDir, "main.py");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["black"]);
	});

	it("uses shfmt as the smart default for shell files when available", async () => {
		await withPathShim("shfmt", async () => {
			const filePath = fileIn(tmpDir, "script.sh");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["shfmt"]);
		});
	});

	it("does not force ktlint on unconfigured Kotlin files", async () => {
		await withPathShim("ktlint", async () => {
			const filePath = fileIn(tmpDir, "App.kt");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters).toEqual([]);
		});
	});

	it("prefers ktfmt over the ktlint default when the project opts in (#129)", async () => {
		createTempFile(tmpDir, ".ktfmt", "");
		await withPathShim("ktfmt", async () => {
			const filePath = fileIn(tmpDir, "App.kt");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["ktfmt"]);
		});
	});

	it("selects Spotless ktlint on every invocation and never ktfmt (#1306)", async () => {
		const fixtureRoot = path.resolve(
			"tests/fixtures/formatter-policy/kotlin-ktlint",
		);
		const filePath = path.join(fixtureRoot, "src", "App.kt");
		for (let invocation = 0; invocation < 5; invocation += 1) {
			const formatters = await getFormattersForFile(filePath, fixtureRoot);
			expect(formatters.map((formatter) => formatter.name)).toEqual(["ktlint"]);
			expect(formatters.some((formatter) => formatter.name === "ktfmt")).toBe(
				false,
			);
		}
	});

	it("selects ktlint for a 76-file multi-directory session with one Gradle read (#1306)", async () => {
		createTempFile(
			tmpDir,
			"settings.gradle.kts",
			"spotless {\n  kotlin {\n    ktlint()\n  }\n}\n",
		);
		const files = Array.from({ length: 76 }, (_, index) => {
			const filePath = path.join(
				tmpDir,
				"modules",
				`module-${index % 13}`,
				"src",
				`File${index}.kt`,
			);
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, `class File${index}\n`);
			return filePath;
		});
		const readsBefore = _getSpotlessGradleReadCountForTests();
		for (const filePath of files) {
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((formatter) => formatter.name)).toEqual(["ktlint"]);
		}
		expect(_getSpotlessGradleReadCountForTests() - readsBefore).toBe(1);
	});

	it("selects Spotless ktfmt and never ktlint (#1306)", async () => {
		createTempFile(
			tmpDir,
			"build.gradle.kts",
			"spotless {\n  kotlin {\n    ktfmt()\n  }\n}\n",
		);
		const formatters = await getFormattersForFile(
			fileIn(tmpDir, "App.kt"),
			tmpDir,
		);
		expect(formatters.map((formatter) => formatter.name)).toEqual(["ktfmt"]);
	});

	it("does not force swiftformat on unconfigured Swift files", async () => {
		await withPathShim("swiftformat", async () => {
			const filePath = fileIn(tmpDir, "App.swift");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters).toEqual([]);
		});
	});

	it("does not force fantomas on unconfigured F# files", async () => {
		await withPathShim("fantomas", async () => {
			const filePath = fileIn(tmpDir, "App.fs");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters).toEqual([]);
		});
	});

	it("does not force nixfmt on unconfigured Nix files", async () => {
		await withPathShim("nixfmt", async () => {
			const filePath = fileIn(tmpDir, "flake.nix");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters).toEqual([]);
		});
	});

	it("does not force mix on an unconfigured Elixir project", async () => {
		createTempFile(tmpDir, "mix.exs", "defmodule Demo.MixProject do\nend\n");
		await withPathShim("mix", async () => {
			const filePath = path.join(tmpDir, "lib", "app.ex");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters).toEqual([]);
		});
	});

	it("uses gleam as the smart default for Gleam files when available in a Gleam project", async () => {
		createTempFile(tmpDir, "gleam.toml", 'name = "demo"\nversion = "1.0.0"\n');
		await withPathShim("gleam", async () => {
			const filePath = path.join(tmpDir, "src", "app.gleam");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["gleam"]);
		});
	});

	it("does not force csharpier on unconfigured C# files", async () => {
		await withPathShim("dotnet", async () => {
			const filePath = fileIn(tmpDir, "Program.cs");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters).toEqual([]);
		});
	});

	it("does not force ormolu on unconfigured Haskell files", async () => {
		await withPathShim("ormolu", async () => {
			const filePath = fileIn(tmpDir, "Main.hs");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters).toEqual([]);
		});
	});

	it("does not force clang-format without config", async () => {
		const filePath = fileIn(tmpDir, "main.cpp");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables clang-format when explicit config is present", async () => {
		createTempFile(tmpDir, ".clang-format", "BasedOnStyle: LLVM\n");
		const filePath = fileIn(tmpDir, "main.cpp");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["clang-format"]);
	});

	it("does not force php-cs-fixer without config", async () => {
		const filePath = fileIn(tmpDir, "index.php");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables php-cs-fixer when explicit config is present", async () => {
		createTempFile(tmpDir, ".php-cs-fixer.dist.php", "<?php return [];\n");
		const filePath = fileIn(tmpDir, "index.php");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["php-cs-fixer"]);
	});

	it("does not force stylua without config", async () => {
		const filePath = fileIn(tmpDir, "init.lua");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables stylua when explicit config is present", async () => {
		createTempFile(tmpDir, "stylua.toml", "column_width = 100\n");
		const filePath = fileIn(tmpDir, "init.lua");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["stylua"]);
	});

	it("does not force ocamlformat without config", async () => {
		const filePath = fileIn(tmpDir, "main.ml");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables ocamlformat when explicit config is present", async () => {
		createTempFile(tmpDir, ".ocamlformat", "profile = conventional\n");
		const filePath = fileIn(tmpDir, "main.ml");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["ocamlformat"]);
	});

	it("uses terragrunt-hcl as the smart default for terragrunt.hcl when available", async () => {
		await withPathShim("terragrunt", async () => {
			const filePath = fileIn(tmpDir, "terragrunt.hcl");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["terragrunt-hcl"]);
		});
	});

	it("uses terragrunt-hcl as the smart default for root.hcl when available", async () => {
		await withPathShim("terragrunt", async () => {
			const filePath = fileIn(tmpDir, "root.hcl");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["terragrunt-hcl"]);
		});
	});

	it("matches terragrunt-hcl for Terragrunt.HCL regardless of case", async () => {
		await withPathShim("terragrunt", async () => {
			const filePath = fileIn(tmpDir, "Terragrunt.HCL");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["terragrunt-hcl"]);
		});
	});

	it("does not match terragrunt-hcl for a generic .hcl file", async () => {
		await withPathShim("terragrunt", async () => {
			const formatters = await getFormattersForFile(
				fileIn(tmpDir, "packer.hcl"),
				tmpDir,
			);
			expect(formatters).toEqual([]);
		});
	});

	it("plain .hcl cached first does not suppress terragrunt.hcl in the same dir", async () => {
		await withPathShim("terragrunt", async () => {
			const plain = await getFormattersForFile(
				fileIn(tmpDir, ".terraform.lock.hcl"),
				tmpDir,
			);
			expect(plain).toEqual([]);
			const terragrunt = await getFormattersForFile(
				fileIn(tmpDir, "terragrunt.hcl"),
				tmpDir,
			);
			expect(terragrunt.map((f) => f.name)).toEqual(["terragrunt-hcl"]);
		});
	});

	it("terragrunt.hcl cached first does not leak its formatter onto plain .hcl", async () => {
		await withPathShim("terragrunt", async () => {
			const terragrunt = await getFormattersForFile(
				fileIn(tmpDir, "terragrunt.hcl"),
				tmpDir,
			);
			expect(terragrunt.map((f) => f.name)).toEqual(["terragrunt-hcl"]);
			const plain = await getFormattersForFile(
				fileIn(tmpDir, ".terraform.lock.hcl"),
				tmpDir,
			);
			expect(plain).toEqual([]);
		});
	});

	it("does not force taplo on unconfigured TOML files", async () => {
		await withPathShim("taplo", async () => {
			const filePath = fileIn(tmpDir, "config.toml");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters).toEqual([]);
		});
	});

	it("does not activate ruff smart-default when black config is in a parent directory", async () => {
		createTempFile(
			tmpDir,
			"pyproject.toml",
			"[tool.black]\nline-length = 88\n",
		);
		const subDir = path.join(tmpDir, "src");
		fs.mkdirSync(subDir, { recursive: true });
		const filePath = fileIn(subDir, "main.py");
		const formatters = await getFormattersForFile(filePath, subDir);
		expect(formatters.map((f) => f.name)).toEqual(["black"]);
	});

	it("does not activate biome smart-default when prettier has explicit config in cwd", async () => {
		createTempFile(tmpDir, ".prettierrc", "{}");
		const filePath = fileIn(tmpDir, "index.ts");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["prettier"]);
	});

	it("does not activate biome smart-default when prettier config is in a parent directory", async () => {
		createTempFile(tmpDir, ".prettierrc", "{}");
		const subDir = path.join(tmpDir, "src");
		fs.mkdirSync(subDir, { recursive: true });
		const filePath = fileIn(subDir, "index.ts");
		const formatters = await getFormattersForFile(filePath, subDir);
		expect(formatters.map((f) => f.name)).toEqual(["prettier"]);
	});

	it("selects config-first formatters from ancestors above package.json boundaries", async () => {
		const cases: Array<{
			name: string;
			ext: string;
			configFile: string;
			content: string;
		}> = [
			{
				name: "sqlfluff",
				ext: ".sql",
				configFile: ".sqlfluff",
				content: "[sqlfluff]\ndialect = postgres\n",
			},
			{
				name: "clang-format",
				ext: ".cpp",
				configFile: ".clang-format",
				content: "BasedOnStyle: LLVM\n",
			},
			{
				name: "php-cs-fixer",
				ext: ".php",
				configFile: ".php-cs-fixer.dist.php",
				content: "<?php return [];\n",
			},
			{
				name: "stylua",
				ext: ".lua",
				configFile: "stylua.toml",
				content: "column_width = 100\n",
			},
			{
				name: "ocamlformat",
				ext: ".ml",
				configFile: ".ocamlformat",
				content: "profile = conventional\n",
			},
			{
				name: "google-java-format",
				ext: ".java",
				configFile: ".google-java-format",
				content: "{}\n",
			},
			{
				name: "cljfmt",
				ext: ".clj",
				configFile: ".cljfmt.edn",
				content: "{}\n",
			},
			{
				name: "cmake-format",
				ext: ".cmake",
				configFile: ".cmake-format",
				content: "# cmake-format config\n",
			},
			{
				// #1572: psscriptanalyzer-format had no hasExplicitFormatterConfig
				// case at all, so no project configuration could ever select it.
				name: "psscriptanalyzer-format",
				ext: ".ps1",
				configFile: "PSScriptAnalyzerSettings.psd1",
				content: "@{}\n",
			},
			// #1595: same shape as #1572 for 7 more formatters left unreachable by
			// 038cd1df (defaultWhenUnconfigured flipped to false, no explicit-config
			// check added). nixfmt (the 8th) has no config surface at all and stays
			// unreachable — see tool-policy.ts's comment above hasCsharpierConfig.
			{
				name: "csharpier",
				ext: ".cs",
				configFile: ".csharpierrc",
				content: "{}\n",
			},
			{
				name: "ormolu",
				ext: ".hs",
				configFile: ".ormolu",
				content: "\n",
			},
			{
				name: "taplo",
				ext: ".toml",
				configFile: "taplo.toml",
				content: "[formatting]\n",
			},
			{
				name: "terraform",
				ext: ".tf",
				configFile: ".terraform.lock.hcl",
				content: "\n",
			},
			{
				name: "swiftformat",
				ext: ".swift",
				configFile: ".swiftformat",
				content: "--indent 4\n",
			},
			{
				name: "fantomas",
				ext: ".fs",
				configFile: ".fantomasignore",
				content: "\n",
			},
			{
				name: "mix",
				ext: ".ex",
				configFile: ".formatter.exs",
				content: '[inputs: ["{mix,.formatter}.exs"]]\n',
			},
		];

		for (const testCase of cases) {
			const caseRoot = path.join(tmpDir, `case-${testCase.name}`);
			const nestedDir = path.join(caseRoot, "packages", "ui", "src");
			createTempFile(caseRoot, testCase.configFile, testCase.content);
			createTempFile(
				path.join(caseRoot, "packages", "ui"),
				"package.json",
				JSON.stringify({ name: "ui" }),
			);
			const filePath = path.join(nestedDir, `file${testCase.ext}`);
			const formatters = await getFormattersForFile(filePath, nestedDir);
			expect(
				formatters.map((f) => f.name),
				testCase.name,
			).toEqual([testCase.name]);
		}
	});

	it("keeps config-first formatters disabled without explicit config", async () => {
		const cases: Array<[string, string]> = [
			["config.json", ".json"],
			["query.sql", ".sql"],
			["main.cpp", ".cpp"],
			["index.php", ".php"],
			["init.lua", ".lua"],
			["main.ml", ".ml"],
			["Main.java", ".java"],
			["core.clj", ".clj"],
			["CMakeLists.cmake", ".cmake"],
			["script.ps1", ".ps1"],
			["Program.cs", ".cs"],
			["Main.hs", ".hs"],
			["config.toml", ".toml"],
			["main.tf", ".tf"],
			["Main.swift", ".swift"],
			["Program.fs", ".fs"],
			["mix.ex", ".ex"],
		];

		for (const [fileName] of cases) {
			const caseDir = path.join(tmpDir, `no-config-${fileName}`);
			fs.mkdirSync(caseDir, { recursive: true });
			const formatters = await getFormattersForFile(
				path.join(caseDir, fileName),
				caseDir,
			);
			expect(formatters, fileName).toEqual([]);
		}
	});

	it("does not force google-java-format without config", async () => {
		const filePath = fileIn(tmpDir, "Main.java");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables google-java-format when .editorconfig is present", async () => {
		createTempFile(tmpDir, ".editorconfig", "[*.java]\nindent_size = 4\n");
		await withPathShim("google-java-format", async () => {
			const filePath = fileIn(tmpDir, "Main.java");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["google-java-format"]);
		});
	});

	it("does not force cljfmt without config", async () => {
		const filePath = fileIn(tmpDir, "core.clj");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables cljfmt when .cljfmt.edn is present", async () => {
		createTempFile(tmpDir, ".cljfmt.edn", "{}\n");
		await withPathShim("cljfmt", async () => {
			const filePath = fileIn(tmpDir, "core.clj");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["cljfmt"]);
		});
	});

	it("does not force cmake-format without config", async () => {
		const filePath = fileIn(tmpDir, "CMakeLists.cmake");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables cmake-format when .cmake-format is present", async () => {
		createTempFile(tmpDir, ".cmake-format", "# cmake-format config\n");
		await withPathShim("cmake-format", async () => {
			const filePath = fileIn(tmpDir, "CMakeLists.cmake");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["cmake-format"]);
		});
	});

	// #1572: `.ps1`'s policy sets defaultWhenUnconfigured: false, and
	// psscriptanalyzer-format had no hasExplicitFormatterConfig case — so
	// neither branch of getFormattersForFile could ever select it, regardless
	// of project configuration. These two tests are the direct reproduction.
	it("does not force psscriptanalyzer-format without config", async () => {
		const filePath = fileIn(tmpDir, "script.ps1");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables psscriptanalyzer-format when PSScriptAnalyzerSettings.psd1 is present", async () => {
		createTempFile(tmpDir, "PSScriptAnalyzerSettings.psd1", "@{}\n");
		const filePath = fileIn(tmpDir, "script.ps1");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["psscriptanalyzer-format"]);
	});

	it("enables psscriptanalyzer-format when ScriptAnalyzerSettings.psd1 is present", async () => {
		createTempFile(tmpDir, "ScriptAnalyzerSettings.psd1", "@{}\n");
		const filePath = fileIn(tmpDir, "script.psm1");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["psscriptanalyzer-format"]);
	});

	// #1595 — same shape as #1572, 7 more formatters (038cd1df flipped
	// defaultWhenUnconfigured to false without adding an explicit-config check).
	it("does not force csharpier without config", async () => {
		const filePath = fileIn(tmpDir, "Program.cs");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables csharpier when .csharpierrc is present", async () => {
		createTempFile(tmpDir, ".csharpierrc", "{}\n");
		const filePath = fileIn(tmpDir, "Program.cs");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["csharpier"]);
	});

	it("does not force ormolu without config", async () => {
		const filePath = fileIn(tmpDir, "Main.hs");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables ormolu when .ormolu is present", async () => {
		createTempFile(tmpDir, ".ormolu", "\n");
		const filePath = fileIn(tmpDir, "Main.hs");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["ormolu"]);
	});

	it("does not force taplo without config", async () => {
		const filePath = fileIn(tmpDir, "config.toml");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables taplo when taplo.toml is present", async () => {
		createTempFile(tmpDir, "taplo.toml", "[formatting]\n");
		const filePath = fileIn(tmpDir, "config.toml");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["taplo"]);
	});

	it("does not force terraform without config", async () => {
		const filePath = fileIn(tmpDir, "main.tf");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables terraform when .terraform.lock.hcl is present (terraform init marker)", async () => {
		createTempFile(tmpDir, ".terraform.lock.hcl", "\n");
		const filePath = fileIn(tmpDir, "main.tf");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["terraform"]);
	});

	it("does not force swiftformat without config", async () => {
		const filePath = fileIn(tmpDir, "Main.swift");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables swiftformat when .swiftformat is present", async () => {
		createTempFile(tmpDir, ".swiftformat", "--indent 4\n");
		const filePath = fileIn(tmpDir, "Main.swift");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["swiftformat"]);
	});

	it("does not force fantomas without config", async () => {
		const filePath = fileIn(tmpDir, "Program.fs");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables fantomas when .fantomasignore is present", async () => {
		createTempFile(tmpDir, ".fantomasignore", "\n");
		const filePath = fileIn(tmpDir, "Program.fs");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["fantomas"]);
	});

	it("enables fantomas when .editorconfig is present", async () => {
		createTempFile(
			tmpDir,
			".editorconfig",
			"[*.fs]\nfsharp_space_before_uppercase_invocation = true\n",
		);
		const filePath = fileIn(tmpDir, "Program.fs");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["fantomas"]);
	});

	it("does not force mix without config", async () => {
		const filePath = fileIn(tmpDir, "mix.ex");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters).toEqual([]);
	});

	it("enables mix when .formatter.exs is present", async () => {
		createTempFile(
			tmpDir,
			".formatter.exs",
			'[inputs: ["{mix,.formatter}.exs"]]\n',
		);
		const filePath = fileIn(tmpDir, "mix.ex");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["mix"]);
	});

	// #1572 review F1: `getFormattersForFile` caches its answer per cwd. Config
	// create/change/remove events invalidate that cache through the write-result
	// seam, so these tests report the changed path before the second lookup.
	describe("formatter config invalidation after the first call", () => {
		it("control: stylua.toml created after the first call is picked up", async () => {
			const filePath = fileIn(tmpDir, "init.lua");
			expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
			createTempFile(tmpDir, "stylua.toml", "column_width = 100\n");
			invalidateFormatterCacheForPath(path.join(tmpDir, "stylua.toml"));
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["stylua"]);
		});

		it("psscriptanalyzer-format: PSScriptAnalyzerSettings.psd1 created after the first call is picked up", async () => {
			const filePath = fileIn(tmpDir, "script.ps1");
			expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
			createTempFile(tmpDir, "PSScriptAnalyzerSettings.psd1", "@{}\n");
			invalidateFormatterCacheForPath(
				path.join(tmpDir, "PSScriptAnalyzerSettings.psd1"),
			);
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual([
				"psscriptanalyzer-format",
			]);
		});

		it("google-java-format: .google-java-format created after the first call is picked up", async () => {
			const filePath = fileIn(tmpDir, "Main.java");
			expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
			createTempFile(tmpDir, ".google-java-format", "{}\n");
			invalidateFormatterCacheForPath(path.join(tmpDir, ".google-java-format"));
			await withPathShim("google-java-format", async () => {
				const formatters = await getFormattersForFile(filePath, tmpDir);
				expect(formatters.map((f) => f.name)).toEqual(["google-java-format"]);
			});
		});

		it("cmake-format: .cmake-format created after the first call is picked up", async () => {
			const filePath = fileIn(tmpDir, "CMakeLists.cmake");
			expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
			createTempFile(tmpDir, ".cmake-format", "# cmake-format config\n");
			invalidateFormatterCacheForPath(path.join(tmpDir, ".cmake-format"));
			await withPathShim("cmake-format", async () => {
				const formatters = await getFormattersForFile(filePath, tmpDir);
				expect(formatters.map((f) => f.name)).toEqual(["cmake-format"]);
			});
		});

		it("sqlfluff: setup.cfg's [sqlfluff] section created after the first call is picked up", async () => {
			const filePath = fileIn(tmpDir, "query.sql");
			expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
			createTempFile(tmpDir, "setup.cfg", "[sqlfluff]\ndialect = postgres\n");
			invalidateFormatterCacheForPath(path.join(tmpDir, "setup.cfg"));
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["sqlfluff"]);
		});

		it("oxfmt: vite-plus.json created after the first call is picked up", async () => {
			// .css's policy smart-defaults to biome when nothing has explicit
			// config; oxfmt only outranks it once oxfmt's OWN explicit-config
			// check (hasVitePlusConfig) goes true. So the observable signal here
			// isn't "was anything selected" (biome always is) but "did the WINNER
			// change" — which only happens if the cache actually re-reads
			// vite-plus.json after it's created.
			const filePath = fileIn(tmpDir, "index.css");
			expect(
				(await getFormattersForFile(filePath, tmpDir)).map((f) => f.name),
			).toEqual(["biome"]);
			createTempFile(tmpDir, "vite-plus.json", "{}\n");
			invalidateFormatterCacheForPath(path.join(tmpDir, "vite-plus.json"));
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["oxfmt"]);
		});

		it("ktfmt: build.gradle.kts's Spotless ktfmt() block created after the first call is picked up", async () => {
			const filePath = fileIn(tmpDir, "Main.kt");
			expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
			createTempFile(
				tmpDir,
				"build.gradle.kts",
				"spotless {\n  kotlin {\n    ktfmt()\n  }\n}\n",
			);
			invalidateFormatterCacheForPath(path.join(tmpDir, "build.gradle.kts"));
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["ktfmt"]);
		});

		// #1595 sweep: each of these filenames must be in FORMATTER_CONFIG_FILES
		// (clients/formatters.ts) or the cache signature never moves when the
		// file is created after the first call — the exact #1572 review F1 class
		// of bug, now proven per formatter via one parameterized table rather
		// than seven near-identical `it` blocks (Sonar CPD; #1661's
		// bad-duplicate-parameterized-rows shape).
		it.each([
			["csharpier", "Program.cs", ".csharpierrc", "{}\n"],
			["ormolu", "Main.hs", ".ormolu", "\n"],
			["taplo", "config.toml", "taplo.toml", "[formatting]\n"],
			["terraform", "main.tf", ".terraform.lock.hcl", "\n"],
			["swiftformat", "Main.swift", ".swiftformat", "--indent 4\n"],
			["fantomas", "Program.fs", ".fantomasignore", "\n"],
			[
				"mix",
				"mix.ex",
				".formatter.exs",
				'[inputs: ["{mix,.formatter}.exs"]]\n',
			],
		] as const)(
			"%s: %s created after the first call is picked up",
			async (formatterName, fileName, configFile, configContent) => {
				const filePath = fileIn(tmpDir, fileName);
				expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
				createTempFile(tmpDir, configFile, configContent);
				invalidateFormatterCacheForPath(path.join(tmpDir, configFile));
				const formatters = await getFormattersForFile(filePath, tmpDir);
				expect(formatters.map((f) => f.name)).toEqual([formatterName]);
			},
		);
	});

	// #1572 review F2: the gate DETECTED the settings file but the command
	// never PASSED it to `Invoke-Formatter`, so an opted-in project silently
	// got the stock `CodeFormatting` ruleset instead of its declared one — the
	// exact stock-style imposition #1144 banned in this same file.
	describe("psscriptanalyzer-format resolveCommand wires -Settings through", () => {
		it("passes -Settings with the resolved config path when one exists", async () => {
			createTempFile(tmpDir, "PSScriptAnalyzerSettings.psd1", "@{}\n");
			await withPathShim("pwsh", async () => {
				const cmd = await psscriptanalyzerFormatFormatter.resolveCommand!(
					fileIn(tmpDir, "script.ps1"),
					tmpDir,
				);
				expect(cmd).not.toBeNull();
				const script = cmd![cmd!.length - 1];
				expect(script).toContain("-Settings");
				expect(script).toContain(
					path.join(tmpDir, "PSScriptAnalyzerSettings.psd1"),
				);
			});
		});

		it("omits -Settings when no config file exists", async () => {
			await withPathShim("pwsh", async () => {
				const cmd = await psscriptanalyzerFormatFormatter.resolveCommand!(
					fileIn(tmpDir, "script.ps1"),
					tmpDir,
				);
				expect(cmd).not.toBeNull();
				const script = cmd![cmd!.length - 1];
				expect(script).not.toContain("-Settings");
			});
		});
	});

	it("taplo resolveCommand falls back to managed install when not on PATH", async () => {
		const managedPath = isWin
			? path.join(tmpDir, "managed", "taplo.exe")
			: path.join(tmpDir, "managed", "taplo");
		makeFakeExe(managedPath);
		const installer = await import("../../clients/installer/index.js");
		const spy = vi
			.spyOn(installer, "ensureTool")
			.mockResolvedValue(managedPath);
		try {
			const formatters = await import("../../clients/formatters.js");
			const cmd = await formatters.taploFormatter.resolveCommand!(
				fileIn(tmpDir, "config.toml"),
				tmpDir,
			);
			expect(spy).toHaveBeenCalledWith("taplo");
			expect(cmd).toEqual([managedPath, "fmt", fileIn(tmpDir, "config.toml")]);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("detect — nearest-wins package.json", () => {
	it("biome: subpackage without biome is NOT detected even if root has it", async () => {
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.0.0" } }),
		);
		const subPkgDir = path.join(tmpDir, "packages", "ui");
		createTempFile(
			subPkgDir,
			"package.json",
			JSON.stringify({ name: "ui", devDependencies: {} }),
		);

		expect(await biomeFormatter.detect(subPkgDir)).toBe(false);
	});

	it("biome: detected when nearest package.json has @biomejs/biome", async () => {
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.0.0" } }),
		);
		expect(await biomeFormatter.detect(tmpDir)).toBe(true);
	});

	it("prettier: detected when nearest package.json has prettier dependency", async () => {
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }),
		);
		expect(await prettierFormatter.detect(tmpDir)).toBe(true);
	});

	it("prettier: subpackage without prettier is NOT detected even if root has it", async () => {
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }),
		);
		const subPkgDir = path.join(tmpDir, "packages", "server");
		createTempFile(
			subPkgDir,
			"package.json",
			JSON.stringify({ name: "server", devDependencies: {} }),
		);

		expect(await prettierFormatter.detect(subPkgDir)).toBe(false);
	});

	it("prettier: detected via prettier field in nearest package.json", async () => {
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ prettier: { singleQuote: true } }),
		);
		expect(await prettierFormatter.detect(tmpDir)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// oxfmt formatter
// ---------------------------------------------------------------------------

describe("oxfmt formatter — detection and policy selection", () => {
	it("detected via oxfmt.toml", async () => {
		createTempFile(tmpDir, "oxfmt.toml", "# oxfmt config\n");
		expect(await oxfmtFormatter.detect(tmpDir)).toBe(true);
	});

	it("detected via @oxc-project/oxfmt in devDependencies", async () => {
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ devDependencies: { "@oxc-project/oxfmt": "^0.1.0" } }),
		);
		expect(await oxfmtFormatter.detect(tmpDir)).toBe(true);
	});

	it("detected via @oxc-project/oxfmt in dependencies", async () => {
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ dependencies: { "@oxc-project/oxfmt": "^0.1.0" } }),
		);
		expect(await oxfmtFormatter.detect(tmpDir)).toBe(true);
	});

	it("not detected when neither oxfmt.toml nor package.json dep is present", async () => {
		expect(await oxfmtFormatter.detect(tmpDir)).toBe(false);
	});

	it("getFormattersForFile selects oxfmt for TypeScript when oxfmt.toml is present", async () => {
		createTempFile(tmpDir, "oxfmt.toml", "# oxfmt config\n");
		const filePath = fileIn(tmpDir, "index.ts");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["oxfmt"]);
	});

	it("getFormattersForFile selects oxfmt for JS when oxfmt.toml is present", async () => {
		createTempFile(tmpDir, "oxfmt.toml", "# oxfmt config\n");
		const formatters = await getFormattersForFile(
			fileIn(tmpDir, "app.js"),
			tmpDir,
		);
		expect(formatters.map((f) => f.name)).toEqual(["oxfmt"]);
	});

	it("selects oxfmt from repo root config across package.json boundaries", async () => {
		createTempFile(tmpDir, ".oxfmtrc.json", "{}\n");
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ devDependencies: { "@oxc-project/oxfmt": "^0.1.0" } }),
		);
		const subPkgDir = path.join(tmpDir, "shared", "foo");
		createTempFile(subPkgDir, "package.json", JSON.stringify({ name: "foo" }));
		const filePath = fileIn(path.join(subPkgDir, "src"), "bar.js");

		const formatters = await getFormattersForFile(
			filePath,
			path.dirname(filePath),
		);

		expect(await oxfmtFormatter.detect(path.dirname(filePath))).toBe(true);
		expect(formatters.map((f) => f.name)).toEqual(["oxfmt"]);
	});

	it("detects oxfmt dependency in an ancestor package.json", async () => {
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ devDependencies: { "@oxc-project/oxfmt": "^0.1.0" } }),
		);
		const subPkgDir = path.join(tmpDir, "shared", "foo");
		createTempFile(subPkgDir, "package.json", JSON.stringify({ name: "foo" }));

		expect(await oxfmtFormatter.detect(path.join(subPkgDir, "src"))).toBe(true);
	});

	it("biome wins over oxfmt when both configs are present", async () => {
		createTempFile(tmpDir, "oxfmt.toml", "# oxfmt config\n");
		createTempFile(
			tmpDir,
			"biome.json",
			JSON.stringify({
				$schema: "https://biomejs.dev/schemas/1.0.0/schema.json",
			}),
		);
		const filePath = fileIn(tmpDir, "index.ts");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["biome"]);
	});

	it("biome is still the smart default when oxfmt is absent", async () => {
		const filePath = fileIn(tmpDir, "index.ts");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["biome"]);
	});

	it("resolveCommand prefers node_modules/.bin/oxfmt", async () => {
		const bin = nodeModulesBin(tmpDir, "oxfmt");
		makeFakeExe(bin);
		const filePath = fileIn(tmpDir, "index.ts");
		const cmd = await oxfmtFormatter.resolveCommand!(filePath, tmpDir);
		// #1844 F1: the unmatched-pattern flag sits between the binary and the
		// path, so a file the oxfmt config ignores is a clean no-op rather than
		// an exit-2 formatting failure.
		expect(cmd).toEqual([bin, "--no-error-on-unmatched-pattern", filePath]);
	});

	it("detected via vite-plus in devDependencies", async () => {
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ devDependencies: { "vite-plus": "^0.1.0" } }),
		);
		expect(await oxfmtFormatter.detect(tmpDir)).toBe(true);
	});

	it("resolveCommand uses vp fmt when Vite+ is configured", async () => {
		createTempFile(
			tmpDir,
			"package.json",
			JSON.stringify({ devDependencies: { "vite-plus": "^0.1.0" } }),
		);
		const vp = nodeModulesBin(tmpDir, "vp");
		makeFakeExe(vp);
		const filePath = fileIn(tmpDir, "index.ts");
		const cmd = await oxfmtFormatter.resolveCommand!(filePath, tmpDir);
		expect(cmd).toEqual([vp, "fmt", filePath, "--write"]);
	});

	const oxfmtExtensionFiles = [
		"style.css",
		"style.scss",
		"app.vue",
		"data.json",
		"config.jsonc",
		"config.yaml",
		"config.yml",
		"README.md",
		"page.mdx",
		"query.graphql",
		"query.gql",
		"config.toml",
		"style.less",
		"page.html",
	];

	// Cross-product: every supported extension × every oxfmt config file.
	// Some extensions keep defaultWhenUnconfigured:true formatters (css/scss,
	// graphql/gql, less…), so we assert oxfmt is included rather than being
	// the sole formatter. yaml/html select no unconfigured formatter (#2384).
	it.each(
		oxfmtExtensionFiles.flatMap((f) => [
			[f, "oxfmt.toml", "# oxfmt config\n"] as const,
			[f, ".oxfmtrc.json", "{}\n"] as const,
		]),
	)(
		"includes oxfmt for %s when %s is present",
		async (fileName, configFile, configContent) => {
			createTempFile(tmpDir, configFile, configContent);
			const formatters = await getFormattersForFile(
				fileIn(tmpDir, fileName),
				tmpDir,
			);
			expect(formatters.map((f) => f.name)).toContain("oxfmt");
		},
	);
});

// ---------------------------------------------------------------------------
// oxfmt + .svelte — a stricter conditional gate than the other oxfmt extensions
// ---------------------------------------------------------------------------
//
// Empirically verified against the real `oxfmt` npm package (0.62.0, scratch
// fixture outside vitest — see PR body for the full four-cell matrix): unlike
// oxfmt's other supported extensions, `.svelte` requires BOTH the `svelte`
// package installed AND the config's `svelte` flag enabled. Either alone
// always fails at runtime (exit 2), so — unlike the cross-product above —
// "an oxfmt config file exists" is NOT sufficient for `.svelte` to be offered.
describe("oxfmt formatter — .svelte conditional gate (#1134)", () => {
	function svelteComponent(dir: string): string {
		return fileIn(dir, "Component.svelte");
	}

	function writePackageJson(
		dir: string,
		devDependencies: Record<string, string>,
	): void {
		createTempFile(dir, "package.json", JSON.stringify({ devDependencies }));
	}

	it("offers oxfmt for Component.svelte with the issue's exact fixture shape", async () => {
		writePackageJson(tmpDir, { oxfmt: "^0.54.0", svelte: "^5.0.0" });
		createTempFile(tmpDir, ".oxfmtrc.json", JSON.stringify({ svelte: true }));

		const formatters = await getFormattersForFile(
			svelteComponent(tmpDir),
			tmpDir,
		);
		expect(formatters.map((f) => f.name)).toEqual(["oxfmt"]);
	});

	it("offers oxfmt for Component.svelte when the svelte flag is set via oxfmt.toml", async () => {
		writePackageJson(tmpDir, { oxfmt: "^0.54.0", svelte: "^5.0.0" });
		createTempFile(tmpDir, "oxfmt.toml", "svelte = true\n");

		const formatters = await getFormattersForFile(
			svelteComponent(tmpDir),
			tmpDir,
		);
		expect(formatters.map((f) => f.name)).toEqual(["oxfmt"]);
	});

	it("does NOT offer oxfmt for Component.svelte without the svelte package (config flag on)", async () => {
		writePackageJson(tmpDir, { oxfmt: "^0.54.0" });
		createTempFile(tmpDir, ".oxfmtrc.json", JSON.stringify({ svelte: true }));

		const formatters = await getFormattersForFile(
			svelteComponent(tmpDir),
			tmpDir,
		);
		expect(formatters.map((f) => f.name)).not.toContain("oxfmt");
	});

	it("does NOT offer oxfmt for Component.svelte without the config flag (svelte package installed)", async () => {
		writePackageJson(tmpDir, { oxfmt: "^0.54.0", svelte: "^5.0.0" });
		createTempFile(tmpDir, ".oxfmtrc.json", "{}\n");

		const formatters = await getFormattersForFile(
			svelteComponent(tmpDir),
			tmpDir,
		);
		expect(formatters.map((f) => f.name)).not.toContain("oxfmt");
	});

	it("does NOT offer oxfmt for Component.svelte when the config flag is explicitly false", async () => {
		writePackageJson(tmpDir, { oxfmt: "^0.54.0", svelte: "^5.0.0" });
		createTempFile(tmpDir, ".oxfmtrc.json", JSON.stringify({ svelte: false }));

		const formatters = await getFormattersForFile(
			svelteComponent(tmpDir),
			tmpDir,
		);
		expect(formatters.map((f) => f.name)).not.toContain("oxfmt");
	});

	it("does NOT offer oxfmt for Component.svelte from a generic oxfmt.toml with no svelte flag", async () => {
		writePackageJson(tmpDir, { oxfmt: "^0.54.0", svelte: "^5.0.0" });
		createTempFile(tmpDir, "oxfmt.toml", "# oxfmt config\n");

		const formatters = await getFormattersForFile(
			svelteComponent(tmpDir),
			tmpDir,
		);
		expect(formatters.map((f) => f.name)).not.toContain("oxfmt");
	});

	it("does NOT offer oxfmt for Component.svelte with neither the package nor the config flag", async () => {
		writePackageJson(tmpDir, { oxfmt: "^0.54.0" });

		const formatters = await getFormattersForFile(
			svelteComponent(tmpDir),
			tmpDir,
		);
		expect(formatters.map((f) => f.name)).not.toContain("oxfmt");
	});

	it("still offers oxfmt for a non-svelte extension without the svelte package or flag", async () => {
		writePackageJson(tmpDir, { oxfmt: "^0.54.0" });
		createTempFile(tmpDir, "oxfmt.toml", "# oxfmt config\n");

		const formatters = await getFormattersForFile(
			fileIn(tmpDir, "index.ts"),
			tmpDir,
		);
		expect(formatters.map((f) => f.name)).toContain("oxfmt");
	});
});

// ---------------------------------------------------------------------------
// Single-source-of-truth drift guard (#1134, the #883 pattern) — belt-and-
// suspenders alongside deriving oxfmtFormatter.extensions directly from
// OXFMT_SUPPORTED_EXTENSIONS: this catches a future PR that reintroduces a
// second hand-maintained copy instead of importing the shared constant.
// ---------------------------------------------------------------------------

describe("oxfmt extension registries stay in sync (#1134)", () => {
	it("oxfmtFormatter.extensions matches tool-policy's OXFMT_SUPPORTED_EXTENSIONS exactly", async () => {
		const { OXFMT_SUPPORTED_EXTENSIONS } =
			await import("../../clients/tool-policy.js");
		expect(new Set(oxfmtFormatter.extensions)).toEqual(
			OXFMT_SUPPORTED_EXTENSIONS,
		);
	});

	it("oxfmtFormatter.extensions includes .svelte", () => {
		expect(oxfmtFormatter.extensions).toContain(".svelte");
	});
});

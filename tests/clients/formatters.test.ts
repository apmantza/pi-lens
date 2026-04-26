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
	biomeFormatter,
	blackFormatter,
	clearFormatterRuntimeState,
	getFormattersForFile,
	oxfmtFormatter,
	phpCsFixerFormatter,
	prettierFormatter,
	rubocopFormatter,
	ruffFormatter,
	standardrbFormatter,
} from "../../clients/formatters.ts";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

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

	it.skipIf(process.env.CI === "true")(
		"ruff: falls back to discovered global install when no venv binary",
		async () => {
			const cmd = await ruffFormatter.resolveCommand!(
				fileIn(tmpDir, "main.py"),
				tmpDir,
			);
			expect(cmd).not.toBeNull();
			expect(String(cmd![0]).toLowerCase()).toContain("ruff");
			expect(cmd).toContain("format");
		},
	);

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

	it("uses prettier as the smart default for unconfigured HTML files", async () => {
		const filePath = fileIn(tmpDir, "page.html");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["prettier"]);
	});

	it("uses prettier as the smart default for unconfigured YAML files", async () => {
		const filePath = fileIn(tmpDir, "config.yaml");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["prettier"]);
	});

	it("uses prettier as the smart default for unconfigured Markdown files", async () => {
		const filePath = fileIn(tmpDir, "README.md");
		const formatters = await getFormattersForFile(filePath, tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["prettier"]);
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

	it("uses ktlint as the smart default for Kotlin files when available", async () => {
		await withPathShim("ktlint", async () => {
			const filePath = fileIn(tmpDir, "App.kt");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["ktlint"]);
		});
	});

	it("uses swiftformat as the smart default for Swift files when available", async () => {
		await withPathShim("swiftformat", async () => {
			const filePath = fileIn(tmpDir, "App.swift");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["swiftformat"]);
		});
	});

	it("uses fantomas as the smart default for F# files when available", async () => {
		await withPathShim("fantomas", async () => {
			const filePath = fileIn(tmpDir, "App.fs");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["fantomas"]);
		});
	});

	it("uses nixfmt as the smart default for Nix files when available", async () => {
		await withPathShim("nixfmt", async () => {
			const filePath = fileIn(tmpDir, "flake.nix");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["nixfmt"]);
		});
	});

	it("uses mix as the smart default for Elixir files when available in an Elixir project", async () => {
		createTempFile(tmpDir, "mix.exs", "defmodule Demo.MixProject do\nend\n");
		await withPathShim("mix", async () => {
			const filePath = path.join(tmpDir, "lib", "app.ex");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["mix"]);
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

	it("uses csharpier as the smart default for C# files when dotnet csharpier is available", async () => {
		await withPathShim("dotnet", async () => {
			const filePath = fileIn(tmpDir, "Program.cs");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["csharpier"]);
		});
	});

	it("uses ormolu as the smart default for Haskell files when available", async () => {
		await withPathShim("ormolu", async () => {
			const filePath = fileIn(tmpDir, "Main.hs");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["ormolu"]);
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

	it("uses taplo as the smart default for TOML files when available", async () => {
		await withPathShim("taplo", async () => {
			const filePath = fileIn(tmpDir, "config.toml");
			const formatters = await getFormattersForFile(filePath, tmpDir);
			expect(formatters.map((f) => f.name)).toEqual(["taplo"]);
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
			const formatters = await import("../../clients/formatters.ts");
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
		const formatters = await getFormattersForFile(fileIn(tmpDir, "app.js"), tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["oxfmt"]);
	});

	it("biome wins over oxfmt when both configs are present", async () => {
		createTempFile(tmpDir, "oxfmt.toml", "# oxfmt config\n");
		createTempFile(tmpDir, "biome.json", JSON.stringify({ $schema: "https://biomejs.dev/schemas/1.0.0/schema.json" }));
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
		expect(cmd?.[0]).toBe(bin);
		expect(cmd?.[1]).toBe(filePath);
	});
});

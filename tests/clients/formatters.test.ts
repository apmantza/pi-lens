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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	biomeFormatter,
	blackFormatter,
	phpCsFixerFormatter,
	prettierFormatter,
	rubocopFormatter,
	ruffFormatter,
	standardrbFormatter,
} from "../../clients/formatters.js";
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let cleanup: () => void;

beforeEach(() => {
	({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-fmt-test-"));
});

afterEach(() => {
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

	it.skipIf(process.env.CI === "true")("ruff: falls back to discovered global install when no venv binary", async () => {
		const cmd = await ruffFormatter.resolveCommand!(
			fileIn(tmpDir, "main.py"),
			tmpDir,
		);
		expect(cmd).not.toBeNull();
		expect(String(cmd![0]).toLowerCase()).toContain("ruff");
		expect(cmd).toContain("format");
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

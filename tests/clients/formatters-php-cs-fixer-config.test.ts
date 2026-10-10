/**
 * #2472: php-cs-fixer's own `ConfigurationResolver` does not walk up parent
 * directories looking for its config file (verified against upstream
 * `computeConfigFiles()` — see `clients/php-cs-fixer-config.ts`'s doc
 * comment), so an ancestor `.php-cs-fixer(.dist).php` found by `detect()`'s
 * own climb was silently dropped by the actual `fix` invocation:
 * `resolveCommand` never passed `--config`, and `formatFile` spawns with
 * cwd = the FILE's own directory, which is not necessarily where the
 * ancestor config lives.
 *
 * These tests call `phpCsFixerFormatter.resolveCommand` and
 * `resolvePhpCsFixerConfig` directly (the same pattern
 * `formatters-rustfmt-edition.test.ts` uses for #2466) so they exercise the
 * real config-resolution code path, not a hand-fed input shaped to hit the
 * bug. `formatters-php-cs-fixer-formatfile.test.ts` covers the same defect
 * one layer down, through `formatFile`'s actual spawn call.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controllable `os.homedir()` override — `vi.spyOn(os, "homedir")` fails
// under Vitest's ESM interop ("Cannot redefine property"), so the module is
// replaced with a thin wrapper that defers to the REAL os.homedir() unless a
// test has set an override (refs #2472 review round 3, F1). Never used to
// touch the real HOME directory — only to redirect os.homedir() to a temp
// dir for the duration of one test; every OTHER test in this file gets the
// real os.homedir() unchanged.
const homedirOverride = vi.hoisted(() => ({
	value: undefined as string | undefined,
}));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const homedir = () => homedirOverride.value ?? actual.homedir();
	return { ...actual, default: { ...actual, homedir }, homedir };
});

import { phpCsFixerFormatter } from "../../clients/formatters.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { resolvePhpCsFixerConfig } from "../../clients/php-cs-fixer-config.js";
import { hasPhpCsFixerConfig } from "../../clients/tool-policy.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const isWin = process.platform === "win32";

// The suite plants a project-local vendor binary on purpose; the trust gate
// itself is witnessed in `project-local-bin-trust.test.ts`.
beforeEach(() => setProjectTrustState("trusted"));

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir && fs.existsSync(dir)) removeTempDirSync(dir);
	}
});

function newTmpDir(prefix: string): string {
	const env = setupTestEnvironment(prefix);
	tmpDirs.push(env.tmpDir);
	return env.tmpDir;
}

function vendorBinPath(root: string): string {
	return isWin
		? path.join(root, "vendor", "bin", "php-cs-fixer.bat")
		: path.join(root, "vendor", "bin", "php-cs-fixer");
}

function makeFakeVendorBin(root: string): string {
	const binPath = vendorBinPath(root);
	fs.mkdirSync(path.dirname(binPath), { recursive: true });
	fs.writeFileSync(binPath, isWin ? "@echo off\r\n" : "#!/bin/sh\n");
	if (!isWin) fs.chmodSync(binPath, 0o755);
	return binPath;
}

const CONFIG_CONTENT =
	"<?php return (new PhpCsFixer\\Config())->setRules(['strict_types' => true]);\n";

describe("phpCsFixerFormatter — ancestor config carriage (#2472)", () => {
	it("passes --config for a file several directories below the project-root config", async () => {
		const tmpDir = newTmpDir("pi-lens-phpcsfixer-nested-");
		const configPath = path.join(tmpDir, ".php-cs-fixer.dist.php");
		fs.writeFileSync(configPath, CONFIG_CONTENT);
		const vendorBin = makeFakeVendorBin(tmpDir);
		const filePath = path.join(tmpDir, "src", "App", "Controller.php");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "<?php\nclass Controller {}\n");

		// Same cwd formatFile actually spawns with: the FILE's own directory,
		// not the project root the config sits in — the exact mismatch #2472
		// reports.
		const resolved = await phpCsFixerFormatter.resolveCommand?.(
			filePath,
			path.dirname(filePath),
		);

		// The load-bearing assertion: removing the --config carriage from the
		// fix collapses this to [vendorBin, "fix", filePath] and this line
		// goes red.
		expect(resolved).toEqual([
			vendorBin,
			"fix",
			"--config",
			configPath,
			filePath,
		]);
	});

	it("does not attach --config when no ancestor config exists, but still resolves the vendor binary", async () => {
		const tmpDir = newTmpDir("pi-lens-phpcsfixer-noconfig-");
		const vendorBin = makeFakeVendorBin(tmpDir);
		const filePath = path.join(tmpDir, "index.php");
		fs.writeFileSync(filePath, "<?php\n");

		const resolved = await phpCsFixerFormatter.resolveCommand?.(
			filePath,
			tmpDir,
		);

		expect(resolved).toEqual([vendorBin, "fix", filePath]);
	});

	it("prefers .php-cs-fixer.php over .php-cs-fixer.dist.php in the same directory (AC3, matches upstream computeConfigFiles() precedence)", () => {
		const tmpDir = newTmpDir("pi-lens-phpcsfixer-precedence-");
		fs.writeFileSync(
			path.join(tmpDir, ".php-cs-fixer.dist.php"),
			CONFIG_CONTENT,
		);
		const preferred = path.join(tmpDir, ".php-cs-fixer.php");
		fs.writeFileSync(preferred, CONFIG_CONTENT);
		const filePath = path.join(tmpDir, "index.php");
		fs.writeFileSync(filePath, "<?php\n");

		const resolved = resolvePhpCsFixerConfig(filePath);

		expect(resolved).toBe(preferred);
	});

	it("resolves --config even when the config sits in the file's own directory (AC3)", async () => {
		const tmpDir = newTmpDir("pi-lens-phpcsfixer-samedir-");
		const configPath = path.join(tmpDir, ".php-cs-fixer.php");
		fs.writeFileSync(configPath, CONFIG_CONTENT);
		const vendorBin = makeFakeVendorBin(tmpDir);
		const filePath = path.join(tmpDir, "index.php");
		fs.writeFileSync(filePath, "<?php\n");

		const resolved = await phpCsFixerFormatter.resolveCommand?.(
			filePath,
			tmpDir,
		);

		expect(resolved).toEqual([
			vendorBin,
			"fix",
			"--config",
			configPath,
			filePath,
		]);
	});

	it("nearest ancestor config wins over a farther one", () => {
		const outerDir = newTmpDir("pi-lens-phpcsfixer-nearest-");
		fs.writeFileSync(
			path.join(outerDir, ".php-cs-fixer.dist.php"),
			CONFIG_CONTENT,
		);
		const innerDir = path.join(outerDir, "packages", "core");
		fs.mkdirSync(innerDir, { recursive: true });
		const innerConfig = path.join(innerDir, ".php-cs-fixer.php");
		fs.writeFileSync(innerConfig, CONFIG_CONTENT);
		const filePath = path.join(innerDir, "src", "Service.php");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "<?php\n");

		const resolved = resolvePhpCsFixerConfig(filePath);

		expect(resolved).toBe(innerConfig);
	});

	it("resolves the same config from a cross-form (forward-slash) path as the native-separator path", () => {
		const tmpDir = newTmpDir("pi-lens-phpcsfixer-crossform-");
		const configPath = path.join(tmpDir, ".php-cs-fixer.php");
		fs.writeFileSync(configPath, CONFIG_CONTENT);
		const nativeFilePath = path.join(tmpDir, "src", "index.php");
		fs.mkdirSync(path.dirname(nativeFilePath), { recursive: true });
		fs.writeFileSync(nativeFilePath, "<?php\n");
		const crossFormFilePath = nativeFilePath.split(path.sep).join("/");

		expect(resolvePhpCsFixerConfig(nativeFilePath)).toBe(configPath);
		expect(resolvePhpCsFixerConfig(crossFormFilePath)).toBe(configPath);
	});

	// #2472 review round 3, F1/F3 (maintainer-decision reversal): a round-2
	// fold ceilinged `resolvePhpCsFixerConfig` (the carriage) at $HOME by
	// default while its own detection gates — `hasPhpCsFixerConfig`
	// (`clients/tool-policy.ts`, via the unceilinged `findNearestContaining`)
	// and `phpCsFixerFormatter.detect` (via its own unceilinged `findUp`) —
	// stayed unceilinged. That disagreement re-created #2472 for any project
	// rooted at or above $HOME: the gate said "config exists", the carriage
	// said "not found", and `--config` was silently dropped. The carriage is
	// unceilinged again; this proves gate and carriage now AGREE for a config
	// sitting exactly AT (a mocked, never-real) $HOME.
	it("gate (hasPhpCsFixerConfig) and carriage (resolvePhpCsFixerConfig) agree for a config AT HOME (#2472 review round 3 F1)", () => {
		const tmpDir = newTmpDir("pi-lens-phpcsfixer-homeagree-");
		const mockedHome = path.join(tmpDir, "mocked-home");
		fs.mkdirSync(mockedHome, { recursive: true });
		homedirOverride.value = mockedHome;
		try {
			const configPath = path.join(mockedHome, ".php-cs-fixer.dist.php");
			fs.writeFileSync(configPath, CONFIG_CONTENT);
			const filePath = path.join(mockedHome, "project", "src", "index.php");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "<?php\n");

			// The gate: does detection say a config exists starting from the
			// project directory?
			expect(hasPhpCsFixerConfig(path.dirname(filePath))).toBe(true);

			// The carriage: does the resolver find the SAME file starting from
			// the formatted file's own directory?
			expect(resolvePhpCsFixerConfig(filePath)).toBe(configPath);

			// Cross-form (forward-slash) filePath resolves identically.
			const crossFormFilePath = filePath.split(path.sep).join("/");
			expect(resolvePhpCsFixerConfig(crossFormFilePath)).toBe(configPath);
		} finally {
			homedirOverride.value = undefined;
		}
	});
});

/**
 * #2472: one layer below `formatters-php-cs-fixer-config.test.ts`'s direct
 * `resolveCommand` assertions — proves the fix reaches the actual production
 * spawn seam (`formatFile`), not just `resolveCommand` in isolation.
 * `safeSpawnAsync` is mocked (recording, never executing, argv) the same way
 * `formatters-format-file.test.ts` mocks it, so this needs no php-cs-fixer
 * binary installed anywhere on the machine.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	which: vi.fn(async () => null),
}));

async function loadFormatters() {
	const mod = await import("../../clients/formatters.js");
	return {
		formatFile: mod.formatFile,
		phpCsFixerFormatter: mod.phpCsFixerFormatter,
	};
}

const isWin = process.platform === "win32";

function vendorBinPath(root: string): string {
	return isWin
		? path.join(root, "vendor", "bin", "php-cs-fixer.bat")
		: path.join(root, "vendor", "bin", "php-cs-fixer");
}

describe("formatFile — php-cs-fixer ancestor config carriage (#2472)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("spawns php-cs-fixer with --config for the nearest ancestor config, through the real production seam", async () => {
		const env = setupTestEnvironment("pi-lens-phpcsfixer-formatfile-");
		try {
			const configPath = path.join(env.tmpDir, ".php-cs-fixer.dist.php");
			fs.writeFileSync(
				configPath,
				"<?php return (new PhpCsFixer\\Config());\n",
			);
			const vendorBin = vendorBinPath(env.tmpDir);
			fs.mkdirSync(path.dirname(vendorBin), { recursive: true });
			fs.writeFileSync(vendorBin, isWin ? "@echo off\r\n" : "#!/bin/sh\n");
			const filePath = path.join(env.tmpDir, "src", "App", "Controller.php");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "<?php\nclass Controller {}\n");

			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const { formatFile, phpCsFixerFormatter } = await loadFormatters();
			const result = await formatFile(filePath, phpCsFixerFormatter);

			expect(result.success).toBe(true);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
			const [cmd, args, opts] = safeSpawnAsync.mock.calls[0];
			// The load-bearing assertion: removing the --config carriage from the
			// fix drops "--config" and configPath from `args` and this goes red.
			expect(cmd).toBe(vendorBin);
			expect(args).toEqual(["fix", "--config", configPath, filePath]);
			// Formatter children run from the nearest project root. php-cs-fixer's
			// explicit --config keeps its ancestor config selection independent of
			// that cwd; its .php-cs-fixer.cache therefore lands at the project root,
			// matching the CLI invocation.
			expect(opts.cwd).toBe(env.tmpDir);
			expect(opts.cwd).not.toBe(path.dirname(filePath));
		} finally {
			env.cleanup();
		}
	});
});

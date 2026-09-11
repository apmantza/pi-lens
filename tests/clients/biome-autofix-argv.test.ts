import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/installer/index.js", () => ({ ensureTool }));

// Regression guard for #1247 review P1/P2: the biome autofix surface must
// (a) place --config-path AFTER the `lint --write` subcommand — biome rejects
// the flag before the subcommand with "not valid in this context", which
// fixFileAsync read as success+0-fixed (a permanent silent no-op) — and
// (b) forward the dispatch cwd to the spawned child so a nested-config
// monorepo doesn't get biome's "Found a nested root configuration" error.
describe("BiomeClient.fixFileAsync — autofix argv order + cwd (#1247 review)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		ensureTool.mockResolvedValue(null);
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});
	});

	it("spawns `lint --write` with --config-path AFTER the subcommand and forwards cwd", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-biome-argv-"),
		);
		try {
			const filePath = path.join(tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "const x = 1;\n");

			const { BiomeClient } = await import("../../clients/biome-client.js");
			const client = new BiomeClient();
			const result = await client.fixFileAsync(filePath, tmpDir);
			expect(result.success).toBe(true);

			// ensureAvailable() spawns a `--version` probe first; the fix call
			// is the one whose args contain the `lint` subcommand.
			const lintCall = safeSpawnAsync.mock.calls.find((call: unknown[]) =>
				(call[1] as string[]).includes("lint"),
			) as [string, string[], { cwd?: string }];
			expect(lintCall).toBeDefined();

			const [, args, opts] = lintCall;
			const lintIdx = args.indexOf("lint");
			const writeIdx = args.indexOf("--write");
			const cfgIdx = args.findIndex((a) => a.startsWith("--config-path="));
			expect(lintIdx).toBeGreaterThan(-1);
			expect(writeIdx).toBe(lintIdx + 1);
			// P1 regression: the config arg must come AFTER the subcommand.
			expect(cfgIdx).toBeGreaterThan(writeIdx);
			expect(args[cfgIdx]).toMatch(/config[\\/]biome[\\/]core\.jsonc$/);
			expect(args.at(-1)).toBe(filePath);
			// P2 regression: the dispatch cwd reaches the child process.
			expect(opts?.cwd).toBe(tmpDir);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("autofix resolves the same nested package root as the runner seam", async () => {
		// Recurrence: folding RUNNER_MARKERS into the language table dropped
		// Biome's biome.json marker and sent autofix back to the workspace root.
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-biome-nested-"),
		);
		try {
			const packageDir = path.join(tmpDir, "packages", "api");
			const filePath = path.join(packageDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(path.join(packageDir, "biome.json"), "{}\n");
			fs.writeFileSync(filePath, "const x = 1;\n");

			const { BiomeClient } = await import("../../clients/biome-client.js");
			await new BiomeClient().fixFileAsync(filePath, tmpDir);
			const lintCall = safeSpawnAsync.mock.calls.find((call: unknown[]) =>
				(call[1] as string[]).includes("lint"),
			) as [string, string[], { cwd?: string }];
			expect(lintCall?.[2]?.cwd).toBe(packageDir);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});

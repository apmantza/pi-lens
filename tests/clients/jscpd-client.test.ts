import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({
		error: null,
		status: 0,
		stdout: "",
		stderr: "",
	})),
}));

describe("jscpd-client", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawn).mockClear();
	});

	it("scans when source exists in nested directories", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
		try {
			const srcFile = path.join(tmpDir, "src", "feature", "index.ts");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "export const x = 1;\n");

			const client = new JscpdClient(false) as unknown as {
				scan: (cwd: string, minLines: number, minTokens: number, isTsProject: boolean) => unknown;
				available: boolean;
			};
			client.available = true;

			client.scan(tmpDir, 5, 50, true);

			expect(safeSpawnMod.safeSpawn).toHaveBeenCalled();
			const args = vi.mocked(safeSpawnMod.safeSpawn).mock.calls[0]?.[1] ?? [];
			const ignoreIndex = args.indexOf("--ignore");
			expect(ignoreIndex).toBeGreaterThan(-1);
			const ignorePattern = String(args[ignoreIndex + 1] ?? "");
			expect(ignorePattern).toContain("**/.turbo/**");
			expect(ignorePattern).toContain("**/.cache/**");
			expect(ignorePattern).toContain("**/*.js");
		} finally {
			cleanup();
		}
	});

	it("does not scan when only excluded directories contain source files", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
		try {
			const excludedFile = path.join(tmpDir, "node_modules", "pkg", "index.ts");
			fs.mkdirSync(path.dirname(excludedFile), { recursive: true });
			fs.writeFileSync(excludedFile, "export const x = 1;\n");

			const client = new JscpdClient(false) as unknown as {
				scan: (cwd: string, minLines: number, minTokens: number, isTsProject: boolean) => {
					success: boolean;
					clones: unknown[];
				};
				available: boolean;
			};
			client.available = true;

			const result = client.scan(tmpDir, 5, 50, true);

			expect(result.success).toBe(true);
			expect(result.clones).toEqual([]);
			expect(safeSpawnMod.safeSpawn).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("does not scan when no source files exist", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
		try {
			fs.writeFileSync(path.join(tmpDir, "README.md"), "hello\n");

			const client = new JscpdClient(false) as unknown as {
				scan: (cwd: string, minLines: number, minTokens: number, isTsProject: boolean) => {
					success: boolean;
					clones: unknown[];
				};
				available: boolean;
			};
			client.available = true;

			const result = client.scan(tmpDir, 5, 50, true);

			expect(result.success).toBe(true);
			expect(result.clones).toEqual([]);
			expect(safeSpawnMod.safeSpawn).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});
});

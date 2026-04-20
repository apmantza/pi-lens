import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
const existsSync = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: (...args: unknown[]) => existsSync(...args),
	};
});

function createCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "jsts",
		pi: {
			getFlag: () => undefined,
		},
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("biome-check runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		existsSync.mockReset();
		// Default: no biome config found
		existsSync.mockReturnValue(false);
	});

	it("runs diagnostics-only check without --write mutation", async () => {
		const env = setupTestEnvironment("pi-lens-biome-check-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const x = 1\n");

			// Mock that biome is available in local node_modules
			existsSync.mockImplementation((p: unknown) => {
				if (
					typeof p === "string" &&
					p.includes("node_modules") &&
					p.includes("biome")
				) {
					return true;
				}
				return false;
			});

			safeSpawnAsync
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "1.9.4",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout: JSON.stringify({ diagnostics: [] }),
					stderr: "",
				});

			const runner = (
				await import("../../../../clients/dispatch/runners/biome-check.ts")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			// Log all calls for debugging
			// biomeCalls = safeSpawnAsync.mock.calls.filter((call) => call[0].includes("biome"))

			expect(
				safeSpawnAsync.mock.calls.some(
					(call) =>
						(call[1] as string[])?.includes("lint") &&
						(call[1] as string[])?.includes("--reporter=json"),
				),
			).toBe(true);
			expect(
				safeSpawnAsync.mock.calls.some((call) =>
					(call[1] as string[])?.includes("--write"),
				),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

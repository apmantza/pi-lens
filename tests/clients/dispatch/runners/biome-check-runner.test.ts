import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

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
	});

	it("runs diagnostics-only check without --write mutation", async () => {
		const env = setupTestEnvironment("pi-lens-biome-check-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const x = 1\n");

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

			const biomeCalls = safeSpawnAsync.mock.calls
				.filter((call) => call[0] === "biome" || (call[0] === "npx" && call[1]?.[0] === "@biomejs/biome"))
				.map((call) => call[1] as string[]);

			expect(
				biomeCalls.some(
					(args) => args.includes("check") && args.includes("--reporter=json"),
				),
			).toBe(true);
			expect(biomeCalls.some((args) => args.includes("--write"))).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #5446: `getModuleSourceFiles` walks a workspace module's representative
 * sources through a hand-spelled `SOURCE_EXTS` set; `.mts`, `.cts`, `.mjs`
 * and `.cjs` files were invisible, so the review graph anchored those
 * modules on their non-TS siblings or on nothing. The JS/TS family now
 * answers through the registry seam (`isJstsFactFile`,
 * `clients/file-kinds.ts`); every non-TS entry in the set stays.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getModuleSourceFiles } from "../../clients/review-graph/workspace-modules.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("#5446 module source walk answers JS/TS through the registry", () => {
	it("collects .mts/.cts/.mjs/.cjs beside .ts and the non-TS tail", () => {
		const env = setupTestEnvironment("pi-lens-5446-mods-");
		try {
			const names = [
				"main.mts",
				"config.cts",
				"legacy.mjs",
				"conf.cjs",
				"app.ts",
				"tool.py",
			];
			for (const name of names) {
				fs.writeFileSync(path.join(env.tmpDir, name), "export const a = 1;\n");
			}

			const files = getModuleSourceFiles(env.tmpDir, 100)
				.map((f) => path.basename(f))
				.sort();

			// Pre-fix: ["app.ts", "tool.py"] — the four ESM/CJS-module
			// extensions were dropped by SOURCE_EXTS.
			expect(files).toEqual([...names].sort());
		} finally {
			env.cleanup();
		}
	});
});

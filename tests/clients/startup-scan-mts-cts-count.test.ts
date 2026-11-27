/**
 * #5446: the startup source-count walk's extension gate must answer the
 * JS/TS question through the registry seam (`isJstsFactFile`,
 * `clients/file-kinds.ts`). `SOURCE_FILE_PATTERN` spelled the family as
 * `ts|tsx|js|jsx`, so an ESM/CJS-module TypeScript project (only `.mts`
 * and `.cts` sources) counted ZERO source files: the startup verdict
 * treated a real TS project like an empty directory and warmed nothing.
 *
 * Recurrence guarded: the pre-fix tree counts only `.ts`/`.tsx`/`.js`/`.jsx`
 * and the four non-TS extensions; `.mts`/`.cts` (and `.mjs`/`.cjs`, which
 * the family seam also carries) are dropped. The non-TS tail (`py`, `go`,
 * `rs`, `rb`) must keep counting — that is the pin the fold cannot silently
 * widen or shrink.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { countSourceFilesWithinLimit } from "../../clients/startup-scan.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("#5446 startup-scan counts the JS/TS family through the registry", () => {
	it("counts .mts/.cts (and .mjs/.cjs) sources, keeping the non-TS tail", () => {
		const env = setupTestEnvironment("pi-lens-5446-startup-");
		try {
			const names = [
				"main.mts",
				"config.cts",
				"legacy.mjs",
				"conf.cjs",
				"app.ts",
				"main.py",
				"main.go",
				"main.rs",
				"main.rb",
			];
			for (const name of names) {
				fs.writeFileSync(path.join(env.tmpDir, name), "export const a = 1;\n");
			}

			const count = countSourceFilesWithinLimit(env.tmpDir, 100);

			// Pre-fix: 5 — the .mts/.cts/.mjs/.cjs quartet is invisible to
			// SOURCE_FILE_PATTERN. Post-fix: every planted source counts.
			expect(count).toBe(names.length);
		} finally {
			env.cleanup();
		}
	});

	it("still ignores a non-source extension through the same gate", () => {
		const env = setupTestEnvironment("pi-lens-5446-startup-neg-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, "notes.xyz"), "x\n");
			fs.writeFileSync(path.join(env.tmpDir, "a.mts"), "export const a = 1;\n");

			expect(countSourceFilesWithinLimit(env.tmpDir, 100)).toBe(1);
		} finally {
			env.cleanup();
		}
	});
});

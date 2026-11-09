/**
 * #5446: `CacheManager.getFilesForJscpd` filters the edited-file worklist
 * with a hand-spelled extension list (`ts|tsx|js|jsx|mjs|cjs|...`). An
 * edited `.mts`/`.cts` file never reached the jscpd re-scan, so duplicate
 * code in ESM-module TypeScript projects went undetected turn after turn.
 *
 * The JS/TS family now answers through the registry seam
 * (`isJstsFactFile`, `clients/file-kinds.ts`); every non-TS extension on
 * the list (py, go, rs, rb, java, cs, php, cpp, c, h, hpp, swift, kt)
 * stays exactly as it was.
 *
 * Enters through the real writer/reader pair the turn-end lane uses:
 * `addModifiedRange` seeds the turn state, `getFilesForJscpd` reads it
 * back. No mocks.
 */
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { setupTestEnvironment } from "./test-utils.js";

let env: { tmpDir: string; cleanup: () => void };
let cache: CacheManager;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-5446-jscpd-worklist-");
	cache = new CacheManager(false);
});

afterEach(() => {
	env.cleanup();
});

const RANGE = { start: 1, end: 1 };

describe("#5446 getFilesForJscpd keeps the JS/TS family through the registry", () => {
	it("returns edited .mts/.cts files beside .ts and the non-TS tail", () => {
		const names = ["a.mts", "b.cts", "c.ts", "d.py"];
		for (const name of names) {
			cache.addModifiedRange(
				path.join(env.tmpDir, name),
				RANGE,
				false,
				env.tmpDir,
				"s1",
			);
		}

		const files = cache
			.getFilesForJscpd(env.tmpDir, "s1")
			.map((f) => path.basename(f))
			.sort();

		// Pre-fix: ["c.ts", "d.py"] — the .mts/.cts edits were filtered out.
		expect(files).toEqual(["a.mts", "b.cts", "c.ts", "d.py"]);
	});

	it("still drops an extension no jscpd tokenizer owns", () => {
		cache.addModifiedRange(
			path.join(env.tmpDir, "notes.xyz"),
			RANGE,
			false,
			env.tmpDir,
			"s2",
		);
		cache.addModifiedRange(
			path.join(env.tmpDir, "a.mts"),
			RANGE,
			false,
			env.tmpDir,
			"s2",
		);

		expect(
			cache.getFilesForJscpd(env.tmpDir, "s2").map((f) => path.basename(f)),
		).toEqual(["a.mts"]);
	});
});

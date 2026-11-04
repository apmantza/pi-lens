/**
 * #5273: the word index is built and refreshed from the source walk. A file
 * named rather than suffixed (`Jenkinsfile`, `build.gradle`) was never in the
 * walk, so the full build skipped it and the incremental refresh reported it
 * as neither present nor changed even after the per-edit seam had indexed it.
 * Both walk sites in clients/word-index.ts opt into `includeNamedFiles`.
 */

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	refreshWordIndexIncrementally,
	wordIndexPostingHits,
} from "../../clients/word-index.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

function seedTs(tmpDir: string): void {
	for (let i = 0; i < 10; i++) {
		createTempFile(tmpDir, `src/f${i}.ts`, `export const value${i} = ${i};\n`);
	}
}

describe("word index enumerates named files (#5273)", () => {
	it("the full build collects a Jenkinsfile and a build.gradle", async () => {
		// Recurrence: collectWordIndexDocs walked by extension only, so these
		// names were absent from every built index.
		const env = setupTestEnvironment("pi-lens-word-named-build-");
		try {
			seedTs(env.tmpDir);
			createTempFile(env.tmpDir, "Jenkinsfile", "def deploystage() {}\n");
			createTempFile(env.tmpDir, "build.gradle", "task packageartifacts {}\n");
			const docs = await collectWordIndexDocs(env.tmpDir);
			const index = buildWordIndex(docs);
			expect(
				wordIndexPostingHits(index, "deploystage").map((h) =>
					h.file.replace(/^.*[\\/]/, ""),
				),
			).toEqual(["Jenkinsfile"]);
			expect(
				wordIndexPostingHits(index, "packageartifacts").map((h) =>
					h.file.replace(/^.*[\\/]/, ""),
				),
			).toEqual(["build.gradle"]);
		} finally {
			env.cleanup();
		}
	});

	it("the incremental refresh picks up a Jenkinsfile created after the build", async () => {
		// Recurrence: refreshWordIndexIncrementally ran its own extension-only
		// walk, so a named file added (or already indexed by the per-edit seam)
		// was invisible to it and stayed absent or was dropped as vanished.
		const env = setupTestEnvironment("pi-lens-word-named-refresh-");
		try {
			seedTs(env.tmpDir);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			const jenkinsfile = createTempFile(
				env.tmpDir,
				"Jenkinsfile",
				"def releasegate() {}\n",
			);
			expect(fs.existsSync(jenkinsfile)).toBe(true);
			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			expect(result).toMatchObject({
				mode: "incremental",
				refreshed: 1,
				dropped: 0,
			});
			expect(
				wordIndexPostingHits(index, "releasegate").map((h) =>
					h.file.replace(/^.*[\\/]/, ""),
				),
			).toEqual(["Jenkinsfile"]);
		} finally {
			env.cleanup();
		}
	});
});

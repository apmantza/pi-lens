/**
 * #4250 recurrence: a caller-selected turn partition let add, cycle, read,
 * and clear disagree about which session owned a durable worklist. The owner
 * resolver is the only production code allowed to index `sessions` directly.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	stripSource,
} from "../support/sweep-kit.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("turn-state partition ownership sweep", () => {
	it("keeps direct sessions indexing inside CacheManager", () => {
		const offenders: string[] = [];
		const sourceFiles = listSourceFiles(path.join(ROOT, "clients"));
		for (const file of sourceFiles) {
			const source = stripSource(fs.readFileSync(file, "utf8"));
			if (
				/sessions\s*\[/.test(source) &&
				!file.endsWith("clients/cache-manager.ts")
			) {
				offenders.push(path.relative(ROOT, file));
			}
		}
		assertNonEmptyScan(
			"turn-state partition ownership sweep",
			sourceFiles.length,
		);
		expect(offenders).toEqual([]);
	});
});

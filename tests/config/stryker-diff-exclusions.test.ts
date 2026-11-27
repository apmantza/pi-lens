import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import { mutationLaneExclusion } from "../../scripts/lib/stryker-diff.mjs";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";
import { expectPlantedStaleRow } from "../support/baseline-staleness.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REGISTRY_PATH = path.join(
	REPO_ROOT,
	"tests/config/stryker-diff-exclusions.json",
);
const REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as Record<
	string,
	{ reason?: string }
>;
const MARKER = "// mutation-lane:" + " exclude";

function liveMarkers(): string[] {
	const files = listSourceFiles(path.join(REPO_ROOT, "tests"), {
		extensions: [".ts"],
	});
	return readWalkedFiles(files)
		.filter(({ source }) =>
			source.split("\n").some((line) => line.trim() === MARKER),
		)
		.map(({ file }) => relativePosix(REPO_ROOT, file));
}

describe("mutation-lane exclusion registry", () => {
	it(
		"keeps live markers and checked reasons in lockstep",
		() => {
			// Recurrence (#3625 F2): a marker or stale registry row could silently
			// change the mutation population without a reviewable governance failure.
			const markers = liveMarkers();
			const audit = auditRegistry({
				sweepName: "mutation-lane exclusion markers",
				flagged: markers,
				registered: [],
				exemptions: Object.fromEntries(
					Object.entries(REGISTRY).map(([file, entry]) => [
						file,
						entry.reason ?? "",
					]),
				),
				scannedCount: markers.length,
				minScanned: 1,
			});
			expect(audit.problems, audit.problems.join("\n")).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("reds a planted registry row no marker backs (#5072)", () => {
		// The registry's row-without-producer direction, through the same audit
		// the lockstep case above runs: a row for a file that carries no marker.
		const planted = "tests/clients/5072-gone-mutation-marker.test.ts";
		const audit = auditRegistry({
			sweepName: "mutation-lane exclusion markers",
			flagged: [],
			registered: [],
			exemptions: { [planted]: "a planted row for the #5072 cell" },
			scannedCount: 1,
			minScanned: 1,
		});
		expectPlantedStaleRow({
			baseline: "tests/config/stryker-diff-exclusions.json",
			rowKey: planted,
			verdict: audit.problems,
		});
	});

	it("crosses a real registry row through the selector seam", () => {
		const file = "tests/mcp/server.smoke.test.ts";
		const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
		const admission = mutationLaneExclusion(file, {
			readFile: () => source,
			exclusions: REGISTRY,
		});
		expect(admission).toEqual({ file, reason: REGISTRY[file].reason });
	});
});

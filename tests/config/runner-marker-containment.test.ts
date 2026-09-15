import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { rootMarkersForFile } from "../../clients/language-profile.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BASELINE_PATH = path.join(
	REPO_ROOT,
	"tests/fixtures/tool-cwd-runner-markers.json",
);

type Baseline = {
	source: string;
	reason: string;
	markers: Record<string, readonly string[]>;
};

const BASELINE = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;

// Probe every baseline runner through several real file-kind paths. The probe
// set is mechanically expanded from the baseline keys, so a dropped probe is
// caught before the containment check. The independent count below prevents
// #2965's round-1 deletion of RUNNER_MARKERS from recurring: the equivalence
// was wrong once in the code and twice in the instrument, so a fixture edit
// alone must not retire a marker or runner from this contract.
function reachableMarkers(): {
	probedRunners: Set<string>;
	markers: Set<string>;
} {
	const probedRunners = new Set<string>();
	const markers = new Set<string>();
	for (const runner of Object.keys(BASELINE.markers)) {
		probedRunners.add(runner);
		for (const extension of [".ts", ".py", ".yaml", ".sql", ".rs", ".md"])
			for (const marker of rootMarkersForFile(
				path.join(REPO_ROOT, `marker-probe${extension}`),
				runner,
			))
				markers.add(marker);
	}
	return { probedRunners, markers };
}

describe("runner marker vocabulary containment (#2971)", () => {
	it("probes every baseline runner before checking marker containment", () => {
		const { probedRunners, markers } = reachableMarkers();
		const baseRunners = new Set(Object.keys(BASELINE.markers));
		const baseRunnerKeys = [...baseRunners].sort();
		const baseMarkerCount = new Set(
			Object.values(BASELINE.markers).flatMap((runnerMarkers) => runnerMarkers),
		).size;
		expect(
			{ runnerKeys: baseRunnerKeys, uniqueMarkerCount: baseMarkerCount },
			"If the baseline changes, update both the fixture and this count/key assertion; the independent values prevent a data edit from silently weakening the deleted RUNNER_MARKERS contract.",
		).toEqual({
			runnerKeys: [
				"biome",
				"oxlint",
				"prettier",
				"ruff",
				"rust-clippy",
				"spellcheck/typos",
				"sqlfluff",
				"yamllint",
			],
			uniqueMarkerCount: 17,
		});

		expect([...probedRunners].sort()).toEqual([...baseRunners].sort());

		const baseMarkers = new Set(
			Object.values(BASELINE.markers).flatMap((runnerMarkers) => runnerMarkers),
		);
		const missing = [...baseMarkers].filter((marker) => !markers.has(marker));
		expect(
			missing,
			"every base spelling is reachable through rootMarkersForFile",
		).toEqual([]);
	});
});

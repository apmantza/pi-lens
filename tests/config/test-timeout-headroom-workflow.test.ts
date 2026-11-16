// #5311 round 2 F1/F9: the headroom step's advisory posture and its scale are
// structural facts about ci.yml, read from the PARSED workflow. A comment
// cannot satisfy them and an edit can quietly break them: dropping
// `continue-on-error` turns an exit 2 (the check could not measure — no report,
// unreadable baseline) into a shard failure the patch did not cause, and a scale
// literal that moves in one step and not the other makes the fold judge every
// test against a cap the run never applied.
// Recurrence it keeps out: #5311 round 1 shipped the step with an exit-2 path and
// no `continue-on-error`, while its body claimed the step was advisory.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowDocument } from "../../scripts/dispatch-safety.mjs";
import { DEFAULT_BASELINE_RELATIVE } from "../../scripts/lib/test-timeout-headroom.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const CI = ".github/workflows/ci.yml";
const SCRIPT = "check-test-timeout-headroom.mjs";
const SCALE = "PI_LENS_TEST_TIMEOUT_SCALE";

type Step = {
	name?: unknown;
	if?: unknown;
	"continue-on-error"?: unknown;
	env?: Record<string, unknown>;
	run?: unknown;
};
type Doc = { jobs?: Record<string, { steps?: Step[] }> };

const doc = workflowDocument(readFileSync(resolve(ROOT, CI), "utf8")) as Doc;

const steps = Object.entries(doc.jobs ?? {}).flatMap(([job, spec]) =>
	(spec.steps ?? []).map((step) => ({ job, step })),
);

const headroom = steps.filter(
	({ step }) => typeof step.run === "string" && step.run.includes(SCRIPT),
);

/** The `PI_LENS_TEST_TIMEOUT_SCALE: <value>` literals the raw text carries. */
function scaleLiterals(text: string): string[] {
	return [...text.matchAll(/^\s*PI_LENS_TEST_TIMEOUT_SCALE:\s*(.+)$/gm)].map(
		// YAML quotes the scalar; the parsed env value does not carry the quotes.
		(match) => match[1].trim().replace(/^['"]|['"]$/g, ""),
	);
}

describe("ci.yml Test timeout headroom step (#5311)", () => {
	it("runs the headroom check from exactly one step", () => {
		assertNonEmptyScan(`ci.yml steps invoking ${SCRIPT}`, headroom.length, 1);
		expect(headroom).toHaveLength(1);
	});

	it("is advisory, so no exit code of the check can redden the shard", () => {
		const [{ step }] = headroom;
		// Exit 2 means the check could not measure; exit 1 only happens with
		// `--fail-on-new`, which this step does not pass. Either way the annotations
		// are the deliverable, not the shard verdict (round 2 F1).
		expect(step["continue-on-error"]).toBe(true);
		// `always()` keeps the line available when the shard itself went red, which
		// is the run whose timing a flake is usually explained by.
		expect(step.if).toBe("always()");
		expect(String(step.run)).not.toContain("--fail-on-new");
	});

	it("reads the report the test run wrote, at the same path", () => {
		const [{ step }] = headroom;
		const consumer = String(step.run).match(/--report\s+"?([^\s"]+)/)?.[1];
		expect(consumer, "the step passes --report").toBeTruthy();
		const producerRun = steps.find(
			({ step: s }) =>
				typeof s.run === "string" &&
				s.run.includes("npm test") &&
				s.run.includes("--reporter=json"),
		)?.step.run;
		expect(producerRun, "the shard run writes a JSON report").toEqual(
			expect.any(String),
		);
		const written = String(producerRun).match(
			/--outputFile=?\$?\{\{\s*runner\.temp\s*\}\}\/([^\s]+)/,
		)?.[1];
		expect(written, "the shard run names its JSON output file").toBeTruthy();
		// The consumer spells it through `${RUNNER_TEMP}`; the producer through the
		// context object. The basename is the shared fact.
		expect(consumer).toContain(`RUNNER_TEMP}/${written}`);
	});

	it("folds the caps at the scale the test run applied", () => {
		const [{ step }] = headroom;
		const shard = steps.find(
			({ step: s }) =>
				typeof s.run === "string" &&
				s.run.includes("npm test") &&
				s.run.includes("--shard"),
		);
		expect(
			shard?.step.env?.[SCALE],
			"the shard run sets the scale",
		).toBeDefined();
		expect(step.env?.[SCALE]).toBe(shard?.step.env?.[SCALE]);
		// One source: the script reads the env var, so a `--scale` flag here would
		// silently outrank it.
		expect(String(step.run)).not.toContain("--scale");
		// And one value across the file: a step whose literal moved alone would fold
		// against a cap no run applied (round 2 F9).
		const literals = scaleLiterals(readFileSync(resolve(ROOT, CI), "utf8"));
		expect(literals.length).toBeGreaterThan(1);
		expect(new Set(literals)).toEqual(new Set([String(step.env?.[SCALE])]));
	});

	it("judges against the committed baseline the repository ships", () => {
		const [{ step }] = headroom;
		// No `--baseline` means the script's own default, whose path this pins to a
		// file that exists and is the one the reader accepts.
		expect(String(step.run)).not.toContain("--baseline");
		expect(existsSync(resolve(ROOT, DEFAULT_BASELINE_RELATIVE))).toBe(true);
	});
});

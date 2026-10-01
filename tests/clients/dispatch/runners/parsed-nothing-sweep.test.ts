/**
 * Registered-or-fail sweep for the #1948 parsed-nothing gate.
 *
 * `parseToolRun` composes BOTH gates a runner needs before it may claim a
 * clean file: "the tool produced nothing" (#1816) and "the tool produced
 * something the parser could not read" (#1948). A runner that reaches for an
 * OLDER spawn-outcome primitive gets only the first, which is exactly the
 * state that hid five parser bugs for months.
 *
 * The first round of this sweep watched `skipUnlessToolRan` alone. That was
 * too narrow, and a review probe proved it: six runners consult the spawn
 * outcome through `spawnFailedWithNoOutput` or `classifyRunOutcome` instead,
 * so they passed this sweep while carrying the live #1948 hole (tflint and
 * detekt actually did). LEGACY_GATES below names all three primitives, so a
 * runner cannot opt out by picking a different one.
 *
 * Two registries, no overlap. This file owns runners that ARE on a
 * spawn-outcome primitive but not on `parseToolRun`. `run-outcome-ratchet`'s
 * `NOT_YET_ON_PRIMITIVE` owns runners that are on no primitive at all. The
 * last test asserts the exclusivity, so a runner cannot be declared twice or
 * fall between them.
 *
 * Stale claims fail too — an exemption whose call site is gone turns red
 * instead of leaving a lie behind.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNNER_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../clients/dispatch/runners",
);

const RATCHET_TEST = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"run-outcome-ratchet.test.ts",
);

/**
 * Every way a runner can consult the spawn outcome WITHOUT getting the #1948
 * gate. Watching only the first of these is what let the hole survive round
 * one of the review.
 */
const LEGACY_GATES = [
	"skipUnlessToolRan",
	"spawnFailedWithNoOutput",
	"classifyRunOutcome",
] as const;

/**
 * Runners that legitimately parse zero diagnostics out of a FAILING run, so
 * the #1948 rule would fire on a healthy run. Each entry states the mechanism.
 */
const EXEMPT: Record<string, string> = {
	"go-vet.ts":
		"go vet exits nonzero for a SIBLING file's problem, then this runner " +
		"filters the output down to the edited file. Zero parsed diagnostics " +
		"under a nonzero exit is the normal, correct outcome there.",
	"terragrunt.ts":
		"`terragrunt hcl validate` validates the whole UNIT DIRECTORY and has " +
		"no per-file flag, so parseTerragruntOutput attributes findings back to " +
		"the edited file by absolute path. A sibling unit's error therefore " +
		"exits nonzero, prints a full JSON array, and correctly yields zero " +
		"diagnostics for the edited file — the go-vet shape.",
	"cue-vet.ts":
		"already answers this question, and more loudly than a ledger row: on " +
		"a nonzero exit whose output attributes to NO file, filterToTouchedFile " +
		"returns undefined and the runner emits a `cue-vet-unparsed` FAILED " +
		"diagnostic rather than reporting clean. It also filters to the touched " +
		"file, so a sibling's error legitimately yields zero here.",
};

/**
 * Runners that write a `runner-empty-result` row themselves rather than
 * through `skipUnlessToolRan`. Allowed only where the row carries a DIFFERENT
 * discriminating identity than the tool id.
 */
const DIRECT_LEDGER_WRITERS: Record<string, string> = {
	"trivy-config.ts":
		"subject is the FILE PATH, not the tool: the identity a reader needs " +
		"here is which file trivy stopped covering. `trivy config` also exits 0 " +
		"whenever it completed, so any nonzero status is already an error and " +
		"the #1948 rule can never apply to it.",
};

function runnerSources(): string[] {
	return fs
		.readdirSync(RUNNER_DIR)
		.filter((name) => name.endsWith(".ts"))
		.sort();
}

function read(name: string): string {
	return fs.readFileSync(path.join(RUNNER_DIR, name), "utf8");
}

/** Call sites, not mentions: a name inside a comment must not count. */
function callsInSource(source: string, callee: string): boolean {
	return source
		.split(/\r?\n/)
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.some((line) => line.includes(`${callee}(`));
}

describe("parsed-nothing sweep (#1948)", () => {
	const sources = runnerSources();
	const adopters = sources.filter((name) =>
		callsInSource(read(name), "parseToolRun"),
	);
	const legacy = sources.filter((name) => {
		const source = read(name);
		return LEGACY_GATES.some((gate) => callsInSource(source, gate));
	});

	it("scans a non-trivial population, so a broken scanner cannot pass vacuously", () => {
		expect(sources.length).toBeGreaterThan(40);
		// The real adopter count, not a slack floor: raising it is the point of
		// every future migration, and a silent DROP must red.
		expect(adopters.length).toBeGreaterThanOrEqual(14);
		// A LEGACY_GATES typo that matched nothing would make the declaration
		// tests trivially true.
		expect(legacy.length).toBeGreaterThanOrEqual(Object.keys(EXEMPT).length);
	});

	it("every runner on the old gate declares why the parsed-nothing gate is wrong for it", () => {
		const undeclared = legacy.filter((name) => !(name in EXEMPT));
		expect(
			undeclared,
			`these runners consult the spawn outcome without the #1948 gate: ${undeclared.join(", ")}. ` +
				"Migrate them to parseToolRun, or add an EXEMPT entry stating the mechanism.",
		).toEqual([]);
	});

	it("every exemption still names a live call site", () => {
		const stale = Object.keys(EXEMPT).filter((name) => !legacy.includes(name));
		expect(
			stale,
			`these exemptions no longer consult a legacy spawn-outcome gate: ${stale.join(", ")}. Delete them.`,
		).toEqual([]);
	});

	it("no runner rebuilds the rule by hand", () => {
		// The taplo copy this replaced spelled the same rule inline and wrote its
		// own ledger row. A second copy would drift from the shared wording and
		// split the ledger identity across two kinds.
		const handRolled = sources.filter((name) => {
			const source = read(name);
			return (
				callsInSource(source, "incrementDegradationCount") &&
				source.includes("runner-empty-result") &&
				!(name in DIRECT_LEDGER_WRITERS)
			);
		});
		expect(
			handRolled,
			`these runners write a runner-empty-result row directly instead of going ` +
				`through the shared seam: ${handRolled.join(", ")}`,
		).toEqual([]);

		const stale = Object.keys(DIRECT_LEDGER_WRITERS).filter(
			(name) => !read(name).includes("runner-empty-result"),
		);
		expect(
			stale,
			`stale DIRECT_LEDGER_WRITERS entries: ${stale.join(", ")}`,
		).toEqual([]);
	});

	it("declares each runner in exactly one registry", () => {
		// One seam per runner. A file declared here AND in the ratchet's
		// NOT_YET_ON_PRIMITIVE would let a migration satisfy one registry while
		// the other kept a stale claim alive.
		const ratchet = fs.readFileSync(RATCHET_TEST, "utf8");
		const ratchetDeclared = new Set(
			[...ratchet.matchAll(/^\s+"([a-z0-9-]+\.ts)":/gm)].map((m) => m[1]),
		);
		expect(
			ratchetDeclared.size,
			"the ratchet registry scraper matched nothing",
		).toBeGreaterThanOrEqual(13);

		const doubleDeclared = Object.keys(EXEMPT).filter((name) =>
			ratchetDeclared.has(name),
		);
		expect(
			doubleDeclared,
			`declared in both registries: ${doubleDeclared.join(", ")}`,
		).toEqual([]);

		// And an adopter must not still be claimed as un-migrated.
		const staleRatchet = adopters.filter((name) => ratchetDeclared.has(name));
		expect(
			staleRatchet,
			`these adopted parseToolRun but the ratchet still exempts them: ${staleRatchet.join(", ")}`,
		).toEqual([]);
	});
});

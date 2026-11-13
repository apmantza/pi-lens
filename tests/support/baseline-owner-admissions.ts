/**
 * Reason-carrying admissions for a checked-in baseline whose staleness is
 * covered another way (#5072).
 *
 * `tests/config/baseline-owner-governance.test.ts` requires every ledger to
 * have an owner test with a planted-stale-row cell. A ledger whose rows a live
 * scan reproduces exactly (a golden output compared with `toEqual`, or a
 * historical mint pinned by a digest) has no row-without-producer direction to
 * plant: the comparison is two-sided, so a row that no longer matches reds on
 * its own. Each such ledger is admitted here with the owner test that holds
 * the coverage and the reason the plant does not apply.
 *
 * The table is governed: a row naming a ledger the check does not discover is
 * dead and reds, so the table only shrinks, and a row must name an owner test
 * that actually reads that ledger.
 */
export interface BaselineOwnerAdmission {
	/** The test file that owns the ledger's staleness coverage. */
	readonly owner: string;
	/** Why a planted-stale-row cell does not apply to this ledger. */
	readonly reason: string;
}

/** Minimum length of an admission reason: a sentence, not a label. */
export const MIN_ADMISSION_REASON_LENGTH = 60;

export const BASELINE_OWNER_ADMISSIONS: Readonly<
	Record<string, BaselineOwnerAdmission>
> = {
	// The two ast-grep self-scan ledgers share one consumer, `scripts/run-astgrep-pi-lens.mjs`,
	// and it compares one way: a finding missing from the baseline is NEW and exits 1,
	// while a baseline row the scan no longer produces is never mentioned. There is
	// therefore no production comparison a cell could drive for the row-without-
	// producer direction, and giving the CLI that shrink direction is a CI-gate
	// behaviour change the maintainer has to accept — named as a follow-up in the
	// #5072 handback, which also drops these rows once the direction exists.
	"rules/ast-grep-rules/self-scan-baseline.json": {
		owner: "tests/scripts/astgrep-self-scan.test.ts",
		reason:
			"its only consumer compares findings against the baseline one way, so no owner-test cell can falsify a row without adding that direction to the CI gate (named as a follow-up in #5072).",
	},
	"scripts/governance-rules/baseline.json": {
		owner: "tests/scripts/astgrep-self-scan.test.ts",
		reason:
			"same one-way consumer as the self-scan baseline, so the row-without-producer plant needs the shrink direction added to scripts/run-astgrep-pi-lens.mjs first (named as a follow-up in #5072).",
	},
};

/**
 * Test files allowed to call the planted-stale-row seam without naming a
 * baseline the census can see.
 *
 * The seam's own unit test falsifies ledgers it writes into a temporary
 * directory, so its `baseline:` values are expressions addressing files no
 * census can discover. Without this the check reports each of those calls as a
 * registration that names nothing. The allowance covers only the missing-literal
 * report: such a call never counts as a cell, so a baseline is never decorated
 * by a test that does not exercise it. Keep this list to the seam's own units.
 */
export const SEAM_TEST_CALL_FILES: readonly string[] = [
	"tests/support/baseline-staleness.test.ts",
];

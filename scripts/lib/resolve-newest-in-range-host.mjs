// Pure helpers behind scripts/resolve-newest-in-range-host.mjs (#2613) — kept
// side-effect-free (no fs/child_process/npm) so the semver-selection logic is
// unit-testable without a live npm registry, mirroring
// scripts/lib/drift-issue.mjs's own testing pattern (that file tests the
// issue-body/lookup logic, not the workflow step that shells out to `gh`;
// this tests the version-selection logic, not the script that shells out to
// `npm view`).
//
// WHY THIS EXISTS (#2590 recurrence, #2613)
// install-smoke.yml's PR-gating lanes install the pinned floor host AND the
// newest pi-coding-agent version this repo's declared peerDependencies range
// admits, so a peer-range change (like #2588) is exercised on the exact host
// it newly admits, before it ships. Reading the range straight out of
// package.json (rather than duplicating it as a separate workflow input)
// keeps the install lane and the declared range in agreement BY
// CONSTRUCTION — a future range edit changes what this resolves on its very
// next run, no second edit required.
//
// REVIEW S1 (#2613 round 2): `peerDependencies["@earendil-works/pi-coding-agent"]`
// is `"*"` today — an unbounded peer range would make "newest in range"
// silently equal "@latest" on a BLOCKING PR lane, exactly the "always
// latest" shape the maintainer routed to the ADVISORY nightly instead. A
// repo-owned `PI_HOST_SUPPORTED_RANGE` (workflow env, alongside the floor
// pin) is intersected with the declared peer range so the wildcard case
// stays bounded by construction; `pickNewestInRange` now takes a LIST of
// ranges (AND semantics: a candidate must satisfy every one).

import semver from "semver";

export const SUPPORTED_RANGE_ENV_VAR = "PI_HOST_SUPPORTED_RANGE";

/**
 * Read the declared peerDependencies range for `packageName` out of a parsed
 * package.json object.
 *
 * @param {Record<string, unknown>} pkg
 * @param {string} packageName
 * @returns {string}
 */
export function readPeerRange(pkg, packageName) {
	const range =
		/** @type {Record<string, unknown> | undefined} */ (
			pkg?.peerDependencies
		)?.[packageName];
	if (typeof range !== "string" || range.trim() === "") {
		throw new Error(
			`package.json has no peerDependencies["${packageName}"] entry`,
		);
	}
	return range;
}

/**
 * Read the repo-owned `PI_HOST_SUPPORTED_RANGE` ceiling out of an env-like
 * object. Required: a wildcard (or otherwise unbounded) declared peer range
 * must never leave this resolution unbounded on a BLOCKING lane (#2613
 * review S1) — this is the seam that keeps it bounded regardless of what
 * the peer range says.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function readSupportedRangeEnv(env) {
	const range = env?.[SUPPORTED_RANGE_ENV_VAR];
	if (typeof range !== "string" || range.trim() === "") {
		throw new Error(
			`${SUPPORTED_RANGE_ENV_VAR} is required (bump it by hand when the peer range narrows or a new minor is validated)`,
		);
	}
	return range;
}

/**
 * Pick the highest published version in `versions` that satisfies EVERY
 * range in `ranges` (AND semantics — a wildcard peer range does not make
 * this unbounded when a second, narrower range is also supplied), excluding
 * prereleases (a prerelease is never a real "newest stable host"). Returns
 * null when nothing satisfies every range — the caller turns that into
 * exit 4.
 *
 * `semver.satisfies` already tolerates invalid/garbage version strings
 * (returns false rather than throwing) and, with `includePrerelease: false`
 * (its own default), already excludes prereleases — a separate pre-filter
 * for either would be dead code, so `versions` is passed straight through.
 * There is no single-string "intersect two ranges" form in the `semver`
 * package (a range is itself an OR of comparator sets), so the AND is
 * computed by requiring every range to independently accept a candidate,
 * then taking the max of what survives — semantically an intersection.
 *
 * @param {string[]} versions
 * @param {string | readonly string[]} ranges
 * @returns {string | null}
 */
export function pickNewestInRange(versions, ranges) {
	const rangeList = Array.isArray(ranges) ? ranges : [ranges];
	const candidates = (versions ?? []).filter((v) =>
		rangeList.every((r) =>
			semver.satisfies(v, r, { includePrerelease: false }),
		),
	);
	if (candidates.length === 0) return null;
	return candidates.reduce((max, v) => (semver.gt(v, max) ? v : max));
}

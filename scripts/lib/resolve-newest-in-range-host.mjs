// Pure helpers behind scripts/resolve-newest-in-range-host.mjs (#2613, #5749)
// — kept side-effect-free (no fs/child_process/npm) so the selection logic is
// unit-testable without a live npm registry, mirroring
// scripts/lib/drift-issue.mjs's own testing pattern (that file tests the
// issue-body/lookup logic, not the workflow step that shells out to `gh`;
// this tests the version-acceptance logic, not the script that shells out to
// `npm view`).
//
// WHY THIS EXISTS (#2590 recurrence, #2613)
// install-smoke.yml's PR-gating lanes install the pinned floor host AND the
// newest pi-coding-agent version, so a host release (or a peer-range change
// like #2588) is exercised before it ships. The peer range is read straight
// out of package.json (rather than duplicated as a separate workflow input)
// so the lane and the declared range agree BY CONSTRUCTION: a peer range that
// stops admitting the newest host reds this lane instead of going unseen.
//
// THE UPPER END IS ALWAYS THE LATEST STABLE PI (#5749, maintainer decision
// 2026-11-22). The first design (#2613 review S1) kept a hand-bumped
// `PI_HOST_SUPPORTED_RANGE` ceiling in the workflow so the wildcard peer range
// could not mean "@latest" on a blocking lane, and routed "always latest" to
// the advisory nightly. That left pi 1.6.0 untested by any gating lane for two
// days after it shipped, and the ceiling was a second place (beside
// PI_HOST_FLOOR_VERSION) that had to be remembered. It is deleted: the host is
// the npm dist-tag `latest` itself. Not the highest version in the versions
// list, which can name a release the maintainers never promoted.

import semver from "semver";

/**
 * Read the declared peerDependencies range for `packageName` out of a parsed
 * package.json object.
 *
 * @param {Record<string, unknown>} pkg
 * @param {string} packageName
 * @returns {string}
 */
export function readPeerRange(pkg, packageName) {
	const range = /** @type {Record<string, unknown> | undefined} */ (
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
 * Whether `version`, the registry's `latest` dist-tag, is a host this lane may
 * install: a valid, stable (non-prerelease) version that satisfies the
 * declared peer range. Anything else is refused, never skipped over to an older
 * host: the caller turns a refusal into exit 4 (fail closed).
 *
 * @param {unknown} version
 * @param {string} peerRange
 * @returns {boolean}
 */
export function isAcceptableLatestHost(version, peerRange) {
	return (
		typeof version === "string" &&
		semver.valid(version) === version &&
		semver.prerelease(version) === null &&
		semver.satisfies(version, peerRange)
	);
}

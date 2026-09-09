import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { describe, expect, it } from "vitest";

// #2633: package.json declared no `engines`, so a fresh install silently
// warned EBADENGINE about a transitive package (typescript-language-server)
// instead of pi-lens stating its own Node floor. This governance test keeps
// engines.node present AND honest against every dependency's own declared
// floor, read from the lockfile (the source of truth for what actually gets
// installed), not re-derived by hand.

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const pkg = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
	engines?: { node?: string };
};

interface LockPackageEntry {
	dev?: boolean;
	engines?: { node?: string };
	version?: string;
}

const lock = JSON.parse(
	fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
) as {
	packages?: Record<string, LockPackageEntry>;
};

interface DependencyFloor {
	name: string;
	range: string;
	dev: boolean;
}

// Every lockfile entry (prod AND dev) that declares its own engines.node —
// a real `npm install` (no --omit=dev, matching `pi update --all`'s git
// install of the whole repo, #2633's actual reproduction) resolves and
// engine-checks dev entries too, so EBADENGINE can come from either side.
function allDependenciesWithNodeFloor(): DependencyFloor[] {
	const packages = lock.packages ?? {};
	const out: DependencyFloor[] = [];
	for (const [key, entry] of Object.entries(packages)) {
		if (key === "") continue; // the root package (pi-lens itself)
		const range = entry.engines?.node;
		if (!range) continue;
		out.push({ name: key, range, dev: entry.dev === true });
	}
	return out;
}

function productionDependenciesWithNodeFloor(): DependencyFloor[] {
	return allDependenciesWithNodeFloor().filter((dep) => !dep.dev);
}

describe("engines.node floor governance (#2633)", () => {
	it("declares engines.node with a real, finite lower bound", () => {
		const range = pkg.engines?.node;
		expect(range, "package.json must declare engines.node").toBeTruthy();

		// The cheapest way to pass the checks below is to declare
		// engines.node: "*" — a wildcard is a semver superset of any finite
		// range, so it would trivially satisfy a subset/satisfies check
		// without promising a floor at all. Reject any range whose lower
		// bound is not a real version above 0.0.0 (semver.minVersion
		// returns null, not a thrown error, for a range with no
		// satisfying version at all, e.g. a self-contradictory range).
		const minVersion = semver.minVersion(range ?? "");
		const hasFiniteFloor =
			minVersion !== null && minVersion.compare("0.0.0") > 0;
		expect(
			hasFiniteFloor,
			`engines.node ("${range}") must have a real, finite lower bound above 0.0.0 (not an unbounded range like "*")`,
		).toBe(true);
	});

	it("satisfies engines.node for every production dependency's own floor", () => {
		const range = pkg.engines?.node ?? "";
		const deps = productionDependenciesWithNodeFloor();

		// Sanity: the walk must actually find entries, or the check below
		// passes vacuously because there is nothing to violate.
		expect(deps.length).toBeGreaterThan(0);

		// semver.subset(A, B) is true only when every version satisfying A
		// also satisfies B — the correct comparison for disjoint/gapped
		// dependency ranges (e.g. "18 || 20 || >=22"), unlike comparing bare
		// lower bounds, which would miss a gap above the floor. This case is
		// scoped to production (dev:false/absent) entries: those are what a
		// downstream `npm install --omit=dev` consumer of the published
		// package actually installs.
		const violations = deps.filter((dep) => !semver.subset(range, dep.range));
		expect(
			violations,
			`engines.node ("${range}") must satisfy every production dependency's own engines.node; violations: ${JSON.stringify(violations)}`,
		).toEqual([]);
	});

	it("would not warn EBADENGINE for any lockfile entry, prod or dev, when installed on Node = declared floor (#2633 review F1)", () => {
		// Case 2 above scopes to production entries, so a devDependency with
		// a floor above ours (e.g. a tool pinned back specifically because
		// its latest raised the floor) is invisible to it — exactly the
		// #2633 shape: typescript-language-server is `dev:true`, and the
		// bug reproduced through a git install of the FULL repo (devDeps
		// included), not a downstream `--omit=dev` install. This case
		// encodes the acceptance criterion directly: "a fresh install on
		// Node = declared floor emits no EBADENGINE line" is exactly
		// `semver.satisfies` of every lockfile entry's own engines.node at
		// our declared floor's minimum version — the same predicate npm's
		// own EBADENGINE check runs at install time, over every entry
		// instead of just the one Node happens to have installed.
		const range = pkg.engines?.node ?? "";
		const floorVersion = semver.minVersion(range)?.version ?? "0.0.0";
		const deps = allDependenciesWithNodeFloor();

		expect(deps.length).toBeGreaterThan(0);

		const violations = deps.filter(
			(dep) => !semver.satisfies(floorVersion, dep.range),
		);
		expect(
			violations,
			`installing on Node ${floorVersion} (our declared floor) would print EBADENGINE for: ${JSON.stringify(violations)}`,
		).toEqual([]);
	});
});

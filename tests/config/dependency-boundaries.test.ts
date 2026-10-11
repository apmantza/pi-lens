import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { parse: parseJson5 } = require("json5") as {
	parse: (source: string) => unknown;
};
const dependencyCruiserPackagePath = resolve(
	repoRoot,
	"node_modules/dependency-cruiser/package.json",
);
const dependencyCruiserPackage = JSON.parse(
	readFileSync(dependencyCruiserPackagePath, "utf8"),
) as { bin: { depcruise: string } };
// Regression: dependency-cruiser 18.3.1 renamed its private entry file while
// preserving the public depcruise command declared in package metadata.
const depcruiseBin = resolve(
	dirname(dependencyCruiserPackagePath),
	dependencyCruiserPackage.bin.depcruise,
);

function cruiseBuiltGraph(): {
	modules: Array<{
		source: string;
		dependencies?: Array<{
			resolved?: string;
			dynamic?: boolean;
		}>;
	}>;
} {
	const output = execFileSync(
		process.execPath,
		[
			depcruiseBin,
			"--validate",
			"--config",
			".dependency-cruiser.cjs",
			"--output-type",
			"json",
			"--no-ignore-known",
			"index.ts",
			"clients/**/*.ts",
		],
		{ cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	return JSON.parse(output) as ReturnType<typeof cruiseBuiltGraph>;
}

describe("dependency boundary governance", () => {
	it("keeps the configured boundary rules present", () => {
		const config = require(resolve(repoRoot, ".dependency-cruiser.cjs")) as {
			forbidden: Array<{ name?: string }>;
		};
		const ruleNames = config.forbidden.map((rule) => rule.name).sort();

		expect(ruleNames).toEqual(
			[
				"declared-client-leaf",
				"no-client-cycles",
				"session-start-eager-allowlist-config-dependency-cruiser-eager-allowlist-json",
			].sort(),
		);
	});

	it("keeps the eager allowlist equal to index.ts static client imports", () => {
		const graph = cruiseBuiltGraph();
		const indexModule = graph.modules.find(
			(module) => module.source === "index.ts",
		);
		expect(indexModule).toBeDefined();

		const resolvedStaticImports = (indexModule?.dependencies ?? [])
			.filter(
				(dependency) =>
					dependency.resolved?.startsWith("clients/") && !dependency.dynamic,
			)
			.map((dependency) => `./${dependency.resolved}`)
			.sort();
		const eagerAllowlist = parseJson5(
			readFileSync(
				resolve(repoRoot, "config/dependency-cruiser-eager-allowlist.json"),
				"utf8",
			),
		) as string[];

		expect(eagerAllowlist).toEqual(resolvedStaticImports);
	}, 30_000);

	it("pins the reviewed static-cycle baseline size", () => {
		// Limitation: this count pin does not detect a baseline shrink. A removed
		// entry is invisible when the remaining entries still satisfy the count.
		//
		// #2418: 30 -> 31. The three config loaders now warn through the shared
		// `clients/config-warn.ts` seam, so three entries were RESHAPED (the same
		// pre-existing extension-log -> file-utils -> lens-config cycle, with
		// config-warn on the path instead of each loader directly) and one is
		// net-new: config-warn -> degradation-ledger, the warn seam recording its
		// own ignored-config telemetry. The ledger sits upstream of the config
		// chain, so that edge closes a baseline-class cycle rather than
		// introducing new coupling — the same reasoning entry 30 was accepted
		// under (#2173). Reduction stays tracked in #2125.
		//
		// #2426: 31 -> 33. Two entries RESHAPED (the loaders resolve through the
		// shared `clients/config-resolve.js`, so it sits on the pre-existing
		// config-warn -> degradation-ledger -> extension-log -> file-utils cycle
		// where `project-lens-config.js` sat directly) and two net-new
		// config-warn edges, both the shared resolver reporting through the SAME
		// seam each loader already used. The same PR REMOVED six cycles it would
		// otherwise have added: `resolveConfig` moved out of the `config-core`
		// barrel so a resolver no longer drags `process-spec` -> `project-trust`,
		// and `config-core` lost both of its sink imports
		// (`reportPiLensConfigRecords` -> `config-resolve.js`,
		// `DEGRADATION_ENTRIES_PER_KIND` -> the `ledger-bounds.js` leaf), which is
		// what that module's own doc always claimed of it.
		//
		// #2426 review round 2 adds NO entry: `workspace-topology.js` now imports
		// the shared basename table from `config-locations.js` instead of carrying
		// its own copy, and that module's transitive set
		// (`config-diagnostic-codes.js`, `path-utils.js`) reaches nothing that
		// imports back into the topology index, so the edge closes no cycle.
		//
		// #2516 round 2: 33 -> 12, the largest reduction this ratchet has seen,
		// and ZERO entries added. `getGlobalPiLensLogDir()` and the probe-home
		// redirect moved from `clients/file-utils.js` onto the cycle-free
		// `clients/probe-home-state.js` leaf; `extension-log.js` imported
		// `file-utils.js` for that function and nothing else, so the edge went
		// with it and took the whole `file-utils` -> `safe-spawn` ->
		// `degradation-ledger` -> `extension-log` -> `file-utils` cycle with it.
		// Eighteen other log-family modules dropped the same edge. The two
		// violations CI reported mid-round were the SURVIVING `file-utils` ->
		// `safe-spawn` and `git-tracked-ignore` -> `safe-spawn` edges reporting a
		// different representative path (through `resource-sampler` ->
		// `instance-reaper`) once the shorter one was gone — not new coupling.
		// `file-utils.js` is still on that remaining cycle, which is why the
		// resolver must stay off it. Reduction stays tracked in #2125.
		//
		// #4314: 12 -> 5, ZERO entries added. no-client-cycles now skips any
		// cycle that a dynamic import closes (`viaOnly.dependencyTypesNot`),
		// which the rule's first-edge-only `dependencyTypesNot` always meant. All
		// seven dropped entries carry a dynamic-import edge; two were already
		// stale. This is what lets clients/lsp-lazy.ts keep the literal
		// `import("./lsp/capabilities.js")` that esbuild has to see.
		const baseline = parseJson5(
			readFileSync(
				resolve(repoRoot, ".dependency-cruiser-known-violations.json"),
				"utf8",
			),
		) as unknown[];

		expect(baseline).toHaveLength(5);
	}, 30_000);
});

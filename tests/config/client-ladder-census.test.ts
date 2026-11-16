/**
 * Client ladder census (#5410, #5666 item 1).
 *
 * The runner census (`registry-parity.test.ts`, "Runner CLI scanner") counts
 * the checkers a dispatch runner builds. It never looked at the clients, which
 * built their own: madge, jscpd and knip each held a private checker, the
 * security scanners probed a managed binary no ladder had verified, and two
 * clients called a second probe-then-install entry beside
 * `resolveAvailableOrInstall`. This census counts every client-owned use of a
 * binary-lookup primitive, so a new stray ladder reds until it is either folded
 * onto the resolver (`resolveToolCommandWithInstallFallback`,
 * `resolveInstalledToolCommand`, `toolBinaryVerdict`) or admitted below with
 * the reason it stays.
 *
 * STATE TABLE (docs/pi-lens-fixer.md "Evidence", detector rule)
 *
 *   admitted   a plain import specifier of a primitive (naming is not using),
 *              and a use whose `file::primitive` key carries a written reason
 *              in `CLIENT_LADDER_ADMISSIONS`;
 *   refused    every other leaf spelling the primitive: a call, an
 *              import-as alias, a namespace or member access, a string key, a
 *              destructured dynamic import, a re-export, a `typeof`.
 *
 * The population is every AST leaf whose text is exactly a primitive name, so
 * a comment never counts and never excuses. The key is the file and the name,
 * never an occurrence count, so a second use in an admitted file is not a new
 * ladder and a moved use keeps its row (defect shape 36).
 *
 * Recurrence pinned: #5410's four availability ladders disagreed on memo, trust
 * and lookup order; the S1/S2 slices folded the runners, and the audit of
 * 2026-11-16 found the same disagreement in the clients the census never read.
 *
 * The primitives are the lookup helpers AND the two seams every hand-built
 * ladder reaches: the installer ask (`ensureTool`, `getInstallAttempt`,
 * `isSpawnableCommand`) and the version probe (`probeToolAsync`). A ladder
 * assembled from `safeSpawnAsync` plus `ensureTool` is seen through the
 * second. Not seen: a probe made with `safeSpawn*` directly that never asks
 * the installer, and any lookup helper added later under a new name until it
 * joins this list.
 *
 * Out of the population, with the owner of each: `clients/dispatch/runners/`
 * (the runner census above), `clients/installer/`,
 * `clients/package-manager.ts` and `clients/tool-probe.ts` (the owners of the
 * lookups and the probe themselves), and
 * `clients/lsp/` (the LSP launch ladder stays distributed by the #5666
 * consolidation verdict, and its launch order is lane #5674's).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { censusSourceFiles, parseNodes } from "../support/ast-census.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	readWalkedFiles,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every way a client reaches a binary without asking the resolver. */
const LADDER_PRIMITIVES: ReadonlySet<string> = new Set([
	"createAvailabilityChecker",
	"resolveAvailableOrInstall",
	"resolveManagedToolClient",
	"findNodeToolBinary",
	"findGlobalBinary",
	"findLocalBinUpwards",
	"findLocalBinAt",
	"findLocalBinsAt",
	"findManagedToolBinary",
	"findManagedNodeToolBinary",
	"findManagedReleaseBinary",
	"discoverManagedTool",
	// The seams a ladder reaches when it builds its own probe-then-install
	// sequence from parts (#5410 review r1 F2): a client that asks the installer
	// or runs a version probe is a ladder whether or not it names a lookup helper.
	"ensureTool",
	"getInstallAttempt",
	"isSpawnableCommand",
	"probeToolAsync",
]);

/** Source this census leaves to its owner; see the header. */
const EXCLUDED_PREFIXES: readonly string[] = [
	"clients/dispatch/runners/",
	"clients/installer/",
	"clients/lsp/",
	"clients/package-manager.ts",
	"clients/tool-probe.ts",
];

/** The primitives a source file uses (plain imports excluded), by name. */
function ladderUses(source: string): Set<string> {
	const used = new Set<string>();
	for (const leaf of parseNodes(source)) {
		if (!leaf.isLeaf() || !LADDER_PRIMITIVES.has(leaf.text())) continue;
		const parent = leaf.parent();
		if (parent?.kind() === "import_specifier" && !parent.field("alias")) {
			continue;
		}
		used.add(leaf.text());
	}
	return used;
}

/** `file::primitive` for every client-owned use in the real tree. */
function clientLadderUses(): { keys: string[]; scanned: number } {
	const files = censusSourceFiles(
		[
			path.join(ROOT, "clients"),
			path.join(ROOT, "tools"),
			path.join(ROOT, "mcp"),
			path.join(ROOT, "index.ts"),
		],
		{ extensions: ["ts"] },
	).filter((file) => {
		const relative = path.relative(ROOT, file).split(path.sep).join("/");
		return !EXCLUDED_PREFIXES.some((prefix) => relative.startsWith(prefix));
	});
	const keys: string[] = [];
	for (const { file, source } of readWalkedFiles(files)) {
		const relative = path.relative(ROOT, file).split(path.sep).join("/");
		for (const name of ladderUses(source)) keys.push(`${relative}::${name}`);
	}
	return { keys, scanned: files.length };
}

/**
 * Every client-owned use that stays, with why. `auditRegistry` reds a row whose
 * use disappeared, so a fold deletes its row in the same change.
 */
const CLIENT_LADDER_ADMISSIONS: Record<string, string> = {
	"clients/biome-client.ts::findGlobalBinary":
		"BiomeClient resolves the binary it spawns for formatting and linting: project shim at the file's cwd, managed, pm-global bins, then npx. The registry ladder answers availability for the runner; folding the spawn ladder waits on #5410 D10.",
	"clients/biome-client.ts::findLocalBinAt":
		"BiomeClient's project rung at the exact cwd, the same lookup the registry ladder makes; its spawn ladder stays with its other rungs (see findGlobalBinary).",
	"clients/biome-client.ts::getInstallAttempt":
		"Reads the install attempt to explain a missing biome in the availability record; the write side is resolveManagedToolClient's (see its row).",
	"clients/biome-client.ts::probeToolAsync":
		"BiomeClient's own version probe of the candidates in its spawn ladder (see findGlobalBinary); folding waits on #5410 D10.",
	"clients/biome-client.ts::resolveManagedToolClient":
		"Typed install seam with a caller-supplied probe and an acceptInstalled validation; biome is one of its two callers. Staying: the install-attempt state it writes is runner-helpers' own, shared with resolveAvailableOrInstall, so there is one memory.",
	"clients/dead-code-client.ts::findLocalBinsAt":
		"vulture's venv candidate list at exactly the root, trust-gated; vulture has no registry spec row and no install path.",
	"clients/dead-code-client.ts::probeToolAsync":
		"vulture's candidate probe (python, python3, pipx); vulture has no registry spec row and no install path.",
	"clients/dependency-checker.ts::discoverManagedTool":
		"madge spawn resolution: read-only managed discovery, never an install, on the spawn path.",
	"clients/dependency-checker.ts::findNodeToolBinary":
		"madge spawn resolution walks to the project's own hoisted copy and the pm-global bins; the shared resolver reads only <cwd>/node_modules/.bin (#2544 r4 F2), so folding is the maintainer's trust-scope decision (#5410 D10).",
	"clients/dependency-checker.ts::isSpawnableCommand":
		"madge spawn resolution asks whether the managed install result is spawnable before running it; read-only, on the spawn path.",
	"clients/dispatch/dispatcher.ts::createAvailabilityChecker":
		"The PATH-only checker behind DispatchContext.hasTool; its fold is #5410's own acceptance item and not this slice's.",
	"clients/dispatch/dispatcher.ts::isSpawnableCommand":
		"The PATH walk behind DispatchContext.hasTool, the same admitted checker as its createAvailabilityChecker row.",
	"clients/formatters.ts::ensureTool":
		"The formatter install fallbacks after a missing formatter; the formatter ladders are #5410's formatter remainder.",
	"clients/formatters.ts::findGlobalBinary":
		"Formatter ladders (biome, prettier): pm-global bins after the project walk; tracked in #5410's formatter remainder.",
	"clients/formatters.ts::findLocalBinUpwards":
		"The formatter walker climbs to the HOME ceiling by design; the project-scope decision is #5410 D10.",
	"clients/formatters.ts::probeToolAsync":
		"The go toolchain probes behind gofmt and the legacy formatter check; toolchain presence, not a registry tool.",
	"clients/govulncheck-client.ts::probeToolAsync":
		"GovulncheckClient's go toolchain and govulncheck probes with its own go-install step; folding it is the security-scanner remainder of #5410.",
	"clients/jscpd-client.ts::findNodeToolBinary":
		"jscpd scan resolves the project's own copy against the scanned root, ancestors and pm-global bins included; the shared resolver reads only the exact cwd, so the scope decision is #5410 D10.",
	"clients/knip-client.ts::findLocalBinUpwards":
		"resolveProjectKnipBinary: the project's pinned knip, found by walking up so a workspace package gets the monorepo's hoisted copy (#1721); the scope decision is #5410 D10.",
	"clients/mcp/session.ts::ensureTool":
		"Wires the installer into the session-start dependency bag for the MCP host; no lookup of its own.",
	"clients/pipeline.ts::probeToolAsync":
		"The cargo and dart toolchain presence probes of the language pipelines; not registry tools and never installed.",
	"clients/runtime-session.ts::ensureTool":
		"The session-start install of the essential tools, a separate caller of the installer from any availability ladder.",
	"clients/security-scan-client.ts::ensureTool":
		"The scanners' install step after a missing probe (ensureViaInstaller); its managed rung is the registry's (see findManagedReleaseBinary), the rest of this ladder is the security-scanner remainder of #5410.",
	"clients/security-scan-client.ts::findManagedReleaseBinary":
		"The security scanners' probe asks for the managed release binary through the runners' own verified rung, so a managed binary that fails its version check falls through to PATH.",
	"clients/security-scan-client.ts::getInstallAttempt":
		"Reads the install attempt to tell a failed install from a skipped one in the scanners' availability record.",
	"clients/security-scan-client.ts::probeToolAsync":
		"The scanners' version probe, run on the candidate the registry's managed rung verified.",
	"clients/sg-runner.ts::findGlobalBinary":
		"SgRunner's multi-candidate ast-grep ladder (sg, ast-grep, npx) with provisional sweeps; it has no registry spec row.",
	"clients/sg-runner.ts::getInstallAttempt":
		"Reads the install attempt for SgRunner's availability record (see resolveManagedToolClient).",
	"clients/sg-runner.ts::probeToolAsync":
		"SgRunner's version probe of its ast-grep candidates (see findGlobalBinary).",
	"clients/sg-runner.ts::resolveManagedToolClient":
		"SgRunner's install step after its own ladder concluded missing; see biome-client's row for why the typed entry stays.",
	"clients/test-runner-client.ts::findGlobalBinary":
		"The test runner's pm-global rung for the runner binary it detects; tracked with the test-runner PATH probes in #5410's remainder.",
	"clients/test-runner-client.ts::findLocalBinAt":
		"The test runner's project rung at the exact root, the same lookup the registry ladder makes.",
	"index.ts::ensureTool":
		"Wires the installer into the session-start dependency bag for pi; no lookup of its own.",
};

describe("Client ladder census (#5410)", () => {
	it(
		"every client-owned binary lookup is admitted with the reason it stays",
		() => {
			const { keys, scanned } = clientLadderUses();
			assertNonEmptyScan("client ladder uses", keys.length, 10);
			const audit = auditRegistry({
				sweepName: "client-ladder-census",
				flagged: keys,
				registered: [],
				exemptions: CLIENT_LADDER_ADMISSIONS,
				scannedCount: scanned,
				minScanned: 100,
				remediation:
					"Fold the lookup onto resolveToolCommandWithInstallFallback / resolveInstalledToolCommand / toolBinaryVerdict, or add a CLIENT_LADDER_ADMISSIONS row that says why it stays.",
			});
			expect(audit.problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});

describe("Client ladder scanner (#5410)", () => {
	const IMPORT = `import { findNodeToolBinary } from "./package-manager.js";`;

	// Shape 69: each spelling reaches a primitive without the bare call a first
	// version matched. The good set is a plain import and nothing else.
	it.each([
		["a plain call", `${IMPORT}\nfindNodeToolBinary("x", ".");`],
		[
			"an import-as alias",
			`import { findNodeToolBinary as f } from "./package-manager.js";\nf("x", ".");`,
		],
		[
			"a namespace member",
			`import * as pm from "./package-manager.js";\npm.findNodeToolBinary("x", ".");`,
		],
		[
			"a value reached through another binding",
			`${IMPORT}\nconst find = findNodeToolBinary;\nfind("x", ".");`,
		],
		[
			"a computed string key",
			`import * as pm from "./package-manager.js";\npm["findNodeToolBinary"]("x", ".");`,
		],
		[
			"a destructured dynamic import",
			`const { findNodeToolBinary } = await import("./package-manager.js");\nfindNodeToolBinary("x", ".");`,
		],
		[
			"a re-export",
			`export { findNodeToolBinary } from "./package-manager.js";`,
		],
	])("counts %s", (_name, source) => {
		expect([...ladderUses(source)]).toEqual(["findNodeToolBinary"]);
	});

	// Recurrence: #5685 review F2. The census listed lookup helpers only, so a
	// ladder built from a version probe, an npx spawn and an installer ask
	// passed it. The probe and the installer ask are what any such ladder uses.
	it("counts a ladder built from a probe, an npx spawn and an installer ask", () => {
		const planted = `
import { probeToolAsync } from "./tool-probe.js";
import { safeSpawnAsync } from "./safe-spawn.js";
export async function resolveStray(cwd: string) {
	const direct = await probeToolAsync("stray", ["--version"], { cwd });
	if (direct.available) return "stray";
	const viaNpx = await safeSpawnAsync("npx", ["stray", "--version"], { cwd });
	if (viaNpx.status === 0) return "npx";
	const { ensureTool } = await import("./installer/index.js");
	return ensureTool("stray");
}`;
		expect([...ladderUses(planted)].sort()).toEqual([
			"ensureTool",
			"probeToolAsync",
		]);
	});

	it("does not count a plain import, a comment or an unrelated name", () => {
		expect([...ladderUses(IMPORT)]).toEqual([]);
		expect([
			...ladderUses(
				`${IMPORT}\n// findNodeToolBinary is discussed here\nconst note = "see findNodeToolBinaryDocs";`,
			),
		]).toEqual([]);
	});
});

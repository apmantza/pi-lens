/**
 * Topology-derived cache consumer conformance — #2294.
 *
 * `registerWorkspaceTopologyReset` is a PUSH-ONLY registry in
 * `clients/workspace-topology.ts`. A future module that memoizes results from
 * a topology probe seam (`getDirectoryMarkers`, `findNearestDirWithAnyBasename`,
 * `findNearestProjectRoot`, and the rest of the canonical list) can fail to
 * register a downstream reset, and NOTHING today notices — the seam has no
 * pull side. `startup-scan.ts`, `review-graph/tsconfig-paths.ts`, and
 * `language-profile.ts` each register a reset; whether that is every current
 * consumer is unprovable from the registry alone.
 *
 * This is the compensating guard: ENUMERATE the consumers via source scan
 * (`tests/support/workspace-topology-scan.ts` exposes the detector), then
 * assert each is either registered (derived — the file itself calls
 * `registerWorkspaceTopologyReset(`) or documented-exempted with a
 * freshness-key reason. Class family: registered-or-fail session-state, the
 * sweep-floor meta-sweep, and the bus-census guards. No runtime behavior is
 * added; the conformance test IS the guard.
 *
 * The population is import-scoped for the consumer (see the scan's doc header):
 * a governed probe enters a module through a NAMED import (including aliases),
 * a multiline named import, or a NAMESPACE import of a canonical source module;
 * a bare import counts even if the binding is never called; an unrelated
 * same-name LOCAL function never does. Registration is derived from an actual
 * CALL-shaped `registerWorkspaceTopologyReset(` on stripped source, exactly
 * like the session-state sweep, so a comment or string that merely NAMES the
 * registration does not count.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { clientSourceFiles } from "../support/session-state-scan.js";
import {
	TOPOLOGY_OWNER,
	TOPOLOGY_PROBE_SEAMS,
	scanTopologyConsumers,
	registeredTopologyConsumers,
} from "../support/workspace-topology-scan.js";
import { assertNonEmptyScan, auditRegistry } from "../support/sweep-kit.js";

/** The canonical topology probe seams, both documented and detected. */
const CANONICAL_SEAMS: readonly string[] = [
	"getDirectoryMarkers",
	"findNearestDirWithMarker",
	"findNearestDirWithAnyBasename",
	"findPiLensConfigMarkerInDir",
	"findGoverningTsconfigDir",
	"getWorkspaceManifestMarkers",
	"findNearestProjectRoot",
];

describe("workspace-topology scan — detector shape", () => {
	it("owns the canonical probe-seam list", () => {
		// The detector and the documentation stay one list.
		expect(TOPOLOGY_PROBE_SEAMS).toEqual(CANONICAL_SEAMS);
		expect(typeof TOPOLOGY_PROBE_SEAMS).toBe("object");
	});

	it("governed probes are scoped to their canonical source modules", () => {
		// `findNearestProjectRoot` lives in startup-scan, NOT workspace-topology.
		// A consumer importing a probe from the wrong module is a mistake we must
		// not falsely govern. The flat list is the union of the per-module
		// export sets, so a probe that lands in the wrong module (or two) shows
		// up as a flat-list drift and reds the equality in the test above.
		expect(TOPOLOGY_PROBE_SEAMS).toEqual([
			"getDirectoryMarkers",
			"findNearestDirWithMarker",
			"findNearestDirWithAnyBasename",
			"findPiLensConfigMarkerInDir",
			"findGoverningTsconfigDir",
			"getWorkspaceManifestMarkers",
			"findNearestProjectRoot",
		]);
	});

	it("excludes the seam owner structurally", () => {
		const consumerFiles = scanTopologyConsumers().map((c) => c.file);
		expect(consumerFiles).not.toContain(TOPOLOGY_OWNER);
	});
});

// The detector's own correctness against synthetic fixture trees, so a
// regression here cannot hide behind whatever `clients/` contains today.
// Same discipline as the R1/S1 walker probes in session-state-conformance.
describe("workspace-topology scan — synthetic fixtures", () => {
	function withFixtureTree(
		files: Record<string, string>,
		run: (dir: string) => void,
	): void {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-topology-sweep-"),
		);
		try {
			for (const [name, contents] of Object.entries(files)) {
				fs.mkdirSync(path.dirname(path.join(dir, name)), {
					recursive: true,
				});
				fs.writeFileSync(path.join(dir, name), contents);
			}
			run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	it("flags a module that IMPORTS a probe seam (named import)", () => {
		withFixtureTree(
			{
				"consumer.ts":
					'import { getDirectoryMarkers } from "./workspace-topology.js";\nconst c = getDirectoryMarkers("/probe");',
			},
			(dir) => {
				const consumers = scanTopologyConsumers(dir);
				expect(consumers.map((c) => c.file)).toEqual(["consumer.ts"]);
				expect(consumers[0].importLines.length).toBeGreaterThanOrEqual(1);
			},
		);
	});

	it("an ALIASED named import enters the population (#2294)", () => {
		// The call-shaped detector the original sweep shipped with MISSES this:
		// `import { getDirectoryMarkers as markers }` then `markers(...)` — the
		// call spells the alias, never the governed name, so a call-shaped match
		// reads clean. Import-scoped binding detection must still flag it.
		withFixtureTree(
			{
				"aliased.ts": [
					'import { getDirectoryMarkers as markers } from "./workspace-topology.js";',
					'const c = markers("/probe");',
				].join("\n"),
			},
			(dir) => {
				const consumers = scanTopologyConsumers(dir);
				expect(consumers.map((c) => c.file)).toEqual(["aliased.ts"]);
			},
		);
	});

	it("a MULTILINE named import enters the population", () => {
		withFixtureTree(
			{
				"multiline.ts": [
					"import {",
					"\tfindNearestDirWithAnyBasename,",
					'} from "./workspace-topology.js";',
					'const r = findNearestDirWithAnyBasename("/probe", ["x"]);',
				].join("\n"),
			},
			(dir) => {
				expect(scanTopologyConsumers(dir).map((c) => c.file)).toEqual([
					"multiline.ts",
				]);
			},
		);
	});

	it("a NAMESPACE import of a canonical module enters the population", () => {
		withFixtureTree(
			{
				"ns.ts": [
					'import * as topo from "./workspace-topology.js";',
					'const d = topo.getDirectoryMarkers("/probe");',
				].join("\n"),
			},
			(dir) => {
				expect(scanTopologyConsumers(dir).map((c) => c.file)).toEqual([
					"ns.ts",
				]);
			},
		);
	});

	it("a BARE import enters the population even when the binding is never called", () => {
		withFixtureTree(
			{
				"bare.ts":
					'import { findNearestProjectRoot } from "./startup-scan.js";',
			},
			(dir) => {
				expect(scanTopologyConsumers(dir).map((c) => c.file)).toEqual([
					"bare.ts",
				]);
			},
		);
	});

	it("an unrelated same-name LOCAL function does NOT enter the population (#2294)", () => {
		// The call-shaped detector FALSELY flagged this: a hand-rolled local
		// `function getDirectoryMarkers()` whose calls spell the seam name. It
		// imports nothing from the canonical modules, so it holds no topology
		// derived cache and must NOT be governed.
		withFixtureTree(
			{
				"local-only.ts": [
					"function getDirectoryMarkers(dir: string) { return dir; }",
					'const c = getDirectoryMarkers("/probe");',
				].join("\n"),
			},
			(dir) => {
				expect(scanTopologyConsumers(dir)).toEqual([]);
			},
		);
	});

	it("a same-name LOCAL function beside a REAL import still counts once", () => {
		withFixtureTree(
			{
				"mixed.ts": [
					'import { getDirectoryMarkers } from "./workspace-topology.js";',
					"function getDirectoryMarkers(dir: string) { return dir; }",
					'const c = getDirectoryMarkers("/probe");',
				].join("\n"),
			},
			(dir) => {
				// The module DID import the governed seam (line 1) — it is a
				// consumer regardless of the later redeclaration.
				expect(scanTopologyConsumers(dir).map((c) => c.file)).toEqual([
					"mixed.ts",
				]);
			},
		);
	});

	it("a comment or string that names a seam is NOT an import", () => {
		withFixtureTree(
			{
				"name-in-comment.ts": `// getDirectoryMarkers( is used below\nconst x = 1;`,
				"name-in-string.ts": `const s = "getDirectoryMarkers";`,
				"comment-import.ts": `// import { getDirectoryMarkers } from "../workspace-topology.js"\nconst y = 2;`,
			},
			(dir) => {
				expect(scanTopologyConsumers(dir)).toEqual([]);
			},
		);
	});

	it("a template-literal import-shaped decoy is NOT an import", () => {
		withFixtureTree(
			{
				"template-decoy.ts": [
					"const fixture = `",
					'import { getDirectoryMarkers } from "./workspace-topology.js";',
					"`;",
				].join("\n"),
			},
			(dir) => {
				expect(scanTopologyConsumers(dir)).toEqual([]);
			},
		);
	});

	it("a type-only or alias-mismatched import is NOT a runtime consumer", () => {
		withFixtureTree(
			{
				"type-only.ts":
					'import type { getDirectoryMarkers as markers } from "./workspace-topology.js";',
				"alias-mismatch.ts":
					'import { unrelated as getDirectoryMarkers } from "./workspace-topology.js";',
			},
			(dir) => {
				expect(scanTopologyConsumers(dir)).toEqual([]);
			},
		);
	});

	it("a same-basename non-canonical import is NOT a governed import", () => {
		withFixtureTree(
			{
				"vendor/workspace-topology.ts":
					"export const getDirectoryMarkers = () => [];",
				"vendor-consumer.ts":
					'import { getDirectoryMarkers } from "./vendor/workspace-topology.js";',
			},
			(dir) => {
				expect(scanTopologyConsumers(dir)).toEqual([]);
			},
		);
	});

	it("registered is DERIVED from a call, never from an import or comment", () => {
		withFixtureTree(
			{
				"registered.ts": [
					'import { registerWorkspaceTopologyReset } from "./workspace-topology.js";',
					"registerWorkspaceTopologyReset(() => cache.clear());",
				].join("\n"),
				"imports-register-only.ts":
					'import { registerWorkspaceTopologyReset } from "./workspace-topology.js";',
				"comment-names-register.ts": `// registerWorkspaceTopologyReset(() => cache.clear())\nconst y = 2;`,
			},
			(dir) => {
				const registered = registeredTopologyConsumers(dir);
				expect(registered.has("registered.ts")).toBe(true);
				expect(registered.has("imports-register-only.ts")).toBe(false);
				expect(registered.has("comment-names-register.ts")).toBe(false);
			},
		);
	});

	it("an unregistered consumer in the population reds the audit (#2294 mutation)", () => {
		withFixtureTree(
			{
				// The defect shape: memoizes from a seam, never registers.
				"rogue.ts": [
					'import { getDirectoryMarkers } from "./workspace-topology.js";',
					'import { registerWorkspaceTopologyReset } from "./workspace-topology.js";',
					`const cache = new Map<string, unknown>();`,
					`const key = getDirectoryMarkers("/probe").dir;`,
					"// rogues: cached result, no downstream reset registered",
				].join("\n"),
			},
			(dir) => {
				const consumers = scanTopologyConsumers(dir);
				const registered = registeredTopologyConsumers(dir);
				const exempt = {}; // deliberately empty — nothing is documented
				const audit = auditRegistry({
					sweepName: "fixture topology-audit",
					flagged: consumers.map((c) => c.file),
					registered,
					exemptions: exempt,
					minScanned: 1,
					minFlagged: 1,
				});
				// The rogue is neither registered nor exempted → red.
				expect(audit.unaccounted).toEqual(["rogue.ts"]);
				expect(audit.problems.length).toBeGreaterThan(0);
			},
		);
	});

	it("the empty-scan floor fires when the walk finds nothing (#2294 mutation)", () => {
		withFixtureTree({ "empty.ts": "const x = 1;" }, (dir) => {
			const consumers = scanTopologyConsumers(dir);
			expect(consumers).toEqual([]);
			const audit = auditRegistry({
				sweepName: "fixture topology empty",
				flagged: consumers.map((c) => c.file),
				registered: [],
				minScanned: 1,
				minFlagged: 1,
				scannedCount: 1,
			});
			// minFlagged=1 but the detector matched nothing → floor message.
			expect(
				audit.problems.filter((p) => p.includes("declared floor")),
			).toHaveLength(1);
		});
		expect(() => assertNonEmptyScan("fixture topology walk", 0, 1)).toThrow(
			/floor of 1/,
		);
	});
});

// The registered-or-fail sweep over real `clients/` — the guard itself.
describe("workspace-topology sweep — registered-or-fail coverage", () => {
	it("commits the exemption contract for consumers that do not register", () => {
		// A freshness-key exemption names a module that uses a probe seam but
		// needs no topology-registry reset: its derived state either (a) is
		// stateless / per-call (recomputed through the seam, whose own caches
		// `resetWorkspaceTopology` already clears), or (b) is invalidated by the
		// module's own registered reset or by its own mtime/size/file-key.
		const EXEMPT = {
			"dispatch/runners/tflint.ts":
				"per-run `.tflint.hcl` discovery through findNearestDirWithAnyBasename — the result feeds one arg set and holds no module-level memo; the walk itself is cached inside workspace-topology's own walkCache, which resetWorkspaceTopology clears.",
			"dispatch/runners/helm-lint.ts":
				"per-edit Chart.yaml discovery through findNearestDirWithMarker — resolved to a chartRoot used once, no downstream memo; the walked index clears with resetWorkspaceTopology.",
			"dispatch/runners/helm-render.ts":
				"per-edit Chart.yaml discovery through findNearestDirWithMarker — same stateless-per-call shape as helm-lint; only an in-flight dedupe map rides chartRoot and it is cleared in finally.",
			"runtime-session.ts":
				"the session-start handler itself calls findNearestProjectRoot once to derive the session cwd and separately invokes resetWorkspaceTopology() in the same reset block — its use is transient and it is precisely the orchestrator of the reset, so there is no topology-derived memo for the registry to clear.",
			"review-graph/workspace-modules.ts":
				"detectWorkspaceType reads getWorkspaceManifestMarkers but its module-graph cache is keyed by cwd and cleared by clearModuleGraphCache, registered in the session-state registry and reached at session start via resetDispatchBaselines — it re-arms at the session boundary through its own registered reset, not through the topology registry.",
			"project-lens-config.ts":
				"findPiLensConfigMarkerInDir feeds config discovery state keyed by config path + mtimeMs + size with per-directory-mtime validation — a freshness-key invalidation that does not depend on the topology index reset.",
			"test-runner-client.ts":
				"#2870: findNearestDirWithAnyBasename answers one hoisted-node_modules probe per detectRunner call and the result is used immediately, never memoized — the walk's own cache lives in workspace-topology and clears with resetWorkspaceTopology. The client's memos are not topology-derived and are self-invalidating besides: availableRunners keys on the resolved root and re-stats a positive verdict's evidence file on every read (a miss is never memoized, #2252), and the language-root walk it keys on comes from language-profile.ts, which registers its own reset.",
		};

		const consumers = scanTopologyConsumers();
		const registered = registeredTopologyConsumers();

		// Two emptiness guards, distinct causes (sweep-kit F4 discipline and
		// the meta-sweep's floor requirement).
		const scanned = clientSourceFiles();
		expect(scanned.length).toBeGreaterThanOrEqual(200); // the WALK is alive
		expect(consumers.length).toBeGreaterThanOrEqual(5); // the DETECTOR is alive

		const audit = auditRegistry({
			sweepName: "workspace-topology sweep",
			scannedCount: scanned.length,
			// The walk sees roughly 400 files; floor at half so a moved
			// clients/ root or a broken extension filter is not read as clean.
			minScanned: 200,
			// Calibration: 9 consumer modules detected on 2026-08-28 (3
			// registered, 6 exempted). Half of 9 rounded up is 5, the documented
			// floor — a reconnect that drops the detector below half the live
			// population reds here.
			minFlagged: 5,
			flagged: consumers.map((c) => c.file),
			// Derived, never copied: a module is registered only when its own
			// source calls registerWorkspaceTopologyReset(
			registered,
			exemptions: EXEMPT,
			minReasonLength: 16,
			remediation:
				"Decide which it is. If the module memoizes a topology-derived result, " +
				"call registerWorkspaceTopologyReset(() => <clear that memo>) at module load. " +
				"If the derived state is stateless, per-call, or self-invalidating " +
				"(own retained reset or a file/path+mtime/size freshness key), name it in " +
				"the exemption map above with that reason.",
		});
		expect(audit.problems, audit.problems.join("\n\n")).toEqual([]);
		expect(audit.staleExemptions, audit.staleExemptions.join("\n")).toEqual([]);
		expect(
			audit.reasonlessExemptions,
			audit.reasonlessExemptions.join("\n"),
		).toEqual([]);
	});
});

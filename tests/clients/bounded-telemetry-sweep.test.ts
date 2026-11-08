/**
 * Registered-or-fail sweep for bounded telemetry (#1743).
 *
 * The rule this makes structural: a record written on a FAILURE path either
 * routes through `emitBounded`/`admitBounded`, or it names the reason its
 * volume is already bounded. Prose could not enforce that — four PRs in two
 * days each rebuilt the bounding by hand, and each needed a review round to
 * get it right.
 *
 * Shape follows the #1692 lessons the finding-delivery-gate sweep paid for:
 *
 * - **Call-shaped evidence.** Findings come from balanced-paren CALL sites, so
 *   a failure names a file, a line, and a callee a reader can go open.
 * - **One seam per tag.** A phase belongs to the registry or to the reasons
 *   map, never both, and the sweep asserts the exclusivity in both directions.
 * - **No stale claims.** Every reasons-map key and every registry entry must
 *   still correspond to a live call site, so a deleted or migrated phase turns
 *   the declaration red instead of leaving a lie behind.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BOUNDED_TELEMETRY_PHASES } from "../../clients/bounded-telemetry.js";
import {
	type EmissionSite,
	isFailureShapedPhase,
	SCAN_ROOTS,
	scanEmissionSites,
	scanSource,
	UNBOUNDED_FAILURE_PHASE_REASONS,
} from "../support/bounded-telemetry-scan.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const SITES = scanEmissionSites(REPO_ROOT);
const RAW_SITES = SITES.filter((site) => site.callee === "logLatency");
const HELPER_SITES = SITES.filter((site) => site.callee !== "logLatency");

/** `file:line` for every finding, so a failure message is actionable. */
function evidence(sites: EmissionSite[]): string[] {
	return sites.map((site) => `${site.file}:${site.line} (${site.callee})`);
}

describe("bounded-telemetry sweep (#1743)", () => {
	it(
		"scans a non-trivial population, so a broken scanner cannot pass vacuously",
		() => {
			// A regex typo that matched nothing would make every assertion below
			// trivially true. Pin the floor instead of the exact count, which churns.
			expect(RAW_SITES.length).toBeGreaterThan(100);
			expect(HELPER_SITES.length).toBeGreaterThanOrEqual(6);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every failure-path record is either helper-emitted or has a stated reason",
		() => {
			const unaccounted = RAW_SITES.filter(
				(site) =>
					site.phase !== undefined &&
					isFailureShapedPhase(site.phase) &&
					!(site.phase in UNBOUNDED_FAILURE_PHASE_REASONS),
			);
			expect(
				evidence(unaccounted),
				[
					"A failure-path `logLatency` is unaccounted for.",
					"Either route it through `emitBounded` (clients/bounded-telemetry.ts)",
					"and add its phase to BOUNDED_TELEMETRY_PHASES, or add the phase to",
					"UNBOUNDED_FAILURE_PHASE_REASONS with the MECHANISM that already",
					"bounds its volume.",
				].join(" "),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("every stated reason is non-empty and names a mechanism", () => {
		for (const [phase, reason] of Object.entries(
			UNBOUNDED_FAILURE_PHASE_REASONS,
		)) {
			expect(
				reason.trim().length,
				`${phase} has an empty reason`,
			).toBeGreaterThan(20);
		}
	});

	it(
		"a registered phase is never also written by a raw logLatency",
		() => {
			const registered = new Set<string>(BOUNDED_TELEMETRY_PHASES);
			const leaked = RAW_SITES.filter(
				(site) => site.phase !== undefined && registered.has(site.phase),
			);
			expect(
				evidence(leaked),
				"A phase in BOUNDED_TELEMETRY_PHASES is still written by a raw logLatency. One seam per phase: route it through emitBounded.",
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every registered phase has a live helper call site",
		() => {
			const emitted = new Set(
				HELPER_SITES.map((site) => site.phase).filter(
					(phase): phase is string => phase !== undefined,
				),
			);
			const dead = BOUNDED_TELEMETRY_PHASES.filter(
				(phase) => !emitted.has(phase),
			);
			expect(
				dead,
				"A registry entry has no emitBounded/admitBounded call site. Remove it, or the registry stops describing the code.",
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every stated reason still has a live raw call site",
		() => {
			const rawPhases = new Set(
				RAW_SITES.map((site) => site.phase).filter(
					(phase): phase is string => phase !== undefined,
				),
			);
			const stale = Object.keys(UNBOUNDED_FAILURE_PHASE_REASONS).filter(
				(phase) => !rawPhases.has(phase),
			);
			expect(
				stale,
				"A phase with a stated reason no longer has a raw logLatency site. It was migrated or deleted — drop the entry.",
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("every stated reason is for a phase the predicate can actually see", () => {
		// Couples the two halves. Narrowing the predicate would otherwise leave
		// the reasons map full of entries the sweep no longer governs, and the
		// narrowing itself would pass unnoticed.
		const invisible = Object.keys(UNBOUNDED_FAILURE_PHASE_REASONS).filter(
			(phase) => !isFailureShapedPhase(phase),
		);
		expect(
			invisible,
			"A phase has a stated reason but the failure-shape predicate no longer matches it. Either the predicate was narrowed, or the entry does not belong.",
		).toEqual([]);
	});

	it("the registry and the reasons map are disjoint", () => {
		const both = BOUNDED_TELEMETRY_PHASES.filter(
			(phase) => phase in UNBOUNDED_FAILURE_PHASE_REASONS,
		);
		expect(both, "A phase claims both seams; pick one.").toEqual([]);
	});
});

describe("bounded-telemetry scanner self-test", () => {
	const fixture = [
		'logLatency({ type: "phase", phase: "probe_alpha_timeout", durationMs: 1 });',
		'emitBounded("loop_block", identity, { durationMs: 2 });',
		'admitBounded("loop_block", identity, { capPerTurn: { limit: 1, turnIndex: 0 } });',
		'myLogLatency({ phase: "probe_not_a_call_timeout" });',
		"logLatency(buildEntry(kind, { nested: fn(1) }));",
	].join("\n");
	const found = scanSource(fixture, "fixture.ts");

	it("reads the phase out of each call's own arguments, with its line", () => {
		expect(found.map((site) => [site.line, site.callee, site.phase])).toEqual([
			[1, "logLatency", "probe_alpha_timeout"],
			[2, "emitBounded", "loop_block"],
			[3, "admitBounded", "loop_block"],
			[5, "logLatency", undefined],
		]);
	});

	it("does not read a call that exists only in a comment", () => {
		// MUTATION PROOF for the sweep-kit stripSource adoption (#1755): remove
		// the strip and both of these become findings. A phase discussed in
		// prose is not a phase emitted in code, in either direction — a
		// commented example must not red the sweep, and a commented registered
		// phase must not red the exclusivity check.
		const laundered = scanSource(
			[
				'// logLatency({ phase: "probe_comment_timeout" });',
				'/* logLatency({ phase: "probe_block_comment_failed" }); */',
				'logLatency({ type: "phase", phase: "probe_real_timeout" });',
			].join("\n"),
			"laundered.ts",
		);
		expect(laundered.map((site) => site.phase)).toEqual(["probe_real_timeout"]);
	});

	it("does not match an identifier that merely ends in the callee name", () => {
		expect(found.some((site) => site.line === 4)).toBe(false);
	});

	it(
		"scans every root that emits records, including tools/",
		() => {
			// MUTATION PROOF for the SCAN_ROOTS addition (#1743 review F2): drop
			// "tools" and this reds. `tools/*.ts` call `logLatency` directly, so a
			// failure record added there would otherwise never be swept.
			expect(SCAN_ROOTS).toContain("tools");
			expect(SITES.some((site) => site.file.startsWith("tools/"))).toBe(true);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("classifies failure-shaped phase names by outcome suffix, not by topic", () => {
		expect(isFailureShapedPhase("lsp_pull_diagnostic_timeout")).toBe(true);
		expect(isFailureShapedPhase("project_snapshot_persist_failed")).toBe(true);
		expect(isFailureShapedPhase("review_graph_size_skip")).toBe(true);
		// Throughput phases: real work, bounded by the work itself.
		expect(isFailureShapedPhase("dispatch_complete")).toBe(false);
		expect(isFailureShapedPhase("graph_build")).toBe(false);
		expect(isFailureShapedPhase("memory_sample")).toBe(false);
		// A suffix must END the name, or `timeout_budget_configured` would match.
		expect(isFailureShapedPhase("lsp_timeout_budget_resolved")).toBe(false);
	});

	it("catches the outcome-suffix names the first pass missed (#1743 review F1)", () => {
		// MUTATION PROOF: remove any of these suffixes from OUTCOME_SUFFIX and
		// the matching line reds. Each names a real record found by the review.
		expect(isFailureShapedPhase("lsp_notify_backpressure_broken")).toBe(true);
		expect(isFailureShapedPhase("helm_render_scratch_leak")).toBe(true);
		expect(isFailureShapedPhase("lsp_server_unexpected_exit")).toBe(true);
		expect(isFailureShapedPhase("path_attribution_missing")).toBe(true);
		expect(isFailureShapedPhase("lsp_sync_abandoned")).toBe(true);
	});

	it("catches an outcome named mid-phase with its reason trailing", () => {
		// MUTATION PROOF for OUTCOME_INFIX: delete it and both of these red.
		// `lsp_client_skipped_unavailable_command` ends in `_command`, so no
		// suffix-anchored rule can see it — that is how two real unbounded
		// per-file records hid from the first pass.
		expect(isFailureShapedPhase("lsp_client_skipped_unavailable_command")).toBe(
			true,
		);
		expect(isFailureShapedPhase("lsp_sweep_group_skipped_warmup")).toBe(true);
		// The infix rule stays narrow: an outcome word appearing anywhere would
		// sweep throughput phases whose SUBJECT is a failure concept.
		expect(isFailureShapedPhase("lsp_timeout_budget_resolved")).toBe(false);
		expect(isFailureShapedPhase("breaker_state_report")).toBe(false);
	});
});

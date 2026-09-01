/**
 * The #1754 ratchet: no NEW hand-rolled generation guard.
 *
 * ## What this can and cannot see
 *
 * Detecting a MISSING guard statically is not possible here. "This write
 * follows an await and the store it writes carries a generation" needs
 * type-level knowledge of every store, and the four historical sites wrote
 * through four different shapes (a module Map, a closure-captured cache, a
 * per-key Map on a state object, a sweep-local Set). Any regex claiming to
 * find those is a regex that lies.
 *
 * So the sweep is built the other way round, per #1741's charter direction:
 *
 * 1. **Declaration by construction.** A store that guards through the
 *    primitive appears in `listDeclaredGenerationSources()` because
 *    `createGenerationSource`/`createGenerationMap` register it. There is no
 *    way to use the primitive without declaring.
 * 2. **A closed list of the hand-rolled remainder.** The scanner below finds
 *    the syntactic signature every hand-rolled version shares — a `===`/`!==`
 *    against an identifier named for a generation, epoch, or sequence — and
 *    requires every file it flags to carry an explicit reason here. A new
 *    hand-rolled guard is therefore red until someone writes down why it is
 *    not using the primitive.
 * 3. **A reverse lock.** A file listed here that the scanner NO LONGER flags
 *    is also red, so a migration must delete its own entry and the list can
 *    only shrink.
 *
 * Known blind spots, stated rather than papered over:
 *
 * - Naming. A generation spelled `stamp`, `token`, `revision`, or `version` is
 *   invisible to the scanner. Declaration (1) is what actually covers new
 *   code; this list covers the code that predates the primitive.
 * - Cross-module generations passed as bare `number` parameters are seen only
 *   where the comparison itself lives.
 * - It flags guards that EXIST. A post-await write with no guard at all — the
 *   #1674 and #1669-N4 defect — is invisible to it, and is caught by the
 *   sites' own regression tests instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { listDeclaredGenerationSources } from "../../clients/generation-guard.js";
import { repoRoot } from "../support/session-state-scan.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

/**
 * Every `clients/` file that still compares a generation/epoch/sequence by
 * hand instead of going through `clients/generation-guard.ts`, with the reason
 * it has not migrated.
 *
 * Adding a file here is a deliberate act with a written justification.
 * Removing one is what a migration does. Both directions are enforced below.
 */
const HAND_ROLLED_GENERATION_GUARDS: Readonly<Record<string, string>> = {
	// --- Migration backlog: these ARE the capture-before-await/check-before-
	// write shape the primitive models. Each is a real candidate, deferred for
	// a stated reason, not exempted on principle. ---
	"lsp/client.ts":
		"#1682's per-(path, identifier) pull sequences: claimed at request time, re-checked at write time. A GenerationMap candidate, deferred because client.ts is the highest-traffic file in the repo and a behavior-identical proof there needs its own round",
	"review-graph/builder.ts":
		"the workspace-cache epoch this primitive was modelled on, plus checkpoint and persist generations that gate post-await promotions (see the `_persistGenerations.get(key) !== result.generation` guard). A GenerationMap candidate; migrating a file this size is real work, not a rider on #1754's proof-of-two",
	"project-snapshot.ts":
		"per-key snapshot generations gating a post-await stage promotion and the exit-hook drain — a superseded save must not promote over a fresher body. Same GenerationMap shape as review-graph/builder.ts, deferred with it",
	"runtime-turn.ts":
		"the turn_end test-runner path captures testRunGeneration before awaiting the runners and re-reads the persisted generation before writing failures, so this IS the guarded-write shape. Deferred because the generation lives in a persisted cache entry rather than an in-process counter, which the primitive does not model yet",
	"runtime-coordinator.ts":
		"clearStartupScanInFlight guards a DELETE on the in-flight map with the generation that owns the entry — the eviction direction, the same guard #1674's F5 round added by hand. A GenerationSource candidate, deferred so #1754 lands with two migrations rather than five",
	"test-runner-delivery.ts":
		"the persisted test-runner-findings cache owns the generation high-water mark across asynchronous runner completion and session restarts. The delivery map compares that durable generation before appending, so an in-process GenerationSource cannot replace the persisted ordering contract; the provenance and generation integration tests cover the drop-before-append path",
	"mcp/analyze.ts":
		"the warm word-index idle eviction captures a per-entry generation before its timer fires and re-checks it in the callback, alongside an entry-identity compare. The eviction direction again, on a per-entry counter rather than a keyed map; a migration candidate once GenerationMap gains an entry-scoped form",

	// --- Not the shape: a generation is compared, but no post-await write
	// hangs on the answer. ---
	"dispatch/runners/utils/runner-helpers.ts":
		"#1754 migrated this file's guarded WRITES (the managed-verify verdict memo, both in-flight evictions). What is left is ensureCurrentGeneration and the ast-grep latch, which clear a cache on a staleness transition rather than guard a write — a different shape the primitive deliberately does not model",
	"dispatch/runners/utils/availability-policy.ts":
		"syncInstallGeneration folds in any resetInstallRetryLatches() since the last touch by clearing the attempt count and cooldown on a mismatch. Clear-on-transition, the same shape as runner-helpers' ensureCurrentGeneration, not a guarded write",
	"tree-sitter-client.ts":
		"the trust-notification set is cleared on a trust-generation transition before the set is consulted (lazy clear-on-transition, #1363). Clear-on-transition again: the generation decides whether to reset state, not whether a pending write may land",
	"dispatch/integration.ts":
		"reverse-dependency reuse eligibility compares a PERSISTED graph build generation read off disk against a cached index's, to decide whether a one-step import delta is contiguous. A read-side eligibility test, and the primitive has no persisted form — see workspace-diagnostics-cache.ts's #1669 review R2 note on why an inert persisted generation was reverted there",
	"review-graph-logger.ts":
		"copies a persisted graph build generation into log metadata. Nothing is guarded; the value is a field in a record",
	"lsp/index.ts":
		"the generation handoff compares PROMISE IDENTITY to decide whether the slot it is clearing is still its own. That is the eviction direction, but keyed on object identity rather than a counter, which is what the primitive models; a counter would add state where an identity compare already answers exactly",

	// --- Permanent: migrating would be circular. ---
	"single-flight.ts":
		"the #1753 singleFlight primitive OWNS its generation compare. It is GenerationGuard's sibling, not its caller: routing singleFlight's own share-branch check through GenerationGuard would make two primitives depend on each other for the property each exists to provide. Permanent, not backlog. Listed at FILE level so it survives #1762's restructuring of that comparison",
};

// The identifier must END at the generation-named word. Letting the match run
// on through `?.`/`.` accessors made `beforeFirstSequence?.truncated ===` look
// like a generation compare — noise that would have made this list unusable.
// A generation-named identifier on the LEFT of the comparison.
const GENERATION_LHS =
	/[\w$]*(?:generation|epoch|sequence)[\w$]*\s*(?:===|!==)/i;
// ...or on the RIGHT, where the left side is often a `map.get(key) ?? 0`.
const GENERATION_RHS =
	/(?:===|!==)\s*(?:[\w$]+[?.]+)*[\w$]*(?:generation|epoch|sequence)[\w$]*\s*(?:[;)&|,]|$)/im;

function comparesGenerationByHand(source: string): boolean {
	return GENERATION_LHS.test(source) || GENERATION_RHS.test(source);
}

const CLIENTS_ROOT = path.join(repoRoot, "clients");

/**
 * `clients/`-relative paths that compare a generation by hand, and how many
 * files were looked at to find them.
 *
 * Built on `tests/support/sweep-kit.ts` (#1755) rather than re-implementing
 * the walk, the stripper and the registry semantics — this repo has paid for
 * those four times. `strings: "blank"` is the right policy here: several of
 * these files carry doc comments and log strings that NAME the pattern, and
 * matching those would make the exemption list unmaintainable noise.
 */
/**
 * Exemptions split by whether the file is in THIS tree.
 *
 * The kit's stale-exemption rule is right for a settled tree: an exemption
 * that excuses no live hit is a screen that stopped screening (#1735). It
 * cannot know that `clients/single-flight.ts` arrives with #1762. So the audit
 * sees only exemptions whose file exists, and the absent ones are checked
 * separately — they must name the issue that brings the file, and they resume
 * normal stale-detection the moment it lands.
 */
function partitionExemptions(): {
	present: Record<string, string>;
	absent: string[];
} {
	const present: Record<string, string> = {};
	const absent: string[] = [];
	for (const [file, reason] of Object.entries(HAND_ROLLED_GENERATION_GUARDS)) {
		if (fs.existsSync(path.join(CLIENTS_ROOT, file))) present[file] = reason;
		else absent.push(file);
	}
	return { present, absent };
}

function scanHandRolledGuards(): { flagged: string[]; scanned: number } {
	const files = listSourceFiles(CLIENTS_ROOT, { skipTests: true });
	const flagged: string[] = [];
	for (const file of files) {
		const relative = relativePosix(CLIENTS_ROOT, file);
		if (relative === "generation-guard.ts") continue;
		const source = stripSource(fs.readFileSync(file, "utf8"), {
			strings: "blank",
		});
		if (comparesGenerationByHand(source)) flagged.push(relative);
	}
	return { flagged: flagged.sort(), scanned: files.length };
}

describe("generation-guard ratchet (#1754)", () => {
	const { flagged, scanned } = scanHandRolledGuards();

	it("actually walked clients/ and matched something", () => {
		// Defect shape 10, #1718: a sweep that scanned nothing, or matched
		// nothing, must FAIL rather than read as clean. Two separate floors,
		// because "walked 0 files" and "walked 400 and matched 0" are different
		// bugs with different fixes.
		assertNonEmptyScan("generation-guard sweep: files walked", scanned, 200);
		assertNonEmptyScan(
			"generation-guard sweep: files flagged",
			flagged.length,
			8,
		);
	});

	it("every hand-rolled generation guard is accounted for", () => {
		const audit = auditRegistry({
			sweepName: "generation-guard ratchet (#1754)",
			flagged,
			// Nothing is "registered" here: a file either guards through the
			// primitive, in which case the scan does not flag it, or it carries
			// an exemption reason. There is no third state to declare.
			registered: [],
			exemptions: partitionExemptions().present,
			minReasonLength: 60,
			minFlagged: 8,
			scannedCount: scanned,
			minScanned: 200,
			remediation:
				"Use clients/generation-guard.ts (createGenerationSource / " +
				"createGenerationMap), or add the file to " +
				"HAND_ROLLED_GENERATION_GUARDS with the reason it cannot.",
		});
		// `auditRegistry` reports unaccounted files, reasonless exemptions AND
		// stale ones in a single pass, so the reverse lock comes from the kit
		// rather than from a second hand-written check.
		expect(audit.problems.join("\n")).toBe("");
	});

	it("does not treat a file absent from the tree as a stale exemption", () => {
		// clients/single-flight.ts arrives with #1762. Its exemption is written
		// now, deliberately, and must not red the sweep before that branch
		// lands. This is the one place the kit's stale-entry rule is relaxed,
		// and it is relaxed only for files that do not exist.
		const { absent } = partitionExemptions();
		for (const file of absent) {
			expect(
				HAND_ROLLED_GENERATION_GUARDS[file],
				`${file}: an exemption for a file not in the tree must say which branch brings it`,
			).toMatch(/#\d{3,}/);
		}
	});
});

describe("generation-guard declaration registry (#1741 charter direction)", () => {
	it("all migrated guarded-write sources declare themselves", async () => {
		await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		await import("../../clients/lsp/workspace-diagnostics-cache.js");
		await import("../../clients/package-manager.js");
		expect(listDeclaredGenerationSources()).toEqual(
			expect.arrayContaining([
				"dispatch-availability",
				"package-manager-global-bin",
				"workspace-diagnostics-cache",
			]),
		);
	});

	it("a migrated file drops out of the hand-rolled list", () => {
		// The reverse lock in action: workspace-diagnostics-cache.ts was flagged
		// before #1754 and must not be flagged after.
		expect(scanHandRolledGuards()).not.toContain(
			"lsp/workspace-diagnostics-cache.ts",
		);
	});
});

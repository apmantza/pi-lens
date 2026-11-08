/**
 * classifiedBy sweep for `logAvailabilityDecision` call sites (#2131, #2209).
 *
 * Dogfood pass 5 measured the #2131 gap: over 8.76h of baseline, 33 of 75
 * `cause: "ok"` decisions (44%) carried no `classifiedBy`, while `not-found`
 * (51/51) and `fast-path` (23/23) carried it 100%. Seven call sites set
 * `cause: "ok"` next to a sibling failure arm that stamps `classifiedBy` and
 * simply omitted it on the success arm — a mechanical, structural gap, not a
 * one-off typo, so a mechanical sweep is the fix that cannot regress silently.
 *
 * #2209 found the same gap on the OTHER side: three named failure arms
 * (and, once the class was swept for every call site rather than just the
 * three, ten more besides) omitted `classifiedBy` too. The gap is symmetric,
 * so the sweep below checks EVERY call, not just `cause: "ok"` ones.
 *
 * This scans every `logAvailabilityDecision` call under `clients/` and reds
 * if ANY call omits `classifiedBy` — the class both issues' verification
 * notes close.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	type AvailabilityDecisionSite,
	scanAvailabilityDecisionSites,
	scanSource,
} from "../support/availability-classifiedby-scan.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const SITES = scanAvailabilityDecisionSites(REPO_ROOT);
const OK_SITES = SITES.filter((site) => site.causeOk);

/** `file:line` for every finding, so a failure message is actionable. */
function evidence(sites: AvailabilityDecisionSite[]): string[] {
	return sites.map((site) => `${site.file}:${site.line}`);
}

describe("availability_decision classifiedBy sweep (#2131)", () => {
	it(
		"scans a non-trivial population, so a broken scanner cannot pass vacuously",
		() => {
			// A regex typo that matched nothing would make the assertion below
			// trivially true. Pin a floor, not the exact count, which churns.
			expect(SITES.length).toBeGreaterThan(20);
			// #2140/#2351: resolveAndLaunch's managed-bin fast path and force-reinstall
			// recovery add three cause:"ok" sites, all stamped classifiedBy below.
			// #5345: 21 -> 20 — the deleted module-level ast-grep sweep held one
			// stamped `cause: "ok"` site; the population and the floor above stay
			// non-trivial.
			// #5410: 20 -> 19 — the dispatcher's own `hasTool` probe now
			// delegates to the checker, whose `cause: "ok"` site already counts.
			expect(OK_SITES.length).toBe(19);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		'every cause:"ok" decision stamps classifiedBy',
		() => {
			const unstamped = OK_SITES.filter((site) => !site.hasClassifiedBy);
			expect(
				evidence(unstamped),
				[
					'A cause:"ok" availability_decision emit is missing classifiedBy.',
					"Every arm reaching this cause is either a direct probe success",
					'(classifiedBy: "probe") or an install/join-repaired verdict the caller',
					'asserted (classifiedBy: "caller"/"joined") — read the sibling failure',
					"arm in the same function for which one applies.",
				].join(" "),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every logAvailabilityDecision call stamps classifiedBy (#2209)",
		() => {
			const unstamped = SITES.filter((site) => !site.hasClassifiedBy);
			expect(
				evidence(unstamped),
				[
					"An availability_decision emit is missing classifiedBy.",
					'Stamp classifiedBy: "probe" when classifyProbeFailure derived the',
					'outcome/cause, or "caller" when the call site asserts it directly —',
					"see availability-policy.ts's AvailabilityDecision.classifiedBy doc.",
				].join(" "),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});

describe("availability-classifiedby scanner self-test", () => {
	const fixture = [
		'logAvailabilityDecision({ tool: "x", verdict: "available", outcome: "success", cause: "ok", elapsedMs: 1, latched: true });',
		'logAvailabilityDecision({ tool: "x", verdict: "available", outcome: "success", cause: "ok", elapsedMs: 1, latched: true, classifiedBy: "probe" });',
		'logAvailabilityDecision({ tool: "x", verdict: "unavailable", outcome: "missing", cause: "not-found", elapsedMs: 1, latched: true, classifiedBy: "probe" });',
		'logAvailabilityDecision({ tool: "x", verdict: "available", outcome: "success", cause: provisional ? "timeout" : "ok", classifiedBy: "probe" });',
		'logAvailabilityDecision({ tool: "x", verdict: "available", outcome: "success", cause: "fast-path", evidence: { classifiedBy: "wrong" } });',
		'logAvailabilityDecision({ tool: "x", verdict: "available", outcome: "success", cause: "ok", note: "unmatched ( quote" });',
		'// logAvailabilityDecision({ cause: "ok" });',
		'fakeLogAvailabilityDecision({ cause: "ok" });',
		"function logAvailabilityDecision(decision) {",
		'logAvailabilityDecision({ ...base, verdict: "available", outcome: "success", cause: "ok", classifiedBy: "probe" });',
		"logAvailabilityDecision(decisionVar);",
	].join("\n");
	const found = scanSource(fixture, "fixture.ts");

	it("reads cause and classifiedBy out of each call's own arguments", () => {
		expect(
			found.map((site) => [site.line, site.causeOk, site.hasClassifiedBy]),
		).toEqual([
			[1, true, false],
			[2, true, true],
			[3, false, true],
			[4, true, true],
			[5, false, false],
			[6, true, false],
			// Line 9 (the declaration) is deliberately absent here.
			[10, true, true],
			[11, false, false],
		]);
	});

	it("does not read a call that exists only in a comment", () => {
		expect(found.some((site) => site.line === 7)).toBe(false);
	});

	it("does not match an identifier that merely ends in the callee name", () => {
		expect(found.some((site) => site.line === 8)).toBe(false);
	});

	it("excludes the function's own declaration (#2226 review F3)", () => {
		expect(found.some((site) => site.line === 9)).toBe(false);
	});

	it("finds a call whose fields arrive via a spread (#2226 review F3)", () => {
		const site = found.find((s) => s.line === 10);
		expect(site).toMatchObject({ causeOk: true, hasClassifiedBy: true });
	});

	it("finds a call that passes the whole decision as a variable (#2226 review F3)", () => {
		const site = found.find((s) => s.line === 11);
		expect(site).toMatchObject({ causeOk: false, hasClassifiedBy: false });
	});

	it("keeps the arg boundary quote-aware when a string carries a bare `)` (#3145 review round 2)", () => {
		// Regression pin for the #3145 review finding: the `quoteAware` option
		// on `matchingCloseIndex` looked dead by mutation (neutering it reds no
		// existing test) until the reviewer probed a `note`-style string
		// containing an unbalanced `)`. Without quote-awareness, that `)` reads
		// as the call's OWN closing paren, truncating the argument text BEFORE
		// `classifiedBy` — misreading a stamped call as unstamped.
		const [site] = scanSource(
			'logAvailabilityDecision({ tool: "x", verdict: "available", outcome: "success", cause: "ok", note: "manifest missing key)", classifiedBy: "probe" });',
			"fixture.ts",
		);
		expect(site).toMatchObject({ causeOk: true, hasClassifiedBy: true });
	});
});

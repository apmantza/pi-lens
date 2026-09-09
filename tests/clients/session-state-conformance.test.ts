/**
 * Session-state lifecycle conformance and sweep — #1635 item 2.
 *
 * Three claims, checked three different ways:
 *
 * 1. **Re-arm.** Where a probe exists, arm the state and prove the registered
 *    reset disarms it. This is the only check that touches real state.
 * 2. **Wiring.** Every `session_start` entry's reset must be reachable from
 *    `handleSessionStart` — derived from the source, not from a list anyone
 *    maintains. A reset that exists but is never called is the exact shape of
 *    #1266, #1490, #1497, #1535, #1537 and #1625.
 * 3. **Coverage.** Every file the sweep flags as session-state-shaped is
 *    registered or exempted with a reason.
 *
 * Claim 3 runs on `tests/support/sweep-kit.ts` (#1755) — the shared
 * registered-or-fail machinery, so this sweep and the six others stop
 * re-deriving the same semantics. The stripper behind claims 1 and 2 comes
 * from the same kit.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EXEMPT_SESSION_STATE_FILES,
	SESSION_STATE_REGISTRY,
	SESSION_STATE_SYMBOL_COUNTS,
	_resetRegistryProbeState,
} from "../support/session-state-registry.js";
import {
	SWEEP_HEURISTIC_LIMITS,
	auditContainerClassExclusions,
	callsWithinFunction,
	callsWithinSessionStartClosure,
	clientSourceFiles,
	resetNameDefinitions,
	scanSessionStateCandidates,
	sessionStartClosureResetNames,
	sessionStartResetNames,
	stripCommentsAndStrings,
} from "../support/session-state-scan.js";
import {
	assertSortedRegistry,
	auditRegistry,
	auditSymbolCounts,
} from "../support/sweep-kit.js";

afterEach(() => _resetRegistryProbeState());

describe("session-state registry — shape", () => {
	it("keeps session admission registries sorted", () => {
		// #2671 recurrence: an unsorted admission is a merge-conflict magnet.
		expect(() => assertSortedRegistry("fixture", ["b", "a"])).toThrow(
			"entries must be sorted",
		);
		assertSortedRegistry(
			"SESSION_STATE_REGISTRY",
			SESSION_STATE_REGISTRY.map((entry) => entry.id),
		);
		assertSortedRegistry(
			"EXEMPT_SESSION_STATE_FILES",
			Object.keys(EXEMPT_SESSION_STATE_FILES),
		);
		assertSortedRegistry(
			"SESSION_STATE_SYMBOL_COUNTS",
			Object.keys(SESSION_STATE_SYMBOL_COUNTS),
		);
	});
	it("every entry is uniquely identified", () => {
		const ids = SESSION_STATE_REGISTRY.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("every entry states a reason", () => {
		for (const entry of SESSION_STATE_REGISTRY) {
			expect(
				entry.reason.length,
				`${entry.id} needs a real reason`,
			).toBeGreaterThan(30);
		}
	});

	it("every registered reset name resolves to exactly one clients/ module", () => {
		const definitions = resetNameDefinitions();
		for (const entry of SESSION_STATE_REGISTRY) {
			const files = definitions.get(entry.resetName);
			expect(
				files,
				`${entry.id}: no exported ${entry.resetName}`,
			).toBeDefined();
			// A duplicated reset name would make the reachability walk below
			// ambiguous — it resolves by name, so two definitions is a real hazard.
			expect(
				files,
				`${entry.id}: ${entry.resetName} is defined twice`,
			).toHaveLength(1);
		}
	});
});

describe("session-state registry — re-arm conformance", () => {
	const probed = SESSION_STATE_REGISTRY.filter((e) => e.probe);

	it("exercises a probe for the core session latches", () => {
		// Not every entry can be probed without spawning a real tool. This pins a
		// floor so the probe set cannot quietly drain to zero while the registry
		// grows.
		expect(probed.length).toBeGreaterThanOrEqual(5);
	});

	for (const entry of SESSION_STATE_REGISTRY) {
		if (!entry.probe) continue;
		it(`${entry.id} re-arms when ${entry.resetName} runs`, () => {
			const probe = entry.probe as NonNullable<typeof entry.probe>;
			probe.reset();
			expect(probe.isArmed(), `${entry.id} should start armed`).toBe(true);
			probe.arm();
			expect(probe.isArmed(), `${entry.id} arm() did not dirty the state`).toBe(
				false,
			);
			probe.reset();
			expect(probe.isArmed(), `${entry.id} did not re-arm`).toBe(true);
		});
	}
});

// The reachability walk's own correctness, pinned against synthetic source so
// a regression here cannot hide behind whatever happens to be in clients/
// today. Review round R1 (S1) got a fabricated bug past the whole suite by
// swapping a real reset call for a COMMENT naming it: the walk regexed raw
// source, so 37/37 stayed green while the reset was gone. The narrative
// comments in runtime-session.ts's reset block name resets by hand, so this
// was armed on real source, not hypothetical.
describe("session-state scan — walker smuggle probes (R1/S1)", () => {
	const withComment = [
		"function handleSessionStart() {",
		"\t// resetZizmorTokenAvailability(); — #1535 says this belongs here",
		"\tresetDegradationLedger();",
		"}",
	].join("\n");

	it("a reset named only in a comment does not count as called", () => {
		const calls = callsWithinFunction(withComment, "handleSessionStart");
		expect(calls).toContain("resetDegradationLedger");
		expect(calls).not.toContain("resetZizmorTokenAvailability");
	});

	it("a reset named only inside a string literal does not count as called", () => {
		const source = [
			"function handleSessionStart() {",
			'\tdbg("calling resetZizmorTokenAvailability() next");',
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).not.toContain(
			"resetZizmorTokenAvailability",
		);
	});

	it("the real call is still found when both forms are present", () => {
		const source = [
			"function handleSessionStart() {",
			"\t// resetZizmorTokenAvailability() — see #1535",
			"\tresetZizmorTokenAvailability();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetZizmorTokenAvailability",
		);
	});

	it("a brace inside a comment or string cannot end the body early", () => {
		const source = [
			"function handleSessionStart() {",
			"\t// a stray } in a comment",
			'\tconst s = "another } here";',
			"\tresetDegradationLedger();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetDegradationLedger",
		);
	});

	// The regex branch had no probe at all until review round R2: deleting it
	// wholesale left every other probe here green. These two cover it from both
	// sides — the lexing decision, and the branch's existence.
	it("R2: a phantom call inside a KEYWORD-position regex does not count as called", () => {
		// The reviewer's exploit. Reading the preceding CHARACTER sees the `f` of
		// `typeof`, calls this division, leaves the regex body unstripped, and the
		// wiring check accepts a call that is not there.
		const source = [
			"function handleSessionStart() {",
			"\tif (typeof /resetZizmorTokenAvailability()/) {",
			"\t\tresetDegradationLedger();",
			"\t}",
			"}",
		].join("\n");
		const calls = callsWithinFunction(source, "handleSessionStart");
		expect(calls).not.toContain("resetZizmorTokenAvailability");
		expect(calls).toContain("resetDegradationLedger");
	});

	it("R2: a regex holding an unbalanced brace cannot truncate the body", () => {
		// Reds if the regex branch is deleted: the `{` inside the character class
		// is then counted by the brace matcher, the body never closes, and the
		// call below it disappears.
		const source = [
			"function handleSessionStart() {",
			"\tconst re = /[{]/;",
			"\tresetDegradationLedger();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetDegradationLedger",
		);
	});

	it("R2: a value-position regex is still lexed as a regex", () => {
		// The control for the keyword fix — narrowing regex position must not
		// swing so far that ordinary regex literals stop being recognized.
		const source = [
			"function handleSessionStart() {",
			'\tconst safe = arg.replace(/"/g, \'""\');',
			"\tresetDegradationLedger();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetDegradationLedger",
		);
	});

	it("stripping preserves length and line structure", () => {
		const source = 'const a = 1; // note\nconst b = "text";\n';
		const stripped = stripCommentsAndStrings(source);
		expect(stripped).toHaveLength(source.length);
		expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
		expect(stripped).toContain("const a = 1;");
		expect(stripped).not.toContain("note");
		expect(stripped).not.toContain("text");
	});
});

// The closure walker's own correctness, pinned against synthetic source the
// same way the handleSessionStart walker is above (#2319). A reset named only
// in a comment inside the closure, or a brace smuggled through a string, must
// not read as a call — the closure-site registry entries depend on it.
describe("session-state scan — closure walker smuggle probes (#2319)", () => {
	const closureSource = (body: string[]) =>
		[
			"pi.on(",
			'\t"session_start",',
			'\twrapSessionEventHandler("session_start", async (event, ctx) => {',
			...body,
			"\t});",
			");",
		].join("\n");

	it("a reset named only in a comment in the closure does not count as called", () => {
		const source = closureSource([
			"\t\t// resetConcurrentSessionBindRollupCounts(); — #2319 says this belongs here",
			"\t\tresetVerifiedPathAttributionGuessCount();",
		]);
		const calls = callsWithinSessionStartClosure(source);
		expect(calls).toContain("resetVerifiedPathAttributionGuessCount");
		expect(calls).not.toContain("resetConcurrentSessionBindRollupCounts");
	});

	it("a brace inside a string in the closure cannot end the body early", () => {
		const source = closureSource([
			'\t\tconst s = "a } here";',
			"\t\tresetVerifiedPathAttributionGuessCount();",
		]);
		expect(callsWithinSessionStartClosure(source)).toContain(
			"resetVerifiedPathAttributionGuessCount",
		);
	});

	it("the real call is still found when both forms are present", () => {
		const source = closureSource([
			"\t\t// resetVerifiedPathAttributionGuessCount() — see #2319",
			"\t\tresetConcurrentSessionBindRollupCounts();",
		]);
		const calls = callsWithinSessionStartClosure(source);
		expect(calls).toContain("resetConcurrentSessionBindRollupCounts");
		expect(calls).not.toContain("resetVerifiedPathAttributionGuessCount");
	});

	it("a reset deferred to a callback does not count as a direct call", () => {
		const source = closureSource([
			"\t\tsetImmediate(() => resetVerifiedPathAttributionGuessCount());",
			"\t\tPromise.resolve().then(() => {",
			"\t\t\tresetConcurrentSessionBindRollupCounts();",
			"\t\t});",
		]);
		expect(callsWithinSessionStartClosure(source)).not.toContain(
			"resetVerifiedPathAttributionGuessCount",
		);
		expect(callsWithinSessionStartClosure(source)).not.toContain(
			"resetConcurrentSessionBindRollupCounts",
		);
	});

	it("a reset deferred to a function callback does not count as direct", () => {
		const source = closureSource([
			"\t\tsetImmediate(function () {",
			"\t\t\tresetVerifiedPathAttributionGuessCount();",
			"\t\t});",
		]);
		expect(callsWithinSessionStartClosure(source)).not.toContain(
			"resetVerifiedPathAttributionGuessCount",
		);
	});

	it("returns empty when the registration shape changes — the failure is loud, not silent", () => {
		// #2319: if the wrapper/event registration is renamed or reformatted,
		// the derivation yields nothing and every closure-site registry entry
		// goes red through its wiring test. It must never report a phantom set.
		const source = [
			"pi.on(",
			'\t"session_start",',
			"\thonSessionStart(doTheThing);",
			");",
		].join("\n");
		expect(callsWithinSessionStartClosure(source)).toEqual([]);
	});
});

describe("session-state registry — session_start wiring", () => {
	const wired = sessionStartResetNames();
	const closureWired = sessionStartClosureResetNames();

	it("derives a non-trivial reset chain from handleSessionStart", () => {
		// A silent derivation failure (renamed entry point, broken brace match)
		// would make every wiring assertion below vacuously... fail, but this
		// names the cause directly instead of scattering it across 20 tests.
		expect(wired.size).toBeGreaterThan(15);
		expect(wired.has("resetDegradationLedger")).toBe(true);
	});

	it("derives the session_start closure resets from index.ts (#2319)", () => {
		// The closure-site entries below depend on THIS derivation, so a silent
		// failure (renamed wrapper, moved registration) would make their wiring
		// claims vacuous — the same guard the floor above gives `wired`. The
		// exact members can shift with legitimate edits; the three registered
		// ones cannot, or their entries red here.
		expect(closureWired.size).toBeGreaterThanOrEqual(5);
		for (const name of [
			"resetVerifiedPathAttributionGuessCount",
			"resetCurrentPhaseForSession",
			"resetConcurrentSessionBindRollupCounts",
		]) {
			expect(closureWired.has(name)).toBe(true);
		}
	});

	for (const entry of SESSION_STATE_REGISTRY) {
		if (entry.policy !== "session_start" || entry.gap) continue;
		const sessionStartName = entry.sessionStartResetName ?? entry.resetName;
		it(`${entry.id}: ${sessionStartName} runs at session_start`, () => {
			// #2319: entries whose reset deliberately lives in index.ts's
			// session_start CLOSURE (not handleSessionStart's reachable graph)
			// are checked against the closure derivation. Every other entry
			// keeps the handleSessionStart walk, unchanged.
			const reached = entry.sessionStartClosureReset ? closureWired : wired;
			const site = entry.sessionStartClosureReset
				? "index.ts's session_start closure"
				: "handleSessionStart";
			expect(
				reached.has(sessionStartName),
				`${sessionStartName} is not reachable from ${site}. ` +
					"Either wire it in, change the entry's policy and say why, or drop " +
					"the sessionStartClosureReset marker.",
			).toBe(true);
		});
	}

	// The mirror image, and the more valuable half: a declared gap must still
	// BE a gap. When #1625 wires the disposition reset in, this test fails and
	// forces the registry to stop claiming it is broken.
	for (const entry of SESSION_STATE_REGISTRY) {
		if (!entry.gap) continue;
		it(`${entry.id}: the declared gap is still real`, () => {
			expect(entry.gap && entry.gap.length).toBeGreaterThan(40);
			expect(
				wired.has(entry.sessionStartResetName ?? entry.resetName),
				`${entry.sessionStartResetName ?? entry.resetName} IS wired at session_start now — delete this entry's ` +
					"`gap` field; the registry must not keep claiming a fixed bug.",
			).toBe(false);
		});
	}

	it("records the gaps this registry currently declares", () => {
		// A named inventory, so a reviewer sees the open population at a glance
		// rather than grepping for `gap:`. Shrinking it is the point of the
		// registry; growing it silently is what this asserts against.
		// One down: #1666 wired package-manager's reset into handleSessionStart,
		// this list's own test went red naming the fix, and the entry lost its
		// `gap`. That is the loop the registry exists to close.
		const gaps = SESSION_STATE_REGISTRY.filter((e) => e.gap).map((e) => e.id);
		expect(gaps).toEqual(["diagnostic-dispositions:deferredThisSession"]);
	});
});

// Migrated to `tests/support/sweep-kit.ts` (#1755). The three coverage claims
// below are now one `auditRegistry` call: registered-or-fail, exemptions that
// require a reason, and stale-exemption self-detection. Behaviour is
// unchanged; the kit also adds the emptiness floor (defect shape 10) that this
// sweep never had — a scan that stops flagging files used to report clean.
describe("session-state sweep — coverage", () => {
	const audit = () =>
		auditRegistry({
			sweepName: "session-state sweep",
			// Two floors, two distinguishable failures (#1755 review F4).
			// `minScanned` catches a dead WALK — a moved clients/ root, a bad
			// extension filter — and reports "looked at 0 source items".
			// `minFlagged` catches a dead DETECTOR: a healthy walk whose
			// container/reset regexes stopped matching. Today the walk sees
			// roughly 200 files and the detector flags 71.
			scannedCount: clientSourceFiles().length,
			minScanned: 100,
			minFlagged: 40,
			flagged: scanSessionStateCandidates().map((c) => c.file),
			registered: SESSION_STATE_REGISTRY.map((e) => e.module),
			exemptions: EXEMPT_SESSION_STATE_FILES,
			minReasonLength: 16,
			remediation:
				"Decide which it is. If the state must re-arm at session_start, " +
				"register it (and wire its reset into handleSessionStart). If it is a " +
				"host derivation, a config memo or turn-scoped working state, exempt it " +
				"with the reason.",
		});

	it("every session-state-shaped file is registered or exempted with a reason", () => {
		const { unaccounted, problems } = audit();
		if (unaccounted.length > 0) expect.fail(problems.join("\n\n"));
	});

	it("no exemption names a file the sweep no longer flags", () => {
		expect(audit().staleExemptions).toEqual([]);
	});

	it("every exemption carries a reason", () => {
		expect(audit().reasonlessExemptions).toEqual([]);
	});

	it("the sweep still flags files — an empty scan must fail, not read as clean", () => {
		const { flaggedCount, problems } = audit();
		expect(
			problems.filter((p) => p.includes("declared floor")),
			problems.join("\n"),
		).toEqual([]);
		expect(flaggedCount).toBeGreaterThanOrEqual(40);
	});

	it("the walk itself still finds source files — a dead walk fails separately (F4)", () => {
		// Distinct from the test above: that one proves the DETECTOR matches,
		// this one proves the WALK has something to look at. A moved clients/
		// root reds here and names the walk; a broken container regex reds there
		// and names the detector.
		expect(clientSourceFiles().length).toBeGreaterThanOrEqual(100);
		expect(audit().scannedCount).toBe(clientSourceFiles().length);
	});

	it("documents the heuristic's blind spots rather than claiming full coverage", () => {
		// The sweep is a floor. This asserts that the boundary stays written
		// down: a future edit that deletes the limits list has to notice it is
		// deleting the honesty, not just a comment.
		expect(SWEEP_HEURISTIC_LIMITS.length).toBeGreaterThanOrEqual(5);
		expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain("closure");
		expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain("no reset seam");
	});

	// #1817: file-granular coverage above cannot see a NEW stateful symbol
	// landing inside a file that already registered or exempted — the #1801
	// review F1 shape. This pins each flagged file's detected-symbol COUNT and
	// diffs it against a live scan every run, so a new (or removed) module-level
	// Map/Set/PathKeyedMap changes the file's id and reds as an unaccounted item.
	it("every flagged file's stateful-symbol count matches its pin (#1817)", () => {
		const counts: Record<string, number> = {};
		for (const candidate of scanSessionStateCandidates()) {
			counts[candidate.file] = candidate.containers.length;
		}
		const { problems } = auditSymbolCounts({
			sweepName: "session-state symbol-count pin",
			counts,
			pinned: SESSION_STATE_SYMBOL_COUNTS,
		});
		if (problems.length > 0) expect.fail(problems.join("\n\n"));
	});

	it("the symbol-count pin names every file the sweep currently flags", () => {
		// The pin table is only a backstop if it actually covers the flagged
		// population — an entry silently missing from SESSION_STATE_SYMBOL_COUNTS
		// would make that file's count invisible rather than pinned. Distinct
		// from the drift check above: that one proves the NUMBERS agree, this one
		// proves every flagged FILE has a number to agree with in the first place.
		const flaggedFiles = new Set(
			scanSessionStateCandidates().map((c) => c.file),
		);
		const missing = [...flaggedFiles].filter(
			(file) => !Object.hasOwn(SESSION_STATE_SYMBOL_COUNTS, file),
		);
		expect(missing, missing.join("\n")).toEqual([]);
	});

	// The mirror of the test above (review round 1, G1): a PIN row naming a
	// file the scan does NOT currently flag is silent dead weight — the pin's
	// key is folded into `auditSymbolCounts`'s composite id, so a phantom entry
	// never becomes an `unaccounted` item and `auditRegistry`'s `staleExemptions`
	// never fires either, because `auditSymbolCounts` never passes exemptions.
	// Nothing structurally catches a made-up filename without this test.
	it("every symbol-count pin entry names a file the sweep still flags — no phantom rows", () => {
		const flaggedFiles = new Set(
			scanSessionStateCandidates().map((c) => c.file),
		);
		const phantom = Object.keys(SESSION_STATE_SYMBOL_COUNTS).filter(
			(file) => !flaggedFiles.has(file),
		);
		expect(phantom, phantom.join("\n")).toEqual([]);
	});
});

// #1817: the symbol-count pin's own correctness, against a synthetic fixture
// tree rather than the real clients/ tree — so the regression cannot hide
// behind whatever clients/ happens to contain today, the same discipline the
// R1/S1 walker probes above use.
describe("session-state sweep — symbol-count pin regression (#1817)", () => {
	function withFixtureTree(
		files: Record<string, string>,
		run: (dir: string) => void,
	): void {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-session-state-symbol-pin-"),
		);
		try {
			for (const [name, contents] of Object.entries(files)) {
				fs.writeFileSync(path.join(dir, name), contents);
			}
			run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	const REGISTERED_FILE_BEFORE = [
		"const existingLatch = new Map<string, string>();",
		"",
		"export function resetExistingLatch(): void {",
		"\texistingLatch.clear();",
		"}",
		"",
	].join("\n");

	// The #1801 F1 shape exactly: a SECOND, uncleared module-level Map added
	// inside a file that already carries a registered container + reset.
	const REGISTERED_FILE_AFTER = [
		REGISTERED_FILE_BEFORE,
		"const newUnclearedLatch = new Map<string, string>();",
		"",
	].join("\n");

	it("file-level coverage alone cannot see the new symbol landing in an already-registered file", () => {
		withFixtureTree(
			{ "already-registered.ts": REGISTERED_FILE_AFTER },
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				expect(candidates.map((c) => c.file)).toEqual([
					"already-registered.ts",
				]);
				expect(candidates[0].containers).toEqual([
					"existingLatch",
					"newUnclearedLatch",
				]);
				// This is the bug #1817 reports: the FILE is still registered, so a
				// file-granular audit reads clean even though a second, uncleared
				// latch landed inside it.
				const fileLevel = auditRegistry({
					sweepName: "fixture file-level audit",
					flagged: candidates.map((c) => c.file),
					registered: ["already-registered.ts"],
				});
				expect(fileLevel.problems).toEqual([]);
			},
		);
	});

	it("the symbol-count pin reds when a registered file's detected-symbol count drifts", () => {
		withFixtureTree(
			{ "already-registered.ts": REGISTERED_FILE_AFTER },
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const counts: Record<string, number> = {};
				for (const c of candidates) counts[c.file] = c.containers.length;

				// Pin captured BEFORE the second latch landed — one container, as
				// REGISTERED_FILE_BEFORE has.
				const pinAudit = auditSymbolCounts({
					sweepName: "fixture symbol-count audit",
					counts,
					pinned: { "already-registered.ts": 1 },
				});
				expect(pinAudit.problems.length).toBeGreaterThan(0);
				expect(pinAudit.unaccounted).toEqual(["already-registered.ts@2"]);
			},
		);
	});

	it("the symbol-count pin passes when the live count matches the pin", () => {
		withFixtureTree(
			{ "already-registered.ts": REGISTERED_FILE_BEFORE },
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const counts: Record<string, number> = {};
				for (const c of candidates) counts[c.file] = c.containers.length;
				const pinAudit = auditSymbolCounts({
					sweepName: "fixture symbol-count audit",
					counts,
					pinned: { "already-registered.ts": 1 },
				});
				expect(pinAudit.problems).toEqual([]);
			},
		);
	});

	it("also reds when a symbol is REMOVED without updating the pin", () => {
		withFixtureTree(
			{ "already-registered.ts": REGISTERED_FILE_BEFORE },
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const counts: Record<string, number> = {};
				for (const c of candidates) counts[c.file] = c.containers.length;
				const pinAudit = auditSymbolCounts({
					sweepName: "fixture symbol-count audit",
					counts,
					// Pin still claims 2, as if a symbol had been removed without
					// updating the table.
					pinned: { "already-registered.ts": 2 },
				});
				expect(pinAudit.problems.length).toBeGreaterThan(0);
			},
		);
	});
});

describe("session-state scan — repo container classes are containers (#2442 F2, #2455)", () => {
	function withFixtureTree(
		files: Record<string, string>,
		run: (dir: string) => void,
	): void {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-session-state-bounded-"),
		);
		try {
			for (const [name, contents] of Object.entries(files)) {
				fs.writeFileSync(path.join(dir, name), contents);
			}
			run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	// The class definitions the fixture modules below import. #2455 replaced
	// the hard-coded `Map|Set|WeakMap|WeakSet|PathKeyedMap|BoundedFifoMap|
	// BoundedLruCache` alternation with a live scan of exported classes that
	// own a `clear()`/`delete()` method, so the fixture tree must carry the
	// class DEFINITIONS the detector is meant to discover — a name alone (as
	// the pre-#2455 fixture used, importing from a `bounded-cache.js` that
	// never existed in the fixture tree) no longer proves anything about the
	// new mechanism.
	const CONTAINER_CLASSES_MODULE = [
		"export class BoundedFifoMap<K, V> {",
		"\tprivate readonly entries = new Map<K, V>();",
		"\tconstructor(maxEntries: number) {}",
		"\tclear(): void {",
		"\t\tthis.entries.clear();",
		"\t}",
		"\tdelete(key: K): boolean {",
		"\t\treturn this.entries.delete(key);",
		"\t}",
		"}",
		"",
		// Owns neither method directly — recognised only through the `extends`
		// chain, exactly like the real `BoundedLruCache` (bounded-cache.ts).
		"export class BoundedLruCache<K, V> extends BoundedFifoMap<K, V> {",
		"\toverride get(key: K): V | undefined {",
		"\t\treturn undefined;",
		"\t}",
		"}",
		"",
	].join("\n");

	// #2442 migrated ~20 module-level `new Map()` caches to BoundedFifoMap /
	// BoundedLruCache. The (then hard-coded) container regex named only
	// Map/Set/WeakMap/WeakSet/PathKeyedMap, so every migrated module silently
	// DROPPED OUT of this sweep — cache-observability.ts went from two
	// recognised containers to zero and no test noticed. A refactor from a raw
	// Map to one of this repo's own container wrappers must never make session
	// state invisible.
	//
	// MUTATION: replace `containerClassNames`'s live scan with the old
	// hard-coded alternation (`Map|Set|WeakMap|WeakSet|PathKeyedMap|
	// BoundedFifoMap|BoundedLruCache`) in tests/support/session-state-scan.ts
	// and this test still passes for THESE two names (they were in the old
	// list) — the point of this fixture is `BoundedLruCache`'s `extends`
	// chain, which the old flat regex never had to resolve. The `#2455`
	// describe block below is what actually reds under that mutation, because
	// it uses a name the hard-coded list never knew.
	const BOUNDED_MODULE = [
		'import { BoundedFifoMap, BoundedLruCache } from "./container-classes.js";',
		"",
		"const fifoLatch = new BoundedFifoMap<string, number>(8);",
		"const lruLatch = new BoundedLruCache<string, number>(8);",
		"",
		"export function resetBoundedLatches(): void {",
		"\tfifoLatch.clear();",
		"\tlruLatch.clear();",
		"}",
		"",
	].join("\n");

	it("flags a module-level `new BoundedFifoMap()` / `new BoundedLruCache()`", () => {
		withFixtureTree(
			{
				"bounded-holder.ts": BOUNDED_MODULE,
				"container-classes.ts": CONTAINER_CLASSES_MODULE,
			},
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const holder = candidates.find((c) => c.file === "bounded-holder.ts");
				expect(holder?.containers).toEqual(["fifoLatch", "lruLatch"]);
			},
		);
	});

	it("counts them for the symbol-count pin, so a new bounded latch reds", () => {
		withFixtureTree(
			{
				"bounded-holder.ts": BOUNDED_MODULE,
				"container-classes.ts": CONTAINER_CLASSES_MODULE,
			},
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const counts: Record<string, number> = {};
				for (const c of candidates) counts[c.file] = c.containers.length;
				// A pin captured when the file held only the FIFO latch.
				const pinAudit = auditSymbolCounts({
					sweepName: "fixture symbol-count audit",
					counts,
					pinned: { "bounded-holder.ts": 1, "container-classes.ts": 0 },
				});
				expect(pinAudit.unaccounted).toEqual(["bounded-holder.ts@2"]);
			},
		);
	});

	it("still ignores a bounded container declared inside a function", () => {
		// Column zero is the module-scope signal; a per-call container is
		// re-armed by construction and must not be flagged.
		withFixtureTree(
			{
				"container-classes.ts": CONTAINER_CLASSES_MODULE,
				"per-call.ts": [
					'import { BoundedFifoMap } from "./container-classes.js";',
					"",
					"export function makeCache(): unknown {",
					"\tconst perCall = new BoundedFifoMap<string, number>(8);",
					"\treturn perCall;",
					"}",
					"",
					"export function resetNothing(): void {}",
					"",
				].join("\n"),
			},
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const perCall = candidates.find((c) => c.file === "per-call.ts");
				expect(perCall?.containers ?? []).toEqual([]);
			},
		);
	});
});

// #2455: the detector must recognise a BRAND NEW repo-local collection class
// by what it DOES (owns `clear()`/`delete()`), not by whether its name made
// it into a hand-maintained list. `SomeRepoLocalCollection` below names
// nothing the pre-#2455 hard-coded alternation
// (`Map|Set|WeakMap|WeakSet|PathKeyedMap|BoundedFifoMap|BoundedLruCache`)
// could ever have matched — proof that the detector generalises rather than
// having simply grown a fourth hard-coded name.
//
// MUTATION: revert `tests/support/session-state-scan.ts` to the pre-#2455
// hard-coded `CONTAINER_DECLARATION` alternation and every test in this
// block reds — `SomeRepoLocalCollection` is invisible to a fixed name list
// by construction.
describe("session-state scan — new repo-local collection classes need no detector edit (#2455)", () => {
	function withFixtureTree(
		files: Record<string, string>,
		run: (dir: string) => void,
	): void {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-session-state-new-class-"),
		);
		try {
			for (const [name, contents] of Object.entries(files)) {
				fs.writeFileSync(path.join(dir, name), contents);
			}
			run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	const NEW_CLASS_MODULE = [
		"export class SomeRepoLocalCollection<K, V> {",
		"\tprivate readonly entries = new Map<K, V>();",
		"\tset(key: K, value: V): void {",
		"\t\tthis.entries.set(key, value);",
		"\t}",
		"\tdelete(key: K): boolean {",
		"\t\treturn this.entries.delete(key);",
		"\t}",
		"}",
		"",
	].join("\n");

	const HOLDER_MODULE = [
		'import { SomeRepoLocalCollection } from "./new-collection-class.js";',
		"",
		"const sessionLatch = new SomeRepoLocalCollection<string, number>();",
		"",
		"export function resetSessionLatch(): void {",
		'\tsessionLatch.delete("k");',
		"}",
		"",
	].join("\n");

	it("flags a module-level `new SomeRepoLocalCollection()` without editing the detector", () => {
		withFixtureTree(
			{
				"new-collection-class.ts": NEW_CLASS_MODULE,
				"holder.ts": HOLDER_MODULE,
			},
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const holder = candidates.find((c) => c.file === "holder.ts");
				expect(holder?.containers).toEqual(["sessionLatch"]);
			},
		);
	});

	it("resolves the container class through an `extends` chain too", () => {
		const subclassModule = [
			NEW_CLASS_MODULE,
			// Owns neither `clear()` nor `delete()` in its own body — only
			// through the `extends` chain, same shape as `BoundedLruCache`.
			"export class SomeRepoLocalSubclass<K, V> extends SomeRepoLocalCollection<K, V> {",
			"\toverride set(key: K, value: V): void {",
			"\t\tsuper.set(key, value);",
			"\t}",
			"}",
			"",
		].join("\n");
		withFixtureTree(
			{
				"new-collection-class.ts": subclassModule,
				"holder.ts": [
					'import { SomeRepoLocalSubclass } from "./new-collection-class.js";',
					"",
					"const sessionLatch = new SomeRepoLocalSubclass<string, number>();",
					"",
					"export function resetSessionLatch(): void {",
					'\tsessionLatch.delete("k");',
					"}",
					"",
				].join("\n"),
			},
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const holder = candidates.find((c) => c.file === "holder.ts");
				expect(holder?.containers).toEqual(["sessionLatch"]);
			},
		);
	});

	it("still ignores the new class declared inside a function (module scope still required)", () => {
		withFixtureTree(
			{
				"new-collection-class.ts": NEW_CLASS_MODULE,
				"per-call.ts": [
					'import { SomeRepoLocalCollection } from "./new-collection-class.js";',
					"",
					"export function makeLatch(): unknown {",
					"\tconst perCall = new SomeRepoLocalCollection<string, number>();",
					"\treturn perCall;",
					"}",
					"",
					"export function resetNothing(): void {}",
					"",
				].join("\n"),
			},
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const perCall = candidates.find((c) => c.file === "per-call.ts");
				expect(perCall?.containers ?? []).toEqual([]);
			},
		);
	});
});

describe("session-state scan — class-declaration shape matrix (#2455 fix round 2, F2)", () => {
	function withFixtureTree(
		files: Record<string, string>,
		run: (dir: string) => void,
	): void {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-session-state-shapes-"),
		);
		try {
			for (const [name, contents] of Object.entries(files)) {
				fs.writeFileSync(path.join(dir, name), contents);
			}
			run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	// Every shape the round-1 `^export class NAME(?:<[^>]*>)?...` regex missed
	// (the reviewer's MISS list): a non-exported class visible only through a
	// separate `export { A }` / `export { A as B }` list, `export default
	// class`, `export abstract class`, `export default abstract class`, and a
	// nested generic in either the class's own type parameters or its
	// `extends` target — round 1's `[^>]*` stopped at the first `>`, one short
	// of the real end, and silently failed to match the whole declaration.
	const NAMED_CLASSES_MODULE = [
		"export class ExportedPlain {",
		"\tclear(): void {}",
		"}",
		"",
		"export abstract class ExportedAbstract {",
		"\tclear(): void {}",
		"}",
		"",
		// Non-exported, re-exported under its own name.
		"class BareReexported {",
		"\tdelete(key: string): boolean {",
		"\t\treturn true;",
		"\t}",
		"}",
		"export { BareReexported };",
		"",
		// Non-exported, re-exported under an ALIAS — the caller elsewhere
		// constructs `new AliasedName(...)`, never `new BareAliased(...)`.
		"class BareAliased {",
		"\tdelete(key: string): boolean {",
		"\t\treturn true;",
		"\t}",
		"}",
		"export { BareAliased as AliasedName };",
		"",
		// Nested generic in the class's OWN type parameter list — round 1's
		// `(?:<[^>]*>)?` after the name stopped at the `>` inside `Map<K, V>`,
		// one short of the outer `>>`, and the whole declaration regex failed
		// to match.
		"export class NestedOwnGeneric<T extends Map<string, number>> {",
		"\tclear(): void {}",
		"}",
		"",
		// Nested generic in the `extends` target, same failure mode. The base
		// class need not exist for THIS class's own name to be captured —
		// round 2 no longer resolves `extends` at all.
		"export class NestedExtendsGeneric extends UnknownBase<Map<string, number>> {",
		"\tclear(): void {}",
		"}",
		"",
	].join("\n");

	const DEFAULT_CLASS_MODULE = [
		"export default class DefaultNamed {",
		"\tclear(): void {}",
		"}",
		"",
	].join("\n");

	const DEFAULT_ABSTRACT_CLASS_MODULE = [
		"export default abstract class DefaultAbstractNamed {",
		"\tclear(): void {}",
		"}",
		"",
	].join("\n");

	const HOLDER_MODULE = [
		"import {",
		"\tExportedPlain,",
		"\tExportedAbstract,",
		"\tBareReexported,",
		"\tAliasedName,",
		"\tNestedOwnGeneric,",
		"\tNestedExtendsGeneric,",
		'} from "./named-classes.js";',
		'import DefaultNamed from "./default-class.js";',
		'import DefaultAbstractNamed from "./default-abstract-class.js";',
		"",
		"const a = new ExportedPlain();",
		"const b = new ExportedAbstract();",
		"const c = new BareReexported();",
		"const d = new AliasedName();",
		"const e = new NestedOwnGeneric<string, number>();",
		"const f = new NestedExtendsGeneric();",
		"const g = new DefaultNamed();",
		"const h = new DefaultAbstractNamed();",
		"",
		"export function resetShapeHolder(): void {",
		"\ta.clear();",
		"\tb.clear();",
		'\tc.delete("k");',
		'\td.delete("k");',
		"\te.clear();",
		"\tf.clear();",
		"\tg.clear();",
		"\th.clear();",
		"}",
		"",
	].join("\n");

	it("flags a module-level `new` for every class-declaration export shape", () => {
		withFixtureTree(
			{
				"named-classes.ts": NAMED_CLASSES_MODULE,
				"default-class.ts": DEFAULT_CLASS_MODULE,
				"default-abstract-class.ts": DEFAULT_ABSTRACT_CLASS_MODULE,
				"holder.ts": HOLDER_MODULE,
			},
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const holder = candidates.find((c) => c.file === "holder.ts");
				expect(holder?.containers).toEqual([
					"a",
					"b",
					"c",
					"d",
					"e",
					"f",
					"g",
					"h",
				]);
			},
		);
	});

	it("MUTATION: reverting to the round-1 `^export class` regex misses every shape but the first", () => {
		// Named directly rather than imported, so this test cannot silently stop
		// covering the mutation if the production regex is ever refactored under
		// a different name.
		const round1Regex =
			/^export class ([A-Za-z_$][\w$]*)(?:<[^>]*>)?(?:\s+extends\s+([A-Za-z_$][\w$]*)(?:<[^>]*>)?)?(?:\s+implements\s+[^{]*)?\s*\{/gm;
		const found = [...NAMED_CLASSES_MODULE.matchAll(round1Regex)].map(
			(m) => m[1],
		);
		// Round 1 requires the LITERAL text "export class", so even
		// ExportedAbstract ("export abstract class") fails it; ExportedPlain is
		// the only shape with no generic and no re-export indirection the old
		// regex could still reach.
		expect(found).toEqual(["ExportedPlain"]);
	});
});

describe("session-state scan — CONTAINER_CLASS_EXCLUSIONS guards (#2455 fix round 2, F3)", () => {
	function withFixtureTree(
		files: Record<string, string>,
		run: (dir: string) => void,
	): void {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-session-state-exclusions-"),
		);
		try {
			for (const [name, contents] of Object.entries(files)) {
				fs.writeFileSync(path.join(dir, name), contents);
			}
			run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	it("the real CONTAINER_CLASS_EXCLUSIONS table has no problems (empty today)", () => {
		expect(auditContainerClassExclusions()).toEqual([]);
	});

	it("reds on a stale entry — a class name the live scan does not find", () => {
		// The reviewer's exact probe: before this guard existed, a nonexistent
		// class name paired with an empty-string reason changed nothing
		// observable, because the exclusion deleted a key that was never in the
		// declared-class Set to begin with — the sweep stayed green.
		withFixtureTree(
			{
				"real-class.ts": [
					"export class RealClass {",
					"\tclear(): void {}",
					"}",
					"",
				].join("\n"),
			},
			(dir) => {
				const problems = auditContainerClassExclusions(
					{ NonexistentClass: "a real reason, just naming the wrong class" },
					dir,
				);
				expect(problems).toEqual([
					'CONTAINER_CLASS_EXCLUSIONS names "NonexistentClass", which the live class scan does not find — stale entry (renamed, deleted, or never existed)',
				]);
			},
		);
	});

	it("reds on an empty reason, even for a class the scan genuinely finds", () => {
		withFixtureTree(
			{
				"real-class.ts": [
					"export class RealClass {",
					"\tclear(): void {}",
					"}",
					"",
				].join("\n"),
			},
			(dir) => {
				const problems = auditContainerClassExclusions({ RealClass: "" }, dir);
				expect(problems).toEqual([
					'CONTAINER_CLASS_EXCLUSIONS["RealClass"] has an empty reason',
				]);
			},
		);
	});

	it("the reviewer's exact probe: a nonexistent class with an EMPTY reason reds on BOTH counts", () => {
		withFixtureTree(
			{
				"real-class.ts": [
					"export class RealClass {",
					"\tclear(): void {}",
					"}",
					"",
				].join("\n"),
			},
			(dir) => {
				const problems = auditContainerClassExclusions(
					{ NonexistentClass: "" },
					dir,
				);
				expect(problems).toHaveLength(2);
			},
		);
	});

	it("passes clean for a real class name with a real reason", () => {
		withFixtureTree(
			{
				"real-class.ts": [
					"export class RealClass {",
					"\tclear(): void {}",
					"}",
					"",
				].join("\n"),
			},
			(dir) => {
				const problems = auditContainerClassExclusions(
					{ RealClass: "proven stateless — no instance fields at all" },
					dir,
				);
				expect(problems).toEqual([]);
			},
		);
	});
});

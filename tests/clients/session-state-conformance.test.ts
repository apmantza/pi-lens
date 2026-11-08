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
	SESSION_CELL_KEYS,
	SESSION_STATE_REGISTRY,
	SESSION_STORE_REGISTRY,
	SESSION_STATE_SYMBOL_COUNTS,
	_resetRegistryProbeState,
} from "../support/session-state-registry.js";
import {
	SWEEP_HEURISTIC_LIMITS,
	auditContainerClassExclusions,
	auditOwnerKeys,
	callsWithinFunction,
	callsWithinSessionStartClosure,
	clientSourceFiles,
	resetNameDefinitions,
	scanScopeCellKeys,
	scanSessionStateCandidates,
	sessionStartClosureResetNames,
	sessionStartResetNames,
	stripCommentsAndStrings,
	symbolCount,
} from "../support/session-state-scan.js";
import {
	assertSortedRegistry,
	auditRegistry,
	auditSymbolCounts,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

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

	it(
		"every registered reset name resolves to exactly one clients/ module",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);
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

	it(
		"derives a non-trivial reset chain from handleSessionStart",
		() => {
			// A silent derivation failure (renamed entry point, broken brace match)
			// would make every wiring assertion below vacuously... fail, but this
			// names the cause directly instead of scattering it across 20 tests.
			expect(wired.size).toBeGreaterThan(15);
			expect(wired.has("resetDegradationLedger")).toBe(true);
		},
		TREE_WALK_TIMEOUT_MS,
	);

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
		it(
			`${entry.id}: ${sessionStartName} runs at session_start`,
			() => {
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
			},
			TREE_WALK_TIMEOUT_MS,
		);
	}

	// The mirror image, and the more valuable half: a declared gap must still
	// BE a gap. When #1625 wires the disposition reset in, this test fails and
	// forces the registry to stop claiming it is broken.
	for (const entry of SESSION_STATE_REGISTRY) {
		if (!entry.gap) continue;
		it(
			`${entry.id}: the declared gap is still real`,
			() => {
				expect(entry.gap && entry.gap.length).toBeGreaterThan(40);
				expect(
					wired.has(entry.sessionStartResetName ?? entry.resetName),
					`${entry.sessionStartResetName ?? entry.resetName} IS wired at session_start now — delete this entry's ` +
						"`gap` field; the registry must not keep claiming a fixed bug.",
				).toBe(false);
			},
			TREE_WALK_TIMEOUT_MS,
		);
	}

	it("records the gaps this registry currently declares", () => {
		// A named inventory, so a reviewer sees the open population at a glance
		// rather than grepping for `gap:`. Shrinking it is the point of the
		// registry; growing it silently is what this asserts against.
		// One down: #1666 wired package-manager's reset into handleSessionStart,
		// this list's own test went red naming the fix, and the entry lost its
		// `gap`. That is the loop the registry exists to close.
		// Empty since #4701 F1 wired `resetDeferredDispositions` into
		// `resetSessionScopedState`: the last declared gap is closed, and this
		// assertion is what keeps a new one from being added silently.
		const gaps = SESSION_STATE_REGISTRY.filter((e) => e.gap).map((e) => e.id);
		expect(gaps).toEqual([]);
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
			exemptions: Object.fromEntries(
				Object.entries(EXEMPT_SESSION_STATE_FILES).map(([file, row]) => [
					file,
					row.reason,
				]),
			),
			minReasonLength: 16,
			remediation:
				"Decide which it is. If the state must re-arm at session_start, " +
				"register it (and wire its reset into handleSessionStart). If it is a " +
				"host derivation, a config memo or turn-scoped working state, exempt it " +
				"with the reason.",
		});

	it(
		"every session-state-shaped file is registered or exempted with a reason",
		() => {
			const { unaccounted, problems } = audit();
			if (unaccounted.length > 0) expect.fail(problems.join("\n\n"));
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"no exemption names a file the sweep no longer flags",
		() => {
			expect(audit().staleExemptions).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every exemption carries a reason",
		() => {
			expect(audit().reasonlessExemptions).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"the sweep still flags files — an empty scan must fail, not read as clean",
		() => {
			const { flaggedCount, problems } = audit();
			expect(
				problems.filter((p) => p.includes("declared floor")),
				problems.join("\n"),
			).toEqual([]);
			expect(flaggedCount).toBeGreaterThanOrEqual(40);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"the walk itself still finds source files — a dead walk fails separately (F4)",
		() => {
			// Distinct from the test above: that one proves the DETECTOR matches,
			// this one proves the WALK has something to look at. A moved clients/
			// root reds here and names the walk; a broken container regex reds there
			// and names the detector.
			expect(clientSourceFiles().length).toBeGreaterThanOrEqual(100);
			expect(audit().scannedCount).toBe(clientSourceFiles().length);
		},
		TREE_WALK_TIMEOUT_MS,
	);

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
	it(
		"every flagged file's stateful-symbol count matches its pin (#1817)",
		() => {
			const counts: Record<string, number> = {};
			for (const candidate of scanSessionStateCandidates()) {
				counts[candidate.file] = symbolCount(candidate);
			}
			const { problems } = auditSymbolCounts({
				sweepName: "session-state symbol-count pin",
				counts,
				pinned: SESSION_STATE_SYMBOL_COUNTS,
			});
			if (problems.length > 0) expect.fail(problems.join("\n\n"));
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"the symbol-count pin names every file the sweep currently flags",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// The mirror of the test above (review round 1, G1): a PIN row naming a
	// file the scan does NOT currently flag is silent dead weight — the pin's
	// key is folded into `auditSymbolCounts`'s composite id, so a phantom entry
	// never becomes an `unaccounted` item and `auditRegistry`'s `staleExemptions`
	// never fires either, because `auditSymbolCounts` never passes exemptions.
	// Nothing structurally catches a made-up filename without this test.
	it(
		"every symbol-count pin entry names a file the sweep still flags — no phantom rows",
		() => {
			const flaggedFiles = new Set(
				scanSessionStateCandidates().map((c) => c.file),
			);
			const phantom = Object.keys(SESSION_STATE_SYMBOL_COUNTS).filter(
				(file) => !flaggedFiles.has(file),
			);
			expect(phantom, phantom.join("\n")).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);
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

	it(
		"file-level coverage alone cannot see the new symbol landing in an already-registered file",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"the symbol-count pin reds when a registered file's detected-symbol count drifts",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"the symbol-count pin passes when the live count matches the pin",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"also reds when a symbol is REMOVED without updating the pin",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);
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

	it(
		"flags a module-level `new BoundedFifoMap()` / `new BoundedLruCache()`",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"counts them for the symbol-count pin, so a new bounded latch reds",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"still ignores a bounded container declared inside a function",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);
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

	it(
		"flags a module-level `new SomeRepoLocalCollection()` without editing the detector",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"resolves the container class through an `extends` chain too",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"still ignores the new class declared inside a function (module scope still required)",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);
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

	it(
		"flags a module-level `new` for every class-declaration export shape",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

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

	it(
		"the real CONTAINER_CLASS_EXCLUSIONS table has no problems (empty today)",
		() => {
			expect(auditContainerClassExclusions()).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"reds on a stale entry — a class name the live scan does not find",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"reds on an empty reason, even for a class the scan genuinely finds",
		() => {
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
						{ RealClass: "" },
						dir,
					);
					expect(problems).toEqual([
						'CONTAINER_CLASS_EXCLUSIONS["RealClass"] has an empty reason',
					]);
				},
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"the reviewer's exact probe: a nonexistent class with an EMPTY reason reds on BOTH counts",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"passes clean for a real class name with a real reason",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);
});

// #4965 (defect shape 72): seven bug fixes in one week (#4961, #4955, #4952,
// #4940, #4762, #4749, #4753) were stores that answered for the process when a
// session owned the data. No check asked who owns a store; this one does.
describe("session-state registry — owner key (#4965)", () => {
	const OK_SESSION = {
		id: "x:session",
		module: "x.ts",
		ownerKey: "session",
		sessionSeamException:
			"one process Set keyed by file path with no session in the key",
	};

	it("every registry entry declares an admitted owner key", () => {
		expect(auditOwnerKeys(SESSION_STATE_REGISTRY)).toEqual([]);
	});

	it("an entry with the column removed is refused", () => {
		const { ownerKey: _dropped, ...withoutColumn } = OK_SESSION;
		expect(auditOwnerKeys([withoutColumn])).toEqual([
			expect.stringContaining("x:session: ownerKey undefined is not"),
		]);
	});

	it("fails closed: only the known values are admitted", () => {
		const refused = [
			"global",
			"Session",
			" session",
			"session ",
			"",
			"process-wide",
			"process-wide:",
			"process-wide: ",
			"process-wide: machine",
			"process wide: a fact about this machine",
			"cwd",
			42,
			null,
			undefined,
			["session"],
		];
		for (const ownerKey of refused)
			expect(
				auditOwnerKeys([{ id: "x", module: "x.ts", ownerKey }]),
				`${JSON.stringify(ownerKey)} must be refused`,
			).toHaveLength(1);
		for (const ownerKey of [
			"repository",
			"project",
			"process-wide: shared LSP pool: one service for every session",
		])
			expect(
				auditOwnerKeys([{ id: "x", module: "x.ts", ownerKey }]),
				`${ownerKey} must be admitted`,
			).toEqual([]);
	});

	it("a session owner states why a scope cell cannot hold it", () => {
		expect(auditOwnerKeys([OK_SESSION])).toEqual([]);
		const bare = { id: "x", module: "x.ts", ownerKey: "session" };
		expect(auditOwnerKeys([bare])).toEqual([
			expect.stringContaining("move it onto a scope cell"),
		]);
		expect(
			auditOwnerKeys([{ ...bare, sessionSeamException: "because" }]),
		).toHaveLength(1);
	});

	it("a seam claim is refused whatever it names, with or without an exception", () => {
		// RECURRENCE GUARDED: #4972 review F2 and F5. A claim checked per module
		// admitted a wrong store (cacheUsageSummary riding the module's real cell),
		// and a non-boolean claim beside a valid exception passed. A store on a
		// scope cell has no registry entry, so no claim is admitted at all.
		const wrongStore = {
			id: "cache-observability:cacheUsageSummary",
			module: "cache-observability.ts",
			state: "cacheUsageSummary",
			ownerKey: "session",
		};
		for (const sessionSeam of [
			"cache-observability",
			true,
			"yes",
			"",
			null,
		] as unknown[]) {
			expect(
				auditOwnerKeys([{ ...wrongStore, sessionSeam }]),
				`${JSON.stringify(sessionSeam)} alone`,
			).toEqual([
				expect.stringContaining("sessionSeam is not a registry field"),
			]);
			expect(
				auditOwnerKeys([
					{
						...wrongStore,
						sessionSeam,
						sessionSeamException: OK_SESSION.sessionSeamException,
					},
				]),
				`${JSON.stringify(sessionSeam)} beside a valid exception`,
			).toEqual([
				expect.stringContaining("sessionSeam is not a registry field"),
			]);
		}
	});

	it("an exception does not ride a non-session owner", () => {
		for (const ownerKey of [
			"project",
			"repository",
			"process-wide: a fact about this machine",
		])
			expect(
				auditOwnerKeys([
					{
						id: "x",
						module: "x.ts",
						ownerKey,
						sessionSeamException: OK_SESSION.sessionSeamException,
					},
				]),
			).toHaveLength(1);
	});

	it(
		"every shipped scope cell is pinned, and every pin is a live use",
		() => {
			expect(scanScopeCellKeys()).toEqual(SESSION_CELL_KEYS);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	describe("the cell census reads code, not prose, and not one spelling", () => {
		let root: string | undefined;
		afterEach(() => {
			if (root) fs.rmSync(root, { recursive: true, force: true });
			root = undefined;
		});
		const scanPlanted = (files: Record<string, string>) => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cell-scan-"));
			for (const [name, text] of Object.entries(files))
				fs.writeFileSync(path.join(root, name), text);
			return Object.fromEntries(
				Object.entries(scanScopeCellKeys([root])).map(([file, tokens]) => [
					path.basename(file),
					tokens,
				]),
			);
		};
		const IMPORT =
			'import { scopeCell, sessionCell } from "./session-scope.js";\n';

		it(
			"reads a literal key, a const key and an imported key",
			() => {
				expect(
					scanPlanted({
						"literal.ts": `${IMPORT}scopeCell<Map<string, number>>(scope, "a", () => new Map());`,
						"const.ts": `${IMPORT}const KEY = "b";\nsessionCell(id, KEY);`,
						"imported.ts": `${IMPORT}import { OTHER_KEY } from "./o.js";\nscopeCell(scope, OTHER_KEY);`,
					}),
				).toEqual({
					"literal.ts": ["a"],
					"const.ts": ["b"],
					"imported.ts": ["ident:OTHER_KEY"],
				});
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it(
			"lists an alias, an indirect call and a value through another binding instead of missing them",
			() => {
				// Plants the author did not design for: each lands a `?` token, which
				// no pin contains, so the census test reds until the spelling is read.
				const tokens = scanPlanted({
					"alias.ts":
						'import { scopeCell as sc } from "./session-scope.js";\nsc(scope, "x");',
					"indirect.ts": `${IMPORT}const open = scopeCell;\nopen(scope, "x");`,
					"binding.ts": `${IMPORT}const OTHER = "x";\nconst KEY = OTHER;\nscopeCell(scope, KEY);`,
					"member.ts":
						'import * as seam from "./session-scope.js";\nseam.scopeCell(scope, "x");',
					"reexport.ts": 'export { scopeCell } from "./session-scope.js";',
					"computed.ts": `${IMPORT}scopeCell(scope, "a" + suffix);`,
					"parameter.ts": `${IMPORT}function f(key: string) { return scopeCell(scope, key); }`,
				});
				for (const [file, found] of Object.entries(tokens))
					expect(
						found.some((token) => token.startsWith("?")),
						`${file}: ${JSON.stringify(found)}`,
					).toBe(true);
				expect(Object.keys(tokens).sort()).toEqual([
					"alias.ts",
					"binding.ts",
					"computed.ts",
					"indirect.ts",
					"member.ts",
					"parameter.ts",
					"reexport.ts",
				]);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it(
			"ignores a name that only a comment or a string carries",
			() => {
				expect(
					scanPlanted({
						"prose.ts":
							'// scopeCell(scope, "x")\nconst note = "sessionCell(id, \\"y\\")";',
					}),
				).toEqual({});
			},
			TREE_WALK_TIMEOUT_MS,
		);
	});
});

// #5027 (defect shape 72, the gap after #4972): the owner-key column read only
// SESSION_STATE_REGISTRY. Session-owned state in a file-level exemption, in the
// store registry, or in a container with no reset (a class field, a Map nobody
// wrote a reset for) had no owner axis, so the seven bugs #4965 cites (#4955,
// #4749, #4940, #4762, #4952, #4961, #4753) could not have been flagged.
describe("session-state registry — owner key on every list (#5027)", () => {
	const exemptRows = () =>
		Object.entries(EXEMPT_SESSION_STATE_FILES).map(([file, row]) => ({
			id: file,
			module: file,
			ownerKey: row.ownerKey,
			sessionSeamException: row.sessionSeamException,
		}));
	const storeRows = () =>
		Object.entries(SESSION_STORE_REGISTRY).map(([name, row]) => ({
			id: name,
			module: row.module,
			ownerKey: row.ownerKey,
		}));

	it("every exempt file row declares an admitted owner key", () => {
		expect(exemptRows().length).toBeGreaterThanOrEqual(100);
		expect(auditOwnerKeys(exemptRows())).toEqual([]);
	});

	it("every declared session store row declares an admitted owner key", () => {
		expect(storeRows()).toHaveLength(5);
		expect(auditOwnerKeys(storeRows(), { declaredStores: true })).toEqual([]);
	});

	it("an exempt row or a store row with no, an unknown or a short owner is refused", () => {
		for (const ownerKey of [
			undefined,
			"global",
			"process-wide: x",
			"Session",
		]) {
			expect(
				auditOwnerKeys([
					{ id: "git-guard.ts", module: "git-guard.ts", ownerKey },
				]),
				String(ownerKey),
			).toEqual([expect.stringContaining("git-guard.ts: ownerKey")]);
			expect(
				auditOwnerKeys(
					[{ id: "widget", module: "widget-state.ts", ownerKey }],
					{
						declaredStores: true,
					},
				),
				String(ownerKey),
			).toEqual([expect.stringContaining("widget: ownerKey")]);
		}
	});

	// #4749 / #4952 recurrence: git-guard.ts sat under a file-level exemption
	// ("git-guard turn state, cleared on the turn path") with no owner, so the
	// per-session blocker sections never had to state whose they were.
	it("a session-owned exempt row states why a scope cell does not hold it", () => {
		const row = {
			id: "git-guard.ts",
			module: "git-guard.ts",
			ownerKey: "session",
		};
		expect(auditOwnerKeys([row])).toEqual([
			expect.stringContaining("is session-owned"),
		]);
		expect(
			auditOwnerKeys([{ ...row, sessionSeamException: "turn state" }]),
		).toEqual([expect.stringContaining("is session-owned")]);
	});

	it("a declared store states no seam exception, and a session exemption keeps its own", () => {
		expect(
			auditOwnerKeys(
				[
					{
						id: "widget",
						module: "widget-state.ts",
						ownerKey: "session",
						sessionSeamException: "a store is the seam",
					},
				],
				{ declaredStores: true },
			),
		).toEqual([expect.stringContaining("states no sessionSeamException")]);
		for (const file of ["git-guard.ts", "runtime-coordinator.ts"])
			expect(
				EXEMPT_SESSION_STATE_FILES[file]?.sessionSeamException?.length,
				file,
			).toBeGreaterThan(30);
	});
});

describe("session-state scan — containers with no reset, and class fields (#5027)", () => {
	function withScanTree(
		files: Record<string, string>,
		run: (dir: string) => void,
	): void {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-session-state-owner-scan-"),
		);
		try {
			for (const [name, contents] of Object.entries(files)) {
				fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
				fs.writeFileSync(path.join(dir, name), contents);
			}
			run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	const flagged = (files: Record<string, string>): string[] => {
		let out: string[] = [];
		withScanTree(files, (dir) => {
			out = scanSessionStateCandidates(dir).map((c) => c.file);
		});
		return out;
	};

	// The planted Map of #5027: a camelCase container in clients/read-guard.ts
	// with no exported reset survived the pairing rule (150 passed on 62ef6a14a).
	it(
		"a reset-less camelCase Map is a candidate",
		() => {
			expect(
				flagged({
					"read-guard.ts":
						"const plantedBySession = new Map<string, string>();\nexport function note(): void {}\n",
				}),
			).toEqual(["read-guard.ts"]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Class sweep of #5027: five files kept their state in a process singleton
	// cell (disk-changes.ts, instance-registry-lock.ts, instance-registry-tail.ts,
	// lsp/created-import-targets.ts, process-bridge.ts) and exported no reset, so
	// the pairing rule never asked whose it was.
	it(
		"a process singleton cell with no reset is a candidate",
		() => {
			expect(
				flagged({
					"cell.ts": [
						'import { getProcessSingleton } from "./process-singletons.js";',
						"export function tally(): { calls: number } {",
						'\treturn getProcessSingleton("tally", 1, () => ({ calls: 0 }));',
						"}",
						"",
					].join("\n"),
				}),
			).toEqual(["cell.ts"]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	describe("the one admitted constant: an UPPER_SNAKE built-in never mutated", () => {
		const READ_ONLY = [
			'const READ_OPS = new Set(["read", "grep"]);',
			"export function isRead(name: string): boolean {",
			"\treturn READ_OPS.has(name);",
			"}",
			"export function all(): string[] {",
			"\treturn [...READ_OPS];",
			"}",
			"",
		].join("\n");
		const withUse = (use: string) =>
			READ_ONLY + `export function extra(): unknown {\n\t${use}\n}\n`;

		it(
			"is not a candidate when every use is a read",
			() => {
				expect(flagged({ "lookup.ts": READ_ONLY })).toEqual([]);
				expect(
					flagged({
						"lookup.ts": withUse(
							"for (const op of READ_OPS) void op; return Array.from(READ_OPS).length + READ_OPS.size;",
						),
					}),
				).toEqual([]);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it.each([
			["add", 'READ_OPS.add("write");'],
			["delete", 'READ_OPS.delete("read");'],
			["clear", "READ_OPS.clear();"],
			["index assignment", 'READ_OPS["x"] = true;'],
			["an alias", 'const view = READ_OPS; view.add("x");'],
			["an argument to another call", "mutate(READ_OPS);"],
			["a value reached through another binding", "return { set: READ_OPS };"],
			["a reassignment", "READ_OPS = new Set();"],
			["a typeof use", "return typeof READ_OPS;"],
		])(
			"is a candidate when a use is %s",
			(_name, use) => {
				expect(flagged({ "lookup.ts": withUse(use) })).toEqual(["lookup.ts"]);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it(
			"ignores a mutation named only in a comment or a string",
			() => {
				expect(
					flagged({
						"lookup.ts": withUse(
							'// READ_OPS.add("write") would be a mutation\n\treturn "READ_OPS.clear()";',
						),
					}),
				).toEqual([]);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it(
			"is a candidate when declared let, in lower case, or built by a clients/ class",
			() => {
				expect(
					flagged({
						"a.ts": READ_ONLY.replace("const READ_OPS", "let READ_OPS"),
					}),
				).toEqual(["a.ts"]);
				expect(
					flagged({ "b.ts": READ_ONLY.replaceAll("READ_OPS", "readOps") }),
				).toEqual(["b.ts"]);
				expect(
					flagged({
						"c.ts": READ_ONLY.replace(
							'new Set(["read", "grep"])',
							"new Registry()",
						),
						"registry.ts": "export class Registry { add(): void {} }\n",
					}),
				).toEqual(["c.ts"]);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		describe("when exported, every shipped source is read", () => {
			const EXPORTED = READ_ONLY.replace(
				"const READ_OPS",
				"export const READ_OPS",
			);
			it(
				"stays admitted when an importer only reads",
				() => {
					expect(
						flagged({
							"lookup.ts": EXPORTED,
							"user.ts":
								'import { READ_OPS } from "./lookup.js";\nexport const hit = READ_OPS.has("x");\n',
						}),
					).toEqual([]);
				},
				TREE_WALK_TIMEOUT_MS,
			);
			it.each([
				["mutates it", 'READ_OPS.add("x");'],
				["passes it on", "consume(READ_OPS);"],
			])(
				"is a candidate when an importer %s",
				(_name, use) => {
					expect(
						flagged({
							"lookup.ts": EXPORTED,
							"user.ts": `import { READ_OPS } from "./lookup.js";\nexport function f(): void {\n\t${use}\n}\n`,
						}),
					).toEqual(["lookup.ts"]);
				},
				TREE_WALK_TIMEOUT_MS,
			);
			it(
				"is a candidate when an importer renames it or re-exports it under another name",
				() => {
					expect(
						flagged({
							"lookup.ts": EXPORTED,
							"user.ts":
								'import { READ_OPS as ops } from "./lookup.js";\nexport const n = ops.size;\n',
						}),
					).toEqual(["lookup.ts"]);
					expect(
						flagged({
							"lookup.ts": READ_ONLY + "export { READ_OPS as OPS };\n",
						}),
					).toEqual(["lookup.ts"]);
				},
				TREE_WALK_TIMEOUT_MS,
			);
			it(
				"treats an unrenamed export list as exported",
				() => {
					expect(
						flagged({
							"lookup.ts": READ_ONLY + "export { READ_OPS };\n",
							"user.ts":
								'import { READ_OPS } from "./lookup.js";\nexport function f(): void {\n\tREAD_OPS.delete("x");\n}\n',
						}),
					).toEqual(["lookup.ts"]);
				},
				TREE_WALK_TIMEOUT_MS,
			);
		});
	});

	describe("class fields bound to a container", () => {
		const fieldsOf = (source: string): string[] => {
			let out: string[] = [];
			withScanTree({ "holder.ts": source }, (dir) => {
				out =
					scanSessionStateCandidates(dir)
						.find((c) => c.file === "holder.ts")
						?.instanceFields.map((f) => f.name) ?? [];
			});
			return out;
		};

		// #4955 recurrence, the declaration and assignment exactly as
		// RuntimeCoordinator carried them at d472a99c9: a nullable field filled
		// by a `??= new <clients/ class>`, which no module-scope scan can see.
		it(
			"reads a null-initialised field the coordinator fills with a new store (#4955)",
			() => {
				withScanTree(
					{
						"read-guard.ts": "export class ReadGuard { reads = new Map(); }\n",
						"runtime-coordinator.ts": [
							'import { ReadGuard } from "./read-guard.js";',
							"export class RuntimeCoordinator {",
							"\tprivate _readGuard: ReadGuard | null = null;",
							"\tgetReadGuard(): ReadGuard {",
							"\t\tthis._readGuard ??= new ReadGuard();",
							"\t\treturn this._readGuard;",
							"\t}",
							"}",
							"",
						].join("\n"),
					},
					(dir) => {
						const coordinator = scanSessionStateCandidates(dir).find(
							(c) => c.file === "runtime-coordinator.ts",
						);
						expect(coordinator?.instanceFields.map((f) => f.name)).toEqual([
							"RuntimeCoordinator._readGuard",
						]);
					},
				);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it.each([
			[
				"an initialised Map",
				"private cache = new Map<string, number>();",
				["Holder.cache"],
			],
			["a Set", "readonly seen: Set<string> = new Set();", ["Holder.seen"]],
			[
				"a WeakMap",
				"private owners = new WeakMap<object, string>();",
				["Holder.owners"],
			],
			["an Array", "private queue: string[] = [];", ["Holder.queue"]],
			[
				"a static field",
				"static readonly shared = new Map<string, string>();",
				["Holder.shared"],
			],
			["a private name", "#hidden = new Set<string>();", ["Holder.#hidden"]],
			[
				"a generic type with an arrow function",
				"private hooks: Map<string, () => void> = new Map();",
				["Holder.hooks"],
			],
			[
				"a constructor assignment",
				"constructor() { this.late = new Set(); }",
				["Holder.late"],
			],
			["a ||= assignment", "start() { this.lazy ||= []; }", ["Holder.lazy"]],
		])(
			"flags %s",
			(_name, member, expected) => {
				expect(fieldsOf(`export class Holder {\n\t${member}\n}\n`)).toEqual(
					expected,
				);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it.each([
			["a scalar", "private count = 0;"],
			["a function value", "private handler = () => new Map();"],
			[
				"a local inside a method",
				"run() { const local = new Map(); return local; }",
			],
			["a default parameter", "run(cache = new Map()) { return cache; }"],
			["a comparison", "check() { return this.x == new Map(); }"],
			["a name in a comment", "// private cache = new Map();"],
			["a name in a string", 'private note = "this.cache = new Map()";'],
		])(
			"does not flag %s",
			(_name, member) => {
				expect(fieldsOf(`export class Holder {\n\t${member}\n}\n`)).toEqual([]);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it(
			"counts fields with the module containers in the one symbol pin",
			() => {
				withScanTree(
					{
						"holder.ts":
							"const knownBySession = new Map<string, string>();\nexport class Holder {\n\tprivate a = new Set<string>();\n}\n",
					},
					(dir) => {
						const [candidate] = scanSessionStateCandidates(dir);
						expect(candidate?.containers).toEqual(["knownBySession"]);
						expect(candidate?.instanceFields.map((f) => f.name)).toEqual([
							"Holder.a",
						]);
						expect(symbolCount(candidate!)).toBe(2);
					},
				);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		// A file with a row must not need a new pin for a constant that is proven
		// read-only, and must for the same constant once a use mutates it.
		it(
			"pins an admitted constant at zero and the same constant, once mutated, at one",
			() => {
				const lookup = [
					'const PLANTED_LOOKUP = new Map<string, string>([["a", "b"]]);',
					'export const has = PLANTED_LOOKUP.has("a");',
					"export function reset(): void {}",
					"",
				].join("\n");
				const countOf = (source: string): number | undefined => {
					let out: number | undefined;
					withScanTree({ "planted.ts": source }, (dir) => {
						const found = scanSessionStateCandidates(dir)[0];
						out = found && symbolCount(found);
					});
					return out;
				};
				expect(countOf(lookup)).toBe(0);
				expect(countOf(`${lookup}PLANTED_LOOKUP.set("c", "d");\n`)).toBe(1);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it(
			"states the spellings it does not read, rather than claiming them",
			() => {
				// Residual, named in SWEEP_HEURISTIC_LIMITS: a value built by a factory
				// call, reached through another binding, or by an aliased constructor.
				expect(
					fieldsOf(
						[
							"const make = () => new Map();",
							"const Store = Map;",
							"export class Holder {",
							"\tprivate viaFactory = make();",
							"\tprivate viaAlias = new Store();",
							"\tconstructor(seed: Map<string, string>) { const m = new Map(); this.viaBinding = m; this.fromParam = seed; }",
							"}",
							"",
						].join("\n"),
					),
				).toEqual([]);
				expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain("CLASS FIELD");
			},
			TREE_WALK_TIMEOUT_MS,
		);
	});

	// #5036 F1. clients/file-time.ts kept `reads` and `locks` as members of the
	// module object `globalState = { reads: new Map(), locks: new Map() }`; the
	// file was absent from all 163 candidates and had no owner row, the #4955
	// shape one level out (a field holding a store, escaped from the scan).
	describe("members of a module-level object literal (#5036 F1)", () => {
		const membersOf = (files: Record<string, string>, file = "holder.ts") => {
			let out: string[] = [];
			withScanTree(files, (dir) => {
				out =
					scanSessionStateCandidates(dir)
						.find((c) => c.file === file)
						?.instanceFields.map((f) => f.name) ?? [];
			});
			return out;
		};

		it.each([
			[
				"file-time.ts's globalState",
				"const globalState = {\n\treads: new Map(),\n\tlocks: new Map(),\n};\n",
				["globalState.reads", "globalState.locks"],
			],
			[
				"an annotated, exported literal",
				"export const state: State = {\n\tserved: new Set<string>(),\n};\n",
				["state.served"],
			],
			[
				"a let literal",
				"let hub = { sessions: new WeakMap<object, string>() };\n",
				["hub.sessions"],
			],
			[
				"a member after a nested object, a call and a generic comma",
				"const s = {\n\tcfg: { a: 1, b: new Map() },\n\tn: make(1, 2),\n\tseen: new Map<string, number>(),\n\tlate: new WeakSet(),\n};\n",
				["s.seen", "s.late"],
			],
		])(
			"flags %s",
			(_name, source, expected) => {
				expect(membersOf({ "holder.ts": source })).toEqual(expected);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it(
			"flags a member built by a clients/ container class",
			() => {
				expect(
					membersOf({
						"read-guard.ts": "export class ReadGuard { reads = new Map(); }\n",
						"holder.ts":
							'import { ReadGuard } from "./read-guard.js";\nconst holder = { guard: new ReadGuard() };\n',
					}),
				).toEqual(["holder.guard"]);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it(
			"counts a member in the one symbol pin, with the module containers",
			() => {
				withScanTree(
					{
						"holder.ts":
							"const knownBySession = new Map<string, string>();\nconst hub = { a: new Set<string>() };\n",
					},
					(dir) => {
						const [candidate] = scanSessionStateCandidates(dir);
						expect(symbolCount(candidate!)).toBe(2);
					},
				);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it.each([
			["an array member", "const cfg = { items: [] };"],
			["a nested object's member", "const cfg = { inner: { m: new Map() } };"],
			["a shorthand member", "const m = 1;\nconst cfg = { m };"],
			["a method", "const cfg = { reads() { return new Map(); } };"],
			["an arrow value", "const cfg = { make: () => new Map() };"],
			[
				"a value that wraps the container",
				"const cfg = { m: wrap(new Map()) };",
			],
			[
				"a literal wrapped in a call",
				"const cfg = Object.freeze({ m: new Map() });",
			],
			[
				"a literal inside a function",
				"function f() {\n\tconst cfg = { m: new Map() };\n\treturn cfg;\n}",
			],
			[
				"a member named in a comment",
				"// const cfg = { m: new Map() };\nconst x = 1;",
			],
			[
				"a member named in a string",
				'const note = "const cfg = { m: new Map() }";',
			],
		])(
			"does not read %s",
			(_name, source) => {
				expect(membersOf({ "holder.ts": `${source}\n` })).toEqual([]);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		// The three spellings the detector's author did not design for: an
		// alias, an indirect call and a value reached through another binding.
		// None is read; each is named in SWEEP_HEURISTIC_LIMITS.
		it(
			"states the member spellings it does not read, rather than claiming them",
			() => {
				expect(
					membersOf({
						"holder.ts": [
							"const Store = Map;",
							"const make = () => new Map();",
							"const hub = { aliased: new Store(), made: make(), later: undefined };",
							"hub.later = new Map();",
							"",
						].join("\n"),
					}),
				).toEqual([]);
				expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain("OBJECT LITERAL");
			},
			TREE_WALK_TIMEOUT_MS,
		);
	});

	// #5036 F2. Three spellings the declaration regex could not read, live in
	// clients/: `exitFlushers` in ndjson-logger.ts (a `=>` in the annotation and
	// an `a ?? b ?? new Set()` initialiser; mutated at lines 434 and 238, no row,
	// no pin) and the two multi-line ReadonlyMap tables of lens-flag-registry.ts
	// and lsp/server-covers.ts.
	describe("declaration spellings of a module container (#5036 F2)", () => {
		const containersOf = (source: string): string[] => {
			let out: string[] = [];
			withScanTree({ "holder.ts": source }, (dir) => {
				out =
					scanSessionStateCandidates(dir, {
						includeUnresetContainers: true,
					}).find((c) => c.file === "holder.ts")?.containers ?? [];
			});
			return out;
		};

		it.each([
			[
				"an arrow function in the annotation and a ?? chain (ndjson-logger.ts)",
				"const exitFlushers: Set<() => void> =\n\tstate?.exitFlushers ??\n\tlegacy?.exitFlushers ??\n\tnew Set<() => void>();\n",
				["exitFlushers"],
			],
			[
				"an annotation over several lines (server-covers.ts)",
				'export const COVERS: ReadonlyMap<\n\tstring,\n\treadonly string[]\n> = new Map([["a", ["b"]]]);\n',
				["COVERS"],
			],
			[
				"a ?? chain on one line",
				"const seen = globalThis.seen ?? new Set<string>();\n",
				["seen"],
			],
			[
				"a ?? chain with a non-null operand",
				"let cache = host.cache! ?? new Map();\n",
				["cache"],
			],
		])(
			"reads %s",
			(_name, source, expected) => {
				expect(containersOf(source)).toEqual(expected);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it.each([
			[
				"a bare declaration, then a container on the next line",
				"let pending: number;\nconst real = new Map();\n",
				["real"],
			],
			[
				"an arrow function that returns a container",
				"const make = (): Map<string, string> => new Map();\n",
				[],
			],
			[
				"a call operand ahead of the ??",
				"const x = load() ?? new Map();\n",
				[],
			],
			["an || chain", "const x = a || new Map();\n", []],
			["a ternary", "const x = flag ? new Map() : other;\n", []],
		])(
			"does not read %s",
			(_name, source, expected) => {
				expect(containersOf(source)).toEqual(expected);
			},
			TREE_WALK_TIMEOUT_MS,
		);
	});

	// #5036 F3 (greptile PRRT_kwDORt8rec6yJBG-, coderabbit PRRT_kwDORt8rec6yJChX).
	// READ_USE_AFTER admits forEach and the value-returning reads, so a container
	// mutated through the callback's third argument and a value mutated in place
	// stay admitted. Live population 0 in clients/, tools/, mcp/ and index.ts;
	// disclosed in SWEEP_HEURISTIC_LIMITS rather than refusing the common read.
	describe("mutation the read-form allowlist cannot see (#5036 F3)", () => {
		const countOf = (source: string): number | undefined => {
			let out: number | undefined;
			withScanTree({ "planted.ts": source }, (dir) => {
				const found = scanSessionStateCandidates(dir)[0];
				out = found && symbolCount(found);
			});
			return out;
		};

		it(
			"admits a container emptied through the forEach callback's third argument",
			() => {
				expect(
					countOf(
						'const READ_OPS = new Set<string>(["a"]);\nexport function drop(): void {\n\tREAD_OPS.forEach((value, _key, set) => set.delete(value));\n}\nexport function reset(): void {}\n',
					),
				).toBe(0);
				expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain("forEach");
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it(
			"admits a value mutated in place after get, values, entries, keys or forEach",
			() => {
				expect(
					countOf(
						'const COUNTS_BY_KIND = new Map<string, { n: number }>();\nexport function bump(): void {\n\tCOUNTS_BY_KIND.get("a")!.n++;\n}\nexport function reset(): void {}\n',
					),
				).toBe(0);
				expect(
					countOf(
						'const LOOKUP = new Map<string, Set<string>>();\nexport function add(): void {\n\tLOOKUP.forEach((s) => s.add("x"));\n}\nexport function reset(): void {}\n',
					),
				).toBe(0);
				expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain(
					"stored VALUE mutated in place",
				);
			},
			TREE_WALK_TIMEOUT_MS,
		);
	});

	// #5036 N2 (greptile PRRT_kwDORt8rec6yJr0B, coderabbit PRRT_kwDORt8rec6yJuxG).
	// `sawParen` in `fieldInitialisers` drops a class field whose type annotation
	// is parenthesised, and with no other state the file leaves the candidate
	// list. Live population 0; disclosed in SWEEP_HEURISTIC_LIMITS, and the
	// predicate is left as it is. The plain-annotation control proves the file is
	// scanned at all, so the omission is the parenthesis alone.
	describe("parenthesised field annotation, disclosed (#5036 N2)", () => {
		const fieldsOf = (source: string): string[] | undefined => {
			let out: string[] | undefined;
			withScanTree({ "holder.ts": source }, (dir) => {
				out = scanSessionStateCandidates(dir)
					.find((c) => c.file === "holder.ts")
					?.instanceFields.map((f) => f.name);
			});
			return out;
		};

		it.each([
			["a union in parentheses", "private queue: (string | number)[] = [];"],
			["a function-type array", "private listeners: (() => void)[] = [];"],
			[
				"a bare function type",
				"private cache: () => Map<string, string> = new Map();",
			],
		])(
			"omits a class field typed with %s, and the file with it",
			(_name, field) => {
				expect(
					fieldsOf(`export class Holder {\n\t${field}\n}\n`),
				).toBeUndefined();
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it(
			"reads the plain annotation, and states the parenthesis miss",
			() => {
				expect(
					fieldsOf(
						"export class Holder {\n\tprivate queue: string[] = [];\n}\n",
					),
				).toEqual(["Holder.queue"]);
				expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain(
					"whose type annotation is parenthesised",
				);
			},
			TREE_WALK_TIMEOUT_MS,
		);
	});
});

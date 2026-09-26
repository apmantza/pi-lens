/**
 * Regression guard for #525 (test hermeticity for ~/.pi-lens machine-global
 * state, the same class #515 fixed for config.json).
 *
 * Uses the REAL (unmocked) `getGlobalPiLensDir` — deliberately does NOT mock
 * `clients/file-utils.js` like tests/clients/instance-registry.test.ts does,
 * so this test proves the actual env-var routing end to end: every writer
 * under `~/.pi-lens` goes through `getGlobalPiLensDir()`, which now respects
 * `PI_LENS_HOME`. Dogfooding caught this live 2026-07-11: a test-fixture
 * instance (`Temp/pi-lens-turn-summary-*` projectRoot) survived in the
 * developer's REAL `~/.pi-lens/instances.json` for ~17h because tests
 * exercising `registerInstance` had no override and wrote straight into the
 * real homedir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	auditRegistry,
	assertNonEmptyScan,
	escapeRegExp,
	listSourceFiles,
	matchingCloseIndex,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { removeTempDirSync } from "./test-utils.js";

import { EventEmitter } from "node:events";
import { waitFor } from "./interleaving-kit.js";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import { makeSessionStartEvent } from "../support/host-event-factory.js";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: () => {
		const child = new EventEmitter();
		const stdout = Object.assign(new EventEmitter(), { unref() {} });
		queueMicrotask(() => child.emit("close", 0, null));
		return Object.assign(child, { stdout, stderr: null, unref() {} });
	},
}));

import extension from "../../index.js";
import { _resetSessionLifecycleForTests } from "../../clients/session-lifecycle.js";

const sharedHome = process.env.PI_LENS_HOME!;

const realGlobalDir = path.join(os.homedir(), ".pi-lens");
const realRegistryPath = path.join(realGlobalDir, "instances.json");

describe("machine-global writers route through PI_LENS_HOME, never the real homedir", () => {
	let overrideDir: string;

	beforeEach(() => {
		overrideDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-home-override-"),
		);
		process.env.PI_LENS_HOME = overrideDir;
	});

	afterEach(() => {
		removeTempDirSync(overrideDir);
		process.env.PI_LENS_HOME = sharedHome;
	});

	it("getGlobalPiLensDir resolves to PI_LENS_HOME", async () => {
		const { getGlobalPiLensDir } = await import("../../clients/file-utils.js");
		expect(getGlobalPiLensDir()).toBe(path.resolve(overrideDir));
	});

	it("registerInstance writes instances.json under PI_LENS_HOME, never under the real homedir", async () => {
		const realHomeExistedBefore = fs.existsSync(realRegistryPath);
		const realHomeMtimeBefore = realHomeExistedBefore
			? fs.statSync(realRegistryPath).mtimeMs
			: undefined;

		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/some/override-routed/project");

		const overriddenPath = path.join(overrideDir, "instances.json");
		expect(fs.existsSync(overriddenPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(overriddenPath, "utf-8"));
		expect(parsed.instances).toHaveLength(1);
		expect(parsed.instances[0].projectRoot).toContain(
			"override-routed/project",
		);

		// The real ~/.pi-lens/instances.json must be untouched: either it still
		// doesn't exist, or (if a real pi-lens session happens to run on this
		// machine concurrently) its mtime did not change from this test's write.
		if (realHomeExistedBefore) {
			expect(fs.statSync(realRegistryPath).mtimeMs).toBe(realHomeMtimeBefore);
		} else {
			expect(fs.existsSync(realRegistryPath)).toBe(false);
		}
	});

	it("deregisterInstance operates only on the PI_LENS_HOME-scoped registry", async () => {
		const { registerInstance, deregisterInstance, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/dereg/project");
		expect(await readInstanceRegistry()).toHaveLength(1);

		deregisterInstance();
		expect(await readInstanceRegistry()).toHaveLength(0);

		// Confirm it operated under the override, not the real homedir dir.
		expect(fs.existsSync(path.join(overrideDir, "instances.json"))).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// #3050: detect a tests/ file that drives the machine-global registry
// against the RUN-SHARED PI_LENS_HOME, rather than against the per-case
// override the suite above proves every writer respects.
//
// #3042's shape: `tests/support/vitest-setup.ts` pins ONE `PI_LENS_HOME`
// (`.probe-home`) for the whole vitest run, not a per-worker temp dir. Every
// writer under it — `clients/instance-registry.ts`'s `registerInstance` /
// `pruneDeadInstances`, `clients/instance-reaper.ts`'s orphan-backstop sweep
// — locks its target with a BEST-EFFORT primitive (`withInstanceRegistryLock`
// / `withInstanceRegistryLockSync` / `acquireQuarantinePidFileLock`): each
// gives up after a bounded wait and silently skips the write on contention,
// rather than blocking or throwing. A test that asserts such a write as a
// hard postcondition is racing every sibling Vitest fork over that ONE file —
// exactly how `tests/index-vanished-instance-wiring.test.ts` redded in CI on
// two unrelated dependabot heads (#3023, #3026) before touching the reaper,
// the registry, or the test itself.
//
// Two sweeps, reusing `tests/support/sweep-kit.ts`'s registered-or-fail
// machinery rather than a new lane:
//
//   1. The set of `clients/` modules that resolve a `getGlobalPiLensDir()`
//      path AND lock it with one of the best-effort primitives above stays a
//      NAMED, registered pair — so a third module adopting the same shape
//      cannot silently join the population sweep 2 depends on.
//   2. Every `tests/**/*.test.ts` file that reaches one of those modules (by
//      import specifier, `vi.mock`/`vi.doMock` target, or a direct
//      `getGlobalPiLensDir()` call) pins its own `PI_LENS_HOME` or mocks
//      `clients/file-utils.js`'s `getGlobalPiLensDir` — the two isolation
//      idioms this repo's registry-driving tests already use (a third,
//      giving a spawned child its own `PI_LENS_HOME` in its env, isolates the
//      CHILD process rather than the parent test file, so a parent that only
//      spawns such a child never touches the registry itself and is outside
//      this walk's population — `tests/clients/instance-registry-race.test.ts`).
//
// Both scans run over comment-and-string-blanked text (AGENTS.md "Detectors
// match code, not prose") — this docblock's own mentions of every symbol
// above must never be read as a hit.

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CLIENTS_ROOT = path.join(REPO_ROOT, "clients");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");

/** Best-effort lock primitives #3042's shape is built on: bounded wait, then
 *  silently skip rather than block or throw. */
const BEST_EFFORT_LOCK_CALLS = [
	"withInstanceRegistryLock(",
	"withInstanceRegistryLockSync(",
	"acquireQuarantinePidFileLock(",
] as const;

/** A module resolves a getGlobalPiLensDir()-rooted path AND locks it with a
 *  best-effort primitive — #3042's exact writer shape, not merely "uses
 *  getGlobalPiLensDir somewhere" (which alone would also catch read-only
 *  consumers like `clients/biome-client.ts`'s tools-dir path, never racy). */
function isBestEffortGlobalDirWriter(source: string): boolean {
	const code = stripSource(source, { strings: "blank" });
	const callsGlobalDir = /\bgetGlobalPiLensDir\s*\(/.test(code);
	const callsBestEffortLock = BEST_EFFORT_LOCK_CALLS.some((needle) =>
		code.includes(needle),
	);
	return callsGlobalDir && callsBestEffortLock;
}

const clientsFiles = listSourceFiles(CLIENTS_ROOT, { skipTests: true });
const producerModules = clientsFiles
	.filter((file) => isBestEffortGlobalDirWriter(fs.readFileSync(file, "utf8")))
	.map((file) => relativePosix(CLIENTS_ROOT, file))
	.sort();

describe("clients/ best-effort getGlobalPiLensDir() writers stay a named, registered set (#3042 recurrence)", () => {
	it("registry-or-fail: every module that locks a getGlobalPiLensDir() path with a best-effort primitive is named here", () => {
		assertNonEmptyScan(
			"clients/ best-effort global-dir writer scan",
			clientsFiles.length,
			300,
		);
		const audit = auditRegistry({
			sweepName: "clients/ best-effort global-dir writer registry",
			flagged: producerModules,
			registered: ["instance-registry.ts", "instance-reaper.ts"],
			scannedCount: clientsFiles.length,
			minScanned: 300,
			remediation:
				"A clients/ module now resolves a getGlobalPiLensDir() path and " +
				"locks it with a best-effort primitive that silently drops the " +
				"write under contention — #3042's exact writer shape. Name it in " +
				"the `registered` list above, then the test-file sweep below " +
				"(which derives its population FROM this list) starts covering " +
				"tests/ files that reach it.",
		});
		expect(audit.problems).toEqual([]);
	});

	it("mutation-proof: dropping the best-effort-lock half of the predicate lets read-only getGlobalPiLensDir() consumers into the registry, failing the audit above", () => {
		// #3042's shape is "resolves the path AND locks it best-effort" — NOT
		// merely "calls getGlobalPiLensDir somewhere". clients/biome-client.ts,
		// clients/effective-config.ts and clients/runtime-session.ts all call
		// getGlobalPiLensDir() (a tools-dir join, a config resolution, an
		// atomic-write-stage sweep) with no lock at all — read-only or
		// single-writer paths, never the racy shape. A predicate that dropped
		// the lock half would sweep them in as unregistered producers.
		const naiveProducerModules = clientsFiles
			.filter((file) =>
				/\bgetGlobalPiLensDir\s*\(/.test(
					stripSource(fs.readFileSync(file, "utf8"), { strings: "blank" }),
				),
			)
			.map((file) => relativePosix(CLIENTS_ROOT, file))
			.sort();

		// The mutation really does find more than the real predicate — proof
		// the AND-condition is load-bearing, not decoration.
		expect(naiveProducerModules.length).toBeGreaterThan(producerModules.length);
		expect(naiveProducerModules).toEqual(
			expect.arrayContaining(["biome-client.ts", "effective-config.ts"]),
		);

		const mutatedAudit = auditRegistry({
			sweepName: "MUTATED (lock condition dropped) global-dir writer registry",
			flagged: naiveProducerModules,
			registered: ["instance-registry.ts", "instance-reaper.ts"],
			minFlagged: 1,
		});
		expect(mutatedAudit.problems.length).toBeGreaterThan(0);
		expect(mutatedAudit.unaccounted).toEqual(
			expect.arrayContaining(["biome-client.ts", "effective-config.ts"]),
		);
	});
});

// ── Hazardous EXPORTED symbols per producer module ──────────────────────────
//
// "Imports something from instance-registry.js" is not the same as "touches
// the racy registry file": many exports are pure functions over an
// already-provided `InstanceEntry[]` (`getInstanceRoots`, `mergeInstanceRoots`,
// `selectLivePeerInstances`, `computeResourceFootprint`) or module-load
// constants/types, and a first version of this sweep that flagged ANY
// specifier reference found 23 such false positives (`clients/warm-attach.
// test.ts` imports only a TYPE; `clients/shared-checkout-guard.test.ts` calls
// a pure selector; `clients/debug-handles.test.ts` calls `getGlobalPiLensDir`
// for an unrelated, non-racy log file). The population must be the functions
// that actually perform the best-effort-locked I/O.

/** Every top-level `function NAME(...) { ... }` DECLARATION, or `const/let
 *  NAME = (async )?(...) => { ... }` / `const/let NAME = (async )?function
 *  (...) { ... }` ASSIGNMENT, in `strippedCode` (comments and strings
 *  already blanked, so brace-counting only ever sees REAL code braces — a
 *  template-literal `${...}` interpolation's own braces are left unblanked
 *  by `stripSource` for exactly this reason), keyed by name to its body text
 *  including the braces. Assumes column-0 top-level declarations, same as
 *  sweep-kit's `findEnclosingSymbol` already does for this repo.
 *
 *  Review round 2, F5: the arrow/function-expression form was previously
 *  unmatched, so a hazardous helper written as `export const sweepX = async
 *  (...) => { ...withInstanceRegistryLock... }` in a registered producer
 *  would never enter `hazardousExportedNames` at all — latent today (zero
 *  such exports in the two current producers) but silent the moment one is
 *  added. Guarded to only bound BLOCK bodies (`=> {`): an expression-bodied
 *  arrow (`=> foo()`) has no braces to balance, and reusing the first brace
 *  found LATER in the file would silently attribute an unrelated function's
 *  body to this declaration — named limit, not attempted here. */
/** Index of a `function NAME(` declaration's BODY brace, given the index of
 *  its parameter list's opening paren — or -1 when the declaration has no
 *  body (an overload signature, which ends at `;`).
 *
 *  Balances the parameter list first, so a default parameter VALUE's braces
 *  (`options: Opts = {}`) can never be mistaken for the body (#3050). Between
 *  the closing paren and the body only a return-type annotation can sit, and
 *  that annotation can carry braces of its own: nested in `<...>`
 *  (`Promise<{ ok: boolean }>`, skipped by angle depth — `=>`'s `>` is not a
 *  closing bracket) or BARE (`instance-registry.ts`'s
 *  `registryTailState(): { tail: Promise<void> }`, skipped by balancing the
 *  group and looking at what follows it: another type brace / `|` / `&` means
 *  the annotation continues, anything else means the group WAS the body). */
function bodyBraceAfterParams(code: string, openParen: number): number {
	if (code[openParen] !== "(") return -1;
	const close = matchingCloseIndex(code, openParen, "(", ")");
	if (close < 0) return -1;
	const nextNonSpace = (from: number): number => {
		let i = from;
		while (i < code.length && /\s/.test(code[i] ?? "")) i++;
		return i;
	};
	const hasReturnType = code[nextNonSpace(close + 1)] === ":";
	let angle = 0;
	for (let i = close + 1; i < code.length; i++) {
		const ch = code[i];
		if (ch === "<") angle++;
		else if (ch === ">") {
			if (code[i - 1] !== "=") angle = Math.max(0, angle - 1);
		} else if (ch === ";") return -1;
		else if (ch === "{" && angle === 0) {
			if (!hasReturnType) return i;
			const end = matchingCloseIndex(code, i, "{", "}");
			if (end < 0) return -1;
			const after = code[nextNonSpace(end + 1)];
			if (after !== "{" && after !== "|" && after !== "&") return i;
			i = end;
		}
	}
	return -1;
}

function topLevelFunctionBodies(strippedCode: string): Map<string, string> {
	const bodies = new Map<string, string>();

	/** Find the body's own `{` at `braceStart`, balance it, and record the
	 *  name — shared tail for both declaration shapes below. */
	const record = (name: string, braceStart: number): void => {
		if (strippedCode[braceStart] !== "{") return;
		const end = matchingCloseIndex(strippedCode, braceStart, "{", "}");
		if (end < 0) return;
		bodies.set(name, strippedCode.slice(braceStart, end + 1));
	};

	// `function NAME(...) { ... }`: the match ends at the parameter list's
	// OPENING paren only, so the body's `{` is found by walking PAST the
	// parameter list — never by a plain forward `indexOf("{")` from there.
	// #3050 recurrence (master 038e28b's Unit red): a default parameter VALUE
	// carries its own braces, so the plain search stopped on the `{}` of
	// `sweepUntrackedOrphans(options: BackstopSweepOptions = {})` and recorded
	// a 2-character body. `callsPrimitiveDirectly` then saw nothing, the whole
	// backstop half of `instance-reaper.ts` (`sweepUntrackedOrphans`,
	// `scheduleUntrackedOrphanSweep`, `sweepAtomicWriteStages`, and
	// `instance-registry.ts`'s `updateHeartbeat`) stayed out of
	// `hazardousSymbols`, and `tests/clients/instance-reaper-unref.test.ts`
	// — which drives the real cooldown stamp and sweep lock in the run-shared
	// home — was waved through as isolated.
	const functionPattern =
		/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/gm;
	let functionMatch: RegExpExecArray | null;
	while ((functionMatch = functionPattern.exec(strippedCode))) {
		const braceStart = bodyBraceAfterParams(
			strippedCode,
			functionMatch.index + functionMatch[0].length - 1,
		);
		if (braceStart >= 0) record(functionMatch[1], braceStart);
	}

	// `const/let NAME = (async )?(...) => { ... }` or `= (async )?function
	// (...) { ... }` (F5): the match ends right at `=>`/the parameter list's
	// CLOSING paren, so — unlike the declaration form above — the very next
	// non-whitespace character MUST be the body's own `{`, or this is an
	// expression-bodied arrow (`=> foo()`) with no braces to balance; reusing
	// a LATER, unrelated brace would silently corrupt this entry (see the
	// doc above `topLevelFunctionBodies`).
	const arrowOrFunctionExprPattern =
		/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:\([^()]*\)\s*(?::[^=\n]+)?=>|[A-Za-z_$][\w$]*\s*=>|function\s*\*?\s*(?:[A-Za-z_$][\w$]*\s*)?\([^()]*\))/gm;
	let arrowMatch: RegExpExecArray | null;
	while ((arrowMatch = arrowOrFunctionExprPattern.exec(strippedCode))) {
		const afterMatch = arrowMatch.index + arrowMatch[0].length;
		const gapLength =
			/^\s*/.exec(strippedCode.slice(afterMatch))?.[0].length ?? 0;
		record(arrowMatch[1], afterMatch + gapLength);
	}

	return bodies;
}

/** Fixed-point closure over one module's own top-level functions: every
 *  function whose body calls a best-effort lock primitive or
 *  `getGlobalPiLensDir(` directly, OR calls another function already in the
 *  set (same file only — `registerInstance` itself calls neither; it calls
 *  `registerInstanceNow`, which calls `writeRegistryWithRetry`, which calls
 *  `withInstanceRegistryLock`/`registryPath`, three hops down. A predicate
 *  that skipped this closure — checked live below — would miss
 *  `registerInstance` entirely), restricted to names the module EXPORTS. */
function hazardousExportedNames(strippedCode: string): string[] {
	const bodies = topLevelFunctionBodies(strippedCode);
	const callsPrimitiveDirectly = (body: string): boolean =>
		/\bgetGlobalPiLensDir\s*\(/.test(body) ||
		BEST_EFFORT_LOCK_CALLS.some((needle) => body.includes(needle));
	const hazardous = new Set<string>();
	for (const [name, body] of bodies) {
		if (callsPrimitiveDirectly(body)) hazardous.add(name);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const [name, body] of bodies) {
			if (hazardous.has(name)) continue;
			for (const hazardousName of hazardous) {
				if (new RegExp(`\\b${escapeRegExp(hazardousName)}\\s*\\(`).test(body)) {
					hazardous.add(name);
					changed = true;
					break;
				}
			}
		}
	}
	const exported = new Set<string>();
	// F5: an exported `const`/`let` arrow or function-expression name is an
	// export too — matched the same way `topLevelFunctionBodies` finds the
	// declaration itself, so a name that entered `bodies` above can also
	// enter `exported` here.
	const exportPattern =
		/^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)|^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/gm;
	let exportMatch: RegExpExecArray | null;
	while ((exportMatch = exportPattern.exec(strippedCode))) {
		exported.add(exportMatch[1] ?? exportMatch[2]);
	}
	return [...hazardous].filter((name) => exported.has(name)).sort();
}

const hazardousSymbols = new Set<string>();
for (const relFile of producerModules) {
	const stripped = stripSource(
		fs.readFileSync(path.join(CLIENTS_ROOT, relFile), "utf8"),
		{ strings: "blank" },
	);
	for (const name of hazardousExportedNames(stripped))
		hazardousSymbols.add(name);
}
// Cross-file addendum this same-file closure structurally cannot see:
// `instance-reaper.ts`'s exported `sweepOrphans` calls `instance-registry.ts`'s
// exported `readInstanceRegistry` — a DIFFERENT file, so it never enters
// `instance-reaper.ts`'s own closure above. Verified live below, every run,
// rather than trusted as a comment.
hazardousSymbols.add("sweepOrphans");

/** Hazardous symbols whose ENTIRE I/O is a registry READ (`readInstanceRegistry`
 *  itself, and `sweepOrphans`, which per the addendum above calls nothing else
 *  racy) — mocking `instance-registry.js`'s `readInstanceRegistry` fully
 *  neutralizes a test that calls ONLY these. A file that also calls a WRITER
 *  (`registerInstance`, `pruneDeadInstances`, ...) needs the stronger
 *  `file-utils.js`/`PI_LENS_HOME` idiom instead — `isIsolated` below checks
 *  this per file, not per call. */
const SYMBOLS_COVERED_BY_READ_MOCK = new Set([
	"readInstanceRegistry",
	"sweepOrphans",
]);

describe("clients/ hazardous exported registry symbols stay derived, not guessed (#3042 recurrence)", () => {
	it("the sweepOrphans -> readInstanceRegistry cross-file addendum is still true", () => {
		// If either half stops being true, the manual `hazardousSymbols.add(
		// "sweepOrphans")` above is a stale guess, not a verified fact.
		const reaperStripped = stripSource(
			fs.readFileSync(path.join(CLIENTS_ROOT, "instance-reaper.ts"), "utf8"),
			{ strings: "blank" },
		);
		expect(/^export async function sweepOrphans\(/m.test(reaperStripped)).toBe(
			true,
		);
		expect(/\breadInstanceRegistry\s*\(/.test(reaperStripped)).toBe(true);
	});

	it("mutation-proof: without the transitive closure, registerInstance (three calls from the lock) drops out of the hazardous set", () => {
		const registrySource = fs.readFileSync(
			path.join(CLIENTS_ROOT, "instance-registry.ts"),
			"utf8",
		);
		const stripped = stripSource(registrySource, { strings: "blank" });
		expect(hazardousExportedNames(stripped)).toContain("registerInstance");

		// MUTATION: direct-call check only, no fixed-point closure.
		const bodies = topLevelFunctionBodies(stripped);
		const direct = new Set<string>();
		for (const [name, body] of bodies) {
			if (
				/\bgetGlobalPiLensDir\s*\(/.test(body) ||
				BEST_EFFORT_LOCK_CALLS.some((needle) => body.includes(needle))
			) {
				direct.add(name);
			}
		}
		expect(direct.has("registerInstance")).toBe(false);
		// ...which would have let a test file calling ONLY registerInstance
		// (tests/clients/instance-registry.test.ts, among others) pass the
		// "touches a producer" check unflagged even with no isolation at all.
	});

	it("reviewer probe (round 2, F5): an arrow-function export calling the lock primitive enters the hazardous set", () => {
		// A FAKE producer module — never a real clients/ file, so this never
		// depends on the two real producers happening to be written as
		// `function` declarations. Named `export function NAME(...) { ... }`
		// was the ONLY shape `topLevelFunctionBodies` recognized before F5; a
		// hazardous helper written as an arrow export (legal, idiomatic
		// TypeScript) entered neither `bodies` nor `hazardousSymbols` at all.
		const fakeProducerSource = [
			'import { getGlobalPiLensDir } from "./file-utils.js";',
			'import { withInstanceRegistryLock } from "./instance-registry-lock.js";',
			"export const sweepFakeThing = async (): Promise<void> => {",
			"	await withInstanceRegistryLock(getGlobalPiLensDir(), async () => {});",
			"};",
		].join("\n");
		const stripped = stripSource(fakeProducerSource, { strings: "blank" });
		expect(hazardousExportedNames(stripped)).toContain("sweepFakeThing");

		// MUTATION: the pre-F5 declaration-only pattern — `sweepFakeThing` is
		// an arrow export, so it never matches at all, and the fixed-point
		// closure never even gets a candidate to start from.
		const declarationOnlyPattern =
			/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/gm;
		expect(declarationOnlyPattern.test(stripped)).toBe(false);
	});

	it("#3050 recurrence: a default parameter VALUE's braces are not read as the function body", () => {
		// The recurrence: master 038e28b's Unit lane redded on
		// `tests/clients/instance-reaper-unref.test.ts` because THIS derivation
		// never saw `sweepUntrackedOrphans`. Its declaration carries
		// `options: BackstopSweepOptions = {}`, and the body brace used to be
		// located with a plain `indexOf("{")` from the opening paren — which
		// lands on the DEFAULT VALUE's `{}`. The recorded body was 2 characters,
		// so the whole backstop half of the module stayed non-hazardous and the
		// unref file's real cooldown-stamp/sweep-lock reach into the run-shared
		// home was waved through as isolated.
		const reaperStripped = stripSource(
			fs.readFileSync(path.join(CLIENTS_ROOT, "instance-reaper.ts"), "utf8"),
			{ strings: "blank" },
		);
		const body = topLevelFunctionBodies(reaperStripped).get(
			"sweepUntrackedOrphans",
		);
		expect(body).toBeDefined();
		expect(body).toContain("acquireBackstopLock(");
		expect(hazardousExportedNames(reaperStripped)).toContain(
			"sweepUntrackedOrphans",
		);

		// MUTATION: the pre-fix locator, inline — the first `{` after the
		// opening paren is the default value's, and it balances to `{}`.
		const declaration =
			/^export async function sweepUntrackedOrphans\s*\(/m.exec(reaperStripped);
		expect(declaration).not.toBeNull();
		const preFixBrace = reaperStripped.indexOf(
			"{",
			(declaration?.index ?? 0) + (declaration?.[0].length ?? 0),
		);
		expect(reaperStripped.slice(preFixBrace, preFixBrace + 2)).toBe("{}");

		// The sibling shape found by this fix, live in the OTHER registered
		// producer: a BARE inline object return type
		// (`registryTailState(): { tail: Promise<void> }`) whose annotation
		// brace would bind as the body just as readily as a default value's.
		const registryStripped = stripSource(
			fs.readFileSync(path.join(CLIENTS_ROOT, "instance-registry.ts"), "utf8"),
			{ strings: "blank" },
		);
		expect(registryStripped).toMatch(
			/^function registryTailState\(\): \{ tail: Promise<void> \} \{/m,
		);
		expect(
			topLevelFunctionBodies(registryStripped).get("registryTailState"),
		).toContain("getProcessSingleton(");
	});
});

/** The walk options the registry-isolation population is built with. Shared
 *  with the red-first proof below so that proof exercises the SAME walk — same
 *  function, same options — over its own private root (#3082). */
const REGISTRY_WALK_OPTIONS = { skipDeclarations: true } as const;

/** Every `tests/**​/*.test.ts` file under `root`, absolute and sorted. */
function walkTestFiles(root: string): string[] {
	return listSourceFiles(root, REGISTRY_WALK_OPTIONS).filter((file) =>
		file.endsWith(".test.ts"),
	);
}

/** Every `tests/**​/*.test.ts` file, repo-relative to `TESTS_ROOT`. */
const testFiles = walkTestFiles(TESTS_ROOT);

/** The literal target filenames the two registered producers write — the
 *  raw-`fs` idiom `tests/index-vanished-instance-wiring.test.ts` and
 *  `tests/clients/instance-reaper-backstop.test.ts` used, bypassing every
 *  producer SYMBOL entirely by reading `process.env.PI_LENS_HOME` (or
 *  `getGlobalPiLensDir()`) and joining the filename by hand. */
const TARGET_FILENAMES = [
	"instances.json",
	"orphan-backstop.json",
	"orphan-backstop.lock",
];

interface Touch {
	reason: "symbol" | "target-file";
	/** Empty for a "target-file" touch (no symbol call at all — a raw `fs` reach). */
	matchedSymbols: string[];
}

/** A test file resolves a producer's getGlobalPiLensDir() path when it CALLS
 *  (not merely imports, mocks, or type-references) one of the hazardous
 *  exported symbols above, OR when it names one of the producers' TARGET
 *  filenames in code together with any `PI_LENS_HOME`/`getGlobalPiLensDir(`
 *  reference — the raw-`fs` idiom neither symbol touches. */
function touchesGlobalDirRegistry(
	commentsBlankedStringsKept: string,
	stringsBlankedCode: string,
): Touch | undefined {
	const matchedSymbols = [...hazardousSymbols]
		.filter((name) =>
			new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(stringsBlankedCode),
		)
		.sort();
	if (matchedSymbols.length > 0) return { reason: "symbol", matchedSymbols };

	// Review round 2, F3: matches the filename ANYWHERE in code/string text,
	// not only as a complete `"filename"` literal — a template-literal path
	// (`` `${home}/instances.json` ``) never produces that exact quoted
	// substring (the filename sits after an interpolation, inside backticks,
	// with no quotes of its own around just the filename), so the stricter
	// form silently missed it.
	const namesTargetFile = TARGET_FILENAMES.some((filename) =>
		commentsBlankedStringsKept.includes(filename),
	);
	if (!namesTargetFile) return undefined;
	const referencesHome =
		/\bPI_LENS_HOME\b/.test(commentsBlankedStringsKept) ||
		/\bgetGlobalPiLensDir\s*\(/.test(stringsBlankedCode);
	return referencesHome
		? { reason: "target-file", matchedSymbols: [] }
		: undefined;
}

/** An ASSIGNMENT or object-literal KEY, never a bare reference — a plain
 *  `process.env.PI_LENS_HOME as string` (read-only) must not count, or this
 *  is exactly the false-clear the mutation test below demonstrates on
 *  `tests/index-vanished-instance-wiring.test.ts` itself. Matches
 *  `process.env.PI_LENS_HOME = x` (own-process pin) and an object literal's
 *  `PI_LENS_HOME: x` key (a spawned child's env, e.g.
 *  `tests/clients/instance-registry-race.test.ts`) without matching `===`.
 *
 *  MUST be evaluated over STRINGS-BLANKED text (review round 2, F2): a real
 *  pin is CODE — `process.env.PI_LENS_HOME =` and an object literal's
 *  `PI_LENS_HOME:` key both survive comment-and-string blanking exactly like
 *  any other statement — so testing it against strings-KEPT text let a
 *  documentation STRING merely narrating the pin (`"process.env.PI_LENS_HOME
 *  = testRegistryHome"`, `tests/scripts/check-pr-body.test.ts`'s own fixture
 *  data for a DIFFERENT check) falsely satisfy this predicate for a
 *  genuinely-unpinned file that happens to carry that string. Kept as a
 *  separate constant from `TARGET_FILENAMES` below on purpose — that
 *  evidence genuinely IS a string literal (a filename), so it alone still
 *  needs the strings-KEPT pass. */
const PI_LENS_HOME_ASSIGNMENT = /\bPI_LENS_HOME\s*(?:=(?!=)|:)/;

/** The full, paren-matched text of a `vi.mock("...basename", factory)` /
 *  `vi.doMock(...)` call targeting `basename`, or `undefined` if the file
 *  never mocks it. */
function findMockCallText(
	commentsBlankedStringsKept: string,
	basename: string,
): string | undefined {
	const target = new RegExp(
		`\\bvi\\.(?:mock|doMock)\\(\\s*"[^"]*/${escapeRegExp(basename)}"`,
	).exec(commentsBlankedStringsKept);
	if (!target) return undefined;
	const openParenIndex = commentsBlankedStringsKept.indexOf("(", target.index);
	const end = matchingCloseIndex(
		commentsBlankedStringsKept,
		openParenIndex,
		"(",
		")",
	);
	if (end < 0) return undefined;
	return commentsBlankedStringsKept.slice(openParenIndex, end + 1);
}

/** The factory's own "give me the real module" hook parameter name
 *  (conventionally `importOriginal`/`importActual`, but vitest never
 *  requires either spelling), plus every local name bound to its awaited
 *  result (`const actual = await importOriginal();`, `const orig = await
 *  importActual();`, ...). Review round 2, F4: a passthrough is not always
 *  spelled `actual` — generalizing to WHATEVER name the factory itself
 *  chose is what makes the guard below survive a rename. */
function realModuleAliases(callText: string): string[] {
	// The factory is `vi.mock`'s SECOND argument — always comma-led here,
	// never immediately after the call's own opening paren (that position is
	// the specifier string). `,\s*` anchors to that comma rather than any
	// open paren, which the specifier's own parenthesis-free text cannot
	// satisfy.
	const paramMatch = /,\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/.exec(
		callText,
	);
	const param = paramMatch?.[1];
	if (!param) return [];
	const aliases = new Set<string>([param]);
	// `(?:<[^>]*>)?` tolerates an explicit generic type argument between the
	// call and its parens (`await importActual<typeof import("...")>()`,
	// this repo's own convention) without requiring nested-`>` handling —
	// good enough for the shapes this repo actually writes.
	const aliasPattern = new RegExp(
		`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+${escapeRegExp(param)}\\s*(?:<[^>]*>)?\\s*\\(`,
		"g",
	);
	let match: RegExpExecArray | null;
	while ((match = aliasPattern.exec(callText))) aliases.add(match[1]);
	return [...aliases];
}

/** True when the file mocks `basename` with a factory that OVERRIDES
 *  `symbolName` — names it as an object-literal key AND does not reference
 *  the real module (the factory's import-original parameter, or any local
 *  bound to its awaited result — see `realModuleAliases`) for that same
 *  symbol name anywhere inside the mock call.
 *  `tests/clients/instance-reaper-registry-scan-escalation.test.ts`'s
 *  `readInstanceRegistry: async () => h.state.registry` qualifies (no real
 *  module reference at all); `tests/index-vanished-instance-wiring.test.ts`'s
 *  `sweepOrphans: async () => { await actual.sweepOrphans(); ... }` does
 *  NOT — it names the key but still calls straight through to the real,
 *  unpinned implementation, which is exactly why this repo's ONE real
 *  member of this sweep's population is caught rather than waved through by
 *  its incidental `vi.mock("../clients/instance-reaper.js", ...)`. Review
 *  round 2, F4: also refuses a bare REFERENCE passthrough with no trailing
 *  call (`getGlobalPiLensDir: actual.getGlobalPiLensDir`) and a renamed
 *  binding (`const orig = await importOriginal(); ... orig.symbolName()`) —
 *  neither is a real override, both used to slip through the old
 *  `actual\.symbolName\(` — literal-only check. */
function mockOverridesSymbol(
	commentsBlankedStringsKept: string,
	basename: string,
	symbolName: string,
): boolean {
	const callText = findMockCallText(commentsBlankedStringsKept, basename);
	if (callText === undefined) return false;
	if (!new RegExp(`\\b${escapeRegExp(symbolName)}\\s*:`).test(callText)) {
		return false;
	}
	const aliases = realModuleAliases(callText);
	return !aliases.some((alias) =>
		new RegExp(
			`\\b${escapeRegExp(alias)}\\.${escapeRegExp(symbolName)}\\b`,
		).test(callText),
	);
}

/** Isolated when the file pins its own `PI_LENS_HOME`, overrides
 *  `file-utils.js`'s `getGlobalPiLensDir` (the universal isolator — every
 *  hazardous symbol's target path resolves through it), or — only when
 *  EVERY matched symbol is read-only — overrides `instance-registry.js`'s
 *  `readInstanceRegistry`.
 *
 *  Takes BOTH text variants (review round 2, F2): the `PI_LENS_HOME` pin
 *  check runs over `stringsBlankedCode` (a real pin is code, not a string —
 *  see `PI_LENS_HOME_ASSIGNMENT`'s own doc), while the mock-override checks
 *  still need `commentsBlankedStringsKept` (a `vi.mock` specifier and a
 *  passthrough alias name are read as-is, not blanked). */
function isIsolated(
	commentsBlankedStringsKept: string,
	stringsBlankedCode: string,
	matchedSymbols: readonly string[],
): boolean {
	if (PI_LENS_HOME_ASSIGNMENT.test(stringsBlankedCode)) return true;
	if (
		mockOverridesSymbol(
			commentsBlankedStringsKept,
			"file-utils.js",
			"getGlobalPiLensDir",
		)
	) {
		return true;
	}
	if (
		matchedSymbols.length > 0 &&
		matchedSymbols.every((name) => SYMBOLS_COVERED_BY_READ_MOCK.has(name)) &&
		mockOverridesSymbol(
			commentsBlankedStringsKept,
			"instance-registry.js",
			"readInstanceRegistry",
		)
	) {
		return true;
	}
	return false;
}

/** Currently no exemption: #3042's own recurrence
 *  (`tests/index-vanished-instance-wiring.test.ts`) was fixed by PR #3048
 *  (merged 2026-09-15, before this sweep landed) — its per-case
 *  `process.env.PI_LENS_HOME = caseHome;` clears `isIsolated` below like any
 *  other properly-isolated file. Zero is therefore the live, healthy state;
 *  `REGISTRY_ISOLATION_EXEMPTIONS` stays declared (rather than removed) so a
 *  FUTURE in-flight fix has the same documented, reasoned escape hatch this
 *  one used while #3048 was still open. */
const REGISTRY_ISOLATION_EXEMPTIONS: Readonly<Record<string, string>> = {};

/** The exact pre-#3048 content of `tests/index-vanished-instance-wiring.
 *  test.ts` — #3042's own recurrence, the shape this whole sweep exists to
 *  catch. Committed verbatim as a static fixture
 *  (`tests/fixtures/pre-3048-vanished-instance-wiring.txt`, copied from full
 *  commit `20896a56bd4c64d01026ba9e919b40ce1fa7dfa3`, the last commit before
 *  PR #3048's fix landed) rather than fetched at test time via `git show`:
 *  review round 2, F1 — `ci.yml`'s Unit tests job checks out at the
 *  default shallow depth (no `fetch-depth` override, confirmed at
 *  `.github/workflows/ci.yml`'s `test:` job), so that historical commit is
 *  not reachable there and `git show` would fail every CI run, collecting
 *  zero tests from this whole file. A committed fixture is also the
 *  minimalism answer: no real spawn, no flake-shape admission, no
 *  wall-clock-budget membership to maintain for a file that never changes. */
const PRE_3048_VANISHED_WIRING_CONTENT = fs.readFileSync(
	path.join(TESTS_ROOT, "fixtures", "pre-3048-vanished-instance-wiring.txt"),
	"utf8",
);

describe("no tests/**/*.test.ts file drives a producer's registry against the run-shared PI_LENS_HOME (#3042 recurrence)", () => {
	function scanFlagged(
		files: readonly string[] = testFiles,
		root: string = TESTS_ROOT,
	): string[] {
		const flagged: string[] = [];
		for (const { file, source } of readWalkedFiles(files)) {
			const commentsBlankedStringsKept = stripSource(source, {
				strings: "keep",
			});
			const stringsBlankedCode = stripSource(source, { strings: "blank" });
			const touch = touchesGlobalDirRegistry(
				commentsBlankedStringsKept,
				stringsBlankedCode,
			);
			if (!touch) continue;
			if (
				isIsolated(
					commentsBlankedStringsKept,
					stringsBlankedCode,
					touch.matchedSymbols,
				)
			)
				continue;
			flagged.push(relativePosix(root, file));
		}
		return flagged;
	}

	it("registered-or-fail: every unpinned reach into a producer's registry is named or exempted with a reason", () => {
		assertNonEmptyScan("tests/ registry-isolation walk", testFiles.length, 900);
		const flagged = scanFlagged();
		const audit = auditRegistry({
			sweepName: "tests/ registry isolation",
			flagged,
			registered: [],
			exemptions: REGISTRY_ISOLATION_EXEMPTIONS,
			// Zero is the HEALTHY steady state here (#3048 has merged, so nothing
			// is flagged) — unlike a tagged-seam sweep, this floor would fail on
			// exactly the day the codebase is clean. `minScanned` below is what
			// still catches a broken walk (#1718's shape).
			minFlagged: 0,
			scannedCount: testFiles.length,
			minScanned: 900,
			remediation:
				"Pin this file's own process.env.PI_LENS_HOME in beforeEach/" +
				"afterEach (tests/clients/lsp-budget.test.ts's shape), or mock " +
				"clients/file-utils.js's getGlobalPiLensDir (tests/clients/" +
				"instance-registry.test.ts's shape) — see #3042/#3050.",
		});
		expect(audit.problems).toEqual([]);
	});

	it("red-first proof: the same walk catches the pre-#3048 shape (scratch copy in a private root, never under tests/)", () => {
		// #3042's own recurrence is fixed on master now, so this proves the
		// detector against its real, historical, pre-fix content instead of a
		// hand-shaped stand-in.
		//
		// The copy lives in a PRIVATE root, not under tests/ (#3082). Writing it
		// into the repo's own test tree — which the first version of this proof
		// did, to be walked "exactly like any other file" — made every sibling
		// governance sweep that lists tests/** and then reads each path die with
		// ENOENT whenever it was mid-enumeration during the ~1 ms the scratch
		// file existed: four different suites took the hit on rotating runs
		// (#3082/#3092). The walk is what is under proof, and the walk does not
		// care which root it is given: `walkTestFiles` is the SAME function with
		// the SAME options the production population above is built from, so the
		// claim ("the full `listSourceFiles` walk reaches this file and
		// `scanFlagged` flags it") survives intact, without driving shared state
		// this test does not own.
		const scratchRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-3082-registry-scratch-"),
		);
		const scratchName = "scratch-3050-pre-3048-vanished-wiring.test.ts";
		// A nested directory, so the walk has to recurse to reach it exactly as
		// it recurses into tests/clients/ for the real population.
		const scratchDir = path.join(scratchRoot, "clients");
		fs.mkdirSync(scratchDir, { recursive: true });
		const scratchPath = path.join(scratchDir, scratchName);
		fs.writeFileSync(scratchPath, PRE_3048_VANISHED_WIRING_CONTENT);
		try {
			const freshTestFiles = walkTestFiles(scratchRoot);
			expect(freshTestFiles).toContain(scratchPath);

			const audit = auditRegistry({
				sweepName: "tests/ registry isolation (pre-#3048 scratch copy)",
				flagged: scanFlagged(freshTestFiles, scratchRoot),
				registered: [],
				exemptions: REGISTRY_ISOLATION_EXEMPTIONS,
				minFlagged: 1,
			});
			expect(audit.problems.length).toBeGreaterThan(0);
			expect(audit.unaccounted).toContain(`clients/${scratchName}`);
		} finally {
			removeTempDirSync(scratchRoot);
		}
	});

	it("mutation-proof: loosening the PI_LENS_HOME check to a bare reference falsely clears the pre-#3048 shape", () => {
		// The pre-#3048 file's own
		// `path.join(process.env.PI_LENS_HOME as string, "instances.json")` is a
		// READ, not a pin — the exact false-clear this predicate must refuse.
		const commentsBlankedStringsKept = stripSource(
			PRE_3048_VANISHED_WIRING_CONTENT,
			{ strings: "keep" },
		);
		const stringsBlankedCode = stripSource(PRE_3048_VANISHED_WIRING_CONTENT, {
			strings: "blank",
		});

		expect(
			isIsolated(commentsBlankedStringsKept, stringsBlankedCode, [
				"sweepOrphans",
			]),
		).toBe(false);

		// MUTATION: drop the assignment/key requirement, match the bare
		// identifier instead — the naive version a first draft would reach for.
		const bareReferenceMatches = /\bPI_LENS_HOME\b/.test(stringsBlankedCode);
		expect(bareReferenceMatches).toBe(true); // the identifier IS present...
		// ...so a bare-reference check would WRONGLY call this file isolated,
		// reintroducing exactly the recurrence #3042 shipped.
		expect(bareReferenceMatches).not.toBe(
			PI_LENS_HOME_ASSIGNMENT.test(stringsBlankedCode),
		);
	});

	it("mutation-proof: a mock naming a producer symbol but still falling through to `actual.<symbol>(` does not isolate", () => {
		// The pre-#3048 file mocks instance-reaper.js and NAMES sweepOrphans as a
		// key — a naive check ("is this producer mocked at all, with this key
		// present") would clear it. Only the pass-through check below refuses
		// that, which is exactly why the SAME file is still caught post-#3048
		// via its own env pin below, rather than by this mock at all.
		const commentsBlankedStringsKept = stripSource(
			PRE_3048_VANISHED_WIRING_CONTENT,
			{ strings: "keep" },
		);

		const callText = findMockCallText(
			commentsBlankedStringsKept,
			"instance-reaper.js",
		);
		expect(callText).toBeDefined();
		expect(callText as string).toMatch(/\bsweepOrphans\s*:/);

		// MUTATION: drop the `actual.<symbol>(` pass-through check — "the key is
		// named" alone is treated as an override.
		const naiveOverridden = /\bsweepOrphans\s*:/.test(callText as string);
		expect(naiveOverridden).toBe(true);
		expect(
			mockOverridesSymbol(
				commentsBlankedStringsKept,
				"instance-reaper.js",
				"sweepOrphans",
			),
		).toBe(false);
		expect(naiveOverridden).not.toBe(
			mockOverridesSymbol(
				commentsBlankedStringsKept,
				"instance-reaper.js",
				"sweepOrphans",
			),
		);
	});

	it("the post-#3048 file is caught by neither the reaper mock (still falls through) nor the read-mock fallback, only by its own PI_LENS_HOME pin", () => {
		// Confirms the LIVE file, today, is isolated for the reason the module
		// docstring above claims — not by accident of some OTHER idiom.
		const file = testFiles.find((candidate) =>
			candidate.endsWith("/index-vanished-instance-wiring.test.ts"),
		);
		expect(file, "fixture moved or renamed").toBeDefined();
		// A REQUIRED, committed fixture, not a population member: read it raw so
		// its absence is a clean ENOENT naming the path (#3104 review note (a) —
		// routing it through readWalkedFile turned a missing fixture into a
		// TypeError inside stripSource, which names nothing).
		const source = fs.readFileSync(file as string, "utf8");
		const commentsBlankedStringsKept = stripSource(source, { strings: "keep" });
		const stringsBlankedCode = stripSource(source, { strings: "blank" });

		const touch = touchesGlobalDirRegistry(
			commentsBlankedStringsKept,
			stringsBlankedCode,
		);
		expect(touch?.matchedSymbols).toEqual(["sweepOrphans"]);
		expect(
			mockOverridesSymbol(
				commentsBlankedStringsKept,
				"instance-reaper.js",
				"sweepOrphans",
			),
		).toBe(false);
		expect(PI_LENS_HOME_ASSIGNMENT.test(stringsBlankedCode)).toBe(true);
		expect(
			isIsolated(
				commentsBlankedStringsKept,
				stringsBlankedCode,
				touch?.matchedSymbols ?? [],
			),
		).toBe(true);
	});

	it("mutation-proof: a comment merely naming the isolation idioms and target files does not satisfy the walk (detectors match code, not prose)", () => {
		// This test file's OWN docblocks above name process.env.PI_LENS_HOME,
		// vi.mock("...file-utils.js"...), and every hazardous symbol in prose —
		// if the scan read comments, this describe block would trivially clear
		// or flag every file just by matching its own explanatory text.
		const commentOnly = [
			'// process.env.PI_LENS_HOME = "/pinned";',
			'// vi.mock("../../clients/file-utils.js", () => ({ getGlobalPiLensDir: () => dir }));',
			'// calls registerInstance("/x") and reads "instances.json"',
		].join("\n");
		const commentsBlankedStringsKept = stripSource(commentOnly, {
			strings: "keep",
		});
		const stringsBlankedCode = stripSource(commentOnly, { strings: "blank" });

		expect(isIsolated(commentsBlankedStringsKept, stringsBlankedCode, [])).toBe(
			false,
		);
		expect(
			touchesGlobalDirRegistry(commentsBlankedStringsKept, stringsBlankedCode),
		).toBeUndefined();
	});

	it("reviewer probe (round 2, F2): a documentation STRING narrating a PI_LENS_HOME pin does not isolate an otherwise-identical hazardous file", () => {
		// Two files, identical except for one doc string. Both call a real
		// hazardous symbol and pin NOTHING — both must be flagged the same way.
		const withoutDoc = [
			'import { registerInstance } from "../../clients/instance-registry.js";',
			'registerInstance("/x");',
		].join("\n");
		const withDoc = [
			'import { registerInstance } from "../../clients/instance-registry.js";',
			'const DOC = "run with process.env.PI_LENS_HOME = /tmp/foo for isolation";',
			'registerInstance("/x");',
		].join("\n");

		for (const source of [withoutDoc, withDoc]) {
			const commentsBlankedStringsKept = stripSource(source, {
				strings: "keep",
			});
			const stringsBlankedCode = stripSource(source, { strings: "blank" });
			const touch = touchesGlobalDirRegistry(
				commentsBlankedStringsKept,
				stringsBlankedCode,
			);
			expect(touch?.matchedSymbols).toEqual(["registerInstance"]);
			expect(
				isIsolated(
					commentsBlankedStringsKept,
					stringsBlankedCode,
					touch?.matchedSymbols ?? [],
				),
			).toBe(false);
		}

		// MUTATION: run the assignment check over strings-KEPT text instead
		// (the pre-fix bug) — the two snippets now DISAGREE: the doc-string
		// one wrongly reads as pinned while the plain one correctly does not,
		// exactly the "only one of two identical files flagged" signature the
		// reviewer's probe named.
		const withDocKept = stripSource(withDoc, { strings: "keep" });
		const withoutDocKept = stripSource(withoutDoc, { strings: "keep" });
		expect(PI_LENS_HOME_ASSIGNMENT.test(withDocKept)).toBe(true);
		expect(PI_LENS_HOME_ASSIGNMENT.test(withoutDocKept)).toBe(false);
	});

	it("reviewer probe (round 2, F3): a template-literal path escapes the exact-quote target-file match", () => {
		// `` `${process.env.PI_LENS_HOME}/instances.json` `` never produces the
		// substring `"instances.json"` (no quotes sit around just the
		// filename), so the stricter pre-fix form missed it entirely even
		// though the snippet plainly reaches the shared registry file by hand.
		const templateLiteralSnippet =
			'fs.writeFileSync(`${process.env.PI_LENS_HOME}/instances.json`, "{}");';
		const commentsBlankedStringsKept = stripSource(templateLiteralSnippet, {
			strings: "keep",
		});
		const stringsBlankedCode = stripSource(templateLiteralSnippet, {
			strings: "blank",
		});
		const touch = touchesGlobalDirRegistry(
			commentsBlankedStringsKept,
			stringsBlankedCode,
		);
		expect(touch?.reason).toBe("target-file");

		// MUTATION: require the filename as a COMPLETE `"quoted"` literal (the
		// pre-fix form) — the template-literal snippet no longer matches at all.
		const quotedOnly = TARGET_FILENAMES.some((filename) =>
			commentsBlankedStringsKept.includes(`"${filename}"`),
		);
		expect(quotedOnly).toBe(false);
	});

	it("reviewer probe (round 2, F4a): a bare reference passthrough with no trailing call does not isolate", () => {
		const source = [
			'vi.mock("../../clients/file-utils.js", async (importOriginal) => {',
			"	const actual = await importOriginal();",
			"	return { ...actual, getGlobalPiLensDir: actual.getGlobalPiLensDir };",
			"});",
		].join("\n");
		const commentsBlankedStringsKept = stripSource(source, { strings: "keep" });
		expect(
			mockOverridesSymbol(
				commentsBlankedStringsKept,
				"file-utils.js",
				"getGlobalPiLensDir",
			),
		).toBe(false);

		// MUTATION: require a trailing call (the pre-fix `actual\.symbol\(`
		// literal) — a bare reference passthrough has none, so the naive check
		// finds no fall-through and wrongly reports an override.
		const callText =
			findMockCallText(commentsBlankedStringsKept, "file-utils.js") ?? "";
		const naiveFallsThrough = /\bactual\.getGlobalPiLensDir\s*\(/.test(
			callText,
		);
		expect(naiveFallsThrough).toBe(false);
	});

	it("reviewer probe (round 2, F4b): a renamed real-module binding still counts as a passthrough", () => {
		const source = [
			'vi.mock("../../clients/file-utils.js", async (importOriginal) => {',
			"	const orig = await importOriginal();",
			"	return { ...orig, getGlobalPiLensDir: () => orig.getGlobalPiLensDir() };",
			"});",
		].join("\n");
		const commentsBlankedStringsKept = stripSource(source, { strings: "keep" });
		expect(
			mockOverridesSymbol(
				commentsBlankedStringsKept,
				"file-utils.js",
				"getGlobalPiLensDir",
			),
		).toBe(false);

		// MUTATION: hardcode the alias name to "actual" (the pre-fix spelling)
		// — "orig" never matches it, so the renamed passthrough is wrongly
		// cleared.
		const callText =
			findMockCallText(commentsBlankedStringsKept, "file-utils.js") ?? "";
		const naiveFallsThrough = /\bactual\.getGlobalPiLensDir\b/.test(callText);
		expect(naiveFallsThrough).toBe(false);
	});
});

// #3083, master red 038e28b: the existing source detector cannot see
// writers reached transitively through index.js. Exercise the real handler,
// scheduler, registry, lock and disk with only the clock and OS child mocked.
describe("transitive session_start backstop isolation", () => {
	// The 30-minute cooldown stamp is real, and both cases share one private
	// directory, so without this the second sweep takes the cooldown branch,
	// writes nothing, and the case reads the FIRST case's stamp — measured, and
	// the reason each case dates its stamp against its own start time below.
	// Clear the stamps (never plant one) so each case observes its OWN write.
	// The run-shared root is cleared for the same reason: each case must red on
	// the state it produced, not on a neighbour's.
	//
	// Scoped to THIS run's directories, the same prefix the harness sweep uses
	// (PR #3100 round 3 F2). `backstop-` alone also deleted a concurrent sibling
	// invocation's live cooldown stamp — production writes it once per run, so
	// the sibling never recovered it and its own case then hung until
	// `waitFor exhausted after 10000ms`, reproduced by the reviewer in 1 of 3
	// concurrent pairs and deterministically with an external deleter.
	const ownBackstopPrefix = `backstop-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-`;

	function clearOwnBackstopStamps(): void {
		for (const name of fs.readdirSync(sharedHome))
			if (name.startsWith(ownBackstopPrefix))
				fs.rmSync(path.join(sharedHome, name, "orphan-backstop.json"), {
					force: true,
				});
		fs.rmSync(path.join(sharedHome, "orphan-backstop.json"), { force: true });
	}

	beforeEach(clearOwnBackstopStamps);

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		_resetSessionLifecycleForTests();
	});

	/** Drive the real host handler to a settled backstop sweep, and report the
	 *  directories production actually chose: every `orphan-backstop.lock`
	 *  parent it mkdir'd, and the stamp beside the first of them. */
	async function driveSessionStartSweep(): Promise<{
		lockPaths: string[];
		stamp: string;
		startedAt: number;
	}> {
		// Real wall clock: only setTimeout/clearTimeout are faked below, so this
		// dates the stamp THIS call produces apart from any earlier case's.
		const startedAt = Date.now();
		_resetSessionLifecycleForTests();
		vi.stubEnv("PI_LENS_STARTUP_MODE", "quick");
		const mkdir = vi.spyOn(fs.promises, "mkdir");
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: process.cwd() }),
		);
		await vi.advanceTimersByTimeAsync(30_000);
		const lockPaths = () =>
			mkdir.mock.calls
				.map(([dir]) => String(dir))
				.filter((dir) => path.basename(dir) === "orphan-backstop.lock");
		await waitFor(lockPaths, (paths) => paths.length > 0, {
			yieldControl: () => new Promise((resolve) => setImmediate(resolve)),
		});
		const lock = lockPaths()[0];
		const stamp = path.join(path.dirname(lock), "orphan-backstop.json");
		// Since #3476 the lock is also a generation in `<lock>s`, released just
		// after the old directory is removed. A case that ended between the two
		// left the next case's single attempt (`waitMs: 0`) contended.
		const released = () => {
			const gens = fs.readdirSync(`${lock}s`);
			return gens.every(
				(name) =>
					name.endsWith(".released") || gens.includes(`${name}.released`),
			);
		};
		await waitFor(
			() => fs.existsSync(stamp) && !fs.existsSync(lock) && released(),
			Boolean,
			{ yieldControl: () => new Promise((resolve) => setImmediate(resolve)) },
		);
		return { lockPaths: lockPaths(), stamp, startedAt };
	}

	it("session_start keeps the backstop stamp and transient lock out of the run-shared home", async () => {
		const { lockPaths, stamp, startedAt } = await driveSessionStartSweep();
		expect(
			JSON.parse(fs.readFileSync(stamp, "utf8")).lastSweepAt,
		).toBeGreaterThanOrEqual(startedAt);
		expect(lockPaths).not.toContain(
			path.join(sharedHome, "orphan-backstop.lock"),
		);
		expect(fs.existsSync(path.join(sharedHome, "orphan-backstop.json"))).toBe(
			false,
		);
	}, 30_000);

	// PR #3100 review F1, reproduced: a SYMLINK alias of the run-shared home in
	// PI_LENS_HOME is a different string but the same directory. A string
	// compare in the harness read it as a separate explicit home, so the real
	// stamp and the real lock landed at the shared root through the link.
	it("session_start keeps backstop state out of a symlink alias of the run-shared home", async () => {
		const alias = path.join(sharedHome, `alias-${process.pid}`);
		fs.rmSync(alias, { force: true });
		fs.symlinkSync(sharedHome, alias, "dir");
		try {
			vi.stubEnv("PI_LENS_HOME", alias);
			const { lockPaths, stamp, startedAt } = await driveSessionStartSweep();
			expect(
				JSON.parse(fs.readFileSync(stamp, "utf8")).lastSweepAt,
			).toBeGreaterThanOrEqual(startedAt);
			expect(lockPaths).not.toContain(path.join(alias, "orphan-backstop.lock"));
			expect(lockPaths).not.toContain(
				path.join(sharedHome, "orphan-backstop.lock"),
			);
			expect(fs.existsSync(path.join(sharedHome, "orphan-backstop.json"))).toBe(
				false,
			);
		} finally {
			fs.rmSync(alias, { force: true });
		}
	}, 30_000);

	// PR #3100 round 3 F2, reproduced: this file's own per-case stamp clearing
	// used the bare `backstop-` prefix, so it deleted the LIVE cooldown stamp of
	// a concurrent vitest invocation sharing this checkout's home. Production
	// writes that stamp once per run, so the sibling never got it back and its
	// own settle loop ran out of time. The clearing must see exactly what the
	// harness sweep sees: this run's directories only.
	it("per-case stamp clearing spares a concurrent invocation's cooldown stamp", () => {
		const sibling = path.join(sharedHome, "backstop-0000000000-0-sibling");
		const own = path.join(
			sharedHome,
			`backstop-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-clearing-guard`,
		);
		for (const dir of [sibling, own]) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, "orphan-backstop.json"),
				JSON.stringify({ lastSweepAt: 1 }),
			);
		}
		try {
			clearOwnBackstopStamps();
			expect(fs.existsSync(path.join(sibling, "orphan-backstop.json"))).toBe(
				true,
			);
			expect(fs.existsSync(path.join(own, "orphan-backstop.json"))).toBe(false);
		} finally {
			for (const dir of [sibling, own])
				fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * #2523 AC1: no NEW unbounded `await` on a pi hook path, and no NEW
 * hand-rolled timeout race anywhere in the shipped tree.
 *
 * ## The defect this guards
 *
 * `wrapSessionEventHandler` (`clients/session-event-guard.ts`) absorbs a
 * stale-ctx throw and adds NO deadline and NO abort. Every bound in the
 * codebase lived at a LEAF — a spawn timeout, an LSP wait — so a dependency
 * that wedged BEFORE reaching the leaf was unreachable by all of them.
 * #2523's probes against the real handlers measured the consequence: a wedged
 * dependency on `turn_end` never returned (400 000 ms harness ceiling), and
 * with the ambient abort fired at t=2 s exactly as `index.ts` wires it,
 * `still-blocked after 30011ms` — Escape does not release the hook.
 *
 * `bounded()` (`clients/deadline-utils.ts`) is the fix primitive: it takes
 * BOTH bounds and its type refuses one without the other. This sweep is what
 * makes the primitive load-bearing rather than optional.
 *
 * ## Two families, one table
 *
 * 1. **`hook-await`** — every `await` in `index.ts`, `clients/runtime-*.ts`,
 *    `mcp/server.ts` and `clients/mcp/session.ts`, the four places a
 *    registered hook handler and its direct deps live. Wrapped in
 *    `bounded()`, or written down here.
 * 2. **`hand-rolled-race`** — every `Promise.race([...])` whose own arms
 *    include a `setTimeout` or an `AbortSignal.timeout`, anywhere in
 *    `clients/`, `index.ts`, `mcp/` or `tools/`, outside `deadline-utils.ts`
 *    itself. `bounded()` must become THE one bound primitive rather than a
 *    new sibling of the scattered idioms, so a NEW hand-rolled race is
 *    forbidden from today even though the existing ones are not migrated in
 *    this slice.
 *
 * ## Why the await scan over-includes, deliberately
 *
 * Not every `await` in those four groups is hook-reachable: a slash command
 * in `index.ts` and an MCP tool-request handler in `mcp/server.ts` are not. A
 * real reachability walk was considered and rejected for slice 1.
 * `tests/support/session-state-scan.ts` already documents why an unrestricted
 * call-graph walk answers a different question ("walking EVERY call out of
 * `handleSessionStart` would drag in most of the codebase"), and a walk that
 * follows only SOME edges — bare calls but not methods, not callbacks, not
 * dynamic imports — produces false NEGATIVES, which for a guard is the
 * direction that fails silently.
 *
 * So the scan over-includes WITHIN the files it walks, and the table records
 * the judgement. Each entry names WHICH hook's budget the await spends, or
 * says that none applies and why. That is a fact a reviewer can check against
 * the source; a reachability heuristic's silence is not.
 *
 * ## The walked file set, and the widening slice 2 added
 *
 * Round 1's header claimed "over-inclusion is the safe direction for a guard"
 * without saying that the FILE SET was a partial walk of its own (#2530 review
 * F6): hook work reached through a helper MODULE left the scan's view
 * entirely. Slice 2's first attempt at closing that listed SIX module names by
 * hand — which is defect shape 34, a guard that enumerates spellings. The
 * reviewer planted 18 unbounded awaits in `clients/observed-mutation.ts` and
 * 148 in `clients/lsp/index.ts` — modules that same PR labelled hook-reached —
 * and the sweep stayed green (#2557 review F4).
 *
 * The set is now DERIVED from the import graph: {@link hookHelperModules}
 * resolves every relative specifier in the four hook-handler groups and
 * returns what they reach in ONE hop. That is **202** modules today, holding
 * **1255** unbounded awaits, against the six hand-picked modules' 100 — and
 * the hand-picked list included `clients/dispatch/dispatcher.ts`, which is not
 * even a one-hop import (it is reached through `clients/dispatch/
 * integration.ts`), so it was both under- and mis-inclusive.
 *
 * {@link HELPER_UNBOUNDED} pins every one of those modules that holds at least
 * one, exactly, through the kit's own `auditSymbolCounts`. Zero-count modules
 * are not listed and do not need to be: one gaining an await appears in the
 * measured map and fails as an unaccounted entry. The granularity is
 * per-MODULE rather than per-occurrence deliberately — 1255 `EXEMPT_SITES`
 * entries whose `reason` would all read "slice 3 owns bounding this" is the
 * hand-maintained mirror AGENTS.md's single-source rule exists to prevent —
 * and the trade is stated in {@link SWEEP_HEURISTIC_LIMITS}: a count cannot
 * tell "bounded one, added one" from "changed nothing". The table shrinks to
 * nothing as #2523 threads the hook signal into the deps types, which is the
 * structural answer a file list only approximates.
 *
 * ## A third family: every `bounded()` call, and where its signal comes from
 *
 * `bounded()`'s `signal` is a REQUIRED property typed `AbortSignal |
 * undefined` — the key must be written, so a deadline-only call cannot
 * compile, but a seam holding an optional signal may pass it straight through
 * and then run on ONE live bound whenever the caller genuinely had none.
 * {@link BOUNDED_CALL_SITES} registers every shipped call with the provenance
 * of its signal, so that set cannot grow without someone writing down why. It
 * replaces round 1's `NEVER_ABORTED` sentinel, which enumerated the same fact
 * by making callers name a constant — a SECOND concept for behaviour
 * `bounded()` already had, on an issue whose premise is that one primitive
 * replaces the private copies (#2557 review F2).
 *
 * ## The table is a BASELINE, deliberately
 *
 * Every entry below is today's tree, owned by `#2523 slice 2` — the slice
 * that actually bounds these awaits and folds the hand-rolled races into
 * `bounded()` (AC3-AC8). Slice 1 changes no hook's behavior. The value
 * shipped here is the RATCHET: entry N+1 cannot be added silently. #2523 says
 * it in as many words — "slice 1's red output is the worklist".
 *
 * Keys are content-derived, never line numbers (#2487): a line inserted
 * elsewhere in `index.ts` must not re-key 29 exemptions, and a textual merge
 * of two such re-keys can land a WRONG number with no conflict marker. The
 * key IS `stableOccurrenceKey` — the kit's own function over the RAW lines —
 * with one neighbourhood suffix; see {@link awaitOccurrenceKey} for what that
 * suffix buys and what it costs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type HookBudgetKey,
	HOOK_WALL_BUDGET_MS,
	isHookBudgetKey,
} from "../../clients/hook-budgets.js";
import {
	awaitOccurrenceKey,
	DEFINITION_FILE,
	findBoundedCallLines,
	findHandRolledRaceLines,
	findUnboundedAwaitLines,
	hookHelperModules,
	hookPathFiles,
	localImportTargets,
	scanFiles,
	shippedSourceFiles,
} from "../support/hook-await-scan.js";
import {
	auditRegistry,
	auditSymbolCounts,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * Whose budget an unbounded await spends.
 *
 * A {@link HookBudgetKey} is the load-bearing case: it asserts the await runs
 * under that hook, and the assertion is checked — every value here must be a
 * key of `HOOK_WALL_BUDGET_MS`, so a renamed hook family breaks this table
 * instead of leaving it quietly wrong.
 *
 * The two non-hook cases are stated rather than smuggled in as an invented
 * budget:
 * - `"off-hook"` — not reachable from any registered hook handler at all: a
 *   slash-command body, an MCP tool-REQUEST handler, a CLI entry point. The
 *   await scan over-includes on purpose (see the header); this is where that
 *   shows. Every `hand-rolled-race` entry is `off-hook` unless the race sits
 *   on a hook path.
 * - `"unbudgeted-hook"` — reachable from a registered hook that #2523's
 *   contract gives no wall budget (`tool_call`, `resources_discover`,
 *   `message_end`). Recorded as a gap, not papered over with a number nobody
 *   agreed to.
 */
type AwaitSite = HookBudgetKey | "off-hook" | "unbudgeted-hook";

interface SweepExemption {
	/** Which scan flagged it. */
	family: "hook-await" | "hand-rolled-race";
	/** Which hook's budget it spends. */
	site: AwaitSite;
	/** Why it is still unbounded. Checked for length by `auditRegistry`. */
	reason: string;
	/** The issue that owns closing it. */
	owner: string;
}

/**
 * Known imprecision, stated rather than hidden — the
 * `SWEEP_HEURISTIC_LIMITS` convention from
 * `tests/support/session-state-scan.ts`.
 */
export const SWEEP_HEURISTIC_LIMITS = [
	"Line-granular, not expression-granular. A line carrying two awaits is ONE " +
		"flagged occurrence, and it counts as bounded only if EVERY await on it " +
		"is (the strict direction: `await bounded(a) + await raw()` stays red).",
	"No reachability walk. Every await in the four scanned file groups is a " +
		"candidate; whether a site is actually on a hook path is recorded in the " +
		"exemption table's `site` field, which a reviewer checks against the " +
		"source. Over-inclusion WITHIN those files is the safe direction.",
	"The helper walk is ONE import hop from the four hook-handler groups, not " +
		"the transitive closure. index.ts alone reaches most of clients/ " +
		"transitively, so the closure is 'the codebase' — a whole-repo " +
		"unbounded-await ratchet, a much larger promise than #2523's and one " +
		"whose numbers no reviewer could check. One hop is the set a hook " +
		"handler calls DIRECTLY, which is where the work a hook awaits lives. A " +
		"module reached only at two hops (clients/dispatch/dispatcher.ts, via " +
		"clients/dispatch/integration.ts) is therefore NOT counted here.",
	"The helper family is keyed per-MODULE COUNT, not per occurrence. A count " +
		"cannot tell 'bounded one, added one' from 'changed nothing' — only the " +
		"four hook-handler groups get per-line keys. The trade buys a table of " +
		"~75 numbers instead of ~1255 exemption entries whose reason would all " +
		"read 'slice 3 owns bounding this', which is the hand-maintained mirror " +
		"the single-source rule exists to prevent. #2523's deps-type threading " +
		"removes the need for the coarser half.",
	"A whole `import type …` / `export type …` DECLARATION is excluded from " +
		"the helper walk (#2557 review friction) — a type edge is not a call. " +
		'A MIXED clause (`import { type A, b } from "…"`) is NOT excluded: the ' +
		"declaration itself does not start with `type`, and `b` is a real value " +
		"import, so the module genuinely is called into. The detector does not " +
		"walk INSIDE a multi-line clause for a per-specifier `type` modifier — " +
		"only the declaration's own leading keyword decides it, which is the " +
		"same 'over-inclusion within a file is the safe direction' trade the " +
		"line-granular limit above states: a mixed clause with every named " +
		'specifier `type`-prefixed (`import { type A, type B } from "…"`, no ' +
		"plain specifier at all) still counts as reached, because nothing here " +
		"parses the specifier list.",
	"The `bounded()` call registry does NOT decide whether a call's `signal` " +
		"argument can be `undefined`. That is a type question, and a regex for " +
		"`??`/`||`/`undefined` would call `signal: options.signal` — the " +
		"bootstrap seam, whose parameter is optional and which is the single " +
		"most important site — clean, the false-negative direction a guard must " +
		"never take. EVERY call is registered instead, and its entry states " +
		"where its signal comes from.",
	"`bounded()` is recognised SYNTACTICALLY, by call shape. A helper that " +
		"wraps `bounded()` one level down reads as unbounded here and needs an " +
		"exemption naming the wrapper — mechanically visible, unlike a walk that " +
		"would silently call it clean.",
	"Exactly ONE call shape counts as bounded: `bounded(...)` (#2530 round 3 " +
		"F1). Round 1 also accepted a `withDeadline`/`withTimeout`/`withBudget`/" +
		"`withinRemaining` call whenever the word `signal` appeared anywhere in " +
		"its own parentheses — but none of those helpers takes a `signal` " +
		"parameter at all, so the match was pure text: `withBudget(sweep(cwd, " +
		"{ signal }), 500)` read as bounded because `signal` named the WRAPPED " +
		"work's argument, not anything reaching the race that decides how long " +
		"this await waits. That is the exact deadline-only hole #2523 exists to " +
		"close, reopened by substring. Zero sites in the scanned tree relied on " +
		"it (measured: the flagged set is identical with or without the " +
		"allowance). A bare `Promise.race`/`Promise.any` is NOT accepted even " +
		"when `signal` appears in it: a signal-only race is the mirror image " +
		"of the deadline-only defect this guard exists for, and a new race is " +
		"forbidden by the hand-rolled-race family anyway.",
	"A module reached only through ANOTHER helper is still outside both scans, " +
		"so a hook whose work moves two hops out leaves the guard's view until " +
		"someone widens the walk. #2523's deps-type threading is the structural " +
		"answer — it follows the work across module boundaries in a way an " +
		"import-graph radius cannot — and until it lands the one-hop set is the " +
		"screen.",
	"The hand-rolled-race scan matches `Promise.race(` AND `Promise.any(` " +
		"(#2530 round 3 F3: `Promise.any([work, delay])` is the same " +
		"first-settlement-wins shape as `race` with a timer arm, and round 1 " +
		"matched only `race`) and reads the call's own parentheses PLUS the 25 " +
		"lines above it, because the dominant spelling hoists the timer arm into " +
		"a named local. A timer built further away, in a helper, or in another " +
		"module is invisible to it; a `setTimeout` within 25 lines of an " +
		"unrelated race is a false positive, which is a table entry rather than " +
		"a silent hole. A bare `new Promise` + `setTimeout` with no race at all " +
		"is a delay, not a bound, and is not flagged.",
	"Comments and string literals are blanked first (`stripSource`), so an " +
		"`await` or a `Promise.race` named in prose or inside a string is not a " +
		"call.",
] as const;

/**
 * {@link occurrenceKeys} output -> the judgement about that exact occurrence.
 *
 * When a genuine edit to a flagged line invalidates a key (not a line
 * inserted elsewhere — that churn is what content keying removes), the
 * failing test prints the key the scan now computes; paste it in with a
 * reason, or wrap the call in `bounded()` and delete the entry.
 *
 * A merge that shifts many keys at once (a line inserted near several
 * flagged sites) does not have to be re-keyed by hand: run
 * `node scripts/rekey-hook-await-exemptions.mjs` — it recomputes every
 * entry's key from the live scan and rewrites only keys whose
 * `rel[#symbol]:hash` head (everything before `~context`) still matches
 * exactly one current occurrence; anything else — a genuinely changed line,
 * a removed one, or an ambiguous duplicate — is refused and left for a
 * human (#2530 round 3 F6, tightened round 4 F1: a head match, not a
 * count-matched zip, is what makes a rewrite safe).
 */
const EXEMPT_SITES: Readonly<Record<string, SweepExemption>> = {
	"clients/mcp/session.ts#getMcpSessionContext:3ab92062~01e3e700": {
		family: "hook-await",
		site: "session_start",
		reason:
			"MCP host parity (#2523 AC8): `getMcpSessionContext` awaits the " +
			"analyzer bootstrap that both `runSessionStart` and " +
			"`runTurnEnd` go through. The MCP adapter calls the same " +
			"handlers index.ts does and needs the same bounds.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runSessionStart:fceb216b~1228c6e4": {
		family: "hook-await",
		site: "session_start",
		reason:
			"MCP host parity (AC8): the standalone MCP server's " +
			"session_start entry calls `handleSessionStart` with no " +
			"deadline and no signal, exactly like index.ts:2151.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runSessionStart:cdc1de9a~b8406198": {
		family: "hook-await",
		site: "session_start",
		reason:
			"MCP host parity (AC8): the standalone MCP server's " +
			"session_start entry calls `handleSessionStart` with no " +
			"deadline and no signal, exactly like index.ts:2151.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runSessionStart:1304e7b3~e7e844f0": {
		family: "hook-await",
		site: "session_start",
		reason:
			"MCP host parity (AC8): the standalone MCP server's " +
			"session_start entry calls `handleSessionStart` with no " +
			"deadline and no signal, exactly like index.ts:2151.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runTurnEndNow:fceb216b~047d1dce": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP host parity (AC8): `runTurnEndNow` calls `handleTurnEnd` " +
			"unbounded. `TURN_END_QUEUE_WAIT_MS` bounds ADMISSION to the " +
			"queue, not the work it admits — #2523 says so explicitly.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runTurnEndNow:e40e5ae4~d9c99f9e": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP host parity (AC8): `runTurnEndNow` calls `handleTurnEnd` " +
			"unbounded. `TURN_END_QUEUE_WAIT_MS` bounds ADMISSION to the " +
			"queue, not the work it admits — #2523 says so explicitly.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runTurnEnd:94e0a7e1~4be0ece0": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP host parity (AC8): the queued `runTurnEnd` wrapper awaits " +
			"`runTurnEndNow`; the queue's wait bound is an admission bound, " +
			"not a work bound.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runTurnEndForIpcNow:fceb216b~09a23787": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP host parity (AC8): the IPC turn-end entry reached from " +
			"mcp/server.ts's socket handler; the same unbounded " +
			"`handleTurnEnd` sits beneath it.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runTurnEndForIpcNow:6bfa417c~ce21a427": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP host parity (AC8): the IPC turn-end entry reached from " +
			"mcp/server.ts's socket handler; the same unbounded " +
			"`handleTurnEnd` sits beneath it.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#handleAgentEnd:70abab7e~0e2c385e": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`getAutofixClients()` -> `loadBootstrapClients()` — #2523 " +
			"names this exact site (runtime-agent-end.ts:347) as " +
			"agent_settled's unbounded analyzer bootstrap.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#handleAgentEnd:aeec4a09~51275360": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`runAutofix` on the deferred drain: per-runner spawn timeouts " +
			"exist at the leaf, nothing bounds the phase above them.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#d74e6662~4d0fd5e9": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"The format phase (`runFormatPhase` per file, joined by " +
			"`Promise.all`) — #2523 AC6's aggregate formatter budget lands " +
			"here. `runFormattersWithConcurrency` is a sequential loop with " +
			"per-item 30s timers, no aggregate cap and no signal in the " +
			"race; the 3-wedged-formatter probe measured `still-blocked " +
			"after 45011ms`.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#f0b9e5ad~c7623832": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"The format phase (`runFormatPhase` per file, joined by " +
			"`Promise.all`) — #2523 AC6's aggregate formatter budget lands " +
			"here. `runFormattersWithConcurrency` is a sequential loop with " +
			"per-item 30s timers, no aggregate cap and no signal in the " +
			"race; the 3-wedged-formatter probe measured `still-blocked " +
			"after 45011ms`.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#846909f2~82252dcb": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"The format phase (`runFormatPhase` per file, joined by " +
			"`Promise.all`) — #2523 AC6's aggregate formatter budget lands " +
			"here. `runFormattersWithConcurrency` is a sequential loop with " +
			"per-item 30s timers, no aggregate cap and no signal in the " +
			"race; the 3-wedged-formatter probe measured `still-blocked " +
			"after 45011ms`.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#b2e21790~677753f9": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`resyncLspFile` after a deferred write: the LSP touch has its " +
			"own wait bound, the resync above it does not.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#e36d39b8~05b260ce": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`resyncLspFile` after a deferred write: the LSP touch has its " +
			"own wait bound, the resync above it does not.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#1f35703b~52cc4490": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`applyConservativeActionableWarningFixes` — #2523's " +
			"agent_settled list (runtime-agent-end.ts:871): count-capped at " +
			"5 fixes, with no time bound at all.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-coordinator.ts#f1693e28~c40c7404": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"The turn-end cascade settle race: bounded at 5000ms with NO " +
			"abort arm — #2523's `bounded but no abort race` list. 5000ms " +
			"alone also exceeds turn_end's whole 3000ms budget.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#demandBootstrapDeps:87590bfa~8bddbc42": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`demandBootstrapDeps` — the analyzer-bootstrap request every " +
			"session_start scan goes through.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#readSequenceWithBudget:41c0b191~d5c54d05": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`readSequenceWithBudget`'s race: a real budget with NO abort " +
			"arm. Also flagged by this sweep's hand-rolled-race family, " +
			"which is the fold slice 2 owns.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteWarmFiles:65b03ede~d9e1b333": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteWarmFiles:4140740f~ebb30080": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteWarmFiles:f243aec9~ea3bd76b": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:65b03ede~e98aab9b": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:4140740f~7a6aab16": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:82953f32~eca16c1c": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:bd07d2d4~f4ffd883": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:45016495~3dad128f": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:fe862775~29288f8c": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:8e313ae2~75f282db": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleManagedToolRefresh:2c87cafc~0a59f635": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Managed-tool refresh and the prettier-install probe, scheduled " +
			"from session_start with no wall bound above the spawn.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleManagedToolRefresh:214f440d~73719009": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Managed-tool refresh and the prettier-install probe, scheduled " +
			"from session_start with no wall bound above the spawn.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#probePrettierInstall:d21c1bff~ff3e8c00": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Managed-tool refresh and the prettier-install probe, scheduled " +
			"from session_start with no wall bound above the spawn.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#collectTodoBaselineItems:c41e7059~85944564": {
		family: "hook-await",
		site: "session_start",
		reason:
			"TODO-baseline collection on session_start. `yieldIfOverBudget` " +
			"yields the event loop so the host stays responsive; it does " +
			"not bound how long the scan takes.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#collectTodoBaselineItems:1662b38a~5fce0ef1": {
		family: "hook-await",
		site: "session_start",
		reason:
			"TODO-baseline collection on session_start. `yieldIfOverBudget` " +
			"yields the event loop so the host stays responsive; it does " +
			"not bound how long the scan takes.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#collectTodoBaselineItems:8f714b6e~2567c228": {
		family: "hook-await",
		site: "session_start",
		reason:
			"TODO-baseline collection on session_start. `yieldIfOverBudget` " +
			"yields the event loop so the host stays responsive; it does " +
			"not bound how long the scan takes.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#buildOrRefreshWordIndex:9cf28eab~6a6b0649": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Word-index build/refresh on session_start (#162): a dynamic " +
			"import plus an O(project-files) build. `buildWordIndexAsync` " +
			"yields cooperatively (WORD_INDEX_BUILD_YIELD_BUDGET_MS 8ms) " +
			"but has no total bound.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#buildOrRefreshWordIndex:2ab50d76~c76a94fd": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Word-index build/refresh on session_start (#162): a dynamic " +
			"import plus an O(project-files) build. `buildWordIndexAsync` " +
			"yields cooperatively (WORD_INDEX_BUILD_YIELD_BUDGET_MS 8ms) " +
			"but has no total bound.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#buildOrRefreshWordIndex:9cf28eab~7c40468a": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Word-index build/refresh on session_start (#162): a dynamic " +
			"import plus an O(project-files) build. `buildWordIndexAsync` " +
			"yields cooperatively (WORD_INDEX_BUILD_YIELD_BUDGET_MS 8ms) " +
			"but has no total bound.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#buildOrRefreshWordIndex:b0d4d07b~184f95fd": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Word-index build/refresh on session_start (#162): a dynamic " +
			"import plus an O(project-files) build. `buildWordIndexAsync` " +
			"yields cooperatively (WORD_INDEX_BUILD_YIELD_BUDGET_MS 8ms) " +
			"but has no total bound.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#buildOrRefreshWordIndex:0ae65eec~ea7fbd17": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Word-index build/refresh on session_start (#162): a dynamic " +
			"import plus an O(project-files) build. `buildWordIndexAsync` " +
			"yields cooperatively (WORD_INDEX_BUILD_YIELD_BUDGET_MS 8ms) " +
			"but has no total bound.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScans:3ca5dbcc~76bb3e52": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`scheduleStartupScans` / `scheduleStartupScansWithClients`: " +
			"the session_start scan fan-out and its bootstrap-dependency " +
			"resolution.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:a7ab4c28~6ee68efd":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"`scheduleStartupScans` / `scheduleStartupScansWithClients`: " +
				"the session_start scan fan-out and its bootstrap-dependency " +
				"resolution.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:5b570c81~8a50c30d":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:eb2411d7~0401ab41":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:07db9a50~8a50c30d":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:f0b9e5ad~b7a44067":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:f1d60b5f~a664d1bb":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:b29e379c~bc03be78":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:e8384622~b262f927":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:0558e1b7~bc03be78":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:498f59ca~b262f927":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:f67cf7ff~95882549":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:f3e39dfa~b262f927":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:d7c597d6~b67d7877":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"One heavyweight startup analyzer per await (knip, jscpd, " +
				"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
				"review graph, call graph, codebase model, word index). Each " +
				"has a spawn-level timeout at the leaf and none has a wall " +
				"bound above it; together they are session_start's 5000ms " +
				"budget many times over.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#2c64a178~b262f927": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#19f6a911~bc03be78": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#3373bfda~b262f927": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#f72b8c48~6555f454": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#e28354af~0280fe82": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#156451e5~c3519908": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#81d86b10~69884346": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#d6f3308b~433f3f02": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#dce32182~306f23d3": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#79639cbb~cd388c97": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#6059719b~a69fa0e5": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#4bdb1922~cd166e7d": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleDeferredToolProbes:ca89b6b8~8ef90162": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Deferred tool probes scheduled from session_start. The go/rust " +
			"availability probes are 3000ms each, sequential, and re-armed " +
			"on every full session_start — #2523's `bounded but no abort " +
			"race` list.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleDeferredToolProbesWithClients:645f350d~bd859216":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"Deferred tool probes scheduled from session_start. The go/rust " +
				"availability probes are 3000ms each, sequential, and re-armed " +
				"on every full session_start — #2523's `bounded but no abort " +
				"race` list.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#scheduleDeferredToolProbesWithClients:4666a6c4~0bb843d4":
		{
			family: "hook-await",
			site: "session_start",
			reason:
				"Deferred tool probes scheduled from session_start. The go/rust " +
				"availability probes are 3000ms each, sequential, and re-armed " +
				"on every full session_start — #2523's `bounded but no abort " +
				"race` list.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-session.ts#handleSessionStart:709d55d3~8ab15d67": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:957b92e7~45615f2b": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:78322ab0~6c959e54": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:2a60d0e5~dbbbc4f4": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:54759b53~eacdc51d": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:55cb0cea~03812217": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:76793e0f~10f7b86c": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:41aec4d4~502541ac": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#07098027~a42f4a7e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`readSequenceWithBudget` from the sequence fast path (#451): " +
			"the budget is real (250ms default) but carries no abort arm.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#07098027~195e8353": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`readSequenceWithBudget` from the snapshot-root path: same " +
			"real budget, same missing abort arm.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#e20461cb~6148cbdf": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Session-start summary: go and rust availability probes, 3000ms " +
			"each and sequential, re-armed on every full session_start " +
			"(#2523's `bounded but no abort race` list).",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#bbb6aaed~a993503c": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Session-start summary: go and rust availability probes, 3000ms " +
			"each and sequential, re-armed on every full session_start " +
			"(#2523's `bounded but no abort race` list).",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#2c3fa403~ec8628b8": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Session-start summary: go and rust availability probes, 3000ms " +
			"each and sequential, re-armed on every full session_start " +
			"(#2523's `bounded but no abort race` list).",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCall:a2e5cf7a~ab927364": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCallImpl:4d186e4d~6342f07d": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCallImpl:7d560cfc~fce36234": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCallImpl:909658e3~e86b200c": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCallImpl:750505ab~c899dd87": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCallImpl:1a767ae6~924dc100": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#0c4f0c61~51275360": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#65d1c872~921c1ea5": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#3f848c4d~b3c7028c": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"`requestBootstrapClients` passing `getAmbientAbortSignal()` — " +
			"#2523 AC4's dead-signal site: `setAmbientAbortSignal` is only " +
			"ever called from tool_result, so the signal read here is " +
			"ALWAYS undefined. Fixing it is AC4's job, not slice 1's.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#171055f5~9e0a2421": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#d7b23cdc~b1998233": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#ce0d3f2f~51275360": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#e7b5efbb~e9eba0d8": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#22725cc2~e70f3ef8": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#flushDebouncedToolResults:f0b9e5ad~07c5adfc":
		{
			family: "hook-await",
			site: "tool_result_edit",
			reason:
				"`flushDebouncedToolResults` joins every debounced pipeline " +
				"with `Promise.all` and no aggregate bound. It is awaited from " +
				"agent_end (index.ts:2670) and turn_end (index.ts:2872) as " +
				"well, so its cost lands in three budgets.",
			owner: "#2523 slice 2",
		},
	"clients/runtime-tool-result.ts#dispatchPipelineAnalysis:52da0ba3~78ccd40a": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"`dispatchPipelineAnalysis` awaits the pipeline promise. Runner " +
			"timeouts are per-runner leaves (RUNNER_TIMEOUT_MS 30000), " +
			"which is 3x the edit budget on its own.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#handleToolResult:3c46b254~2a5bfb5e": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"The edit tool_result body — the ONE path #2523's contract " +
			"allows to block the host, and only for 10000ms. Measured write " +
			"p90 2614ms / edit p90 3199ms today, so the budget is a ceiling " +
			"rather than a change.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#handleToolResult:7d560cfc~f14ecaea": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"The edit tool_result body — the ONE path #2523's contract " +
			"allows to block the host, and only for 10000ms. Measured write " +
			"p90 2614ms / edit p90 3199ms today, so the budget is a ceiling " +
			"rather than a change.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#handleToolResult:a1bef279~57385903": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"The edit tool_result body — the ONE path #2523's contract " +
			"allows to block the host, and only for 10000ms. Measured write " +
			"p90 2614ms / edit p90 3199ms today, so the budget is a ceiling " +
			"rather than a change.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#734a21b6~69a83146": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"Observed-mutation settle and dispatch on the edit path. " +
			"`OBSERVED_TURN_BUDGET_MS` (600ms) bounds the CAPTURE, not this " +
			"join.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#57d3f8bf~32875b26": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"Observed-mutation settle and dispatch on the edit path. " +
			"`OBSERVED_TURN_BUDGET_MS` (600ms) bounds the CAPTURE, not this " +
			"join.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#8c164eee~caedcf66": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"Observed-mutation settle and dispatch on the edit path. " +
			"`OBSERVED_TURN_BUDGET_MS` (600ms) bounds the CAPTURE, not this " +
			"join.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#39fdd082~e70743cd": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"Classified-mutation join and the second dispatch on the edit " +
			"path; same leaf-bounded, aggregate-unbounded shape as the " +
			"observed path above.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#310cbbae~e4b0261c": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"Classified-mutation join and the second dispatch on the edit " +
			"path; same leaf-bounded, aggregate-unbounded shape as the " +
			"observed path above.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#runTestTargetsBounded:a0d413d5~f6c4b650": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`await stamp` settles with the run it stamps; the batch's own " +
			"wall budget and batchAbort bound it; wrapping it in bounded() " +
			"would add a second timer per target.",
		owner: "#2523 slice 3",
	},
	"clients/runtime-turn.ts#runTestTargetsBounded:7307dda7~99843961": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`runTestTargetsBounded`'s per-target loop. Its batch budget " +
			"(TEST_RUNNER_BATCH_BUDGET_MS, 90000ms) is 30x turn_end's " +
			"total; test-runner delivery already has an off-hook channel " +
			"(#2366) and #2522 owns selection.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#handleTurnEnd:fde4167d~b1a2c4cd": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`sweepInlineBlockerFreshness` — #2523's turn_end list " +
			"(runtime-turn.ts:789): unconditional, no `signal` parameter, " +
			"uncapped population.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#handleTurnEnd:f02aaccc~a59ea951": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`runtime.settleCascadeRuns` — bounded at 5000ms with no abort " +
			"arm, and 5000ms alone exceeds the 3000ms turn_end budget " +
			"(#2523's `bounded but no abort race` list).",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#5b570c81~b2f3321c": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`knipClient.analyze` — #2523's turn_end list " +
			"(runtime-turn.ts:1355): the 30s timeout lives INSIDE the " +
			"spawn, so anything that wedges before the spawn is unreachable " +
			"by it.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#118c149d~fbb822b8": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"A project-diagnostics analyzer run on turn_end with a " +
			"spawn-level timeout only; the same leaf-bound shape as knip " +
			"above it.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#dfbc3b71~d09e69a7": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"madge dependency-check on turn_end behind a flag: " +
			"`ensureAvailable` and the batch check are both unbounded above " +
			"their spawns.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#ebaaaabd~de3a52db": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"madge dependency-check on turn_end behind a flag: " +
			"`ensureAvailable` and the batch check are both unbounded above " +
			"their spawns.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#156451e5~bf99fb9e": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"Dynamic import of the call-graph analyzer on the turn_end " +
			"path. Module load is unbounded, and #1974's 31.7s warmup was a " +
			"module-compilation cost of exactly this shape.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#9167ea7d~7f6889da": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"Dynamic import of the call-graph analyzer on the turn_end " +
			"path. Module load is unbounded, and #1974's 31.7s warmup was a " +
			"module-compilation cost of exactly this shape.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#3bc6dd13~bff396df": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`buildActionableWarningsReport` on turn_end. #2509 moved its " +
			"DELIVERY off-hook (`publishActionableWarningsReport`); the " +
			"build itself still runs inside the hook.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#82bbe401~723cb9f3": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`drainPendingRunnerFindings(0)` — a zero-WAIT drain, which " +
			"bounds how long it waits for new findings but not how long the " +
			"drain itself takes.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#756411f6~249e7096": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`readCachedDiagnosticsForServers` — #2523's turn_end list " +
			"(runtime-turn.ts:2882).",
		owner: "#2523 slice 2",
	},
	"index.ts#ensureLSPConfigInitialized:a10dd3b9~bb9d4558": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`initLSPConfig` inside `ensureLSPConfigInitialized`, reached " +
			"from session_start (index.ts:2131) and from tool_call. #2523 " +
			"names it in the session_start list of unbounded awaits.",
		owner: "#2523 slice 2",
	},
	"index.ts#d628f09d~02fe26af": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#65b51dab~a327124f": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#a5c3de37~231f1f06": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#ea09dcdf~609209be": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#2dc4f4e6~f95b2c48": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#51210408~9af17d2e": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#1c47f42a~879e01ba": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#2ccc914e~d8df7429": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`configureWarmAttach` — one of the four unbounded " +
			"session_start awaits #2523 names (index.ts:2060).",
		owner: "#2523 slice 2",
	},
	"index.ts#1946ceb9~8beff560": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`ensureLSPConfigInitialized` — #2523's session_start list " +
			"(index.ts:2131).",
		owner: "#2523 slice 2",
	},
	"index.ts#cdc1de9a~0e4e5946": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart` itself: the entire session_start body " +
			"under one await. Slice 2 bounds it at the registered handler " +
			"with the 5000ms budget; wrapping it here as well would " +
			"double-bound the same work.",
		owner: "#2523 slice 2",
	},
	"index.ts#889073a2~ebe0e096": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Installer `ensureTool` for a managed tool during " +
			"session_start. The spawn has a leaf timeout; the dynamic " +
			"module load and resolution above it have none.",
		owner: "#2523 slice 2",
	},
	"index.ts#e3e3db09~8a678173": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`loadSessionState` — #2523's session_start list " + "(index.ts:2245).",
		owner: "#2523 slice 2",
	},
	"index.ts#dd06eafe~0055eaad": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`dropStaleFiles` — #2523's session_start list (index.ts:2252): " +
			"up to 1024 concurrent `fs.stat` with no wall bound. On a " +
			"9p/slow filesystem (#462 measured 1.3ms per stat) that is " +
			"seconds of unbounded startup.",
		owner: "#2523 slice 2",
	},
	"index.ts#4846f0dd~4bafc6ce": {
		family: "hook-await",
		site: "tool_result_read_only",
		reason:
			"THE read-only offender #2523 AC5 names (index.ts:2381 in the " +
			"issue's tree): `loadBootstrapClients()` is awaited for EVERY " +
			"tool result — Read/Grep/Glob/Bash — with no timeout and no " +
			"signal, before the mutation gate in runtime-tool-result.ts. " +
			"AC5's red-first test is at 500ms.",
		owner: "#2523 slice 2",
	},
	"index.ts#eb6fa337~da853dbd": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"`handleToolResult` itself: the whole tool_result body under " +
			"one await. Slice 2 applies the split budget (500ms read-only / " +
			"10000ms edit) at the registered handler, after the mutation " +
			"classification decides which applies.",
		owner: "#2523 slice 2",
	},
	"index.ts#38efb539~455b59f1": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"Reached from `onAgentSettled` (index.ts:3137/3143): the " +
			"observed-mutation settled sweep and its ledger refresh. " +
			"agent_settled is the designated place for settled-time work " +
			"and carries the widest non-edit budget (10000ms), but nothing " +
			"enforces it today.",
		owner: "#2523 slice 2",
	},
	"index.ts#41d6e96f~455b59f1": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"Reached from `onAgentSettled` (index.ts:3137/3143): the " +
			"observed-mutation settled sweep and its ledger refresh. " +
			"agent_settled is the designated place for settled-time work " +
			"and carries the widest non-edit budget (10000ms), but nothing " +
			"enforces it today.",
		owner: "#2523 slice 2",
	},
	"index.ts#c70fadbc~59511e16": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`runDeferredMutationDrain`, called from `onAgentSettled` " +
			"(index.ts:3138). Its `getAutofixClients` closure is the " +
			"`loadBootstrapClients()` #2523 names under agent_settled; " +
			"runtime-agent-end.ts:347 is the consumer.",
		owner: "#2523 slice 2",
	},
	"index.ts#2b868994~aa492d94": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`runDeferredMutationDrain`, called from `onAgentSettled` " +
			"(index.ts:3138). Its `getAutofixClients` closure is the " +
			"`loadBootstrapClients()` #2523 names under agent_settled; " +
			"runtime-agent-end.ts:347 is the consumer.",
		owner: "#2523 slice 2",
	},
	"index.ts#69dd02da~0e26f7e0": {
		family: "hook-await",
		site: "agent_end",
		reason:
			"`flushDebouncedToolResults` — #2523's agent_end entry " +
			"(index.ts:2670): it re-enters the full pipeline unbounded, and " +
			"agent_end's measured p90 is 10043ms against a 1000ms budget.",
		owner: "#2523 slice 2",
	},
	"index.ts#69dd02da~fa7a23dd": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`flushDebouncedToolResults` on the turn_end path: the same " +
			"unbounded pipeline re-entry as the agent_end copy, under the " +
			"3000ms turn_end budget.",
		owner: "#2523 slice 2",
	},
	"index.ts#4846f0dd~0f433171": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`loadBootstrapClients()` on turn_end — the same analyzer " +
			"bootstrap the read-only tool_result path awaits, with the same " +
			"absence of a timeout and a signal.",
		owner: "#2523 slice 2",
	},
	"index.ts#e40e5ae4~44b2f503": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`handleTurnEnd` itself: the entire turn_end body under one " +
			"await, measured p50 3687ms / p90 14246ms against a 3000ms " +
			"budget. Slice 2 bounds it at the registered handler.",
		owner: "#2523 slice 2",
	},
	"index.ts#0aa50b6e~d0186439": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`onAgentSettled` awaits its three phases in sequence with no " +
			"aggregate bound; the 10000ms budget is a TOTAL, not a " +
			"per-phase allowance.",
		owner: "#2523 slice 2",
	},
	"index.ts#2c2d49c9~adf2e1af": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`onAgentSettled` awaits its three phases in sequence with no " +
			"aggregate bound; the 10000ms budget is a TOTAL, not a " +
			"per-phase allowance.",
		owner: "#2523 slice 2",
	},
	"index.ts#652343ba~0f4cd6ac": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`onAgentSettled` awaits its three phases in sequence with no " +
			"aggregate bound; the 10000ms budget is a TOTAL, not a " +
			"per-phase allowance.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#ensureReady:9d37dcc9~2d2d543a": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`ensureLspConfig` inside `ensureReady`, the MCP server's lazy " +
			"init. Reached from the session_start and turn_end IPC entries " +
			"as well as from every tool request (AC8).",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#startIpcServer:69da6a7d~346d0967": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP IPC socket handler: `ensureReady` plus `runTurnEndForIpc` " +
			"per inbound turn-end request. This is the MCP mirror of pi's " +
			"turn_end hook (AC8) and carries the same 3000ms contract.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#startIpcServer:8fc63658~fa9af389": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP IPC socket handler: `ensureReady` plus `runTurnEndForIpc` " +
			"per inbound turn-end request. This is the MCP mirror of pi's " +
			"turn_end hook (AC8) and carries the same 3000ms contract.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#startIpcServer:3c5e37d1~30036a6f": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP IPC socket handler: `ensureReady` plus `runTurnEndForIpc` " +
			"per inbound turn-end request. This is the MCP mirror of pi's " +
			"turn_end hook (AC8) and carries the same 3000ms contract.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:355aebb4~f9eb7744": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:d0096ea8~399bce43": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:d6342815~dae8ad93": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:b7d6cff5~6e3e2098": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:d0096ea8~47b872f7": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:b81286d9~e49fada2": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:0be1c5d6~7e47546e": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:6d8e2d74~7661145d": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:635e0ace~d3f9050a": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:5c4ca6a0~9ac0a7dd": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#d7e00d53~d131daed": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#d5bcaa8e~be1a6327": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#97fa6c9a~d4940394": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#d42985f0~9545d834": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#d0096ea8~ba799d41": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#c56f3208~1b9a2dec": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#d0096ea8~cf386b8b": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`pilens_session_start` tool request: the MCP mirror of the " +
			"session_start hook (AC8), unbounded exactly like its index.ts " +
			"twin.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#8b574bae~7f0e398e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`pilens_session_start` tool request: the MCP mirror of the " +
			"session_start hook (AC8), unbounded exactly like its index.ts " +
			"twin.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#d0096ea8~6d4f5f60": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`pilens_turn_end` tool request: the MCP mirror of the turn_end " +
			"hook (AC8), unbounded exactly like its index.ts twin.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#09e7e2f1~960fbcc1": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`pilens_turn_end` tool request: the MCP mirror of the turn_end " +
			"hook (AC8), unbounded exactly like its index.ts twin.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#73e6f55a~b6e340bc": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-request handler (LSP navigation/diagnostics) and the " +
			"request dispatcher itself. An agent is waiting on its own " +
			"request; no pi hook budget applies.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#d0096ea8~05547e1a": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-request handler (LSP navigation/diagnostics) and the " +
			"request dispatcher itself. An agent is waiting on its own " +
			"request; no pi hook budget applies.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#73e6f55a~c0f0423f": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-request handler (LSP navigation/diagnostics) and the " +
			"request dispatcher itself. An agent is waiting on its own " +
			"request; no pi hook budget applies.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#handleRequest:3543a7ce~154cbab1": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-request handler (LSP navigation/diagnostics) and the " +
			"request dispatcher itself. An agent is waiting on its own " +
			"request; no pi hook budget applies.",
		owner: "#2523 slice 2",
	},
	"race:clients/dispatch/dispatcher.ts#runRunner:5dbd3dcf~c580947c": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"Per-runner RUNNER_TIMEOUT_MS race (30000ms) with no abort arm " +
			"— 10x turn_end's whole budget at one leaf. Slice 2's fold " +
			"worklist.",
		owner: "#2523 slice 2",
	},
	"race:clients/dispatch/integration.ts#7c47013c~8d42d097": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"Cascade-computation race in the dispatch integration layer; a " +
			"hand-rolled timer arm, no abort arm. Slice 2's fold worklist.",
		owner: "#2523 slice 2",
	},
	"race:clients/format-service.ts#FormatService:5dbd3dcf~30d03c7a": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"#2523 AC6's target: `runFormattersWithConcurrency` is a " +
			"sequential loop with a per-item 30s timer, no aggregate cap " +
			"and no signal in the race (`_concurrency` is unused). The " +
			"3-wedged-formatter probe measured `still-blocked after " +
			"45011ms`.",
		owner: "#2523 slice 2",
	},
	"race:clients/lsp-document-symbols.ts#getOpenDocumentSymbols:888067f6~68634f87":
		{
			family: "hand-rolled-race",
			site: "off-hook",
			reason:
				"Document-symbol wait race with a hand-rolled timer arm; the " +
				"LSP family's `maxWaitMs` shape. Slice 2's fold worklist.",
			owner: "#2523 slice 2",
		},
	"race:clients/lsp/index.ts#41c0b191~56c015fc": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"LSP wait race with a hand-rolled timer arm (the `maxWaitMs` " +
			"family #2523's inventory names). Slice 2's fold worklist.",
		owner: "#2523 slice 2",
	},
	"race:clients/quiet-window.ts#buildHeartbeatResourcePatchBounded:888067f6~f7fcd4ba":
		{
			family: "hand-rolled-race",
			site: "off-hook",
			reason:
				"`buildHeartbeatResourcePatchBounded`'s hand-rolled race — " +
				"already named `Bounded`, which is exactly why it should be " +
				"spelled with the shared primitive. Slice 2's fold worklist.",
			owner: "#2523 slice 2",
		},
	"race:clients/runtime-coordinator.ts#f1693e28~c40c7404": {
		family: "hand-rolled-race",
		site: "turn_end",
		reason:
			"The turn-end cascade settle race (5000ms, no abort arm) as a " +
			"hand-rolled race. Its await is separately exempted in the " +
			"hook-await family; both entries close together in slice 2.",
		owner: "#2523 slice 2",
	},
	"race:clients/runtime-session.ts#readSequenceWithBudget:41c0b191~d5c54d05": {
		family: "hand-rolled-race",
		site: "session_start",
		reason:
			"`readSequenceWithBudget`'s hand-rolled race on the " +
			"session_start sequence fast path (#451). Its awaits are " +
			"separately exempted in the hook-await family.",
		owner: "#2523 slice 2",
	},
	"race:mcp/analyze-cli.ts#readHookPayload:5b26dbc8~bab4bd45": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"`readHookPayload`'s stdin-read race in the analyze CLI: a " +
			"standalone process entry point, no pi hook involved. Slice 2's " +
			"fold worklist for uniformity, not for a hook budget.",
		owner: "#2523 slice 2",
	},
};

/**
 * The one reason every {@link HELPER_UNBOUNDED} entry carries, written once.
 *
 * It is genuinely ONE fact for all 75 modules — none of them can be bounded
 * from here, because bounding a helper's await needs the hook's signal to have
 * been threaded into the deps type that reaches it, which is #2523 AC4 and has
 * not landed. Repeating that sentence 75 times with a module name substituted
 * in would be the hand-maintained mirror the single-source rule exists to
 * prevent, not 75 reasons.
 */
const HELPER_EXEMPTION_REASON =
	"Unbounded awaits in a module a registered hook handler imports directly. " +
	"None can be bounded without the hook's own signal reaching them, which is " +
	"#2523 AC4's deps-type threading (TurnEndDeps / AgentEndDeps / " +
	"SessionStartDeps gain a required `signal`, both hosts pass ctx.signal) and " +
	"is not in this PR. This pin is the measured slice-3 worklist: the number " +
	"may only change with a stated reason, so an await added here fails loudly " +
	"and one bounded here is recorded rather than absorbed.";

/**
 * Every one-hop helper module holding at least one unbounded await, and how
 * many (#2557 review F4).
 *
 * The SET is derived by {@link hookHelperModules} from the import graph, never
 * spelled — see this file's header for what the hand-written six-name list
 * missed. Modules measuring ZERO are deliberately absent: one that gains an
 * await appears in the measured map and fails as an unaccounted entry, so
 * listing 127 zeroes would add churn without adding a guard.
 *
 * Pinned through `auditSymbolCounts`, the kit's own file-count mechanism
 * (#1817), rather than a bespoke comparison — same machinery the session-state
 * sweep pins ~72 files with.
 *
 * Round-3 deltas (2026-09-03), all measured, none hand-picked:
 *
 * - `clients/actionable-warnings.ts` 12 → 14. Review F-A's fix adds an outer
 *   `await withDeadline(inner, …)` deadline-only cap around the existing
 *   `await bounded(…)` call in `boundedLspCall`, so the loop's own shrinking
 *   residual budget stops reaching the ledger as a false
 *   `hook-await-exceeded`. `isBoundedAwait` only recognizes the literal
 *   `bounded(` call head (by design — see its own doc comment on why
 *   `withDeadline` was deliberately dropped from that list in round 1), so
 *   the new deadline-only await is honestly unbounded by this heuristic even
 *   though it composes correctly with the still-present `bounded()` call.
 * - `clients/formatters.ts` 118 → 115, from `origin/master`'s #2514
 *   (`05df8268`..`4cd8bdb6`, folding formatters' tool-bin walkers onto one
 *   ceilinged walker), merged into this branch — not a change this PR made.
 * - Eight modules REMOVED entirely (their one-hop edge was ONLY an `import
 *   type`, per the friction fix above): `clients/biome-client.ts` (9),
 *   `clients/complexity-client.ts` (1), `clients/dependency-checker.ts` (21),
 *   `clients/jscpd-client.ts` (4), `clients/knip-client.ts` (6),
 *   `clients/lsp/client.ts` (75), `clients/opengrep-client.ts` (2),
 *   `clients/ruff-client.ts` (6) — 8 modules, 124 awaits, measured with
 *   `scripts/.probe-measure-helpers.mjs` (not committed) against this
 *   branch's `hookHelperModules`. Every one of these is a linter/analyzer
 *   CLIENT class only reached from a hook handler for its exported TYPE
 *   (`clients/runtime-turn.ts`'s `import type { DependencyChecker,
 *   MadgeBatchStats } from "./dependency-checker.js"`, confirmed by hand for
 *   this entry); the actual VALUE-level construction is `bootstrap.ts`'s
 *   dynamic `await import(...)` inside `requestBootstrapClients`, which is
 *   TWO hops from a hook handler (hook handler → `bootstrap.ts` →
 *   the client) and correctly outside the one-hop walk. 202 modules / 1255
 *   awaits (the PR's round-1 baseline) is now 190 modules / 1130 awaits.
 */
const HELPER_UNBOUNDED: Readonly<Record<string, number>> = {
	"clients/actionable-warnings.ts": 14,
	"clients/ast-grep-client.ts": 15,
	"clients/blocker-freshness.ts": 13,
	"clients/bootstrap.ts": 23,
	"clients/cooperative-budget.ts": 3,
	"clients/dead-code-client.ts": 4,
	"clients/dispatch/integration.ts": 20,
	"clients/dispatch/pending-runner-findings.ts": 2,
	"clients/dispatch/runners/psscriptanalyzer.ts": 7,
	"clients/dispatch/runners/utils/lazy-installer.ts": 2,
	"clients/dispatch/runners/utils/runner-helpers.ts": 32,
	"clients/file-time.ts": 1,
	"clients/file-utils.ts": 1,
	"clients/format-service.ts": 5,
	"clients/formatters.ts": 115,
	"clients/gitleaks-client.ts": 4,
	"clients/govulncheck-client.ts": 6,
	"clients/installer/index.ts": 192,
	"clients/installer/managed-tool-refresh.ts": 29,
	"clients/instance-reaper.ts": 26,
	"clients/instance-registry.ts": 23,
	"clients/language-profile.ts": 3,
	"clients/lens-engine.ts": 1,
	"clients/lens-map.ts": 2,
	"clients/lsp-budget.ts": 1,
	"clients/lsp-document-symbols.ts": 2,
	"clients/lsp/cascade-tier.ts": 2,
	"clients/lsp/config.ts": 3,
	"clients/lsp/index.ts": 151,
	"clients/lsp/server.ts": 111,
	"clients/map-with-concurrency.ts": 2,
	"clients/observed-mutation.ts": 18,
	"clients/opaque-mutation-scan.ts": 10,
	"clients/package-manager.ts": 8,
	"clients/partial-edit-apply.ts": 2,
	"clients/performance-report.ts": 8,
	"clients/pipeline.ts": 45,
	"clients/project-changes.ts": 2,
	"clients/project-snapshot.ts": 2,
	"clients/quiet-window.ts": 6,
	"clients/read-expansion.ts": 2,
	"clients/recent-touches.ts": 8,
	"clients/review-graph/builder.ts": 41,
	"clients/safe-spawn.ts": 9,
	"clients/session-state-store.ts": 4,
	"clients/shared-checkout-guard.ts": 7,
	"clients/source-filter.ts": 2,
	"clients/startup-scan.ts": 3,
	"clients/test-runner-client.ts": 4,
	"clients/tree-sitter-shared.ts": 1,
	"clients/trivy-client.ts": 2,
	"clients/warm-attach.ts": 9,
	"clients/widget-state.ts": 3,
	"clients/word-index.ts": 24,
	"clients/zizmor-config.ts": 2,
	"tools/ast-dump.ts": 2,
	"tools/ast-grep-outline.ts": 2,
	"tools/ast-grep-replace.ts": 3,
	"tools/ast-grep-search.ts": 5,
	"tools/effective-config.ts": 1,
	"tools/lens-diagnostic-mark.ts": 2,
	"tools/lens-diagnostics.ts": 10,
	"tools/lsp-diagnostics.ts": 30,
	"tools/lsp-navigation.ts": 33,
	"tools/module-report.ts": 3,
	"tools/project-report.ts": 1,
	"tools/symbol-search.ts": 1,
};

/**
 * Every shipped `bounded()` CALL, and where its `signal` comes from (#2557
 * review F2).
 *
 * `bounded()` takes a REQUIRED `signal` whose type admits `undefined`: the key
 * must be written, so a deadline-only call cannot compile, but a seam holding
 * an optional signal passes it straight through and then runs on ONE live
 * bound whenever the caller genuinely had none. That is weaker than #2523's
 * contract, so it is not forbidden — it is written down, here, per call site.
 *
 * Keyed on the call's `signal` line (`findBoundedCallLines`), so changing WHICH
 * signal a call passes re-keys it and forces the claim below to be re-stated
 * rather than silently inherited.
 */
const BOUNDED_CALL_SITES: Readonly<Record<string, string>> = {
	"call:clients/actionable-warnings.ts#boundedLspCall:2b57f8b9~9137fb1a":
		"`LspEnrichmentDeps.signal`. ALWAYS live on the deferred loop (built " +
		"from the turn signal combined with the deferral controller's). Optional " +
		"for the in-band loop, which passes `args.signal` — present on every " +
		"turn_end path and absent only in a unit harness. Deadline half is live " +
		"either way, and is itself the per-trip minimum of the loop's remaining " +
		"budget and the per-pull timeout.",
	"call:clients/bootstrap.ts#requestBootstrapClients:076f54d7~878c680d":
		"`options.signal`, GENUINELY absent for the three session-start demands: " +
		"`SessionBootstrapAccess.request` takes no signal on purpose (#1394 — a " +
		"session_start can land mid-turn, and binding the outgoing turn's signal " +
		"cancelled every startup scan with no retry). Two live bounds even then, " +
		"because this call supplies the seam's own `bootstrapShutdownController` " +
		"as `shutdownSignal`. The tool_call demand passes the ambient signal.",
	"call:clients/observed-mutation.ts#withBounds:6ec6083f~67028b50":
		"`withBounds(work, ms, signal, site)`'s third parameter, threaded from " +
		"`ArmObservationArgs.signal` / `SettledSweepArgs.signal`. Optional in the " +
		"type; filled by every production hook path (tool_call arm, " +
		"tool_result_edit settle, agent_settled sweeps). The fallback is " +
		"fail-safe, not the normal case, and the wall budget is live regardless.",
	"call:clients/pipeline.ts#resyncLspFile:194d22cb~34c8c753":
		"The AMBIENT turn abort signal, set for the whole tool_result path and " +
		"absent only in a bare unit harness. PI_LENS_LSP_SYNC_BUDGET_MS is the " +
		"bound that is always live.",
	"call:clients/lsp/index.ts#55b587e6~3997fa51":
		"`signal` parameter, defaulting to `getAmbientAbortSignal()`. Caller-supplied " +
		"on the pre-dispatch resync path (passing the turn's ambient signal so Escape mid-turn " +
		"abandons auxiliary warmup without gating the edit hook) and defaulted to the " +
		"ambient signal on the touchFile with-auxiliary path. LSP_SPAWN_BUDGET_MS wall-clock " +
		"bound is live per server.",
};

/** `auditRegistry` takes flat strings; the structure is folded in here. */
function exemptionReasons(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(EXEMPT_SITES)) {
		const budget = isHookBudgetKey(entry.site)
			? `${HOOK_WALL_BUDGET_MS[entry.site]}ms budget`
			: "no declared budget";
		out[key] =
			`[${entry.family}, ${entry.site}, ${budget}, owner ${entry.owner}] ${entry.reason}`;
	}
	return out;
}

// The detector, the key derivation and this file-listing/scan driver are all
// imported from `tests/support/hook-await-scan.ts` — the ONE home shared
// with `scripts/rekey-hook-await-exemptions.mjs` (see that file's header,
// and the usage note above `EXEMPT_SITES`). A vitest test file cannot be
// `import()`ed by a plain Node script, so a second, hand-copied detector in
// the script would be the single-source-of-truth violation AGENTS.md flags.
const awaits = scanFiles(
	REPO_ROOT,
	hookPathFiles(REPO_ROOT),
	findUnboundedAwaitLines,
	"",
);
const races = scanFiles(
	REPO_ROOT,
	shippedSourceFiles(REPO_ROOT),
	findHandRolledRaceLines,
	"race:",
	(rel) => rel === DEFINITION_FILE,
);
const boundedCalls = scanFiles(
	REPO_ROOT,
	shippedSourceFiles(REPO_ROOT),
	findBoundedCallLines,
	"call:",
	(rel) => rel === DEFINITION_FILE,
);

/** rel -> unbounded-await count for every one-hop helper that has any. */
function measureHelperModules(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const absolute of hookHelperModules(REPO_ROOT)) {
		const rel = relativePosix(REPO_ROOT, absolute);
		const count = findUnboundedAwaitLines(
			stripSource(fs.readFileSync(absolute, "utf8")),
		).length;
		if (count > 0) out[rel] = count;
	}
	return out;
}

describe("#2523 AC1 every hook-path await is bounded, and no new hand-rolled race", () => {
	it("scans both file groups and finds both families (a dead scan is not a clean one)", () => {
		// Two floors, two failure modes (#1755 review F4): a broken walk and a
		// broken detector must not share a message.
		expect(awaits.scanned).toBeGreaterThanOrEqual(8);
		expect(races.scanned).toBeGreaterThanOrEqual(200);
		expect(awaits.occurrences.length).toBeGreaterThanOrEqual(1);
		expect(races.occurrences.length).toBeGreaterThanOrEqual(1);
	});

	it("recognises a real bound and nothing else", () => {
		// Mutation guard on the DETECTOR (defect shape 10): each fixture is a
		// shape that appears in the scanned files today, or the shape slice 2
		// will replace it with.
		expect(findUnboundedAwaitLines("await loadBootstrapClients();")).toEqual([
			1,
		]);
		expect(
			findUnboundedAwaitLines(
				'await bounded(loadBootstrapClients(), { ms: 500, signal, hook: "tool_result", label: "bootstrap" });',
			),
		).toEqual([]);
		// A deadline with no signal is HALF a bound, which is the defect.
		expect(findUnboundedAwaitLines("await withBudget(sweep(), 500);")).toEqual([
			1,
		]);
		// #2530 round 3 F2: round 1 accepted this because the word `signal`
		// appeared ANYWHERE in the call's own parentheses — even here, where it
		// names an argument of the WRAPPED work (`sweep`), not anything reaching
		// `withDeadline`'s own race. None of `withDeadline`/`withTimeout`/
		// `withBudget`/`withinRemaining` takes a `signal` parameter at all
		// (`DeadlineOptions` has none), so the match was pure substring — the
		// exact deadline-only hole #2523 exists to close, reopened by text
		// instead of semantics. `bounded()` is the only accepted shape now.
		expect(
			findUnboundedAwaitLines(
				"await withDeadline(sweep(), { ms: 500, signal });",
			),
		).toEqual([1]);
		expect(
			findUnboundedAwaitLines(
				"await withTimeout(sweep(cwd, { signal }), 500);",
			),
		).toEqual([1]);
		expect(
			findUnboundedAwaitLines(
				"await withinRemaining(sweep(cwd, { signal }), deadlineAt);",
			),
		).toEqual([1]);
		// Review round 2 (F3): a bare `Promise.race` is NEVER a bound here,
		// even when the word `signal` appears in it. A signal-only race is the
		// mirror image of the deadline-only defect — the shape
		// `clients/project-diagnostics/fresh-fetch.ts:670` already has, and the
		// one this file's own inventory names as "signal only, no deadline" —
		// so accepting it let a half-bound pass BOTH families at once. Round 1
		// pinned that hole as correct. A new race is forbidden by the
		// `hand-rolled-race` family anyway, which leaves `bounded()` as the only
		// accepted form.
		expect(
			findUnboundedAwaitLines(
				"await Promise.race([sweep(), aborted(signal)]);",
			),
		).toEqual([1]);
		// #2530 round 3 F3: `Promise.any` is the same first-settlement-wins
		// shape as `Promise.race` with a timer arm.
		expect(
			findUnboundedAwaitLines("await Promise.any([sweep(), aborted(signal)]);"),
		).toEqual([1]);
		// Including the timer-bearing spelling: the race family forbids it, and
		// the await family must not quietly call it bounded on the way past.
		expect(
			findUnboundedAwaitLines(
				"await Promise.race([sweep(), timeout(AbortSignal.timeout(5), signal)]);",
			),
		).toEqual([1]);
		// A line is bounded only if EVERY await on it is.
		expect(
			findUnboundedAwaitLines(
				'await bounded(a(), { ms: 1, signal, hook: "h", label: "l" }) + await raw();',
			),
		).toEqual([1]);
		// Not a keyword: a property named `await`, an identifier tail.
		expect(findUnboundedAwaitLines("queue.await(job);")).toEqual([]);
		expect(findUnboundedAwaitLines("const awaited = value;")).toEqual([]);
		// Comments and strings are blanked before the scan reaches them.
		expect(
			findUnboundedAwaitLines(stripSource("// await loadBootstrapClients();")),
		).toEqual([]);
		expect(
			findUnboundedAwaitLines(stripSource('const s = "await sweep();";')),
		).toEqual([]);
	});

	it("recognises a hand-rolled timeout race and nothing else", () => {
		expect(
			findHandRolledRaceLines(
				[
					"const winner = await Promise.race([",
					"\twork(),",
					"\tnew Promise((resolve) => setTimeout(resolve, 5000)),",
					"]);",
				].join("\n"),
			),
		).toEqual([1]);
		expect(
			findHandRolledRaceLines(
				"await Promise.race([work(), abortPromise(AbortSignal.timeout(500))]);",
			),
		).toEqual([1]);
		// #2530 round 3 F3: `Promise.any` is the same first-settlement-wins
		// shape as `Promise.race` with a timer arm, and round 1 matched only
		// `race`.
		expect(
			findHandRolledRaceLines(
				"await Promise.any([work(), new Promise((r) => setTimeout(r, 500))]);",
			),
		).toEqual([1]);
		// The dominant spelling: the timer arm hoisted into a named local a few
		// lines above the race. An inline-only detector called this clean.
		expect(
			findHandRolledRaceLines(
				[
					"const timeoutPromise = new Promise((resolve) => {",
					"\ttimeoutHandle = setTimeout(() => resolve(TIMED_OUT), budgetMs);",
					"});",
					"const raced = await Promise.race([work(), timeoutPromise]);",
				].join("\n"),
			),
		).toEqual([4]);
		// A race with NO timer arm is not a hand-rolled bound — it is ordinary
		// first-past-the-post, and forbidding it would be a different rule.
		expect(
			findHandRolledRaceLines("await Promise.race([primary(), secondary()]);"),
		).toEqual([]);
		// A bare setTimeout with no race is a delay, not a bound.
		expect(
			findHandRolledRaceLines("await new Promise((r) => setTimeout(r, 10));"),
		).toEqual([]);
		expect(
			findHandRolledRaceLines(
				stripSource("// Promise.race([work(), setTimeout(done, 5)])"),
			),
		).toEqual([]);
	});

	it("MUTATION: a bare await planted on a hook path goes red, and bounded() makes it green", () => {
		// The end-to-end proof, through the REAL detector and the REAL audit —
		// not a hand-typed key. Planting the await must fail the guard even
		// though its file is full of already-exempted siblings.
		const rel = "clients/runtime-probe-hook.ts";
		const planted = [
			"export async function onProbeTurnEnd(deps: ProbeDeps): Promise<void> {",
			"\tawait sweepInlineBlockerFreshness(deps);",
			"}",
		].join("\n");
		const plantedRawLines = planted.split("\n");
		const plantedHits = findUnboundedAwaitLines(stripSource(planted));
		expect(plantedHits).toEqual([2]);
		const plantedAudit = auditRegistry({
			sweepName: "hook-await-bounds sweep",
			flagged: plantedHits.map((line) => ({
				key: awaitOccurrenceKey(rel, plantedRawLines, line - 1),
				detail: `${rel}:${line}`,
			})),
			registered: [],
			exemptions: exemptionReasons(),
			minFlagged: 1,
		});
		expect(plantedAudit.unaccounted).toHaveLength(1);
		expect(plantedAudit.problems.join("\n")).toContain("neither");

		// The same await wrapped in bounded() is not flagged at all, so there is
		// nothing left for an exemption to excuse.
		const wrapped = [
			"export async function onProbeTurnEnd(deps: ProbeDeps): Promise<void> {",
			"\tawait bounded(sweepInlineBlockerFreshness(deps), {",
			"\t\tms: HOOK_WALL_BUDGET_MS.turn_end,",
			"\t\tsignal: deps.signal,",
			'\t\thook: "turn_end",',
			'\t\tlabel: "sweepInlineBlockerFreshness",',
			"\t});",
			"}",
		].join("\n");
		expect(findUnboundedAwaitLines(stripSource(wrapped))).toEqual([]);
	});

	it("every exemption names a declared hook budget or a stated non-hook reason", () => {
		const entries = Object.entries(EXEMPT_SITES);
		for (const [key, entry] of entries) {
			expect(
				isHookBudgetKey(entry.site) ||
					entry.site === "off-hook" ||
					entry.site === "unbudgeted-hook",
				`${key}: site "${entry.site}" is not a declared hook budget key`,
			).toBe(true);
			expect(entry.owner, `${key}: no owning issue`).toMatch(/#\d+/);
			expect(
				key.startsWith("race:") === (entry.family === "hand-rolled-race"),
				`${key}: family "${entry.family}" does not match the key namespace`,
			).toBe(true);
		}
		// The binding to clients/hook-budgets.ts must not be vacuous: if every
		// entry were "off-hook" the table would assert nothing about any hook.
		const hookOwned = entries.filter(([, entry]) =>
			isHookBudgetKey(entry.site),
		);
		expect(hookOwned.length).toBeGreaterThanOrEqual(
			Math.max(1, Math.floor(entries.length / 4)),
		);
	});

	it("derives the helper set from the import graph, not from a list of names", () => {
		// #2557 review F4. The round-1 shape was six hand-written module names,
		// which is defect shape 34: it could not see `clients/observed-mutation.ts`
		// or `clients/lsp/index.ts` — modules this PR itself labels hook-reached.
		const helpers = hookHelperModules(REPO_ROOT).map((absolute) =>
			relativePosix(REPO_ROOT, absolute),
		);
		// A dead walk is not a clean one: the resolver returning [] (a stray
		// `strings: "blank"` erases every specifier, which it did on the first
		// cut) would make every count below vacuously correct.
		expect(helpers.length).toBeGreaterThanOrEqual(100);
		// The three modules the hand-written list missed, each reached in one hop
		// and each carrying real unbounded awaits.
		expect(helpers).toContain("clients/observed-mutation.ts");
		expect(helpers).toContain("clients/lsp/index.ts");
		expect(helpers).toContain("clients/formatters.ts");
		// ...and one it WRONGLY included: `clients/dispatch/dispatcher.ts` is
		// two hops out, through `clients/dispatch/integration.ts`.
		expect(helpers).not.toContain("clients/dispatch/dispatcher.ts");
		expect(
			localImportTargets(
				path.join(REPO_ROOT, "clients/dispatch/integration.ts"),
			).map((absolute) => relativePosix(REPO_ROOT, absolute)),
		).toContain("clients/dispatch/dispatcher.ts");
		// ...and one the TYPE-ONLY exclusion above wrongly included before this
		// PR: `clients/lsp/client.ts` is reached from a hook handler only for
		// its exported TYPES (`LSPDiagnostic`/`LSPCodeAction` in signatures);
		// the actual value-level LSP client is `clients/lsp/index.ts`'s
		// `getLSPService()`.
		expect(helpers).not.toContain("clients/lsp/client.ts");
		// A hook handler is not its own helper.
		for (const handler of hookPathFiles(REPO_ROOT)) {
			expect(helpers).not.toContain(relativePosix(REPO_ROOT, handler));
		}
	});

	// #2557 review friction: 9 modules / 128 awaits (`clients/lsp/client.ts`
	// alone contributing 75) reached the one-hop set ONLY through an
	// `import type` clause, never a value import — a hook handler that
	// imports a TYPE from a helper never actually calls into it, so counting
	// it as a hook-reached module is a false positive the reviewer measured
	// tripping 22% of recently merged PRs. A type edge is not a call.
	it("does not count a module reached only through import type / export type", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-hook-await-type-only-"),
		);
		try {
			fs.writeFileSync(
				path.join(dir, "type-only-target.ts"),
				"export interface A {}\n",
			);
			fs.writeFileSync(
				path.join(dir, "value-target.ts"),
				"export const B = 1;\n",
			);
			fs.writeFileSync(
				path.join(dir, "mixed-target.ts"),
				"export interface C {}\nexport const D = 1;\n",
			);
			fs.writeFileSync(
				path.join(dir, "importer.ts"),
				[
					'import type { A } from "./type-only-target.js";',
					'import { B } from "./value-target.js";',
					// A mixed clause: an inline `type` specifier alongside a real
					// value one. The whole DECLARATION does not start with `type`,
					// so this stays a real edge (the module IS called into).
					'import { type C, D } from "./mixed-target.js";',
					'export type { A as AReExport } from "./type-only-target.js";',
					"",
					"export function use(): void {",
					"  void B;",
					"  void D;",
					"}",
					"",
				].join("\n"),
			);
			const targets = localImportTargets(path.join(dir, "importer.ts")).map(
				(absolute) => path.basename(absolute),
			);
			expect(targets).not.toContain("type-only-target.ts");
			expect(targets).toContain("value-target.ts");
			expect(targets).toContain("mixed-target.ts");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pins every one-hop helper module's unbounded-await count", () => {
		const measured = measureHelperModules();
		// Vacuity floor: an empty measurement would make the audit below pass on
		// nothing at all.
		expect(Object.keys(measured).length).toBeGreaterThanOrEqual(50);
		expect(
			Object.values(measured).reduce((total, n) => total + n, 0),
		).toBeGreaterThan(0);
		const audit = auditSymbolCounts({
			sweepName: "hook helper unbounded-await pin (#2523 slice 3 worklist)",
			counts: measured,
			pinned: HELPER_UNBOUNDED,
			remediation:
				"A module a registered hook handler imports DIRECTLY gained or lost " +
				"an unbounded await. Wrap it in bounded() (clients/deadline-utils.ts) " +
				"and lower the pinned number, or raise the number here and say why it " +
				"had to grow. A module that appears with no pin at all is new to the " +
				"one-hop set — add it. " +
				HELPER_EXEMPTION_REASON,
		});
		expect(audit.problems, audit.problems.join("\n\n")).toEqual([]);
		expect(HELPER_EXEMPTION_REASON.length).toBeGreaterThan(120);
	});

	it("registers every shipped bounded() call with the provenance of its signal", () => {
		// #2557 review F2. `bounded()` reads a missing signal as one that never
		// aborts, so a seam with an optional signal runs on ONE live bound
		// whenever its caller had none. Round 1 made that greppable with a
		// `NEVER_ABORTED` sentinel — a second concept for behaviour bounded()
		// already had. Registering the CALLS instead covers the same seams
		// without one, and covers sites that would never have named a sentinel.
		const audit = auditRegistry({
			sweepName: "bounded() call-site registry (#2523)",
			flagged: boundedCalls.occurrences,
			registered: [],
			exemptions: BOUNDED_CALL_SITES,
			scannedCount: boundedCalls.scanned,
			minScanned: 200,
			minFlagged: 1,
			remediation:
				"A new bounded() call site. Add an entry here keyed by the printed " +
				"occurrence key, saying WHERE its `signal` comes from and whether " +
				"that source can be undefined — if it can, this call runs on the " +
				"wall clock alone whenever it is, which is weaker than #2523's " +
				"contract and has to be a written decision rather than a default.",
		});
		expect(audit.problems, audit.problems.join("\n\n")).toEqual([]);
		for (const [key, reason] of Object.entries(BOUNDED_CALL_SITES)) {
			expect(reason.length, `${key}: provenance too thin`).toBeGreaterThan(80);
		}
	});

	it("MUTATION: the bounded() call detector sees calls and nothing that merely looks like one", () => {
		expect(
			findBoundedCallLines(
				[
					"const settled = await bounded(work(), {",
					"\tms: 5,",
					"\tsignal: deps.signal,",
					'\thook: "turn_end",',
					'\tlabel: "l",',
					"});",
				].join("\n"),
			),
		).toEqual([3]);
		// Shorthand `signal` keys on the same line the value comes from.
		expect(
			findBoundedCallLines(
				[
					'await bounded(w(), { ms, signal, hook: "turn_end", label: "l" });',
				].join("\n"),
			),
		).toEqual([1]);
		// No `signal` property at all (a JS caller): keyed at the call head, so
		// it is still registered rather than invisible.
		expect(findBoundedCallLines("await bounded(w(), { ms: 5 });")).toEqual([1]);
		// The neighbours that must NOT match.
		expect(findBoundedCallLines("await boundedLspCall(call, deps);")).toEqual(
			[],
		);
		expect(findBoundedCallLines("const n = boundedNumber(v, 5);")).toEqual([]);
		expect(findBoundedCallLines("await deps.bounded(work(), opts);")).toEqual(
			[],
		);
		expect(findBoundedCallLines("const c = new BoundedFifoMap(10);")).toEqual(
			[],
		);
		expect(findBoundedCallLines(stripSource("// bounded(w(), o);"))).toEqual(
			[],
		);
	});

	it("documents the heuristic's limits", () => {
		expect(SWEEP_HEURISTIC_LIMITS.length).toBeGreaterThanOrEqual(4);
		for (const limit of SWEEP_HEURISTIC_LIMITS) {
			expect(limit.length).toBeGreaterThan(40);
		}
	});

	it("every hook-path await and every hand-rolled race is bounded or exempted", () => {
		const audit = auditRegistry({
			sweepName: "hook-await-bounds sweep (#2523 AC1)",
			flagged: [...awaits.occurrences, ...races.occurrences],
			registered: [],
			exemptions: exemptionReasons(),
			scannedCount: awaits.scanned + races.scanned,
			// index.ts + mcp/server.ts + clients/mcp/session.ts + eight
			// clients/runtime-*.ts, plus ~450 shipped files for the race scan.
			minScanned: 208,
			minFlagged: 1,
			remediation:
				"An await: wrap it in bounded() from clients/deadline-utils.ts — it " +
				"takes the hook's budget from HOOK_WALL_BUDGET_MS " +
				"(clients/hook-budgets.ts) AND the hook's ctx.signal, and its type " +
				"refuses one without the other. A `race:` key: use bounded() (or " +
				"withDeadline for a signal-less leaf) instead of hand-rolling the " +
				"timer arm. Otherwise add an EXEMPT_SITES entry here keyed by the " +
				"printed occurrence key, with its family, the hook whose budget it " +
				"spends, a real reason, and the issue that owns closing it.",
		});
		expect(audit.problems, audit.problems.join("\n\n")).toEqual([]);
	});
});

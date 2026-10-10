import * as path from "node:path";
import { BoundedFifoMap } from "./bounded-cache.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { getTurnId } from "./turn-context.js";

/** Relocatable machine-level root for rules shared by all projects. */
export function getUserRuleRoot(): string {
	return path.join(getGlobalPiLensDir(), "rules");
}

/**
 * The rule families that share one mutable-corpus identity. Closed, so a third
 * family is a compile error here rather than a silent key collision between
 * two writers of one store (AGENTS.md shape 24: enumerate the writers and give
 * them a discriminator before composing the branches).
 *
 * - `tree-sitter` — `clients/tree-sitter-query-loader.ts`'s in-process memo
 *   gate over `<root>/rules/tree-sitter-queries/` plus the user root.
 * - `ast-grep` — `clients/sgconfig.ts`'s source-snapshot fingerprint over the
 *   project, user, and bundled `ast-grep-rules/` trees, shared by config
 *   assembly and `AstGrepRuleManager`'s description metadata.
 */
export type RuleCorpusFamily = "tree-sitter" | "ast-grep";

/**
 * How many (cycle, family, root) fingerprints stay live. A turn contributes
 * two or three (one family per root, and a linked-worktree turn can carry two
 * roots), so 16 retains several turns' worth. The cap is a MEMORY bound, not a
 * correctness one: an evicted key recomputes on its next call and returns the
 * same value. `BoundedFifoMap` is the repo's existing bounded container, so
 * this needs no new admission under AGENTS.md shape 46.
 */
const RULE_CORPUS_CYCLE_ENTRIES = 16;

const ruleCorpusCycleFingerprints = new BoundedFifoMap<string, string>(
	RULE_CORPUS_CYCLE_ENTRIES,
);

/**
 * One-entry read-through slot in front of the bounded map, holding the same
 * value — never a different answer. It exists because the map's key ends in an
 * absolute rule root, and building plus hashing that ~150-character string
 * measured 0.3–0.4 us of a 1.3 us warm `loadQueries` call: replacing the memo
 * call with a same-module function returning a literal measured identically to
 * a literal, while the real cross-module call did not, and shortening only the
 * key recovered the difference. Three `===` compares cost ~0.05 us: the cycle
 * id and the family are usually the SAME string object across calls
 * (`getTurnId()` returns either the interned `"turn:0"` sentinel or the stored
 * per-session id, and `family` is a literal at the call site), so only the root
 * falls through to a memcmp.
 *
 * A cycle that alternates two roots misses this slot on every call and pays the
 * map path. That matches what the loader already does — `TreeSitterQueryLoader`
 * remembers a single `loadedRoot`, so alternating roots already forces a full
 * reload there — and the map stays correct for it.
 */
let cycleSlot:
	| {
			cycle: string;
			family: RuleCorpusFamily;
			root: string;
			fingerprint: string;
	  }
	| undefined;

/**
 * The mutable rule corpus's content fingerprint, computed AT MOST ONCE PER
 * DISPATCH CYCLE and reused by every call inside it (#4212 round 4).
 *
 * WHY A CYCLE AND NOT A CALL. All three alternatives were measured on this
 * machine in one session: 1000 warm `loadQueries` calls in a fresh process over
 * a 170-file project corpus, home and data dirs pinned. Master, which checks
 * nothing, took 1.55 and 2.21 ms across two reps. Round 2's per-call content
 * fingerprint took 1854.26 and 1880.22 ms (~1000x). Round 3's cheaper per-call
 * stat signature took 402.12 and 405.36 ms (~220x). This per-cycle content
 * fingerprint took 2.00 and 2.04 ms — inside master's own rep-to-rep spread. A
 * warm call that must stay at master's cost cannot touch the filesystem at all,
 * so the corpus is fingerprinted once per cycle and the remaining calls compare
 * a string. ADR 0006's condition for persisting a derived value is met: the
 * fresh-process benchmark shows the recompute IS the cost, and each entry
 * carries the cycle it was derived from.
 *
 * THE CYCLE IDENTITY is `getTurnId()` (`clients/turn-context.ts`): already
 * per-turn, already argument-free so a module-level singleton can read it,
 * already `getProcessSingleton`-backed, and already bumped by
 * `RuntimeCoordinator.beginTurn` on both the primary and the
 * concurrent-secondary branch. No timer and no new registry. Distinct sessions
 * get distinct ids, so interleaved turns keep their own entries instead of
 * clearing each other's. The memo itself is plain module scope, not a process
 * singleton: pi can evaluate this module more than once, and per
 * `clients/process-singletons.ts`'s own rule a cache that re-derives the same
 * answer from the filesystem is wasteful when duplicated, not wrong.
 *
 * `force` recomputes AND republishes. `clients/dispatch/runners/tree-sitter.ts`
 * forces on a RuleCache miss, which means the corpus demonstrably moved, so its
 * fresh value becomes the cycle's value: every later warm call in the same
 * cycle — the project scanner, structural search — then sees the edit without
 * paying for another walk.
 *
 * DECLARED RESIDUAL. `getTurnId()` returns the sentinel `"turn:0"` when no host
 * turn identity is in scope (`tests/clients/turn-id-observability.test.ts` pins
 * that meaning), so a process that never runs a host lifecycle event — a bare
 * script, a standalone MCP server — has one process-long cycle and refreshes
 * its corpus at process start only. That is master's behaviour on that route,
 * not a regression: master keyed the loader memo on `loadedRoot` alone in every
 * process, the pi host included. It is chosen over recomputing per call because
 * the alternative is the ~1000x measurement above. Callers that must observe an
 * edit now pass `force` or call the loader's `reload()`.
 */
export function ruleCorpusFingerprintForCycle(
	family: RuleCorpusFamily,
	root: string,
	compute: (root: string) => string,
	force = false,
): string {
	const cycle = getTurnId();
	if (
		!force &&
		cycleSlot !== undefined &&
		cycleSlot.cycle === cycle &&
		cycleSlot.family === family &&
		cycleSlot.root === root
	) {
		return cycleSlot.fingerprint;
	}
	const key = `${cycle}\0${family}\0${root}`;
	let fingerprint = force ? undefined : ruleCorpusCycleFingerprints.get(key);
	if (fingerprint === undefined) {
		fingerprint = compute(root);
		ruleCorpusCycleFingerprints.set(key, fingerprint);
	}
	cycleSlot = { cycle, family, root, fingerprint };
	return fingerprint;
}

/** Test-only: drop every cycle entry so a case starts from a cold memo. */
export function _resetRuleCorpusCycleFingerprintsForTests(): void {
	ruleCorpusCycleFingerprints.clear();
	cycleSlot = undefined;
}

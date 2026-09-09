/**
 * The session-root registry: which project roots does this process serve?
 *
 * #2052. A file is IN-SESSION when it lies within any initialized session cwd.
 * `initLSPConfig` (`clients/lsp/config.ts`) is the single writer, and every
 * entry point funnels through it — `ensureLSPConfigInitialized` (`index.ts`),
 * `ensureReady` (`mcp/server.ts`), `clients/runtime-session.ts`, and
 * `clients/lens-engine.ts` — so registration needs no second call site.
 *
 * WHY THIS IS ITS OWN MODULE, not a helper inside `config.ts`: `clients/lsp/
 * index.ts`'s import surface from `config.js` is mirrored by an explicit
 * `vi.mock` factory in ~58 test files. Importing a new symbol from `config.js`
 * breaks every one of them with "No export is defined on the mock", which is a
 * standing tax on any future export.
 *
 * WHY THE CONFIG PAYLOAD LIVES HERE TOO (#2518). Until this fix the payload
 * lived in `config.ts`'s own 32-entry `workspaceConfigs` LRU while this
 * registry held 128, and the two answered halves of ONE question: the registry
 * decides whether a root still needs initializing (`ensureReady`,
 * `mcp/server.ts`), the payload decides whether the operator's
 * `lsp.disabledServers` denial applies (`isServerDisabled`). Thirty-three
 * `ensureReady` calls on other cwds therefore dropped a LIVE root's denial
 * while the registry still reported the root ready, so nothing re-initialized
 * it and a server the operator had turned off came back — #2415 AC 3's exact
 * prohibition, silently.
 *
 * Tying the two CAPS would not have fixed it. `initLSPConfig` registers the
 * root BEFORE its `await` and writes the payload AFTER, so two interleaved
 * initializations enter the two containers in different orders; with separate
 * containers the same cap still evicts different keys from each. One entry per
 * root — the key IS the registration, the value IS the payload — makes a
 * payload miss for a served root impossible by construction instead of by an
 * ordering agreement between two modules.
 *
 * WHY IT IS NOT A LATCH. The first attempt at #2052 used a single
 * last-writer-wins session cwd that fell back to `process.cwd()`. Two bugs
 * followed directly from that shape, and this module's contract excludes both:
 *
 *  - MULTI-ROOT. A process that initializes projA and then projB serves BOTH.
 *    A latch silently made projA's files foreign the moment projB registered.
 *  - FAIL-OPEN ON EMPTY. An empty registry declines NOTHING. Declining is a
 *    hard refusal to answer, so it must rest on positive evidence that a
 *    session exists AND that the file sits outside it — never on the absence
 *    of evidence. Callers that never declared a session (isolated tests, API
 *    consumers, a request racing initialization) therefore keep the pre-#2052
 *    clamp behavior instead of having `process.cwd()` gate a refusal.
 *
 * This is also the seam #2053 needs: an explicit `analysisRoot` registers here.
 */

import { BoundedFifoMap } from "../bounded-cache.js";
import { incrementDegradationCount } from "../degradation-ledger.js";
import type { RegisteredLSPConfig } from "./config.js";
import { isSameOrWithin } from "./server.js";
import path from "node:path";

/**
 * Insertion-ordered, so eviction drops the OLDEST root. `BoundedFifoMap`
 * (#2442) owns the eviction; this module no longer hand-rolls it. FIFO and not
 * LRU on purpose: eviction order is REGISTRATION order, so a config write for
 * an already-registered root cannot reorder the registry underneath the
 * `ensureReady` memo that reads it.
 *
 * The value is `undefined` between `registerSessionRoot` and the config write
 * that follows the loader's `await` — the same window in which, before #2518,
 * no payload existed for the root at all. {@link sessionRootConfigEntries}
 * skips those entries, so an in-flight root resolves exactly as it did before:
 * to a shorter ancestor root's config, or to none.
 */
const SESSION_ROOT_CAP = 128;
const sessionRoots = new BoundedFifoMap<
	string,
	RegisteredLSPConfig | undefined
>(SESSION_ROOT_CAP);

/**
 * The cap dropped a root this process was serving. Its files fall back to
 * pre-#2052 clamp behavior and its `lsp.disabledServers` denial stops applying
 * until something initializes the root again — which `shouldInitializeSessionRoot`
 * now guarantees the next SESSION START OR TOOL CALL naming that root does,
 * because the registration went with the payload. Nothing else re-initializes:
 * the readers of the denial (`isServerDisabled`, `getServersForFileWithConfig`,
 * `getServerInitOverride`) ask the store, they never load it.
 *
 * A CONSTANT subject, counted rather than latched (#2518 review F3). The
 * subject cannot be the evicted root: the ledger's `recordDegradationOnce` /
 * `incrementDegradationCount` dedupe keys are unbounded, so a per-root subject
 * would grow one key per root a long-lived process ever cycles through — a
 * container bounded on one axis and unbounded on another, which is the shape
 * this whole fix is about. That argument bounds the SUBJECT; it is not an
 * argument for throwing the tally away, and the number of roots this process
 * has had to drop is exactly what an operator tunes the cap against. The
 * ledger keeps one entry per kind/subject and emits durable rows only on
 * power-of-two counts, so counting is as bounded here as latching.
 *
 * Returns the evicted roots so the caller can drop the per-root session
 * bookkeeping that described them — `initLSPConfig` releases each one's
 * `config_resolved` claim (review F1).
 */
function noteEvictedRoots(
	evicted: Array<[string, RegisteredLSPConfig | undefined]>,
): string[] {
	const roots = evicted.map(([root]) => root);
	if (roots.length > 0) {
		incrementDegradationCount({
			kind: "lsp-session-root-evicted",
			subject: `cap=${SESSION_ROOT_CAP}`,
			reason: `session root registry at capacity; dropped ${roots[0]} and will load it again on the next session start or tool call naming that root`,
		});
	}
	return roots;
}

/**
 * Record a session cwd as served. Idempotent; re-registering refreshes nothing.
 * Returns the roots this insertion dropped at the cap, oldest first.
 */
export function registerSessionRoot(cwd: string): string[] {
	const root = path.resolve(cwd);
	// Present already: leave the entry alone. Writing the `undefined`
	// placeholder over a loaded config would blank a served root's denial for
	// the length of the re-initializing load — the #2518 window in miniature.
	if (sessionRoots.has(root)) return [];
	return noteEvictedRoots(sessionRoots.set(root, undefined));
}

/**
 * Store the config `initLSPConfig` just loaded for a root it registered.
 *
 * Re-inserts the root when the cap dropped it while the load was in flight:
 * the caller is a live session declaring this root right now, so the pair
 * belongs in the registry — and it is a PAIR, which is what keeps the payload
 * from outliving the registration or the registration from outliving the
 * payload.
 *
 * Returns the roots this write dropped at the cap, oldest first.
 */
export function setSessionRootConfig(
	cwd: string,
	config: RegisteredLSPConfig,
): string[] {
	return noteEvictedRoots(sessionRoots.set(path.resolve(cwd), config));
}

/**
 * Every served root that has a loaded config, in registration order —
 * `getConfigForFile`'s (`config.ts`) longest-prefix walk. Entries still
 * awaiting their first load are skipped; see the store's doc comment.
 */
export function sessionRootConfigEntries(): Iterable<
	[string, RegisteredLSPConfig | undefined]
> {
	return sessionRoots;
}

/** Return whether this exact root is still served after cap eviction. */
export function isSessionRootRegistered(cwd: string): boolean {
	return sessionRoots.has(path.resolve(cwd));
}

/**
 * True when a readiness memo must run initialization for this root.
 *
 * The memo alone is never enough (#2052 R1, #2518): a readiness set caps
 * itself, and `initLSPConfig` has callers (`clients/runtime-session.ts`,
 * `clients/lens-engine.ts`) that no memo sees, so a memo hit can outlive the
 * registration — and with it the config that carries the operator's denial.
 * Every readiness memo asks this function, never its own `has` alone.
 */
export function shouldInitializeSessionRoot(
	cwd: string,
	readyRoots: { readonly has: (root: string) => boolean },
): boolean {
	const normalized = path.resolve(cwd);
	return !readyRoots.has(normalized) || !isSessionRootRegistered(normalized);
}

/**
 * Is `filePath` outside EVERY registered session root?
 *
 * Returns false (serve it) when the registry is empty — see the fail-open rule
 * in this module's header. Containment uses `isSameOrWithin`, the same
 * comparator the LSP root ceiling uses, which selects `path.win32` by path
 * SHAPE rather than by `process.platform` (shape 2 / #1150).
 */
export function isOutsideAllSessionRoots(filePath: string): boolean {
	if (sessionRoots.size === 0) return false;
	const resolved = path.resolve(filePath);
	for (const root of sessionRoots.keys()) {
		if (isSameOrWithin(root, resolved)) return false;
	}
	return true;
}

/**
 * The registered roots, for the decline telemetry record. Sorted with a
 * code-unit comparator so the emitted string is deterministic across locales
 * (#1883), and capped because the record is BOUNDED — a process with many
 * roots must not emit an unbounded path list.
 */
export function getSessionRootsForTelemetry(limit = 4): string[] {
	return [...sessionRoots.keys()]
		.sort((a, b) => Number(a > b) - Number(a < b))
		.slice(0, limit);
}

/**
 * Clear the registry — the roots AND the configs they carry, which are one
 * store since #2518, so a reset cannot leave the two disagreeing about which
 * roots exist. Called by `resetLSPConfigStateForTests`.
 */
export function resetSessionRootsForTests(): void {
	sessionRoots.clear();
}

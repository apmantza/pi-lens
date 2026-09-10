import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { PathKeyedMap } from "../path-keyed-map.js";
import { normalizeEphemeralMapKey } from "../path-utils.js";

/**
 * #1095: bind LSP diagnostics to the document CONTENT they were computed
 * against, instead of inferring staleness purely from mtime/TTL proxies.
 *
 * A `publishDiagnostics` notification carries an optional `version` (the
 * document version the diagnostics apply to). pi-lens already owns the
 * didOpen/didChange version counter and the exact text it sent at each
 * version, so at SEND time it can fingerprint that text and, when the server
 * echoes a `version`, bind the stored diagnostics to that fingerprint. A
 * consumer can then ask "were these diagnostics computed against what's on
 * disk NOW?" by comparing the fingerprint to the current file bytes — a real
 * content check rather than an mtime proxy.
 */

/**
 * true  → the diagnostics' fingerprint matches the current disk bytes.
 * false → it demonstrably does NOT (the server's view diverged from disk).
 * "unknown" → cannot be determined (server never reported a version, so no
 *   fingerprint was captured; or the file could not be stat'd/read). "unknown"
 *   is the honest #533 fallback — never rendered as false-clean OR false-live —
 *   and preserves EXACTLY the pre-#1095 behavior for servers that never bind.
 */
export type BoundToCurrentDisk = boolean | "unknown";

/**
 * The stored half of a binding: what a per-file diagnostics entry was computed
 * against. Captured at publish time on the owning client (see
 * `LSPClientState.diagnosticBindings`). Both fields are absent for a version-
 * less publish; `contentHash` is present only when a server-reported version
 * matched the client's last-sent version for that document.
 */
export interface StoredDiagnosticBinding {
	/** The `publishDiagnostics.version` the diagnostics were computed against. */
	version?: number;
	/** sha256 of the EXACT didOpen/didChange payload text for that version. */
	contentHash?: string;
}

/**
 * The read-time binding surfaced to consumers: the stored half plus the lazily
 * computed disk verdict.
 *
 * SIDE-CHANNEL CARRIAGE CONTRACT (#1108 shape-5 — copy-loss risk). Two producers
 * on `clients/lsp/index.ts` surface a binding:
 *   - `touchFile` returns a `TouchFileResult` WRAPPER (`{ diags, confirmation,
 *     inconclusive, binding }`, below) — the #1179 structural fix. These flags are
 *     EXPLICIT ENUMERABLE fields on that wrapper, so a `[...]`/`.map`/`.filter`/
 *     `structuredClone`/`JSON` copy of the DIAGNOSTICS (`.diags`) can no longer
 *     drop them: the copy operates on `.diags`, the flags stay on the wrapper.
 *   - `getAllDiagnostics` still attaches `binding` as a lazy, disk-verifying
 *     NON-enumerable getter on each Map entry — deliberately NOT migrated to an
 *     enumerable field, because enumerable would make an incidental spread/serialize
 *     eagerly trigger the per-entry disk stat+hash (a stat storm the cascade's
 *     TTL-gated read exists to avoid). That getter therefore KEEPS the read-off-
 *     original contract:
 *       - READ IT OFF THE ORIGINAL producer entry, never off a derived copy. Any
 *         `{...entry}` / `structuredClone` / `JSON.parse(JSON.stringify(...))`
 *         between the producer and the read SILENTLY DROPS the getter — the consumer
 *         then reads `undefined` (indistinguishable from "unknown") and skips the
 *         #1092 staleness demotion. This is the class that bit as #1094
 *         (`inconclusive`) and #1096 (`binding`); the cascade reads the binding off
 *         the original `entry` BEFORE any copy for exactly this reason
 *         (`clients/dispatch/integration.ts` `readBoundToCurrentDisk`).
 *   - IF A FLAG MUST CROSS A SERIALIZATION BOUNDARY (the warm-attach IPC socket, a
 *     JSON round-trip), re-surface it as an EXPLICIT enumerable field on the
 *     transport DTO — no side-channel (enumerable or not) survives `JSON.stringify`
 *     of a `.diags` array. See `clients/warm-attach.ts`/`clients/mcp/ipc.ts`, which
 *     carry `inconclusive` as an enumerable response field for exactly this reason.
 */
export interface DiagnosticBinding extends StoredDiagnosticBinding {
	boundToCurrentDisk: BoundToCurrentDisk;
}

/**
 * #1179 (shape-5 structural fix): the confirmed shape a diagnostics-collecting
 * `touchFile` resolves to. The diagnostics array plus the two former
 * NON-enumerable side-channel flags (`inconclusive` #570/#1093, `binding` #1095)
 * promoted to EXPLICIT ENUMERABLE fields on a wrapper, so the copy-loss class of
 * #1094/#1096 is impossible BY CONSTRUCTION: a copy of the diagnostics operates on
 * `.diags` and never touches the flags on the wrapper.
 *
 * `diags` is always present (empty array when nothing was collected). `inconclusive`
 * is present-and-true only for a genuinely unconfirmed collect (the notify write
 * and/or diagnostics wait lapsed its deadline). `confirmation` is present only when
 * this touch completed its configured diagnostics/confirmation policy — `"confirmed"`
 * for every spawned server, or `"partial"` when an auxiliary contributed no evidence —
 * cut off by the aux grace timer (#1470), or silent with no stored publication for this
 * content (#1493) — and `unconfirmedServerIds` names it. A partial touch
 * is deliberately NOT `inconclusive`: the primary answered and its findings stand;
 * only the claim of full coverage is withdrawn.
 *
 * #1549 makes that separation total: an auxiliary can NEVER make a touch
 * `inconclusive`, whichever deadline it missed. Only a primary can, and
 * `inconclusiveServerIds`/`inconclusiveReason` name which one and why. See
 * {@link resolveTouchVerdict}, which owns the rule.
 *
 * `confirmation` is required
 * before treating an empty result from a known silent-on-clean server as clean, but is
 * not a substitute for a consumer's stricter scope-specific fallback — notably, an
 * all-scope classic TypeScript touch still needs the tool's synchronous tsserver check.
 * `binding` is present only for a collecting touch that composed one (absent →
 * "unknown", the honest #533 fall-through).
 *
 * A touch that SHORT-CIRCUITS resolves to `{ diags: [] }` with no confirmation
 * metadata — that is `shouldSkipTouch`, which requires `waitForDiagnostics ===
 * false`, i.e. a non-collecting (`diagnostics: "none"`) touch whose content every
 * spawned server already has. A debounced COLLECTING touch is a different thing
 * and does NOT short-circuit: the notify is skipped for the servers that already
 * hold the content, but the diagnostics wait still runs and the touch can resolve
 * `confirmation: "confirmed"` on its own evidence. That is sound because the
 * debounce entry is per-server and recorded only when that server's write
 * actually landed (#1253/#743) — a skipped notify therefore means "this server
 * demonstrably has this content", which is exactly the premise the silent-clean
 * gates need.
 */
export interface TouchFileResult {
	diags: import("./client.js").LSPDiagnostic[];
	/** Primary/custom servers with no pull or observed push diagnostics. */
	diagnosticsUnsupportedServerIds?: string[];
	/** The file was declined because its nearest root is outside the session. */
	skipReason?: "outside-project-root";
	confirmation?: "confirmed" | "partial";
	inconclusive?: boolean;
	/**
	 * #1549: WHICH servers made this touch inconclusive. Present only alongside
	 * `inconclusive: true`, and only ever naming PRIMARY-role servers — an
	 * auxiliary that never reported narrows the verdict to `"partial"` via
	 * {@link touchCoverageGap} instead, so it can never appear here. Empty/absent
	 * on an inconclusive touch means the attribution could not be derived (a
	 * client without the per-path publication stamp), which fails closed to the
	 * pre-#1549 "the touch is inconclusive, cause unattributed" state.
	 */
	inconclusiveServerIds?: string[];
	/**
	 * #1549: which deadline produced the verdict — the notify write that never
	 * landed, the diagnostics wait that lapsed, or both. Named so a forensic sweep
	 * of `latency.log`/`cascade.log` reads the cause instead of inferring it from
	 * duration histograms.
	 */
	inconclusiveReason?: TouchInconclusiveReason;
	/**
	 * #1470/#1493: server ids this touch carries NO evidence for. Populated (and
	 * `confirmation` narrowed to `"partial"`) for every auxiliary that never
	 * reported — its push wait cut off by the aux grace timer (R8/#714's
	 * `auxCutOffServerIds`) or settled with nothing published — and that has no
	 * stored publication for this touch's content either. See
	 * {@link auxiliaryCoverageGap}, which owns the rule. Absent when every spawned
	 * server answered for itself.
	 *
	 * #1533 extends the same evidence to `clientScope: "all"` — the batch/directory
	 * scan surface, where auxiliaries are spawned but the grace wait is never
	 * entered. It derives the outcomes from post-wait state instead of waiting a
	 * second time, so an `"all"`-scope sweep reports a silent scanner without
	 * paying back the fan-out latency #1459's resync gate recovered.
	 *
	 * #1459 adds the two doors that open BEFORE any wait: a scanner whose circuit
	 * breaker was open (so it never attached at all) and one whose `didOpen` resync
	 * the fan-out gate deferred (so it never received this content). Neither used
	 * to mark the result, which is how a 15 s opengrep cooldown read as a clean
	 * security verdict for every file a cascade sweep touched inside it. A deferred
	 * auxiliary reaches {@link auxiliaryCoverageGap} as outcome `"deferred"`, so a
	 * stored publication whose content hash matches these exact bytes still keeps
	 * it covered — the same exemption `cut_off` and `silent` get.
	 */
	unconfirmedServerIds?: string[];
	/**
	 * #2810: the subset of {@link TouchDiagnosticsResult.unconfirmedServerIds}
	 * this touch handed to the collect-later store, i.e. the only scanners a
	 * turn-end drain can still deliver findings for (`cut_off`, `silent` or
	 * `demoted`, each with no publication for these bytes). Deliberately NOT the
	 * #1459 resync deferrals: those never received the content, are never marked
	 * collect-later, and nothing arrives for them — they stay in the silent half
	 * of the coverage notice, which is what says the result is incomplete.
	 */
	deferredServerIds?: string[];
	binding?: DiagnosticBinding;
}

/**
 * #1549: which deadline made a touch inconclusive. `"mixed"` means both a
 * primary's notify write and the diagnostics wait lapsed on this touch.
 */
type TouchInconclusiveReason = "notify-write" | "diagnostics-wait" | "mixed";

/** The inputs {@link resolveTouchVerdict} decides a touch's honesty verdict from. */
export interface TouchVerdictInput {
	/**
	 * PRIMARY-role servers whose `didOpen`/`didChange` write did not land inside
	 * the notify budget (timed out or rejected). Auxiliary write failures are
	 * deliberately NOT passed here — they are coverage gaps.
	 */
	primaryNotifyWriteTimedOutServerIds: readonly string[];
	/** Did the diagnostics wait lapse in a way attributable to a primary? */
	diagnosticsTimedOut: boolean;
	/**
	 * PRIMARY-role servers that produced no publication evidence for this touch
	 * when the wait lapsed. May be empty when the attribution is unknowable
	 * (a client with no per-path publication stamp) — the verdict then still
	 * stands on `diagnosticsTimedOut`, just unattributed.
	 */
	diagnosticsUnansweredServerIds: readonly string[];
}

/** The verdict fields {@link resolveTouchVerdict} produces. */
export interface TouchVerdict {
	inconclusive: boolean;
	inconclusiveServerIds?: string[];
	inconclusiveReason?: TouchInconclusiveReason;
}

/**
 * #1549: the ONE rule that decides whether a touch is inconclusive, and who is
 * responsible.
 *
 * The rule this replaced was `notifyWriteTimedOut || diagnosticsTimedOut` with
 * both flags TOUCH-WIDE over every spawned server, so one slow auxiliary
 * discarded every good answer in the touch: a clean typescript reply beside an
 * opengrep scan that needed 2s read as "nothing is known about this file". Over
 * 6,079 cascade neighbour sweeps that produced a 97.6% inconclusive rate
 * (ordinary edit-time touches in the same window: 15%).
 *
 * The verdict is therefore decided from the PRIMARY population only. An
 * auxiliary that never reported is a named COVERAGE GAP — `confirmation:
 * "partial"` plus {@link touchCoverageGap} — which withdraws the claim of full
 * coverage while the primary's findings still flow. That is the #533 honesty
 * doctrine cutting both ways: overclaiming ("confirmed" while a scanner was
 * silent) and underclaiming ("inconclusive" while the language server answered)
 * are both dishonest.
 *
 * Keep this a pure function: it is the single place a consumer's reading of
 * `inconclusive` can be audited against, and it is unit-tested directly.
 */
export function resolveTouchVerdict(input: TouchVerdictInput): TouchVerdict {
	const notifyIds = [...new Set(input.primaryNotifyWriteTimedOutServerIds)];
	const waitIds = input.diagnosticsTimedOut
		? [...new Set(input.diagnosticsUnansweredServerIds)]
		: [];
	if (notifyIds.length === 0 && !input.diagnosticsTimedOut) {
		return { inconclusive: false };
	}
	const serverIds = [...new Set([...notifyIds, ...waitIds])];
	const reason: TouchInconclusiveReason =
		notifyIds.length > 0 && input.diagnosticsTimedOut
			? "mixed"
			: notifyIds.length > 0
				? "notify-write"
				: "diagnostics-wait";
	return {
		inconclusive: true,
		...(serverIds.length > 0 && { inconclusiveServerIds: serverIds }),
		inconclusiveReason: reason,
	};
}

/**
 * #1470: the single source of truth for "which servers did this touch NOT hear
 * from". Read this instead of comparing `confirmation` to a string literal — a
 * consumer that tests `confirmation === "confirmed"` is correct only by accident
 * (it happens to fail closed for `"partial"`), and one that tests `!inconclusive`
 * is outright wrong, because a partially-confirmed touch is deliberately NOT
 * inconclusive: the primary's answer is still trustworthy and must survive.
 */
export function touchCoverageGap(
	result: TouchFileResult | undefined,
): readonly string[] {
	return result?.unconfirmedServerIds ?? [];
}

/**
 * #1470: did this touch complete its configured confirmation policy at all —
 * `"confirmed"` (for every spawned server) or `"partial"` (for every server
 * except the named cut-off auxiliaries)?
 *
 * This is deliberately NOT `confirmation === "confirmed"`. A consumer asking
 * "did the PRIMARY confirm?" must answer yes for a partial touch: `partial`
 * implies neither the notify write nor the diagnostics wait lapsed, so the
 * silent-clean gates ran to completion exactly as they do for a full
 * confirmation. Reading `=== "confirmed"` there looks safely fail-closed but
 * reports "the language server could not confirm clean" when the truth is "the
 * language server confirmed clean and a scanner never reported" — the same overclaim
 * pointing the other way. Pair this with {@link touchCoverageGap}, which names
 * what the touch does not speak for.
 */
export function touchCompletedConfirmationPolicy(
	result: TouchFileResult | undefined,
): boolean {
	return result?.confirmation !== undefined;
}

/**
 * #1458: how an auxiliary's push wait ended for one touch, decided from
 * EVIDENCE (did a publication land) rather than from how the raced promise
 * settled. Recorded per auxiliary per touch on `lsp_aux_wait_outcome`.
 *   - `answered` → a fresh publication landed for this touch. An EMPTY
 *     publication counts: a scanner that ran and found nothing still bumps
 *     `diagnosticsVersion`, which is what makes "clean" distinguishable from
 *     "never spoke".
 *   - `silent`   → the wait settled with nothing published for this touch. The
 *     usual cause is the auxiliary's own budget lapsing, but not the only one: a
 *     debounce-skipped notify (#743/#1253) leaves the auxiliary nothing new to
 *     answer, and a wait satisfied by a non-empty cache can settle at ~0ms, so
 *     `silent` does NOT imply the auxiliary spent its budget. It means only
 *     that no publication landed during this wait — which is why the coverage
 *     policy below pairs it with `publishedThisContent`.
 *   - `cut_off`  → the aux grace timer won; the auxiliary's own wait never got
 *     to answer for itself. Only the `with-auxiliary` grace wait can produce
 *     this. The `"all"`-scope aggregate path (#1533) arms no ceiling of its own,
 *     so it emits only the other three shapes — see the `waitShape` field on
 *     `lsp_aux_wait_outcome`, which names the producer.
 *   - `deferred` (#1459) → the fan-out gate deferred this auxiliary's `didOpen`
 *     resync, so it was never sent these bytes and is not waited on at all. Kept
 *     distinct from `silent` deliberately: `silent` is the reserved signal for a
 *     scanner that HAD the content and published nothing, which is the whole
 *     subject of #1493 — recording a deferral there would corrupt it.
 */
type AuxiliaryWaitOutcome =
	| "answered"
	| "silent"
	| "cut_off"
	| "deferred"
	| "demoted";

/** One auxiliary's contribution to a touch, as {@link auxiliaryCoverageGap} reads it. */
export interface AuxiliaryWaitEvidence {
	serverId: string;
	outcome: AuxiliaryWaitOutcome;
	/**
	 * #1493: independent proof this auxiliary already published for EXACTLY the
	 * content this touch carries — a stored binding whose `contentHash` equals
	 * the touch's content hash. Such an auxiliary has reported on this file's
	 * current bytes, so a wait that produced nothing new withholds nothing.
	 * Absent/false → this touch has no publication of its own to point at.
	 */
	publishedThisContent?: boolean;
}

/**
 * #1493: the single policy deciding which auxiliaries a touch carries NO
 * evidence from. Both no-answer shapes belong here, because they are the same
 * fact about coverage:
 *   - `cut_off` (#1470) — our grace timer ended the wait.
 *   - `silent` — the auxiliary's own budget lapsed with nothing published.
 *   - `deferred` (#1459) — the fan-out gate never sent it these bytes.
 * The rule is written as `outcome !== "answered"`, not as a list, so a new
 * no-answer shape fails closed by default instead of needing to be remembered
 * here — which is how `deferred` joined without touching this filter.
 * An auxiliary that never reported has told us nothing about the file, and
 * whether a SIBLING answered fast enough for the wait to settle early is
 * irrelevant to that. Before this policy, a silent auxiliary was a gap only by
 * accident: it burned the whole touch deadline when it was the only one, which
 * tripped `diagnosticsTimedOut`. With a fast sibling the wait settled early and
 * the silence went unrecorded, so the touch claimed an unqualified
 * `"confirmed"` for a scanner that said nothing (#1493, the #1470 shape on the
 * sibling outcome).
 *
 * NOT an overcorrection into demoting every clean file: `answered` is decided
 * by a publication landing, not by findings existing, so an auxiliary that ran
 * to budget and published an empty set is covered and its touch stays
 * `"confirmed"`. `publishedThisContent` covers the second honest case — an
 * auxiliary whose publication for these exact bytes is already stored (the
 * touch's notify was debounce-skipped, or its late publication was carried in),
 * which has reported even though nothing new landed during this wait.
 *
 * The `publishedThisContent` exemption applies to BOTH no-answer shapes, for the
 * same reason it applies to either: the question is whether this auxiliary has
 * reported on these exact bytes, and how a wait we abandoned would have ended is
 * irrelevant once a verified publication for them exists. Exempting `silent` but
 * not `cut_off` on identical evidence would report the same coverage two ways
 * depending on which timer happened to win. This stays fail-closed — it
 * un-narrows only against a content-hash match, never against a timer.
 */
export function auxiliaryCoverageGap(
	evidence: readonly AuxiliaryWaitEvidence[],
): string[] {
	return evidence
		.filter(
			(aux) => aux.outcome !== "answered" && aux.publishedThisContent !== true,
		)
		.map((aux) => aux.serverId);
}

/**
 * Fingerprint the EXACT text handed to didOpen/didChange. sha256 over the raw
 * string — no normalization — so the disk comparison (which reads the file with
 * the SAME raw `utf-8` transform pi-lens builds LSP payloads with) round-trips
 * CRLF and BOM bytes identically. See `createDiskBindingCache`.
 */
export function hashDiagnosticContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Compose the merged `boundToCurrentDisk` across every client contributing to a
 * merged diagnostics result (primary + auxiliaries). The merged set is only as
 * trustworthy as its least-bound contributor:
 *   - ANY contributor demonstrably mismatches disk        → false
 *   - otherwise, all contributors are "unknown" (or none) → "unknown"
 *   - otherwise (≥1 bound, none mismatched)               → true
 * Unknowns never block a `true`: a version-less auxiliary alongside a bound
 * primary must not erase the primary's binding, only a real mismatch does.
 */
export function composeBoundToCurrentDisk(
	values: readonly BoundToCurrentDisk[],
): BoundToCurrentDisk {
	if (values.some((v) => v === false)) return false;
	if (values.every((v) => v === "unknown")) {
		return "unknown";
	}
	return true;
}

/** One-word summary of a binding verdict for latency/observability logs. */
export function bindingStateLabel(
	value: BoundToCurrentDisk,
): "bound" | "mismatch" | "unknown" {
	if (value === true) return "bound";
	if (value === false) return "mismatch";
	return "unknown";
}

/**
 * Lazily verify a stored binding against current disk, memoizing the disk
 * fingerprint per (file, mtime) so repeated reads within a sweep don't re-hash
 * unchanged files. Cheapness contract (#1095): stat the file first and only
 * read+hash when the mtime differs from the memoized entry.
 *
 * READ-TRANSFORM SYMMETRY (the CRLF/BOM invariant): pi-lens builds every LSP
 * didOpen/didChange payload from `fs.readFile(path, "utf-8")` (raw UTF-8 — no
 * BOM strip, no EOL normalization). This verifier reads disk with the identical
 * `readFileSync(path, "utf-8")` so a Windows CRLF(+BOM) file whose bytes are
 * unchanged fingerprints identically and binds `true`. Any divergence here
 * would make every Windows file spuriously mismatch.
 */
export interface DiskBindingCache {
	boundToCurrentDisk(
		filePath: string,
		stored: StoredDiagnosticBinding,
	): BoundToCurrentDisk;
}

/**
 * Bound on the per-(file,mtime) disk-fingerprint memo. The memo grows by one
 * entry per distinct tracked file; a full clear on overflow (rather than an LRU)
 * is fine because each entry is a pure, cheaply-recomputed derivation of disk
 * bytes — the worst case after a clear is one extra re-hash per file. Keeps the
 * map from growing unbounded across a long-lived session.
 */
const DISK_BINDING_MEMO_MAX = 4096;

export function createDiskBindingCache(): DiskBindingCache {
	// #1025: key through PathKeyedMap + normalizeEphemeralMapKey so two forms of
	// the same path (`SUB\a.ts` vs `sub/a.ts`) can't produce a duplicate memo or a
	// false miss. Ephemeral (slash-fold + win32-lowercase, no realpath I/O) — the
	// keys are file paths this process is already stat'ing on the hot read path.
	// #2300: the memo guards a CONTENT HASH recompute, so a stale memo serves a
	// stale hash — `size` is the cheap second axis alongside `mtimeMs`, from the
	// SAME stat call, so a same-mtime-bucket external rewrite is not masked.
	const diskHashByPath = new PathKeyedMap<{
		mtimeMs: number;
		size: number;
		hash: string;
	}>(normalizeEphemeralMapKey);
	return {
		boundToCurrentDisk(filePath, stored) {
			// No fingerprint captured (version-less server) → unknown, never false.
			if (stored.contentHash === undefined) return "unknown";
			let stat: fs.Stats;
			try {
				stat = fs.statSync(filePath);
			} catch {
				// Can't stat (deleted/unreadable): can't disprove the binding either,
				// so stay honest — "unknown", never a manufactured false.
				return "unknown";
			}
			let cached = diskHashByPath.get(filePath);
			if (
				!cached ||
				cached.mtimeMs !== stat.mtimeMs ||
				cached.size !== stat.size
			) {
				let diskHash: string;
				try {
					diskHash = hashDiagnosticContent(fs.readFileSync(filePath, "utf-8"));
				} catch {
					return "unknown";
				}
				cached = { mtimeMs: stat.mtimeMs, size: stat.size, hash: diskHash };
				if (diskHashByPath.size >= DISK_BINDING_MEMO_MAX) {
					diskHashByPath.clear();
				}
				diskHashByPath.set(filePath, cached);
			}
			return cached.hash === stored.contentHash;
		},
	};
}

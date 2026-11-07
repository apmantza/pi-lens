/**
 * Shared "finding identity" primitive (#1816 item 2, unifying the #533
 * canonicalization fix that only reached one of three copies).
 *
 * Three call sites independently hand-rolled the same shape — a hash over
 * `relativeFile|tool|rule|...|normalizedMessage` — to derive a stable id for
 * a diagnostic/finding: `diagnostic-dispositions.ts` (dd:/ddw:),
 * `actionable-warnings.ts` (aw:), and `code-quality-warnings.ts` (cq:). Only
 * `diagnostic-dispositions.ts`'s `relativeFile` routed both `cwd` and
 * `filePath` through `normalizeMapKey` before computing the relative path
 * (see the #1024/#210-class comment this module's `relativeFile` carries
 * forward) — the other two hashed the RAW inputs, so a drive-letter-case or
 * slash-variant `filePath` produced a different id in the warning stores
 * than dispositions would compute for the identical file. This module is the
 * single source for all three: one canonicalizing `relativeFile`, one
 * `normalizeMessage`, one `hashText`, and one hash length.
 *
 * Hash length: dispositions used 12 hex chars, the two warning builders used
 * 10. This module picks 12 (dispositions' length — dispositions is the older,
 * more heavily-audited call site) for every finding id going forward.
 * Callers that persist ids in a keyed on-disk store (only
 * `actionable-warnings.ts` does; see its own module doc) are responsible for
 * back-compat lookups against ids computed under their PRE-#1816 formula —
 * this module does not attempt migration itself, since it has no way to know
 * which callers persist and which are ephemeral-per-turn.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { normalizeMapKey, toPosix } from "./path-utils.js";

/** Every finding id in this codebase truncates its sha256 hex digest to this
 * many characters. Single source so the three call sites this module
 * unifies (and any future one) can't drift back apart the way the pre-#1816
 * 10-vs-12 split did. */
export const FINDING_ID_HASH_LENGTH = 12;

/** Exported so a cross-check against a live diagnostic's message (e.g.
 * lens-diagnostic-mark's widget match) folds whitespace/case the same way id
 * derivation does — a second, slightly different normalizer would make a
 * real match invisible. */
export function normalizeMessage(message: string): string {
	return message.replace(/\s+/g, " ").trim().toLowerCase();
}

/** How many characters a rendered finding line prints of its message before
 * cutting. `displayedMessage` owns it so the render and the disposition alias
 * cannot report two different budgets. */
export const DISPLAYED_MESSAGE_MAX_CHARS = 100;

/**
 * The message a rendered finding LINE shows: its first line, cut at
 * {@link DISPLAYED_MESSAGE_MAX_CHARS} characters.
 *
 * It lives beside {@link normalizeMessage} because it answers the same
 * question from the other side: which spelling of a message the agent has in
 * hand when it marks. `formatCascadeNeighborDiagnostics` renders every cascade
 * line through it, so an agent marking what it was SHOWN spells the DISPLAYED
 * form, while the anchor hashed the whole message — for a multiline or
 * over-budget error those are different strings and the mark anchored on a
 * message no finding carries (#5367). The disposition seam therefore accepts
 * this form as an alias of the message it was cut from, through this ONE
 * derivation: a second spelling of the 100-character, first-line rule is how
 * the two sides drifted apart in the first place.
 */
export function displayedMessage(message: string): string {
	return message.split("\n")[0].slice(0, DISPLAYED_MESSAGE_MAX_CHARS);
}

/**
 * True when {@link displayedMessage} may say something the full message does
 * not: the display form is a possible CUT, so a mark spelled from it needs the
 * #5367 alias. The test is the structure that cuts — a newline, or more than
 * the budget — never a second normalization, because `applyDispositions` runs
 * it per finding on the per-edit dispatch path. It errs towards `true` (a
 * trailing whitespace-only line is cut by structure and identical after
 * folding), which costs one redundant anchor pair and can never drop a finding
 * the message itself would have kept.
 */
export function messageIsCutWhenDisplayed(message: string): boolean {
	return message.length > DISPLAYED_MESSAGE_MAX_CHARS || message.includes("\n");
}

/**
 * A finding's line-agnostic identity: `[tool, rule, normalised message]`. The
 * same finding keeps it when an edit above it moves its line, and two
 * occurrences of one rule with one message share it, so callers that must
 * tell occurrences apart count matches (see {@link retainRecordedFindings}).
 * Shared by the widget's retention match (`widget-state.ts`) and the
 * recorded-blocker carry (#4484 round 2).
 */
export function findingIdentity(d: {
	tool?: string | undefined;
	rule?: string | undefined;
	message: string;
}): string {
	return JSON.stringify([
		d.tool ?? "",
		d.rule ?? "",
		normalizeMessage(d.message),
	]);
}

/**
 * #4484 round 3: {@link findingIdentity} with digit runs folded, so a message
 * that cites its own line (helm-lint's `deploy.yaml:4: …`) keeps it when the
 * line moves. The recorded-blocker carry matches on it, and round 5's record
 * merge dedupes on it.
 */
export function foldedFindingIdentity(d: {
	tool?: string | undefined;
	rule?: string | undefined;
	message: string;
}): string {
	return findingIdentity({ ...d, message: d.message.replace(/\d+/g, "#") });
}

/**
 * #4484 round 4: the position a carry reads when a recorded finding has no
 * usable position (no alignment, or round 5's stale line). The finding then
 * matches its identity anywhere `matchesAnywhere` allows.
 */
export const ANY_POSITION = "anywhere";

/**
 * #4484: which recorded findings a fresh observation leaves standing (R3 in
 * PR #4491's round-3 table). A prior finding is matched by an observed finding
 * of the same {@link findingIdentity} that sits at the prior finding's
 * position (`positionOf`: its line, aligned to the observed bytes), and is
 * replaced by that observed copy, one per prior entry. Identity alone is not
 * enough: two occurrences of one rule share it, so an untouched occurrence
 * elsewhere would stand in for a fixed one. Digit runs in the message are
 * folded, so a message that cites its own line (helm-lint's
 * `deploy.yaml:4: …`) still matches after the line moves. A prior finding
 * with no position (its line was edited or deleted) is matched by nothing.
 * Round 4: a prior finding at {@link ANY_POSITION} (no usable position) is
 * matched by its identity at any line, after every positioned prior finding
 * took its match; that fails closed. Round 5: only by an observed finding
 * `matchesAnywhere` accepts (its line holds the prior finding's text), so a
 * same-rule finding on another line's text never stands in. An unmatched prior entry
 * survives only when `keepUnobserved` says its source gave no verdict;
 * otherwise the observation retired it. Observed findings no prior entry
 * matched are not returned: an observation keeps a recorded finding, it never
 * records one by itself.
 */
export function retainRecordedFindings<
	T extends {
		tool?: string | undefined;
		rule?: string | undefined;
		message: string;
		line?: number | undefined;
	},
>(
	prior: readonly T[],
	observed: readonly T[],
	options: {
		positionOf: (finding: T) => number | undefined | typeof ANY_POSITION;
		keepUnobserved: (finding: T) => boolean;
		matchesAnywhere?: (prior: T, observed: T) => boolean;
	},
): { kept: T[]; retired: T[] } {
	const identity = foldedFindingIdentity;
	const byPlace = new Map<string, T[]>();
	const byIdentity = new Map<string, T[]>();
	const file = (map: Map<string, T[]>, key: string, d: T) => {
		const bucket = map.get(key);
		if (bucket) bucket.push(d);
		else map.set(key, [d]);
	};
	for (const d of observed) {
		file(byIdentity, identity(d), d);
		if (d.line !== undefined) file(byPlace, `${identity(d)}@${d.line}`, d);
	}
	const taken = new Set<T>();
	const take = (
		bucket: T[] | undefined,
		accepts: (d: T) => boolean = () => true,
	): T | undefined => {
		const match = bucket?.find((d) => !taken.has(d) && accepts(d));
		if (match !== undefined) taken.add(match);
		return match;
	};
	const positions = prior.map((d) => options.positionOf(d));
	const matches = prior.map((d, i) => {
		const at = positions[i];
		return typeof at === "number"
			? take(byPlace.get(`${identity(d)}@${at}`))
			: undefined;
	});
	prior.forEach((d, i) => {
		if (positions[i] === ANY_POSITION)
			matches[i] = take(
				byIdentity.get(identity(d)),
				(o) => options.matchesAnywhere?.(d, o) ?? true,
			);
	});
	const kept: T[] = [];
	const retired: T[] = [];
	prior.forEach((d, i) => {
		const match = matches[i];
		if (match !== undefined) kept.push(match);
		else if (options.keepUnobserved(d)) kept.push(d);
		else retired.push(d);
	});
	return { kept, retired };
}

export function hashText(
	value: string,
	length: number = FINDING_ID_HASH_LENGTH,
): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * Canonicalize BOTH `filePath` and `cwd` through `normalizeMapKey` (the path
 * identity: realpath on every platform, #4689, plus the win32 case fold)
 * BEFORE computing the relative path, so two callers holding different path
 * FORMS of the same file (raw vs. already-normalized, a link spelling, a
 * Windows drive/segment case difference, a slash variant) converge on the
 * identical relative-path component instead of silently diverging into two
 * different finding ids for the same file (the #533 orphaned-record class).
 * `normalizeMapKey` is idempotent, so an already-canonical caller pays no
 * behavior change, only the realpath I/O — acceptable here because finding
 * ids are computed far less often than a per-write hot-path map key.
 */
export function relativeFile(filePath: string, cwd: string): string {
	const canonicalCwd = normalizeMapKey(cwd);
	const canonicalFile = normalizeMapKey(filePath);
	const rel = toPosix(path.relative(canonicalCwd, canonicalFile));
	return rel && !rel.startsWith("..") ? rel : canonicalFile;
}

/**
 * Shared finding-id builder. `prefix` carries the caller's own namespace
 * (`"dd:"`, `"ddw:"`, `"aw:"`, `"cq:"`, ...) so distinct finding families
 * never collide in a shared store. `parts` is the caller's own ordered,
 * domain-specific identity fields (tool/rule/code/normalizedMessage/line/
 * lineContentHash/...) — this function only supplies the canonical
 * `relativeFile` component and the hash/prefix wiring.
 *
 * Both `undefined` AND `null` entries fold to `""` (review-round F4,
 * #1816), matching the `String(x ?? "")` idiom every pre-#1816 id builder
 * used. `null` is in the parts type despite every caller's field being
 * declared `T | undefined` in TypeScript: those fields (`Diagnostic.code`,
 * `.rule`, etc.) are frequently assigned straight from `JSON.parse`'d tool
 * output, which defeats the static type at runtime — a runner that emits
 * `"code": null` produces a real `null`, not `undefined`. Folding only
 * `undefined` would silently hash that as the string `"null"` instead of
 * `""`, diverging from every other id-construction path for the exact same
 * finding — a fresh, narrower instance of the #533 divergence class this
 * module exists to eliminate.
 */
export function stableFindingId(
	prefix: string,
	args: {
		cwd: string;
		filePath: string;
		parts: Array<string | number | null | undefined>;
	},
): string {
	const joined = [
		relativeFile(args.filePath, args.cwd),
		...args.parts.map((part) =>
			part === undefined || part === null ? "" : String(part),
		),
	].join("|");
	return `${prefix}${hashText(joined)}`;
}

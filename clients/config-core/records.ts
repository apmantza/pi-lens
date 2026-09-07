/**
 * Bounded, redacted validation/migration records (#2425, scope item 6).
 *
 * A malformed config produces one record per rejected key, and a config file
 * can hold arbitrarily many keys, so the collection is bounded at the source
 * rather than at the sink. The bound reuses the degradation ledger's own
 * `ENTRIES_PER_KIND` discipline — the same number, imported rather than
 * re-typed, because a record that survives collection only to be dropped by the
 * ledger is memory spent for nothing.
 *
 * REASONS NEVER EMBED FILE CONTENT. Every reason on this surface is assembled
 * from a fixed template plus structural facts: a key name, a type name, a
 * count. No value, no snippet, no parser echo. #2431 is the sibling defect on
 * the existing loaders (a parse error carrying a source snippet); this module
 * does not fix it, and it does not repeat it. Key names are user text, so they
 * are stripped of control characters, length-bounded, and run through the
 * repo's existing `redactSecrets` before they reach a record.
 *
 * No module state: the collector is an instance a caller owns for the length of
 * one resolution, so there is no latch here to re-arm at `session_start`.
 */

import type { ConfigDiagnosticCode } from "../config-diagnostic-codes.js";
import { DEGRADATION_ENTRIES_PER_KIND } from "../ledger-bounds.js";
import { redactSecrets } from "../redact/secrets.js";
import type { SourceTier } from "./provenance.js";

/**
 * One rejected or migrated config key.
 *
 * `subject` is the ledger identity (`<file>\0<key>`, or a bare `<file>` for a
 * whole-file record). It is stored rather than derived at the sink, so the
 * record a test inspects is the record the ledger counts.
 */
export interface MigrationRecord {
	readonly code: ConfigDiagnosticCode;
	readonly file: string;
	readonly key: string;
	readonly subject: string;
	/** Structural description. Never the offending value. */
	readonly reason: string;
	/**
	 * Where the key MOVES TO, for a deprecation record (`PILENS_CFG_0002` /
	 * `0003`). Absent on a validation record, which describes a key that is
	 * going nowhere.
	 *
	 * Carried as DATA beside the rendered `reason` on purpose (#2426 scope item
	 * 4): the auto-migrator that #2426 explicitly leaves out of scope is then a
	 * pure function over a list of records — `(file, key) -> canonicalKey` — and
	 * never has to parse a message whose prose is documented as free to change.
	 */
	readonly canonicalKey?: string;
	/**
	 * The tier the source that produced this record was read at, when the
	 * producer knows it (#2426 review round 3, F1).
	 *
	 * `reportPiLensConfigRecords` needs this to tell a GLOBAL pi-lens-owned
	 * record from a PROJECT one — the subsystem it reports under depends on
	 * where the file lives, not on which loader happens to be calling. Absent
	 * only for a whole-merge bound refusal (`merge.ts`'s own depth/key-count
	 * guards), which spans every source at once and so cannot name a single
	 * one's tier.
	 */
	readonly tier?: SourceTier;
}

/**
 * Records retained per resolution. The same value and the same reasoning as the
 * ledger's per-kind bound: everything past it is counted, not kept.
 */
export const MAX_MIGRATION_RECORDS = DEGRADATION_ENTRIES_PER_KIND;

/** Longest key label a record carries. A key is a name, not a document. */
export const MAX_RECORD_KEY_LENGTH = 120;

/**
 * Codes whose record is a VERDICT ON THE WHOLE CONFIGURATION rather than one
 * more notice about one key. They are kept however full the collector is, and
 * are never counted as suppressed (#2426 review round 7, F1).
 *
 * The bound exists so that a file with 500 bad keys cannot put 500 notices on
 * screen: past 20, the rest are worth a count. That reasoning holds for every
 * PER-KEY record and inverts for this one. "Nothing in this file is in effect"
 * is not more of the same information — it is the statement that the notices
 * above it are no longer the whole story, and dropping it leaves the user
 * reading "19 keys rejected, N more suppressed" about a configuration that
 * applied nothing at all.
 *
 * Enforced in `add`, which is the single choke point BOTH bounds go through:
 * `resolveConfig`'s own collector and the second `finalizeRecords` pass that
 * `config-resolve.ts` runs over what the first one returned. A call site that
 * appended the record itself would be re-bounded by the second pass.
 *
 * `PILENS_CFG_0007` is deliberately NOT here: it is produced by `finalize`
 * after the bound has already been applied, so it can never meet it.
 */
const UNBOUNDED_RECORD_CODES: ReadonlySet<ConfigDiagnosticCode> =
	new Set<ConfigDiagnosticCode>(["PILENS_CFG_0008"]);

/**
 * The NUL separator `warnIgnoredConfigOnce` puts between file and key. Built
 * from its code point rather than written literally, so a literal NUL never
 * enters this source file.
 */
const SUBJECT_SEPARATOR = String.fromCharCode(0);

/** The ledger subject for a (file, key) pair; a bare file when there is no key. */
export function migrationSubject(file: string, key: string): string {
	return key.length > 0 ? `${file}${SUBJECT_SEPARATOR}${key}` : file;
}

/**
 * Replace every control character with a space.
 *
 * Written as a code-point scan rather than a character-class regex so this
 * source file contains no literal control byte of its own.
 */
function stripControlCharacters(text: string): string {
	let out = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? " " : character;
	}
	return out;
}

/**
 * Make a user-supplied key safe to quote in a diagnostic: strip control
 * characters (a config key can hold a newline, which would split one warning
 * across two log lines), bound the length, and run the result through the
 * repo's secret redactor in case the key itself spells one.
 */
export function boundedKeyLabel(key: string): string {
	const printable = stripControlCharacters(key).trim();
	const bounded =
		printable.length > MAX_RECORD_KEY_LENGTH
			? `${printable.slice(0, MAX_RECORD_KEY_LENGTH)}...`
			: printable;
	return redactSecrets(bounded);
}

/** A JSON type name for a value. Structural only: never the value itself. */
export function jsonTypeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * The file (and, when known, the tier) a FINALIZED record list belongs to.
 *
 * Only the overflow record needs it: every producer already fills `file` and
 * `tier` on the records it emits — including `config-core`'s own
 * internal-failure record, which anchors itself from the sources it was handed
 * (`resolve.ts`) — so there is nothing left for a sink to back-fill. What a
 * sink cannot know on its own is which file the *suppression* is about, since
 * that record describes the list rather than any one entry in it.
 */
export interface RecordAnchor {
	readonly file: string;
	readonly tier?: SourceTier;
}

/**
 * The file a finalized list names when its producer can anchor it to none.
 *
 * A list with no records cannot overflow, so this is the floor under an
 * anchorless producer rather than a case production reaches.
 */
const UNANCHORED_RECORD_LABEL = "(config resolution)";

/**
 * A bounded collector for one resolution.
 *
 * Deliberately an instance rather than a module singleton: a resolution is a
 * call, not a session, so the collector's lifetime is the call's lifetime and
 * nothing has to reset it on a session boundary (defect shape 17).
 */
export class MigrationRecordCollector {
	private readonly kept: MigrationRecord[] = [];
	private dropped: number;
	private readonly limit: number;

	/**
	 * `priorDropped` SEEDS the drop count with records an EARLIER bound already
	 * discarded before this collector saw the list (#2426 review round 6, F1).
	 *
	 * The shared resolution is bounded twice by construction: `resolveConfig`
	 * runs its own collector across every source, and the loader then finalizes
	 * what survived plus the deprecation records it composes itself. Only the
	 * second bound used to be counted, so a `.pi-lens.json` whose 40 refused
	 * keys were truncated to 19 told the user ONE notice had been suppressed
	 * when 21 had. A suppression count that undercounts is worse than no count:
	 * it tells the user the list they were shown is almost complete.
	 */
	constructor(limit: number = MAX_MIGRATION_RECORDS, priorDropped = 0) {
		this.limit = Math.max(0, Math.trunc(limit));
		this.dropped = Math.max(0, Math.trunc(priorDropped));
	}

	add(record: MigrationRecord): void {
		if (this.kept.length >= this.limit) {
			// A whole-config verdict outranks the bound — see
			// `UNBOUNDED_RECORD_CODES`. It is kept AND not counted as suppressed,
			// so `droppedCount` stays the number of per-key notices the user is
			// not seeing.
			if (UNBOUNDED_RECORD_CODES.has(record.code)) {
				this.kept.push(record);
				return;
			}
			this.dropped += 1;
			return;
		}
		this.kept.push(record);
	}

	/** The retained records, oldest first. */
	get records(): readonly MigrationRecord[] {
		return this.kept;
	}

	/** How many records the bound discarded. Counted, never silently zero. */
	get droppedCount(): number {
		return this.dropped;
	}

	/**
	 * The retained records plus, when the bound discarded any, ONE record
	 * counting them.
	 *
	 * The whole of "bound a record list and say so when it truncates" lives
	 * here, and nowhere else (#2426 review round 5, F-A/F-B/S-A). Three
	 * producers had grown their own copy of it — the shared resolution, the
	 * project loader's unknown-key scan, and (by omission, which is how the
	 * defect showed) the project loader's legacy-document enumeration, which
	 * shipped its records raw and let one file's key count set the
	 * notification count. A fourth producer must not have to remember any of
	 * this: it calls `finalizeRecords` and is bounded.
	 *
	 * Two finalized lists that anchor to the SAME file and suppress the SAME
	 * number of records render one notice, not two. That is the warn-once
	 * latch doing its documented job: both records state the identical fact
	 * about the identical file, and the user has one thing to do about it.
	 */
	finalize(anchor?: RecordAnchor): readonly MigrationRecord[] {
		if (this.dropped === 0) return this.kept;
		const file = anchor?.file ?? UNANCHORED_RECORD_LABEL;
		return [
			...this.kept,
			{
				code: "PILENS_CFG_0007",
				file,
				key: "",
				subject: migrationSubject(file, ""),
				reason: `${this.dropped} further config notices were suppressed by the bound of ${MAX_MIGRATION_RECORDS}`,
				...(anchor?.tier === undefined ? {} : { tier: anchor.tier }),
			},
		];
	}
}

/**
 * Bound a record list and append the suppression count when it truncates.
 *
 * The ONE exported shape every producer uses (#2426 review round 6, S2). It
 * used to have a twin — `finalizableCollector()`, a pre-subtracted collector a
 * streaming producer filled key by key — and two shapes for one policy is the
 * thing round 5 collapsed three copies of this bound to avoid. A push-based
 * producer buffers into an array and calls this; the array it builds is bounded
 * by the parsed document already in memory, which is a smaller cost than a
 * second public entry point onto the same arithmetic.
 *
 * One slot of the bound is held back for the overflow record, so a finalized
 * list is never LONGER than `MAX_MIGRATION_RECORDS` however many records went
 * in. That subtraction is written here and at no call site. The one exception
 * is a whole-config verdict (`UNBOUNDED_RECORD_CODES`), which is kept past the
 * limit by `add` and can therefore make a finalized list one entry longer —
 * deliberately, because that entry is what makes the other entries readable.
 *
 * `priorDropped` is what an earlier bound already discarded — see the
 * collector's constructor. A caller that finalizes a list some other bound has
 * already truncated MUST pass it, or the count it publishes is the tail of the
 * truncation rather than the whole of it.
 */
export function finalizeRecords(
	records: Iterable<MigrationRecord>,
	anchor?: RecordAnchor,
	priorDropped = 0,
): readonly MigrationRecord[] {
	const collector = new MigrationRecordCollector(
		MAX_MIGRATION_RECORDS - 1,
		priorDropped,
	);
	for (const record of records) collector.add(record);
	return collector.finalize(anchor);
}

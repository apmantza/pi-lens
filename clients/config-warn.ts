/**
 * The ONE seam for "a config the user wrote is being ignored" (#2418).
 *
 * Three loaders — `clients/lsp/config.ts`, `clients/lens-config.ts`,
 * `clients/project-lens-config.ts` — each degraded a malformed config to
 * defaults and warned about it, with three near-identical bodies: a warn-once
 * latch, a `logExtension` line, and a `notifyUserDegradation` call. Three
 * copies meant three places to forget the stable diagnostic code, and three
 * places for the message shape to drift. They now share this helper, which
 * owns all four obligations:
 *
 * 1. the warn-once latch, keyed on (subsystem, file, key, reason) so a repeat
 *    load of the same broken file does not re-nag the user;
 * 2. the MACHINE-audience `extension.log` line;
 * 3. the durable degradation-ledger row, through the repo's existing
 *    `recordDegradationOnce` choke point rather than a parallel tally;
 * 4. the HUMAN-audience notification, carrying the stable `PILENS_CFG_*` code
 *    that `docs/public-api-stability.md` makes the user's match key.
 *
 * The message prose is assembled here from a per-subsystem label so every
 * caller's rendered string is byte-identical to what it emitted before the
 * extraction — the prose is not API (the code is), but silently rewording a
 * warning inside a refactor is still not a thing this PR does.
 */

import {
	type ConfigDiagnosticCode,
	DEPRECATED_CONFIG_SURFACES,
	withConfigDiagnosticCode,
} from "./config-diagnostic-codes.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { errorClassName } from "./error-class.js";
import { logExtension } from "./extension-log.js";
import { redactSecrets } from "./redact/secrets.js";
import { notifyUserDegradation } from "./user-notify.js";

/**
 * The config loaders that can report an ignored config. A closed union rather
 * than a free string: the latch key and the log's `subsystem` field are the
 * same value, so an ad-hoc caller cannot fragment either one.
 */
export type IgnoredConfigSubsystem =
	| "lsp-config"
	| "lens-config"
	| "project-lens-config";

/**
 * The noun each subsystem uses for the config it is ignoring. These strings
 * are load-bearing for byte-identical prose: `ignoring invalid LSP config …`,
 * `… global config …`, `… project config …` are what shipped before #2418
 * extracted this helper, and `tests/clients/lsp/config.test.ts` +
 * `tests/clients/project-lens-config.test.ts` still assert on them.
 */
const SUBSYSTEM_CONFIG_LABEL: Record<IgnoredConfigSubsystem, string> = {
	"lsp-config": "LSP config",
	"lens-config": "global config",
	"project-lens-config": "project config",
};

/**
 * The code every ignored-config warning carries: PILENS_CFG_0001, "config file
 * unreadable or unparsable; ignored". Named here rather than repeated at three
 * call sites so the registry entry has exactly one referent in production code.
 */
const IGNORED_CONFIG_CODE: ConfigDiagnosticCode = "PILENS_CFG_0001";

/**
 * The degradation kind this helper records under. One kind for all three
 * loaders: the subject discriminates WHICH file, and `metadata.subsystem`
 * discriminates which loader, so aggregation answers both without a kind
 * explosion.
 */
const IGNORED_CONFIG_KIND = "config-ignored";

/**
 * The degradation kind a DEPRECATION notice records under (#2426).
 *
 * Kept apart from `config-ignored` because the two are opposite facts about a
 * session: an ignored config means pi-lens ran on defaults instead of what the
 * user asked for, while a deprecated one means it ran on exactly what the user
 * asked for and the location will stop working. Folding them together would
 * have made "how many sessions ran degraded" un-answerable from the ledger.
 */
const DEPRECATED_CONFIG_KIND = "config-deprecated";

/**
 * The code that says a notice LIST was truncated (#2426 review round 6, F2).
 *
 * It is the one code on this seam that describes the OUTPUT rather than the
 * config, so it is the one that must not inherit either default below.
 */
const SUPPRESSED_NOTICE_CODE: ConfigDiagnosticCode = "PILENS_CFG_0007";

/**
 * The degradation kind a SUPPRESSED-NOTICE summary records under (#2426 review
 * round 6, F2).
 *
 * Neither of the other two: nothing was ignored and nothing is deprecated —
 * a legacy file whose 28 settings ALL applied still overflows the bound, and
 * before this it produced a `config-ignored` row and an `ignoring invalid
 * project config` notice for a file with nothing invalid in it. That is the
 * same inversion `DEPRECATED_CONFIG_KIND` exists to prevent, arriving through
 * the default branch instead of through a wrong one.
 */
const SUPPRESSED_NOTICE_KIND = "config-notice-suppressed";

/**
 * The codes that mean "accepted, but deprecated". DERIVED from the deprecation
 * registry rather than listed, so a future `kind` of deprecated surface with a
 * new code cannot render as `ignoring invalid …` by omission.
 */
const DEPRECATION_NOUN_BY_CODE: ReadonlyMap<string, string> = new Map(
	DEPRECATED_CONFIG_SURFACES.map((row) => [
		row.code,
		row.kind === "file" ? "location" : "key",
	]),
);

/** Warn-once latch, keyed on (subsystem, file, key, reason). */
const warnedIgnoredConfigs = new Set<string>();

/**
 * The one shape `JSON.parse`'s own `SyntaxError#message` states a position
 * in, on every supported Node (CI pins Node 22; V8 has emitted `at position N
 * (line L column C)` for this shape since ~Node 20). Captures the absolute
 * offset too (group 1), not just V8's own stated line/col (groups 2, 3):
 * with source text in hand, line/col is recomputed by scanning the source
 * ourselves rather than trusted from the message (#2451) — the offset is
 * still just a digit, kept only as the pre-#2451 fallback for a caller that
 * has no source text to scan.
 *
 * V8 also emits a position-free shape for a token error — `Unexpected token
 * 'x', "<snippet>"... is not valid JSON` — which carries no position at all,
 * only a slice of the source text being parsed. That is the exact shape
 * #2431's evidence hit (`ghp_SECRET` sitting in the snippet on Node 24), and
 * `locateSyntaxErrorOffset` below locates it in the source instead.
 */
const JSON_PARSE_POSITION = /at position (\d+) \(line (\d+) column (\d+)\)/;

/**
 * True for `JSON.parse`'s own `SyntaxError`, including one thrown across a
 * realm boundary (e.g. `vm.runInContext`), where BOTH `instanceof SyntaxError`
 * and `instanceof Error` fail — a realm-bound object's prototype chain
 * resolves through that OTHER realm's `Error.prototype`/`Object.prototype`,
 * never this one's. Duck-typed on `name` and `message` instead, which are
 * plain string own/inherited properties readable regardless of which realm's
 * prototype chain the object carries.
 */
function isSyntaxError(
	error: unknown,
): error is { name: string; message: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { name?: unknown }).name === "SyntaxError" &&
		typeof (error as { message?: unknown }).message === "string"
	);
}

/**
 * Line (1-based) and column (1-based, V8's own convention) of a character
 * offset, scanned directly from the source — never trusted from anything the
 * message states (#2451). `offset` is always in `[0, sourceText.length]`: it
 * comes from either V8's own `at position N` digit (bounded by construction —
 * V8 cannot state a position past the text it just parsed) or a snippet
 * `indexOf` match inside `sourceText` itself, so there is no out-of-range
 * case for this function to guard against.
 */
function lineColAt(
	sourceText: string,
	offset: number,
): { readonly line: number; readonly col: number } {
	let line = 1;
	let lastNewline = -1;
	for (let i = 0; i < offset; i++) {
		if (sourceText[i] === "\n") {
			line++;
			lastNewline = i;
		}
	}
	return { line, col: offset - lastNewline };
}

/**
 * Split V8's position-free `Unexpected token` message into the offending
 * token and the (possibly truncated) source snippet around it.
 *
 * NOT regex-quote-matched: the snippet is a raw slice of the user's source
 * text and can itself contain `"`, which a `/"([\s\S]*?)"/`-shaped pattern
 * would stop at prematurely (`{"a": ghp_SECRET` has one right after the
 * opening `{`). Fixed prefix/suffix stripping instead, which is exact
 * regardless of what the snippet contains.
 */
function parseUnexpectedTokenMessage(
	message: string,
): { readonly token: string; readonly snippet: string } | undefined {
	const prefix = "Unexpected token '";
	if (!message.startsWith(prefix)) return undefined;
	const closeIdx = message.indexOf("', ", prefix.length);
	// No explicit `closeIdx === -1` branch: when the marker is missing,
	// `closeIdx` is `-1`, so `rest` below starts at `message[2]` — always
	// still inside the fixed `prefix` text the `startsWith` check just
	// confirmed, never `"`. The `rest.startsWith('"')` check a few lines down
	// already rejects that case; a second explicit check here could never be
	// exercised by any input that passes the first, so it stayed untestable
	// dead code rather than a guard (#2451 mutation pass).
	const token = message.slice(prefix.length, closeIdx);
	let rest = message.slice(closeIdx + 3);
	if (rest.startsWith("...")) rest = rest.slice(3);
	if (!rest.startsWith('"')) return undefined;
	rest = rest.slice(1);
	const truncatedSuffix = '"... is not valid JSON';
	const plainSuffix = '" is not valid JSON';
	const snippet = rest.endsWith(truncatedSuffix)
		? rest.slice(0, -truncatedSuffix.length)
		: rest.endsWith(plainSuffix)
			? rest.slice(0, -plainSuffix.length)
			: undefined;
	// No explicit `snippet.length === 0` branch: `String#indexOf("")` matches
	// at EVERY position, so an empty snippet always fails the caller's
	// uniqueness check (`sourceText.indexOf(snippet, snippetAt + 1) !== -1`
	// is true at every offset, including on an empty `sourceText`) — a second
	// explicit check here could never be exercised by any input the first
	// does not already catch (#2451 mutation pass).
	return snippet === undefined ? undefined : { token, snippet };
}

/**
 * Locate a `JSON.parse` `SyntaxError`'s offset in ITS OWN source text
 * (#2451). Two shapes, both anchored to the source rather than to anything
 * V8 states about it:
 *
 * - `at position N`: N is already an exact offset.
 * - `Unexpected token 'x', "<snippet>"...`: no offset in the message at all,
 *   only a slice of the source. `snippet` is searched for in `sourceText`
 *   with `indexOf`; a match that is not unique is not trusted (the wrong
 *   occurrence would report a false location, and a `config-ignored` reason
 *   is not worth that risk). Inside a unique match, the offending token's
 *   own OFFSET is used when it too occurs exactly once in the snippet — the
 *   common case (JSON punctuation, a typo'd letter) — otherwise the snippet's
 *   own start stands in: still the correct line far more often than not
 *   (the snippet is a ~20-char window around the real offset), never a
 *   snippet the user did not already put in their own file.
 *
 * Returns `undefined` when neither shape locates unambiguously — the honest,
 * safe answer, which the caller degrades to the bare class name for.
 */
function locateSyntaxErrorOffset(
	message: string,
	sourceText: string,
): number | undefined {
	const stated = JSON_PARSE_POSITION.exec(message);
	if (stated) return Number(stated[1]);

	const parsed = parseUnexpectedTokenMessage(message);
	if (!parsed) return undefined;
	const { token, snippet } = parsed;

	const snippetAt = sourceText.indexOf(snippet);
	if (snippetAt === -1 || sourceText.indexOf(snippet, snippetAt + 1) !== -1) {
		return undefined;
	}
	const tokenAt = snippet.indexOf(token);
	const onlyTokenOccurrence =
		tokenAt !== -1 && snippet.indexOf(token, tokenAt + 1) === -1;
	return snippetAt + (onlyTokenOccurrence ? tokenAt : 0);
}

export interface NormalizeParseErrorReasonOptions {
	/**
	 * The raw text the error was parsed from. Enables recovering `line L col
	 * C` locality for EVERY V8 `SyntaxError` shape, including the
	 * position-free `Unexpected token` one that otherwise degrades to a bare
	 * class name (#2451) — derived by scanning the source, never by trusting a
	 * digit or a snippet straight out of the message. Omit when no source was
	 * ever read (e.g. an `fs.readFileSync` failure); the reason then falls
	 * back to the pre-#2451 shape (V8's own stated line/col, still nothing but
	 * digits, when the message states one).
	 */
	readonly sourceText?: string;
	/**
	 * Force class-name-only, even for a non-`SyntaxError`. For a caller whose
	 * caught error is NOT documented to be free of embedded file content — a
	 * bug inside this module's own object-walking/merge code, which throws on
	 * a value it read out of the untrusted parsed document, and whose message
	 * could therefore quote it — never the message, whatever the error's type.
	 * Delegates to `./error-class.js`'s `errorClassName`, the ONE
	 * implementation `clients/config-core/normalize.ts`,
	 * `clients/config-core/resolve.ts`, and `clients/lens-config.ts` also call
	 * directly (#2451) — NOT this function, on purpose: `config-core/` must
	 * never import a sink (this module -> the degradation ledger), which is
	 * exactly the cycle #2426 removed from it, so its two catch sites reach
	 * the shared leaf without reaching back through this seam.
	 */
	readonly classOnly?: boolean;
}

/**
 * Normalize a caught parse/validation error into a bounded, snippet-free
 * reason: the error's own class plus a position, when one can be derived —
 * NEVER the raw message (#2431), and never anything but the class name at
 * all for a `classOnly` caller (#2451).
 *
 * `JSON.parse`'s `SyntaxError#message` is DOCUMENTED (V8) to embed a slice of
 * the source text being parsed. A user's malformed config that happens to
 * carry a credential next to the syntax error would otherwise leak it into
 * `extension.log`, the user-facing notification, and the durable
 * degradation-ledger row through this one seam — so a `SyntaxError` NEVER
 * keeps its message, position-derived or not.
 *
 * Every other caught error reaching this helper (a loader's own hand-thrown
 * validation error, an `fs` error) is not documented to embed file content,
 * and is additionally routed through the repo's own secret scanner
 * (`redactSecrets`) — but that scanner is a floor, not a guarantee: it only
 * recognizes secrets shaped like its registered patterns and long enough to
 * clear each pattern's `minSuffixLength` (16-40 chars), so a short truncated
 * fragment of a real credential can still pass through untouched. It is
 * still worth calling on this branch because most non-`SyntaxError` messages
 * are hand-authored by this codebase, not engine dumps of file content — but
 * `normalizeParseErrorReason`'s own guarantee (no message survives at all)
 * applies only to the `SyntaxError` branch (and, unconditionally, to a
 * `classOnly` caller). `warnIgnoredConfigOnce` (the one `{ parseError }`
 * caller) additionally redacts EVERY reason, including hand-authored ones,
 * so a caller-composed string that happens to interpolate file content (a
 * user-authored config KEY, a rule id) is still covered.
 */
export function normalizeParseErrorReason(
	error: unknown,
	options: NormalizeParseErrorReasonOptions = {},
): string {
	if (options.classOnly) {
		return errorClassName(error);
	}
	if (isSyntaxError(error)) {
		if (options.sourceText !== undefined) {
			const offset = locateSyntaxErrorOffset(error.message, options.sourceText);
			if (offset !== undefined) {
				const { line, col } = lineColAt(options.sourceText, offset);
				return `${error.name} at line ${line} col ${col}`;
			}
			return error.name;
		}
		const match = JSON_PARSE_POSITION.exec(error.message);
		return match
			? `${error.name} at line ${match[2]} col ${match[3]}`
			: error.name;
	}
	const message = error instanceof Error ? error.message : String(error);
	return redactSecrets(message);
}

/**
 * Which durable kind a notice records under. Three facts, three kinds, decided
 * in ONE place so a fourth code cannot inherit "ignored" by falling through.
 */
function degradationKindFor(
	suppressedNotice: boolean,
	deprecationNoun: string | undefined,
): string {
	if (suppressedNotice) return SUPPRESSED_NOTICE_KIND;
	return deprecationNoun ? DEPRECATED_CONFIG_KIND : IGNORED_CONFIG_KIND;
}

/**
 * The rendered prose for one notice.
 *
 * The two pre-existing shapes are BYTE-IDENTICAL to what shipped — several
 * suites assert on them — and the third is deliberately built from neither
 * vocabulary: a truncation summary describes the notice list, never the
 * config, so it says nothing about the file being invalid or ignored.
 */
function noticeMessage(options: {
	readonly subsystem: IgnoredConfigSubsystem;
	readonly file: string;
	readonly reason: string;
	readonly suppressedNotice: boolean;
	readonly deprecationNoun: string | undefined;
}): string {
	const label = SUBSYSTEM_CONFIG_LABEL[options.subsystem];
	if (options.suppressedNotice) {
		return `${label} notices for ${options.file} were summarised: ${options.reason}`;
	}
	return options.deprecationNoun
		? `deprecated ${label} ${options.deprecationNoun} in ${options.file}: ${options.reason}`
		: `ignoring invalid ${label} ${options.file}: ${options.reason}`;
}

export interface WarnIgnoredConfigOptions {
	/** Which loader is ignoring the config; also the `extension.log` subsystem. */
	readonly subsystem: IgnoredConfigSubsystem;
	/** The config file being ignored, as the loader knows it. */
	readonly file: string;
	/**
	 * Why it is being ignored. A hand-authored string for a validated bad
	 * value / wrong type (already safe, never file-content-derived); or, for a
	 * caught parse/read error, `{ parseError }` carrying the raw error so this
	 * seam — and only this seam — is what decides how much of it survives into
	 * the three sinks below (#2431). Callers that catch a `JSON.parse` or `fs`
	 * error must use `{ parseError }`, never pre-stringify it themselves.
	 * `sourceText`, when the caller actually read the file (a `JSON.parse`
	 * failure, never an `fs` read failure — nothing was ever read then), lets
	 * `normalizeParseErrorReason` recover `line L col C` locality for the
	 * position-free `Unexpected token` shape too (#2451).
	 */
	readonly reason:
		| string
		| { readonly parseError: unknown; readonly sourceText?: string };
	/**
	 * The offending KEY inside the file, when the loader is rejecting one key
	 * rather than the whole file. Part of the ledger subject, so
	 * `<file>\0<key>` stays the identity a per-key degradation is counted under;
	 * a whole-file rejection is just `<file>`, with no trailing separator.
	 *
	 * No production caller passes it TODAY (#2418 review round 3, S1). It is
	 * kept rather than deleted because it is the forcing function for #2426:
	 * the legacy-location/legacy-key deprecation records land through this same
	 * helper as `PILENS_CFG_0002`/`0003`, and a per-KEY record that had to
	 * share a subject with the whole file would be uncountable. The audit that
	 * would otherwise flag it as dead is answered here, in one place, instead
	 * of by re-deriving the seam in three months.
	 */
	readonly key?: string;
	/**
	 * Override the stable diagnostic code. Defaults to `PILENS_CFG_0001`
	 * (unreadable/unparsable, ignored), which is what all three loaders mean
	 * today. The seam exists because `PILENS_CFG_0002`/`0003` (deprecated key /
	 * deprecated file location accepted) are registered and reserved for the
	 * #2416 migration path, and will report through this same helper.
	 */
	readonly code?: ConfigDiagnosticCode;
}

/**
 * Warn once that a config file (or one key in it) is being ignored.
 *
 * Fires the durable ledger row, the machine log, and the user-facing
 * notification. Every one of the three is bounded, but on two DIFFERENT
 * lifetimes: the latch here bounds the log line and the notification for the
 * life of the PROCESS, while `recordDegradationOnce` bounds the ledger row on
 * (kind, subject) for the life of the SESSION. That is why the ledger call sits
 * in front of the latch's early return — see the comment on it. The ledger
 * bound is also coarser, so a file failing for two different reasons warns
 * twice but is counted as one degraded config.
 */
export function warnIgnoredConfigOnce(options: WarnIgnoredConfigOptions): void {
	const { subsystem, file, key } = options;
	const code: ConfigDiagnosticCode = options.code ?? IGNORED_CONFIG_CODE;
	// The ONLY place a caught parse/read error becomes a string (#2431). A
	// `{ parseError }` is normalized to error class + position, never the raw
	// message. A hand-authored reason is still `redactSecrets`-scrubbed here —
	// review round 2, F1: several callers interpolate a user-authored KEY or
	// rule id straight from the parsed config (`unknown key "${key}" is not a
	// recognized pi-lens setting`), so "hand-authored" does not mean
	// "content-free"; the ONE seam every caller shares is where that gets
	// caught, not each of the ~8 call sites that format one of these strings.
	const reason: string = redactSecrets(
		typeof options.reason === "string"
			? options.reason
			: normalizeParseErrorReason(options.reason.parseError, {
					sourceText: options.reason.sourceText,
				}),
	);

	// The durable half (#2418 F6), and it runs BEFORE the latch on purpose
	// (#2418 review round 3, F1). The latch is a PROCESS-lifetime Set; the
	// ledger is per SESSION, reset by `resetDegradationLedger()` at the top of
	// `handleSessionStart`. With the early return in front of this call, every
	// session after the first recorded nothing while the config on disk was
	// still ignored — the exact catalog-shape-17 defect
	// `refreshGrammarSessionLatches` exists to prevent in tree-sitter-client.
	//
	// No second, generation-compared latch is needed to re-arm it, unlike that
	// precedent: `recordDegradationOnce` already dedupes on (kind, subject)
	// through its own once-key set, and that set IS cleared by the ledger
	// reset. Calling it unconditionally makes the ledger the single source of
	// truth for "once per session", instead of a parallel Set here that mirrors
	// it and has to be kept in step. (tree-sitter needs its own gates because
	// they guard `incrementDegradationCount`, which counts EVERY call, plus
	// non-ledger state.)
	//
	// Subject is `<file>\0<key>` when a single key is rejected, and plain
	// `<file>` otherwise, so a per-key rejection and a whole-file rejection are
	// distinct rows for the same file without a trailing separator on every row.
	const suppressedNotice = code === SUPPRESSED_NOTICE_CODE;
	const deprecationNoun = suppressedNotice
		? undefined
		: DEPRECATION_NOUN_BY_CODE.get(code);

	recordDegradationOnce({
		kind: degradationKindFor(suppressedNotice, deprecationNoun),
		subject: key ? `${file}\0${key}` : file,
		reason,
		metadata: { subsystem, configPath: file },
		code,
	});

	const latchKey = `${subsystem}\0${file}\0${key ?? ""}\0${reason}`;
	if (warnedIgnoredConfigs.has(latchKey)) return;
	warnedIgnoredConfigs.add(latchKey);

	// Three prose shapes for three different facts. A deprecation notice — or a
	// truncation summary — that said "ignoring invalid …" would tell the user
	// their setting is not being applied when it IS: the one thing #2426's
	// "no user is broken silently" rule cannot afford to get backwards.
	const message = noticeMessage({
		subsystem,
		file,
		reason,
		suppressedNotice,
		deprecationNoun,
	});

	logExtension({
		subsystem,
		level: "warn",
		message: withConfigDiagnosticCode(message, code),
		metadata: { configPath: file, reason, code, ...(key ? { key } : {}) },
	});

	// HUMAN-audience too: a config the user wrote is being ignored. Routed
	// through the host's own render path (#1333), never a raw write. The stable
	// code (#2418) is what a user matches or suppresses on; the prose may still
	// change. Once per PROCESS, deliberately: re-nagging about the same broken
	// file at every session boundary is noise, while the ledger row above is
	// the per-session record.
	notifyUserDegradation(`pi-lens: ${message}`, "warning", { code });
}

/**
 * Clear the warn-once latch. Test-only seam, and the one the loaders' own
 * reset helpers delegate to — a subsystem argument clears just that loader's
 * entries so one loader's test cannot silently un-latch another's.
 */
export function resetIgnoredConfigWarnCache(
	subsystem?: IgnoredConfigSubsystem,
): void {
	if (!subsystem) {
		warnedIgnoredConfigs.clear();
		return;
	}
	for (const latchKey of warnedIgnoredConfigs) {
		if (latchKey.startsWith(`${subsystem}\0`)) {
			warnedIgnoredConfigs.delete(latchKey);
		}
	}
}

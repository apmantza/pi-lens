/**
 * Vendored port of the pi host edit tool's text-normalization primitives, so
 * the read-guard's oldText->range matching agrees *by construction* with how the
 * host actually applies edits (exact-then-fuzzy in normalized space).
 *
 * SOURCE OF TRUTH: `@earendil-works/pi-coding-agent`
 *   `dist/core/tools/edit-diff.js` -- `normalizeForFuzzyMatch`, `normalizeToLF`,
 *   `detectLineEnding`, `restoreLineEndings`, `stripBom`.
 *
 * The host SDK is a *type-only* dependency at runtime (pi installs extensions
 * with `npm install --omit=dev`, so the SDK is not in `node_modules`). These
 * functions are therefore intentionally COPIED, not imported -- keep each one
 * behaviourally identical to the host. The companion sync test
 * (`tests/clients/host-edit-normalize-sync.test.ts`) re-reads the host source
 * from devDeps and fails if it drifts from this port, pinning the floor below.
 *
 * The Unicode fold classes are built from explicit code points (HOST_* below)
 * rather than literal glyphs so this file stays pure-ASCII; the code-point sets
 * are the same ones the host hard-codes as \u escapes in `normalizeForFuzzyMatch`.
 *
 * Refs #257 (read-guard / edit-autopatch alignment with the host edit tool).
 */

/**
 * Host SDK version this port mirrors. Bump together with the devDependency
 * floor in package.json and re-confirm the sync test when the host changes its
 * normalization ladder.
 */
export const HOST_EDIT_DIFF_SDK_FLOOR = "0.79.9";

// Host normalizeForFuzzyMatch code-point sets (edit-diff.js). Exported so the
// sync test can assert the host source still encodes exactly these.
/** U+2018 U+2019 U+201A U+201B -> ' */
export const HOST_SMART_SINGLE_QUOTES = [0x2018, 0x2019, 0x201a, 0x201b];
/** U+201C U+201D U+201E U+201F -> " */
export const HOST_SMART_DOUBLE_QUOTES = [0x201c, 0x201d, 0x201e, 0x201f];
/** U+2010..U+2015 dashes + U+2212 minus -> - */
export const HOST_UNICODE_DASHES = [
	0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212,
];
/** U+00A0 NBSP, U+2002..U+200A spaces, U+202F, U+205F, U+3000 -> space */
export const HOST_SPECIAL_SPACES = [
	0x00a0, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
	0x200a, 0x202f, 0x205f, 0x3000,
];
/** U+FEFF byte-order mark */
export const HOST_BOM_CODE_POINT = 0xfeff;

const charClass = (codePoints: number[]): RegExp =>
	new RegExp(`[${String.fromCharCode(...codePoints)}]`, "g");

const SMART_SINGLE_QUOTES_RE = charClass(HOST_SMART_SINGLE_QUOTES);
const SMART_DOUBLE_QUOTES_RE = charClass(HOST_SMART_DOUBLE_QUOTES);
const UNICODE_DASHES_RE = charClass(HOST_UNICODE_DASHES);
const SPECIAL_SPACES_RE = charClass(HOST_SPECIAL_SPACES);
const BOM = String.fromCharCode(HOST_BOM_CODE_POINT);

// --- verbatim host ports (edit-diff.js) ---------------------------------------

/** First-occurrence-wins line-ending detection (CRLF vs LF). */
export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** Collapse CRLF and lone-CR line endings to LF. */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Restore LF text back to the detected ending (no-op for LF files). */
export function restoreLineEndings(
	text: string,
	ending: "\r\n" | "\n",
): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Mirrors the host's progressive ladder:
 * NFKC -> strip trailing whitespace per line -> smart quotes -> Unicode
 * dashes/hyphens -> special Unicode spaces. None of these transforms add or
 * remove a newline, so line numbers computed on the result map 1:1 to file
 * lines.
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(SMART_SINGLE_QUOTES_RE, "'")
		.replace(SMART_DOUBLE_QUOTES_RE, '"')
		.replace(UNICODE_DASHES_RE, "-")
		.replace(SPECIAL_SPACES_RE, " ");
}

/** Strip a leading UTF-8 BOM if present. */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith(BOM)
		? { bom: BOM, text: content.slice(1) }
		: { bom: "", text: content };
}

// --- composed guard helper ----------------------------------------------------

/**
 * Full host MATCH-space normalization used by the read-guard's oldText->range
 * resolver and the autopatch synthetic-read bridge: BOM strip -> LF -> fuzzy
 * fold. A needle normalized this way finds exactly what the host's
 * `fuzzyFindText` / `countOccurrences` would find, so the gate no longer
 * rejects edits the host would apply (smart quotes, em-dashes, NBSP, BOM, lone
 * CR, NFKC-equivalent forms). Newline positions are preserved relative to the
 * LF view, so occurrence line numbers stay aligned with the file.
 */
export function normalizeForGuardMatch(text: string): string {
	return normalizeForFuzzyMatch(normalizeToLF(stripBom(text).text));
}

// --- counterfactual: would the host's edit tool apply this oldText? -----------

export interface HostMatchOutcome {
	/** The host would resolve this oldText to exactly one replacement. */
	wouldApply: boolean;
	/** Occurrences in the host's fuzzy match space (>1 => host rejects as ambiguous). */
	occurrences: number;
	/** A fuzzy (not exact) match was needed to find it. */
	usedFuzzyMatch: boolean;
}

/**
 * Replicate the host edit tool's match *decision* for a single oldText against
 * file content, WITHOUT applying anything: exact-then-fuzzy find + duplicate
 * count in fuzzy space, exactly as `fuzzyFindText` + `countOccurrences` do
 * (edit-diff.js). The host pre-strips BOM and normalizes to LF, so this does the
 * same before matching.
 *
 * Used as the read-guard's counterfactual log: when the guard blocks an edit,
 * `wouldApply === true` flags a false-block (the host would have applied it),
 * `false` confirms a genuine miss (the host would also fail). This is the only
 * way to measure the guard's false-block rate without an A/B harness (#257).
 */
export function hostWouldApplyOldText(
	content: string,
	oldText: string,
): HostMatchOutcome {
	const c = normalizeToLF(stripBom(content).text);
	const o = normalizeToLF(stripBom(oldText).text);
	if (o.length === 0) {
		return { wouldApply: false, occurrences: 0, usedFuzzyMatch: false };
	}
	const exactFound = c.indexOf(o) !== -1;
	// The host always counts duplicates in fuzzy space, even for an exact match.
	const fuzzyContent = normalizeForFuzzyMatch(c);
	const fuzzyOldText = normalizeForFuzzyMatch(o);
	const fuzzyFound = fuzzyContent.indexOf(fuzzyOldText) !== -1;
	const occurrences =
		fuzzyOldText.length === 0
			? 0
			: fuzzyContent.split(fuzzyOldText).length - 1;
	return {
		wouldApply: (exactFound || fuzzyFound) && occurrences === 1,
		occurrences,
		usedFuzzyMatch: !exactFound && fuzzyFound,
	};
}

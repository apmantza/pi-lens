// Shared merge helpers for the LSP capability docs (#390). The nightly runs on
// ubuntu-latest, which lacks many language toolchains, so a naive overwrite would
// DROP rows a richer run (e.g. the dev box) captured. These helpers MERGE: a row
// the current run measured is updated in place; a row it didn't measure (server
// unavailable/unknown here) is preserved verbatim. Server-row count never
// shrinks. Used by characterize-lsp.mjs + probe-clean-signal.mjs (which share
// docs/lsp-capability-matrix.md) and server-capabilities.mjs. #460/#390.
//
// Deliberately dependency-free: tests and scripts copy this file alone into a
// scratch checkout (release-qa.test.ts), so it imports nothing.

/**
 * The generated LSP docs the nightly regenerates and `check-generated-docs-diff`
 * compares against HEAD. One list, so a doc added to the nightly cannot be
 * regenerated without being compared (#3645 added the idle-eviction document);
 * the refresh PR's `add-paths` in tool-smoke.yml must carry the same paths.
 */
export const GENERATED_LSP_DOCS = [
	"docs/lsp-capability-matrix.md",
	"docs/servercapabilities.md",
	"docs/lsp-idle-eviction.md",
];

/**
 * The matrix `clean-behavior` values that are a measurement of anything.
 * `unknown` is evidence in neither direction (the #240 doctrine), so it never
 * enters a comparison. Shared by `scripts/probe-clean-signal.mjs` (through
 * `buildMatrixObservations` and its row filter), `scripts/lib/assert-evaluated.mjs`
 * (the evaluated count) and `tests/config/lsp-clean-behavior-census.test.ts`
 * (the marker census), which previously kept independent spellings of the same
 * set (#3401). Lives here because this file imports nothing: the refresh-PR job
 * runs the floor script on a checkout with no `dist/` (#4518).
 */
export const MEASURED_CLEAN_BEHAVIORS = new Set([
	"publishes-versioned",
	"publishes-unversioned",
	"silent",
]);

/**
 * The matrix `first-publish` values that are a measurement (#4512). `unknown`,
 * `n/a (pull)` and `TBD` are not, so they never read as a missed probe.
 */
export const MEASURED_FIRST_PUBLISHES = new Set(["direct", "empty-first"]);

/**
 * Parse a GitHub-flavoured Markdown table into { header, aligns, rows } where
 * rows is an array of cell-string arrays. Only the FIRST table after `afterLine`
 * (a line whose text includes the marker) is parsed. Returns null if not found.
 *
 * @param {string} text
 * @param {string} headerMarker  a substring of the table's header row (e.g. "| lang | server |")
 * @returns {{ start: number, end: number, header: string[], sep: string, rows: string[][] } | null}
 */
export function parseTable(text, headerMarker) {
	const lines = text.split("\n");
	let headerIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(headerMarker) && lines[i].trim().startsWith("|")) {
			headerIdx = i;
			break;
		}
	}
	if (headerIdx < 0 || headerIdx + 1 >= lines.length) return null;
	const sepIdx = headerIdx + 1;
	if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[sepIdx])) return null;
	const header = splitRow(lines[headerIdx]);
	const rows = [];
	let end = sepIdx + 1;
	for (let i = sepIdx + 1; i < lines.length; i++) {
		if (!lines[i].trim().startsWith("|")) break;
		rows.push(splitRow(lines[i]));
		end = i + 1;
	}
	return { start: headerIdx, end, header, sep: lines[sepIdx], rows };
}

function splitRow(line) {
	// Strip leading/trailing pipe then split; trim each cell.
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((c) => c.trim());
}

function renderRow(cells) {
	return `| ${cells.join(" | ")} |`;
}

/**
 * Compare strings by Unicode code point, independently of the host locale.
 * Generated docs must not change when a runner's locale changes.
 */
export function compareStableStrings(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare generated docs while ignoring the intentionally volatile date marker.
 * The marker remains in rendered output; only the no-op refresh decision omits
 * it so a date-only nightly cannot open a PR (#3380).
 */
export function compareGeneratedDocs(a, b) {
	const withoutGenerationDate = (text) =>
		text
			.split("\n")
			.filter((line) => !/^_Last generated: .*_$/.test(line))
			.join("\n");
	return (
		compareStableStrings(withoutGenerationDate(a), withoutGenerationDate(b)) !==
		0
	);
}

export function sortedStrings(values) {
	return [...(values ?? [])].map(String).sort(compareStableStrings);
}

/**
 * Render the server capability inventory without depending on handshake order.
 * The caller supplies the measured date/platform so this remains pure and easy
 * to test with two differently ordered inventories.
 */
/**
 * #3407: the save column. `none` renders as the table's "not advertised" dot;
 * a snapshot without the field (a client predating the accessor) is `?`, never
 * a dot, because "unknown" must not read as "declares no save".
 */
function saveCell(textDocumentSave) {
	if (textDocumentSave === "save" || textDocumentSave === "save+text")
		return textDocumentSave;
	if (textDocumentSave === "none") return "·";
	return "?";
}

export function renderServerCapabilitiesDoc({
	rows,
	unavailable,
	date,
	platform,
	ops,
}) {
	const sortedRows = [...rows].sort((a, b) =>
		compareStableStrings(String(a.serverId), String(b.serverId)),
	);
	const sortedOps = [...ops];
	const yn = (b) => (b ? "✓" : "·");
	const lines = [
		"# LSP server capability inventory",
		"",
		"Advertised capabilities of every LSP server pi-lens supports, read from each",
		"server's `initialize` handshake. Generated by `node scripts/server-capabilities.mjs",
		"[--install]` (requires `npm run build:dist`). Servers whose toolchain/binary is",
		"absent on the generating host are listed under *Unavailable* — run in a",
		"provisioned environment (the nightly) to capture those rows.",
		"",
		`_Last generated: ${date} on ${platform}; ${sortedRows.length} servers captured, ${unavailable.size} unavailable._`,
		"",
		"## Diagnostic mode + navigation/edit operations",
		"",
		`Legend: ✓ advertised, · not. **mode** = document diagnostics (\`pull\` = \`textDocument/diagnostic\`, else push-only); **ws-pull** = advertises \`workspace/diagnostic\` (one project-wide pull — the #387 Item 2 fast path); **save** = \`textDocumentSync.save\` (#3407): \`save\` gets \`textDocument/didSave\`, \`save+text\` gets it with the document text (\`includeText\`), · declares none, ? not captured. ${sortedOps.map(([k, a]) => `**${a}**=${k}`).join(", ")}; **cmds** = executeCommand allowlist size.`,
		"",
		`| server | mode | ws-pull | save | ${sortedOps.map(([, a]) => a).join(" | ")} | cmds |`,
		`|---|---|---|---|${sortedOps.map(() => "---").join("|")}|---|`,
	];
	for (const s of sortedRows) {
		const operationSupport = s.operationSupport ?? {};
		const opsText = sortedOps.map(([k]) => yn(operationSupport[k])).join(" | ");
		lines.push(
			`| ${s.serverId} | ${s.workspaceDiagnosticsSupport?.mode ?? "?"} | ${yn(s.workspaceDiagnosticsSupport?.workspaceDiagnostics)} | ${saveCell(s.textDocumentSave)} | ${opsText} | ${sortedStrings(s.advertisedCommands).length} |`,
		);
	}
	lines.push(
		"",
		"## Raw advertised capability keys",
		"",
		"Top-level keys of each server's `ServerCapabilities` — the full advertised",
		"surface, including providers pi-lens does not yet consume.",
		"",
	);
	for (const s of sortedRows) {
		const keys = sortedStrings(s.rawCapabilityKeys);
		lines.push(
			`- **${s.serverId}**: ${keys.length ? keys.join(", ") : "(none reported)"}`,
		);
	}
	const withCmds = sortedRows.filter(
		(s) => sortedStrings(s.advertisedCommands).length > 0,
	);
	if (withCmds.length) {
		lines.push("", "## Advertised executeCommand allowlists", "");
		for (const s of withCmds) {
			const commands = sortedStrings(s.advertisedCommands);
			const shown = commands.slice(0, 40).join(", ");
			const more = commands.length > 40 ? ", …" : "";
			lines.push(`- **${s.serverId}** (${commands.length}): ${shown}${more}`);
		}
	}
	const unavailableSorted = sortedStrings(unavailable);
	if (unavailableSorted.length) {
		lines.push(
			"",
			"## Unavailable on the generating host",
			"",
			"Toolchain/binary not installed here, so capabilities weren't captured",
			"(many are the toolchain-gated family tracked in #241):",
			"",
		);
		for (const name of unavailableSorted) lines.push(`- ${name}`);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Merge measured rows into an existing table's rows, keyed by a column index.
 * For each measured row, only the columns named in `ownedCols` are overwritten
 * (so two scripts sharing a table each update only their own columns); unlisted
 * columns keep the existing value. Rows present in the doc but NOT measured this
 * run are preserved. New servers are appended.
 *
 * @param {string[][]} existing   parsed existing rows
 * @param {string[]} header       column headers (for name→index)
 * @param {Object[]} measured     objects keyed by header name → cell value
 * @param {string} keyCol         header name of the unique key (e.g. "lang")
 * @param {string[]} ownedCols    header names this run is authoritative for
 * @returns {string[][]}          merged rows
 */
export function mergeRows(existing, header, measured, keyCol, ownedCols) {
	const idx = (name) => header.indexOf(name);
	const keyIdx = idx(keyCol);
	const byKey = new Map();
	const order = [];
	for (const cells of existing) {
		const k = cells[keyIdx];
		byKey.set(k, [...cells]);
		order.push(k);
	}
	for (const m of measured) {
		const k = m[keyCol];
		let cells = byKey.get(k);
		if (!cells) {
			cells = header.map((h) => (m[h] !== undefined ? String(m[h]) : ""));
			byKey.set(k, cells);
			order.push(k);
			continue;
		}
		for (const col of ownedCols) {
			const ci = idx(col);
			if (ci >= 0 && m[col] !== undefined) cells[ci] = String(m[col]);
		}
	}
	return order.map((k) => byKey.get(k));
}

/**
 * Merge a measured `src` token (e.g. "ci") into an existing one (e.g. "dev") so a
 * row measured on both surfaces reads "dev+ci". Order kept deterministic
 * (dev before ci). An empty/missing existing value just yields the new token.
 *
 * @param {string} existing
 * @param {string} measured
 * @returns {string}
 */
export function mergeSrc(existing, measured) {
	const set = new Set();
	for (const part of String(existing ?? "").split("+")) {
		const t = part.trim();
		if (t && t !== "—") set.add(t);
	}
	if (measured) set.add(measured.trim());
	const order = ["dev", "ci"];
	return [...set]
		.sort((a, b) => {
			const ia = order.indexOf(a);
			const ib = order.indexOf(b);
			return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
		})
		.join("+");
}

/**
 * Replace the table located by `headerMarker` in `text` with a table built from
 * `header`/`sep`/`rows`. If no such table exists, returns null (caller decides
 * whether to append a fresh table). Preserves everything outside the table.
 *
 * @returns {string | null}
 */
export function replaceTable(text, headerMarker, header, sep, rows) {
	const tbl = parseTable(text, headerMarker);
	if (!tbl) return null;
	const lines = text.split("\n");
	const rendered = [renderRow(header), sep, ...rows.map(renderRow)];
	lines.splice(tbl.start, tbl.end - tbl.start, ...rendered);
	return lines.join("\n");
}

/**
 * Merge prior rows into a NEW header shape by column NAME, tolerating a schema
 * change between the prior doc and this run (#469). Unlike `mergeRows` (which
 * requires identical headers), this reshapes each prior row that this run did
 * NOT capture onto `newHeader`: columns present in both are carried by name,
 * columns the prior row lacked (a column added this run) are filled with
 * `placeholder`, and columns dropped from the new schema are simply not
 * carried. Rows this run DID capture are the caller's fresh rows and always
 * win — pass only the prior rows NOT in `capturedKeys` as `priorRows`.
 *
 * @param {string[][]} priorRows     prior rows to reshape (already narrowed to
 *   the ones this run did not capture), in `priorHeader` column order
 * @param {string[]} priorHeader     the prior doc's header
 * @param {string[]} newHeader       this run's header (may differ in columns)
 * @param {string} keyCol            header name of the unique row key (e.g. "server")
 * @param {string | ((column: string) => string)} [placeholder]  fill value for columns the prior row lacked (a function picks it per column, #3407)
 * @returns {string[][]}             priorRows reshaped onto newHeader
 */
export function reshapeRowsByName(
	priorRows,
	priorHeader,
	newHeader,
	keyCol,
	placeholder = "·",
) {
	const priorIdx = (name) => priorHeader.indexOf(name);
	return priorRows.map((cells) =>
		newHeader.map((h) => {
			const pi = priorIdx(h);
			if (pi >= 0 && cells[pi] !== undefined) return cells[pi];
			if (h === keyCol) return cells[priorIdx(keyCol)] ?? "";
			return typeof placeholder === "function" ? placeholder(h) : placeholder;
		}),
	);
}

/**
 * Parse a `## heading` bulleted-list section (lines of the form
 * `- **<key>**: <rest>`) into an ordered Map of key → full bullet line
 * (without the leading `- `). Stops at the next `## ` heading or EOF. Returns
 * an empty Map if the section isn't found — callers treat that as "nothing to
 * carry over", never a crash.
 *
 * @param {string} text
 * @param {string} heading   e.g. "## Raw advertised capability keys"
 * @returns {Map<string, string>}
 */
export function parseBulletSection(text, heading) {
	const lines = text.split("\n");
	const map = new Map();
	let i = lines.findIndex((l) => l.trim() === heading.trim());
	if (i < 0) return map;
	i++;
	// The bold key is followed by either `:` (Raw advertised capability keys)
	// or ` (N):` (Advertised executeCommand allowlists, N = allowlist size) —
	// tolerate both so a single parser/merger works for both sections.
	const bulletRe = /^- \*\*(.+?)\*\*(?:\s*\([^)]*\))?:\s*(.*)$/;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line)) break;
		const m = bulletRe.exec(line);
		if (m) map.set(m[1], line.replace(/^- /, ""));
	}
	return map;
}

/**
 * Merge preserved-server bullets into a freshly-generated `## heading` section
 * of `newText`, carrying over the prior doc's bullet line for each key in
 * `keysToCarry` that has one (silently skipped if the prior doc had none for
 * that key). The merged section is re-sorted by key so preserved and freshly-
 * generated bullets interleave alphabetically, matching the generator's
 * existing sort. If `heading` isn't found in `newText`, returns `newText`
 * unchanged (fail-open — never crash the nightly over a missing section).
 *
 * @param {string} newText
 * @param {string} heading
 * @param {Map<string, string>} priorBullets   from `parseBulletSection` on the prior doc
 * @param {string[]} keysToCarry               keys (servers) to pull from `priorBullets`
 * @returns {string}
 */
export function mergeBulletSection(
	newText,
	heading,
	priorBullets,
	keysToCarry,
) {
	const lines = newText.split("\n");
	const headingIdx = lines.findIndex((l) => l.trim() === heading.trim());
	if (headingIdx < 0) return newText;
	// The section body starts after the heading, skipping a single blank line
	// (the generator always emits one), and runs up to the next `## ` heading
	// or EOF.
	const bodyStart =
		lines[headingIdx + 1] === "" ? headingIdx + 2 : headingIdx + 1;
	let bodyEnd = lines.length;
	for (let i = bodyStart; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) {
			bodyEnd = i;
			break;
		}
	}
	// The bold key is followed by either `:` (Raw advertised capability keys)
	// or ` (N):` (Advertised executeCommand allowlists, N = allowlist size) —
	// tolerate both so a single parser/merger works for both sections.
	const bulletRe = /^- \*\*(.+?)\*\*(?:\s*\([^)]*\))?:\s*(.*)$/;
	const byKey = new Map();
	// Keep the section's non-bullet prefix (for example the raw-capability
	// introduction) above the sorted bullets. Only content after the last bullet
	// is trailing; treating every non-bullet line as trailing moves the intro
	// below carried bullets (#5526).
	let firstBullet = bodyEnd;
	let lastBullet = bodyStart - 1;
	for (let i = bodyStart; i < bodyEnd; i++) {
		const m = bulletRe.exec(lines[i]);
		if (!m) continue;
		if (firstBullet === bodyEnd) firstBullet = i;
		lastBullet = i;
		byKey.set(m[1], lines[i]);
	}
	let added = false;
	for (const k of keysToCarry) {
		if (byKey.has(k)) continue; // captured this run — always wins
		const prior = priorBullets.get(k);
		if (prior === undefined) continue; // prior doc had no bullet — skip silently
		byKey.set(k, `- ${sortBulletValues(prior)}`);
		added = true;
	}
	if (!added) return newText;
	const sortedLines = [...byKey.keys()]
		.sort(compareStableStrings)
		.map((k) => byKey.get(k));
	const before = lines.slice(0, firstBullet);
	const trailing = lines.slice(Math.max(lastBullet + 1, firstBullet), bodyEnd);
	const after = lines.slice(bodyEnd);
	return [...before, ...sortedLines, ...trailing, ...after].join("\n");
}

function sortBulletValues(value) {
	const separator = value.indexOf(": ");
	if (separator < 0) return value;
	const prefix = value.slice(0, separator + 2);
	const values = value.slice(separator + 2);
	if (!values || values === "(none reported)") return value;
	return `${prefix}${sortedStrings(values.split(", ")).join(", ")}`;
}

// Deliberately a SHORT, schema-stable marker (not "| server | mode | ws-pull |")
// — the whole point of #469 is that a prior doc predating the ws-pull column
// must still be found and parsed, so the marker can't assume a column that
// might not exist yet.
const SERVER_CAPS_TABLE_MARKER = "| server | mode |";
const SERVER_CAPS_RAW_KEYS_HEADING = "## Raw advertised capability keys";
const SERVER_CAPS_EXEC_CMDS_HEADING = "## Advertised executeCommand allowlists";

/**
 * Merge a prior `docs/servercapabilities.md` into a freshly-generated one
 * (#390/#469): servers the fresh run didn't capture keep their prior table
 * row (reshaped by column NAME onto the fresh header via `reshapeRowsByName`,
 * so a schema change like the ws-pull column addition no longer disables the
 * guard — #469) and their bullet lines in both "Raw advertised capability
 * keys" and "Advertised executeCommand allowlists" (via `mergeBulletSection`,
 * which the original #390 guard didn't touch at all). Servers captured this
 * run always win — their fresh row/bullets are never overwritten by a stale
 * prior value.
 *
 * Pure (text in, text in, text out) so it's testable without spawning any LSP
 * server. Fail-open: if either doc's table is unparseable, returns the fresh
 * text unchanged (caller logs the skip; the nightly must never crash on this).
 *
 * @param {string} priorText   previous docs/servercapabilities.md content
 * @param {string} freshText   this run's freshly-generated content
 * @returns {{ text: string, preservedCount: number }}
 */
export function mergeServerCapabilitiesDoc(priorText, freshText) {
	const priorTbl = parseTable(priorText, SERVER_CAPS_TABLE_MARKER);
	const newTbl = parseTable(freshText, SERVER_CAPS_TABLE_MARKER);
	if (!priorTbl || !newTbl) {
		return { text: freshText, preservedCount: 0 };
	}
	const keyIdx = newTbl.header.indexOf("server");
	const priorKeyIdx = priorTbl.header.indexOf("server");
	if (keyIdx < 0 || priorKeyIdx < 0) {
		return { text: freshText, preservedCount: 0 };
	}
	const capturedKeys = new Set(newTbl.rows.map((c) => c[keyIdx]));
	const notCapturedPriorRows = priorTbl.rows.filter(
		(c) => !capturedKeys.has(c[priorKeyIdx]),
	);
	// #3407: a prior row carried into a column it predates is unmeasured there.
	// For the save column that is `?`, not the `·` ("declares none") every
	// boolean column uses.
	const reshaped = reshapeRowsByName(
		notCapturedPriorRows,
		priorTbl.header,
		newTbl.header,
		"server",
		(column) => (column === "save" ? "?" : "·"),
	);
	const mergedRows = [...newTbl.rows, ...reshaped].sort((a, b) =>
		compareStableStrings(a[keyIdx], b[keyIdx]),
	);
	let text = replaceTable(
		freshText,
		SERVER_CAPS_TABLE_MARKER,
		newTbl.header,
		newTbl.sep,
		mergedRows,
	);
	if (!text) {
		return { text: freshText, preservedCount: 0 };
	}
	const preservedServers = notCapturedPriorRows.map((c) => c[priorKeyIdx]);
	for (const heading of [
		SERVER_CAPS_RAW_KEYS_HEADING,
		SERVER_CAPS_EXEC_CMDS_HEADING,
	]) {
		const priorBullets = parseBulletSection(priorText, heading);
		text = mergeBulletSection(text, heading, priorBullets, preservedServers);
	}
	return { text, preservedCount: preservedServers.length };
}

// ---------------------------------------------------------------------------
// #3401: the capability-matrix staleness guards.
//
// The merge guard above preserves a row the current run did not measure, which
// is right for an ubuntu-poor host but leaves a measured cell unexpirable: the
// vue/ast-grep `first-publish=direct` cells came from the pre-#3394 attribution
// defect and NOTHING observed them afterwards, yet the guard kept them forever.
// Two bounded rules fix that, and both need a per-cell observation memory that
// outlives one nightly run:
//
//  - STALENESS (first-publish and clean-behavior, DATE-based): a measured cell
//    whose axis the probe does not re-observe KEEPS its last known value and is
//    marked `stale` with the date of the first miss (#4512). It is never
//    rewritten to `unknown`: the pre-#4512 expiry turned five `direct` cells
//    into `unknown` in the #4338 refresh, erasing the last known value, and
//    nothing raised it. A refresh counts the consecutive nightly misses per
//    lang and RAISES a lang at `MISSED_PROBE_RAISE_RUNS` (the nightly files one
//    tracking issue for the raised set). `empty-first` cells back live
//    `emptyFirstPublish` markers; #4615 stamps their first unobserved night with
//    the same `firstMissed` clock and the first-publish census reds once that
//    stamp is `FIRST_PUBLISH_EXPIRY_DAYS` old, so the cell+marker pair cannot
//    outlive the instrument that produced it — the #3310 blindness.
//  - HYSTERESIS (clean-behavior/tier, run-based): a change is written only after
//    `TIER_CHANGE_AGREE_RUNS` consecutive runs observe the same new value, so a
//    single flapping run (ast-grep 2 -> 2* -> 3 -> 2* across four nightlies)
//    cannot rewrite a cell. A night that measured nothing for the lang resets
//    the hold.
//
// The matrix doc is the only state the refresh persists, so the bookkeeping
// lives in a generated section of that same doc. The nightly seeds its working
// copy from the last `bot/lsp-docs-refresh` doc when that branch is ahead of
// master (scripts/seed-matrix-from-bot-branch.mjs), so the state advances per
// nightly run whether or not the bot PR has merged. Nothing here is a
// measurement; the section is bookkeeping.
// ---------------------------------------------------------------------------

/**
 * #4615: elapsed days after which a marker-backed `empty-first` cell's first
 * miss stamp reds the first-publish census (tests/config/lsp-first-publish-
 * census.test.ts). Since #4512 no cell is ever expired to `unknown` by the
 * refresh: a missed probe keeps the last known value and marks it stale.
 * Elapsed calendar days, not runs: a skipped nightly cannot stall it.
 */
export const FIRST_PUBLISH_EXPIRY_DAYS = 5;

/**
 * #4512: consecutive nightly misses after which a stale cell is RAISED (the
 * nightly files it on one tracking issue). One miss is a transient runner or
 * toolchain gap and stays quiet; two consecutive nights are a pattern.
 */
export const MISSED_PROBE_RAISE_RUNS = 2;

/**
 * #4512: the probe-owned columns a row may be stale in, plus the per-row
 * provenance the matrix gained: `version` (what the server reported) and
 * `install` (how pi-lens got it). Appended to an older doc by
 * `ensureMatrixColumns`; an unmeasured cell is `—`.
 */
export const MATRIX_ADDED_COLUMNS = ["version", "install", "stale"];

const MATRIX_EMPTY_CELL = "—";

/**
 * #4512: give a matrix doc that predates the `version`/`install`/`stale`
 * columns those columns, every existing row carrying `—`. Idempotent: a doc
 * that has them is returned unchanged. Returns `text` untouched when the table
 * is not found (the caller reports that on its own).
 *
 * @param {string} text
 * @param {string} [marker]
 * @returns {string}
 */
export function ensureMatrixColumns(text, marker = "| lang | server |") {
	const tbl = parseTable(text, marker);
	if (!tbl) return text;
	const missing = MATRIX_ADDED_COLUMNS.filter((c) => !tbl.header.includes(c));
	if (missing.length === 0) return text;
	const header = [...tbl.header, ...missing];
	const sep = `|${header.map(() => "---").join("|")}|`;
	const rows = tbl.rows.map((cells) => [
		...cells,
		...missing.map(() => MATRIX_EMPTY_CELL),
	]);
	return replaceTable(text, marker, header, sep, rows) ?? text;
}

/**
 * #3401: consecutive agreeing runs before a `clean-behavior`/`tier` change is
 * written. Two, so one odd nightly (the ast-grep flap) is held as pending but
 * two agreeing nights commit.
 */
export const TIER_CHANGE_AGREE_RUNS = 2;

/**
 * Advance one confirmed class through the shared consecutive-observation
 * hysteresis. The callers translate the generic pending record back to their
 * axis-specific persisted shape after this seam decides whether to hold or
 * commit the observation.
 *
 * @param {string} confirmed
 * @param {{ value: string, runs: number } | undefined} pending
 * @param {string} observed
 * @param {number} agreeRuns
 * @returns {{ confirmed: string, pending?: { value: string, runs: number }, committed: boolean }}
 */
export function advancePendingClass(confirmed, pending, observed, agreeRuns) {
	if (!observed || observed === confirmed)
		return { confirmed, pending: undefined, committed: false };
	const samePending = pending?.value === observed;
	const runs = samePending ? Number(pending.runs ?? 1) + 1 : 1;
	const requiredRuns = Math.max(2, Number(agreeRuns));
	if (samePending && runs >= requiredRuns)
		return { confirmed: observed, pending: undefined, committed: true };
	return {
		confirmed,
		pending: { value: observed, runs },
		committed: false,
	};
}

/** @param {Date | number | string} now @returns {string} UTC `YYYY-MM-DD` */
function utcDay(now) {
	if (isUtcDay(now)) return now;
	return new Date(now).toISOString().slice(0, 10);
}

/** True for a real `YYYY-MM-DD` calendar date (`2026-13-45` is not). */
function isUtcDay(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
		return false;
	const ms = Date.parse(`${value}T00:00:00Z`);
	return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** Whole UTC days from `from` to `to` (both `YYYY-MM-DD`); `null` if `from` is not a real date. */
export function elapsedDays(from, to) {
	if (!isUtcDay(from)) return null;
	return Math.round(
		(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
			86_400_000,
	);
}

const REFRESH_STATE_HEADING =
	"## Capability matrix refresh state (nightly-generated)";
const REFRESH_STATE_FENCE = "```json";
const REFRESH_STATE_FENCE_END = "```";

/**
 * Parse the `## Capability matrix refresh state` JSON block. An absent or
 * malformed block parses as `{}`: it is bookkeeping, so a lost block degrades
 * to "no memory this run", never a crash.
 *
 * @param {string} text
 * @returns {{ "first-publish"?: Record<string, { firstMissed?: string, pendingFirstPublish?: string, runs?: number }>, "clean-behavior"?: Record<string, { pendingBehavior: string, pendingTier: string, runs: number }> }}
 */
export function parseRefreshState(text) {
	const lines = String(text ?? "").split("\n");
	const headingIdx = lines.findIndex(
		(l) => l.trim() === REFRESH_STATE_HEADING.trim(),
	);
	if (headingIdx < 0) return {};
	const openIdx = lines.indexOf(REFRESH_STATE_FENCE, headingIdx + 1);
	if (openIdx < 0) return {};
	const closeIdx = lines.indexOf(REFRESH_STATE_FENCE_END, openIdx + 1);
	if (closeIdx < 0) return {};
	try {
		const parsed = JSON.parse(lines.slice(openIdx + 1, closeIdx).join("\n"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** The refresh-state key holding the missed-probe streaks (#4512). */
export const MISSED_PROBE_KEY = "missed-probe";

/**
 * #4512: the axes a measured cell can be missed on. One streak per lang and
 * axis, so a clean-behavior miss on one night and a first-publish miss on the
 * next are two first misses, never one consecutive pair.
 */
const MISSED_PROBE_AXES = ["clean-behavior", "first-publish"];

/**
 * #4512: keep only well-formed missed-probe streaks, `{ [lang]: { [axis]:
 * { since, last, misses } } }`: `since` the UTC day of the axis's first miss,
 * `last` the UTC day the streak was last advanced, `misses` the count of
 * distinct nightly misses. A hand-edited or old block (the single per-lang
 * streak this key briefly held before it shipped) cannot carry garbage into the
 * section: a lang with no well-formed axis is dropped.
 */
function sanitizeMissedProbeState(map) {
	const out = {};
	if (!map || typeof map !== "object") return out;
	for (const lang of Object.keys(map).sort(compareStableStrings)) {
		const axes = {};
		for (const axis of MISSED_PROBE_AXES) {
			const e = map[lang]?.[axis];
			if (
				isUtcDay(e?.since) &&
				isUtcDay(e?.last) &&
				Number.isInteger(e?.misses) &&
				e.misses > 0
			)
				axes[axis] = { since: e.since, last: e.last, misses: e.misses };
		}
		if (Object.keys(axes).length) out[lang] = axes;
	}
	return out;
}

/** The refresh-state key holding the idle-eviction promotion bookkeeping (#3989). */
export const IDLE_EVICTION_KEY = "idle-eviction";

/**
 * #3989: keep only well-formed idle-eviction nights, at most two per server
 * (the promotion window), so a hand-edited or old block cannot carry garbage
 * into the rendered section. A night is `{ day, rssMb, coldMs }`: `rssMb` may
 * be null (not measured), `coldMs` is always a number (a night without one
 * never counts).
 */
function sanitizeIdleEvictionState(map) {
	const out = {};
	if (!map || typeof map !== "object") return out;
	for (const serverId of Object.keys(map).sort(compareStableStrings)) {
		const nights = [];
		for (const n of Array.isArray(map[serverId]?.nights)
			? map[serverId].nights
			: []) {
			if (
				isUtcDay(n?.day) &&
				Number.isFinite(n?.coldMs) &&
				(n.rssMb === null || Number.isFinite(n.rssMb))
			)
				nights.push({ day: n.day, rssMb: n.rssMb, coldMs: n.coldMs });
		}
		if (nights.length) out[serverId] = { nights: nights.slice(-2) };
	}
	return out;
}

/**
 * #3989: replace the `idle-eviction` key of the refresh-state block in `text`,
 * leaving the other keys as parsed. An empty map removes the key (and the
 * section when nothing else is left).
 *
 * @param {string} text
 * @param {Record<string, { nights: { day: string, rssMb: number | null, coldMs: number }[] }>} idleEviction
 */
export function setIdleEvictionState(text, idleEviction) {
	const state = {
		...parseRefreshState(text),
		[IDLE_EVICTION_KEY]: idleEviction,
	};
	return replaceRefreshStateSection(text, renderRefreshStateSection(state));
}

/**
 * Render the refresh-state section's lines, or `[]` when there is nothing to
 * remember. Keys are sorted and zero counters are dropped so a settled run
 * writes a byte-identical block and the refresh PR does not open on churn.
 */
function renderRefreshStateSection(state) {
	const firstPublish = {};
	for (const lang of Object.keys(state?.["first-publish"] ?? {}).sort(
		compareStableStrings,
	)) {
		const entry = state["first-publish"][lang];
		const firstMissed = entry?.firstMissed;
		const pendingFirstPublish = entry?.pendingFirstPublish;
		const runs = Number(entry?.runs ?? 1);
		if (isUtcDay(firstMissed)) firstPublish[lang] = { firstMissed };
		if (
			pendingFirstPublish === "direct" ||
			pendingFirstPublish === "empty-first"
		) {
			firstPublish[lang] = {
				...firstPublish[lang],
				pendingFirstPublish,
				runs: Number.isFinite(runs) && runs > 0 ? runs : 1,
			};
		}
	}
	const cleanBehavior = {};
	for (const lang of Object.keys(state?.["clean-behavior"] ?? {}).sort(
		compareStableStrings,
	)) {
		const pending = state["clean-behavior"][lang];
		if (pending?.pendingBehavior && pending?.pendingTier) {
			cleanBehavior[lang] = {
				pendingBehavior: pending.pendingBehavior,
				pendingTier: pending.pendingTier,
				runs: Number(pending.runs ?? 1),
			};
		}
	}
	const idleEviction = sanitizeIdleEvictionState(state?.[IDLE_EVICTION_KEY]);
	const missedProbe = sanitizeMissedProbeState(state?.[MISSED_PROBE_KEY]);
	const payload = {};
	if (Object.keys(cleanBehavior).length)
		payload["clean-behavior"] = cleanBehavior;
	if (Object.keys(firstPublish).length) payload["first-publish"] = firstPublish;
	if (Object.keys(idleEviction).length)
		payload[IDLE_EVICTION_KEY] = idleEviction;
	if (Object.keys(missedProbe).length) payload[MISSED_PROBE_KEY] = missedProbe;
	if (Object.keys(payload).length === 0) return [];
	return [
		REFRESH_STATE_HEADING,
		"",
		"Bookkeeping for the two-run `first-publish`/`clean-behavior` hysteresis, the",
		"first-miss stamps (#3401, #4615), the consecutive-night `missed-probe`",
		"streaks behind the `stale` column (#4512) and consecutive-night",
		"`idle-eviction` counts (#3989). Regenerated every run; never a measurement.",
		"",
		REFRESH_STATE_FENCE,
		JSON.stringify(payload),
		REFRESH_STATE_FENCE_END,
	];
}

/**
 * Replace (or append) the refresh-state section at the end of `text`. Placing it
 * after the generated drift footnote keeps the drift writer's own "up to the
 * next `## ` heading" scan from swallowing it.
 */
export function replaceRefreshStateSection(text, section) {
	const lines = String(text).split("\n");
	const headingIdx = lines.findIndex(
		(l) => l.trim() === REFRESH_STATE_HEADING.trim(),
	);
	let kept = lines;
	if (headingIdx >= 0) {
		let end = lines.length;
		for (let i = headingIdx + 1; i < lines.length; i++) {
			if (/^##\s/.test(lines[i])) {
				end = i;
				break;
			}
		}
		kept = [...lines.slice(0, headingIdx), ...lines.slice(end)];
	}
	while (kept.length && kept.at(-1) === "") kept.pop();
	const body = kept.join("\n");
	if (section.length === 0) return `${body}\n`;
	return `${body}\n\n${section.join("\n")}\n`;
}

/**
 * Refresh docs/lsp-capability-matrix.md from one probe run, applying the
 * #3401 hysteresis and the #4512 stale marking. Text in, text out (plus counts) so the nightly's real
 * refresh entry is testable with recorded run inputs and no LSP spawn.
 *
 * @param {string} text  the current doc
 * @param {Array<{ lang: string, firstPublish?: string | null, cleanBehavior?: string | null, tier?: string | null }>} observations
 *   this run's comparable observations, already resolved onto target langs by
 *   the caller (a non-comparable axis is `null`)
 * @param {{ src?: string, marker?: string, agreeRuns?: number, now?: Date | number | string, probedLangs?: Iterable<string>, markers?: (lang: string) => { silentOnClean?: boolean, emptyFirstPublish?: string } | undefined }} [opts]
 *   `now` is the injected clock (default: the real one); `probedLangs` scopes a
 *   subset probe: a lang outside it keeps its bookkeeping untouched. Omitted
 *   means a full run. `markers` is the registry lookup (`silentOnClean`,
 *   `emptyFirstPublish`) a held row must agree with to be promoted; without it
 *   no held row is promoted.
 * @returns {{ text: string, changed: boolean, reason?: string, pending: number, committed: number, pendingLangs: string[], committedLangs: string[], gatedLangs: string[], staleLangs: string[], raisedLangs: string[] }}
 */
export function refreshCapabilityMatrix(text, observations, opts = {}) {
	const marker = opts.marker ?? "| lang | server |";
	const src = opts.src ?? "ci";
	const agreeRuns = Math.max(
		1,
		Number(opts.agreeRuns ?? TIER_CHANGE_AGREE_RUNS),
	);
	const raiseRuns = Math.max(
		1,
		Number(opts.raiseRuns ?? MISSED_PROBE_RAISE_RUNS),
	);
	const today = utcDay(opts.now ?? new Date());
	const probed = opts.probedLangs ? new Set(opts.probedLangs) : null;
	if (!parseTable(text, marker)) {
		return {
			text,
			changed: false,
			reason: "capability table not found in doc",
			pending: 0,
			committed: 0,
			pendingLangs: [],
			committedLangs: [],
			gatedLangs: [],
			staleLangs: [],
			raisedLangs: [],
		};
	}
	// #4512: an older doc gains the version/install/stale columns here, so the
	// first refresh after the change writes them without a hand edit.
	const migrated = ensureMatrixColumns(text, marker);
	const tbl = parseTable(migrated, marker);
	const idx = (name) => tbl.header.indexOf(name);
	const langIdx = idx("lang");
	const srcIdx = idx("src");
	const staleIdx = idx("stale");
	const fpIdx = idx("first-publish");
	const cbIdx = idx("clean-behavior");
	const tierIdx = idx("tier");
	const byLang = new Map((observations ?? []).map((o) => [o.lang, o]));
	const prior = parseRefreshState(text);
	const priorFp = prior["first-publish"] ?? {};
	const priorCb = prior["clean-behavior"] ?? {};
	const priorMissed = sanitizeMissedProbeState(prior[MISSED_PROBE_KEY]);
	const nextState = {
		"first-publish": {},
		"clean-behavior": {},
		[MISSED_PROBE_KEY]: {},
		// The idle-eviction bookkeeping belongs to its own nightly step; this
		// refresh must carry it through, not drop it (#3989).
		[IDLE_EVICTION_KEY]: prior[IDLE_EVICTION_KEY],
	};
	const staleLangs = [];
	const raisedLangs = [];
	const pendingLangs = [];
	const committedLangs = [];
	const gatedLangs = [];
	// #5323: a held row joins the curated table only as a row every census of
	// that table accepts, each arm the rule a promoted row could break there.
	// A marker the lookup cannot report reads as unmarked, as in the censuses;
	// with no lookup at all nothing is resolved, so nothing is promoted. A
	// promotion only adds a row with no miss stamp, so the censuses' orphan
	// and stamp rules cannot be broken by one.
	const markers = opts.markers;
	const censusAccepts = (lang, behavior, firstPublish) => {
		if (typeof markers !== "function") return false;
		const marker = markers(lang) ?? {};
		const indexing = marker.emptyFirstPublish === "indexing";
		return (
			// tests/config/lsp-clean-behavior-census.test.ts (observations carry
			// only measured classes)
			(marker.silentOnClean === true) === (behavior === "silent") &&
			// tests/config/lsp-first-publish-census.test.ts
			!(firstPublish === "empty-first" && !indexing) &&
			!(firstPublish === "direct" && indexing)
		);
	};
	// #5323: a held row's clean-behavior goes through the same two-run
	// hysteresis as a curated `unknown` cell. The night it commits, the row
	// moves to the curated table with that clean-behavior and tier, and the
	// loop below then treats it as any curated row. A held row's first-publish
	// observation waits in the same bookkeeping (one run, never committed
	// while held), so the loop commits it the promotion night when it agrees.
	const heldRows = readHeldRows(migrated);
	const heldBefore = heldRows.size;
	for (const [lang, row] of heldRows) {
		if (probed && !probed.has(lang)) {
			if (priorCb[lang]) nextState["clean-behavior"][lang] = priorCb[lang];
			if (priorFp[lang]) nextState["first-publish"][lang] = priorFp[lang];
			continue;
		}
		const observed = byLang.get(lang);
		const observedFp = observed?.firstPublish ?? null;
		if (MEASURED_FIRST_PUBLISHES.has(observedFp))
			nextState["first-publish"][lang] = {
				pendingFirstPublish: observedFp,
				runs: 1,
			};
		if (!observed?.cleanBehavior) continue;
		const observedTier = observed.tier ?? "";
		const pending = priorCb[lang];
		const advanced = advancePendingClass(
			MATRIX_EMPTY_CELL,
			pending?.pendingBehavior && pending?.pendingTier
				? {
						value: `${pending.pendingBehavior}\u0000${pending.pendingTier}`,
						runs: Number(pending.runs ?? 1),
					}
				: undefined,
			`${observed.cleanBehavior}\u0000${observedTier}`,
			agreeRuns,
		);
		// The first-publish the curated loop would commit for this row tonight:
		// the held pending, advanced once by tonight's observation.
		const priorPendingFp = priorFp[lang]?.pendingFirstPublish;
		const fpTonight = MEASURED_FIRST_PUBLISHES.has(observedFp)
			? advancePendingClass(
					"unknown",
					priorPendingFp
						? { value: priorPendingFp, runs: Number(priorFp[lang].runs ?? 1) }
						: undefined,
					observedFp,
					agreeRuns,
				)
			: null;
		const settledFp = fpTonight?.committed ? fpTonight.confirmed : "unknown";
		if (
			advanced.committed &&
			!censusAccepts(lang, observed.cleanBehavior, settledFp)
		) {
			// Settled but refused: stay held, one agreeing night short of a
			// commit, so every later agreeing night checks again and the
			// bookkeeping is the same bytes each night.
			nextState["clean-behavior"][lang] = {
				pendingBehavior: observed.cleanBehavior,
				pendingTier: observedTier,
				runs: Math.max(2, agreeRuns) - 1,
			};
			gatedLangs.push(lang);
		} else if (advanced.committed) {
			const promoted = {
				...row,
				"clean-behavior": observed.cleanBehavior,
				// The cell the gate judged; the curated loop finds it current.
				"first-publish": settledFp,
				tier: observedTier,
				stale: MATRIX_EMPTY_CELL,
			};
			tbl.rows.push(
				tbl.header.map((name) => promoted[name] || MATRIX_EMPTY_CELL),
			);
			heldRows.delete(lang);
			delete nextState["first-publish"][lang];
			committedLangs.push(lang);
		} else if (advanced.pending) {
			nextState["clean-behavior"][lang] = {
				pendingBehavior: observed.cleanBehavior,
				pendingTier: observedTier,
				runs: advanced.pending.runs,
			};
			pendingLangs.push(lang);
		}
	}
	const measured = [];
	for (const cells of tbl.rows) {
		const lang = cells[langIdx];
		const observed = byLang.get(lang);
		const cell = { lang };
		if (probed && !probed.has(lang)) {
			// A subset probe says nothing about this lang: neither advance nor drop
			// its bookkeeping (a one-lang dev run must not advance a stale streak or tick a hold).
			if (priorFp[lang]) nextState["first-publish"][lang] = priorFp[lang];
			if (priorCb[lang]) nextState["clean-behavior"][lang] = priorCb[lang];
			if (priorMissed[lang])
				nextState[MISSED_PROBE_KEY][lang] = priorMissed[lang];
			measured.push(cell);
			continue;
		}
		if (observed)
			cell.src = mergeSrc(srcIdx >= 0 ? (cells[srcIdx] ?? "") : "", src);
		// first-publish: hold a changed comparable class until two consecutive
		// observations agree, just like clean-behavior. A cell the probe no longer
		// observes keeps its last known value (#4512) and is stamped once with its
		// first miss (`firstMissed`, never slid); the `stale` column below marks it.
		const observedFp = observed?.firstPublish ?? null;
		const currentFp = fpIdx >= 0 ? cells[fpIdx] : "";
		const fpObserved = MEASURED_FIRST_PUBLISHES.has(observedFp);
		if (fpObserved) {
			const held = priorFp[lang];
			const advanced = advancePendingClass(
				currentFp,
				held?.pendingFirstPublish
					? { value: held.pendingFirstPublish, runs: Number(held.runs ?? 1) }
					: undefined,
				observedFp,
				agreeRuns,
			);
			if (advanced.committed) {
				cell["first-publish"] = advanced.confirmed;
				committedLangs.push(lang);
			} else if (advanced.pending) {
				nextState["first-publish"][lang] = {
					pendingFirstPublish: advanced.pending.value,
					runs: advanced.pending.runs,
				};
				pendingLangs.push(lang);
			}
		} else if (MEASURED_FIRST_PUBLISHES.has(currentFp)) {
			// A missing, garbage or future stamp restarts the clock today. The
			// stamp is the #4615 census's evidence for a marker-backed
			// `empty-first` cell, and the `stale` date for a `direct` one.
			const elapsed = elapsedDays(priorFp[lang]?.firstMissed, today);
			nextState["first-publish"][lang] =
				elapsed !== null && elapsed >= 0
					? priorFp[lang]
					: { firstMissed: today };
		}
		// clean-behavior/tier: hold a change until `agreeRuns` runs agree.
		const observedCb = observed?.cleanBehavior ?? null;
		if (observedCb) {
			const observedTier = observed.tier ?? "";
			const currentCb = cbIdx >= 0 ? cells[cbIdx] : "";
			const currentTier = tierIdx >= 0 ? cells[tierIdx] : "";
			if (observedCb !== currentCb || observedTier !== currentTier) {
				const held = priorCb[lang];
				const advanced = advancePendingClass(
					`${currentCb}\u0000${currentTier}`,
					held?.pendingBehavior && held?.pendingTier
						? {
								value: `${held.pendingBehavior}\u0000${held.pendingTier}`,
								runs: Number(held.runs ?? 1),
							}
						: undefined,
					`${observedCb}\u0000${observedTier}`,
					agreeRuns,
				);
				if (advanced.committed) {
					cell["clean-behavior"] = observedCb;
					cell.tier = observedTier;
					committedLangs.push(lang);
				} else if (advanced.pending) {
					nextState["clean-behavior"][lang] = {
						pendingBehavior: observedCb,
						pendingTier: observedTier,
						runs: advanced.pending.runs,
					};
					pendingLangs.push(lang);
				}
			}
		}
		// #4512: a measured cell the probe did not re-observe tonight is STALE.
		// The streak counts distinct nightly misses (a same-day rerun does not
		// advance it) and ends the night an axis is observed again.
		const missedAxes = {
			"clean-behavior":
				MEASURED_CLEAN_BEHAVIORS.has(cbIdx >= 0 ? cells[cbIdx] : "") &&
				!observed?.cleanBehavior,
			"first-publish": MEASURED_FIRST_PUBLISHES.has(currentFp) && !fpObserved,
		};
		const streaks = {};
		for (const axis of MISSED_PROBE_AXES) {
			if (!missedAxes[axis]) continue;
			const held = priorMissed[lang]?.[axis];
			streaks[axis] = held
				? {
						since: held.since,
						last: today,
						misses: held.last === today ? held.misses : held.misses + 1,
					}
				: { since: today, last: today, misses: 1 };
		}
		const missed = Object.values(streaks);
		if (missed.length) {
			nextState[MISSED_PROBE_KEY][lang] = streaks;
			cell.stale = `since ${missed.map((x) => x.since).sort(compareStableStrings)[0]}`;
			staleLangs.push(lang);
			if (missed.some((x) => x.misses >= raiseRuns)) raisedLangs.push(lang);
		} else if (staleIdx >= 0 && cells[staleIdx] !== MATRIX_EMPTY_CELL) {
			cell.stale = MATRIX_EMPTY_CELL;
		}
		measured.push(cell);
	}
	const merged = mergeRows(tbl.rows, tbl.header, measured, "lang", [
		"clean-behavior",
		"first-publish",
		"tier",
		"src",
		"stale",
	]);
	// `replaceTable` only returns null for a table `parseTable` cannot find, and
	// this same text and marker were parsed above.
	const table = replaceTable(migrated, marker, tbl.header, tbl.sep, merged);
	const out = replaceRefreshStateSection(
		heldRows.size === heldBefore ? table : writeHeldRows(table, heldRows),
		renderRefreshStateSection(nextState),
	);
	return {
		text: out,
		changed: out !== text,
		pending: pendingLangs.length,
		committed: committedLangs.length,
		pendingLangs,
		committedLangs,
		gatedLangs,
		staleLangs,
		raisedLangs,
	};
}

/**
 * #4512: the raised stale cells of a refreshed doc, for the tracking issue.
 * Reads each raised lang's row and its missed-probe streak from the refreshed
 * text, so the issue shows the last known values the matrix is still holding.
 *
 * @param {string} text  the refreshed doc
 * @param {Iterable<string>} raisedLangs
 * @param {string} [marker]
 * @returns {Array<{ lang: string, server: string, cleanBehavior: string, firstPublish: string, since: string, misses: number }>}
 */
export function describeRaisedCells(
	text,
	raisedLangs,
	marker = "| lang | server |",
) {
	const tbl = parseTable(text, marker);
	if (!tbl) return [];
	const col = (name) => tbl.header.indexOf(name);
	const streaks = sanitizeMissedProbeState(
		parseRefreshState(text)[MISSED_PROBE_KEY],
	);
	const out = [];
	for (const lang of raisedLangs) {
		const cells = tbl.rows.find((c) => c[col("lang")] === lang);
		// The axis missed the most nights in a row is the one that raised the lang.
		const streak = Object.values(streaks[lang] ?? {}).sort(
			(a, b) => b.misses - a.misses,
		)[0];
		if (!cells || !streak) continue;
		out.push({
			lang,
			server: cells[col("server")] ?? "",
			cleanBehavior: cells[col("clean-behavior")] ?? "",
			firstPublish: cells[col("first-publish")] ?? "",
			since: streak.since,
			misses: streak.misses,
		});
	}
	return out;
}

/**
 * #5323: the generated table that holds a measured push server the curated
 * matrix has no row for, until the clean-signal probe commits its
 * `clean-behavior`. The curated matrix stays the clean-behavior census's whole
 * population (no blank or admitted rows); this table is outside it.
 * Its header never contains the curated marker `| lang | server |`, so no
 * reader of the curated table can find this one instead.
 */
export const HELD_ROWS_HEADING =
	"## Measured, not yet characterized (nightly-generated)";
export const HELD_ROWS_MARKER = "| lang | mode | server |";
const HELD_COLUMNS = [
	"lang",
	"mode",
	"server",
	"src",
	"version",
	"install",
	"stale",
];
const HELD_ROWS_PROSE = [
	"Generated by the nightly; not part of the clean-behavior census. A push",
	"server the curated matrix has no row for waits here until",
	"probe-clean-signal commits its `clean-behavior` (two agreeing nights, as for",
	"a curated cell) and it agrees with the server's `silentOnClean` marker; that",
	"night it moves to the matrix above. `stale` is the",
	"first night characterize-lsp did not measure the server, kept until it does.",
];

/**
 * The held rows of `text` by lang, in table order, each keyed by column name
 * (a cell the table lacks reads `—`). Empty when the table is absent.
 *
 * @param {string} text
 * @returns {Map<string, Record<string, string>>}
 */
function readHeldRows(text) {
	const tbl = parseTable(text, HELD_ROWS_MARKER);
	const out = new Map();
	if (!tbl) return out;
	for (const cells of tbl.rows) {
		const row = {};
		for (const col of HELD_COLUMNS) {
			const at = tbl.header.indexOf(col);
			row[col] = at >= 0 && cells[at] ? cells[at] : MATRIX_EMPTY_CELL;
		}
		out.set(row.lang, row);
	}
	return out;
}

/**
 * Write `held` back as the held table. A doc without the section gains it
 * before `## Key findings` (or at the end) only when there is a row to hold;
 * a section that exists is kept even when it empties.
 *
 * @param {string} text
 * @param {Map<string, Record<string, string>>} held
 * @returns {string}
 */
function writeHeldRows(text, held) {
	const rows = [...held.values()].map((row) =>
		HELD_COLUMNS.map((col) => row[col] || MATRIX_EMPTY_CELL),
	);
	const sep = `|${HELD_COLUMNS.map(() => "---").join("|")}|`;
	if (parseTable(text, HELD_ROWS_MARKER))
		return replaceTable(text, HELD_ROWS_MARKER, HELD_COLUMNS, sep, rows);
	if (rows.length === 0) return text;
	const section = [
		HELD_ROWS_HEADING,
		"",
		...HELD_ROWS_PROSE,
		"",
		renderRow(HELD_COLUMNS),
		sep,
		...rows.map(renderRow),
		"",
	].join("\n");
	const keyFindings = text.indexOf("\n## Key findings");
	return keyFindings >= 0
		? `${text.slice(0, keyFindings + 1)}${section}\n${text.slice(keyFindings + 1)}`
		: `${text.trimEnd()}\n\n${section}`;
}

/**
 * Merge one characterize-lsp run into the capability matrix: the measured
 * `mode` (and the Tier 1 for a pull server) plus the #4512 provenance
 * (`version`, `install`). MERGE, don't overwrite: a row this run could not
 * measure keeps its prior value (#390). Rows whose mode came back
 * `unknown`/`no-lsp`/error are not written, but their provenance still is: a
 * server that did not answer still ran some version of some install.
 *
 * #5323: a measured server with no row gets one, but only a server lang
 * (`opts.serverLangs`: the fixture `probePopulation` picks for a registry
 * server) can create a row, and only a measured mode does; a variant fixture
 * or a provenance line alone never adds one. Without `serverLangs` nothing is
 * added. A new pull server joins the curated table (pull is the whole clean
 * answer); a new push server joins the held table until its clean-behavior
 * commits (`refreshCapabilityMatrix`). A held row this run did not measure
 * stays, marked `stale` from its first missed night; `probedLangs` scopes a
 * subset run as for the refresh.
 *
 * @param {string} text  the current doc
 * @param {Array<{ lang: string, server?: string, mode: string }>} rows  this run's mode rows
 * @param {Map<string, { install: string, version?: string }>} provenance  by lang
 * @param {string} src  `ci` or `dev`
 * @param {string} [marker]
 * @param {{ serverLangs?: Iterable<string>, probedLangs?: Iterable<string>, now?: Date | number | string }} [opts]
 * @returns {{ text: string, measured: number, rows: number, held: number } | null}  `null` when the table is not found
 */
export function mergeCharacterization(
	text,
	rows,
	provenance,
	src,
	marker = "| lang | server |",
	opts = {},
) {
	const migrated = ensureMatrixColumns(text, marker);
	const tbl = parseTable(migrated, marker);
	if (!tbl) return null;
	const langIdx = tbl.header.indexOf("lang");
	const srcIdx = tbl.header.indexOf("src");
	const existingByLang = new Map(tbl.rows.map((c) => [c[langIdx], c]));
	const serverLangs = new Set(opts.serverLangs ?? []);
	const probed = opts.probedLangs ? new Set(opts.probedLangs) : null;
	const held = readHeldRows(migrated);
	// pull => Tier 1 by protocol; push-only tier is decided by the clean-behavior
	// probe, so `tier` stays untouched for push rows (don't clobber a probed value).
	const cells = new Map();
	const measuredLangs = new Set();
	for (const r of rows) {
		if (r.mode !== "pull" && r.mode !== "push-only") continue;
		measuredLangs.add(r.lang);
		const prior = existingByLang.get(r.lang);
		if (prior) {
			const cell = { lang: r.lang, mode: r.mode };
			if (r.mode === "pull") cell.tier = "1";
			cell.src = mergeSrc(prior[srcIdx], src);
			cells.set(r.lang, cell);
			continue;
		}
		const heldRow = held.get(r.lang);
		if (!heldRow && !serverLangs.has(r.lang)) continue;
		const server = r.server || heldRow?.server || MATRIX_EMPTY_CELL;
		const rowSrc = mergeSrc(heldRow?.src, src);
		if (r.mode === "push-only") {
			held.set(r.lang, {
				...heldRow,
				lang: r.lang,
				mode: r.mode,
				server,
				src: rowSrc,
				stale: MATRIX_EMPTY_CELL,
			});
			continue;
		}
		held.delete(r.lang);
		cells.set(r.lang, {
			lang: r.lang,
			server,
			mode: r.mode,
			"clean-behavior": MATRIX_EMPTY_CELL,
			"first-publish": "n/a (pull)",
			tier: "1",
			src: rowSrc,
			version: heldRow?.version ?? MATRIX_EMPTY_CELL,
			install: heldRow?.install ?? MATRIX_EMPTY_CELL,
			stale: MATRIX_EMPTY_CELL,
		});
	}
	for (const [lang, p] of provenance) {
		const target =
			held.get(lang) ??
			cells.get(lang) ??
			(existingByLang.has(lang) ? { lang } : undefined);
		if (!target) continue;
		target.install = p.install;
		if (p.version) target.version = p.version;
		if (!held.has(lang)) cells.set(lang, target);
	}
	const today = utcDay(opts.now ?? new Date());
	for (const [lang, row] of held) {
		if (measuredLangs.has(lang) || (probed && !probed.has(lang))) continue;
		if (!/^since \d{4}-\d{2}-\d{2}$/.test(row.stale))
			row.stale = `since ${today}`;
	}
	const merged = mergeRows(tbl.rows, tbl.header, [...cells.values()], "lang", [
		"mode",
		"tier",
		"src",
		"version",
		"install",
	]);
	return {
		text: writeHeldRows(
			replaceTable(migrated, marker, tbl.header, tbl.sep, merged),
			held,
		),
		measured: measuredLangs.size,
		rows: tbl.rows.length,
		held: held.size,
	};
}

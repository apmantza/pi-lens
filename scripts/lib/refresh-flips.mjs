// #4512 acceptance 5: a refresh with no flips lands without a manual step, and
// a refresh with flips says so. A "flip" is any change to a regenerated LSP doc
// other than the short list of surfaces known to be measurement bookkeeping.
//
// Fail closed (principles section 1, "Gates fail closed"): the gate admits the
// benign surfaces below and refuses every other difference, so a new column, a
// new section or a changed footnote is a flip until someone names it benign.
// Pure over text, so the recorded-run tests need no git and no network.
import { GENERATED_LSP_DOCS, parseTable, replaceTable } from "./md-matrix.mjs";

const MATRIX_DOC = "docs/lsp-capability-matrix.md";
const MATRIX_MARKER = "| lang | server |";

/**
 * The matrix columns that record how or when a row was measured, not what the
 * server does. A change in only these is not a capability flip: `src` (where it
 * ran), `version`/`install` (what ran, #4512) and `stale` (when the probe last
 * missed it).
 */
export const BENIGN_MATRIX_COLUMNS = ["src", "version", "install", "stale"];

/** `_Last generated: <date> ..._` is volatile on purpose (#3380). */
const GENERATED_LINE = /^_Last generated: .*_$/;

const STATE_HEADING = "## Capability matrix refresh state (nightly-generated)";

/**
 * Replace the refresh-state JSON payload (and only it) with a placeholder. The
 * section's heading and prose stay compared, so a changed generator or text
 * smuggled into the section is a flip; the counters inside the fence are
 * bookkeeping by definition.
 */
function maskRefreshStatePayload(text) {
	const lines = text.split("\n");
	const heading = lines.findIndex((l) => l.trim() === STATE_HEADING);
	if (heading < 0) return text;
	const open = lines.indexOf("```json", heading + 1);
	const close = open < 0 ? -1 : lines.indexOf("```", open + 1);
	if (close < 0) return text;
	lines.splice(open + 1, close - open - 1, "<refresh-state>");
	return lines.join("\n");
}

/**
 * The doc text with every admitted-benign surface removed.
 *
 * @param {string} docPath
 * @param {string} text
 * @returns {string}
 */
export function maskGeneratedDoc(docPath, text) {
	let out = String(text)
		.split("\n")
		.filter((line) => !GENERATED_LINE.test(line))
		.join("\n");
	if (docPath !== MATRIX_DOC) return out;
	out = maskRefreshStatePayload(out);
	const tbl = parseTable(out, MATRIX_MARKER);
	if (!tbl) return out;
	const keep = tbl.header
		.map((name, i) => [name, i])
		.filter(([name]) => !BENIGN_MATRIX_COLUMNS.includes(name))
		.map(([, i]) => i);
	const header = keep.map((i) => tbl.header[i]);
	const sep = `|${header.map(() => "---").join("|")}|`;
	const rows = tbl.rows.map((cells) => keep.map((i) => cells[i] ?? ""));
	return replaceTable(out, MATRIX_MARKER, header, sep, rows) ?? out;
}

/** Multiset difference `a - b` over lines (order and duplicates counted). */
function lineDifference(a, b) {
	const remaining = new Map();
	for (const line of b) remaining.set(line, (remaining.get(line) ?? 0) + 1);
	const out = [];
	for (const line of a) {
		const n = remaining.get(line) ?? 0;
		if (n > 0) remaining.set(line, n - 1);
		else out.push(line);
	}
	return out;
}

const clip = (line) => (line.length > 240 ? `${line.slice(0, 237)}...` : line);

/**
 * Every flip between HEAD's generated docs and the regenerated ones, as
 * `<path>: - <removed line>` / `<path>: + <added line>` entries. Empty means
 * the refresh is flip-free. A doc HEAD lacks, or the regeneration lacks, is a
 * flip by name.
 *
 * @param {Record<string, string | null | undefined>} headDocs  by repo path
 * @param {Record<string, string | null | undefined>} newDocs   by repo path
 * @returns {string[]}
 */
export function listRefreshFlips(headDocs, newDocs) {
	const flips = [];
	for (const docPath of GENERATED_LSP_DOCS) {
		const head = headDocs[docPath];
		const next = newDocs[docPath];
		if (typeof head !== "string" || typeof next !== "string") {
			if (head !== next)
				flips.push(
					`${docPath}: ${typeof head === "string" ? "missing from the regeneration" : "not at HEAD"}`,
				);
			continue;
		}
		const a = maskGeneratedDoc(docPath, head).split("\n");
		const b = maskGeneratedDoc(docPath, next).split("\n");
		for (const line of lineDifference(a, b))
			flips.push(`${docPath}: - ${clip(line)}`);
		for (const line of lineDifference(b, a))
			flips.push(`${docPath}: + ${clip(line)}`);
	}
	return flips;
}

// The body lint caps a code fence at 20 lines (check-pr-body.mjs, #5003): all
// the flips when they fit, else 19 and the "... N more" line.
const MAX_FENCE_LINES = 20;

/**
 * The refresh PR body. `landing` is what the workflow can do with a flip-free
 * refresh: `automerge` (armed, the repository opted in), `ci-only` (CI starts
 * through the App token; a maintainer merges) or `manual` (the repository
 * `GITHUB_TOKEN` opened it, so CI does not start until a close and reopen).
 *
 * The body follows .github/PULL_REQUEST_TEMPLATE.md because the PR is linted
 * like any other (#5062): the flips verdict and landing sit in the reviewer
 * notes, the listed flips in the change outline, and the proof sections carry
 * the honest docs-only answers.
 *
 * @param {{ flips: readonly string[], landing: "automerge" | "ci-only" | "manual", issuesUrl?: string, checkFailed?: boolean }} input
 * @returns {string}
 */
export function buildRefreshPrBody({ flips, landing, issuesUrl, checkFailed }) {
	const verdict = checkFailed
		? "Capability flips: The flip check could not run, so this refresh is treated as having flips and is not armed for auto-merge."
		: flips.length === 0
			? "Capability flips: None. Only `src`, `version`, `install`, `stale`, the refresh state and the generation date differ from `master`."
			: `Capability flips: ${flips.length} changed line(s) outside \`src\`, \`version\`, \`install\`, \`stale\`, the refresh state and the generation date. A maintainer reviews this refresh.`;
	let landed;
	if (landing === "automerge" && !checkFailed && flips.length === 0) {
		landed =
			"Landing: No flips: auto-merge is armed. CI runs on this PR because it was opened with the refresh App token, and GitHub merges it when the required checks pass.";
	} else if (landing === "manual") {
		landed =
			"Landing: this PR is created with the repository `GITHUB_TOKEN`, which cannot trigger workflow runs. After the bot opens or updates it, a maintainer must close and reopen the PR to arm CI. (Configure the refresh App to remove this step.)";
	} else {
		landed =
			"Landing: CI runs on this PR because it was opened with the refresh App token. A maintainer merges it.";
	}
	// The Tests line says whether the flips were classified. The check can fail
	// (landRefresh's catch), and then the body must not claim it ran.
	const flipCheck = checkFailed
		? "The flip check could not run, so the flips were not classified against `master`."
		: "`scripts/lsp-refresh-landing.mjs` classified the flips above against `master`.";
	const lines = [
		"## Summary",
		"",
		"Automated nightly refresh of the LSP capability docs from the tool-smoke run: docs only, no runtime code changes.",
		"The capability-flip verdict and the landing path are under the reviewer notes.",
		"",
		"Refs #460, #390, #529, #4512.",
		"",
		"## Notes for the reviewer",
		"",
		`- ${verdict}`,
		`- ${landed}`,
		"- The two matrix docs are **merged**, never blind-overwritten: a server this ubuntu host couldn't spawn keeps its prior (dev-box) classification, so the nightly can't regress a richer run (#390). `docs/lsp-idle-eviction.md` is the exception: it is regenerated in full, so a server this host cannot spawn reads `unavailable`.",
	];
	if (!checkFailed && flips.length > 0 && issuesUrl)
		lines.push(`- Open nightly drift issues: ${issuesUrl}`);
	lines.push(
		"",
		"## Change outline",
		"",
		"- `docs/lsp-capability-matrix.md` — `mode` (characterize-lsp) + `clean-behavior` (probe-clean-signal, Tier 2 vs 3) columns (#460) + a `## silentOnClean drift` footnote (#529, telemetry only — never a gate); `version`/`install` (what the nightly ran) and `stale` (a cell the probe did not re-observe, with the date of its first miss) per row (#4512)",
		"- `docs/servercapabilities.md` — advertised capability inventory incl. ws-pull (#389)",
		"- `docs/lsp-idle-eviction.md` — per-server idle-eviction safety (#3645): stable columns only (result, reason, respawn, coverage; timings live in the run log). A declared-versus-measured finding there is for a maintainer to act on in a follow-up; this refresh changes no policy",
	);
	if (!checkFailed && flips.length > 0) {
		const fits = flips.length <= MAX_FENCE_LINES;
		const shown = fits ? flips : flips.slice(0, MAX_FENCE_LINES - 1);
		lines.push(
			"",
			"```diff",
			...shown,
			...(fits
				? []
				: [
						`... ${flips.length - shown.length} more, in the Files changed diff`,
					]),
			"```",
		);
	}
	lines.push(
		"",
		"## Proof and checks",
		"",
		"### Tests",
		"",
		"Docs-only regeneration: this diff changes no test file. The PR step runs only after the nightly LSP capability census (`tests/config/lsp-first-publish-census.test.ts`, `tests/config/lsp-clean-behavior-census.test.ts`) succeeded on the regenerated docs. " +
			flipCheck,
		"",
		"### Class sweep",
		"",
		"none: docs-only regeneration of generated LSP docs, no runtime code.",
		"",
		"Alignment: none: generated docs touch no alignment-family member",
		"",
		"### Observability",
		"",
		"none: docs-only diff with no runtime code and no new failure path.",
		"",
		"### Fold check",
		"",
		"none: bot-generated docs regeneration with no code mechanism to fold into.",
	);
	return `${lines.join("\n")}\n`;
}

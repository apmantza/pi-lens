// Rendering, parsing and the declared-versus-measured drift check for the
// nightly LSP idle-eviction measurement (#3645). Pure: rows in, text or
// findings out, so the durable artifact and its drift rules are testable
// without spawning a language server. The measurement itself lives in
// lsp-idle-eviction-probe.mjs; the script that drives both is
// scripts/measure-lsp-idle-eviction.mjs.
//
// Why the committed document carries only STABLE columns (result, reason,
// respawn, coverage): a nightly refresh PR opens whenever the document changes
// by anything but its date (`compareGeneratedDocs`), and every timing or memory
// figure differs on every run, bucketed or not (review round 1 F1: two
// back-to-back local runs flipped 7 of 30 bucket cells). The figures are
// evidence, not diff noise, so they go to the run's step log, its job summary
// and the JSON summary.

import { compareStableStrings, parseTable } from "./md-matrix.mjs";

/**
 * Bounded vocabulary for a row's reason. The document never renders free text
 * from a server or a runner, so an unrelated error message cannot churn it.
 */
export const REASONS = {
	"no-fixture":
		"No smoke fixture routes to this server, so there is nothing to spawn.",
	"tool-unavailable":
		"A tool this server's fixture needs could not be installed or found on the generating host.",
	"setup-failed": "The fixture's workspace setup step failed.",
	"server-not-started":
		"The fixture ran but this server never became a live client.",
	"budget-exhausted":
		"The run's wall-clock budget ended before this server was reached.",
	"probe-error": "The probe itself threw before it had a baseline.",
	"no-baseline":
		"The server produced no finding on the fixture, so nothing can show its coverage survives eviction.",
	"not-evicted":
		"The idle-eviction timer did not release the client within the bound.",
	"client-died":
		"The client went away without an idle-eviction record, so the release was a crash, not the eviction path.",
	"respawn-failed":
		"After eviction the next request could not bring the server back.",
	"findings-narrowed":
		"After the respawn the server reported fewer findings than before eviction.",
};

/** The four outcomes a row can have. */
export const RESULT_STATES = [
	"eligible",
	"vetoed",
	"inconclusive",
	"unavailable",
];

const MB = 1024 * 1024;

/** Count rows by result; `budget` is the subset of unavailable never reached. */
export function summarizeRows(rows) {
	const counts = {
		total: rows.length,
		eligible: 0,
		vetoed: 0,
		inconclusive: 0,
		unavailable: 0,
		budget: 0,
	};
	for (const row of rows) {
		counts[row.result] += 1;
		if (row.reason === "budget-exhausted") counts.budget += 1;
	}
	return counts;
}

/**
 * Declared-versus-measured findings. `declared` maps a server id to its
 * registry `idleEviction`; `rows` are this run's measurements.
 *
 * Only `transparent-vetoed` is drift: the registry evicts a server the
 * measurement says breaks. Everything else is a proposal or a note for a
 * human, because the measurement proposes and a follow-up flips the policy.
 *
 * @returns {{ serverId: string, kind: string, severity: "drift" | "proposal" | "info", detail: string }[]}
 */
export function idleEvictionDrift(rows, declared) {
	const findings = [];
	for (const row of [...rows].sort((a, b) =>
		compareStableStrings(a.serverId, b.serverId),
	)) {
		const policy = declared.get(row.serverId);
		const why = row.reason ? ` (${row.reason})` : "";
		if (row.result === "eligible" && row.widened > 0) {
			findings.push({
				serverId: row.serverId,
				kind: "widened",
				severity: "info",
				detail: `reported ${row.widened} more finding(s) after the respawn than before eviction; a policy flip needs "preserved" without widening on several nights`,
			});
		}
		if (policy === "transparent" && row.result === "vetoed") {
			findings.push({
				serverId: row.serverId,
				kind: "transparent-vetoed",
				severity: "drift",
				detail: `declared transparent but the measurement vetoes it${why}`,
			});
		} else if (
			policy === "transparent" &&
			(row.result === "inconclusive" || row.result === "unavailable")
		) {
			findings.push({
				serverId: row.serverId,
				kind: "transparent-unverified",
				severity: "info",
				detail: `declared transparent with no evidence this run: ${row.result}${why}`,
			});
		} else if (policy === "unmeasured" && row.result === "eligible") {
			findings.push({
				serverId: row.serverId,
				kind: "unmeasured-eligible",
				severity: "proposal",
				detail:
					"declared unmeasured but eviction and respawn preserved its findings",
			});
		} else if (policy === "unmeasured" && row.result === "vetoed") {
			findings.push({
				serverId: row.serverId,
				kind: "unmeasured-vetoed",
				severity: "proposal",
				detail: `declared unmeasured and the measurement vetoes eviction${why}; consider declaring resident`,
			});
		} else if (policy === "resident" && row.result === "eligible") {
			findings.push({
				serverId: row.serverId,
				kind: "resident-eligible",
				severity: "info",
				detail:
					"declared resident although eviction and respawn preserved its findings",
			});
		}
	}
	return findings;
}

/** Title of the single persistent tracking issue for hard drift (#3645). */
export const IDLE_EVICTION_DRIFT_TITLE =
	"nightly: LSP idle-eviction drift (declared transparent, measured vetoed)";

/**
 * The tracking issue's body, or null when no server is in hard drift. Only
 * `drift` findings file an issue: a proposal or note is for the committed
 * document's reviewers, while a server the registry evicts that the measurement
 * vetoes is shipped behaviour breaking on respawn.
 *
 * @param {{ serverId: string, kind: string, severity: string, detail: string }[]} findings
 * @param {{ runUrl?: string | null }} [options]
 */
export function buildIdleEvictionDriftBody(findings, options = {}) {
	const drift = findings.filter((f) => f.severity === "drift");
	if (drift.length === 0) return null;
	const lines = [
		"Auto-filed by the nightly `tool-smoke` idle-eviction measurement (#3645).",
		"",
		'The registry declares these servers `idleEviction: "transparent"`, so the shared idle timer releases them, but this run\'s respawn of each one failed or reported fewer findings than before eviction. Declare them `resident` (with a reason in `tests/config/lsp-idle-eviction-reasons.json`) or fix the respawn. The per-server rows are in `docs/lsp-idle-eviction.md`.',
		"",
		...drift.map((f) => `- **${f.serverId}**: ${f.detail}`),
	];
	if (options.runUrl) lines.push("", `Workflow run: ${options.runUrl}`);
	lines.push(
		"",
		"This issue is closed automatically once a nightly run finds no such server.",
	);
	return lines.join("\n");
}

/**
 * What the tracking issue should do. `drift`: at least one server the registry
 * declares `transparent` is vetoed. `clean`: EVERY transparent server has an
 * `eligible` row this run. `unknown`: anything else (a transparent server that
 * is unavailable, budget-exhausted, client-died, not-evicted, no-baseline, or
 * absent from a filtered run): no evidence either way, so the issue is left
 * as it is. Closing on the absence of drift would close it exactly when the
 * measurement could not see (review round 1 F3).
 *
 * @returns {"drift" | "clean" | "unknown"}
 */
export function driftIssueState(rows, declared) {
	const byId = new Map(rows.map((row) => [row.serverId, row]));
	let clean = true;
	for (const [serverId, policy] of declared) {
		if (policy !== "transparent") continue;
		const row = byId.get(serverId);
		if (row?.result === "vetoed") return "drift";
		if (row?.result !== "eligible") clean = false;
	}
	return clean ? "clean" : "unknown";
}

const cell = (value) => (value === undefined || value === null ? "n/a" : value);

function rowCells(row, declared) {
	return [
		row.serverId,
		row.role ?? "primary",
		declared.get(row.serverId) ?? "?",
		row.result,
		row.reason ?? "·",
		cell(row.respawn),
		cell(row.coverage),
	];
}

/**
 * Render the durable artifact. `declared` is read from the registry by the
 * caller at generation time. Rows are sorted by server id with a
 * locale-independent comparator so a runner's locale never changes the text.
 */
export function renderIdleEvictionDoc({ rows, declared, date, platform }) {
	const sorted = [...rows].sort((a, b) =>
		compareStableStrings(a.serverId, b.serverId),
	);
	const counts = summarizeRows(sorted);
	const lines = [
		"# LSP idle-eviction measurement",
		"",
		"Per-server cost and safety of releasing an idle language-server client, measured",
		"by the nightly so each server's `idleEviction` declaration in",
		"`clients/lsp/server.ts` can be made from evidence (#3645). Generated by",
		"`node scripts/measure-lsp-idle-eviction.mjs` (requires",
		"`npm run build:dist`); it changes no server's policy.",
		"",
		"For each registry server the probe spawns the server on its smoke fixture,",
		"records the first diagnostics, then makes the server evictable in the probe",
		"process only and lets the real idle-eviction timer release it. The next request",
		"respawns it through the ordinary path. A server is `eligible` only when the",
		"respawned server reports every finding it reported before eviction; the",
		"`coverage` column is that comparison, and for an auxiliary scanner it is the",
		"content-bound coverage check the auxiliary freeze depends on. A server that",
		"cannot demonstrate it is never proposed for eviction on perf grounds alone.",
		"",
		`_Last generated: ${date} on ${platform}; ${counts.total} registry servers: ${counts.eligible} eligible, ${counts.vetoed} vetoed, ${counts.inconclusive} inconclusive, ${counts.unavailable} unavailable (${counts.budget} not reached: budget)._`,
		"",
		"## Per-server rows",
		"",
		"Only stable columns are committed, so the nightly refresh changes this file",
		"only when a server's outcome changes. The measured init duration, resident",
		"memory of the server's process tree and post-eviction cold start are in the",
		"nightly run's step log and job summary, one row per server. `n/a` means not",
		"measured, never zero: **respawn** is whether the next request after eviction",
		"brought the server back, **coverage** is whether the respawned server kept",
		"every baseline finding.",
		"",
		"A server that reports extra findings after the respawn (`widened`) still reads",
		"`preserved`, because nothing was lost, but a first scan that grows on respawn",
		"is a sign the baseline was partial. Any policy flip needs `preserved` on",
		"several nights, not one; a `widened` disclosure is per run and is shown in the",
		"step log only, because it flaps.",
		"",
		"| server | role | declared | result | reason | respawn | coverage |",
		"|---|---|---|---|---|---|---|",
	];
	for (const row of sorted) {
		lines.push(`| ${rowCells(row, declared).join(" | ")} |`);
	}
	// `widened` is per-run and flaps (it depends on how far the first scan got),
	// so it stays out of the committed document.
	const findings = idleEvictionDrift(sorted, declared).filter(
		(f) => f.kind !== "widened",
	);
	lines.push("", "## Declared versus measured", "");
	if (findings.length === 0) {
		lines.push(
			"No divergence between declared policy and this run's measurement.",
		);
	} else {
		lines.push(
			"`drift` means the registry evicts a server the measurement vetoes. A `proposal`",
			"or `info` line is for a maintainer to act on in a follow-up; this run changed",
			"nothing.",
			"",
		);
		for (const f of findings) {
			lines.push(`- **${f.serverId}** [${f.severity}] ${f.detail}`);
		}
	}
	lines.push("", "## Reasons", "");
	for (const [code, text] of Object.entries(REASONS)) {
		lines.push(`- \`${code}\`: ${text}`);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Per-server timing and memory figures for the run's step log and job summary:
 * the evidence the committed document deliberately does not carry.
 */
export function renderRawTable(rows) {
	const sorted = [...rows].sort((a, b) =>
		compareStableStrings(a.serverId, b.serverId),
	);
	const mb = (bytes) =>
		typeof bytes === "number" ? String(Math.round(bytes / MB)) : "n/a";
	const ms = (value) =>
		typeof value === "number" ? String(Math.round(value)) : "n/a";
	return [
		"| server | result | reason | init ms | rss MB | cold start ms |",
		"|---|---|---|---|---|---|",
		...sorted.map(
			(r) =>
				`| ${r.serverId} | ${r.result} | ${r.reason ?? "·"} | ${ms(r.initMs)} | ${mb(r.rssBytes)} | ${ms(r.coldStartMs)} |`,
		),
		"",
	].join("\n");
}

const TABLE_MARKER = "| server | role | declared | result |";

/**
 * Read the per-server rows back out of a rendered document. Returns null when
 * the table is absent, so a governance test can name the problem instead of
 * passing on an empty population.
 *
 * @returns {{ serverId: string, role: string, declared: string, result: string, reason: string | undefined }[] | null}
 */
export function parseIdleEvictionDoc(text) {
	const table = parseTable(text, TABLE_MARKER);
	if (!table) return null;
	const index = (name) => table.header.indexOf(name);
	return table.rows.map((cells) => ({
		serverId: cells[index("server")],
		role: cells[index("role")],
		declared: cells[index("declared")],
		result: cells[index("result")],
		reason: cells[index("reason")] === "·" ? undefined : cells[index("reason")],
	}));
}

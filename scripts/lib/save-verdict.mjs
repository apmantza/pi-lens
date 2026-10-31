// The save-triggered verdict seam (#3405 acceptance 4): the pure classifier and
// table writer behind `scripts/probe-save-verdict.mjs`.
//
// The question the table answers is narrow and must not drift: does a language
// server publish its findings WITHOUT a `textDocument/didSave`, or does only a
// save make it answer? Before this module the column in
// `docs/lsp-capability-matrix.md` was prose moved from a PR body, half of it read
// from each server's source, and no command regenerated it — so a nightly could
// not re-measure it and a reader could not reproduce a cell.
//
// Two properties make the answer trustworthy, and both live here rather than in
// the driver:
//
// - ATTRIBUTION. A row's verdict is decided by which of the measurement ARMS saw
//   the answer, never by what the driver happened to be doing: `noSave` (the
//   seeded error reaches the server as didOpen/didChange only), `silence` (an
//   untriggered window of the same length — a late answer from the first arm
//   lands here and belongs to NO arm, so the row is `inconclusive` rather than
//   credited to the save), `saveAlone` (identical bytes plus a save, so a
//   publish carries the save as its only new input) and `savedWrite` (a
//   diagnostic-neutral byte edit plus a save, the production shape).
// - MERGE. A run that could not reach a server keeps that row verbatim (#390):
//   an unreachable toolchain must never blank a measured cell, so `refresh`
//   rewrites only the rows this run measured, and a row whose run hit a failure
//   (`install`, `setup`, a thrown arm) produces NO cell at all rather than a
//   verdict read off the arm that failed (#4999 F8).
//
// Dependency-free on purpose (only `md-matrix.mjs`, itself dependency-free, for
// the markdown table primitives): the nightly writes this doc on a checkout where
// `dist/` may not exist yet, and the tests drive every rule without a language
// server.

import { parseTable, replaceTable } from "./md-matrix.mjs";

/** The table this module owns, located by its header prefix. */
export const SAVE_VERDICT_MARKER = "| server | save as declared |";

/** The column whose value states whether only a save produces an answer. */
export const SAVE_VERDICT_COLUMN = "publishes after save only";

/**
 * Every value `publishes after save only` may hold. `unknown` is the only
 * pre-measurement value (a row no run has reached); a MEASURED row must not
 * carry it, and a census in `tests/config/lsp-save-verdict-census.test.ts`
 * pins both directions so a hand edit cannot dress a guess as a measurement.
 */
export const SAVE_VERDICT_VALUES = new Set([
	"unknown",
	"no",
	"no (pull)",
	"yes",
	"yes (saved write)",
	"inconclusive",
	"cannot measure",
]);

/**
 * The command a measured cell names as its provenance. The `src` token that says
 * whether a run happened on CI or a dev box is NOT committed here: it and every
 * arm's elapsed time live in the run's log and summary, so a re-measurement that
 * changes only those is not a capability flip (#4999 F7).
 */
export const SAVE_VERDICT_COMMAND = "node scripts/probe-save-verdict.mjs";

/** Written for one run: the verdicts a probe run settled, so re-measuring one is a refresh (#4999 F3). */
const SAVE_VERDICT_SETTLED = new Set([
	"no",
	"no (pull)",
	"yes",
	"yes (saved write)",
]);

function countOf(arm) {
	const n = Number(arm?.nonEmpty ?? 0);
	return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function isCause(cause) {
	return typeof cause === "string" && cause.trim() !== "";
}

/**
 * The cause lines a fixture's install step records, one per declared tool that
 * never resolved (#4999 R3-1).
 *
 * `ensureTool` answers `undefined` for every install failure it OWNS — a failed
 * download, a policy decline, a held lock — and only throws for a bug in the
 * installer, so a caller that catches around it records nothing for the failure
 * mode it was written for. The installer already keeps the answer: every branch
 * that leaves a tool unresolved records an `InstallAttempt` with its outcome and
 * reason (`finishInstallAttempt` falls back to `"install failed"` itself), and
 * the installer's module doc names this lane's row detail as the consumer
 * (#2638). So this reads that record instead of re-deriving one; the refusal
 * map needs no second read, because every unresolved attempt already carries
 * its reason.
 *
 * A RESOLVED path is never a cause, whatever the attempt says: the trust-gated
 * branch records `declined` and still returns the binary its discovery pass
 * found, and the arms can measure on that binary.
 *
 * @param {{ lang?: string, tools?: string[] }} fixture
 * @param {{
 *   ensureTool: (toolId: string) => Promise<string | undefined>,
 *   getInstallAttempt?: (toolId: string) => { outcome: string, reason?: string } | undefined,
 * }} deps
 * @returns {Promise<string[]>} the causes, in the fixture's declared tool order
 */
export async function installCauses(fixture, deps) {
	const { ensureTool, getInstallAttempt } = deps;
	const causes = [];
	for (const tool of fixture?.tools ?? []) {
		let resolved;
		try {
			resolved = await ensureTool(tool);
		} catch (e) {
			// A throw is a hole no arm can fill; it never resolves a toolchain.
			causes.push(`install failed for ${tool}: ${e?.message ?? e}`);
			continue;
		}
		if (resolved) continue;
		const attempt = getInstallAttempt?.(tool);
		const outcome = attempt?.outcome ?? "not attempted";
		const reason = attempt?.reason ?? "no reason recorded";
		causes.push(`install ${outcome} for ${tool}: ${reason}`);
	}
	return causes;
}

/**
 * The detail a probe row reports: the install causes only where no arm measured.
 *
 * A cause is evidence about the ROW, never a verdict. `ensureTool` answers
 * `undefined` for every id the installer does not manage, and the installer
 * records `declined: unknown tool id` for gopls, csharp-ls and fsautocomplete
 * while the runner's own toolchain still supplies the binary — so letting the
 * cause decide filed a measured row as `not measured` (#4999 R4-1: go, csharp
 * and fsharp regressed in tool-smoke run 40978934098 attempt 2).
 *
 * The arms own the verdict: a row that produced `cells` keeps the arm detail and
 * carries no install cause. A row they left unmeasured names both the installer's
 * cause and the reason no arm could measure it, so an operator can still tell an
 * absent toolchain from a failed download from a crashed server.
 *
 * @param {{
 *   cells?: unknown,
 *   install?: string[],
 *   detail?: string,
 * }} row
 * @returns {string}
 */
export function detailWithInstallCauses(row) {
	const detail = typeof row?.detail === "string" ? row.detail : "";
	if (row?.cells) return detail;
	const causes = (row?.install ?? []).filter(isCause);
	return [...causes, detail].filter(Boolean).join(" — ");
}

/**
 * Classify one server's save verdict from its measurement arms.
 *
 * `mode` is the server's diagnostic mode (`pull` for a server that answers
 * `textDocument/diagnostic`, otherwise a push mode). A pull server never
 * publishes, so its no-save arm is the request's own answer; the verdict is
 * still `no`-family, marked `(pull)` so a reader does not go looking for a
 * publish that never existed. A pull server whose no-save arm saw nothing is
 * `inconclusive`, NEVER `yes` (#4999 F2): every one of its arms is a repeated
 * `textDocument/diagnostic` request, so no arm has a save as its only new
 * input, and the previous rule credited such a server with a publish it
 * cannot make.
 *
 * An arm missing from the input (the driver skipped it) is silent: every rule
 * below is positive-evidence-only, so an absent arm can never turn into a `yes`.
 * A row whose RUN failed is not classified at all — `saveVerdictCells` returns
 * no cell for it (#4999 F8).
 *
 * @param {{
 *   mode?: string,
 *   noSave?: { nonEmpty?: number, ms?: number | null },
 *   silence?: { nonEmpty?: number, ms?: number | null },
 *   saveAlone?: { nonEmpty?: number, ms?: number | null },
 *   savedWrite?: { nonEmpty?: number, ms?: number | null },
 * }} input
 * @returns {{ verdict: string, reason: string }}
 */
export function classifySaveVerdict(input) {
	const mode = input?.mode === "pull" ? "pull" : "push";
	const noSave = countOf(input?.noSave);
	const silence = countOf(input?.silence);
	const saveAlone = countOf(input?.saveAlone);
	const savedWrite = countOf(input?.savedWrite);

	if (noSave > 0) {
		return {
			verdict: mode === "pull" ? "no (pull)" : "no",
			reason:
				mode === "pull"
					? "the diagnostics request answered the seeded finding with no save, so the save is not the trigger"
					: "the seeded finding published without a save, so the save is not the trigger",
		};
	}
	// #4999 F2: a pull server's every arm is a request. Nothing it answers can be
	// attributed to a save, so the positive branches below never apply to it.
	if (mode === "pull") {
		return {
			verdict: "inconclusive",
			reason:
				"pull mode: every arm is a textDocument/diagnostic request, so no arm has the save as its only new input",
		};
	}
	// A publish in the untriggered window is a late answer from an earlier arm.
	// Crediting it to the arm that followed would turn a slow server into a
	// save-triggered one, which is the one wrong direction that matters here.
	if (silence > 0) {
		return {
			verdict: "inconclusive",
			reason: `${silence} finding(s) arrived in the untriggered window after the no-save arm, so no arm owns the answer`,
		};
	}
	if (saveAlone > 0) {
		return {
			verdict: "yes",
			reason:
				"the same bytes produced nothing without a save and findings after the save alone",
		};
	}
	if (savedWrite > 0) {
		return {
			verdict: "yes (saved write)",
			reason:
				"neither the unsaved seed nor the save alone published, and a diagnostic-neutral edit plus a save did",
		};
	}
	return {
		verdict: "inconclusive",
		reason:
			"no arm published, so this fixture does not distinguish a save-triggered server from one that never diagnoses it",
	};
}

/**
 * `3 publish events`, or `silent (6000 ms)`.
 *
 * Not the arm's elapsed time (#4999 F7): it moves on every run, so a
 * timing-only difference would arrive as a capability flip and disarm the
 * refresh PR's auto-merge. Every arm's elapsed time goes to the run log; only
 * the window survives in the cell, and it is a flag the nightly passes once for
 * every arm of a run, not an observation.
 *
 * `unit` is the arm's singular noun — `finding` (the default), `publish event`,
 * `diagnostic` — and is pluralised here so a cell cannot report publish events
 * as findings (#4999 F9).
 *
 * @param {{ nonEmpty?: number, ms?: number | null } | undefined} arm
 * @param {number} waitMs
 * @param {string} [unit]
 */
export function describeArm(arm, waitMs, unit = "finding") {
	const n = countOf(arm);
	if (n === 0) return `silent (${waitMs} ms)`;
	return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * The clean-gate policy a fixture already declares, so a regenerated row keeps
 * saying whether the server gates the nightly. Derived from the fixture, never
 * restated by hand: the table cannot then claim a policy the harness no longer
 * applies.
 *
 * @param {{ auxiliaryServerIds?: string[], lspGate?: boolean, lspGateExempt?: string }} fixture
 */
export function fixturePolicy(fixture) {
	if (fixture?.auxiliaryServerIds?.length) return "Auxiliary, not gated.";
	if (fixture?.lspGate === true) return "Gated.";
	if (typeof fixture?.lspGateExempt === "string")
		return "Exempt from the clean gate.";
	return "";
}

/**
 * Render the three owned cells of one measured row.
 *
 * @param {{
 *   server: string,
 *   save: string,
 *   mode: string,
 *   fixture: { lang: string, auxiliaryServerIds?: string[], lspGate?: boolean, lspGateExempt?: string },
 *   arms: Parameters<typeof classifySaveVerdict>[0],
 *   waitMs: number,
 *   failures?: string[],
 * }} row
 * @returns {Record<string, string> | undefined} cell values keyed by column name,
 *   or `undefined` when the run could not complete an arm the row needs (the
 *   caller then leaves the row unmeasured, so the merge guard keeps it)
 */
export function saveVerdictCells(row) {
	// #4999 F8: an arm that threw, or an install/setup that failed, leaves a hole
	// no arm can fill. The zeroed arms it produces read as silence, and a
	// publishing save-alone arm would then mint a `yes` for a comparison that
	// never happened — so this row gets NO cell and the merge guard keeps the
	// prior one (#390). The cause reaches the run log through the driver.
	if ((row?.failures ?? []).some(isCause)) return undefined;
	const { verdict, reason } = classifySaveVerdict({
		mode: row.mode,
		...row.arms,
	});
	// A push arm counts publish EVENTS (one event may carry several findings); a
	// pull arm counts the diagnostics a request answered. Naming the unit is
	// what keeps the cell from reporting publishes as findings (#4999 F9).
	const unit = row.mode === "pull" ? "diagnostic" : "publish event";
	const noSave = describeArm(row.arms?.noSave, row.waitMs, unit);
	const saveAlone = describeArm(row.arms?.saveAlone, row.waitMs, unit);
	const savedWrite = describeArm(row.arms?.savedWrite, row.waitMs, unit);
	const observation = {
		no: `Measured: answers without a save (${noSave} on didOpen); a later save alone: ${saveAlone}.`,
		// #4999 R3-2: a pull server's save arm is a save PLUS a
		// `textDocument/diagnostic` request, so the count is the request's answer and
		// cannot be attributed to the save.
		"no (pull)": `Measured: pull mode — no save needed; a later save+request answered: ${saveAlone}.`,
		yes: `Measured: only the save published — silent on didOpen (${row.waitMs} ms), then ${saveAlone} after the save alone.`,
		"yes (saved write)": `Measured: only a saved write published — silent on didOpen and on the save alone, then ${savedWrite} on a diagnostic-neutral edit plus a save.`,
		"cannot measure": `Measured: cannot measure: ${reason}.`,
	}[verdict];
	const policy = fixturePolicy(row.fixture);
	const verdictCell =
		observation ??
		`Measured: inconclusive — ${reason} (arms: no-save ${noSave}, save alone ${saveAlone}, saved write ${savedWrite}).`;
	return {
		server: row.server,
		// Backticked like every other declaration cell in the doc, so a reader sees
		// a protocol token rather than prose.
		"save as declared": `\`${row.save}\``,
		[SAVE_VERDICT_COLUMN]: verdict,
		verdict: policy ? `${verdictCell} ${policy}` : verdictCell,
		evidence: `\`${SAVE_VERDICT_COMMAND}\` (fixture ${row.fixture?.lang ?? row.server})`,
	};
}

/**
 * The run-log line for a row the merge held back (#5060): the answer that
 * stands, and what the night that could not tell measured.
 *
 * @param {{ server: string, prior: string, measured: string, verdict: string }} held
 * @returns {string}
 */
export function describeHeldBack(held) {
	return `save-verdict: held back ${held.server}: kept "${held.prior}", this night measured "${held.measured}" — ${held.verdict}`;
}

/**
 * Emit the held rows for the run: one log line per server and, under GitHub
 * Actions, one `::warning::` annotation with the same text (#5060 F1). A held
 * night leaves the doc unchanged, so the refresh PR shows nothing; the
 * annotation is what puts it on the run's summary page. One record per server
 * per run, however often a row repeats. A staleness counter or an issue is new
 * state and not built here.
 *
 * @param {Array<{ server: string, prior: string, measured: string, verdict: string }>} heldBack
 * @param {{ env: Record<string, string | undefined>, log: (line: string) => void }} sink
 */
export function reportHeldBack(heldBack, { env, log }) {
	const seen = new Set();
	for (const held of heldBack) {
		if (seen.has(held.server)) continue;
		seen.add(held.server);
		const line = describeHeldBack(held);
		log(line);
		if (env.GITHUB_ACTIONS) log(`::warning::${line}`);
	}
}

/**
 * Rows of this run that reached their table row: written or held back. The
 * driver's "none has a table row" floor reads it, so a night that held every
 * row is not reported as a missing row (#5060).
 *
 * @param {{ measured: string[], heldBack: unknown[] }} refreshed
 * @returns {number}
 */
export function rowsReached(refreshed) {
	return refreshed.measured.length + refreshed.heldBack.length;
}

/**
 * The `--summary` record of a run, `heldBack` included (#5060 F1).
 *
 * @param {{
 *   command: string,
 *   src: string,
 *   waitMs: number,
 *   rows: Array<{ cells: Record<string, string> | undefined }>,
 *   refreshed: ReturnType<typeof refreshSaveVerdictTable>,
 *   notMeasured: unknown[],
 *   budgetExhausted: boolean,
 * }} run
 */
export function saveVerdictSummary(run) {
	return {
		command: run.command,
		src: run.src,
		waitMs: run.waitMs,
		measured: run.rows.map((row) => row.cells),
		wrote: run.refreshed.measured,
		notInTable: run.refreshed.notInTable,
		kept: run.refreshed.kept,
		heldBack: run.refreshed.heldBack,
		notMeasured: run.notMeasured,
		budgetExhausted: run.budgetExhausted,
	};
}

/**
 * Merge this run's measured rows into the doc's save-verdict table.
 *
 * Rows this run did not measure are copied verbatim — the merge guard that keeps
 * an unreachable toolchain from blanking a measured cell (#390).
 *
 * A measured server with no row is NOT appended: the table's population is the
 * capability inventory's save-declaring servers (one row per registry SERVER id),
 * and a fixture whose launch VARIANT declares `save` under an id the inventory
 * records as declaring none (`typescript`'s TS7 variants, #3405) would otherwise
 * add a row contradicting the inventory. Those servers are reported as
 * `notInTable` so the run's log names them, and the census in
 * `tests/config/lsp-save-verdict-census.test.ts` keeps the table's population
 * equal to the inventory's.
 *
 * @param {string} text
 * @param {Array<Record<string, string>>} measured  rows keyed by column name
 * @param {{ marker?: string }} [opts]
 * A measured row whose verdict is not a settled answer (`inconclusive`,
 * `cannot measure`, anything else) never replaces a settled prior one, and its
 * evidence stays with it (#5060): a night that could not tell is not a night
 * that found the opposite. The gate admits the settled answers and refuses every
 * other value, so a spelling nobody planned cannot erase an answer either. The
 * row is reported in `heldBack` for the run log; the table has no column for an
 * unobserved night, so the log is where it is recorded.
 *
 * @returns {{
 *   text: string,
 *   changed: boolean,
 *   measured: string[],
 *   kept: string[],
 *   heldBack: Array<{ server: string, prior: string, measured: string, verdict: string }>,
 *   notInTable: string[],
 *   reason?: string,
 * }}
 */
export function refreshSaveVerdictTable(text, measured, opts = {}) {
	const marker = opts.marker ?? SAVE_VERDICT_MARKER;
	const table = parseTable(text, marker);
	const rows = measured ?? [];
	if (!table) {
		return {
			text,
			changed: false,
			measured: [],
			kept: [],
			heldBack: [],
			notInTable: [],
			reason: "save-verdict table not found in doc",
		};
	}
	const keyIdx = table.header.indexOf("server");
	const byKey = new Map(rows.map((row) => [row.server, row]));
	const merged = [];
	const measuredServers = [];
	const kept = [];
	const heldBack = [];
	const verdictIdx = table.header.indexOf(SAVE_VERDICT_COLUMN);
	const detailIdx = table.header.indexOf("verdict");
	for (const cells of table.rows) {
		const row = byKey.get(cells[keyIdx]);
		if (!row) {
			merged.push(cells);
			kept.push(cells[keyIdx]);
			continue;
		}
		if (
			SAVE_VERDICT_SETTLED.has(cells[verdictIdx]) &&
			!SAVE_VERDICT_SETTLED.has(row[SAVE_VERDICT_COLUMN])
		) {
			merged.push(cells);
			heldBack.push({
				server: cells[keyIdx],
				prior: cells[verdictIdx],
				measured: row[SAVE_VERDICT_COLUMN],
				verdict: row[table.header[detailIdx]],
			});
			continue;
		}
		merged.push(
			cells.map((cell, i) => {
				const column = table.header[i];
				return row[column] !== undefined ? row[column] : cell;
			}),
		);
		measuredServers.push(cells[keyIdx]);
	}
	const tableKeys = new Set(table.rows.map((cells) => cells[keyIdx]));
	const out = replaceTable(text, marker, table.header, table.sep, merged);
	return {
		text: out,
		changed: out !== text,
		measured: measuredServers,
		kept,
		heldBack,
		notInTable: rows
			.map((row) => row.server)
			.filter((server) => !tableKeys.has(server)),
	};
}

/**
 * The rows the doc currently holds, as `{ server, save, verdict, evidence }`.
 *
 * `evidence` is part of the row because PROVENANCE is what decides whether a
 * row is worth re-measuring (#4999 F3): a source-read `no` and a probe-measured
 * `no` hold the same verdict and mean different things, and inferring which one
 * a row is from the verdict alone left the source claims last in the queue,
 * exactly where a bounded run never reaches them.
 *
 * @param {string} text
 * @param {{ marker?: string }} [opts]
 * @returns {Array<{ server: string, save: string, verdict: string, evidence: string }>}
 */
export function parseSaveVerdictRows(text, opts = {}) {
	const table = parseTable(text, opts.marker ?? SAVE_VERDICT_MARKER);
	if (!table) return [];
	const idx = (name) => table.header.indexOf(name);
	const server = idx("server");
	const save = idx("save as declared");
	const verdict = idx(SAVE_VERDICT_COLUMN);
	const evidence = idx("evidence");
	return table.rows.map((cells) => ({
		server: cells[server],
		save: cells[save],
		verdict: cells[verdict],
		evidence: cells[evidence],
	}));
}

/**
 * Order the probe's fixtures by what a bounded run can still improve (#3405).
 *
 * Without this a run spends its budget in fixture order and starves exactly the
 * rows the table needs. The first version of this function ranked by verdict
 * alone, and that was wrong in two directions (#4999 F3): the 33 tool-smoke
 * fixtures with no table row (a launch variant under an id the inventory
 * records as declaring no save) ranked as "unmeasured" and came FIRST, and the
 * source-read rows ranked as "measured" and came last, so a short budget never
 * replaced a source claim with a measurement.
 *
 * Four tiers, keyed on the doc row's provenance:
 *
 * 1. no row, or a row whose evidence does not name the probe — a source read, a
 *    prior run, a hand edit: this run can replace a claim nobody measured;
 * 2. a row the probe measured that is still unsettled (`unknown`,
 *    `inconclusive`, `cannot measure`): worth another try;
 * 3. a row the probe measured and settled: re-measuring is a refresh;
 * 4. a fixture with no table row at all, which can never write one: last,
 *    because budget spent on it starves every row above.
 *
 * Ties keep fixture order, so a run over the same doc is deterministic.
 *
 * @template {{ lang: string }} F
 * @param {F[]} fixtures
 * @param {Array<{ server: string, verdict: string, evidence?: string }>} rows
 * @param {(fixture: F) => string} serverOf
 * @returns {F[]}
 */
export function orderByNeed(fixtures, rows, serverOf) {
	const byServer = new Map((rows ?? []).map((row) => [row.server, row]));
	const UNPROVEN = 0;
	const UNSETTLED = 1;
	const SETTLED = 2;
	const NO_ROW = 3;
	const tiers = [[], [], [], []];
	for (const fixture of fixtures ?? []) {
		const row = byServer.get(serverOf(fixture));
		let tier = NO_ROW;
		if (row) {
			if (!String(row.evidence ?? "").includes(SAVE_VERDICT_COMMAND))
				tier = UNPROVEN;
			else tier = SAVE_VERDICT_SETTLED.has(row.verdict) ? SETTLED : UNSETTLED;
		}
		tiers[tier].push(fixture);
	}
	return tiers.flat();
}

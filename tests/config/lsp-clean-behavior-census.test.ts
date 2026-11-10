/**
 * #3347 — the expiry check on the clean-signal marker class.
 *
 * ## The recurrence each assertion prevents
 *
 * The repaired `probe-clean-signal.mjs` rewrites the matrix's `clean-behavior`
 * column from a measurement (through the nightly `bot/lsp-docs-refresh` auto-PR),
 * while `silentOnClean` in clients/lsp/wait-policy/strategies.ts is
 * hand-maintained. The two sources drift in five distinct ways, and each one is a
 * live wait-policy defect rather than a docs nit:
 *
 *  1. a row measured `silent` with no marker — the cascade burns the whole
 *     in-lane wait it could skip (the pre-#458 situation);
 *  2. a marker on a row measured `publishes-*` — the cascade skips a wait the
 *     server would have resolved with a real publish (#3347's cue case);
 *  3. a marker whose server has NO measured push row at all — nothing can ever
 *     expire it, so it outlives the measurement that justified it (the escape
 *     that shipped in round 2: a marker added to `typos` passed the census);
 *  4. a push row whose cell goes blank or back to `TBD`/`unknown` — the row drops
 *     out of a matrix-driven comparison silently, taking its marker coverage
 *     with it;
 *  5. a row whose `mode` flips to `pull` while keeping a `silent` cell —
 *     `clean-behavior` is a push-wait measurement, so that combination is not
 *     evidence for the marker it still appears to support.
 *
 * So the census walks BOTH populations: every matrix row (1, 2, 4, 5) and every
 * registry entry (3). Deliberately a two-source governance test — it parses the
 * checked-in matrix with the same parser the nightly generator uses and reads the
 * real registry the LSP client imports; it recreates neither.
 *
 * ## The pull-strategy census (#5464), same file on purpose
 *
 * A third matrix reader would join the two that already exist; the pull census
 * reads the same `matrixRows()` and judges the same strategy table, so it lives
 * beside the push census rather than as a fourth parser (rival interface
 * considered: a standalone `lsp-pull-strategy-census.test.ts`; it lost because
 * it would re-parse the matrix a third time).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	MEASURED_CLEAN_BEHAVIORS,
	strategyKeyForLang,
} from "../../scripts/lib/clean-signal.mjs";
import { parseTable } from "../../scripts/lib/md-matrix.mjs";
import { SERVER_DIAGNOSTIC_STRATEGIES } from "../../clients/lsp/wait-policy/strategies.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const MATRIX_PATH = path.join(repoRoot, "docs", "lsp-capability-matrix.md");

/**
 * Named admissions for a push-only row the clean-signal probe has not yet
 * classified: `lang` → why. `unknown`/`TBD` is evidence in neither direction
 * (the #240 doctrine), but it has to be admitted BY NAME rather than filtered
 * out, or a measured row escapes the census simply by losing its cell.
 * Shrink-only: `staleAdmissions` reds when an admitted row becomes measured,
 * so a landed measurement cannot leave a stale exemption behind.
 *
 * The reason string is documentation for a human reader ONLY. Nothing reads it:
 * #3390 round 2 shipped a stale filter that skipped any admission whose reason
 * contained `docs-refresh bot`, so an admission survived the exact transition
 * the shrink-only claim is about — prose satisfying a guard, the self-excuse
 * direction AGENTS.md's detector rule forbids.
 */
const UNMEASURED_PUSH_ADMISSIONS = new Map<string, string>([
	[
		"groovy",
		"groovy-language-server publishes no release, so no nightly fixture can install it (#5123); the row is hand-added and its `unknown` cell stays until a run observes the server itself",
	],
	[
		"vue",
		"@vue/language-server: the `publishes-unversioned` cell was an artifact of #3390 (58/45 publishes attributed to vue were tinymist's); nightly 36046209160 re-measured 0/0 with the sink scoped, so the cell is `unknown` until a run observes vue itself publish",
	],
]);

interface MatrixRow {
	lang: string;
	server: string;
	mode: string;
	cleanBehavior: string;
}

function matrixRows(): MatrixRow[] {
	const table = parseTable(
		fs.readFileSync(MATRIX_PATH, "utf8"),
		"| lang | server |",
	);
	expect(table, "capability matrix table is parseable").not.toBeNull();
	const header = table!.header;
	const index = (name: string) => {
		const result = header.indexOf(name);
		expect(result, `the matrix carries a ${name} column`).toBeGreaterThan(-1);
		return result;
	};
	const lang = index("lang");
	const server = index("server");
	const mode = index("mode");
	const cleanBehavior = index("clean-behavior");
	return table!.rows.map((cells) => ({
		lang: cells[lang] ?? "",
		server: cells[server] ?? "",
		mode: cells[mode] ?? "",
		cleanBehavior: cells[cleanBehavior] ?? "",
	}));
}

/**
 * Named admissions for a `mode=pull` matrix row whose strategy key has NO row in
 * SERVER_DIAGNOSTIC_STRATEGIES, so it waits on DEFAULT_STRATEGY (1500 ms): key →
 * why. A pull server answers authoritatively, so a cold answer slower than the
 * budget is abandoned as `touched=0` (#5464: deno, 4.15 s and 4.60 s on the
 * nightly runner against 1500 ms). The matrix says WHICH servers pull; only a
 * measured cold touch says what budget they need, so an unmeasured pull server
 * is admitted here BY NAME until a run records one, and an unlisted pull row
 * fails closed. Shrink-only: `stalePullAdmissions` reds when the key gains a
 * strategy row or leaves the pull population. The reason string is documentation
 * ONLY and is never read (see UNMEASURED_PUSH_ADMISSIONS).
 */
const UNMEASURED_PULL_ADMISSIONS = new Map<string, string>([
	["json", "vscode-json-language-server: no cold-touch measurement recorded"],
	["css", "vscode-css-language-server: no cold-touch measurement recorded"],
	["html", "vscode-html-language-server: no cold-touch measurement recorded"],
	["ruby", "ruby-lsp: no cold-touch measurement recorded"],
	[
		"rust",
		"rust-analyzer: the registry id is `rust` but the strategy row is keyed `rust-analyzer`, so the row never applies and rust waits on the default; re-keying it changes rust's budget, pull retry and second-push expectation and is its own measured change",
	],
]);

/** Pull rows whose strategy key has no row and no named admission. */
function unaccountedPullRows(
	pullRows: MatrixRow[],
	strategyKeys: ReadonlySet<string>,
	admissions: Map<string, string>,
): string[] {
	return pullRows
		.filter((row) => {
			const key = strategyKeyForLang(row.lang);
			return !strategyKeys.has(key) && !admissions.has(key);
		})
		.map(
			(row) =>
				`${row.lang} (${row.server}): mode=pull with no SERVER_DIAGNOSTIC_STRATEGIES row for ${strategyKeyForLang(row.lang)} and no named admission — it waits on the 1500 ms default, which abandons a cold pull slower than that as touched=0 (#5464)`,
		);
}

/** Admissions whose justification is gone: TOTAL over the reason text. */
function stalePullAdmissions(
	pullRows: MatrixRow[],
	strategyKeys: ReadonlySet<string>,
	admissions: Map<string, string>,
): string[] {
	return [...admissions.keys()]
		.filter(
			(key) =>
				strategyKeys.has(key) ||
				!pullRows.some((row) => strategyKeyForLang(row.lang) === key),
		)
		.map(
			(key) =>
				`${key}: stale unmeasured-pull admission — the key has a strategy row or no pull matrix row, so the admission must be deleted`,
		);
}

function markedServers(): string[] {
	return Object.entries(SERVER_DIAGNOSTIC_STRATEGIES)
		.filter(([, strategy]) => strategy.silentOnClean === true)
		.map(([serverId]) => serverId);
}

/**
 * Push rows that are neither measured nor admitted by name. Pure so the live
 * matrix and the state-table fixture below run the SAME predicate.
 */
function unaccountedPushRows(
	pushRows: MatrixRow[],
	admissions: Map<string, string>,
): string[] {
	return pushRows
		.filter(
			(row) =>
				!MEASURED_CLEAN_BEHAVIORS.has(row.cleanBehavior) &&
				!admissions.has(row.lang),
		)
		.map(
			(row) =>
				`${row.lang} (${row.server}): clean-behavior=${JSON.stringify(row.cleanBehavior)} is neither measured nor admitted — a push row that leaves the measured population takes its silentOnClean coverage with it`,
		);
}

/**
 * Admissions whose justification is gone: TOTAL over the reason text. An
 * admission is stale the moment no unmeasured push row for that lang exists —
 * the row became measured, changed mode, or left the matrix. The reason string
 * is never consulted (see UNMEASURED_PUSH_ADMISSIONS).
 */
function staleAdmissions(
	pushRows: MatrixRow[],
	admissions: Map<string, string>,
): string[] {
	return [...admissions.keys()]
		.filter(
			(lang) =>
				!pushRows.some(
					(row) =>
						row.lang === lang &&
						!MEASURED_CLEAN_BEHAVIORS.has(row.cleanBehavior),
				),
		)
		.map(
			(lang) =>
				`${lang}: stale unmeasured-push admission — the row is now measured (or gone), so the admission must be deleted`,
		);
}

describe("#3347 clean-behavior marker census", () => {
	it("measures or admits by name every push row", () => {
		const pushRows = matrixRows().filter((row) => row.mode === "push-only");
		expect(unaccountedPushRows(pushRows, UNMEASURED_PUSH_ADMISSIONS)).toEqual(
			[],
		);
		expect(staleAdmissions(pushRows, UNMEASURED_PUSH_ADMISSIONS)).toEqual([]);

		// A floor, not a ratchet: the census must never pass by comparing nothing
		// (defect shape 10 — an empty census fails loud).
		const comparable = pushRows.filter((row) =>
			MEASURED_CLEAN_BEHAVIORS.has(row.cleanBehavior),
		);
		expect(comparable.length).toBeGreaterThanOrEqual(3);
	});

	it("expires an admission on measurement whatever its reason says", () => {
		// #3390 round 2 recurrence: the stale filter skipped any admission whose
		// reason contained "docs-refresh bot", so an admission outlived the very
		// transition the shrink-only claim covers (rows 3 and 9 below). The state
		// table is row state × admission present/absent × reason wording; the two
		// wordings must be indistinguishable in every arm.
		const row = (cleanBehavior: string): MatrixRow => ({
			lang: "fixturelang",
			server: "fixture-language-server",
			mode: "push-only",
			cleanBehavior,
		});
		const measured = [row("publishes-unversioned")];
		const unmeasured = [row("unknown")];
		const gone: MatrixRow[] = [];
		const none = new Map<string, string>();
		for (const reason of [
			"plain reason with no special wording",
			"awaits the docs-refresh bot after nightly 36046209160",
		]) {
			const admitted = new Map<string, string>([["fixturelang", reason]]);
			// 1: measured, no admission → nothing to report.
			expect(unaccountedPushRows(measured, none), reason).toEqual([]);
			expect(staleAdmissions(measured, none), reason).toEqual([]);
			// 2 and 3: measured row keeps an admission → stale, both wordings.
			expect(staleAdmissions(measured, admitted), reason).toHaveLength(1);
			// 4: unmeasured row with no admission → unaccounted.
			expect(unaccountedPushRows(unmeasured, none), reason).toHaveLength(1);
			// 5 and 6: unmeasured row with an admission → the admission's purpose.
			expect(unaccountedPushRows(unmeasured, admitted), reason).toEqual([]);
			expect(staleAdmissions(unmeasured, admitted), reason).toEqual([]);
			// 7: no push row, no admission → nothing to account for.
			expect(unaccountedPushRows(gone, none), reason).toEqual([]);
			expect(staleAdmissions(gone, none), reason).toEqual([]);
			// 8 and 9: the row left the push population → stale, both wordings.
			expect(staleAdmissions(gone, admitted), reason).toHaveLength(1);
		}
	});

	it("matches every measured push server in both directions", () => {
		const mismatches: string[] = [];
		for (const row of matrixRows()) {
			if (
				row.mode !== "push-only" ||
				!MEASURED_CLEAN_BEHAVIORS.has(row.cleanBehavior)
			)
				continue;
			const key = strategyKeyForLang(row.lang);
			const marked = SERVER_DIAGNOSTIC_STRATEGIES[key]?.silentOnClean === true;
			const shouldBeSilent = row.cleanBehavior === "silent";
			if (marked !== shouldBeSilent) {
				mismatches.push(
					`${row.lang} (${row.server}) → ${key}: matrix clean-behavior=${row.cleanBehavior}, registry silentOnClean=${marked}`,
				);
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("backs every silentOnClean marker with a measured silent push row", () => {
		const rows = matrixRows();
		const unsupported = markedServers()
			.map((serverId) => {
				const owned = rows.filter(
					(row) => strategyKeyForLang(row.lang) === serverId,
				);
				if (
					owned.some(
						(row) => row.mode === "push-only" && row.cleanBehavior === "silent",
					)
				)
					return undefined;
				const detail = owned.length
					? owned
							.map(
								(row) =>
									`${row.lang}: mode=${row.mode}, clean-behavior=${JSON.stringify(row.cleanBehavior)}`,
							)
							.join("; ")
					: "no matrix row maps to this server id";
				return `${serverId}: silentOnClean:true with no push-only matrix row measured silent (${detail}) — nothing can expire this marker`;
			})
			.filter((entry): entry is string => entry !== undefined);
		expect(unsupported).toEqual([]);
		// No floor on the marker population: an empty one is a legitimate state
		// (every server re-measured as publishing), and it cannot be reached
		// silently anyway — dropping a marker while its row still reads `silent`
		// reds the both-directions test above, per server.
	});

	it("never reads a clean-behavior measurement off a non-push row", () => {
		const offenders = matrixRows()
			.filter(
				(row) =>
					row.mode !== "push-only" &&
					MEASURED_CLEAN_BEHAVIORS.has(row.cleanBehavior),
			)
			.map(
				(row) =>
					`${row.lang} (${row.server}): mode=${row.mode} carries clean-behavior=${row.cleanBehavior} — clean-behavior is a push-wait measurement, so this row is evidence for neither direction of its silentOnClean marker`,
			);
		expect(offenders).toEqual([]);
	});
});

describe("#5464 pull-strategy census", () => {
	const strategyKeys = new Set(Object.keys(SERVER_DIAGNOSTIC_STRATEGIES));
	const pullRows = () => matrixRows().filter((row) => row.mode === "pull");

	// Recurrence: deno was a measured pull server (matrix `mode=pull`) with no
	// strategy row; it took the 1500 ms default and the nightly flipped red when
	// the runner slowed (#5464). The matrix is the instrument that says a server
	// pulls, so every pull row is judged against the strategy table.
	it("gives every pull row a strategy row or a named admission", () => {
		const rows = pullRows();
		// A floor, not a ratchet: the census must never pass by comparing nothing.
		expect(rows.length).toBeGreaterThanOrEqual(6);
		expect(
			unaccountedPullRows(rows, strategyKeys, UNMEASURED_PULL_ADMISSIONS),
		).toEqual([]);
		expect(
			stalePullAdmissions(rows, strategyKeys, UNMEASURED_PULL_ADMISSIONS),
		).toEqual([]);
	});

	// State table: row population × strategy row × admission. Every cell other
	// than "has a row" or "admitted" is a report, whatever the reason says.
	it("reports an unlisted pull row and expires an admission whatever its reason says", () => {
		const row = (lang: string): MatrixRow => ({
			lang,
			server: `${lang}-language-server`,
			mode: "pull",
			cleanBehavior: "—",
		});
		const withRow = new Set(["fixturelang"]);
		const noRow = new Set<string>();
		const none = new Map<string, string>();
		for (const reason of [
			"plain reason",
			"awaits the nightly measurement after run 1",
		]) {
			const admitted = new Map<string, string>([["fixturelang", reason]]);
			// has a row, no admission → clean.
			expect(unaccountedPullRows([row("fixturelang")], withRow, none)).toEqual(
				[],
			);
			// no row, no admission → reported (the deno-on-master state).
			expect(
				unaccountedPullRows([row("fixturelang")], noRow, none),
				reason,
			).toHaveLength(1);
			// no row, admitted → accepted, not stale.
			expect(
				unaccountedPullRows([row("fixturelang")], noRow, admitted),
				reason,
			).toEqual([]);
			expect(
				stalePullAdmissions([row("fixturelang")], noRow, admitted),
				reason,
			).toEqual([]);
			// the row was added but the admission stayed → stale.
			expect(
				stalePullAdmissions([row("fixturelang")], withRow, admitted),
				reason,
			).toHaveLength(1);
			// the server left the pull population → stale.
			expect(stalePullAdmissions([], noRow, admitted), reason).toHaveLength(1);
			// an alias key resolves through strategyKeyForLang like the live rows.
			expect(
				unaccountedPullRows([row("jedi")], new Set(["python-jedi"]), none),
			).toEqual([]);
		}
	});
});

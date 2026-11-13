/**
 * #5072 bullet 3: the owner-and-staleness check over a set of repo sources.
 *
 * A baseline admits work a scanner still finds, so a row whose producer has
 * gone is a free pass: a check that asks only "does the live scan stay inside
 * the ledger" also passes on a ledger of rows nobody produces any more. This
 * module discovers the baseline-shaped population, classifies it, and reports
 * every ledger that has no owner test or no planted-stale-row cell. The class
 * rules fail closed: a baseline-shaped file the check cannot classify is a
 * finding, so a new shape cannot join the tree without a rule for it.
 *
 * `tests/config/baseline-owner-governance.test.ts` runs it over the repo and
 * holds the planted cells that prove the check itself reddens; the seam a cell
 * calls lives in `tests/support/baseline-staleness.ts`.
 */

import * as path from "node:path";
import {
	escapeRegExp,
	stripSource,
	testDeclarations,
} from "../support/sweep-kit.js";
import { plantedStaleRowRegistrations } from "../support/baseline-staleness.js";
import {
	BASELINE_OWNER_ADMISSIONS,
	SEAM_TEST_CALL_FILES,
	MIN_ADMISSION_REASON_LENGTH,
	type BaselineOwnerAdmission,
} from "../support/baseline-owner-admissions.js";

/** A file or export whose name claims to hold a baseline. */
const BASELINE_NAME = /baseline/i;

/** The seam a planted-stale-row cell calls (#5072). */
const STALE_ROW_SEAM = "expectPlantedStaleRow";

/**
 * The initializer shapes that hold rows: an object or array literal, a frozen
 * one, a `new Set(...)`, or a parsed JSON file. A number, a string, or a regex
 * is a bound, not a ledger.
 */
// Every alternative is anchored: an unanchored `new Set(` would match a Set in
// the NEXT declaration, because the slice below reaches past this one.
const TABLE_INITIALIZER =
	/^(?:\{\s*\})?(?:[[{]|Object\.freeze\(\s*[[{]|new Set\(|JSON\.parse\()/;

/** How far past a declaration name the initializer search reaches, in characters. */
const DECLARATION_WINDOW = 600;

/**
 * The exported constants whose name contains BASELINE and whose initializer is
 * a row table (see {@link TABLE_INITIALIZER}). Export is the scope: an exported
 * table is a ledger other files read, while a `const BASELINE = ...` inside one
 * sweep is that sweep's own fixture and its file already owns it. Column-zero
 * matching keeps a function-local table out, and a `;` before the `=` rejects a
 * name whose declaration has no initializer in this window.
 */
export function exportedRowTables(source: string): string[] {
	const blanked = stripSource(source, { strings: "blank" });
	const names: string[] = [];
	const declaration =
		/^export\s+const\s+([A-Za-z0-9_]*BASELINE[A-Za-z0-9_]*)\b/gm;
	for (
		let match = declaration.exec(blanked);
		match;
		match = declaration.exec(blanked)
	) {
		const rest = blanked.slice(
			match.index + match[0].length,
			match.index + match[0].length + DECLARATION_WINDOW,
		);
		const equals = rest.indexOf("=");
		if (equals < 0 || rest.slice(0, equals).includes(";")) continue;
		if (TABLE_INITIALIZER.test(rest.slice(equals + 1).replace(/^\s+/, ""))) {
			names.push(match[1]);
		}
	}
	return names;
}

/** What the census can call a baseline-shaped file. */
export type BaselineClass =
	| "ledger"
	| "fixture-input"
	| "prose"
	| "model"
	| "script"
	| "test-file"
	| "source-module"
	| "unclassified";

/** One baseline-shaped file or export, with the class the check gave it. */
export interface BaselineCandidate {
	/** `<repo path>` for a data file, `<repo path>#<EXPORT>` for a table. */
	readonly id: string;
	readonly repoPath: string;
	readonly cls: BaselineClass;
	/** Why the check gave it this class, shown in the census and findings. */
	readonly why: string;
}

/** One way the ownership contract is unmet. */
export interface BaselineFinding {
	readonly id: string;
	readonly problem: string;
}

/**
 * What a baseline-named file of each kind is, in first-match order. A new kind
 * of baseline-shaped file adds a row; one that matches no row is `unclassified`
 * and reddens, so a new shape cannot join the tree silently.
 */
const CLASS_RULES: ReadonlyArray<{
	readonly cls: BaselineClass;
	readonly why: string;
	readonly matches: (repoPath: string, ext: string) => boolean;
}> = [
	{
		cls: "prose",
		why: "prose holds prose, not rows a scanner compares",
		matches: (_repoPath, ext) =>
			ext === ".md" || ext === ".markdown" || ext === ".txt" || ext === ".rst",
	},
	{
		cls: "model",
		why: "a TLA+ model or config constant, not a row ledger",
		matches: (repoPath, ext) =>
			repoPath.startsWith("formal/") || ext === ".tla" || ext === ".cfg",
	},
	{
		cls: "script",
		why: "a tool or a compiled twin, not a checked-in row table",
		matches: (_repoPath, ext) =>
			ext === ".mjs" || ext === ".cjs" || ext === ".js",
	},
	{
		cls: "fixture-input",
		why: "fixture input a test builds its own tree from",
		matches: (repoPath) => /(^|\/)fixtures?\//.test(repoPath),
	},
	{
		cls: "ledger",
		why: "a checked-in JSON row table",
		matches: (_repoPath, ext) => ext === ".json",
	},
];

/**
 * Classify every baseline-shaped entry of `sources` (repo-relative posix →
 * text). Two discovery rules: a TypeScript module-level row-table const is a
 * ledger whatever the file is named, and any other name that claims a baseline
 * is classified by {@link CLASS_RULES}.
 */
export function classifyBaselines(
	sources: ReadonlyMap<string, string>,
): BaselineCandidate[] {
	const found: BaselineCandidate[] = [];
	for (const [repoPath, text] of sources) {
		const ext = path.posix.extname(repoPath);
		const named = BASELINE_NAME.test(path.posix.basename(repoPath));
		if (ext === ".ts" || ext === ".tsx") {
			const tables = exportedRowTables(text);
			for (const name of tables) {
				found.push({
					id: `${repoPath}#${name}`,
					repoPath,
					cls: "ledger",
					why: `a checked-in row table (${name})`,
				});
			}
			if (tables.length === 0 && named) {
				found.push({
					id: repoPath,
					repoPath,
					cls: /\.test\.[cm]?ts$/.test(repoPath)
						? "test-file"
						: "source-module",
					why: "no module-level row-table const",
				});
			}
			continue;
		}
		if (!named) continue;
		const rule = CLASS_RULES.find((candidate) =>
			candidate.matches(repoPath, ext),
		);
		found.push(
			rule === undefined
				? {
						id: repoPath,
						repoPath,
						cls: "unclassified",
						why: "no class rule covers this extension or location",
					}
				: { id: repoPath, repoPath, cls: rule.cls, why: rule.why },
		);
	}
	return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Does the text name this reference? A short basename is only a reference when
 * it stands alone: `scripts/governance-rules/baseline.json` contains the string
 * `baseline.json`, and 21 test files mention some other ledger's
 * `…-baseline.json`, so a substring match would call all of them owners.
 */
function mentions(raw: string, ref: string): boolean {
	if (ref.includes("/")) return raw.includes(ref);
	return new RegExp(`(^|[^\\w./-])${escapeRegExp(ref)}(?![\\w.])`).test(raw);
}

/** Does this test file read the ledger, by import spelling, path, or declaration? */
function readsLedger(
	testPath: string,
	raw: string,
	ledger: BaselineCandidate,
): boolean {
	const exportName = ledger.id.includes("#")
		? ledger.id.split("#")[1]
		: undefined;
	// A table exported from a test file is read by the file that declares it: it
	// names the export, not its own path.
	if (testPath === ledger.repoPath) {
		return exportName === undefined || raw.includes(exportName);
	}
	const base = path.posix.basename(ledger.repoPath);
	const stem = base.slice(
		0,
		base.length - path.posix.extname(ledger.repoPath).length,
	);
	const refs = [ledger.repoPath, base, `${stem}.js`, `${stem}.json`];
	if (!refs.some((ref) => mentions(raw, ref))) return false;
	return exportName === undefined || raw.includes(exportName);
}

/** Character offset of a 1-based line in `text`. */
function lineOffset(text: string, line: number): number {
	let offset = 0;
	for (let i = 0; i < line - 1; i++) {
		const next = text.indexOf("\n", offset);
		if (next < 0) return text.length;
		offset = next + 1;
	}
	return offset;
}

/** The cell shape a finding points a maintainer at. */
const CELL_SHAPE =
	`add a live it() that plants a row and calls ${STALE_ROW_SEAM}({ ` +
	'baseline: "<id>", rowKey: "<planted row>", direction: "extra-row" | ' +
	'"withheld-member", verdict: <the owner ratchet verdict for that corpus> })';

/**
 * The ownership and staleness findings for one tree. `sources` is repo-relative
 * posix path → raw text, for every candidate and every `*.test.ts` file.
 */
/** What the census saw, so the run prints its population instead of only a verdict. */
export interface BaselineCensusCounts {
	/** Baseline-shaped files the check reads as whole populations. */
	readonly ledgers: number;
	/** Ledgers with at least one live planted-stale-row cell. */
	readonly planted: number;
	/** Ledgers excused by a written admission instead of a cell. */
	readonly admitted: number;
	/** Ledgers with neither a cell nor an admission: each one is a finding. */
	readonly unplanted: number;
	/** Ledgers no `*.test.ts` file reads. */
	readonly unowned: number;
	/** Baseline-shaped files the class rules cannot place. */
	readonly unclassified: number;
}

/** The findings and the population they were computed over. */
export interface BaselineGovernanceReport {
	readonly findings: BaselineFinding[];
	readonly counts: BaselineCensusCounts;
}

/**
 * Run the whole census over a source map: classify, find the cells, and report
 * every baseline that is neither planted, owned, nor admitted with a reason.
 */
export function baselineGovernanceReport(
	sources: ReadonlyMap<string, string>,
	admissions: Readonly<
		Record<string, BaselineOwnerAdmission>
	> = BASELINE_OWNER_ADMISSIONS,
): BaselineGovernanceReport {
	const candidates = classifyBaselines(sources);
	const findings: BaselineFinding[] = [];
	const counts = {
		ledgers: 0,
		planted: 0,
		admitted: 0,
		unplanted: 0,
		unowned: 0,
		unclassified: 0,
	};
	const ledgers = candidates.filter((c) => c.cls === "ledger");
	counts.ledgers = ledgers.length;
	const ledgerById = new Map(ledgers.map((l) => [l.id, l]));

	// An admission for a ledger the check does not discover is a dead row: the
	// population may shrink, never silently grow.
	for (const [id, admission] of Object.entries(admissions)) {
		if (ledgerById.has(id)) continue;
		findings.push({
			id,
			problem:
				"admission names a baseline the check does not discover " +
				"(renamed, deleted, or reclassified); drop the row",
		});
		void admission;
	}

	// Cells: registrations inside a live it()/test() of a test file, mapped to
	// the ledger they name.
	const cells = new Map<string, string[]>();
	const pushCell = (id: string, where: string) => {
		const list = cells.get(id) ?? [];
		list.push(where);
		cells.set(id, list);
	};
	for (const [repoPath, raw] of sources) {
		if (!/\.test\.[cm]?ts$/.test(repoPath) || !raw.includes(STALE_ROW_SEAM)) {
			continue;
		}
		const stripped = stripSource(raw, { strings: "blank" });
		const liveCells = testDeclarations(raw, stripped).filter(
			(d) => d.live && (d.callee === "it" || d.callee === "test"),
		);
		for (const registration of plantedStaleRowRegistrations(raw)) {
			const where = `${repoPath}:${registration.line}`;
			if (registration.baseline === undefined) {
				// The seam's own unit falsifies ledgers outside the repository, so it
				// cannot name one here; it still counts as no cell for any ledger.
				if (SEAM_TEST_CALL_FILES.includes(repoPath)) continue;
				findings.push({
					id: repoPath,
					problem: `the ${STALE_ROW_SEAM} call at ${where} omits its baseline literal, so the check cannot map it to a ledger`,
				});
				continue;
			}
			const ledger = ledgerById.get(registration.baseline);
			if (ledger === undefined) {
				findings.push({
					id: registration.baseline,
					problem: `a ${STALE_ROW_SEAM} cell at ${where} names a baseline the check does not discover (a typo, or a ledger the class rules exempt)`,
				});
				continue;
			}
			if (!registration.hasRowKey) {
				findings.push({
					id: ledger.id,
					problem: `the ${STALE_ROW_SEAM} cell at ${where} omits rowKey, so nothing says which row it planted`,
				});
				continue;
			}
			if (registration.direction === undefined) {
				findings.push({
					id: ledger.id,
					problem: `the ${STALE_ROW_SEAM} cell at ${where} omits direction, or spells it as an expression the check cannot read`,
				});
				continue;
			}
			if (
				registration.direction !== "extra-row" &&
				registration.direction !== "withheld-member"
			) {
				findings.push({
					id: ledger.id,
					problem: `the ${STALE_ROW_SEAM} cell at ${where} has direction "${registration.direction}", which is not "extra-row" or "withheld-member"`,
				});
				continue;
			}
			const offset = lineOffset(stripped, registration.line);
			if (
				!liveCells.some((d) => offset >= d.callParen && offset <= d.callEnd + 1)
			) {
				findings.push({
					id: ledger.id,
					problem: `the ${STALE_ROW_SEAM} cell at ${where} is not inside a live it()/test(), so nothing runs it`,
				});
				continue;
			}
			pushCell(ledger.id, where);
		}
	}

	for (const ledger of ledgers) {
		const owners = [...sources.entries()]
			.filter(([p]) => /\.test\.[cm]?ts$/.test(p))
			.filter(([p, raw]) => readsLedger(p, raw, ledger))
			.map(([p]) => p)
			.sort();
		const ledgerCells = cells.get(ledger.id) ?? [];
		const admission = admissions[ledger.id];
		if (owners.length === 0) {
			counts.unowned++;
			findings.push({
				id: ledger.id,
				problem:
					`no *.test.ts file reads it (${ledger.why}), so no test can red ` +
					"when a row goes stale",
			});
		}
		if (ledgerCells.length > 0) counts.planted++;
		if (ledgerCells.length === 0) {
			if (admission === undefined) {
				counts.unplanted++;
				findings.push({
					id: ledger.id,
					problem: `no planted-stale-row cell. Owner tests: ${owners.join(", ") || "none"}. ${CELL_SHAPE}`,
				});
			} else {
				counts.admitted++;
				if (!owners.includes(admission.owner)) {
					findings.push({
						id: ledger.id,
						problem: `admission names ${admission.owner} as its owner, but that test does not read the ledger`,
					});
				}
				if (admission.reason.trim().length < MIN_ADMISSION_REASON_LENGTH) {
					findings.push({
						id: ledger.id,
						problem: `admission reason is ${admission.reason.trim().length} characters; an admission carries a sentence of at least ${MIN_ADMISSION_REASON_LENGTH} explaining why a plant does not apply`,
					});
				}
			}
		} else if (admission !== undefined) {
			findings.push({
				id: ledger.id,
				problem: `admission is dead: ${ledgerCells.length} planted-stale-row cell(s) cover it (${ledgerCells.join(", ")}); drop the row`,
			});
		}
	}

	for (const candidate of candidates) {
		if (candidate.cls !== "unclassified") continue;
		counts.unclassified++;
		findings.push({
			id: candidate.id,
			problem: `baseline-shaped file the check cannot classify (${candidate.why}); teach the class rule or rename the file`,
		});
	}
	return {
		findings: findings.sort((a, b) =>
			a.id < b.id ? -1 : a.id > b.id ? 1 : a.problem < b.problem ? -1 : 1,
		),
		counts,
	};
}

/** The findings only: what every assertion in the owner test reads. */
export function baselineGovernanceFindings(
	sources: ReadonlyMap<string, string>,
	admissions: Readonly<
		Record<string, BaselineOwnerAdmission>
	> = BASELINE_OWNER_ADMISSIONS,
): BaselineFinding[] {
	return baselineGovernanceReport(sources, admissions).findings;
}

/**
 * The one seam a governance baseline's planted-stale-row cell reports through
 * (#5072).
 *
 * A baseline row excuses work a scanner still finds, so a row whose producer
 * has gone is a free pass the ratchet never reports: a check that only asks
 * "does the live scan stay inside the ledger" also passes on a ledger of rows
 * nobody produces any more. The owner test of every checked-in baseline
 * therefore carries one cell that falsifies a row. It either adds a ledger row
 * no live scan produces (`"extra-row"`), or withholds the live member of a
 * committed row (`"withheld-member"`). The cell hands the ratchet's verdict for
 * that falsified corpus to {@link expectPlantedStaleRow}, and the call is both
 * the runtime proof and the registration
 * `tests/config/baseline-owner-governance.test.ts` scans for.
 *
 * The call is not a comment. It reads the checked-in ledger and requires the
 * plant to be a plant: an `"extra-row"` key the committed ledger does not
 * carry, a `"withheld-member"` key it does. It then requires a non-empty
 * verdict that names the planted row. A cell whose ratchet has gone blind, or
 * that names a row the ledger already carries on its own, fails here, so a
 * registration cannot outlive the behaviour it claims.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stripSource } from "./sweep-kit.js";

/** The repo root the ledger paths of a registration resolve against. */
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/**
 * Which side of the ledger the cell falsifies.
 *
 * - `"extra-row"`: the cell puts a row in the ledger that no live scan
 *   produces. The committed ledger must not carry the key, or the cell is
 *   claiming a plant that is already a live row.
 * - `"withheld-member"`: the cell keeps a committed row and removes its live
 *   member. The committed ledger must carry the key, or there is no committed
 *   row to orphan.
 */
export type PlantedStaleRowDirection = "extra-row" | "withheld-member";

/** One planted-stale-row cell's claim about one baseline. */
export interface PlantedStaleRowClaim {
	/**
	 * Repo-relative path of the checked-in baseline the cell falsifies. A
	 * table exported from a `.ts` file is spelled `<path>#<EXPORT_NAME>`.
	 */
	readonly baseline: string;
	/**
	 * The row identity the cell planted or orphaned: a file path, a
	 * `file#symbol` key, a directory prefix, whatever the ledger keys its rows
	 * by. It must appear in the ratchet's verdict, so the verdict is about the
	 * row the cell planted and not about some other drift.
	 */
	readonly rowKey: string;
	readonly direction: PlantedStaleRowDirection;
	/**
	 * The owner's staleness verdict for the falsified corpus, verbatim: the
	 * problems array, the message, or one entry of either.
	 */
	readonly verdict: string | readonly (string | undefined)[];
}

/**
 * The text of the committed rows, so "is this row already in the ledger" asks
 * the ledger and not the file that reads it. A `<path>#<EXPORT>` ledger lives
 * inside a source file that also holds its owner test, so searching the whole
 * file would count the cell's own planted literal as a committed row. For a
 * named export this returns the declared table's own span; a JSON ledger is
 * its own table, so the file is the ledger.
 */
function committedLedgerText(
	text: string,
	exportName: string | undefined,
	baseline: string,
): string {
	if (exportName === undefined || exportName === "") return text;
	if (!/^[A-Za-z_$][\w$]*$/.test(exportName)) {
		throw new Error(
			`planted-stale-row cell names ${baseline}, whose export part ` +
				`"${exportName}" is not an identifier (#5072)`,
		);
	}
	const blanked = stripSource(text, { strings: "blank" });
	const declared = new RegExp(
		`export\\s+const\\s+${exportName}\\b[^=]*=\\s*`,
	).exec(blanked);
	if (declared === null) {
		throw new Error(
			`planted-stale-row cell names ${baseline}, which declares no export ` +
				`${exportName} to hold its rows (#5072)`,
		);
	}
	const open = declared.index + declared[0].length;
	const opener = blanked[open];
	if (opener !== "[" && opener !== "{") {
		throw new Error(
			`planted-stale-row cell names ${baseline}, whose export ${exportName} ` +
				"is not a row table the cell can read (#5072)",
		);
	}
	const closers: Record<string, string> = { "[": "]", "{": "}" };
	let depth = 0;
	for (let at = open; at < blanked.length; at++) {
		const char = blanked[at];
		if (char === "[" || char === "{") depth++;
		else if (char === "]" || char === "}") {
			depth--;
			if (depth === 0) {
				if (closers[opener] !== char) {
					throw new Error(
						`planted-stale-row cell names ${baseline}, whose export ` +
							`${exportName} table is not balanced (#5072)`,
					);
				}
				return text.slice(open, at + 1);
			}
		}
	}
	throw new Error(
		`planted-stale-row cell names ${baseline}, whose export ${exportName} ` +
			"table never closes (#5072)",
	);
}

/** Verdict entries the claim carries, with the empty ones dropped. */
function verdictLines(verdict: PlantedStaleRowClaim["verdict"]): string[] {
	const lines = typeof verdict === "string" ? [verdict] : [...verdict];
	return lines.filter(
		(line): line is string => typeof line === "string" && line !== "",
	);
}

/**
 * Assert the cell's ratchet reddens on the row the cell planted.
 *
 * Throws with the reason when: the baseline is not in the tree, the plant is
 * not a plant for its direction, the verdict is empty (the ratchet read the
 * planted row as live), or no verdict line names the planted row.
 */
export function expectPlantedStaleRow(claim: PlantedStaleRowClaim): void {
	if (claim.baseline.trim() === "") {
		throw new Error("planted-stale-row cell names no baseline (#5072)");
	}
	if (claim.rowKey.trim() === "") {
		throw new Error(
			`planted-stale-row cell for ${claim.baseline} names no row (#5072)`,
		);
	}
	const [ledgerPath = "", exportName] = claim.baseline.split("#");
	// A cell spells the ledger repo-relatively; resolve() also lets a unit of this
	// seam itself point at a ledger outside the repository.
	const ledgerFile = path.resolve(REPO_ROOT, ledgerPath);
	let text: string;
	try {
		text = fs.readFileSync(ledgerFile, "utf-8");
	} catch {
		throw new Error(
			`planted-stale-row cell names a baseline that is not in the tree: ${claim.baseline} (#5072)`,
		);
	}
	const committed = committedLedgerText(
		text,
		exportName,
		claim.baseline,
	).includes(claim.rowKey);
	if (claim.direction === "extra-row" && committed) {
		throw new Error(
			`planted-stale-row cell for ${claim.baseline}: "${claim.rowKey}" is a ` +
				"row the committed ledger already carries, so the cell plants a row " +
				"no live producer has nowhere (#5072)",
		);
	}
	if (claim.direction === "withheld-member" && !committed) {
		throw new Error(
			`planted-stale-row cell for ${claim.baseline}: "${claim.rowKey}" is not ` +
				"a row of the committed ledger, so the cell withholds a member from " +
				"no committed row (#5072)",
		);
	}
	const lines = verdictLines(claim.verdict);
	if (lines.length === 0) {
		throw new Error(
			`planted-stale-row cell for ${claim.baseline}: the ratchet read the ` +
				`planted row "${claim.rowKey}" as live and returned no verdict. A ` +
				"baseline whose row-without-producer direction is blind needs a " +
				"reason in tests/support/baseline-owner-admissions.ts (#5072)",
		);
	}
	if (!lines.some((line) => line.includes(claim.rowKey))) {
		throw new Error(
			`planted-stale-row cell for ${claim.baseline}: no verdict line names ` +
				`the planted row "${claim.rowKey}". The ratchet reddened on other ` +
				`drift only: ${lines.slice(0, 3).join(" | ")}`,
		);
	}
}

/** One {@link expectPlantedStaleRow} call site found in a source file. */
export interface PlantedStaleRowRegistration {
	/** The `baseline:` literal, or undefined when the call omits it. */
	readonly baseline: string | undefined;
	/** Whether a `rowKey:` property is there at all; its value may be an
	 * expression, which the check cannot read and does not need to. */
	readonly hasRowKey: boolean;
	/** The `direction:` literal, or undefined when it is missing or an expression. */
	readonly direction: string | undefined;
	/** 1-based line of the call, for the finding. */
	readonly line: number;
}

/**
 * The literals of one call's object argument. Each `key:` is located in the
 * comment- and string-blanked source (so a key that only appears in prose is
 * not a literal), and its value is then read from the RAW text at the same
 * offset: {@link stripSource} blanks contents in place, so an offset into the
 * blanked text addresses the same character of the raw text, and the quoted
 * value is only present in the raw text. Reading the value off the blanked
 * source would return a run of spaces, and reading it off a `strings: "keep"`
 * strip would count a call quoted inside a string literal as a registration.
 */
function readRegistrationLiterals(
	raw: string,
	blankedArgs: string,
	argsOffset: number,
): {
	baseline?: string;
	hasRowKey: boolean;
	direction?: string;
} {
	const read: { baseline?: string; hasRowKey: boolean; direction?: string } = {
		hasRowKey: false,
	};
	const seen = new Set<string>();
	const property = /\b(baseline|rowKey|direction)\s*:/g;
	for (
		let match = property.exec(blankedArgs);
		match;
		match = property.exec(blankedArgs)
	) {
		const key = match[1] as "baseline" | "rowKey" | "direction";
		if (seen.has(key)) continue;
		seen.add(key);
		// rowKey may be an expression (the planted id is often a variable the test
		// built), and the check only needs to know the cell names a row at all: the
		// seam validates the value against the committed ledger when it runs.
		if (key === "rowKey") {
			read.hasRowKey = true;
			continue;
		}
		const valueAt = argsOffset + match.index + match[0].length;
		const value = /^\s*"([^"]*)"/.exec(raw.slice(valueAt, valueAt + 800))?.[1];
		if (value !== undefined) read[key] = value;
	}
	return read;
}

/**
 * Find every {@link expectPlantedStaleRow} call site in one RAW source file,
 * with its literals, so the governance check can map a cell to the baseline it
 * names. A call inside a comment or inside a string literal is not a
 * registration: the call itself is located in blanked source.
 */
export function plantedStaleRowRegistrations(
	raw: string,
): PlantedStaleRowRegistration[] {
	const blanked = stripSource(raw, { strings: "blank" });
	const registrations: PlantedStaleRowRegistration[] = [];
	const callAt = /(?<![\w$.])expectPlantedStaleRow\s*\(/g;
	for (let match = callAt.exec(blanked); match; match = callAt.exec(blanked)) {
		const open = match.index + match[0].length;
		const literals = readRegistrationLiterals(
			raw,
			blanked.slice(open, open + 4000),
			open,
		);

		registrations.push({
			baseline: literals.baseline,
			hasRowKey: literals.hasRowKey,
			direction: literals.direction,
			line: raw.slice(0, match.index).split("\n").length,
		});
	}
	return registrations;
}

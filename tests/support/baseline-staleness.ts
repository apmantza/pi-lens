/**
 * The one seam a governance baseline's planted-stale-row cell reports through
 * (#5072).
 *
 * A baseline row excuses work a scanner still finds, so a row whose producer
 * has gone is a free pass the ratchet never reports: a check that only asks
 * "does the live scan stay inside the ledger" also passes on a ledger of rows
 * nobody produces any more. The owner test of every checked-in baseline
 * therefore carries one cell that adds a row no live scan produces, drives the
 * ratchet's own comparison over that falsified corpus, and hands the verdict
 * to {@link expectPlantedStaleRow}. The call is both the runtime proof and the
 * registration `tests/config/baseline-owner-governance.test.ts` scans for.
 *
 * The call is not a comment. It reads the checked-in ledger and refuses a
 * planted row the committed ledger already carries, then requires a verdict
 * line that names the planted row. A cell whose ratchet has gone blind, or that
 * names a row the ledger already carries on its own, fails here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { matchingCloseIndex, stripSource } from "./sweep-kit.js";

/** The repo root the ledger paths of a registration resolve against. */
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/** One planted-stale-row cell's claim about one baseline. */
export interface PlantedStaleRowClaim {
	/**
	 * Repo-relative path of the checked-in baseline the cell falsifies. A
	 * table exported from a code module is spelled `<path>#<EXPORT_NAME>`.
	 */
	readonly baseline: string;
	/**
	 * The row identity the cell planted, spelled as the ledger spells a row
	 * identity: a key or a field value. It must name no row of the committed
	 * ledger and must appear in the ratchet's verdict, so the verdict is about
	 * the planted row and not about some other drift.
	 */
	readonly rowKey: string;
	/**
	 * The owner's staleness verdict for the falsified corpus, verbatim: the
	 * problems array, the message, or one entry of either.
	 */
	readonly verdict: string | readonly (string | undefined)[];
}

/** Characters that continue a path or identifier, so a match inside one is not a mention. */
const IDENTITY_CHAR = /[\w./-]/;

/**
 * Does `text` carry `identity` as a whole token? `tests/x.test.ts` is not a
 * token of `tests/x.test.tsx`, and `a` is not a token of `banana` (#5546 F7).
 */
export function namesIdentity(text: string, identity: string): boolean {
	for (
		let at = text.indexOf(identity);
		at >= 0;
		at = text.indexOf(identity, at + 1)
	) {
		const before = at === 0 ? "" : text[at - 1]!;
		const after = text[at + identity.length] ?? "";
		if (!IDENTITY_CHAR.test(before) && !IDENTITY_CHAR.test(after)) return true;
	}
	return false;
}

/**
 * The plain string literals of a JS/TS source, as written values, with the
 * offset of each opening quote. Comments are not code, so a path in a comment
 * is not here; a template literal with an interpolation is computed, so it is
 * not here either. Offsets line up with `source` because {@link stripSource}
 * blanks in place.
 */
export function stringLiterals(
	source: string,
	blanked: string = stripSource(source, { strings: "blank" }),
): Array<{ value: string; at: number }> {
	const found: Array<{ value: string; at: number }> = [];
	for (let at = 0; at < blanked.length; at++) {
		const quote = blanked[at];
		if (quote !== '"' && quote !== "'" && quote !== "`") continue;
		const close = blanked.indexOf(quote, at + 1);
		if (close < 0) break;
		if (quote !== "`" || blanked.slice(at + 1, close).trim() === "") {
			found.push({
				value: source.slice(at + 1, close).replace(/\\(.)/g, "$1"),
				at,
			});
		}
		at = close;
	}
	return found;
}

/** Every key and string value of a parsed JSON document, recursively. */
export function jsonStrings(
	value: unknown,
	into: Set<string> = new Set(),
): Set<string> {
	if (typeof value === "string") into.add(value);
	else if (Array.isArray(value)) for (const v of value) jsonStrings(v, into);
	else if (value !== null && typeof value === "object") {
		for (const [key, v] of Object.entries(value)) {
			into.add(key);
			jsonStrings(v, into);
		}
	}
	return into;
}

/**
 * The span of a module-scope binding's initializer in blanked source: from
 * after its `=` to the `;` that ends the statement at bracket depth zero. A
 * bare identifier initializer is followed to that binding's own initializer,
 * so `export const X_BASELINE = ROWS` reads the rows `ROWS` holds.
 */
export function initializerSpan(
	blanked: string,
	name: string,
	hops = 0,
): { start: number; end: number } | undefined {
	const declared = new RegExp(
		`(?<![\\w$.])(?:const|let|var)\\s+${name}(?![\\w$])`,
	).exec(blanked);
	if (declared === null) return undefined;
	let at = declared.index + declared[0].length;
	let depth = 0;
	let start = -1;
	for (; at < blanked.length; at++) {
		const ch = blanked[at]!;
		if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
		else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
			if (!(ch === ">" && blanked[at - 1] === "=")) depth--;
		} else if (depth === 0 && ch === ";") break;
		else if (
			depth === 0 &&
			start < 0 &&
			ch === "=" &&
			blanked[at + 1] !== ">" &&
			blanked[at + 1] !== "="
		) {
			start = at + 1;
			depth = 0;
		}
	}
	if (start < 0) return undefined;
	const alias = /^\s*([A-Za-z_$][\w$]*)\s*(?:as\s+const\s*)?$/.exec(
		blanked.slice(start, at),
	);
	if (alias !== null && hops < 4) {
		return initializerSpan(blanked, alias[1]!, hops + 1) ?? { start, end: at };
	}
	return { start, end: at };
}

/**
 * The row identities the committed ledger spells: every key and string value
 * of a JSON ledger, parsed (so an escaped quote reads as the quote), or every
 * string literal inside a code module's table.
 */
function committedIdentities(
	text: string,
	exportName: string | undefined,
	baseline: string,
): Set<string> {
	if (exportName === undefined) {
		try {
			return jsonStrings(JSON5.parse(text));
		} catch {
			throw new Error(
				`planted-stale-row cell names ${baseline}, which is not a JSON document the cell can read (#5072)`,
			);
		}
	}
	const blanked = stripSource(text, { strings: "blank" });
	const span =
		exportName === "default" ? undefined : initializerSpan(blanked, exportName);
	if (span === undefined) {
		throw new Error(
			`planted-stale-row cell names ${baseline}, which declares no ${exportName} to hold its rows (#5072)`,
		);
	}
	return new Set(
		stringLiterals(text, blanked)
			.filter((literal) => literal.at >= span.start && literal.at < span.end)
			.map((literal) => literal.value),
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
 * Throws with the reason when: the baseline is not in the tree, the planted
 * row is one the committed ledger already carries, the verdict is empty (the
 * ratchet read the planted row as live), or no verdict line names the row.
 */
export function expectPlantedStaleRow(claim: PlantedStaleRowClaim): void {
	if (claim.rowKey.trim() === "") {
		throw new Error(
			`planted-stale-row cell for ${claim.baseline} names no row (#5072)`,
		);
	}
	const hash = claim.baseline.indexOf("#");
	const ledgerPath = hash < 0 ? claim.baseline : claim.baseline.slice(0, hash);
	const exportName = hash < 0 ? undefined : claim.baseline.slice(hash + 1);
	// A cell spells the ledger repo-relatively; resolve() also lets a unit of
	// this seam point at a ledger outside the repository.
	let text: string;
	try {
		text = fs.readFileSync(path.resolve(REPO_ROOT, ledgerPath), "utf-8");
	} catch {
		throw new Error(
			`planted-stale-row cell names a baseline that is not in the tree: ${claim.baseline} (#5072)`,
		);
	}
	if (committedIdentities(text, exportName, claim.baseline).has(claim.rowKey)) {
		throw new Error(
			`planted-stale-row cell for ${claim.baseline}: "${claim.rowKey}" is a ` +
				"row the committed ledger already carries, so it is not a planted row (#5072)",
		);
	}
	const lines = verdictLines(claim.verdict);
	if (lines.length === 0) {
		throw new Error(
			`planted-stale-row cell for ${claim.baseline}: the ratchet read the ` +
				`planted row "${claim.rowKey}" as live and returned no verdict (#5072)`,
		);
	}
	if (!lines.some((line) => namesIdentity(line, claim.rowKey))) {
		throw new Error(
			`planted-stale-row cell for ${claim.baseline}: no verdict line names ` +
				`the planted row "${claim.rowKey}". The ratchet reddened on other ` +
				`drift only: ${lines.slice(0, 3).join(" | ")}`,
		);
	}
}

/**
 * The ledger rows no live member produces, sorted: the comparison every
 * keyed-row ratchet runs for its row-without-producer direction (#5072).
 */
export function rowsWithoutLiveMember(
	rows: Iterable<string>,
	live: ReadonlySet<string>,
): string[] {
	return [...rows]
		.filter((row) => !live.has(row))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** One {@link expectPlantedStaleRow} call site found in a source file. */
export interface PlantedStaleRowRegistration {
	/** The `baseline:` literal, or undefined when the call does not spell one. */
	readonly baseline: string | undefined;
	/** Whether the call carries a `rowKey` property; its value may be an expression. */
	readonly hasRowKey: boolean;
	/** Offset of the call's open paren in the source. */
	readonly callParen: number;
	/** 1-based line of the call, for the finding. */
	readonly line: number;
	/** Offset of the `baseline:` value's opening quote, so an owner scan can skip it. */
	readonly baselineLiteral: number | undefined;
}

/**
 * Find every {@link expectPlantedStaleRow} call site in one RAW source file.
 * The call is located in comment- and string-blanked source, so a call in a
 * comment or a string is not one, and its properties are read only up to the
 * call's own closing paren (#5546 B7). A property value is read from the raw
 * text at the blanked offset, since {@link stripSource} blanks in place.
 */
export function plantedStaleRowRegistrations(
	raw: string,
	blanked: string = stripSource(raw, { strings: "blank" }),
): PlantedStaleRowRegistration[] {
	const registrations: PlantedStaleRowRegistration[] = [];
	const callAt = /(?<![\w$.])expectPlantedStaleRow\s*\(/g;
	const literals = stringLiterals(raw, blanked);
	for (let match = callAt.exec(blanked); match; match = callAt.exec(blanked)) {
		const open = match.index + match[0].length - 1;
		const close = matchingCloseIndex(blanked, open, "(", ")");
		const args = blanked.slice(open, close < 0 ? blanked.length : close);
		let baseline: string | undefined;
		let baselineLiteral: number | undefined;
		const baselineKey = /(?<![\w$])baseline\s*:\s*/.exec(args);
		if (baselineKey !== null) {
			const valueAt = open + baselineKey.index + baselineKey[0].length;
			const literal = literals.find((l) => l.at === valueAt);
			if (literal !== undefined) {
				baseline = literal.value;
				baselineLiteral = valueAt;
			}
		}
		registrations.push({
			baseline,
			hasRowKey: /(?<![\w$])rowKey\s*[:,}]/.test(args),
			callParen: open,
			line: raw.slice(0, match.index).split("\n").length,
			baselineLiteral,
		});
	}
	return registrations;
}

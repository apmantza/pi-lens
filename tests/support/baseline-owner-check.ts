/**
 * #5072 bullet 3: the owner-and-staleness census over the tracked tree.
 *
 * A baseline admits work a scanner still finds, so a row whose producer has
 * gone is a free pass: a check that asks only "does the live scan stay inside
 * the ledger" also passes on a ledger of rows nobody produces any more. This
 * module finds every tracked baseline, places it with a short list of positive
 * class rules, and reports every ledger that has no owner test or no
 * planted-stale-row cell. Anything a claim picks up and no rule places is
 * `unclassified` and reds, so a new shape cannot join the tree silently.
 *
 * Population: every tracked path (the caller passes `git ls-files`, so
 * dot-files and dot-dirs are in it and no extension is filtered out). An
 * entry is a candidate through one of three claims read from the artifact:
 *
 * - name: its basename says `baseline`, whatever the extension;
 * - export: a JS/TS module exports a binding whose name says `baseline`;
 * - content: it parses as a JSON document holding a row collection whose rows
 *   name tracked members (see {@link memberKeyedRows}).
 *
 * `tests/config/baseline-owner-governance.test.ts` runs it over the repo and
 * holds the planted cells that prove each rule reds; the seam a cell calls
 * lives in `tests/support/baseline-staleness.ts`.
 */

import * as path from "node:path";
import JSON5 from "json5";
import { stripSource, testDeclarations } from "./sweep-kit.js";
import {
	initializerSpan,
	plantedStaleRowRegistrations,
	stringLiterals,
} from "./baseline-staleness.js";

/** A file or export whose name claims to hold a baseline. */
const BASELINE_NAME = /baseline/i;

/** A JS/TS module the census reads exported bindings from. */
const CODE_MODULE = /\.(?:[cm]?[jt]s|tsx)$/;

/** An ambient declaration file: it declares a module's shape and holds no rows. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/** A vitest file: the only kind of file that can own a ledger or hold a cell. */
const TEST_FILE = /\.test\.(?:[cm]?[jt]s|tsx)$/;

/** The fixture tree tests copy into temporary roots as input (#5546 F4). */
const FIXTURE_ROOT = "tests/fixtures/";

/** The seam a planted-stale-row cell calls (#5072). */
const STALE_ROW_SEAM = "expectPlantedStaleRow";

/** What the census can call a candidate. Only `ledger` and `unclassified` can red. */
export type BaselineClass =
	| "ledger"
	| "bound"
	| "code"
	| "fixture-input"
	| "model"
	| "prose"
	| "registered"
	| "unclassified";

/** One candidate, with the class the census gave it. */
export interface BaselineCandidate {
	/** `<repo path>` for a file, `<repo path>#<EXPORT>` for a module binding. */
	readonly id: string;
	readonly repoPath: string;
	readonly cls: BaselineClass;
	/** Why the census gave it this class, shown in the census and findings. */
	readonly why: string;
}

/** One way the ownership contract is unmet. */
export interface BaselineFinding {
	readonly id: string;
	readonly problem: string;
}

/**
 * Candidates that are not baselines, each with the reason a reviewer can
 * check. A row names a candidate the class rules would otherwise send to
 * `ledger` or `unclassified`; a row that names anything else is dead and
 * reds, so the table only shrinks. The census discovers this table as a
 * ledger of its own (its name says baseline), and the governance test plants
 * its cell.
 */
export const NOT_A_BASELINE: Readonly<Record<string, string>> = {
	".all-contributorsrc":
		"the all-contributors manifest: its rows name people and the files their badges render into, and no ratchet excuses a finding with them",
	".markdownlint-cli2.jsonc":
		"markdownlint-cli2's own configuration, read by the tool; no test compares its rows with a live scan",
	".oxfmtrc.json":
		"oxfmt's own configuration, read by the tool; no test compares its rows with a live scan",
	".oxlintrc.json":
		"oxlint's own configuration, read by the tool; no test compares its rows with a live scan",
	".vscode/settings.json":
		"editor settings for contributors; no tool or test excuses a finding with its rows",
	"cases/python/autofix-default-poc/case.json":
		"a run-harness case spec: its rows name the files a run must not change",
	"cases/python/pipeline-dispatch-poc/case.json":
		"a run-harness case spec: its rows name the files a run must not change",
	"cases/ts/format-default-poc/case.json":
		"a run-harness case spec: its rows name the files a run must not change",
	"cases/ts/pipeline-dispatch-poc/case.json":
		"a run-harness case spec: its rows name the files a run must not change",
	"knip.jsonc":
		"knip's own configuration, read by the tool; no test compares its rows with a live scan",
	"package.json":
		"the package manifest: its `files` rows name what the tarball ships, not excused findings",
	"scripts/release-qa.mjs#BASELINE_COLUMNS":
		"the column header of the docs/release-qa-baseline.md table, not rows",
	"scripts/test-shard-weights.json":
		"measured test durations a script regenerates; a stale row moves a shard weight and excuses no finding",
	"scripts/tla-model-costs.json":
		"measured TLA+ model costs a script regenerates; a stale row moves a cost and excuses no finding",
	"tsconfig.dist.json":
		"TypeScript project configuration, read by tsc; no test compares its rows with a live scan",
	"tsconfig.mutation.json":
		"TypeScript project configuration, read by tsc; no test compares its rows with a live scan",
};

/** First non-space character of a file once JSONC line and block comments are skipped. */
function startsLikeJson(text: string): boolean {
	const head = text.replace(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, "");
	return head.startsWith("{") || head.startsWith("[");
}

/** The parsed document when the text is JSON (comments allowed), else undefined. */
function parseJsonDocument(text: string): unknown {
	if (!startsLikeJson(text)) return undefined;
	try {
		return JSON5.parse(text);
	} catch {
		return undefined;
	}
}

/** The JSON kind of a value, so a collection whose rows mix kinds is not a table. */
function kindOf(value: unknown): string {
	if (Array.isArray(value)) return "array";
	return value === null ? "null" : typeof value;
}

/** The strings a row is identified by: itself, its string elements, or its string fields. */
function rowStrings(row: unknown): string[] {
	if (typeof row === "string") return [row];
	if (Array.isArray(row)) return row.filter((v) => typeof v === "string");
	if (row !== null && typeof row === "object") {
		return Object.values(row).filter((v) => typeof v === "string");
	}
	return [];
}

/**
 * Does `value` name a tracked member? Each token (split on `::`, `:`, `#`,
 * whitespace and quotes) is tried as a repo path, as the tail of one (a
 * ledger keyed relative to `tests/`), and as the source twin of a compiled
 * `.js` name.
 */
function namesMember(value: string, members: ReadonlySet<string>): boolean {
	for (const raw of value.split(/::|[\s:#"'`,()[\]]+/)) {
		const token = raw.replace(/^\.\//, "");
		if (token === "") continue;
		const twins = [token];
		if (/\.[cm]?js$/.test(token)) {
			twins.push(token.replace(/js$/, "ts"), token.replace(/\.js$/, ".tsx"));
		}
		for (const twin of twins) {
			if (members.has(twin)) return true;
			if (twin.includes("/") && tailIndex(members).has(twin)) return true;
		}
	}
	return false;
}

const tails = new WeakMap<ReadonlySet<string>, Set<string>>();
/** Every `/`-suffix of every member, once per population. */
function tailIndex(members: ReadonlySet<string>): Set<string> {
	let index = tails.get(members);
	if (index === undefined) {
		index = new Set();
		for (const member of members) {
			for (
				let at = member.indexOf("/");
				at >= 0;
				at = member.indexOf("/", at + 1)
			) {
				index.add(member.slice(at + 1));
			}
		}
		tails.set(members, index);
	}
	return index;
}

/**
 * Is this JSON document a row table keyed by repo members? A row collection
 * is the document itself or one property of it: an array whose entries are
 * all one JSON kind, or an object whose keys are its rows. It is member-keyed
 * when at least one row names a tracked member, so a ledger with stale rows
 * still counts as long as one row is live.
 */
export function memberKeyedRows(
	doc: unknown,
	members: ReadonlySet<string>,
): boolean {
	const collections: unknown[] = [doc];
	if (kindOf(doc) === "object") {
		for (const value of Object.values(doc as object)) {
			if (typeof value === "object" && value !== null) collections.push(value);
		}
	}
	return collections.some((collection) => {
		if (Array.isArray(collection)) {
			if (collection.length === 0) return false;
			const kind = kindOf(collection[0]);
			if (!collection.every((row) => kindOf(row) === kind)) return false;
			return collection.some((row) =>
				rowStrings(row).some((s) => namesMember(s, members)),
			);
		}
		return Object.keys(collection as object).some((key) =>
			namesMember(key, members),
		);
	});
}

/** What a module binding's initializer holds. */
type BindingForm = "table" | "scalar" | "code" | "none";

/** A literal a bound or marker is written as: a number, string, boolean, regex, or plain template. */
const SCALAR_INITIALIZER =
	/^(?:-?(?:\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|0[xob][\da-f_]+)n?|true|false|null|undefined|"[^"\n]*"|'[^'\n]*'|`[^`$]*`|\/[^/\n].*\/[a-z]*)(?:\s+as\s+const)?$/i;

/** A function or class value: code, not rows. */
const CODE_INITIALIZER =
	/^(?:async\s+)?(?:function\b|class\b|[A-Za-z_$][\w$]*\s*=>|\([^()]*\)\s*(?::[^=]*)?=>)/;

/** Classify the initializer of a module-scope binding in blanked source. */
function bindingForm(blanked: string, name: string): BindingForm {
	const span = initializerSpan(blanked, name);
	if (span === undefined) {
		return new RegExp(
			`(?<![\\w$.])(?:function\\*?|class)\\s+${name}(?![\\w$])`,
		).test(blanked)
			? "code"
			: "none";
	}
	const expression = blanked.slice(span.start, span.end).trim();
	if (SCALAR_INITIALIZER.test(expression)) return "scalar";
	if (CODE_INITIALIZER.test(expression)) return "code";
	return "table";
}

/**
 * The exported bindings of a module whose name says baseline, with the form
 * each holds: `export const|let|var NAME`, an export-clause name
 * (`export { rows as X_BASELINE }`, followed to its local binding), and, in a
 * module whose own name says baseline, its default export. Functions,
 * classes, types and re-exports from another module hold no rows here.
 */
function baselineBindings(
	blanked: string,
	namedModule: boolean,
): Array<{ name: string; form: BindingForm }> {
	const found = new Map<string, BindingForm>();
	const declaration =
		/(?<![\w$.])export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
	for (const match of blanked.matchAll(declaration)) {
		const name = match[1]!;
		if (BASELINE_NAME.test(name)) found.set(name, bindingForm(blanked, name));
	}
	const clause = /(?<![\w$.])export\s*(?:type\s*)?\{([^}]*)\}(?!\s*from\b)/g;
	for (const match of blanked.matchAll(clause)) {
		for (const spec of match[1]!.split(",")) {
			const parts = spec.trim().split(/\s+as\s+/);
			const local = parts[0]?.replace(/^type\s+/, "").trim();
			const exported = (parts[1] ?? parts[0] ?? "").trim();
			if (!local || !BASELINE_NAME.test(exported)) continue;
			const form = bindingForm(blanked, local);
			// A name this module imported and re-exports holds its rows in the
			// module that declares it, where the census reads it.
			const imported = new RegExp(
				`(?<![\\w$.])import\\b[^;]*\\b${local}\\b[^;]*\\bfrom\\b`,
			).test(blanked);
			if (!(form === "none" && imported)) found.set(exported, form);
		}
	}
	if (namedModule) {
		const fallback =
			/(?<![\w$.])(?:export\s+default|module\.exports\s*=)\s*/.exec(blanked);
		if (fallback !== null) {
			const rest = blanked.slice(fallback.index + fallback[0].length);
			const end = rest.search(/;\s*(?:\n|$)/);
			const expression = (end < 0 ? rest : rest.slice(0, end)).trim();
			found.set(
				"default",
				CODE_INITIALIZER.test(expression)
					? "code"
					: SCALAR_INITIALIZER.test(expression)
						? "scalar"
						: "table",
			);
		}
	}
	return [...found].map(([name, form]) => ({ name, form }));
}

const BY_ID = (a: { id: string }, b: { id: string }) =>
	a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Classify every candidate of `sources` (tracked repo-relative posix path to
 * text). The class rules, first match wins:
 *
 * 1. under `tests/fixtures/`: `fixture-input`;
 * 2. a JS/TS module: each baseline-named export is a `ledger` (rows), a
 *    `bound` (a scalar literal), or `unclassified` (no initializer); a
 *    baseline-named module with no such export is `code`;
 * 3. a JSON document: `ledger` when its name says baseline or its rows name
 *    tracked members;
 * 4. a baseline-named Markdown file: `prose`; a baseline-named TLA+ module or
 *    config under `formal/`: `model`;
 * 5. any other baseline-named file (YAML, CSV, TOML, JSONL, text, binary):
 *    `unclassified`.
 */
export function classifyBaselines(
	sources: ReadonlyMap<string, string>,
): BaselineCandidate[] {
	const members = new Set(sources.keys());
	const found: BaselineCandidate[] = [];
	const push = (
		id: string,
		repoPath: string,
		cls: BaselineClass,
		why: string,
	) => found.push({ id, repoPath, cls, why });
	for (const [repoPath, text] of sources) {
		const named = BASELINE_NAME.test(path.posix.basename(repoPath));
		const code = CODE_MODULE.test(repoPath) && !DECLARATION_FILE.test(repoPath);
		if (repoPath.startsWith(FIXTURE_ROOT)) {
			if (named || (!code && memberKeyedDocument(text, members))) {
				push(
					repoPath,
					repoPath,
					"fixture-input",
					"fixture input a test copies into a temporary root",
				);
			}
			continue;
		}
		if (code) {
			if (!named && !BASELINE_NAME.test(text)) continue;
			const bindings = baselineBindings(
				stripSource(text, { strings: "blank" }),
				named,
			);
			for (const { name, form } of bindings) {
				if (form === "code") continue;
				push(
					`${repoPath}#${name}`,
					repoPath,
					form === "table"
						? "ledger"
						: form === "scalar"
							? "bound"
							: "unclassified",
					form === "table"
						? `an exported binding holding rows (${name})`
						: form === "scalar"
							? `an exported scalar literal (${name}), a bound and not rows`
							: `an exported binding with no initializer the census can read (${name})`,
				);
			}
			if (named && !bindings.some((b) => b.form !== "code")) {
				push(
					repoPath,
					repoPath,
					"code",
					"a module with no exported baseline binding",
				);
			}
			continue;
		}
		const doc = parseJsonDocument(text);
		if (doc !== undefined) {
			if (named || memberKeyedRows(doc, members)) {
				push(
					repoPath,
					repoPath,
					"ledger",
					named
						? "a JSON document named baseline"
						: "a JSON row table keyed by repo members",
				);
			}
			continue;
		}
		if (!named) continue;
		if (/\.(?:md|markdown)$/i.test(repoPath)) {
			push(
				repoPath,
				repoPath,
				"prose",
				"Markdown prose, not rows a scanner compares",
			);
		} else if (
			repoPath.startsWith("formal/") &&
			/\.(?:tla|cfg)$/.test(repoPath)
		) {
			push(repoPath, repoPath, "model", "a TLA+ module or model config");
		} else {
			push(
				repoPath,
				repoPath,
				"unclassified",
				"a baseline-named file the census cannot read rows from",
			);
		}
	}
	return found.sort(BY_ID);
}

function memberKeyedDocument(
	text: string,
	members: ReadonlySet<string>,
): boolean {
	const doc = parseJsonDocument(text);
	return doc !== undefined && memberKeyedRows(doc, members);
}

/** What the census saw, so the run prints its population and not only a verdict. */
export interface BaselineCensusCounts {
	readonly ledgers: number;
	readonly planted: number;
	readonly unplanted: number;
	readonly unowned: number;
	readonly unclassified: number;
	readonly registered: number;
}

/** The findings, the counts, and every candidate with its final class. */
export interface BaselineGovernanceReport {
	readonly findings: BaselineFinding[];
	readonly counts: BaselineCensusCounts;
	readonly candidates: BaselineCandidate[];
}

/** One test file's code, read once: its blanked text and the paths its literals reach. */
interface TestReferences {
	readonly blanked: string;
	readonly reaches: Set<string>;
}

/**
 * The repo paths a test file's string literals reach: a literal equal to a
 * path or a basename, and a relative specifier resolved from the test's own
 * directory (with the `.ts` twin of a `.js` specifier). Comments are blanked,
 * a literal counts only as a whole value, and the `baseline:` literal of a
 * cell is skipped, so neither a comment, a sentence that mentions a path, nor
 * the cell's own claim makes a test the owner (#5546 F6/B1/B8).
 */
function testReferences(testPath: string, raw: string): TestReferences {
	const blanked = stripSource(raw, { strings: "blank" });
	const skip = new Set(
		raw.includes(STALE_ROW_SEAM)
			? plantedStaleRowRegistrations(raw, blanked).map((r) => r.baselineLiteral)
			: [],
	);
	const reaches = new Set<string>();
	for (const { value, at } of stringLiterals(raw, blanked)) {
		if (skip.has(at) || value === "") continue;
		const spellings = [value.replace(/^\.\//, "")];
		if (value.startsWith(".")) {
			spellings.push(
				path.posix.normalize(
					path.posix.join(path.posix.dirname(testPath), value),
				),
			);
		}
		for (const spelling of spellings) {
			reaches.add(spelling);
			if (/\.[cm]?js$/.test(spelling)) {
				reaches.add(spelling.replace(/js$/, "ts"));
				reaches.add(spelling.replace(/\.js$/, ".tsx"));
			}
		}
	}
	return { blanked, reaches };
}

/** Does this test file read the ledger? */
function readsLedger(
	testPath: string,
	refs: TestReferences,
	ledger: BaselineCandidate,
): boolean {
	const hash = ledger.id.indexOf("#");
	if (hash < 0) {
		return (
			refs.reaches.has(ledger.repoPath) ||
			refs.reaches.has(path.posix.basename(ledger.repoPath))
		);
	}
	const name = ledger.id.slice(hash + 1);
	const uses =
		refs.blanked.match(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g"))
			?.length ?? 0;
	// The declaring file reads its own table when it uses the name past its
	// declaration; any other file has to import the module.
	if (testPath === ledger.repoPath) return uses >= 2;
	return refs.reaches.has(ledger.repoPath) && (name === "default" || uses >= 1);
}

/** The cell shape a finding points a maintainer at. */
const CELL_SHAPE =
	`add a live it() that plants a row and calls ${STALE_ROW_SEAM}({ ` +
	'baseline: "<id>", rowKey: "<planted row>", verdict: <the ratchet comparison over the planted rows> })';

/**
 * Run the census over a source map: classify, find the owners and the cells,
 * and report every ledger that is not owned and planted, every unclassified
 * candidate, every stray cell, and every dead `NOT_A_BASELINE` row.
 */
export function baselineGovernanceReport(
	sources: ReadonlyMap<string, string>,
	notABaseline: Readonly<Record<string, string>> = NOT_A_BASELINE,
): BaselineGovernanceReport {
	const classified = classifyBaselines(sources);
	const findings: BaselineFinding[] = [];
	// A row excuses only what would otherwise red: a ledger or an unclassified
	// candidate. A row for anything else names nothing the census needs excused.
	const excusable = new Set(
		classified
			.filter((c) => c.cls === "ledger" || c.cls === "unclassified")
			.map((c) => c.id),
	);
	for (const id of Object.keys(notABaseline)) {
		if (!excusable.has(id)) {
			findings.push({
				id,
				problem:
					"NOT_A_BASELINE row names no ledger or unclassified candidate (renamed, deleted, or placed by a class rule); drop the row",
			});
		}
	}
	const candidates = classified.map((c) =>
		excusable.has(c.id) && Object.hasOwn(notABaseline, c.id)
			? { ...c, cls: "registered" as const, why: notABaseline[c.id]! }
			: c,
	);
	const ledgers = candidates.filter((c) => c.cls === "ledger");
	const ledgerIds = new Set(ledgers.map((l) => l.id));

	const tests = new Map<string, TestReferences>();
	for (const [repoPath, raw] of sources) {
		if (TEST_FILE.test(repoPath))
			tests.set(repoPath, testReferences(repoPath, raw));
	}

	// Cells: a registration with a baseline literal and a rowKey, inside a live
	// it()/test(). Anything else is not a cell, and the ledger it meant to
	// cover reds as unplanted.
	const cells = new Map<string, string[]>();
	for (const [repoPath, refs] of tests) {
		const raw = sources.get(repoPath)!;
		if (!raw.includes(STALE_ROW_SEAM)) continue;
		const live = testDeclarations(raw, refs.blanked).filter(
			(d) => d.live && (d.callee === "it" || d.callee === "test"),
		);
		for (const registration of plantedStaleRowRegistrations(
			raw,
			refs.blanked,
		)) {
			const where = `${repoPath}:${registration.line}`;
			if (registration.baseline === undefined || !registration.hasRowKey)
				continue;
			if (
				!live.some(
					(d) =>
						registration.callParen > d.callParen &&
						registration.callParen < d.callEnd,
				)
			) {
				continue;
			}
			if (!ledgerIds.has(registration.baseline)) {
				findings.push({
					id: registration.baseline,
					problem: `the ${STALE_ROW_SEAM} cell at ${where} names a baseline the census does not hold as a ledger (a typo, or a ledger moved under a not-a-ledger class)`,
				});
				continue;
			}
			cells.set(registration.baseline, [
				...(cells.get(registration.baseline) ?? []),
				where,
			]);
		}
	}

	let planted = 0;
	let unplanted = 0;
	let unowned = 0;
	for (const ledger of ledgers) {
		const owners = [...tests]
			.filter(([p, refs]) => readsLedger(p, refs, ledger))
			.map(([p]) => p)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		if (owners.length === 0) {
			unowned++;
			findings.push({
				id: ledger.id,
				problem: `no test file reads it (${ledger.why}), so no test can red when a row goes stale`,
			});
		}
		if (cells.has(ledger.id)) planted++;
		else {
			unplanted++;
			findings.push({
				id: ledger.id,
				problem: `no planted-stale-row cell (${ledger.why}). Owner tests: ${owners.join(", ") || "none"}. ${CELL_SHAPE}`,
			});
		}
	}
	const unclassified = candidates.filter((c) => c.cls === "unclassified");
	for (const candidate of unclassified) {
		findings.push({
			id: candidate.id,
			problem: `${candidate.why}; add a class rule, or a NOT_A_BASELINE row with the reason`,
		});
	}
	return {
		findings: findings.sort((a, b) =>
			a.id !== b.id
				? BY_ID(a, b)
				: a.problem < b.problem
					? -1
					: a.problem > b.problem
						? 1
						: 0,
		),
		counts: {
			ledgers: ledgers.length,
			planted,
			unplanted,
			unowned,
			unclassified: unclassified.length,
			registered: candidates.filter((c) => c.cls === "registered").length,
		},
		candidates,
	};
}

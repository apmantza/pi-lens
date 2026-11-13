/**
 * #2028/#2029 — delivery-surface adoption ratchet.
 *
 * DELIVERY_SURFACES is the single registry for agent-facing findings/
 * blockers/advisories. `assertNoDeliveryBypass` validates entries IN it,
 * but an emitter that never registers bypasses every gate silently.
 *
 * This ratchet closes that gap: scan clients/ for agent-facing advisory
 * marker emoji (🔴/🛑/🟡) in string/template construction, then require
 * every hit file to appear as a sourceFile in DELIVERY_SURFACES or carry
 * an EXEMPT entry with a reason.
 *
 * What the scan classifies (#4429: a population-deriving scanner fails
 * closed). It reads the parsed source (`tests/support/literal-sites.ts`), so
 * a marker in a comment is not a delivery and never counts or satisfies an
 * exemption. A file is a marker
 * file when its code holds a marker by VALUE, whatever the spelling: the
 * character itself, a `\u{…}` or surrogate-pair `\u…` escape, or a
 * `String.fromCodePoint`/`fromCharCode` call on numeric literals. Text the
 * scan cannot evaluate (a lone surrogate escape, or a code-point call on
 * anything but numeric literals, or a bare reference to one) is an
 * UNCLASSIFIED spelling, reported with its file and line until it is either
 * rewritten or admitted in ADMITTED_UNCLASSIFIED with a reason.
 *
 * Known limitation (documented, accepted floor): a surface that renders
 * findings without these markers (e.g. plain-text "WARNING:" prefix) is
 * invisible here. The AGENTS.md inventory paragraph is the complementary
 * human check.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DELIVERY_SURFACES } from "../../clients/finding-delivery-gate.js";
import {
	fieldWrites,
	guardEvidence,
	literalValues,
	outputSites,
} from "../support/literal-sites.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLIENTS_DIR = path.join(REPO_ROOT, "clients");

const MARKERS = ["🔴", "🛑", "🟡"];
const SCAN_EXTENSIONS = new Set([".ts"]);

/**
 * Code-point text the scan cannot evaluate, admitted by content (the file and
 * the trimmed line), each with the reason it can never be a marker.
 */
const ADMITTED_UNCLASSIFIED: Record<string, string> = {
	'host-edit-normalize.ts: new RegExp(`[${String.fromCharCode(...codePoints)}]`, "g");':
		"regex classes built from this file's HOST_* tables: BMP punctuation and spaces, U+00A0..U+3000",
	"host-edit-normalize.ts: const BOM = String.fromCharCode(HOST_BOM_CODE_POINT);":
		"the U+FEFF byte-order mark, this file's HOST_BOM_CODE_POINT",
	"lsp/index.ts: const decoded = String.fromCharCode(Number.parseInt(match[1], 16));":
		"decodes a two-hex-digit %XX URI escape, so at most U+00FF",
};

interface MarkerScan {
	/** 1-based lines whose code holds a marker by value. */
	markerLines: number[];
	/** `<clients-relative file>: <trimmed line>` for each unevaluable spelling. */
	unclassified: string[];
}

/**
 * Classify every marker spelling in one source (#4429), read by value from
 * the parsed literals (`tests/support/literal-sites.ts`, #5554 r2 F8).
 */
function scanMarkers(rel: string, source: string): MarkerScan {
	const lines = source.split("\n");
	const scan: MarkerScan = { markerLines: [], unclassified: [] };
	for (const { line, value } of literalValues(rel, source)) {
		if (value === undefined)
			scan.unclassified.push(`${rel}: ${lines[line - 1]?.trim() ?? ""}`);
		else if (MARKERS.some((marker) => value.includes(marker)))
			if (!scan.markerLines.includes(line)) scan.markerLines.push(line);
	}
	return scan;
}

function isMarkerFile(rel: string, source: string): boolean {
	return scanMarkers(rel, source).markerLines.length > 0;
}

/** Files with emoji that are NOT agent-directed findings delivery. */
const EXEMPT: Record<string, string> = {
	"finding-delivery-gate.ts":
		"the registry itself - contains marker references in descriptions",
	"todo-scanner.ts": "classification icon return value, not delivered text",
	"actionable-warnings.ts":
		"advisory text built here but delivered by runtime-turn.ts (registered)",
	"demoted-finding-render.ts":
		"transforms pipeline stop-blocker output; follows that registration",
	"runtime-context.ts":
		"framing wrapper over registered context injections; no own delivery",
	// #5120: the partial apply's 🛑 "Batch not applied" line wraps the
	// preflight verdict on the host edit's result; finding-delivery-gate.test.ts
	// classifies this file as delivering that surface.
	"runtime-tool-result.ts":
		"wraps read-guard-tool-lines:preflight-errors (registered) on the edit result",
	"format-utils.ts":
		"shared emoji lookup table consumed by registered render paths",
	// #1892, the same shape as actionable-warnings.ts and
	// demoted-finding-render.ts above: a turn-end LANE renders the sections
	// that `clients/runtime-turn.ts`'s registered `runtime-turn:secrets-*` /
	// `runtime-turn:stale-secrets-tier` seams deliver, and pushes nothing
	// itself (`tests/config/turn-end-lane-boundaries.test.ts` reds if it ever
	// does). Keyed by its path under clients/, not by basename, so this
	// exemption cannot silently cover a future unrelated `secrets.ts`.
	"turn-end/lanes/secrets.ts":
		"turn-end lane; sections delivered by runtime-turn.ts (registered)",
};

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectSourceFiles(full, out);
		} else if (
			SCAN_EXTENSIONS.has(path.extname(entry.name)) &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".d.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

function registeredSourceFiles(): Set<string> {
	const files = new Set<string>();
	for (const entry of Object.values(DELIVERY_SURFACES)) {
		const sf = (entry as { file?: string }).file;
		if (sf) files.add(path.basename(sf));
	}
	return files;
}

describe("delivery-surface adoption ratchet (#2028/#2029)", () => {
	it("every advisory-marker file is registered or exempted", () => {
		const registered = registeredSourceFiles();
		const unregistered: string[] = [];

		for (const full of collectSourceFiles(CLIENTS_DIR)) {
			const rel = path.relative(CLIENTS_DIR, full);
			const base = path.basename(rel);
			const content = fs.readFileSync(full, "utf8");
			if (!isMarkerFile(rel, content)) continue;
			if (registered.has(base) || EXEMPT[base] || EXEMPT[rel]) continue;
			unregistered.push(rel);
		}

		expect(unregistered).toEqual([]);
	});

	it("exempted files still contain their marker (no stale exemptions)", () => {
		// Resolve each exempt key to its actual location (some are nested).
		const allFiles = collectSourceFiles(CLIENTS_DIR);
		for (const base of Object.keys(EXEMPT)) {
			// A key is either a basename or a clients/-relative path (#1892: a
			// nested lane needs the narrower spelling, and a stale exemption of
			// either spelling must still be reported by this test).
			const match = allFiles.find(
				(f) =>
					path.basename(f) === base || path.relative(CLIENTS_DIR, f) === base,
			);
			expect(
				match,
				`exempt file not found under clients/: ${base}`,
			).toBeDefined();
			const content = fs.readFileSync(match!, "utf8");
			expect(
				isMarkerFile(base, content),
				`exempt file ${base} no longer matches advisory markers`,
			).toBe(true);
		}
	});

	it("ratchet floor: at least one advisory-marker file detected", () => {
		let count = 0;
		for (const full of collectSourceFiles(CLIENTS_DIR)) {
			const rel = path.relative(CLIENTS_DIR, full);
			if (isMarkerFile(rel, fs.readFileSync(full, "utf8"))) count++;
		}
		expect(count).toBeGreaterThanOrEqual(3);
	});

	it("classifies every marker spelling in clients/ (#4429)", () => {
		// Recurrence: #4411 review F3, a population scanner that skipped
		// spellings it did not recognise and passed. Also catches a stale
		// admission, so the list can only shrink with the code.
		const unclassified = collectSourceFiles(CLIENTS_DIR).flatMap((full) => {
			const rel = path.relative(CLIENTS_DIR, full).split(path.sep).join("/");
			return scanMarkers(rel, fs.readFileSync(full, "utf8")).unclassified;
		});
		expect(
			unclassified
				.filter((entry) => !Object.hasOwn(ADMITTED_UNCLASSIFIED, entry))
				.map((entry) => `unclassified spelling at ${entry}`),
		).toEqual([]);
		expect(
			Object.keys(ADMITTED_UNCLASSIFIED).filter(
				(entry) => !unclassified.includes(entry),
			),
			"stale ADMITTED_UNCLASSIFIED entries",
		).toEqual([]);
	});

	it("reads a marker by value through every escape spelling (#4429)", () => {
		// The raw-character needle missed `clients/mutating-tool.ts`'s
		// "\u{1F534} BLOCKED —" (registered, so no bypass, but invisible).
		const source = [
			'const a = "\\u{1F534} BLOCKED";',
			"const b = `\\uD83D\\uDED1 stop`;",
			"const c = String.fromCodePoint(0x1f7e1);",
			"const d = String.fromCharCode(0xd83d, 0xdd34);",
			'const e = String["fromCodePoint"](0x1f534);',
			'const plain = "\\u{1F7E2} \\\\u{1F534} " + String.fromCodePoint(1);',
		].join("\n");
		expect(scanMarkers("fake.ts", source)).toEqual({
			markerLines: [1, 2, 3, 4, 5],
			unclassified: [],
		});
	});

	it("reports a marker spelling it cannot evaluate, with its line (#4429)", () => {
		// The fail-closed branch: a lone surrogate half and a code-point call
		// on a computed value may spell a marker, so each reds, never skips.
		const source = [
			"const ok = 1;",
			'const half = "\\uD83D" + tail;',
			"const built = String.fromCodePoint(base + 0x534);",
			"const make = String.fromCharCode;",
			"const keyed = String[key](0x1f534);",
			"const bracketRef = String['fromCharCode'];",
		].join("\n");
		expect(scanMarkers("fake.ts", source)).toEqual({
			markerLines: [],
			unclassified: [
				'fake.ts: const half = "\\uD83D" + tail;',
				"fake.ts: const built = String.fromCodePoint(base + 0x534);",
				"fake.ts: const make = String.fromCharCode;",
				"fake.ts: const keyed = String[key](0x1f534);",
				"fake.ts: const bracketRef = String['fromCharCode'];",
			],
		});
	});

	it("ignores markers and unevaluable spellings inside comments and strings (#4429)", () => {
		// The self-excuse direction: before #4429 a marker in a doc comment
		// kept two exemptions (widget-state.ts, inline-blocker-dispositions.ts)
		// alive with no marker in their code.
		const source = [
			"// 🔴 BLOCKED, String.fromCodePoint(base)",
			'/* "\\u{1F534}" and "\\uD83D" */',
			"const doc = \"call String['fromCodePoint'](base) here\";",
		].join("\n");
		expect(scanMarkers("fake.ts", source)).toEqual({
			markerLines: [],
			unclassified: [],
		});
	});
});

/**
 * #5258 clean-claim census. A clean verdict ("clean", "✓", "No diagnostics
 * found.") must come from proof, so every literal a delivery surface can emit
 * is classified, whatever its wording: `claim`, `finding` or `neutral`, in
 * `tests/clients/clean-claim-census.json`, keyed by its source text
 * (whitespace collapsed) with its count. A new or reworded literal reds until
 * it is classified, so a claim cannot appear under a spelling nobody listed
 * (#5554 review F1), and a swapped line changes its identity (F4/B5/B6).
 *
 * A claim names its producer. `cleanVerdict` and `checkedVerdict`
 * (`clients/dispatch/types.ts`) are the proof producers: the claim's own
 * statement must read its `guard`, and for `cleanVerdict` the guard is
 * initialised by a `cleanVerdict(` call or reads a `field` that every write
 * in the file sets from one, so a relabelled row or a `clean: true` reds.
 * `own` rows decide locally; OWN_CLAIM_CEILING pins their count, so a new
 * one is a visible raise and a converted one lowers it.
 *
 * Accepted residuals: a claim assembled at runtime from literals each
 * classified neutral is read as neutral, and files outside CENSUS_FILES are
 * not in the census.
 */
const CENSUS_FILES = [
	"tools/lens-diagnostics.ts",
	"tools/lsp-diagnostics.ts",
	"index.ts",
	"clients/widget-state.ts",
	"mcp/analyze-cli.ts",
	"clients/pipeline.ts",
];
const OWN_CLAIM_CEILING = 26;

type Producer = "cleanVerdict" | "checkedVerdict" | "own";
interface ClaimRow {
	count: number;
	producer: Producer;
	guard?: string;
	field?: string;
	why: string;
}
interface FileRows {
	claim: Record<string, ClaimRow>;
	finding: Record<string, number>;
	neutral: Record<string, number>;
}
type CensusRegistry = Record<string, FileRows>;

const CENSUS_PATH = path.join(
	REPO_ROOT,
	"tests/clients/clean-claim-census.json",
);

function loadCensus(): CensusRegistry {
	const raw = JSON.parse(fs.readFileSync(CENSUS_PATH, "utf8")) as Record<
		string,
		unknown
	>;
	return Object.fromEntries(
		Object.entries(raw).filter(([key]) => !key.startsWith("$")),
	) as CensusRegistry;
}

/** Every disagreement between one file's literals and its registry rows. */
function censusProblems(
	file: string,
	source: string,
	rows: FileRows,
): string[] {
	const registered = new Map<string, number>();
	const problems: string[] = [];
	for (const [cls, table] of Object.entries(rows) as [
		keyof FileRows,
		Record<string, number | ClaimRow>,
	][])
		for (const [key, value] of Object.entries(table)) {
			if (registered.has(key))
				problems.push(`${file}: ${key} is registered in two classes`);
			registered.set(key, typeof value === "number" ? value : value.count);
			if (!["claim", "finding", "neutral"].includes(cls))
				problems.push(`${file}: unknown class ${cls}`);
		}
	const found = new Map<string, number[]>();
	for (const site of outputSites(file, source))
		found.set(site.key, [...(found.get(site.key) ?? []), site.line]);
	for (const [key, lines] of found) {
		const count = registered.get(key);
		if (count === undefined)
			problems.push(
				`${file}:${lines.join(",")}: unclassified output site ${key} (add it under claim, finding or neutral)`,
			);
		else if (count !== lines.length)
			problems.push(
				`${file}:${lines.join(",")}: ${key} registered x${count}, found x${lines.length}`,
			);
	}
	for (const key of registered.keys())
		if (!found.has(key)) problems.push(`${file}: stale row ${key}`);
	return problems;
}

const CLEAN_VERDICT_CALL = /^cleanVerdict\s*\(/;

/**
 * A value is a `cleanVerdict(` call, or a bare identifier whose nearest
 * preceding declaration is initialised by one (a shorthand `{ clean }`).
 */
function fromCleanVerdict(
	file: string,
	source: string,
	write: { value: string; start: number },
): boolean {
	if (CLEAN_VERDICT_CALL.test(write.value)) return true;
	if (!/^[\w$]+$/.test(write.value)) return false;
	const { init } = guardEvidence(file, source, write.start, write.value);
	return CLEAN_VERDICT_CALL.test(init ?? "");
}

/** Every claim row whose producer its code does not show. */
function producerProblems(
	file: string,
	source: string,
	rows: FileRows,
): string[] {
	const problems: string[] = [];
	for (const [key, row] of Object.entries(rows.claim)) {
		if (!row.why?.trim()) problems.push(`${file}: ${key} has no why`);
		if (row.producer === "own") continue;
		if (row.producer !== "cleanVerdict" && row.producer !== "checkedVerdict") {
			problems.push(`${file}: ${key} names unknown producer ${row.producer}`);
			continue;
		}
		const guard = row.guard ?? "";
		const fieldValues =
			row.field !== undefined ? fieldWrites(file, source, row.field) : [];
		for (const site of outputSites(file, source).filter((s) => s.key === key)) {
			const evidence = guardEvidence(file, source, site.start, guard);
			const where = `${file}:${site.line}: ${row.producer} claim`;
			if (!guard || !evidence.referenced) {
				problems.push(`${where}: its statement does not read guard ${guard}`);
				continue;
			}
			if (row.producer === "checkedVerdict") {
				if (!/\.checked$/.test(guard))
					problems.push(`${where}: guard ${guard} is not a verdict's .checked`);
				continue;
			}
			const byCall = CLEAN_VERDICT_CALL.test(evidence.init ?? "");
			const byField =
				row.field !== undefined &&
				new RegExp(`\\.${row.field}\\b`).test(evidence.init ?? "") &&
				fieldValues.length > 0 &&
				fieldValues.every((write) => fromCleanVerdict(file, source, write));
			if (!byCall && !byField)
				problems.push(
					`${where}: guard ${guard} is not set by cleanVerdict (init ${evidence.init ?? "none"}; ${row.field ?? "no field"} writes ${fieldValues.map((write) => write.value).join(" | ") || "none"})`,
				);
		}
	}
	return problems;
}

function readCensusSource(file: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
}

describe("clean-claim census (#5258)", () => {
	it(
		"every emitted literal in the census files is classified",
		() => {
			// Recurrence: #5554 review F1, "No diagnostics found." x4, the delta
			// body and "✅ Codebase is healthy!" rendered clean under spellings a
			// needle list never named. Also reds a stale or miscounted row.
			const census = loadCensus();
			expect(Object.keys(census).sort()).toEqual([...CENSUS_FILES].sort());
			expect(
				CENSUS_FILES.flatMap((file) =>
					censusProblems(file, readCensusSource(file), census[file]!),
				),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"a producer claim reads its guard and the guard comes from the producer",
		() => {
			// Recurrence: #5554 review F4/B2, an own row relabelled to a producer
			// its code never calls, laundering a local clean decision.
			const census = loadCensus();
			expect(
				CENSUS_FILES.flatMap((file) =>
					producerProblems(file, readCensusSource(file), census[file]!),
				),
			).toEqual([]);
			const own = Object.values(census)
				.flatMap((rows) => Object.values(rows.claim))
				.filter((row) => row.producer === "own")
				.reduce((sum, row) => sum + row.count, 0);
			expect(own, "move OWN_CLAIM_CEILING with the rows").toBe(
				OWN_CLAIM_CEILING,
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it.each([
		["a check-mark emoji", 'export const plant = "\u2705";'],
		["No findings", 'export const plant = "No findings";'],
		["All checks passed", "export const plant = `All checks passed`;"],
		["healthy", 'export const plant = "healthy";'],
		[
			"an interpolated No ${x} issues",
			"export const plant = `No ${x} issues`;",
		],
		[
			"a second copy of a claim",
			'export const plant = "No diagnostics found.";',
		],
	])("reds a planted %s in a census file", (_name, plant) => {
		// The review's planted spellings (probe pC): each is unclassified, so it
		// reds whatever words it uses.
		const file = "tools/lsp-diagnostics.ts";
		const source = `${readCensusSource(file)}\n${plant}\n`;
		const problems = censusProblems(file, source, loadCensus()[file]!);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(
			/unclassified output site|registered x2, found x3/,
		);
	});

	it("reds a negation line swapped for a clean one", () => {
		// Recurrence: #5554 review B5/B6, a count-only registry passed a
		// "not a clean verdict" line rewritten to claim clean.
		const file = "tools/lens-diagnostics.ts";
		const original = readCensusSource(file);
		const source = original.replace(
			"Absence of their findings is NOT a clean verdict.`",
			"Absence of their findings is a clean verdict.`",
		);
		expect(source).not.toBe(original);
		const problems = censusProblems(file, source, loadCensus()[file]!);
		expect(problems.some((p) => p.includes("unclassified output site"))).toBe(
			true,
		);
		expect(problems.some((p) => p.includes("stale row"))).toBe(true);
	});

	it("reds a clean field written without cleanVerdict", () => {
		// The review's `clean: true` plant: the header reads details.clean, so a
		// literal true there would say clean without proof.
		const file = "tools/lens-diagnostics.ts";
		const original = readCensusSource(file);
		const source = original.replace(
			"clean: cleanVerdict({",
			"clean: true || cleanVerdict({",
		);
		expect(source).not.toBe(original);
		expect(producerProblems(file, source, loadCensus()[file]!)).toEqual([
			expect.stringMatching(/guard proven is not set by cleanVerdict/),
		]);
	});

	it("reds a clean binding no longer set by cleanVerdict", () => {
		// The ✓ line reads `clean` directly and the header reads it through the
		// shorthand `{ clean }` field write, so both lose their proof.
		const file = "tools/lens-diagnostics.ts";
		const original = readCensusSource(file);
		const source = original.replace(
			"const clean = cleanVerdict({ ...cleanEvidence, findings: 0 });",
			"const clean = visibleSummaries.length > 0;",
		);
		expect(source).not.toBe(original);
		expect(producerProblems(file, source, loadCensus()[file]!)).toEqual([
			expect.stringMatching(/:556: .*guard proven is not set by cleanVerdict/),
			expect.stringMatching(/:4062: .*guard clean is not set by cleanVerdict/),
		]);
	});

	it("reds an own claim relabelled to a producer it does not read", () => {
		const file = "tools/lens-diagnostics.ts";
		const rows = loadCensus()[file]!;
		const [key, row] = Object.entries(rows.claim).find(([key]) =>
			key.startsWith("`No new ${severity"),
		)!;
		const relabelled: FileRows = {
			...rows,
			claim: {
				...rows.claim,
				[key]: {
					...row,
					producer: "cleanVerdict",
					guard: "proven",
					field: "clean",
				},
			},
		};
		expect(producerProblems(file, readCensusSource(file), relabelled)).toEqual([
			expect.stringMatching(/does not read guard proven/),
		]);
	});
});

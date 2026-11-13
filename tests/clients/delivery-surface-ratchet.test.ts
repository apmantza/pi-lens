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
 * closed). It reads comment-blanked source with string contents kept, since
 * the marker's evidence is a string literal, so a marker in a comment is not
 * a delivery and never counts or satisfies an exemption. A file is a marker
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
import { matchingCloseIndex, stripSource } from "../support/sweep-kit.js";
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

const NUMERIC_LITERAL =
	/^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*)$/;
const UNICODE_ESCAPE = /\\u\{([\da-fA-F]+)\}|\\u([\da-fA-F]{4})/g;
const CODE_POINT_CALL = /\bfrom(?:CodePoint|CharCode)\b/g;
const BRACKET_KEY = /\[\s*(["'`])[\w$]+\1\s*\]/g;
const STRING_SUBSCRIPT = /\bString\s*\[/g;

function isSurrogate(text: string): boolean {
	return /[\uD800-\uDFFF]/.test(
		text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
	);
}

/** Classify every spelling of a needle (default: the markers) in one source. */
function scanMarkers(
	rel: string,
	source: string,
	needles: readonly string[] = MARKERS,
): MarkerScan {
	const kept = stripSource(source, { strings: "keep" });
	const blanked = stripSource(source);
	const lines = source.split("\n");
	const lineAt = (index: number) => source.slice(0, index).split("\n").length;
	const scan: MarkerScan = { markerLines: [], unclassified: [] };
	const classify = (index: number, value: string | undefined) => {
		const line = lineAt(index);
		if (value === undefined || isSurrogate(value)) {
			scan.unclassified.push(`${rel}: ${lines[line - 1]?.trim() ?? ""}`);
		} else if (needles.some((marker) => value.includes(marker))) {
			scan.markerLines.push(line);
		}
	};
	for (const marker of needles) {
		for (
			let at = kept.indexOf(marker);
			at >= 0;
			at = kept.indexOf(marker, at + 1)
		) {
			classify(at, marker);
		}
	}
	// A run of adjacent escapes decodes as one value, so a surrogate pair
	// written `\uD83D\uDD34` is one marker and a lone half is unclassified.
	let run: { start: number; end: number; text: string } | undefined;
	const flush = () => {
		if (run) classify(run.start, run.text);
		run = undefined;
	};
	for (const match of kept.matchAll(UNICODE_ESCAPE)) {
		const start = match.index ?? 0;
		const backslashes = /\\*$/.exec(kept.slice(0, start))?.[0].length ?? 0;
		if (backslashes % 2 === 1) continue; // `\\u…` is a literal backslash
		const codePoint = Number.parseInt(match[1] ?? match[2], 16);
		const text =
			codePoint > 0x10ffff ? undefined : String.fromCodePoint(codePoint);
		if (text === undefined) {
			flush();
			classify(start, undefined);
			continue;
		}
		if (run && run.end === start)
			run = { ...run, end: start + match[0].length, text: run.text + text };
		else {
			flush();
			run = { start, end: start + match[0].length, text };
		}
	}
	flush();
	// A code-point constructor is a member of `String`, read by dot or by a
	// literal bracket key (#4457 review F5); a `String[…]` key the scan cannot
	// read may name one, so it is unclassified.
	const sites: { name: string; start: number; after: number }[] = [];
	for (const match of blanked.matchAll(CODE_POINT_CALL)) {
		const start = match.index ?? 0;
		sites.push({ name: match[0], start, after: start + match[0].length });
	}
	for (const match of kept.matchAll(BRACKET_KEY)) {
		const start = match.index ?? 0;
		if (blanked[start] !== "[") continue; // inside a string or regex
		const key = /^\[\s*(["'`])([\w$]+)\1\s*\]$/.exec(match[0])?.[2];
		if (key === "fromCodePoint" || key === "fromCharCode")
			sites.push({ name: key, start, after: start + match[0].length });
	}
	for (const match of blanked.matchAll(STRING_SUBSCRIPT)) {
		const openIndex = (match.index ?? 0) + match[0].length - 1;
		const close = matchingCloseIndex(blanked, openIndex, "[", "]");
		const key = close < 0 ? "" : kept.slice(openIndex + 1, close).trim();
		if (!/^(["'`])[\w$]+\1$/.test(key)) classify(openIndex, undefined);
	}
	for (const { name, start, after } of sites) {
		const open = /^\s*\(/.exec(blanked.slice(after));
		if (!open) {
			classify(start, undefined); // a reference: called somewhere unseen
			continue;
		}
		const openIndex = after + open[0].length - 1;
		const close = matchingCloseIndex(blanked, openIndex, "(", ")");
		const args =
			close < 0
				? []
				: kept
						.slice(openIndex + 1, close)
						.split(",")
						.map((arg) => arg.trim());
		if (close < 0 || !args.every((arg) => NUMERIC_LITERAL.test(arg))) {
			classify(start, undefined);
			continue;
		}
		const units = args.map((arg) => Number(arg.replace(/_/g, "")));
		classify(
			start,
			name === "fromCodePoint"
				? String.fromCodePoint(...units)
				: String.fromCharCode(...units),
		);
	}
	scan.markerLines.sort((a, b) => a - b);
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
				"fake.ts: const keyed = String[key](0x1f534);",
				"fake.ts: const built = String.fromCodePoint(base + 0x534);",
				"fake.ts: const make = String.fromCharCode;",
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
 * #5258 — clean-claim registry (AGENTS.md shape 10, "silencing as fixing").
 *
 * Every rendered "clean", "✓" or "No issues" claim must be backed by proof
 * that the scope was checked; a bare empty result never stands in. The
 * known-good form is a claim gated by a producer: `cleanVerdict` (zero
 * findings over a scope where every file was proven checked) or
 * `checkedVerdict` (a dispatch verdict, read as `verdict.checked`), both in
 * `clients/dispatch/types.ts`. A claim still decided by its own local logic
 * is an `own` row: the instance list this registry shrinks, pinned by count.
 *
 * The scan reads every clients/, tools/, mcp/ and index.ts source and finds
 * each line whose string, template or regex text holds a clean needle (the
 * words below, case-insensitive, after decoding `\u`/`\x` escapes and joining
 * `"a" + "b"` on one line) or a ✓/✔ by value (the marker decoder above, so a
 * `String.fromCodePoint(0x2713)` counts). Comments never count. Every hit line
 * is a CLEAN_EMITTERS row or counted in its file's NOT_A_CLEAN_CLAIM entry, so
 * a new claim reds until someone names its producer. Residual (accepted):
 * a needle split across lines, or assembled at runtime from bindings that
 * each hold a fragment, is not read.
 */
const CLEAN_GLYPHS = ["✓", "✔"];
const CLEAN_WORDS = /\bclean\b|\bno issues\b|\ball (?:passed|clear)\b/i;
const TEXT_ESCAPE =
	/\\u\{([\da-fA-F]+)\}|\\u([\da-fA-F]{4})|\\x([\da-fA-F]{2})/g;
const CLEAN_SCAN_ROOTS = ["clients", "tools", "mcp"];
const CLEAN_SCAN_FILES = ["index.ts"];

type CleanProducer = "cleanVerdict" | "checkedVerdict" | "own";

/** How a producer shows in the emitting file's code. */
const PRODUCER_CALL: Record<Exclude<CleanProducer, "own">, RegExp> = {
	cleanVerdict: /\bcleanVerdict\s*\(/,
	checkedVerdict: /\bverdict\.checked\b|\bcheckedVerdict\s*\(/,
};

/**
 * Lines that render or record a clean verdict, keyed `<file>: <trimmed line>`.
 * `proof` names what pins the row (a test, or the open question it carries);
 * `lines` counts identical lines one row covers.
 */
const CLEAN_EMITTERS: Record<
	string,
	{ producer: CleanProducer; proof: string; lines?: number }
> = {
	"clients/pipeline.ts: ? `\\u2713 ${langLabel} clean · ${elapsed}ms`": {
		producer: "checkedVerdict",
		proof:
			"the dispatch verdict (#5285); tests/clients/dispatch-pipeline-formal.test.ts",
	},
	'tools/lens-diagnostics.ts: return `lens_diagnostics ${mode} — ${cacheVerdict ?? (proven ? "clean" : "unconfirmed")}${advisorySuffix}${uncheckedSuffix} (${proven ? (details?.provenFiles ?? files) : files} files)${coldSuffix}${failedSuffix}`;':
		{
			producer: "cleanVerdict",
			proof: "tests/tools/lens-diagnostics-clean-proof-5258.test.ts",
		},
	'tools/lens-diagnostics.ts: : `No ${severity === "all" ? "" : severity + " "}issues across ${provenCount} file${provenCount === 1 ? "" : "s"} diagnosed this session. ✓\\n`) +':
		{
			producer: "cleanVerdict",
			proof: "tests/tools/lens-diagnostics-clean-proof-5258.test.ts",
		},
	'tools/lens-diagnostics.ts: return `lens_diagnostics${scope} — ${count} ${noun} · ${details.cleanFiles ?? 0} clean · ${details.unconfirmedFiles} unconfirmed${details.timedOutFiles ? ` (${details.timedOutFiles} timed out)` : ""}`;':
		{
			producer: "own",
			proof:
				"per-file count from classifyBatchFileOutcome (tools/lsp-diagnostics.ts)",
		},
	'clients/persistent-reverify.ts: ? "clean"': {
		producer: "own",
		proof:
			"every carried warning re-checked and answered; tests/clients/persistent-reverify.test.ts C3b",
	},
	'clients/widget-state.ts: ? green("✓ clean")': {
		producer: "own",
		proof: "a completed check and no pending analysis (#5287)",
	},
	'clients/widget-state.ts: return "clean";': {
		producer: "own",
		proof:
			"classifyFileTier: zero counts; the row renders through isUncheckedClean",
	},
	'clients/widget-state.ts: : green("✓");': {
		producer: "own",
		proof: "isUncheckedClean decides the per-file glyph",
	},
	'clients/widget-state.ts: : " " + dim("clean");': {
		producer: "own",
		proof: "isUncheckedClean decides the per-file word",
	},
	'clients/runtime-turn.ts: ? " confirmed clean"': {
		producer: "own",
		proof: "ResolvedBlockerFile.confirmedClean from the turn-end observation",
	},
	'clients/runtime-turn.ts: "clean";': {
		producer: "own",
		proof: "turn_end result before blocker parts are counted",
	},
	"clients/test-runner-client.ts: return `[Tests] ✓ ${result.passed}/${total} passed${durationStr} — ${result.runner}`;":
		{
			producer: "own",
			proof:
				"result.failed === 0 over a parsed run; tests/clients/test-runner-client.test.ts",
		},
	'tools/lsp-diagnostics.ts: return tier === "tier3-silent" ? "unconfirmed" : "clean";':
		{
			producer: "own",
			proof: "classifyEmptyResult (#533); tests/tools/lsp-diagnostics.test.ts",
		},
	'tools/lsp-diagnostics.ts: return "clean";': {
		producer: "own",
		proof:
			"classifyEmptyResult's catch and classifyBatchFileOutcome's fall-through: open hypotheses H1/H2 on #5258",
		lines: 2,
	},
	'tools/lsp-diagnostics.ts: cached.diagnostics.length === 0 ? "clean" : undefined;':
		{
			producer: "own",
			proof: "a cache replay bound to the current disk",
		},
	'tools/lsp-diagnostics.ts: confirmation = "clean";': {
		producer: "own",
		proof: "canTrustTouchConfirmation over the touch's answer",
		lines: 2,
	},
	'tools/lsp-diagnostics.ts: ? "clean"': {
		producer: "own",
		proof: "a confirmed empty resolution",
		lines: 2,
	},
	'tools/lsp-diagnostics.ts: return `Primary LSP${primaryId ? ` (${primaryId})` : ""}: confirmed clean.`;':
		{
			producer: "own",
			proof:
				"the primary answered with no diagnostics; tests/tools/lsp-diagnostics-missing-primary-4322.test.ts",
		},
	'tools/lsp-diagnostics.ts: `${clean} file${clean === 1 ? "" : "s"} confirmed clean, ${unconfirmed} unconfirmed: ` +':
		{
			producer: "own",
			proof: "batch count from classifyBatchFileOutcome",
		},
	"tools/lsp-diagnostics.ts: ? `${clean} clean · ${unconfirmed} unconfirmed: ` +":
		{
			producer: "own",
			proof: "batch count from classifyBatchFileOutcome",
		},
	'tools/lsp-diagnostics.ts: `${clean} other file${clean === 1 ? "" : "s"} confirmed clean, ${unconfirmed} unconfirmed: ` +':
		{
			producer: "own",
			proof: "batch count from classifyBatchFileOutcome",
		},
	'clients/lsp/client.ts: ? { status: "clean" }': {
		producer: "own",
		proof: "one client answered empty for the file",
	},
	'clients/lsp/client.ts: : { status: "clean" };': {
		producer: "own",
		proof: "a pull answered with zero diagnostics",
	},
	'clients/lsp/cascade-tier.ts: outcome: found ? "resolved-found" : "resolved-clean",':
		{
			producer: "own",
			proof:
				"a resolved neighbor with no errors; tests/index-cascade-resolved-clean-wiring.test.ts",
			lines: 2,
		},
	'clients/dispatch/integration.ts: visibleNeighbors.length === 0 ? "no_neighbors" : "clean";':
		{
			producer: "own",
			proof: "every selected neighbor answered, none with errors",
		},
	'clients/runtime-tool-result.ts: "cited-file-clean",': {
		producer: "own",
		proof:
			"retires foreign rows when the cited file's analysis ran clean (#4137)",
	},
};

/**
 * The count of hit lines per file that are not a clean claim, with the reason.
 * A count that moves either way reds, so each new line is judged.
 */
const NOT_A_CLEAN_CLAIM: Record<string, { lines: number; reason: string }> = {
	"clients/cascade-format.ts": {
		lines: 3,
		reason: "warnings that a result is not clean",
	},
	"clients/cascade-types.ts": {
		lines: 1,
		reason: "the verdict's type member; integration.ts produces it",
	},
	"clients/complexity-client.ts": {
		lines: 1,
		reason: "a regex for 'Clean up' comments",
	},
	"clients/degradation-ledger.ts": {
		lines: 1,
		reason: "a git linked-worktree record kind",
	},
	"clients/dispatch/dispatcher.ts": {
		lines: 7,
		reason: "'not a clean result' disclosures",
	},
	"clients/dispatch/integration.ts": {
		lines: 1,
		reason: "a 'does NOT mean clean' bound disclosure",
	},
	"clients/dispatch/runners/helm-render.ts": {
		lines: 5,
		reason: "'rather than clean' disclosures",
	},
	"clients/finding-delivery-gate.ts": {
		lines: 1,
		reason: "a 'Not a clean verdict' disclosure",
	},
	"clients/formatters.ts": {
		lines: 1,
		reason: "an external tool's exit-code description",
	},
	"clients/generated-artifacts.ts": {
		lines: 4,
		reason: "a not-generated file classification, not a check",
	},
	"clients/git-guard.ts": {
		lines: 1,
		reason: "instructions naming a future clean check",
	},
	"clients/instance-reaper.ts": {
		lines: 2,
		reason: "a nothing-to-reap outcome, not a check",
	},
	"clients/lens-flag-registry.ts": {
		lines: 1,
		reason: "a flag description of the footer glyph",
	},
	"clients/lsp/cascade-tier.ts": {
		lines: 3,
		reason: "type members and comparisons",
	},
	"clients/lsp/client.ts": { lines: 5, reason: "type members and comparisons" },
	"clients/lsp/wait-policy/strategies.ts": {
		lines: 4,
		reason: "wait-policy rationale text",
	},
	"clients/observed-mutation.ts": {
		lines: 3,
		reason: "a content-drift verdict, not a diagnostics check",
	},
	"clients/persistent-reverify.ts": {
		lines: 2,
		reason: "the outcome type and its count",
	},
	"clients/runtime-coordinator.ts": {
		lines: 4,
		reason: "a disclosure, a type and comparisons",
	},
	"clients/runtime-session.ts": {
		lines: 1,
		reason: "'empty cache ≠ clean' guidance",
	},
	"clients/runtime-tool-result.ts": {
		lines: 1,
		reason: "a git linked-worktree record kind",
	},
	"clients/runtime-turn.ts": {
		lines: 11,
		reason:
			"'does not cover' and 'NOT recorded as a clean run' disclosures, a debug reason, a generation label and a type",
	},
	"clients/shared-checkout-guard.ts": {
		lines: 4,
		reason: "the git clean verb and working-tree state",
	},
	"clients/source-filter.ts": {
		lines: 1,
		reason: "a file-filter classification, not a check",
	},
	"clients/tool-render.ts": { lines: 1, reason: "a tool-call success glyph" },
	"clients/widget-state.ts": {
		lines: 3,
		reason: "the tier type and comparisons",
	},
	"index.ts": { lines: 7, reason: "connection and installed-tool glyphs" },
	"mcp/analyze-cli.ts": {
		lines: 1,
		reason: "a 'not a clean result' disclosure",
	},
	"mcp/server.ts": {
		lines: 5,
		reason: "selection, connection and rebuild glyphs and a refusal text",
	},
	"tools/lens-diagnostics.ts": {
		lines: 17,
		reason:
			"'not proof of clean' guidance and 'NOT a clean verdict' disclosures",
	},
	"tools/lsp-diagnostics.ts": {
		lines: 21,
		reason:
			"types, comparisons, the outcome key list and 'cannot confirm clean' disclosures",
	},
	"tools/lsp-navigation.ts": { lines: 2, reason: "capability-support glyphs" },
};

/** `own` rows may only fall; lower this as a row moves onto a producer. */
const OWN_CLEAN_EMITTER_CEILING = 27;

/** 1-based lines of `source` holding a clean needle in code text or by value. */
function scanCleanClaims(rel: string, source: string): MarkerScan {
	const kept = stripSource(source, { strings: "keep" });
	const blanked = stripSource(source);
	let text = "";
	for (let i = 0; i < kept.length; i++) {
		const ch = kept[i] ?? "";
		if (ch === "\n" || ch !== blanked[i] || ch === " " || ch === "\t")
			text += ch; // string, template or regex text, or whitespace
		else if (ch === '"' || ch === "'" || ch === "`") text += "\0";
		else if (ch === "+") text += "\x02";
		else text += "\x01"; // code
	}
	const glyphs = scanMarkers(rel, source, CLEAN_GLYPHS);
	const lines = new Set(glyphs.markerLines);
	text.split("\n").forEach((line, index) => {
		const decoded = line
			.replace(/\0[ \t]*\x02[ \t]*\0/g, "")
			.replace(TEXT_ESCAPE, (_match, braced, four, two) => {
				const codePoint = Number.parseInt(braced ?? four ?? two, 16);
				return codePoint > 0x10ffff ? " " : String.fromCodePoint(codePoint);
			})
			.replace(/[\0\x01\x02]/g, " ");
		if (
			CLEAN_GLYPHS.some((glyph) => decoded.includes(glyph)) ||
			CLEAN_WORDS.test(decoded)
		)
			lines.add(index + 1);
	});
	return {
		markerLines: [...lines].sort((a, b) => a - b),
		unclassified: glyphs.unclassified,
	};
}

function cleanScanSources(): { rel: string; source: string }[] {
	const files = [
		...CLEAN_SCAN_ROOTS.flatMap((root) =>
			collectSourceFiles(path.join(REPO_ROOT, root)),
		),
		...CLEAN_SCAN_FILES.map((file) => path.join(REPO_ROOT, file)),
	];
	return files.map((full) => ({
		rel: path.relative(REPO_ROOT, full).split(path.sep).join("/"),
		source: fs.readFileSync(full, "utf8"),
	}));
}

interface CleanCensus {
	/** Every hit as `<file>: <trimmed line>`. */
	hits: string[];
	/** Hits outside CLEAN_EMITTERS, counted per file. */
	others: Map<string, number>;
	/** Unevaluable code-point spellings outside clients/ (covered above). */
	unclassified: string[];
	/** File sources by repo-relative path. */
	sources: Map<string, string>;
}

function cleanCensus(): CleanCensus {
	const census: CleanCensus = {
		hits: [],
		others: new Map(),
		unclassified: [],
		sources: new Map(),
	};
	for (const { rel, source } of cleanScanSources()) {
		census.sources.set(rel, source);
		const scan = scanCleanClaims(rel, source);
		if (!rel.startsWith("clients/"))
			census.unclassified.push(...scan.unclassified);
		const lines = source.split("\n");
		for (const line of scan.markerLines) {
			const key = `${rel}: ${lines[line - 1]?.trim() ?? ""}`;
			census.hits.push(key);
			if (!Object.hasOwn(CLEAN_EMITTERS, key))
				census.others.set(rel, (census.others.get(rel) ?? 0) + 1);
		}
	}
	return census;
}

describe("clean-claim registry (#5258)", () => {
	it(
		"every clean-needle line is a registered emitter or a counted non-claim",
		() => {
			// Recurrence: #5258, a "✓ No issues" line and a "clean" header that
			// rendered over files no check had covered. A new needle line reds
			// here until its producer or its non-claim reason is written down.
			const census = cleanCensus();
			const counted = Object.fromEntries(census.others);
			const declared = Object.fromEntries(
				Object.entries(NOT_A_CLEAN_CLAIM).map(([file, row]) => [
					file,
					row.lines,
				]),
			);
			expect(counted).toEqual(declared);
			expect(census.unclassified).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every emitter row still names a live line (no stale rows)",
		() => {
			const census = cleanCensus();
			expect(
				Object.entries(CLEAN_EMITTERS)
					.filter(
						([key, row]) =>
							census.hits.filter((hit) => hit === key).length !==
							(row.lines ?? 1),
					)
					.map(([key]) => key),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"a producer row's file calls that producer; own rows only fall",
		() => {
			// Recurrence: a row relabelled to a producer the file never calls
			// would hide a local clean decision behind the registry.
			const census = cleanCensus();
			const missing: string[] = [];
			let own = 0;
			for (const [key, row] of Object.entries(CLEAN_EMITTERS)) {
				expect(row.proof.trim(), key).not.toBe("");
				if (row.producer === "own") {
					own += row.lines ?? 1;
					continue;
				}
				const file = key.slice(0, key.indexOf(": "));
				const code = stripSource(census.sources.get(file) ?? "");
				if (!PRODUCER_CALL[row.producer].test(code))
					missing.push(`${key} (${row.producer})`);
			}
			expect(missing).toEqual([]);
			expect(own, "lower OWN_CLEAN_EMITTER_CEILING with the row").toBe(
				OWN_CLEAN_EMITTER_CEILING,
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("reads a clean needle through every planted spelling (#5258)", () => {
		// The detector state table's plants: each spelling a claim could hide
		// behind, and the comment and identifier forms that must not count.
		const source = [
			'const OK = "clean";',
			"const tick = String.fromCodePoint(0x2713);",
			'const escaped = "\\u0063lean";',
			'const joined = "cl" + "ean";',
			"const heavy = `\\u{2714} ${n} files`;",
			'const none = "No issues found";',
			"// clean ✓ no issues in a comment",
			"const isClean = cleanFiles > 0;",
			'const word = "cleanup-dir";',
			"const built = String.fromCodePoint(base + 1);",
		].join("\n");
		expect(scanCleanClaims("fake.ts", source)).toEqual({
			markerLines: [1, 2, 3, 4, 5, 6],
			unclassified: ["fake.ts: const built = String.fromCodePoint(base + 1);"],
		});
	});
});

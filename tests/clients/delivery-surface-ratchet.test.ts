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

/** Classify every marker spelling in one clients/ source. */
function scanMarkers(rel: string, source: string): MarkerScan {
	const kept = stripSource(source, { strings: "keep" });
	const blanked = stripSource(source);
	const lines = source.split("\n");
	const lineAt = (index: number) => source.slice(0, index).split("\n").length;
	const scan: MarkerScan = { markerLines: [], unclassified: [] };
	const classify = (index: number, value: string | undefined) => {
		const line = lineAt(index);
		if (value === undefined || isSurrogate(value)) {
			scan.unclassified.push(`${rel}: ${lines[line - 1]?.trim() ?? ""}`);
		} else if (MARKERS.some((marker) => value.includes(marker))) {
			scan.markerLines.push(line);
		}
	};
	for (const marker of MARKERS) {
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

#!/usr/bin/env node
/**
 * Measure the `symbol_search` query surface over recorded pi session JSONL
 * (issue #5138, D8). The instrument is read-only: it walks a corpus of session
 * transcripts, discovers every `symbol_search` call, classifies the rendered
 * result, and reports five rates per time window.
 *
 * Usage:
 *   node scripts/symbol-search-query-metrics.mjs [corpusPath]
 *        [--since <ISO-8601>] [--until <ISO-8601>] [--json] [--help]
 *
 * corpusPath defaults to `~/.pi/agent/sessions` and may be a session `.jsonl`
 * file or a directory walked recursively. With neither `--since` nor `--until`
 * the report prints five named windows (all time, before the D9 patch, the
 * #5136 bracket, after #5136, and today). With either bound it prints the one
 * window those bounds name.
 * Bounds are inclusive on both ends, so an instant exactly on a boundary
 * belongs to every window it bounds.
 *
 * Exit codes: 0 report printed, 1 corpus or runtime failure (a missing or
 * empty corpus included), 2 usage error.
 *
 * A discovered call is `scanned` when its arguments are statically readable
 * (a native `symbol_search` / `pilens_symbol_search` call, or a `codemode`
 * call whose script passes a literal object to `tools.symbol_search(`), and
 * `unscannable` otherwise. `unscannable` calls are counted, excluded from the
 * other denominators, and always printed.
 * A file whose first row carries no `type` is the subagent-artifacts envelope,
 * not a session; the walk skips it on purpose, so its `symbol_search` traffic
 * stays outside the population.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "./lib/is-main-module.mjs";

export const DEFAULT_CORPUS = path.join(
	os.homedir(),
	".pi",
	"agent",
	"sessions",
);

/** Session rows before the D9 patch (#5138 plan, `f040f813b`). */
const D9_PATCH_BOUNDARY = "2026-11-04T22:13:00Z";
/** Session rows after #5136 (`bb8d40627`) merged. */
const EXT_SUFFIX_BOUNDARY = "2026-11-04T22:38:00Z";

const SYMBOL_SEARCH_NAMES = new Set(["symbol_search", "pilens_symbol_search"]);
const CODEMODE_CALL = /tools\s*\.\s*symbol_search\s*\(/g;
const INLINE_FILTER = /(^|\s)-?(?:file|ext|lang):/;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const FOLLOW_UP_WINDOW = 3;
const WHOLE_FILE_VIEWERS = new Set(["cat", "bat", "less", "more", "nl"]);
const HEAD_TAIL_VIEWERS = new Set(["head", "tail"]);
const SHELL_SEPARATOR = /\s*(?:&&|\|\||;|\||&)\s*/;

const USAGE = `Usage: node scripts/symbol-search-query-metrics.mjs [corpusPath] [--since <ISO-8601>] [--until <ISO-8601>] [--json]

  corpusPath  session JSONL file or directory (default: ~/.pi/agent/sessions)
  --since     count only rows at or after this instant
  --until     count only rows at or before this instant
  --json      print only the machine-readable report
  --help      print this usage

With neither --since nor --until the report prints five named windows.`;

class UsageError extends Error {}
/** The corpus cannot answer: missing or holding no session files. Exit 1. */
class CorpusError extends Error {}

/**
 * The five windows a bare run prints, so a PR body can quote them without a
 * second run. `now` pins the start-of-day boundary for the `today` window.
 */
export function defaultWindows(now = new Date()) {
	const startOfToday = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	).toISOString();
	return [
		{ label: "all", since: null, until: null },
		{
			label: `until-${D9_PATCH_BOUNDARY}`,
			since: null,
			until: D9_PATCH_BOUNDARY,
		},
		{
			label: `${D9_PATCH_BOUNDARY}..${EXT_SUFFIX_BOUNDARY}`,
			since: D9_PATCH_BOUNDARY,
			until: EXT_SUFFIX_BOUNDARY,
		},
		{
			label: `since-${EXT_SUFFIX_BOUNDARY}`,
			since: EXT_SUFFIX_BOUNDARY,
			until: null,
		},
		{ label: "today", since: startOfToday, until: null },
	];
}

function requireValue(argv, index, flag) {
	const value = argv[index];
	if (value === undefined || value.startsWith("--")) {
		throw new UsageError(`${flag} needs an ISO-8601 value`);
	}
	return value;
}

function validateInstant(value, flag) {
	if (Number.isNaN(Date.parse(value))) {
		throw new UsageError(`${flag} is not an ISO-8601 instant: ${value}`);
	}
	return value;
}

export function parseArgs(argv) {
	const out = {
		corpus: undefined,
		since: undefined,
		until: undefined,
		json: false,
		help: false,
	};
	const positional = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") out.help = true;
		else if (arg === "--json") out.json = true;
		else if (arg === "--since")
			out.since = validateInstant(
				requireValue(argv, ++index, "--since"),
				"--since",
			);
		else if (arg === "--until")
			out.until = validateInstant(
				requireValue(argv, ++index, "--until"),
				"--until",
			);
		else if (arg.startsWith("-"))
			throw new UsageError(`unknown option: ${arg}`);
		else positional.push(arg);
	}
	if (positional.length > 1) {
		throw new UsageError("at most one corpus path is accepted");
	}
	out.corpus = positional[0];
	return out;
}

// ---------------------------------------------------------------------------
// Static argument reading for codemode scripts.
// ---------------------------------------------------------------------------

function skipTrivia(state) {
	const { source } = state;
	while (state.index < source.length) {
		const ch = source[state.index];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			state.index++;
			continue;
		}
		if (ch === "/" && source[state.index + 1] === "/") {
			state.index += 2;
			while (state.index < source.length && source[state.index] !== "\n") {
				state.index++;
			}
			continue;
		}
		if (ch === "/" && source[state.index + 1] === "*") {
			state.index += 2;
			while (
				state.index < source.length &&
				!(source[state.index] === "*" && source[state.index + 1] === "/")
			) {
				state.index++;
			}
			state.index += 2;
			continue;
		}
		break;
	}
}

function parseStringLiteral(state) {
	const quote = state.source[state.index];
	state.index++;
	let out = "";
	while (state.index < state.source.length) {
		const ch = state.source[state.index];
		if (ch === "\\") {
			const next = state.source[state.index + 1];
			state.index += 2;
			if (next === "n") out += "\n";
			else if (next === "t") out += "\t";
			else if (next === "r") out += "\r";
			else if (next === "b") out += "\b";
			else if (next === "f") out += "\f";
			else if (next === "v") out += "\v";
			else if (next === "0") out += "\0";
			else if (next === "u") {
				const hex = state.source.slice(state.index, state.index + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
					throw new Error("bad \\u escape");
				}
				out += String.fromCharCode(Number.parseInt(hex, 16));
				state.index += 4;
			} else if (next === "x") {
				const hex = state.source.slice(state.index, state.index + 2);
				if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
					throw new Error("bad \\x escape");
				}
				out += String.fromCharCode(Number.parseInt(hex, 16));
				state.index += 2;
			} else {
				out += next ?? "";
			}
			continue;
		}
		if (ch === quote) {
			state.index++;
			return out;
		}
		if (quote === "`" && ch === "$" && state.source[state.index + 1] === "{") {
			throw new Error("template interpolation is not a static literal");
		}
		out += ch;
		state.index++;
	}
	throw new Error("unterminated string");
}

function parseNumberLiteral(state) {
	const start = state.index;
	if (state.source[state.index] === "-" || state.source[state.index] === "+") {
		state.index++;
	}
	while (
		state.index < state.source.length &&
		/[0-9.eE+-]/.test(state.source[state.index])
	) {
		state.index++;
	}
	const value = Number(state.source.slice(start, state.index));
	if (!Number.isFinite(value)) throw new Error("bad number");
	return value;
}

function parseValue(state) {
	skipTrivia(state);
	const ch = state.source[state.index];
	if (ch === undefined) throw new Error("unexpected end of source");
	if (ch === "{") return parseObjectLiteral(state);
	if (ch === "[") return parseArrayLiteral(state);
	if (ch === '"' || ch === "'" || ch === "`") return parseStringLiteral(state);
	if (ch === "-" || ch === "+" || (ch >= "0" && ch <= "9")) {
		return parseNumberLiteral(state);
	}
	IDENTIFIER.lastIndex = state.index;
	const match = IDENTIFIER.exec(state.source);
	if (match && match.index === state.index) {
		const word = match[0];
		state.index += word.length;
		if (word === "true") return true;
		if (word === "false") return false;
		if (word === "null") return null;
		throw new Error(`non-literal value: ${word}`);
	}
	throw new Error(`unexpected character: ${ch}`);
}

function parseObjectLiteral(state) {
	state.index++;
	skipTrivia(state);
	const out = {};
	if (state.source[state.index] === "}") {
		state.index++;
		return out;
	}
	for (;;) {
		skipTrivia(state);
		let key;
		const ch = state.source[state.index];
		if (ch === '"' || ch === "'" || ch === "`") {
			key = parseStringLiteral(state);
		} else {
			IDENTIFIER.lastIndex = state.index;
			const match = IDENTIFIER.exec(state.source);
			if (!match || match.index !== state.index) {
				throw new Error("object key is not static");
			}
			key = match[0];
			state.index += key.length;
		}
		skipTrivia(state);
		if (state.source[state.index] !== ":") throw new Error("expected :");
		state.index++;
		skipTrivia(state);
		out[key] = parseValue(state);
		skipTrivia(state);
		const separator = state.source[state.index];
		if (separator === ",") {
			state.index++;
			skipTrivia(state);
			if (state.source[state.index] === "}") {
				state.index++;
				return out;
			}
			continue;
		}
		if (separator === "}") {
			state.index++;
			return out;
		}
		throw new Error("expected , or }");
	}
}

function parseArrayLiteral(state) {
	state.index++;
	skipTrivia(state);
	const out = [];
	if (state.source[state.index] === "]") {
		state.index++;
		return out;
	}
	for (;;) {
		out.push(parseValue(state));
		skipTrivia(state);
		const separator = state.source[state.index];
		if (separator === ",") {
			state.index++;
			skipTrivia(state);
			if (state.source[state.index] === "]") {
				state.index++;
				return out;
			}
			continue;
		}
		if (separator === "]") {
			state.index++;
			return out;
		}
		throw new Error("expected , or ]");
	}
}

/**
 * Parse a JS object literal that carries only static values. Returns the
 * object, or `undefined` when the source is not such a literal (a variable, a
 * function call, a template interpolation). This is the `statically readable
 * argument JSON` seam for codemode calls; it never evaluates source.
 */
export function extractStaticObject(source) {
	try {
		const state = { source: String(source), index: 0 };
		skipTrivia(state);
		if (state.source[state.index] !== "{") return undefined;
		const value = parseValue(state);
		skipTrivia(state);
		if (state.index !== state.source.length) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

/** The source text of the first argument of the call opening at `openIndex`. */
function firstArgumentSource(source, openIndex) {
	let depth = 0;
	let quote = null;
	for (let index = openIndex; index < source.length; index++) {
		const ch = source[index];
		if (quote) {
			if (ch === "\\") {
				index++;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) return source.slice(openIndex + 1, index);
			continue;
		}
		if (ch === "," && depth === 1) {
			return source.slice(openIndex + 1, index);
		}
	}
	return undefined;
}

/**
 * A same-length copy of `source` with comment bodies and string/template
 * literal bodies replaced by spaces, so a `tools.symbol_search(` spelling that
 * appears only in a comment or a string is never read as a call. Escapes keep
 * their two-character width and newlines are preserved, so every index in the
 * copy addresses the same character of the original.
 */
function codeOnlySource(source) {
	const text = String(source);
	let out = "";
	let index = 0;
	while (index < text.length) {
		const ch = text[index];
		if (ch === "/" && text[index + 1] === "/") {
			while (index < text.length && text[index] !== "\n") {
				out += " ";
				index++;
			}
			continue;
		}
		if (ch === "/" && text[index + 1] === "*") {
			out += "  ";
			index += 2;
			while (
				index < text.length &&
				!(text[index] === "*" && text[index + 1] === "/")
			) {
				out += text[index] === "\n" ? "\n" : " ";
				index++;
			}
			if (index < text.length) {
				out += "  ";
				index += 2;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			out += " ";
			index++;
			while (index < text.length) {
				const inner = text[index];
				if (inner === "\\") {
					out += "  ";
					index += 2;
					continue;
				}
				out += inner === "\n" ? "\n" : " ";
				index++;
				if (inner === ch) break;
			}
			continue;
		}
		out += ch;
		index++;
	}
	return out;
}

/**
 * Every `tools.symbol_search(...)` call in a codemode script, each reduced to
 * its static arguments or to `{ unscannable: true }` when the first argument
 * is not a static object literal.
 */
export function findCodemodeSymbolSearchArgs(script) {
	const text = String(script ?? "");
	const code = codeOnlySource(text);
	const found = [];
	CODEMODE_CALL.lastIndex = 0;
	let match;
	while ((match = CODEMODE_CALL.exec(code))) {
		const openIndex = match.index + match[0].length - 1;
		const argument = firstArgumentSource(text, openIndex);
		if (argument === undefined) {
			found.push({ unscannable: true });
			continue;
		}
		if (argument.trim() === "") {
			found.push({ unscannable: false, args: {} });
			continue;
		}
		const args = extractStaticObject(argument);
		if (
			args === undefined ||
			args === null ||
			typeof args !== "object" ||
			Array.isArray(args)
		) {
			found.push({ unscannable: true });
		} else {
			found.push({ unscannable: false, args });
		}
	}
	return found;
}

// ---------------------------------------------------------------------------
// Result classification and path extraction.
// ---------------------------------------------------------------------------

/** `listing`, `empty`, `error`, or `unknown` for one rendered result. */
export function classifyResult(text, isError = false) {
	const value = String(text ?? "");
	if (
		/Top \d+ file\(s\) for/.test(value) ||
		/^\s*\d+\.\s+.*\(score [\d.]+/m.test(value)
	) {
		return "listing";
	}
	if (/No files matched/.test(value)) return "empty";
	if (
		isError ||
		/Word index is building|unavailableReason|result error/.test(value)
	) {
		return "error";
	}
	return "unknown";
}

/** The paths a listing rendered, from its JSON line or its numbered rows. */
export function extractListedPaths(text) {
	const value = String(text ?? "");
	const paths = [];
	for (const line of value.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{"available"')) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed?.results)) {
				for (const row of parsed.results) {
					if (typeof row?.file === "string") paths.push(row.file);
				}
			}
		} catch {
			// A malformed JSON line still falls back to the numbered-row shape.
		}
	}
	if (paths.length > 0) return [...new Set(paths)];
	// `path line (score ...)` (#5104), and the older `path (score ..., line N)`.
	const rowPattern = /^\s*\d+\.\s+(.+?)(?:\s+\d+)?\s+\(score /gm;
	let match;
	while ((match = rowPattern.exec(value))) paths.push(match[1].trim());
	return [...new Set(paths)];
}

function normalizePathSpelling(spelling, cwd) {
	const normalized = String(spelling).replace(/\\/g, "/").replace(/^\.\//, "");
	if (path.isAbsolute(normalized)) return normalized;
	const base = typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
	return path.resolve(base, normalized).replace(/\\/g, "/");
}

function pathsMatch(a, b, cwd) {
	const left = normalizePathSpelling(a, cwd);
	const right = normalizePathSpelling(b, cwd);
	if (left === right) return true;
	return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function splitShellSegments(command) {
	return String(command)
		.split(SHELL_SEPARATOR)
		.filter((segment) => segment.trim() !== "");
}

function tokenizeShell(segment) {
	const tokens = [];
	let current = "";
	let quote = null;
	for (let index = 0; index < segment.length; index++) {
		const ch = segment[index];
		if (quote) {
			if (ch === "\\") {
				current += segment[index + 1] ?? "";
				index++;
				continue;
			}
			if (ch === quote) {
				quote = null;
				continue;
			}
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (current !== "") {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current !== "") tokens.push(current);
	return tokens;
}

/**
 * The paths a bash command reads as a file view (`cat`/`bat`/`less`/`more`/
 * `nl`, `head`/`tail`, and a non-in-place ranged `sed`). A search such as
 * `grep`/`rg`/`find` reads no contiguous content and is not a view.
 */
export function bashViewPaths(command) {
	const paths = [];
	for (const segment of splitShellSegments(command)) {
		const tokens = tokenizeShell(segment);
		let start = 0;
		while (
			start < tokens.length &&
			/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])
		) {
			start++;
		}
		const verb = tokens[start];
		const rest = tokens.slice(start + 1);
		if (verb === undefined) continue;
		if (verb === "sed") {
			const inPlace = rest.some(
				(token) => token === "-i" || /^-[a-zA-Z]*i/.test(token),
			);
			const quiet = rest.some((token) => /^-[a-zA-Z]*n/.test(token));
			const range = rest.some((token) => /^\d+,\d+p$/.test(token));
			if (inPlace || !quiet || !range) continue;
			const operands = rest.filter(
				(token) => !token.startsWith("-") && !/^\d+,\d+p$/.test(token),
			);
			if (operands.length > 0) paths.push(operands.at(-1));
			continue;
		}
		if (!WHOLE_FILE_VIEWERS.has(verb) && !HEAD_TAIL_VIEWERS.has(verb)) {
			continue;
		}
		for (const token of rest) {
			if (token.startsWith("-")) continue;
			if (HEAD_TAIL_VIEWERS.has(verb) && /^\d+$/.test(token)) continue;
			paths.push(token);
		}
	}
	return paths;
}

// ---------------------------------------------------------------------------
// Corpus reading and call discovery.
// ---------------------------------------------------------------------------

function collectJsonlFiles(corpusPath) {
	if (!fs.existsSync(corpusPath)) {
		throw new CorpusError(
			`corpus path does not exist: ${corpusPath} (0 files read)`,
		);
	}
	const stat = fs.statSync(corpusPath);
	if (stat.isFile()) return [corpusPath];
	const files = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(full);
			}
		}
	};
	walk(corpusPath);
	return files.sort();
}

/**
 * Read one session transcript file. A file whose first row carries no `type`
 * is the subagent-artifacts envelope, not a session, and is skipped.
 * Unparseable lines are counted, never thrown.
 */
function readTranscriptRows(file) {
	const rows = [];
	const parseErrors = [];
	let lineNumber = 0;
	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		lineNumber++;
		if (line.trim() === "") continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			parseErrors.push({ file, line: lineNumber });
		}
	}
	if (rows.length === 0 || typeof rows[0]?.type !== "string") {
		return { rows: [], parseErrors };
	}
	return { rows, parseErrors };
}
function inWindow(row, sinceMs, untilMs) {
	if (sinceMs === null && untilMs === null) return true;
	const stamp = Date.parse(row?.timestamp);
	if (Number.isNaN(stamp)) return false;
	if (sinceMs !== null && stamp < sinceMs) return false;
	if (untilMs !== null && stamp > untilMs) return false;
	return true;
}

function orderedToolCalls(rows) {
	const calls = [];
	for (const row of rows) {
		if (row?.type !== "message") continue;
		const message = row.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			if (part?.type !== "toolCall") continue;
			calls.push({
				id: part.id,
				name: part.name,
				args: part.arguments ?? {},
				timestamp: row.timestamp,
			});
		}
	}
	return calls;
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.join("\n");
}

function toolResultsById(rows) {
	const results = new Map();
	for (const row of rows) {
		if (row?.type !== "message") continue;
		const message = row.message;
		if (message?.role !== "toolResult") continue;
		if (typeof message.toolCallId !== "string") continue;
		results.set(message.toolCallId, {
			toolName: message.toolName,
			text: contentText(message.content),
			isError: message.isError === true,
		});
	}
	return results;
}

function discoverCalls(calls) {
	const discovered = [];
	for (let index = 0; index < calls.length; index++) {
		const call = calls[index];
		if (SYMBOL_SEARCH_NAMES.has(call.name)) {
			discovered.push({
				call,
				index,
				args: call.args,
				unscannable: false,
			});
			continue;
		}
		if (call.name !== "codemode") continue;
		if (typeof call.args?.code !== "string") continue;
		const occurrences = findCodemodeSymbolSearchArgs(call.args.code);
		if (occurrences.length === 0) continue;
		// One result blob cannot be split across queries, so a script that
		// issues several `tools.symbol_search(` calls counts once, and the
		// first statically readable argument object decides its scope.
		const first = occurrences.find((entry) => !entry.unscannable);
		discovered.push({
			call,
			index,
			args: first?.args ?? null,
			unscannable: occurrences.some((entry) => entry.unscannable),
		});
	}
	return discovered;
}

function isScoped(args) {
	if (args === null || typeof args !== "object") return false;
	if (typeof args.query === "string" && INLINE_FILTER.test(args.query)) {
		return true;
	}
	if (Array.isArray(args.paths) && args.paths.length > 0) return true;
	if (typeof args.lang === "string" && args.lang.trim() !== "") return true;
	return false;
}

function readCallPaths(call) {
	const args = call.args ?? {};
	if (call.name === "read") {
		const candidate = args.file ?? args.path;
		return typeof candidate === "string" ? [candidate] : [];
	}
	if (call.name === "read_symbol" || call.name === "read_enclosing") {
		return typeof args.path === "string" ? [args.path] : [];
	}
	if (call.name === "bash") {
		return typeof args.command === "string" ? bashViewPaths(args.command) : [];
	}
	return [];
}

function emptyTotals() {
	return {
		discovered: 0,
		unscannable: 0,
		unpaired: 0,
		listing: 0,
		empty: 0,
		error: 0,
		unknown: 0,
		scopedClassified: 0,
		scopedEmpty: 0,
		listingTotal: 0,
		listedRead: 0,
		repeatRead: 0,
		drilldown: 0,
	};
}

function analyzeTranscript(rows, sinceMs, untilMs) {
	const totals = emptyTotals();
	const session = rows.find((row) => row?.type === "session");
	const cwd = typeof session?.cwd === "string" ? session.cwd : undefined;
	const windowRows = rows.filter(
		(row) => row?.type !== "message" || inWindow(row, sinceMs, untilMs),
	);
	const calls = orderedToolCalls(windowRows);
	const results = toolResultsById(windowRows);
	// A call is a repeat read when it reads a path an earlier call in this
	// session window already read (exact resolved path, no suffix matching).
	const readBefore = new Set();
	const isRepeatRead = calls.map((call) => {
		let repeat = false;
		for (const readPath of readCallPaths(call)) {
			const key = normalizePathSpelling(readPath, cwd);
			if (readBefore.has(key)) repeat = true;
			readBefore.add(key);
		}
		return repeat;
	});
	for (const entry of discoverCalls(calls)) {
		totals.discovered++;
		if (entry.unscannable) {
			totals.unscannable++;
			continue;
		}
		const result = results.get(entry.call.id);
		if (result === undefined) {
			totals.unpaired++;
			continue;
		}
		const classification = classifyResult(result.text, result.isError);
		totals[classification]++;
		if (
			(classification === "listing" || classification === "empty") &&
			isScoped(entry.args)
		) {
			totals.scopedClassified++;
			if (classification === "empty") totals.scopedEmpty++;
		}
		if (classification !== "listing") continue;
		totals.listingTotal++;
		const listed = extractListedPaths(result.text);
		const followUps = calls.slice(
			entry.index + 1,
			entry.index + 1 + FOLLOW_UP_WINDOW,
		);
		const listedRead = followUps.some((call) =>
			readCallPaths(call).some((readPath) =>
				listed.some((listedPath) => pathsMatch(readPath, listedPath, cwd)),
			),
		);
		if (listedRead) totals.listedRead++;
		const followUpStart = entry.index + 1;
		if (
			isRepeatRead
				.slice(followUpStart, followUpStart + FOLLOW_UP_WINDOW)
				.some(Boolean)
		) {
			totals.repeatRead++;
		}
		if (
			followUps.some(
				(call) =>
					call.name === "module_report" || call.name === "lsp_navigation",
			)
		) {
			totals.drilldown++;
		}
	}
	return totals;
}

function makeRate(numerator, denominator, discovered) {
	return {
		numerator,
		denominator,
		excluded: Math.max(0, discovered - denominator),
		rate: denominator === 0 ? null : numerator / denominator,
	};
}

function summarizeWindow(window, totals, parseErrors) {
	const scanned = totals.discovered - totals.unscannable;
	return {
		label: window.label,
		since: window.since ?? null,
		until: window.until ?? null,
		calls: {
			discovered: totals.discovered,
			scanned,
			unscannable: totals.unscannable,
			unpaired: totals.unpaired,
			paired: scanned - totals.unpaired,
		},
		results: {
			listing: totals.listing,
			empty: totals.empty,
			error: totals.error,
			unknown: totals.unknown,
		},
		emptyRate: makeRate(
			totals.scopedEmpty,
			totals.scopedClassified,
			totals.discovered,
		),
		listedReadRate: makeRate(
			totals.listedRead,
			totals.listingTotal,
			totals.discovered,
		),
		repeatReadRate: makeRate(
			totals.repeatRead,
			totals.listingTotal,
			totals.discovered,
		),
		drilldownRate: makeRate(
			totals.drilldown,
			totals.listingTotal,
			totals.discovered,
		),
		unscannableRate: makeRate(
			totals.unscannable,
			totals.discovered,
			totals.discovered,
		),
		parseErrors,
	};
}

export function buildReport(corpusPath, windows) {
	const bounds = windows.map((window) => ({
		sinceMs: window.since ? Date.parse(window.since) : null,
		untilMs: window.until ? Date.parse(window.until) : null,
	}));
	const totals = windows.map(() => emptyTotals());
	let parseErrorCount = 0;
	const files = collectJsonlFiles(corpusPath);
	if (files.length === 0) {
		throw new CorpusError(
			`no session files under ${corpusPath} (0 files read)`,
		);
	}
	let skipped = 0;
	for (const file of files) {
		const read = readTranscriptRows(file);
		parseErrorCount += read.parseErrors.length;
		if (read.rows.length === 0) {
			skipped++;
			continue;
		}
		for (let index = 0; index < windows.length; index++) {
			const counts = analyzeTranscript(
				read.rows,
				bounds[index].sinceMs,
				bounds[index].untilMs,
			);
			for (const key of Object.keys(totals[index])) {
				totals[index][key] += counts[key];
			}
		}
	}
	return {
		corpus: corpusPath,
		generatedAt: new Date().toISOString(),
		parseErrors: parseErrorCount,
		files: { read: files.length, skipped },
		windows: windows.map((window, index) =>
			summarizeWindow(window, totals[index], parseErrorCount),
		),
	};
}

function rateText(rate) {
	const value = rate.rate === null ? "n/a" : rate.rate.toFixed(3);
	return `${rate.numerator}/${rate.denominator}(excluded=${rate.excluded}) ${value}`;
}

const RATE_DEFINITIONS = [
	"emptyRate = scoped searches (inline file:/ext:/lang:, paths or lang argument) that matched no file / scoped searches that listed or came back empty; errors are not in it",
	"listedReadRate = listings followed within 3 tool calls by a read (read, read_symbol, read_enclosing, or a bash cat/head/tail/sed -n view) of a listed file / listings",
	"repeatReadRate = listings followed within 3 tool calls by a read of a file the session had already read (a second read) / listings",
	"drilldownRate = listings followed within 3 tool calls by module_report or lsp_navigation / listings",
	"unscannableRate = codemode calls whose symbol_search arguments are not a static literal / discovered calls",
	"n/a = the denominator is 0 (no rate); excluded = discovered calls outside the denominator",
];

export function formatSummary(report) {
	const lines = [
		`symbol_search query metrics — corpus ${report.corpus} — ${report.files.read} file(s) read, ${report.files.skipped} skipped (no session rows) — ${report.windows.length} window(s)`,
		...RATE_DEFINITIONS.map((line) => `  ${line}`),
	];
	for (const window of report.windows) {
		lines.push(
			`window ${window.label} since=${window.since ?? "-"} until=${window.until ?? "-"}: ` +
				`discovered=${window.calls.discovered} scanned=${window.calls.scanned} ` +
				`unscannable=${window.calls.unscannable} unpaired=${window.calls.unpaired} ` +
				`listing=${window.results.listing} empty=${window.results.empty} ` +
				`error=${window.results.error} unknown=${window.results.unknown} ` +
				`emptyRate=${rateText(window.emptyRate)} ` +
				`listedReadRate=${rateText(window.listedReadRate)} ` +
				`repeatReadRate=${rateText(window.repeatReadRate)} ` +
				`drilldownRate=${rateText(window.drilldownRate)} ` +
				`unscannableRate=${rateText(window.unscannableRate)}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const corpus = args.corpus ?? DEFAULT_CORPUS;
	const windows =
		args.since || args.until
			? [
					{
						label: `${args.since ?? "-"}..${args.until ?? "-"}`,
						since: args.since ?? null,
						until: args.until ?? null,
					},
				]
			: defaultWindows();
	let report;
	try {
		report = buildReport(corpus, windows);
	} catch (error) {
		if (!(error instanceof CorpusError)) throw error;
		process.stderr.write(`${error.message}\n`);
		return 1;
	}
	if (args.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		process.stdout.write(formatSummary(report));
		process.stdout.write(`\n${JSON.stringify(report)}\n`);
	}
	return 0;
}

if (isMainModule(import.meta.url)) {
	try {
		process.exitCode = main();
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n\n${USAGE}\n`);
			process.exitCode = 2;
		} else {
			process.stderr.write(
				`symbol-search query metrics failed: ${error instanceof Error ? error.message : error}\n`,
			);
			process.exitCode = 1;
		}
	}
}

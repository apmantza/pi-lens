/**
 * Parse bash commands for the file access the agent performed, so the read-guard
 * stays consistent with how the Read/Write tools are tracked:
 *
 *   - VIEW commands (cat/head/tail/sed -n) → reads, recorded with the exact line
 *     range shown (like the Read tool's delivered range).
 *   - WRITE commands (redirects, tee, sed -i, cp/mv dest, touch, and explicit
 *     in-place formatter/fixer targets) → the agent
 *     authored/owns the resulting file, exactly like the Write tool — these are
 *     registered via noteCreatedFile + recordWritten so a follow-up edit is not
 *     blocked.
 *
 * NOT treated as reads: grep (scattered matches, not a contiguous view), find
 * and ls (names only, no content), and bare path mentions in arbitrary commands.
 * Treating those as reads would let an edit through for content never shown.
 */
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { isReadableSourceFile } from "./file-kinds.js";
import { classifyMutatingTool } from "./mutating-tool.js";
import { countFileLines } from "./read-guard-tool-lines.js";
import type { SearchReadLocation } from "./search-read-registration.js";
import { stripAnsi } from "./sanitize.js";

/** A contiguous range of lines a bash command showed the agent. */
export interface ReadSpan {
	filePath: string;
	/** 1-based first line read. */
	offset: number;
	/** Number of lines read. */
	limit: number;
}

function stripQuotes(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
			return token.slice(1, -1);
		}
	}
	return token;
}

/** Small conservative shell lexer shared by command-analysis consumers. */
export interface ShellCommandSegment {
	tokens: string[];
	unsupported: boolean;
	/**
	 * Set to "pipe" when this segment's output feeds the NEXT segment via an
	 * unquoted `|` (used by #1908 to detect a truncating pipe tail after
	 * grep). Undefined for every other terminator (`;`, `&&`, `||`, `&`, EOF)
	 * — those consumers don't need it and adding cases here is a no-op for
	 * them.
	 */
	terminator?: "pipe";
}

interface PendingHeredoc {
	delimiter: string;
	stripTabs: boolean;
	quoted: boolean;
}

function parseHeredocDelimiter(
	command: string,
	start: number,
): { heredoc: PendingHeredoc; end: number } | undefined {
	let i = start;
	const stripTabs = command[i] === "-";
	if (stripTabs) i += 1;
	while (/\s/.test(command[i] ?? "")) i += 1;
	let delimiter = "";
	let quoted = false;
	while (i < command.length && !/[\s;&|<>]/.test(command[i] ?? "")) {
		const ch = command[i];
		if (ch === "'" || ch === '"') {
			quoted = true;
			const quote = ch;
			i += 1;
			while (i < command.length && command[i] !== quote) {
				delimiter += command[i++];
			}
			if (command[i] !== quote) return undefined;
			i += 1;
			continue;
		}
		if (ch === "\\") {
			quoted = true;
			i += 1;
			if (i >= command.length) return undefined;
			delimiter += command[i++];
			continue;
		}
		delimiter += ch;
		i += 1;
	}
	if (!delimiter) return undefined;
	return { heredoc: { delimiter, stripTabs, quoted }, end: i - 1 };
}

function heredocSubstitutionBodies(body: string): string[] {
	const substitutions: string[] = [];
	for (let i = 0; i < body.length; i += 1) {
		if (body.startsWith("$(", i)) {
			let depth = 1;
			let quote: "single" | "double" | undefined;
			for (let end = i + 2; end < body.length; end += 1) {
				const ch = body[end];
				if (quote === "single") {
					if (ch === "'") quote = undefined;
					continue;
				}
				if (quote === "double") {
					if (ch === '"' && body[end - 1] !== "\\") quote = undefined;
					continue;
				}
				if (ch === "'" || ch === '"') {
					quote = ch === "'" ? "single" : "double";
				} else if (body.startsWith("$(", end)) {
					depth += 1;
					end += 1;
				} else if (ch === ")") {
					depth -= 1;
					if (depth === 0) {
						substitutions.push(body.slice(i + 2, end));
						i = end;
						break;
					}
				}
			}
		} else if (body[i] === "`" && body[i - 1] !== "\\") {
			const end = body.indexOf("`", i + 1);
			if (end >= 0) {
				substitutions.push(body.slice(i + 1, end));
				i = end;
			}
		}
	}
	return substitutions;
}

function consumeHeredocBodies(
	command: string,
	start: number,
	heredocs: PendingHeredoc[],
): { end: number; substitutions: string[] } {
	let cursor = start;
	const substitutions: string[] = [];
	for (const heredoc of heredocs) {
		const bodyStart = cursor;
		let found = false;
		while (cursor < command.length) {
			const lineEnd = command.indexOf("\n", cursor);
			const end = lineEnd < 0 ? command.length : lineEnd;
			let line = command.slice(cursor, end);
			if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
			if (line.replace(/\r$/, "") === heredoc.delimiter) {
				if (!heredoc.quoted)
					substitutions.push(
						...heredocSubstitutionBodies(command.slice(bodyStart, cursor)),
					);
				cursor = lineEnd < 0 ? end : end + 1;
				found = true;
				break;
			}
			cursor = lineEnd < 0 ? end : end + 1;
		}
		if (!found) {
			if (!heredoc.quoted)
				substitutions.push(
					...heredocSubstitutionBodies(command.slice(bodyStart)),
				);
			return { end: command.length - 1, substitutions };
		}
	}
	return { end: cursor - 1, substitutions };
}

export function tokenizeShellCommand(command: string): ShellCommandSegment[] {
	const segments: ShellCommandSegment[] = [];
	const pendingHeredocs: PendingHeredoc[] = [];
	let tokens: string[] = [];
	let word = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let unsupported = false;
	let atTokenStart = true;
	const flushWord = () => {
		if (word) tokens.push(word);
		word = "";
		atTokenStart = true;
	};
	const flushSegment = (terminator?: "pipe") => {
		flushWord();
		if (tokens.length > 0 || unsupported)
			segments.push({ tokens, unsupported, terminator });
		tokens = [];
		unsupported = false;
		atTokenStart = true;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (quote === "single") {
			if (ch === "'") quote = undefined;
			else word += ch;
			continue;
		}
		if (quote === "double") {
			if (escaped) {
				word += ch;
				escaped = false;
			} else if (ch === "\\") escaped = true;
			else if (ch === '"') quote = undefined;
			else word += ch;
			continue;
		}
		if (escaped) {
			// A backslash-newline is a shell line continuation, not part of the
			// command argument. Keeping the newline here makes a continued git command
			// visible to command guards.
			if (ch !== "\n") word += ch;
			escaped = false;
			atTokenStart = false;
			continue;
		}
		if (ch === "\\") {
			// Bash uses backslash as a general escape, but command inputs on
			// Windows routinely contain native paths (C:\\src\\file.ts). Preserve
			// backslashes before ordinary path characters while still honoring
			// shell escapes and line continuations.
			if (next === "\n" || /[\s\\'";$|&<>]/.test(next ?? "")) {
				escaped = true;
			} else {
				word += ch;
				atTokenStart = false;
			}
			atTokenStart = false;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			atTokenStart = false;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			atTokenStart = false;
			continue;
		}
		if (ch === "#" && atTokenStart) {
			while (i + 1 < command.length && command[i + 1] !== "\n") i++;
			continue;
		}
		if (/\s/.test(ch) && ch !== "\n") {
			flushWord();
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
			flushWord();
			if (ch === "\n" && pendingHeredocs.length > 0) {
				const heredocs = pendingHeredocs.splice(0);
				flushSegment();
				const consumed = consumeHeredocBodies(command, i + 1, heredocs);
				for (const substitution of consumed.substitutions)
					segments.push(...tokenizeShellCommand(substitution));
				i = consumed.end;
				continue;
			}
			let terminator: "pipe" | undefined;
			if (ch === "|" && next === "|") i++;
			else if (ch === "&" && next === "&") i++;
			else if (ch === "|") {
				unsupported = true;
				terminator = "pipe";
			} else if (ch === "&") unsupported = true;
			flushSegment(terminator);
			continue;
		}
		if (ch === "<" || ch === ">") {
			flushWord();
			if (
				ch === "<" &&
				next === "<" &&
				command[i - 1] !== "<" &&
				command[i + 2] !== "<"
			) {
				const parsed = parseHeredocDelimiter(command, i + 2);
				if (parsed) {
					pendingHeredocs.push(parsed.heredoc);
					i = parsed.end;
				}
			}
			unsupported = true;
			continue;
		}
		word += ch;
		atTokenStart = false;
	}
	if (quote || escaped) unsupported = true;
	flushSegment();
	return segments;
}

/** Resolve a token to an absolute path if it looks like a source file. */
function resolveCandidate(token: string, cwd: string): string | null {
	const cleaned = stripQuotes(token);
	if (!cleaned || cleaned.startsWith("-") || !isReadableSourceFile(cleaned)) {
		return null;
	}
	return path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
}

/** Parse a count flag value like `-20`, `-n20`, or the `20` following `-n`. */
function parseCountFlag(token: string): number | undefined {
	const digits = token.replace(/^-n?/, "").replace(/[^0-9]/g, "");
	if (!digits) return undefined;
	const n = Number.parseInt(digits, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function commandSegments(command: string): string[][] {
	return tokenizeShellCommand(command).map((segment) => segment.tokens);
}

/** Unwrap the common agent-authored `npx <tool>` launcher form. */
function unwrapCommand(tokens: string[]): { verb: string; args: string[] } {
	let verb = path.basename(tokens[0] ?? "");
	let args = tokens.slice(1);
	if (verb === "npx") {
		while (args[0] === "-y" || args[0] === "--yes") args = args.slice(1);
		verb = path.basename(args[0] ?? "");
		args = args.slice(1);
	}
	return { verb, args };
}

/**
 * Return source-file operands while excluding values consumed by known options.
 * This stays deliberately narrower than a general CLI parser: only formatter
 * options whose values can themselves look like source files belong here.
 */
function formatterFileArgs(
	args: string[],
	start = 0,
	valueOptions: ReadonlySet<string> = new Set(),
): string[] {
	const files: string[] = [];
	for (let i = start; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (valueOptions.has(arg)) {
			i += 1;
			continue;
		}
		if (arg === "--" || arg.startsWith("-")) continue;
		files.push(arg);
	}
	return files;
}

/** Find redirect targets without treating quoted `>` characters as syntax. */
function extractRedirectTargets(command: string): string[] {
	const targets: string[] = [];
	let quote: "single" | "double" | undefined;
	let escaped = false;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (quote === "single") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') quote = undefined;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			continue;
		}
		if (ch === '"') {
			quote = "double";
			continue;
		}
		if (ch !== ">") continue;
		while (i + 1 < command.length && /\s/.test(command[i + 1])) i += 1;
		if (command[i + 1] === ">") i += 1;
		while (i + 1 < command.length && /\s/.test(command[i + 1])) i += 1;
		let target = "";
		for (i += 1; i < command.length; i += 1) {
			const next = command[i];
			if (/\s/.test(next) || next === ";" || next === "|" || next === "&") {
				i -= 1;
				break;
			}
			target += next;
		}
		if (target) targets.push(target);
	}
	return targets;
}

/**
 * Extract the line ranges a bash command explicitly showed the agent.
 * Only file-VIEWING commands, and only the exact lines shown:
 *   cat/less/more/bat/nl FILE → whole file
 *   head [-n N] FILE          → lines 1..N (default 10)
 *   tail [-n N] FILE          → last N lines (default 10)
 *   sed -n 'A,Bp' FILE        → lines A..B
 */
export function extractReadPathsFromCommand(
	command: string,
	cwd: string,
): ReadSpan[] {
	const spans: ReadSpan[] = [];
	const seen = new Set<string>();

	const resolveFile = (
		token: string,
	): { abs: string; total: number } | null => {
		const abs = resolveCandidate(token, cwd);
		if (!abs) return null;
		try {
			if (!nodeFs.statSync(abs).isFile()) return null;
		} catch {
			return null;
		}
		return { abs, total: countFileLines(abs) };
	};

	const addSpan = (token: string, start: number, count: number) => {
		const file = resolveFile(token);
		if (!file) return;
		const offset = Math.min(Math.max(1, start), file.total);
		const limit = Math.min(count, file.total - offset + 1);
		if (limit < 1) return;
		const key = `${file.abs}:${offset}:${limit}`;
		if (seen.has(key)) return;
		seen.add(key);
		spans.push({ filePath: file.abs, offset, limit });
	};

	for (const tokens of commandSegments(command)) {
		if (tokens.length === 0) continue;
		const verb = path.basename(tokens[0] ?? "");
		const args = tokens.slice(1);

		if (["cat", "bat", "less", "more", "nl"].includes(verb)) {
			for (const a of args) addSpan(a, 1, Number.MAX_SAFE_INTEGER);
		} else if (verb === "head" || verb === "tail") {
			let count: number | undefined;
			const files: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a === "-n" || a === "-c") {
					const next = args[i + 1];
					if (next !== undefined) {
						count = parseCountFlag(next) ?? count;
						i++;
					}
				} else if (/^-n?\d+$/.test(a)) {
					count = parseCountFlag(a) ?? count;
				} else if (!a.startsWith("-")) {
					files.push(a);
				}
			}
			const n = count ?? 10; // GNU head/tail default
			for (const f of files) {
				const file = resolveFile(f);
				if (!file) continue;
				if (verb === "head") addSpan(f, 1, n);
				else addSpan(f, file.total - n + 1, n); // tail: last n lines
			}
		} else if (verb === "sed") {
			if (args.includes("-i")) continue; // sed -i writes, not reads
			let range: { start: number; end: number } | undefined;
			for (const a of args) {
				const m = stripQuotes(a).match(/^(\d+),(\d+)p$/);
				if (m) {
					range = {
						start: Number.parseInt(m[1], 10),
						end: Number.parseInt(m[2], 10),
					};
					break;
				}
			}
			if (!range) continue;
			for (const a of args)
				addSpan(a, range.start, range.end - range.start + 1);
		}
	}

	return spans;
}

function grepHasLineNumbers(args: string[]): boolean {
	return args.some((arg) => {
		const token = stripQuotes(arg);
		if (token === "--line-number") return true;
		if (!token.startsWith("-") || token.startsWith("--")) return false;
		return token.slice(1).includes("n");
	});
}

const GREP_OPTIONS_WITH_VALUE = new Set([
	"-e",
	"-f",
	"-m",
	"-A",
	"-B",
	"-C",
	"--regexp",
	"--file",
	"--max-count",
	"--after-context",
	"--before-context",
	"--context",
]);

export interface GrepContextLines {
	before: number;
	after: number;
}

function parseContextValue(
	inline: string,
	next: string | undefined,
): number | undefined {
	const raw = inline !== "" ? inline : next;
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0) return undefined;
	// Bound the credit: a huge -C would credit a whole file from one hit.
	return Math.min(n, 100);
}

/**
 * Read the context lines a `grep` invocation actually PRINTS around each hit
 * (#1904 item 2). Only these lines were delivered to the model, so only these
 * may be credited as read. Handles `-A N`, `-A3`, clustered short flags such as
 * `-rnA3`, `--after-context=N`, the `-B`/`--before-context` mirror, `-C`
 * (both sides), and the bare `-NUM` form.
 */
export function parseGrepContextLines(args: string[]): GrepContextLines {
	let before = 0;
	let after = 0;
	for (let i = 0; i < args.length; i++) {
		const token = stripQuotes(args[i]);
		if (token === "--") break;
		const nextToken =
			args[i + 1] === undefined ? undefined : stripQuotes(args[i + 1]);

		const long = /^--(after|before)-context(?:=(\d+))?$/.exec(token);
		if (long) {
			const value = parseContextValue(long[2] ?? "", nextToken);
			if (value === undefined) continue;
			if (long[1] === "after") after = Math.max(after, value);
			else before = Math.max(before, value);
			continue;
		}
		const longBoth = /^--context(?:=(\d+))?$/.exec(token);
		if (longBoth) {
			const value = parseContextValue(longBoth[1] ?? "", nextToken);
			if (value === undefined) continue;
			before = Math.max(before, value);
			after = Math.max(after, value);
			continue;
		}
		// Bare numeric context form: `grep -3 pattern file`.
		const bare = /^-(\d+)$/.exec(token);
		if (bare) {
			const value = parseContextValue(bare[1], undefined);
			if (value === undefined) continue;
			before = Math.max(before, value);
			after = Math.max(after, value);
			continue;
		}
		// Short flags, possibly clustered: the context flag must be LAST in the
		// cluster because it consumes the remaining characters as its value.
		const short = /^-[A-Za-z]*([ABC])(\d*)$/.exec(token);
		if (!short) continue;
		const value = parseContextValue(short[2], nextToken);
		if (value === undefined) continue;
		if (short[1] === "A") after = Math.max(after, value);
		else if (short[1] === "B") before = Math.max(before, value);
		else {
			before = Math.max(before, value);
			after = Math.max(after, value);
		}
	}
	return { before, after };
}

function extractGrepSearchFiles(args: string[], cwd: string): string[] {
	const files: string[] = [];
	let patternSeen = false;
	let endOfOptions = false;
	for (let i = 0; i < args.length; i++) {
		const token = stripQuotes(args[i]);
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && GREP_OPTIONS_WITH_VALUE.has(token)) {
			i++;
			continue;
		}
		if (!endOfOptions && /^-[ef].+/.test(token)) continue;
		if (!endOfOptions && token.startsWith("-")) continue;
		if (!patternSeen) {
			patternSeen = true;
			continue;
		}
		const abs = resolveCandidate(token, cwd);
		if (!abs) continue;
		try {
			if (!nodeFs.statSync(abs).isFile()) continue;
		} catch {
			continue;
		}
		files.push(abs);
	}
	return files;
}

function parseGrepLineWithFile(
	line: string,
	cwd: string,
): SearchReadLocation | undefined {
	const match = /^(.*?):(\d+):/.exec(stripAnsi(line));
	if (!match) return undefined;
	const lineNumber = Number.parseInt(match[2], 10);
	if (!Number.isFinite(lineNumber) || lineNumber < 1) return undefined;
	const abs = resolveCandidate(match[1], cwd);
	if (!abs) return undefined;
	try {
		if (!nodeFs.statSync(abs).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return { file: abs, startLine: lineNumber, endLine: lineNumber };
}

function parseGrepLineWithoutFile(
	line: string,
	file: string,
): SearchReadLocation | undefined {
	const match = /^(\d+):/.exec(stripAnsi(line));
	if (!match) return undefined;
	const lineNumber = Number.parseInt(match[1], 10);
	if (!Number.isFinite(lineNumber) || lineNumber < 1) return undefined;
	return { file, startLine: lineNumber, endLine: lineNumber };
}

/**
 * Verbs that DROP printed lines from a piped stream (#1908, review F4): a
 * hit that survives such a tail cannot be trusted to still carry the
 * -A/-B/-C context grep's flags declared, because that context may have
 * been among the dropped lines. `head`/`tail` drop by position (even bare,
 * since both default to a 10-line window); `sed` with a `q` command drops
 * everything after the addressed line; `uniq` drops adjacent duplicate
 * lines, which can include a context line that happens to repeat.
 *
 * The criterion is DROPPING, not "changes grep's output shape" — a review
 * finding (#1913 F4) caught this file previously conflating the two:
 *   - `head`/`tail`/`sed q`/`uniq` downstream of a matching grep → some
 *     printed lines are genuinely gone, so credit falls back to
 *     match-line-only (the same conservative default already used for
 *     unparseable commands) rather than trusting the declared flags.
 *   - `sort` and other REORDER-ONLY filters keep every line grep printed,
 *     just in a different order — a surviving `file:line:` match still
 *     carries the full context grep actually printed, so no special case is
 *     needed (proven by the "still credits full context through a
 *     non-truncating pipe tail" test below).
 *   - `wc` and similar filters that REPLACE grep's output entirely (with a
 *     count, say) leave no `file:line:`-shaped line at all, so
 *     `parseGrepOutputSearchReads` already finds zero matches in the real
 *     captured stdout. Also no special case needed, but for the OPPOSITE
 *     reason from `sort`: nothing survives to credit, rather than
 *     everything surviving intact.
 *   - A pass-through filter (`cat`, `grep -v`, ...) between grep and a
 *     dropping tail still counts: the walk below follows the whole pipe
 *     chain, not just the immediate next segment.
 *   - Out of scope, deliberately: `sed -n 'Np'` range-address filtering
 *     without `q`, and `sort -u`, also drop lines but aren't in #1908's
 *     stated scope — revisit if they recur in the field. Also out of
 *     scope: a truncating tail hidden inside a subshell/brace-group
 *     (`( ... )`, `{ ...; }`) or reimplemented in `awk`/`perl` — the shared
 *     tokenizer this file uses doesn't parse inside those, matching its
 *     documented "small conservative shell lexer" scope.
 */
const LINE_DROPPING_TAIL_VERBS = new Set(["head", "tail", "uniq"]);

function isSedQuitCommand(args: string[]): boolean {
	for (const arg of args) {
		const token = stripQuotes(arg);
		if (token.startsWith("-")) continue;
		// A `q` command anchored at the start of the script or after a `;`/
		// newline separator, optionally preceded by a numeric/`$` address
		// (`q`, `1q`, `$q`, `1,3p;q`). Deliberately not a full sed parser.
		if (/(^|[;\n])\s*(\d+|\$)?\s*q\b/.test(token)) return true;
	}
	return false;
}

function isLineDroppingTailCommand(tokens: string[]): boolean {
	const verb = path.basename(stripQuotes(tokens[0] ?? ""));
	if (LINE_DROPPING_TAIL_VERBS.has(verb)) return true;
	if (verb === "sed") return isSedQuitCommand(tokens.slice(1));
	return false;
}

/**
 * True when the grep segment starting at `index` feeds — directly or through
 * a chain of pipes — into a line-dropping tail (#1908). Only an unquoted `|`
 * counts: a `;`/`&&`/`&`-separated command downstream never receives grep's
 * stdout, so it must not downgrade credit (#1913 F2 — this was previously
 * unverified by any test that could tell a real pipe from mere adjacency).
 */
function grepPipesIntoTruncatingTail(
	segments: ShellCommandSegment[],
	index: number,
): boolean {
	if (segments[index]?.terminator !== "pipe") return false;
	for (let j = index + 1; j < segments.length; j++) {
		if (isLineDroppingTailCommand(segments[j].tokens)) return true;
		if (segments[j].terminator !== "pipe") return false;
	}
	return false;
}

function collectGrepCommandFiles(
	command: string,
	cwd: string,
): {
	hasLineNumberGrep: boolean;
	files: Set<string>;
	context: GrepContextLines;
} {
	const files = new Set<string>();
	let hasLineNumberGrep = false;
	// A command can chain several greps whose output all reaches the model, but
	// the parsed hits carry no segment identity. Credit the SMALLEST context any
	// contributing grep printed, so no line is credited that a hit from the
	// narrowest grep never delivered.
	let context: GrepContextLines | undefined;
	// #1908: if ANY contributing grep pipes into a truncating tail, fall back
	// to match-line-only credit for the whole command — the parsed hits carry
	// no segment identity, so a per-segment override isn't representable in
	// the aggregate `context` this function returns.
	let truncated = false;
	const segments = tokenizeShellCommand(command);
	for (let i = 0; i < segments.length; i++) {
		const tokens = segments[i].tokens;
		const verb = path.basename(stripQuotes(tokens[0] ?? ""));
		if (verb !== "grep" && verb !== "egrep" && verb !== "fgrep") continue;
		const args = tokens.slice(1);
		if (!grepHasLineNumbers(args)) continue;
		hasLineNumberGrep = true;
		const segmentContext = parseGrepContextLines(args);
		context = context
			? {
					before: Math.min(context.before, segmentContext.before),
					after: Math.min(context.after, segmentContext.after),
				}
			: segmentContext;
		for (const file of extractGrepSearchFiles(args, cwd)) files.add(file);
		if (grepPipesIntoTruncatingTail(segments, i)) truncated = true;
	}
	return {
		hasLineNumberGrep,
		files,
		context: truncated
			? { before: 0, after: 0 }
			: (context ?? { before: 0, after: 0 }),
	};
}

function dedupePushSearchRead(
	out: SearchReadLocation[],
	seen: Set<string>,
	loc: SearchReadLocation | undefined,
): void {
	if (!loc) return;
	const key = `${loc.file}:${loc.startLine}:${loc.endLine ?? loc.startLine}`;
	if (seen.has(key)) return;
	seen.add(key);
	out.push(loc);
}

function parseGrepOutputSearchReads(
	output: string,
	cwd: string,
	singleFile?: string,
): SearchReadLocation[] {
	const out: SearchReadLocation[] = [];
	const seen = new Set<string>();
	for (const rawLine of output.split(/\r?\n/)) {
		if (!rawLine) continue;
		dedupePushSearchRead(out, seen, parseGrepLineWithFile(rawLine, cwd));
		if (singleFile) {
			dedupePushSearchRead(
				out,
				seen,
				parseGrepLineWithoutFile(rawLine, singleFile),
			);
		}
	}
	return out;
}

/**
 * Parse `grep -n` output into the specific lines shown to the agent (#169).
 * Multi-file grep prints `file:line:text`; single-file grep prints `line:text`,
 * so the latter is only accepted when the command names exactly one source file.
 */
export function extractGrepSearchReadsFromOutput(
	command: string,
	cwd: string,
	output: string,
): SearchReadLocation[] {
	const { hasLineNumberGrep, files, context } = collectGrepCommandFiles(
		command,
		cwd,
	);
	if (!hasLineNumberGrep) return [];
	const singleFile = files.size === 1 ? [...files][0] : undefined;
	const locations = parseGrepOutputSearchReads(output, cwd, singleFile);
	// Only the printed context lines were delivered to the model, so only they
	// are credited. A bare grep credits its match line alone (#1904 item 2).
	for (const loc of locations) {
		loc.contextBefore = context.before;
		loc.contextAfter = context.after;
	}
	return locations;
}

/**
 * Extract files a bash command WROTE/created, so the read-guard can treat them
 * as authored by the agent (mirrors the Write tool). Handles:
 *   redirects: `> FILE`, `>> FILE`, `N> FILE`, `&> FILE` (with or without space)
 *   tee [-a] FILE..., sed -i ... FILE, cp/mv/install ... DEST, touch FILE...,
 *   and common in-place formatter/fixer invocations with explicit file targets.
 *
 * Returns absolute paths. The file need not exist yet (it may be created) —
 * existence is confirmed later by recordWritten at tool_result time.
 */
export function extractWrittenPathsFromCommand(
	command: string,
	cwd: string,
): string[] {
	const out = new Set<string>();
	const add = (token: string) => {
		const abs = resolveCandidate(token, cwd);
		if (abs) out.add(abs);
	};

	for (const tokens of commandSegments(command)) {
		if (tokens.length === 0) continue;

		// Redirect targets are collected by a quote-aware scanner. The shared
		// tokenizer supplies the normalized command arguments; it deliberately
		// does not expose shell redirection operators as arguments.
		for (const target of extractRedirectTargets(command)) add(target);
		// A command may contain multiple segments; only the first pass should
		// attach redirects, otherwise targets would be duplicated harmlessly but
		// needlessly rescanned.
		break;
	}
	for (const tokens of commandSegments(command)) {
		if (tokens.length === 0) continue;
		const { verb, args } = unwrapCommand(tokens);

		if (verb === "tee" || verb === "touch") {
			for (const a of args) if (!a.startsWith("-")) add(a);
		} else if (verb === "sed" && args.includes("-i")) {
			for (const a of args) add(a);
		} else if (verb === "cp" || verb === "mv" || verb === "install") {
			// Known miss (#1668 review F3): the GNU `-t DEST`/`--target-directory`
			// form puts the destination BEFORE the sources — this always treats
			// the LAST non-flag argument as the destination, so `-t DEST SRC` and
			// multi-source `-t DEST SRC1 SRC2...` are misread. Rare in agent-
			// authored bash (source-before-dest is the common form); documented
			// rather than fixed, since correctly parsing `-t` means recognizing it
			// takes a value while telling it apart from every other single-letter
			// flag this same branch already ignores.
			const files = args.filter((a) => !a.startsWith("-"));
			if (files.length >= 1) add(files[files.length - 1]); // destination
		} else if (verb === "biome") {
			const sub = args[0];
			if ((sub === "format" || sub === "check") && args.includes("--write")) {
				for (const file of formatterFileArgs(
					args,
					1,
					new Set(["--config-path"]),
				))
					add(file);
			}
		} else if (verb === "prettier" && args.includes("--write")) {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--config", "--ignore-path", "--parser", "--plugin"]),
			))
				add(file);
		} else if (verb === "eslint" && args.includes("--fix")) {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--config", "--ignore-path", "--parser", "--plugin"]),
			))
				add(file);
		} else if (verb === "ruff") {
			const sub = args[0];
			if (sub === "format" || args.includes("--fix")) {
				const start = sub === "format" || sub === "check" ? 1 : 0;
				for (const file of formatterFileArgs(
					args,
					start,
					new Set(["--config"]),
				))
					add(file);
			}
		} else if (verb === "gofmt" && args.includes("-w")) {
			for (const file of formatterFileArgs(args)) add(file);
		} else if (verb === "cargo" && args[0] === "fmt") {
			// Bare cargo fmt is project-scoped and cannot be enumerated without a
			// filesystem walk. Only explicit rustfmt operands after `--` are safe.
			const separator = args.indexOf("--");
			if (separator >= 0) {
				for (const file of formatterFileArgs(
					args,
					separator + 1,
					new Set(["--edition", "--config-path"]),
				))
					add(file);
			}
		} else if (verb === "rustfmt") {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--edition", "--config-path"]),
			))
				add(file);
		} else if (verb === "black") {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set([
					"--config",
					"--exclude",
					"--include",
					"--line-length",
					"--target-version",
				]),
			))
				add(file);
		} else if (verb === "clang-format" && args.includes("-i")) {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--style", "--fallback-style", "--assume-filename"]),
			))
				add(file);
		} else if (verb === "dotnet" && args[0] === "format") {
			// dotnet format is normally solution-scoped. `--include` is the one
			// invocation form that provides attributable source paths.
			for (let i = 1; i < args.length; i += 1) {
				if (args[i] === "--include" && args[i + 1]) {
					for (const file of (args[i + 1] ?? "").split(",")) add(file);
					i += 1;
				} else if (args[i]?.startsWith("--include=")) {
					for (const file of (args[i] ?? "")
						.slice("--include=".length)
						.split(","))
						add(file);
				}
			}
		} else if (verb === "git") {
			// git ops that REWRITE working-tree files with explicit paths:
			//   git checkout [<ref>] -- <files>   git restore [opts] <files>
			// These restore content but never go through the edit tool, so without
			// this pi-lens keeps stale diagnostics/fileSeq for the restored file.
			// Whole-tree ops (reset --hard, stash pop, revert, merge, rebase, pull,
			// or `git checkout <branch>`) don't name files and aren't handled here.
			const sub = args[0];
			if (sub === "checkout" || sub === "restore") {
				const dashDash = args.indexOf("--");
				const fileArgs =
					dashDash >= 0
						? args.slice(dashDash + 1)
						: sub === "restore"
							? args.slice(1).filter((a) => !a.startsWith("-"))
							: []; // `git checkout` without `--` is ambiguous (ref vs path)
				for (const a of fileArgs) add(a);
			} else if (sub === "mv") {
				// git mv SRC... DEST — the destination is a write, exactly like
				// plain `mv` above (#1668 review F2). The source side is a delete,
				// handled by extractDeletedPathsFromCommand.
				const files = args.slice(1).filter((a) => !a.startsWith("-"));
				if (files.length >= 1) add(files[files.length - 1]);
			}
		}
	}

	return Array.from(out);
}

/**
 * Extract files a bash command likely DELETED, for the type-3 (Deleted)
 * watched-files gap (#1668): `rm FILE...`, `git rm FILE...`, and the SOURCE
 * side of `mv SRC DEST` / `git mv SRC DEST` (the destination is a write,
 * covered by `extractWrittenPathsFromCommand` — including for `git mv`,
 * #1668 review F2).
 *
 * Deliberately narrow: only commands naming an explicit file target are
 * handled. A bare directory op (`rm -rf dir/`, `git clean`) is skipped —
 * resolving what vanished inside a directory would mean listing it before
 * and after, the "stat the world" cost this module exists to avoid. The
 * caller confirms each candidate by checking it no longer exists on disk;
 * this function only proposes what the command named.
 */
export function extractDeletedPathsFromCommand(
	command: string,
	cwd: string,
): string[] {
	const out = new Set<string>();
	const add = (token: string) => {
		const abs = resolveCandidate(token, cwd);
		if (abs) out.add(abs);
	};
	// mv SRC... DEST / git mv SRC... DEST — every argument except the last is
	// a source that vanishes from its original path once the move lands.
	// Known miss (#1668 review F3): the same `-t DEST`/`--target-directory`
	// form documented in `extractWrittenPathsFromCommand` misreads here too —
	// this assumes source-before-destination order.
	const addMoveSources = (args: string[]) => {
		const files = args.filter((a) => !a.startsWith("-"));
		if (files.length >= 2) {
			for (const src of files.slice(0, -1)) add(src);
		}
	};

	for (const tokens of commandSegments(command)) {
		if (tokens.length === 0) continue;
		const verb = path.basename(tokens[0] ?? "");
		const args = tokens.slice(1);

		if (verb === "rm") {
			for (const a of args) if (!a.startsWith("-")) add(a);
		} else if (verb === "git" && args[0] === "rm") {
			const rmArgs = args.slice(1);
			const dashDash = rmArgs.indexOf("--");
			const fileArgs =
				dashDash >= 0
					? rmArgs.slice(dashDash + 1)
					: rmArgs.filter((a) => !a.startsWith("-"));
			for (const a of fileArgs) add(a);
		} else if (verb === "git" && args[0] === "mv") {
			addMoveSources(args.slice(1));
		} else if (verb === "mv") {
			addMoveSources(args);
		}
	}

	return Array.from(out);
}

/**
 * One edit-class predicate for the `tool_result` path (#2939 F3).
 *
 * `index.ts` used to answer "is this an edit-class result" twice — once in
 * the handler body (gated on `toolName === "bash"`) and once in the
 * `budgetKey` callback (no tool gate) — and the copies disagreed on the
 * first third-party case tried (`mcp__acme__shell` with `input.command`:
 * wrapper said edit, handler said read-only). Both call sites now share
 * this function, so they cannot drift again.
 *
 * A result is edit-class when the mutation seam classifies it, or when its
 * `input.command` names written files. The command half carries no tool-name
 * gate on purpose: a shell that wrote files runs the same pipeline whatever
 * its tool is named, and the edit budget must cover that work.
 */
export function isEditClassToolResult(
	event: { toolName?: string; input?: { command?: unknown } },
	cwd: string,
): boolean {
	if (classifyMutatingTool(event, { recognizeOnly: true }) !== undefined) {
		return true;
	}
	const command = event?.input?.command;
	return (
		typeof command === "string" &&
		extractWrittenPathsFromCommand(command, cwd).length > 0
	);
}

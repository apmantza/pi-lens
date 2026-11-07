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
import { isWindowsPath, normalizeHostToolPath } from "./path-utils.js";
import {
	appliedFilesOfOwnTool,
	classifyMutatingTool,
} from "./mutating-tool.js";
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

/**
 * How bash quoted one stretch of a word's SOURCE (#4713 R11). `escaped` is one
 * unquoted backslash-escaped character; `keptEscape` is one escaped before an
 * ordinary character (`\c`), whose backslash the path reading keeps for native
 * Windows paths (#4713 R12); `ansiC` is `$'…'` and `locale` is `$"…"`. A
 * backslash-newline is no part: bash removes it before it reads quoting, so it
 * joins the stretch around it.
 */
type WordPartKind =
	| "unquoted"
	| "single"
	| "double"
	| "ansiC"
	| "locale"
	| "escaped"
	| "keptEscape";

/**
 * One stretch of a word, kept even when it emits nothing (`""`). `text` is
 * what bash emits for it; an `ansiC` part is decoded (see {@link decodeAnsiC}).
 * Adjacent quotes of one kind share a part: no reader tells `'a''b'` from
 * `'ab'`, as bash does not. Each `$'…'` is a part of its own, because a NUL
 * ends only the quote it is in.
 */
interface WordPart {
	kind: WordPartKind;
	text: string;
}

/** Bash's one-character escapes inside `$'…'`: the escape's byte to its value. */
const ANSI_C_ESCAPES: ReadonlyMap<number, number> = new Map(
	Object.entries({
		a: 0x07,
		b: 0x08,
		e: 0x1b,
		E: 0x1b,
		f: 0x0c,
		n: 0x0a,
		r: 0x0d,
		t: 0x09,
		v: 0x0b,
		"\\": 0x5c,
		"'": 0x27,
		'"': 0x22,
		"?": 0x3f,
	}).map(([escape, value]) => [escape.charCodeAt(0), value]),
);

/** Whether `byte` is an ASCII digit of `radix` (8 or 16). */
function isDigitByte(byte: number, radix: number): boolean {
	if (byte >= 0x30 && byte <= 0x37) return true;
	if (radix === 8) return false;
	const lower = byte | 0x20;
	return byte === 0x38 || byte === 0x39 || (lower >= 0x61 && lower <= 0x66);
}

/** A code point as bash writes it in a UTF-8 locale: up to six bytes. */
function utf8Sequence(codePoint: number): number[] {
	if (codePoint < 0x80) return [codePoint];
	const tail: number[] = [];
	let rest = codePoint;
	// A lead byte of n bytes holds 7 - n bits of the code point.
	let leadBits = 6;
	do {
		tail.unshift(0x80 | (rest & 0x3f));
		rest >>>= 6;
		leadBits--;
	} while (rest >= 1 << leadBits);
	return [((0xff00 >> (tail.length + 1)) & 0xff) | rest, ...tail];
}

/**
 * The text of a `$'…'` body as bash decodes it (bash 5.3, #4739 round 5): the
 * simple escapes, `\nnn` octal (value & 0xff), `\xHH`, `\uHHHH`,
 * `\UHHHHHHHH`, `\cX`, and an unknown escape kept with its backslash. A NUL
 * ends the string. The work is on bytes, as bash's is, and the text is the
 * bytes read as UTF-8, as the command itself is. A non-ASCII `\u` follows a
 * UTF-8 locale; under C, bash prints the escape itself, and neither reading
 * can spell an ASCII word.
 */
function decodeAnsiC(body: string): string {
	const source = new TextEncoder().encode(body);
	const out: number[] = [];
	const digitsAt = (start: number, max: number, radix: number) => {
		let end = start;
		while (
			end < source.length &&
			end - start < max &&
			isDigitByte(source[end] ?? 0, radix)
		)
			end++;
		return end;
	};
	const number = (start: number, end: number, radix: number) =>
		Number.parseInt(new TextDecoder().decode(source.slice(start, end)), radix);
	let i = 0;
	while (i < source.length) {
		const byte = source[i] ?? 0;
		if (byte !== 0x5c || i + 1 >= source.length) {
			out.push(byte);
			i++;
			continue;
		}
		const escape = source[i + 1] ?? 0;
		let value = ANSI_C_ESCAPES.get(escape);
		if (value !== undefined) {
			i += 2;
		} else if (isDigitByte(escape, 8)) {
			const end = digitsAt(i + 1, 3, 8);
			value = number(i + 1, end, 8) & 0xff;
			i = end;
		} else if (escape === 0x78 || escape === 0x75 || escape === 0x55) {
			// `\x` takes up to 2 hex digits, `\u` 4 and `\U` 8.
			const end = digitsAt(
				i + 2,
				escape === 0x78 ? 2 : escape === 0x75 ? 4 : 8,
				16,
			);
			if (end === i + 2) {
				out.push(0x5c, escape);
				i += 2;
				continue;
			}
			const code = number(i + 2, end, 16);
			i = end;
			if (escape === 0x78) value = code;
			else if (code === 0) value = 0;
			// Bash drops a code point at or above 2^31 and goes on.
			else if (code < 0x80000000) out.push(...utf8Sequence(code));
		} else if (escape === 0x63 && i + 2 < source.length) {
			const control = source[i + 2] ?? 0;
			i += 3;
			// `\c\\` is one control character, made from both backslashes.
			if (control === 0x5c && source[i] === 0x5c) i++;
			// Bash upper-cases the letter first; the low five bits are the same.
			value = control === 0x3f ? 0x7f : control & 0x1f;
		} else {
			out.push(0x5c, escape);
			i += 2;
			continue;
		}
		if (value === 0) break;
		if (value !== undefined) out.push(value);
	}
	return new TextDecoder().decode(new Uint8Array(out));
}

/**
 * A word as bash lexed it: `parts` is the model every reader takes the word
 * from (#4713 R11, R12), through {@link wordValue}. The legacy token text is
 * only the public `tokens` stream; no reader here takes a word from it.
 */
interface ShellWord {
	parts: readonly WordPart[];
	/**
	 * Bash expands a leading `~` only when its whole tilde-prefix, up to the
	 * first unquoted `/`, is unquoted (#4577 M1, #4713 R11): the first part is
	 * unquoted and starts with `~`, and it is the only part or holds the `/`.
	 * `~/x""` expands; `""~`, `~""/x` and `~\ x` do not.
	 */
	tildeExpands: boolean;
	/**
	 * An unquoted `(`, `)`, `{` or `}` standing alone: shell syntax, not a
	 * character of a command word (#4739 r2). Bash ends a word at a paren, so
	 * `(git push)` runs `git`, and a lone `{` opens a group whose first command
	 * follows it. The one paren a word keeps is the `(` of `$(`, which opens a
	 * substitution, and an escaped or quoted paren is a character of its word.
	 */
	syntax?: true;
}

/**
 * How a segment ended. `redirect` is an `&` that belongs to a redirection
 * (`2>&1`, `>&2`, `&>f`), so the next segment is the same simple command; a
 * `|&` is a `pipe`; `end` is the end of the text.
 */
type ShellSegmentExit =
	| "and"
	| "or"
	| "pipe"
	| "seq"
	| "background"
	| "redirect"
	| "end";

/**
 * One lexed segment with its character range in the command text (`start` where
 * the previous terminator ended, `end` at this segment's own terminator). A
 * redirect target's offset falls in the range of the segment that runs it,
 * which is how `scanShellWriteScopes` decides which `cd` applies to it (#2050
 * AC4). Internal: the public segment shape callers compare stays unchanged.
 */
interface ShellSegmentRange {
	segment: ShellCommandSegment;
	start: number;
	end: number;
	exit: ShellSegmentExit;
	/** An unquoted `(`, `)`, `{`, `}` or backtick appeared in the segment. */
	grouping: boolean;
	/** Per word: a redirection's descriptor or target, not an argument. */
	redirectWords: readonly boolean[];
	/**
	 * The segment's words (#4713 R11). A quote that emits nothing still makes a
	 * word (`'' cd sub` runs an empty command name), which `segment.tokens`
	 * skips, so the two lists are not index-aligned (#4713 R12).
	 */
	words: readonly ShellWord[];
}

/**
 * An unquoted character bash takes as itself in a word. No `~`: bash expands
 * one after `=` (`a=~/x`), so only a leading one is admitted, and only as `~`
 * or `~/`, which `cdOperandPath` expands.
 */
const LITERAL_WORD_CHAR = /^[A-Za-z0-9_./@%:,=+-]$/;

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

/**
 * A word a write, read, delete or grep reader takes: its path reading (see
 * {@link wordValue}), empty when the word is not known statically, and whether
 * bash expands its leading `~` (see {@link ShellWord.tildeExpands}).
 */
interface ShellOperand {
	text: string;
	tildeExpands: boolean;
}

function shellOperands(range: ShellSegmentRange): ShellOperand[] {
	return range.words.map((word) => ({
		text: wordValue(word, true),
		tildeExpands: word.tildeExpands,
	}));
}

/**
 * Bash's word after quote removal (#4713 R11). This is the name bash looks a
 * command up by: `\c""d`, `'cd'` and `$'cd'` are all `cd`, and `"\c"d` is
 * `\cd`.
 *
 * `asPath` is the reading every operand reader takes (#4713 R12). It keeps the
 * backslash of a `keptEscape` part, so an unquoted `C:\src\f.ts` names that
 * native Windows path where bash would read `C:srcf.ts`; every other part is
 * bash's own text, so `"C:\x\f.ts"` keeps its backslashes and `$'f.ts'` is
 * `f.ts`.
 */
function wordValue(word: ShellWord, asPath = false): string {
	let value = "";
	for (const part of word.parts) {
		value +=
			asPath && part.kind === "keptEscape"
				? part.text.replace(/[\s\S]/g, "\\$&")
				: part.text;
	}
	return value;
}

export function tokenizeShellCommand(command: string): ShellCommandSegment[] {
	// A range of empty words only (`'' && cd sub`) has no token, and the public
	// stream never carried one (#4713 R12).
	return tokenizeShellCommandWithRanges(command).flatMap(({ segment }) =>
		segment.tokens.length > 0 || segment.unsupported ? [segment] : [],
	);
}

/**
 * A word as the command guards read it (#4739): bash's word after quote
 * removal (see {@link wordValue}, read as a path so a native Windows
 * `C:\git.exe` keeps its separators), never the legacy token text, which
 * spells `$'git'` and `\$'git'` alike as `$git`.
 *
 * `hidden` marks a word whose bash value this model does not know: a word
 * bash expands (`$g`, a command substitution, a glob or a brace list), whose
 * text is the unexpanded spelling. An ANSI-C word is decoded (`$'\x67it'` is
 * `git`, round 5). A guard decides what to do with a word it cannot read;
 * this model only says so.
 */
export interface DecodedShellWord {
	text: string;
	hidden?: "expansion";
	/** Bash expands this word's leading `~` to a home directory (see {@link ShellWord.tildeExpands}); `text` keeps the `~`. */
	tildeExpands?: true;
}

export interface DecodedShellSegment {
	words: DecodedShellWord[];
}

/** What bash expands in a part of each quoting kind. */
const EXPANDING_CHARS: Partial<Record<WordPartKind, RegExp>> = {
	unquoted: /[$`*?[{]/,
	double: /[$`]/,
	locale: /[$`]/,
};

export function decodeShellWords(command: string): DecodedShellSegment[] {
	return tokenizeShellCommandWithRanges(command).map(({ words }) => ({
		words: words.flatMap((word): DecodedShellWord[] => {
			// A lone paren or brace is shell syntax, not a word (#4739 round 2).
			if (word.syntax === true) return [];
			const hidden = word.parts.some((part) =>
				EXPANDING_CHARS[part.kind]?.test(part.text),
			);
			return [
				{
					text: wordValue(word, true),
					...(hidden && { hidden: "expansion" as const }),
					...(word.tildeExpands && { tildeExpands: true as const }),
				},
			];
		}),
	}));
}

function tokenizeShellCommandWithRanges(command: string): ShellSegmentRange[] {
	const segments: ShellSegmentRange[] = [];
	const pendingHeredocs: PendingHeredoc[] = [];
	let tokens: string[] = [];
	let word = "";
	let words: ShellWord[] = [];
	// The word's parts so far, and the one still open (#4713 R11).
	let parts: WordPart[] = [];
	let part: { kind: WordPartKind; text: string } | undefined;
	let quote: "single" | "double" | undefined;
	// The part kind the open quote emits: `single`, `double`, `ansiC`, `locale`.
	let quoteKind: WordPartKind = "single";
	let escaped = false;
	// The previous character was an unquoted `$` opening `$'…'` or `$"…"`.
	let dollarQuote = false;
	// The previous character was a backslash the token keeps (`\c`): bash
	// removes it and takes this character as escaped.
	let escapeKept = false;
	let unsupported = false;
	let atTokenStart = true;
	let segmentStart = 0;
	let grouping = false;
	let redirectWords: boolean[] = [];
	// The next word is a redirection's target (`> f`, `2>&1`'s `1`).
	let redirectPending = false;
	const closePart = () => {
		if (part)
			parts.push({
				kind: part.kind,
				// An ANSI-C part holds the quoted source; bash's text is decoded.
				text: part.kind === "ansiC" ? decodeAnsiC(part.text) : part.text,
			});
		part = undefined;
	};
	// Append the emitted `text` to the open part of `kind`, opening one when
	// the open part is of another kind.
	const addToPart = (kind: WordPartKind, text: string) => {
		if (part?.kind !== kind) {
			closePart();
			part = { kind, text: "" };
		}
		part.text += text;
	};
	const flushWord = () => {
		closePart();
		// A quote that emits nothing still makes a word: `'' cd sub` runs an
		// empty command name, and `cd "" sub` passes two operands (#4713 R12).
		// The public `tokens` stream keeps skipping it.
		if (word || parts.length > 0) {
			if (word) tokens.push(word);
			const [first, ...rest] = parts;
			words.push({
				parts,
				tildeExpands:
					first?.kind === "unquoted" &&
					first.text?.startsWith("~") === true &&
					(rest.length === 0 || first.text.includes("/")),
				...(rest.length === 0 &&
					first?.kind === "unquoted" &&
					["(", ")", "{", "}"].includes(first.text ?? "") && { syntax: true }),
			});
			redirectWords.push(redirectPending);
			redirectPending = false;
		}
		word = "";
		parts = [];
		atTokenStart = true;
	};
	const flushSegment = (
		terminator?: "pipe",
		end = command.length - 1,
		exit: ShellSegmentExit = "end",
	) => {
		flushWord();
		if (words.length > 0 || unsupported)
			segments.push({
				segment: {
					tokens,
					unsupported,
					...(terminator ? { terminator } : {}),
				},
				start: segmentStart,
				end,
				exit,
				grouping,
				redirectWords,
				words,
			});
		tokens = [];
		words = [];
		redirectWords = [];
		grouping = false;
		unsupported = false;
		atTokenStart = true;
		segmentStart = end + 1;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] ?? "";
		const next = command[i + 1];
		if (quote === "single") {
			if (ch === "'") {
				quote = undefined;
				// A NUL ends only its own `$'…'`: decode each quote alone.
				if (quoteKind === "ansiC") closePart();
			} else {
				word += ch;
				addToPart(quoteKind, ch);
				// Inside `$'…'` a backslash escapes the next character, a quote
				// included: `$'\''` is one quote character, and reading its second
				// quote as the close swallowed what follows it (#4739).
				if (quoteKind === "ansiC" && ch === "\\" && next !== undefined) {
					word += next;
					addToPart(quoteKind, next);
					i++;
				}
			}
			continue;
		}
		if (quote === "double") {
			if (escaped) {
				// Bash removes the backslash before these inside double quotes, so
				// the character is an escaped part of its own, and keeps it before
				// any other character; the token drops it either way.
				word += ch;
				if ('$`"\\'.includes(ch)) addToPart("escaped", ch);
				else if (ch !== "\n") addToPart(quoteKind, `\\${ch}`);
				escaped = false;
			} else if (ch === "\\") escaped = true;
			else if (ch === '"') quote = undefined;
			else {
				word += ch;
				addToPart(quoteKind, ch);
			}
			continue;
		}
		if (escaped) {
			// A backslash-newline is a shell line continuation, not part of the
			// command argument. Keeping the newline here makes a continued git command
			// visible to command guards.
			if (ch !== "\n") {
				word += ch;
				addToPart("escaped", ch);
			}
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
				// Bash removes this backslash; the token keeps it.
				word += ch;
				if (next === undefined) addToPart("unquoted", ch);
				else escapeKept = true;
			}
			atTokenStart = false;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch === "'" ? "single" : "double";
			quoteKind =
				ch === "'"
					? dollarQuote
						? "ansiC"
						: "single"
					: dollarQuote
						? "locale"
						: "double";
			// A quote opens a part even when it emits nothing, so `""FOO=1`
			// starts with a quoted part and is no assignment.
			addToPart(quoteKind, "");
			dollarQuote = false;
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
				flushSegment(undefined, i, "seq");
				const consumed = consumeHeredocBodies(command, i + 1, heredocs);
				// A substitution's own text is NOT a range of this command: offsets
				// here are relative to the substituted body, so a redirect inside one
				// is not attributed to any of the command's segments (`-1`) rather
				// than to whichever `cd` its accidental offset lands near.
				for (const substitution of consumed.substitutions)
					segments.push(
						...tokenizeShellCommandWithRanges(substitution).map((entry) => ({
							...entry,
							start: -1,
							end: -1,
						})),
					);
				i = consumed.end;
				segmentStart = i + 1;
				continue;
			}
			let terminator: "pipe" | undefined;
			let exit: ShellSegmentExit = "seq";
			const prev = command[i - 1];
			if (ch === "|" && next === "|") {
				i++;
				exit = "or";
			} else if (ch === "&" && next === "&") {
				i++;
				exit = "and";
			} else if (ch === "|") {
				unsupported = true;
				terminator = "pipe";
				exit = "pipe";
			} else if (ch === "&") {
				unsupported = true;
				exit =
					prev === ">" || prev === "<" || next === ">"
						? "redirect"
						: prev === "|"
							? "pipe"
							: "background";
			}
			flushSegment(terminator, i, exit);
			continue;
		}
		if (ch === "<" || ch === ">") {
			// `2>` names a descriptor, not an argument, only when the digits are
			// one unquoted part: `2"">f` passes the argument `2` (#4713 R12).
			closePart();
			const [digits, ...more] = parts;
			if (
				more.length === 0 &&
				digits?.kind === "unquoted" &&
				/^\d+$/.test(digits.text ?? "")
			)
				redirectPending = true;
			flushWord();
			redirectPending = true;
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
					// The delimiter was this redirection's word.
					redirectPending = false;
				}
			}
			unsupported = true;
			continue;
		}
		if ("(){}`".includes(ch)) grouping = true;
		// An escaped paren (`\(`) is a character of its word, not syntax.
		if ((ch === "(" || ch === ")") && !escapeKept) {
			const opensSubstitution =
				ch === "(" && part?.kind === "unquoted" && part.text.endsWith("$");
			if (!opensSubstitution) {
				flushWord();
				word = ch;
				addToPart("unquoted", ch);
				flushWord();
				escapeKept = false;
				continue;
			}
		}
		word += ch;
		if (escapeKept) addToPart("keptEscape", ch);
		else if (ch === "$" && (next === "'" || next === '"')) dollarQuote = true;
		else addToPart("unquoted", ch);
		escapeKept = false;
		atTokenStart = false;
	}
	if (quote || escaped) unsupported = true;
	flushSegment(undefined, command.length - 1, "end");
	return segments;
}

/**
 * Resolve a bash operand to the file the SHELL opened.
 *
 * A shell word follows shell rules, not host-tool-argument rules (#4577 M1):
 * bash expands a bare leading `~`/`~/` itself and leaves a quoted or escaped
 * one literal, and none of the host resolver's other stages apply — a shell
 * reads the file literally named `@foo.ts`, `file://x` or `a\u202Fb.ts`, so
 * applying the `@` strip, the `file://` conversion or the unicode-space fold
 * here credited a file the command never touched. `~user/x` stays relative:
 * bash would expand it to that user's home, which is not knowable here, and
 * the pre-fix seam left it under the cwd.
 */
function resolveCandidate(token: ShellOperand, cwd: string): string | null {
	const cleaned = token.text;
	if (!cleaned || cleaned.startsWith("-") || !isReadableSourceFile(cleaned)) {
		return null;
	}
	// `\~/x` survives the lexer backslash-first (it keeps native Windows
	// path separators), and bash reads that tilde literally: drop the escape
	// instead of crediting the phantom `<cwd>/\~/x`.
	const operand =
		cleaned.startsWith("~") && token.tildeExpands
			? normalizeHostToolPath(cleaned)
			: cleaned.startsWith("\\~")
				? cleaned.slice(1)
				: cleaned;
	// An already-absolute operand keeps the spelling the command carried: a
	// re-resolve rewrites it (`C:/x/large.ts` -> `C:\x\large.ts` on win32) and
	// the read guard records that spelling (#4019, #4577 R4).
	return path.isAbsolute(operand) ? operand : path.resolve(cwd, operand);
}

/** Parse a count flag value like `-20`, `-n20`, or the `20` following `-n`. */
function parseCountFlag(token: string): number | undefined {
	const digits = token.replace(/^-n?/, "").replace(/[^0-9]/g, "");
	if (!digits) return undefined;
	const n = Number.parseInt(digits, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Unwrap the common agent-authored `npx <tool>` launcher form. */
function unwrapCommand(tokens: ShellOperand[]): {
	verb: string;
	args: ShellOperand[];
} {
	let verb = path.basename(tokens[0]?.text ?? "");
	let args = tokens.slice(1);
	if (verb === "npx") {
		while (args[0]?.text === "-y" || args[0]?.text === "--yes")
			args = args.slice(1);
		verb = path.basename(args[0]?.text ?? "");
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
	args: ShellOperand[],
	start = 0,
	valueOptions: ReadonlySet<string> = new Set(),
): ShellOperand[] {
	const files: ShellOperand[] = [];
	for (let i = start; i < args.length; i += 1) {
		const operand = args[i];
		if (!operand) continue;
		const arg = operand.text;
		if (valueOptions.has(arg)) {
			i += 1;
			continue;
		}
		if (arg === "--" || arg.startsWith("-")) continue;
		files.push(operand);
	}
	return files;
}

/** A move command's operands, read from either GNU argument order. */
interface MoveOperands {
	/** The operands that leave their original path. */
	sources: ShellOperand[];
	/** The trailing operand of the plain form, null when the form is `-t`. */
	destination: ShellOperand | null;
	/** The directory named by `-t DIR`, null for the plain order. */
	destinationDir: ShellOperand | null;
}

/**
 * The short-option letters that take NO value for `mv` / `cp` / `install`, so a
 * cluster of them may still end in `t` and mean `--target-directory` (#5378 R2
 * F6). Letters these commands give a value (`-S`uffix, `install -m`ode,
 * `-o`wner, `-g`roup) and any letter they do not define stay out: GNU hands the
 * `t` to that option, so the word names no target directory.
 */
const MOVE_CLUSTER_LETTERS = new Set("abdfilnprRsvx");

/**
 * The target-directory value a word carries by itself, or null when the word is
 * not that option (#5378). `--target-directory=DIR`, `-tDIR` and a run of
 * valueless letters ending in `t` (`-vt DIR`, `-vtDIR`) all name it; the empty
 * string means the value is the NEXT word (`-t`, `--target-directory`, `-vt`).
 * getopt reads a short cluster left to right and stops at the first letter that
 * takes a value, so the `t` there is the option and the rest of the word is its
 * value. An attached value is a word fragment, so bash expands no `~` in it.
 */
function attachedTargetDirectory(text: string): string | null {
	if (text.startsWith("--")) {
		if (text === "--target-directory") return "";
		return text.startsWith("--target-directory=")
			? text.slice("--target-directory=".length)
			: null;
	}
	if (!text.startsWith("-")) return null;
	const cluster = /^-([^t]*)t(.*)$/.exec(text);
	if (!cluster) return null;
	for (const letter of cluster[1] ?? "") {
		if (!MOVE_CLUSTER_LETTERS.has(letter)) return null;
	}
	return cluster[2] ?? "";
}

/** A word that names the target-directory option, and how much it consumes. */
interface TargetDirectoryOption {
	/** The directory operand, either attached to the word or the next one. */
	value: ShellOperand;
	/** True when the value is the NEXT word, so the loop skips it. */
	consumesNext: boolean;
}

/**
 * The target-directory option at `args[index]`, or null when that word is not
 * it (#5378). An option with no word after it is null too: nothing names a
 * directory, exactly as before this parser read `-t`.
 */
function targetDirectoryAt(
	args: ShellOperand[],
	index: number,
): TargetDirectoryOption | null {
	const attached = attachedTargetDirectory(args[index]?.text ?? "");
	if (attached === null) return null;
	if (attached !== "")
		return {
			value: { text: attached, tildeExpands: false },
			consumesNext: false,
		};
	const next = args[index + 1];
	return next ? { value: next, consumesNext: true } : null;
}

/**
 * Parse the operands of `mv` / `cp` / `install` / `git mv` (#5378). GNU puts
 * the destination LAST in the plain form (`mv SRC... DEST`) and FIRST in the
 * target-directory form, which `attachedTargetDirectory` recognizes; every
 * remaining operand of that form is a source. `--` ends the option list, so
 * `mv -- -t` moves the file named `-t`.
 *
 * Only the target-directory option is read as taking a value. Every other
 * leading dash stays an unknown flag, so an option that carries its own value
 * (`cp -S .bak`) still reads its value as an operand, as it did before this
 * parser.
 */
function moveOperands(args: ShellOperand[]): MoveOperands {
	const operands: ShellOperand[] = [];
	let destinationDir: ShellOperand | null = null;
	let options = true;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (!options || !arg.text.startsWith("-")) {
			operands.push(arg);
			continue;
		}
		if (arg.text === "--") {
			options = false;
			continue;
		}
		const option = targetDirectoryAt(args, i);
		if (!option) continue;
		destinationDir = option.value;
		if (option.consumesNext) i += 1;
	}
	const last = operands[operands.length - 1] ?? null;
	return destinationDir
		? { sources: operands, destination: null, destinationDir }
		: { sources: operands.slice(0, -1), destination: last, destinationDir };
}

/**
 * The last segment of a move operand, read with the separators ITS OWN spelling
 * uses (#5378 R2 F4). The word model keeps a native Windows operand's
 * backslashes (`C:\work\a.ts`), and `path.posix.basename` does not split on
 * `\`, so it would return the whole operand and the join would name
 * `dest/C:\work\a.ts`. Shape-based, not host-based (AGENTS.md shape 2): a
 * Windows-SHAPED operand is parsed with `path.win32` on every platform, the
 * same rule `basenameForShape` in `clients/generated-artifacts.ts` applies.
 */
function basenameForOperand(operand: string): string {
	return isWindowsPath(operand)
		? path.win32.basename(operand)
		: path.posix.basename(operand);
}

/**
 * The paths a move WRITES: the plain form's trailing operand, or for the `-t`
 * form `DIR/<basename>` of each source, because the move keeps each name inside
 * the directory it moves into (#5378). Joined with `/`: bash spells its
 * operands POSIX, and `resolveCandidate` keeps that spelling (#4577 R4). The
 * directory's own trailing separator is kept, never stripped, so `-t /` names
 * the root and a POSIX directory spelled with a backslash keeps that character
 * (#5378 R2 F2); the separator is added only when the spelling lacks one.
 */
function moveDestinations(move: MoveOperands): ShellOperand[] {
	const targetDir = move.destinationDir;
	if (!targetDir) return move.destination ? [move.destination] : [];
	const dir = targetDir.text;
	const separator =
		dir === "" || dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
	return move.sources.map((source) => ({
		text: dir + separator + basenameForOperand(source.text),
		tildeExpands: targetDir.tildeExpands,
	}));
}

/**
 * Find redirect targets without treating quoted `>` characters as syntax.
 *
 * Each target carries the offset it starts at, so the caller can attribute it
 * to the simple command that runs it and resolve a relative target against the
 * `cd` in effect for that segment (#2050 AC4).
 */
function extractRedirectTargets(
	command: string,
): Array<{ text: string; index: number }> {
	const targets: Array<{ text: string; index: number }> = [];
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
		if (target) targets.push({ text: target, index: i - target.length });
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
 *
 * #1649: `isRecordable` drops a file before its lines are counted, so a view
 * of a vendor or ignored file pays no read. Each file is counted once per
 * command (`head` and `tail` resolve a file twice).
 */
export function extractReadPathsFromCommand(
	command: string,
	cwd: string,
	isRecordable?: (abs: string) => boolean,
): ReadSpan[] {
	const spans: ReadSpan[] = [];
	const seen = new Set<string>();
	const totals = new Map<string, number>();

	const resolveFile = (
		token: ShellOperand,
	): { abs: string; total: number } | null => {
		const abs = resolveCandidate(token, cwd);
		if (!abs) return null;
		try {
			if (!nodeFs.statSync(abs).isFile()) return null;
		} catch {
			return null;
		}
		if (isRecordable && !isRecordable(abs)) return null;
		let total = totals.get(abs);
		if (total === undefined) {
			total = countFileLines(abs);
			totals.set(abs, total);
		}
		return { abs, total };
	};

	const addSpan = (token: ShellOperand, start: number, count: number) => {
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

	for (const range of tokenizeShellCommandWithRanges(command)) {
		const tokens = shellOperands(range);
		if (tokens.length === 0) continue;
		const verb = path.basename(tokens[0]?.text ?? "");
		const args = tokens.slice(1);

		if (["cat", "bat", "less", "more", "nl"].includes(verb)) {
			for (const a of args) addSpan(a, 1, Number.MAX_SAFE_INTEGER);
		} else if (verb === "head" || verb === "tail") {
			let count: number | undefined;
			const files: ShellOperand[] = [];
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a?.text === "-n" || a?.text === "-c") {
					const next = args[i + 1];
					if (next !== undefined) {
						count = parseCountFlag(next.text) ?? count;
						i++;
					}
				} else if (/^-n?\d+$/.test(a.text)) {
					count = parseCountFlag(a.text) ?? count;
				} else if (!a.text.startsWith("-")) {
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
			if (args.some((arg) => arg.text === "-i")) continue; // sed -i writes, not reads
			let range: { start: number; end: number } | undefined;
			for (const a of args) {
				const m = a.text.match(/^(\d+),(\d+)p$/);
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
	return args.some((token) => {
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
		const token = args[i] ?? "";
		if (token === "--") break;
		const nextToken = args[i + 1];

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

function extractGrepSearchFiles(args: ShellOperand[], cwd: string): string[] {
	const files: string[] = [];
	let patternSeen = false;
	let endOfOptions = false;
	for (let i = 0; i < args.length; i++) {
		const operand = args[i];
		if (!operand) continue;
		const token = operand.text;
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
		const abs = resolveCandidate(operand, cwd);
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
	// Grep prints shell-expanded filenames. A leading tilde in OUTPUT is
	// literal bytes, not an operand whose quoting can be recovered.
	const abs = resolveCandidate({ text: match[1], tildeExpands: false }, cwd);
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
	for (const token of args) {
		if (token.startsWith("-")) continue;
		// A `q` command anchored at the start of the script or after a `;`/
		// newline separator, optionally preceded by a numeric/`$` address
		// (`q`, `1q`, `$q`, `1,3p;q`). Deliberately not a full sed parser.
		if (/(^|[;\n])\s*(\d+|\$)?\s*q\b/.test(token)) return true;
	}
	return false;
}

function isLineDroppingTailCommand(tokens: string[]): boolean {
	const verb = path.basename(tokens[0] ?? "");
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
	ranges: readonly ShellSegmentRange[],
	words: readonly ShellOperand[][],
	index: number,
): boolean {
	if (ranges[index]?.segment.terminator !== "pipe") return false;
	for (let j = index + 1; j < ranges.length; j++) {
		if (isLineDroppingTailCommand((words[j] ?? []).map((w) => w.text)))
			return true;
		if (ranges[j]?.segment.terminator !== "pipe") return false;
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
	const ranges = tokenizeShellCommandWithRanges(command);
	// Each range's words, derived once: a pipeline of greps reads every later
	// range for a dropping tail.
	const words = ranges.map((range) => shellOperands(range));
	for (let i = 0; i < ranges.length; i++) {
		const operands = words[i] ?? [];
		const verb = path.basename(operands[0]?.text ?? "");
		if (verb !== "grep" && verb !== "egrep" && verb !== "fgrep") continue;
		const args = operands.slice(1).map((operand) => operand.text);
		if (!grepHasLineNumbers(args)) continue;
		hasLineNumberGrep = true;
		const segmentContext = parseGrepContextLines(args);
		context = context
			? {
					before: Math.min(context.before, segmentContext.before),
					after: Math.min(context.after, segmentContext.after),
				}
			: segmentContext;
		for (const file of extractGrepSearchFiles(operands.slice(1), cwd)) {
			files.add(file);
		}
		if (grepPipesIntoTruncatingTail(ranges, words, i)) truncated = true;
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
 * The directory a `cd`/`pushd` operand names, read from its word model
 * (#4713 R7-1, R8-2, R11), or `undefined` when bash's word is not known before
 * the shell runs it. Admitted: bash's own word after quote removal, starting
 * with a `PLAIN_PATH_START` character, with no `$`, backtick or backslash in
 * a double-quoted part, every unquoted character from `LITERAL_WORD_CHAR` (or
 * a `~` that begins its part), and a tilde bash expands only as `~` or `~/…`.
 * `~+1`, `~-`, `~user`, `$D` and an unquoted `*` name nothing; a quoted `'*'`
 * is the literal name bash enters.
 *
 * #2050 AC4: bash rewrites the working directory mid-command, so a relative
 * operand after a `cd` belongs to the directory it entered, not to the
 * directory the command started in.
 */
function cdOperandPath(
	word: ShellWord | undefined,
	cwd: string,
): string | undefined {
	const value = word && wordValue(word);
	if (!word || value === undefined || !PLAIN_PATH_START.test(value))
		return undefined;
	for (const part of word.parts) {
		const text = part.text;
		// Inside double quotes bash expands `$` and a backtick (`"s$D"`, R116),
		// and keeps a backslash the token text drops (`"s\ub"`, R50).
		if (
			(part.kind === "double" || part.kind === "locale") &&
			/[\\$`]/.test(text)
		)
			return undefined;
		// Unquoted, a `~` is literal unless it begins the word (the tilde rule
		// below) or follows an unquoted `=` (`cd a=~/x`, R73): one that begins
		// a later part follows a quote or an escape (`cd a""~`, R118).
		if (part.kind === "unquoted")
			for (const [index, ch] of [...text].entries())
				if (!LITERAL_WORD_CHAR.test(ch) && !(ch === "~" && index === 0))
					return undefined;
	}
	const tilde = word.tildeExpands;
	if (tilde && value !== "~" && !value.startsWith("~/")) return undefined;
	const operand = tilde ? normalizeHostToolPath(value) : value;
	return path.isAbsolute(operand) ? operand : path.resolve(cwd, operand);
}

/** What one bash command names: the files it writes, and the `cd` targets. */
export interface ShellWriteScan {
	/** Absolute paths the command writes or creates, in command order. */
	written: string[];
	/**
	 * Absolute directories the command's `cd`/`pushd` names, in command order,
	 * read from the words `directoryEffect` reads (#4713 R8-1). #2050: opaque recovery takes its baseline in each of these
	 * that is a checkout of the session's own repository, so a write in a
	 * linked worktree is recovered from THAT root.
	 */
	cdTargets: string[];
}

/**
 * Parse a bash command for the files it WROTE/created, so the read-guard can
 * treat them as authored by the agent (mirrors the Write tool), and for the
 * directories it `cd`ed into. Handles:
 *   redirects: `> FILE`, `>> FILE`, `N> FILE`, `&> FILE` (with or without space)
 *   tee [-a] FILE..., sed -i ... FILE, cp/mv/install ... DEST, touch FILE...,
 *   and common in-place formatter/fixer invocations with explicit file targets.
 *
 * Every operand resolves against the working directory in effect for ITS
 * segment, so `cd <dir> && echo x > f.ts` names `<dir>/f.ts` (#2050 AC4).
 *
 * That directory moves only where bash certainly moves it (#4713 round 4): see
 * {@link directoryEffect} for the admitted forms. A directory builtin in a
 * pipeline or a backgrounded list leaves it alone (bash ran it in a subshell);
 * anything else the scan cannot certify returns it to `cwd`, the pre-#2050
 * answer, for the rest of the command.
 *
 * Returns absolute paths. The file need not exist yet (it may be created) —
 * existence is confirmed later by recordWritten at tool_result time.
 */
export function scanShellWriteScopes(
	command: string,
	cwd: string,
): ShellWriteScan {
	const out = new Set<string>();
	const cdTargets: string[] = [];
	const seenCdTargets = new Set<string>();
	// The working directory in effect for the segment being read, which a `cd`
	// or `pushd` in an earlier segment moves.
	let effectiveCwd = cwd;
	// The `pushd` directory stack, holding only the pushes this scan admitted,
	// so a `popd` returns to the directory it restores (#4713 F1).
	const dirStack: string[] = [];
	// Set once the scan meets a directory change it cannot certify; from then
	// on every operand resolves against `cwd`, as before #2050.
	let fellBack = false;
	// Set when the current `&&` chain holds a move entered after `&&`: bash
	// made it only if the left side succeeded, which is certain inside the
	// chain (a later `&&` command runs only then) and unknowable past its end.
	let chainMove = false;
	const fallBack = () => {
		fellBack = true;
		effectiveCwd = cwd;
		dirStack.length = 0;
		chainMove = false;
	};
	const add = (token: ShellOperand) => {
		const abs = resolveCandidate(token, effectiveCwd);
		if (abs) out.add(abs);
	};
	// Every directory a `cd`/`pushd` names is a candidate recovery root,
	// whether or not the scan can certify that the shell stayed there.
	const nameCdTarget = (target: string | undefined) => {
		if (target && !seenCdTargets.has(target)) {
			seenCdTargets.add(target);
			cdTargets.push(target);
		}
	};

	// Redirect targets are collected by a quote-aware scanner. The shared
	// tokenizer supplies the normalized command arguments; it deliberately does
	// not expose shell redirection operators as arguments. Each target is
	// attributed to the segment whose range holds it, then resolved against the
	// `cd` in effect there. A substitution's own segments carry `end: -1` (its
	// offsets are relative to the substituted body), so a `>` inside a heredoc
	// body is not credited to this command at all.
	const redirects = extractRedirectTargets(command);
	let redirectCursor = 0;
	const ranges = tokenizeShellCommandWithRanges(command);
	const backgrounded = backgroundedRanges(ranges);
	// How the current simple command was entered (`seq` at list start), and its
	// ranges so far: a redirection's `&` splits one command into two ranges.
	let entry: ShellSegmentExit = "seq";
	let simpleCommand: ShellSegmentRange[] = [];
	for (const [rangeIndex, range] of ranges.entries()) {
		const { start: segmentStart, end: segmentEnd } = range;
		if (segmentEnd >= 0) {
			for (; redirectCursor < redirects.length; redirectCursor += 1) {
				const redirect = redirects[redirectCursor];
				if (!redirect || redirect.index > segmentEnd) break;
				// A heredoc body's offsets sit in the gap between two segments, so
				// the first segment after the body would otherwise claim its `>`
				// (#4713 F5).
				if (redirect.index < segmentStart) continue;
				// The target is read through the same word model as any operand,
				// so `> ''~/f.ts` names the literal `./~/f.ts` (#4713 R11), and
				// `> "C:\x\f.ts"` keeps the backslashes bash keeps (#4713 R12).
				// The raw scanner stops at every character that ends a range, so
				// the text is one range; it holds an open quote when the scanner
				// split a quoted name (`> "f.ts x"`), which names nothing.
				const [target] = tokenizeShellCommandWithRanges(redirect.text);
				if (target && !target.segment.unsupported)
					for (const operand of shellOperands(target)) add(operand);
			}
		}
		const tokens = shellOperands(range);
		const { verb, args } =
			tokens.length === 0
				? { verb: "", args: [] as ShellOperand[] }
				: unwrapCommand(tokens);

		if (verb === "tee" || verb === "touch") {
			for (const a of args) if (!a.text.startsWith("-")) add(a);
		} else if (verb === "sed" && args.some((arg) => arg.text === "-i")) {
			for (const a of args) add(a);
		} else if (verb === "cp" || verb === "mv" || verb === "install") {
			// Both GNU orders name a destination: the plain form its trailing
			// operand, `-t DIR` one destination per source (#5378).
			for (const target of moveDestinations(moveOperands(args))) add(target);
		} else if (verb === "biome") {
			const sub = args[0]?.text;
			if (
				(sub === "format" || sub === "check") &&
				args.some((arg) => arg.text === "--write")
			) {
				for (const file of formatterFileArgs(
					args,
					1,
					new Set(["--config-path"]),
				))
					add(file);
			}
		} else if (
			verb === "prettier" &&
			args.some((arg) => arg.text === "--write")
		) {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--config", "--ignore-path", "--parser", "--plugin"]),
			))
				add(file);
		} else if (verb === "eslint" && args.some((arg) => arg.text === "--fix")) {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--config", "--ignore-path", "--parser", "--plugin"]),
			))
				add(file);
		} else if (verb === "ruff") {
			const sub = args[0]?.text;
			if (sub === "format" || args.some((arg) => arg.text === "--fix")) {
				const start = sub === "format" || sub === "check" ? 1 : 0;
				for (const file of formatterFileArgs(
					args,
					start,
					new Set(["--config"]),
				))
					add(file);
			}
		} else if (verb === "gofmt" && args.some((arg) => arg.text === "-w")) {
			for (const file of formatterFileArgs(args)) add(file);
		} else if (verb === "cargo" && args[0]?.text === "fmt") {
			// Bare cargo fmt is project-scoped and cannot be enumerated without a
			// filesystem walk. Only explicit rustfmt operands after `--` are safe.
			const separator = args.findIndex((arg) => arg.text === "--");
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
		} else if (
			verb === "clang-format" &&
			args.some((arg) => arg.text === "-i")
		) {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--style", "--fallback-style", "--assume-filename"]),
			))
				add(file);
		} else if (verb === "dotnet" && args[0]?.text === "format") {
			// dotnet format is normally solution-scoped. `--include` is the one
			// invocation form that provides attributable source paths.
			for (let i = 1; i < args.length; i += 1) {
				if (args[i]?.text === "--include" && args[i + 1]) {
					for (const file of (args[i + 1]?.text ?? "").split(","))
						add({
							text: file,
							tildeExpands: args[i + 1]?.tildeExpands === true,
						});
					i += 1;
				} else if (args[i]?.text.startsWith("--include=")) {
					for (const file of (args[i]?.text ?? "")
						.slice("--include=".length)
						.split(","))
						add({ text: file, tildeExpands: args[i]?.tildeExpands === true });
				}
			}
		} else if (verb === "git") {
			// git ops that REWRITE working-tree files with explicit paths:
			//   git checkout [<ref>] -- <files>   git restore [opts] <files>
			// These restore content but never go through the edit tool, so without
			// this pi-lens keeps stale diagnostics/fileSeq for the restored file.
			// Whole-tree ops (reset --hard, stash pop, revert, merge, rebase, pull,
			// or `git checkout <branch>`) don't name files and aren't handled here.
			const sub = args[0]?.text;
			if (sub === "checkout" || sub === "restore") {
				const dashDash = args.findIndex((arg) => arg.text === "--");
				const fileArgs =
					dashDash >= 0
						? args.slice(dashDash + 1)
						: sub === "restore"
							? args.slice(1).filter((a) => !a.text.startsWith("-"))
							: []; // `git checkout` without `--` is ambiguous (ref vs path)
				for (const a of fileArgs) add(a);
			} else if (sub === "mv") {
				// git mv — the destination is a write, exactly like plain `mv`
				// above (#1668 review F2, both argument orders since #5378). The
				// source side is a delete, handled by
				// extractDeletedPathsFromCommand.
				for (const target of moveDestinations(moveOperands(args.slice(1))))
					add(target);
			}
		}
		// A heredoc's substitution runs in a subshell and joins no list: it
		// names a directory, and moves none.
		if (segmentEnd < 0) {
			nameCdTarget(directoryEffect([range], effectiveCwd).named);
			continue;
		}
		simpleCommand.push(range);
		if (range.exit === "redirect") continue;
		const exit = range.exit;
		const effect = directoryEffect(simpleCommand, effectiveCwd);
		simpleCommand = [];
		nameCdTarget(effect.named);
		const previousEntry = entry;
		entry = exit;
		if (fellBack || effect.kind === "none") {
			// No directory change of its own.
		} else if (effect.kind === "construct") {
			fallBack();
		} else if (
			previousEntry === "pipe" ||
			exit === "pipe" ||
			backgrounded[rangeIndex]
		) {
			// A pipeline member or a backgrounded list runs in a subshell: its
			// directory change never reaches the next command.
		} else if (
			previousEntry === "or" ||
			exit === "or" ||
			effect.kind === "unknown"
		) {
			// A move is certain only when entered at list start or after
			// `&&`/`;`/newline/`&` and ended by `&&`/`;`/newline/the end, in a
			// form the scan reads; anything else falls back.
			fallBack();
		} else if (effect.kind === "move") {
			if (effect.push) dirStack.push(effectiveCwd);
			effectiveCwd = effect.target;
			if (previousEntry === "and") chainMove = true;
		} else {
			const restored = dirStack.pop();
			if (restored === undefined) fallBack();
			else {
				effectiveCwd = restored;
				if (previousEntry === "and") chainMove = true;
			}
		}
		// Only `&&` and `|` continue the chain; past its end the move it holds
		// may never have happened (#4713 R5-1).
		if (chainMove && exit !== "and" && exit !== "pipe") fallBack();
	}

	return { written: Array.from(out), cdTargets };
}

/** Bash reserved words: a command starting with one opens or closes a construct. */
const SHELL_RESERVED_WORDS: ReadonlySet<string> = new Set([
	"!",
	"[[",
	"]]",
	"{",
	"}",
	"case",
	"coproc",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"select",
	"then",
	"time",
	"until",
	"while",
]);

/**
 * Builtins that run shell text in the current shell or change how a later
 * word resolves, so the directory after them is not knowable statically.
 */
const SHELL_CODE_BUILTINS: ReadonlySet<string> = new Set([
	".",
	"alias",
	"builtin",
	"command",
	"enable",
	"eval",
	"shopt",
	"source",
	"trap",
]);

/** The first character of an operand bash reads as a directory path. */
const PLAIN_PATH_START = /^[A-Za-z0-9_./~]/;

/** A bash assignment word's name and `=`, when bash reads them unquoted. */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

type DirectoryEffect = (
	| { kind: "none" }
	| { kind: "construct" }
	| { kind: "unknown" }
	| { kind: "move"; target: string; push: boolean }
	| { kind: "pop" }
) & {
	/**
	 * The directory a `cd`/`pushd` names, whether or not the move is certain:
	 * a recovery-root candidate (#2050, the `cdTargets` list).
	 */
	named?: string | undefined;
};

/**
 * What one simple command does to the shell's directory, read as a positive
 * list (#4713 round 4). Admitted: `cd DIR` and `pushd DIR` with exactly one
 * statically resolvable plain path operand (see `cdOperandPath`), and a bare
 * `popd`, each the name bash runs (`wordValue`) once leading assignments and
 * redirections are set aside.
 * A command whose first word is a plain word naming none of the directory or
 * shell-text builtins is `none`. A reserved word or an unquoted grouping
 * character is a `construct`; every other form is `unknown`.
 *
 * `named` reads the same words more loosely (#4713 R8-1): a `builtin` or
 * `command` prefix, an option before the operand or a second operand still
 * name the directory, which the move rule leaves `unknown`. Every quoting
 * question is asked of the word model (#4713 R11), never of the token text.
 */
function directoryEffect(
	ranges: readonly ShellSegmentRange[],
	cwd: string,
): DirectoryEffect {
	const words: ShellWord[] = [];
	for (const range of ranges)
		for (const [index, word] of range.words.entries())
			if (range.redirectWords[index] !== true) words.push(word);
	// Bash takes `NAME=value` as an assignment only when the name and `=` are
	// unquoted; `'FOO=bar' cd sub` and `FOO""=bar cd sub` run a command named
	// `FOO=bar` (#4713 R8-3, R10).
	let first = 0;
	while (
		words[first]?.parts[0]?.kind === "unquoted" &&
		ASSIGNMENT_PREFIX.test(words[first]?.parts[0]?.text ?? "")
	)
		first++;
	// The name bash looks each word up by (#4713 R11): `\c""d` is `cd`.
	const names = words.map((word) => wordValue(word));
	let at = first;
	while (names[at] === "builtin" || names[at] === "command") at++;
	let named: string | undefined;
	if (names[at] === "cd" || names[at] === "pushd")
		named = cdOperandPath(
			words.find((_, i) => i > at && names[i]?.startsWith("-") !== true),
			cwd,
		);
	if (ranges.some((range) => range.grouping))
		return { kind: "construct", named };
	if (first >= words.length) return { kind: "none" };
	const verb = names[first];
	if (verb === undefined) return { kind: "unknown", named };
	// An empty command name (`'' cd sub`) is a command bash cannot find, so it
	// changes no directory (#4713 R12).
	if (verb === "") return { kind: "none" };
	if (SHELL_RESERVED_WORDS.has(verb)) return { kind: "construct" };
	const operands = words.slice(first + 1);
	if (verb === "cd" || verb === "pushd") {
		// The directory moves only on one plain path operand (#4713 R7-1):
		// `named` is then that operand. Every other form (a stack index or
		// option, `~+1`, `~user`, `$D`, a glob, a prefix) falls back.
		return operands.length === 1 && named
			? { kind: "move", target: named, push: verb === "pushd", named }
			: { kind: "unknown", named };
	}
	if (verb === "popd")
		return operands.length === 0 ? { kind: "pop" } : { kind: "unknown" };
	if (SHELL_CODE_BUILTINS.has(verb) || !/^[\w./+@%:,~[\]-]+$/.test(verb))
		return { kind: "unknown", named };
	return { kind: "none" };
}

/**
 * Per range: whether its list ends in a lone `&`, so bash ran every command of
 * that list in a background subshell.
 */
function backgroundedRanges(ranges: readonly ShellSegmentRange[]): boolean[] {
	const backgrounded = ranges.map(() => false);
	let listStart = 0;
	for (const [index, range] of ranges.entries()) {
		if (range.end < 0) continue;
		if (
			range.exit !== "seq" &&
			range.exit !== "background" &&
			range.exit !== "end"
		)
			continue;
		if (range.exit === "background")
			for (let k = listStart; k <= index; k += 1) backgrounded[k] = true;
		listStart = index + 1;
	}
	return backgrounded;
}

/**
 * The files a bash command WROTE/created. Thin reading of
 * {@link scanShellWriteScopes}, which is the one place the command is walked.
 */
export function extractWrittenPathsFromCommand(
	command: string,
	cwd: string,
): string[] {
	return scanShellWriteScopes(command, cwd).written;
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
	const add = (token: ShellOperand) => {
		const abs = resolveCandidate(token, cwd);
		if (abs) out.add(abs);
	};
	// mv SRC... DEST / mv -t DIR SRC... / git mv — every moved operand vanishes
	// from its original path once the move lands. `moveOperands` reads both GNU
	// argument orders (#5378: the `-t DIR` form names the destination FIRST).
	const addMoveSources = (args: ShellOperand[]) => {
		for (const src of moveOperands(args).sources) add(src);
	};

	for (const range of tokenizeShellCommandWithRanges(command)) {
		const tokens = shellOperands(range);
		if (tokens.length === 0) continue;
		const verb = path.basename(tokens[0]?.text ?? "");
		const args = tokens.slice(1);

		if (verb === "rm") {
			for (const a of args) if (!a.text.startsWith("-")) add(a);
		} else if (verb === "git" && args[0]?.text === "rm") {
			const rmArgs = args.slice(1);
			const dashDash = rmArgs.findIndex((arg) => arg.text === "--");
			const fileArgs =
				dashDash >= 0
					? rmArgs.slice(dashDash + 1)
					: rmArgs.filter((a) => !a.text.startsWith("-"));
			for (const a of fileArgs) add(a);
		} else if (verb === "git" && args[0]?.text === "mv") {
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
 * this function, so the answer is written once — but the call sites
 * themselves are not yet pinned (W4/M8, #2939), so a future tool-name gate
 * re-introduced at one of them would still pass the suite.
 *
 * A result is edit-class when the mutation seam classifies it, or when its
 * `input.command` names written files. The command half carries no tool-name
 * gate on purpose: a shell that wrote files runs the same pipeline whatever
 * its tool is named, and the edit budget must cover that work.
 *
 * #5248: a pi-lens tool that reports the files it wrote (`details.appliedFiles`,
 * `appliedFilesOfOwnTool`) is edit-class too. Its dispatch runs once per file,
 * so the read-only wall abandoned a multi-file rename or replace after the
 * first file, and the commit gate ran before the rest published a verdict.
 */
export function isEditClassToolResult(
	event: {
		toolName?: string;
		input?: { command?: unknown };
		details?: unknown;
	},
	cwd: string,
): boolean {
	if (classifyMutatingTool(event, { recognizeOnly: true }) !== undefined) {
		return true;
	}
	if (appliedFilesOfOwnTool(event).length > 0) return true;
	const command = event?.input?.command;
	return (
		typeof command === "string" &&
		extractWrittenPathsFromCommand(command, cwd).length > 0
	);
}

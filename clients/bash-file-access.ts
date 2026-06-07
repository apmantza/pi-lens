/**
 * Parse bash commands for the file access the agent performed, so the read-guard
 * stays consistent with how the Read/Write tools are tracked:
 *
 *   - VIEW commands (cat/head/tail/sed -n) → reads, recorded with the exact line
 *     range shown (like the Read tool's delivered range).
 *   - WRITE commands (redirects, tee, sed -i, cp/mv dest, touch) → the agent
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
import { countFileLines } from "./read-guard-tool-lines.js";

/** A contiguous range of lines a bash command showed the agent. */
export interface ReadSpan {
	filePath: string;
	/** 1-based first line read. */
	offset: number;
	/** Number of lines read. */
	limit: number;
}

// Source-ish extensions worth registering. Anchored end-check → linear (no
// catastrophic backtracking).
const READABLE_EXT_RE =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|rs|go|cs|java|kt|rb|php|c|cpp|cc|h|hpp|json|jsonc|yaml|yml|toml|md|txt|env|cfg|conf|ini|html|css|scss|less|xml|sql|vue|svelte)$/i;

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

/** Resolve a token to an absolute path if it looks like a source file. */
function resolveCandidate(token: string, cwd: string): string | null {
	const cleaned = stripQuotes(token);
	if (!cleaned || cleaned.startsWith("-") || !READABLE_EXT_RE.test(cleaned)) {
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

function splitSegments(command: string): string[] {
	return command.split(/&&|\|\||[;|\n]/);
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

	for (const rawSegment of splitSegments(command)) {
		const segment = rawSegment.trim();
		if (!segment) continue;
		const tokens = segment.split(/\s+/);
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
			for (const a of args) addSpan(a, range.start, range.end - range.start + 1);
		}
	}

	return spans;
}

/**
 * Extract files a bash command WROTE/created, so the read-guard can treat them
 * as authored by the agent (mirrors the Write tool). Handles:
 *   redirects: `> FILE`, `>> FILE`, `N> FILE`, `&> FILE` (with or without space)
 *   tee [-a] FILE...,  sed -i ... FILE,  cp/mv/install ... DEST,  touch FILE...
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

	for (const rawSegment of splitSegments(command)) {
		const segment = rawSegment.trim();
		if (!segment) continue;

		// Redirect targets: the token after `>` / `>>` (optionally prefixed by a
		// file descriptor like `2>` or `&>`, with or without a space).
		for (const m of segment.matchAll(/>>?\s*([^\s>|&]+)/g)) add(m[1]);

		const tokens = segment.split(/\s+/);
		const verb = path.basename(tokens[0] ?? "");
		const args = tokens.slice(1);

		if (verb === "tee" || verb === "touch") {
			for (const a of args) if (!a.startsWith("-")) add(a);
		} else if (verb === "sed" && args.includes("-i")) {
			for (const a of args) add(a);
		} else if (verb === "cp" || verb === "mv" || verb === "install") {
			const files = args.filter((a) => !a.startsWith("-"));
			if (files.length >= 1) add(files[files.length - 1]); // destination
		}
	}

	return Array.from(out);
}

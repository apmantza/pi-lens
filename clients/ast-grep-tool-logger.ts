/**
 * NDJSON telemetry for the agent-facing ast_grep_search / ast_grep_replace
 * tools. Captures inputs, outcome, and failure category so we can answer:
 *
 *   - How often do agents hit "Multiple AST nodes" with multi-line patterns?
 *   - Which language emits which failure most often?
 *   - Do retries (post-skill-read) succeed within the same session?
 *   - Which patterns keep getting tried and keep failing?
 *
 * Mirrors `actionable-warnings-logger.ts` for shape + rotation behaviour.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";

const AG_LOG_DIR = getGlobalPiLensDir();
const AG_LOG_FILE = path.join(AG_LOG_DIR, "ast-grep-tools.log");
const AG_LOG_BACKUP_FILE = path.join(AG_LOG_DIR, "ast-grep-tools.log.1");
const MAX_LOG_BYTES = Math.max(
	128 * 1024,
	Number.parseInt(
		process.env.PI_LENS_AST_GREP_LOG_MAX_BYTES ?? "1048576",
		10,
	) || 1048576,
);

try {
	if (!fs.existsSync(AG_LOG_DIR)) {
		fs.mkdirSync(AG_LOG_DIR, { recursive: true });
	}
} catch (err) {
	void err;
}

export type AstGrepToolName = "ast_grep_search" | "ast_grep_replace";

export type AstGrepToolOutcome = "success" | "no_matches" | "error";

export type AstGrepErrorKind =
	| "multiple_ast_nodes"
	| "cannot_parse_query"
	| "tool_not_found"
	| "timeout"
	| "json_parse_failed"
	| "other";

export interface AstGrepToolEvent {
	tool: AstGrepToolName;
	sessionId?: string;
	lang: string;
	pattern: string;
	patternLineCount: number;
	rewrite?: string;
	rewriteLineCount?: number;
	pathsCount: number;
	applied?: boolean;
	outcome: AstGrepToolOutcome;
	errorKind?: AstGrepErrorKind;
	errorRaw?: string;
	matchCount: number;
	truncated: boolean;
	durationMs: number;
}

const PATTERN_TRUNCATE_AT = 500;
const ERROR_TRUNCATE_AT = 300;

function truncate(value: string | undefined, max: number): string | undefined {
	if (value === undefined) return undefined;
	if (value.length <= max) return value;
	return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

function countLines(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (value.length === 0) return 0;
	let lines = 1;
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

/**
 * Categorise an error string from the sg-runner / spawn layer. Looks first
 * at the friendly wrappers sg-runner.ts emits (which already contain the
 * original stderr); falls back to raw stderr substring checks for codepaths
 * that don't go through that wrapper.
 */
export function classifyAstGrepError(
	errorMessage: string | undefined,
): AstGrepErrorKind {
	if (!errorMessage) return "other";
	const lower = errorMessage.toLowerCase();
	if (
		lower.includes("multiple ast nodes are detected") ||
		lower.includes("the pattern appears to contain multiple ast nodes")
	) {
		return "multiple_ast_nodes";
	}
	if (
		lower.includes("cannot parse query") ||
		lower.includes("pattern syntax error") ||
		lower.includes("could not be parsed as valid code")
	) {
		return "cannot_parse_query";
	}
	if (
		lower.includes("cli not found") ||
		lower.includes("enoent") ||
		lower.includes("not installed")
	) {
		return "tool_not_found";
	}
	if (lower.includes("timed out") || lower.includes("timeout")) {
		return "timeout";
	}
	if (lower.includes("failed to parse output")) {
		return "json_parse_failed";
	}
	return "other";
}

/**
 * Map a classified error kind to a one-line, agent-facing remediation hint.
 *
 * The runner layer (sg-runner.ts) already wraps the two highest-frequency
 * spawn errors — "Multiple AST nodes" and "Cannot parse query" — with curated
 * multi-line guidance, so those return `null` here (don't double up). This
 * closes the loop for the categories that otherwise reach the agent as raw
 * stderr (`other`/`timeout`/`tool_not_found`/`json_parse_failed`): we already
 * classify them for telemetry, so reuse that classification to help the agent
 * self-correct on the error path the way getPatternHint() does on zero-matches.
 */
export function astGrepRemediationHint(kind: AstGrepErrorKind): string | null {
	switch (kind) {
		case "multiple_ast_nodes":
		case "cannot_parse_query":
			// Error text already carries curated guidance from sg-runner.ts.
			return null;
		case "tool_not_found":
			return "Hint: the ast-grep CLI is missing or not on PATH — install it with `npm i -D @ast-grep/cli`.";
		case "timeout":
			return "Hint: the operation timed out — scope `paths` to specific files/folders, or narrow the pattern.";
		case "json_parse_failed":
			return "Hint: ast-grep produced output that could not be parsed — retry with a simpler pattern; the installed CLI version may be incompatible.";
		default:
			return "Hint: verify the pattern is a single valid AST node for this `lang` (use ast_grep_dump to discover node kinds), or fall back to grep for plain-text search.";
	}
}

function rotateIfNeeded(): void {
	try {
		if (!fs.existsSync(AG_LOG_FILE)) return;
		const size = fs.statSync(AG_LOG_FILE).size;
		if (size < MAX_LOG_BYTES) return;
		try {
			fs.rmSync(AG_LOG_BACKUP_FILE, { force: true });
		} catch (err) {
			void err;
		}
		fs.renameSync(AG_LOG_FILE, AG_LOG_BACKUP_FILE);
	} catch (err) {
		void err;
	}
}

export function logAstGrepToolEvent(
	event: Omit<
		AstGrepToolEvent,
		"pattern" | "rewrite" | "errorRaw"
	> & {
		pattern: string;
		rewrite?: string;
		errorRaw?: string;
	},
): void {
	if (isTestMode()) return;
	const payload: AstGrepToolEvent = {
		...event,
		pattern: truncate(event.pattern, PATTERN_TRUNCATE_AT) ?? "",
		patternLineCount: event.patternLineCount,
		rewrite: truncate(event.rewrite, PATTERN_TRUNCATE_AT),
		rewriteLineCount: event.rewriteLineCount,
		errorRaw: truncate(event.errorRaw, ERROR_TRUNCATE_AT),
	};
	const line = `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`;
	try {
		rotateIfNeeded();
		fs.appendFileSync(AG_LOG_FILE, line);
	} catch (err) {
		void err;
	}
}

export function getAstGrepToolLogPath(): string {
	return AG_LOG_FILE;
}

export { countLines as _countLinesForTest };

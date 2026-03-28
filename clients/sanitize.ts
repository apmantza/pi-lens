/**
 * Tool Output Sanitization for pi-lens
 *
 * Cleans and normalizes tool output for display to users.
 * Removes ANSI codes, extracts key error messages, etc.
 */

// --- Constants ---

// ANSI escape codes for colors and formatting
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ANSI_ESCAPE_EXTENDED = /\x1b\[[0-9;]*[A-Za-z]/g;

// Common error patterns from different tools
const ERROR_INDICATORS = [
	/\berror\b/i,
	/\bfailed\b/i,
	/\bfatal\b/i,
	/\binvalid\b/i,
	/\bunexpected\b/i,
	/\bexpected\b/i,
	/\bsyntax\b/i,
	/\bcannot find\b/i,
	/\bnot found\b/i,
	/\bno such\b/i,
];

// Patterns that indicate a line is a "detail" rather than an error
const DETAIL_PATTERNS = [
	/^help wanted/i,
	/^note:/i,
	/^hint:/i,
	/^→/,
	/^\s*at\s+/, // Stack traces
	/^ {4}/, // Indented continuation
];

// --- Core Sanitization Functions ---

/**
 * Remove ANSI escape sequences from a string.
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE, "").replace(ANSI_ESCAPE_EXTENDED, "");
}

/**
 * Normalize whitespace in a string.
 * Collapses multiple spaces/tabs to single space, trims lines.
 */
export function normalizeWhitespace(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line.length > 0)
		.join("\n");
}

/**
 * Check if a line contains error indicators.
 */
function isErrorLine(line: string): boolean {
	const cleanLine = stripAnsi(line).trim();
	return ERROR_INDICATORS.some((pattern) => pattern.test(cleanLine));
}

/**
 * Check if a line is a "detail" line (continuation, stack trace, etc.)
 * that shouldn't be shown as a standalone error.
 */
function isDetailLine(line: string): boolean {
	const cleanLine = stripAnsi(line).trim();
	return DETAIL_PATTERNS.some((pattern) => pattern.test(cleanLine));
}

/**
 * Sanitize a single line of tool output.
 * Removes ANSI codes and normalizes common patterns.
 */
export function sanitizeLine(line: string): string {
	return stripAnsi(line)
		.replace(/^\s*\[error\]\s*/i, "")
		.replace(/^\s*error:\s*/i, "")
		.replace(/^\s*[×✖✘✗]\s*/u, "")
		.replace(/^\s*[✓✔]\s*/u, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Sanitize multi-line tool output.
 * Returns cleaned lines, filtered to relevant content.
 */
export function sanitizeOutput(output: string): string {
	if (!output || typeof output !== "string") {
		return "";
	}

	const lines = output.split(/\r?\n/);

	const sanitized = lines
		.map((line) => sanitizeLine(line))
		.filter((line) => line.length > 0)
		.filter((line) => !isDetailLine(line));

	return sanitized.join("\n");
}

/**
 * Extract the most relevant error message from tool output.
 * Returns the first line that contains error indicators, or the first non-empty line.
 */
export function extractErrorMessage(output: string): string | undefined {
	if (!output || typeof output !== "string") {
		return undefined;
	}

	const lines = output
		.split(/\r?\n/)
		.map((line) => sanitizeLine(line))
		.filter((line) => line.length > 0);

	if (lines.length === 0) {
		return undefined;
	}

	// Find first line with error indicators
	const errorLine = lines.find((line) => isErrorLine(line));
	if (errorLine) {
		return errorLine;
	}

	// Fall back to first non-detail line
	const firstMain = lines.find((line) => !isDetailLine(line));
	return firstMain;
}

/**
 * Truncate a message to a maximum length, adding ellipsis if needed.
 */
export function truncateMessage(
	message: string,
	maxLength: number = 140,
): string {
	if (message.length <= maxLength) {
		return message;
	}
	return `${message.slice(0, maxLength - 1)}…`;
}

// --- Tool-Specific Sanitizers ---

/**
 * Sanitize TypeScript/LSP diagnostic output.
 */
export function sanitizeTsDiagnostic(output: string): string {
	if (!output) return "";

	// TypeScript errors often look like:
	// error TS2322: Type 'string' is not assignable to type 'number'.
	// or:
	// src/file.ts(10,5): error TS2322: ...

	const lines = output
		.split(/\r?\n/)
		.map((line) => stripAnsi(line))
		.filter((line) => line.length > 0)
		// Filter out non-error lines
		.filter((line) => line.includes("error TS") || line.includes("warning TS"));

	// If we have file:line:col format errors, extract those
	const fileErrors = lines
		.filter((line) => /^.+?\([\d,]+\):/.test(line))
		.map((line) => {
			// Extract file:line:col from the beginning
			const match = line.match(/^(.+?\([\d,]+\):)\s*(.+)/);
			if (match) {
				return `${match[1]} ${match[2].trim()}`;
			}
			return line.trim();
		});

	if (fileErrors.length > 0) {
		return fileErrors.slice(0, 10).join("\n");
	}

	// Otherwise just return error lines
	return lines.slice(0, 5).join("\n");
}

// --- Helper Functions ---

/**
 * Extract error/warning lines from tool output.
 * Filters and formats lines containing diagnostic information.
 */
function extractDiagnosticLines(
	output: string,
	predicate: (line: string) => boolean,
	maxLines: number = 10,
): string {
	if (!output) return "";

	return output
		.split(/\r?\n/)
		.map((line) => stripAnsi(line))
		.filter((line) => line.length > 0)
		.filter(predicate)
		.slice(0, maxLines)
		.join("\n");
}

/**
 * Format JSON diagnostics array into readable output.
 */
function formatJsonDiagnostics(
	diags: any[],
	formatter: (d: any) => string,
): string {
	return diags.slice(0, 10).map(formatter).join("\n");
}

// --- Tool-Specific Sanitizers ---

/**
 * Sanitize Rust cargo output.
 */
export function sanitizeRustOutput(output: string): string {
	if (!output) return "";

	return extractDiagnosticLines(output, (line) => {
		const clean = stripAnsi(line);
		return (
			isErrorLine(clean) || /^\s*-->\s+/.test(clean) // rustc source locations
		);
	});
}

/**
 * Sanitize Go vet output.
 */
export function sanitizeGoOutput(output: string): string {
	if (!output) return "";

	return extractDiagnosticLines(output, (line) => {
		const clean = stripAnsi(line);
		return /^\.\/|\.go:/.test(clean) || isErrorLine(clean);
	});
}

/**
 * Sanitize Biome output.
 */
export function sanitizeBiomeOutput(output: string): string {
	if (!output) return "";

	try {
		const data = JSON.parse(output);
		if (data.diagnostics && Array.isArray(data.diagnostics)) {
			return formatJsonDiagnostics(data.diagnostics, (d: any) => {
				const loc = d.location;
				const file = loc?.path ? `${loc.path}` : "";
				const line = loc?.span?.start?.line ?? 0;
				const msg = d.message || "";
				return file ? `${file}:${line + 1} ${msg}` : msg;
			});
		}
	} catch (err) {
		void err;
		// Not JSON, fall through to text processing
	}

	// Text output processing
	return extractDiagnosticLines(output, (line) => {
		const clean = stripAnsi(line);
		return isErrorLine(clean) || clean.includes("hint");
	});
}

/**
 * Sanitize Ruff output.
 */
export function sanitizeRuffOutput(output: string): string {
	if (!output) return "";

	try {
		const data = JSON.parse(output);
		if (Array.isArray(data)) {
			return formatJsonDiagnostics(data, (d: any) => {
				const row = d.location?.row ?? 0;
				const col = d.location?.column ?? 0;
				const code = d.code || "";
				const msg = d.message || "";
				return `${row}:${col} [${code}] ${msg}`;
			});
		}
	} catch (err) {
		void err;
		// Not JSON, fall through
	}

	// Text output
	return extractDiagnosticLines(output, (line) => {
		const clean = stripAnsi(line);
		return isErrorLine(clean) || /\[(E|W)\d+\]/.test(clean);
	});
}

// --- Summary Generator ---

export interface SanitizedResult {
	summary: string | undefined;
	details: string | undefined;
	truncated: boolean;
}

/**
 * Sanitize tool output and return both a summary and full details.
 * Summary is the first error line, details is the full cleaned output.
 */
export function sanitizeToolOutput(
	output: string,
	maxSummaryLength: number = 140,
): SanitizedResult {
	if (!output || typeof output !== "string") {
		return { summary: undefined, details: undefined, truncated: false };
	}

	const sanitized = sanitizeOutput(output);
	const lines = sanitized.split("\n").filter((l) => l.length > 0);

	if (lines.length === 0) {
		return { summary: undefined, details: undefined, truncated: false };
	}

	// Summary: first line with error indicators, or first line
	const summary = extractErrorMessage(output);
	const truncatedSummary = truncateMessage(
		summary ?? lines[0],
		maxSummaryLength,
	);

	// Details: all lines up to a reasonable limit
	const MAX_DETAIL_LINES = 20;
	const detailsLines = lines.slice(0, MAX_DETAIL_LINES);
	const details = detailsLines.join("\n");
	const truncated = lines.length > MAX_DETAIL_LINES;

	return {
		summary: truncatedSummary,
		details: truncated
			? `${details}\n... and ${lines.length - MAX_DETAIL_LINES} more lines`
			: details,
		truncated,
	};
}

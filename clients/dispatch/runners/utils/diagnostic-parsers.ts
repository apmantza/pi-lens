/**
 * Shared diagnostic output parsers for pi-lens runners
 *
 * Common patterns for parsing tool output into standardized diagnostics.
 * Supports the common `file:line:col: message` format used by most linters.
 */

import { getAutofixCapability } from "../../../tool-policy.js";
import type { DefectClass, Diagnostic } from "../../types.js";

export interface LineParserConfig {
	/** Tool name for diagnostic identification */
	tool: string;
	/** Regex pattern to match lines. Must capture: [fullMatch, file?, line?, col?, ...messageParts] */
	regex: RegExp;
	/** Extract message from regex match groups */
	extractMessage: (match: RegExpMatchArray) => string;
	/** Extract rule/code from regex match groups (optional) */
	extractRule?: (match: RegExpMatchArray) => string | undefined;
	/** Generate diagnostic ID from match */
	generateId: (match: RegExpMatchArray) => string;
	/** Determine severity from line content or match (defaults to warning) */
	getSeverity?: (
		line: string,
		match: RegExpMatchArray,
	) => "error" | "warning" | "info";
	/** Whether this diagnostic is fixable (defaults to false) */
	fixable?: boolean | ((match: RegExpMatchArray) => boolean);
	/** Whether safe pipeline autofix is available */
	autoFixAvailable?: boolean | ((match: RegExpMatchArray) => boolean);
	/** How the fix is expected to be applied */
	fixKind?:
		| Diagnostic["fixKind"]
		| ((match: RegExpMatchArray) => Diagnostic["fixKind"]);
	/**
	 * Override the auto-classified defect class. Setting this is preferred for
	 * tools whose typical messages don't contain the keywords classifyDefect
	 * scans for (e.g. go-vet, mypy) — without it, diagnostics fall through to
	 * "unknown" and dedup against LSP diagnostics may collide.
	 */
	defectClass?: DefectClass;
	/** Strip ANSI escape codes before parsing (defaults to true) */
	stripAnsi?: boolean;
}

/**
 * Create a parser for line-based tool output.
 * Common format: file:line:col: message (with variations)
 */
export function createLineParser(config: LineParserConfig) {
	return (raw: string, filePath: string): Diagnostic[] => {
		const diagnostics: Diagnostic[] = [];

		// Optionally strip ANSI codes (for tools that output colored text)
		const clean =
			config.stripAnsi !== false ? raw.replace(/\x1b\[[0-9;]*m/g, "") : raw;

		const lines = clean.split("\n").filter((l) => l.trim());

		for (const line of lines) {
			const match = line.match(config.regex);
			if (!match) continue;

			const lineNum = parseInt(match[2], 10);
			const colNum = parseInt(match[3], 10);

			const severity = config.getSeverity
				? config.getSeverity(line, match)
				: "warning";

			const fixable =
				typeof config.fixable === "function"
					? config.fixable(match)
					: (config.fixable ?? false);
			const autoFixAvailable =
				typeof config.autoFixAvailable === "function"
					? config.autoFixAvailable(match)
					: (config.autoFixAvailable ?? false);
			const fixKind =
				typeof config.fixKind === "function"
					? config.fixKind(match)
					: config.fixKind;

			diagnostics.push({
				id: config.generateId(match),
				message: config.extractMessage(match),
				filePath,
				line: lineNum,
				column: colNum,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: config.tool,
				rule: config.extractRule?.(match),
				defectClass: config.defectClass,
				fixable,
				autoFixAvailable,
				fixKind,
			});
		}

		return diagnostics;
	};
}

// =============================================================================
// PRE-BUILT PARSERS FOR COMMON TOOLS
// =============================================================================

/**
 * Parse Ruff output: file:line:col: CODE message
 */
const ruffAutofix = getAutofixCapability("ruff");

export const parseRuffOutput = createLineParser({
	tool: "ruff",
	regex: /^(.+?):(\d+):(\d+):\s*(\w+)\s*(.+)/,
	extractMessage: (m) => `${m[4]}: ${m[5]}`, // CODE: message
	extractRule: (m) => m[4],
	generateId: (m) => `ruff-${m[4]}`,
	fixable: true, // Ruff can fix most issues
	autoFixAvailable: ruffAutofix?.safePipelineAutofix ?? false,
	fixKind: ruffAutofix?.fixKind === "none" ? undefined : ruffAutofix?.fixKind,
});

/**
 * Parse Go vet output: file:line:col: message
 */
export const parseGoVetOutput = createLineParser({
	tool: "go-vet",
	regex: /^(.+?):(\d+):(\d+):\s*(.+)/,
	extractMessage: (m) => m[4],
	generateId: (m) => `go-vet-${m[2]}`,
	defectClass: "correctness",
});

/**
 * Parse Biome output: file:line:col message (category)
 * With autofix support for fix suggestions
 */
export function createBiomeParser(_autofix: boolean = false) {
	const biomeAutofix = getAutofixCapability("biome");
	return createLineParser({
		tool: "biome",
		regex: /^(.+?):(\d+):(\d+)\s+(.+?)\s*\((.+?)\)/,
		extractMessage: (m) => `${m[5]}: ${m[4]}`, // category: message
		extractRule: (m) => m[5],
		generateId: (m) => `biome-${m[2]}-${m[5]}`,
		getSeverity: (line) => (line.includes("error") ? "error" : "warning"),
		fixable: true,
		autoFixAvailable: biomeAutofix?.safePipelineAutofix ?? false,
		fixKind:
			biomeAutofix?.fixKind === "none" ? undefined : biomeAutofix?.fixKind,
	});
}

// Backward-compatible default biome parser
export const parseBiomeOutput = createBiomeParser(false);

// =============================================================================
// GENERIC PARSER FACTORY
// =============================================================================

/**
 * Create a simple parser for tools using standard file:line:col format.
 * Format variations: :line:col:, line:col, (line,col), etc.
 */
export function createSimpleParser(
	tool: string,
	options: {
		separator?: ":" | " " | ",";
		includesFileName?: boolean;
		severity?: "error" | "warning" | "info";
		fixable?: boolean;
	} = {},
): (raw: string, filePath: string) => Diagnostic[] {
	const sep = options.separator ?? ":";
	const severity = options.severity ?? "warning";
	const fixable = options.fixable ?? false;

	// Build regex based on separator type
	const escapedSep = sep === " " ? "\\s+" : escapeRegExp(sep);
	const regex = options.includesFileName
		? new RegExp(
				`^(.+?)${escapedSep}(\\d+)${escapedSep}(\\d+)${escapedSep}(.+)`,
			)
		: new RegExp(`^(\\d+)${escapedSep}(\\d+)${escapedSep}(.+)`);

	return (raw: string, filePath: string): Diagnostic[] => {
		const diagnostics: Diagnostic[] = [];
		const lines = raw.split("\n").filter((l) => l.trim());

		for (const line of lines) {
			const match = line.match(regex);
			if (!match) continue;

			const lineNum = options.includesFileName
				? parseInt(match[2], 10)
				: parseInt(match[1], 10);
			const colNum = options.includesFileName
				? parseInt(match[3], 10)
				: parseInt(match[2], 10);
			const message = options.includesFileName ? match[4] : match[3];

			diagnostics.push({
				id: `${tool}-${lineNum}`,
				message: message.trim(),
				filePath,
				line: lineNum,
				column: colNum,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool,
				fixable,
			});
		}

		return diagnostics;
	};
}

function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

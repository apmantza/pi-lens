/**
 * Shared utilities for runners
 */

import * as fs from "node:fs";
import type { Diagnostic } from "../types.js";

/**
 * Read file content, returning undefined if it can't be read
 */
export function readFileContent(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Parse common tool output line into a diagnostic
 * Format: file:line:col message (category)
 */
export function parseToolLine(
	line: string,
	toolName: string,
	filePath: string,
): Diagnostic | null {
	const match = line.match(/^(.+?):(\d+):(\d+)\s+(.+?)\s*\((.+?)\)/);
	if (!match) return null;

	return {
		id: `${toolName}-${match[2]}-${match[5]}`,
		message: `${match[5]}: ${match[4]}`,
		filePath,
		line: parseInt(match[2], 10),
		column: parseInt(match[3], 10),
		severity: line.includes("error") ? "error" : "warning",
		semantic: "warning",
		tool: toolName,
		rule: match[5],
		fixable: false,
	};
}

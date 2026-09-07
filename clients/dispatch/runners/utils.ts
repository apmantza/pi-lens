/**
 * Shared utilities for runners
 */

import * as fs from "node:fs";

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

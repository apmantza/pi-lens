/**
 * #2372/#277 — LSP callers use the grouped capability facade.
 *
 * Recurrence: slice-3 callers could import the growing LSPService module
 * directly, making the planned ClientRegistry/TouchOrchestrator/
 * DiagnosticAggregator/WorkspaceWalker seams impossible to introduce without
 * another whole-tree migration. The facade is the one admitted adapter.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const ALLOWLIST = new Set(["clients/lsp/capabilities.ts"]);

function productionFiles(): string[] {
	return listSourceFiles(REPO_ROOT, {
		skipTests: true,
		exclude: (file) =>
			file !== "index.ts" &&
			!file.startsWith("clients/") &&
			!file.startsWith("tools/") &&
			!file.startsWith("mcp/"),
	});
}

describe("#2372 grouped LSP capability facade import ratchet", () => {
	it("has no direct production LSPService-module imports outside the adapter", () => {
		const files = productionFiles();
		assertNonEmptyScan("production LSP caller population", files.length);
		const walked = readWalkedFiles(files);
		const direct: string[] = [];
		for (const { file, source } of walked) {
			const relative = relativePosix(REPO_ROOT, file);
			// Import-module evidence is the deliberate string-literal exception:
			// comments are still blanked, but the module specifier must remain.
			const stripped = stripSource(source, { strings: "keep" });
			if (
				/from\s*["'][^"']*\/lsp\/index\.js|import\(\s*["'][^"']*\/lsp\/index\.js/.test(
					stripped,
				)
			) {
				if (!ALLOWLIST.has(relative)) direct.push(relative);
			}
		}
		expect(direct).toEqual([]);
	});
});

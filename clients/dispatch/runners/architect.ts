/**
 * Architectural rules runner for dispatch system
 *
 * Checks for architectural violations:
 * - Absolute Windows/Unix paths
 * - Hardcoded localhost URLs
 * - Empty catch blocks
 * - Secrets in code
 * - File size limits
 */

import * as path from "node:path";
import { ArchitectClient } from "../../architect-client.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { readFileContent } from "./utils.js";

// Module-level singleton — loadConfig once per cwd, not on every file write
let _client: ArchitectClient | null = null;
let _loadedCwd: string | null = null;

function normalizeCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getClient(cwd: string): ArchitectClient {
	const normalized = normalizeCwd(cwd);
	if (_client && _loadedCwd === normalized) return _client;
	_client = new ArchitectClient();
	_client.loadConfig(cwd);
	_loadedCwd = normalized;
	return _client;
}

const architectRunner: RunnerDefinition = {
	id: "architect",
	appliesTo: ["jsts", "python", "go", "rust", "cxx", "shell", "cmake"],
	priority: 40,
	enabledByDefault: true,
	skipTestFiles: true, // Skip test files - rules can be noisy there

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const relPath = path.relative(ctx.cwd, ctx.filePath).replace(/\\/g, "/");
		const content = readFileContent(ctx.filePath);

		if (!content) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const architectClient = getClient(ctx.cwd);

		if (!architectClient.hasConfig()) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics: Diagnostic[] = [];

		// Check for violations
		const violations = architectClient.checkFile(relPath, content);
		for (const v of violations) {
			// Build message with inline fix guidance
			let message = v.message;
			const fixSuggestion: string | undefined = v.fix;

			if (v.fix) {
				const fixPreview =
					v.fix.length > 60 ? `${v.fix.substring(0, 60)}...` : v.fix;
				message += `\n💡 Suggested fix: ${fixPreview}`;
			} else if (v.note) {
				const notePreview =
					v.note.length > 80 ? `${v.note.substring(0, 80)}...` : v.note;
				message += `\n📝 ${notePreview}`;
			}

			diagnostics.push({
				id: `architect-${v.line || 0}-${v.pattern}`,
				message,
				filePath: ctx.filePath,
				line: v.line,
				severity: "warning",
				semantic: "warning",
				tool: "architect",
				rule: v.pattern,
				fixable: !!v.fix,
				fixSuggestion,
			});
		}

		// Check file size limit
		const lineCount = content.split("\n").length;
		const sizeViolation = architectClient.checkFileSize(relPath, lineCount);
		if (sizeViolation) {
			diagnostics.push({
				id: `architect-size-${lineCount}`,
				message: sizeViolation.message,
				filePath: ctx.filePath,
				severity: "warning",
				semantic: "warning",
				tool: "architect",
				rule: "file-size-limit",
				fixSuggestion: "Split into smaller modules",
			});
		}

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return {
			status: "succeeded", // Warnings don't fail the run
			diagnostics,
			semantic: "warning",
		};
	},
};

export default architectRunner;

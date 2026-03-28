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

import type { DispatchContext, Diagnostic, RunnerDefinition, RunnerResult } from "../types.js";
import { ArchitectClient } from "../../architect-client.js";
import { readFileContent } from "./utils.js";

const architectRunner: RunnerDefinition = {
	id: "architect",
	appliesTo: ["jsts", "python", "go", "rust", "cxx", "shell", "cmake"],
	priority: 40,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const relPath = ctx.filePath.replace(ctx.cwd, "").replace(/\\/g, "/");
		const content = readFileContent(ctx.filePath);

		if (!content) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const architectClient = new ArchitectClient();
		architectClient.loadConfig(ctx.cwd);

		if (!architectClient.hasConfig()) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics: Diagnostic[] = [];

		// Check for violations
		const violations = architectClient.checkFile(relPath, content);
		for (const v of violations) {
			diagnostics.push({
				id: `architect-${v.line || 0}-${v.pattern}`,
				message: v.message,
				filePath: ctx.filePath,
				line: v.line,
				severity: "error",
				semantic: "blocking",
				tool: "architect",
				rule: v.pattern,
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
				severity: "error",
				semantic: "blocking",
				tool: "architect",
				rule: "file-size-limit",
				fixSuggestion: "Split into smaller modules",
			});
		}

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return {
			status: "failed",
			diagnostics,
			semantic: "blocking",
		};
	},
};

export default architectRunner;

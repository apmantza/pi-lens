/**
 * TypeScript LSP runner for dispatch system
 *
 * Wraps the existing TypeScriptClient for LSP diagnostics.
 */

import { TypeScriptClient } from "../../typescript-client.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { readFileContent } from "./utils.js";

const tsLspRunner: RunnerDefinition = {
	id: "ts-lsp",
	appliesTo: ["jsts"],
	priority: 5,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Only check TypeScript files
		if (!ctx.filePath.match(/\.tsx?$/)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Use the existing TypeScriptClient
		const tsClient = new TypeScriptClient();

		const content = readFileContent(ctx.filePath);
		if (!content) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		tsClient.updateFile(ctx.filePath, content);

		const diags = tsClient.getDiagnostics(ctx.filePath);

		if (diags.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Convert to diagnostics
		const diagnostics: Diagnostic[] = [];

		for (const d of diags) {
			const severity =
				d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
			diagnostics.push({
				id: `ts-${d.range.start.line}-${d.code}`,
				message: d.message,
				filePath: ctx.filePath,
				line: d.range.start.line + 1,
				severity,
				semantic: d.severity === 1 ? "blocking" : "warning",
				tool: "ts-lsp",
				rule: `TS${d.code}`,
			});
		}

		return {
			status: diagnostics.some((d) => d.severity === "error")
				? "failed"
				: "succeeded",
			diagnostics,
			semantic: "warning",
		};
	},
};

export default tsLspRunner;

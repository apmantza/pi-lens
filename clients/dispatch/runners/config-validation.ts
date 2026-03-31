/**
 * Config Validation Runner
 *
 * Validates config/environment variable access against actual config files.
 * Detects undefined keys, typos, and missing env vars.
 *
 * Uses Tree-sitter to find config access patterns in code and validates
 * against parsed config files (.env, config.ini, config.yaml, etc.)
 */

import { createConfigValidator } from "../../config-validator.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

const configValidationRunner: RunnerDefinition = {
	id: "config-validation",
	appliesTo: ["jsts", "python", "go", "rust"],
	priority: 8, // Run early, before other linters
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Only check supported file extensions
		const ext = ctx.filePath.match(/\.(py|js|ts|tsx|go|rs)$/);
		if (!ext) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		try {
			const validator = await createConfigValidator(ctx.cwd);
			const result = await validator.validateFile(ctx.filePath);

			const diagnostics: Diagnostic[] = [];

			// Report undefined keys as warnings
			for (const access of result.undefined) {
				diagnostics.push({
					id: `config-undefined:${access.key}`,
					message: `Undefined config key: "${access.key}"`,
					filePath: ctx.filePath,
					line: access.line,
					column: access.column,
					severity: "warning",
					semantic: "warning",
					tool: "config-validation",
				});
			}

			// Report typos with suggestion
			for (const { access, suggestion } of result.typos) {
				diagnostics.push({
					id: `config-typo:${access.key}`,
					message: `Possible typo: "${access.key}" — did you mean "${suggestion}"?`,
					filePath: ctx.filePath,
					line: access.line,
					column: access.column,
					severity: "warning",
					semantic: "warning",
					tool: "config-validation",
				});
			}

			if (diagnostics.length === 0) {
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			}

			return {
				status: "failed",
				diagnostics,
				semantic: "warning",
			};
		} catch (_err) {
			// Silently fail if validator can't run (e.g., tree-sitter not available)
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
	},
};

export default configValidationRunner;

/**
 * Tree-sitter Structural Analysis Runner
 *
 * Executes all loaded tree-sitter query files from rules/tree-sitter-queries/
 * for fast AST-based pattern matching.
 */

import path from "node:path";
import { TreeSitterClient } from "../../tree-sitter-client.js";
import { queryLoader } from "../../tree-sitter-query-loader.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

const treeSitterRunner: RunnerDefinition = {
	id: "tree-sitter",
	appliesTo: ["jsts", "python"],
	priority: 14, // Between oxlint (12) and ast-grep-napi (15)
	enabledByDefault: true,
	skipTestFiles: false, // Run on test files too (structural issues matter there)

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Initialize tree-sitter client
		const client = new TreeSitterClient();
		if (!client.isAvailable()) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const initialized = await client.init();
		if (!initialized) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Determine language from file extension
		const filePath = ctx.filePath;
		const isPython = filePath.endsWith(".py");
		const isTypeScript = filePath.endsWith(".ts");
		const isTSX = filePath.endsWith(".tsx");
		const isJavaScript = filePath.endsWith(".js") || filePath.endsWith(".jsx");

		let languageId: string;
		if (isPython) {
			languageId = "python";
		} else if (isTSX) {
			languageId = "tsx";
		} else if (isTypeScript) {
			languageId = "typescript";
		} else if (isJavaScript) {
			languageId = "javascript";
		} else {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Load queries if not already loaded
		if (!queryLoader.getAllQueries().length) {
			await queryLoader.loadQueries();
		}

		// Get all loaded queries for this language
		const allQueries = queryLoader.getAllQueries();
		const languageQueries = allQueries.filter(
			(q) =>
				q.language === languageId ||
				(isJavaScript && q.language === "typescript"),
		);

		if (languageQueries.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const diagnostics: Diagnostic[] = [];

		// Run each query against the file
		for (const query of languageQueries) {
			try {
				// Extract directory from file path (use path.dirname for cross-platform)
				const rootDir = path.dirname(filePath);

				const matches = await client.structuralSearch(
					query.id, // Use query ID as pattern (findMatchingQuery will resolve it)
					languageId,
					rootDir,
					{ maxResults: 10, fileFilter: (f) => f === filePath },
				);

				for (const match of matches) {
					// Get line/column from match (already 0-indexed from tree-sitter)
					const line = match.line;
					const column = match.column;

					// Map severity to semantic
					const semantic =
						query.severity === "error"
							? "blocking"
							: query.severity === "warning"
								? "warning"
								: "none";

					diagnostics.push({
						id: `tree-sitter:${query.id}:${line}`,
						message: query.message,
						filePath,
						line: line + 1, // 1-indexed
						column: column + 1, // 1-indexed
						severity: query.severity,
						semantic,
						tool: "tree-sitter",
						rule: query.id,
					});
				}
			} catch (err) {
				// Individual query failure shouldn't stop other queries
				console.error(`[tree-sitter] Query ${query.id} failed:`, err);
			}
		}

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Check if any blocking issues
		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");

		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
	},
};

export default treeSitterRunner;

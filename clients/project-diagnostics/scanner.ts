import * as path from "node:path";
import { createDispatchContext } from "../dispatch/dispatcher.js";
import { evaluateRules } from "../dispatch/fact-rule-runner.js";
import { runProviders } from "../dispatch/fact-runner.js";
import { FactStore } from "../dispatch/fact-store.js";
import type { Diagnostic } from "../dispatch/types.js";
import { isTestFile } from "../file-utils.js";
import { collectSourceFilesAsync } from "../source-filter.js";
import { TreeSitterClient } from "../tree-sitter-client.js";
import { TreeSitterQueryLoader } from "../tree-sitter-query-loader.js";
import {
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	saveProjectDiagnosticsSnapshot,
} from "./cache.js";
import type {
	ProjectDiagnostic,
	ProjectDiagnosticsScanOptions,
	ProjectDiagnosticsSnapshot,
} from "./types.js";
// Side-effect import: registers fact providers and fact rules.
import "../dispatch/integration.js";

const DEFAULT_MAX_FILES = 500;
const FACT_RULE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
]);
const TREE_SITTER_EXT_TO_LANG: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".rb": "ruby",
};

let sharedTreeSitterClient: TreeSitterClient | undefined;
function getTreeSitterClient(): TreeSitterClient {
	sharedTreeSitterClient ??= new TreeSitterClient();
	return sharedTreeSitterClient;
}

function normalizeSeverity(
	severity: string | undefined,
): ProjectDiagnostic["severity"] {
	if (severity === "error" || severity === "warning" || severity === "hint") {
		return severity;
	}
	return severity === "info" ? "info" : "warning";
}

function normalizeSemantic(
	diagnostic: Diagnostic,
): ProjectDiagnostic["semantic"] {
	if (diagnostic.semantic === "blocking") return "blocking";
	if (diagnostic.semantic === "warning") return "warning";
	return "none";
}

function fromDispatchDiagnostic(
	diagnostic: Diagnostic,
	runner: string,
): ProjectDiagnostic {
	return {
		filePath: path.resolve(diagnostic.filePath),
		line: diagnostic.line,
		column: diagnostic.column,
		severity: normalizeSeverity(diagnostic.severity),
		semantic: normalizeSemantic(diagnostic),
		tool: diagnostic.tool,
		runner,
		rule: diagnostic.rule,
		code: diagnostic.code,
		message: diagnostic.message,
		source: "project-scan",
	};
}

async function scanFactRules(
	cwd: string,
	files: string[],
): Promise<ProjectDiagnostic[]> {
	const facts = new FactStore();
	const pi = { getFlag: () => undefined };
	const diagnostics: ProjectDiagnostic[] = [];
	for (const filePath of files) {
		if (
			isTestFile(filePath) ||
			!FACT_RULE_EXTENSIONS.has(path.extname(filePath))
		) {
			continue;
		}
		facts.clearFileFactsFor(filePath);
		const ctx = createDispatchContext(filePath, cwd, pi, facts, false);
		try {
			await runProviders(ctx);
			for (const diagnostic of evaluateRules(ctx)) {
				diagnostics.push(fromDispatchDiagnostic(diagnostic, "fact-rules"));
			}
		} catch {
			// Project scans are best-effort; one unparsable file should not abort the tool.
		}
	}
	return diagnostics;
}

async function scanTreeSitter(
	cwd: string,
	files: string[],
): Promise<ProjectDiagnostic[]> {
	const client = getTreeSitterClient();
	if (!client.isAvailable()) return [];
	if (!(await client.init())) return [];

	const loader = new TreeSitterQueryLoader();
	const queryMap = await loader.loadQueries(cwd);
	const diagnostics: ProjectDiagnostic[] = [];

	for (const filePath of files) {
		if (isTestFile(filePath)) continue;
		const langId = TREE_SITTER_EXT_TO_LANG[path.extname(filePath)];
		if (!langId) continue;
		const queries = [
			...(queryMap.get(langId) ?? []),
			...(langId === "javascript" ? (queryMap.get("typescript") ?? []) : []),
		];
		for (const query of queries) {
			try {
				const matches = await client.runQueryOnFile(query, filePath, langId, {
					maxResults: 50,
				});
				for (const match of matches ?? []) {
					diagnostics.push({
						filePath,
						line: match.line ?? 1,
						column: match.column,
						severity: query.severity === "error" ? "error" : query.severity,
						semantic:
							query.inline_tier === "blocking" || query.severity === "error"
								? "blocking"
								: "warning",
						tool: "tree-sitter",
						runner: "tree-sitter",
						rule: query.id,
						message: query.message,
						source: "project-scan",
					});
				}
			} catch {
				// Continue scanning other rules/files.
			}
		}
	}
	return diagnostics;
}

export async function scanProjectDiagnostics(
	options: ProjectDiagnosticsScanOptions,
): Promise<ProjectDiagnosticsSnapshot> {
	const cwd = path.resolve(options.cwd);
	const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
	const files = await collectSourceFilesAsync(cwd, { maxFiles });
	const diagnostics = [
		...(await scanTreeSitter(cwd, files)),
		...(await scanFactRules(cwd, files)),
	];
	const snapshot: ProjectDiagnosticsSnapshot = {
		version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
		cwd,
		tier: options.tier,
		scannedAt: new Date().toISOString(),
		diagnostics,
		filesScanned: files.length,
		runners: ["tree-sitter", "fact-rules"],
	};
	saveProjectDiagnosticsSnapshot(cwd, snapshot);
	return snapshot;
}

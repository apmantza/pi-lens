import * as fs from "node:fs";
import * as path from "node:path";
import { createDispatchContext } from "../dispatch/dispatcher.js";
import { evaluateRules } from "../dispatch/fact-rule-runner.js";
import { runProviders } from "../dispatch/fact-runner.js";
import { FactStore } from "../dispatch/fact-store.js";
import {
	canHandle as astGrepCanHandle,
	evaluateAstGrepRules,
	getLang as astGrepGetLang,
	loadSg,
} from "../dispatch/runners/ast-grep-napi.js";
import type { Diagnostic } from "../dispatch/types.js";
import { isTestFile } from "../file-utils.js";
import { collectSourceFilesAsync } from "../source-filter.js";
import { getSharedTreeSitterClient } from "../tree-sitter-shared.js";
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
// Skip files this large: matches the per-edit ast-grep runner's guard so a single
// generated megafile can't dominate a project scan.
const AST_GREP_MAX_FILE_BYTES = 1024 * 1024;
// Project-audit budgets — looser than the per-edit runner's 10/50 (which exist to
// keep inline output bounded), since a project scan is an explicit, expensive call.
const AST_GREP_SCAN_MAX_MATCHES_PER_RULE = 25;
const AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE = 100;
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
	const client = getSharedTreeSitterClient();
	if (!client || !client.isAvailable()) return [];
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

/**
 * Project-wide ast-grep pass via the bundled napi engine — no `ast-grep` binary
 * required (#308). In `lens_diagnostics mode=full` the ast-grep LSP already
 * covers the project WHEN its binary is present; this closes the no-binary gap
 * using the same Rust core + shipped ruleset. Findings dedup against the LSP's
 * (`filePath:line:rule`) in the full-mode merge, so running both never
 * double-reports. Iterates the SAME `files` list as the other scanners, so it
 * inherits identical exclusion/ignore/cap behavior automatically.
 */
async function scanAstGrepNapi(
	cwd: string,
	files: string[],
): Promise<ProjectDiagnostic[]> {
	const sgModule = await loadSg();
	if (!sgModule) return [];

	const diagnostics: ProjectDiagnostic[] = [];
	for (const filePath of files) {
		if (isTestFile(filePath) || !astGrepCanHandle(filePath)) continue;

		let stats: fs.Stats;
		try {
			stats = fs.statSync(filePath);
		} catch {
			continue;
		}
		if (stats.size > AST_GREP_MAX_FILE_BYTES) continue;

		const lang = astGrepGetLang(filePath, sgModule);
		if (!lang) continue;

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			const rootNode = lang.parse(content).root();
			const fileDiagnostics = evaluateAstGrepRules(
				filePath,
				rootNode,
				cwd,
				"jsts",
				{
					maxMatchesPerRule: AST_GREP_SCAN_MAX_MATCHES_PER_RULE,
					maxTotalDiagnostics: AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE,
				},
			);
			for (const diagnostic of fileDiagnostics) {
				diagnostics.push(fromDispatchDiagnostic(diagnostic, "ast-grep-napi"));
			}
		} catch {
			// Project scans are best-effort; one unparsable file must not abort the tool.
		}
	}
	return diagnostics;
}

export async function scanProjectDiagnostics(
	options: ProjectDiagnosticsScanOptions,
): Promise<ProjectDiagnosticsSnapshot> {
	const cwd = path.resolve(options.cwd);
	const { signal } = options;
	const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
	const files = options.files
		? options.files.slice(0, maxFiles)
		: await collectSourceFilesAsync(cwd, { maxFiles });
	// Check cancellation at each phase boundary so a full-mode scan stops
	// promptly when the agent/user aborts (#341). The per-phase runners are
	// already file-capped, so phase granularity is enough to bound the work.
	const runners: string[] = [];
	const diagnostics: ProjectDiagnostic[] = [];
	if (!signal?.aborted) {
		diagnostics.push(...(await scanTreeSitter(cwd, files)));
		runners.push("tree-sitter");
	}
	if (!signal?.aborted) {
		diagnostics.push(...(await scanFactRules(cwd, files)));
		runners.push("fact-rules");
	}
	if (!signal?.aborted) {
		diagnostics.push(...(await scanAstGrepNapi(cwd, files)));
		runners.push("ast-grep-napi");
	}
	const snapshot: ProjectDiagnosticsSnapshot = {
		version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
		cwd,
		tier: options.tier,
		scannedAt: new Date().toISOString(),
		diagnostics,
		filesScanned: files.length,
		runners,
	};
	// A cancelled scan yields a partial snapshot; don't persist it as the
	// authoritative cross-session cache — only a complete run is cacheable.
	// Likewise, an explicit `files` scan (#461) only covers a caller-chosen
	// subset (e.g. git-staged files), not the whole project — persisting it
	// would poison the cross-session cache with a partial view that a later
	// unscoped `refreshRunners=cached` read would wrongly trust as complete.
	if (signal?.aborted || options.files) return snapshot;
	saveProjectDiagnosticsSnapshot(cwd, snapshot);
	return snapshot;
}

/**
 * ast-grep NAPI runner for dispatch system
 *
 * Uses @ast-grep/napi for programmatic parsing instead of CLI.
 * Handles TypeScript/JavaScript/CSS/HTML files with YAML rule support.
 *
 * Replaces CLI-based runners for faster performance (100x speedup).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AstGrepNapi,
	loadAstGrepNapi,
	type SgRoot,
} from "../../deps/ast-grep-napi.js";
import { resolvePackagePath } from "../../package-root.js";
import { hasEslintConfig } from "../../tool-policy.js";
import { enabledAuxiliaryLspServerIds } from "../auxiliary-lsp.js";
import { classifyDefect } from "../diagnostic-taxonomy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	calculateRuleComplexity,
	isOverlyBroadPattern,
	isStructuredRule,
	loadYamlRules,
	MAX_BLOCKING_RULE_COMPLEXITY,
	type YamlRule,
} from "./yaml-rule-parser.js";

// Lazy load the napi package
let sg: AstGrepNapi | undefined;
let sgLoadAttempted = false;

export async function loadSg(): Promise<
	AstGrepNapi | undefined
> {
	if (sg) return sg;
	if (sgLoadAttempted) return undefined; // Don't retry if already failed
	sgLoadAttempted = true;
	try {
		sg = await loadAstGrepNapi();
		return sg;
	} catch {
		return undefined;
	}
}

// Supported extensions for NAPI
const SUPPORTED_EXTS = [".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".htm"];

/** Maximum matches per rule to prevent excessive false positives */
const MAX_MATCHES_PER_RULE = 10;

/** Maximum total diagnostics per file to prevent output spam */
const MAX_TOTAL_DIAGNOSTICS = 50;

/** Rules already covered by tree-sitter runner (priority 14, runs first) */
const TREE_SITTER_OVERLAP = new Set([
	"constructor-super",
	"empty-catch",
	"long-parameter-list",
	"nested-ternary",
	"no-dupe-class-members",
]);

/**
 * Rules commonly covered by ESLint/Biome correctness checks.
 * We can suppress these from ast-grep in lint-enabled projects to reduce noise.
 */
const LINTER_OVERLAP = new Set([
	"getter-return",
	"no-array-constructor",
	"no-async-promise-executor",
	"no-await-in-loop",
	"no-case-declarations",
	"no-compare-neg-zero",
	"no-cond-assign",
	"no-constant-condition",
	"no-constructor-return",
	"no-dupe-args",
	"no-dupe-keys",
	"no-extra-boolean-cast",
	"no-new-symbol",
	"no-new-wrappers",
	"no-prototype-builtins",
]);

const NON_SUPPRESSIBLE = new Set([
	"empty-catch",
	"no-discarded-error",
	"unchecked-throwing-call",
]);

function defaultFixSuggestion(defectClass: string, ruleId: string): string {
	if (defectClass === "silent-error") {
		return "Handle the error path explicitly: log context and rethrow or return a typed error result.";
	}
	if (defectClass === "secrets") {
		return "Remove hardcoded secret material and load values from env/secret manager.";
	}
	if (defectClass === "injection") {
		return "Avoid dynamic execution/interpolation here; use parameterized APIs or strict allowlists.";
	}
	if (defectClass === "async-misuse") {
		return "Make async flow explicit: await consistently and handle rejection/error paths.";
	}
	if (ruleId.includes("unsafe") || ruleId.includes("security")) {
		return "Refactor to a safer API usage with explicit validation and bounded behavior.";
	}
	return "Refactor this pattern to the safer equivalent used in the codebase.";
}

function explicitRuleFixSuggestion(rule: YamlRule): string | undefined {
	const raw = (rule.fix ?? rule.note ?? "").trim();
	if (!raw) return undefined;
	const oneLine = raw.replace(/\s+/g, " ").trim();
	return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

function normalizeRuleId(ruleId: string): string {
	return ruleId.replace(/-js$/, "");
}

export function canHandle(filePath: string): boolean {
	return SUPPORTED_EXTS.includes(path.extname(filePath).toLowerCase());
}

export function getLang(
	filePath: string,
	sgModule: AstGrepNapi,
) {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".ts":
			return sgModule.ts;
		case ".tsx":
			return sgModule.tsx;
		case ".js":
		case ".jsx":
			return sgModule.js;
		case ".css":
			return sgModule.css;
		case ".html":
		case ".htm":
			return sgModule.html;
		default:
			return undefined;
	}
}

/** Per-edit defaults — tuned to keep inline output bounded on a broken file. */
export interface AstGrepEvaluateOptions {
	/** Drop non-error rules and complexity-bounded blocking rules (per-edit blocking pass). */
	blockingOnly?: boolean;
	/** Cap matches kept per rule (default {@link MAX_MATCHES_PER_RULE}). */
	maxMatchesPerRule?: number;
	/** Cap total diagnostics per file (default {@link MAX_TOTAL_DIAGNOSTICS}). */
	maxTotalDiagnostics?: number;
}

/**
 * Run the shipped ast-grep YAML ruleset against a parsed file via napi's native
 * engine, applying the same suppression policy (linter/tree-sitter overlap,
 * overly-broad-pattern guard) as the per-edit runner. Extracted so the
 * project-wide scanner can reuse the identical engine + rules WITHOUT the
 * ast-grep binary — closing the no-binary gap (#308) — while the per-edit runner
 * keeps its tight budgets. Callers pass the already-parsed `rootNode` so they
 * control parsing/size gating.
 */
export function evaluateAstGrepRules(
	filePath: string,
	rootNode: { findAll(config: never): unknown[] },
	cwd: string,
	kind: string | undefined,
	options: AstGrepEvaluateOptions = {},
): Diagnostic[] {
	const maxMatchesPerRule = options.maxMatchesPerRule ?? MAX_MATCHES_PER_RULE;
	const maxTotalDiagnostics =
		options.maxTotalDiagnostics ?? MAX_TOTAL_DIAGNOSTICS;
	const blockingOnly = options.blockingOnly === true;

	const diagnostics: Diagnostic[] = [];
	const seenRuleIds = new Set<string>();
	const suppressLinterOverlap = kind === "jsts" && hasEslintConfig(cwd);

	const ruleDirs = [
		path.join(process.cwd(), "rules", "ast-grep-rules", "rules"),
		path.join(process.cwd(), "rules", "ast-grep-rules"),
		resolvePackagePath(import.meta.url, "rules", "ast-grep-rules", "rules"),
		resolvePackagePath(import.meta.url, "rules", "ast-grep-rules"),
	];

	for (const ruleDir of ruleDirs) {
		let rules: YamlRule[];
		try {
			rules = loadYamlRules(ruleDir, blockingOnly ? "error" : undefined);
		} catch {
			continue;
		}

		for (const rule of rules) {
			// If the same rule id is loaded from multiple directories
			// (workspace + bundled), prefer the first one to avoid duplicates.
			if (seenRuleIds.has(rule.id)) continue;
			seenRuleIds.add(rule.id);

			if (
				suppressLinterOverlap &&
				LINTER_OVERLAP.has(normalizeRuleId(rule.id)) &&
				!NON_SUPPRESSIBLE.has(normalizeRuleId(rule.id))
			) {
				continue;
			}

			// Skip rules already handled by tree-sitter runner (priority 14)
			if (TREE_SITTER_OVERLAP.has(rule.id)) continue;

			// Skip rules whose top-level pattern is overly broad ($NAME, $X, etc.)
			// without additional structural constraints to narrow matches.
			if (
				rule.rule &&
				isOverlyBroadPattern(rule.rule.pattern) &&
				!isStructuredRule(rule)
			) {
				continue;
			}

			const lang = rule.language?.toLowerCase();
			if (lang && lang !== "typescript" && lang !== "javascript") {
				continue;
			}

			if (blockingOnly && rule.rule) {
				const complexity = calculateRuleComplexity(rule.rule);
				if (complexity > MAX_BLOCKING_RULE_COMPLEXITY) {
					continue;
				}
			}

			if (!rule.rule) continue;

			try {
				let matches: unknown[] = [];

				// Delegate matching to napi's native engine, which handles the
				// full ast-grep rule grammar (pattern, kind, has/inside/follows/
				// precedes/stopBy/field/nthChild, any/all/not) plus metavariable
				// `constraints` (#206). A faithful js-yaml parse feeds the rule
				// object straight through. If napi rejects the rule (a malformed
				// or invalid-kind rule), skip it — never silently match nothing
				// through a partial interpreter.
				const nativeConfig = rule.constraints
					? { rule: rule.rule, constraints: rule.constraints }
					: { rule: rule.rule };
				try {
					matches = rootNode.findAll(nativeConfig as never);
				} catch {
					matches = [];
				}

				const limitedMatches = matches.slice(0, maxMatchesPerRule);

				for (const match of limitedMatches) {
					if (diagnostics.length >= maxTotalDiagnostics) break;

					const node = match as {
						range(): { start: { line: number; column: number } };
					};
					const range = node.range();
					const severity = rule.severity === "error" ? "error" : "warning";
					const semantic = severity === "error" ? "blocking" : "warning";
					const defectClass = classifyDefect(
						rule.id,
						"ast-grep-napi",
						rule.message || rule.id,
					);
					const ruleFix = explicitRuleFixSuggestion(rule);

					diagnostics.push({
						id: `ast-grep-napi-${range.start.line}-${rule.id}`,
						message: `[${rule.metadata?.category || "slop"}] ${rule.message || rule.id}`,
						filePath,
						line: range.start.line + 1,
						column: range.start.column + 1,
						severity,
						semantic,
						tool: "ast-grep-napi",
						rule: rule.id,
						defectClass,
						fixable: !!ruleFix,
						autoFixAvailable: false,
						fixKind: ruleFix ? "suggestion" : undefined,
						fixSuggestion:
							semantic === "blocking"
								? (ruleFix ?? defaultFixSuggestion(defectClass, rule.id))
								: ruleFix,
					});
				}

				if (diagnostics.length >= maxTotalDiagnostics) break;
			} catch {
				// Rule failed, skip
			}
		}
	}

	return diagnostics;
}

// --- Runner Definition ---

const astGrepNapiRunner: RunnerDefinition = {
	id: "ast-grep-napi",
	appliesTo: ["jsts"],
	priority: PRIORITY.SPECIALIZED_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		if (!canHandle(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// #239 Phase 2: the ast-grep LSP supersedes this in-process runner when its
		// binary is available — same Rust engine, plus codeAction fixes, and it runs
		// the shipped baseline ruleset via `--config`. Skip here so we don't double-
		// report against the LSP's `tool: ast-grep` diagnostics. Resume ONLY as the
		// fallback when the binary is absent / can't spawn (Gate B).
		const astGrepLspEnabled = enabledAuxiliaryLspServerIds((f) =>
			ctx.pi?.getFlag?.(f),
		).includes("ast-grep");
		if (astGrepLspEnabled && (await ctx.hasTool("ast-grep"))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const sgModule = await loadSg();
		if (!sgModule) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (!fs.existsSync(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lang = getLang(ctx.filePath, sgModule);
		if (!lang) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let stats: import("fs").Stats;
		try {
			stats = fs.statSync(ctx.filePath);
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		if (stats.size > 1024 * 1024) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let content: string;
		const contentFromFacts = ctx.facts.getFileFact<string | null>(
			ctx.filePath,
			"file.content",
		);
		if (contentFromFacts !== undefined && contentFromFacts !== null) {
			content = contentFromFacts;
		} else {
			try {
				content = fs.readFileSync(ctx.filePath, "utf-8");
			} catch {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		let root: SgRoot;
		try {
			root = lang.parse(content);
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let rootNode: any;
		try {
			rootNode = root.root();
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = evaluateAstGrepRules(
			ctx.filePath,
			rootNode,
			ctx.cwd,
			ctx.kind,
			{ blockingOnly: ctx.blockingOnly },
		);

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
		let semantic: "blocking" | "warning" | "none" = "none";
		if (hasBlocking) {
			semantic = "blocking";
		} else if (diagnostics.length > 0) {
			semantic = "warning";
		}
		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic,
		};
	},
};

export default astGrepNapiRunner;

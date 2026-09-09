/**
 * AstGrep Client for pi-lens
 *
 * Structural code analysis using ast-grep CLI.
 * Scans files against YAML rule definitions.
 *
 * Requires: npm install -D @ast-grep/cli
 * Rules: ./rules/ directory
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AstGrepRuleManager,
	checkAstGrepRulesHealth,
} from "./ast-grep-rule-manager.js";
import type {
	AstGrepDiagnostic,
	AstGrepMatch,
	RuleDescription,
	SgMatch,
} from "./ast-grep-types.js";
import { reportBundledResourceDirHealth } from "./bundled-resource-health.js";
import { getDegradationLedgerGeneration } from "./degradation-ledger.js";
import { logLatency } from "./latency-logger.js";
import { getMutationBridge } from "./mutation-bridge.js";
import { resolvePackagePath } from "./package-root.js";
import { truncatedByOutputCap } from "./spawn-output-cap.js";
import {
	SgRunner,
	type SgExecutionOptions,
	type SgScanResult,
} from "./sg-runner.js";

/**
 * #2636: `AstGrepClient`'s constructor falls back to the bundled `rules/`
 * (`resolvePackagePath(import.meta.url, "rules")`) with no existence check
 * when the project has none of its own — same managed-cache-relocation gap
 * #2626 fixed for `skills/`. Purely observational: logs a `phase` record
 * naming the resolved path + rule-description count on EVERY call that uses
 * the bundled fallback (healthy or not, so an empty ledger is distinguishable
 * from this never having run at all — #2626 review F5), and records a
 * bounded `ast-grep-rules-dir-missing` degradation only when the bundled dir
 * itself turns out absent, unreadable, or holds no `.yml` rule description.
 * Called only when using the bundled fallback — never when the project
 * provides its own `rules/` (a broken PROJECT override is a user config
 * concern, not this bug's shape) — from `ensureRulesHealthReported` below,
 * both at construction and again on the ledger's next generation (#2636
 * review F3).
 */
function reportAstGrepRulesHealth(bundledRuleDir: string): void {
	const health = checkAstGrepRulesHealth(bundledRuleDir);
	logLatency({
		type: "phase",
		phase: "ast_grep_rules_resolved",
		filePath: bundledRuleDir,
		durationMs: 0,
		metadata: {
			status: health.status,
			entryCount: health.status === "healthy" ? health.entryCount : 0,
		},
	});
	reportBundledResourceDirHealth(
		"ast-grep-rules-dir-missing",
		bundledRuleDir,
		health,
		"ast-grep rule descriptions",
	);
}

/**
 * Record an applied `ast_grep_replace` rewrite through the mutation bridge
 * (#2423, acceptance criterion 3).
 *
 * ast-grep reports 0-based line numbers; the guard and the change log are
 * 1-based, so every range is shifted by one. One record per FILE carries every
 * range that file's matches covered, because the bridge's contract is
 * per-file — the same shape a multi-hunk edit produces.
 *
 * Exported for tests: they drive it against a registered bridge instead of
 * spawning ast-grep.
 */
function recordAstGrepApply(matches: AstGrepMatch[]): void {
	const bridge = getMutationBridge();
	if (!bridge || matches.length === 0) return;
	const rangesByFile = new Map<string, Array<[number, number]>>();
	for (const match of matches) {
		const start = (match.range?.start?.line ?? 0) + 1;
		const end = Math.max(start, (match.range?.end?.line ?? 0) + 1);
		const existing = rangesByFile.get(match.file);
		if (existing) existing.push([start, end]);
		else rangesByFile.set(match.file, [[start, end]]);
	}
	for (const [filePath, editRanges] of rangesByFile) {
		bridge.recordMutation({
			filePath,
			kind: "edit",
			editRanges,
			consumer: "ast_grep_replace",
		});
	}
}

// --- Client ---

function extractDebugAst(raw: string): string | undefined {
	const lines = raw.split(/\r?\n/);
	const start = lines.findIndex((line) =>
		/^Debug (?:A|C)ST:/.test(line.trim()),
	);
	if (start < 0) return undefined;
	const out: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (!line.trim()) break;
		out.push(line);
	}
	return out.length > 0 ? out.join("\n") : undefined;
}

function lineStartOffsets(source: string): number[] {
	const offsets = [0];
	for (let index = 0; index < source.length; index++) {
		if (source.charCodeAt(index) === 10) offsets.push(index + 1);
	}
	return offsets;
}

function snippetForRange(
	source: string,
	offsets: number[],
	startLine0: number,
	startCol0: number,
	endLine0: number,
	endCol0: number,
): string {
	const start = (offsets[startLine0] ?? 0) + startCol0;
	const end = (offsets[endLine0] ?? source.length) + endCol0;
	const text = source.slice(start, end).replace(/\s+/g, " ").trim();
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

const MAX_VALIDATE_PATTERN_CHARS = 20_000;
const MAX_VALIDATE_RULE_CHARS = 200_000;

const VALIDATION_SNIPPETS: Record<string, { ext: string; source: string }> = {
	bash: { ext: "sh", source: "echo pi_lens_validate\n" },
	c: { ext: "c", source: "int main(void) { return 0; }\n" },
	cpp: { ext: "cpp", source: "int main() { return 0; }\n" },
	csharp: { ext: "cs", source: "class C { static void Main() {} }\n" },
	css: { ext: "css", source: ".pi-lens { color: black; }\n" },
	go: { ext: "go", source: "package main\nfunc main() {}\n" },
	html: { ext: "html", source: "<main>pi-lens</main>\n" },
	java: { ext: "java", source: "class Main { void run() {} }\n" },
	javascript: { ext: "js", source: "const piLensValidate = 1;\n" },
	json: { ext: "json", source: '{"piLensValidate":true}\n' },
	kotlin: { ext: "kt", source: "fun main() {}\n" },
	lua: { ext: "lua", source: "local pi_lens_validate = 1\n" },
	php: { ext: "php", source: "<?php $piLensValidate = 1;\n" },
	python: { ext: "py", source: "pi_lens_validate = 1\n" },
	ruby: { ext: "rb", source: "pi_lens_validate = 1\n" },
	rust: { ext: "rs", source: "fn main() {}\n" },
	tsx: { ext: "tsx", source: "export function App() { return <div />; }\n" },
	typescript: { ext: "ts", source: "const piLensValidate = 1;\n" },
	yaml: { ext: "yaml", source: "piLensValidate: true\n" },
};

function validationSnippetFor(language: string): {
	ext: string;
	source: string;
} {
	const key = language.toLowerCase().replace(/^"|"$/g, "");
	return (
		VALIDATION_SNIPPETS[key] ?? {
			ext: key.replace(/[^a-z0-9_-]/gi, "") || "txt",
			source: "pi_lens_validate\n",
		}
	);
}

function validateInputShape(
	value: string,
	maxChars: number,
	label: string,
): string | undefined {
	if (value.includes("\0")) return `${label} contains NUL bytes`;
	if (value.length > maxChars) {
		return `${label} is too large (${value.length} chars, max ${maxChars})`;
	}
	return undefined;
}

function stderrHasError(stderr: string): boolean {
	return stderr.split(/\r?\n/).some((line) => /^\s*(error|Error):/.test(line));
}

function formatDebugAst(tree: string, source: string): string {
	const offsets = lineStartOffsets(source);
	return tree
		.split(/\r\n|\n/)
		.map((line) => {
			const match =
				/^([ \t]*)([^ \t(][^(]*)? \((\d+),(\d+)\)-\((\d+),(\d+)\)$/.exec(line);
			if (!match) return line;
			const [, indent = "", label = "", startLine, startCol, endLine, endCol] =
				match;
			const sl = Number(startLine);
			const sc = Number(startCol);
			const el = Number(endLine);
			const ec = Number(endCol);
			const snippet = snippetForRange(source, offsets, sl, sc, el, ec);
			return `${indent}${label} [${sl + 1},${sc + 1}] - [${el + 1},${ec + 1}] ${JSON.stringify(snippet)}`;
		})
		.join("\n");
}

/** One symbol/import/export/member in `ast-grep outline` JSON (lines 0-based). */
export interface AstGrepOutlineItem {
	role: string;
	symbolType: string;
	name: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	signature: string;
	astKind: string;
	isImport?: boolean;
	isExported?: boolean;
	isPublic?: boolean;
	members?: AstGrepOutlineItem[];
}

export interface AstGrepOutlineFile {
	path: string;
	language: string;
	items: AstGrepOutlineItem[];
}

export class AstGrepClient {
	private ruleDir: string;
	private log: (msg: string) => void;
	private ruleManager: AstGrepRuleManager;
	private runner: SgRunner;
	// #2636 review F3/F7:
	private readonly usingBundledRuleDirFallback: boolean;
	private rulesHealthReportedGeneration: number | undefined;

	constructor(ruleDir?: string, verbose = false) {
		const projectRuleDir = path.join(process.cwd(), "rules");
		// F7: ONE existsSync call, reused for both the fallback decision and the
		// ruleDir choice — two separate calls let the directory appear (or a
		// concurrent watcher/installer create it) between them, making
		// `usingBundledRuleDirFallback` true while `this.ruleDir` ends up being
		// the now-existing PROJECT dir: the health check would then classify a
		// project override's own directory against `reportAstGrepRulesHealth`'s
		// bundled-fallback doc contract.
		const hasProjectRuleDir = fs.existsSync(projectRuleDir);
		this.usingBundledRuleDirFallback = !ruleDir && !hasProjectRuleDir;
		this.ruleDir =
			ruleDir ||
			(hasProjectRuleDir
				? projectRuleDir
				: resolvePackagePath(import.meta.url, "rules"));
		this.log = verbose ? createSubsystemLogger("ast-grep") : () => {};
		this.ensureRulesHealthReported();
		this.ruleManager = new AstGrepRuleManager(this.ruleDir, this.log);
		this.runner = new SgRunner(verbose);
	}

	/**
	 * #2636 review F3: `AstGrepClient` is a per-PROCESS singleton
	 * (`index.ts`/`mcp/server.ts`/`clients/mcp/session.ts` each construct it
	 * exactly once), but `resetDegradationLedger()` wipes the ledger's
	 * once-per-subject latch on EVERY `session_start`
	 * (`runtime-session.ts`'s `handleSessionStart`). A report that only ever
	 * fires at construction is therefore invisible after the first session
	 * boundary — `pilens_health` shows nothing for a bug that is still there
	 * (shape 17's inverse: `resolveSkillPaths`/`ruleFilesForLanguage` avoid
	 * this because pi calls them fresh per request, but `AstGrepClient` has
	 * no such per-request re-entry).
	 *
	 * Re-checked against the ledger's own generation counter at the START of
	 * every real scan entry point (`ensureAvailable`, called by every
	 * `tools/ast-grep-*`/`ast-dump` handler before doing any work) — the same
	 * pattern `clients/tree-sitter-client.ts`'s `refreshGrammarSessionLatches`
	 * uses for its own per-instance session latches, adapted here: the
	 * degradation ledger already re-arms its OWN once-per-subject dedup on
	 * reset, so this method only has to decide WHETHER to call
	 * `reportAstGrepRulesHealth` again, never re-implement the dedup itself.
	 */
	private ensureRulesHealthReported(): void {
		const generation = getDegradationLedgerGeneration();
		if (this.rulesHealthReportedGeneration === generation) return;
		this.rulesHealthReportedGeneration = generation;
		if (this.usingBundledRuleDirFallback) {
			reportAstGrepRulesHealth(this.ruleDir);
		}
	}

	/**
	 * Check if ast-grep CLI is available, auto-install if not
	 */
	ensureAvailable(): Promise<boolean> {
		this.ensureRulesHealthReported();
		return this.runner.ensureAvailable();
	}

	/**
	 * Replace using a raw YAML rule that includes a `fix:` field (Phase 3/4 of #125).
	 * Dry-run returns matches for preview; apply writes fixes to disk.
	 */
	async replaceWithRule(
		ruleYaml: string,
		paths: string[],
		apply: boolean,
	): Promise<{
		matches: AstGrepMatch[];
		totalMatches: number;
		applied: boolean;
		stalePreview?: boolean;
		error?: string;
	}> {
		const allMatches: AstGrepMatch[] = [];
		for (const scanPath of paths) {
			if (apply) {
				// Stale-preview check: dry-run first. Preserve CLI failures instead of
				// treating an invalid rule as a stale, no-match preview.
				const preCheck = await this.tempScanDetailed(scanPath, ruleYaml);
				if (preCheck.failure || preCheck.error) {
					return {
						matches: allMatches,
						totalMatches: allMatches.length,
						applied: false,
						error: preCheck.error ?? "ast-grep preview failed",
					};
				}
				if (preCheck.matches.length === 0) {
					return {
						matches: [],
						totalMatches: 0,
						applied: false,
						stalePreview: true,
					};
				}
			}
			const result = await this.runner.tempScanWithFixAsync(
				scanPath,
				"agent-rule",
				ruleYaml,
				apply,
			);
			if (result.error) {
				return {
					matches: allMatches,
					totalMatches: allMatches.length,
					applied: false,
					error: result.error,
				};
			}
			allMatches.push(...result.matches);
		}
		return {
			matches: allMatches,
			totalMatches: allMatches.length,
			applied: apply,
		};
	}

	/**
	 * Search using a raw YAML rule (Phase 4 of #125).
	 * Routes through sg scan --config rather than sg run -p.
	 * Each path is scanned independently; results are merged.
	 */
	private async tempScanDetailed(
		dir: string,
		ruleYaml: string,
		options: SgExecutionOptions = {},
	): Promise<SgScanResult> {
		// SAFETY: keep tests and older embedders that replace the runner with the
		// historic match-only seam working. The cast only makes
		// `tempScanDetailedAsync` OPTIONAL on the runner surface — it claims
		// nothing about the method existing. The call site below checks for it
		// before invoking, and the production SgRunner always has it, so a
		// failure there cannot be mistaken for an empty result.
		const detailed = (
			this.runner as unknown as {
				tempScanDetailedAsync?: (
					dir: string,
					ruleId: string,
					ruleYaml: string,
					timeout?: number,
					options?: SgExecutionOptions,
				) => Promise<SgScanResult>;
			}
		).tempScanDetailedAsync;
		if (detailed) {
			return detailed.call(
				this.runner,
				dir,
				"agent-rule",
				ruleYaml,
				30_000,
				options,
			);
		}
		const matches = await this.runner.tempScanAsync(
			dir,
			"agent-rule",
			ruleYaml,
			30_000,
			options,
		);
		return { matches, status: 0 };
	}

	async searchWithRule(
		ruleYaml: string,
		paths: string[],
		options: SgExecutionOptions = {},
	): Promise<{
		matches: AstGrepMatch[];
		totalMatches: number;
		error?: string;
	}> {
		const allMatches: AstGrepMatch[] = [];
		for (const scanPath of paths) {
			try {
				const results = await this.tempScanDetailed(
					scanPath,
					ruleYaml,
					options,
				);
				if (results.failure || results.error) {
					return {
						matches: allMatches,
						totalMatches: allMatches.length,
						error:
							results.error ||
							`ast-grep scan failed (${results.failure ?? "unknown failure"})`,
					};
				}
				allMatches.push(...results.matches);
			} catch (err) {
				return {
					matches: allMatches,
					totalMatches: allMatches.length,
					error: String(err),
				};
			}
		}
		return { matches: allMatches, totalMatches: allMatches.length };
	}

	/**
	 * Dump the parsed tree-sitter AST for a snippet using ast-grep CLI.
	 */
	async dumpAst(
		source: string,
		lang: string,
		options: { includeAnonymous?: boolean } = {},
	): Promise<{ output?: string; error?: string }> {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ast-dump-"));
		const tmpFile = path.join(
			tmpDir,
			`snippet.${lang.replace(/[^a-z0-9_-]/gi, "") || "txt"}`,
		);
		try {
			fs.writeFileSync(tmpFile, source, "utf-8");
			const mode = options.includeAnonymous ? "cst" : "ast";
			const result = await this.runner.execRaw([
				"run",
				"--lang",
				lang,
				"-p",
				source,
				`--debug-query=${mode}`,
				tmpFile,
			]);
			const raw = result.stderr || result.stdout;
			const tree = extractDebugAst(raw);
			if (tree) return { output: formatDebugAst(tree, source) };
			return {
				error:
					result.error ||
					result.stderr.trim() ||
					result.stdout.trim() ||
					`ast-grep did not return a debug AST for language ${lang}`,
			};
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	async validatePattern(
		pattern: string,
		lang: string,
		options?: {
			selector?: string;
			strictness?: string;
		} & SgExecutionOptions,
	): Promise<{ valid: boolean; warning?: string; error?: string }> {
		const shapeError = validateInputShape(
			pattern,
			MAX_VALIDATE_PATTERN_CHARS,
			"pattern",
		);
		if (shapeError) return { valid: false, error: shapeError };

		const snippet = validationSnippetFor(lang);
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-sg-validate-"),
		);
		const tmpFile = path.join(tmpDir, `snippet.${snippet.ext}`);
		try {
			fs.writeFileSync(tmpFile, snippet.source, "utf-8");
			const args = ["run", "-p", pattern, "--lang", lang, "--json=compact"];
			if (options?.selector) args.push("--selector", options.selector);
			if (options?.strictness) args.push("--strictness", options.strictness);
			args.push(tmpFile);
			const result = await this.runner.execRaw(args, 10_000, options);
			const stderr = result.stderr.trim();
			const stdout = result.stdout.trim();
			// FIRST (#2100): hitting `execRaw`'s cap SIGTERMs ast-grep, so a
			// truncated run also carries the kill's error message. Read after the
			// two checks below, this guard could only ever describe a run that
			// exited before the signal reached it. `execRaw` re-spells `failure`
			// in its own vocabulary but keeps the timeout/aborted spellings, so
			// those runs still fall through to the error branch below.
			if (truncatedByOutputCap(result)) {
				return {
					valid: false,
					error: "ast-grep validation output was truncated",
				};
			}
			if (result.error) return { valid: false, error: result.error };
			if (result.status !== 0 && !(result.status === 1 && !stderr)) {
				return {
					valid: false,
					error:
						stderr ||
						`ast-grep validation failed with exit code ${result.status}`,
				};
			}
			if (stderrHasError(stderr)) return { valid: false, error: stderr };
			const warning = stderr || stdout || undefined;
			return {
				valid: true,
				...(warning ? { warning } : {}),
			};
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup; never mask the validation result.
			}
		}
	}

	async validateRule(
		ruleYaml: string,
		options: SgExecutionOptions = {},
	): Promise<{ valid: boolean; error?: string }> {
		const shapeError = validateInputShape(
			ruleYaml,
			MAX_VALIDATE_RULE_CHARS,
			"rule",
		);
		if (shapeError) return { valid: false, error: shapeError };

		const language =
			/^\s*language:\s*([^\s#]+)/im.exec(ruleYaml)?.[1] ?? "typescript";
		const snippet = validationSnippetFor(language);
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sg-rule-"));
		try {
			fs.writeFileSync(
				path.join(tmpDir, `snippet.${snippet.ext}`),
				snippet.source,
				"utf-8",
			);
			const result = await this.tempScanDetailed(tmpDir, ruleYaml, options);
			if (result.failure || result.error) {
				return {
					valid: false,
					error:
						result.error ||
						`ast-grep rule validation failed (${result.failure ?? "unknown failure"})`,
				};
			}
			return { valid: true };
		} catch (err) {
			return { valid: false, error: String(err) };
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup; never mask the validation result.
			}
		}
	}

	/**
	 * Syntax-only code outline via `ast-grep outline` (#311) — symbols, imports,
	 * exports, and members for file or directory input. Raw, fast, no index/LSP;
	 * complements module_report (which adds the cached graph's who-uses-this,
	 * complexity, and blast radius). Returns parsed JSON; args go through
	 * `execRaw` (execFile-style, no shell), so no interpolation risk.
	 */
	async outline(
		paths: string[],
		options: {
			lang?: string;
			items?: string;
			view?: string;
			types?: string[];
			match?: string;
			pubMembers?: boolean;
			globs?: string[];
		} = {},
	): Promise<{ output?: AstGrepOutlineFile[]; error?: string }> {
		if (paths.length === 0) return { error: "no paths provided" };
		const args = ["outline", "--json=compact", "--color", "never"];
		if (options.lang) args.push("--lang", options.lang);
		if (options.items) args.push("--items", options.items);
		if (options.view) args.push("--view", options.view);
		if (options.types?.length) args.push("--type", options.types.join(","));
		if (options.match) args.push("--match", options.match);
		if (options.pubMembers) args.push("--pub-members");
		for (const glob of options.globs ?? []) args.push("--globs", glob);
		args.push(...paths);
		const result = await this.runner.execRaw(args);
		const raw = (result.stdout ?? "").trim();
		if (!raw) {
			return {
				error:
					result.error ||
					result.stderr?.trim() ||
					"ast-grep outline returned no output",
			};
		}
		try {
			return { output: JSON.parse(raw) as AstGrepOutlineFile[] };
		} catch (err) {
			return {
				error: `failed to parse ast-grep outline JSON: ${
					err instanceof Error ? err.message : String(err)
				}`,
			};
		}
	}

	/**
	 * Search for AST patterns in files
	 */
	async search(
		pattern: string,
		lang: string,
		paths: string[],
		options?: {
			selector?: string;
			context?: number;
			strictness?: string;
		} & SgExecutionOptions,
	): Promise<{
		matches: AstGrepMatch[];
		totalMatches: number;
		truncated: boolean;
		error?: string;
	}> {
		const args = ["run", "-p", pattern, "--lang", lang, "--json=compact"];
		if (options?.selector) {
			args.push("--selector", options.selector);
		}
		if (options?.context !== undefined) {
			args.push("--context", String(options.context));
		}
		if (options?.strictness) {
			args.push("--strictness", options.strictness);
		}
		args.push(...paths);
		const result = await this.runner.exec(args, options);
		return {
			matches: result.matches,
			totalMatches: result.totalMatches,
			truncated: result.truncated,
			error: result.error,
		};
	}

	/**
	 * Search and replace AST patterns
	 */
	async replace(
		pattern: string,
		rewrite: string,
		lang: string,
		paths: string[],
		apply = false,
		options?: { strictness?: string },
	): Promise<{
		matches: AstGrepMatch[];
		totalMatches: number;
		truncated: boolean;
		applied: boolean;
		stalePreview?: boolean;
		error?: string;
	}> {
		const baseArgs = ["run", "-p", pattern, "-r", rewrite, "--lang", lang];
		if (options?.strictness) {
			baseArgs.push("--strictness", options.strictness);
		}

		if (!apply) {
			// Dry-run: --json=compact shows what would change without writing
			const result = await this.runner.exec([
				...baseArgs,
				"--json=compact",
				...paths,
			]);
			return {
				matches: result.matches,
				totalMatches: result.totalMatches,
				truncated: result.truncated,
				applied: false,
				error: result.error,
			};
		}

		// Stale-preview check: re-run dry-run before writing.
		// If the pattern no longer matches, the files changed since the preview.
		const preCheck = await this.runner.exec([
			...baseArgs,
			"--json=compact",
			...paths,
		]);
		if (preCheck.error) {
			return {
				matches: [],
				totalMatches: 0,
				truncated: false,
				applied: false,
				error: preCheck.error,
			};
		}
		if (preCheck.matches.length === 0) {
			return {
				matches: [],
				totalMatches: 0,
				truncated: false,
				applied: false,
				stalePreview: true,
			};
		}

		// Apply: --update-all writes the files. We do NOT recount afterwards —
		// the original pattern no longer matches post-rewrite, and searching for
		// the rewrite as a pattern is unreliable (multi-line rewrites and
		// metavariable substitutions don't round-trip into a valid search
		// pattern, yielding a false "0 matches" even on a successful apply).
		// preCheck above already captured exactly what matched and was rewritten.
		const applyResult = await this.runner.exec([
			...baseArgs,
			"--update-all",
			...paths,
		]);
		if (applyResult.error) {
			return {
				matches: [],
				totalMatches: 0,
				truncated: false,
				applied: false,
				error: applyResult.error,
			};
		}
		// #2423: `--update-all` just rewrote these files, and no `tool_result`
		// describes it — pi-lens's own tool was as invisible to the mutation
		// bookkeeping as any third-party one. Record each rewritten file through
		// the same seam an extension would use. Fire-and-forget: the bridge never
		// throws, and a missing bridge (pi-lens not activated, guard disabled) is
		// a silent no-op.
		recordAstGrepApply(preCheck.matches);
		return {
			matches: preCheck.matches,
			totalMatches: preCheck.totalMatches,
			truncated: preCheck.truncated,
			applied: true,
			error: undefined,
		};
	}

	/**
	 * Run a one-off scan with a temporary rule and configuration
	 */
	private async runTempScanAsync(
		dir: string,
		ruleId: string,
		ruleYaml: string,
		timeout = 30000,
	): Promise<AstGrepMatch[]> {
		if (!(await this.ensureAvailable())) return [];
		return this.runner.tempScanAsync(dir, ruleId, ruleYaml, timeout);
	}

	/**
	 * Find similar functions by comparing normalized AST structure
	 */
	async findSimilarFunctions(
		dir: string,
		lang: string = "typescript",
	): Promise<
		Array<{
			pattern: string;
			functions: Array<{ name: string; file: string; line: number }>;
		}>
	> {
		const ruleYaml = `id: find-functions
language: ${lang}
rule:
  kind: function_declaration
severity: info
message: found
`;

		const matches = await this.runTempScanAsync(
			dir,
			"find-functions",
			ruleYaml,
		);
		if (matches.length === 0) return [];

		return this.groupSimilarFunctions(matches);
	}

	private groupSimilarFunctions(matches: AstGrepMatch[]): Array<{
		pattern: string;
		functions: Array<{ name: string; file: string; line: number }>;
	}> {
		const grouped = new Map<
			string,
			Array<{ name: string; file: string; line: number }>
		>();

		for (const item of matches) {
			const name = this.extractFunctionName(item.text);
			if (!name) continue;

			const signature = this.normalizeFunction(item.text);
			const line =
				(item.range?.start?.line || item.labels?.[0]?.range?.start?.line || 0) +
				1;

			const group = grouped.get(signature) ?? [];
			group.push({ name, file: item.file, line });
			grouped.set(signature, group);
		}

		return Array.from(grouped.entries())
			.filter(([, functions]) => functions.length > 1)
			.map(([pattern, functions]) => ({ pattern, functions }));
	}

	/**
	 * Extract function name from match text
	 */
	private extractFunctionName(text: string): string | null {
		return text.match(/function\s+(\w+)/)?.[1] ?? null;
	}

	private normalizeFunction(text: string): string {
		const normalizedText = text
			.replace(/function\s+\w+/, "function FN")
			.replace(/\bconst\b|\blet\b|\bvar\b/g, "VAR")
			.replace(/["'].*?["']/g, "STR")
			.replace(/`[^`]*`/g, "TMPL")
			.replace(/\b\d+\b/g, "NUM")
			.replace(/\btrue\b|\bfalse\b/g, "BOOL")
			.replace(/\/\/.*/g, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\s+/g, " ")
			.trim();

		// Extract just the body structure
		const bodyMatch = normalizedText.match(/\{(.*)\}/);
		const body = bodyMatch ? bodyMatch[1].trim() : normalizedText;

		// Use first 200 chars as signature
		return body.slice(0, 200);
	}

	/**
	 * Scan for exported function names in a directory
	 */
	async scanExports(
		dir: string,
		lang: string = "typescript",
	): Promise<Map<string, string>> {
		const exports = new Map<string, string>();
		const ruleYaml = `id: find-functions
language: ${lang}
rule:
  kind: function_declaration
severity: info
message: found
`;

		const matches = await this.runTempScanAsync(
			dir,
			"find-functions",
			ruleYaml,
			15000,
		);
		this.log(`scanExports output length: ${matches.length}`);

		for (const item of matches) {
			const text = item.text || "";
			const nameMatch = text.match(/function\s+(\w+)/);
			if (nameMatch?.[1]) {
				this.log(`scanExports found: ${nameMatch[1]} in ${item.file}`);
				exports.set(nameMatch[1], item.file);
			}
		}

		return exports;
	}

	formatMatches(
		matches: AstGrepMatch[],
		isDryRun = false,
		showModeIndicator = false,
		maxItems = 50,
	): string {
		return this.runner.formatMatches(
			matches as SgMatch[],
			isDryRun,
			maxItems,
			showModeIndicator,
		);
	}

	/**
	 * Format diagnostics for LLM consumption
	 */
	formatDiagnostics(diags: AstGrepDiagnostic[]): string {
		if (diags.length === 0) return "";

		const errors = diags.filter((d) => d.severity === "error");
		const warnings = diags.filter((d) => d.severity === "warning");
		const infos = diags.filter((d) => d.severity === "info");
		const hints = diags.filter((d) => d.severity === "hint");

		let output = `[ast-grep] ${diags.length} structural issue(s)`;
		if (errors.length) output += ` — ${errors.length} error(s)`;
		if (warnings.length) output += ` — ${warnings.length} warning(s)`;
		if (infos.length) output += ` — ${infos.length} info(s)`;
		if (hints.length) output += ` — ${hints.length} hint(s)`;
		output += ":\n";

		for (const d of diags.slice(0, 10)) {
			const loc =
				d.line === d.endLine ? `L${d.line}` : `L${d.line}-${d.endLine}`;
			const ruleInfo = d.ruleDescription
				? `${d.rule}: ${d.ruleDescription.message}`
				: d.rule;
			const fix = d.fix || d.ruleDescription?.note ? " [fixable]" : "";
			output += `  ${ruleInfo} (${loc})${fix}\n`;

			if (d.ruleDescription?.note) {
				const shortNote = d.ruleDescription.note.split(/\r?\n/)[0];
				output += `    → ${shortNote}\n`;
			}
		}

		if (diags.length > 10) {
			output += `  ... and ${diags.length - 10} more\n`;
		}

		return output;
	}

	getRuleDescription(ruleId: string): RuleDescription | undefined {
		return this.ruleManager.loadRuleDescriptions().get(ruleId);
	}
}

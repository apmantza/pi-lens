/**
 * AstGrep Client for pi-lens
 *
 * Structural code analysis using ast-grep CLI.
 * Scans files against YAML rule definitions.
 *
 * Requires: npm install -D @ast-grep/cli
 * Rules: ./rules/ directory
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AstGrepRuleManager } from "./ast-grep-rule-manager.js";
import type {
	AstGrepDiagnostic,
	AstGrepMatch,
	RuleDescription,
	SgMatch,
} from "./ast-grep-types.js";
import { resolvePackagePath } from "./package-root.js";
import { SgRunner } from "./sg-runner.js";

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

function formatDebugAst(tree: string, source: string): string {
	const offsets = lineStartOffsets(source);
	return tree
		.split(/\r\n|\n/)
		.map((line) => {
			const match = /^([ \t]*)([^ \t(][^(]*)? \((\d+),(\d+)\)-\((\d+),(\d+)\)$/.exec(line);
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

export class AstGrepClient {
	private ruleDir: string;
	private log: (msg: string) => void;
	private ruleManager: AstGrepRuleManager;
	private runner: SgRunner;

	constructor(ruleDir?: string, verbose = false) {
		const projectRuleDir = path.join(process.cwd(), "rules");
		this.ruleDir =
			ruleDir ||
			(fs.existsSync(projectRuleDir)
				? projectRuleDir
				: resolvePackagePath(import.meta.url, "rules"));
		this.log = verbose
			? (msg: string) => console.error(`[ast-grep] ${msg}`)
			: () => {};
		this.ruleManager = new AstGrepRuleManager(this.ruleDir, this.log);
		this.runner = new SgRunner(verbose);
	}

	/**
	 * Check if ast-grep CLI is available, auto-install if not
	 */
	ensureAvailable(): Promise<boolean> {
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
				// Stale-preview check: dry-run first
				const preCheck = await this.runner.tempScanAsync(scanPath, "agent-rule", ruleYaml);
				if (preCheck.length === 0) {
					return { matches: [], totalMatches: 0, applied: false, stalePreview: true };
				}
			}
			const result = await this.runner.tempScanWithFixAsync(
				scanPath, "agent-rule", ruleYaml, apply,
			);
			if (result.error) {
				return { matches: allMatches, totalMatches: allMatches.length, applied: false, error: result.error };
			}
			allMatches.push(...result.matches);
		}
		return { matches: allMatches, totalMatches: allMatches.length, applied: apply };
	}

	/**
	 * Search using a raw YAML rule (Phase 4 of #125).
	 * Routes through sg scan --config rather than sg run -p.
	 * Each path is scanned independently; results are merged.
	 */
	async searchWithRule(
		ruleYaml: string,
		paths: string[],
	): Promise<{
		matches: AstGrepMatch[];
		totalMatches: number;
		error?: string;
	}> {
		const allMatches: AstGrepMatch[] = [];
		for (const scanPath of paths) {
			try {
				const results = await this.runner.tempScanAsync(
					scanPath,
					"agent-rule",
					ruleYaml,
				);
				allMatches.push(...results);
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

	/**
	 * Search for AST patterns in files
	 */
	async search(
		pattern: string,
		lang: string,
		paths: string[],
		options?: { selector?: string; context?: number; strictness?: string },
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
		const result = await this.runner.exec(args);
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
			.filter(([_, functions]) => functions.length > 1)
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
	): string {
		return this.runner.formatMatches(
			matches as SgMatch[],
			isDryRun,
			50,
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
		const hints = diags.filter((d) => d.severity === "hint");

		let output = `[ast-grep] ${diags.length} structural issue(s)`;
		if (errors.length) output += ` — ${errors.length} error(s)`;
		if (warnings.length) output += ` — ${warnings.length} warning(s)`;
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

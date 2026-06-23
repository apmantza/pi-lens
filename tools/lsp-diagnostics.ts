/**
 * lsp_diagnostics tool definition
 *
 * Proactive LSP diagnostics check — single files or directories.
 * Adopted from code-yeongyu/pi-lsp-client design.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
	getProjectIgnoreMatcher,
	isExcludedDirName,
} from "../clients/file-utils.js";
import { getLSPService } from "../clients/lsp/index.js";
import type { LSPDiagnostic } from "../clients/lsp/client.js";

const LANG_EXTENSIONS: Record<string, string[]> = {
	".ts": [".ts", ".tsx", ".mts", ".cts"],
	".tsx": [".ts", ".tsx", ".mts", ".cts"],
	".js": [".js", ".jsx", ".mjs", ".cjs"],
	".py": [".py", ".pyi"],
	".rs": [".rs"],
	".go": [".go"],
	".rb": [".rb", ".rake", ".gemspec"],
	".java": [".java"],
	".kt": [".kt", ".kts"],
	".swift": [".swift"],
	".cs": [".cs"],
	".cpp": [".cpp", ".cc", ".cxx", ".hpp", ".hxx"],
	".c": [".c", ".h"],
	".zig": [".zig", ".zon"],
	".hs": [".hs", ".lhs"],
	".ex": [".ex", ".exs"],
	".gleam": [".gleam"],
	".tf": [".tf", ".tfvars"],
	".nix": [".nix"],
	".sh": [".sh", ".bash", ".zsh"],
	".php": [".php"],
	".lua": [".lua"],
	".dart": [".dart"],
	".vue": [".vue"],
	".svelte": [".svelte"],
	".css": [".css", ".scss", ".less"],
	".html": [".html", ".htm"],
	".json": [".json", ".jsonc"],
	".yaml": [".yaml", ".yml"],
	".toml": [".toml"],
	".prisma": [".prisma"],
};

const MAX_FILES = 50;
const MAX_BATCH_FILES = 100;
const MAX_DIAGNOSTICS = 200;
const DEFAULT_BATCH_CONCURRENCY = 8;
const MAX_BATCH_CONCURRENCY = 16;

// LSP severities: 1=Error, 2=Warning, 3=Information, 4=Hint
const SEVERITY_NAMES: Record<number, string> = {
	1: "error",
	2: "warning",
	3: "information",
	4: "hint",
};

type LspHealthLike = {
	health?: string;
	serverCountAttempted?: number;
	serverCountReady?: number;
	candidateServerIds?: string[];
	mergedCount?: number;
};

type BatchOptions = {
	concurrency: number;
	waitMs?: number;
};

type FileDiag = {
	file: string;
	line?: number;
	character?: number;
	severity: number;
	message: string;
	source?: string;
	code?: string | number;
};

type FileDiagnosticResult = {
	file: string;
	diagnostics: FileDiag[];
	unavailable?: string;
	error?: string;
};

function lspUnavailableMessage(
	filePath: string,
	health: LspHealthLike | undefined,
): string | undefined {
	if (!health || !String(health.health ?? "").startsWith("no_clients")) {
		return undefined;
	}
	const candidates = health.candidateServerIds?.length
		? ` candidates=${health.candidateServerIds.join(",")}`
		: "";
	const reason =
		(health.serverCountAttempted ?? 0) === 0
			? "no LSP server configured"
			: "no LSP client is currently ready";
	const stale =
		(health.mergedCount ?? 0) > 0
			? " Showing stale last-known diagnostics below."
			: " No diagnostics were collected.";
	return `LSP unavailable for ${filePath}: ${reason}; ready=${health.serverCountReady ?? 0}/${health.serverCountAttempted ?? 0}.${candidates}.${stale}`;
}

function boundedPositiveInt(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
): number {
	const parsed = typeof value === "number" ? Math.floor(value) : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	let nextIndex = 0;
	const workers = Math.min(Math.max(1, concurrency), items.length);
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= items.length) return;
				results[index] = await mapper(items[index]!, index);
			}
		}),
	);
	return results;
}

/**
 * Project-ignore predicate rooted at `root`, fail-open. Lets a directory scan
 * honor the user's `.pi-lens.json` / `.gitignore` patterns — not just the
 * canonical dir-name list — so `lsp_diagnostics` stays consistent with the
 * workspace-diagnostics walk and every other scan surface (#243/#297/#298). A
 * config-probe error never blocks a scan (matches the walkers' behaviour).
 */
function projectIgnorePredicate(
	root: string,
): (fullPath: string, isDir: boolean) => boolean {
	try {
		const matcher = getProjectIgnoreMatcher(root);
		return (fullPath, isDir) => matcher.isIgnored(fullPath, isDir);
	} catch {
		return () => false;
	}
}

function collectFiles(
	dir: string,
	extensions: string[],
	maxFiles: number,
	isIgnored: (fullPath: string, isDir: boolean) => boolean = () => false,
): string[] {
	const files: string[] = [];
	function walk(current: string): void {
		if (files.length >= maxFiles) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= maxFiles) return;
			if (entry.isSymbolicLink()) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!isExcludedDirName(entry.name) && !isIgnored(full, true)) walk(full);
			} else if (entry.isFile() && extensions.includes(path.extname(full))) {
				if (isIgnored(full, false)) continue;
				files.push(full);
			}
		}
	}
	walk(dir);
	return files;
}

export function createLspDiagnosticsTool() {
	return {
		name: "lsp_diagnostics" as const,
		label: "LSP Diagnostics",
		description:
			"Get errors, warnings, and hints from language servers for a file or directory. " +
			"Use BEFORE running builds to proactively check for issues. " +
			"Works on directories by auto-detecting file extensions and scanning all matching files.",
		promptSnippet:
			"Get LSP diagnostics for a file or directory (use before builds)",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"File or directory path to check. For directories, all matching source files are scanned.",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					minItems: 1,
					maxItems: MAX_BATCH_FILES,
					description:
						"Explicit files to check as a bounded-concurrency batch. When provided, path is ignored.",
				}),
			),
			severity: Type.Optional(
				Type.String({
					enum: ["error", "warning", "information", "hint", "all"],
					description: "Filter by severity level (default: all)",
				}),
			),
			concurrency: Type.Optional(
				Type.Number({
					description:
						"Batch/directory concurrency for opening files and collecting diagnostics. Default 8, max 16.",
				}),
			),
			waitMs: Type.Optional(
				Type.Number({
					description:
						"Optional per-file LSP wait budget for batch diagnostics. Uses server defaults when omitted.",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const typedParams = params as {
				path?: string;
				paths?: string[];
				severity?: string;
				concurrency?: number;
				waitMs?: number;
			};
			const severity = (typedParams.severity ?? "all") as string;
			const cwd = ctx.cwd ?? process.cwd();
			const concurrency = boundedPositiveInt(
				typedParams.concurrency,
				DEFAULT_BATCH_CONCURRENCY,
				1,
				MAX_BATCH_CONCURRENCY,
			);
			const waitMs =
				typeof typedParams.waitMs === "number" && typedParams.waitMs >= 0
					? Math.floor(typedParams.waitMs)
					: undefined;

			const lspService = getLSPService();
			if (!lspService) {
				return {
					content: [
						{ type: "text" as const, text: "LSP service not available." },
					],
					isError: true,
					details: {},
				};
			}

			if (
				Array.isArray(typedParams.paths) &&
				typedParams.paths.length > 0
			) {
				const absPaths = typedParams.paths
					.filter(
						(entry): entry is string =>
							typeof entry === "string" && entry.trim().length > 0,
					)
					.slice(0, MAX_BATCH_FILES)
					.map((entry) =>
						path.isAbsolute(entry) ? entry : path.resolve(cwd, entry),
					);
				return runBatchFileDiagnostics(absPaths, severity, lspService, {
					concurrency,
					waitMs,
				});
			}

			const rawPath = typedParams.path;
			if (!rawPath || rawPath.trim().length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "path or paths is required.",
						},
					],
					isError: true,
					details: {},
				};
			}
			const absPath = path.isAbsolute(rawPath)
				? rawPath
				: path.resolve(cwd, rawPath);

			let stat: fs.Stats;
			try {
				stat = fs.statSync(absPath);
			} catch {
				return {
					content: [
						{ type: "text" as const, text: `Path not found: ${absPath}` },
					],
					isError: true,
					details: {},
				};
			}

			if (stat.isDirectory()) {
				return runDirectoryDiagnostics(absPath, severity, lspService, {
					concurrency,
					waitMs,
				});
			}
			return runFileDiagnostics(absPath, severity, lspService, waitMs);
		},
	};
}

async function collectDiagnosticsForFile(
	absPath: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	waitMs?: number,
): Promise<LSPDiagnostic[]> {
	try {
		const content = fs.readFileSync(absPath, "utf-8");
		const serviceWithTouch = lspService as NonNullable<
			ReturnType<typeof getLSPService>
		> & {
			touchFile?: (
				filePath: string,
				content: string,
				options: {
					diagnostics: "document";
					collectDiagnostics: true;
					maxClientWaitMs?: number;
					source: string;
					clientScope: "all";
				},
			) => Promise<LSPDiagnostic[] | undefined>;
		};
		if (
			waitMs !== undefined &&
			typeof serviceWithTouch.touchFile === "function"
		) {
			await serviceWithTouch.touchFile(absPath, content, {
				diagnostics: "document",
				collectDiagnostics: true,
				maxClientWaitMs: waitMs,
				source: "lsp_diagnostics",
				clientScope: "all",
			});
		} else {
			await lspService.openFile(absPath, content, {
				preserveDiagnostics: false,
			});
		}
	} catch {
		// Non-fatal: getDiagnostics may still have stale/health information.
	}

	return lspService.getDiagnostics(
		absPath,
		waitMs !== undefined ? "document" : "full",
	);
}

function diagnosticsToFileDiags(
	file: string,
	diagnostics: LSPDiagnostic[],
): FileDiag[] {
	return diagnostics.map((d) => ({
		file,
		line: d.range?.start?.line,
		character: d.range?.start?.character,
		severity: d.severity,
		message: d.message,
		source: d.source,
		code: d.code,
	}));
}

async function collectFileDiagnosticResult(
	file: string,
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	waitMs?: number,
): Promise<FileDiagnosticResult> {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) {
			return { file, diagnostics: [], error: `${file}: not a file` };
		}
	} catch {
		return { file, diagnostics: [], error: `${file}: path not found` };
	}

	const rawDiags = await collectDiagnosticsForFile(file, lspService, waitMs);
	const health = lspService.getDiagnosticsHealth?.(file) as
		| LspHealthLike
		| undefined;
	return {
		file,
		diagnostics: diagnosticsToFileDiags(
			file,
			applySeverityFilter(rawDiags, severity),
		),
		unavailable: lspUnavailableMessage(file, health),
	};
}

async function runFileDiagnostics(
	absPath: string,
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	waitMs?: number,
) {
	const rawDiags = await collectDiagnosticsForFile(absPath, lspService, waitMs);
	const lspHealth = lspService.getDiagnosticsHealth?.(absPath) as
		| LspHealthLike
		| undefined;
	const unavailable = lspUnavailableMessage(absPath, lspHealth);
	const filtered = applySeverityFilter(rawDiags, severity);
	const total = filtered.length;
	const truncated = total > MAX_DIAGNOSTICS;
	const limited = truncated ? filtered.slice(0, MAX_DIAGNOSTICS) : filtered;

	let text: string;
	if (total === 0) {
		text = unavailable ?? "No diagnostics found.";
	} else {
		const lines = limited.map(formatDiag);
		if (unavailable) lines.unshift(unavailable, "");
		if (truncated) {
			lines.unshift(
				`Found ${total} diagnostics (showing first ${MAX_DIAGNOSTICS}):`,
			);
		}
		text = lines.join("\n");
	}

	return {
		content: [{ type: "text" as const, text }],
		details: {
			filePath: absPath,
			mode: "file",
			severity,
			diagnostics: limited.map((d) => ({
				line: d.range?.start?.line,
				character: d.range?.start?.character,
				severity: d.severity,
				message: d.message,
				source: d.source,
				code: d.code,
			})),
			totalDiagnostics: total,
			truncated,
			lspHealth,
			waitMs,
		},
	};
}

async function runBatchFileDiagnostics(
	absPaths: string[],
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	options: BatchOptions,
) {
	if (absPaths.length === 0) {
		return {
			content: [{ type: "text" as const, text: "No file paths provided." }],
			isError: true,
			details: { mode: "batch", severity, filesChecked: 0 },
		};
	}

	const results = await mapWithConcurrency(
		absPaths,
		options.concurrency,
		(file) =>
			collectFileDiagnosticResult(file, severity, lspService, options.waitMs),
	);
	const fileErrors = results.flatMap((result) =>
		result.error ? [result.error] : [],
	);
	const lspHealthWarnings = results.flatMap((result) =>
		result.unavailable ? [result.unavailable] : [],
	);
	const allDiags = results.flatMap((result) => result.diagnostics);
	const total = allDiags.length;
	const truncated = total > MAX_DIAGNOSTICS;
	const display = truncated ? allDiags.slice(0, MAX_DIAGNOSTICS) : allDiags;

	const lines: string[] = [
		`Files checked: ${results.length}`,
		`Total diagnostics: ${total}`,
		`Concurrency: ${options.concurrency}`,
	];
	if (options.waitMs !== undefined)
		lines.push(`Wait budget: ${options.waitMs}ms`);
	if (fileErrors.length > 0) lines.push("", "File errors:", ...fileErrors);
	if (lspHealthWarnings.length > 0) {
		lines.push("", "LSP health warnings:", ...lspHealthWarnings.slice(0, 10));
	}
	if (display.length === 0) {
		lines.push("", "No diagnostics found.");
	} else {
		lines.push("");
		for (const d of display) {
			const sevName = SEVERITY_NAMES[d.severity] ?? "unknown";
			const loc =
				d.line !== undefined
					? `${d.file}:${d.line + 1}:${(d.character ?? 0) + 1}`
					: d.file;
			const src = d.source ? `[${d.source}]` : "";
			const code = d.code ? ` (${d.code})` : "";
			lines.push(`${loc}: ${sevName}${src}${code}: ${d.message}`);
		}
		if (truncated) {
			lines.push(
				"",
				`... (${total - MAX_DIAGNOSTICS} more diagnostics not shown)`,
			);
		}
	}

	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {
			mode: "batch",
			severity,
			filesChecked: results.length,
			concurrency: options.concurrency,
			waitMs: options.waitMs,
			diagnostics: display,
			totalDiagnostics: total,
			truncated,
			fileErrors: fileErrors.length > 0 ? fileErrors : undefined,
			lspHealthWarnings:
				lspHealthWarnings.length > 0 ? lspHealthWarnings : undefined,
		},
	};
}

async function runDirectoryDiagnostics(
	absPath: string,
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	options: BatchOptions,
) {
	let extension: string | undefined;
	let collectedFiles: string[] = [];

	const isIgnored = projectIgnorePredicate(absPath);
	for (const [ext, exts] of Object.entries(LANG_EXTENSIONS)) {
		collectedFiles = collectFiles(absPath, exts, MAX_FILES + 1, isIgnored);
		if (collectedFiles.length > 0) {
			extension = ext;
			break;
		}
	}

	if (!extension || collectedFiles.length === 0) {
		return {
			content: [
				{
					type: "text" as const,
					text: `No supported source files found in: ${absPath}`,
				},
			],
			details: {
				filePath: absPath,
				mode: "directory",
				severity,
				filesScanned: 0,
			},
		};
	}

	const wasCapped = collectedFiles.length > MAX_FILES;
	const filesToProcess = collectedFiles.slice(0, MAX_FILES);
	const results = await mapWithConcurrency(
		filesToProcess,
		options.concurrency,
		(file) =>
			collectFileDiagnosticResult(file, severity, lspService, options.waitMs),
	);
	const fileErrors = results.flatMap((result) =>
		result.error ? [result.error] : [],
	);
	const lspHealthWarnings = results.flatMap((result) =>
		result.unavailable ? [result.unavailable] : [],
	);
	const allDiags = results.flatMap((result) => result.diagnostics);
	const total = allDiags.length;
	const truncated = total > MAX_DIAGNOSTICS;
	const display = truncated ? allDiags.slice(0, MAX_DIAGNOSTICS) : allDiags;

	let text: string;
	if (total === 0) {
		text = [
			`Directory: ${absPath}`,
			`Files scanned: ${filesToProcess.length}${wasCapped ? ` (capped at ${MAX_FILES})` : ""}`,
			...(lspHealthWarnings.length > 0
				? [
						"LSP unavailable for one or more files:",
						...lspHealthWarnings.slice(0, 10),
					]
				: ["No diagnostics found."]),
		].join("\n");
	} else {
		const lines: string[] = [
			`Directory: ${absPath}`,
			`Files scanned: ${filesToProcess.length}${wasCapped ? ` (capped at ${MAX_FILES})` : ""}`,
			`Files with errors: ${new Set(display.map((d) => d.file)).size}`,
			`Total diagnostics: ${total}`,
			...(lspHealthWarnings.length > 0
				? ["", "LSP health warnings:", ...lspHealthWarnings.slice(0, 10)]
				: []),
			"",
		];
		for (const d of display) {
			const sevName = SEVERITY_NAMES[d.severity] ?? "unknown";
			const relPath = path.relative(absPath, d.file);
			const loc =
				d.line !== undefined
					? `${relPath}:${d.line + 1}:${(d.character ?? 0) + 1}`
					: d.file;
			const src = d.source ? `[${d.source}]` : "";
			const code = d.code ? ` (${d.code})` : "";
			lines.push(`${loc}: ${sevName}${src}${code}: ${d.message}`);
		}
		if (truncated) {
			lines.push(
				"",
				`... (${total - MAX_DIAGNOSTICS} more diagnostics not shown)`,
			);
		}
		text = lines.join("\n");
	}

	return {
		content: [{ type: "text" as const, text }],
		details: {
			filePath: absPath,
			mode: "directory",
			severity,
			filesScanned: filesToProcess.length,
			capped: wasCapped,
			diagnostics: display.map((d) => ({
				file: path.relative(absPath, d.file),
				line: d.line,
				character: d.character,
				severity: d.severity,
				message: d.message,
				source: d.source,
				code: d.code,
			})),
			totalDiagnostics: total,
			truncated,
			fileErrors: fileErrors.length > 0 ? fileErrors : undefined,
			lspHealthWarnings:
				lspHealthWarnings.length > 0 ? lspHealthWarnings : undefined,
			concurrency: options.concurrency,
			waitMs: options.waitMs,
		},
	};
}

// ── helpers ─────────────────────────────────────────────────────────────

function applySeverityFilter<T extends { severity: number }>(
	diags: T[],
	severity: string,
): T[] {
	if (severity === "all") return diags;
	const maxLevel: Record<string, number> = {
		error: 1,
		warning: 2,
		information: 3,
		hint: 4,
	};
	const max = maxLevel[severity] ?? 0;
	if (max === 0) return diags;
	return diags.filter((d) => (d.severity ?? 3) <= max);
}

function formatDiag(diag: LSPDiagnostic): string {
	const loc =
		diag.range?.start?.line !== undefined
			? `L${diag.range.start.line + 1}:${(diag.range.start.character ?? 0) + 1}`
			: "";
	const src = diag.source ? `[${diag.source}]` : "";
	const code = diag.code ? ` (${diag.code})` : "";
	const sevName = SEVERITY_NAMES[diag.severity] ?? "unknown";
	return `${loc}: ${sevName}${src}${code}: ${diag.message}`;
}

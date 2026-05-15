/**
 * lsp_diagnostics tool definition
 *
 * Proactive LSP diagnostics check — single files or directories.
 * Adopted from code-yeongyu/pi-lsp-client design.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { getLSPService } from "../clients/lsp/index.js";
import type { LSPDiagnostic } from "../clients/lsp/client.js";

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"out",
	"target",
	"__pycache__",
	".venv",
	"venv",
]);

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
const MAX_DIAGNOSTICS = 200;

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

function collectFiles(
	dir: string,
	extensions: string[],
	maxFiles: number,
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
				if (!SKIP_DIRS.has(entry.name)) walk(full);
			} else if (entry.isFile() && extensions.includes(path.extname(full))) {
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
			filePath: Type.String({
				description:
					"File or directory path to check. For directories, all matching source files are scanned.",
			}),
			severity: Type.Optional(
				Type.String({
					enum: ["error", "warning", "information", "hint", "all"],
					description: "Filter by severity level (default: all)",
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
			const rawPath = (params as { filePath: string }).filePath;
			const severity = ((params as { severity?: string }).severity ??
				"all") as string;
			const cwd = ctx.cwd ?? process.cwd();
			const absPath = path.isAbsolute(rawPath)
				? rawPath
				: path.resolve(cwd, rawPath);

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
				return runDirectoryDiagnostics(absPath, severity, lspService);
			}
			return runFileDiagnostics(absPath, severity, lspService);
		},
	};
}

async function runFileDiagnostics(
	absPath: string,
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
) {
	try {
		const content = fs.readFileSync(absPath, "utf-8");
		await lspService.openFile(absPath, content, {
			preserveDiagnostics: false,
		});
	} catch {
		// Non-fatal
	}

	const rawDiags: LSPDiagnostic[] = await lspService.getDiagnostics(absPath);
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
		},
	};
}

async function runDirectoryDiagnostics(
	absPath: string,
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
) {
	let extension: string | undefined;
	let collectedFiles: string[] = [];

	for (const [ext, exts] of Object.entries(LANG_EXTENSIONS)) {
		collectedFiles = collectFiles(absPath, exts, MAX_FILES + 1);
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

	type FileDiag = {
		file: string;
		line?: number;
		character?: number;
		severity: number;
		message: string;
		source?: string;
		code?: string | number;
	};

	const allDiags: FileDiag[] = [];
	const fileErrors: string[] = [];
	const lspHealthWarnings: string[] = [];

	for (const file of filesToProcess) {
		try {
			const content = fs.readFileSync(file, "utf-8");
			await lspService.openFile(file, content, {
				preserveDiagnostics: false,
			});
		} catch {
			fileErrors.push(`${file}: could not read`);
			continue;
		}

		const rawDiags: LSPDiagnostic[] = await lspService.getDiagnostics(file);
		const health = lspService.getDiagnosticsHealth?.(file) as
			| LspHealthLike
			| undefined;
		const unavailable = lspUnavailableMessage(file, health);
		if (unavailable) lspHealthWarnings.push(unavailable);
		for (const d of rawDiags) {
			allDiags.push({
				file,
				line: d.range?.start?.line,
				character: d.range?.start?.character,
				severity: d.severity,
				message: d.message,
				source: d.source,
				code: d.code,
			});
		}
	}

	const filtered = applySeverityFilter(allDiags, severity);
	const total = filtered.length;
	const truncated = total > MAX_DIAGNOSTICS;
	const display = truncated ? filtered.slice(0, MAX_DIAGNOSTICS) : filtered;

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

/**
 * lsp_diagnostics tool definition
 *
 * Proactive LSP diagnostics check — single files or directories.
 * Adopted from code-yeongyu/pi-lsp-client design.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "../clients/deps/typebox.js";
import {
	getProjectIgnoreMatcher,
	isExcludedDirName,
} from "../clients/file-utils.js";
import { getLSPService } from "../clients/lsp/index.js";
import { combineAbortSignals } from "../clients/deadline-utils.js";
import type { LSPDiagnostic } from "../clients/lsp/client.js";
import { classifyCascadeWaitTier } from "../clients/lsp/cascade-tier.js";
import { convertLspDiagnostics } from "../clients/dispatch/utils/lsp-diagnostics.js";
import { reconcileScanDiagnostics } from "../clients/widget-state.js";
import { baseName, compactRenderResult } from "./render-compact.js";
import { makeProgressReporter, scanningSummaryLine } from "./scan-progress.js";

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
	signal?: AbortSignal;
	onProgress?: (completed: number, total: number) => void;
	// #571: threaded down to `collectFileDiagnosticResult` so each confirmed
	// per-file result reconciled into the footer draws its own fresh
	// write-ordering token.
	nextWriteIndex?: () => number;
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
	/**
	 * #533: discriminated per-file outcome, mirroring the #240 doctrine at the
	 * LSP layer (found | clean | unresolved) up through the tool's aggregation.
	 * "found" = diagnostics.length > 0 (self-evident, doesn't need the field).
	 * "clean" = an empty result the server actually confirmed (a pull server, or
	 * a push server whose empty result isn't from a known-silent-on-clean tier).
	 * "unconfirmed" = an empty result from a push-only, silent-on-clean server
	 * (classic typescript-language-server) — indistinguishable from "still
	 * analyzing" or "never asked". Never render this bucket as "0 diagnostics".
	 */
	confirmation?: "clean" | "unconfirmed";
	/**
	 * #570: true when `confirmation === "unconfirmed"` specifically because
	 * the priming LSP check TIMED OUT (notify write and/or diagnostics wait
	 * hit its deadline), as opposed to the server being a known silent-on-
	 * clean tier. Both land in the same "unconfirmed" bucket for counting
	 * purposes, but the reason differs and the rendered text should say so.
	 */
	timedOut?: boolean;
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
	signal?: AbortSignal,
	onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
	const results: R[] = [];
	let nextIndex = 0;
	let completed = 0;
	const workers = Math.min(Math.max(1, concurrency), items.length);
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (true) {
				// Honor cancellation (Escape / turn abort): stop pulling new items
				// rather than grind the whole batch. Completed entries are returned.
				if (signal?.aborted) return;
				const index = nextIndex;
				nextIndex += 1;
				if (index >= items.length) return;
				results[index] = await mapper(items[index]!, index);
				completed += 1;
				onProgress?.(completed, items.length);
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

export function createLspDiagnosticsTool(
	// #571: same shared write-ordering token source `lens_diagnostics` mode=full
	// uses (index.ts injects `() => runtime.nextWriteIndex()`) — a confirmed
	// fresh result this tool reconciles into the footer draws a fresh token so
	// `WriteOrderingGuard` can tell it apart from a concurrent, genuinely newer
	// per-edit write for the same file. Optional/undefined in tests.
	nextWriteIndex?: () => number,
) {
	return {
		name: "lsp_diagnostics" as const,
		label: "LSP Diagnostics",
		description:
			"Get errors, warnings, and hints from language servers for a file or directory. " +
			"Use BEFORE running builds to proactively check for issues. " +
			"Works on directories by auto-detecting file extensions and scanning all matching files.",
		promptSnippet:
			"Get LSP diagnostics for a file or directory (use before builds)",
		renderResult: compactRenderResult<{
			mode?: string;
			phase?: string;
			completed?: number;
			total?: number;
			filePath?: string;
			diagnostics?: unknown[];
			totalDiagnostics?: number;
			filesChecked?: number;
			filesScanned?: number;
			cleanFiles?: number;
			unconfirmedFiles?: number;
			timedOutFiles?: number;
			unconfirmed?: boolean;
			timedOut?: boolean;
		}>(({ details, args, isError, text }) => {
			// Streaming progress partials render the live bar (see scanningSummaryLine).
			const scanning = scanningSummaryLine(details, text);
			if (scanning) return scanning;
			if (isError) {
				return `lsp_diagnostics — ${text.split("\n")[0] ?? "error"}`;
			}
			const count =
				details?.totalDiagnostics ?? details?.diagnostics?.length ?? 0;
			const target =
				baseName(details?.filePath ?? args.path) || "workspace";
			const files = details?.filesChecked ?? details?.filesScanned;
			const scope =
				typeof files === "number" && files > 1
					? ` across ${files} files`
					: target
						? ` ${target}`
						: "";
			const noun = count === 1 ? "diagnostic" : "diagnostics";
			// #533: a batch/directory result with any unconfirmed files must NEVER
			// compact-render as a bare "N diagnostics" — that erases the fact some
			// files' clean status was never actually confirmed by the server.
			const unconfirmedFiles = details?.unconfirmedFiles ?? 0;
			if (unconfirmedFiles > 0) {
				const cleanFiles = details?.cleanFiles ?? 0;
				const timedOutFiles = details?.timedOutFiles ?? 0;
				const suffix =
					timedOutFiles > 0 ? ` (${timedOutFiles} timed out)` : "";
				return `lsp_diagnostics${scope} — ${count} ${noun} · ${cleanFiles} clean · ${unconfirmedFiles} unconfirmed${suffix}`;
			}
			// Single-file mode: 0 diagnostics from an unconfirmed result — either a
			// silent-on-clean server or (#570) a timed-out check — is not a clean
			// render either.
			if (count === 0 && details?.unconfirmed) {
				return details?.timedOut
					? `lsp_diagnostics${scope} — timed out (result may be incomplete)`
					: `lsp_diagnostics${scope} — unconfirmed (server cannot confirm clean)`;
			}
			return `lsp_diagnostics${scope} — ${count} ${noun}`;
		}),
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
			_signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: { cwd?: string; signal?: AbortSignal },
		) {
			// Escape aborts the turn via ctx.signal; honor both it and the tool-call
			// signal so a batch/directory scan cancels rather than grinding on.
			const signal = combineAbortSignals(_signal, ctx.signal);
			// Stream a throttled progress bar for batch/directory scans (opaque for
			// seconds-to-minutes otherwise).
			const onProgress = makeProgressReporter(onUpdate, "Scanning LSP diagnostics");
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
					signal,
					onProgress,
					nextWriteIndex,
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
					signal,
					onProgress,
					nextWriteIndex,
				});
			}
			return runFileDiagnostics(
				absPath,
				severity,
				lspService,
				waitMs,
				nextWriteIndex,
			);
		},
	};
}

type DiagnosticsCollectionResult = {
	diagnostics: LSPDiagnostic[];
	/**
	 * #570: true when the priming `touchFile` call could not confirm its
	 * result (notify write and/or diagnostics wait timed out) before the
	 * follow-up `getDiagnostics` read below. An empty result in that case is
	 * NOT a confirmed clean answer — treat it the same as the existing
	 * "unconfirmed" (silent-on-clean server) bucket rather than reporting a
	 * bare 0.
	 */
	timedOut: boolean;
};

async function collectDiagnosticsForFile(
	absPath: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	waitMs?: number,
): Promise<DiagnosticsCollectionResult> {
	let timedOut = false;
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
			) => Promise<
				(LSPDiagnostic[] & { inconclusive?: boolean }) | undefined
			>;
		};
		if (
			waitMs !== undefined &&
			typeof serviceWithTouch.touchFile === "function"
		) {
			const touched = await serviceWithTouch.touchFile(absPath, content, {
				diagnostics: "document",
				collectDiagnostics: true,
				maxClientWaitMs: waitMs,
				source: "lsp_diagnostics",
				clientScope: "all",
			});
			timedOut = touched?.inconclusive === true;
		} else {
			await lspService.openFile(absPath, content, {
				preserveDiagnostics: false,
			});
		}
	} catch {
		// Non-fatal: getDiagnostics may still have stale/health information.
	}

	const diagnostics = await lspService.getDiagnostics(
		absPath,
		waitMs !== undefined ? "document" : "full",
	);
	return { diagnostics, timedOut };
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

/**
 * #533: classify an EMPTY diagnostic result as "clean" (the server actually
 * confirmed no issues) or "unconfirmed" (came from a push-only,
 * silent-on-clean server — classic typescript-language-server — that
 * publishes nothing on a clean→clean transition, so an empty result here is
 * indistinguishable from "still analyzing" or "never asked"). Reuses the same
 * capability-snapshot classifier the #458 cascade lane already trusts
 * (`classifyCascadeWaitTier`) so this tool's notion of "silent tier-3" stays
 * in lockstep with the rest of the LSP layer instead of drifting via a second
 * copy of the server-strategy table. Fail-safe: any error or missing snapshot
 * (server not alive, capability probe failure) reads as "clean" — the same
 * default this tool has always had — rather than manufacturing a new failure
 * mode from a best-effort classification.
 */
async function classifyEmptyResult(
	file: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
): Promise<"clean" | "unconfirmed"> {
	try {
		const snapshots = await lspService.getCapabilitySnapshots(file);
		const tier = classifyCascadeWaitTier(lspService, file, snapshots);
		return tier === "tier3-silent" ? "unconfirmed" : "clean";
	} catch {
		return "clean";
	}
}

/**
 * #571: reconcile this tool's fresh LSP result into the footer cache
 * (`widget-state.ts`'s `allDiagnostics`) — same shared choke point
 * `lens_diagnostics` mode=full uses (`clients/widget-state.ts`'s
 * `reconcileScanDiagnostics`). A manual `lsp_diagnostics` check that proves a
 * stale footer error is actually gone (the real-world case that surfaced
 * #571) is exactly the kind of confirmed result that should correct it.
 *
 * `rawDiags` (pre-severity-filter) is what gets written — the footer records
 * the true known state, independent of this call's display-only severity
 * filter. A non-empty result is definitionally confirmed (the server DID
 * answer with real diagnostics); an empty result is only confirmed when
 * `classifyEmptyResult` (#533) says "clean", not "unconfirmed" (silent
 * push-only server — indistinguishable from still-analyzing/never-asked, so
 * must not overwrite a real prior footer entry).
 */
function reconcileWidgetFromLspResult(
	file: string,
	rawDiags: LSPDiagnostic[],
	confirmation: "clean" | "unconfirmed" | undefined,
	nextWriteIndex: (() => number) | undefined,
): void {
	const confirmed = rawDiags.length > 0 || confirmation !== "unconfirmed";
	if (!confirmed) return;
	try {
		reconcileScanDiagnostics(
			file,
			convertLspDiagnostics(rawDiags, file, { source: "lsp_diagnostics" }),
			true,
			nextWriteIndex?.(),
		);
	} catch {
		// Never let a footer-reconciliation hiccup fail the diagnostics check.
	}
}

async function collectFileDiagnosticResult(
	file: string,
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	waitMs?: number,
	nextWriteIndex?: () => number,
): Promise<FileDiagnosticResult> {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) {
			return { file, diagnostics: [], error: `${file}: not a file` };
		}
	} catch {
		return { file, diagnostics: [], error: `${file}: path not found` };
	}

	const { diagnostics: rawDiags, timedOut } = await collectDiagnosticsForFile(
		file,
		lspService,
		waitMs,
	);
	const health = lspService.getDiagnosticsHealth?.(file) as
		| LspHealthLike
		| undefined;
	const filteredDiags = applySeverityFilter(rawDiags, severity);
	// #570: a timed-out priming check is never a confirmed "clean" — treat it
	// as unconfirmed without consulting the (unrelated) silent-tier
	// classifier, and remember why so the rendered text is accurate.
	const confirmation =
		filteredDiags.length === 0
			? timedOut
				? "unconfirmed"
				: await classifyEmptyResult(file, lspService)
			: undefined;
	reconcileWidgetFromLspResult(file, rawDiags, confirmation, nextWriteIndex);
	return {
		file,
		diagnostics: diagnosticsToFileDiags(file, filteredDiags),
		unavailable: lspUnavailableMessage(file, health),
		confirmation,
		timedOut: confirmation === "unconfirmed" ? timedOut : undefined,
	};
}

async function runFileDiagnostics(
	absPath: string,
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	waitMs?: number,
	nextWriteIndex?: () => number,
) {
	const { diagnostics: rawDiags, timedOut } = await collectDiagnosticsForFile(
		absPath,
		lspService,
		waitMs,
	);
	const lspHealth = lspService.getDiagnosticsHealth?.(absPath) as
		| LspHealthLike
		| undefined;
	const unavailable = lspUnavailableMessage(absPath, lspHealth);
	const filtered = applySeverityFilter(rawDiags, severity);
	const total = filtered.length;
	const truncated = total > MAX_DIAGNOSTICS;
	const limited = truncated ? filtered.slice(0, MAX_DIAGNOSTICS) : filtered;
	// #533: an empty result needs a confirmed/unconfirmed verdict — a push-only,
	// silent-on-clean server (classic typescript) publishes nothing on a
	// clean→clean edit, so "0 diagnostics" from it is unverifiable, not clean.
	// #570: a timed-out priming check is a second, distinct reason a result
	// can be unconfirmed — checked first since it's a property of THIS check,
	// not a general server-capability classification.
	const confirmation =
		total === 0
			? timedOut
				? "unconfirmed"
				: await classifyEmptyResult(absPath, lspService)
			: undefined;
	const unconfirmed = confirmation === "unconfirmed";
	reconcileWidgetFromLspResult(absPath, rawDiags, confirmation, nextWriteIndex);

	let text: string;
	if (total === 0) {
		text = timedOut
			? "Diagnostics check timed out: the LSP server didn't confirm a result " +
				"within the wait budget. This is NOT the same as 0 diagnostics; the " +
				"file may still have errors that just hadn't been reported yet. " +
				"Re-check after the server settles, or increase waitMs."
			: unconfirmed
				? "Diagnostics unconfirmed: the server for this file cannot confirm a " +
					"clean result (push-only, silent-on-clean — e.g. classic " +
					"typescript-language-server never publishes on a clean re-check). " +
					"This is NOT the same as 0 diagnostics; it may still be analyzing or " +
					"may never have been asked. Re-check after an edit, or use waitMs to " +
					"wait longer."
				: (unavailable ?? "No diagnostics found.");
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
			unconfirmed,
			timedOut: unconfirmed ? timedOut : undefined,
			lspHealth,
			waitMs,
		},
	};
}

/**
 * #533: tally the per-file discriminated outcome across a batch/directory
 * result set. `unconfirmed` files are those whose diagnostics collapsed to an
 * empty array from a push-only, silent-on-clean server (see
 * `classifyEmptyResult`) — they must never be folded into "clean" in the
 * aggregate render, or a majority-unconfirmed result reads as a false "0
 * diagnostics across N files".
 */
function tallyConfirmation(results: FileDiagnosticResult[]): {
	clean: number;
	unconfirmed: number;
	timedOut: number;
} {
	let clean = 0;
	let unconfirmed = 0;
	let timedOut = 0;
	for (const result of results) {
		if (result.diagnostics.length > 0) continue;
		if (result.confirmation === "unconfirmed") {
			unconfirmed += 1;
			// #570: timed-out checks are a subset of "unconfirmed" — tallied
			// separately so the aggregate text can say WHY, not just THAT.
			if (result.timedOut) timedOut += 1;
		} else {
			clean += 1;
		}
	}
	return { clean, unconfirmed, timedOut };
}

/**
 * #570: build the explanatory clause for a batch/directory result that has
 * unconfirmed files, distinguishing timed-out checks from the pre-existing
 * #533 silent-on-clean-server bucket — both are "unconfirmed" for counting,
 * but the reason differs and misreporting a timeout as "server can't confirm
 * clean" would itself be misleading.
 */
function unconfirmedReasonClause(unconfirmed: number, timedOut: number): string {
	const silent = unconfirmed - timedOut;
	if (timedOut > 0 && silent > 0) {
		return (
			`${timedOut} timed out (check didn't complete within budget) and ` +
			`${silent} from a server that cannot confirm clean (push-only, ` +
			"silent-on-clean)."
		);
	}
	if (timedOut > 0) {
		return `${timedOut} timed out (check didn't complete within the wait budget).`;
	}
	return (
		"from a server that cannot confirm clean (push-only, silent-on-clean; " +
		"e.g. classic typescript-language-server does not publish on a clean " +
		"re-check)."
	);
}

/**
 * Fan out `collectFileDiagnosticResult` across a file list at bounded
 * concurrency and reduce the results into the shape both batch-style callers
 * (`runBatchFileDiagnostics`/`runDirectoryDiagnostics`) render from —
 * previously duplicated identically between them (SonarCloud
 * `new_duplicated_lines_density` gate, surfaced when #571 added the
 * `nextWriteIndex` threading to both call sites). Purely mechanical
 * extraction: no behavior change, and does NOT touch the confirmed/
 * unconfirmed semantics `collectFileDiagnosticResult`/`tallyConfirmation`
 * already encode — those, and `lens_diagnostics` mode=full's separate,
 * deliberately different confirmation gate in `tools/lens-diagnostics.ts`,
 * are unrelated to this file's internal duplication and are left exactly
 * as they were.
 */
async function collectBatchDiagnostics(
	files: string[],
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	options: BatchOptions,
): Promise<{
	results: FileDiagnosticResult[];
	fileErrors: string[];
	lspHealthWarnings: string[];
	total: number;
	truncated: boolean;
	display: FileDiag[];
	clean: number;
	unconfirmed: number;
	timedOut: number;
}> {
	const results = await mapWithConcurrency(
		files,
		options.concurrency,
		(file) =>
			collectFileDiagnosticResult(
				file,
				severity,
				lspService,
				options.waitMs,
				options.nextWriteIndex,
			),
		options.signal,
		options.onProgress,
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
	const { clean, unconfirmed, timedOut } = tallyConfirmation(results);
	return {
		results,
		fileErrors,
		lspHealthWarnings,
		total,
		truncated,
		display,
		clean,
		unconfirmed,
		timedOut,
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

	const {
		results,
		fileErrors,
		lspHealthWarnings,
		total,
		truncated,
		display,
		clean,
		unconfirmed,
		timedOut,
	} = await collectBatchDiagnostics(absPaths, severity, lspService, options);

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
	// #533/#570: surface unconfirmed files regardless of whether OTHER files in
	// the batch found real diagnostics — a mixed found/unconfirmed result must
	// not let the unconfirmed files silently pass as clean just because the
	// batch as a whole isn't "0 diagnostics".
	if (unconfirmed > 0) {
		lines.push(
			"",
			`${clean} file${clean === 1 ? "" : "s"} confirmed clean, ${unconfirmed} unconfirmed: ` +
				`${unconfirmedReasonClause(unconfirmed, timedOut)} NOT the same as 0 diagnostics.`,
		);
	}
	if (display.length === 0) {
		if (unconfirmed === 0) {
			lines.push("", "No diagnostics found.");
		}
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
			cleanFiles: clean,
			unconfirmedFiles: unconfirmed,
			timedOutFiles: timedOut > 0 ? timedOut : undefined,
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
	const {
		fileErrors,
		lspHealthWarnings,
		total,
		truncated,
		display,
		clean,
		unconfirmed,
		timedOut,
	} = await collectBatchDiagnostics(
		filesToProcess,
		severity,
		lspService,
		options,
	);

	let text: string;
	if (total === 0) {
		// #533/#570: an unconfirmed-containing directory result must never
		// render as a bare "no diagnostics" — that reads as an affirmative
		// clean scan the server never actually gave for those files.
		const cleanLine =
			unconfirmed > 0
				? `${clean} clean · ${unconfirmed} unconfirmed: ` +
					`${unconfirmedReasonClause(unconfirmed, timedOut)} NOT the same as 0 diagnostics.`
				: "No diagnostics found.";
		text = [
			`Directory: ${absPath}`,
			`Files scanned: ${filesToProcess.length}${wasCapped ? ` (capped at ${MAX_FILES})` : ""}`,
			...(lspHealthWarnings.length > 0
				? [
						"LSP unavailable for one or more files:",
						...lspHealthWarnings.slice(0, 10),
					]
				: [cleanLine]),
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
			// #533/#570: the remaining clean-looking files in a mixed scan may
			// still be unconfirmed — say so even though the directory as a
			// whole found diagnostics elsewhere.
			...(unconfirmed > 0
				? [
						"",
						`${clean} other file${clean === 1 ? "" : "s"} confirmed clean, ${unconfirmed} unconfirmed: ` +
							unconfirmedReasonClause(unconfirmed, timedOut),
					]
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
			cleanFiles: clean,
			unconfirmedFiles: unconfirmed,
			timedOutFiles: timedOut > 0 ? timedOut : undefined,
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

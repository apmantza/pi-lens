/**
 * Format Service for pi-lens
 *
 * Concurrent formatter execution using Effect-TS.
 * Auto-formats files on write with a single selected formatter per file.
 *
 * Key features:
 * - Chooses one formatter per file using config-gated or smart-default policy
 * - Runs formatting with timeout protection
 * - FileTime integration for safety
 * - Explicit config wins; otherwise smart defaults apply
 */

import { logExtension } from "./extension-log.js";
import * as path from "node:path";
import { recordFormatter } from "./widget-state.js";
import { FileTime } from "./file-time.js";
import type {
	FormatterInfo,
	FormatterOutcomeKind,
	FormatterResult,
} from "./formatters.js";
import { loadFormatters } from "./formatters-lazy.js";

// --- Configuration ---

/** Reserved for future batching; formatting currently runs one selected formatter per file. */
const DEFAULT_FORMATTER_CONCURRENCY = 1;

// --- Types ---

export interface FormatOptions {
	/** Skip auto-format even if enabled (manual mode) */
	skip?: boolean;
	/** Specific formatters to use (overrides detection) */
	formatters?: string[];
}

export interface FormatSummary {
	filePath: string;
	formatters: Array<{
		name: string;
		success: boolean;
		changed: boolean;
		error?: string;
		/** Typed outcome kind (#2413) — separates `unavailable` from `failed`. */
		outcome: FormatterOutcomeKind;
	}>;
	anyChanged: boolean;
	allSucceeded: boolean;
}

// --- Format Service ---

export class FormatService {
	private fileTime: FileTime;
	private enabled: boolean;

	constructor(sessionID: string, enabled: boolean = true) {
		this.fileTime = new FileTime(sessionID);
		this.enabled = enabled;
	}

	/**
	 * Format a file with the single selected formatter for that file.
	 */
	async formatFile(
		filePath: string,
		options: FormatOptions = {},
	): Promise<FormatSummary> {
		const absolutePath = path.resolve(filePath);
		const cwd = path.dirname(absolutePath);

		// Skip if disabled
		if (options.skip || !this.enabled) {
			return {
				filePath: absolutePath,
				formatters: [],
				anyChanged: false,
				allSucceeded: true,
			};
		}

		// Check if file was modified externally (safety check)
		if (this.fileTime.hasChanged(absolutePath)) {
			logExtension({
				subsystem: "format",
				level: "warn",
				message: `File ${absolutePath} modified externally, skipping format`,
				metadata: { filePath: absolutePath },
			});
			return {
				filePath: absolutePath,
				formatters: [],
				anyChanged: false,
				allSucceeded: false,
			};
		}

		// Get formatters for this file
		const formatters = options.formatters
			? await this.getFormattersByName(options.formatters)
			: await (await loadFormatters()).getFormattersForFile(absolutePath, cwd);

		if (formatters.length === 0) {
			return {
				filePath: absolutePath,
				formatters: [],
				anyChanged: false,
				allSucceeded: true,
			};
		}

		// Run formatters with limited concurrency
		const results = await this.runFormattersWithConcurrency(
			absolutePath,
			formatters,
		);

		// Record new file state after formatting
		this.fileTime.read(absolutePath);

		for (const [index, result] of results.entries()) {
			recordFormatter(
				absolutePath,
				formatters[index]?.name ?? "unknown",
				result.changed,
				result.success,
				result.outcome,
			);
		}

		// Build summary
		const anyChanged = results.some((r) => r.changed);
		const allSucceeded = results.every((r) => r.success);

		return {
			filePath: absolutePath,
			formatters: results.map((r, i) => ({
				name: formatters[i].name,
				success: r.success,
				changed: r.changed,
				error: r.error,
				outcome: r.outcome,
			})),
			anyChanged,
			allSucceeded,
		};
	}

	/**
	 * Run the selected formatter with timeout protection.
	 */
	private async runFormattersWithConcurrency(
		filePath: string,
		formatters: FormatterInfo[],
		_concurrency = DEFAULT_FORMATTER_CONCURRENCY,
	): Promise<FormatterResult[]> {
		const results: FormatterResult[] = [];

		for (const formatter of formatters) {
			// #1097: keep the timer handle so it can be cleared once the race
			// settles. An uncleared, REF'D 30s setTimeout that outlives a fast
			// `formatFile` win would keep a one-shot `pi --print` process alive for
			// up to 30s after completion (same uncleared-race-timeout class as the
			// LSP client-wait leak fixed in clients/lsp/index.ts).
			let formatTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				const timeoutMs = 30000;
				const timeoutPromise = new Promise<FormatterResult>((_, reject) => {
					formatTimer = setTimeout(
						() =>
							reject(
								new Error(
									`Formatter ${formatter.name} timed out after ${timeoutMs}ms`,
								),
							),
						timeoutMs,
					);
				});

				const result = await Promise.race([
					loadFormatters().then(({ formatFile }) =>
						formatFile(filePath, formatter),
					),
					timeoutPromise,
				]);
				results.push(result);
			} catch (error) {
				// A timeout or thrown error here is a real failure (#2413): the
				// formatter ran and did not complete, distinct from an unavailable
				// executable (which formatFile classifies before spawning).
				results.push({
					success: false,
					changed: false,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				if (formatTimer) clearTimeout(formatTimer);
			}
		}

		return results;
	}

	/**
	 * Get formatters by name (for explicit formatter selection)
	 */
	private async getFormattersByName(names: string[]): Promise<FormatterInfo[]> {
		const { listAllFormatters, ...formatters } = await loadFormatters();
		const allNames = listAllFormatters();

		return names
			.filter((name) => allNames.includes(name))
			.map((name) => {
				// Convert hyphenated name to camelCase then append Formatter
				// e.g. "php-cs-fixer" → "phpCsFixerFormatter", "clang-format" → "clangFormatFormatter"
				const camel = name.replace(/-([a-z])/g, (_, c: string) =>
					c.toUpperCase(),
				);
				const key = `${camel}Formatter` as keyof typeof formatters;
				return formatters[key] as FormatterInfo;
			})
			.filter(Boolean);
	}

	/**
	 * Assert file hasn't changed before editing
	 * Throws FileTimeError if file modified externally
	 */
	assertUnchanged(filePath: string): void {
		this.fileTime.assert(filePath);
	}

	/**
	 * Check if file has changed externally
	 */
	hasChanged(filePath: string): boolean {
		return this.fileTime.hasChanged(filePath);
	}

	/**
	 * Record file read (after agent reads file)
	 */
	recordRead(filePath: string): void {
		this.fileTime.read(filePath);
	}

	/**
	 * Clear detection cache
	 */
	clearCache(): void {
		void loadFormatters().then(({ clearFormatterRuntimeState }) =>
			clearFormatterRuntimeState(),
		);
	}
}

// --- Singleton Instance ---

let globalFormatService: FormatService | null = null;
let currentSessionID: string | null = null;

export function getFormatService(
	sessionID?: string,
	enabled: boolean = true,
): FormatService {
	// Create new instance if:
	// 1. No service exists yet
	// 2. Session ID changed (different session)
	const shouldCreateNew =
		!globalFormatService || (sessionID && sessionID !== currentSessionID);

	if (shouldCreateNew) {
		globalFormatService = new FormatService(sessionID ?? "default", enabled);
		currentSessionID = sessionID ?? "default";
	}
	return globalFormatService!;
}

export function resetFormatService(): void {
	void loadFormatters().then(({ clearFormatterRuntimeState }) =>
		clearFormatterRuntimeState(),
	);
	globalFormatService = null;
	currentSessionID = null;
}

/**
 * Reset format service and clear all file tracking state.
 * Use this in tests to ensure complete isolation.
 */
export function clearFormatServiceAndFileState(): void {
	resetFormatService();
}

// Re-export for convenience

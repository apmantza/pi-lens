import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyDefect } from "../diagnostic-taxonomy.js";
import { PRIORITY } from "../priorities.js";
import type {
	DefectClass,
	Diagnostic,
	DispatchContext,
	OutputSemantic,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveOpengrepConfig } from "../../opengrep-config.js";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
} from "./utils/runner-helpers.js";

const opengrep = createAvailabilityChecker("opengrep", ".exe");
const MAX_DIAGNOSTICS = 50;

// Content+config result cache. Opengrep is expensive per invocation (~2s engine
// cold-start floor, ~8s with the `auto` ruleset — see #111 latency notes), so
// we skip re-scanning a file whose content and effective `--config` are
// unchanged since the last scan (redundant re-dispatch, fork rehydrate, a
// sibling runner re-triggering the group). A real edit changes the content hash
// and correctly misses the cache.
interface OpengrepCacheEntry {
	signature: string;
	result: RunnerResult;
}
const scanCache = new Map<string, OpengrepCacheEntry>();

/** Test-only: clear the module-level scan cache between cases. */
export function _resetOpengrepCacheForTests(): void {
	scanCache.clear();
}

function fileSignature(
	filePath: string,
	configArg: string | undefined,
): string | undefined {
	try {
		const content = fs.readFileSync(filePath);
		return crypto
			.createHash("sha1")
			.update(configArg ?? "")
			.update("\0")
			.update(content)
			.digest("hex");
	} catch {
		return undefined;
	}
}

interface OpengrepJsonOutput {
	results?: OpengrepResult[];
	errors?: Array<{ message?: string; type?: string; level?: string }>;
}

interface OpengrepResult {
	check_id?: string;
	path?: string;
	start?: { line?: number; col?: number };
	extra?: {
		message?: string;
		severity?: string;
		metadata?: Record<string, unknown>;
		fix?: string;
		fix_regex?: unknown;
	};
}

function getPiLensMetadata(
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	const nested = metadata["pi-lens"] ?? metadata.pi_lens;
	return nested && typeof nested === "object"
		? (nested as Record<string, unknown>)
		: {};
}

function metadataString(
	metadata: Record<string, unknown>,
	piLens: Record<string, unknown>,
	key: string,
): string | undefined {
	const direct = piLens[key] ?? metadata[`pi_lens_${key}`];
	return typeof direct === "string" && direct.trim()
		? direct.trim()
		: undefined;
}

function metadataBoolean(
	metadata: Record<string, unknown>,
	piLens: Record<string, unknown>,
	key: string,
): boolean {
	return piLens[key] === true || metadata[`pi_lens_${key}`] === true;
}

function normalizeDefectClass(
	value: string | undefined,
): DefectClass | undefined {
	if (!value) return undefined;
	const normalized = value.toLowerCase().replace(/_/g, "-");
	if (
		normalized === "silent-error" ||
		normalized === "injection" ||
		normalized === "secrets" ||
		normalized === "async-misuse" ||
		normalized === "correctness" ||
		normalized === "safety" ||
		normalized === "style" ||
		normalized === "unknown" ||
		normalized === "unused-value"
	) {
		return normalized;
	}
	if (
		normalized.includes("traversal") ||
		normalized.includes("ssrf") ||
		normalized.includes("xss") ||
		normalized.includes("deserial") ||
		normalized.includes("crypto") ||
		normalized.includes("auth")
	) {
		return "safety";
	}
	return undefined;
}

function opengrepSemantic(
	result: OpengrepResult,
	defectClass: DefectClass,
): OutputSemantic {
	const metadata = result.extra?.metadata ?? {};
	const piLens = getPiLensMetadata(metadata);
	const explicitSemantic = metadataString(metadata, piLens, "semantic");
	if (
		explicitSemantic === "blocking" ||
		metadataBoolean(metadata, piLens, "blocking")
	) {
		return "blocking";
	}
	if (explicitSemantic === "warning" || explicitSemantic === "silent") {
		return explicitSemantic;
	}

	const severity = String(result.extra?.severity ?? "").toUpperCase();
	const confidence = String(
		metadata.confidence ?? piLens.confidence ?? "",
	).toLowerCase();
	const highSignalSecurity =
		defectClass === "injection" ||
		defectClass === "secrets" ||
		defectClass === "safety";

	if (severity === "ERROR" && highSignalSecurity && confidence !== "low") {
		return "blocking";
	}

	return "warning";
}

function mapSeverity(
	opengrepSeverity: string | undefined,
	semantic: OutputSemantic,
): Diagnostic["severity"] {
	if (semantic === "blocking") return "error";
	const severity = String(opengrepSeverity ?? "").toUpperCase();
	if (severity === "ERROR") return "error";
	if (severity === "INFO") return "info";
	return "warning";
}

export function parseOpengrepJson(raw: string, ctx: DispatchContext): Diagnostic[] {
	if (!raw.trim()) return [];
	let parsed: OpengrepJsonOutput;
	try {
		parsed = JSON.parse(raw) as OpengrepJsonOutput;
	} catch {
		return [];
	}

	const results = Array.isArray(parsed.results) ? parsed.results : [];
	const diagnostics: Diagnostic[] = [];

	for (const [index, result] of results.entries()) {
		if (diagnostics.length >= MAX_DIAGNOSTICS) break;
		const rule = result.check_id || "opengrep";
		const message = result.extra?.message || rule;
		const metadata = result.extra?.metadata ?? {};
		const piLens = getPiLensMetadata(metadata);
		const explicitDefect = normalizeDefectClass(
			metadataString(metadata, piLens, "defect_class"),
		);
		const defectClass =
			explicitDefect ?? classifyDefect(rule, "opengrep", message);
		const semantic = opengrepSemantic(result, defectClass);
		const filePath = result.path || ctx.filePath;
		const line = result.start?.line ?? 1;
		const column = result.start?.col ?? 1;
		const fixSuggestion =
			metadataString(metadata, piLens, "fix") ??
			(typeof result.extra?.fix === "string" ? result.extra.fix : undefined);

		diagnostics.push({
			id: `opengrep:${rule}:${path.basename(filePath)}:${line}:${column}:${index}`,
			message: `[${rule}] ${message}`,
			filePath,
			line,
			column,
			severity: mapSeverity(result.extra?.severity, semantic),
			semantic,
			tool: "opengrep",
			rule,
			defectClass,
			fixable: Boolean(fixSuggestion || result.extra?.fix_regex),
			autoFixAvailable: false,
			fixKind:
				fixSuggestion || result.extra?.fix_regex ? "suggestion" : undefined,
			fixSuggestion,
		});
	}

	return diagnostics;
}

const opengrepRunner: RunnerDefinition = {
	id: "opengrep",
	appliesTo: [
		"csharp",
		"css",
		"cxx",
		"dart",
		"docker",
		"go",
		"html",
		"java",
		"json",
		"jsts",
		"kotlin",
		"lua",
		"php",
		"python",
		"ruby",
		"rust",
		"shell",
		"swift",
		"terraform",
		"yaml",
	],
	priority: PRIORITY.DEEP_LANGUAGE_ANALYSIS,
	enabledByDefault: false,

	async when(ctx: DispatchContext): Promise<boolean> {
		return resolveOpengrepConfig(ctx.cwd, {
			enabled: Boolean(ctx.pi.getFlag("lens-opengrep")),
			config: ctx.pi.getFlag("lens-opengrep-config"),
		}).enabled;
	},

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const resolved = resolveOpengrepConfig(cwd, {
			enabled: Boolean(ctx.pi.getFlag("lens-opengrep")),
			config: ctx.pi.getFlag("lens-opengrep-config"),
		});
		if (!resolved.enabled) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Return a cached result when this file's content + effective config are
		// unchanged since the last scan (avoids redundant re-runs of an expensive
		// scanner — see scanCache note).
		const signature = fileSignature(ctx.filePath, resolved.configArg);
		if (signature) {
			const cached = scanCache.get(ctx.filePath);
			if (cached && cached.signature === signature) return cached.result;
		}

		// Opengrep is auto-installable (single GitHub-release binary, no login or
		// telemetry) — unlike Semgrep it installs on demand when elected (#111).
		const cmd = await resolveAvailableOrInstall(opengrep, "opengrep", cwd);
		if (!cmd) {
			// Not installed yet — don't cache, so a later run retries after install.
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// NOTE: Opengrep has no `--metrics` flag (it never phones home), so unlike
		// Semgrep we must NOT pass `--metrics=off` — it would error on the unknown flag.
		const args = ["scan", "--json", "--timeout", "5"];
		if (resolved.configArg) args.push("--config", resolved.configArg);
		args.push(ctx.filePath);

		const spawnResult = await safeSpawnAsync(cmd, args, { cwd, timeout: 20000 });
		const diagnostics = parseOpengrepJson(spawnResult.stdout || "", ctx);

		let result: RunnerResult;
		if (diagnostics.length === 0) {
			result = {
				status: spawnResult.error ? "failed" : "succeeded",
				diagnostics: [],
				semantic: "none",
				rawOutput: (spawnResult.stderr || "").slice(0, 500),
			};
		} else {
			const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
			result = {
				status: hasBlocking ? "failed" : "succeeded",
				diagnostics,
				semantic: hasBlocking ? "blocking" : "warning",
			};
		}

		// Cache only successful scans — a spawn error (e.g. timeout) should retry.
		if (signature && !spawnResult.error) {
			scanCache.set(ctx.filePath, { signature, result });
		}
		return result;
	},
};

export default opengrepRunner;

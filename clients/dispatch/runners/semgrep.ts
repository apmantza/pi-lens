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
import { resolveSemgrepConfig } from "../../semgrep-config.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const semgrep = createAvailabilityChecker("semgrep", ".exe");
const MAX_DIAGNOSTICS = 50;

interface SemgrepJsonOutput {
	results?: SemgrepResult[];
	errors?: Array<{ message?: string; type?: string; level?: string }>;
}

interface SemgrepResult {
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

function semgrepSemantic(
	result: SemgrepResult,
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
		metadata.confidence ??
			metadata.semgrep_confidence ??
			piLens.confidence ??
			"",
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
	semgrepSeverity: string | undefined,
	semantic: OutputSemantic,
): Diagnostic["severity"] {
	if (semantic === "blocking") return "error";
	const severity = String(semgrepSeverity ?? "").toUpperCase();
	if (severity === "ERROR") return "error";
	if (severity === "INFO") return "info";
	return "warning";
}

function parseSemgrepJson(raw: string, ctx: DispatchContext): Diagnostic[] {
	if (!raw.trim()) return [];
	let parsed: SemgrepJsonOutput;
	try {
		parsed = JSON.parse(raw) as SemgrepJsonOutput;
	} catch {
		return [];
	}

	const results = Array.isArray(parsed.results) ? parsed.results : [];
	const diagnostics: Diagnostic[] = [];

	for (const [index, result] of results.entries()) {
		if (diagnostics.length >= MAX_DIAGNOSTICS) break;
		const rule = result.check_id || "semgrep";
		const message = result.extra?.message || rule;
		const metadata = result.extra?.metadata ?? {};
		const piLens = getPiLensMetadata(metadata);
		const explicitDefect = normalizeDefectClass(
			metadataString(metadata, piLens, "defect_class"),
		);
		const defectClass =
			explicitDefect ?? classifyDefect(rule, "semgrep", message);
		const semantic = semgrepSemantic(result, defectClass);
		const filePath = result.path || ctx.filePath;
		const line = result.start?.line ?? 1;
		const column = result.start?.col ?? 1;
		const fixSuggestion =
			metadataString(metadata, piLens, "fix") ??
			(typeof result.extra?.fix === "string" ? result.extra.fix : undefined);

		diagnostics.push({
			id: `semgrep:${rule}:${path.basename(filePath)}:${line}:${column}:${index}`,
			message: `[${rule}] ${message}`,
			filePath,
			line,
			column,
			severity: mapSeverity(result.extra?.severity, semantic),
			semantic,
			tool: "semgrep",
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

const semgrepRunner: RunnerDefinition = {
	id: "semgrep",
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
		return resolveSemgrepConfig(ctx.cwd, {
			enabled: Boolean(ctx.pi.getFlag("lens-semgrep")),
			config: ctx.pi.getFlag("lens-semgrep-config"),
		}).enabled;
	},

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const resolved = resolveSemgrepConfig(cwd, {
			enabled: Boolean(ctx.pi.getFlag("lens-semgrep")),
			config: ctx.pi.getFlag("lens-semgrep-config"),
		});
		if (!resolved.enabled) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (
			!(await (semgrep.isAvailableAsync(cwd)))
		) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		const cmd = semgrep.getCommand(cwd) ?? "semgrep";
		const args = ["scan", "--json", "--metrics=off", "--timeout", "5"];
		if (resolved.configArg) args.push("--config", resolved.configArg);
		args.push(ctx.filePath);

		const result = await safeSpawnAsync(cmd, args, { cwd, timeout: 20000 });
		const raw = result.stdout || "";
		const diagnostics = parseSemgrepJson(raw, ctx);
		if (diagnostics.length === 0) {
			return {
				status: result.error ? "failed" : "succeeded",
				diagnostics: [],
				semantic: "none",
				rawOutput: (result.stderr || "").slice(0, 500),
			};
		}

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
	},
};

export default semgrepRunner;

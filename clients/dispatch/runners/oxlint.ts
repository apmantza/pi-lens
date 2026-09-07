/**
 * Oxlint runner for dispatch system
 *
 * Fast JavaScript/TypeScript linter written in Rust.
 * Drop-in replacement for ESLint with better performance.
 *
 * Requires: oxlint (npm install -g oxlint)
 */

import { findLocalBinUpwards } from "../../package-manager.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { truncatedByOutputCap } from "../../spawn-output-cap.js";
import {
	getJstsLintPolicyForCwd,
	hasVitePlusConfig,
} from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	resolveToolCommand,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

// One file's JSON report. Nothing legitimate approaches 8 MiB here, so this is
// a blast-radius bound on a runaway or wedged oxlint rather than a working
// limit — the same value MAX_SG_OUTPUT_BYTES and MAX_REPORT_BYTES use, and what
// makes `outputTruncated` reachable for this runner at all (#2100).
const MAX_OXLINT_OUTPUT_BYTES = 8 * 1024 * 1024;

const OXLINT_NO_FILES = Symbol("oxlint-no-files");
const OXLINT_NO_FILES_UNCONFIRMED = Symbol("oxlint-no-files-unconfirmed");
const OXLINT_NO_FILES_BANNER =
	"No files found to lint. Please check your paths and ignore patterns.";
const OXLINT_NO_FILES_REPORT_KEYS = new Set([
	"diagnostics",
	"number_of_files",
	"number_of_rules",
	"threads_count",
	"start_time",
]);

type OxlintProcessState =
	| "normal"
	| "spawn"
	| "timeout"
	| "killed"
	| "signal"
	| "truncated";
type OxlintNoFilesUnconfirmedReason =
	| `process-${Exclude<OxlintProcessState, "normal">}`
	| "status-zero"
	| "status-null"
	| "status-other"
	| "stderr-nonempty"
	| "banner-near"
	| "banner-missing"
	| "json-malformed"
	| "json-unknown-key"
	| "json-missing-key"
	| "json-known-field-invalid"
	| "diagnostics-nonempty"
	| "files-nonzero";

export type OxlintNoFilesDecision =
	| { kind: "expected-no-files" }
	| { kind: "ordinary-report" }
	| { kind: "unconfirmed-no-files"; reason: OxlintNoFilesUnconfirmedReason };

/**
 * Vite+'s `vp` from the project's own `node_modules/.bin`.
 *
 * Delegates to THE shared bin walker (#2544 review F1). This was a private,
 * UNCEILINGED copy of that walk, while `formatters.ts`'s `oxfmtFormatter`
 * resolved the SAME binary — `vp` — through the ceilinged `findInNodeModules`:
 * one `vp` resolver stopped at `$HOME` and the other climbed past it to the
 * filesystem root, so which policy applied depended on whether the format path
 * or the lint path asked. A `node_modules/.bin/vp` at or above `$HOME` can
 * never be this project's own Vite+ install (#2514).
 */
function resolveLocalVp(cwd: string): string | null {
	return findLocalBinUpwards("vp", cwd) ?? null;
}

async function resolveVitePlusCommand(cwd: string): Promise<string | null> {
	const local = resolveLocalVp(cwd);
	if (local) return local;
	const version = await safeSpawnAsync("vp", ["--version"], {
		timeout: 5000,
		cwd,
	});
	return !version.error && version.status === 0 ? "vp" : null;
}

const oxlintRunner: RunnerDefinition = {
	id: "oxlint",
	appliesTo: ["jsts"],
	priority: PRIORITY.LINT_SECONDARY,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getJstsLintPolicyForCwd(cwd);
		if (!policy.preferredRunners.includes("oxlint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		let args: string[];
		if (hasVitePlusConfig(cwd)) {
			cmd = await resolveVitePlusCommand(cwd);
		}
		if (cmd) {
			args = ["lint", "--format", "json", ctx.filePath];
		} else {
			// Use ctx.hasTool for async availability check — avoids the synchronous
			// spawnSync probe that blocks the event loop on first call per cwd.
			// FactStore caches the result for the session so subsequent writes are free.
			const oxlintCmd = resolveToolCommand(cwd, "oxlint") ?? "oxlint";
			cmd = (await ctx.hasTool(oxlintCmd))
				? oxlintCmd
				: await resolveToolCommandWithInstallFallback(cwd, "oxlint");
			args = ["--format", "json", ctx.filePath];
		}
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run oxlint (or Vite+'s vp lint wrapper) on the file.
		const result = await safeSpawnAsync(cmd, args, {
			cwd,
			timeout: 30000,
			maxOutputBytes: MAX_OXLINT_OUTPUT_BYTES,
		});

		// Oxlint exits 0 whenever nothing at ERROR severity was found — that
		// includes a run that found only warnings, its own default severity
		// (#1947). A run that found nothing at all also exits 0, but still
		// prints a report with an empty `diagnostics` array, so parsing
		// unconditionally and branching on the parsed count (below) tells the
		// two apart instead of the exit code discarding the warning case.
		//
		// Parse JSON output. Fall back to the unix-format parser if JSON parsing
		// fails (older oxlint versions, malformed stderr noise, etc.) — keeps the
		// runner producing diagnostics even when the structured-fix metadata is
		// unavailable.
		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		const parsedOutput = stdout + stderr;
		const noFilesDecision = decideOxlintNoFiles(result, stdout, stderr);
		// #1994's shared gate classifies invocation and parsed-output failures.
		// The private markers preserve one legitimate nonzero/empty shape and
		// force a status-0 lookalike away from clean. Neither escapes this runner.
		// parseToolRun checks process failures before invoking this parser, so
		// spawn/timeout/killed/signal precedence remains owned by #1994.
		const parsedRun = parseToolRun<
			Diagnostic | typeof OXLINT_NO_FILES | typeof OXLINT_NO_FILES_UNCONFIRMED
		>(
			"oxlint",
			{ result, output: parsedOutput },
			() => {
				if (noFilesDecision.kind === "expected-no-files") {
					return [OXLINT_NO_FILES];
				}
				if (
					noFilesDecision.kind === "unconfirmed-no-files" &&
					result.status === 0
				) {
					return [OXLINT_NO_FILES_UNCONFIRMED];
				}
				let parsed = parseOxlintJson(stdout, ctx.filePath);
				if (parsed.length === 0 && stdout.length > 0) {
					parsed = parseOxlintUnix(parsedOutput, ctx.filePath);
				}
				return parsed;
			},
			{ parseOutput: parsedOutput },
		);
		if (parsedRun.skipped) return parsedRun.skipped;

		if (parsedRun.diagnostics.includes(OXLINT_NO_FILES)) {
			// Real captured bytes show oxlint exits
			// 1 with "No files found" + number_of_files: 0 when a config excludes
			// the target, so "nonzero exit" alone cannot mean "unreadable report
			// of problems" until the no-files shape is ruled out.
			// Read BEFORE reporting "succeeded" — a config (root's or a nested
			// one nearer the file, per oxlint's own discovery) that ignores this
			// file reports the same empty diagnostics array a clean file does.
			// "succeeded"/"none" would say "we checked, it's clean"; this file
			// was never checked at all.
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
				skipReason: "no-files-matched",
			};
		}
		if (parsedRun.diagnostics.includes(OXLINT_NO_FILES_UNCONFIRMED)) {
			const reason =
				noFilesDecision.kind === "unconfirmed-no-files"
					? noFilesDecision.reason
					: "status-zero";
			return {
				status: "failed",
				diagnostics: [
					{
						id: `oxlint:no-files-unconfirmed:${reason}`,
						message: `oxlint no-files report was not canonical (${reason})`,
						filePath: ctx.filePath,
						line: 1,
						column: 1,
						severity: "warning",
						semantic: "warning",
						tool: "oxlint",
					},
				],
				semantic: "warning",
				failureKind: "unconfirmed_output",
				failureMessage: `no-files-${reason}`,
			};
		}
		const diagnostics = parsedRun.diagnostics.filter(
			(diagnostic): diagnostic is Diagnostic =>
				diagnostic !== OXLINT_NO_FILES &&
				diagnostic !== OXLINT_NO_FILES_UNCONFIRMED,
		);

		// A warning-only result on exit 0 is oxlint's normal outcome, not a
		// failure: exit 0 means nothing hit ERROR severity. `status: "failed"`
		// here would stop this arm from reporting "succeeded", which breaks two
		// things downstream — plan.ts's ["eslint", "oxlint", "biome-check-json"]
		// fallback group only stops at the first `status: "succeeded"` runner
		// (dispatcher.ts's `runGroup`), so biome-check-json would run again on
		// every warning-only save (extra spawns, a possible install, duplicate
		// findings); and it would mismatch the sibling convention (biome-check,
		// golangci-lint, rubocop) of keying `status` off blocking severity, not
		// off the tool's raw exit code. The findings themselves still reach the
		// delivery pipeline regardless of `status` — dispatcher.ts buckets by
		// each diagnostic's own `semantic`, so a warning stays a warning.
		return finishParsedRun({
			tool: "oxlint",
			ctx,
			result,
			diagnostics,
			classify: (diagnostics) => {
				const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
				return {
					status: !hasBlocking && result.status === 0 ? "succeeded" : "failed",
					semantic: hasBlocking ? "blocking" : "warning",
				};
			},
		});
	},
};

interface OxlintLabel {
	span?: { offset?: number; length?: number; line?: number; column?: number };
}

interface OxlintJsonDiagnostic {
	message?: string;
	code?: string;
	severity?: string;
	help?: string;
	filename?: string;
	labels?: OxlintLabel[];
}

interface OxlintJsonReport {
	diagnostics?: OxlintJsonDiagnostic[];
	number_of_files?: number;
}

interface OxlintProcessEvidence {
	status?: number | null;
	error?: Error | null;
	failure?: string;
	signal?: NodeJS.Signals | null;
	outputTruncated?: boolean;
	spawnFailure?: { kind?: string };
}

function oxlintProcessState(result: OxlintProcessEvidence): OxlintProcessState {
	const failureKind = result.spawnFailure?.kind;
	if (truncatedByOutputCap(result)) return "truncated";
	if (result.failure === "timeout" || failureKind === "timeout")
		return "timeout";
	if (result.failure === "aborted" || failureKind === "killed") return "killed";
	if (result.signal || result.failure === "signal") return "signal";
	if (result.failure === "spawn" || result.error) return "spawn";
	return "normal";
}

function isNonnegativeInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 1;
}

function isNonnegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * One decision seam for every oxlint no-files axis (#1998).
 *
 * Real oxlint 1.79.0 establishes the only expected shape: a normal completed
 * process, exit 1, empty stderr, the exact no-files banner, and a JSON object
 * containing exactly the five captured summary fields with canonical types
 * and ranges. Diagnostics must be empty and `number_of_files` must be zero.
 *
 * Any process-control evidence wins before report bytes. Any no-files
 * lookalike that differs on status, stderr, banner, JSON syntax/schema,
 * diagnostics, or file count is unconfirmed rather than clean. A report with
 * no no-files evidence remains an ordinary oxlint report for the normal parser.
 */
export function decideOxlintNoFiles(
	result: OxlintProcessEvidence,
	stdout: string,
	stderr: string,
): OxlintNoFilesDecision {
	const processState = oxlintProcessState(result);
	if (processState !== "normal") {
		return {
			kind: "unconfirmed-no-files",
			reason: `process-${processState}`,
		};
	}

	const jsonStart = stdout.indexOf("{");
	const bannerText = (
		jsonStart === -1 ? stdout : stdout.slice(0, jsonStart)
	).trim();
	const banner =
		bannerText === OXLINT_NO_FILES_BANNER
			? "exact"
			: /no files found.+lint/i.test(bannerText)
				? "near"
				: "missing";

	let report: Record<string, unknown> | undefined;
	let jsonMalformed = jsonStart === -1;
	if (jsonStart !== -1) {
		try {
			const parsed = JSON.parse(stdout.slice(jsonStart)) as unknown;
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				report = parsed as Record<string, unknown>;
			} else {
				jsonMalformed = true;
			}
		} catch {
			jsonMalformed = true;
		}
	}

	const hasFileCount =
		report !== undefined &&
		Object.prototype.hasOwnProperty.call(report, "number_of_files");
	const fileCount = report?.number_of_files;
	const hasNoFilesEvidence =
		banner !== "missing" ||
		(hasFileCount && (fileCount === 0 || !isNonnegativeInteger(fileCount)));
	if (!hasNoFilesEvidence) return { kind: "ordinary-report" };

	if (result.status == null) {
		return { kind: "unconfirmed-no-files", reason: "status-null" };
	}
	if (result.status === 0) {
		return { kind: "unconfirmed-no-files", reason: "status-zero" };
	}
	if (result.status !== 1) {
		return { kind: "unconfirmed-no-files", reason: "status-other" };
	}
	if (stderr.trim().length > 0) {
		return { kind: "unconfirmed-no-files", reason: "stderr-nonempty" };
	}
	if (banner === "near") {
		return { kind: "unconfirmed-no-files", reason: "banner-near" };
	}
	if (banner === "missing") {
		return { kind: "unconfirmed-no-files", reason: "banner-missing" };
	}
	if (jsonMalformed || !report) {
		return { kind: "unconfirmed-no-files", reason: "json-malformed" };
	}

	const keys = Object.keys(report);
	if (keys.some((key) => !OXLINT_NO_FILES_REPORT_KEYS.has(key))) {
		return { kind: "unconfirmed-no-files", reason: "json-unknown-key" };
	}
	if (
		OXLINT_NO_FILES_REPORT_KEYS.size !== keys.length ||
		[...OXLINT_NO_FILES_REPORT_KEYS].some(
			(key) => !Object.prototype.hasOwnProperty.call(report, key),
		)
	) {
		return { kind: "unconfirmed-no-files", reason: "json-missing-key" };
	}
	if (
		!Array.isArray(report.diagnostics) ||
		!isNonnegativeInteger(report.number_of_files) ||
		!isNonnegativeInteger(report.number_of_rules) ||
		!isPositiveInteger(report.threads_count) ||
		!isNonnegativeFinite(report.start_time)
	) {
		return {
			kind: "unconfirmed-no-files",
			reason: "json-known-field-invalid",
		};
	}
	if (report.diagnostics.length > 0) {
		return { kind: "unconfirmed-no-files", reason: "diagnostics-nonempty" };
	}
	if (report.number_of_files !== 0) {
		return { kind: "unconfirmed-no-files", reason: "files-nonzero" };
	}
	return { kind: "expected-no-files" };
}

// Oxlint codes look like "eslint(no-debugger)" or "oxc(approx-constant)".
// Strip the plugin prefix so the rule lines up with what users expect.
// indexOf-based extraction avoids a regex hot-spot Sonar flagged for
// potential super-linear backtracking on adversarial inputs.
function extractOxlintRule(code: string | undefined): string {
	if (!code) return "unknown";
	const open = code.indexOf("(");
	if (open === -1) return code;
	const close = code.indexOf(")", open + 1);
	if (close === -1 || close === open + 1) return code;
	return code.slice(open + 1, close);
}

function parseOxlintJson(raw: string, filePath: string): Diagnostic[] {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{")) return [];
	let parsed: OxlintJsonReport;
	try {
		parsed = JSON.parse(trimmed) as OxlintJsonReport;
	} catch {
		return [];
	}
	if (!Array.isArray(parsed.diagnostics)) return [];
	const diagnostics: Diagnostic[] = [];
	for (const d of parsed.diagnostics) {
		const rule = extractOxlintRule(d.code);
		const label = d.labels?.[0]?.span;
		const lineNum = label?.line ?? 1;
		const colNum = label?.column ?? 1;
		const severity = d.severity === "error" ? "error" : "warning";
		const help = d.help?.trim();
		diagnostics.push({
			id: `oxlint-${rule}-${lineNum}`,
			message: `${d.message ?? "oxlint issue"} (${rule})`,
			filePath,
			line: lineNum,
			column: colNum,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "oxlint",
			rule,
			// Oxlint's help text is rule-specific guidance ("Remove the debugger
			// statement", "Consider removing this declaration"). Surface it as a
			// fix suggestion so the warning becomes actionable instead of falling
			// silently into code-quality.
			fixSuggestion: help && help.length > 0 ? help : undefined,
		});
	}
	return diagnostics;
}

function parseOxlintUnix(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split("\n")) {
		// Parse: file:line:column: message (rule)
		const match = line.match(/^(.+):(\d+):(\d+):\s*(.+?)\s*\(([^)]+)\)$/);
		if (match) {
			const [, _file, lineStr, _col, message, rule] = match;
			diagnostics.push({
				id: `oxlint-${rule}-${lineStr}`,
				message: `${message} (${rule})`,
				filePath,
				line: parseInt(lineStr, 10),
				severity: "warning",
				semantic: "warning",
				tool: "oxlint",
				rule,
			});
		}
	}
	return diagnostics;
}

export default oxlintRunner;

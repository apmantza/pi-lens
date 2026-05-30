/**
 * Oxlint runner for dispatch system
 *
 * Fast JavaScript/TypeScript linter written in Rust.
 * Drop-in replacement for ESLint with better performance.
 *
 * Requires: oxlint (npm install -g oxlint)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { walkUpDirs } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
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

function resolveLocalVp(cwd: string): string | null {
	const isWin = process.platform === "win32";
	for (const dir of walkUpDirs(cwd)) {
		const candidates = isWin
			? [
					path.join(dir, "node_modules", ".bin", "vp.cmd"),
					path.join(dir, "node_modules", ".bin", "vp"),
				]
			: [path.join(dir, "node_modules", ".bin", "vp")];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return null;
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
	enabledByDefault: true,
	skipTestFiles: true,

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
			timeout: 30000,
		});

		// Oxlint returns non-zero when issues found
		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse JSON output. Fall back to the unix-format parser if JSON parsing
		// fails (older oxlint versions, malformed stderr noise, etc.) — keeps the
		// runner producing diagnostics even when the structured-fix metadata is
		// unavailable.
		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		let diagnostics = parseOxlintJson(stdout, ctx.filePath);
		if (diagnostics.length === 0 && stdout.length > 0) {
			diagnostics = parseOxlintUnix(stdout + stderr, ctx.filePath);
		}

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
		return {
			status: "failed",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
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
	const diagnostics: Diagnostic[] = [];
	for (const d of parsed.diagnostics ?? []) {
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

/**
 * Pyright runner for dispatch system
 *
 * Provides real Python type-checking (not just linting).
 * Catches type errors like: result: str = add(1, 2)  # Type "int" not assignable to "str"
 *
 * Requires: pyright (pip install pyright or npm install -g pyright)
 */

import { logExtension } from "../../extension-log.js";
import { getLSPService } from "../../lsp/index.js";
import {
	augmentPythonEnvironment,
	detectPythonEnvironment,
} from "../../python-environment.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
} from "./utils/runner-helpers.js";
import { finishParsedRun } from "./utils/tool-failure.js";

const pyright = createAvailabilityChecker("pyright", ".exe");

const pyrightRunner: RunnerDefinition = {
	id: "pyright",
	appliesTo: ["python"],
	priority: PRIORITY.LSP_FALLBACK,
	timeoutMs: 75_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Always allow pyright CLI fallback even when LSP is enabled.
		// LSP can be present but still fail transiently for a file; in that case,
		// pyright provides a resilient second signal path.
		// When LSP is enabled (not disabled via --no-lsp), connect to the LSP service for this file
		if (!ctx.pi.getFlag("no-lsp")) {
			const lspService = getLSPService();
			await lspService.getClientForFile(ctx.filePath);
		}

		const cwd = ctx.cwd || process.cwd();

		// Get pyright command - try multiple strategies
		let cmd: string | null = null;

		// Strategy 1: Check cached availability (fast path)
		if (await pyright.isAvailableAsync(cwd)) {
			cmd = pyright.getCommand(cwd);
		}

		// Strategy 2: use the shared availability taxonomy and install suppression.
		if (!cmd) {
			const installedPath = await resolveAvailableOrInstall(
				pyright,
				"pyright",
				cwd,
			);
			if (installedPath) cmd = installedPath;
		}

		// Strategy 3: Direct PATH check (handles module cache staleness)
		if (!cmd) {
			const { findCommandAsync } = await import("../../safe-spawn.js");
			const foundCmd: string | null = await findCommandAsync("pyright");
			if (foundCmd) cmd = foundCmd;
		}

		// If still no pyright, skip this runner
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Pyright's Node CLI falls back to `python` on PATH when the project has no
		// explicit Pyright config. Apply the same environment the Python LSP uses so
		// a conventional project .venv resolves without shell activation.
		const pythonEnvironment = await detectPythonEnvironment(cwd);
		const env = augmentPythonEnvironment(process.env, pythonEnvironment);
		const result = await safeSpawnAsync(cmd, ["--outputjson", ctx.filePath], {
			timeout: 60000,
			cwd,
			env,
		});

		// Pyright returns non-zero when errors found, that's OK
		if (result.error) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const output = (result.stdout || "").trim();
		if (!output) {
			// Empty stdout with a nonzero exit and stderr chatter is an unreadable
			// report of problems, never clean (#1839). The helper turns that into
			// failed + parse-error; exit 0 stays clean.
			return finishParsedRun({
				tool: "pyright",
				ctx,
				result,
				diagnostics: [],
			});
		}

		try {
			const data = JSON.parse(output);
			const diagnostics = parsePyrightOutput(data, ctx.filePath);

			return finishParsedRun({
				tool: "pyright",
				ctx,
				result,
				diagnostics,
				classify: (diagnostics) => {
					const hasErrors = diagnostics.some((d) => d.severity === "error");
					return {
						status: hasErrors ? "failed" : "succeeded",
						semantic: hasErrors ? "blocking" : "warning",
					};
				},
			});
			// pi-lens-ignore: missing-error-propagation
		} catch {
			logExtension({
				subsystem: "runner:pyright",
				message: `JSON parse failed for ${ctx.filePath} — raw output: ${output.slice(0, 200)}`,
				metadata: { filePath: ctx.filePath },
			});
			return {
				status: "failed",
				diagnostics: [],
				semantic: "none",
				rawOutput: output.slice(0, 500),
			};
		}
	},
};

interface PyrightDiagnostic {
	severity?: "error" | "warning" | "information";
	message?: string;
	file?: string;
	rule?: string;
	// #1802 fix round: pyright's `--outputjson` output does NOT have a
	// top-level `start`. Each diagnostic carries `range: { start, end }`,
	// and pyright's own docs (docs/command-line.md, "JSON Output") state
	// range positions are zero-based. `range` is omitted entirely when
	// pyright has no location to report, so it must stay optional.
	range?: {
		start?: { line?: number; character?: number };
		end?: { line?: number; character?: number };
	};
}

/**
 * Map pyright's own severity vocabulary onto the four-tier `Diagnostic.severity`
 * (clients/dispatch/types.ts), the same way `normalizeBiomeSeverity` does for
 * biome-check (#1791) and `normalizeRuleSeverity` does for ast-grep-napi
 * (#1787). Pyright names its info tier `"information"`; `"error"`/`"warning"`
 * pass through as-is. An unrecognized value falls back to `"warning"` — the
 * tier every pyright diagnostic reported at before this fix, so reviving the
 * info tier never silently demotes an existing finding. Pyright has no
 * `"hint"` tier in its own vocabulary, so that tier is unreachable here.
 */
export function normalizePyrightSeverity(
	raw: PyrightDiagnostic["severity"] | undefined,
): Diagnostic["severity"] {
	switch (raw) {
		case "error":
			return "error";
		case "information":
			return "info";
		// "warning" and any unrecognized value fall back below — the tier
		// every pyright diagnostic reported at before this fix, so reviving
		// the info tier never silently demotes an existing finding. There is
		// no separate `case "warning"` branch: it would be redundant with
		// this default and unprovable as its own branch.
		default:
			return "warning";
	}
}

export function parsePyrightOutput(data: any, _filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	// Pyright JSON output has generalDiagnostics array
	const generalDiags: PyrightDiagnostic[] = data.generalDiagnostics || [];

	for (const diag of generalDiags) {
		// Skip if not for this file (pyright may output diagnostics for imports)
		// For now, include all - caller will filter if needed

		// pyright's `range.start.line`/`character` are zero-based (see the
		// `PyrightDiagnostic` note above); `Diagnostic.line`/`column` are
		// one-based, the same convention ast-grep-napi and taplo already
		// convert to (`range.start.line + 1`). `range` itself is omitted when
		// pyright has nothing to point at, so both fall back to line 1.
		const start = diag.range?.start;
		diagnostics.push({
			id: `pyright-${diag.rule || start?.line || "unknown"}`,
			message: diag.message || "Type error",
			filePath: diag.file || _filePath,
			line: (start?.line ?? 0) + 1,
			column: (start?.character ?? 0) + 1,
			severity: normalizePyrightSeverity(diag.severity),
			// Blocking classification stays error-only — reviving the info tier
			// must never widen what fails a turn.
			semantic: diag.severity === "error" ? "blocking" : "warning",
			tool: "pyright",
			rule: diag.rule,
		});
	}

	return diagnostics;
}

export default pyrightRunner;

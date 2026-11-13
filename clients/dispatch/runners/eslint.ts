/**
 * ESLint runner for dispatch system
 *
 * Runs ESLint on JS/TS files when an ESLint config is present in the project.
 * Prefers the local node_modules installation over global.
 *
 * Gate: skips when no ESLint config is detected (project uses Biome/OxLint instead).
 */

import { toolAbsentSkip } from "./utils/runner-helpers.js";
import { skipped } from "../types.js";
import { hasToolConfig } from "../../tool-config-presence.js";
import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwdWithReason } from "../../tool-cwd.js";
import { getAutofixCapability } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createCwdCachedProbe,
	resolveToolCommand,
} from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";
import { semanticFor } from "../types.js";

const ESLINT_PROBE_BUDGET_MS = 5000;

// Per-cwd cached eslint `--version` verification (#120). Before this, every
// dispatch invocation ran a fresh `safeSpawnAsync(cmd, ["--version"])` after
// the local cmd resolution. The probe is cached per cwd because
// `resolveToolCommand("eslint")` is deterministic from cwd; the underlying
// cmd identity is captured inside the probe closure.
//
// The verdict is governed by the shared availability policy (#1494): the probe
// hands back the spawn result, so one stalled probe on the first JS/TS save
// expires on a cooldown instead of disabling eslint for the whole session.
function makeEslintProbe(cmd: string) {
	return createCwdCachedProbe(
		(cwd) =>
			safeSpawnAsync(cmd, ["--version"], {
				timeout: ESLINT_PROBE_BUDGET_MS,
				cwd,
			}),
		{
			tool: "eslint",
			budgetMs: ESLINT_PROBE_BUDGET_MS,
			flightKeyComponent: cmd,
		},
	);
}
const eslintAvailabilityByCmd = new Map<
	string,
	ReturnType<typeof makeEslintProbe>
>();
function getEslintProbe(cmd: string) {
	const existing = eslintAvailabilityByCmd.get(cmd);
	if (existing) return existing;
	const created = makeEslintProbe(cmd);
	eslintAvailabilityByCmd.set(cmd, created);
	return created;
}

interface EslintMessage {
	ruleId: string | null;
	severity: 1 | 2;
	message: string;
	line: number;
	column: number;
	fix?: unknown;
}

interface EslintFileResult {
	filePath: string;
	messages: EslintMessage[];
}

function parseEslintJson(
	raw: string,
	filePath: string,
	cwd: string,
): { diagnostics: Diagnostic[]; parseError?: string } {
	try {
		const results: EslintFileResult[] = JSON.parse(raw);
		const autofix = getAutofixCapability("eslint");
		const diagnostics: Diagnostic[] = [];
		const absTarget = path.resolve(cwd, filePath);

		for (const fileResult of results) {
			// #3295: flat config `files`/`ignores` and a directory argv both put a
			// SECOND result in this array; each names its own `filePath`.
			if (
				fileResult.filePath &&
				!pathsEqual(path.resolve(cwd, fileResult.filePath), absTarget)
			)
				continue;
			for (const msg of fileResult.messages) {
				const severity = msg.severity === 2 ? "error" : "warning";
				diagnostics.push({
					id: `eslint:${msg.ruleId ?? "unknown"}:${msg.line}`,
					message: msg.ruleId ? `${msg.ruleId}: ${msg.message}` : msg.message,
					filePath,
					line: msg.line ?? 1,
					column: msg.column ?? 1,
					severity,
					semantic: semanticFor(severity),
					tool: "eslint",
					rule: msg.ruleId ?? undefined,
					fixable: !!msg.fix,
					autoFixAvailable:
						!!msg.fix && (autofix?.safePipelineAutofix ?? false),
					fixKind:
						!!msg.fix && autofix?.fixKind !== "none"
							? autofix?.fixKind
							: undefined,
				});
			}
		}

		return { diagnostics };
	} catch (err) {
		return {
			diagnostics: [],
			parseError: err instanceof Error ? err.message : String(err),
		};
	}
}

const eslintRunner: RunnerDefinition = {
	id: "eslint",
	appliesTo: ["jsts"],
	priority: PRIORITY.LINT_SECONDARY,
	requiresConfig: (cwd) => hasToolConfig("eslint", cwd),

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// `cwd` is where the child starts (the config's directory, #5541); the
		// package the file lives in still answers the install lookup. The gate
		// stays at `cwd`: an anchor is an ESLint config, so it cannot disagree
		// with the package's own answer, and `effective-config.ts` asks it there.
		const { cwd, packageDir = cwd } = resolveRunnerCwdWithReason(ctx, "eslint");

		// Only run if project has an ESLint config.
		if (!eslintRunner.requiresConfig?.(cwd)) {
			return skipped("not-configured");
		}

		const cmd = resolveToolCommand(packageDir, "eslint") ?? "eslint";

		// Verify ESLint is actually executable (cached per directory, see getEslintProbe).
		const eslintProbe = getEslintProbe(cmd);
		if (!(await eslintProbe(packageDir))) {
			return toolAbsentSkip(packageDir, { checker: eslintProbe });
		}

		const result = await safeSpawnAsync(
			cmd,
			["--format", "json", "--no-error-on-unmatched-pattern", ctx.filePath],
			{ timeout: 30000, cwd },
		);

		// Exit table: 0 is clean-or-findings, and 1/2 are ran outcomes whose
		// JSON parser decides whether findings or a parse/config error reached the
		// user. In particular, status 2 carries file-local fatal parse messages
		// as JSON and must not be discarded before parsing.
		//
		// ESLint exits 0 whenever nothing reached ERROR severity — that
		// includes a run that found only warnings (#1954), which also prints a
		// full JSON report. So parse stdout unconditionally and branch on the
		// parsed diagnostic count instead of letting the exit code discard the
		// warning case. `parseStreams` makes stderr only a fallback for a
		// failing run whose stdout went missing; parsing stderr noise on a
		// healthy exit-0 run would turn deprecation chatter into spurious
		// parse-error findings.
		const parsed = parseToolRun(
			"eslint",
			{
				result,
				// EXIT TABLE (ESLint 9.10 docs https://eslint.org/docs/latest/use/command-line-interface): 0 clean; 1 findings; 2 fatal findings/error; other nonzero rejected.
				exitCodes: { ran: [1, 2] },
			},
			(rawOutput) => parseEslintJson(rawOutput, ctx.filePath, cwd).diagnostics,
			{ parseStreams: "stdout-else-stderr" },
		);
		if (parsed.skipped) return parsed.skipped;
		return finishParsedRun({
			tool: "eslint",
			ctx,
			result,
			diagnostics: parsed.diagnostics,
		});
	},
};

export default eslintRunner;

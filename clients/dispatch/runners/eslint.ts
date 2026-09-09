/**
 * ESLint runner for dispatch system
 *
 * Runs ESLint on JS/TS files when an ESLint config is present in the project.
 * Prefers the local node_modules installation over global.
 *
 * Gate: skips when no ESLint config is detected (project uses Biome/OxLint instead).
 */

import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { getAutofixCapability, hasEslintConfig } from "../../tool-policy.js";
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
): { diagnostics: Diagnostic[]; parseError?: string } {
	try {
		const results: EslintFileResult[] = JSON.parse(raw);
		const autofix = getAutofixCapability("eslint");
		const diagnostics: Diagnostic[] = [];

		for (const fileResult of results) {
			for (const msg of fileResult.messages) {
				const severity = msg.severity === 2 ? "error" : "warning";
				diagnostics.push({
					id: `eslint:${msg.ruleId ?? "unknown"}:${msg.line}`,
					message: msg.ruleId ? `${msg.ruleId}: ${msg.message}` : msg.message,
					filePath,
					line: msg.line ?? 1,
					column: msg.column ?? 1,
					severity,
					semantic: severity === "error" ? "blocking" : "warning",
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

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "eslint");
		const userHasConfig = hasEslintConfig(cwd);

		// Only run if project has an ESLint config.
		if (!userHasConfig) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = resolveToolCommand(cwd, "eslint") ?? "eslint";

		// Verify ESLint is actually executable (cached per cwd, see getEslintProbe).
		if (!(await getEslintProbe(cmd)(cwd))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const result = await safeSpawnAsync(
			cmd,
			["--format", "json", "--no-error-on-unmatched-pattern", ctx.filePath],
			{ timeout: 30000, cwd },
		);

		// ESLint exits 2 on fatal/config errors — nothing was linted, so this
		// is an unavailable run, not a clean or failed one.
		if (result.status === 2) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// ESLint exits 0 whenever nothing reached ERROR severity — that
		// includes a run that found only warnings (#1954), which also prints a
		// full JSON report. So parse stdout unconditionally and branch on the
		// parsed diagnostic count instead of letting the exit code discard the
		// warning case. Stderr is only a fallback for a failing run whose
		// stdout went missing; parsing stderr noise on a healthy exit-0 run
		// would turn deprecation chatter into spurious parse-error findings.
		const stdout = result.stdout ?? "";
		let raw = stdout;
		if (raw.length === 0 && result.status !== 0) {
			raw = result.stderr || "";
		}

		const parsed = parseEslintJson(raw, ctx.filePath);
		if (parsed.parseError && raw.trim().length > 0) {
			const preview = raw.replace(/\s+/g, " ").slice(0, 160);
			return {
				status: "failed",
				diagnostics: [
					{
						id: "eslint:parse-error:1",
						message:
							"ESLint JSON parse failed: " +
							parsed.parseError +
							(preview ? " (output preview: " + preview + ")" : ""),
						filePath: ctx.filePath,
						line: 1,
						column: 1,
						severity: "warning",
						semantic: "warning",
						tool: "eslint",
					},
				],
				semantic: "warning",
			};
		}

		const diagnostics = parsed.diagnostics;
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.semantic === "blocking");
		// A warning-only result on exit 0 is ESLint's normal outcome, not a
		// failure: exit 0 means nothing hit ERROR severity. Keying status off
		// blocking severity plus exit code (the sibling convention from oxlint,
		// biome-check, golangci-lint, rubocop) keeps plan.ts's fallback group
		// ["eslint", "oxlint", "biome-check-json"] stopping at eslint instead
		// of re-running oxlint and biome-check-json on every warning-only save.
		// The findings reach delivery regardless of status — dispatcher.ts
		// buckets by each diagnostic's own `semantic`.
		return {
			status: !hasErrors && result.status === 0 ? "succeeded" : "failed",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default eslintRunner;

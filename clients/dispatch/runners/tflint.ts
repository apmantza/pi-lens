import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
import { findNearestDirWithAnyBasename } from "../../workspace-topology.js";
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
import { parseToolRun } from "./utils/tool-failure.js";
import { finishParsedRun } from "./utils/tool-failure.js";

const tflint = createAvailabilityChecker("tflint", ".exe");

const TFLINT_CONFIG = ".tflint.hcl";

/**
 * tflint resolves `.tflint.hcl` from its own working directory and never walks
 * parents (its only fallback is `~/.tflint.hcl`). We run it from the edited
 * file's directory, so a repo-root config would govern nothing beneath the
 * root unless we name it explicitly. Returns null when `TFLINT_CONFIG_FILE` is
 * set: `--config` outranks the env var in tflint's own precedence, so passing
 * one would override a deliberate choice.
 */
function findTflintConfig(fileDir: string): string | null {
	if (process.env.TFLINT_CONFIG_FILE) return null;
	const dir = findNearestDirWithAnyBasename(fileDir, [TFLINT_CONFIG]);
	return dir ? path.join(dir, TFLINT_CONFIG) : null;
}

interface TflintIssue {
	rule: { name: string; severity: string };
	message: string;
	range: {
		filename: string;
		start: { line: number; column: number };
	};
}

interface TflintOutput {
	issues: TflintIssue[];
	errors: Array<{ message: string }>;
}

function parseTflintOutput(raw: string, filePath: string): Diagnostic[] {
	try {
		const parsed = JSON.parse(raw) as TflintOutput;
		const issues = parsed.issues ?? [];

		return issues.map((issue) => {
			const severity = issue.rule.severity === "error" ? "error" : "warning";
			return {
				id: `tflint-${issue.rule.name}-${issue.range.start.line}`,
				message: `[${issue.rule.name}] ${issue.message}`,
				filePath,
				line: issue.range.start.line,
				column: issue.range.start.column,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "tflint",
				rule: issue.rule.name,
				fixable: false,
			};
		});
	} catch {
		return [];
	}
}

const tflintRunner: RunnerDefinition = {
	id: "tflint",
	appliesTo: ["terraform"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("tflint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (await tflint.isAvailableAsync(cwd)) {
			cmd = tflint.getCommand(cwd);
		} else {
			const managed = await resolveAvailableOrInstall(tflint, "tflint", cwd);
			if (managed) cmd = managed;
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const fileDir = path.dirname(absPath);
		const args = [
			"--format=json",
			"--no-color",
			`--filter=${path.basename(absPath)}`,
		];
		const configPath = findTflintConfig(fileDir);
		if (configPath) args.push(`--config=${configPath}`);

		const result = await safeSpawnAsync(cmd, args, {
			cwd: fileDir,
			timeout: 30000,
		});

		// #1948: tflint exits nonzero and writes its JSON report to stdout, so a
		// nonzero exit whose report yields zero diagnostics is a parser break,
		// not a clean file. No exit-code table: tflint's nonzero codes are not
		// verified against a real binary here, so the conservative
		// nothing-to-parse rule stays the only discriminator.
		const run = parseToolRun("tflint", { result }, (out) =>
			parseTflintOutput(out, ctx.filePath),
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		return finishParsedRun({
			tool: "tflint",
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
	},
};

export default tflintRunner;

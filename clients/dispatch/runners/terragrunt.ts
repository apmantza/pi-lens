import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { pathsEqual } from "../../path-utils.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
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
import { spawnFailedWithNoOutput } from "./utils/spawn-outcome.js";
import { finishParsedRun } from "./utils/tool-failure.js";

const terragrunt = createAvailabilityChecker("terragrunt", ".exe");

interface TerragruntDiagnostic {
	severity?: string | number;
	summary?: string;
	detail?: string;
	range?: {
		filename?: string;
		start?: { line?: number; column?: number };
	};
}

interface TerragruntInvalidFile {
	diagnostics?: TerragruntDiagnostic[];
}

function normalizeSeverity(raw: unknown): "error" | "warning" {
	if (typeof raw === "number") return raw === 1 ? "error" : "warning";
	if (typeof raw === "string" && raw.toLowerCase() === "error") return "error";
	return "warning";
}

function toRawDiagnostics(parsed: unknown): TerragruntDiagnostic[] {
	if (Array.isArray(parsed)) return parsed as TerragruntDiagnostic[];
	if (!parsed || typeof parsed !== "object") return [];
	const invalidFiles = (parsed as { invalid_files?: unknown }).invalid_files;
	if (!Array.isArray(invalidFiles)) return [];
	return (invalidFiles as TerragruntInvalidFile[]).flatMap((f) =>
		Array.isArray(f?.diagnostics) ? f.diagnostics : [],
	);
}

/**
 * Parse `terragrunt hcl validate --json` output.
 *
 * OBSERVED CONTRACT (captured empirically from terragrunt v1.1.2, win-x64):
 * the payload is a FLAT JSON array of diagnostic objects on stdout, e.g.
 *
 *   [{"range":{"filename":"<ABSOLUTE path>","start":{"line":1,"column":8,...},
 *     "end":{...}},"snippet":{...},"summary":"Unclosed configuration block",
 *     "detail":"...","severity":"error"}]
 *
 * Key facts: `severity` is a STRING ("error"), `range.filename` is an ABSOLUTE
 * path (host separator), and a CLEAN unit prints NOTHING (empty stdout, exit 0)
 * — not `[]`. The nested `{invalid_files:[{diagnostics:[...]}]}` wrapper and the
 * numeric (1=error/2=warning) severity encoding were NOT observed on v1.1.2 and
 * are retained only as a tolerant fallback for other/older shapes.
 * Malformed/unparseable input returns [].
 */
export function parseTerragruntOutput(
	raw: string,
	filePath: string,
	absPath: string = path.resolve(filePath),
): Diagnostic[] {
	if (!raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	// Resolved against the unit dir, not compared by basename: a unit that
	// includes its parent via find_in_parent_folders() gets diagnostics from a
	// parent terragrunt.hcl, whose basename matches but whose lines do not.
	const unitDir = path.dirname(absPath);
	const diagnostics: Diagnostic[] = [];
	for (const d of toRawDiagnostics(parsed)) {
		if (!d || typeof d !== "object") continue;
		const diagFile = d.range?.filename;
		if (diagFile && !pathsEqual(path.resolve(unitDir, diagFile), absPath))
			continue;
		const line = d.range?.start?.line ?? 1;
		const column = d.range?.start?.column ?? 1;
		const severity = normalizeSeverity(d.severity);
		const message = d.summary ?? d.detail ?? "terragrunt hcl validate error";
		// No rule code in hcl validate output, so the message carries the identity.
		const idMessage = message
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.slice(0, 80);
		diagnostics.push({
			id: `terragrunt-hclvalidate-${line}-${column}-${idMessage}`,
			message,
			filePath,
			line,
			column,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "terragrunt",
			fixable: false,
		});
	}
	return diagnostics;
}

const SKIPPED: RunnerResult = {
	status: "skipped",
	diagnostics: [],
	semantic: "none",
};

/**
 * Runner for `terragrunt hcl validate --json`, the linter for terragrunt units.
 *
 * REQUIRES the redesigned terragrunt CLI: the `terragrunt hcl validate` /
 * `terragrunt hcl fmt` command group replaced the old `hclvalidate`/`hclfmt`
 * top-level commands in the CLI redesign (~terragrunt v0.75; the legacy names
 * were removed in v1.0). Contract verified empirically on terragrunt v1.1.2.
 *
 * Observed exit-code / output table (terragrunt v1.1.2, win-x64):
 *   - clean unit ............ exit 0, EMPTY stdout (no `[]`)
 *   - validation findings ... exit 1, flat JSON array on stdout (+ a log line
 *                             "N HCL validation error(s) found" on stderr)
 *   - unknown command ....... an older binary that predates `hcl validate`
 *                             exits non-zero with the error on STDERR and EMPTY
 *                             stdout; `spawnFailedWithNoOutput` classifies that
 *                             as SKIPPED (never a false blocker, and never a
 *                             false CLEAN — a nonzero exit carries no
 *                             `SpawnResult.error`, so the status has to be part
 *                             of the test).
 *
 * `hcl validate` recursively validates the unit(s) at its working dir; it has no
 * per-file flag (`--filter` takes component filter-syntax, NOT a filename — a
 * bare basename silently matches zero components and suppresses ALL findings,
 * verified on v1.1.2). So we validate the edited file's unit directory and
 * attribute findings back to the edited file by absolute path in
 * parseTerragruntOutput.
 *
 * Misdetection edge: `root.hcl` is filename-detected as terragrunt, so a
 * `root.hcl` that is NOT a terragrunt file still gets validated here — `hcl
 * validate` just checks generic HCL, so a non-terragrunt file fails soft
 * (either clean or a plain HCL diagnostic, never a spurious hard blocker).
 */
const terragruntRunner: RunnerDefinition = {
	id: "terragrunt",
	appliesTo: ["terragrunt"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "terragrunt");
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("terragrunt"))
			return SKIPPED;

		let cmd: string | null = null;
		if (await terragrunt.isAvailableAsync(cwd)) {
			cmd = terragrunt.getCommand(cwd);
		} else {
			const managed = await resolveAvailableOrInstall(
				terragrunt,
				"terragrunt",
				cwd,
			);
			if (managed) cmd = managed;
		}

		if (!cmd) return SKIPPED;

		const absPath = path.resolve(cwd, ctx.filePath);
		const fileDir = path.dirname(absPath);
		const result = await safeSpawnAsync(
			cmd,
			["hcl", "validate", "--json", "--non-interactive"],
			{ cwd: fileDir, timeout: 30000 },
		);

		if (spawnFailedWithNoOutput(result)) return SKIPPED;

		const diagnostics = parseTerragruntOutput(
			result.stdout || "",
			ctx.filePath,
			absPath,
		);
		return finishParsedRun({
			tool: "terragrunt",
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

export default terragruntRunner;

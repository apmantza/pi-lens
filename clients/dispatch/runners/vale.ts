import * as fs from "node:fs";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";
import { parseToolRun } from "./utils/tool-failure.js";

const vale = createAvailabilityChecker("vale", ".exe");

/**
 * Check for a .vale.ini config file in cwd or parent dirs.
 */
function findValeConfig(cwd: string): string | undefined {
	const local = path.join(cwd, ".vale.ini");
	if (fs.existsSync(local)) return local;

	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".vale.ini");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return undefined;
}

/**
 * Parse Vale JSON output.
 *
 * #1933 review F1: this used to assume a `{ Data: { Files: [...] } }`
 * envelope that no real `vale` binary ever emits -- that shape traces to an
 * unverified claim, never checked against a real run (AGENTS.md defect
 * shape 16). Verified against a real `vale --output JSON` v3.9.6 run: the
 * top level is a flat map keyed by the linted file's path (exactly the
 * string passed on the command line, so its exact spelling isn't load-
 * bearing here -- one file is linted per invocation, so this reads every
 * value in the map rather than matching a specific key), each value an
 * array of alert objects:
 *
 * {
 *   "path/passed/on/cli.md": [
 *     {
 *       "Line": 10,
 *       "Span": [5, 12],
 *       "Severity": "warning",
 *       "Message": "some message",
 *       "Check": "Google.SomeRule"
 *     }
 *   ]
 * }
 *
 * There is no separate "Column" field. `Span` is the [start, end] column
 * range of the match within `Line`; `Span[0]` is the column Vale's own
 * `--output line` formatter prints.
 *
 * Before this fix, the old shape meant `parsed?.Data?.Files` was always
 * undefined, so every real Vale run -- however many errors it actually
 * found -- silently parsed to zero diagnostics and reported "succeeded".
 */
interface ValeAlert {
	Line?: number;
	Span?: [number, number];
	Severity?: string;
	Message?: string;
	Check?: string;
	Action?: unknown;
}

type ValeOutput = Record<string, ValeAlert[]>;

export function parseValeOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	if (!raw.trim()) return diagnostics;

	try {
		const parsed = JSON.parse(raw) as ValeOutput;
		if (!parsed || typeof parsed !== "object") return diagnostics;

		for (const alerts of Object.values(parsed)) {
			if (!Array.isArray(alerts)) continue;

			for (const alert of alerts) {
				if (!alert.Message) continue;

				const severityMap: Record<string, "error" | "warning" | "info"> = {
					error: "error",
					warning: "warning",
					info: "info",
					suggestion: "info",
				};
				const severity =
					severityMap[alert.Severity?.toLowerCase() ?? ""] ?? "warning";

				diagnostics.push({
					id: `vale-${alert.Line}-${alert.Check ?? "unknown"}`,
					message: `[${alert.Check ?? "vale"}] ${alert.Message}`,
					filePath,
					line: alert.Line ?? 1,
					column: alert.Span?.[0] ?? 1,
					severity,
					semantic: severity === "error" ? "blocking" : "warning",
					tool: "vale",
					rule: alert.Check ?? "vale",
					fixable: false,
				});
			}
		}
	} catch {
		// JSON parse failed, return empty
		return diagnostics;
	}

	return diagnostics;
}

const valeRunner: RunnerDefinition = {
	id: "vale",
	appliesTo: ["markdown"],
	priority: PRIORITY.DOC_QUALITY,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "vale");

		// Config-gated: skip unless a .vale.ini is found
		if (!findValeConfig(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (await vale.isAvailableAsync(cwd)) {
			cmd = vale.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "vale");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		// Vale exits 0 even on findings, non-zero only on errors
		const result = await safeSpawnAsync(
			cmd,
			["--output", "JSON", ctx.filePath],
			{ cwd, timeout: 15000 },
		);

		// #1816: this runner read `result.status` zero times, so a Vale that
		// rejected its config exited nonzero with an empty stdout, parsed to
		// zero alerts, and reported clean prose. No exit-code table: Vale's
		// nonzero codes vary with --minAlertLevel, so the conservative
		// nothing-to-parse rule is the only safe discriminator here.
		//
		// #1948: `parseToolRun` adds the second gate. Vale's `Data.Files`
		// envelope bug produced exactly this shape — exit 1, a full JSON
		// report on stdout, zero alerts parsed — and left no record.
		const run = parseToolRun("vale", { result }, (raw) =>
			parseValeOutput(raw, ctx.filePath),
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");

		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
	},
};

export default valeRunner;

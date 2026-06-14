import * as fs from "node:fs";
import * as path from "node:path";
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
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";

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
 * Format:
 * {
 *   "Data": {
 *     "Files": [
 *       {
 *         "Path": "file.md",
 *         "Alerts": [
 *           {
 *             "Line": 10,
 *             "Column": 5,
 *             "Severity": "warning",
 *             "Message": "some message",
 *             "Check": "some-rule"
 *           }
 *         ]
 *       }
 *     ],
 *     "LintedTotal": 1
 *   }
 * }
 */
interface ValeAlert {
	Line?: number;
	Column?: number;
	Severity?: string;
	Message?: string;
	Check?: string;
	Action?: unknown;
}

interface ValeFile {
	Path?: string;
	Alerts?: ValeAlert[];
}

function parseValeOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	if (!raw.trim()) return diagnostics;

	try {
		const parsed = JSON.parse(raw) as {
			Data?: {
				Files?: ValeFile[];
			};
		};

		const files = parsed?.Data?.Files;
		if (!files) return diagnostics;

		for (const file of files) {
			if (!file.Alerts) continue;

			for (const alert of file.Alerts) {
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
					column: alert.Column ?? 1,
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
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		// Config-gated: skip unless a .vale.ini is found
		if (!findValeConfig(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (await (vale.isAvailableAsync(cwd))) {
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

		const raw = result.stdout || "";
		const diagnostics = parseValeOutput(raw, ctx.filePath);

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

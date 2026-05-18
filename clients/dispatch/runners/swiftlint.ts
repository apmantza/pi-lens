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

const swiftlint = createAvailabilityChecker("swiftlint", ".exe");

/**
 * SwiftLint JSON output is a flat array of violation objects:
 *
 * [
 *   {
 *     "rule_id": "identifier_name",
 *     "reason": "Variable name should be between 3 and 40 characters long",
 *     "character": 10,
 *     "file": "/path/to/file.swift",
 *     "severity": "Warning",
 *     "type": "Identifier Name",
 *     "line": 15
 *   }
 * ]
 *
 * An empty array means clean. Exit code is non-zero when violations exist.
 */
interface SwiftLintViolation {
	rule_id?: string;
	reason?: string;
	character?: number;
	file?: string;
	severity?: string;
	type?: string;
	line?: number;
}

function parseSwiftLintOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	if (!raw.trim()) return diagnostics;

	try {
		const parsed = JSON.parse(raw) as SwiftLintViolation[];
		if (!Array.isArray(parsed)) return diagnostics;

		for (const item of parsed) {
			if (!item.reason) continue;

			const severityMap: Record<string, "error" | "warning" | "info"> = {
				error: "error",
				warning: "warning",
				info: "info",
			};
			const severity =
				severityMap[item.severity?.toLowerCase() ?? ""] ?? "warning";
			const ruleId = item.rule_id ?? "swiftlint";

			diagnostics.push({
				id: `swiftlint-${item.line}-${ruleId}`,
				message: `[${ruleId}] ${item.reason}`,
				filePath,
				line: item.line ?? 1,
				column: item.character ?? 1,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "swiftlint",
				rule: ruleId,
				fixable: false,
			});
		}
	} catch {
		return diagnostics;
	}

	return diagnostics;
}

const swiftlintRunner: RunnerDefinition = {
	id: "swiftlint",
	appliesTo: ["swift"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		let cmd: string | null = null;
		if (
			await (swiftlint.isAvailableAsync?.(cwd) ?? swiftlint.isAvailable(cwd))
		) {
			cmd = swiftlint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "swiftlint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const result = await safeSpawnAsync(
			cmd,
			["--reporter", "json", path.resolve(cwd, ctx.filePath)],
			{ cwd, timeout: 15000 },
		);

		// SwiftLint exits non-zero on violations — stdout still has the JSON
		const raw = result.stdout || "";
		const diagnostics = parseSwiftLintOutput(raw, ctx.filePath);

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

export default swiftlintRunner;

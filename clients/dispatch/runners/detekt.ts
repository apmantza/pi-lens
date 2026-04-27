import * as fs from "node:fs";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const detekt = createAvailabilityChecker("detekt", ".bat");

const DETEKT_CONFIG_CANDIDATES = [
	"detekt.yml",
	".detekt.yml",
	path.join("config", "detekt", "detekt.yml"),
	path.join("detekt", "detekt.yml"),
];

function findDetektConfig(cwd: string): string | undefined {
	for (const candidate of DETEKT_CONFIG_CANDIDATES) {
		const full = path.join(cwd, candidate);
		if (fs.existsSync(full)) return full;
	}
	return undefined;
}

// detekt text output: /path/file.kt:10:5: error: Message [RuleId]
function parseDetektOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const pattern =
		/^(.+?):(\d+):(\d+): (error|warning): (.+?)(?:\s+\[([^\]]+)\])?$/gm;

	const absTarget = path.resolve(filePath);
	for (const match of raw.matchAll(pattern)) {
		const [, file, lineStr, colStr, level, message, rule] = match;
		if (path.resolve(file.trim()) !== absTarget) continue;

		const severity = level === "error" ? "error" : "warning";
		const lineNum = Number.parseInt(lineStr, 10);
		const colNum = Number.parseInt(colStr, 10);

		diagnostics.push({
			id: `detekt-${rule ?? "unknown"}-${lineNum}-${colNum}`,
			message: rule ? `[${rule}] ${message}` : message,
			filePath,
			line: lineNum,
			column: colNum,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "detekt",
			rule: rule ?? "detekt",
		});
	}
	return diagnostics;
}

const detektRunner: RunnerDefinition = {
	id: "detekt",
	appliesTo: ["kotlin"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("detekt")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const configPath = findDetektConfig(cwd);
		if (!configPath) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = detekt.isAvailable(cwd) ? detekt.getCommand(cwd) : null;
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["--input", absPath, "--config", configPath],
			{ cwd, timeout: 60000 },
		);

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		const diagnostics = parseDetektOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default detektRunner;

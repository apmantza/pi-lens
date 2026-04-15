import * as nodeFs from "node:fs";
import * as path from "node:path";
import { ensureTool } from "../../installer/index.js";
import { safeSpawn } from "../../safe-spawn.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const mypy = createAvailabilityChecker("mypy", "");

const MYPY_CONFIGS = [
	"mypy.ini",
	".mypy.ini",
	"setup.cfg",
	"pyproject.toml",
];

function hasMypyConfig(cwd: string): boolean {
	for (const cfg of MYPY_CONFIGS) {
		const cfgPath = path.join(cwd, cfg);
		if (!nodeFs.existsSync(cfgPath)) continue;
		if (cfg === "setup.cfg") {
			try {
				const content = nodeFs.readFileSync(cfgPath, "utf-8");
				if (content.includes("[mypy]")) return true;
			} catch {}
			continue;
		}
		if (cfg === "pyproject.toml") {
			try {
				const content = nodeFs.readFileSync(cfgPath, "utf-8");
				if (content.includes("[tool.mypy]")) return true;
			} catch {}
			continue;
		}
		return true;
	}
	return false;
}

// mypy output: file.py:10: error: Incompatible types [assignment]
function parseMypyOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = line.match(
			/^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.+?)(?:\s+\[([^\]]+)\])?$/,
		);
		if (!match) continue;
		const [, , lineNum, col, level, message, errorCode] = match;
		if (level === "note") continue; // skip contextual notes
		const severity = level === "error" ? "error" : "warning";
		const rule = errorCode ?? "mypy";
		diagnostics.push({
			id: `mypy-${lineNum}-${rule}`,
			message: errorCode ? `[${errorCode}] ${message}` : message,
			filePath,
			line: Number(lineNum),
			column: col ? Number(col) : 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "mypy",
			rule,
		});
	}
	return diagnostics;
}

const mypyRunner: RunnerDefinition = {
	id: "mypy",
	appliesTo: ["python"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		// Only run if mypy config exists — avoids false positives in untyped projects
		if (!hasMypyConfig(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (mypy.isAvailable(cwd)) {
			cmd = mypy.getCommand(cwd);
		} else {
			const installed = await ensureTool("mypy");
			if (!installed) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
			cmd = installed;
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const result = safeSpawn(
			cmd,
			["--no-error-summary", "--show-column-numbers", ctx.filePath],
			{ timeout: 30000, cwd },
		);

		const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		const diagnostics = parseMypyOutput(raw, ctx.filePath);
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

export default mypyRunner;

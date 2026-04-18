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

function hasMixExs(cwd: string): boolean {
	return fs.existsSync(path.join(cwd, "mix.exs"));
}

async function isCommandAvailable(command: string): Promise<boolean> {
	const result = await safeSpawnAsync(command, ["--version"], { timeout: 5000 });
	return !result.error && result.status === 0;
}

function parseElixirOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = raw.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const syntax = line.match(/^\*\* \(([^)]+)\)\s+(.+?):(\d+):(?:(\d+):)?\s*(.+)$/);
		if (syntax) {
			const [, kind, sourcePath, lineStr, colStr, message] = syntax;
			const resolvedSource = path.resolve(sourcePath.trim());
			const resolvedTarget = path.resolve(filePath);
			if (resolvedSource !== resolvedTarget) continue;
			diagnostics.push({
				id: `elixir-check-${kind}-${lineStr}-${colStr || "1"}`,
				message: `[${kind}] ${message.trim()}`,
				filePath,
				line: Number.parseInt(lineStr, 10) || 1,
				column: Number.parseInt(colStr || "1", 10) || 1,
				severity: "error",
				semantic: "blocking",
				tool: "elixir-check",
				rule: kind,
				fixable: false,
			});
			continue;
		}

		const warning = line.match(/^warning:\s+(.+)$/);
		if (!warning) continue;
		const location = lines[index + 1]?.match(/^\s+(.+?):(\d+):(?:(\d+):)?$/);
		if (!location) continue;
		const [, sourcePath, lineStr, colStr] = location;
		const resolvedSource = path.resolve(sourcePath.trim());
		const resolvedTarget = path.resolve(filePath);
		if (resolvedSource !== resolvedTarget) continue;
		diagnostics.push({
			id: `elixir-check-warning-${lineStr}-${colStr || "1"}`,
			message: warning[1].trim(),
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr || "1", 10) || 1,
			severity: "warning",
			semantic: "warning",
			tool: "elixir-check",
			rule: "warning",
			fixable: false,
		});
	}
	return diagnostics;
}

function firstOutputLine(result: { stdout?: string; stderr?: string }): string {
	return `${result.stderr || ""}\n${result.stdout || ""}`
		.trim()
		.split(/\r?\n/, 1)[0]
		.slice(0, 200);
}

const elixirCheckRunner: RunnerDefinition = {
	id: "elixir-check",
	appliesTo: ["elixir"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const absPath = path.resolve(cwd, ctx.filePath);

		let command: string | undefined;
		let args: string[] = [];
		if (hasMixExs(cwd) && (await isCommandAvailable("mix"))) {
			command = "mix";
			args = ["compile", "--warnings-as-errors"];
		} else if (await isCommandAvailable("elixirc")) {
			const outDir = path.join(cwd, ".pi-lens", "elixir-check");
			fs.mkdirSync(outDir, { recursive: true });
			command = "elixirc";
			args = ["-o", outDir, absPath];
		}

		if (!command) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const result = await safeSpawnAsync(command, args, {
			cwd,
			timeout: 30000,
		});
		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const raw = `${result.stderr || ""}\n${result.stdout || ""}`;
		const diagnostics = parseElixirOutput(raw, ctx.filePath);
		if (diagnostics.length === 0) {
			if (result.status && result.status !== 0) {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "elixir-check-nonzero-no-diagnostics",
							message:
								firstOutputLine(result) ||
								`${command} exited non-zero without structured diagnostics`,
							filePath: ctx.filePath,
							severity: "error",
							semantic: "blocking",
							tool: "elixir-check",
							rule: command,
							fixable: false,
						},
					],
					semantic: "blocking",
				};
			}
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

export default elixirCheckRunner;

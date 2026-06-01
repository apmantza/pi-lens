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
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const dotnet = createAvailabilityChecker("dotnet", ".exe");

function findProjectTarget(cwd: string): string | undefined {
	const entries = fs.readdirSync(cwd);
	const solution = entries.find((entry) => /\.(sln|slnx)$/i.test(entry));
	if (solution) return solution;
	return entries.find((entry) => /\.(csproj)$/i.test(entry));
}

interface DotnetDiagnosticLine {
	reportedFile: string;
	lineStr: string;
	colStr: string;
	severityLabel: "error" | "warning";
	rule: string;
	message: string;
}

function isDotnetRuleId(value: string): boolean {
	if (value.length < 2) return false;
	let sawDigit = false;
	for (const char of value) {
		const code = char.charCodeAt(0);
		const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
		const isDigit = code >= 48 && code <= 57;
		if (isDigit) {
			sawDigit = true;
			continue;
		}
		if (!isLetter || sawDigit) return false;
	}
	return sawDigit;
}

function parseDotnetDiagnosticLine(line: string): DotnetDiagnosticLine | null {
	const lower = line.toLowerCase();
	const fileEnd = lower.lastIndexOf(".cs(");
	if (fileEnd < 0) return null;

	const reportedFile = line.slice(0, fileEnd + 3).trim();
	let cursor = fileEnd + 4;
	const lineStart = cursor;
	while (
		cursor < line.length &&
		line.charCodeAt(cursor) >= 48 &&
		line.charCodeAt(cursor) <= 57
	) {
		cursor += 1;
	}
	if (cursor === lineStart || line[cursor] !== ",") return null;
	const lineStr = line.slice(lineStart, cursor);

	cursor += 1;
	const colStart = cursor;
	while (
		cursor < line.length &&
		line.charCodeAt(cursor) >= 48 &&
		line.charCodeAt(cursor) <= 57
	) {
		cursor += 1;
	}
	if (cursor === colStart || line.slice(cursor, cursor + 3) !== "): ")
		return null;
	const colStr = line.slice(colStart, cursor);

	cursor += 3;
	const tailLower = line.slice(cursor).toLowerCase();
	let severityLabel: "error" | "warning";
	if (tailLower.startsWith("error ")) {
		severityLabel = "error";
		cursor += "error ".length;
	} else if (tailLower.startsWith("warning ")) {
		severityLabel = "warning";
		cursor += "warning ".length;
	} else {
		return null;
	}

	const colon = line.indexOf(":", cursor);
	if (colon < 0) return null;
	const rule = line.slice(cursor, colon).trim();
	if (!isDotnetRuleId(rule)) return null;

	let message = line.slice(colon + 1).trim();
	if (message.endsWith("]")) {
		const projectSuffix = message.lastIndexOf(" [");
		if (projectSuffix >= 0) message = message.slice(0, projectSuffix).trimEnd();
	}

	return { reportedFile, lineStr, colStr, severityLabel, rule, message };
}

function parseDotnetBuildOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const parsed = parseDotnetDiagnosticLine(line);
		if (!parsed) continue;

		const { reportedFile, lineStr, colStr, severityLabel, rule, message } =
			parsed;
		const resolvedReported = path.resolve(reportedFile);
		const resolvedTarget = path.resolve(filePath);
		if (resolvedReported !== resolvedTarget) continue;

		const severity =
			severityLabel.toLowerCase() === "error" ? "error" : "warning";
		const lineNum = Number.parseInt(lineStr, 10) || 1;
		const colNum = Number.parseInt(colStr, 10) || 1;
		diagnostics.push({
			id: `dotnet-build-${rule}-${lineNum}-${colNum}`,
			message: `[${rule}] ${message.trim()}`,
			filePath,
			line: lineNum,
			column: colNum,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "dotnet-build",
			rule,
			fixable: false,
		});
	}

	return diagnostics;
}

const dotnetBuildRunner: RunnerDefinition = {
	id: "dotnet-build",
	appliesTo: ["csharp"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	timeoutMs: 90_000,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		if (!(await (dotnet.isAvailableAsync?.(cwd) ?? dotnet.isAvailable(cwd)))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = dotnet.getCommand(cwd);
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const target = findProjectTarget(cwd);
		if (!target) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const result = await safeSpawnAsync(
			cmd,
			["build", target, "--nologo", "--verbosity", "minimal"],
			{
				cwd,
				timeout: 60000,
			},
		);
		const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

		if (result.status === 0 && !raw) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseDotnetBuildOutput(raw, ctx.filePath);
		if (diagnostics.length === 0) {
			return {
				status: result.status === 0 ? "succeeded" : "failed",
				diagnostics: [],
				semantic: "warning",
				rawOutput: raw,
			};
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default dotnetBuildRunner;

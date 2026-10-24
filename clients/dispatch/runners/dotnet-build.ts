import * as fs from "node:fs";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import {
	DOTNET_CSHARP_PROJECT_MARKERS,
	DOTNET_CSHARP_SOLUTION_MARKERS,
} from "../../file-kinds.js";
import { direntsHaveMarkerGlobMatch, pathsEqual } from "../../path-utils.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

const dotnet = createAvailabilityChecker("dotnet", ".exe");

function findProjectTarget(cwd: string): string | undefined {
	const entries = fs.readdirSync(cwd, { withFileTypes: true });
	// #4806: the marker seam decides what counts as a solution or a project (a
	// directory named like one does not). A solution outranks a lone project.
	for (const patterns of [
		DOTNET_CSHARP_SOLUTION_MARKERS,
		DOTNET_CSHARP_PROJECT_MARKERS,
	]) {
		const hit = entries.find((entry) =>
			patterns.some((pattern) => direntsHaveMarkerGlobMatch([entry], pattern)),
		);
		if (hit) return hit.name;
	}
	return undefined;
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

function parseDotnetBuildOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const absTarget = path.resolve(cwd, filePath);
	for (const line of raw.split(/\r?\n/)) {
		const parsed = parseDotnetDiagnosticLine(line);
		if (!parsed) continue;

		const { reportedFile, lineStr, colStr, severityLabel, rule, message } =
			parsed;
		// #3278: one seam for reported-path attribution — see javac.ts.
		if (!pathsEqual(path.resolve(cwd, reportedFile), absTarget)) continue;

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
	timeoutMs: 90_000,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "dotnet-build");
		if (!(await dotnet.isAvailableAsync(cwd))) {
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

		const parsed = parseToolRun(
			"dotnet-build",
			{
				result,
				output: raw,
				// EXIT TABLE (.NET SDK 8 measured fixture): 0 clean; 1 findings; 2 error; other nonzero rejected.
				exitCodes: { ran: [1, 2] },
			},
			(output) => parseDotnetBuildOutput(output, ctx.filePath, cwd),
		);
		if (parsed.skipped) return parsed.skipped;
		return finishParsedRun({
			tool: "dotnet-build",
			ctx,
			result,
			diagnostics: parsed.diagnostics,
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

export default dotnetBuildRunner;

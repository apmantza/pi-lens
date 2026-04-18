import * as path from "node:path";
import { safeSpawn } from "../../safe-spawn.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

type CompilerSpec =
	| { command: string; args: string[]; flavor: "gcc" | "msvc" }
	| undefined;

function resolveCompiler(absPath: string): CompilerSpec {
	const gccLike: Array<{ command: string; args: string[] }> = [
		{ command: "clang++", args: ["-fsyntax-only", absPath] },
		{ command: "g++", args: ["-fsyntax-only", absPath] },
		{ command: "c++", args: ["-fsyntax-only", absPath] },
	];
	for (const candidate of gccLike) {
		const probe = safeSpawn(candidate.command, ["--version"], { timeout: 5000 });
		if (!probe.error && probe.status === 0) {
			return { ...candidate, flavor: "gcc" };
		}
	}

	const clProbe = safeSpawn("cl", [], { timeout: 5000 });
	if (!clProbe.error && clProbe.status !== null) {
		return {
			command: "cl",
			args: ["/nologo", "/Zs", absPath],
			flavor: "msvc",
		};
	}

	return undefined;
}

function parseGccLikeOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(
			/^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s+(.+)$/i,
		);
		if (!match) continue;
		const [, sourcePath, lineStr, colStr, severityLabel, message] = match;
		const resolvedSource = path.resolve(sourcePath.trim());
		const resolvedTarget = path.resolve(filePath);
		if (resolvedSource !== resolvedTarget) continue;

		const severity =
			severityLabel.toLowerCase().includes("error") ? "error" : "warning";
		diagnostics.push({
			id: `cpp-check-${severityLabel}-${lineStr}-${colStr || "1"}`,
			message: message.trim(),
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr || "1", 10) || 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "cpp-check",
			rule: severityLabel.toLowerCase(),
			fixable: false,
		});
	}
	return diagnostics;
}

function parseMsvcOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(
			/^(.*)\((\d+)(?:,(\d+))?\):\s*(fatal error|error|warning)\s+([A-Z]+\d+):\s+(.+)$/i,
		);
		if (!match) continue;
		const [, sourcePath, lineStr, colStr, severityLabel, rule, message] = match;
		const resolvedSource = path.resolve(sourcePath.trim());
		const resolvedTarget = path.resolve(filePath);
		if (resolvedSource !== resolvedTarget) continue;

		const severity =
			severityLabel.toLowerCase().includes("error") ? "error" : "warning";
		diagnostics.push({
			id: `cpp-check-${rule}-${lineStr}-${colStr || "1"}`,
			message: `[${rule}] ${message.trim()}`,
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr || "1", 10) || 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "cpp-check",
			rule,
			fixable: false,
		});
	}
	return diagnostics;
}

function firstOutputLine(raw: string): string {
	return raw.trim().split(/\r?\n/, 1)[0]?.slice(0, 200) ?? "";
}

const cppCheckRunner: RunnerDefinition = {
	id: "cpp-check",
	appliesTo: ["cxx"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const absPath = path.resolve(cwd, ctx.filePath);
		const compiler = resolveCompiler(absPath);
		if (!compiler) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const result = safeSpawn(compiler.command, compiler.args, {
			cwd,
			timeout: 30000,
		});
		const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
		const diagnostics =
			compiler.flavor === "msvc"
				? parseMsvcOutput(raw, ctx.filePath)
				: parseGccLikeOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			if (result.status && result.status !== 0) {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "cpp-check-nonzero-no-diagnostics",
							message:
								firstOutputLine(raw) ||
								`${compiler.command} exited non-zero without structured diagnostics`,
							filePath: ctx.filePath,
							severity: "warning",
							semantic: "warning",
							tool: "cpp-check",
							rule: compiler.command,
							fixable: false,
						},
					],
					semantic: "warning",
					rawOutput: raw,
				};
			}
			return { status: "succeeded", diagnostics: [], semantic: "none", rawOutput: raw };
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
			rawOutput: raw,
		};
	},
};

export default cppCheckRunner;

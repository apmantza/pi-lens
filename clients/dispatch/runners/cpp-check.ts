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

type CompilerSpec =
	| { command: string; args: string[]; flavor: "gcc" | "msvc" }
	| undefined;

// Per-compiler availability checkers — each one caches per-cwd and
// dedupes concurrent --version probes, the same protections every other
// runner gets via createAvailabilityChecker. cpp-check previously
// re-spawned its full candidate sweep on every edit.
const compilerCheckers = {
	clang: createAvailabilityChecker("clang", ".exe"),
	gcc: createAvailabilityChecker("gcc", ".exe"),
	cc: createAvailabilityChecker("cc", ".exe"),
	"clang++": createAvailabilityChecker("clang++", ".exe"),
	"g++": createAvailabilityChecker("g++", ".exe"),
	"c++": createAvailabilityChecker("c++", ".exe"),
	cl: createAvailabilityChecker("cl", ".exe"),
} as const;
type CompilerKey = keyof typeof compilerCheckers;

const C_SOURCE_EXTENSIONS = new Set([".c"]);
const C_HEADER_EXTENSIONS = new Set([".h"]);
const CPP_SOURCE_EXTENSIONS = new Set([
	".c++",
	".cc",
	".cp",
	".cpp",
	".cxx",
	".c++m",
	".cppm",
	".cxxm",
	".ixx",
	".cu",
	".hip",
	".mm",
	".clcpp",
]);
const CPP_HEADER_EXTENSIONS = new Set([
	".hh",
	".hpp",
	".hxx",
	".inl",
	".ipp",
	".tpp",
	".txx",
]);

function headerLooksLikeCpp(absPath: string): boolean {
	try {
		const content = fs.readFileSync(absPath, "utf-8");
		return /\b(namespace|template|class|constexpr|concept|using)\b|std::|\b(public|private|protected)\s*:/.test(
			content,
		);
	} catch {
		return false;
	}
}

function getGccLikeCandidates(
	absPath: string,
): Array<{ key: CompilerKey; args: string[] }> {
	const ext = path.extname(absPath).toLowerCase();
	const cMode =
		C_SOURCE_EXTENSIONS.has(ext) ||
		(C_HEADER_EXTENSIONS.has(ext) && !headerLooksLikeCpp(absPath));
	const cppMode =
		CPP_SOURCE_EXTENSIONS.has(ext) || CPP_HEADER_EXTENSIONS.has(ext);

	if (cMode) {
		const cArgs = C_HEADER_EXTENSIONS.has(ext)
			? ["-x", "c-header", "-fsyntax-only", absPath]
			: ["-x", "c", "-fsyntax-only", absPath];
		return [
			{ key: "clang", args: cArgs },
			{ key: "gcc", args: cArgs },
			{ key: "cc", args: cArgs },
		];
	}

	if (cppMode || ext) {
		return [
			{ key: "clang++", args: ["-fsyntax-only", absPath] },
			{ key: "g++", args: ["-fsyntax-only", absPath] },
			{ key: "c++", args: ["-fsyntax-only", absPath] },
		];
	}

	return [];
}

async function resolveCompiler(
	absPath: string,
	cwd: string,
): Promise<CompilerSpec> {
	for (const candidate of getGccLikeCandidates(absPath)) {
		const checker = compilerCheckers[candidate.key];
		if (await checker.isAvailableAsync(cwd)) {
			const command = checker.getCommand(cwd) ?? candidate.key;
			return { command, args: candidate.args, flavor: "gcc" };
		}
	}

	// MSVC `cl.exe` doesn't accept `--version`; the createAvailabilityChecker
	// probe used by every other compiler returns false even when cl is on
	// PATH. Keep the ad-hoc no-arg probe but cache the resolution via the
	// shared checker so subsequent edits don't re-spawn.
	const clChecker = compilerCheckers.cl;
	const clCmd = clChecker.getCommand(cwd);
	if (clCmd) {
		// Already probed in a previous turn and resolved.
		return { command: clCmd, args: ["/nologo", "/Zs", absPath], flavor: "msvc" };
	}
	const clProbe = await safeSpawnAsync("cl", [], { timeout: 5000 });
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

		const severity = severityLabel.toLowerCase().includes("error")
			? "error"
			: "warning";
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

		const severity = severityLabel.toLowerCase().includes("error")
			? "error"
			: "warning";
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
		const compiler = await resolveCompiler(absPath, cwd);
		if (!compiler) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const result = await safeSpawnAsync(compiler.command, compiler.args, {
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
			return {
				status: "succeeded",
				diagnostics: [],
				semantic: "none",
				rawOutput: raw,
			};
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

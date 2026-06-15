import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "../../file-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

// Per-cwd cached `--version` probes (#120). Before this, each dispatch
// invocation fired a fresh `safeSpawnAsync` per command — once per Elixir
// file save.
const mix = createAvailabilityChecker("mix", ".bat");
const elixirc = createAvailabilityChecker("elixirc", ".bat");

function hasMixExs(cwd: string): boolean {
	return fs.existsSync(path.join(cwd, "mix.exs"));
}

// Elixir 1.16+ emits diagnostics in a multi-line "code snippet" format where
// the file:line:col lives on a trailing `└─ path:line:col` line, several lines
// after the `error:`/`warning:` header:
//
//     warning: variable "x" is unused
//     │
//   3 │     x = 1
//     │     ~
//     │
//     └─ lib/foo.ex:3:5: Foo.bar/0
//
// Older Elixir put the location on the line immediately after `warning:` and
// reported compile errors as a single `** (Kind) path:line:col: message` line.
// We support both so the runner works across toolchain versions.
const ELIXIR_SNIPPET_LOCATION = /└─\s+(.+?):(\d+)(?::(\d+))?(?::|$)/;

function parseElixirOutput(
	raw: string,
	filePath: string,
	cwd: string = process.cwd(),
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const resolvedTarget = path.resolve(cwd, filePath);
	const lines = raw.split(/\r?\n/);

	// elixirc reports paths RELATIVE to its cwd (e.g. `bad.ex`, not the absolute
	// path we passed), so resolve the reported path against the runner cwd — not
	// process.cwd(). Elixir 1.16+ also normalizes to a lowercase drive letter and
	// forward slashes (`c:/...`), which never string-equals `C:\...` on Windows,
	// so compare case-insensitively there.
	const matchesTarget = (sourcePath: string): boolean => {
		const resolved = path.resolve(cwd, sourcePath.trim());
		return process.platform === "win32"
			? resolved.toLowerCase() === resolvedTarget.toLowerCase()
			: resolved === resolvedTarget;
	};

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		// Defense-in-depth: cap line length before regex matching. The input is
		// trusted, bounded compiler output and the patterns have no exponential
		// backtracking, but this bounds worst-case work regardless (ReDoS guard).
		if (line.length > 2000) continue;

		// Legacy one-line compile error: ** (CompileError) path:line:col: message
		const syntax = line.match(
			/^\*\* \(([^)]+)\)\s+(.+?):(\d+):(?:(\d+):)?\s*(.+)$/,
		);
		if (syntax) {
			const [, kind, sourcePath, lineStr, colStr, message] = syntax;
			if (!matchesTarget(sourcePath)) continue;
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

		// error:/warning: header — may be bare (legacy) or indented (1.16+).
		const header = line.match(/^\s*(error|warning):\s+(.+)$/);
		if (!header) continue;
		const [, severityLabel, message] = header;
		const severity = severityLabel === "error" ? "error" : "warning";

		// New format: scan forward for the `└─ path:line:col` snippet footer.
		let located = false;
		for (
			let lookahead = index + 1;
			lookahead < lines.length && lookahead <= index + 12;
			lookahead++
		) {
			const next = lines[lookahead];
			// A blank gap or another header ends this diagnostic block.
			if (/^\s*(error|warning):\s+/.test(next)) break;
			const snippet = next.match(ELIXIR_SNIPPET_LOCATION);
			if (snippet) {
				const [, sourcePath, lineStr, colStr] = snippet;
				if (matchesTarget(sourcePath)) {
					diagnostics.push({
						id: `elixir-check-${severity}-${lineStr}-${colStr || "1"}`,
						message:
							severity === "error" ? `[error] ${message.trim()}` : message.trim(),
						filePath,
						line: Number.parseInt(lineStr, 10) || 1,
						column: Number.parseInt(colStr || "1", 10) || 1,
						severity,
						semantic: severity === "error" ? "blocking" : "warning",
						tool: "elixir-check",
						rule: severity === "error" ? "error" : "warning",
						fixable: false,
					});
				}
				located = true;
				break;
			}
		}
		if (located) continue;

		// Legacy format: location on the immediately following line.
		const location = lines[index + 1]?.match(/^\s+(.+?):(\d+):(?:(\d+):)?$/);
		if (!location) continue;
		const [, sourcePath, lineStr, colStr] = location;
		if (!matchesTarget(sourcePath)) continue;
		diagnostics.push({
			id: `elixir-check-${severity}-${lineStr}-${colStr || "1"}`,
			message: severity === "error" ? `[error] ${message.trim()}` : message.trim(),
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr || "1", 10) || 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "elixir-check",
			rule: severity === "error" ? "error" : "warning",
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
		if (hasMixExs(cwd) && (await mix.isAvailableAsync(cwd))) {
			command = "mix";
			args = ["compile", "--warnings-as-errors"];
		} else if (await elixirc.isAvailableAsync(cwd)) {
			const outDir = path.join(getProjectDataDir(cwd), "elixir-check");
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
		const diagnostics = parseElixirOutput(raw, ctx.filePath, cwd);
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
export { parseElixirOutput };

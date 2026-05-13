import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

interface PSAnalyzerResult {
	RuleName?: string;
	Severity?: string;
	Line?: number;
	Column?: number;
	Message?: string;
}

// The PS script written to a temp file each run — avoids cmd.exe quoting issues
// safeSpawnAsync uses shell:true on Windows, which mangles -Command strings.
// Using -File with a temp script sidesteps all escaping problems.
const PS_SCRIPT = `
param([string]$FilePath)
Import-Module PSScriptAnalyzer -ErrorAction Stop
$results = @(Invoke-ScriptAnalyzer -Path $FilePath | Select-Object RuleName,@{N='Severity';E={$_.Severity.ToString()}},Line,Column,Message)
if ($results.Count -eq 0) { Write-Output '[]'; exit 0 }
$results | ConvertTo-Json -Depth 3 -Compress
`.trim();

// Cache resolved powershell binary and module availability per process
let psCmd: string | null | undefined = undefined;
let psAnalyzerAvailable: boolean | undefined = undefined;

const PS_TIMEOUT_MS = 30000;

function spawnPs(cmd: string, args: string[], timeoutMs = PS_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; status: number | null }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { windowsHide: true, shell: false });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const done = (status: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, status });
		};

		const timer = setTimeout(() => {
			if (!settled) {
				child.kill("SIGTERM");
				setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 1000);
				done(null);
			}
		}, timeoutMs);

		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		child.stdout?.on("data", (d) => (stdout += d));
		child.stderr?.on("data", (d) => (stderr += d));
		child.on("close", (code) => done(code));
		child.on("error", () => done(null));
	});
}

async function resolvePowerShellCmd(): Promise<string | null> {
	if (psCmd !== undefined) return psCmd;
	for (const candidate of ["pwsh", "powershell"]) {
		const r = await spawnPs(candidate, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
		if (r.status === 0) {
			psCmd = candidate;
			return psCmd;
		}
	}
	psCmd = null;
	return null;
}

async function checkModuleAvailable(cmd: string): Promise<boolean> {
	if (psAnalyzerAvailable !== undefined) return psAnalyzerAvailable;
	const r = await spawnPs(cmd, [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"if (Get-Module -ListAvailable PSScriptAnalyzer) { exit 0 } else { exit 1 }",
	]);
	psAnalyzerAvailable = r.status === 0;
	return psAnalyzerAvailable;
}

function parsePSAnalyzerOutput(raw: string, filePath: string): Diagnostic[] {
	if (!raw.trim() || raw.trim() === "[]") return [];
	let parsed: PSAnalyzerResult | PSAnalyzerResult[];
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const items = Array.isArray(parsed) ? parsed : [parsed];
	return items
		.filter((item) => item.Message && item.Line)
		.map((item) => {
			const sev = (item.Severity ?? "Warning").toLowerCase();
			const severity: "error" | "warning" | "info" =
				(sev === "error" || sev === "parseerror") ? "error" : (sev === "information" ? "info" : "warning");
			const rule = item.RuleName ?? "PSScriptAnalyzer";
			return {
				id: `psscriptanalyzer-${rule}-${item.Line}`,
				message: `[${rule}] ${item.Message}`,
				filePath,
				line: item.Line!,
				column: item.Column ?? 1,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "psscriptanalyzer",
				rule,
				fixable: false,
			};
		});
}

const psScriptAnalyzerRunner: RunnerDefinition = {
	id: "psscriptanalyzer",
	appliesTo: ["powershell"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cmd = await resolvePowerShellCmd();
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		if (!(await checkModuleAvailable(cmd))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cwd = ctx.cwd || process.cwd();
		const absPath = path.resolve(cwd, ctx.filePath);

		// Write script to temp file so we avoid cmd.exe quoting entirely
		const tmpScript = path.join(os.tmpdir(), `pi-lens-psa-${process.pid}.ps1`);
		await fs.writeFile(tmpScript, PS_SCRIPT, "utf-8");

		try {
			const result = await spawnPs(cmd, [
				"-NoProfile",
				"-NonInteractive",
				"-File", tmpScript,
				"-FilePath", absPath,
			]);

			if (result.status === null) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}

			const diagnostics = parsePSAnalyzerOutput(result.stdout, ctx.filePath);

			if (diagnostics.length === 0) {
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			}

			const hasErrors = diagnostics.some((d) => d.severity === "error");
			return {
				status: hasErrors ? "failed" : "succeeded",
				diagnostics,
				semantic: hasErrors ? "blocking" : "warning",
			};
		} finally {
			await fs.unlink(tmpScript).catch(() => {});
		}
	},
};

export default psScriptAnalyzerRunner;

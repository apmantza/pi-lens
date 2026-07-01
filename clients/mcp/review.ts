/**
 * Review-loop helpers for the MCP path: forking a `fresh` worker (so an analysis
 * reflects the latest build, not the long-lived server's stale image) and
 * rebuilding the dist/in-place output so `fresh` picks the change up.
 *
 * Together these close the "stale-process trap": commit → `pilens_rebuild` →
 * `pilens_analyze mode=fresh` measures the just-built code first-hand.
 */

import { spawn } from "node:child_process";
import {
	type NodePackageManager,
	pmBinary,
	resolveNodePackageManager,
	runScriptArgs,
} from "../package-manager.js";
import { safeSpawnAsync } from "../safe-spawn.js";
import type { AnalyzeFileOptions, McpAnalyzeResult } from "./analyze.js";

/**
 * Which npm script rebuilds the layout the server is running from. A server at
 * `…/dist/mcp/server.js` is the precompiled dist (`build:dist` recreates it); a
 * server at `…/mcp/server.js` is the in-place dev build (`build` emits beside the
 * sources). The forked worker is always resolved relative to the server, so it
 * shares the server's layout — rebuilding that layout updates the worker.
 */
export function resolveRebuildScript(
	serverFilePath: string,
): "build" | "build:dist" {
	return serverFilePath.replace(/\\/g, "/").includes("/dist/")
		? "build:dist"
		: "build";
}

export interface FreshAnalyzeOutcome {
	result?: McpAnalyzeResult;
	error?: string;
}

/**
 * Fork `node <workerPath>` to analyze a file in a fresh process. We spawn node
 * directly (no shell) so an interpreter path containing spaces is safe on
 * Windows — `safeSpawnAsync`'s shell mode does not escape the command itself.
 */
export function analyzeFileFresh(
	workerPath: string,
	file: string,
	cwd: string,
	options: AnalyzeFileOptions = {},
	timeoutMs = 120_000,
): Promise<FreshAnalyzeOutcome> {
	return new Promise((resolve) => {
		const args = [workerPath, `--file=${file}`, `--cwd=${cwd}`];
		if (options.flags) args.push(`--flags=${JSON.stringify(options.flags)}`);

		const child = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (outcome: FreshAnalyzeOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(outcome);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish({ error: `fresh analyze timed out after ${timeoutMs}ms` });
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", (err) =>
			finish({ error: `failed to fork worker: ${err.message}` }),
		);
		child.on("close", (code) => {
			if (code !== 0) {
				finish({
					error: `worker exited ${code}: ${stderr.trim() || "(no stderr)"}`,
				});
				return;
			}
			try {
				finish({ result: JSON.parse(stdout) as McpAnalyzeResult });
			} catch {
				finish({
					error: `worker produced invalid JSON (${stderr.trim() || stdout.slice(0, 200)})`,
				});
			}
		});
	});
}

export interface RebuildOutcome {
	ok: boolean;
	script: string;
	/** Package manager used to run the script (e.g. for the caller's headline). */
	packageManager: NodePackageManager;
	durationMs: number;
	output: string;
}

/**
 * Run `<pm> run <script>` in the pi-lens repo, where `<pm>` is resolved from the
 * repo's lockfile / installed managers. Uses `safeSpawnAsync` (Windows
 * `.cmd`/shell-aware). `ignoreAmbientSignal` — a rebuild must run to completion.
 */
export async function runRebuild(
	repoRoot: string,
	script: "build" | "build:dist",
	timeoutMs = 300_000,
): Promise<RebuildOutcome> {
	const start = Date.now();
	const packageManager = await resolveNodePackageManager(repoRoot);
	const res = await safeSpawnAsync(
		pmBinary(packageManager),
		runScriptArgs(script),
		{
			cwd: repoRoot,
			timeout: timeoutMs,
			ignoreAmbientSignal: true,
		},
	);
	const output = `${res.stdout}\n${res.stderr}`.trim();
	return {
		ok: !res.error && res.status === 0,
		script,
		packageManager,
		durationMs: Date.now() - start,
		output: output.slice(-2000),
	};
}

/** Minimal shape needed to dedupe/aggregate project-scan diagnostics. */
export type ScanDiagnostic = {
	filePath: string;
	line?: number;
	column?: number;
	rule?: string;
	runner?: string;
	tool?: string;
};

/**
 * Dedupe project-scan diagnostics (the cheap scanners can emit the same
 * file:line:rule twice) and aggregate counts by rule and file — so the
 * `pilens_project_scan` tool returns a compact, scannable summary instead of
 * dumping ~100 raw objects into the agent's context.
 */
export function summarizeScan(diagnostics: readonly ScanDiagnostic[]): {
	deduped: ScanDiagnostic[];
	byRule: Record<string, number>;
	byFile: Record<string, number>;
} {
	const seen = new Set<string>();
	const deduped: ScanDiagnostic[] = [];
	const byRule: Record<string, number> = {};
	const byFile: Record<string, number> = {};
	for (const diagnostic of diagnostics) {
		const ruleId =
			diagnostic.rule ?? diagnostic.runner ?? diagnostic.tool ?? "unknown";
		const key = `${diagnostic.filePath}|${diagnostic.line ?? "?"}|${diagnostic.column ?? "?"}|${ruleId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(diagnostic);
		byRule[ruleId] = (byRule[ruleId] ?? 0) + 1;
		byFile[diagnostic.filePath] = (byFile[diagnostic.filePath] ?? 0) + 1;
	}
	return { deduped, byRule, byFile };
}

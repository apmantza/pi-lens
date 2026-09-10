#!/usr/bin/env node
/**
 * pi-lens-analyze — the *push* half of the mirror, in two modes.
 *
 * Per-edit (default): a Claude Code PostToolUse hook (matched to Edit|Write)
 * that fires pi-lens automatically after every edit, the way pi's per-edit
 * pipeline does. Also usable as a plain CLI for testing/debugging. Reuses the
 * Tier 1 `analyzeFile` facade and defaults to `no-lsp` so inline feedback is
 * FAST (cold LSP would cost ~5s per edit and under-report anyway — pull
 * `pilens_analyze` against the warm MCP server for the type-check). The fast
 * runners (tree-sitter structural, ast-grep security, biome/ruff/oxlint lint,
 * complexity) are complete even in a cold process.
 *
 * Per-turn (`--turn-end`, or a Claude Code `Stop` payload on stdin): the
 * analogue of pi's agent_end — incremental knip/madge, cascade-to-dependents,
 * tests, actionable-warnings aggregation. WARM-ONLY: it drives the real
 * `handleTurnEnd` inside the running MCP server over the workspace IPC socket
 * and never falls back to a cold pass, because only the warm process owns the
 * session state and pending turn work. A skip reports WHY, on stdout as well as
 * stderr (#1272 — Claude Code never surfaces stderr from a hook that exits 0,
 * so a stderr-only skip was indistinguishable from a clean turn), and records
 * the outcome for `pilens_health`.
 *
 * Input: `--file=<path>` (+ optional `--cwd=`), or a Claude Code hook JSON
 * payload on stdin (`tool_input.path`/`file_path`, `cwd`, `hook_event_name`).
 * argv wins: when `--file` or `--turn-end` is present stdin is never read at
 * all, so an open-but-idle pipe cannot hang the hook (#1271).
 * Output: a concise report on stdout; with `--hook`, a PostToolUse JSON
 * envelope that injects the report as context. Exit 0 always (advisory — never
 * blocks the edit, never blocks the stop).
 */

import * as path from "node:path";
import type { McpAnalyzeResult } from "../clients/mcp/analyze.js";
import {
	recordTurnEndOutcome,
	requestWarmAnalyze,
	requestWarmTurnEnd,
	type WarmDiagnosticsFailureReason,
	type WarmTurnEndResponse,
} from "../clients/mcp/ipc.js";
// Type-only deps at runtime — safe for the bin's light no-edit path.
import { AUTOMATION_FRAMING } from "../clients/runtime-context.js";

console.log = (...args: unknown[]) => console.error(...args);

function argVal(name: string): string | undefined {
	const prefix = `--${name}=`;
	const found = process.argv.find((value) => value.startsWith(prefix));
	return found ? found.slice(prefix.length) : undefined;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function formatReport(result: McpAnalyzeResult, cwd: string): string {
	const rel = path.relative(cwd, result.filePath) || result.filePath;
	const lines = [
		// #2420: advisories (hint/info-tier style opinions) reported under their
		// own label — no longer folded into the warning count on this surface.
		`🔎 pi-lens: ${rel} — ${result.counts.blockers} blocking, ${result.counts.warnings} warning(s), ${result.counts.advisories} advisory(ies)`,
	];
	for (const d of result.diagnostics.slice(0, 30)) {
		const marker = d.semantic === "blocking" ? "🔴" : "⚠";
		const label = d.rule ?? d.tool;
		lines.push(`  ${marker} L${d.line ?? "?"} ${label}: ${d.message}`);
	}
	if (result.diagnostics.length > 30) {
		lines.push(`  … ${result.diagnostics.length - 30} more`);
	}
	if (
		result.lsp &&
		(result.lsp.status === "skipped" || result.lsp.status === "deferred")
	) {
		lines.push(
			"  (LSP type-check skipped — run pilens_analyze on the warm MCP server for type errors)",
		);
	}
	return lines.join("\n");
}

interface HookPayload {
	cwd?: string;
	hook_event_name?: string;
	tool_input?: { file_path?: string; path?: string };
}

/**
 * #1271: a piped-but-never-closed stdin used to hang this bin forever — the
 * `isTTY` guard only covers an interactive terminal, and any spawner using
 * `stdio: 'pipe'` (CI wrappers, `sh -c`, pre-commit runners) leaves the pipe
 * open. As a Stop hook that meant sitting at Claude Code's full 60 s timeout
 * every turn; a hung hook is strictly worse than a failed one. Bounded read →
 * degrade to "no payload", which is exactly how a plain CLI invocation is
 * already treated. `unref` so a still-open pipe cannot hold the event loop
 * after we have stopped caring about it.
 */
const STDIN_READ_TIMEOUT_MS = 2_000;

async function readHookPayload(): Promise<HookPayload | undefined> {
	if (process.stdin.isTTY) return undefined;
	const raw = await Promise.race([
		readStdin(),
		new Promise<undefined>((resolve) => {
			const timer = setTimeout(() => resolve(undefined), STDIN_READ_TIMEOUT_MS);
			timer.unref();
		}),
	]);
	if (raw === undefined) {
		process.stdin.pause();
		(process.stdin as { unref?: () => void }).unref?.();
		return undefined;
	}
	try {
		return (JSON.parse(raw) as HookPayload | null) ?? undefined;
	} catch {
		// not a JSON payload — plain CLI invocation
		return undefined;
	}
}

// The framing token is for pi's user-role injection; the rest of the first
// line reads fine in a transcript, so only the token goes.
const TURN_END_MAX_LINES = 40;
const TURN_END_MAX_CHARS = 2000;

/**
 * #1275: the `tests` section is the RAW vitest failure dump, which carries SGR
 * colour codes and other control bytes straight into the Claude Code
 * transcript — and the character cap below can slice an escape sequence in
 * half, leaking the tail as literal garbage. Strip CSI/two-byte escapes and C0
 * controls (keeping \n and \t, which the render depends on) plus DEL, BEFORE
 * capping so the caps measure text the reader will actually see.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const ANSI_AND_CONTROL = new RegExp(
	[
		"\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\)", // OSC … BEL/ST
		"\\u001B\\[[0-?]*[ -/]*[@-~]", // CSI — SGR colours et al
		"\\u001B[@-Z\\\\-_]", // two-byte escapes
		"[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", // C0 minus newline/tab, plus DEL
	].join("|"),
	"g",
);

function stripControlSequences(text: string): string {
	return text.replace(ANSI_AND_CONTROL, "");
}

/**
 * #1275: `slice` counts UTF-16 code units, so a cut that lands between the high
 * and low halves of a surrogate pair renders as U+FFFD — and findings are dense
 * with emoji. Back the cut off by one when it would orphan a high surrogate.
 */
function capCodeUnits(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const last = text.charCodeAt(cap - 1);
	const splitsPair = last >= 0xd800 && last <= 0xdbff;
	return text.slice(0, splitsPair ? cap - 1 : cap);
}

function formatTurnEnd(response: WarmTurnEndResponse): string | undefined {
	const sections = [response.turnEnd, response.tests]
		.filter((section): section is string => Boolean(section))
		// #1275: the producer emits the framing token as a PREFIX, but a section
		// assembled by joining several messages can carry it again mid-text, where
		// a positional strip would leave it in the transcript. Replace every
		// occurrence — the token is never meaningful content.
		.map((section) =>
			stripControlSequences(section.split(AUTOMATION_FRAMING).join("")),
		);
	if (sections.length === 0) return undefined;

	// `turnEnd` is server-capped, `tests` is not (a vitest failure dump can run long).
	let out = `🔎 pi-lens turn-end\n${sections.join("\n\n")}`;
	const lines = out.split("\n");
	if (lines.length > TURN_END_MAX_LINES) {
		out = `${lines.slice(0, TURN_END_MAX_LINES).join("\n")}\n  … (truncated)`;
	}
	if (out.length > TURN_END_MAX_CHARS) {
		out = `${capCodeUnits(out, TURN_END_MAX_CHARS)}\n  … (truncated)`;
	}
	return out;
}

/**
 * #1272: every skip used to read "no warm pi-lens MCP server", including the
 * cases where the server WAS warm and answering. Those are different remedies —
 * start the server, wait for a slow pass, or rebuild a stale one — so the
 * message names which happened. `ipc-error` is also what a stale-build reply
 * looks like on the wire (the server answers `{error: "warm build stale"}`),
 * hence the rebuild hint on that arm.
 */
const TURN_END_SKIP_REASONS: Record<WarmDiagnosticsFailureReason, string> = {
	"ipc-error":
		"no warm pi-lens MCP server answered for this workspace, or its build is stale — start the MCP server, or run `npm run build` if you have edited pi-lens sources",
	timeout:
		"the warm pi-lens MCP server did not finish the pass within the hook budget — the turn-end findings are kept and will be delivered on a later Stop",
	"schema-mismatch":
		"the warm pi-lens MCP server speaks a different turn-end schema than this hook binary — rebuild and restart the server so both halves match",
	"stale-answer":
		"the warm pi-lens MCP server replied about a superseded state — the findings are kept for a later Stop",
};

async function runTurnEndMode(
	cwd: string,
	payload: HookPayload | undefined,
): Promise<void> {
	// Subagent edits already fire PostToolUse into the shared workspace turn
	// state, and the consume bridges are one-shot — a subagent pass would eat the
	// main agent's findings into a transcript nobody reads, and multiply the
	// heavy pass by the fan-out. Only the main agent's Stop runs it.
	if (payload?.hook_event_name === "SubagentStop") {
		process.stderr.write(
			"pi-lens turn-end skipped: SubagentStop (the main agent's Stop runs the pass)\n",
		);
		process.exitCode = 0;
		return;
	}

	// Warm-only by design: only the server process owns the session state and
	// pending turn work, so a cold pass would report a false clean (#533/#1023).
	const outcome = await requestWarmTurnEnd(cwd);
	if (!outcome.available) {
		const detail = TURN_END_SKIP_REASONS[outcome.reason];
		const message = `🔎 pi-lens turn-end skipped (${outcome.reason}): ${detail}`;
		// #1272: stderr AND stdout. Claude Code does not surface stderr from a
		// hook that exits 0, so a stderr-only skip made a permanently dead
		// integration byte-for-byte identical to a clean turn. stdout is the
		// hook's only transcript-visible channel, so the skip goes there too —
		// one line, so a genuinely absent server is a footnote, not noise.
		process.stderr.write(`${message} (cwd: ${cwd})\n`);
		await writeStdout(message);
		recordTurnEndOutcome(cwd, { ran: false, reason: outcome.reason });
		process.exitCode = 0;
		return;
	}

	recordTurnEndOutcome(cwd, { ran: true });
	const report = formatTurnEnd(outcome.response);
	if (report) await writeStdout(report);
	process.exitCode = 0;
}

function writeStdout(text: string): Promise<void> {
	return new Promise<void>((done) => {
		process.stdout.write(`${text}\n`, () => done());
	});
}

async function main(): Promise<void> {
	const hookMode = process.argv.includes("--hook");
	const withLsp = process.argv.includes("--lsp");
	const fileArg = argVal("file");
	const turnEndFlag = process.argv.includes("--turn-end");
	// #1271: the stdin payload is the fallback way to learn WHAT to do. When
	// argv already says so, reading stdin buys nothing and costs everything —
	// an open pipe (`stdio: 'pipe'` with no `end()`) used to hang here forever,
	// which as a Stop hook means Claude Code waits out its full 60 s timeout on
	// every single turn. Only dial stdin when argv left the question open.
	const payload =
		fileArg === undefined && !turnEndFlag ? await readHookPayload() : undefined;
	const cwd = argVal("cwd") ?? payload?.cwd ?? process.cwd();

	const event = payload?.hook_event_name;
	if (turnEndFlag || event === "Stop" || event === "SubagentStop") {
		return runTurnEndMode(cwd, payload);
	}

	const file =
		fileArg ?? payload?.tool_input?.file_path ?? payload?.tool_input?.path;
	if (!file) process.exit(0); // nothing to analyze — stay silent

	// Warm path first: if the MCP server is up for this workspace, it analyzes in
	// its warm process (LSP-COMPLETE) and we never load the dispatch graph here.
	// Falls back to a cold, no-LSP local run when no server is reachable.
	let result = await requestWarmAnalyze(cwd, file);
	if (!result) {
		const { analyzeFile } = await import("../clients/mcp/analyze.js");
		result = await analyzeFile(file, cwd, {
			flags: withLsp ? {} : { "no-lsp": true },
			record: false,
			// Edit-detection path (PostToolUse) — mark the file for pilens_turn_end.
			registerTurnState: true,
		});
	}
	// One-shot consumers cannot rely on the installer's unref'd debounce.
	const { flushProbeCache } = await import("../clients/installer/index.js");
	await flushProbeCache();

	if (result.counts.diagnostics === 0) process.exit(0); // clean → no noise

	const report = formatReport(result, cwd);
	if (hookMode) {
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					additionalContext: report,
				},
			}),
		);
	} else {
		process.stdout.write(`${report}\n`);
	}
	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(`pi-lens-analyze failed: ${(err as Error).message}\n`);
	process.exit(0); // advisory — never break the edit flow
});

/**
 * #4484 witness (ADR 0007): a second write must not clear a blocker it left
 * in place.
 *
 * Recurrence it prevents: write 1 introduces error E, write 2 changes another
 * line, the delta calls E "not new", and pi-lens then said `✓ clean`, opened
 * the --lens-guard commit gate, emptied the session store and the widget, and
 * reported E as "cleared by the 2nd write" at turn end, while E was still on
 * disk. The same happened across turns and for a linter with ordinal ids
 * (helm-lint), where a line shift or a fix of an earlier finding keeps or
 * moves an id.
 *
 * Real: `index.ts`'s registered handlers (session_start, turn_start,
 * tool_result, tool_call, turn_end, context), `handleToolResult`,
 * `runPipeline`, `dispatchForFile` with the real `lsp` and `helm-lint`
 * runners, `RuntimeCoordinator`, `handleTurnEnd`, the git-guard gate,
 * `lens_diagnostics` and the widget store. Doubled only at the process
 * boundaries, the #3190 witness shape: `clients/safe-spawn.js` (helm) and the
 * LSP service behind `clients/lsp/capabilities.js`, whose `touchFile` reports
 * error 2304 on every line containing `BAD_CALL`, so it tracks the bytes like
 * a server would.
 *
 * Cells share one project directory: `index.ts`'s module graph is a process
 * singleton, and a session started in a second directory delivered nothing in
 * the probe. Each cell uses its own file and its own session, and ends by
 * fixing its file so no record or gate state reaches the next cell.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { waitFor } from "./clients/interleaving-kit.js";

const boundary = vi.hoisted(() => {
	/** Round 6 (P27): the ast-grep auxiliary server. Once `published`, napi's
	 *  Gate B skips; with `diag`, the server reports `no-unknown-returns` on
	 *  each `): unknown {` line, as its catalog would. Round 7 (P33): with
	 *  `cutoff`, the server does not answer the touch: unconfirmed, and none
	 *  of its diagnostics. #4529 review (P45): with `other` instead, it
	 *  reports another rule on those lines, at that LSP severity, as a team
	 *  sgconfig's catalog would. */
	const ag = {
		published: false,
		diag: false,
		cutoff: false,
		other: 0 as 0 | 1 | 2 | 4,
	};
	/** Round 8 (P39): with `silent`, the bash server does not answer a
	 *  `.sh` touch; `runs` counts shellcheck's CLI scans. */
	const sh = { silent: false, runs: 0 };
	const lsp = {
		/** The fake language server: error 2304 on each `BAD_CALL` line, and
		 *  warning 6133 on each `unusedVar` line (round 2, row 16). */
		diagnose: (content: string): unknown[] =>
			content.split("\n").flatMap((line, i, lines): unknown[] => {
				const range = {
					start: { line: i, character: 0 },
					end: { line: i, character: 8 },
				};
				if (ag.other !== 0 && line.includes("): unknown {"))
					return [
						{
							severity: ag.other,
							message: "Prefer an options object over positional parameters",
							code: "other-rule",
							source: "ast-grep",
							serverId: "ast-grep",
							range: {
								start: { line: i, character: 0 },
								end: { line: i, character: 10 },
							},
						},
					];
				if (ag.diag && line.includes("): unknown {"))
					return [
						{
							severity: 1,
							message:
								"Function returns 'unknown' — parse the value at its boundary and return a named domain type",
							code: "no-unknown-returns",
							source: "ast-grep",
							serverId: "ast-grep",
							range: {
								start: { line: i, character: 0 },
								end: { line: i, character: 10 },
							},
						},
					];
				// #5727: the Python rule of the report, on a bare `json.loads(`
				// call; a `try:` on the line above is the fix, as the rule's own
				// `inside: try_statement` exception would read it here.
				if (
					ag.diag &&
					line.includes("json.loads(") &&
					!(lines[i - 1] ?? "").trimEnd().endsWith("try:")
				)
					return [
						{
							severity: 1,
							message:
								"Call without try/except — throws on invalid input or missing file",
							code: "unchecked-throwing-call-python",
							source: "ast-grep",
							serverId: "ast-grep",
							range: {
								start: { line: i, character: 4 },
								end: { line: i, character: 26 },
							},
						},
					];
				// #5727: the Python language server's own error.
				if (line.includes("BAD_PY"))
					return [
						{
							severity: 1,
							message: '"BAD_PY" is not defined',
							code: "undefined-name",
							source: "python",
							serverId: "python",
							range,
						},
					];
				if (line.includes("BAD_CALL"))
					return [
						{
							severity: 1,
							message: "Cannot find name 'BAD_CALL'.",
							code: lsp.code,
							source: "ts",
							serverId: "typescript",
							range,
						},
					];
				if (line.includes("BAD_OTHER"))
					return [
						{
							severity: 1,
							message: "Cannot find name 'BAD_OTHER'.",
							code: 2304,
							source: "ts",
							serverId: "typescript",
							range,
						},
					];
				if (line.includes("unusedVar"))
					return [
						{
							severity: 2,
							message: "'unusedVar' is declared but its value is never read.",
							code: 6133,
							source: "ts",
							serverId: "typescript",
							range,
						},
					];
				return [];
			}),
		enabled: false,
		touches: 0,
		/**
		 * Review r2 (F3): the `code` the server reports for `BAD_CALL`. The
		 * rendered rule is `${source}:${code}`, so a long id exercises the
		 * place list's rule cap; the default is the ordinary TypeScript code.
		 */
		code: 2304 as number | string,
		/**
		 * Round 2: how the server answers the next touch. `inconclusive` is a
		 * touch whose diagnostics wait hit its deadline, `partial` one where
		 * another server answered but typescript did not, `throw` a server
		 * that failed, `hold` an answer that arrives only when the test
		 * releases it. #5017: `stale` is a confirmed answer the server computed
		 * for older bytes (`boundToCurrentDisk: false`): one blocking row that
		 * is not in these bytes.
		 */
		mode: "answer" as
			| "answer"
			| "inconclusive"
			| "partial"
			| "stale"
			| "throw"
			| "hold",
		/**
		 * #5008: the shape `clients/lsp/index.ts` produces when a scanner never
		 * reported — the primary's own answer for these bytes, `confirmation:
		 * "partial"`, and the silent servers named. A named server's rows are
		 * dropped, as the service's merge drops a server with no evidence.
		 */
		auxGap: undefined as undefined | string[],
		/**
		 * #5008: the primary silent with NO attribution, while an auxiliary that
		 * did answer reports one blocking row — the inverse cell of the state
		 * table (the touch's `inconclusiveServerIds` is the unknown case).
		 */
		silentAux: false,
		/**
		 * #5727: the Python primary (`python`) does not answer, for `reason`,
		 * while the ast-grep auxiliary answers these bytes, the shape the real
		 * `LSPService.touchFile` returns (tests/scripts/touch-result.test.ts
		 * pins `answeredServerIds` on it): the auxiliary's rows, the primary
		 * named, and the auxiliary in `answeredServerIds`. With `auxSilent`
		 * the auxiliary did not answer either: no rows, and on an inconclusive
		 * touch the service names no coverage gap. With `stale`, the merged
		 * binding says the answer is about other bytes (a second auxiliary's
		 * view diverged from disk while ast-grep's answer covered these).
		 * With `lastKnown` (diagnostics-wait only), the primary's last-known row
		 * for older bytes rides along in `.diags` too (#4231: an inconclusive
		 * primary may contribute its last-known diagnostics); the runner withholds
		 * it, so every row it holds is withheld.
		 */
		primarySilent: undefined as
			| undefined
			| {
					reason: "diagnostics-wait" | "primary-unavailable";
					auxSilent?: boolean;
					stale?: boolean;
					lastKnown?: boolean;
			  },
		/** Pending held answers; `release(true)` fails the touch instead. */
		held: [] as Array<(fail?: boolean) => void>,
		/** #4509: called once a touch is held, so a test can act mid-dispatch. */
		onHold: undefined as (() => void) | undefined,
		/**
		 * The double's touchFile. It lives here, not in the `vi.mock` factory:
		 * `tests/config/vi-mock-export-sweep.test.ts` reads a factory's export
		 * list off the first `return` it finds (the #3190 witness's note).
		 */
		touch: async (
			file: string,
			content: string,
			options?: { source?: string },
		) => {
			lsp.touches += 1;
			if (lsp.primarySilent) {
				const { reason, auxSilent, stale, lastKnown } = lsp.primarySilent;
				const primaryRows = lastKnown
					? [
							{
								severity: 1,
								message: "Cannot find name 'BAD_OLD'.",
								code: 2304,
								source: "ts",
								serverId: "python",
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 5 },
								},
							},
						]
					: [];
				return {
					diags: [
						...primaryRows,
						...(auxSilent
							? []
							: (lsp.diagnose(content) as Array<{ serverId?: string }>).filter(
									(d) => d.serverId === "ast-grep",
								)),
					],
					inconclusive: true,
					inconclusiveServerIds: ["python"],
					inconclusiveReason: reason,
					...(reason === "primary-unavailable" && {
						primaryUnavailableCause: "unstarted",
					}),
					...(!auxSilent && { answeredServerIds: ["ast-grep"] }),
					binding: { boundToCurrentDisk: stale !== true },
				};
			}
			if (lsp.auxGap) {
				const silent = new Set(lsp.auxGap);
				return {
					diags: (lsp.diagnose(content) as Array<{ serverId?: string }>).filter(
						(d) => d.serverId === undefined || !silent.has(d.serverId),
					),
					confirmation: "partial",
					unconfirmedServerIds: [...lsp.auxGap],
				};
			}
			if (lsp.silentAux)
				return {
					diags: [
						{
							severity: 1,
							message:
								"Function returns 'unknown' — parse the value at its boundary",
							code: "no-unknown-returns",
							source: "ast-grep",
							serverId: "ast-grep",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 10 },
							},
						},
					],
					inconclusive: true,
				};
			if (sh.silent && file.endsWith(".sh"))
				return {
					diags: [],
					inconclusive: true,
					inconclusiveServerIds: ["bash"],
				};
			if (ag.cutoff)
				return {
					diags: (lsp.diagnose(content) as Array<{ serverId?: string }>).filter(
						(d) => d.serverId !== "ast-grep",
					),
					inconclusive: true,
					inconclusiveServerIds: ["ast-grep"],
				};
			if (lsp.mode === "inconclusive")
				return {
					diags: [],
					inconclusive: true,
					inconclusiveServerIds: ["typescript"],
				};
			if (lsp.mode === "partial")
				return {
					diags: [
						{
							severity: 2,
							message: "Prefer a const declaration.",
							code: "use-const",
							source: "biome",
							serverId: "biome",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 5 },
							},
						},
					],
					inconclusive: true,
					inconclusiveServerIds: ["typescript"],
				};
			if (lsp.mode === "stale")
				return {
					diags: [
						{
							severity: 1,
							message: "Cannot find name 'BAD_OTHER'.",
							code: 2304,
							source: "ts",
							serverId: "typescript",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 5 },
							},
						},
					],
					confirmation: "confirmed",
					binding: { boundToCurrentDisk: false },
				};
			if (lsp.mode === "throw")
				throw new Error("connection closed: the JSON RPC server exited");
			// Only the dispatch runner's check is held: the turn end's own
			// re-verify touch of a recorded blocker answers, so it never waits
			// out its hook budget on an answer the test has not released.
			if (lsp.mode === "hold" && options?.source === "dispatch-lsp-runner")
				return new Promise((resolve, reject) => {
					lsp.held.push((fail) =>
						fail
							? reject(
									new Error("connection closed: the JSON RPC server exited"),
								)
							: resolve({ diags: lsp.diagnose(content) }),
					);
					lsp.onHold?.();
				});
			return { diags: lsp.diagnose(content) };
		},
	};
	const helm = { stdout: "", lintCalls: 0 };
	const isHelm = (c: string) => /(^|[\\/])helm(\.exe)?$/i.test(c);
	/** Round 8 (P39): shellcheck and the bash server are present too. */
	const isDoubled = (c: string) =>
		isHelm(c) || /(^|[\\/])(shellcheck|bash-language-server)(\.exe)?$/i.test(c);
	/** shellcheck's JSON: SC1072 on each `BAD_SH` line of the named file. */
	function shellcheckJson(file: string, text: string) {
		const items = text.split("\n").flatMap((l, i) =>
			l.includes("BAD_SH")
				? [
						{
							file,
							line: i + 1,
							endLine: i + 1,
							column: 1,
							endColumn: 2,
							level: "error",
							code: 1072,
							message: "Unexpected BAD_SH token",
						},
					]
				: [],
		);
		return {
			stdout: JSON.stringify(items),
			stderr: "",
			status: items.length ? 1 : 0,
		};
	}
	/**
	 * #5788 round 4: a cell's answer for git, given the call's args and cwd. A
	 * returned promise holds an async caller (the complexity adviser's ref
	 * read) until the cell settles it. Unset, git reads as no repository.
	 */
	const git = {
		answer: undefined as
			| ((
					args: readonly string[],
					cwd: string | undefined,
			  ) => SpawnAnswer | Promise<SpawnAnswer>)
			| undefined,
	};
	type SpawnAnswer = { stdout: string; stderr: string; status: number };
	function run(
		command: string,
		args: readonly string[] = [],
		options?: { cwd?: string },
	) {
		if (command === "git" && git.answer !== undefined)
			return git.answer(args, options?.cwd);
		if (/shellcheck/.test(command) && args.includes("--format")) {
			sh.runs += 1;
			const file = args[args.length - 1] ?? "";
			const fs = (
				process as unknown as {
					getBuiltinModule: (m: "node:fs") => typeof import("node:fs");
				}
			).getBuiltinModule("node:fs");
			return shellcheckJson(
				file,
				fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "",
			);
		}
		// The fixture's `.git` is an empty directory, which real git answers with
		// "not a git repository" (the commit gate's staged-delta read, #5553).
		if (command === "git")
			return { stdout: "", stderr: "fatal: not a git repository", status: 128 };
		// Version and gate probes of the other doubled binaries succeed.
		if (isDoubled(command) && !isHelm(command))
			return { stdout: "version: 0.10.0", stderr: "", status: 0 };
		if (!isHelm(command))
			return {
				stdout: "",
				stderr: "command not found",
				status: 127,
				failure: "spawn" as const,
				spawnFailure: { kind: "tool-not-found" as const },
			};
		if (args[0] === "lint") {
			helm.lintCalls += 1;
			return {
				stdout: helm.stdout,
				stderr: helm.stdout
					? "Error: 1 chart(s) linted, 1 chart(s) failed"
					: "",
				status: helm.stdout ? 1 : 0,
			};
		}
		return {
			stdout: 'version.BuildInfo{Version:"v3.16.2"}',
			stderr: "",
			status: 0,
		};
	}
	return { lsp, helm, isHelm, isDoubled, run, ag, sh, git };
});

vi.mock("../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/safe-spawn.js")>()),
	safeSpawn: boundary.run,
	safeSpawnAsync: async (
		command: string,
		args: readonly string[] = [],
		options?: { cwd?: string },
	) => boundary.run(command, args, options),
	isCommandAvailableAsync: async (command: string) =>
		boundary.isDoubled(command),
	findCommandAsync: async (command: string) =>
		boundary.isDoubled(command) ? command : null,
}));

import extension from "../index.js";
import {
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../clients/dispatch/collect-later-tier.js";
import {
	peekSettledRunnerFindings,
	resetPendingRunnerFindings,
	settlePendingRunnerFindingsForTests,
} from "../clients/dispatch/pending-runner-findings.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { CacheManager } from "../clients/cache-manager.js";
import {
	forgetCascadePendingNeighbor,
	listCascadePendingNeighbors,
	recordDeliveredCascadeNeighbor,
} from "../clients/cascade-format.js";
import { getDegradationSummary } from "../clients/degradation-ledger.js";
import { exportWidgetState } from "../clients/widget-state.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { useGlobalConfig } from "./support/global-config.js";
import { installLspServiceDouble } from "./support/lsp-service-seam.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";

let tmpDir = "";
let pendingCleanup: (() => Promise<void>) | undefined;
const originalTestMode = process.env.PI_LENS_TEST_MODE;

beforeAll(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4484-witness-")),
	);
});
afterAll(() => removeTempDirSync(tmpDir));
/** The shared double this cell runs against (`beforeEach`). */
let lspDouble: Record<string, unknown>;
beforeEach(async () => {
	lspDouble = await installLspServiceDouble({
		supportsLSP: () => boundary.lsp.enabled,
		hasLSP: async () => boundary.lsp.enabled,
		touchFile: boundary.lsp.touch,
		hasServerPublishedForFileRoot: async (serverId: string) =>
			serverId === "ast-grep" && boundary.ag.published,
	});
	process.env.PI_LENS_TEST_MODE = "0";
	boundary.lsp.enabled = false;
	boundary.lsp.touches = 0;
	boundary.lsp.mode = "answer";
	boundary.lsp.code = 2304;
	boundary.lsp.auxGap = undefined;
	boundary.lsp.silentAux = false;
	boundary.lsp.primarySilent = undefined;
	boundary.helm.stdout = "";
	boundary.helm.lintCalls = 0;
	boundary.ag.published = false;
	boundary.ag.diag = false;
	boundary.ag.cutoff = false;
	boundary.ag.other = 0;
	boundary.sh.silent = false;
});
afterEach(async () => {
	// A cell that failed before its own fix still leaves no record, gate
	// state or persisted guard record for the next cell (shuffle-safe).
	const cleanup = pendingCleanup;
	pendingCleanup = undefined;
	boundary.lsp.mode = "answer";
	boundary.lsp.code = 2304;
	boundary.lsp.auxGap = undefined;
	boundary.lsp.silentAux = false;
	boundary.lsp.primarySilent = undefined;
	boundary.lsp.onHold = undefined;
	boundary.git.answer = undefined;
	for (const release of boundary.lsp.held.splice(0)) release();
	resetObservedRunnerLatency();
	// #5146: end the cell's session once its held boundaries are released.
	await endMockSessions();
	if (cleanup) await cleanup().catch(() => {});
	boundary.ag.published = false;
	boundary.ag.diag = false;
	boundary.ag.cutoff = false;
	boundary.ag.other = 0;
	boundary.sh.silent = false;
	resetPendingRunnerFindings();
	if (originalTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = originalTestMode;
});

type Tool = {
	execute: (...a: unknown[]) => Promise<{ content?: Array<{ text?: string }> }>;
};

const scrub = (s: string) =>
	s
		.replaceAll(tmpDir, "<PROJECT>")
		.replace(/·\s*\d+ms/g, "· <MS>ms")
		.trim();

/**
 * The CLI spelling that retires the ast-grep auxiliary server, applied after
 * the factory as pi applies it (#4944: the flag was unregistered, so the old
 * double only appeared to honor it). The napi-only cells pass it so the
 * runner under test is the per-edit one, not the substitute for a server.
 */
const AST_GREP_OFF = { "no-ast-grep": true };

/** One host session over one file, through the registered handlers. */
async function openSession(
	name: string,
	file: string,
	fixed: string,
	config: Record<string, unknown> = {},
	afterFactory: Record<string, boolean | string> = {},
) {
	setGlobalConfig({ guard: { enabled: true }, ...config });
	const pi = createPiMock();
	extension(pi.asExtensionAPI());
	for (const [flag, value] of Object.entries(afterFactory))
		pi.setFlag(flag, value);
	const ctx = () => makeCtx({ cwd: tmpDir });
	await pi.emit(
		"session_start",
		makeSessionStartEvent(),
		makeCtx({ cwd: tmpDir, sessionId: `pi-lens-4484-${name}` }),
	);
	await pi.emit("turn_start", {}, ctx());
	const target = path.join(tmpDir, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	let helmAfter: string | undefined;
	const session = {
		target,
		/** #5788 C4: the host replaces this session with another (`/new`). */
		async replace(sessionId: string): Promise<void> {
			await pi.emit(
				"session_shutdown",
				{ type: "session_shutdown", reason: "new" },
				makeCtx({ cwd: tmpDir, sessionId: `pi-lens-4484-${name}` }),
			);
			await pi.emit(
				"session_start",
				makeSessionStartEvent({ reason: "new" }),
				makeCtx({ cwd: tmpDir, sessionId }),
			);
			await pi.emit("turn_start", {}, ctx());
		},
		/** Round 8 (P39): flip a host flag mid-session. */
		setFlag(flag: string, value: boolean) {
			pi.setFlag(flag, value);
		},
		/** The next write's helm stdout (helm cells only). */
		helmNext(stdout: string) {
			helmAfter = stdout;
		},
		async write(content: string): Promise<string> {
			fs.writeFileSync(target, content);
			if (helmAfter !== undefined) boundary.helm.stdout = helmAfter;
			const r = (await pi.emit(
				"tool_result",
				{
					toolName: "write",
					input: { path: target, content },
					content: [{ type: "text", text: "wrote" }],
				},
				ctx(),
			)) as { content?: Array<{ text?: string }> } | undefined;
			return scrub((r?.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		/** Round 4 (P18): a host `write` of another file in the same session. */
		async writeOther(file: string, content: string): Promise<void> {
			const other = path.join(tmpDir, file);
			fs.mkdirSync(path.dirname(other), { recursive: true });
			fs.writeFileSync(other, content);
			await pi.emit(
				"tool_result",
				{
					toolName: "write",
					input: { path: other, content },
					content: [{ type: "text", text: "wrote" }],
				},
				ctx(),
			);
		},
		/** A host `edit` that changed `lines` (1-based), as its diff names them. */
		async edit(content: string, lines: number[]): Promise<string> {
			fs.writeFileSync(target, content);
			const after = content.split("\n");
			const r = (await pi.emit(
				"tool_result",
				{
					toolName: "edit",
					input: { path: target },
					details: {
						diff: lines.map((n) => `+ ${n} ${after[n - 1] ?? ""}`).join("\n"),
					},
					content: [{ type: "text", text: "edited" }],
				},
				ctx(),
			)) as { content?: Array<{ text?: string }> } | undefined;
			return scrub((r?.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		/**
		 * #5784: a host `bash` call that rewrote the file through a script the
		 * parser cannot credit, so its synthetic write runs without authorship
		 * and ends with the withheld line, not the STOP block.
		 */
		async bash(content: string, command: string): Promise<string> {
			fs.writeFileSync(target, content);
			const r = (await pi.emit(
				"tool_result",
				{
					toolName: "bash",
					input: { command },
					content: [{ type: "text", text: "" }],
				},
				ctx(),
			)) as { content?: Array<{ text?: string }> } | undefined;
			return scrub((r?.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		/** #5790 r3: the commit gate's refusal text, or "" when it admits. */
		async commitReason(): Promise<string> {
			const v = ((await pi.emit(
				"tool_call",
				{ toolName: "bash", input: { command: 'git commit -m "wip"' } },
				ctx(),
			)) ?? {}) as { block?: boolean; reason?: string };
			return v.block === true ? scrub(v.reason ?? "") : "";
		},
		/** #5790 r3: the `source=lsp` probe of another file of the project. */
		async settleOther(file: string): Promise<string> {
			const lens = pi.tools.get("lens_diagnostics") as Tool;
			const out = await lens.execute(
				"zz-settle-other",
				{ source: "lsp", waitMs: 30000, path: path.join(tmpDir, file) },
				undefined,
				null,
				{ cwd: tmpDir },
			);
			return scrub((out.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		async commitBlocked(): Promise<boolean> {
			const v = ((await pi.emit(
				"tool_call",
				{ toolName: "bash", input: { command: 'git commit -m "wip"' } },
				ctx(),
			)) ?? {}) as { block?: boolean };
			return v.block === true;
		},
		/** End the turn and return the context message it injects. */
		async endTurn(): Promise<string> {
			await pi.emit("turn_end", {}, ctx());
			const injected = (await pi.emit(
				"context_with_system",
				makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
				ctx(),
			)) as { messages?: Array<{ content: string }> } | undefined;
			await pi.emit("turn_start", {}, ctx());
			return scrub(
				(injected?.messages ?? []).map((m) => m.content).join("\n\n"),
			);
		},
		/** `sessionId`: the read of another session on this activation (#5788 N3). */
		async sessionDiagnostics(sessionId?: string): Promise<string> {
			const lens = pi.tools.get("lens_diagnostics") as Tool;
			const out = await lens.execute(
				`zz-${name}`,
				{ source: "session", mode: "all" },
				undefined,
				null,
				sessionId === undefined
					? { cwd: tmpDir }
					: makeCtx({ cwd: tmpDir, sessionId }),
			);
			return scrub((out.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		/** The session read's text and its `details` (#5788 round 4). */
		async sessionReport(): Promise<{
			text: string;
			details: { clean?: boolean };
		}> {
			const lens = pi.tools.get("lens_diagnostics") as Tool;
			const out = (await lens.execute(
				`zz-report-${name}`,
				{ source: "session", mode: "all" },
				undefined,
				null,
				{ cwd: tmpDir },
			)) as {
				content?: Array<{ text?: string }>;
				details?: { clean?: boolean };
			};
			return {
				text: scrub((out.content ?? []).map((p) => p.text ?? "").join("\n")),
				details: out.details ?? {},
			};
		},
		/** A host event with a call id the cell chooses (tool_call, tool_result). */
		async emit(
			kind: string,
			payload: Record<string, unknown>,
		): Promise<string> {
			const r = (await pi.emit(kind, payload, ctx())) as
				| { content?: Array<{ text?: string }> }
				| undefined;
			return scrub((r?.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		/** The agent's `lens_diagnostic_mark` call on this file. */
		async mark(params: Record<string, unknown>): Promise<string> {
			const tool = pi.tools.get("lens_diagnostic_mark") as Tool;
			const out = await tool.execute(
				`zz-mark-${name}`,
				{ ...params, path: target },
				undefined,
				null,
				{ cwd: tmpDir },
			);
			return scrub((out.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		/** #5784: the call the no-verdict sentence names, on this file. */
		async settleCall(params: Record<string, unknown>): Promise<string> {
			const lens = pi.tools.get("lens_diagnostics") as Tool;
			const out = await lens.execute(
				`zz-settle-${name}`,
				{ ...params, path: target },
				undefined,
				null,
				{ cwd: tmpDir },
			);
			return scrub((out.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		widgetBlocking(): number {
			return exportWidgetState()
				.files.filter((f) => path.resolve(f.filePath) === target)
				.reduce((n, f) => n + (f.diagnosticCounts?.blocking ?? 0), 0);
		},
	};
	pendingCleanup = async () => {
		helmAfter = "";
		await session.write(fixed);
		await session.endTurn();
	};
	return session;
}

const V1 = "const a = 1;\nBAD_CALL();\nconst b = 2;\n";
/** V1's blocker line rewritten: same error, different bytes, so its old line
 *  hash no longer describes these bytes. */
const V1_LINE_REWRITTEN = "const a = 1;\nBAD_CALL(1);\nconst b = 2;\n";
const V1_LINE_REWRITTEN_OTHER_LINE =
	"const a = 1;\nBAD_CALL(1);\nconst b = 5;\n";
const V2_OTHER_LINE = "const a = 1;\nBAD_CALL();\nconst b = 3;\n";
const V2_INSERT_ABOVE =
	"const z = 0;\nconst a = 1;\nBAD_CALL();\nconst b = 2;\n";
const V_FIXED = "const a = 1;\nconst b = 2;\n";
const V_FIXED_OTHER = "const a = 1;\nconst b = 4;\n";

const STILL_UNFIXED = /Still unfixed: 1 blocker reported earlier \(L(\d+)\b/;

/** Cleanup: fix the file and drain the turn, so the next cell starts clean. */
async function fixAndDrain(s: Awaited<ReturnType<typeof openSession>>) {
	const cleanup = pendingCleanup;
	pendingCleanup = undefined;
	await cleanup?.();
	expect(await s.commitBlocked()).toBe(false);
}

/** Round 8: each runner's row in the file's last dispatch record. */
async function lastRunnerRows(
	file: string,
): Promise<Record<string, { status?: string }>> {
	await flushLatencyLog();
	const target = path.join(tmpDir, file);
	const read = readNdjsonRows<{
		filePath?: string;
		metadata?: {
			runners?: Array<{ id: string; status?: string; skipReason?: string }>;
		};
	}>(getLatencyLogPath());
	// A torn write would drop the record this witness reads: red with the count.
	expect(read.skipped).toBe(0);
	// The row is the file's LAST one that CARRIES a runners table: a later row
	// for the same file (a turn_end, a review row) has none, and taking it would
	// report `{}` as the answer.
	const row = read.rows
		.filter((r) => r.filePath === target && r.metadata?.runners !== undefined)
		.at(-1);
	return Object.fromEntries(
		(row?.metadata?.runners ?? []).map((r) => [r.id, r]),
	);
}

/**
 * The ledger rows of one kind, read back from the real latency.log sink
 * (shape 67: the sink is flushed first, with no other await in between).
 */
async function degradationRows(
	kind: string,
): Promise<Record<string, unknown>[]> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	// The ledger rows ARE the trace under test; a skipped line would shorten it.
	expect(read.skipped).toBe(0);
	return read.rows.flatMap((row) => {
		const metadata = row.metadata as Record<string, unknown> | undefined;
		return row.phase === "degradation_ledger" &&
			metadata?.kind === kind &&
			metadata !== undefined
			? [metadata]
			: [];
	});
}

const setGlobalConfig = useGlobalConfig();

describe("#4484 witness: a repeat write keeps an unfixed blocker pending", () => {
	it("keeps an LSP error that write 2 left in place blocking on every surface (cell A)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("a", "src/cell-a.ts", V_FIXED);
		const w1 = await s.write(V1);
		expect(w1).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(await s.commitBlocked()).toBe(true);

		const latencyLog = getLatencyLogPath();
		await flushLatencyLog();
		const offset = fs.existsSync(latencyLog) ? fs.statSync(latencyLog).size : 0;
		const w2 = await s.write(V2_OTHER_LINE);
		// The write tells the agent the old blocker is still there, in one line,
		// and never says clean.
		expect(w2).not.toMatch(/clean/);
		expect(w2).not.toContain("🔴 STOP");
		expect(w2).toMatch(STILL_UNFIXED);
		expect(w2.match(STILL_UNFIXED)?.[1]).toBe("2");
		expect(await s.commitBlocked()).toBe(true);
		// The dispatch's own record says one blocker was held back by the delta.
		await flushLatencyLog();
		const read = readNdjsonRows(latencyLog, offset);
		// The offset is a byte count, so the reader slices the bytes before
		// decoding: a multi-byte character earlier in the log (an emoji in a
		// message) moves a character index off the row boundary (review F3, seed
		// 202). A skipped line would lower the count below, so it is a red.
		expect(read.skipped).toBe(0);
		const rows = read.rows.filter(
			(row) =>
				row.result === "dispatch_complete" &&
				String(row.filePath).endsWith("cell-a.ts"),
		);
		expect(
			rows.map(
				(row) => (row.metadata as Record<string, unknown>).heldBackBlockers,
			),
		).toEqual([1]);

		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("Unresolved from this turn — src/cell-a.ts:");
		expect(turnEnd).toContain("L2: Cannot find name 'BAD_CALL'.");
		expect(turnEnd).not.toContain("Resolved this turn");
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.sessionDiagnostics()).toContain(
			"L2: Cannot find name 'BAD_CALL'.",
		);
		expect(s.widgetBlocking()).toBe(1);
		await fixAndDrain(s);
	}, 120_000);

	it("still reports a write that removes the error as resolved and opens the gate (cell C)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("c", "src/cell-c.ts", V_FIXED);
		await s.write(V1);
		expect(await s.commitBlocked()).toBe(true);
		const w2 = await s.write(V_FIXED);
		expect(w2).toContain("✓ JavaScript/TypeScript clean");
		expect(await s.commitBlocked()).toBe(false);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain(
			"Resolved this turn: src/cell-c.ts (1 blocker(s) cleared by the 2nd write)",
		);
		expect(turnEnd).not.toContain("Unresolved");
		expect(await s.sessionDiagnostics()).not.toContain("src/cell-c.ts");
		expect(s.widgetBlocking()).toBe(0);
	}, 120_000);

	it("re-blocks an LSP error moved by a line inserted above it as new (cell B, unchanged)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("b", "src/cell-b.ts", V_FIXED);
		await s.write(V1);
		const w2 = await s.write(V2_INSERT_ABOVE);
		expect(w2).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(w2).toContain("L3: Cannot find name 'BAD_CALL'.");
		expect(w2).not.toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("L3: Cannot find name 'BAD_CALL'.");
		await fixAndDrain(s);
	}, 120_000);

	it("keeps the error pending when write 2 comes in the next turn (cell I, cross-turn)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("i", "src/cell-i.ts", V_FIXED);
		const blockerSection = "Unresolved from this turn — src/cell-i.ts";
		await s.write(V1);
		expect(await s.endTurn()).toContain(blockerSection);
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).not.toMatch(/clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		// #4921: the unchanged error was delivered at the first turn end and is
		// not sent again; it is still held, which the gate and the session store
		// say. The reply is not asserted empty: in some shuffle orders a cascade
		// budget advisory (a scan count left by a sibling cell) joins this turn's
		// message, the content is then new, and the whole of it is sent, blocker
		// included. That is the content-keyed dedupe working as designed (an
		// accepted residual in the PR), so the blocker is asserted absent only
		// while the message gained nothing else.
		if (!/cascade budget was exhausted/.test(turnEnd))
			expect(turnEnd).not.toContain(blockerSection);
		expect(await s.sessionDiagnostics()).toContain("src/cell-i.ts");
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);

	it("re-delivers the error under --no-delta, before and after the fix (cell K)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("k", "src/cell-k.ts", V_FIXED, {
			delta: { enabled: false },
		});
		await s.write(V1);
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(w2).not.toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).toContain("Unresolved from this turn");
		await fixAndDrain(s);
	}, 120_000);

	describe("a linter with ordinal ids (helm-lint)", () => {
		const chart = () => {
			fs.mkdirSync(path.join(tmpDir, "chart", "templates"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(tmpDir, "chart", "Chart.yaml"),
				"apiVersion: v2\nname: witness\nversion: 0.1.0\n",
			);
			fs.writeFileSync(
				path.join(tmpDir, "chart", "values.yaml"),
				"replicas: 2\n",
			);
		};
		const lint = (...lines: string[]) =>
			["==> Linting .", ...lines.map((l) => `[ERROR] templates/${l}`)].join(
				"\n",
			);
		const T1 =
			"apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: {{ .Values.replicas }}\n  paused: false\n";
		const T2 = T1.replace("paused: false", "paused: true");

		it("keeps a helm blocker that write 2 left in place, and after a line shift (cells F and H)", async () => {
			chart();
			const s = await openSession("f", "chart/templates/deploy-f.yaml", T2, {
				lsp: { enabled: false },
			});
			const e4 = lint(
				"deploy-f.yaml:4: nil pointer evaluating interface {}.image",
			);
			s.helmNext(e4);
			expect(await s.write(T1)).toContain("🔴 STOP");
			s.helmNext(e4);
			const w2 = await s.write(T2);
			expect(w2).not.toMatch(/clean/);
			expect(w2.match(STILL_UNFIXED)?.[1]).toBe("4");
			expect(await s.commitBlocked()).toBe(true);
			// A line inserted above: the ordinal id stays, the line moves to 5.
			s.helmNext(
				lint("deploy-f.yaml:5: nil pointer evaluating interface {}.image"),
			);
			const w3 = await s.write(`# note\n${T2}`);
			expect(w3).not.toMatch(/clean/);
			expect(w3.match(STILL_UNFIXED)?.[1]).toBe("5");
			const turnEnd = await s.endTurn();
			expect(turnEnd).toContain(
				"Unresolved from this turn — chart/templates/deploy-f.yaml:",
			);
			expect(turnEnd).toContain("deploy-f.yaml:5: nil pointer");
			expect(turnEnd).not.toContain("Resolved this turn");
			expect(await s.commitBlocked()).toBe(true);
			expect(s.widgetBlocking()).toBe(1);
			await fixAndDrain(s);
		}, 120_000);

		it("keeps the later helm blocker when fixing the earlier one renumbers it (cell R)", async () => {
			chart();
			const s = await openSession("r", "chart/templates/deploy-r.yaml", T2, {
				lsp: { enabled: false },
			});
			s.helmNext(
				lint(
					"deploy-r.yaml:2: unknown field kind",
					"deploy-r.yaml:4: nil pointer evaluating interface {}.image",
				),
			);
			expect(await s.write(T1)).toContain(
				"🔴 STOP — 2 issue(s) must be fixed:",
			);
			// Fix the first: the second takes its ordinal id.
			s.helmNext(
				lint("deploy-r.yaml:4: nil pointer evaluating interface {}.image"),
			);
			const w2 = await s.write(T2);
			expect(w2).not.toMatch(/clean/);
			expect(w2.match(STILL_UNFIXED)?.[1]).toBe("4");
			expect(await s.commitBlocked()).toBe(true);
			const turnEnd = await s.endTurn();
			expect(turnEnd).toContain("deploy-r.yaml:4: nil pointer");
			expect(turnEnd).not.toContain("unknown field kind");
			expect(turnEnd).not.toContain("Resolved this turn");
			await fixAndDrain(s);
		}, 120_000);
	});
});

/**
 * Round 2 (#4484): a recorded blocker leaves the record only when a
 * conclusive observation from its own source shows it gone. Rows refer to
 * the state table at the top of PR #4491.
 */
describe("#4484 witness, round 2: only evidence retires a recorded blocker", () => {
	/** `no-unknown-returns` (ast-grep, severity error) on line 3 (#4482's shape). */
	const AST_GREP_SRC = [
		'export const CLIENT_VERSION = "1.0.50";',
		"export const plain = CLIENT_VERSION;",
		"export function dig(obj: Record<string, string>, key: string): unknown {",
		"\treturn obj[key];",
		"}",
		"",
	].join("\n");
	const AST_GREP_EDITED = AST_GREP_SRC.replace("1.0.50", "1.0.51");
	const AST_GREP_FIXED = AST_GREP_SRC.replace("): unknown {", "): string {");
	/** `debugger-statement` (tree-sitter, severity error) on line 2. */
	const TS_SRC =
		"export function run(): void {\n\tdebugger;\n}\nexport const a = 1;\n";
	const TS_EDITED = TS_SRC.replace("a = 1", "a = 2");
	const TS_FIXED = "export function run(): void {}\nexport const a = 1;\n";
	const SCOPED = { lsp: { enabled: false } };

	// Recurrence: since #4482 the ast-grep runner drops a blocker on a line the
	// edit did not change, so an edit elsewhere emptied the observation and the
	// record cleared (TLC MutRangeGated).
	it("keeps an ast-grep blocker pending after an edit to another line (row 7)", async () => {
		const s = await openSession(
			"sa",
			"src/scope-ag.ts",
			AST_GREP_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		const w1 = await s.write(AST_GREP_SRC);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("no-unknown-returns");
		expect(await s.commitBlocked()).toBe(true);
		const w2 = await s.edit(AST_GREP_EDITED, [1]);
		expect(w2).not.toMatch(/clean/);
		expect(w2).not.toContain("🔴 STOP");
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L3\b/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("Unresolved from this turn — src/scope-ag.ts:");
		expect(turnEnd).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence: tree-sitter's edit-range gate did the same before #4482.
	it("keeps a tree-sitter blocker pending after an edit to another line (row 7)", async () => {
		const s = await openSession(
			"st",
			"src/scope-ts.ts",
			TS_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		const w1 = await s.write(TS_SRC);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("debugger");
		const w2 = await s.edit(TS_EDITED, [4]);
		expect(w2).not.toMatch(/clean/);
		expect(w2).not.toContain("🔴 STOP");
		expect(w2).toMatch(/Still unfixed: \d+ blockers? reported earlier \(L2\b/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("Unresolved from this turn — src/scope-ts.ts:");
		await fixAndDrain(s);
	}, 120_000);

	// Control (#4481 kept): a pre-existing finding on a line the agent never
	// touched is observed, not delivered, and never enters the record.
	it("does not block on a pre-existing ast-grep finding outside the first edit (row 8)", async () => {
		const file = "src/scope-pre.ts";
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, file), AST_GREP_SRC);
		const s = await openSession(
			"sp",
			file,
			AST_GREP_EDITED,
			SCOPED,
			AST_GREP_OFF,
		);
		const w1 = await s.edit(AST_GREP_EDITED, [1]);
		expect(w1).not.toContain("🔴 STOP");
		expect(w1).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).not.toContain("Unresolved from this turn");
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence: a run with no verdict read as an empty, clean observation
	// (TLC MutFailClear).
	it("keeps an LSP error pending when the server does not answer the next write (row 10)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("xt", "src/carry-timeout.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		// The carry of an unobserved blocker is counted once per file.
		expect(
			getDegradationSummary().find(
				(c) => c.kind === "blocker-carried-unobserved",
			)?.latestReasons,
		).toContainEqual(
			expect.objectContaining({
				subject: expect.stringContaining("carry-timeout.ts"),
			}),
		);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain(
			"Unresolved from this turn — src/carry-timeout.ts:",
		);
		expect(turnEnd).not.toContain("Resolved this turn");
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	// #4597 read-back: `blocker-position-unaligned` (clients/pipeline.ts) is the
	// record that says a kept blocker has no place in these bytes. It landed
	// unasserted, so its rename or removal would have left every cell here green
	// while a stale line number read as "no verdict".
	it("counts a recorded blocker it cannot place in the write's bytes", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("ul", "src/unalign.ts", V_FIXED);
		// The ledger is the file's process-global sink, and a sibling cell's own
		// file may already hold this kind: only this cell's subject is read. The
		// record's name is handed to the assertion, so the #4597 read-back is a
		// comparison this test makes (#4597 r2 F1).
		const unalignedRows = async (kind: string) =>
			(await degradationRows(kind)).filter((row) =>
				String(row.subject ?? "").includes("unalign.ts"),
			);
		expect(await s.write(V1)).toContain("🔴 STOP");
		// The server stops answering, and the blocker's own line is rewritten:
		// the alignment cannot place it, so this write marks the record stale
		// instead of counting it as unplaced yet.
		boundary.lsp.mode = "inconclusive";
		expect(await s.edit(V1_LINE_REWRITTEN, [2])).toContain(
			"Still unfixed: 1 blocker reported earlier",
		);
		expect(await unalignedRows("blocker-position-unaligned")).toEqual([]);
		// The next write has nothing to place that stale record against. #5784:
		// the same unconfirmed blocker again, so its line is held back, and no
		// all-clear stands in for it; the commit gate still holds it.
		const w3 = await s.write(V1_LINE_REWRITTEN_OTHER_LINE);
		expect(w3).not.toContain("Still unfixed");
		expect(w3).not.toMatch(/clean/);
		expect(await s.commitBlocked()).toBe(true);
		expect(await unalignedRows("blocker-position-unaligned")).toContainEqual(
			expect.objectContaining({ count: 1 }),
		);
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	it("keeps an LSP error pending when the server fails on the next write (row 10)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("xf", "src/carry-fail.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "throw";
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence: a run that answered for one server read as a verdict for
	// every server, so the silent server's recorded error left the record.
	it("keeps an LSP error pending when its own server is unconfirmed while another answers (row 10)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("xp", "src/carry-partial.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "partial";
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	// #5017 recurrence: the server answered with findings it computed for older
	// bytes (`boundToCurrentDisk: false`). The run read as a verdict, so the
	// recorded BAD_CALL, still on disk, left the record and the gate opened on a
	// finding about other bytes. The stale row is not these bytes' either, so it
	// never enters the record.
	it("keeps a blocker pending when the server's findings are about older bytes (#5017)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("stale", "src/carry-stale.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "stale";
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(w2).not.toContain("BAD_OTHER");
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence: TLC MutDeferredInFlight. A write cleared the record while the
	// blocker's own re-check ran collect-later, and turn end called it resolved.
	it("keeps a blocker pending while its collect-later re-check runs, and retires it only when a current run settles clean (rows 12, 14)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("dl", "src/carry-deferred.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		// The language server is now slow: its next runs leave the write path.
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "lsp",
			durationMs: 6_000,
		});
		boundary.lsp.mode = "hold";
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain(
			"Unresolved from this turn — src/carry-deferred.ts:",
		);
		expect(turnEnd).not.toContain("Resolved this turn");
		// The fix lands while the server is still slow: nothing has seen it yet.
		await s.write(V_FIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		// Both held runs answer; only the one about the current bytes counts.
		// Coalescing starts the queued rerun only once the first run settles, so
		// release the first, let the rerun start and hold, then release it.
		for (const release of boundary.lsp.held.splice(0)) release();
		for (let i = 0; i < 5; i++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		expect(boundary.lsp.held).toHaveLength(1);
		for (const release of boundary.lsp.held.splice(0)) release();
		await settlePendingRunnerFindingsForTests();
		expect(peekSettledRunnerFindings().length).toBeGreaterThanOrEqual(2);
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).toMatch(
			/Resolved this turn: src\/carry-deferred\.ts/,
		);
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence: a settled re-check that failed is no evidence, yet an empty
	// failed answer would read as "E gone"; and with no commit before turn end,
	// only the turn end's late lane can retire the blocker.
	it("retires nothing on a failed collect-later re-check, and retires at turn end on a clean one (rows 10, 14)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("df", "src/carry-deferred-fail.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "lsp",
			durationMs: 6_000,
		});
		boundary.lsp.mode = "hold";
		await s.write(V_FIXED);
		for (const release of boundary.lsp.held.splice(0)) release(true);
		await settlePendingRunnerFindingsForTests();
		expect(peekSettledRunnerFindings().length).toBeGreaterThanOrEqual(1);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		// A clean re-check of the current bytes settles; no commit asks first.
		// The quick failure moved the server back inline, so slow it again.
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "lsp",
			durationMs: 6_000,
		});
		await s.write(V_FIXED_OTHER);
		for (const release of boundary.lsp.held.splice(0)) release();
		await settlePendingRunnerFindingsForTests();
		expect(peekSettledRunnerFindings().length).toBeGreaterThanOrEqual(1);
		expect(await s.endTurn()).toMatch(
			/Resolved this turn: src\/carry-deferred-fail\.ts/,
		);
		expect(await s.commitBlocked()).toBe(false);
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence: an unused value blocks only while the delta calls it new, so
	// the next unrelated write dropped it from the record as if fixed (TLC
	// MutPromotedClear).
	it("keeps a delta-promoted unused value blocking on the next unrelated write (row 16)", async () => {
		boundary.lsp.enabled = true;
		const U1 = "const a = 1;\nconst unusedVar = 2;\nconst b = 2;\n";
		const U2 = "const a = 1;\nconst unusedVar = 2;\nconst b = 3;\n";
		const s = await openSession("un", "src/carry-unused.ts", V_FIXED);
		// The delta promotes only against a baseline, so the file exists first.
		await s.write(V_FIXED);
		const w1 = await s.write(U1);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("unusedVar");
		const w2 = await s.write(U2);
		expect(w2).not.toMatch(/clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 120_000);
});

/**
 * Round 3 (#4484): rows refer to the round-3 state table at the top of PR
 * #4491. R1: a run has a verdict only when it read the file and finished.
 * R2: a recorded blocker's position is its line aligned to the current bytes.
 * R3: it stays only while its source has no verdict, or a verdict saw its
 * identity at its position. R4: lines a no-verdict run owed join the next
 * run's range.
 */
describe("#4484 witness, round 3: position, verdict and owed lines", () => {
	const SCOPED = { lsp: { enabled: false } };
	const AG_PRE = [
		'export const CLIENT_VERSION = "1.0.50";',
		"export const plain = CLIENT_VERSION;",
		"export function dig(obj: Record<string, string>, key: string): unknown {",
		"\treturn obj[key];",
		"}",
		"",
	].join("\n");
	const AG_TWIN = `${AG_PRE}export function dig2(obj: Record<string, string>, key: string): unknown {\n\treturn obj[key];\n}\n`;
	const AG_TWIN_FIXED = AG_TWIN.replace(
		"dig2(obj: Record<string, string>, key: string): unknown",
		"dig2(obj: Record<string, string>, key: string): string",
	);
	const TS_PRE =
		"export function run(): void {\n\tdebugger;\n}\nexport const a = 1;\n";
	const TS_TWIN = `${TS_PRE}export function run2(): void {\n\tdebugger;\n}\n`;
	const TS_TWIN_FIXED = `${TS_PRE}export function run2(): void {\n\treturn;\n}\n`;

	// Recurrence (F1, review probe P9): the carry matched on identity alone, so
	// a pre-existing, never-delivered match of the same rule outside the edit
	// stood in for the blocker the edit fixed. The gate stayed shut on L3, a
	// line the agent never touched (TLC MutTwinIdentity).
	it("retires a fixed ast-grep blocker beside an untouched match of the same rule (row 6)", async () => {
		const file = "src/twin-ag.ts";
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, file), AG_PRE);
		const s = await openSession("ta", file, AG_PRE, SCOPED, AST_GREP_OFF);
		const w1 = await s.edit(AG_TWIN, [6, 7, 8]);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("L6:");
		expect(await s.commitBlocked()).toBe(true);
		const w2 = await s.edit(AG_TWIN_FIXED, [6]);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(w2).not.toContain("🔴 STOP");
		expect(await s.commitBlocked()).toBe(false);
		const turnEnd = await s.endTurn();
		expect(turnEnd).not.toContain("Unresolved from this turn");
		expect(turnEnd).toMatch(/Resolved this turn: src\/twin-ag\.ts/);
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence (F1, review probe P10): the same stand-in through tree-sitter.
	it("retires a fixed tree-sitter blocker beside an untouched match of the same rule (row 6)", async () => {
		const file = "src/twin-ts.ts";
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, file), TS_PRE);
		const s = await openSession("tt", file, TS_PRE, SCOPED, AST_GREP_OFF);
		const w1 = await s.edit(TS_TWIN, [5, 6, 7]);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("L6:");
		const w2 = await s.edit(TS_TWIN_FIXED, [6]);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(w2).not.toContain("🔴 STOP");
		expect(await s.commitBlocked()).toBe(false);
		const turnEnd = await s.endTurn();
		expect(turnEnd).not.toContain("Unresolved from this turn");
		pendingCleanup = undefined;
	}, 120_000);

	// Control (row 7): the recorded blocker's own line, moved by an edit above
	// it, still holds the match; the other occurrence never enters the record.
	it("keeps a recorded ast-grep blocker at its own moved line, and only that one (row 7)", async () => {
		const file = "src/twin-move.ts";
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, file), AG_PRE);
		const s = await openSession("tm", file, AG_PRE, SCOPED, AST_GREP_OFF);
		expect(await s.edit(AG_TWIN, [6, 7, 8])).toContain("🔴 STOP");
		const moved = `// header\n${AG_TWIN}`;
		const w2 = await s.edit(moved, [1]);
		expect(w2).not.toContain("🔴 STOP");
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L7\b/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("L7:");
		expect(turnEnd).not.toContain("L4:");
		pendingCleanup = async () => {
			await s.write(moved.replaceAll("): unknown {", "): string {"));
			await s.endTurn();
		};
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (row 12, R3): a blocker carried while its server had no verdict
	// kept its recorded line after an edit above it, so the write and turn end
	// named a line the error was no longer on.
	it("moves a carried LSP error with its line while the server does not answer (row 12)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("cm", "src/carry-move.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		const w2 = await s.write(V2_INSERT_ABOVE);
		expect(w2.match(STILL_UNFIXED)?.[1]).toBe("3");
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("L3:");
		expect(turnEnd).not.toContain("L2:");
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (F2, review probe P1): a skip that never read the file counted
	// as a verdict. Past the LSP sync limit the runner skips without touching
	// the server, and the record retired while BAD_CALL was on disk (TLC
	// MutSkipVerdict).
	it("keeps an LSP error pending when the file outgrows the language server's sync limit (row 11)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("sl", "src/skip-lsp.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		const touches = boundary.lsp.touches;
		const big = `${V1}${"const pad = 0;\n".repeat(5_100)}`;
		const w2 = await s.write(big);
		expect(boundary.lsp.touches).toBe(touches);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (F2, review probe P2): the ast-grep runner skips a file over
	// 1 MiB without reading it, and the edit said clean.
	it("keeps an ast-grep blocker pending when the file outgrows the runner's size cap (row 11)", async () => {
		const s = await openSession(
			"sg",
			"src/skip-ag.ts",
			AG_PRE,
			SCOPED,
			AST_GREP_OFF,
		);
		const AG_FIXED = AG_PRE.replace("): unknown {", "): string {");
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		const big = `${AG_PRE}// ${"x".repeat(1_100_000)}\n`;
		const w2 = await s.edit(big, [6]);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L3\b/);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		pendingCleanup = async () => {
			await s.write(AG_FIXED);
			await s.endTurn();
		};
		// #5784: a runner's no-verdict carry names the runner, and no
		// language-server probe, which would not re-check it.
		expect(w2).toMatch(
			/1 recorded earlier was not re-checked on this write \([\w-]+ gave no verdict\), so only a later write its check answers can retire it\./,
		);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (residual a): a blocker first seen while its runner had no
	// verdict was never recorded, because the next run withheld it as out of
	// range (TLC MutOwedRanges).
	it("records a blocker first written while its runner had no verdict once the runner next answers (row 15)", async () => {
		const AG_FIXED = AG_PRE.replace("): unknown {", "): string {");
		const s = await openSession(
			"ow",
			"src/owed-ag.ts",
			AG_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		await s.write(AG_FIXED);
		// One edit adds the blocker at L3 and grows the file past the cap, so
		// the ast-grep run skips without reading it.
		const big = `${AG_PRE}// ${"x".repeat(1_100_000)}\n`;
		const w1 = await s.edit(big, [3, 6]);
		expect(w1).not.toContain("no-unknown-returns");
		// The next edit only removes the padding; L3 is outside its range.
		const w2 = await s.edit(AG_PRE, [6]);
		expect(w2).toContain("🔴 STOP");
		expect(w2).toContain("L3:");
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (F4, review probe P5): a new error that took a fixed error's
	// line-bound id was held back by the delta and labelled "still unfixed …
	// earlier", although the agent had never seen it.
	it("delivers a new error that takes a fixed error's id in the STOP block (row 16)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("lb", "src/label-new.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		const w2 = await s.write(V1.replace("BAD_CALL", "BAD_OTHER"));
		expect(w2).toContain("🔴 STOP");
		expect(w2).toContain("L2: Cannot find name 'BAD_OTHER'.");
		expect(w2).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);
});

describe("#4484 witness, round 4: no alignment fails closed", () => {
	const SCOPED = { lsp: { enabled: false } };
	const AG_PRE = [
		'export const CLIENT_VERSION = "1.0.50";',
		"export const plain = CLIENT_VERSION;",
		"export function dig(obj: Record<string, string>, key: string): unknown {",
		"\treturn obj[key];",
		"}",
		"",
	].join("\n");
	const AG_FIXED = AG_PRE.replace("): unknown {", "): string {");
	const TS_PRE =
		"export function run(): void {\n\tdebugger;\n}\nexport const a = 1;\n";
	const TS_FIXED = TS_PRE.replace("\tdebugger;\n", "\treturn;\n");
	// 1100 distinct lines above and a new last line: no common prefix, and a
	// middle past the 1000-edit cap, so the write has no alignment.
	const PAD = Array.from({ length: 1100 }, (_, i) => `// pad ${i}`).join("\n");
	const padRange = Array.from({ length: 1100 }, (_, i) => i + 1);

	// Recurrence (G1, verify probe P11c): with no alignment the carry read the
	// recorded line number as it was, found nothing there, and retired an
	// ast-grep blocker still on disk: `✓ clean`, the gate open, and "Resolved"
	// at turn end (TLC MutUnaligned).
	it("keeps an ast-grep blocker pending when the write cannot be aligned (row 4, P11c)", async () => {
		const s = await openSession(
			"uc",
			"src/unaligned-ag.ts",
			AG_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		const big = `${PAD}\n${AG_PRE}export const tail = 1;\n`;
		const w2 = await s.edit(big, [...padRange, 1106]);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L1103\b/);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (G1, verify probe P11d): the same through tree-sitter.
	it("keeps a tree-sitter blocker pending when the write cannot be aligned (row 4, P11d)", async () => {
		const s = await openSession(
			"ud",
			"src/unaligned-ts.ts",
			TS_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		await s.write(TS_FIXED);
		expect(await s.edit(TS_PRE, [2])).toContain("🔴 STOP");
		const big = `${PAD}\n${TS_PRE}export const tail = 1;\n`;
		const w2 = await s.edit(big, [...padRange, 1105]);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L1102\b/);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (G1 and G3, verify probe P18): the anchor lived in a
	// 256-entry cache apart from the record. Writes to 260 other files evicted
	// it, and the next edit above the blocker retired it with nothing to align.
	it("keeps a tree-sitter blocker's anchor across writes to 260 other files (row 10, P18)", async () => {
		const s = await openSession(
			"evict",
			"src/evicted-ts.ts",
			TS_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		await s.write(TS_FIXED);
		expect(await s.edit(TS_PRE, [2])).toContain("🔴 STOP");
		for (let i = 0; i < 260; i += 1)
			await s.writeOther(
				`src/p18/other-${i}.ts`,
				`export const v${i} = ${i};\n`,
			);
		const w2 = await s.edit(`// header\n${TS_PRE}`, [1]);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L3\b/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);

	// G1's third path (round-4 brief item 4): past the blocker baseline's
	// 2 MiB cap the write's bytes get no line hashes, so it has no alignment.
	it("keeps a tree-sitter blocker pending when the file outgrows the 2 MiB hash cap (row 4)", async () => {
		const s = await openSession(
			"ug",
			"src/hashcap-ts.ts",
			TS_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		await s.write(TS_FIXED);
		expect(await s.edit(TS_PRE, [2])).toContain("🔴 STOP");
		const wide = Array.from(
			{ length: 2100 },
			(_, i) => `// ${String(i).padStart(4, "0")} ${"x".repeat(1000)}`,
		).join("\n");
		const w2 = await s.edit(
			`${wide}\n${TS_PRE}`,
			Array.from({ length: 2100 }, (_, i) => i + 1),
		);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (G2, verify probe P20): the agent deletes the line its own
	// blocker was on, and an untouched match of the same rule slides onto that
	// number. A deleted line has no position, so nothing stands in for it
	// (mutation X17 read the stale number and kept a false "Still unfixed").
	it("retires a deleted blocker although an untouched match slides onto its line number (row 3, P20)", async () => {
		const OLD = "export function old(): void {\n\tdebugger; // old\n}\n";
		const NEU = "export function neu(): void {\n\tdebugger;\n}\n";
		const FIXED = OLD.replace("\tdebugger; // old\n", "\treturn;\n");
		// The untouched match is on disk before the session, so no write
		// delivers or records it (#4481).
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src/slide-ts.ts"), OLD);
		const s = await openSession(
			"uf",
			"src/slide-ts.ts",
			FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		const w1 = await s.edit(`${NEU}${OLD}`, [1, 2, 3]);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("L2:");
		expect(w1).not.toContain("L5:");
		const w2 = await s.edit(OLD, [1]);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(false);
		pendingCleanup = undefined;
	}, 120_000);
});

describe("#4484 witness, round 5: a fallback holds only what its evidence names", () => {
	const SCOPED = { lsp: { enabled: false } };
	const AG_PRE = [
		'export const CLIENT_VERSION = "1.0.50";',
		"export const plain = CLIENT_VERSION;",
		"export function dig(obj: Record<string, string>, key: string): unknown {",
		"\treturn obj[key];",
		"}",
		"",
	].join("\n");
	const AG_FIXED = AG_PRE.replace("): unknown {", "): string {");
	const PAD = Array.from({ length: 1100 }, (_, i) => `// pad ${i}`).join("\n");
	const padRange = Array.from({ length: 1100 }, (_, i) => i + 1);
	// Past the ast-grep runner's 1 MiB cap: it skips without reading the file.
	const OVER_CAP = `// ${"x".repeat(1_100_000)}`;

	// Recurrence (K1, verify probe P22): with no alignment the carry matched
	// the agent's fixed `debugger` by identity alone, so an untouched,
	// never-delivered `debugger` with other text took over the record and
	// blocked through every later write and turn end (TLC MutUnalignedText).
	it("retires a fixed blocker on an unaligned write although an older match with other text stays (row 4b, P22)", async () => {
		const OLD = "export function old(): void {\n\tdebugger; // old\n}\n";
		const NEU = "export function neu(): void {\n\tdebugger;\n}\n";
		const FIXED = OLD.replace("\tdebugger; // old\n", "\treturn;\n");
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src/adopt-ts.ts"), OLD);
		const s = await openSession(
			"adopt",
			"src/adopt-ts.ts",
			FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		const w1 = await s.edit(`${NEU}${OLD}`, [1, 2, 3]);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("L2:");
		// No common prefix and a middle past the edit cap: no alignment.
		const w2 = await s.edit(`${PAD}\n${OLD}export const tail = 1;\n`, [
			...padRange,
			1104,
		]);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).not.toContain("STOP");
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence (K1's stale line): a write with no alignment kept a blocker
	// its runner gave no verdict on at its old line number. The next write
	// aligned that stale number to another line, found nothing there, and
	// retired the blocker while it was still on disk.
	it("keeps a blocker its runner skipped on an unaligned write once the next write aligns (row 6b)", async () => {
		const s = await openSession(
			"stale",
			"src/stale-ag.ts",
			AG_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		// Unaligned, and past the runner's size cap: no verdict, no position.
		const w2 = await s.edit(`${PAD}\n${AG_PRE}${OVER_CAP}\n`, [
			...padRange,
			1106,
		]);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier/);
		// Dropping the padding line aligns, and the runner reads the file again.
		const w3 = await s.edit(`${PAD}\n${AG_PRE}`, [1106]);
		expect(w3).not.toMatch(/✓ .*clean/);
		expect(w3).toMatch(/Still unfixed: 1 blocker reported earlier \(L1103\b/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (K2, verify probe P23): a file with no blocker record kept
	// only the id of a runner that skipped it, so the next write owed that
	// runner the whole file, and an untouched, pre-existing finding became a
	// new STOP (TLC MutOwedByContent).
	it("owes a runner that skipped a file with no record only the lines it skipped (row 9, P23)", async () => {
		const BASE = `${AG_PRE}export const k = 1;\n`;
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src/owed-pre.ts"), BASE);
		const s = await openSession(
			"owpre",
			"src/owed-pre.ts",
			AG_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		const W0 = BASE.replace("k = 1", "k = 2");
		// #5258: this session runs --no-lsp, so no primary checker ran and the
		// line says so instead of `✓ clean`. The row's claim is that no write
		// turns the pre-existing finding into a STOP.
		const noStop = (text: string) => {
			expect(text).not.toContain("STOP");
			expect(text).toMatch(/⚠ .*unconfirmed/);
		};
		noStop(await s.edit(W0, [6]));
		// The skipped lines hold a copy of the pre-existing finding's own line,
		// so owed positions must be remapped, not matched by text.
		const COPY = AG_PRE.split("\n").slice(2, 5).join("\n");
		noStop(await s.edit(`${W0}${COPY}\n${OVER_CAP}\n`, [7, 8, 9, 10]));
		noStop(await s.edit(W0, [6]));
		expect(await s.commitBlocked()).toBe(false);
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence (K2's sibling, row 12): an unaligned write to a file with a
	// record owed a runner that had skipped the whole file, so a pre-existing,
	// never-delivered finding became a new STOP. Owed lines follow their text.
	it("owes a runner that skipped only its skipped lines on an unaligned write to a recorded file (row 12)", async () => {
		const TS_BAD = "debugger; // top\n";
		const TS_OK = "// top\n";
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src/owed-rec.ts"), AG_PRE);
		const s = await openSession(
			"owrec",
			"src/owed-rec.ts",
			AG_PRE,
			SCOPED,
			AST_GREP_OFF,
		);
		// The debugger blocks (tree-sitter, recorded); the ast-grep runner skips
		// the file past its size cap and owes the edit's lines.
		const w1 = await s.edit(`${TS_BAD}${AG_PRE}${OVER_CAP}\n`, [1, 7]);
		expect(w1).toContain("🔴 STOP");
		expect(w1).not.toContain("no-unknown-returns");
		// Unaligned, and back under the cap: the owed lines moved by 1100.
		const w2 = await s.edit(`${PAD}\n${TS_BAD}${AG_PRE}`, padRange);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L1101\b/);
		expect(w2).not.toContain("unknown");
		pendingCleanup = async () => {
			await s.write(`${TS_OK}${AG_FIXED}`);
			await s.endTurn();
		};
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (K3, verify probe P25): a carry moved a blocker's line but
	// kept its line-bound id, so the settled re-check's copy at the same line
	// joined the record beside it, and the turn end listed it twice.
	it("lists a carried blocker once after its collect-later re-check settles (row 13, P25)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("dup", "src/carry-dup.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "lsp",
			durationMs: 6_000,
		});
		boundary.lsp.mode = "hold";
		const w2 = await s.write(`BAD_OTHER();\nconst z = 0;\n${V1}`);
		expect(w2.match(STILL_UNFIXED)?.[1]).toBe("4");
		for (const release of boundary.lsp.held.splice(0)) release();
		await settlePendingRunnerFindingsForTests();
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("STOP — 2 issue(s)");
		expect(turnEnd.match(/L4:/g)?.length).toBe(1);
		expect(turnEnd).toContain("L1:");
		boundary.lsp.mode = "answer";
		await s.write(V_FIXED);
		await settlePendingRunnerFindingsForTests();
		await s.endTurn();
		pendingCleanup = undefined;
	}, 120_000);
});

describe("#4484 witness, round 6: Gate B answers only for what its server sees", () => {
	const AG_PRE = [
		'export const CLIENT_VERSION = "1.0.50";',
		"export const plain = CLIENT_VERSION;",
		"export function dig(obj: Record<string, string>, key: string): unknown {",
		"\treturn obj[key];",
		"}",
		"",
	].join("\n");
	const AG_FIXED = AG_PRE.replace("): unknown {", "): string {");
	const AG_TWO = `${AG_PRE}export function dig2(obj: Record<string, string>, key: string): unknown {\n\treturn obj[key];\n}\n`;
	const AG_TWO_FIXED = AG_TWO.replaceAll("): unknown {", "): string {");
	// The ast-grep server publishes from here on, so napi takes Gate B.
	const serverCovers = () => {
		boundary.ag.published = true;
		boundary.ag.diag = true;
	};

	// Recurrence (N1, verify probe P27): napi recorded a blocker before the
	// ast-grep server first published. An edit elsewhere made napi skip as
	// covered by the server, which counted as a verdict, but the server's gate
	// withholds an out-of-span copy, and its copy has another identity. The
	// write said `✓ clean`, opened the gate and reported the blocker resolved
	// while it was still on disk.
	it("keeps a napi blocker recorded before the ast-grep server publishes after an edit elsewhere (row 17, P27)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("p27", "src/p27.ts", AG_FIXED);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		serverCovers();
		const w2 = await s.edit(
			AG_PRE.replace("CLIENT_VERSION;", "CLIENT_VERSION; // x"),
			[2],
		);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L3\b/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("STOP");
		expect(turnEnd).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (the attack on a bare Gate B skip while a napi blocker is
	// recorded): napi never answers while the server covers the file, so the
	// fix on the blocker's own line would never retire it, and the gate would
	// stay shut for the session.
	it("retires a napi blocker fixed on its own line while the ast-grep server covers the file (row 18)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("gbfix", "src/gate-b-fix.ts", AG_FIXED);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		serverCovers();
		const w2 = await s.edit(AG_FIXED, [3]);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(w2).not.toContain("STOP");
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).not.toContain("STOP");
		pendingCleanup = undefined;
	}, 180_000);

	// Recurrence (the keep's range bound): an edit whose range covers a napi
	// blocker's unchanged line lets the server see it, so its copy blocks.
	// Keeping napi's entry too would list the one finding twice.
	it("lists a napi blocker once when the edit names its unchanged line under Gate B (row 18b)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("gbsame", "src/gate-b-same.ts", AG_FIXED);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		serverCovers();
		const w2 = await s.edit(
			AG_PRE.replace("CLIENT_VERSION;", "CLIENT_VERSION; // x"),
			[2, 3],
		);
		expect(w2).toContain("🔴 STOP");
		expect(w2).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (row 23): Gate B's verdict discharged the lines napi owed
	// from a skip, so once the server stopped covering the file napi's next
	// run read only the edit, and the blocker written during the skip never
	// blocked.
	it("keeps napi owed the lines it skipped across Gate B until it runs again (row 23)", async () => {
		boundary.lsp.enabled = true;
		const OVER_CAP = `// ${"x".repeat(1_100_000)}`;
		const s = await openSession("gbowed", "src/gate-b-owed.ts", AG_FIXED);
		await s.write(`${AG_FIXED}${OVER_CAP}\n`);
		// Past napi's size cap: it skips without reading and owes line 3.
		const w1 = await s.edit(`${AG_PRE}${OVER_CAP}\n`, [3]);
		expect(w1).not.toContain("no-unknown-returns");
		serverCovers();
		boundary.ag.diag = false;
		await s.edit(
			`${AG_PRE.replace("CLIENT_VERSION;", "CLIENT_VERSION; // x")}${OVER_CAP}\n`,
			[2],
		);
		// The server stops covering the file; napi runs on the next edit.
		boundary.ag.published = false;
		const w3 = await s.edit(
			AG_PRE.replace("CLIENT_VERSION;", "CLIENT_VERSION; // y"),
			[2, 7],
		);
		expect(w3).toContain("🔴 STOP");
		expect(w3).toContain("L3:");
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (O2, verify probe P33): the agent edited the blocker's line
	// and left the violation while the ast-grep server did not answer. Gate
	// B's skip still counted for the edit, so the blocker retired: an open
	// gate and "Resolved" with the violation on disk.
	it("keeps a napi blocker edited but still violating while the ast-grep server does not answer (row 26, P33)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("p33", "src/p33.ts", AG_FIXED);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		serverCovers();
		boundary.ag.cutoff = true;
		const w2 = await s.edit(
			AG_PRE.replace("key: string): unknown", "k2: string): unknown").replace(
				"obj[key]",
				"obj[k2]",
			),
			[3, 4],
		);
		// #4509: napi runs while it holds the recorded blocker, and with the
		// server silent its own finding delivers, so the edit gets a STOP.
		expect(w2).toMatch(/🔴 STOP[^]*L3:/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("STOP");
		expect(turnEnd).not.toContain("Resolved this turn");
		boundary.ag.cutoff = false;
		boundary.ag.published = false;
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (O1, verify probe P34): napi turned collect-later after it
	// recorded a blocker. Its Gate B skip on an edit elsewhere settled as
	// covered by the server, and the settle retired the blocker file-wide:
	// the gate opened and turn end said "Resolved".
	it("keeps a napi blocker when its collect-later Gate B skip settles (row 24, P34)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("p34", "src/p34.ts", AG_FIXED);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		serverCovers();
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "ast-grep-napi",
			durationMs: 6_000,
		});
		await s.edit(
			AG_PRE.replace("CLIENT_VERSION;", "CLIENT_VERSION; // x"),
			[2],
		);
		await settlePendingRunnerFindingsForTests();
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("STOP");
		expect(turnEnd).not.toContain("Resolved this turn");
		resetObservedRunnerLatency();
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (Q2, verify probe P43): the lsp runner answered, with a
	// typescript warning, while the ast-grep server stayed unconfirmed. Only
	// the runner half of round 7's void had a cell, so dropping the server
	// half (mutation M3) kept the witness green while the blocker retired:
	// an open gate and "Resolved" with the violation on disk.
	it("keeps a napi blocker edited but still violating while lsp answers and the ast-grep server does not (row 26b, P43)", async () => {
		const PRE = `${AG_PRE}export const unusedVar = 1;\n`;
		const FIXED = PRE.replace("): unknown {", "): string {");
		boundary.lsp.enabled = true;
		const s = await openSession("p43", "src/p43.ts", FIXED);
		await s.write(FIXED);
		expect(await s.edit(PRE, [3])).toContain("🔴 STOP");
		serverCovers();
		boundary.ag.cutoff = true;
		const w2 = await s.edit(
			PRE.replace("key: string): unknown", "k2: string): unknown").replace(
				"obj[key]",
				"obj[k2]",
			),
			[3, 4],
		);
		// The lane's runner reached a verdict; only its server was silent.
		expect((await lastRunnerRows("src/p43.ts")).lsp?.status).toBe("succeeded");
		expect(w2).toMatch(/🔴 STOP[^]*L3:/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("STOP");
		expect(turnEnd).not.toContain("Resolved this turn");
		boundary.ag.cutoff = false;
		boundary.ag.published = false;
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (row 28, verify probe P40): a whole-file write left the
	// violation while the ast-grep server did not answer. Gate B's skip
	// covered the whole file, so the blocker retired at 7cecb0339: an open
	// gate and "Resolved" with the violation on disk.
	it("keeps a napi blocker on a whole-file write while the ast-grep server does not answer (row 28, P40)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("p40", "src/p40.ts", AG_FIXED);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		serverCovers();
		boundary.ag.cutoff = true;
		const w2 = await s.write(AG_PRE.replace("plain =", "plain2 ="));
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("STOP");
		expect(turnEnd).not.toContain("Resolved this turn");
		boundary.ag.cutoff = false;
		boundary.ag.published = false;
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (N1 per entry): one write fixed a napi blocker inside the
	// edit and left another outside it. Gate B's skip retired both; a
	// runner-wide bare skip would keep both, and the fixed one, its text
	// gone, could never be placed again.
	it("retires the fixed napi blocker and keeps the one outside the edit under Gate B (row 19)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("gbtwo", "src/gate-b-two.ts", AG_TWO_FIXED);
		await s.write(AG_TWO_FIXED);
		expect(await s.edit(AG_TWO, [3, 6])).toContain("🔴 STOP — 2 issue(s)");
		serverCovers();
		const w2 = await s.edit(AG_TWO.replace("): unknown {", "): string {"), [3]);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L6\b/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 180_000);
});

describe("#4484 witness, round 8: a covered skip counts only when its lane answered", () => {
	const SH = "#!/bin/bash\necho one\nBAD_SH here\necho two\n";
	const SH_FIXED = SH.replace("BAD_SH here\n", "");

	// Recurrence (Q1, verify probe P39): shellcheck recorded a blocker while
	// the lsp lane was off. Then the bash server's cover engaged, but the
	// server did not answer. shellcheck's covered skip still counted as a
	// verdict, so the gate opened and turn end said "Resolved" with the
	// violation on disk.
	it("keeps a shellcheck blocker when its covering bash server does not answer (row 32, P39)", async () => {
		// The cover's gate walks PATH for the bash server's binaries (no
		// spawn), so stub files stand in for them; spawns stay doubled.
		const bin = path.join(tmpDir, "p39-bin");
		fs.mkdirSync(bin, { recursive: true });
		for (const tool of ["bash-language-server", "shellcheck"])
			fs.writeFileSync(path.join(bin, tool), "#!/bin/sh\n", { mode: 0o755 });
		const originalPath = process.env.PATH;
		process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
		try {
			boundary.lsp.enabled = true;
			const s = await openSession(
				"p39",
				"scripts/p39.sh",
				SH_FIXED,
				{},
				{ "no-lsp": true },
			);
			expect(await s.write(SH.replace("echo one", "echo zero"))).toContain(
				"🔴 STOP",
			);
			expect(await s.edit(SH, [2])).toMatch(
				/Still unfixed: 1 blocker reported earlier \(L3\b/,
			);
			// The cover engages (in production: `no-lsp` turned off, or a gate
			// probe that failed once and later succeeds), and the server is silent.
			s.setFlag("no-lsp", false);
			boundary.sh.silent = true;
			const scans = boundary.sh.runs;
			const w2 = await s.edit(SH.replace("echo two", "echo three"), [4]);
			expect(boundary.sh.runs).toBe(scans);
			// The cover engaged: shellcheck skipped without a scan.
			expect((await lastRunnerRows("scripts/p39.sh")).shellcheck?.status).toBe(
				"skipped",
			);
			expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L3\b/);
			expect(await s.commitBlocked()).toBe(true);
			const turnEnd = await s.endTurn();
			expect(turnEnd).toContain("SC1072");
			expect(turnEnd).not.toContain("Resolved this turn");
			boundary.sh.silent = false;
			s.setFlag("no-lsp", true);
			await fixAndDrain(s);
		} finally {
			process.env.PATH = originalPath;
		}
	}, 180_000);
});

describe("#4509 witness: a recorded blocker is judged by a run of its own runner", () => {
	const SCOPED = { lsp: { enabled: false } };
	const AG_PRE = [
		'export const CLIENT_VERSION = "1.0.50";',
		"export const plain = CLIENT_VERSION;",
		"export function dig(obj: Record<string, string>, key: string): unknown {",
		"\treturn obj[key];",
		"}",
		"",
	].join("\n");
	const AG_FIXED = AG_PRE.replace("): unknown {", "): string {");
	const K2 = (src: string) =>
		src
			.replace("key: string): unknown", "k2: string): unknown")
			.replace("obj[key]", "obj[k2]");
	const PAD = Array.from({ length: 1100 }, (_, i) => `// pad ${i}`).join("\n");
	const padRange = Array.from({ length: 1100 }, (_, i) => i + 1);
	const OVER_CAP = `// ${"x".repeat(1_100_000)}`;

	/** napi records the blocker at L3; then the ast-grep server publishes. */
	async function primedUnderGateB(name: string) {
		boundary.lsp.enabled = true;
		const s = await openSession(name, `src/${name}.ts`, AG_FIXED);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		boundary.ag.published = true;
		boundary.ag.diag = true;
		return s;
	}

	// Recurrence (#4491 round-7 verify, probe P42): the aux lane was cut off
	// during an edit on the blocker's line, so napi's entry kept the old line
	// text and no write could place it. The agent then fixed the line: the
	// fixed blocker read "Still unfixed" for the session, the commit gate
	// stayed shut, and only a napi run (the server gone) cleared it.
	it("retires a napi blocker fixed after an edit on its line that the ast-grep server missed (row 31, P42)", async () => {
		const s = await primedUnderGateB("p42");
		boundary.ag.cutoff = true;
		const cutOff = await s.edit(K2(AG_PRE), [3, 4]);
		expect(cutOff).not.toMatch(/✓ .*clean/);
		expect(await s.commitBlocked()).toBe(true);
		boundary.ag.cutoff = false;
		boundary.ag.diag = false;
		const fix = await s.edit(K2(AG_FIXED), [3]);
		expect(fix).not.toMatch(/Still unfixed/);
		expect(fix).not.toContain("STOP");
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).toMatch(/Resolved this turn: src\/p42\.ts/);
		expect(
			await s.write(
				K2(AG_FIXED).replace("CLIENT_VERSION;", "CLIENT_VERSION; // w"),
			),
		).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(false);
		// The cut-off edit's own result: napi, the server silent, delivers its
		// copy with the line's current text.
		expect(cutOff).toMatch(/🔴 STOP[^]*L3:/);
		pendingCleanup = undefined;
	}, 180_000);

	// Recurrence (the void a covered skip gets when its lane is silent,
	// applied to napi's run): napi read the fixed bytes while the ast-grep
	// server was cut off, yet its verdict was thrown away, so the fixed
	// blocker read "Still unfixed" with nothing on disk.
	it("retires a napi blocker fixed while the ast-grep server is cut off (row 31b)", async () => {
		const s = await primedUnderGateB("p42b");
		boundary.ag.cutoff = true;
		const fix = await s.edit(AG_FIXED, [3]);
		expect(fix).not.toMatch(/Still unfixed/);
		expect(fix).not.toContain("STOP");
		expect(await s.commitBlocked()).toBe(false);
		pendingCleanup = undefined;
	}, 180_000);

	// Recurrence (#4509, the settle's cover guard on napi's own run): napi
	// was slow, so its run on the fix settled later; the settle read any
	// result naming a covering lane as a skip and retired nothing, so the
	// fixed blocker held the commit gate shut while napi stayed slow.
	it("retires a napi blocker when napi's slow run on the fix settles under Gate B (row 31c)", async () => {
		const s = await primedUnderGateB("p42c");
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "ast-grep-napi",
			durationMs: 6_000,
		});
		boundary.ag.diag = false;
		await s.edit(AG_FIXED, [3]);
		await settlePendingRunnerFindingsForTests();
		expect(peekSettledRunnerFindings().length).toBeGreaterThanOrEqual(1);
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).toMatch(/Resolved this turn: src\/p42c\.ts/);
		resetObservedRunnerLatency();
		pendingCleanup = undefined;
	}, 180_000);

	// Recurrence (#4491 round-6 review O3, probe P38): an unaligned write
	// while the ast-grep server covered the file left napi's entry with no
	// place, and the server's copy has another identity, so the fix on the
	// blocker's line never retired it: pinned for the session.
	it("retires a napi blocker fixed after an unaligned write while the ast-grep server covers the file (row 33, P38)", async () => {
		const s = await primedUnderGateB("p38");
		const big = `${PAD}\n${AG_PRE}export const tail = 1;\n`;
		const w2 = await s.edit(big, [...padRange, 1106]);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier/);
		expect(await s.commitBlocked()).toBe(true);
		const fixed = big.replace("): unknown {", "): string {");
		const fix = await s.edit(fixed, [1103]);
		expect(fix).not.toMatch(/Still unfixed/);
		expect(fix).not.toContain("STOP");
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).toMatch(/Resolved this turn: src\/p38\.ts/);
		// napi's withheld copy placed the kept blocker at its current line.
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L1103\b/);
		pendingCleanup = undefined;
	}, 180_000);

	// Recurrence (#4509 N3, probe P29): a no-verdict unaligned write kept the
	// blocker with its old line number and line hash; the next, aligned write
	// read that hash at the old number, found a block comment holding the
	// same text, placed the blocker there and retired it: `✓ clean`, an open
	// gate and "Resolved" with the violation on disk at L1103.
	it("keeps a blocker carried without a place although its old line number now holds its text (row 34, P29)", async () => {
		const padc = Array.from({ length: 1100 }, (_, i) => `// pad ${i}`);
		padc[0] = "/*";
		padc[2] = AG_PRE.split("\n")[2] ?? "";
		padc[1099] = "*/";
		const PADC = padc.join("\n");
		const s = await openSession(
			"p29",
			"src/p29.ts",
			AG_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		// Unaligned, and past napi's size cap: no verdict, and no place.
		const w2 = await s.edit(`${PADC}\n${AG_PRE}${OVER_CAP}\n`, [
			...padRange,
			1106,
		]);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier/);
		const w3 = await s.edit(`${PADC}\n${AG_PRE}`, [1106]);
		expect(w3).not.toMatch(/✓ .*clean/);
		expect(w3).toMatch(/Still unfixed: 1 blocker reported earlier \(L1103\b/);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		// Kept without a place, the blocker cites no line from older bytes — and
		// the line says so (its line MOVED, review r3 F6) instead of dropping it
		// from a count that still holds it (#5008).
		expect(w2).toMatch(
			/Still unfixed: 1 blocker reported earlier; 1 whose line could not be re-placed in these bytes\./,
		);
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (#4509 N3, at the turn end's past-EOF sweep): a blocker
	// carried without a place kept its old line number, past the new end of
	// the file, so the sweep read the whole record as stale and retired it
	// with the violation on disk.
	it("keeps a blocker carried without a place when its old line number is past the end of the file (row 35)", async () => {
		const s = await openSession(
			"eof",
			"src/stale-eof.ts",
			AG_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		const big = `${PAD}\n${AG_FIXED}`;
		await s.write(big);
		expect(await s.edit(`${PAD}\n${AG_PRE}`, [1103])).toContain("🔴 STOP");
		// The padding goes, past napi's size cap: no verdict, and no place.
		const w2 = await s.edit(
			`${AG_PRE}export const tail = 1;\n${OVER_CAP}\n`,
			[1, 2, 3, 4, 5, 6, 7, 8],
		);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).not.toContain("line no longer exists");
		expect(turnEnd).not.toContain("Retired after this delivery");
		expect(turnEnd).toMatch(
			/STOP[^]*no-unknown-returns|STOP[^]*Function returns 'unknown'/,
		);
		expect(await s.commitBlocked()).toBe(true);
		// #5784: the same unconfirmed blocker on the next write: its line is held
		// back as an identical replay, and the blocker stays pending.
		const w3 = await s.edit(
			`${AG_PRE}export const tail = 2;\n${OVER_CAP}\n`,
			[7],
		);
		expect(w3).not.toMatch(/Still unfixed|clean/);
		expect(await s.commitBlocked()).toBe(true);
		expect(w2).toMatch(
			/Still unfixed: 1 blocker reported earlier; 1 whose line could not be re-placed in these bytes\./,
		);
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (#4509 N2, probe P31b): a write napi skipped owed it the
	// lines of a clean block by content, `}` among them; once the next write
	// could not be aligned, every `}` in the file was owed, so an older,
	// untouched constant condition whose span ends on one became the agent's
	// STOP and pinned the gate.
	it("does not owe an older finding a write never touched through a line with no word character (row 36, P31b)", async () => {
		const Q =
			"export function q(): number {\n\tif (true) {\n\t\treturn 1;\n\t}\n\treturn 0;\n}\n";
		const BASE = `${Q}export const k = 1;\n`;
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src/p31b.ts"), BASE);
		const s = await openSession(
			"p31b",
			"src/p31b.ts",
			Q.replace("if (true)", "if (Math.random() > 2)"),
			SCOPED,
			AST_GREP_OFF,
		);
		const W0 = BASE.replace("k = 1", "k = 2");
		expect(await s.edit(W0, [7])).not.toContain("STOP");
		const ADD = 'export function z(): string {\n\treturn "z";\n}';
		expect(
			await s.edit(`${W0}${ADD}\n${OVER_CAP}\n`, [8, 9, 10, 11]),
		).not.toContain("STOP");
		const w2src = `${PAD}\n${W0}${ADD}\nexport const tail = 1;\n`;
		const n = w2src.split("\n").length;
		const w2 = await s.edit(w2src, [...padRange, n - 1]);
		expect(w2).not.toContain("STOP");
		expect(w2).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(false);
		expect(
			await s.edit(w2src.replace("tail = 1", "tail = 2"), [n - 1]),
		).not.toMatch(/STOP|Still unfixed/);
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).not.toContain("STOP");
		pendingCleanup = undefined;
	}, 180_000);
	// Recurrence (#4484 round 7, LaneVoids, kept by #4509 for a file with no
	// napi blocker recorded): napi skipped as covered while the ast-grep
	// server was cut off, and the skip counted as napi's verdict, so the
	// violation written on that edit was never owed to napi; once the server
	// stopped covering, napi's next run read only its own edit and the
	// blocker never blocked.
	it("keeps napi owed an edit its covered skip saw while the ast-grep server was silent (row 37)", async () => {
		boundary.lsp.enabled = true;
		boundary.ag.published = true;
		const s = await openSession("lanevoid", "src/lane-void.ts", AG_FIXED);
		await s.write(AG_FIXED);
		boundary.ag.cutoff = true;
		const w1 = await s.edit(AG_PRE, [3]);
		expect(w1).not.toMatch(/✓ .*clean/);
		expect(
			(await lastRunnerRows("src/lane-void.ts"))["ast-grep-napi"]?.status,
		).toBe("skipped");
		boundary.ag.cutoff = false;
		// The server stops covering the file; napi runs on the next edit.
		boundary.ag.published = false;
		const w2 = await s.edit(
			AG_PRE.replace("CLIENT_VERSION;", "CLIENT_VERSION; // x"),
			[2],
		);
		expect(w2).toMatch(/🔴 STOP[^]*L3:/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (#4484 round 6, EditScopedKeep, kept by #4509 for a race):
	// napi decides to skip as covered from the record it sees when the
	// dispatch starts. A commit-gate consult during the dispatch absorbed a
	// settled napi blocker into the record; the covered skip then counted as
	// napi's verdict over the whole file and retired that blocker, outside
	// the edit, with the violation on disk.
	it("keeps a napi blocker absorbed during a covered skip's dispatch when it lies outside the edit (row 38)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("race", "src/race.ts", AG_FIXED);
		await s.write(AG_FIXED);
		// napi is slow: its run on this edit settles later, unabsorbed.
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "ast-grep-napi",
			durationMs: 6_000,
		});
		await s.edit(AG_PRE, [3]);
		await settlePendingRunnerFindingsForTests();
		expect(peekSettledRunnerFindings().length).toBeGreaterThanOrEqual(1);
		resetObservedRunnerLatency();
		boundary.ag.published = true;
		boundary.ag.diag = true;
		boundary.lsp.mode = "hold";
		const held = new Promise<void>((resolve) => {
			boundary.lsp.onHold = resolve;
		});
		const edit = s.edit(
			AG_PRE.replace("CLIENT_VERSION;", "CLIENT_VERSION; // x"),
			[2],
		);
		let w2 = "";
		try {
			await held;
			// The absorb reads napi's answer about the earlier bytes as current
			// only while the file's mtime is within the drift tolerance of
			// napi's mark (`freshnessFromMtime`), as on a coarse-mtime
			// filesystem. A warm run wrote this edit inside it by luck and a
			// lone run did not (#4529 review R2), so the race is pinned here.
			const markedAt = new Date(peekSettledRunnerFindings()[0]!.markedAtMs);
			fs.utimesSync(s.target, markedAt, markedAt);
			// napi has already skipped as covered; the gate now absorbs its
			// blocker.
			expect(await s.commitBlocked()).toBe(true);
		} finally {
			// A red above still lets the held dispatch finish in this cell.
			for (const release of boundary.lsp.held.splice(0)) release();
			boundary.lsp.mode = "answer";
			w2 = await edit;
		}
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L3\b/);
		expect(await s.commitBlocked()).toBe(true);
		// The turn end drains napi's settled answer, as it would; left in the
		// store, the next consult would judge it against the fix's bytes, and
		// a fix written within the tolerance would absorb it again.
		expect(await s.endTurn()).toMatch(/STOP[^]*L3/);
		expect(peekSettledRunnerFindings()).toHaveLength(0);
		await fixAndDrain(s);
	}, 180_000);
	// Recurrence (#4509 N3, at the settle): a write napi deferred could not
	// be aligned, so the blocker was kept with its old line number. The
	// settled run found the violation at its new line, but the settle read
	// the old number as the blocker's position, saw nothing there and retired
	// it: an open gate and "Resolved" with the violation on disk.
	it("keeps a blocker carried without a place when its runner's deferred run settles (row 39)", async () => {
		const s = await openSession(
			"stl",
			"src/stale-settle.ts",
			AG_FIXED,
			SCOPED,
			AST_GREP_OFF,
		);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "ast-grep-napi",
			durationMs: 6_000,
		});
		const big = `${PAD}\n${AG_PRE}export const tail = 1;\n`;
		expect(await s.edit(big, [...padRange, 1106])).toMatch(
			/Still unfixed: 1 blocker reported earlier/,
		);
		await settlePendingRunnerFindingsForTests();
		expect(peekSettledRunnerFindings().length).toBeGreaterThanOrEqual(1);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).not.toContain("Resolved this turn");
		expect(turnEnd).toContain("STOP");
		resetObservedRunnerLatency();
		await fixAndDrain(s);
	}, 180_000);

	// Recurrence (#4529 review R1, probe P45): napi's finding dropped on every
	// line the ast-grep server flagged, whatever the rule. A team sgconfig's
	// server flagged another rule on napi's blocker line, and the agent edited
	// that line leaving the violation. At warning, the write read `✓ clean`,
	// the gate opened and turn end said "Resolved". At error, napi's blocker
	// was swapped for the other rule.
	for (const [severity, label] of [
		[2, "warning"],
		[1, "error"],
	] as const) {
		it(`keeps napi's blocker where the ast-grep server flags another rule at ${label} on its line (row 40, P45)`, async () => {
			const s = await primedUnderGateB(`p45-${label}`);
			boundary.ag.diag = false;
			boundary.ag.other = severity;
			const w2 = await s.edit(K2(AG_PRE), [3, 4]);
			expect(w2).not.toMatch(/✓ .*clean/);
			expect(w2).toMatch(/🔴 STOP[^]*L3: [^\n]*Function returns 'unknown'/);
			expect(await s.commitBlocked()).toBe(true);
			const turnEnd = await s.endTurn();
			expect(turnEnd).not.toContain("Resolved this turn");
			expect(turnEnd).toMatch(/STOP[^]*Function returns 'unknown'/);
			if (severity === 1)
				expect(turnEnd).toMatch(/STOP[^]*Prefer an options object/);
			await fixAndDrain(s);
		}, 180_000);
	}

	// Recurrence (#4529 review R3, probe P46): napi's run on an edit of its
	// blocker's line was slow. The ast-grep server's copy was recorded on the
	// write and napi's at the settle, so turn end listed one violation twice.
	it("lists a violation once when napi's slow run settles beside the ast-grep server's copy (row 41, P46)", async () => {
		const s = await primedUnderGateB("p46");
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "ast-grep-napi",
			durationMs: 6_000,
		});
		await s.edit(K2(AG_PRE), [3, 4]);
		await settlePendingRunnerFindingsForTests();
		expect(peekSettledRunnerFindings().length).toBeGreaterThanOrEqual(1);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toMatch(/STOP — 1 issue\(s\)/);
		expect(turnEnd.match(/Function returns 'unknown'/g)).toHaveLength(1);
		expect(await s.commitBlocked()).toBe(true);
		resetObservedRunnerLatency();
		await fixAndDrain(s);
	}, 180_000);
});

/**
 * #5008 witness: a PARTIAL run is a verdict for the servers that answered.
 *
 * Recurrence it prevents: the primary language server answers `[]` (or its own
 * findings) for the new bytes while an auxiliary scanner is unconfirmed or
 * deferred, and the whole `lsp` run reads as "no verdict". Every recorded
 * blocker of the primary's then stays carried, so a fix the primary confirmed
 * never retires: the commit gate stays shut, turn end re-serves "Unresolved",
 * and `lens_diagnostics` lists dead lines. It never clears while a scanner is
 * permanently uncovered.
 */
describe("#5008 witness: a partial run answers for the servers that answered", () => {
	/** One ast-grep violation (the server's own rule) beside an LSP error. */
	const WITH_VIOLATION =
		"const a = 1;\nfunction parse(): unknown {\n\treturn a;\n}\nBAD_CALL();\n";
	/** The same file with the LSP error fixed and the violation still there. */
	const FIXED_CALL =
		"const a = 1;\nfunction parse(): unknown {\n\treturn a;\n}\nconst n = 2;\n";
	/** Both fixed: the cleanup write of this describe's cells. */
	const CLEAN =
		"const a = 1;\nfunction parse(): string {\n\treturn String(a);\n}\nconst n = 2;\n";
	// Acceptance 1, empty answer: the primary confirmed the fix, opengrep never
	// reported. The primary's blocker must retire; the gap must still be named,
	// so the write never reads as fully clean.
	it("retires the primary's blocker while a silent scanner keeps the coverage gap (#5008)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("gap", "src/aux-gap.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		expect(await s.commitBlocked()).toBe(true);
		// The primary answers these bytes with nothing; opengrep never reported.
		boundary.lsp.auxGap = ["opengrep"];
		const w2 = await s.write(V_FIXED);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(w2).toMatch(
			/coverage: opengrep silent — diagnostics are incomplete/,
		);
		expect(await s.commitBlocked()).toBe(false);
		const turnEnd = await s.endTurn();
		expect(turnEnd).not.toContain("Unresolved from this turn");
		boundary.lsp.auxGap = undefined;
		await fixAndDrain(s);
	}, 120_000);

	// Acceptance 1, the other half: the auxiliary's OWN recorded blocker is not
	// evidence the primary has, so it stays carried by `keepUnobserved`'s server
	// clause while the primary's retires.
	it("keeps the unconfirmed scanner's own blocker while the primary's retires (#5008)", async () => {
		boundary.lsp.enabled = true;
		boundary.ag.published = true;
		boundary.ag.diag = true;
		const s = await openSession("gap-aux", "src/aux-gap-own.ts", CLEAN);
		expect(await s.write(WITH_VIOLATION)).toContain("🔴 STOP");
		expect(await s.commitBlocked()).toBe(true);
		// The ast-grep server does not answer this touch; the primary (typescript)
		// does, and confirms the BAD_CALL fix.
		boundary.ag.diag = false;
		boundary.lsp.auxGap = ["ast-grep"];
		const w2 = await s.write(FIXED_CALL);
		// One blocker stays: the scanner's own, at its line, under its rule.
		expect(w2).toMatch(
			/Still unfixed: 1 blocker reported earlier \(L2 ast-grep:no-unknown-returns\)/,
		);
		expect(w2).not.toContain("BAD_CALL");
		expect(w2).toMatch(
			/coverage: ast-grep silent — diagnostics are incomplete/,
		);
		// A real blocker still pins the gate; the dead one no longer does.
		expect(await s.commitBlocked()).toBe(true);
		boundary.lsp.auxGap = undefined;
		await fixAndDrain(s);
	}, 180_000);

	// Acceptance 2, the inverse cell: the primary is silent with no attribution
	// while an auxiliary that DID answer delivers a blocking finding. The
	// primary's recorded blocker is not the answering server's to retire.
	it("keeps the primary's blocker when the primary is silent and an auxiliary answers (#5008)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("silent", "src/silent-primary.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.silentAux = true;
		const w2 = await s.write(V2_OTHER_LINE);
		// The auxiliary's finding is new and STOPs; the primary's is not the
		// auxiliary's to clear, so it stays pending.
		expect(w2).toContain("🔴 STOP");
		expect(w2).toMatch(
			/Still unfixed: 1 blocker reported earlier \(L2 ts:2304\)/,
		);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).toContain(
			"Unresolved from this turn — src/silent-primary.ts:",
		);
		boundary.lsp.silentAux = false;
		await fixAndDrain(s);
	}, 120_000);

	// Acceptance 3: the count, the listed places and each place's rule agree, and
	// a blocker the count includes but these bytes cannot place is said.
	it("counts what it lists, with a rule id per line, and says what has no line (#5008)", async () => {
		boundary.lsp.enabled = true;
		const twoErrors = "const a = 1;\nBAD_CALL();\nBAD_CALL();\nconst b = 2;\n";
		const s = await openSession("fmt", "src/count-list.ts", V_FIXED);
		expect(await s.write(twoErrors)).toContain("🔴 STOP — 2 issue(s)");
		// The server stops answering; an edit elsewhere keeps both blockers.
		boundary.lsp.mode = "inconclusive";
		expect(await s.edit(`${twoErrors}const c = 3;\n`, [5])).toMatch(
			/Still unfixed: 2 blockers reported earlier \(L2 ts:2304, L3 ts:2304\)\./,
		);
		// One blocker's own line is rewritten, so its line number is from older
		// bytes: it stays counted, and the line says its line moved (review r3
		// F6: this is not the "no line in this file" cause).
		expect(
			await s.edit(
				"const a = 1;\nBAD_CALL(1);\nBAD_CALL();\nconst b = 2;\n",
				[2],
			),
		).toMatch(
			/Still unfixed: 2 blockers reported earlier \(L3 ts:2304\); 1 whose line could not be re-placed in these bytes\./,
		);
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	// Review r2 (F1): the coverage NOTICE is once per session, the CLAIM is not.
	// Recurrence: write 1 on a file with a silent scanner printed the notice, and
	// write 2..N — same file, same scanner set — hit the notice's dedupe key and
	// read `✓ JavaScript/TypeScript clean`, so the reporter's 133-write session
	// claimed a clean security lane everywhere after its first edit.
	it("keeps the silent scanner named on the writes after its once-only notice (#5008)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("gap-repeat", "src/aux-gap-repeat.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.auxGap = ["opengrep"];
		// Write 2 pays the session latch: the notice is rendered once.
		expect(await s.write(V_FIXED)).toMatch(
			/coverage: opengrep silent — diagnostics are incomplete/,
		);
		// Write 3 is the same file with the same missing scanner, and the notice
		// is now withheld. The status line still has to name it.
		const w3 = await s.write(V_FIXED_OTHER);
		expect(w3).toMatch(/unconfirmed — opengrep silent/);
		expect(w3).not.toContain("\u2713");
		expect(await s.commitBlocked()).toBe(false);
		boundary.lsp.auxGap = undefined;
		await fixAndDrain(s);
	}, 120_000);

	// Review r2 (F3): 108 of the 667 bundled rule ids exceed the 32-character
	// cap, and the rendered value is `${source}:${id}`, so the ellipsis branch
	// is reachable in production. Its output had no witness: the cap could be
	// raised to 1e9 with every suite green.
	it("bounds a long rule id beside a place, so five places stay one line (#5008)", async () => {
		boundary.lsp.enabled = true;
		boundary.lsp.code =
			"documentbuilderfactory-external-parameter-entities-true-java";
		const s = await openSession("long-rule", "src/long-rule.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		// The server stops answering, so the blocker is carried and rendered.
		boundary.lsp.mode = "inconclusive";
		expect(await s.edit(`${V1}const c = 3;\n`, [4])).toMatch(
			/Still unfixed: 1 blocker reported earlier \(L2 ts:documentbuilderfactory-exter…\)\./,
		);
		boundary.lsp.code = 2304;
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);
});

/**
 * #5727 witness: a recorded blocker is judged by an answer of the server that
 * produced it, also while the runner as a whole reached no verdict.
 *
 * Recurrence: Python's ast-grep rules run only through the ast-grep auxiliary
 * server, under the `lsp` runner. With the primary language server silent or
 * unable to start, the `lsp` run reached no verdict, and the carry kept every
 * recorded `lsp` row by runner id, although the ast-grep server answered these
 * bytes clean. A fixed `unchecked-throwing-call-python` then read "🔴 Still
 * unfixed" on the write, stayed in `lens_diagnostics`, was served as
 * "Unresolved" at turn end, and shut the commit gate until the primary
 * answered. A row is retired only on its own server's answer: a server that
 * did not answer, and a row that names no server, keep it.
 */
describe("#5727 witness: an auxiliary's answer judges its own recorded blocker", () => {
	const PY_BAD =
		"import json\n\n\ndef load(raw):\n    data = json.loads(raw)\n    return data\n";
	const PY_FIXED =
		"import json\n\n\ndef load(raw):\n    try:\n        data = json.loads(raw)\n    except ValueError:\n        data = None\n    return data\n";
	/** The call still bare, two lines lower: the match is still there. */
	const PY_STILL_BARE =
		"import json\nimport os\n\n\ndef load(raw):\n    data = json.loads(raw)\n    return data\n";
	/** A primary error on line 2 beside the auxiliary's finding on line 5. */
	const PY_BOTH =
		"import json\nBAD_PY = 1\n\ndef load(raw):\n    data = json.loads(raw)\n    return data\n";
	/** Only the auxiliary's finding fixed; the primary's line is untouched. */
	const PY_BOTH_AUX_FIXED =
		"import json\nBAD_PY = 1\n\ndef load(raw):\n    try:\n        data = json.loads(raw)\n    except ValueError:\n        data = None\n    return data\n";
	/** The cleanup write: clean, and other bytes than any cell's last write. */
	const PY_CLEAN = `${PY_FIXED}\n# checked\n`;
	const RULE = "unchecked-throwing-call-python";

	const carriedFor = (file: string) =>
		(
			getDegradationSummary().find(
				(c) => c.kind === "blocker-carried-unobserved",
			)?.latestReasons ?? []
		).filter((r) => String(r.subject ?? "").includes(file));

	it("retires a fixed ast-grep blocker while the primary does not answer (#5727, diagnostics-wait)", async () => {
		boundary.lsp.enabled = true;
		boundary.ag.diag = true;
		boundary.lsp.primarySilent = { reason: "diagnostics-wait" };
		const s = await openSession("py-wait", "src/py-wait.py", PY_CLEAN);
		const w1 = await s.write(PY_BAD);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("json.loads(raw)");
		expect(await s.commitBlocked()).toBe(true);

		const w2 = await s.write(PY_FIXED);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(w2).not.toContain("🔴");
		// The carry of an unobserved blocker is the record this write no longer
		// writes for the file: nothing it recorded is left unjudged.
		expect(carriedFor("py-wait.py")).toEqual([]);
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.sessionDiagnostics()).not.toContain(RULE);
		expect(await s.endTurn()).not.toContain("Unresolved from this turn");
		boundary.lsp.primarySilent = undefined;
		await fixAndDrain(s);
	}, 120_000);

	it("retires a fixed ast-grep blocker while the primary cannot start (#5727, primary-unavailable)", async () => {
		boundary.lsp.enabled = true;
		boundary.ag.diag = true;
		boundary.lsp.primarySilent = { reason: "primary-unavailable" };
		const s = await openSession("py-unavail", "src/py-unavail.py", PY_CLEAN);
		expect(await s.write(PY_BAD)).toContain("🔴 STOP");
		expect(await s.commitBlocked()).toBe(true);

		const w2 = await s.write(PY_FIXED);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).not.toContain("Unresolved from this turn");
		boundary.lsp.primarySilent = undefined;
		await fixAndDrain(s);
	}, 120_000);

	// Control: the server's own answer still holds the finding, so it stays.
	it("keeps an ast-grep blocker its server still reports while the primary does not answer (#5727)", async () => {
		boundary.lsp.enabled = true;
		boundary.ag.diag = true;
		boundary.lsp.primarySilent = { reason: "diagnostics-wait" };
		const s = await openSession("py-ctrl", "src/py-ctrl.py", PY_CLEAN);
		expect(await s.write(PY_BAD)).toContain("🔴 STOP");
		const w2 = await s.write(PY_STILL_BARE);
		expect(w2).toContain("json.loads(raw)");
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).toContain(
			"Unresolved from this turn — src/py-ctrl.py:",
		);
		boundary.lsp.primarySilent = undefined;
		await fixAndDrain(s);
	}, 120_000);

	// Fail closed: a server that did not answer either retires nothing. On an
	// inconclusive touch the service names no auxiliary coverage gap, so "not
	// named silent" is no evidence that the auxiliary answered.
	it("keeps an ast-grep blocker when its server does not answer the fix either (#5727)", async () => {
		boundary.lsp.enabled = true;
		boundary.ag.diag = true;
		boundary.lsp.primarySilent = { reason: "diagnostics-wait" };
		const s = await openSession(
			"py-auxsilent",
			"src/py-auxsilent.py",
			PY_CLEAN,
		);
		expect(await s.write(PY_BAD)).toContain("🔴 STOP");
		boundary.lsp.primarySilent = {
			reason: "diagnostics-wait",
			auxSilent: true,
		};
		const w2 = await s.write(PY_FIXED);
		expect(w2).toMatch(
			/Still unfixed: 1 blocker reported earlier \(L\d+ ast-grep:unchecked-throwing-cal…\)/,
		);
		expect(await s.commitBlocked()).toBe(true);
		boundary.lsp.primarySilent = undefined;
		await fixAndDrain(s);
	}, 120_000);

	// Per server, not per runner: the auxiliary's answer retires its own row and
	// never the silent primary's.
	it("retires the auxiliary's fixed blocker and keeps the silent primary's (#5727)", async () => {
		boundary.lsp.enabled = true;
		boundary.ag.diag = true;
		boundary.lsp.primarySilent = { reason: "diagnostics-wait" };
		const s = await openSession("py-both", "src/py-both.py", PY_CLEAN);
		// The primary's error is recorded from an answer, the auxiliary's beside it.
		boundary.lsp.primarySilent = undefined;
		expect(await s.write(PY_BOTH)).toContain("🔴 STOP — 2 issue(s)");
		boundary.lsp.primarySilent = { reason: "diagnostics-wait" };
		const w2 = await s.write(PY_BOTH_AUX_FIXED);
		expect(w2).toMatch(
			/Still unfixed: 1 blocker reported earlier \(L2 python:undefined-name\)\./,
		);
		expect(w2).not.toContain(RULE);
		expect(await s.commitBlocked()).toBe(true);
		boundary.lsp.primarySilent = undefined;
		await fixAndDrain(s);
	}, 120_000);

	// One server, two findings, one fixed: its answer still holds the other,
	// so only the fixed one retires.
	it("retires the fixed one of two ast-grep blockers while the primary does not answer (#5727)", async () => {
		const TWO =
			"import json\n\n\ndef load(raw):\n    data = json.loads(raw)\n    return data\n\n\ndef load2(raw):\n    return json.loads(raw)\n";
		const TWO_ONE_FIXED =
			"import json\n\n\ndef load(raw):\n    try:\n        data = json.loads(raw)\n    except ValueError:\n        data = None\n    return data\n\n\ndef load2(raw):\n    return json.loads(raw)\n";
		boundary.lsp.enabled = true;
		boundary.ag.diag = true;
		boundary.lsp.primarySilent = { reason: "diagnostics-wait" };
		const s = await openSession("py-two", "src/py-two.py", PY_CLEAN);
		expect(await s.write(TWO)).toContain("🔴 STOP — 2 issue(s)");
		const w2 = await s.write(TWO_ONE_FIXED);
		// The one still there is delivered at its moved line; the fixed one is
		// not carried beside it.
		expect(w2).toContain("🔴 STOP — 1 issue(s)");
		expect(w2).toContain("L13: Call without try/except");
		expect(w2).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(true);
		boundary.lsp.primarySilent = undefined;
		await fixAndDrain(s);
	}, 120_000);

	// A touch whose answer is about other bytes withholds every row, so it is
	// no answer of the auxiliary either: a finding still there must not retire
	// because its row was withheld.
	it("keeps an ast-grep blocker when the touch's answer is about other bytes (#5727)", async () => {
		boundary.lsp.enabled = true;
		boundary.ag.diag = true;
		boundary.lsp.primarySilent = { reason: "primary-unavailable" };
		const s = await openSession("py-stale", "src/py-stale.py", PY_CLEAN);
		expect(await s.write(PY_BAD)).toContain("🔴 STOP");
		boundary.lsp.primarySilent = { reason: "primary-unavailable", stale: true };
		const w2 = await s.write(PY_STILL_BARE);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier/);
		expect(await s.commitBlocked()).toBe(true);
		boundary.lsp.primarySilent = undefined;
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence it prevents (#5727 F1): the named-contributor arm of the stale
	// drop had no cell, so a change that cleared the answered list there kept an
	// auxiliary's fixed blocker as "Still unfixed" while the silent primary's
	// stale last-known row was withheld. Here every row is withheld and the
	// auxiliary's clean answer for these bytes is the only evidence left.
	it("retires the auxiliary's fixed blocker while the silent primary's stale row is withheld (#5727)", async () => {
		boundary.lsp.enabled = true;
		boundary.ag.diag = true;
		boundary.lsp.primarySilent = { reason: "diagnostics-wait" };
		const s = await openSession("py-known", "src/py-known.py", PY_CLEAN);
		expect(await s.write(PY_BAD)).toContain("🔴 STOP");
		expect(await s.commitBlocked()).toBe(true);

		boundary.lsp.primarySilent = {
			reason: "diagnostics-wait",
			stale: true,
			lastKnown: true,
		};
		const w2 = await s.write(PY_FIXED);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(w2).not.toContain("BAD_OLD");
		expect(w2).not.toContain("🔴");
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).not.toContain("Unresolved from this turn");
		boundary.lsp.primarySilent = undefined;
		await fixAndDrain(s);
	}, 120_000);
});

/**
 * #5784 witness: a blocker carried because its source gave no verdict says so
 * and names what settles it, and its per-write line is not replayed verbatim.
 *
 * Recurrence prevented: a subagent session on pi-lens 4.5.2, where the
 * classic typescript-language-server (push-only, silent on a clean re-check)
 * never answered after the first write, and every later write ended with the
 * same `withheld` line for 30 minutes. Nothing in the line said the check had
 * no verdict, and nothing named the budgeted probe that settles it.
 */
describe("#5784 witness: an unconfirmed carried blocker is not replayed verbatim", () => {
	/** The V1 shape with a varying last line, so each write is new bytes. */
	const withTail = (n: number, above = "") =>
		`${above}const a = 1;\nBAD_CALL();\nconst b = ${n};\n`;
	const SCRIPT = "node tools/gen.js > src/replay.ts";
	const NOT_RECHECKED = "not re-checked on";
	const NO_VERDICT =
		"1 recorded earlier was not re-checked on this write (typescript gave no verdict), so fixing the code cannot retire it;";
	const SETTLE =
		"lens_diagnostics source=lsp path=src/replay.ts waitMs=30000 settles it.";
	const WITHHELD = /withheld: this call names the file/;
	const IN_FLIGHT = "re-check is still running";
	const RECORD_HELD = "no check has retired";

	const suppressedCount = async (subject: string): Promise<number> =>
		(await degradationRows("blocker-replay-suppressed")).filter((row) =>
			String(row.subject ?? "").includes(subject),
		).length;

	it("names the missing verdict and the probe on the withheld line, then holds back its identical replay", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("rp", "src/replay.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		// (a) the first replay says why, and what settles it.
		const b1 = await s.bash(withTail(10), SCRIPT);
		expect(b1).toMatch(WITHHELD);
		expect(b1).toContain(NO_VERDICT);
		expect(b1).toContain(SETTLE);
		// (b) the same set again: no second line, and no clean claim in its place.
		const b2 = await s.bash(withTail(11), SCRIPT);
		expect(b2).not.toMatch(WITHHELD);
		expect(b2).not.toContain(NOT_RECHECKED);
		expect(b2).not.toMatch(/clean|unconfirmed —/);
		expect(await suppressedCount("withheld-line:")).toBeGreaterThan(0);
		// The blocker itself is still held everywhere a pull or a gate reads it.
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.sessionDiagnostics()).toContain(
			"Cannot find name 'BAD_CALL'",
		);
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	it("delivers the line again when the unconfirmed set moves or a verdict arrives", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("rm", "src/replay.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		expect(await s.bash(withTail(20), SCRIPT)).toMatch(WITHHELD);
		expect(await s.bash(withTail(21), SCRIPT)).not.toMatch(WITHHELD);
		// (c1) a line inserted above moves the carried blocker: a new set.
		const moved = await s.bash(withTail(22, "const z = 0;\n"), SCRIPT);
		expect(moved).toMatch(WITHHELD);
		expect(moved).toMatch(/\(L3 ts:2304\)/);
		expect(await s.bash(withTail(23, "const z = 0;\n"), SCRIPT)).not.toMatch(
			WITHHELD,
		);
		// (c2) the server answers and still sees the error: a verdict, delivered
		// as before, with no no-verdict sentence.
		boundary.lsp.mode = "answer";
		const answered = await s.bash(withTail(24, "const z = 0;\n"), SCRIPT);
		expect(answered).toMatch(WITHHELD);
		expect(answered).not.toContain(NOT_RECHECKED);
		// The verdict re-armed the file: the next silent write says it once more.
		boundary.lsp.mode = "inconclusive";
		const rearmed = await s.bash(withTail(25, "const z = 0;\n"), SCRIPT);
		expect(rearmed).toMatch(WITHHELD);
		expect(rearmed).toContain(NO_VERDICT);
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	it("keeps delivering a blocker whose source reached a verdict on every write", async () => {
		// The control (brief point 5): only an identical unconfirmed replay is
		// held back. A blocker the server reports on each write is a verdict.
		boundary.lsp.enabled = true;
		const s = await openSession("rv", "src/replay.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		for (const n of [30, 31, 32]) {
			const out = await s.bash(withTail(n), SCRIPT);
			expect(out).toMatch(WITHHELD);
			expect(out).not.toContain(NOT_RECHECKED);
		}
		await fixAndDrain(s);
	}, 120_000);

	it("words the Still unfixed line, the turn end and the session read the same way, once per set", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("ru", "src/replay.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		const w2 = await s.write(withTail(40));
		expect(w2).toMatch(STILL_UNFIXED);
		expect(w2).toContain(NO_VERDICT);
		expect(w2).toContain(SETTLE);
		const w3 = await s.write(withTail(41));
		expect(w3).not.toMatch(STILL_UNFIXED);
		expect(w3).not.toMatch(/clean|unconfirmed —/);
		expect(await suppressedCount("still-unfixed-line:")).toBeGreaterThan(0);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("Unresolved from this turn — src/replay.ts:");
		expect(turnEnd).toContain(
			"  1 recorded earlier was not re-checked on its latest write (typescript gave no verdict), so fixing the code cannot retire it;",
		);
		// The session read names the probe for the file its check left unanswered.
		const session = await s.sessionDiagnostics();
		expect(session).toContain("typescript silent");
		expect(session).toContain(
			`src/replay.ts: 1 recorded earlier was not re-checked on its latest write (typescript gave no verdict), so fixing the code cannot retire it; ${SETTLE}`,
		);
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	it("names no earlier finding on the session read for an unanswered file that holds none", async () => {
		// The other direction of the session read's note: a silent server on a
		// file with no blocker leaves the file unchecked, and nothing earlier.
		boundary.lsp.enabled = true;
		boundary.lsp.mode = "inconclusive";
		const s = await openSession("rn", "src/replay-clean.ts", V_FIXED);
		await s.write(V_FIXED_OTHER);
		const session = await s.sessionDiagnostics();
		expect(session).toContain("typescript silent");
		expect(session).not.toContain(NOT_RECHECKED);
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	it("settles a fixed file through the probe the sentence names", async () => {
		// The incident's own sequence: the fix lands while the server stays
		// silent, so the passive path keeps the blocker; the named probe answers.
		boundary.lsp.enabled = true;
		const s = await openSession("rs", "src/replay.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		const line = await s.bash(V_FIXED_OTHER, SCRIPT);
		expect(line).toContain(NO_VERDICT);
		expect(await s.sessionDiagnostics()).toContain("BAD_CALL");
		// The call is read off the line itself, so the sentence and the action
		// it names cannot drift apart.
		const named =
			/lens_diagnostics source=(\w+) path=(\S+) waitMs=(\d+) settles/.exec(
				line,
			);
		expect(named?.[2]).toBe("src/replay.ts");
		boundary.lsp.mode = "answer";
		expect(
			await s.settleCall({ source: named?.[1], waitMs: Number(named?.[3]) }),
		).toMatch(/confirmed clean/);
		expect(await s.sessionDiagnostics()).not.toContain("BAD_CALL");
		expect(await s.commitBlocked()).toBe(false);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5788 review F1, CodeRabbit C6): the session read built its
	// note from the file's unchecked reason and blocking count, so an
	// ast-grep blocker found fresh on the latest write was told fixing the
	// code could not retire it, and sent to a probe of the silent primary.
	it("gives no not-re-checked note on the session read to a blocker found fresh on the latest write", async () => {
		const PY_BAD =
			"import json\n\n\ndef load(raw):\n    data = json.loads(raw)\n    return data\n";
		const PY_FIXED =
			"import json\n\n\ndef load(raw):\n    try:\n        data = json.loads(raw)\n    except ValueError:\n        data = None\n    return data\n";
		boundary.lsp.enabled = true;
		boundary.ag.diag = true;
		boundary.lsp.primarySilent = { reason: "diagnostics-wait" };
		const s = await openSession(
			"fr",
			"src/fresh.py",
			`${PY_FIXED}\n# checked\n`,
		);
		expect(await s.write(PY_BAD)).toContain("🔴 STOP");
		const session = await s.sessionDiagnostics();
		expect(session).toContain("unchecked-throwing-call-python");
		expect(session).toContain("python silent");
		expect(session).not.toContain(NOT_RECHECKED);
		expect(session).not.toContain("source=lsp");
		// The fix retires it on the next write, as a fresh blocker can be.
		await s.write(PY_FIXED);
		expect(await s.commitBlocked()).toBe(false);
		boundary.lsp.primarySilent = undefined;
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5788 review F2): a carry whose collect-later re-check was
	// still running was told fixing the code could not retire it, while the
	// held run then retired the fix at turn end with no probe.
	it("says a re-check is still running, never that fixing cannot retire it, while it runs", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("if", "src/inflight.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "lsp",
			durationMs: 6_000,
		});
		boundary.lsp.mode = "hold";
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(w2).toContain(IN_FLIGHT);
		expect(w2).not.toContain("cannot retire");
		const session = await s.sessionDiagnostics();
		expect(session).toContain(IN_FLIGHT);
		expect(session).not.toContain("cannot retire");
		// The server is back inline and gives no verdict: the next carry is its
		// own, so the earlier carry's running mark is not restated.
		resetObservedRunnerLatency();
		boundary.lsp.mode = "inconclusive";
		const w3 = await s.write(withTail(70));
		expect(w3).toMatch(STILL_UNFIXED);
		expect(w3).not.toContain(IN_FLIGHT);
		expect(w3).toContain("cannot retire");
		for (const release of boundary.lsp.held.splice(0)) release();
		await settlePendingRunnerFindingsForTests();
		boundary.lsp.mode = "answer";
		await s.write(V_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5788 review F6, session-read half): mode=full cleared the
	// session cache while the blocker record still held the commit gate, and
	// the session read said "No issues ... ✓" over it.
	it("prints no all-clear on the session read while a blocker record is unresolved, mode=full included", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("af", "src/allclear.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		await s.bash(V_FIXED_OTHER, "node tools/gen.js > src/allclear.ts");
		boundary.lsp.mode = "answer";
		const target = path.join(tmpDir, "src/allclear.ts");
		// The production service's sweep shape, answering clean for the file.
		lspDouble.runWorkspaceDiagnostics = async () => [
			{ filePath: target, diagnostics: [], count: 0 },
		];
		const full = await s.settleCall({ mode: "full", waitMs: 30000 });
		expect(await s.commitBlocked()).toBe(true);
		const session = await s.sessionDiagnostics();
		for (const read of [full, session]) {
			expect(read).not.toContain("✓");
			expect(read).not.toMatch(/No issues across/);
			expect(read).toContain(RECORD_HELD);
		}
		// source=lsp retires the record, and the all-clear may stand again.
		expect(await s.settleCall({ source: "lsp", waitMs: 30000 })).toMatch(
			/confirmed clean/,
		);
		expect(await s.sessionDiagnostics()).not.toContain(RECORD_HELD);
		// #5790: the settle that retires the record opens the commit gate in the
		// same step, not at the next turn end.
		expect(await s.commitBlocked()).toBe(false);
		await s.write(V_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5788 review N1): the session read withheld its all-clear over
	// a blocker the agent had marked false-positive, while the turn end and the
	// commit gate honoured the mark.
	it("lets the all-clear stand over a blocker the agent marked false-positive", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("fp", "src/marked.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		await s.mark({
			line: 2,
			message: "Cannot find name 'BAD_CALL'.",
			rule: "ts:2304",
			tool: "lsp",
			disposition: "false-positive",
			reason: "#5788 N1 witness",
		});
		const session = await s.sessionReport();
		expect(session.text).toContain("suppressed by disposition");
		expect(session.text).not.toContain(RECORD_HELD);
		// #5788 round 3 R3-5: the verdict itself, not only the missing line.
		expect(session.text).toContain(
			"No issues across 1 file diagnosed this session. ✓",
		);
		expect(session.details.clean).toBe(true);
		await s.write(V_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5788 round 3 R3-3, CodeRabbit TQxF): the turn-end note was
	// built from the whole record, so a typescript row the agent marked
	// false-positive still drew "not re-checked … source=lsp settles it"
	// beside the fresh ast-grep blocker that survived the policy (N1's sibling).
	it("leaves a marked unconfirmed row out of the turn-end note", async () => {
		boundary.lsp.enabled = true;
		boundary.ag.diag = true;
		const MIX =
			"const a = 1;\nBAD_CALL();\nfunction f(): unknown {\n  return 1;\n}\n";
		const s = await openSession("tm", "src/turn-marked.ts", V_FIXED);
		expect(await s.write(MIX)).toContain("🔴 STOP");
		boundary.lsp.primarySilent = { reason: "diagnostics-wait" };
		expect(await s.write(MIX + "// t\n")).toMatch(NOT_RECHECKED);
		await s.mark({
			line: 2,
			message: "Cannot find name 'BAD_CALL'.",
			rule: "ts:2304",
			tool: "lsp",
			disposition: "false-positive",
			reason: "#5788 R3-3 witness",
		});
		const end = await s.endTurn();
		expect(end).toContain("no-unknown-returns");
		expect(end).not.toMatch(NOT_RECHECKED);
		boundary.lsp.primarySilent = undefined;
		boundary.ag.diag = false;
		await s.write(V_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5788 round 3 R3-4, CodeRabbit TQxZ): the held-record
	// admission sat in the no-issues branch only, so a hint-only file in the
	// session sent the read down the listing branch, which said clean:true and
	// never named the held record while the commit gate blocked.
	it("names a held record when a hint-only file shares the session read", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("hh", "src/held-hint.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		await s.bash(V_FIXED_OTHER, "node tools/gen.js > src/held-hint.ts");
		boundary.lsp.mode = "answer";
		const target = path.join(tmpDir, "src/held-hint.ts");
		lspDouble.runWorkspaceDiagnostics = async () => [
			{ filePath: target, diagnostics: [], count: 0 },
		];
		await s.settleCall({ mode: "full", waitMs: 30000 });
		boundary.ag.other = 4;
		const hint = await openSession("hi", "src/hint-only.py", "x = 1\n");
		await hint.write("def g(): unknown {\n    return 1\n");
		boundary.ag.other = 0;
		expect(await s.commitBlocked()).toBe(true);
		const session = await s.sessionReport();
		expect(session.text).toContain(RECORD_HELD);
		expect(session.details.clean).not.toBe(true);
		await s.write(V_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5788 review N3): the session read judged every session's
	// blocker records, so another session's record withheld this session's
	// all-clear and named a file it never touched (#4921's rule for the turn end).
	it("reads only the calling session's blocker records for the all-clear", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("os", "src/owned.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		await s.bash(V_FIXED_OTHER, "node tools/gen.js > src/owned.ts");
		boundary.lsp.mode = "answer";
		// A clean sweep empties the session cache; the record stays.
		const target = path.join(tmpDir, "src/owned.ts");
		lspDouble.runWorkspaceDiagnostics = async () => [
			{ filePath: target, diagnostics: [], count: 0 },
		];
		await s.settleCall({ mode: "full", waitMs: 30000 });
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.sessionDiagnostics()).toContain(RECORD_HELD);
		expect(await s.sessionDiagnostics("pi-lens-4484-elsewhere")).not.toContain(
			RECORD_HELD,
		);
		await s.write(V_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5788 review F4, CodeRabbit C4): the per-write latch was
	// written when the line rendered, so a run whose delivery the 10 s bound
	// abandoned latched a line the agent never saw, and every later identical
	// replay was held back. This cell waits out the real bound once: the
	// abandonment under test is a production wall deadline, as in
	// tests/index-5108-opaque-blocker-disclosure-witness.test.ts.
	it("leaves the latch unwritten when the 10 s bound abandons the delivery", async () => {
		const carried = () =>
			getDegradationSummary().find(
				(group) => group.kind === "blocker-carried-unobserved",
			)?.count ?? 0;
		boundary.lsp.enabled = true;
		const s = await openSession("ab", "src/abandon.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "hold";
		const before = carried();
		// The held server outlasts the bound: the tool result shows nothing.
		expect(await s.write(withTail(20))).not.toMatch(STILL_UNFIXED);
		boundary.lsp.mode = "inconclusive";
		for (const release of boundary.lsp.held.splice(0)) release(true);
		// The abandoned run finishes on its own and carries the blocker.
		expect(await waitFor(carried, (n) => n > before)).toBeGreaterThan(before);
		// Its line never reached the agent, so the next write's is delivered.
		expect(await s.write(withTail(21))).toMatch(STILL_UNFIXED);
		boundary.lsp.mode = "answer";
		await s.write(V_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5788 round 3 R3-1, CodeRabbit TQw1): round 3 dropped the
	// host-abandon arm of the latch commit. A credited script write is
	// read-only class, so the host waits 500 ms; the run outlasted it, its
	// Still unfixed line never reached the agent, and the latch still
	// committed, holding back the next write's line. The git double answers
	// the opaque recovery as a repository whose base holds V1.
	it("leaves the latch unwritten when the 500 ms script bound abandons the delivery", async () => {
		const carried = () =>
			getDegradationSummary().find(
				(group) => group.kind === "blocker-carried-unobserved",
			)?.count ?? 0;
		boundary.lsp.enabled = true;
		const s = await openSession("sb", "src/script-bound.ts", V_FIXED);
		const target = path.join(tmpDir, "src/script-bound.ts");
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.git.answer = (args) => {
			const ok = (stdout: string) => ({ stdout, stderr: "", status: 0 });
			const changed = fs.readFileSync(target, "utf8") !== V1;
			if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree")
				return ok("true\n");
			if (args[0] === "status")
				return ok(changed ? " M src/script-bound.ts\0" : "");
			if (args[0] === "ls-files")
				return ok(args.includes("--others") ? "" : "src/script-bound.ts\n");
			if (args[0] === "for-each-ref") return ok("refs/heads/master\t\n");
			if (args[0] === "show") return ok(V1);
			return { stdout: "", stderr: "fatal: not a git repository", status: 128 };
		};
		const command =
			"node - <<'JS'\nrequire('fs').appendFileSync('src/script-bound.ts', '// s')\nJS";
		await s.emit("tool_call", {
			toolName: "bash",
			toolCallId: "sb-script",
			input: { command },
		});
		fs.writeFileSync(target, V1 + "// s\n");
		boundary.lsp.mode = "hold";
		const before = carried();
		// The held server outlasts the 500 ms bound: the host sees nothing.
		expect(
			await s.emit("tool_result", {
				toolName: "bash",
				toolCallId: "sb-script",
				input: { command },
				content: [{ type: "text", text: "" }],
			}),
		).not.toMatch(STILL_UNFIXED);
		boundary.lsp.mode = "inconclusive";
		for (const release of boundary.lsp.held.splice(0)) release(true);
		// The abandoned run finishes on its own and carries the blocker.
		expect(await waitFor(carried, (n) => n > before)).toBeGreaterThan(before);
		// Its line never reached the agent, so the next write's is delivered.
		expect(await s.write(V1 + "// next\n")).toMatch(STILL_UNFIXED);
		boundary.lsp.mode = "answer";
		await s.write(V_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5788 round 3 R3-2, CodeRabbit TQw5): the latch commit read
	// a liveness captured before the complexity adviser's await. A /new during
	// that await left it true, so the replaced run latched its line and held
	// back the replacement's first Still unfixed line. The git double holds
	// the adviser's ref read across the replacement.
	it("leaves the latch unwritten when the session is replaced during the adviser's read", async () => {
		boundary.lsp.enabled = true;
		const F =
			"export function q(n: number): number {\n  return n;\n}\nBAD_CALL();\n";
		const s = await openSession(
			"ra",
			"src/adviser.ts",
			"export const z = 1;\n",
		);
		expect(await s.write(F)).toContain("🔴 STOP");
		let reached!: () => void;
		const atRead = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release!: () => void;
		boundary.git.answer = (args) => {
			const none = {
				stdout: "",
				stderr: "fatal: not a git repository",
				status: 128,
			};
			if (args[0] !== "for-each-ref") return none;
			boundary.git.answer = undefined;
			reached();
			return new Promise((resolve) => {
				release = () => resolve(none);
			});
		};
		// The complexity adviser compares against the content its call saw.
		await s.emit("tool_call", {
			toolName: "write",
			toolCallId: "ra-seed",
			input: {
				path: path.join(tmpDir, "src/adviser.ts"),
				content: F + "// t\n",
			},
		});
		boundary.lsp.mode = "inconclusive";
		const stale = s.write(F + "// t\n");
		expect(
			await Promise.race([atRead.then(() => "held"), stale.then(() => "done")]),
		).toBe("held");
		await s.replace("pi-lens-4484-rb");
		boundary.lsp.mode = "answer";
		expect(await s.write(F)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		release();
		// The replaced run finishes with its line for a host that left.
		expect(await stale).toMatch(STILL_UNFIXED);
		expect(await s.write(F + "// u\n")).toMatch(STILL_UNFIXED);
		boundary.lsp.mode = "answer";
		await s.write(V_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (CodeRabbit C4 on #5788): a run of a session the host replaced
	// (`/new`) finished after the replacement's first verdict, carried the
	// replacement's record, and latched its unconfirmed line, so the
	// replacement's own first unconfirmed line was held back from an agent
	// that never saw it.
	it("leaves the latch unwritten by a run whose session was replaced", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("sa", "src/replaced.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "hold";
		let held!: () => void;
		const holding = new Promise<void>((resolve) => {
			held = resolve;
		});
		boundary.lsp.onHold = () => held();
		const stale = s.write(withTail(50));
		await holding;
		boundary.lsp.onHold = undefined;
		await s.replace("pi-lens-4484-sb");
		// The replacement's first write gets a verdict while the old run is held.
		boundary.lsp.mode = "answer";
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		for (const release of boundary.lsp.held.splice(0)) release(true);
		// The old run finishes with an unconfirmed line for a host that left.
		expect(await stale).toMatch(STILL_UNFIXED);
		expect(await s.write(withTail(51))).toMatch(STILL_UNFIXED);
		boundary.lsp.mode = "answer";
		await s.write(V_FIXED);
		await fixAndDrain(s);
	}, 120_000);
});

describe("#5790 witness: a cascade note with no finding does not hold the commit gate", () => {
	const TARGET = "src/cascade-target.ts";
	const NEIGHBOUR = "src/cascade-user.ts";
	const TARGET_FIXED = "export const a = 1;\nexport const b = 2;\n";
	const TARGET_BAD = "export const a = 1;\nBAD_CALL();\nexport const b = 2;\n";
	const TARGET_BAD_OTHER =
		"export const a = 1;\nBAD_CALL();\nexport const b = 3;\n";
	const NEIGHBOUR_FIXED =
		'import { a } from "./cascade-target.js";\nexport const c = a + 1;\n';
	const NEIGHBOUR_BAD = NEIGHBOUR_FIXED + "BAD_CALL();\n";
	const INCONCLUSIVE = "Cascade diagnostics inconclusive for 1 neighbor";
	const CASCADE_ERRORS = "Cascade errors in 1 neighbor file(s)";
	const HOLD_REMEDY =
		"no write of one file clears them now. Fix what they name, re-check each file (write it, or run lens_diagnostics source=lsp on it), and end the turn: this session's next turn end replaces them.";

	const blockerContent = (): string =>
		new CacheManager(false).readCache<{ blockerContent?: string }>(
			"turn-end-findings",
			tmpDir,
			Number.POSITIVE_INFINITY,
		)?.data?.blockerContent ?? "";

	/**
	 * The neighbour shares the cells' project directory, so the cell's cleanup
	 * deletes it before its fixing turn end, and no later cell sees it.
	 */
	const removeNeighbourOnCleanup = () => {
		const fixTarget = pendingCleanup;
		pendingCleanup = async () => {
			fs.rmSync(path.join(tmpDir, NEIGHBOUR), { force: true });
			await fixTarget?.();
		};
	};

	// Recurrence (#5790): a server silent through the turn end made the
	// cascade persist its "inconclusive" note into the commit gate's record.
	// No file owns that text, so every later write latched
	// blocking_provenance_untrusted, and the commit stayed refused after the
	// agent fixed and settled both files, until the next turn end.
	it("admits the commit once both files settle, with the cascade's inconclusive note delivered", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("cn", TARGET, TARGET_FIXED);
		removeNeighbourOnCleanup();
		await s.writeOther(NEIGHBOUR, NEIGHBOUR_BAD);
		expect(await s.write(TARGET_BAD)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		await s.write(TARGET_BAD_OTHER);
		const turnEnd = await s.endTurn();
		// The agent is still told; only the gate's record leaves the note out.
		expect(turnEnd).toContain(INCONCLUSIVE);
		const recorded = blockerContent();
		fs.writeFileSync(s.target, TARGET_FIXED);
		boundary.lsp.mode = "answer";
		expect(await s.settleCall({ source: "lsp", waitMs: 30000 })).toMatch(
			/confirmed clean/,
		);
		await s.writeOther(NEIGHBOUR, NEIGHBOUR_FIXED);
		expect(await s.commitBlocked()).toBe(false);
		// The gate's record held the edited file's section and not the note.
		expect(recorded).toContain("Unresolved from this turn — " + TARGET + ":");
		expect(recorded).not.toContain(INCONCLUSIVE);
		await fixAndDrain(s);
	}, 120_000);

	// The fail-closed direction: a cascade section that shows a neighbour's
	// finding is a blocker claim no file re-check retires, so the gate keeps
	// it after the edited file settles clean.
	it("keeps a cascade section that shows a neighbour's error in the gate after the edited file settles", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("ce", TARGET, TARGET_FIXED);
		removeNeighbourOnCleanup();
		// On disk before the session's writes: no write of this session
		// records it, so the cascade section is the gate's only hold on it.
		fs.writeFileSync(path.join(tmpDir, NEIGHBOUR), NEIGHBOUR_BAD);
		expect(await s.write(TARGET_BAD)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		await s.write(TARGET_BAD_OTHER);
		boundary.lsp.mode = "answer";
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain(CASCADE_ERRORS);
		expect(blockerContent()).toContain(CASCADE_ERRORS);
		fs.writeFileSync(s.target, TARGET_FIXED);
		expect(await s.settleCall({ source: "lsp", waitMs: 30000 })).toMatch(
			/confirmed clean/,
		);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5790 r3): the cascade section's neighbour error is text no
	// file owns, so no write clears it mid-turn, yet the refusal said "Write
	// the affected files again". A neighbour fixed outside pi and confirmed
	// clean by source=lsp kept its pending cascade error on every later turn.
	// The refusal now names the steps that clear the hold, and following them
	// does, for both ways of re-checking the neighbour.
	it.each(["write", "source=lsp", "source=lsp on its directory"] as const)(
		"names the steps that clear a held neighbour error, and following them clears it (%s)",
		async (recheck) => {
			boundary.lsp.enabled = true;
			const s = await openSession("ch" + recheck.length, TARGET, TARGET_FIXED);
			removeNeighbourOnCleanup();
			fs.writeFileSync(path.join(tmpDir, NEIGHBOUR), NEIGHBOUR_BAD);
			expect(await s.write(TARGET_BAD)).toContain("🔴 STOP");
			boundary.lsp.mode = "inconclusive";
			await s.write(TARGET_BAD_OTHER);
			boundary.lsp.mode = "answer";
			expect(await s.endTurn()).toContain(CASCADE_ERRORS);
			fs.writeFileSync(s.target, TARGET_FIXED);
			expect(await s.settleCall({ source: "lsp", waitMs: 30000 })).toMatch(
				/confirmed clean/,
			);
			const refusal = await s.commitReason();
			expect(refusal).toContain("blocking_provenance_untrusted");
			expect(refusal).not.toContain("Write the affected files again");
			expect(refusal).toContain(HOLD_REMEDY);
			// A turn end with the neighbour still broken holds it again, with the
			// same steps rather than "commit again".
			await s.endTurn();
			const held = await s.commitReason();
			expect(held).not.toContain("then commit again");
			expect(held).toContain(HOLD_REMEDY);
			// Follow it: fix the neighbour, re-check it, end the turn.
			if (recheck === "write") await s.writeOther(NEIGHBOUR, NEIGHBOUR_FIXED);
			else {
				fs.writeFileSync(path.join(tmpDir, NEIGHBOUR), NEIGHBOUR_FIXED);
				// The directory form goes through the batch collector, a second
				// caller of the confirmed-clean hook.
				const probed =
					recheck === "source=lsp" ? NEIGHBOUR : path.dirname(NEIGHBOUR);
				expect(await s.settleOther(probed)).toMatch(
					recheck === "source=lsp" ? /confirmed clean/ : /No diagnostics found/,
				);
			}
			await s.endTurn();
			expect(await s.commitReason()).toBe("");
			await fixAndDrain(s);
		},
		120_000,
	);

	// The other direction (#4495 round 3's rule, now on the probe path): a
	// probe whose read started before the cascade observation that recorded
	// the error cannot speak for it, so the error stays pending.
	it("keeps a pending neighbour error that a source=lsp read older than its record cannot speak for", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("co", TARGET, TARGET_FIXED);
		removeNeighbourOnCleanup();
		const neighbour = path.join(tmpDir, NEIGHBOUR);
		fs.writeFileSync(neighbour, NEIGHBOUR_FIXED);
		const pending = () =>
			listCascadePendingNeighbors().filter((e) => e.filePath === neighbour);
		try {
			recordDeliveredCascadeNeighbor(
				neighbour,
				[
					{
						id: "lsp:2304:3",
						message: "Cannot find name 'BAD_CALL'.",
						filePath: neighbour,
						line: 3,
						column: 1,
						severity: "error",
						semantic: "blocking",
						tool: "lsp",
						rule: "ts:2304",
					},
				],
				0,
				Date.now() + 60_000,
			);
			expect(await s.settleOther(NEIGHBOUR)).toMatch(/confirmed clean/);
			expect(pending()).toHaveLength(1);
		} finally {
			forgetCascadePendingNeighbor(neighbour);
		}
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5790 review F1, the reviewer's witness): a file of the
	// record edited outside pi after the turn end reaches the
	// file_content_changed refusal, which named "Write the affected files
	// again" while the record held a neighbour's error no write clears.
	it("names the clearing steps when a file of a held record changes outside pi", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("cc", TARGET, TARGET_FIXED);
		removeNeighbourOnCleanup();
		fs.writeFileSync(path.join(tmpDir, NEIGHBOUR), NEIGHBOUR_BAD);
		// A clean edit of the target: the only blocker is the neighbour's.
		expect(await s.write(TARGET_FIXED + "export const d = 4;\n")).not.toContain(
			"🔴 STOP",
		);
		expect(await s.endTurn()).toContain(CASCADE_ERRORS);
		fs.writeFileSync(s.target, TARGET_FIXED);
		const refusal = await s.commitReason();
		expect(refusal).toContain("(file_content_changed)");
		expect(refusal).not.toContain("Write the affected files again");
		expect(refusal).toContain(HOLD_REMEDY);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5804, #5790 r3 rows V2 to V3): the neighbour's cascade error
	// held the commit gate, then the neighbour was rewritten while the server
	// gave no verdict, with the error still in its bytes. The turn end forgot
	// the neighbour's pending error (an edited file's own dispatch "reports
	// it") although that dispatch reported nothing, and the gate admitted the
	// commit with the error on disk.
	it("keeps a neighbour's pending error when its rewrite gets no server verdict", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("cf", TARGET, TARGET_FIXED);
		removeNeighbourOnCleanup();
		const neighbour = path.join(tmpDir, NEIGHBOUR);
		fs.writeFileSync(neighbour, NEIGHBOUR_BAD);
		expect(await s.write(TARGET_BAD)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		await s.write(TARGET_BAD_OTHER);
		boundary.lsp.mode = "answer";
		expect(await s.endTurn()).toContain(CASCADE_ERRORS);
		fs.writeFileSync(s.target, TARGET_FIXED);
		expect(await s.settleCall({ source: "lsp", waitMs: 30000 })).toMatch(
			/confirmed clean/,
		);
		// V2: the neighbour's error alone holds the gate.
		expect(await s.commitReason()).toContain("blocking_provenance_untrusted");
		// The neighbour is rewritten, the error still in its bytes, and the
		// server gives no verdict on the rewrite.
		boundary.lsp.mode = "inconclusive";
		const rewrittenAt = Date.now();
		await s.writeOther(NEIGHBOUR, NEIGHBOUR_BAD + "export const d = 4;\n");
		boundary.lsp.mode = "answer";
		await s.endTurn();
		try {
			// V3: the error is still on disk, so the gate still refuses, and the
			// record carries it to the rewrite: a claim about bytes pi wrote, not
			// an edit outside pi that the next turn end would name once and forget.
			expect(fs.readFileSync(neighbour, "utf8")).toContain("BAD_CALL();");
			expect(await s.commitReason()).toContain(HOLD_REMEDY);
			// The unanswered write is counted once for the neighbour.
			expect(
				getDegradationSummary().find(
					(c) => c.kind === "blocker-carried-unobserved",
				)?.latestReasons,
			).toContainEqual(
				expect.objectContaining({
					subject: expect.stringContaining("cascade-user.ts"),
				}),
			);
			const [held] = listCascadePendingNeighbors().filter(
				(e) => e.filePath === neighbour,
			);
			expect(held?.errorCount).toBe(1);
			expect(held?.checkedAt).toBeGreaterThanOrEqual(rewrittenAt);
		} finally {
			forgetCascadePendingNeighbor(neighbour);
		}
		await s.writeOther(NEIGHBOUR, NEIGHBOUR_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5804, a write is a transition): the last write of the turn
	// decides. A write a server answered for, then one it did not, leaves the
	// file unconfirmed; the first write's answer must not speak for the second.
	it("keeps a neighbour's pending error when an unanswered write follows an answered one", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("cw", TARGET, TARGET_FIXED);
		removeNeighbourOnCleanup();
		const neighbour = path.join(tmpDir, NEIGHBOUR);
		fs.writeFileSync(neighbour, NEIGHBOUR_BAD);
		expect(await s.write(TARGET_BAD)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		await s.write(TARGET_BAD_OTHER);
		boundary.lsp.mode = "answer";
		expect(await s.endTurn()).toContain(CASCADE_ERRORS);
		fs.writeFileSync(s.target, TARGET_FIXED);
		expect(await s.settleCall({ source: "lsp", waitMs: 30000 })).toMatch(
			/confirmed clean/,
		);
		try {
			await s.writeOther(NEIGHBOUR, NEIGHBOUR_FIXED);
			boundary.lsp.mode = "inconclusive";
			await s.writeOther(NEIGHBOUR, NEIGHBOUR_BAD + "export const d = 4;\n");
			boundary.lsp.mode = "answer";
			await s.endTurn();
			expect(fs.readFileSync(neighbour, "utf8")).toContain("BAD_CALL();");
			expect(await s.commitReason()).toContain(HOLD_REMEDY);
		} finally {
			forgetCascadePendingNeighbor(neighbour);
		}
		await s.writeOther(NEIGHBOUR, NEIGHBOUR_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5804, a timeout is a transition): the file's earlier write
	// was answered, and a later write is still in flight when the turn ends,
	// so it has published no verdict. The earlier answer must not speak for
	// the bytes now on disk.
	it("keeps a neighbour's pending error while a later write of it is still in flight at the turn end", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("cx", TARGET, TARGET_FIXED);
		removeNeighbourOnCleanup();
		const neighbour = path.join(tmpDir, NEIGHBOUR);
		fs.writeFileSync(neighbour, NEIGHBOUR_BAD);
		expect(await s.write(TARGET_BAD)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		await s.write(TARGET_BAD_OTHER);
		boundary.lsp.mode = "answer";
		expect(await s.endTurn()).toContain(CASCADE_ERRORS);
		fs.writeFileSync(s.target, TARGET_FIXED);
		expect(await s.settleCall({ source: "lsp", waitMs: 30000 })).toMatch(
			/confirmed clean/,
		);
		let inFlight: Promise<void> | undefined;
		try {
			await s.writeOther(NEIGHBOUR, NEIGHBOUR_FIXED);
			boundary.lsp.mode = "hold";
			let held!: () => void;
			const holding = new Promise<void>((resolve) => {
				held = resolve;
			});
			boundary.lsp.onHold = () => held();
			inFlight = s.writeOther(
				NEIGHBOUR,
				NEIGHBOUR_BAD + "export const d = 4;\n",
			);
			await holding;
			boundary.lsp.onHold = undefined;
			await s.endTurn();
			expect(fs.readFileSync(neighbour, "utf8")).toContain("BAD_CALL();");
			expect(await s.commitReason()).toContain(HOLD_REMEDY);
		} finally {
			boundary.lsp.mode = "answer";
			for (const release of boundary.lsp.held.splice(0)) release(true);
			await inFlight;
			forgetCascadePendingNeighbor(neighbour);
		}
		await s.writeOther(NEIGHBOUR, NEIGHBOUR_FIXED);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (#5790 review F2): a source=lsp probe covers the sources its
	// servers answered for, so it retires only the pending rows those sources
	// raised. A knip row it never observed stayed forgotten with the lsp ones.
	it.each([
		[["knip"], ["knip"]],
		[["lsp", "knip"], ["knip"]],
		[["lsp"], []],
		[[""], [""]],
	] as const)(
		"retires only the pending neighbour rows a source=lsp probe covered (%j keeps %j)",
		async (tools, kept) => {
			boundary.lsp.enabled = true;
			const s = await openSession(
				"cv" + tools.join("").length,
				TARGET,
				TARGET_FIXED,
			);
			removeNeighbourOnCleanup();
			const neighbour = path.join(tmpDir, NEIGHBOUR);
			fs.writeFileSync(neighbour, NEIGHBOUR_FIXED);
			const pendingTools = () =>
				listCascadePendingNeighbors()
					.filter((e) => e.filePath === neighbour)
					.flatMap((e) => e.errors.map((error) => error.tool));
			try {
				recordDeliveredCascadeNeighbor(
					neighbour,
					tools.map((tool, index) => ({
						id: tool + ":" + index,
						message: "finding " + index,
						filePath: neighbour,
						line: index + 1,
						column: 1,
						severity: "error" as const,
						semantic: "blocking" as const,
						tool,
					})),
					0,
					Date.now() - 60_000,
				);
				expect(await s.settleOther(NEIGHBOUR)).toMatch(/confirmed clean/);
				expect(pendingTools()).toEqual(kept);
			} finally {
				forgetCascadePendingNeighbor(neighbour);
			}
			await fixAndDrain(s);
		},
		120_000,
	);
});

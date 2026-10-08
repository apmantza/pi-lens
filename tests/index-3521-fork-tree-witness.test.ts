/**
 * #3521: the read guard across `/tree`, `/fork`, `/clone`, resume and
 * `pi --fork <path>`, driven through pi 0.85's REAL `AgentSessionRuntime`.
 *
 * Why the real host and not the pi mock: pi re-runs the extension factory for
 * a forked runtime, and `/tree` stays in one activation. The earlier fork
 * tests emitted `session_before_fork` and `session_start` on ONE mock
 * activation, which pi never does, so a closure-local fork stash looked alive
 * while it was dead on every real `/fork`. Here pi itself runs the factory
 * (`extensionFactories: [extension]`, the same module instance these tests
 * import), builds each branch, and emits every lifecycle event. Tool calls go
 * through the session's installed agent hooks (`beforeToolCall` ->
 * `tool_call`, `afterToolCall` -> `tool_result`), reads use pi's real `read`
 * tool, and the matching session entries are appended so `/fork` and `/tree`
 * see the conversation the guard saw. No model is called.
 *
 * The rule under test: after a conversation move, the guard holds exactly
 * the reads whose tool call's `toolResult` is on the new branch, each record
 * kept whole, with no FileTime stamp, so every edit is judged line by line
 * against disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentSessionRuntime,
	type ExtensionAPI,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createReadToolDefinition,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import extension from "../index.js";
import { makeLspServiceDouble } from "./support/lsp-service-double.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { takeHandoff } from "../clients/session-scope.js";
import { exportWidgetState } from "../clients/widget-state.js";
import { queueAgentAdvisory } from "../clients/agent-nudge.js";
import { AstGrepClient } from "../clients/ast-grep-client.js";
import { CacheManager } from "../clients/cache-manager.js";
import {
	deferRunnerFindings,
	pendingRunnerFindingsSize,
	resetPendingRunnerFindings,
} from "../clients/dispatch/pending-runner-findings.js";
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import { recordMemorySampleOutcome } from "../clients/memory-sampler.js";
import {
	_observedMutationStateForTests,
	_setObservedTurnBudgetForTests,
	hasPendingObservation,
	OBSERVED_TURN_BUDGET_MS,
} from "../clients/observed-mutation.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	cleanupTestEnvironmentsDrained,
	drainBackgroundWritesForTests,
	setupTestEnvironment,
} from "./clients/test-utils.js";

// This file runs 25 real session_starts with PI_LENS_TEST_MODE=0: each appends
// the config-resolution lines to sessionstart.log and a `config_resolved` row
// to latency.log, and beforeEach truncates latency.log. The harness's
// per-worker PI_LENS_HOME (#3721) keeps those writes off every other worker's
// sink; the loggers bind their paths at load, so the home is the harness's.

/**
 * #3676: the LSP service is the one process boundary the quick fix's real
 * apply path crosses. Armed only by the #3676 describe; every other test in
 * this file sees the real service.
 */
const lspDouble = vi.hoisted(() => ({ service: undefined as unknown }));
vi.mock("../clients/lsp/index.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../clients/lsp/index.js")>();
	return {
		...original,
		getLSPService: () =>
			(lspDouble.service as ReturnType<typeof original.getLSPService>) ??
			original.getLSPService(),
	};
});

/**
 * #3613: the dispatch pipeline is doubled at its boundary for the S4 turn
 * describe only, so a tool result carries a known code-quality warning
 * through the real tool_result, turn_start and turn_end handlers. Every other
 * test sees the real pipeline.
 */
const pipelineDouble = vi.hoisted(() => ({
	result: undefined as undefined | ((filePath: string) => unknown),
	/** The files the doubled pipeline analysed, in order. */
	analysed: [] as string[],
}));
vi.mock("../clients/pipeline.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../clients/pipeline.js")>();
	return {
		...original,
		runPipeline: (async (ctx, deps) =>
			pipelineDouble.result
				? (pipelineDouble.analysed.push(ctx.filePath),
					pipelineDouble.result(ctx.filePath))
				: original.runPipeline(ctx, deps)) as typeof original.runPipeline,
	};
});

const FLAGS = new Map<string, boolean>([
	["no-lsp", true],
	["no-autofix", true],
	["no-autoformat", true],
	["no-tests", true],
	["no-opengrep", true],
	["no-delta", true],
]);

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * pi-lens's session_start schedules background writes (the project
 * snapshot) into `PILENS_DATA_DIR`, which lives under `root`; they can land
 * after a test ends and recreate the directory. Drain them before removing
 * it, and sweep the prefix once more after the file.
 */
const TMP_PREFIX = "pi-lens-3521-";
let env: ReturnType<typeof setupTestEnvironment>;
let root: string;
let cwd: string;
let agentDir: string;
let sessionsDir: string;
let previousDataDir: string | undefined;
let previousTestMode: string | undefined;
let nextMtimeMs: number;
const runtimes: AgentSessionRuntime[] = [];
/** Errors pi reported from an extension handler (the `onError` binding). */
const extensionErrors: unknown[] = [];

beforeEach(async () => {
	_resetSessionLifecycleForTests();
	env = setupTestEnvironment(TMP_PREFIX);
	root = env.tmpDir;
	cwd = path.join(root, "proj");
	agentDir = path.join(root, "agent");
	sessionsDir = path.join(root, "sessions");
	for (const dir of [cwd, path.join(cwd, ".git"), agentDir, sessionsDir])
		fs.mkdirSync(dir, { recursive: true });
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(root, "data");
	// The latency row and the turn_end sidecar are both off in test mode.
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	// Strictly increasing and in the past: every write is visible to FileTime,
	// and none postdates a guard's session anchor by accident.
	nextMtimeMs = Date.now() - 1_800_000;
	clearLatencyLog();
	await flushLatencyLog();
});

afterEach(async () => {
	try {
		for (const runtime of runtimes.splice(0)) await runtime.dispose();
		await drainBackgroundWritesForTests();
		expect(extensionErrors.splice(0)).toEqual([]);
	} finally {
		_resetSessionLifecycleForTests();
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
		env.cleanup();
	}
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained(TMP_PREFIX);
});

async function startRuntime(
	sessionManager: SessionManager,
	alongside: Array<(pi: ExtensionAPI) => void> = [],
	/** Factories whose handlers pi runs before pi-lens's (#3881). */
	ahead: Array<(pi: ExtensionAPI) => void> = [],
	runtimeCwd = cwd,
	/**
	 * #3855 PR8: the first bind's `session_start`, as an SDK caller passes
	 * `createAgentSessionFromServices({ sessionStartEvent })` (pi `sdk.js`).
	 * Later replacements carry pi's own event.
	 */
	firstStartEvent?: { type: "session_start"; reason: "reload" | "fork" },
): Promise<AgentSessionRuntime> {
	let firstEvent = firstStartEvent;
	const runtime = await createAgentSessionRuntime(
		async ({
			cwd: runtimeCwd,
			sessionManager: sm,
			sessionStartEvent: event,
		}) => {
			const sessionStartEvent = event ?? firstEvent;
			firstEvent = undefined;
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				extensionFlagValues: FLAGS,
				resourceLoaderOptions: {
					extensionFactories: [...ahead, extension, ...alongside],
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: sm,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{ cwd: runtimeCwd, agentDir, sessionManager },
	);
	// Bound once with an error listener, as pi's modes bind: `/reload` emits
	// its session_start only to a session with host bindings, and a handler
	// error then reaches the listener instead of vanishing.
	const bindings = { onError: (error: unknown) => extensionErrors.push(error) };
	runtime.setRebindSession(async () => {
		await runtime.session.bindExtensions(bindings);
	});
	await runtime.session.bindExtensions(bindings);
	runtimes.push(runtime);
	return runtime;
}

/** A conversation driven through one runtime's live session. */
function conversation(runtime: AgentSessionRuntime) {
	const S = () => runtime.session;
	const assistant = (
		content: unknown[],
		stopReason: "toolUse" | "stop" = "toolUse",
	) => ({
		role: "assistant" as const,
		content,
		api: "x",
		provider: "x",
		model: "x",
		usage,
		stopReason,
		timestamp: Date.now(),
	});
	const append = (message: unknown): string =>
		S().sessionManager.appendMessage(
			message as Parameters<SessionManager["appendMessage"]>[0],
		);
	const toolCall = async (
		id: string,
		name: string,
		args: Record<string, unknown>,
	) => {
		const callEntry = append(
			assistant([{ type: "toolCall", id, name, arguments: args }]),
		);
		const verdict = (await S().agent.beforeToolCall?.({
			toolCall: { type: "toolCall", id, name, arguments: args },
			args,
		} as never)) as { block?: boolean; reason?: string } | undefined;
		return { callEntry, verdict };
	};
	const toolResult = async (
		id: string,
		name: string,
		args: Record<string, unknown>,
		content: unknown[],
		isError = false,
	): Promise<string> => {
		const patched = (await S().agent.afterToolCall?.({
			toolCall: { type: "toolCall", id, name, arguments: args },
			args,
			result: { content, details: undefined },
			isError,
		} as never)) as { content?: unknown[] } | undefined;
		return append({
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: patched?.content ?? content,
			isError,
			timestamp: Date.now(),
		});
	};
	return {
		S,
		user: (text: string): string =>
			append({ role: "user", content: text, timestamp: Date.now() }),
		done: (): string =>
			append(assistant([{ type: "text", text: "done" }], "stop")),
		async read(id: string, file: string) {
			const args = { path: file };
			const { callEntry } = await toolCall(id, "read", args);
			const result = await createReadToolDefinition(cwd).execute(
				id,
				args,
				undefined,
				undefined,
				{ cwd } as never,
			);
			const resultEntry = await toolResult(id, "read", args, result.content);
			return { callEntry, resultEntry };
		},
		/** A positional edit of one line; applied to disk only when allowed. */
		async editLine(
			id: string,
			file: string,
			line: number,
			newText: string,
			apply = true,
		): Promise<string> {
			const args = {
				path: file,
				edits: [{ range: { start: { line }, end: { line } }, newText }],
			};
			const { verdict } = await toolCall(id, "edit", args);
			const blocked = verdict?.block === true;
			if (!blocked && apply) {
				const lines = fs.readFileSync(file, "utf8").split("\n");
				lines.splice(line - 1, 1, newText);
				writeNow(file, lines.join("\n"));
				await toolResult(id, "edit", args, [{ type: "text", text: "ok" }]);
			} else {
				await toolResult(
					id,
					"edit",
					args,
					[{ type: "text", text: verdict?.reason ?? "blocked" }],
					true,
				);
			}
			return blocked ? `BLOCK: ${firstLine(verdict?.reason)}` : "ALLOW";
		},
		async write(id: string, file: string, content: string) {
			const args = { path: file, content };
			const { verdict } = await toolCall(id, "write", args);
			writeNow(file, content);
			await toolResult(id, "write", args, [{ type: "text", text: "ok" }]);
			return verdict?.block === true ? "BLOCK" : "ALLOW";
		},
		/** A bash call whose output the host returned as `output`. */
		async bash(id: string, command: string, output: string) {
			const args = { command };
			await toolCall(id, "bash", args);
			return toolResult(id, "bash", args, [{ type: "text", text: output }]);
		},
		/** One of pi-lens's own tools, executed as the host would. */
		async ownTool(id: string, name: string, args: Record<string, unknown>) {
			await toolCall(id, name, args);
			const tool = S().getToolDefinition(name);
			if (!tool) throw new Error(`tool ${name} is not registered`);
			const result = (await tool.execute(
				id,
				args as never,
				undefined,
				undefined,
				{
					cwd,
				} as never,
			)) as { content: unknown[] };
			return toolResult(id, name, args, result.content);
		},
	};
}

function firstLine(text: string | undefined): string {
	return String(text ?? "").split("\n")[0] ?? "";
}

/** A file authored before this session: its mtime is an hour old. */
function fixture(name: string, lines: number): string {
	const file = path.join(cwd, name);
	fs.writeFileSync(
		file,
		Array.from({ length: lines }, (_, i) => `${name}-line${i + 1}`).join("\n"),
	);
	const old = (Date.now() - 3_600_000) / 1000;
	fs.utimesSync(file, old, old);
	return file;
}

/** A write with a strictly later mtime, so FileTime always sees it. */
function writeNow(file: string, content: string): void {
	fs.writeFileSync(file, content);
	nextMtimeMs += 10_000;
	fs.utimesSync(file, nextMtimeMs / 1000, nextMtimeMs / 1000);
}

const ZERO_READ = expect.stringMatching(/^BLOCK: .*Edit without read/);

async function branchRetainedRows(): Promise<Record<string, unknown>[]> {
	await flushLatencyLog();
	const text = fs.existsSync(getLatencyLogPath())
		? fs.readFileSync(getLatencyLogPath(), "utf8")
		: "";
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((row) => row.phase === "read_guard_branch_retained")
		.map((row) => row.metadata as Record<string, unknown>);
}

/**
 * Let a fire-and-forget sidecar write land. The save is deliberately not
 * awaited by its hook (#2523), so the test yields the event loop — no timer —
 * until the atomic rename is visible.
 */
async function sidecarSettled(sessionId: string): Promise<void> {
	const file = path.join(
		getProjectDataDir(cwd),
		"sessions",
		`${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
	);
	for (let i = 0; i < 5000 && !fs.existsSync(file); i++)
		await new Promise<void>((resolve) => setImmediate(resolve));
	expect(fs.existsSync(file), `sidecar ${file}`).toBe(true);
}

/** pi-lens persists its sidecar at turn_end; emit one the way pi does. */
async function turnEnd(
	runtime: AgentSessionRuntime,
	awaitSidecar = true,
): Promise<void> {
	await runtime.session.extensionRunner.emit({
		type: "turn_end",
		turnIndex: 0,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "x",
			provider: "x",
			model: "x",
			usage,
			stopReason: "stop",
			timestamp: Date.now(),
		},
		toolResults: [],
	} as never);
	if (awaitSidecar)
		await sidecarSettled(runtime.session.sessionManager.getSessionId());
}

describe("#3521 /tree keeps only the reads on the new branch", () => {
	it("blocks an edit backed only by a read on the abandoned branch (A1)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		c.done();
		const u2 = c.user("prompt 2");
		await c.read("call_read_b", b);
		c.done();

		await c.S().navigateTree(u2);

		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
		expect((await branchRetainedRows()).at(-1)).toMatchObject({
			trigger: "tree",
			source: "live",
			kept: 0,
			dropped: 1,
			branchReadable: true,
		});
	});

	it("blocks an edit of a file written only on the abandoned branch (A2)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const file = path.join(cwd, "c.conf");
		c.user("prompt 1");
		c.done();
		const u2 = c.user("prompt 2");
		expect(await c.write("call_write_c", file, "c1\nc2\nc3\nc4")).toBe("ALLOW");
		c.done();

		await c.S().navigateTree(u2);

		// pi never reverts files: the write is still on disk, the conversation
		// no longer shows it.
		expect(fs.existsSync(file)).toBe(true);
		expect(await c.editLine("post_c", file, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("keeps a file overwritten on the kept branch editable through its creation read (A2 inverse)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const file = fixture("c.conf", 4);
		c.user("prompt 1");
		expect(await c.write("call_write_c", file, "c1\nc2\nc3\nc4")).toBe("ALLOW");
		c.done();
		const u2 = c.user("prompt 2");
		c.done();

		await c.S().navigateTree(u2);

		expect(await c.editLine("post_c", file, 2, "Y", false)).toBe("ALLOW");
	});

	it("needs a re-read of a brand-new file created on the kept branch (writtenThisSession is cleared)", async () => {
		// A write that CREATES a file returns from tool_call before
		// noteCreatedFile (`targetMissing`), so no creation read carries its
		// tool call; only `writtenThisSession` vouched for it, and a move clears
		// that. The safe direction: one re-read, never an allow.
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const file = path.join(cwd, "new.conf");
		c.user("prompt 1");
		await c.write("call_write_new", file, "n1\nn2\nn3");
		c.done();
		const u2 = c.user("prompt 2");
		c.done();

		await c.S().navigateTree(u2);

		expect(await c.editLine("post_new", file, 2, "Y", false)).toEqual(
			ZERO_READ,
		);
	});

	it("blocks an edit of a line only the abandoned branch rewrote (A3)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_b1", b);
		c.done();
		const u2 = c.user("prompt 2");
		expect(
			await c.editLine("call_edit_b", b, 2, "EDITED-ON-ABANDONED-BRANCH"),
		).toBe("ALLOW");
		c.done();

		await c.S().navigateTree(u2);

		// The conversation shows line 2 as `b.conf-line2`; disk holds the
		// abandoned branch's edit. Neither its own-edit record nor its FileTime
		// stamp may vouch for that line (NoStaleAllow).
		expect(fs.readFileSync(b, "utf8").split("\n")[1]).toBe(
			"EDITED-ON-ABANDONED-BRANCH",
		);
		expect(await c.editLine("post_b2", b, 2, "Y", false)).toMatch(/^BLOCK: /);
		// The kept read stays whole: a line the abandoned branch left alone is
		// still editable (NoFalseBlock, A11).
		expect(await c.editLine("post_b4", b, 4, "Y", false)).toBe("ALLOW");
	});

	it("keeps a read when /tree lands on its toolResult, drops it on the call alone (A4)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		const { callEntry, resultEntry } = await c.read("call_read_b", b);
		c.done();

		await c.S().navigateTree(resultEntry);
		expect(await c.editLine("post_b_result", b, 2, "Y", false)).toBe("ALLOW");

		// Mid-turn: the assistant entry that issued the call, without its
		// result. The agent never saw the bytes.
		await c.S().navigateTree(callEntry);
		expect(await c.editLine("post_b_call", b, 2, "Y", false)).toEqual(
			ZERO_READ,
		);
	});

	it("needs a re-read after a /tree round trip back to a branch (A5: records are deleted, not parked)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const a = fixture("a.conf", 6);
		c.user("prompt 1");
		c.done();
		const u2 = c.user("prompt 2");
		await c.read("call_read_a", a);
		const leafA = c.done();

		await c.S().navigateTree(u2);
		c.user("prompt 2 on branch B");
		c.done();
		await c.S().navigateTree(leafA);

		// The read is back in the conversation, but the guard deleted it when it
		// left branch A. Deferred parking (#3521): one re-read, never an allow.
		expect(await c.editLine("post_a", a, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("blocks an edit of a large (unhashed) file after a move until it is re-read (A10)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		// Past PI_LENS_READ_GUARD_HASH_MAX_LINES (3000): the read has no hashes.
		const big = fixture("big.conf", 3100);
		c.user("prompt 1");
		await c.read("call_read_big", big);
		c.done();
		const u2 = c.user("prompt 2");
		expect(await c.editLine("call_edit_big", big, 2, "EDITED")).toBe("ALLOW");
		c.done();

		await c.S().navigateTree(u2);

		expect(await c.editLine("post_big", big, 2, "Y", false)).toMatch(
			/^BLOCK: .*File modified since read/,
		);
	});

	it("drops a read whose tool result carried no tool-call id", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		// OpenAI-compatible servers can send no id; pi stores `""`.
		const { resultEntry } = await c.read("", b);
		c.done();

		// The read's result stays on the branch; only its id is missing.
		await c.S().navigateTree(resultEntry);

		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("credits a sibling branch's read that reuses the same tool-call id (accepted residual, #3521 D1)", async () => {
		// Pinned so the residual is visible, not fixed: pi stores provider ids
		// verbatim, and Mistral's fallback (`toolcall:<index>`), OpenAI-
		// compatible index ids, and Google's per-message ids can repeat across
		// responses. Matching on the id alone cannot tell the two calls apart.
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		c.done();
		const u2 = c.user("prompt 2 on branch X");
		await c.read("call_0", b);
		const leafX = c.done();

		await c.S().navigateTree(u2);
		c.user("prompt 2 on branch Y");
		await c.read("call_0", a);
		c.done();
		await c.S().navigateTree(leafX);

		// Branch X never read a.conf; Y's record rides X's `call_0` result.
		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
	});

	it("wipes a live concurrent secondary's read on a primary /tree (accepted residual, #3521 F2)", async () => {
		// Pinned so a later fix flips it deliberately: the read guard is the
		// module-level runtime's, shared with an in-process subagent, and the
		// primary's retainBranch drops every id its own branch lacks. The cost
		// is one re-read in the subagent, never an allow.
		const primary = conversation(
			await startRuntime(SessionManager.inMemory(cwd)),
		);
		const p1 = primary.user("primary prompt 1");
		primary.done();
		primary.user("primary prompt 2");
		primary.done();
		const secondary = conversation(
			await startRuntime(SessionManager.inMemory(cwd)),
		);
		const f = fixture("f.conf", 6);
		secondary.user("subagent prompt");
		await secondary.read("sub_read_f", f);
		expect(await secondary.editLine("sub_edit_pre", f, 2, "Y", false)).toBe(
			"ALLOW",
		);

		await primary.S().navigateTree(p1);

		expect(await secondary.editLine("sub_edit_post", f, 3, "Y", false)).toEqual(
			ZERO_READ,
		);
	});

	it("leaves the primary's guard alone when a concurrent secondary moves its own tree (A12)", async () => {
		const primary = conversation(
			await startRuntime(SessionManager.inMemory(cwd)),
		);
		const b = fixture("b.conf", 6);
		primary.user("prompt 1");
		await primary.read("call_read_b", b);
		primary.done();

		// An in-process subagent: a second live runtime in the same process,
		// classified concurrent-secondary. Its branch has no tool results.
		const secondary = conversation(
			await startRuntime(SessionManager.inMemory(cwd)),
		);
		const s1 = secondary.user("subagent prompt");
		secondary.done();
		await secondary.S().navigateTree(s1);

		expect(await primary.editLine("post_b", b, 2, "Y", false)).toBe("ALLOW");
	});
});

describe("#3521 a /tree during agent_settled work gets no credit from it (shape 22)", () => {
	// pi marks the run inactive BEFORE it awaits the agent_settled handlers,
	// so navigateTree can run while pi-lens's settled sweep is replaying
	// drift into the read guard. Review F1 (probe-settled-race): the replay's
	// `recordWritten` landed after `retainBranch` cleared the authored set and
	// a zero-read edit on the new branch was ALLOWED.
	async function settledThenTree(race: boolean): Promise<string> {
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		const c = conversation(runtime);
		const f = fixture("f.conf", 6);
		c.user("prompt 1");
		c.done();
		const u2 = c.user("prompt 2 on branch X");
		await c.read("call_read_f", f);
		c.done();
		// A first settle baselines the observed ledger for the tracked file.
		await runtime.session.extensionRunner.emit({
			type: "agent_settled",
		} as never);
		// A third-party write after the read: the drift the sweep replays.
		const lines = fs.readFileSync(f, "utf8").split("\n");
		lines[1] = "EXTERNAL";
		writeNow(f, lines.join("\n"));
		if (race) {
			const settled = runtime.session.extensionRunner.emit({
				type: "agent_settled",
			} as never);
			await c.S().navigateTree(u2);
			await settled;
		} else {
			await runtime.session.extensionRunner.emit({
				type: "agent_settled",
			} as never);
			await c.S().navigateTree(u2);
		}
		// Branch Y never read f.conf.
		return c.editLine("post_f", f, 4, "Y", false);
	}

	it("does not credit a settled-sweep replay that lands after the /tree", async () => {
		expect(await settledThenTree(true)).toEqual(ZERO_READ);
	});

	it("blocks the same edit when the settle finishes before the /tree", async () => {
		expect(await settledThenTree(false)).toEqual(ZERO_READ);
	});
});

describe("#3676 the quick fix is credited to the branch its report was produced on", () => {
	// Recurrence: #3669 round-3 verify F-A. The report the quick fix acts on
	// survives a /tree (it moves neither projectSeq nor fileSeq), and a read-only
	// turn on the new branch publishes no report over it. The settle then applied
	// the fix and credited it with the settle's own epoch, so branch Y's agent
	// could edit a file it had never read.
	const ACTIONABLE_FLAGS = [
		"lens-actionable-warnings",
		"lens-actionable-warning-actions",
		"lens-actionable-warning-all",
		"lens-actionable-warning-autofix",
	];

	beforeEach(() => {
		for (const flag of ACTIONABLE_FLAGS) FLAGS.set(flag, true);
	});

	afterEach(() => {
		for (const flag of ACTIONABLE_FLAGS) FLAGS.delete(flag);
		lspDouble.service = undefined;
	});

	/** The LSP boundary: a warning with a preferred quick fix, served while warm. */
	function armLsp(file: string, warm: () => boolean) {
		const range = {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 5 },
		};
		lspDouble.service = makeLspServiceDouble({
			supportsLSP: () => warm(),
			openFile: async () => undefined,
			getLastKnownDiagnostics: () => [
				{
					severity: 2,
					message: "replace this value",
					code: "fix-value",
					source: "eslint",
					serverId: "eslint",
					range,
				},
			],
			codeAction: async () => [
				{
					title: "Fix it",
					kind: "quickfix",
					isPreferred: true,
					edit: {
						changes: {
							[pathToFileURL(file).href]: [{ range, newText: "FIXED" }],
						},
					},
				},
			],
		});
	}

	const settle = (runtime: AgentSessionRuntime) =>
		runtime.session.extensionRunner.emit({ type: "agent_settled" } as never);
	const turnStart = (runtime: AgentSessionRuntime) =>
		runtime.session.extensionRunner.emit({
			type: "turn_start",
			turnIndex: 0,
			timestamp: Date.now(),
		} as never);

	/** The conversation moves pi can make between X's report and Y's settle. */
	type Move = "tree" | "fork" | "new" | "resume" | "clone" | "reload";

	/**
	 * Branch X reads and rewrites `f`, ends its turn (the report is built and
	 * persisted) and settles while the LSP is cold, so the pass skips. The
	 * conversation makes `move` to a branch that never read `f` (a clone at the
	 * leaf and a reload keep X's reads), takes a read-only turn (no report is
	 * published over X's), and settles with the LSP warm. Returns the zero-read
	 * probe on the new branch.
	 */
	async function reportOnXFixOnY(
		fixOnY = true,
		move: Move = "tree",
	): Promise<string> {
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			'{"devDependencies":{"eslint":"^9.0.0"}}',
		);
		fs.writeFileSync(
			path.join(cwd, "package-lock.json"),
			'{"packages":{"node_modules/eslint":{"version":"9.0.0"}}}',
		);
		const f = fixture("fix.conf", 4);
		let warm = true;
		armLsp(f, () => warm);
		const runtime = await startRuntime(
			move === "tree"
				? SessionManager.inMemory(cwd)
				: SessionManager.create(cwd, sessionsDir),
		);
		const c = conversation(runtime);
		let otherSession: string | undefined;
		if (move === "resume") {
			// The session a resume lands on: it never read `f`.
			c.user("prompt on the other session");
			c.done();
			otherSession = c.S().sessionManager.getSessionFile()!;
			await runtime.newSession();
		}
		const u1 = c.user("prompt on X");
		await turnStart(runtime);
		await c.read("x_read_f", f);
		expect(
			await c.write("x_write_f", f, "value = 1;\nline2\nline3\nline4"),
		).toBe("ALLOW");
		c.done();
		await turnEnd(runtime);
		warm = false;
		await settle(runtime);
		expect(fs.readFileSync(f, "utf8")).not.toContain("FIXED");

		if (move === "tree") await c.S().navigateTree(u1);
		else if (move === "fork") await runtime.fork(u1);
		else if (move === "new") await runtime.newSession();
		else if (move === "resume") await runtime.switchSession(otherSession!);
		else if (move === "clone")
			await runtime.fork(c.S().sessionManager.getLeafId()!, {
				position: "at",
			});
		else await reload(runtime);
		warm = fixOnY;
		c.user("a question on Y, no file touched");
		c.done();
		await turnStart(runtime);
		// A read-only turn on a moved session writes no sidecar to wait for.
		await turnEnd(runtime, false);
		await settle(runtime);
		expect(fs.readFileSync(f, "utf8").includes("FIXED")).toBe(fixOnY);
		// Isolate the authorship credit from the mtime fallback (#3520).
		const old = (Date.now() - 3_600_000) / 1000;
		fs.utimesSync(f, old, old);
		return c.editLine("y_edit_f", f, 3, "Y", false);
	}

	it("does not credit a quick fix applied on a branch the report was not produced on", async () => {
		expect(await reportOnXFixOnY()).toEqual(ZERO_READ);
	});

	// The control: the same moves with the fix never applied on Y. Without it
	// the case above could be answered by anything but the fix's credit.
	it("blocks the same zero-read edit when no fix was applied on the new branch", async () => {
		expect(await reportOnXFixOnY(false)).toEqual(ZERO_READ);
	});

	// Recurrence (#3912 review r1 F2): a new ReadGuard restarts its branch epoch
	// at 0, so an entry the parent stamped 0 equals the live 0 of a fork, a /new
	// session or a resume, and the report (one cache file per project) crossed
	// the move with its credit.
	for (const move of ["fork", "new", "resume"] as const) {
		it(`does not credit a quick fix applied after a ${move}`, async () => {
			expect(await reportOnXFixOnY(true, move)).toEqual(ZERO_READ);
		});

		it(`blocks the same zero-read edit after a ${move} when no fix was applied`, async () => {
			expect(await reportOnXFixOnY(false, move)).toEqual(ZERO_READ);
		});
	}

	// The moves that keep X's reads keep their legitimate allow: the reads, not
	// the quick fix's credit, vouch for the edit.
	for (const move of ["clone", "reload"] as const) {
		for (const fixOnY of [true, false]) {
			it(`keeps the allow its kept reads give after a ${move} (fix ${fixOnY ? "applied" : "not applied"})`, async () => {
				expect(await reportOnXFixOnY(fixOnY, move)).toBe("ALLOW");
			});
		}
	}
});

describe("#3521 every read producer carries its tool call across a move", () => {
	// Keep-side witnesses: each record below is on the kept branch, so a
	// producer that stops stamping its tool call would turn a read the
	// conversation still shows into a false block.
	async function keptAfterTree(
		produce: (c: ReturnType<typeof conversation>) => Promise<unknown>,
		file: string,
		line: number,
	): Promise<string> {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		c.user("prompt 1");
		await produce(c);
		c.done();
		const u2 = c.user("prompt 2");
		c.done();
		await c.S().navigateTree(u2);
		return c.editLine("post", file, line, "Y", false);
	}

	it("keeps an own-edit record, so the agent can re-edit the line it wrote", async () => {
		const b = fixture("b.conf", 6);
		expect(
			await keptAfterTree(
				async (c) => {
					await c.read("call_read_b", b);
					expect(await c.editLine("call_edit_b", b, 2, "OWN")).toBe("ALLOW");
				},
				b,
				2,
			),
		).toBe("ALLOW");
	});

	it("keeps a bash view span", async () => {
		const b = fixture("b.conf", 6);
		expect(
			await keptAfterTree(
				(c) =>
					c.bash(
						"call_sed_b",
						`sed -n '1,6p' ${b}`,
						fs.readFileSync(b, "utf8"),
					),
				b,
				2,
			),
		).toBe("ALLOW");
	});

	it("keeps a grep search credit", async () => {
		const b = fixture("b.conf", 6);
		expect(
			await keptAfterTree(
				(c) => c.bash("call_grep_b", `grep -n line2 ${b}`, "2:b.conf-line2"),
				b,
				2,
			),
		).toBe("ALLOW");
	});

	it("keeps a read_symbol body", async () => {
		const file = path.join(cwd, "sym.ts");
		fs.writeFileSync(
			file,
			"export function target(n: number): number {\n\treturn n * 2;\n}\n",
		);
		const old = (Date.now() - 3_600_000) / 1000;
		fs.utimesSync(file, old, old);
		expect(
			await keptAfterTree(
				(c) =>
					c.ownTool("call_sym", "read_symbol", {
						path: file,
						symbol: "target",
					}),
				file,
				2,
			),
		).toBe("ALLOW");
	});
});

describe("#3521 /fork and /clone carry the reads on the fork's branch", () => {
	it("credits a read before the fork point and not one after it (A6)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		c.done();
		const u2 = c.user("prompt 2");
		await c.read("call_read_b", b);
		c.done();

		await runtime.fork(u2);

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
		const rows = await branchRetainedRows();
		expect(rows.at(-1)).toMatchObject({
			trigger: "fork",
			source: "slot",
			kept: 1,
			dropped: 1,
		});
	});

	it("falls back to the parent's sidecar that its fork shutdown saved when the slot is gone", async () => {
		// A second extension takes the process slot between the parent's
		// session_shutdown and the fork's session_start, the way a module graph
		// of another build would miss it. No turn_end ran, so only the sidecar
		// the parent's shutdown saved can carry the read.
		const loseSlot = (pi: ExtensionAPI) => {
			pi.on("session_shutdown", (event) => {
				const shutdown = event as {
					reason?: string;
					targetSessionFile?: string;
				};
				if (shutdown.reason === "fork")
					takeHandoff("fork", shutdown.targetSessionFile);
			});
		};
		const runtime = await startRuntime(
			SessionManager.create(cwd, sessionsDir),
			[loseSlot],
		);
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		c.done();
		const u2 = c.user("prompt 2");
		c.done();

		await runtime.fork(u2);

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect((await branchRetainedRows()).at(-1)).toMatchObject({
			trigger: "fork",
			source: "parent-sidecar",
			kept: 1,
		});
	});

	it("carries the reads of an in-memory session through the process slot", async () => {
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		c.done();
		const u2 = c.user("prompt 2");
		await c.read("call_read_b", b);
		c.done();

		await runtime.fork(u2);

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("/clone keeps every read; a clone at an earlier entry keeps only what precedes it (A7)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		const { resultEntry: afterA } = await c.read("call_read_a", a);
		c.done();
		c.user("prompt 2");
		await c.read("call_read_b", b);
		c.done();

		await runtime.fork(c.S().sessionManager.getLeafId()!, { position: "at" });
		expect(await c.editLine("clone_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("clone_b", b, 2, "Y", false)).toBe("ALLOW");

		await runtime.fork(afterA, { position: "at" });
		expect(await c.editLine("at_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("at_b", b, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("credits only a sibling branch's own reads when forking from it (A8)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		const d = fixture("d.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		const p1Done = c.done();
		c.user("prompt 2 on branch X");
		await c.read("call_read_b", b);
		const leafX = c.done();
		await c.S().navigateTree(p1Done);
		c.user("prompt 2 on branch Y");
		await c.read("call_read_d", d);
		c.done();

		// The fork point is on branch X, which the guard left at the /tree.
		await runtime.fork(leafX, { position: "at" });

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("post_d", d, 2, "Y", false)).toEqual(ZERO_READ);
		// X's read was deleted when the guard left X, so it is not handed on:
		// the A5 re-read, never a blind allow.
		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
	});
});

describe("#3521 a resumed session keeps only its branch's reads", () => {
	it("drops a persisted read that is not on the branch the resume lands on (A9)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		const p1Done = c.done();
		c.user("prompt 2");
		await c.read("call_read_b", b);
		c.done();
		// The sidecar is saved while both reads are live.
		await turnEnd(runtime);
		// /tree without a summary appends nothing; the sibling prompt below is
		// the last appended entry, which is where a resume lands.
		await c.S().navigateTree(p1Done);
		c.user("prompt 2 on branch Y");
		c.done();
		const sessionFile = c.S().sessionManager.getSessionFile()!;

		await runtime.switchSession(sessionFile);

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
		expect((await branchRetainedRows()).at(-1)).toMatchObject({
			trigger: "resume",
			source: "own-sidecar",
			kept: 1,
			dropped: 1,
		});
	});

	it("loads the parent's sidecar for `pi --fork <path>`, filtered to the copied branch", async () => {
		const parentRuntime = await startRuntime(
			SessionManager.create(cwd, sessionsDir),
		);
		const parent = conversation(parentRuntime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		parent.user("prompt 1");
		await parent.read("call_read_a", a);
		const p1Done = parent.done();
		parent.user("prompt 2");
		await parent.read("call_read_b", b);
		parent.done();
		await turnEnd(parentRuntime);
		// Leave the parent on branch Y so the copied tree's leaf is not the read.
		await parent.S().navigateTree(p1Done);
		parent.user("prompt 2 on branch Y");
		parent.done();
		const parentFile = parent.S().sessionManager.getSessionFile()!;
		await parentRuntime.dispose();
		runtimes.splice(runtimes.indexOf(parentRuntime), 1);

		// `pi --fork <path>`: a new process, a `startup` with
		// `header.parentSession` set and no sidecar of its own.
		const child = conversation(
			await startRuntime(SessionManager.forkFrom(parentFile, cwd, sessionsDir)),
		);

		expect(await child.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await child.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
		expect((await branchRetainedRows()).at(-1)).toMatchObject({
			trigger: "startup",
			source: "parent-sidecar",
			kept: 1,
			dropped: 1,
		});
	});
});

/** The `session_scope_transition` rows (#3611), in write order. */
async function latencyRows(phase: string): Promise<Record<string, unknown>[]> {
	await flushLatencyLog();
	const text = fs.existsSync(getLatencyLogPath())
		? fs.readFileSync(getLatencyLogPath(), "utf8")
		: "";
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((row) => row.phase === phase)
		.map((row) => row.metadata as Record<string, unknown>);
}

function scopeTransitionRows(): Promise<Record<string, unknown>[]> {
	return latencyRows("session_scope_transition");
}

/**
 * #3611 acceptance: one `session_scope_transition` row per transition,
 * carrying `evaluationOrdinal`, through pi's real runtime. The recurrence:
 * a transition that begins or retires a scope without a row leaves N3's
 * residence question (does `/reload` re-evaluate the entry?) and every
 * lifecycle straddle unreadable from `latency.log`.
 */
describe("#3611 one session_scope_transition row per transition", () => {
	it("writes one row per start, /tree, /fork, /new and quit, each start on a fresh ticket naming its predecessor", async () => {
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		const c = conversation(runtime);
		const u1 = c.user("prompt 1");
		c.done();
		c.user("prompt 2");
		c.done();
		await c.S().navigateTree(u1);
		const y = c.user("prompt 2 on branch Y");
		c.done();
		await runtime.fork(y);
		await runtime.newSession();
		await runtime.dispose();
		runtimes.splice(runtimes.indexOf(runtime), 1);

		const rows = await scopeTransitionRows();
		expect(rows.map((row) => [row.transition, row.reason, row.role])).toEqual([
			["start", "startup", "primary"],
			["tree", "tree", "primary"],
			["shutdown", "fork", "primary"],
			["start", "fork", "primary"],
			["shutdown", "new", "primary"],
			["start", "new", "primary"],
			["shutdown", "quit", "primary"],
		]);
		for (const row of rows) {
			expect(row.evaluationOrdinal).toEqual(expect.any(Number));
			expect(row.evaluationOrdinal as number).toBeGreaterThan(0);
		}
		// One coordinator (pi re-ran the factory, not the module).
		expect(new Set(rows.map((row) => row.coordinatorId)).size).toBe(1);
		const starts = rows.filter((row) => row.transition === "start");
		expect(new Set(starts.map((row) => row.scopeId)).size).toBe(3);
		expect(starts[1]?.parentScopeId).toBe(starts[0]?.scopeId);
		expect(starts[2]?.parentScopeId).toBe(starts[1]?.scopeId);
		// A shutdown retires the scope its activation started; /tree moves it.
		expect(rows[1]).toMatchObject({
			scopeId: starts[0]?.scopeId,
			branchEpoch: 1,
		});
		expect(rows[2]?.scopeId).toBe(starts[0]?.scopeId);
		expect(rows[4]?.scopeId).toBe(starts[1]?.scopeId);
		expect(rows[6]?.scopeId).toBe(starts[2]?.scopeId);
	});

	it("writes a shutdown and a start row for resume and /reload, the reload start on a fresh ticket", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		c.user("prompt 1");
		c.done();
		const firstFile = c.S().sessionManager.getSessionFile()!;
		await runtime.newSession();
		await runtime.switchSession(firstFile);
		await reload(runtime);

		const rows = await scopeTransitionRows();
		expect(rows.map((row) => [row.transition, row.reason])).toEqual([
			["start", "startup"],
			["shutdown", "new"],
			["start", "new"],
			["shutdown", "resume"],
			["start", "resume"],
			["shutdown", "reload"],
			["start", "reload"],
		]);
		const starts = rows.filter((row) => row.transition === "start");
		expect(new Set(starts.map((row) => row.scopeId)).size).toBe(4);
		expect(starts[3]?.parentScopeId).toBe(starts[2]?.scopeId);
		// #3612: each start names its hand-off source. No turn ended, so no
		// sidecar exists; the reload takes the slot its shutdown left.
		expect(starts.map((row) => row.handoffSource)).toEqual([
			"none",
			"none",
			"none",
			"slot",
		]);
	});

	it("gives a concurrent secondary its own scope and retires only that scope at its shutdown", async () => {
		const primaryRuntime = await startRuntime(SessionManager.inMemory(cwd));
		const secondaryRuntime = await startRuntime(SessionManager.inMemory(cwd));
		await secondaryRuntime.dispose();
		runtimes.splice(runtimes.indexOf(secondaryRuntime), 1);

		const rows = await scopeTransitionRows();
		expect(rows.map((row) => [row.transition, row.role])).toEqual([
			["start", "primary"],
			["start", "secondary"],
			["shutdown", "secondary"],
		]);
		expect(rows[1]?.scopeId).not.toBe(rows[0]?.scopeId);
		expect(rows[2]?.scopeId).toBe(rows[1]?.scopeId);
		// The primary's scope is still live: its edits still go through.
		const primary = conversation(primaryRuntime);
		const b = fixture("b.conf", 6);
		primary.user("prompt");
		await primary.read("call_read_b", b);
		expect(await primary.editLine("post_b", b, 2, "Y", false)).toBe("ALLOW");
	});
});

/** pi's `/reload`, as the interactive mode drives it (#3611 S1's recipe). */
async function reload(runtime: AgentSessionRuntime): Promise<void> {
	await runtime.session.reload();
}

const SITUATIONAL_TOOLS = [
	"ast_grep_outline",
	"ast_grep_replace",
	"ast_grep_search",
	"lens_diagnostic_mark",
	"lsp_navigation",
];

/** The situational tools active in a runtime's live session. */
function activeSituational(runtime: AgentSessionRuntime): string[] {
	return runtime.session
		.getActiveToolNames()
		.filter((name) => SITUATIONAL_TOOLS.includes(name))
		.sort();
}

/**
 * `pi_lens_activate_tools`, executed the way pi runs an extension tool: with
 * the runner's own context, so the activation sees the live session.
 */
async function activateTools(
	runtime: AgentSessionRuntime,
	id: string,
	tools: string[],
): Promise<void> {
	const tool = runtime.session.getToolDefinition("pi_lens_activate_tools");
	if (!tool) throw new Error("pi_lens_activate_tools is not registered");
	await tool.execute(
		id,
		{ tools } as never,
		undefined,
		undefined,
		runtime.session.extensionRunner.createToolContext(id, undefined),
	);
}

/** The files the widget holds, by basename. */
function widgetFiles(): string[] {
	return exportWidgetState()
		.files.map((file) => path.basename(file.filePath))
		.sort();
}

/**
 * #3612 (N1, D5): `/reload` keeps the session, its conversation and its
 * branch, and pi re-runs the factory. The recurrence: the reload start reset
 * the read guard and imported nothing, so every read, and every file the
 * session authored, needed a re-read that the conversation already showed.
 */
describe("#3612 /reload hands the read guard to the reloaded activation", () => {
	it("keeps a read whose tool result is on the branch across /reload (N1)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		c.done();

		await reload(runtime);

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect((await branchRetainedRows()).at(-1)).toMatchObject({
			trigger: "reload",
			source: "slot",
			kept: 1,
			dropped: 0,
		});
	});

	it("keeps a file the session wrote, and never read, editable across /reload (D5)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const file = path.join(cwd, "new.conf");
		c.user("prompt 1");
		expect(await c.write("call_write_new", file, "n1\nn2\nn3")).toBe("ALLOW");
		c.done();

		await reload(runtime);

		expect(await c.editLine("post_new", file, 2, "Y", false)).toBe("ALLOW");
	});

	it("does not call a file changed after the session began authored, before or after /reload (#3520)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		c.user("prompt 1");
		c.done();
		// Written after the session began, by nothing the guard records.
		const file = path.join(cwd, "late.conf");
		fs.writeFileSync(file, "l1\nl2\nl3");
		expect(await c.editLine("pre_late", file, 2, "Y", false)).toEqual(
			ZERO_READ,
		);

		await reload(runtime);

		expect(await c.editLine("post_late", file, 2, "Y", false)).toEqual(
			ZERO_READ,
		);
	});

	it("does not carry the parent's authorship into a /fork", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const file = path.join(cwd, "new.conf");
		c.user("prompt 1");
		expect(await c.write("call_write_new", file, "n1\nn2\nn3")).toBe("ALLOW");
		const u2 = c.user("prompt 2");
		c.done();

		await runtime.fork(u2);

		// The same rule as /tree (G10): the write's creation read carried no
		// tool call, so only the parent's authorship vouched for it.
		expect(await c.editLine("post_new", file, 2, "Y", false)).toEqual(
			ZERO_READ,
		);
	});

	it("drops a read whose tool result never reached the branch at /reload", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		// The read is recorded, but its tool result entry is never appended:
		// the conversation does not show the agent these bytes.
		const args = { path: b };
		await c.S().agent.beforeToolCall?.({
			toolCall: {
				type: "toolCall",
				id: "call_read_b",
				name: "read",
				arguments: args,
			},
			args,
		} as never);
		const result = await createReadToolDefinition(cwd).execute(
			"call_read_b",
			args,
			undefined,
			undefined,
			{ cwd } as never,
		);
		await c.S().agent.afterToolCall?.({
			toolCall: {
				type: "toolCall",
				id: "call_read_b",
				name: "read",
				arguments: args,
			},
			args,
			result: { content: result.content, details: undefined },
			isError: false,
		} as never);
		expect(await c.editLine("pre_b", b, 2, "Y", false)).toBe("ALLOW");

		await reload(runtime);

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("keeps an in-memory session's read across /reload while a subagent binds in the shutdown gap (F2, file-less)", async () => {
		// A file-less slot matches on the reason alone. An in-process subagent
		// that binds between the primary's reload shutdown and its start must
		// not take the primary's hand-off.
		const subagents: AgentSessionRuntime[] = [];
		const bindInGap = (pi: ExtensionAPI) => {
			pi.on("session_shutdown", async (event) => {
				if ((event as { reason?: string }).reason === "reload")
					subagents.push(await startRuntime(SessionManager.inMemory(cwd)));
			});
		};
		const runtime = await startRuntime(SessionManager.inMemory(cwd), [
			bindInGap,
		]);
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		c.done();

		await reload(runtime);

		expect(subagents).toHaveLength(1);
		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		// From the slot: the sidecar the reload shutdown saved would carry the
		// read too, and would hide a subagent that took the slot.
		expect((await branchRetainedRows()).at(-1)).toMatchObject({
			trigger: "reload",
			source: "slot",
			kept: 1,
		});
	});
});

/**
 * #3653: pi binds every extension to each session's own tool set, so a
 * second in-process session (pi-web hosts every chat in one process) needs
 * the tool-set plan too. The recurrence: the plan sat behind the #473
 * concurrent-secondary return, so every session after the first kept all the
 * situational tools active.
 */
describe("#3653 a concurrent secondary gets its own tool-set plan", () => {
	it("starts a concurrent secondary with the situational tools inactive", async () => {
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		expect(activeSituational(primary)).toEqual([]);

		const secondary = await startRuntime(SessionManager.inMemory(cwd));

		expect(activeSituational(secondary)).toEqual([]);
		expect(secondary.session.getActiveToolNames()).toContain(
			"pi_lens_activate_tools",
		);
	});

	it("keeps each session's activations its own", async () => {
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		await activateTools(primary, "act_primary", ["ast_grep_search"]);
		const secondary = await startRuntime(SessionManager.inMemory(cwd));
		await activateTools(secondary, "act_secondary", ["lsp_navigation"]);

		await reload(primary);

		expect(activeSituational(primary)).toEqual(["ast_grep_search"]);
		expect(activeSituational(secondary)).toEqual(["lsp_navigation"]);
	});
});

/**
 * #3604 (re-scoped by #3609 N8): the lazy-tool activations belong to the
 * conversation. The recurrence: they lived in a map keyed by session file,
 * so an in-memory session lost them on every rebuild, and nothing persisted
 * them for a resume after a restart or for `pi --fork`.
 */
describe("#3604 lazy-tool activations follow the conversation", () => {
	it("keeps an in-memory session's activations across /reload", async () => {
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		await activateTools(runtime, "act", ["ast_grep_search"]);

		await reload(runtime);

		expect(activeSituational(runtime)).toEqual(["ast_grep_search"]);
	});

	it("keeps an in-memory session's activations across /fork", async () => {
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		const c = conversation(runtime);
		c.user("prompt 1");
		c.done();
		await activateTools(runtime, "act", ["ast_grep_search"]);
		const u2 = c.user("prompt 2");
		c.done();

		await runtime.fork(u2);

		expect(activeSituational(runtime)).toEqual(["ast_grep_search"]);
	});

	it("restores a resumed session's activations after a process restart", async () => {
		const first = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(first);
		c.user("prompt 1");
		c.done();
		await activateTools(first, "act", ["ast_grep_search"]);
		await turnEnd(first);
		const sessionFile = c.S().sessionManager.getSessionFile()!;
		await first.dispose();
		runtimes.splice(runtimes.indexOf(first), 1);

		// `pi --session <file>`: a new process, a `startup` start.
		const resumed = await startRuntime(
			SessionManager.open(sessionFile, sessionsDir),
		);

		expect(activeSituational(resumed)).toEqual(["ast_grep_search"]);
	});

	it("starts `pi --fork <path>` with the parent's activations", async () => {
		const parent = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(parent);
		c.user("prompt 1");
		c.done();
		await activateTools(parent, "act", ["ast_grep_search"]);
		await turnEnd(parent);
		const parentFile = c.S().sessionManager.getSessionFile()!;
		await parent.dispose();
		runtimes.splice(runtimes.indexOf(parent), 1);

		const child = await startRuntime(
			SessionManager.forkFrom(parentFile, cwd, sessionsDir),
		);

		expect(activeSituational(child)).toEqual(["ast_grep_search"]);
	});

	it("starts /new with no activations", async () => {
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		await activateTools(runtime, "act", ["ast_grep_search"]);

		await runtime.newSession();

		expect(activeSituational(runtime)).toEqual([]);
	});

	it("keeps an activation whose tool result left the branch on /tree (D7)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const u1 = c.user("prompt 1");
		c.done();
		c.user("prompt 2");
		await activateTools(runtime, "act", ["ast_grep_search"]);
		c.done();

		await c.S().navigateTree(u1);
		await reload(runtime);

		expect(activeSituational(runtime)).toEqual(["ast_grep_search"]);
	});
});

/**
 * #3589: pi re-runs the factory for a fork, so a closure-local widget stash
 * died with the parent's activation and every fork started with an empty
 * widget. The recurrence: a fork test that emits both events on one
 * activation, which pi never does.
 */
describe("#3589 a fork starts with the parent's widget files", () => {
	async function parentWithWidget(
		sessionManager: SessionManager,
	): Promise<{ runtime: AgentSessionRuntime; u2: string }> {
		const runtime = await startRuntime(sessionManager);
		const c = conversation(runtime);
		c.user("prompt 1");
		expect(
			await c.write(
				"call_write_w",
				path.join(cwd, "w.ts"),
				"export const w = 1;\n",
			),
		).toBe("ALLOW");
		c.done();
		const u2 = c.user("prompt 2");
		c.done();
		expect(widgetFiles()).toEqual(["w.ts"]);
		return { runtime, u2 };
	}

	it("carries the parent's widget files into a persisted /fork", async () => {
		const { runtime, u2 } = await parentWithWidget(
			SessionManager.create(cwd, sessionsDir),
		);

		await runtime.fork(u2);

		expect(widgetFiles()).toEqual(["w.ts"]);
	});

	it("carries the parent's widget files into an in-memory /fork", async () => {
		const { runtime, u2 } = await parentWithWidget(
			SessionManager.inMemory(cwd),
		);

		await runtime.fork(u2);

		expect(widgetFiles()).toEqual(["w.ts"]);
	});

	it("starts /new with an empty widget", async () => {
		const { runtime } = await parentWithWidget(SessionManager.inMemory(cwd));

		await runtime.newSession();

		expect(widgetFiles()).toEqual([]);
	});
});

/**
 * #3612 scope note (from the #3757 review): the agent advisory queue is
 * drained per session scope (#3748), and `/reload` retires the scope while
 * the conversation goes on. The recurrence: an advisory queued before a
 * `/reload`, such as the fix-run lost-edit notice, is dropped as its scope's
 * and never reaches the model.
 */
/** Observe (not replace) the coordinators index.ts resets. */
function coordinators(): RuntimeCoordinator[] {
	const seen: RuntimeCoordinator[] = [];
	const reset = RuntimeCoordinator.prototype.resetForSession;
	vi.spyOn(RuntimeCoordinator.prototype, "resetForSession").mockImplementation(
		function (this: RuntimeCoordinator, ...args) {
			seen.push(this);
			return reset.apply(this, args);
		},
	);
	return seen;
}

async function contextText(runtime: AgentSessionRuntime): Promise<string> {
	const messages = await runtime.session.extensionRunner.emitContext([
		{ role: "user", content: "keep working", timestamp: Date.now() },
	] as never);
	return JSON.stringify(messages);
}

describe("#3612 a queued agent advisory follows /reload", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("delivers an advisory queued before /reload to the reloaded session's context call", async () => {
		const seen = coordinators();
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		queueAgentAdvisory(
			"lost edit in a.rs",
			seen[0]!.captureSessionGeneration(),
		);

		await reload(runtime);

		expect(await contextText(runtime)).toContain("lost edit in a.rs");
		expect(await contextText(runtime)).not.toContain("lost edit in a.rs");
	});

	it("still drops an advisory whose session ended with /new", async () => {
		const seen = coordinators();
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		queueAgentAdvisory(
			"lost edit in a.rs",
			seen[0]!.captureSessionGeneration(),
		);

		await runtime.newSession();

		expect(await contextText(runtime)).not.toContain("lost edit in a.rs");
	});

	/**
	 * #3881 r2 F1: a forwarded slot keeps the store policy of the start it
	 * was left for. The recurrence: a /fork start interrupted by a reload
	 * handed its slot on as a reload slot, so the fork adopted the parent's
	 * authorship and its queued advisory, which a clean /fork resets and
	 * leaves to the parent ("does not carry the parent's authorship into a
	 * /fork", "still drops an advisory whose session ended with /new").
	 */
	describe("#3881 an interrupted /fork keeps the fork's store policy", () => {
		for (const store of ["in-memory", "file-backed"] as const) {
			it(`gives a ${store} /fork interrupted by a reload none of the parent's authorship or advisories`, async () => {
				const seen = coordinators();
				let runtime: AgentSessionRuntime | undefined;
				let inner: Promise<void> | undefined;
				const reloadDuringFork = (pi: ExtensionAPI) => {
					pi.on("session_start", (event) => {
						if ((event as { reason?: string }).reason !== "fork" || inner)
							return;
						inner = new Promise<void>((resolve, reject) =>
							setImmediate(() =>
								runtime!.session.reload().then(resolve, reject),
							),
						);
					});
				};
				runtime = await startRuntime(
					store === "file-backed"
						? SessionManager.create(cwd, sessionsDir)
						: SessionManager.inMemory(cwd),
					[],
					[reloadDuringFork],
				);
				const c = conversation(runtime);
				const written = path.join(cwd, "authored.conf");
				c.user("prompt 1");
				expect(await c.write("call_write", written, "w1\nw2\nw3")).toBe(
					"ALLOW",
				);
				c.done();
				await activateTools(runtime, "act", ["ast_grep_search"]);
				queueAgentAdvisory(
					"lost edit in a.rs",
					seen[0]!.captureSessionGeneration(),
				);
				const u2 = c.user("prompt 2");
				c.done();

				await runtime.fork(u2);
				expect(inner).toBeDefined();
				await inner;

				// As on a clean /fork: the activation crosses; the parent's
				// authorship and its queued advisory do not.
				expect.soft(activeSituational(runtime)).toEqual(["ast_grep_search"]);
				expect
					.soft(await c.editLine("post_written", written, 2, "Y", false))
					.toEqual(ZERO_READ);
				expect
					.soft(await contextText(runtime))
					.not.toContain("lost edit in a.rs");
				const starts = (await scopeTransitionRows()).filter(
					(row) => row.transition === "start",
				);
				expect(starts.at(-1)).toMatchObject({
					reason: "reload",
					handoffSource: "slot",
				});
			});
		}
	});

	/**
	 * #3819 (TLC `H3FileLess`): a file-less slot matched on its reason alone.
	 * An in-process subagent that binds in the primary's replacement gap
	 * (declined, #3662) and then reloads or forks itself sends a non-startup
	 * start with no primary registered, which classified primary (#3668 row
	 * 17). The recurrence: that start took the primary's slot and adopted its
	 * lazy-tool activations, its queued advisory and its authorship. Since
	 * #3855 that start is not the successor the primary's shutdown named, so it
	 * stays secondary.
	 */
	describe("#3819 a gap subagent's own /reload or /fork takes nothing of the primary's", () => {
		async function gapSubagentReplaces(kind: "reload" | "fork") {
			const seen = coordinators();
			let subagent: AgentSessionRuntime | undefined;
			const replaceInGap = (pi: ExtensionAPI) => {
				pi.on("session_shutdown", async (event) => {
					if ((event as { reason?: string }).reason !== kind || subagent)
						return;
					subagent = await startRuntime(SessionManager.inMemory(cwd));
					if (kind === "reload") {
						await reload(subagent);
						return;
					}
					const s = conversation(subagent);
					s.user("subagent prompt 1");
					s.done();
					const su2 = s.user("subagent prompt 2");
					s.done();
					await subagent.fork(su2);
				});
			};
			const primary = await startRuntime(SessionManager.inMemory(cwd), [
				replaceInGap,
			]);
			const c = conversation(primary);
			const written = path.join(cwd, "authored.conf");
			const a = fixture("a.conf", 6);
			c.user("prompt 1");
			expect(await c.write("call_write", written, "w1\nw2\nw3")).toBe("ALLOW");
			await c.read("call_read_a", a);
			c.done();
			await activateTools(primary, "act", ["ast_grep_search"]);
			queueAgentAdvisory(
				"lost edit in a.rs",
				seen[0]!.captureSessionGeneration(),
			);
			const u2 = c.user("prompt 2");
			c.done();
			resetDegradationLedger();

			if (kind === "reload") await reload(primary);
			else await primary.fork(u2);

			expect(subagent).toBeDefined();
			return { primary, subagent: subagent!, written, a };
		}

		function subjects(kind: string): string[] {
			return getDegradationSummary()
				.filter((group) => group.kind === kind)
				.flatMap((group) => group.latestReasons.map((r) => r.subject));
		}
		const missedSubjects = () => subjects("session-scope-handoff-missed");

		for (const kind of ["reload", "fork"] as const) {
			it(`gives a subagent's own ${kind} in the gap none of the primary's activations or advisories`, async () => {
				const { primary, subagent, written, a } =
					await gapSubagentReplaces(kind);

				// #3855: the subagent's own start stays secondary, and the
				// primary's real successor takes its slot.
				const starts = (await scopeTransitionRows())
					.filter((row) => row.transition === "start")
					.map((row) => [row.reason, row.role]);
				expect.soft(starts.slice(-2)).toEqual([
					[kind, "secondary"],
					[kind, "primary"],
				]);
				expect.soft(activeSituational(subagent)).toEqual([]);
				expect.soft(activeSituational(primary)).toEqual(["ast_grep_search"]);
				expect
					.soft(await contextText(subagent))
					.not.toContain("lost edit in a.rs");
				// A secondary never looks for a slot.
				expect.soft(missedSubjects()).toEqual([]);
				// Accepted residual #3613 (S4, TLC `MutSecondaryReadShared`),
				// pinned so S4 flips it: a secondary's edits are judged by the
				// primary's read guard, so the primary's read of a.conf allows the
				// subagent's edit, and the primary's own authorship policy decides
				// its written file (carried on /reload, reset on /fork, D5). These
				// read ZERO_READ before #3855 only because the subagent's own start
				// wrongly took the primary slot and reset the guard.
				const s = conversation(subagent);
				expect
					.soft(await s.editLine("sub_written", written, 2, "Y", false))
					.toEqual(kind === "reload" ? "ALLOW" : ZERO_READ);
				expect.soft(await s.editLine("sub_a", a, 2, "Y", false)).toBe("ALLOW");
			});
		}

		/**
		 * The r1 review's F1 probe: option (a) cleared the slot at every
		 * primary start. A gap subagent started a new session, took nothing,
		 * and quit inside the gap; the real successor still classified primary.
		 * The recurrence: that start found the slot cleared, and an in-memory
		 * /fork lost its activations. Since #3855 the subagent's /new is not
		 * the successor the fork named, so it stays secondary in both variants;
		 * the fork must still keep its activations.
		 */
		for (const store of ["in-memory", "file-backed"] as const) {
			it(`keeps an in-memory /fork's activations when a gap subagent (${store}) starts a new session and quits inside the gap`, async () => {
				let subagent: AgentSessionRuntime | undefined;
				const reloadAndQuitInGap = (pi: ExtensionAPI) => {
					pi.on("session_shutdown", async (event) => {
						if ((event as { reason?: string }).reason !== "fork") return;
						if (subagent) return;
						subagent = await startRuntime(
							store === "in-memory"
								? SessionManager.inMemory(cwd)
								: SessionManager.create(cwd, sessionsDir),
						);
						await subagent.newSession();
						await subagent.dispose();
						runtimes.splice(runtimes.indexOf(subagent), 1);
					});
				};
				const primary = await startRuntime(SessionManager.inMemory(cwd), [
					reloadAndQuitInGap,
				]);
				const c = conversation(primary);
				c.user("prompt 1");
				c.done();
				await activateTools(primary, "act", ["ast_grep_search"]);
				const u2 = c.user("prompt 2");
				c.done();

				await primary.fork(u2);

				expect(subagent).toBeDefined();
				expect(activeSituational(primary)).toEqual(["ast_grep_search"]);
			});
		}
	});
});

/**
 * #3855 (TLC `H3DemoteCarry`, `H3DemoteAdvisory`, `H3DemoteActivation`,
 * `H3SecNew`, `H3DemotedReplaces`, `H3StaleNoteResume`): #3668's row 17. A
 * subagent that binds in the primary's replacement gap and then replaces itself
 * sends a non-startup start while no primary is registered. #3668 took every
 * such start for the primary's successor, so the subagent's start registered
 * as primary, and the real successor probed its live ctx and was demoted: it
 * skipped handleSessionStart and adoptHandoff, and the conversation lost its
 * reads, its queued advisory and its activations. The recurrence: a gap start
 * classified primary that is not the successor the primary's shutdown named,
 * or the named successor declined (no primary at all).
 */
describe("#3855 only the successor the primary named is primary in its gap", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	type Store = "file-backed" | "in-memory";
	type Move = "reload" | "fork" | "new" | "resume";
	const managerFor = (store: Store) =>
		store === "file-backed"
			? SessionManager.create(cwd, sessionsDir)
			: SessionManager.inMemory(cwd);

	/**
	 * A primary start resets the in-memory ledger, so read the durable
	 * `degradation_ledger` rows a record leaves in latency.log.
	 */
	async function subjects(kind: string): Promise<unknown[]> {
		return (await latencyRows("degradation_ledger"))
			.filter((row) => row.kind === kind)
			.map((row) => row.subject)
			.sort();
	}

	async function startRows(): Promise<unknown[][]> {
		return (await scopeTransitionRows())
			.filter((row) => row.transition === "start")
			.map((row) => [row.reason, row.role]);
	}

	/** A persisted session file that pi can resume. */
	function savedSessionFile(): string {
		const other = SessionManager.create(cwd, sessionsDir);
		other.appendMessage({
			role: "user",
			content: "an earlier conversation",
			timestamp: Date.now(),
		} as Parameters<SessionManager["appendMessage"]>[0]);
		return other.getSessionFile()!;
	}

	/** A runtime replaces itself the way pi's commands do. */
	async function replace(runtime: AgentSessionRuntime, move: Move) {
		if (move === "reload") return reload(runtime);
		if (move === "new") return void (await runtime.newSession());
		if (move === "resume")
			return void (await runtime.switchSession(savedSessionFile()));
		const s = conversation(runtime);
		s.user("prompt before the fork");
		s.done();
		const target = s.user("prompt the fork restarts");
		s.done();
		await runtime.fork(target);
	}

	/**
	 * The primary reads a file, activates a tool and has an advisory queued,
	 * then replaces itself (`move`). Inside its shutdown, each subagent binds
	 * and replaces itself, so every subagent's own start lands in the gap.
	 */
	async function gapRun(
		store: Store,
		move: Move,
		subagents: Array<{ store: Store; move: Move }>,
	) {
		const seen = coordinators();
		let ran = false;
		const replaceInGap = (pi: ExtensionAPI) => {
			pi.on("session_shutdown", async (event) => {
				if ((event as { reason?: string }).reason !== move || ran) return;
				ran = true;
				for (const sub of subagents)
					await replace(await startRuntime(managerFor(sub.store)), sub.move);
			});
		};
		const primary = await startRuntime(managerFor(store), [replaceInGap]);
		const c = conversation(primary);
		const a = fixture("a.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		c.done();
		await activateTools(primary, "act", ["ast_grep_search"]);
		queueAgentAdvisory(
			"lost edit in a.rs",
			seen[0]!.captureSessionGeneration(),
		);
		resetDegradationLedger();

		await replace(primary, move);

		expect(ran).toBe(true);
		return { primary, c, a };
	}

	/** The reloaded session keeps everything its predecessor handed it. */
	async function keepsConversation(
		run: Awaited<ReturnType<typeof gapRun>>,
	): Promise<void> {
		expect
			.soft((await scopeTransitionRows()).at(-1))
			.toMatchObject({ transition: "start", handoffSource: "slot" });
		expect
			.soft(await run.c.editLine("post_a", run.a, 2, "Y", false))
			.toBe("ALLOW");
		expect.soft(activeSituational(run.primary)).toEqual(["ast_grep_search"]);
		expect.soft(await contextText(run.primary)).toContain("lost edit in a.rs");
	}

	for (const store of ["file-backed", "in-memory"] as const) {
		for (const kind of ["reload", "fork"] as const) {
			it(`keeps a ${store} session's reads, activations and advisory when a gap subagent's own ${kind} starts first`, async () => {
				const run = await gapRun(store, "reload", [{ store, move: kind }]);

				// The subagent's bind and its own replacement stay secondary; the
				// reloaded session is the primary and adopts its slot.
				expect.soft((await startRows()).slice(-3)).toEqual([
					["startup", "secondary"],
					[kind, "secondary"],
					["reload", "primary"],
				]);
				await keepsConversation(run);
				// One record per decline: the bind (#3662) and the subagent's own
				// start (#3855).
				expect
					.soft(await subjects("session-successor-pending"))
					.toEqual(["declined", "not-the-successor"]);
			});
		}

		/**
		 * Round 1's residual R1, fixed (review F1): pi gives an in-memory /new no
		 * file and a new session manager, so the subagent's start carries no key,
		 * which is not the key the primary's reload named.
		 */
		it(`keeps a ${store} session's reads, activations and advisory when a gap subagent's own in-memory /new starts first (R1 fixed)`, async () => {
			const run = await gapRun(store, "reload", [
				{ store: "in-memory", move: "new" },
			]);

			expect.soft((await startRows()).slice(-3)).toEqual([
				["startup", "secondary"],
				["new", "secondary"],
				["reload", "primary"],
			]);
			await keepsConversation(run);
			expect
				.soft(await subjects("session-successor-pending"))
				.toEqual(["declined", "not-the-successor"]);
		});
	}

	/**
	 * Review F5: every primary gap kind, not only /reload. A gap subagent's own
	 * in-memory reload stays secondary, and the primary's own successor is
	 * primary.
	 */
	for (const [move, store] of [
		["fork", "file-backed"],
		["fork", "in-memory"],
		["new", "file-backed"],
		["new", "in-memory"],
		["resume", "file-backed"],
	] as const) {
		it(`keeps the ${store} ${move} successor primary when a gap subagent reloads itself first`, async () => {
			const run = await gapRun(store, move, [
				{ store: "in-memory", move: "reload" },
			]);

			expect.soft((await startRows()).slice(-3)).toEqual([
				["startup", "secondary"],
				["reload", "secondary"],
				[move, "primary"],
			]);
			if (move === "fork")
				expect
					.soft(activeSituational(run.primary))
					.toEqual(["ast_grep_search"]);
		});
	}

	it("keeps the real successor primary when two gap subagents replace themselves at once", async () => {
		const run = await gapRun("in-memory", "reload", [
			{ store: "in-memory", move: "reload" },
			{ store: "file-backed", move: "fork" },
		]);

		expect.soft((await startRows()).slice(-5)).toEqual([
			["startup", "secondary"],
			["reload", "secondary"],
			["startup", "secondary"],
			["fork", "secondary"],
			["reload", "primary"],
		]);
		await keepsConversation(run);
	});

	/**
	 * Residual R3: inside the primary's own in-memory /new gap, a subagent's
	 * own in-memory /new is indistinguishable from the successor. Both carry
	 * reason `new` and no key, so the first one is primary. The process still
	 * has exactly one primary. Pinned so that closing R3 flips it on purpose.
	 */
	it("lets the first in-memory /new be primary in an in-memory /new gap (accepted residual R3)", async () => {
		await gapRun("in-memory", "new", [{ store: "in-memory", move: "new" }]);

		expect((await startRows()).slice(-3)).toEqual([
			["startup", "secondary"],
			["new", "primary"],
			["new", "secondary"],
		]);
	});

	/**
	 * Review F2 (probe PR1): round 1 let a start inherit its predecessor's role.
	 * After an R1 demotion, the user's conversation stayed secondary when it
	 * reloaded inside the gap of the subagent's next /new. Now no demotion
	 * happens, and the conversation's reload in the subagent's own /new gap is
	 * the primary's own successor.
	 */
	for (const store of ["file-backed", "in-memory"] as const) {
		it(`keeps the ${store} conversation primary when it reloads inside a gap subagent's next /new`, async () => {
			let primary: AgentSessionRuntime | undefined;
			let subagent: AgentSessionRuntime | undefined;
			let armed = false;
			const reloadPrimaryOnNew = (pi: ExtensionAPI) => {
				pi.on("session_shutdown", async (event) => {
					if ((event as { reason?: string }).reason !== "new" || !armed) return;
					armed = false;
					await reload(primary!);
				});
			};
			const newInGap = (pi: ExtensionAPI) => {
				pi.on("session_shutdown", async (event) => {
					if ((event as { reason?: string }).reason !== "reload" || subagent)
						return;
					subagent = await startRuntime(SessionManager.inMemory(cwd), [
						reloadPrimaryOnNew,
					]);
					await subagent.newSession();
				});
			};
			primary = await startRuntime(managerFor(store), [newInGap]);

			await reload(primary);
			armed = true;
			await subagent!.newSession();

			expect((await startRows()).slice(-5)).toEqual([
				["startup", "secondary"],
				["new", "secondary"],
				["reload", "primary"],
				["reload", "primary"],
				["new", "secondary"],
			]);
		});
	}

	/**
	 * Review F3 (probe PR7): pi's reload() emits no session_start to a session
	 * without host bindings, so round 1's note for that subagent's successor
	 * stayed. When the primary later resumed the subagent's file, its own
	 * successor matched the stale note and was declined, and no session was
	 * primary.
	 */
	it("keeps the primary's resume successor primary after a subagent reloaded with no start", async () => {
		const primary = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const subagent = await startRuntime(
			SessionManager.create(cwd, sessionsDir),
		);
		const s = conversation(subagent);
		s.user("subagent prompt");
		s.done();
		const subagentFile = subagent.session.sessionManager.getSessionFile()!;
		const unbound = subagent.session as unknown as Record<string, unknown>;
		for (const binding of [
			"_extensionUIContext",
			"_extensionCommandContextActions",
			"_extensionShutdownHandler",
			"_extensionErrorListener",
		])
			unbound[binding] = undefined;
		await subagent.session.reload();

		await primary.switchSession(subagentFile);

		expect((await startRows()).slice(-3)).toEqual([
			["startup", "primary"],
			["startup", "secondary"],
			["resume", "primary"],
		]);
	});

	/**
	 * Verify r2 V1 (probe PR8): an SDK subagent's first bind may carry
	 * `sessionStartEvent` reason `reload` or `fork` (a public option, pi
	 * `sdk.js`). Inside an in-memory primary's /reload or /fork gap it has no
	 * key, which is not the ticket the primary's shutdown named. Round 2's
	 * key-less fail-safe (J6) admitted it, and the real successor was demoted
	 * and lost its activations.
	 */
	for (const store of ["in-memory", "file-backed"] as const) {
		for (const move of ["reload", "fork"] as const) {
			it(`keeps the ${store} ${move} successor primary when an SDK subagent binds with reason ${move} in its gap`, async () => {
				let bound = false;
				const sdkBindInGap = (pi: ExtensionAPI) => {
					pi.on("session_shutdown", async (event) => {
						if ((event as { reason?: string }).reason !== move || bound) return;
						bound = true;
						await startRuntime(SessionManager.inMemory(cwd), [], [], cwd, {
							type: "session_start",
							reason: move,
						});
					});
				};
				const primary = await startRuntime(managerFor(store), [sdkBindInGap]);
				await activateTools(primary, "act", ["ast_grep_search"]);

				await replace(primary, move);

				expect(bound).toBe(true);
				expect.soft((await startRows()).slice(-2)).toEqual([
					[move, "secondary"],
					[move, "primary"],
				]);
				expect.soft(activeSituational(primary)).toEqual(["ast_grep_search"]);
			});
		}
	}

	/**
	 * Verify r3 V3 (PR12) and verify r4 V6 (PR13): an in-memory /new runs on a
	 * new session manager, and a /reload can land in any window of its
	 * session_start (#3881): before pi-lens's start handler runs (W0, micro:0),
	 * inside its awaits before it holds its scope (W1 micro:1, W2 micro:2), or
	 * after (W3, setImmediate). The reload's shutdown found no ticket on that
	 * manager, so the gap was named (reload, none), and a key-less reload start
	 * passed for the successor: a gap subagent's own in-memory reload, or an
	 * SDK bind with reason reload. The user's conversation was then demoted.
	 */
	type Window = "W0 micro:0" | "W1 micro:1" | "W2 micro:2" | "W3 setImmediate";
	const scheduleIn = (window: Window, fn: () => void): void => {
		const hops = { "W0 micro:0": 0, "W1 micro:1": 1, "W2 micro:2": 2 }[
			window as "W0 micro:0"
		];
		if (hops === undefined) return void setImmediate(fn);
		const micro = (n: number): void =>
			n === 0 ? queueMicrotask(fn) : queueMicrotask(() => micro(n - 1));
		micro(hops);
	};
	for (const window of [
		"W0 micro:0",
		"W1 micro:1",
		"W2 micro:2",
		"W3 setImmediate",
	] as const) {
		for (const gap of ["subagent-reload", "sdk-bind", "none"] as const) {
			it(`keeps the reload successor of an interrupted in-memory /new primary (${window}, gap: ${gap})`, async () => {
				let runtime: AgentSessionRuntime | undefined;
				let inner: Promise<void> | undefined;
				let armed = false;
				let acted = false;
				const reloadDuringNew = (pi: ExtensionAPI) => {
					pi.on("session_start", (event) => {
						if (!armed || (event as { reason?: string }).reason !== "new")
							return;
						if (inner) return;
						inner = new Promise<void>((resolve, reject) =>
							scheduleIn(window, () =>
								runtime!.session.reload().then(resolve, reject),
							),
						);
					});
				};
				const actInReloadGap = (pi: ExtensionAPI) => {
					pi.on("session_shutdown", async (event) => {
						if ((event as { reason?: string }).reason !== "reload") return;
						if (!armed || acted) return;
						acted = true;
						if (gap === "subagent-reload")
							await reload(await startRuntime(SessionManager.inMemory(cwd)));
						else if (gap === "sdk-bind")
							await startRuntime(SessionManager.inMemory(cwd), [], [], cwd, {
								type: "session_start",
								reason: "reload",
							});
					});
				};
				runtime = await startRuntime(
					SessionManager.inMemory(cwd),
					[actInReloadGap],
					[reloadDuringNew],
				);
				armed = true;
				const before = (await startRows()).length;

				await runtime.newSession();
				expect(inner).toBeDefined();
				await inner;

				// The inner reload's start is the one primary; every gap start,
				// and in W0 the /new start that ran after its own shutdown, is
				// secondary.
				const rows = (await startRows()).slice(before);
				expect.soft(rows.at(-1)).toEqual(["reload", "primary"]);
				expect
					.soft(rows.slice(0, -1).filter(([, role]) => role === "primary"))
					.toEqual([]);
				expect(acted).toBe(true);
			});
		}
	}

	/**
	 * #4106 (V7 of #3855, verify r5 PR16): a gap subagent's own /new start is
	 * interrupted by its own /reload before pi-lens's start handler runs
	 * (micro:0), so that activation records no role. With no primary
	 * registered (the primary's gap), its shutdown failed safe to primary,
	 * named the gap by its own fresh ticket, and the subagent's reload start
	 * took the slot: the user's P' was declined and lost its activation. At
	 * micro:1 the role is recorded (secondary), and it was already right.
	 */
	for (const [move, store] of [
		["reload", "in-memory"],
		["reload", "file-backed"],
		["fork", "in-memory"],
		["fork", "file-backed"],
		["new", "file-backed"],
	] as const) {
		for (const hops of [0, 1] as const) {
			it(`keeps the ${store} ${move} successor primary when a gap subagent's /new is interrupted by its own /reload at micro:${hops}`, async () => {
				let sub: AgentSessionRuntime | undefined;
				let inner: Promise<void> | undefined;
				let armed = false;
				const subReloadDuringNew = (pi: ExtensionAPI) => {
					pi.on("session_start", (event) => {
						if (!armed || (event as { reason?: string }).reason !== "new")
							return;
						if (inner) return;
						inner = new Promise<void>((resolve, reject) => {
							const hop = (n: number): void =>
								n === 0
									? queueMicrotask(() =>
											sub!.session.reload().then(resolve, reject),
										)
									: queueMicrotask(() => hop(n - 1));
							hop(hops);
						});
					});
				};
				let acted = false;
				const inGap = (pi: ExtensionAPI) => {
					pi.on("session_shutdown", async (event) => {
						if ((event as { reason?: string }).reason !== move || acted) return;
						acted = true;
						sub = await startRuntime(
							SessionManager.inMemory(cwd),
							[],
							[subReloadDuringNew],
						);
						armed = true;
						await sub.newSession();
						await inner;
					});
				};
				const primary = await startRuntime(managerFor(store), [inGap]);
				await activateTools(primary, "act", ["ast_grep_search"]);
				const before = (await startRows()).length;

				await replace(primary, move);

				expect(acted).toBe(true);
				const rows = (await startRows()).slice(before);
				expect.soft(rows.at(-1)).toEqual([move, "primary"]);
				expect
					.soft(rows.slice(0, -1).filter(([, role]) => role === "primary"))
					.toEqual([]);
				if (move !== "new")
					expect.soft(activeSituational(primary)).toEqual(["ast_grep_search"]);
				// One bounded record names the role-less decline (micro:0 only;
				// at micro:1 the activation's role is recorded).
				const roleless = (await subjects("session-successor-pending")).filter(
					(subject) => subject === "roleless-shutdown",
				);
				expect(roleless).toEqual(hops === 0 ? ["roleless-shutdown"] : []);
			});
		}
	}

	/**
	 * #4106 row 5, the other direction: the user's own /new interrupted at
	 * micro:0 by its own /reload is also role-less at its shutdown, and it IS
	 * the named successor (its manager is the one the /new named, by file or
	 * by none). It must stay primary, or no session would be.
	 */
	for (const store of ["in-memory", "file-backed"] as const) {
		it(`keeps the user's own ${store} /new primary when its own /reload interrupts its start at micro:0`, async () => {
			let runtime: AgentSessionRuntime | undefined;
			let inner: Promise<void> | undefined;
			let armed = false;
			const reloadDuringNew = (pi: ExtensionAPI) => {
				pi.on("session_start", (event) => {
					if (!armed || (event as { reason?: string }).reason !== "new") return;
					if (inner) return;
					inner = new Promise<void>((resolve, reject) =>
						queueMicrotask(() =>
							runtime!.session.reload().then(resolve, reject),
						),
					);
				});
			};
			runtime = await startRuntime(managerFor(store), [], [reloadDuringNew]);
			armed = true;
			const before = (await startRows()).length;

			await runtime.newSession();
			expect(inner).toBeDefined();
			await inner;

			const rows = (await startRows()).slice(before);
			expect.soft(rows.at(-1)).toEqual(["reload", "primary"]);
			expect
				.soft(rows.slice(0, -1).filter(([, role]) => role === "primary"))
				.toEqual([]);
			// Its role-less shutdown is the named successor's: classified
			// primary, it runs the primary teardown, so no role-less decline is
			// recorded (a decline would skip that teardown).
			expect(await subjects("session-successor-pending")).not.toContain(
				"roleless-shutdown",
			);
		});
	}

	/**
	 * #2129 F3: after a primary quit nothing is pending, so a subagent's own
	 * replacement re-arms the process as its primary. The recurrence this
	 * guards: a start declined outside a primary's gap, which leaves the
	 * process with no primary at all.
	 */
	it("lets a subagent's own /reload become the primary after the primary quit", async () => {
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startRuntime(SessionManager.inMemory(cwd));
		await primary.dispose();
		runtimes.splice(runtimes.indexOf(primary), 1);
		resetDegradationLedger();

		await reload(subagent);

		expect((await startRows()).slice(-2)).toEqual([
			["startup", "secondary"],
			["reload", "primary"],
		]);
		expect(await subjects("session-successor-pending")).toEqual([]);
	});
});

/**
 * #3758: the pending runner-findings store is process-global, and every
 * activation's turn_end drains it. A concurrent secondary (an in-process
 * subagent) keeps ending turns while the primary goes through `/new`, so its
 * turn_end in the gap between the primary's shutdown and the next start
 * delivered the ended session's late runner result into the subagent's own
 * conversation. The recurrence: a drain that delivers an entry whose scope
 * has retired.
 */
describe("#3758 pending runner findings and session scope", () => {
	afterEach(() => {
		resetPendingRunnerFindings();
		vi.restoreAllMocks();
	});

	/** A collect-later runner result, deferred the way the dispatcher does. */
	function deferFailedRunner(
		session: ReturnType<RuntimeCoordinator["captureSessionGeneration"]>,
		runnerId: string,
	): void {
		deferRunnerFindings({
			filePath: path.join(cwd, "a.ts"),
			cwd,
			projectRoot: cwd,
			runnerId,
			markedAtMs: Date.now(),
			promise: Promise.resolve({
				status: "failed",
				diagnostics: [],
				semantic: "warning",
				failureKind: "exception",
				failureMessage: `${runnerId} crashed`,
			}),
			session,
		});
	}

	/** pi's turn_end, without the sidecar wait (in-memory sessions). */
	async function endTurn(runtime: AgentSessionRuntime): Promise<void> {
		await runtime.session.extensionRunner.emit({
			type: "turn_end",
			turnIndex: 0,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "x",
				provider: "x",
				model: "x",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
			toolResults: [],
		} as never);
	}

	/** A concurrent secondary in its own project, so its record is its own. */
	async function startSubagent(): Promise<AgentSessionRuntime> {
		const subCwd = path.join(root, "sub");
		fs.mkdirSync(path.join(subCwd, ".git"), { recursive: true });
		return startRuntime(SessionManager.inMemory(subCwd), [], [], subCwd);
	}

	it("drops, and counts, a result whose session ended before a secondary's turn end drains it", async () => {
		const seen = coordinators();
		let subagent: AgentSessionRuntime | undefined;
		let subagentSaw: string | undefined;
		let dropped: string[] | undefined;
		// Runs after pi-lens's own session_shutdown handler has retired the
		// primary's scope, and before pi builds the next session (whose start
		// resets the in-memory ledger, so the row is read here).
		const inTheGap = (pi: ExtensionAPI) => {
			pi.on("session_shutdown", async () => {
				if (!subagent) return;
				await endTurn(subagent);
				subagentSaw = await contextText(subagent);
				dropped = getDegradationSummary()
					.find((group) => group.kind === "generation-guard-stale-write")
					?.latestReasons.map((row) => row.subject)
					.filter((subject) => subject.includes("probe-3758"));
			});
		};
		const primary = await startRuntime(SessionManager.inMemory(cwd), [
			inTheGap,
		]);
		subagent = await startSubagent();
		// A session that has ended a turn holds the analyzer clients, which
		// stay resident across the shutdown (#2467): the gap's turn_end runs.
		await endTurn(primary);
		deferFailedRunner(seen[0]!.captureSessionGeneration(), "probe-3758");

		await primary.newSession();

		expect({
			subagentSees: subagentSaw?.includes("probe-3758 crashed"),
			pending: pendingRunnerFindingsSize(),
			dropped,
		}).toEqual({
			subagentSees: false,
			pending: 0,
			dropped: [
				`runtime-session:turn-end:probe-3758:${path.join(cwd, "a.ts")}`,
			],
		});
	});

	it("lets a secondary that ends its turn first take a live primary's result (accepted residual until S4, #3758)", async () => {
		// Pinned so S4 (#3613) flips it deliberately. A secondary's own tool
		// results capture the coordinator's scope, which is the primary's
		// (S1, #3611), so the store cannot tell the primary's result from the
		// secondary's own. Draining by the activation's scope would move every
		// secondary result to the primary instead.
		const seen = coordinators();
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		deferFailedRunner(seen[0]!.captureSessionGeneration(), "probe-3758-live");

		await endTurn(subagent);
		const subagentSees = (await contextText(subagent)).includes(
			"probe-3758-live crashed",
		);
		await endTurn(primary);

		expect({
			subagentSees,
			primarySees: (await contextText(primary)).includes(
				"probe-3758-live crashed",
			),
		}).toEqual({ subagentSees: true, primarySees: false });
	});
});

/**
 * #3763 item 4, the host wiring: index.ts hands `ast_grep_replace` the
 * capture of its coordinator's session. The recurrence: the tool built with
 * no capture, so every in-pi rewrite reaches the bridge without a lineage and
 * stays fail-open while every unit test of the tool stays green.
 */
describe("#3763 ast_grep_replace is wired to the live session", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes the session scope the call ran in to the apply", async () => {
		const seen = coordinators();
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		vi.spyOn(AstGrepClient.prototype, "ensureAvailable").mockResolvedValue(
			true,
		);
		const replace = vi
			.spyOn(AstGrepClient.prototype, "replace")
			.mockResolvedValue({
				matches: [],
				totalMatches: 0,
				truncated: false,
				applied: true,
			});
		const tool = runtime.session.getToolDefinition("ast_grep_replace");
		if (!tool) throw new Error("ast_grep_replace is not registered");

		await tool.execute(
			"call-3763-wired",
			{
				pattern: "var $X",
				rewrite: "let $X",
				lang: "typescript",
				apply: true,
			} as never,
			undefined,
			undefined,
			runtime.session.extensionRunner.createToolContext(
				"call-3763-wired",
				undefined,
			),
		);

		const lineage = (
			replace.mock.calls[0]?.[5] as { lineage?: { scopeId: number } }
		)?.lineage;
		expect(lineage?.scopeId).toBe(seen[0]!.captureSessionGeneration().scopeId);
	});
});

/**
 * #3881: pi awaiting the `session_start` emit does not stop a concurrent
 * `AgentSession.reload()`. A handler ordered before pi-lens schedules one, so
 * the inner reload's `session_shutdown` lands while pi-lens's start of the
 * same session is still awaiting, before `adoptHandoff`. The recurrence: that
 * shutdown stashed its own empty scope over the slot left for its start, and
 * the inner reload's start took the empty slot, so the conversation lost its
 * lazy-tool activations. A resume start has no slot: its shutdown also
 * saved that empty scope over the sidecar the inner reload's start reads.
 *
 * "continuing": an extension ordered after pi-lens holds the inner shutdown
 * until the interrupted start's pi-lens handler has settled, so that start
 * runs on with a ctx pi has not yet invalidated. The recurrence: it took the
 * slot its own shutdown handed on, and the inner reload's start missed it.
 */
describe("#3881 an interrupted session_start hands on the slot left for it", () => {
	for (const kind of ["reload", "fork", "resume"] as const) {
		for (const store of ["in-memory", "file-backed"] as const) {
			// pi resumes a session from its file.
			if (kind === "resume" && store === "in-memory") continue;
			for (const continuing of [false, true]) {
				it(`keeps a ${store} session's activations when a reload interrupts its ${kind} start before it adopts${continuing ? ", and the start runs on" : ""}`, async () => {
					let runtime: AgentSessionRuntime | undefined;
					let inner: Promise<void> | undefined;
					const reloadDuringStart = (pi: ExtensionAPI) => {
						pi.on("session_start", (event) => {
							if ((event as { reason?: string }).reason !== kind || inner)
								return;
							inner = new Promise<void>((resolve, reject) =>
								setImmediate(() =>
									runtime!.session.reload().then(resolve, reject),
								),
							);
						});
					};
					let startSettled = () => {};
					const settled = new Promise<void>((resolve) => {
						startSettled = resolve;
					});
					const holdShutdownForStart = (pi: ExtensionAPI) => {
						// Ordered after pi-lens: pi reaches it once pi-lens's handler
						// for the interrupted start has settled.
						pi.on("session_start", () => {
							if (inner) startSettled();
						});
						pi.on("session_shutdown", async () => {
							if (inner) await settled;
						});
					};
					runtime = await startRuntime(
						store === "file-backed"
							? SessionManager.create(cwd, sessionsDir)
							: SessionManager.inMemory(cwd),
						continuing ? [holdShutdownForStart] : [],
						[reloadDuringStart],
					);
					const c = conversation(runtime);
					c.user("prompt 1");
					c.done();
					await activateTools(runtime, "act", ["ast_grep_search"]);
					const u2 = c.user("prompt 2");
					c.done();
					if (kind === "resume") await turnEnd(runtime);
					resetDegradationLedger();

					if (kind === "reload") await reload(runtime);
					else if (kind === "fork") await runtime.fork(u2);
					else
						await runtime.switchSession(c.S().sessionManager.getSessionFile()!);
					expect(inner).toBeDefined();
					await inner;

					expect(activeSituational(runtime)).toEqual(["ast_grep_search"]);
					const rows = await scopeTransitionRows();
					const shutdowns = rows.filter((row) => row.transition === "shutdown");
					const starts = rows.filter((row) => row.transition === "start");
					// The interrupted start retired a scope it never logged a start
					// for: its shutdown landed after its scope began (t1), before it
					// adopted, and it never adopted later. Its successor, the inner
					// reload, took the slot (a resume left none: the sidecar).
					const interrupted = shutdowns.at(-1)!.scopeId;
					expect(starts.some((row) => row.scopeId === interrupted)).toBe(false);
					expect(starts.at(-1)).toMatchObject({
						reason: "reload",
						role: "primary",
						handoffSource: kind === "resume" ? "own-sidecar" : "slot",
					});
					// One bounded record names the interrupted start (#3873 O1). The
					// inner reload's start resets the in-memory ledger, so read the
					// record's durable row.
					expect(
						(await latencyRows("degradation_ledger")).filter(
							(row) => row.kind === "session-scope-handoff-interrupted",
						),
					).toEqual([
						expect.objectContaining({
							subject: kind,
							shutdownReason: "reload",
							outcome: kind === "resume" ? "no-slot" : "forwarded",
						}),
					]);
				});
			}
		}
	}

	/**
	 * #4113 (#3898's T-1): a reload scheduled with zero microtask hops lands
	 * before pi-lens's `session_start` handler is entered, so the activation
	 * has no role, no in-flight mark and no scope. The recurrence: that
	 * shutdown forwarded nothing; the interrupted fork's late start was
	 * declined and discarded the `(fork, key)` slot, and the inner reload's
	 * start missed it, losing the conversation's activations. The gap's name
	 * says which start was interrupted, so the shutdown forwards as the mark
	 * does. A reload or resume start kept its state here before the fix; it
	 * pins the same forward (and its bounded record) for every slot kind.
	 */
	for (const kind of ["fork", "reload", "resume"] as const) {
		for (const store of ["in-memory", "file-backed"] as const) {
			if (kind === "resume" && store === "in-memory") continue;
			it(`keeps a ${store} session's activations when a reload interrupts its ${kind} start before pi-lens's handler runs (micro:0)`, async () => {
				let runtime: AgentSessionRuntime | undefined;
				let armed = false;
				let inner: Promise<void> | undefined;
				const reloadAtOnce = (pi: ExtensionAPI) => {
					pi.on("session_start", (event) => {
						if (
							!armed ||
							(event as { reason?: string }).reason !== kind ||
							inner
						)
							return;
						inner = new Promise<void>((resolve, reject) =>
							queueMicrotask(() =>
								runtime!.session.reload().then(resolve, reject),
							),
						);
					});
				};
				runtime = await startRuntime(
					store === "file-backed"
						? SessionManager.create(cwd, sessionsDir)
						: SessionManager.inMemory(cwd),
					[],
					[reloadAtOnce],
				);
				const c = conversation(runtime);
				c.user("prompt 1");
				c.done();
				await activateTools(runtime, "act", ["ast_grep_search"]);
				const u2 = c.user("prompt 2");
				c.done();
				if (kind === "resume") await turnEnd(runtime);
				resetDegradationLedger();

				armed = true;
				if (kind === "reload") await reload(runtime);
				else if (kind === "fork") await runtime.fork(u2);
				else
					await runtime.switchSession(c.S().sessionManager.getSessionFile()!);
				expect(inner).toBeDefined();
				await inner;

				expect(activeSituational(runtime)).toEqual(["ast_grep_search"]);
				expect(
					(await scopeTransitionRows())
						.filter((row) => row.transition === "start")
						.at(-1),
				).toMatchObject({
					reason: "reload",
					role: "primary",
					handoffSource: kind === "resume" ? "own-sidecar" : "slot",
				});
				const handoffRows = (await latencyRows("degradation_ledger"))
					.filter((row) =>
						String(row.kind).startsWith("session-scope-handoff-"),
					)
					.map((row) => [row.kind, row.subject, row.outcome]);
				expect(handoffRows).toContainEqual([
					"session-scope-handoff-interrupted",
					kind,
					kind === "resume" ? "no-slot" : "forwarded",
				]);
				// The late declined fork start finds no slot left to discard.
				expect(
					handoffRows.filter(
						([rowKind]) => rowKind === "session-scope-handoff-discarded",
					),
				).toEqual([]);
			});
		}
	}

	/**
	 * #4113 verify X1 (R2, the reviewer's PR20): a gap subagent resumes the
	 * user's file inside the user's resume gap, so two started primaries run
	 * on one file. In the user's later reload gap the second runtime reloads
	 * itself: it is primary with no in-flight mark, and the gap names
	 * `(reload, its file)`. The recurrence: without the "no scope" half of
	 * the unstarted rule, that started shutdown forwarded the user's slot
	 * instead of stashing its own scope, and its reload successor ran with the
	 * user's activations, not its own.
	 */
	it("keeps a same-file second primary's own activations when it reloads in the user's reload gap (R2)", async () => {
		let second: AgentSessionRuntime | undefined;
		let target = "";
		let phase: "resume" | "reload" | "done" = "resume";
		const gapActor = (pi: ExtensionAPI) => {
			pi.on("session_shutdown", async (event) => {
				const reason = (event as { reason?: string }).reason;
				if (phase === "resume" && reason === "resume" && !second) {
					second = await startRuntime(SessionManager.inMemory(cwd));
					await second.switchSession(target);
				} else if (phase === "reload" && reason === "reload" && second) {
					phase = "done";
					await activateTools(second, "act-second", ["lsp_navigation"]);
					await reload(second);
				}
			});
		};
		const other = SessionManager.create(cwd, sessionsDir);
		other.appendMessage({
			role: "user",
			content: "other",
			timestamp: Date.now(),
		} as never);
		target = other.getSessionFile()!;
		const primary = await startRuntime(
			SessionManager.create(cwd, sessionsDir),
			[gapActor],
		);
		const c = conversation(primary);
		c.user("prompt 1");
		c.done();
		await primary.switchSession(target);
		expect(second).toBeDefined();
		await activateTools(primary, "act-user", ["ast_grep_search"]);
		resetDegradationLedger();

		phase = "reload";
		await reload(primary);

		expect(phase).toBe("done");
		expect(activeSituational(second!)).toEqual(["lsp_navigation"]);
		expect(
			(await latencyRows("degradation_ledger")).filter(
				(row) => row.kind === "session-scope-handoff-interrupted",
			),
		).toEqual([]);
	});

	/**
	 * #3881 r2 F2: a reload scheduled one microtask hop after the fork's
	 * `session_start` emit lands in t0, after pi-lens's handler was entered
	 * and before it set its scope. The recurrence: a mark set after the
	 * start's first await (r1's M3b) left that shutdown with no mark and no
	 * scope, so the `(fork, key)` slot stayed and the inner reload's start
	 * missed it.
	 */
	it("keeps an in-memory session's activations when a microtask-scheduled reload interrupts its fork start before its scope began", async () => {
		let runtime: AgentSessionRuntime | undefined;
		let inner: Promise<void> | undefined;
		const reloadNextMicrotask = (pi: ExtensionAPI) => {
			pi.on("session_start", (event) => {
				if ((event as { reason?: string }).reason !== "fork" || inner) return;
				// One hop: zero hops lands before pi-lens's handler is entered
				// (T-1, #4113: the micro:0 tests above).
				inner = Promise.resolve()
					.then(() => undefined)
					.then(() => runtime!.session.reload());
			});
		};
		runtime = await startRuntime(
			SessionManager.inMemory(cwd),
			[],
			[reloadNextMicrotask],
		);
		const c = conversation(runtime);
		c.user("prompt 1");
		c.done();
		await activateTools(runtime, "act", ["ast_grep_search"]);
		const u2 = c.user("prompt 2");
		c.done();
		resetDegradationLedger();

		await runtime.fork(u2);
		expect(inner).toBeDefined();
		await inner;

		expect(activeSituational(runtime)).toEqual(["ast_grep_search"]);
		const rows = await scopeTransitionRows();
		// t0: the interrupted start had no scope yet, so only the parent's
		// fork shutdown retired one.
		expect(
			rows
				.filter((row) => row.transition === "shutdown")
				.map((row) => row.reason),
		).toEqual(["fork"]);
		expect(
			rows.filter((row) => row.transition === "start").at(-1),
		).toMatchObject({ reason: "reload", handoffSource: "slot" });
		expect(
			(await latencyRows("degradation_ledger")).filter(
				(row) => row.kind === "session-scope-handoff-interrupted",
			),
		).toEqual([
			expect.objectContaining({ subject: "fork", outcome: "forwarded" }),
		]);
	});

	/**
	 * #3881 r3: a #2890 duplicate `session_start` admitted while the first
	 * start is in flight runs a second primary start in this activation
	 * (`liveToolPlan.changed` lets it through). The first start adopts the
	 * fork's slot and becomes the activation's scope. The recurrence: r2's
	 * guarded `finally` kept the duplicate's in-flight mark, so the later
	 * reload's shutdown forwarded (finding no slot) instead of stashing the
	 * adopted scope, and the inner reload started without the activation.
	 */
	it("keeps an in-memory /fork's activations when a duplicate start is admitted mid-flight and a reload follows", async () => {
		let runtime: AgentSessionRuntime | undefined;
		let armed = false;
		let dup: Promise<unknown> | undefined;
		let inner: Promise<void> | undefined;
		const duplicateStart = (pi: ExtensionAPI) => {
			pi.on("session_start", (event) => {
				const reason = (event as { reason?: string }).reason;
				if (!armed || reason !== "fork" || dup) return;
				const runner = runtime!.session.extensionRunner;
				dup = Promise.resolve().then(() =>
					runner.emit({ type: "session_start", reason } as never),
				);
			});
		};
		const reloadAfterStart = (pi: ExtensionAPI) => {
			pi.on("session_start", () => {
				if (dup && !inner) inner = runtime!.session.reload();
			});
		};
		runtime = await startRuntime(
			SessionManager.inMemory(cwd),
			[reloadAfterStart],
			[duplicateStart],
		);
		const c = conversation(runtime);
		c.user("prompt 1");
		c.done();
		await activateTools(runtime, "act", ["ast_grep_search"]);
		const u2 = c.user("prompt 2");
		c.done();
		// The saved sidecar keeps the duplicate in flight until the reload's
		// shutdown lands (without it the duplicate settles first).
		await turnEnd(runtime);
		resetDegradationLedger();

		armed = true;
		await runtime.fork(u2);
		expect(dup).toBeDefined();
		await dup;
		expect(inner).toBeDefined();
		await inner;

		expect(activeSituational(runtime)).toEqual(["ast_grep_search"]);
		expect(
			(await scopeTransitionRows())
				.filter((row) => row.transition === "start")
				.at(-1),
		).toMatchObject({ reason: "reload", handoffSource: "slot" });
	});
});

/**
 * #3613 (session-scope S4, N2): the coordinator's turn state is the
 * primary's, and a concurrent secondary (an in-process subagent) runs its own
 * turn_start, tool results and turn_end on the same module-level runtime. The
 * recurrence: the subagent's turn_start advanced the primary's turn and
 * cleared the warnings the primary's tool results had recorded for this turn,
 * so the primary's turn_end delivered none of them; and the per-turn records
 * were one map, so either session's turn end delivered and cleared the
 * other's.
 */
describe("#3613 a concurrent secondary's turn leaves the primary's turn state alone", () => {
	const PRIMARY_RULE = "probe-3613-primary";
	const SUBAGENT_RULE = "probe-3613-subagent";

	beforeEach(() => {
		FLAGS.set("lens-actionable-warnings", true);
		// An actionable and a code-quality warning on line 1 of every analysed
		// file, named by the session that edits it: the subagent edits `sub.ts`.
		pipelineDouble.result = (filePath) => {
			const rule =
				path.basename(filePath) === "sub.ts" ? SUBAGENT_RULE : PRIMARY_RULE;
			// `key.ts` holds a hardcoded secret the ast-grep rule flags.
			const awRule =
				path.basename(filePath) === "key.ts"
					? "ts-hardcoded-secret-assignment"
					: "no-var";
			return {
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				actionableWarnings: [
					{
						id: `aw:${rule}`,
						filePath,
						displayPath: path.basename(filePath),
						line: 1,
						severity: "warning",
						tool: "ast-grep",
						rule: awRule,
						message: `AW-${rule}`,
						actions: [],
						suppressed: false,
						origin: "dispatch",
					},
				],
				codeQualityWarnings: [
					{
						id: `cq:${rule}`,
						filePath,
						displayPath: path.basename(filePath),
						line: 1,
						severity: "warning",
						tool: "ast-grep",
						rule,
						message: `${rule} fired`,
						category: "maintainability",
						origin: "dispatch",
					},
				],
			};
		};
	});

	afterEach(() => {
		FLAGS.delete("lens-actionable-warnings");
		pipelineDouble.result = undefined;
		pipelineDouble.analysed = [];
		vi.restoreAllMocks();
	});

	/**
	 * A concurrent secondary in the primary's project: pi-lens analyses only
	 * files under the primary's root.
	 */
	function startSubagent(): Promise<AgentSessionRuntime> {
		return startRuntime(SessionManager.inMemory(cwd));
	}

	async function startTurn(runtime: AgentSessionRuntime): Promise<void> {
		await runtime.session.extensionRunner.emit({
			type: "turn_start",
			turnIndex: 0,
			timestamp: Date.now(),
		} as never);
	}

	async function endTurn(runtime: AgentSessionRuntime): Promise<void> {
		await runtime.session.extensionRunner.emit({
			type: "turn_end",
			turnIndex: 0,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "x",
				provider: "x",
				model: "x",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
			toolResults: [],
		} as never);
	}

	/** One edit through the session's real tool_call and tool_result hooks. */
	let edits = 0;
	async function edit(runtime: AgentSessionRuntime, file: string) {
		const c = conversation(runtime);
		c.user(`edit ${path.basename(file)}`);
		await c.write(`call_edit_${++edits}`, file, "const a = 1;\n");
	}

	const sessionIdOf = (runtime: AgentSessionRuntime) =>
		runtime.session.sessionManager.getSessionId();

	/**
	 * An edit batch with one stale `oldText`: pi-lens applies the edit that
	 * still matches and runs the post-edit pipeline itself, from tool_call.
	 */
	async function partialEdit(runtime: AgentSessionRuntime, file: string) {
		const c = conversation(runtime);
		c.user(`edit ${path.basename(file)}`);
		await c.read(`call_read_${++edits}`, file);
		const id = `call_partial_${++edits}`;
		const args = {
			path: file,
			edits: [
				{ oldText: "const a = 1;", newText: "const a = 2;" },
				{ oldText: "const gone = 0;", newText: "const gone = 1;" },
			],
		};
		await runtime.session.agent.beforeToolCall?.({
			toolCall: { type: "toolCall", id, name: "edit", arguments: args },
			args,
		} as never);
	}

	/**
	 * Which session's warnings a context shows: `cq:<rule>` from the
	 * code-quality advisory, `aw:<file>` from the actionable one.
	 */
	function shown(text: string): string[] {
		const actionable =
			/Fixable warnings introduced this turn[\s\S]*?If continuing/.exec(
				text,
			)?.[0] ?? "";
		return [
			...[PRIMARY_RULE, SUBAGENT_RULE]
				.filter((rule) => text.includes(`${rule}×`))
				.map((rule) => `cq:${rule}`),
			...["a.ts", "sub.ts"]
				.filter((file) => actionable.includes(`  ${file}: `))
				.map((file) => `aw:${file}`),
		];
	}

	/** The per-turn records a coordinator holds for one session's turn. */
	const held = (coordinator: RuntimeCoordinator, sessionId?: string) => [
		...coordinator
			.peekCodeQualityWarnings(sessionId)
			.map((w) => `cq:${w.rule}`),
		...coordinator
			.peekActionableWarnings(sessionId)
			.map((w) => `aw:${path.basename(w.filePath)}`),
	];
	const PRIMARY = [`cq:${PRIMARY_RULE}`, "aw:a.ts"];
	const SUBAGENT = [`cq:${SUBAGENT_RULE}`, "aw:sub.ts"];

	it("keeps the primary's warnings, turn and write order when a subagent's turn starts", async () => {
		const seen = coordinators();
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const coordinator = seen[0]!;
		await startTurn(primary);
		await edit(primary, path.join(cwd, "a.ts"));
		const turnState = () => ({
			turnIndex: coordinator.turnIndex,
			orderTurn: coordinator.writeOrderTurn,
			writeIndex: coordinator.peekWriteIndex(),
			turnStartProjectSeq: coordinator.turnStartProjectSeq,
			warnings: held(coordinator),
		});
		const before = turnState();
		expect(before.warnings).toEqual(PRIMARY);
		const subagent = await startSubagent();

		await startTurn(subagent);

		expect(turnState()).toEqual(before);
		await endTurn(primary);
		expect(shown(await contextText(primary))).toEqual(PRIMARY);
	});

	it("keeps the primary's turns its own when its session start throws after the reset", async () => {
		// #3613 F1 (review r1 P1). The recurrence: the stable id was pinned only
		// after the start's await, so a swallowed throw there left the
		// coordinator on reset's random id, and every turn of the primary took
		// the other-session path: its turn index and order turn never moved.
		const seen: RuntimeCoordinator[] = [];
		const reset = RuntimeCoordinator.prototype.resetForSession;
		vi.spyOn(
			RuntimeCoordinator.prototype,
			"resetForSession",
		).mockImplementation(function (this: RuntimeCoordinator, ...args) {
			seen.push(this);
			reset.apply(this, args);
			throw new Error("probe-3613-F1: a session_start step after reset");
		});
		// Production swallows a session_start crash (`surfaceHandlerCrash`
		// rethrows only under Vitest), and the session goes on.
		const vitest = process.env.VITEST;
		delete process.env.VITEST;
		let primary: AgentSessionRuntime;
		try {
			primary = await startRuntime(SessionManager.inMemory(cwd));
		} finally {
			process.env.VITEST = vitest;
		}
		extensionErrors.splice(0);
		const coordinator = seen[0]!;
		const before = {
			turnIndex: coordinator.turnIndex,
			orderTurn: coordinator.writeOrderTurn,
		};

		await startTurn(primary);
		await edit(primary, path.join(cwd, "a.ts"));
		await endTurn(primary);
		await startTurn(primary);

		expect({
			id: coordinator.telemetrySessionId,
			turns: coordinator.turnIndex - before.turnIndex,
			orderMoved: coordinator.writeOrderTurn > before.orderTurn,
		}).toEqual({ id: sessionIdOf(primary), turns: 2, orderMoved: true });
	});

	/**
	 * A call of a tool pi-lens does not know as a writer, with a path: the
	 * observed-mutation net arms a baseline for it from tool_call, inside the
	 * per-turn observation budget.
	 */
	let opaqueCalls = 0;
	const opaqueTool = (id: string, file: string) => ({
		toolCall: {
			type: "toolCall",
			id,
			name: "probe_mcp_write",
			arguments: { path: file },
		},
		args: { path: file },
	});
	async function opaqueCallId(runtime: AgentSessionRuntime, file: string) {
		const id = `call_opaque_${++opaqueCalls}`;
		await runtime.session.agent.beforeToolCall?.(opaqueTool(id, file) as never);
		return { id, armed: hasPendingObservation(id) };
	}
	const opaqueCall = async (runtime: AgentSessionRuntime, file: string) =>
		(await opaqueCallId(runtime, file)).armed;
	/** The host's tool_result for an opaque call: the net settles it. */
	async function opaqueResult(
		runtime: AgentSessionRuntime,
		id: string,
		file: string,
	): Promise<void> {
		await runtime.session.agent.afterToolCall?.({
			...opaqueTool(id, file),
			result: { content: [{ type: "text", text: "ok" }], details: undefined },
			isError: false,
		} as never);
	}
	/** Spend the whole observation budget of the turn the net last charged. */
	const exhaustBudget = () =>
		_setObservedTurnBudgetForTests(
			_observedMutationStateForTests().turnIndex,
			OBSERVED_TURN_BUDGET_MS,
		);

	it("gives each of a subagent's turns its own observation budget", async () => {
		// #3613 F2 (review r1 P4). The recurrence: the budget keyed on the
		// primary's turn index, which a subagent's turns no longer move, so a
		// subagent that spent it in its first turn observed nothing for the
		// rest of its run.
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		const target = path.join(cwd, "opaque.txt");
		fs.writeFileSync(target, "x\n");
		await startTurn(primary);
		await startTurn(subagent);
		const firstArms = await opaqueCall(subagent, target);
		exhaustBudget();
		const spentTurnArms = await opaqueCall(subagent, target);

		await startTurn(subagent);

		expect({
			firstArms,
			spentTurnArms,
			nextTurnArms: await opaqueCall(subagent, target),
		}).toEqual({ firstArms: true, spentTurnArms: false, nextTurnArms: true });
	});

	it("charges a subagent's settled observation to its own turn", async () => {
		// #3613 F2: the settle in tool_result charges the turn the arm used.
		// The recurrence: the settle charged the primary's turn index, so a
		// subagent's observation time spent the primary's budget.
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		const target = path.join(cwd, "opaque.txt");
		fs.writeFileSync(target, "x\n");
		await startTurn(primary);
		await startTurn(subagent);
		const { id } = await opaqueCallId(subagent, target);
		const subagentTurn = _observedMutationStateForTests().turnIndex;
		await opaqueCall(primary, target);
		const primaryTurn = _observedMutationStateForTests().turnIndex;

		await opaqueResult(subagent, id, target);

		expect({
			distinct: subagentTurn !== primaryTurn,
			charged: _observedMutationStateForTests().turnIndex,
		}).toEqual({ distinct: true, charged: subagentTurn });
	});

	it("does not fire the memory sample at every subagent turn end while the primary sits on a sampling turn", async () => {
		// #3613 F2 (round 2). The recurrence: the cadence keyed on the
		// primary's turn index, which a subagent's turns no longer move, so
		// while the primary sat on a sampling turn every subagent turn end
		// wrote a sample.
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		for (let turn = 1; turn <= 10; turn += 1) await startTurn(primary);
		const before = (await latencyRows("memory_sample")).length;

		for (let turn = 1; turn <= 2; turn += 1) {
			await startTurn(subagent);
			await endTurn(subagent);
		}

		expect((await latencyRows("memory_sample")).length - before).toBe(0);
	});

	it("keeps the memory sample's cadence through a long subagent run inside one primary turn", async () => {
		// #3613 G1 (verify r2, probe MEM). The recurrence: round 2 paced the
		// cadence on a subagent's fractional turn key, which never meets the
		// `% 10` gate, so a long subagent run wrote no memory sample at all
		// (the process-level OOM signal, #1999).
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		await startTurn(primary);
		const before = (await latencyRows("memory_sample")).length;

		for (let turn = 1; turn <= 20; turn += 1) {
			await startTurn(subagent);
			await endTurn(subagent);
		}

		expect(
			(await latencyRows("memory_sample")).length - before,
		).toBeGreaterThan(0);
	});

	it("tightens the memory sample on the same turn count it paces on", async () => {
		// #3613 G1. The recurrence: the gate read the count of all turn starts
		// while the tightened window was recorded on the primary's turn index,
		// so a heap jump during a subagent run opened a window that had
		// already closed.
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		await startTurn(primary);
		// A one-byte last sample: the next real one reads as rapid growth.
		recordMemorySampleOutcome(1, 0);
		const before = (await latencyRows("memory_sample")).length;

		// Turn starts 2..11: the sample at 10 tightens, so 11 samples too.
		for (let turn = 1; turn <= 10; turn += 1) {
			await startTurn(subagent);
			await endTurn(subagent);
		}

		expect((await latencyRows("memory_sample")).length - before).toBe(2);
	});

	it("keeps the primary's spent budget spent through nine subagent turns inside its turn", async () => {
		// #3613 G2 (verify r2, probe E9). The recurrence: parking evicted the
		// smallest key, which is the primary's live turn (a subagent's keys sit
		// above it), so the ninth subagent turn handed the primary a fresh
		// budget.
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		const target = path.join(cwd, "opaque.txt");
		fs.writeFileSync(target, "x\n");
		await startTurn(primary);
		await opaqueCall(primary, target);
		exhaustBudget();
		const subagentArms: boolean[] = [];
		for (let turn = 1; turn <= 9; turn += 1) {
			await startTurn(subagent);
			subagentArms.push(await opaqueCall(subagent, target));
		}

		expect({
			subagentArms: subagentArms.every(Boolean),
			primaryArmsAgain: await opaqueCall(primary, target),
		}).toEqual({ subagentArms: true, primaryArmsAgain: false });
	});

	it("keeps a live subagent's spent budget spent through another subagent's nine turns", async () => {
		// #3613 G2 (verify r3 H1, probe LIVEA): a live concurrent session's
		// current turn is live too. The recurrence: liveness that counted only
		// the coordinator's own turn, so a second subagent's run evicted the
		// first subagent's spent turn and handed it a fresh budget.
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagentA = await startSubagent();
		const subagentB = await startSubagent();
		const target = path.join(cwd, "opaque.txt");
		fs.writeFileSync(target, "x\n");
		await startTurn(primary);
		await startTurn(subagentA);
		await opaqueCall(subagentA, target);
		exhaustBudget();
		const bArms: boolean[] = [];
		for (let turn = 1; turn <= 9; turn += 1) {
			await startTurn(subagentB);
			bArms.push(await opaqueCall(subagentB, target));
		}

		expect({
			bArms: bArms.every(Boolean),
			aArmsAgain: await opaqueCall(subagentA, target),
		}).toEqual({ bArms: true, aArmsAgain: false });
	});

	it("keeps the primary's spent observation budget spent while a subagent's turn interleaves", async () => {
		// #3613 F2. The recurrence it guards: per-session budget keys over the
		// net's one budget slot, so every switch between the two sessions'
		// calls reset the spend and neither turn was bounded.
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		const target = path.join(cwd, "opaque.txt");
		fs.writeFileSync(target, "x\n");
		await startTurn(primary);
		await opaqueCall(primary, target);
		exhaustBudget();
		await startTurn(subagent);

		const subagentArms = await opaqueCall(subagent, target);

		expect({
			subagentArms,
			primaryArmsAgain: await opaqueCall(primary, target),
		}).toEqual({ subagentArms: true, primaryArmsAgain: false });
	});

	it("delivers a subagent's own warnings at its turn end, after the primary's next turn starts", async () => {
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		await startTurn(subagent);
		await edit(subagent, path.join(cwd, "sub.ts"));
		await startTurn(primary);

		await endTurn(subagent);
		const subagentSees = await contextText(subagent);
		await edit(primary, path.join(cwd, "a.ts"));
		await endTurn(primary);
		const primarySees = await contextText(primary);

		expect({
			subagent: shown(subagentSees),
			primary: shown(primarySees),
		}).toEqual({ subagent: SUBAGENT, primary: PRIMARY });
	});

	it("delivers a subagent's warnings from an edit pi-lens applied in part at its own turn end", async () => {
		const seen = coordinators();
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const coordinator = seen[0]!;
		const subagent = await startSubagent();
		const sub = path.join(cwd, "sub.ts");
		fs.writeFileSync(sub, "const a = 1;\n");
		await startTurn(primary);
		await startTurn(subagent);

		await partialEdit(subagent, sub);
		const analysed = [...pipelineDouble.analysed];
		const primaryHolds = held(coordinator);
		await endTurn(subagent);

		expect({
			analysed,
			primaryHolds,
			subagentSees: shown(await contextText(subagent)),
		}).toEqual({ analysed: [sub], primaryHolds: [], subagentSees: SUBAGENT });
	});

	it("keeps the primary's warnings out of a subagent's turn end", async () => {
		const seen = coordinators();
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const coordinator = seen[0]!;
		const subagent = await startSubagent();
		await startTurn(primary);
		await startTurn(subagent);
		await edit(primary, path.join(cwd, "a.ts"));

		await endTurn(subagent);

		expect({
			subagentSees: shown(await contextText(subagent)),
			primaryKeeps: held(coordinator),
		}).toEqual({ subagentSees: [], primaryKeeps: PRIMARY });
	});

	it("enriches only the primary's secret report with the primary's ast-grep match", async () => {
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		const key = path.join(cwd, "key.ts");
		await startTurn(primary);
		await startTurn(subagent);
		await edit(primary, key);
		// A gitleaks scan after the edit: its finding is live for both
		// sessions, which share the project's scan cache.
		new CacheManager(false).writeCache(
			"gitleaks",
			{
				success: true,
				scannedAt: new Date().toISOString(),
				findings: [{ ruleId: "aws-access-token", file: key, startLine: 1 }],
			},
			cwd,
		);

		await endTurn(subagent);
		const subagentSees = await contextText(subagent);
		await endTurn(primary);
		const primarySees = await contextText(primary);

		const provenance = (text: string) =>
			/key\.ts:1 — aws-access-token \[([^\]]*)\]/.exec(text)?.[1];
		expect({
			subagent: provenance(subagentSees),
			primary: provenance(primarySees),
		}).toEqual({ subagent: "gitleaks", primary: "gitleaks + ast-grep" });
	});

	it("starts a subagent's turn without the warnings its previous turn left undelivered", async () => {
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		await startTurn(primary);
		await startTurn(subagent);
		await edit(subagent, path.join(cwd, "sub.ts"));

		// The turn ended with no turn_end (an aborted turn); the next one starts.
		await startTurn(subagent);
		await endTurn(subagent);

		expect(shown(await contextText(subagent))).toEqual([]);
	});

	it("keeps a subagent's warnings across the primary's /new", async () => {
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		await startTurn(primary);
		await startTurn(subagent);
		await edit(subagent, path.join(cwd, "sub.ts"));

		await primary.newSession();
		await endTurn(subagent);

		expect(shown(await contextText(subagent))).toEqual(SUBAGENT);
	});

	it("re-analyses a subagent's unchanged file on its next turn", async () => {
		// The recurrence it guards: gating the turn_start's dedupe clear to
		// the primary with the rest of the turn state. The dedupe keys on the
		// primary's turn index, which a subagent's turn no longer moves.
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		const sub = path.join(cwd, "sub.ts");
		await startTurn(primary);
		await startTurn(subagent);
		await edit(subagent, sub);
		await endTurn(subagent);

		await startTurn(subagent);
		await edit(subagent, sub);

		expect(pipelineDouble.analysed).toEqual([sub, sub]);
	});

	it("advances a subagent's own turn id and leaves the primary's", async () => {
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const subagent = await startSubagent();
		await startTurn(primary);
		await startTurn(subagent);
		await startTurn(subagent);

		await edit(subagent, path.join(cwd, "sub.ts"));
		await edit(primary, path.join(cwd, "a.ts"));

		await flushLatencyLog();
		const turnIds = new Set(
			fs
				.readFileSync(getLatencyLogPath(), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => (JSON.parse(line) as { turnId?: string }).turnId),
		);
		expect({
			subagent: turnIds.has(`${sessionIdOf(subagent)}:2`),
			primary: turnIds.has(`${sessionIdOf(primary)}:1`),
			primaryMoved: turnIds.has(`${sessionIdOf(primary)}:3`),
		}).toEqual({ subagent: true, primary: true, primaryMoved: false });
	});

	it("drops a subagent's per-turn records when it shuts down before its turn end", async () => {
		const seen = coordinators();
		const primary = await startRuntime(SessionManager.inMemory(cwd));
		const coordinator = seen[0]!;
		const subagent = await startSubagent();
		const subagentId = sessionIdOf(subagent);
		await startTurn(primary);
		await startTurn(subagent);
		await edit(subagent, path.join(cwd, "sub.ts"));
		await edit(primary, path.join(cwd, "a.ts"));
		const recorded = held(coordinator, subagentId);

		await subagent.dispose();
		runtimes.splice(runtimes.indexOf(subagent), 1);

		expect({
			recorded,
			left: held(coordinator, subagentId),
			primary: held(coordinator),
			// Its turn key goes too: the session's id now keys the primary's turn.
			turnKey: coordinator.turnKey(subagentId) === coordinator.turnIndex,
		}).toEqual({
			recorded: SUBAGENT,
			left: [],
			primary: PRIMARY,
			turnKey: true,
		});
	});
});

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
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
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
): Promise<AgentSessionRuntime> {
	const runtime = await createAgentSessionRuntime(
		async ({ cwd: runtimeCwd, sessionManager: sm, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				extensionFlagValues: FLAGS,
				resourceLoaderOptions: {
					extensionFactories: [extension, ...alongside],
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
		{ cwd, agentDir, sessionManager },
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
async function turnEnd(runtime: AgentSessionRuntime): Promise<void> {
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
async function scopeTransitionRows(): Promise<Record<string, unknown>[]> {
	await flushLatencyLog();
	const text = fs.existsSync(getLatencyLogPath())
		? fs.readFileSync(getLatencyLogPath(), "utf8")
		: "";
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((row) => row.phase === "session_scope_transition")
		.map((row) => row.metadata as Record<string, unknown>);
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

	it("keeps the session's mtime anchor across /reload, so a file changed after the session began stays authored (D5)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		c.user("prompt 1");
		c.done();
		// Written after the session began, by nothing the guard records.
		const file = path.join(cwd, "late.conf");
		fs.writeFileSync(file, "l1\nl2\nl3");
		expect(await c.editLine("pre_late", file, 2, "Y", false)).toBe("ALLOW");

		await reload(runtime);

		expect(await c.editLine("post_late", file, 2, "Y", false)).toBe("ALLOW");
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
describe("#3612 a queued agent advisory follows /reload", () => {
	/** Observe (not replace) the coordinators index.ts resets. */
	function coordinators(): RuntimeCoordinator[] {
		const seen: RuntimeCoordinator[] = [];
		const reset = RuntimeCoordinator.prototype.resetForSession;
		vi.spyOn(
			RuntimeCoordinator.prototype,
			"resetForSession",
		).mockImplementation(function (this: RuntimeCoordinator, ...args) {
			seen.push(this);
			return reset.apply(this, args);
		});
		return seen;
	}

	async function contextText(runtime: AgentSessionRuntime): Promise<string> {
		const messages = await runtime.session.extensionRunner.emitContext([
			{ role: "user", content: "keep working", timestamp: Date.now() },
		] as never);
		return JSON.stringify(messages);
	}

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
	 * #3819 (TLC `H3FileLess`): a file-less slot matched on its reason alone.
	 * An in-process subagent that binds in the primary's replacement gap
	 * (declined, #3662) and then reloads or forks itself sends a non-startup
	 * start with no primary registered, so it classifies primary (#3668 row
	 * 17). The recurrence: that start took the primary's slot and adopted its
	 * lazy-tool activations, its queued advisory and its authorship.
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
			return { subagent: subagent!, written, a };
		}

		function subjects(kind: string): string[] {
			return getDegradationSummary()
				.filter((group) => group.kind === kind)
				.flatMap((group) => group.latestReasons.map((r) => r.subject));
		}
		const missedSubjects = () => subjects("session-scope-handoff-missed");

		for (const kind of ["reload", "fork"] as const) {
			it(`gives a subagent's own ${kind} in the gap none of the primary's activations, advisories or authorship`, async () => {
				const { subagent, written, a } = await gapSubagentReplaces(kind);
				const s = conversation(subagent);

				expect.soft(activeSituational(subagent)).toEqual([]);
				expect
					.soft(await contextText(subagent))
					.not.toContain("lost edit in a.rs");
				expect
					.soft(await s.editLine("sub_written", written, 2, "Y", false))
					.toEqual(ZERO_READ);
				// Reads never crossed: the read guard imports only the records
				// whose tool call is on the adopting session's branch.
				expect
					.soft(await s.editLine("sub_a", a, 2, "Y", false))
					.toEqual(ZERO_READ);
				// Each crossing is its own soft assertion, so a red names every
				// store that crossed. The subagent's start found no slot of its
				// own and recorded it.
				expect.soft(missedSubjects()).toEqual([kind]);
			});
		}

		/**
		 * TLC's 5-step `HandoffOnce` trace (the #3835 review): the ticket key
		 * alone left the primary's reload slot in place, because the gap
		 * subagent's own fork took nothing. That subagent, now primary, runs
		 * /new; in its gap the session it demoted reloads itself, classifies
		 * primary, and took the stale slot its own predecessor never left.
		 */
		for (const store of ["file-backed", "in-memory"] as const) {
			it(`never lets a later reload of the demoted ${store} session take its predecessor's slot`, async () => {
				let primary: AgentSessionRuntime | undefined;
				let subagent: AgentSessionRuntime | undefined;
				let demotedReloaded = false;
				const reloadDemotedInNewGap = (pi: ExtensionAPI) => {
					pi.on("session_shutdown", async (event) => {
						if ((event as { reason?: string }).reason !== "new") return;
						if (demotedReloaded) return;
						demotedReloaded = true;
						await reload(primary!);
					});
				};
				const forkInGap = (pi: ExtensionAPI) => {
					pi.on("session_shutdown", async (event) => {
						if ((event as { reason?: string }).reason !== "reload") return;
						if (subagent) return;
						subagent = await startRuntime(SessionManager.inMemory(cwd), [
							reloadDemotedInNewGap,
						]);
						const s = conversation(subagent);
						s.user("subagent prompt 1");
						s.done();
						const su2 = s.user("subagent prompt 2");
						s.done();
						await subagent.fork(su2);
					});
				};
				primary = await startRuntime(
					store === "file-backed"
						? SessionManager.create(cwd, sessionsDir)
						: SessionManager.inMemory(cwd),
					[forkInGap],
				);

				// The reload leaves its slot; in its gap the subagent's own fork
				// classifies primary and the real successor is demoted.
				await reload(primary);
				// The demoted successor discarded the slot left for it (#3819 r2).
				expect(subjects("session-scope-handoff-discarded")).toEqual(["reload"]);
				// The subagent's /new leaves no slot; in its gap the demoted
				// session reloads itself and classifies primary.
				await subagent!.newSession();

				expect(demotedReloaded).toBe(true);
				const reloadStarts = (await scopeTransitionRows()).filter(
					(row) => row.transition === "start" && row.reason === "reload",
				);
				expect(
					reloadStarts.map((row) => [row.role, row.handoffSource]),
				).toEqual([
					["secondary", undefined],
					// The sidecar the first reload's shutdown saved, not the slot
					// that shutdown left for the start it demoted.
					["primary", "own-sidecar"],
				]);
			});
		}

		/**
		 * The r1 review's F1 probe: option (a) cleared the slot at every
		 * primary start. A gap subagent's own /reload classifies primary (row
		 * 17), takes nothing, and quits inside the gap, so the real successor
		 * still classifies primary. The recurrence: that start found the slot
		 * cleared, and an in-memory /fork lost its activations.
		 */
		for (const store of ["in-memory", "file-backed"] as const) {
			it(`keeps an in-memory /fork's activations when a gap subagent (${store}) reloads itself and quits inside the gap`, async () => {
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
						await reload(subagent);
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

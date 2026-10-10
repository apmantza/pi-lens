/**
 * #3873: the session-scope hand-off and its neighbours leave one record per
 * decision in `latency.log`.
 *
 * Recurrence prevented (live dogfood session 2026-09-30, builds B2/B3): S2's
 * fixes fired once and could not be shown firing again. #3819 (stale slot),
 * #3855 (demoted successor), #3759 (late-write fence) and #3705 left zero
 * rows, so "the fix fired" was indistinguishable from a logging gap, and
 * `read_guard_branch_retained {kept: 0, dropped: 0}` read the same for a
 * missing sidecar, an empty read set and a payload the importer ignored.
 *
 * The lifecycle cases (O1-O6) drive pi 0.85's REAL `AgentSessionRuntime`, as
 * `tests/index-3521-fork-tree-witness.test.ts` does (#2825): pi itself runs
 * the factory and emits every lifecycle event, and each assertion reads a row
 * back from the real `latency.log`. The slot, nudge, fence and chain cases
 * call the real module functions. Nothing is mocked; the only process
 * boundary a case crosses is none.
 *
 * Not shared with the witness file on purpose: #4114 and #4118 are editing it,
 * so the harness below is a copy of the parts these cases need; fold the two
 * after both land.
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
	consumeAgentNudge,
	queueAgentAdvisory,
	recordCrossProcessTouches,
	_resetAgentNudgeForTests,
} from "../clients/agent-nudge.js";
import { hashText } from "../clients/finding-identity.js";
import { _seedProcessSingletonCellForTests } from "../clients/process-singletons.js";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	createGenerationSource,
	emitFenceRollupAtSessionEnd,
} from "../clients/generation-guard.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLastLoggedPhase,
	getLatencyLogPath,
	logLatency,
} from "../clients/latency-logger.js";
import { _resetRecentTouchesForTests } from "../clients/recent-touches.js";
import { chainLateFormatResync } from "../clients/pipeline.js";
import {
	flushSessionStartLog,
	SESSIONSTART_LOG_FILE,
} from "../clients/sessionstart-logger.js";
import { normalizeMapKey } from "../clients/path-utils.js";
import { createReadGuard } from "../clients/read-guard.js";
import { READ_GUARD_CELL } from "../clients/read-guard-branch.js";
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	adoptHandoff,
	beginScope,
	discardHandoff,
	forwardHandoff,
	retireScope,
	scopeCell,
	stashHandoff,
	takeHandoff,
} from "../clients/session-scope.js";
import {
	cleanupTestEnvironmentsDrained,
	drainBackgroundWritesForTests,
	setupTestEnvironment,
} from "./clients/test-utils.js";

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

const TMP_PREFIX = "pi-lens-3873-";
let env: ReturnType<typeof setupTestEnvironment>;
let root: string;
let cwd: string;
let agentDir: string;
let sessionsDir: string;
let previousDataDir: string | undefined;
let previousTestMode: string | undefined;
const runtimes: AgentSessionRuntime[] = [];
const extensionErrors: unknown[] = [];

beforeEach(async () => {
	_resetSessionLifecycleForTests();
	_resetAgentNudgeForTests();
	_resetRecentTouchesForTests();
	env = setupTestEnvironment(TMP_PREFIX);
	root = env.tmpDir;
	cwd = path.join(root, "proj");
	agentDir = path.join(root, "agent");
	sessionsDir = path.join(root, "sessions");
	for (const dir of [cwd, path.join(cwd, ".git"), agentDir, sessionsDir])
		fs.mkdirSync(dir, { recursive: true });
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(root, "data");
	// `logLatency` writes nothing in test mode.
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	// The hand-off slot is a process singleton: leave none from an earlier
	// case, then start each case from an empty log.
	const clearing = beginScope({ role: "primary" });
	stashHandoff(clearing, {
		reason: "reload",
		sessionFile: "/s/clear.jsonl",
		targetSessionFile: undefined,
	});
	takeHandoff("reload", "/s/clear.jsonl");
	clearLatencyLog();
	await flushLatencyLog();
});

afterEach(async () => {
	try {
		for (const runtime of runtimes.splice(0)) await runtime.dispose();
		await drainBackgroundWritesForTests();
		expect(extensionErrors.splice(0)).toEqual([]);
	} finally {
		vi.restoreAllMocks();
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
		async ({
			cwd: runtimeCwd,
			sessionManager: sm,
			sessionStartEvent: event,
		}) => {
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
					sessionStartEvent: event,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{ cwd, agentDir, sessionManager },
	);
	const bindings = { onError: (error: unknown) => extensionErrors.push(error) };
	runtime.setRebindSession(async () => {
		await runtime.session.bindExtensions(bindings);
	});
	await runtime.session.bindExtensions(bindings);
	runtimes.push(runtime);
	return runtime;
}

/** A user prompt, an assistant text turn and one `read` of `file`, on the live session. */
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
	return {
		S,
		user: (text: string): string =>
			append({ role: "user", content: text, timestamp: Date.now() }),
		done: (): string =>
			append(assistant([{ type: "text", text: "done" }], "stop")),
		async read(id: string, file: string) {
			const args = { path: file };
			append(
				assistant([{ type: "toolCall", id, name: "read", arguments: args }]),
			);
			await S().agent.beforeToolCall?.({
				toolCall: { type: "toolCall", id, name: "read", arguments: args },
				args,
			} as never);
			const result = await createReadToolDefinition(cwd).execute(
				id,
				args,
				undefined,
				undefined,
				{ cwd } as never,
			);
			const patched = (await S().agent.afterToolCall?.({
				toolCall: { type: "toolCall", id, name: "read", arguments: args },
				args,
				result: { content: result.content, details: undefined },
				isError: false,
			} as never)) as { content?: unknown[] } | undefined;
			append({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: patched?.content ?? result.content,
				isError: false,
				timestamp: Date.now(),
			});
		},
	};
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

/** A row's `metadata`: the fields the cases narrow, and the rest as written. */
interface Row {
	[field: string]: unknown;
	storeNames?: string[];
	fileKeys?: string[];
	tried?: Array<{ storeNames?: string[]; [field: string]: unknown }>;
	sources?: Array<{ source: string }>;
}

/** The metadata of every `phase` row in `latency.log`, in write order. */
async function rows(phase: string): Promise<Row[]> {
	await flushLatencyLog();
	const text = fs.existsSync(getLatencyLogPath())
		? fs.readFileSync(getLatencyLogPath(), "utf8")
		: "";
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { phase?: string; metadata?: Row })
		.filter((row) => row.phase === phase)
		.map((row) => row.metadata as Row);
}

async function reload(runtime: AgentSessionRuntime): Promise<void> {
	await runtime.session.reload();
}

/** Let a fire-and-forget sidecar write land (no timer: yield the loop). */
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

describe("#3873 O1: the hand-off slot leaves a record per transition", () => {
	// Recurrence: #3819's stale slot had no witness. A slot left and taken, or
	// left and never taken, left no trace at all.
	it("/reload writes one stashed row and one taken row naming the same slot", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		c.user("prompt 1");
		await c.read("call_read_a", fixture("a.conf", 6));
		c.done();

		await reload(runtime);

		const slot = await rows("session_handoff_slot");
		expect(slot.map((row) => [row.op, row.reason, row.by])).toEqual([
			["stashed", "reload", undefined],
			["taken", "reload", "adopt"],
		]);
		expect(slot[0]?.keyHash).toMatch(/^file:[0-9a-f]{8}$/);
		expect(slot[1]?.keyHash).toBe(slot[0]?.keyHash);
		expect(slot[0]?.storeNames).toEqual(
			expect.arrayContaining(["read-guard", "read-guard-authorship"]),
		);
		expect(slot[1]?.ageMs).toEqual(expect.any(Number));
	});

	it("a slot replaced before any start took it names the slot it replaced and its age", () => {
		const first = beginScope({ role: "primary" });
		const second = beginScope({ role: "primary" });
		stashHandoff(first, {
			reason: "fork",
			sessionFile: "/s/a.jsonl",
			targetSessionFile: "/s/b.jsonl",
		});
		stashHandoff(second, {
			reason: "reload",
			sessionFile: "/s/c.jsonl",
			targetSessionFile: undefined,
		});

		return rows("session_handoff_slot").then((slot) => {
			expect(slot.map((row) => row.op)).toEqual(["stashed", "replaced"]);
			expect(slot[1]).toMatchObject({
				reason: "reload",
				replacedReason: "fork",
				replacedKeyHash: slot[0]?.keyHash,
			});
			expect(slot[1]?.replacedAgeMs).toEqual(expect.any(Number));
		});
	});

	it("a start whose key is not the slot's leaves the slot and names who asked", async () => {
		stashHandoff(beginScope({ role: "primary" }), {
			reason: "fork",
			sessionFile: "/s/a.jsonl",
			targetSessionFile: "/s/b.jsonl",
		});

		expect(takeHandoff("fork", "/s/other.jsonl", "discard")).toBeUndefined();
		expect(takeHandoff("fork", "/s/b.jsonl", "adopt")).toBeDefined();

		const slot = await rows("session_handoff_slot");
		expect(slot.map((row) => [row.op, row.by])).toEqual([
			["stashed", undefined],
			["key-mismatch-left", "discard"],
			["taken", "adopt"],
		]);
		expect(slot[1]).toMatchObject({
			reason: "fork",
			askedReason: "fork",
		});
		expect(slot[1]?.askedKeyHash).not.toBe(slot[1]?.keyHash);
	});

	it("a quit with a slot nobody took writes unconsumed-at-exit, and a /new shutdown writes nothing", async () => {
		stashHandoff(beginScope({ role: "primary" }), {
			reason: "reload",
			sessionFile: "/s/a.jsonl",
			targetSessionFile: undefined,
		});
		stashHandoff(beginScope({ role: "primary" }), {
			reason: "new",
			sessionFile: "/s/a.jsonl",
			targetSessionFile: "/s/new.jsonl",
		});
		stashHandoff(beginScope({ role: "primary" }), {
			reason: "quit",
			sessionFile: "/s/a.jsonl",
			targetSessionFile: undefined,
		});

		const slot = await rows("session_handoff_slot");
		expect(slot.map((row) => row.op)).toEqual([
			"stashed",
			"unconsumed-at-exit",
		]);
		expect(slot[1]?.reason).toBe("reload");
	});

	it("a forward re-keys the slot as a forwarded row and keeps the snapshot's age", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const manager = {};
		stashHandoff(beginScope({ role: "primary" }), {
			reason: "reload",
			sessionFile: undefined,
			targetSessionFile: undefined,
			sessionManager: manager,
		});
		vi.advanceTimersByTime(5_000);
		forwardHandoff({
			startReason: "reload",
			reason: "reload",
			sessionFile: undefined,
			targetSessionFile: undefined,
			sessionManager: manager,
		});
		vi.useRealTimers();

		const slot = await rows("session_handoff_slot");
		expect(slot.map((row) => [row.op, row.by])).toEqual([
			["stashed", undefined],
			["taken", "forward"],
			["forwarded", undefined],
		]);
		expect(slot[2]?.keyHash).toMatch(/^ticket:\d+$/);
		// Re-keyed, not re-stashed: the forwarded slot is as old as the snapshot.
		expect(slot[2]?.ageMs).toBe(5_000);
	});
});

describe("#3873 round 2: a stale slot, and a slot an earlier build left", () => {
	// F4. Recurrence: a slot that outlives its successor stays in place ("a slot
	// left for another start stays"), and every declined start asks for it, so
	// one stale slot wrote a `key-mismatch-left` row per start (51 rows, 16.6 KB
	// from one slot and 50 declined starts in the review probe).
	it("50 declined starts against one stale slot write one key-mismatch-left row; a new slot is told again", async () => {
		const stash = (file: string) =>
			stashHandoff(beginScope({ role: "primary" }), {
				reason: "reload",
				sessionFile: file,
				targetSessionFile: undefined,
			});
		stash("/s/stale.jsonl");
		for (let i = 0; i < 50; i += 1)
			discardHandoff({
				reason: "startup",
				sessionFile: `/s/sub-${i}.jsonl`,
				sessionManager: undefined,
			});
		stash("/s/next.jsonl");
		discardHandoff({
			reason: "startup",
			sessionFile: "/s/sub-next.jsonl",
			sessionManager: undefined,
		});

		expect((await rows("session_handoff_slot")).map((row) => row.op)).toEqual([
			"stashed",
			"key-mismatch-left",
			"replaced",
			"key-mismatch-left",
		]);
	});

	// F6. Recurrence: a version bump on the hand-off cell made a build that
	// meets a pre-#3873 cell discard it, so an in-place upgrade's `/reload`
	// lost the reads, authorship and lazy tools its predecessor had left.
	it("takes a slot an earlier build stashed (no `at`) and reports no age for it", async () => {
		_seedProcessSingletonCellForTests("session-scope.handoff", {
			schema: "pi-lens.process-singletons",
			version: 2,
			value: {
				handoff: {
					reason: "reload",
					key: "/s/old.jsonl",
					stores: { "lazy-tool-memory": ["ast_grep_search"] },
				},
				left: new WeakMap(),
			},
		});

		expect(takeHandoff("reload", "/s/old.jsonl")).toEqual({
			"lazy-tool-memory": ["ast_grep_search"],
		});
		const [taken] = await rows("session_handoff_slot");
		expect(taken).toMatchObject({ op: "taken", by: "adopt" });
		expect(taken?.ageMs).toBeUndefined();
	});
});

describe("#3873 O2, O3: the adopt walk and each store's action", () => {
	// Recurrence: B3 logged `read_guard_branch_retained {kept: 0, dropped: 0,
	// branchToolResults: 1034}` and nothing else, which read the same for a
	// missing sidecar, a version-1 payload and an empty read set; the other
	// stores logged nothing at all on adopt or reset.
	it("/reload adopts the slot and reports each store's items in and kept", async () => {
		const seen = coordinators();
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		c.user("prompt 1");
		await c.read("call_read_a", fixture("a.conf", 6));
		c.done();
		await activateTools(runtime, "act", ["ast_grep_search"]);
		queueAgentAdvisory(
			"lost edit in a.rs",
			seen[0]!.captureSessionGeneration(),
		);

		await reload(runtime);

		const adopt = (await rows("session_handoff_adopt")).at(-1);
		expect(adopt).toMatchObject({ reason: "reload", chosen: "slot" });
		expect(adopt?.tried).toEqual([
			expect.objectContaining({ source: "slot", found: true }),
		]);
		expect(adopt?.tried?.[0]?.storeNames).toEqual(
			expect.arrayContaining([
				"read-guard",
				"lazy-tool-memory",
				"agent-advisories",
			]),
		);
		const actions = new Map(
			(await rows("session_store_action"))
				.filter((row) => row.reason === "reload")
				.map((row) => [row.store, row]),
		);
		expect(actions.get("widget")).toMatchObject({ action: "skip" });
		expect(actions.get("read-guard")).toMatchObject({
			action: "adopt",
			source: "slot",
			itemsIn: 1,
			itemsKept: 1,
			itemsDropped: 0,
		});
		expect(actions.get("lazy-tool-memory")).toMatchObject({
			action: "adopt",
			itemsIn: 1,
			itemsKept: 1,
		});
		expect(actions.get("agent-advisories")).toMatchObject({
			action: "adopt",
			itemsIn: 1,
			itemsKept: 1,
		});
		expect(actions.get("read-guard-authorship")).toMatchObject({
			action: "adopt",
			itemsIn: 0,
		});
		expect((await rows("read_guard_branch_retained")).at(-1)).toMatchObject({
			trigger: "reload",
			kept: 1,
			dropped: 0,
			payloadReads: 1,
		});
		// The restart readout (B2 printed `rehydrated N file(s)`): one line a
		// start in sessionstart.log, naming each store's items kept of items in.
		await flushSessionStartLog();
		expect(fs.readFileSync(SESSIONSTART_LOG_FILE, "utf8")).toMatch(
			/session_start: stores from slot — widget skip, read-guard adopt 1\/1, .*agent-advisories adopt 1\/1, lazy-tool-memory adopt 1\/1/,
		);
	});

	it("a resume from the sidecar names the sidecar it read, and a branch move shows in payloadReads", async () => {
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
		await turnEnd(runtime);
		await c.S().navigateTree(p1Done);
		c.user("prompt 2 on branch Y");
		c.done();

		await runtime.switchSession(c.S().sessionManager.getSessionFile()!);

		const adopt = (await rows("session_handoff_adopt")).at(-1);
		expect(adopt).toMatchObject({ reason: "resume", chosen: "own-sidecar" });
		expect(adopt?.tried).toEqual([
			expect.objectContaining({
				source: "own-sidecar",
				found: true,
				version: 2,
				ageMs: expect.any(Number),
			}),
		]);
		expect(adopt?.tried?.[0]?.storeNames).toEqual(
			expect.arrayContaining(["widget", "read-guard"]),
		);
		expect((await rows("read_guard_branch_retained")).at(-1)).toMatchObject({
			trigger: "resume",
			source: "own-sidecar",
			kept: 1,
			dropped: 1,
			payloadReads: 2,
		});
		expect(
			(await rows("session_store_action")).filter(
				(row) => row.reason === "resume" && row.store === "read-guard",
			),
		).toEqual([
			expect.objectContaining({ itemsIn: 2, itemsKept: 1, itemsDropped: 1 }),
		]);
	});

	it("a launch with no sidecar says both candidates were absent, and kept 0 reads payloadReads null", async () => {
		await startRuntime(SessionManager.create(cwd, sessionsDir));

		const adopt = (await rows("session_handoff_adopt")).at(-1);
		expect(adopt).toMatchObject({ reason: "startup", chosen: "none" });
		expect(adopt?.tried).toEqual([
			{ source: "own-sidecar", found: false },
			{ source: "parent-sidecar", found: false },
		]);
		expect((await rows("read_guard_branch_retained")).at(-1)).toMatchObject({
			kept: 0,
			dropped: 0,
			payloadReads: null,
		});
	});

	it("tells an empty read set, an ignored version-1 payload and a missing payload apart", async () => {
		const sidecar = (stores: Record<string, unknown>) => ({
			savedAt: Date.now(),
			stores,
		});
		const start = async (stores: Record<string, unknown> | undefined) => {
			const scope = beginScope({ role: "primary" });
			scopeCell(scope, READ_GUARD_CELL, () => createReadGuard("o2"));
			await adoptHandoff(scope, {
				reason: "resume",
				sessionFile: "/s/a.jsonl",
				sessionManager: undefined,
				cwd,
				loadOwnSidecar: async () => stores && sidecar(stores),
				loadParentSidecar: async () => undefined,
			});
		};
		const v1Record = {
			filePath: "/x/a.ts",
			requestedOffset: 1,
			requestedLimit: 3,
			effectiveOffset: 1,
			effectiveLimit: 3,
			expandedByLsp: false,
			turnIndex: 1,
			writeIndex: 1,
			timestamp: Date.now(),
		};

		const empty = createReadGuard("empty").exportState();
		await start({ "read-guard": empty });
		await start({
			"read-guard": { version: 1, reads: [["/x/a.ts", [v1Record]]] },
		});
		await start(undefined);

		const moves = (await rows("read_guard_branch_retained")).map((row) => ({
			kept: row.kept,
			dropped: row.dropped,
			payloadReads: row.payloadReads,
			payloadVersion: row.payloadVersion,
		}));
		// The three look identical in `kept`/`dropped`; `payloadReads` splits them.
		expect(moves).toEqual([
			{ kept: 0, dropped: 0, payloadReads: 0, payloadVersion: empty.version },
			{ kept: 0, dropped: 0, payloadReads: 1, payloadVersion: 1 },
			{ kept: 0, dropped: 0, payloadReads: null, payloadVersion: null },
		]);
	});

	it("a migrated version-1 envelope reports version 1 and the stores it actually held", async () => {
		const scope = beginScope({ role: "primary" });
		scopeCell(scope, READ_GUARD_CELL, () => createReadGuard("v1"));
		const { loadSessionState } =
			await import("../clients/session-state-store.js");
		const dir = path.join(getProjectDataDir(cwd), "sessions");
		fs.mkdirSync(dir, { recursive: true });
		fs.copyFileSync(
			path.join(__dirname, "fixtures", "session-state", "v1-widget.json"),
			path.join(dir, "v1-widget.json"),
		);

		await adoptHandoff(scope, {
			reason: "resume",
			sessionFile: "/s/a.jsonl",
			sessionManager: undefined,
			cwd,
			loadOwnSidecar: () => loadSessionState(cwd, "v1-widget"),
			loadParentSidecar: async () => undefined,
		});

		const adopt = (await rows("session_handoff_adopt")).at(-1);
		expect(adopt?.tried).toEqual([
			expect.objectContaining({
				source: "own-sidecar",
				found: true,
				version: 1,
				// The v1 file has no read-set: `read-guard` is absent, not empty.
				storeNames: ["widget"],
			}),
		]);
	});

	it("hands the per-store summary to dbg, one line a start", async () => {
		const scope = beginScope({ role: "primary" });
		scopeCell(scope, READ_GUARD_CELL, () => createReadGuard("dbg"));
		const lines: string[] = [];

		await adoptHandoff(scope, {
			reason: "new",
			sessionFile: undefined,
			sessionManager: undefined,
			cwd,
			loadOwnSidecar: async () => undefined,
			loadParentSidecar: async () => undefined,
			dbg: (line) => lines.push(line),
		});

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/^session_start: stores from none — widget reset, read-guard reset/,
		);
	});
});

describe("#3873 O4: a scope's end and a gap demotion", () => {
	// Recurrence: `session_scope_transition` only ever said `start`, `shutdown`
	// and `tree`. A scope superseded without a shutdown, and a start the gap
	// demoted to secondary (#3855), left no row that said so.
	it("writes an end row for a scope its coordinator superseded, and none for one a shutdown already retired", async () => {
		const coordinator = new RuntimeCoordinator();
		// The scope the coordinator was constructed with; its first reset supersedes it.
		const constructed = coordinator.sessionScope;
		coordinator.resetForSession();
		const orphan = coordinator.sessionScope;
		coordinator.resetForSession();
		const retired = coordinator.sessionScope;
		retireScope(retired, "fork");
		coordinator.resetForSession();

		const ends = (await rows("session_scope_transition")).filter(
			(row) => row.transition === "end",
		);
		// `retired` ended by a shutdown (its row is `logScopeTransition`'s at the
		// call site in index.ts), so superseding it again writes nothing.
		expect(ends.map((row) => [row.scopeId, row.reason, row.role])).toEqual([
			[constructed.scopeId, "superseded", "primary"],
			[orphan.scopeId, "superseded", "primary"],
		]);
	});

	it("writes a demote row for a gap start that is not the named successor, and none for a subagent beside a live primary", async () => {
		const subagentInGap = (pi: ExtensionAPI) => {
			let ran = false;
			pi.on("session_shutdown", async (event) => {
				if ((event as { reason?: string }).reason !== "reload" || ran) return;
				ran = true;
				await startRuntime(SessionManager.inMemory(cwd));
			});
		};
		const primary = await startRuntime(
			SessionManager.create(cwd, sessionsDir),
			[subagentInGap],
		);

		await reload(primary);

		const demotes = (await rows("session_scope_transition")).filter(
			(row) => row.transition === "demote",
		);
		expect(demotes).toEqual([
			expect.objectContaining({
				role: "secondary",
				reason: "startup",
				basis: "successor-pending",
				lineageMatch: "not-named",
				classification: "concurrent-secondary",
				gapMs: expect.any(Number),
				discardedSlot: false,
			}),
		]);
	});

	it("writes no demote row for a subagent that binds beside a live primary", async () => {
		await startRuntime(SessionManager.inMemory(cwd));
		await startRuntime(SessionManager.inMemory(cwd));

		const transitions = await rows("session_scope_transition");
		expect(transitions.map((row) => [row.transition, row.role])).toEqual([
			["start", "primary"],
			["start", "secondary"],
		]);
	});
});

describe("#3873 O5: the fence rollup", () => {
	// Recurrence: `generation-guard-stale-write` goes through a power-of-two
	// ledger, so zero rows meant zero drops or a fence nothing exercised, and
	// the session-end bus rollup covered only the bus side.
	it("counts guarded and dropped writes per declared source, once, then starts over", async () => {
		const source = createGenerationSource("fence-rollup-probe");
		const early = source.capture();
		early.guardedWrite("a", () => "kept");
		source.bump();
		early.guardedWrite("b", () => "dropped");
		source.capture().guardedWrite("c", () => "kept");

		emitFenceRollupAtSessionEnd(cwd);
		emitFenceRollupAtSessionEnd(cwd);

		const rollups = await rows("session_end_fence_rollup");
		expect(rollups).toHaveLength(2);
		expect(rollups[0]?.sources).toEqual(
			expect.arrayContaining([
				{ source: "fence-rollup-probe", guarded: 3, dropped: 1 },
			]),
		);
		expect(rollups[0]).toMatchObject({
			guardedTotal: expect.any(Number),
			droppedTotal: expect.any(Number),
		});
		expect(rollups[1]?.sources).toEqual([]);
	});

	// Recurrence: unbounded row growth on a repeat decision. The row names the
	// 16 busiest fences; the rest are counted. Runs before the declaration-cap
	// case below, which fills the declaration table.
	it("names at most 16 sources in a rollup row and counts the rest", async () => {
		emitFenceRollupAtSessionEnd(cwd);
		for (let i = 0; i < 20; i += 1)
			createGenerationSource(`fence-rollup-cap-${String(i).padStart(2, "0")}`)
				.capture()
				.guardedWrite("w", () => i);
		clearLatencyLog();
		await flushLatencyLog();

		emitFenceRollupAtSessionEnd(cwd);

		const [rollup] = await rows("session_end_fence_rollup");
		expect(rollup?.sources).toHaveLength(16);
		expect(rollup).toMatchObject({ guardedTotal: 20, sourcesOmitted: 4 });
	});

	it("folds sources past the declaration cap into one (other) entry instead of growing the tally", async () => {
		// `declare` keeps 128 names; 130 more guarantee the last are undeclared.
		for (let i = 0; i < 130; i += 1)
			createGenerationSource(`fence-cap-probe-${i}`)
				.capture()
				.guardedWrite("w", () => i);

		emitFenceRollupAtSessionEnd(cwd);

		const [rollup] = await rows("session_end_fence_rollup");
		const sources: Array<{ source: string }> = rollup?.sources ?? [];
		const names = sources.map((entry) => entry.source);
		expect(names).toContain("(other)");
		expect(names).not.toContain("fence-cap-probe-129");
	});

	it("writes exactly one rollup row at a primary session_shutdown, even when no fence was used", async () => {
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		await runtime.dispose();
		runtimes.splice(runtimes.indexOf(runtime), 1);

		expect(await rows("session_end_fence_rollup")).toHaveLength(1);
	});
});

describe("#3873 O6: session_start_total names why the start was primary", () => {
	// Recurrence: all four starts of the B3 window read `classification:
	// primary, sameRoot: unknown`; the gap age and the lineage input the
	// decision consulted were not recorded.
	it("a launch is primary with no prior primary and no gap", async () => {
		await startRuntime(SessionManager.inMemory(cwd));

		const total = (await rows("session_start_total")).at(-1);
		expect(total).toMatchObject({
			classification: "primary",
			basis: "no-prior-primary",
			lineageMatch: "none",
		});
		expect(total?.gapMs).toBeUndefined();
	});

	it("a /reload successor reports the gap it started in and that it is the named one", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));

		await reload(runtime);

		const totals = await rows("session_start_total");
		expect(totals.at(-1)).toMatchObject({
			reason: "reload",
			classification: "primary",
			basis: "no-prior-primary",
			lineageMatch: "named",
			gapMs: expect.any(Number),
		});
	});
});

describe("#3873 O7: the agent_nudge row names what it delivered", () => {
	// Recurrence: "the same advisory delivered three times" after a restart
	// replay needed inference from counts; the row held no file identity,
	// origin session or queue epoch.
	it("carries hashed file keys, the writers' session ids, the consuming scope and a drain epoch", async () => {
		const scope = beginScope({ role: "primary" });
		recordCrossProcessTouches([
			// Not in key form: the row hashes the accumulator key, not this spelling.
			{ path: "/repo/./a.ts", reason: "format", sessionId: "other-session" },
			{ path: "/repo/b.ts", reason: "autofix" },
		]);
		consumeAgentNudge(undefined, scope);
		recordCrossProcessTouches([
			{ path: "/repo/a.ts", reason: "format", sessionId: "other-session" },
		]);
		consumeAgentNudge(undefined, scope);

		const nudges = await rows("agent_nudge");
		expect(nudges).toHaveLength(2);
		expect(nudges[0]).toMatchObject({
			scopeId: scope.scopeId,
			queueEpoch: 1,
			originSessionIds: ["other-session"],
			originCrossProcess: 2,
		});
		expect(nudges[0]?.fileKeys).toHaveLength(2);
		// The same touch replayed: same file key, a later drain.
		expect(nudges[1]?.queueEpoch).toBe(2);
		expect(nudges[0]?.fileKeys).toContain(nudges[1]?.fileKeys?.[0]);
		// A hash of the accumulator key, never the path itself.
		expect(nudges[0]?.fileKeys).toEqual(
			expect.arrayContaining([hashText(normalizeMapKey("/repo/a.ts"), 8)]),
		);
		for (const key of nudges[0]?.fileKeys ?? [])
			expect(key).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("#3873 round 2: the agent_nudge row's bounds and producers", () => {
	// F1. Recurrence: unbounded row growth on a repeat decision. A drain of
	// many files, from many writer sessions, still writes one bounded row.
	it("names at most 8 file keys and 4 writer sessions in one row", async () => {
		recordCrossProcessTouches(
			Array.from({ length: 9 }, (_, i) => ({
				path: `/repo/f${i}.ts`,
				reason: "format" as const,
				sessionId: `writer-${i % 5}`,
			})),
		);

		consumeAgentNudge(undefined, beginScope({ role: "primary" }));

		const [row] = await rows("agent_nudge");
		expect(row).toMatchObject({ filesTotal: 9 });
		expect(row?.fileKeys).toHaveLength(8);
		expect(row?.originSessionIds).toEqual([
			"writer-0",
			"writer-1",
			"writer-2",
			"writer-3",
		]);
	});

	// F2. Recurrence: `originSessionIds` is only ever filled by the two
	// `index.ts` cross-process readers; without a producer proof both
	// pass-throughs could be dropped and the field would read `[]` forever.
	function otherProcessTouched(sessionId: string): string {
		const file = path.join(cwd, `touched-${sessionId}.ts`);
		fs.writeFileSync(file, "x");
		const dir = getProjectDataDir(cwd);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "recent-touches.json"),
			JSON.stringify({
				entries: [
					{
						path: file,
						reason: "format",
						ts: Date.now(),
						pid: process.pid + 1,
						sessionId,
					},
				],
			}),
		);
		return file;
	}

	async function drainedNudge(runtime: AgentSessionRuntime): Promise<Row> {
		for (let i = 0; i < 5000; i += 1) {
			await runtime.session.extensionRunner.emitContext([
				{ role: "user", content: "keep working", timestamp: Date.now() },
			] as never);
			const [row] = await rows("agent_nudge");
			if (row) return row;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		throw new Error("no agent_nudge row");
	}

	it("session_start passes a writer's session id from the shared touch record", async () => {
		otherProcessTouched("writer-at-start");

		const runtime = await startRuntime(SessionManager.inMemory(cwd));

		expect((await drainedNudge(runtime)).originSessionIds).toEqual([
			"writer-at-start",
		]);
	});

	it("turn_start passes a writer's session id from the shared touch record", async () => {
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		otherProcessTouched("writer-at-turn");

		await runtime.session.extensionRunner.emit({
			type: "turn_start",
			turnIndex: 1,
			timestamp: Date.now(),
		} as never);

		expect((await drainedNudge(runtime)).originSessionIds).toEqual([
			"writer-at-turn",
		]);
	});
});

describe("#3873 round 2: decision rows do not take over stall attribution", () => {
	// F1. Recurrence: `loop_block` names the last logged phase as its cause. A
	// zero-duration decision row (or a give-up row whose durationMs is the
	// formatter's age) that wins that slot blames the record for a stall the
	// real phase before it owns.
	for (const phase of [
		"session_handoff_slot",
		"session_handoff_adopt",
		"session_store_action",
		"session_end_fence_rollup",
		"format_late_resync_chained",
	])
		it(`${phase} is not the last phase after real work`, () => {
			logLatency({
				type: "phase",
				phase: "real_work_for_3873",
				filePath: "x",
				durationMs: 5,
			});

			logLatency({ type: "phase", phase, filePath: "x", durationMs: 0 });

			expect(getLastLoggedPhase()?.phase).toBe("real_work_for_3873");
		});
});

describe("#3873 F1: a formatter give-up leaves a per-file row at chain time", () => {
	// Recurrence (#3909 review F1): the in-band path wrote its late row only
	// on settlement, and an Escape or a formatter that never settles left no
	// per-file record that the pipeline had given up.
	for (const which of ["inband", "deferred"] as const) {
		it(`${which}: one row at chain time, before the formatter settles`, async () => {
			let settle!: () => void;
			const settled = new Promise<void>((resolve) => {
				settle = resolve;
			});
			const late = `${which}_format_late_resync`;

			void chainLateFormatResync(
				settled,
				which,
				{ toolName: "write", filePath: "/repo/f.ts", startedAt: Date.now() },
				() => {},
			);

			// The give-up is on record while the formatter is still running.
			expect(await rows("format_late_resync_chained")).toEqual([{ which }]);
			expect(await rows(late)).toEqual([]);
			// Let the chain finish (yielding the loop, no timer) so nothing outlives the case.
			settle();
			for (let i = 0; i < 5000 && (await rows(late)).length === 0; i += 1)
				await new Promise<void>((resolve) => setImmediate(resolve));
			expect(await rows(late)).toHaveLength(1);
		});
	}

	it("swallows a rejected late resync without an unhandled rejection", async () => {
		// Recurrence (#3858): the abandoned formatter's detached continuation must
		// not turn a late formatter/LSP failure into a host-level unhandled rejection.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			void chainLateFormatResync(
				Promise.reject(new Error("late formatter failed")),
				"inband",
				{ toolName: "write", filePath: "/repo/f.ts", startedAt: Date.now() },
				() => {},
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

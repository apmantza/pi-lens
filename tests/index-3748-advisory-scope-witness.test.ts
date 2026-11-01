/**
 * #3748 item 1, the pi host ADAPTER: `index.ts`'s `context` handler drains the
 * agent advisory queue for the scope its own activation serves.
 *
 * The recurrence this prevents: `consumeAgentNudge(dbg)` passing no scope. The
 * queue is drained per scope (`tests/clients/agent-advisory-scope.test.ts`),
 * so that call would silently stop delivering the primary's own advisory, such
 * as the #3741 fix-run loss notice, while every unit test stayed green.
 *
 * Real: the extension, its host-mock `session_start` and `context` handlers,
 * and the `RuntimeCoordinator` `index.ts` owns, reached by observing the
 * `resetForSession` its session start performs. Nothing is faked.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	queueAgentAdvisory,
	_resetAgentNudgeForTests,
} from "../clients/agent-nudge.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import extension from "../index.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

let tmpDir: string;
let childrenBeforeCase: ReadonlySet<number>;

// lane: unit-linux. The census reads `/proc`, which only Linux has. Other hosts
// still run each case as written and skip only the census below.
const CENSUS_HOST = process.platform === "linux";

/**
 * The `ast-grep lsp` children this worker owns (#5146): alive, parented to this
 * process, launched as `ast-grep lsp`. The #2042 kill guard refuses a child that
 * outlives its worker, found later by the production orphan sweep. Read from
 * `/proc`, so the census spawns nothing.
 */
function astGrepLspChildrenOwnedHere(): number[] {
	const owned: number[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			// `pid (comm) state ppid ...`: `comm` may hold spaces, so split after `)`.
			const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
			const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (Number(ppid) !== process.pid || state === "Z" || state === "X") {
				continue;
			}
			const argv = fs
				.readFileSync(`/proc/${entry}/cmdline`, "utf8")
				.split("\0");
			if (path.basename(argv[0] ?? "") === "ast-grep" && argv[1] === "lsp") {
				owned.push(Number(entry));
			}
		} catch {
			// Exited between the listing and the read: not a live child.
		}
	}
	return owned;
}

type PiMock = ReturnType<typeof createPiMock>;

/**
 * The sessions the running case started (#5146). `endOpenSessions` ends them in
 * the teardown; a session never shut down keeps the LSP its `tool_result` spawned
 * alive after the worker exits.
 */
const openSessions: { pi: PiMock; cwd: string; sessionId: string }[] = [];

async function startSession(
	pi: PiMock,
	cwd: string,
	sessionId: string,
): Promise<void> {
	openSessions.push({ pi, cwd, sessionId });
	await pi.emit(
		"session_start",
		makeSessionStartEvent(),
		makeCtx({ cwd, sessionId }),
	);
}

/**
 * Ends the case's sessions in reverse start order, as the host does. The
 * primary, started first, ends last and runs the shared teardown, the LSP fleet
 * reset; a secondary's shutdown skips it while a session is still live (#4554).
 */
async function endOpenSessions(): Promise<void> {
	for (let s = openSessions.pop(); s !== undefined; s = openSessions.pop()) {
		await s.pi.emit(
			"session_shutdown",
			{ reason: "quit" },
			makeCtx({ cwd: s.cwd, sessionId: s.sessionId }),
		);
	}
}

beforeEach(() => {
	// The census judges only the children a case created: a child a sibling file
	// left in this worker is not this case's to answer for.
	childrenBeforeCase = new Set(
		CENSUS_HOST ? astGrepLspChildrenOwnedHere() : [],
	);
	// The process primary registration, the advisory queue and the scopes are
	// process-global. Clearing the lifecycle state per case keeps a primary left
	// by ANOTHER suite (same vitest worker) from turning this file's first start
	// into a declined secondary, which would make the two cases below assert
	// against a different classification than the one they name.
	_resetSessionLifecycleForTests();
	_resetAgentNudgeForTests();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3748-advisory-"));
});

afterEach(async () => {
	await endOpenSessions();
	vi.restoreAllMocks();
	removeTempDirSync(tmpDir);
	// #5146: a case whose `tool_result` spawned an ast-grep LSP must end its
	// sessions, or the child is still alive here and orphans when the worker exits.
	if (CENSUS_HOST) {
		expect(
			astGrepLspChildrenOwnedHere().filter(
				(pid) => !childrenBeforeCase.has(pid),
			),
		).toEqual([]);
	}
});

describe("pi context delivers the primary's own queued advisory (#3748)", () => {
	it("injects an advisory queued under the activation's session scope", async () => {
		const runtimes: RuntimeCoordinator[] = [];
		const resetForSession = RuntimeCoordinator.prototype.resetForSession;
		vi.spyOn(
			RuntimeCoordinator.prototype,
			"resetForSession",
		).mockImplementation(function (this: RuntimeCoordinator, ...args) {
			runtimes.push(this);
			return resetForSession.apply(this, args);
		});
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await startSession(pi, tmpDir, "pi-3748-advisory-session");
		const runtime = runtimes[0];
		expect(runtime).toBeDefined();
		queueAgentAdvisory("lost edit in a.rs", runtime.captureSessionGeneration());

		const injected = (await pi.emit(
			"context_with_system",
			makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-advisory-session" }),
		)) as { messages?: Array<{ role?: string; content: string }> } | undefined;

		// #4631 round 5 (F2): the transcript leads with the host's system head, and
		// the delivery keeps it — dropping it would red here, not ship a
		// promptless request.
		expect((injected?.messages ?? [])[0]?.role).toBe("system");
		expect(
			(injected?.messages ?? []).map((m) => m.content).join("\n"),
		).toContain("lost edit in a.rs");

		// Release the process primary, so the case below starts one of its own
		// rather than being declined behind a leaked registration.
		await endOpenSessions();
	});

	it("drains the requesting session's own scope after a concurrent start (#4631 F3)", async () => {
		// The window this closes: on pi 0.87+ the drain runs in
		// `context_with_system`, the LAST phase of the host's `emitContext`, after
		// every other extension's `context` handler has been awaited. `scope` is
		// activation-wide and `session_start` reassigns it, so a concurrent
		// in-process start (#473) landing in that window used to make the primary's
		// request drain the SECONDARY's scope: the primary's own advisory stayed
		// queued and never reached the model.
		const runtimes: RuntimeCoordinator[] = [];
		const resetForSession = RuntimeCoordinator.prototype.resetForSession;
		vi.spyOn(
			RuntimeCoordinator.prototype,
			"resetForSession",
		).mockImplementation(function (this: RuntimeCoordinator, ...args) {
			runtimes.push(this);
			return resetForSession.apply(this, args);
		});
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await startSession(pi, tmpDir, "pi-3748-primary");
		const primary = runtimes[0];
		expect(primary).toBeDefined();
		queueAgentAdvisory("lost edit in a.rs", primary.captureSessionGeneration());

		// The concurrent start. A DIFFERENT root makes the classification
		// unambiguous (#473: a subagent sharing the activation): the primary is
		// live, so this start is declined as a concurrent-secondary and its own
		// scope REPLACES the activation-wide `scope`. Asserted, so a state change
		// that admitted it as a replacement start cannot quietly retarget the
		// case: an admitted start retires the primary's scope, which is a
		// different scenario (the session really ended).
		const secondaryCwd = path.join(tmpDir, "secondary-root");
		fs.mkdirSync(secondaryCwd, { recursive: true });
		await startSession(pi, secondaryCwd, "pi-3748-secondary");
		expect(runtimes).toHaveLength(1);

		const injected = (await pi.emit(
			"context_with_system",
			makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-primary" }),
		)) as { messages?: Array<{ role?: string; content: string }> } | undefined;

		// #4631 round 5 (F2): the transcript leads with the host's system head, and
		// the delivery keeps it — dropping it would red here, not ship a
		// promptless request.
		expect((injected?.messages ?? [])[0]?.role).toBe("system");
		expect(
			(injected?.messages ?? []).map((m) => m.content).join("\n"),
		).toContain("lost edit in a.rs");
	});

	it("drains the activation-wide scope when this activation never recorded the requesting session (#4631 F3 fallback)", async () => {
		// #4631 round 6 (R6-2): the OTHER arm of the same drain. The lookup
		// (`liveSessionMembers.find(...)`) answers for a session this activation
		// started; when the request names a session it never recorded, the
		// activation-wide `scope` is the only identity left and the fallback
		// carries it. Without one of the two arms, a branch that returns
		// `undefined` here would silently stop delivering and every case above
		// would stay green.
		const runtimes: RuntimeCoordinator[] = [];
		const resetForSession = RuntimeCoordinator.prototype.resetForSession;
		vi.spyOn(
			RuntimeCoordinator.prototype,
			"resetForSession",
		).mockImplementation(function (this: RuntimeCoordinator, ...args) {
			runtimes.push(this);
			return resetForSession.apply(this, args);
		});
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await startSession(pi, tmpDir, "pi-3748-recorded");
		const recorded = runtimes[0];
		expect(recorded).toBeDefined();
		queueAgentAdvisory(
			"lost edit in b.rs",
			recorded.captureSessionGeneration(),
		);

		// The request's own session id is NOT in `liveSessionMembers`: no
		// `session_start` in this activation carried it, so the lookup answers
		// nothing and the drain must fall back to the activation-wide scope.
		const injected = (await pi.emit(
			"context_with_system",
			makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-never-recorded" }),
		)) as { messages?: Array<{ role?: string; content: string }> } | undefined;

		expect((injected?.messages ?? [])[0]?.role).toBe("system");
		expect(
			(injected?.messages ?? []).map((m) => m.content).join("\n"),
		).toContain("lost edit in b.rs");
	});
});

/**
 * #5108 review F1, the class sweep: `handleToolResult` queued every agent
 * advisory under the coordinator's scope, which is the PRIMARY's. A concurrent
 * secondary (#473) shares that coordinator but drains its own member scope, so
 * a notice about the secondary's edit reached the primary's context and never
 * the secondary's. Recurrence prevented: any `queueAgentAdvisory` site in the
 * tool_result path that takes `writeSession` instead of `deps.advisoryScope`.
 *
 * Real: the extension, both session starts, the real `tool_result` handler and
 * its root classification, the advisory queue and the `context_with_system`
 * drain. The secondary's root sits OUTSIDE the primary's, so the coordinator's
 * root classifies the secondary's edit.
 */
describe("a tool_result advisory reaches the session that made the edit (#5108 F1)", () => {
	async function twoSessions(secondaryRoot: string) {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await startSession(pi, tmpDir, "pi-5108-primary");
		await startSession(pi, secondaryRoot, "pi-5108-secondary");
		const contextOf = async (cwd: string, sessionId: string) => {
			const injected = (await pi.emit(
				"context_with_system",
				makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
				makeCtx({ cwd, sessionId }),
			)) as { messages?: Array<{ content: unknown }> } | undefined;
			return (injected?.messages ?? [])
				.map((m) => JSON.stringify(m.content))
				.join("\n");
		};
		return { pi, contextOf };
	}

	// A sibling of the temp root, not under it and not `pi-lens-`-prefixed: a
	// pi-owned temp path is the intended-skip class and never notifies (#4560).
	let outsideRoot: string;
	beforeEach(() => {
		outsideRoot = path.join(
			tmpDir,
			"..",
			`capture-5108-${process.pid}-${Math.random().toString(16).slice(2)}`,
		);
		fs.mkdirSync(outsideRoot, { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(outsideRoot, { recursive: true, force: true });
	});

	it("delivers the outside-root notice to the secondary, not the primary", async () => {
		const file = path.join(outsideRoot, "outside.ts");
		fs.writeFileSync(file, "export const value = 1;\n");
		const { pi, contextOf } = await twoSessions(outsideRoot);
		await pi.emit(
			"tool_result",
			{
				toolName: "edit",
				toolCallId: "ed-5108-outside",
				input: { path: file },
				content: [{ type: "text", text: "ok" }],
			},
			makeCtx({ cwd: outsideRoot, sessionId: "pi-5108-secondary" }),
		);

		const secondary = await contextOf(outsideRoot, "pi-5108-secondary");
		const primary = await contextOf(tmpDir, "pi-5108-primary");
		expect(secondary).toContain("outside the session root");
		expect(secondary).toContain("outside.ts");
		expect(primary).not.toContain("outside.ts");
	});

	it("delivers the adopted-project notice to the secondary, not the primary", async () => {
		// A project marker makes the secondary's root a separate project of the
		// coordinator's, the `adopted` class.
		fs.writeFileSync(
			path.join(outsideRoot, "package.json"),
			'{"name":"adopted-5108"}\n',
		);
		const file = path.join(outsideRoot, "adopted.ts");
		fs.writeFileSync(file, "export const value = 1;\n");
		const { pi, contextOf } = await twoSessions(outsideRoot);
		await pi.emit(
			"tool_result",
			{
				toolName: "edit",
				toolCallId: "ed-5108-adopted",
				input: { path: file },
				content: [{ type: "text", text: "ok" }],
			},
			makeCtx({ cwd: outsideRoot, sessionId: "pi-5108-secondary" }),
		);

		const secondary = await contextOf(outsideRoot, "pi-5108-secondary");
		const primary = await contextOf(tmpDir, "pi-5108-primary");
		expect(secondary).toContain("as a separate project");
		expect(primary).not.toContain("as a separate project");
	});
});

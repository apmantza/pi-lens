/**
 * #3611 (S1 of the #3609 design): session scope tickets, the lineage handle,
 * and the process order turn, through real coordinators, the real widget
 * store, the real observed-mutation net and the real degradation ledger.
 *
 * The recurrences these prevent:
 * - N3 (#3540 case A): a `/reload` that re-evaluates the entry module builds
 *   a new coordinator whose per-instance order turn restarts, while the
 *   widget module keeps its write guards, so the live session's own verdict
 *   is dropped as older.
 * - N4: two coordinators' session generations both start at 0, so the
 *   process-wide observed-mutation net diffs one session's baseline against
 *   another session's call.
 * - A handle that stays current after its session's `session_shutdown`, or
 *   after a `/tree`, and so lets a late writer land in state the conversation
 *   no longer holds.
 *
 * A "simulated entry re-evaluation" here is the real thing: `vi.resetModules`
 * plus a dynamic import evaluates `runtime-coordinator.js` (and
 * `session-scope.js`) a second time, while the widget module this file
 * imported statically stays the one module, as `clients/` modules do across
 * a `/reload` (design §1.3).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { resetMutationAttribution } from "../../clients/mutation-attribution.js";
import {
	armObservedMutation,
	type ObservedReplayEntry,
	resetObservedMutationNet,
	settleObservedMutation,
} from "../../clients/observed-mutation.js";
import { _seedProcessSingletonCellForTests } from "../../clients/process-singletons.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	adoptHandoff,
	beginScope,
	discardHandoff,
	forwardHandoff,
	nextOrderTurn,
	type PersistedStores,
	retireScope,
	stashHandoff,
	takeHandoff,
} from "../../clients/session-scope.js";
import {
	getRememberedLazyTools,
	rememberLazyTools,
} from "../../clients/tool-set-policy.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnostics,
	recordDiagnostics,
} from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

type CoordinatorModule = typeof import("../../clients/runtime-coordinator.js");

/** A second evaluation of the coordinator module, as a `/reload` fallback makes. */
async function reEvaluatedCoordinatorModule(): Promise<CoordinatorModule> {
	vi.resetModules();
	return (await import("../../clients/runtime-coordinator.js")) as CoordinatorModule;
}

function staleWriteSubjects(): string[] {
	return getDegradationSummary()
		.filter((group) => group.kind === "generation-guard-stale-write")
		.flatMap((group) => group.latestReasons.map((r) => r.subject));
}

let env: ReturnType<typeof setupTestEnvironment>;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-3611-scope-");
	clearWidgetState();
	resetDegradationLedger();
	resetObservedMutationNet();
	resetMutationAttribution();
});

afterEach(() => {
	clearWidgetState();
	// The hand-off slot is a process singleton; leave none behind. A
	// file-less slot is keyed by a ticket, so replace it with a known one.
	stashHandoff(beginScope({ role: "primary" }), {
		reason: "reload",
		sessionFile: "/s/own.jsonl",
		targetSessionFile: undefined,
	});
	takeHandoff("reload", "/s/own.jsonl");
	env.cleanup();
});

describe("#3611 N3: the order turn is one process counter", () => {
	it("a turn-1 widget write from a re-evaluated coordinator outranks a turn-5 token from the first", async () => {
		const file = path.join(env.tmpDir, "a.ts");
		const first = new RuntimeCoordinator();
		first.resetForSession();
		for (let turn = 0; turn < 5; turn += 1) first.beginTurn();
		expect(
			recordDiagnostics(
				file,
				[{ message: "from session 1", severity: "error", line: 1 }],
				first.nextWriteOrderToken(),
			),
		).toBe(true);

		// `/reload` re-evaluates the entry: a new coordinator, same widget module.
		const { RuntimeCoordinator: ReEvaluated } =
			await reEvaluatedCoordinatorModule();
		const second = new ReEvaluated();
		second.resetForSession();
		second.beginTurn();
		expect(second.turnIndex).toBe(1);

		expect(
			recordDiagnostics(
				file,
				[{ message: "from session 2", severity: "error", line: 1 }],
				second.nextWriteOrderToken(),
			),
		).toBe(true);
		expect(getFileDiagnostics(file)?.map((d) => d.message)).toEqual([
			"from session 2",
		]);
	});
});

describe("#3611 N4: scope tickets are process-unique", () => {
	it("two coordinators' session generations never compare equal in the observed-mutation settle", async () => {
		const file = path.join(env.tmpDir, "patched.ts");
		fs.writeFileSync(file, "const a = 1;\n");
		const first = new RuntimeCoordinator();
		first.resetForSession();
		const { RuntimeCoordinator: ReEvaluated } =
			await reEvaluatedCoordinatorModule();
		const second = new ReEvaluated();
		second.resetForSession();

		// Session 1 arms a baseline for a call id; session 2 settles that id.
		await armObservedMutation({
			toolCallId: "call-3611",
			toolName: "patch_file",
			targetPath: file,
			cwd: env.tmpDir,
			sessionGeneration: first.sessionGeneration,
			turnIndex: 1,
		});
		fs.writeFileSync(file, "const a = 2;\n");
		const replayed: ObservedReplayEntry[] = [];
		const settled = await settleObservedMutation({
			toolCallId: "call-3611",
			toolName: "patch_file",
			sessionGeneration: second.sessionGeneration,
			turnIndex: 1,
			record: (entry) => {
				replayed.push(entry);
				return true;
			},
		});

		expect(settled).toMatchObject({
			settled: false,
			reason: "session-generation-advanced",
		});
		expect(replayed).toEqual([]);
		expect(second.sessionGeneration).not.toBe(first.sessionGeneration);
	});
});

describe("#3611 r2 F2: another build's registry cell hands over its counters", () => {
	// getProcessSingleton replaces a cell of another version. Without the
	// hand-over both counters restart, tickets collide (N4) and the order turn
	// falls (N3) whenever two builds meet in one process.
	it("a new coordinator's ticket and order turn stay above a version-mismatched cell's", () => {
		const first = new RuntimeCoordinator();
		first.resetForSession();
		for (let turn = 0; turn < 3; turn += 1) first.beginTurn();
		// Another build's live cell: same counters, another version.
		_seedProcessSingletonCellForTests("session-scope.registry", {
			schema: "pi-lens.process-singletons",
			version: 999,
			value: {
				nextTicket: first.sessionGeneration,
				orderTurn: first.writeOrderTurn,
			},
		});

		const second = new RuntimeCoordinator();
		second.resetForSession();
		second.beginTurn();

		expect(second.sessionGeneration).toBeGreaterThan(first.sessionGeneration);
		expect(second.writeOrderTurn).toBeGreaterThan(first.writeOrderTurn);
	});

	it("a cell whose counters are not positive integers seeds nothing", () => {
		_seedProcessSingletonCellForTests("session-scope.registry", {
			schema: "pi-lens.process-singletons",
			version: 999,
			value: { nextTicket: "7", orderTurn: -3 },
		});
		expect(beginScope({ role: "primary" }).scopeId).toBe(1);
		expect(nextOrderTurn()).toBe(1);
	});
});

describe("#3611 the lineage handle", () => {
	it("stops being current when its scope retires at session_shutdown, and its write drops with the runtime-session record", () => {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		const handle = runtime.captureSessionGeneration();
		expect(handle.isCurrent()).toBe(true);
		expect(handle.generation).toBe(runtime.sessionGeneration);

		retireScope(runtime.sessionScope, "reload");

		expect(handle.isCurrent()).toBe(false);
		expect(runtime.isCurrentSession(handle.generation)).toBe(false);
		expect(handle.guardedWrite("late-write", () => "landed")).toBeUndefined();
		expect(staleWriteSubjects()).toEqual(["runtime-session:late-write"]);
	});

	it("is superseded by resetForSession, which draws a fresh ticket and names its predecessor", () => {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		const before = runtime.captureSessionGeneration();
		const previous = runtime.sessionScope;

		runtime.resetForSession();

		expect(before.isCurrent()).toBe(false);
		expect(previous.retiredBy()).toBe("superseded");
		expect(runtime.sessionScope.parentScopeId).toBe(previous.scopeId);
		expect(runtime.sessionGeneration).not.toBe(previous.scopeId);
		const after = runtime.captureSessionGeneration();
		expect(after.isCurrent()).toBe(true);
		expect(after.guardedWrite("own-write", () => "landed")).toBe("landed");
	});

	it("goes branch-stale on /tree and stays session-current; a handle with no /tree is current at both levels", () => {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		const handle = runtime.captureSessionGeneration();
		expect(handle.isCurrent("session")).toBe(true);
		expect(handle.isCurrent("branch")).toBe(true);

		runtime.readGuard.retainBranch(new Set());

		expect(handle.isCurrent("session")).toBe(true);
		// A bare isCurrent() is the GenerationHandle contract: session level.
		expect(handle.isCurrent()).toBe(true);
		expect(handle.isCurrent("branch")).toBe(false);
		// One epoch: the read guard's is its scope's.
		expect(runtime.readGuard.currentBranchEpoch).toBe(
			runtime.sessionScope.branchEpoch(),
		);
		expect(runtime.captureSessionGeneration().branchEpoch).toBe(
			handle.branchEpoch + 1,
		);
	});

	it("keeps the primary current when a secondary's scope retires", () => {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		const primary = runtime.captureSessionGeneration();
		const secondary = beginScope({ role: "secondary" });
		expect(secondary.scopeId).not.toBe(runtime.sessionGeneration);

		retireScope(secondary, "quit");

		expect(primary.isCurrent("branch")).toBe(true);
		expect(runtime.sessionScope.isLive()).toBe(true);
	});

	it("ends a scope whose shutdown carried no reason", () => {
		// An older host or an RPC shutdown can omit the reason; the scope must
		// still stop being current.
		const scope = beginScope({ role: "primary" });
		const handle = scope.capture();
		retireScope(scope, undefined);
		expect(scope.isLive()).toBe(false);
		expect(scope.retiredBy()).toBe("shutdown");
		expect(handle.isCurrent()).toBe(false);
	});

	it("keeps the first retirement reason when a scope is retired twice", () => {
		const scope = beginScope({ role: "primary" });
		retireScope(scope, "reload");
		retireScope(scope, "superseded");
		expect(scope.retiredBy()).toBe("reload");
	});
});

/** A primary scope whose conversation activated `tools`. */
function scopeWith(tools: string[]) {
	const scope = beginScope({ role: "primary" });
	rememberLazyTools(scope, tools);
	return scope;
}

/**
 * #3612 (F2, maintainer decision on #3609): the slot is consumed only by the
 * start it was left for. The recurrences: a start for another session file
 * (or a subagent's `startup` in a file-less process) takes the primary's
 * hand-off, and the real successor starts empty; or a mismatching start
 * discards a slot its real successor still needs. The S9 model cannot
 * witness either direction (mutations c05 and c06 survive there).
 */
describe("#3612 the hand-off slot (F2)", () => {
	it("is taken by the start whose reason and session file equal its key, once", () => {
		stashHandoff(scopeWith(["ast_grep_search"]), {
			reason: "fork",
			sessionFile: "/s/parent.jsonl",
			targetSessionFile: "/s/child.jsonl",
		});

		expect(takeHandoff("fork", "/s/child.jsonl")).toEqual(
			expect.objectContaining({ "lazy-tool-memory": ["ast_grep_search"] }),
		);
		expect(takeHandoff("fork", "/s/child.jsonl")).toBeUndefined();
	});

	it("stays in place for a start with another file, then goes to the matching start", () => {
		stashHandoff(scopeWith(["ast_grep_search"]), {
			reason: "fork",
			sessionFile: "/s/parent.jsonl",
			targetSessionFile: "/s/child.jsonl",
		});

		expect(takeHandoff("fork", "/s/other.jsonl")).toBeUndefined();
		expect(takeHandoff("fork", undefined)).toBeUndefined();
		expect(takeHandoff("fork", "/s/child.jsonl")).toBeDefined();
	});

	// #3819: a file-less slot matched on its reason alone, so a gap
	// subagent's own reload took the primary's hand-off.
	it("keys a file-less session on the ticket of the scope that left it", () => {
		const left = scopeWith(["ast_grep_search"]);
		// A host without a session manager object leaves an unbound slot; a
		// WeakMap key that is not an object would throw into the shutdown.
		for (const sessionManager of ["manager", null])
			stashHandoff(left, {
				reason: "reload",
				sessionFile: undefined,
				targetSessionFile: undefined,
				sessionManager,
			});

		expect(takeHandoff("reload", undefined)).toBeUndefined();
		expect(takeHandoff("reload", left.scopeId + 1)).toBeUndefined();
		expect(takeHandoff("startup", left.scopeId)).toBeUndefined();
		expect(takeHandoff("fork", left.scopeId)).toBeUndefined();
		expect(takeHandoff("reload", left.scopeId)).toBeDefined();
	});

	it("is left only for a successor that continues the conversation, keyed by its file", () => {
		const scope = scopeWith(["ast_grep_search"]);
		for (const reason of ["new", "resume", "quit", undefined])
			expect(
				stashHandoff(scope, {
					reason,
					sessionFile: "/s/own.jsonl",
					targetSessionFile: "/s/child.jsonl",
				}),
				String(reason),
			).toBe(false);
		expect(takeHandoff("fork", "/s/child.jsonl")).toBeUndefined();

		// pi's reload keeps the session and names no target: the own file keys it.
		expect(
			stashHandoff(scope, {
				reason: "reload",
				sessionFile: "/s/own.jsonl",
				targetSessionFile: undefined,
			}),
		).toBe(true);
		expect(takeHandoff("reload", "/s/own.jsonl")).toBeDefined();
	});
});

/**
 * #3612: which source a start adopts, per reason, through the real stores.
 * The recurrences: a fork or reload that ignores the slot, a resume that
 * adopts the session it left, and a `/new` that inherits anything.
 */
describe("#3612 adoptHandoff", () => {
	const sidecar = (tools: string[]): PersistedStores => ({
		savedAt: Date.now(),
		stores: { "lazy-tool-memory": tools },
	});

	function start(
		reason: string | undefined,
		sessionFile: string | undefined,
		own?: PersistedStores,
		parent?: PersistedStores,
		sessionManager?: Record<string, unknown>,
	) {
		const scope = beginScope({ role: "primary" });
		const loadOwnSidecar = vi.fn(async () => own);
		const loadParentSidecar = vi.fn(async () => parent);
		const source = adoptHandoff(scope, {
			reason,
			sessionFile,
			sessionManager,
			cwd: env.tmpDir,
			loadOwnSidecar,
			loadParentSidecar,
		});
		return { scope, source, loadOwnSidecar, loadParentSidecar };
	}

	function missedSubjects(): string[] {
		return getDegradationSummary()
			.filter((group) => group.kind === "session-scope-handoff-missed")
			.flatMap((group) => group.latestReasons.map((r) => r.subject));
	}

	it("adopts a fork's slot without reading the parent's sidecar", async () => {
		stashHandoff(scopeWith(["ast_grep_search"]), {
			reason: "fork",
			sessionFile: "/s/parent.jsonl",
			targetSessionFile: "/s/child.jsonl",
		});
		const fork = start("fork", "/s/child.jsonl", undefined, sidecar(["x"]));

		expect(await fork.source).toBe("slot");
		expect([...getRememberedLazyTools(fork.scope)]).toEqual([
			"ast_grep_search",
		]);
		expect(fork.loadParentSidecar).not.toHaveBeenCalled();
		expect(missedSubjects()).toEqual([]);
	});

	it("falls back to the parent's sidecar when no slot was left for the fork, and records the miss", async () => {
		const fork = start(
			"fork",
			"/s/child.jsonl",
			sidecar(["own"]),
			sidecar(["lsp_navigation"]),
		);

		expect(await fork.source).toBe("parent-sidecar");
		expect([...getRememberedLazyTools(fork.scope)]).toEqual(["lsp_navigation"]);
		expect(fork.loadOwnSidecar).not.toHaveBeenCalled();
		expect(missedSubjects()).toEqual(["fork"]);
	});

	it("falls back to the session's own sidecar when no slot was left for the reload", async () => {
		const reload = start(
			"reload",
			"/s/own.jsonl",
			sidecar(["ast_grep_outline"]),
		);

		expect(await reload.source).toBe("own-sidecar");
		expect([...getRememberedLazyTools(reload.scope)]).toEqual([
			"ast_grep_outline",
		]);
		expect(reload.loadParentSidecar).not.toHaveBeenCalled();
		expect(missedSubjects()).toEqual(["reload"]);
	});

	it("resumes from the session's own sidecar before its parent's, and never takes the slot", async () => {
		const manager = {};
		const left = scopeWith(["ast_grep_search"]);
		stashHandoff(left, {
			reason: "fork",
			sessionFile: undefined,
			targetSessionFile: undefined,
			sessionManager: manager,
		});
		const resume = start(
			"resume",
			undefined,
			sidecar(["own"]),
			sidecar(["parent"]),
			manager,
		);

		expect(await resume.source).toBe("own-sidecar");
		expect([...getRememberedLazyTools(resume.scope)]).toEqual(["own"]);
		expect(takeHandoff("fork", left.scopeId)).toBeDefined();
		expect(missedSubjects()).toEqual([]);
	});

	// #3819: pi hands a file-less /reload or in-memory /fork successor the
	// session manager its predecessor's shutdown left the slot from; a gap
	// subagent's own start carries another manager.
	it("takes a file-less slot only through the session manager it was left from", async () => {
		const primaryManager = {};
		stashHandoff(scopeWith(["ast_grep_search"]), {
			reason: "reload",
			sessionFile: undefined,
			targetSessionFile: undefined,
			sessionManager: primaryManager,
		});

		const subagent = start("reload", undefined, undefined, undefined, {});
		expect(await subagent.source).toBe("none");
		expect([...getRememberedLazyTools(subagent.scope)]).toEqual([]);

		// #3819 r2 (the r1 review's F1): the subagent's start took nothing
		// and left the slot for the successor.
		const successor = start(
			"reload",
			undefined,
			undefined,
			undefined,
			primaryManager,
		);
		expect(await successor.source).toBe("slot");
		expect([...getRememberedLazyTools(successor.scope)]).toEqual([
			"ast_grep_search",
		]);
		expect(missedSubjects()).toEqual(["reload"]);
	});

	// #3819 r2 (TLC's 5-step HandoffOnce trace): a row-17 start demotes the
	// real successor, which later returns as a primary start of the same
	// conversation. The recurrence: that start took the stale slot.
	it("discards the slot at the demoted start it was left for, and records the discard", async () => {
		const primaryManager = {};
		for (const [sessionFile, sessionManager] of [
			["/s/own.jsonl", undefined],
			[undefined, primaryManager],
		] as const) {
			const left = scopeWith(["ast_grep_search"]);
			stashHandoff(left, {
				reason: "reload",
				sessionFile,
				targetSessionFile: undefined,
				sessionManager,
			});

			// Another session's demoted start, or another reason: not its slot.
			expect(
				discardHandoff({
					reason: "reload",
					sessionFile: "/s/other.jsonl",
					sessionManager: {},
				}),
			).toBe(false);
			expect(
				discardHandoff({ reason: "fork", sessionFile, sessionManager }),
			).toBe(false);
			expect(
				discardHandoff({ reason: "reload", sessionFile, sessionManager }),
			).toBe(true);
			const later = start(
				"reload",
				sessionFile,
				undefined,
				undefined,
				sessionManager,
			);
			expect(await later.source).toBe("none");
			expect([...getRememberedLazyTools(later.scope)]).toEqual([]);
		}
		expect(
			getDegradationSummary()
				.filter((group) => group.kind === "session-scope-handoff-discarded")
				.flatMap((group) => group.latestReasons.map((r) => r.subject)),
		).toEqual(["reload"]);
	});

	// #3881: a primary shutdown that lands while its own start is still in
	// flight hands on the slot left for that start, re-keyed to its own
	// transition. The recurrence: it stashed its empty scope over that slot,
	// and the next start took the empty one.
	it("forwards the slot left for an interrupted start to that session's next start, and no other slot", async () => {
		const manager = {};
		const cases = [
			// [stash reason, stash file, stash target, manager, start's file]
			["reload", "/s/a.jsonl", undefined, undefined, "/s/a.jsonl"],
			["fork", "/s/a.jsonl", "/s/f.jsonl", undefined, "/s/f.jsonl"],
			["reload", undefined, undefined, manager, undefined],
			["fork", undefined, undefined, manager, undefined],
		] as const;
		for (const [reason, sessionFile, target, sessionManager, file] of cases) {
			stashHandoff(scopeWith(["ast_grep_search"]), {
				reason,
				sessionFile,
				targetSessionFile: target,
				sessionManager,
			});
			const interrupted = (shutdown: string, startReason: string) => ({
				startReason,
				reason: shutdown,
				sessionFile: file,
				targetSessionFile: undefined,
				sessionManager,
			});

			// Not the slot left for this start, or a shutdown no start reads
			// a slot after: the slot stays as it was.
			expect(forwardHandoff(interrupted("reload", "new"))).toBe(false);
			expect(forwardHandoff(interrupted("quit", reason))).toBe(false);
			expect(
				forwardHandoff({
					...interrupted("reload", reason),
					sessionFile: file && "/s/other.jsonl",
					sessionManager: sessionManager && {},
				}),
			).toBe(false);
			expect(forwardHandoff(interrupted("reload", reason))).toBe(true);

			const next = start("reload", file, undefined, undefined, sessionManager);
			expect(await next.source).toBe("slot");
			expect([...getRememberedLazyTools(next.scope)]).toEqual([
				"ast_grep_search",
			]);
		}
		// An inner fork re-keys to pi's target file.
		stashHandoff(scopeWith(["ast_grep_search"]), {
			reason: "reload",
			sessionFile: "/s/a.jsonl",
			targetSessionFile: undefined,
		});
		expect(
			forwardHandoff({
				startReason: "reload",
				reason: "fork",
				sessionFile: "/s/a.jsonl",
				targetSessionFile: "/s/g.jsonl",
				sessionManager: undefined,
			}),
		).toBe(true);
		expect(takeHandoff("fork", "/s/g.jsonl")).toMatchObject({
			"lazy-tool-memory": ["ast_grep_search"],
		});
		expect(
			getDegradationSummary()
				.filter((group) => group.kind === "session-scope-handoff-interrupted")
				.flatMap((group) => group.latestReasons.map((r) => r.subject)),
		).toEqual(["new", "reload", "fork"]);
	});

	it("starts `pi --fork` (a startup with a parent) from the parent's sidecar", async () => {
		const child = start(
			"startup",
			"/s/child.jsonl",
			undefined,
			sidecar(["parent"]),
		);

		expect(await child.source).toBe("parent-sidecar");
		expect([...getRememberedLazyTools(child.scope)]).toEqual(["parent"]);
	});

	it("reads no source for /new and resets the widget", async () => {
		recordDiagnostics(path.join(env.tmpDir, "a.ts"), [
			{ tool: "tsc", severity: "error", message: "boom", line: 1 },
		]);
		const fresh = start(
			"new",
			"/s/new.jsonl",
			sidecar(["own"]),
			sidecar(["parent"]),
		);

		expect(await fresh.source).toBe("none");
		expect(fresh.loadOwnSidecar).not.toHaveBeenCalled();
		expect(fresh.loadParentSidecar).not.toHaveBeenCalled();
		expect([...getRememberedLazyTools(fresh.scope)]).toEqual([]);
		expect(exportWidgetState().files).toEqual([]);
	});

	it("leaves the widget alone on /reload: its module outlives the factory re-run", async () => {
		const file = path.join(env.tmpDir, "a.ts");
		recordDiagnostics(file, [
			{ tool: "tsc", severity: "error", message: "boom", line: 1 },
		]);
		stashHandoff(scopeWith([]), {
			reason: "reload",
			sessionFile: "/s/own.jsonl",
			targetSessionFile: undefined,
		});
		const reload = start("reload", "/s/own.jsonl");

		expect(await reload.source).toBe("slot");
		expect(exportWidgetState().files.map((f) => f.filePath)).toEqual([file]);
	});
});

/**
 * #2939 M8 and W4's call-site half — `index.ts` picks the `tool_result` wall
 * budget and the ledger hook from `isEditClassToolResult(...)` at TWO sites
 * (the inner `bounded(handleToolResult(...))` and the registration wrapper's
 * `budgetKey` callback), and PR #2897's verify measured BOTH green under
 * mutation because every existing test drives `handleToolResult` directly and
 * none drives the registered host handler.
 *
 * Recurrence prevented: #2897 round 1 shipped one 10 s budget for every tool
 * result, so a wedged dependency on a Read held the host twenty times longer
 * than the read-only contract allows (#2523 AC5 — "Read/Grep/Glob/Bash must
 * never await analyzer bootstrap"), and #2939 W4's F3 found the two edit-class
 * copies disagreeing with each other. Both bounds are observed here through
 * the production `hook-await-exceeded` ledger row, whose subject is
 * `<hook>:<label>` and whose reason names the budget that fired.
 *
 * Doubles: the host (`createPiMock`), the analyzer-bootstrap module (the
 * shared production-faithful `bootstrapSeamMock`, because the edit path AWAITS
 * a load that really spawns availability probes), and the TIMING of
 * `handleToolResult` — the real export, wrapped so its promise never settles,
 * which is the wedged dependency these budgets exist for. `bounded` and the
 * degradation ledger are real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `hang` makes the real handler's promise never settle (the wedged await).
 * `ambientAfterYield` records what the ambient abort slot holds once the
 * handler has yielded — the moment every `safeSpawn` inside the real pipeline
 * reads it, and the only place the M13 `await` is observable.
 */
const handlerGate = vi.hoisted(() => ({
	hang: false,
	ambientAfterYield: undefined as AbortSignal | undefined | "unset",
	/**
	 * #5108 F1: when set, the handler waits for it, then finishes having
	 * collected `notices` as withheld-blocker lines. `work` is the handler's
	 * returned promise, so a case can wait for its late settlement.
	 */
	hold: undefined as Promise<void> | undefined,
	notices: [] as string[],
	work: undefined as Promise<unknown> | undefined,
}));
vi.mock("../clients/runtime-tool-result.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/runtime-tool-result.js")>();
	const { getAmbientAbortSignal } = await import("../clients/safe-spawn.js");
	return {
		...actual,
		handleToolResult: (deps: Parameters<typeof actual.handleToolResult>[0]) => {
			const work = (async () => {
				await Promise.resolve();
				handlerGate.ambientAfterYield = getAmbientAbortSignal();
				const hold = handlerGate.hold;
				if (hold !== undefined) {
					await hold;
					deps.withheldNotices?.push(...handlerGate.notices);
					return undefined;
				}
				return handlerGate.hang
					? new Promise<never>(() => {})
					: actual.handleToolResult(deps);
			})();
			// The promise `index.ts` chains its late advisory on, so a case
			// awaiting it resumes after that chain has run.
			handlerGate.work = work;
			return work;
		},
	};
});

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		metricsClient: { reset: () => {} },
		// #5108 F1: the cases below start sessions, whose start resets it.
		knipClient: { resetSessionState: () => {} },
	}));
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import {
	_resetAgentNudgeForTests,
	consumeAgentNudge,
} from "../clients/agent-nudge.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import extension from "../index.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

let tmpDir: string;
let filePath: string;

beforeEach(() => {
	handlerGate.hang = true;
	handlerGate.hold = undefined;
	handlerGate.notices = [];
	handlerGate.work = undefined;
	handlerGate.ambientAfterYield = "unset";
	resetDegradationLedger();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2939-budget-"));
	filePath = path.join(tmpDir, "witnessed.ts");
	fs.writeFileSync(filePath, "const a = 1;\nconst b = 2;\n", "utf8");
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Every `hook-await-exceeded` row, as `<hook>:<label>` → reason. */
function exceeded(): Record<string, string> {
	const rows: Record<string, string> = {};
	for (const entry of getDegradationSummary().find(
		(group) => group.kind === "hook-await-exceeded",
	)?.latestReasons ?? []) {
		rows[entry.subject] = entry.reason;
	}
	return rows;
}

/**
 * Register the real handlers with the clock already fake — every deadline
 * `bounded()` arms has to be a fake timer — and emit one wedged `tool_result`.
 * The returned promise settles only when a bound gives up on it.
 */
function wedgedEmit(event: Record<string, unknown>): Promise<unknown> {
	vi.useFakeTimers();
	const pi = createPiMock();
	extension(pi.asExtensionAPI());
	return pi.emit("tool_result", event, makeCtx({ cwd: tmpDir }));
}

const readEvent = () => ({
	toolName: "read",
	toolCallId: "rd-1",
	input: { path: "PLACEHOLDER" },
	content: [],
});

describe("#2939 M8/W4b — the registration's wall budget follows the edit class", () => {
	it("releases a READ result at the 500ms read-only budget", async () => {
		const event = readEvent();
		event.input.path = filePath;
		const settled = wedgedEmit(event);
		await vi.advanceTimersByTimeAsync(500);
		await settled;

		// The 500 is `HOOK_WALL_BUDGET_MS.tool_result_read_only`, and the hook
		// name in the subject is the other half of the same ternary pair. The
		// wrapper's own bound never fires here: at equal budgets the inner one
		// settles the handler first, which is why the EDIT case below is what
		// pins the `budgetKey` callback.
		expect(exceeded()).toEqual({
			"tool_result_read_only:handleToolResult":
				"exceeded 500ms budget after 500ms",
		});
	});

	it("gives an EDIT result the 10000ms budget and holds past 500ms", async () => {
		const settled = wedgedEmit({
			toolName: "edit",
			toolCallId: "ed-1",
			input: {
				path: filePath,
				oldText: "const a = 1;",
				newText: "const a = 2;",
			},
			content: [],
		});

		// Nothing has given up yet: the edit contract is 10s, not 500ms. This is
		// also the assertion that pins the WRAPPER's `budgetKey` — a callback
		// that answered read-only for an edit would fire its own
		// `tool_result_read_only:registered-handler` bound right here.
		await vi.advanceTimersByTimeAsync(500);
		expect(exceeded()).toEqual({});

		await vi.advanceTimersByTimeAsync(9_500);
		await settled;
		// Both sites, with the hook name each one chose: the inner bound and the
		// wrapper's `budgetKey` callback.
		expect(exceeded()).toEqual({
			"tool_result_edit:handleToolResult":
				"exceeded 10000ms budget after 10000ms",
			"tool_result_edit:registered-handler":
				"exceeded 10000ms budget after 10000ms",
		});
	});
});

/**
 * #2939 M13 — `return await bounded(handleToolResult(...))`.
 *
 * Recurrence prevented: #2897 round 2's V2. `onToolResult` publishes the
 * turn's abort signal with `setAmbientAbortSignal(ctx.signal)` so the edit
 * pipeline's linter/type-check children are killed when the agent is
 * interrupted (#197), and clears it in the handler's own `finally`. Drop the
 * `await` and that `finally` runs the instant the promise is RETURNED — the
 * slot is empty for the entire pipeline, and Escape mid-edit kills nothing.
 * PR #3411 round 1 removed the `await` because the existing suites stayed
 * green; this case is what makes the removal red.
 */
describe("#2939 M13 — the ambient abort slot outlives the handler's first yield", () => {
	it("still holds the hook's signal once the handler has yielded, and is cleared after", async () => {
		handlerGate.hang = false;
		const controller = new AbortController();
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const ctx = makeCtx({ cwd: tmpDir });
		(ctx as unknown as { signal: AbortSignal }).signal = controller.signal;

		await pi.emit(
			"tool_result",
			{
				toolName: "read",
				toolCallId: "rd-2",
				input: { path: filePath },
				content: [],
			},
			ctx,
		);

		expect(handlerGate.ambientAfterYield).toBe(controller.signal);
		// And the `finally` did run once the handler settled.
		const { getAmbientAbortSignal } = await import("../clients/safe-spawn.js");
		expect(getAmbientAbortSignal()).toBeUndefined();
	});
});

/**
 * #5108 review F1: the late withheld-blocker advisory an abandoned handler
 * queues names the session whose tool result it was.
 *
 * Recurrence prevented: PR #5114 round 1 queued it under
 * `runtime.captureSessionGeneration()`, the coordinator's scope, which is the
 * PRIMARY's. A concurrent secondary (#473) drains its own member scope, so its
 * disclosure reached the primary's context and the secondary never heard of
 * its blocker: the #5108 silence, for the secondary.
 *
 * Real: both session starts, the bound that abandons the handler, the
 * advisory queue and both `context_with_system` drains. The double is the
 * TIMING of `handleToolResult` (held past the bound, then finishing with one
 * withheld line), as above.
 */
describe("#5108 F1: a late advisory reaches the session whose tool result it was", () => {
	it("queues an abandoned secondary's withheld blocker for the secondary's own context", async () => {
		_resetSessionLifecycleForTests();
		_resetAgentNudgeForTests();
		handlerGate.hang = false;
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const secondaryRoot = path.join(tmpDir, "secondary-root");
		fs.mkdirSync(secondaryRoot, { recursive: true });
		const primaryCtx = () => makeCtx({ cwd: tmpDir, sessionId: "pi-5108-p" });
		const secondaryCtx = () =>
			makeCtx({ cwd: secondaryRoot, sessionId: "pi-5108-s" });
		await pi.emit("session_start", makeSessionStartEvent(), primaryCtx());
		await pi.emit("session_start", makeSessionStartEvent(), secondaryCtx());

		let release: () => void = () => {};
		handlerGate.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		handlerGate.notices = [
			"\u26a0 1 blocking finding in second.ts withheld: test",
		];
		vi.useFakeTimers();
		const settled = pi.emit(
			"tool_result",
			{
				toolName: "bash",
				toolCallId: "sh-5108",
				input: { command: "true" },
				content: [{ type: "text", text: "done" }],
			},
			secondaryCtx(),
		);
		await vi.advanceTimersByTimeAsync(500);
		await settled;
		vi.useRealTimers();
		// The bound gave up first; the handler finishes afterwards.
		release();
		await handlerGate.work;

		const textOf = async (ctx: ReturnType<typeof makeCtx>) => {
			const injected = (await pi.emit(
				"context_with_system",
				makeContextWithSystemEvent([{ role: "user", content: "go" }]),
				ctx,
			)) as { messages?: Array<{ content: unknown }> } | undefined;
			return (injected?.messages ?? [])
				.map((m) => JSON.stringify(m.content))
				.join("\n");
		};
		const secondary = await textOf(secondaryCtx());
		const primary = await textOf(primaryCtx());
		expect(secondary).toContain("second.ts withheld");
		expect(secondary).toContain("abandoned");
		expect(primary).not.toContain("second.ts");
	});

	// The fallback for a call no session start has recorded yet: the late
	// advisory has no callee default, and an entry with no scope makes every
	// later drain throw (#5114 verify r2, m4).
	it("queues a late advisory from before the first session start without breaking the next drain", async () => {
		_resetSessionLifecycleForTests();
		_resetAgentNudgeForTests();
		handlerGate.hang = false;
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		let release: () => void = () => {};
		handlerGate.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		handlerGate.notices = [
			"\u26a0 1 blocking finding in early.ts withheld: test",
		];
		vi.useFakeTimers();
		const settled = pi.emit(
			"tool_result",
			{
				toolName: "bash",
				toolCallId: "sh-5108-early",
				input: { command: "true" },
				content: [{ type: "text", text: "done" }],
			},
			makeCtx({ cwd: tmpDir, sessionId: "pi-5108-early" }),
		);
		await vi.advanceTimersByTimeAsync(500);
		await settled;
		vi.useRealTimers();
		release();
		await handlerGate.work;

		// Any later drain prunes the queue first, so an entry with no scope
		// throws there; the real store is read directly, as every drain does.
		expect(() => consumeAgentNudge()).not.toThrow();
	});
});

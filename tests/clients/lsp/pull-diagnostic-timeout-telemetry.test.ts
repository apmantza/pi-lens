/**
 * #1713: pull-diagnostic timeouts were structurally unobservable — the
 * per-request `withDeadline` at `clients/lsp/client.ts` throws on timeout, so
 * the settle emit it raced against never runs and NOTHING records that the
 * timeout happened. A late answer that arrives after the caller gave up was
 * silently discarded with zero trace.
 *
 * Two records close the gap:
 *  - Every pull timeout emits a `lsp_pull_diagnostic_timeout` latency.log
 *    entry (file, identifier, effective budget, previousResultId presence,
 *    elapsed).
 *  - A telemetry-only continuation on the abandoned request promise emits a
 *    `lsp_pull_late_answer_discarded` record if the request eventually
 *    resolves anyway, bounded via the degradation ledger
 *    (`incrementDegradationCount`, kind `lsp-pull-late-answer`) so identity
 *    (file + identifier) survives aggregation without a second hand-rolled
 *    latch.
 *
 * These are connection-double tests: `state.connection.sendRequest` is a
 * mock, not a wire-protocol server (matches `pull-diagnostic-identifiers.test.ts`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { latencyEvents } = vi.hoisted(() => ({
	latencyEvents: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: vi.fn((event: Record<string, unknown>) => {
			latencyEvents.push(event);
		}),
	};
});

import {
	clientRequestWorkspaceDiagnostics,
	clientWaitForDiagnostics,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `pullRetryBudgetMs: 0` for "typescript" (wait-policy/strategies.ts) keeps
 *  the pull path to exactly ONE request per `clientWaitForDiagnostics` call —
 *  no retry loop to account for in the assertions below. */
function pullState(overrides?: Partial<LSPClientState>): LSPClientState {
	return createMockState({
		serverId: "typescript",
		root: "/project",
		workspaceDiagnosticsSupport: {
			advertised: true,
			mode: "pull",
			workspaceDiagnostics: false,
			diagnosticProviderKind: "static",
		},
		staticDiagnosticsMode: "push-only",
		...overrides,
	});
}

function installSendRequest(
	state: LSPClientState,
	handler: (method: string, params: unknown) => Promise<unknown>,
) {
	const mock = vi.fn(handler);
	state.connection.sendRequest =
		mock as unknown as typeof state.connection.sendRequest;
	return mock;
}

const timeoutEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_pull_diagnostic_timeout");
const discardedEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_pull_late_answer_discarded");

afterEach(() => {
	latencyEvents.length = 0;
	resetDegradationLedger();
	vi.useRealTimers();
});

describe("#1713 pull-diagnostic timeout emits a latency.log record", () => {
	it("records file, identifier, effective budget, previousResultId presence, elapsed", async () => {
		const state = pullState();
		// Never resolves: this test only cares about the timeout record, and an
		// eventually-resolving mock would fire the LATE-ANSWER continuation after
		// this test returns, polluting a later test's event capture.
		installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: new Promise(() => {}),
		);

		const startedAt = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 30, { pullOnly: true });

		expect(timeoutEvents()).toHaveLength(1);
		const event = timeoutEvents()[0];
		expect(event.filePath).toBe(TEST_KEY);
		expect(event.metadata).toMatchObject({
			identifier: "bare",
			effectiveBudgetMs: 30,
			hadPreviousResultId: false,
		});
		// durationMs is the request's own elapsed time at the moment it was
		// abandoned — bounded near the budget, not the mock's full 300ms delay.
		expect(event.durationMs as number).toBeGreaterThanOrEqual(0);
		expect(event.durationMs as number).toBeLessThan(
			Date.now() - startedAt + 50,
		);
	});

	it("carries hadPreviousResultId: true when a prior pull left a resultId", async () => {
		const state = pullState();
		state.pullResultIds.set(TEST_KEY, "prior-result-id");
		installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: new Promise(() => {}),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 30, { pullOnly: true });

		expect(timeoutEvents()).toHaveLength(1);
		expect(timeoutEvents()[0].metadata).toMatchObject({
			hadPreviousResultId: true,
		});
	});

	// Mutation guard: a request that fails FAST (not via the timeout race) must
	// never be misreported as a timeout — deleting the `isPullTimeoutError`
	// message check would make every failure look like one.
	it("does NOT record a timeout entry when the request fails for another reason", async () => {
		const state = pullState();
		installSendRequest(state, async (method) => {
			if (method !== "textDocument/diagnostic") return undefined;
			throw new Error("server unavailable");
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 30, { pullOnly: true });

		expect(timeoutEvents()).toHaveLength(0);
	});
});

describe("#1713 a late pull answer after abandonment is a bounded, traced discard", () => {
	it("does not report a cancellation settlement as a late answer", async () => {
		const state = pullState();
		state.connection.sendRequest = vi.fn(
			(
				method: string,
				_params: unknown,
				token?: {
					onCancellationRequested(listener: () => void): { dispose(): void };
				},
			) => {
				if (method !== "textDocument/diagnostic") {
					return Promise.resolve(undefined);
				}
				return new Promise((_resolve, reject) => {
					token?.onCancellationRequested(() => {
						reject(Object.assign(new Error("cancelled"), { code: -32800 }));
					});
				});
			},
		) as unknown as typeof state.connection.sendRequest;

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		await wait(20);

		expect(discardedEvents()).toHaveLength(0);
		expect(
			getDegradationSummary().find((g) => g.kind === "lsp-pull-late-answer"),
		).toBeUndefined();
	});

	it("fires exactly one discarded record, via the degradation ledger with identity preserved", async () => {
		const state = pullState();
		installSendRequest(state, async (method) => {
			if (method !== "textDocument/diagnostic") return undefined;
			await wait(80);
			return { kind: "full", resultId: "late-1", items: [] };
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		expect(discardedEvents()).toHaveLength(0); // not discarded yet — still in flight

		await wait(120); // let the abandoned request settle

		expect(discardedEvents()).toHaveLength(1);
		expect(discardedEvents()[0].filePath).toBe(TEST_KEY);
		expect(discardedEvents()[0].metadata).toMatchObject({ identifier: "bare" });

		const ledger = getDegradationSummary();
		const group = ledger.find((g) => g.kind === "lsp-pull-late-answer");
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe(TEST_KEY);
		expect(group?.latestReasons[0]?.reason).toMatch(
			/^late pull answer discarded after \d+ms/,
		);
	});

	// Mutation guard: a late FAILURE is not an "answer" — deleting the
	// no-op onRejected branch (or making it log too) would misreport an
	// abandoned request's eventual error as a discarded answer.
	it("does NOT record a discard when the abandoned request eventually fails instead", async () => {
		const state = pullState();
		installSendRequest(state, async (method) => {
			if (method !== "textDocument/diagnostic") return undefined;
			await wait(80);
			throw new Error("late failure");
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		await wait(120);

		expect(discardedEvents()).toHaveLength(0);
		expect(
			getDegradationSummary().find((g) => g.kind === "lsp-pull-late-answer"),
		).toBeUndefined();
	});

	it("records each repeat occurrence independently, preserving identity — not per-repeat spam suppression", async () => {
		const state = pullState();
		let call = 0;
		installSendRequest(state, async (method) => {
			if (method !== "textDocument/diagnostic") return undefined;
			call += 1;
			await wait(80);
			return { kind: "full", resultId: `late-${call}`, items: [] };
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		await wait(120);
		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		await wait(120);

		// Two genuinely separate abandoned-then-answered requests for the SAME
		// file → two independent discard records, not collapsed into one and
		// not suppressed on the second occurrence.
		expect(discardedEvents()).toHaveLength(2);
		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-pull-late-answer",
		);
		expect(group?.count).toBe(2);
	});
});

describe("#1713 class sweep: workspace/diagnostic shares the same telemetry", () => {
	function workspacePullState(): LSPClientState {
		return createMockState({
			serverId: "typescript",
			root: "/project",
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "static",
			},
		});
	}

	it("emits a timeout record for an abandoned workspace/diagnostic pull", async () => {
		const state = workspacePullState();
		// Never resolves — see the equivalent per-file test above for why.
		installSendRequest(state, (method) =>
			method !== "workspace/diagnostic"
				? Promise.resolve(undefined)
				: new Promise(() => {}),
		);

		await clientRequestWorkspaceDiagnostics(state, 20);

		expect(timeoutEvents()).toHaveLength(1);
		expect(timeoutEvents()[0].metadata).toMatchObject({
			hadPreviousResultId: false,
		});
	});

	it("emits a discarded record when the abandoned workspace pull answers late", async () => {
		const state = workspacePullState();
		installSendRequest(state, async (method) => {
			if (method !== "workspace/diagnostic") return undefined;
			await wait(80);
			return { items: [] };
		});

		await clientRequestWorkspaceDiagnostics(state, 20);
		await wait(120);

		expect(discardedEvents()).toHaveLength(1);
		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-pull-late-answer",
		);
		expect(group?.count).toBe(1);
	});
});

/**
 * #1716: `navRequest` (`clients/lsp/client.ts` — hover/definition/references/
 * signatureHelp/documentSymbol/workspace-symbol/call-hierarchy) shares the
 * observability hole #1713 fixed for pull diagnostics. Its per-request
 * `withTimeout` previously collapsed a timeout to `undefined`, so callers
 * rendered an unanswered request as an empty result.
 *
 * navRequest is the highest-volume LSP call site (one call per turn, often
 * several), so unlike #1713's per-event latency.log write, this fix bounds
 * the DETAILED record to the rising edge — the first timeout/late-answer per
 * (method, file) each session — while the degradation ledger still counts
 * every occurrence exactly. Two records:
 *  - `lsp_nav_request_timeout` on the rising edge of a timeout for a given
 *    (method, file), via the `lsp-nav-request-timeout` ledger kind.
 *  - `lsp_nav_late_answer_discarded` on the rising edge of an abandoned
 *    request answering late, via the `lsp-nav-late-answer` ledger kind.
 *
 * Connection-double tests: `state.connection.sendRequest` is a mock, not a
 * wire-protocol server (matches `pull-diagnostic-timeout-telemetry.test.ts`).
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
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	type LSPClientState,
	navRequest,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
	latencyEvents.filter((e) => e.phase === "lsp_nav_request_timeout");
const discardedEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_nav_late_answer_discarded");

afterEach(() => {
	latencyEvents.length = 0;
	resetDegradationLedger();
});

describe("#1716 navRequest timeout emits a bounded latency.log record", () => {
	it("records method, file, effective budget, elapsed on the first timeout for a (method, file) pair", async () => {
		const state = createMockState();
		// Never resolves: only the timeout record is under test here, and an
		// eventually-resolving mock would fire the late-answer continuation
		// after this test returns, polluting a later test's event capture.
		installSendRequest(state, () => new Promise(() => {}));

		const startedAt = Date.now();
		await expect(
			navRequest(state, "textDocument/hover", {}, TEST_FILE, 30),
		).rejects.toThrow("LSP request timed out");
		expect(timeoutEvents()).toHaveLength(1);
		const event = timeoutEvents()[0];
		expect(event.filePath).toBe(TEST_KEY);
		expect(event.metadata).toMatchObject({
			method: "textDocument/hover",
			effectiveBudgetMs: 30,
		});
		expect(event.durationMs as number).toBeGreaterThanOrEqual(0);
		expect(event.durationMs as number).toBeLessThan(
			Date.now() - startedAt + 50,
		);

		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-nav-request-timeout",
		);
		expect(group?.count).toBe(1);
	});

	it("uses a stable placeholder scope when staleCheckPath is omitted (workspaceSymbol, call-hierarchy follow-ups)", async () => {
		const state = createMockState();
		installSendRequest(state, () => new Promise(() => {}));

		await expect(
			navRequest(state, "workspace/symbol", { query: "x" }, undefined, 30),
		).rejects.toThrow("LSP request timed out");

		expect(timeoutEvents()).toHaveLength(1);
		expect(timeoutEvents()[0].filePath).toBe("*no-path*");
	});

	// Mutation guard: a request that fails FAST (not via the timeout race) must
	// never be misreported as a timeout — deleting `isNavTimeoutError`'s exact
	// message check would make every failure look like one.
	it("does NOT record a timeout entry when the request fails for another reason", async () => {
		const state = createMockState();
		installSendRequest(state, async () => {
			throw new Error("server unavailable");
		});

		// A non-timeout failure propagates (navRequest's existing behavior,
		// unchanged by this fix) — the assertion under test is what telemetry
		// this leaves behind, not the rejection itself.
		await expect(
			navRequest(state, "textDocument/hover", {}, TEST_FILE, 30),
		).rejects.toThrow("server unavailable");

		expect(timeoutEvents()).toHaveLength(0);
	});

	// The bounding choice under test: navRequest is high-volume, so a storm of
	// timeouts for the SAME (method, file) must not storm latency.log — only
	// the first occurrence writes a detailed record. Deleting the rising-edge
	// gate (the `occurrence !== 1` check) would make this test see 3 events
	// instead of 1.
	it("suppresses the detailed record on repeat timeouts for the same (method, file), but keeps counting exactly in the ledger", async () => {
		const state = createMockState();
		installSendRequest(state, () => new Promise(() => {}));

		for (let i = 0; i < 3; i += 1) {
			await expect(
				navRequest(state, "textDocument/hover", {}, TEST_FILE, 20),
			).rejects.toThrow("LSP request timed out");
		}

		expect(timeoutEvents()).toHaveLength(1);
		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-nav-request-timeout",
		);
		expect(group?.count).toBe(3);
	});

	// A different METHOD against the same file is a different subject — its
	// own rising edge, not suppressed by the hover timeout above.
	it("treats a different method against the same file as a distinct (method, file) subject", async () => {
		const state = createMockState();
		installSendRequest(state, () => new Promise(() => {}));

		await expect(
			navRequest(state, "textDocument/hover", {}, TEST_FILE, 20),
		).rejects.toThrow("LSP request timed out");
		await expect(
			navRequest(state, "textDocument/definition", {}, TEST_FILE, 20),
		).rejects.toThrow("LSP request timed out");

		expect(timeoutEvents()).toHaveLength(2);
	});
});

describe("#1716 a late nav answer after abandonment is a bounded, traced discard", () => {
	it("fires one discarded record on the rising edge, via the degradation ledger with identity preserved", async () => {
		const state = createMockState();
		installSendRequest(state, async () => {
			await wait(80);
			return { contents: "late hover" };
		});

		await expect(
			navRequest(state, "textDocument/hover", {}, TEST_FILE, 20),
		).rejects.toThrow("LSP request timed out");
		expect(discardedEvents()).toHaveLength(0); // not discarded yet — still in flight

		await wait(120); // let the abandoned request settle

		expect(discardedEvents()).toHaveLength(1);
		expect(discardedEvents()[0].filePath).toBe(TEST_KEY);
		expect(discardedEvents()[0].metadata).toMatchObject({
			method: "textDocument/hover",
		});

		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-nav-late-answer",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe(
			`textDocument/hover:${TEST_KEY}`,
		);
		expect(group?.latestReasons[0]?.reason).toMatch(
			/^late nav answer discarded after \d+ms/,
		);
	});

	// Mutation guard: a late FAILURE is not an "answer" — deleting the no-op
	// onRejected branch (or making it log too) would misreport an abandoned
	// request's eventual error as a discarded answer.
	it("does NOT record a discard when the abandoned request eventually fails instead", async () => {
		const state = createMockState();
		installSendRequest(state, async () => {
			await wait(80);
			throw new Error("late failure");
		});

		await expect(
			navRequest(state, "textDocument/hover", {}, TEST_FILE, 20),
		).rejects.toThrow("LSP request timed out");
		await wait(120);

		expect(discardedEvents()).toHaveLength(0);
		expect(
			getDegradationSummary().find((g) => g.kind === "lsp-nav-late-answer"),
		).toBeUndefined();
	});

	it("keeps counting every repeat late answer in the ledger, but only logs the rising edge", async () => {
		const state = createMockState();
		installSendRequest(state, async () => {
			await wait(80);
			return { contents: "late" };
		});

		await expect(
			navRequest(state, "textDocument/hover", {}, TEST_FILE, 20),
		).rejects.toThrow("LSP request timed out");
		await wait(120);
		await expect(
			navRequest(state, "textDocument/hover", {}, TEST_FILE, 20),
		).rejects.toThrow("LSP request timed out");
		await wait(120);

		expect(discardedEvents()).toHaveLength(1);
		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-nav-late-answer",
		);
		expect(group?.count).toBe(2);
	});
});

describe("#1716 no behavior change on the success path", () => {
	it("returns the result normally and records nothing when the request answers in time", async () => {
		const state = createMockState();
		installSendRequest(state, async () => ({ contents: "fast hover" }));

		const result = await navRequest(
			state,
			"textDocument/hover",
			{},
			TEST_FILE,
			5000,
		);

		expect(result).toEqual({ contents: "fast hover" });
		expect(timeoutEvents()).toHaveLength(0);
		expect(discardedEvents()).toHaveLength(0);
	});
});

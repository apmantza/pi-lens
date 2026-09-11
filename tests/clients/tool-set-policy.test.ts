import { beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());

vi.mock("../../clients/latency-logger.js", () => ({ logLatency }));

import {
	clearRememberedLazyTools,
	getRememberedLazyTools,
	isFreshSessionStart,
	planToolSet,
	recordToolSetMutation,
	rememberLazyTools,
	inheritRememberedLazyTools,
	resetRememberedLazyToolsForTests,
	REMEMBERED_LAZY_TOOLS_MAX_SESSIONS,
	supportsDeferredTools,
} from "../../clients/tool-set-policy.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const LAZY = new Set(["ast_grep_search", "ast_grep_replace", "lsp_navigation"]);
/** What the host hands us on EVERY session_start: all tools active. */
const ALL_ACTIVE = [
	"lens_diagnostics",
	"pi_lens_activate_tools",
	"ast_grep_search",
	"ast_grep_replace",
	"lsp_navigation",
];

describe("tool-set cache policy", () => {
	beforeEach(() => {
		logLatency.mockClear();
		resetDegradationLedger();
		resetRememberedLazyToolsForTests();
	});

	it("records missing session-file identity once when activation memory is unavailable", () => {
		rememberLazyTools(undefined, ["ast_grep_search"]);
		rememberLazyTools(undefined, ["ast_grep_replace"]);

		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "tool-set-session-file-unavailable",
				count: 1,
				latestReasons: [
					expect.objectContaining({
						reason:
							"session-file identity unavailable; activation memory is inert",
					}),
				],
			}),
		]);
	});

	it("bounds remembered session files with FIFO eviction", () => {
		for (let i = 0; i < REMEMBERED_LAZY_TOOLS_MAX_SESSIONS + 1; i++) {
			rememberLazyTools(`bounded-${i}`, ["ast_grep_search"]);
		}
		expect([...getRememberedLazyTools("bounded-0")]).toEqual([]);
		expect([
			...getRememberedLazyTools(
				`bounded-${REMEMBERED_LAZY_TOOLS_MAX_SESSIONS}`,
			),
		]).toEqual(["ast_grep_search"]);
	});

	it("copies the parent's activation posture to a fork session file", () => {
		rememberLazyTools("parent-file", ["ast_grep_search"]);
		inheritRememberedLazyTools("parent-file", "child-file");
		expect([...getRememberedLazyTools("child-file")]).toEqual([
			"ast_grep_search",
		]);
	});

	it("records activation in the session-file store before a factory re-run", () => {
		clearRememberedLazyTools("policy-before-rebuild");
		rememberLazyTools("policy-before-rebuild", ["ast_grep_search"]);
		expect([...getRememberedLazyTools("policy-before-rebuild")]).toEqual([
			"ast_grep_search",
		]);
	});

	it("keeps activation isolated by session file", () => {
		clearRememberedLazyTools("policy-file-a");
		clearRememberedLazyTools("policy-file-b");
		rememberLazyTools("policy-file-a", ["ast_grep_search"]);
		expect([...getRememberedLazyTools("policy-file-b")]).toEqual([]);
	});

	it("clears activation when a conversation switches session file", () => {
		rememberLazyTools("policy-switched", ["ast_grep_search"]);
		clearRememberedLazyTools("policy-switched");
		expect([...getRememberedLazyTools("policy-switched")]).toEqual([]);
	});

	it("does not create process-restart state without a session-file write", () => {
		// Clearing an unknown file must not plant state a restart could read
		// back, and clearing a written file must drop it through the real
		// store. Mutation G (clear neutered to a no-op) leaves the written
		// entry behind and reds the second assertion.
		clearRememberedLazyTools("policy-restart-unknown");
		expect([...getRememberedLazyTools("policy-restart-unknown")]).toEqual([]);
		rememberLazyTools("policy-restart", ["ast_grep_search"]);
		clearRememberedLazyTools("policy-restart");
		expect([...getRememberedLazyTools("policy-restart")]).toEqual([]);
	});

	it("classifies only startup and new as fresh logical sessions", () => {
		expect(isFreshSessionStart(undefined)).toBe(true);
		expect(isFreshSessionStart("startup")).toBe(true);
		expect(isFreshSessionStart("new")).toBe(true);
		for (const reason of ["fork", "reload", "resume"]) {
			expect(isFreshSessionStart(reason), reason).toBe(false);
		}
	});

	it("reads the host's own deferred-tool capability flag", () => {
		expect(
			supportsDeferredTools({ compat: { supportsToolReferences: true } }),
		).toBe(true);
		expect(
			supportsDeferredTools({ compat: { supportsToolReferences: false } }),
		).toBe(false);
		// Unknown (no flag / no compat / no model) is reported as false rather
		// than guessed.
		expect(supportsDeferredTools({ compat: {} })).toBe(false);
		expect(supportsDeferredTools({})).toBe(false);
		expect(supportsDeferredTools(undefined)).toBe(false);
	});

	describe("planToolSet", () => {
		it("restores remembered tools in ACTIVATION order, not registration order", () => {
			// A host rebuild reports tools in REGISTRATION order; the parent's
			// array had them appended in ACTIVATION order. The active-tools
			// array is what serializes into the request's tool block, so a
			// transposition is a changed prefix — i.e. a cache miss on the
			// first post-fork/resume/reload turn (#1453 review residual).
			const registrationOrder = [
				"lens_diagnostics",
				"pi_lens_activate_tools",
				"ast_grep_search",
				"lsp_navigation",
			];
			const lazy = new Set(["ast_grep_search", "lsp_navigation"]);
			// The parent activated lsp_navigation FIRST, then ast_grep_search.
			const remembered = new Set(["lsp_navigation", "ast_grep_search"]);

			const plan = planToolSet(registrationOrder, lazy, remembered);

			expect(plan.desired).toEqual([
				"lens_diagnostics",
				"pi_lens_activate_tools",
				"lsp_navigation",
				"ast_grep_search",
			]);
			expect(plan.changed).toBe(false);
		});

		it("shrinks to the baseline when nothing was activated (startup/new)", () => {
			const plan = planToolSet(ALL_ACTIVE, LAZY, new Set());

			expect(plan.desired).toEqual([
				"lens_diagnostics",
				"pi_lens_activate_tools",
			]);
			expect(plan).toMatchObject({
				addedCount: 0,
				removedCount: 3,
				changed: true,
			});
		});

		it("restores baseline + remembered from an all-active rebuild", () => {
			const plan = planToolSet(ALL_ACTIVE, LAZY, new Set(["ast_grep_search"]));

			expect(plan.desired).toEqual([
				"lens_diagnostics",
				"pi_lens_activate_tools",
				"ast_grep_search",
			]);
			expect(plan).toMatchObject({
				addedCount: 0,
				removedCount: 2,
				changed: true,
			});
		});

		it("re-adds a remembered tool the host did not report as active", () => {
			const plan = planToolSet(
				["lens_diagnostics"],
				LAZY,
				new Set(["lsp_navigation"]),
			);

			expect(plan.desired).toEqual(["lens_diagnostics", "lsp_navigation"]);
			expect(plan).toMatchObject({
				addedCount: 1,
				removedCount: 0,
				changed: true,
			});
		});

		it("reports no change when the active set already matches", () => {
			const plan = planToolSet(
				["lens_diagnostics", "ast_grep_search"],
				LAZY,
				new Set(["ast_grep_search"]),
			);

			expect(plan.changed).toBe(false);
			expect(plan.addedCount).toBe(0);
			expect(plan.removedCount).toBe(0);
		});
	});

	it("logs bounded mutation counts, reason, and deferral capability", () => {
		recordToolSetMutation({
			addedCount: 2,
			removedCount: 0,
			reason: "lazy_activation",
			deferralApplies: false,
		});

		expect(logLatency).toHaveBeenCalledOnce();
		expect(logLatency).toHaveBeenCalledWith({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "tool_set_mutation",
			durationMs: 0,
			metadata: {
				addedCount: 2,
				removedCount: 0,
				reason: "lazy_activation",
				deferralApplies: false,
			},
		});
	});
});

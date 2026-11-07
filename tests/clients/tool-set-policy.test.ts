import { beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());

vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency,
}));

import {
	getRememberedLazyTools,
	isFreshSessionStart,
	lazyToolMemoryStore,
	planToolSet,
	recordToolSetMutation,
	rememberLazyTools,
	supportsDeferredTools,
} from "../../clients/tool-set-policy.js";
import { beginScope } from "../../clients/session-scope.js";
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
	});

	it("records a missing session scope once when activation memory is unavailable", () => {
		rememberLazyTools(undefined, ["ast_grep_search"]);
		rememberLazyTools(undefined, ["ast_grep_replace"]);

		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "tool-set-scope-unavailable",
				count: 1,
			}),
		]);
	});

	it("keeps each scope's activations its own, in activation order (#3653)", () => {
		const primary = beginScope({ role: "primary" });
		const secondary = beginScope({ role: "secondary" });
		rememberLazyTools(primary, ["ast_grep_search"]);
		rememberLazyTools(secondary, ["lsp_navigation"]);
		rememberLazyTools(primary, ["ast_grep_replace", "ast_grep_search"]);

		expect([...getRememberedLazyTools(primary)]).toEqual([
			"ast_grep_search",
			"ast_grep_replace",
		]);
		expect([...getRememberedLazyTools(secondary)]).toEqual(["lsp_navigation"]);
		expect([...getRememberedLazyTools(undefined)]).toEqual([]);
	});

	it("snapshots a scope's activations and restores them into another, skipping a malformed payload (#3604)", () => {
		const parent = beginScope({ role: "primary" });
		rememberLazyTools(parent, ["ast_grep_search", "lsp_navigation"]);
		const snapshot = lazyToolMemoryStore.snapshot(parent);
		expect(snapshot).toEqual(["ast_grep_search", "lsp_navigation"]);

		const child = beginScope({ role: "primary" });
		const ctx = {
			reason: "fork" as const,
			source: "slot" as const,
			savedAt: undefined,
			sessionManager: undefined,
			cwd: "/",
		};
		void lazyToolMemoryStore.restore(
			child,
			JSON.parse(JSON.stringify(snapshot)),
			ctx,
		);
		void lazyToolMemoryStore.restore(child, { names: ["x"] }, ctx);
		void lazyToolMemoryStore.restore(child, [42, "ast_grep_outline"], ctx);

		expect([...getRememberedLazyTools(child)]).toEqual([
			"ast_grep_search",
			"lsp_navigation",
			"ast_grep_outline",
		]);
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
		// Pi 0.86.1 (the supported floor) through 1.5.0 gate the host's deferred
		// (searchable) tool definitions on TWO arms, and the field must follow
		// both (#5361 r2, review F1):
		//  - `api/openai-responses.js` (azure, codex share it):
		//    `compat.supportsToolSearch` selects the "additions" tool support;
		//  - `api/anthropic-messages.js:153,897`: `nativeToolChanges` is
		//    `supportsMidConvoSystemMessages && supportsMidConvoToolChanges`.
		// Reading the pi 0.80-era `supportsToolReferences` spelling made the
		// field lie on every supported host (#5361).
		expect(
			supportsDeferredTools({ compat: { supportsToolSearch: true } }),
		).toBe(true);
		expect(
			supportsDeferredTools({
				compat: {
					supportsMidConvoSystemMessages: true,
					supportsMidConvoToolChanges: true,
				},
			}),
		).toBe(true);
		// Each half of the Anthropic arm alone is not the capability: pi sends
		// no mid-conversation tool changes when either flag is missing, so a
		// model with one of them must still read false.
		expect(
			supportsDeferredTools({
				compat: { supportsMidConvoSystemMessages: true },
			}),
		).toBe(false);
		expect(
			supportsDeferredTools({ compat: { supportsMidConvoToolChanges: true } }),
		).toBe(false);
		expect(
			supportsDeferredTools({ compat: { supportsToolSearch: false } }),
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

		// #4913 recurrence: `--no-tool <name>` reaches the extension after the
		// factory registered every tool, so the plan is what drops a named tool.
		it("drops a disabled tool from the kept set and from the restored one", () => {
			const plan = planToolSet(
				ALL_ACTIVE,
				LAZY,
				new Set(["ast_grep_search", "lsp_navigation"]),
				new Set(["lens_diagnostics", "lsp_navigation"]),
			);

			expect(plan.desired).toEqual([
				"pi_lens_activate_tools",
				"ast_grep_search",
			]);
			expect(plan.changed).toBe(true);
			// lens_diagnostics (kept baseline) and lsp_navigation (remembered)
			// both go; the plan counts what it removed from the host's set.
			expect(plan.removedCount).toBe(ALL_ACTIVE.length - 2);
			// #4917 F3: the two the command line named, apart from the lazy rest.
			expect(plan.policyDisabledCount).toBe(2);
		});

		it("re-adds no disabled tool the host did not report as active", () => {
			const plan = planToolSet(
				["lens_diagnostics"],
				LAZY,
				new Set(["lsp_navigation"]),
				new Set(["lsp_navigation"]),
			);

			expect(plan.desired).toEqual(["lens_diagnostics"]);
			expect(plan.changed).toBe(false);
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

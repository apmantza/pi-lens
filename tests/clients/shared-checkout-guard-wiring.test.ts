/**
 * `handleToolCall` wiring for the shared-checkout guard (#2007).
 *
 * The evaluator can be perfectly correct and still protect nobody if the
 * tool_call seam never asks it. These three cases pin the seam itself: the
 * flag gate, the refusal reaching pi, and the allow path staying silent.
 *
 * The guard module is mocked so the seam is tested without a registry, a git
 * repo, or a peer process. Its own behavior is covered by
 * `shared-checkout-guard.test.ts` against the real git binary.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const evaluate = vi.fn();
vi.mock("../../clients/shared-checkout-guard.js", () => ({
	evaluateSharedCheckoutGuard: (...args: unknown[]) => evaluate(...args),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => makeLspServiceDouble(),
	resetLSPService: () => {},
}));

import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";

function deps(
	command: string,
	getFlag: (flag: string) => boolean,
): Parameters<typeof handleToolCall>[0] {
	return {
		event: { toolName: "bash", input: { command } },
		ctx: { cwd: process.cwd() },
		lensEnabled: true,
		getFlag,
		dbg: () => {},
		runtime: new RuntimeCoordinator(),
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
	} as Parameters<typeof handleToolCall>[0];
}

describe("shared-checkout guard wiring (#2007)", () => {
	beforeEach(() => {
		evaluate.mockReset();
		evaluate.mockResolvedValue({ block: false });
	});

	it("does not consult the guard while the flag is off", async () => {
		await handleToolCall(deps("git checkout main", () => false));
		// MUTATION PROOF: drop the `getFlag("lens-checkout-guard")` gate and
		// this reds — an opt-in experiment would be on for everyone.
		expect(evaluate).not.toHaveBeenCalled();
	});

	it("blocks the tool with the guard's own reason", async () => {
		evaluate.mockResolvedValue({
			block: true,
			reason: "🔴 WORKING-TREE CHANGE BLOCKED (--lens-checkout-guard): …",
		});
		const result = await handleToolCall(
			deps("git checkout main", (flag) => flag === "lens-checkout-guard"),
		);
		// MUTATION PROOF: delete the wiring block in runtime-tool-call.ts and
		// this reds — the evaluator's verdict would never reach pi.
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain(
			"WORKING-TREE CHANGE BLOCKED",
		);
		expect(evaluate).toHaveBeenCalledWith(
			"bash",
			{ command: "git checkout main" },
			process.cwd(),
		);
	});

	it("lets an allowed command through without an opinion", async () => {
		const result = await handleToolCall(
			deps("git checkout main", (flag) => flag === "lens-checkout-guard"),
		);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result).toBeUndefined();
	});
});

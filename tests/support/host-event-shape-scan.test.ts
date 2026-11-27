import { describe, expect, it } from "vitest";
import {
	hostEventShapeScanFileCount,
	scanHostEventShapeViolations,
	scanSourceForHostEventShapeViolations,
} from "./host-event-shape-scan.ts";
import { assertNonEmptyScan } from "./sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "./test-timeout-scale.js";

/**
 * #1681: pins every `session_start`/`tool_result` test fixture to the real
 * host contract. See `host-event-shape-scan.ts`'s doc comment for the
 * ground-truth citations. This is the registered-or-fail guard the issue
 * asked for — a new fixture that puts `sessionId`/`provider`/`model` on
 * either event object fails HERE, on the next full run, rather than sitting
 * silently until someone notices the fixture masked something.
 */
describe("host event-shape scan (#1681)", () => {
	it(
		"finds no fixture that puts sessionId/provider/model on a session_start or tool_result event",
		() => {
			assertNonEmptyScan(
				"host event-shape production walk",
				hostEventShapeScanFileCount(),
				// Calibration: 830 files walked on 2026-08-26; half rounds to 400.
				400,
			);
			const violations = scanHostEventShapeViolations();
			expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// ── Mutation-proof probes: the scan itself must actually catch the shape
	// it claims to, on synthetic source, independent of what tests/ currently
	// contains. Each runs the REAL detection function, not a re-description
	// of it, so deleting/neutering the field check or the brace matcher fails
	// one of these. ───────────────────────────────────────────────────────
	it("flags sessionId on a session_start event literal", () => {
		const violations = scanSourceForHostEventShapeViolations(
			"probe.test.ts",
			'await pi.emit("session_start", { reason: "startup", sessionId: "x" }, ctx);',
		);
		expect(violations).toEqual([
			expect.objectContaining({
				eventType: "session_start",
				field: "sessionId",
			}),
		]);
	});

	it("flags provider and model on a tool_result event literal", () => {
		const violations = scanSourceForHostEventShapeViolations(
			"probe.test.ts",
			'await pi.emit("tool_result", { toolName: "edit", provider: "anthropic", model: "x" }, ctx);',
		);
		const fields = violations.map((v) => v.field).sort();
		expect(fields).toEqual(["model", "provider"]);
	});

	it("does not flag the real host shape (reason only, no sessionId)", () => {
		const violations = scanSourceForHostEventShapeViolations(
			"probe.test.ts",
			'await pi.emit("session_start", { reason: "startup" }, ctx);',
		);
		expect(violations).toEqual([]);
	});

	it("does not flag sessionId that belongs to a later ctx argument, not the event", () => {
		// `makeCtx({ sessionId: ... })` is the THIRD argument — the correct home
		// for sessionId per the host contract — and must never be mistaken for
		// the event literal itself.
		const violations = scanSourceForHostEventShapeViolations(
			"probe.test.ts",
			'await pi.emit("session_start", { reason: "startup" }, makeCtx({ sessionId: "x" }));',
		);
		expect(violations).toEqual([]);
	});

	it("ignores sessionId mentioned only in a comment or string, not a real field", () => {
		const violations = scanSourceForHostEventShapeViolations(
			"probe.test.ts",
			[
				'// sessionId: "not-a-real-field"',
				'await pi.emit("session_start", { reason: "startup", note: "sessionId: fake" }, ctx);',
			].join("\n"),
		);
		expect(violations).toEqual([]);
	});
});

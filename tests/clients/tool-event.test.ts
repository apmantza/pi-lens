import { describe, expect, it } from "vitest";
import {
	isToolCallEventType,
	resolveReadEvidenceCorrelationId,
} from "../../clients/tool-event.js";

describe("isToolCallEventType", () => {
	it("matches when toolName equals the tag", () => {
		expect(isToolCallEventType("edit", { toolName: "edit" })).toBe(true);
		expect(isToolCallEventType("write", { toolName: "write" })).toBe(true);
	});

	it("does not match a different tool", () => {
		expect(isToolCallEventType("edit", { toolName: "write" })).toBe(false);
		expect(isToolCallEventType("write", { toolName: "read" })).toBe(false);
	});

	it("is false for null / undefined / non-objects", () => {
		expect(isToolCallEventType("edit", null)).toBe(false);
		expect(isToolCallEventType("edit", undefined)).toBe(false);
		expect(isToolCallEventType("edit", "edit")).toBe(false);
		expect(isToolCallEventType("edit", 42)).toBe(false);
	});

	it("is false when toolName is missing", () => {
		expect(isToolCallEventType("edit", { input: {} })).toBe(false);
		expect(isToolCallEventType("edit", {})).toBe(false);
	});
});

describe("resolveReadEvidenceCorrelationId", () => {
	it("uses the parent transcript identity for nested codemode reads", () => {
		expect(
			resolveReadEvidenceCorrelationId({
				toolCallId: "nested/1",
				parentToolCallId: "parent",
			}),
		).toBe("parent");
	});

	it("keeps the normal call identity for top-level reads", () => {
		expect(resolveReadEvidenceCorrelationId({ toolCallId: "read-1" })).toBe(
			"read-1",
		);
	});
});

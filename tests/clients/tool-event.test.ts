import { describe, expect, it } from "vitest";
import { isToolCallEventType } from "../../clients/tool-event.js";

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

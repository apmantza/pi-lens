import { beforeEach, describe, expect, it } from "vitest";
import { AgentBehaviorClient } from "./agent-behavior-client.js";

describe("AgentBehaviorClient", () => {
	let client: AgentBehaviorClient;

	beforeEach(() => {
		client = new AgentBehaviorClient();
		client.reset();
	});

	describe("blind write detection", () => {
		it("should NOT warn when read precedes write", () => {
			client.recordToolCall("read", "src/file.ts");
			client.recordToolCall("edit", "src/file.ts");

			const warnings = client.recordToolCall("write", "src/file.ts");
			expect(warnings).toHaveLength(0);
		});

		it("should warn when multiple writes happen without reads", () => {
			// First write is OK (no history)
			client.recordToolCall("write", "src/file1.ts");

			// Second write - still in window, accumulates
			client.recordToolCall("edit", "src/file2.ts");

			// Third write without any read - now we have a pattern
			const warnings = client.recordToolCall("edit", "src/file3.ts");
			expect(warnings).toHaveLength(1);
			expect(warnings[0].type).toBe("blind-write");
		});

		it("should not warn for single write with no history", () => {
			const warnings = client.recordToolCall("write", "src/file.ts");
			expect(warnings).toHaveLength(0);
		});
	});

	describe("thrashing detection", () => {
		it("should warn after 3 consecutive identical tool calls", () => {
			client.recordToolCall("bash", undefined);

			// Second call - no warning yet
			let warnings = client.recordToolCall("bash", undefined);
			expect(warnings).toHaveLength(0);

			// Third consecutive - should warn
			warnings = client.recordToolCall("bash", undefined);
			expect(warnings).toHaveLength(1);
			expect(warnings[0].type).toBe("thrashing");
			expect(warnings[0].details.callCount).toBe(3);
		});

		it("should NOT warn for different tool calls", () => {
			client.recordToolCall("read", "src/file.ts");
			client.recordToolCall("bash", "npm test");

			const warnings = client.recordToolCall("edit", "src/file.ts");
			expect(warnings).toHaveLength(0);
		});

		it("should reset count when tool changes", () => {
			client.recordToolCall("bash", undefined);
			client.recordToolCall("bash", undefined);

			// Different tool resets the count
			client.recordToolCall("read", "src/file.ts");

			// Now start new consecutive sequence
			client.recordToolCall("bash", undefined);

			const warnings = client.recordToolCall("bash", undefined);
			expect(warnings).toHaveLength(0); // Only 2 consecutive, not 3
		});
	});

	describe("edit counting", () => {
		it("should track edit count per file", () => {
			client.recordToolCall("edit", "src/a.ts");
			client.recordToolCall("edit", "src/a.ts");
			client.recordToolCall("edit", "src/b.ts");

			expect(client.getEditCount("src/a.ts")).toBe(2);
			expect(client.getEditCount("src/b.ts")).toBe(1);
			expect(client.getEditCount("src/c.ts")).toBe(0);
		});
	});

	describe("formatWarnings", () => {
		it("should format multiple warnings", () => {
			const warnings = [
				{
					type: "blind-write" as const,
					message: "⚠ BLIND WRITE — editing file",
					severity: "warning" as const,
					details: {},
				},
				{
					type: "thrashing" as const,
					message: "🔴 THRASHING — 3 consecutive calls",
					severity: "error" as const,
					details: {},
				},
			];

			const formatted = client.formatWarnings(warnings);
			expect(formatted).toContain("BLIND WRITE");
			expect(formatted).toContain("THRASHING");
		});

		it("should return empty string for no warnings", () => {
			expect(client.formatWarnings([])).toBe("");
		});
	});
});

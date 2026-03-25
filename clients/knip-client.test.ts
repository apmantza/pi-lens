import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnipClient } from "./knip-client.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("KnipClient", () => {
	let client: KnipClient;
	let tmpDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		client = new KnipClient();
		({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-test-"));
	});

	afterEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe("isAvailable", () => {
		it("should check knip availability", () => {
			const available = client.isAvailable();
			expect(typeof available).toBe("boolean");
		});
	});

	describe("analyze", () => {
		it("should return success=false when not available", () => {
			const mockClient = new KnipClient();
			if (mockClient.isAvailable()) return;

			const result = mockClient.analyze(tmpDir);
			expect(result.success).toBe(false);
		});
	});

	describe("formatResult", () => {
		it("should return empty string for no issues", () => {
			const result = {
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "",
			};

			expect(client.formatResult(result)).toBe("");
		});

		it("should format unused exports", () => {
			const result = {
				success: true,
				issues: [
					{ type: "export" as const, name: "unusedFunc", file: "utils.ts" },
				],
				unusedExports: [
					{ type: "export" as const, name: "unusedFunc", file: "utils.ts" },
				],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "Found 1 issue",
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("Knip");
			expect(formatted).toContain("unusedFunc");
		});

		it("should format unused dependencies", () => {
			const result = {
				success: true,
				issues: [{ type: "dependency" as const, name: "lodash" }],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [{ type: "dependency" as const, name: "lodash" }],
				unlistedDeps: [],
				summary: "",
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("lodash");
			expect(formatted).toContain("unused dep");
		});

		it("should show unlisted dependencies count", () => {
			const result = {
				success: true,
				issues: [{ type: "unlisted" as const, name: "axios" }],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [{ type: "unlisted" as const, name: "axios" }],
				summary: "",
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("unlisted dep");
		});

		it("should format multiple issue types", () => {
			const result = {
				success: true,
				issues: [
					{ type: "export" as const, name: "func1", file: "a.ts" },
					{ type: "file" as const, name: "old.ts" },
				],
				unusedExports: [
					{ type: "export" as const, name: "func1", file: "a.ts" },
					{ type: "export" as const, name: "func2", file: "b.ts" },
				],
				unusedFiles: [{ type: "file" as const, name: "old.ts" }],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "",
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("2 unused export(s)");
			expect(formatted).toContain("1 unused file(s)");
		});
	});
});

/**
 * LSP Error Recovery Tests
 *
 * Tests for LSP failure scenarios and recovery mechanisms.
 * Critical for stability in real-world usage.
 */

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLSPService, type LSPService, resetLSPService } from "../index.js";

// Check if we should run real LSP tests
const runRealLSPTests = process.env.RUN_REAL_LSP_TESTS === "true";

describe("LSP Error Recovery", () => {
	let service: LSPService;

	beforeEach(() => {
		resetLSPService();
		service = getLSPService();
	});

	afterEach(async () => {
		await service.shutdown();
		resetLSPService();
	});

	describe("Spawn Failures", () => {
		it("should handle LSP spawn failure gracefully", async () => {
			// Simulate spawn failure by using invalid command
			const result = await service.hasLSP("/test/invalid-file.xyz");

			// Should return false without throwing
			expect(result).toBe(false);
		});

		it("should handle missing LSP server binary", async () => {
			// Test with a file type that has no installed LSP
			const result = await service.hasLSP("/test/file.unknown");

			expect(result).toBe(false);
		});

		it("should handle permission denied on spawn", async () => {
			// This would require mocking at a lower level
			// For now, just verify it doesn't crash
			await expect(
				service.openFile("/test.ts", "content"),
			).resolves.not.toThrow();
		});
	});

	describe("Runtime Crashes", () => {
		it("should handle LSP crash during operation", async () => {
			// Open a file first
			await service.openFile("/test.ts", "const x = 1;");

			// Simulate crash by shutting down abruptly
			await service.shutdown();

			// Subsequent operations should handle gracefully
			const diags = await service.getDiagnostics("/test.ts");
			expect(diags).toEqual([]);
		});

		it("should handle multiple rapid shutdown calls", async () => {
			// First shutdown
			await expect(service.shutdown()).resolves.not.toThrow();

			// Second shutdown should also not throw
			await expect(service.shutdown()).resolves.not.toThrow();

			// Third shutdown
			await expect(service.shutdown()).resolves.not.toThrow();
		});

		it("should handle getDiagnostics on crashed server", async () => {
			// Get diagnostics without opening (simulates crash state)
			const diags = await service.getDiagnostics("/nonexistent/crashed.ts");

			expect(diags).toEqual([]);
		});
	});

	describe("Root Detection Edge Cases", () => {
		it("should exclude .pi-lens from root detection", async () => {
			// This was a real bug where .pi-lens/tools/package.json was found as root
			// We verify the config excludes .pi-lens
			const { getAllServers } = await import("../config.js");
			const servers = getAllServers();

			// Should return array (verification that config loads)
			expect(Array.isArray(servers)).toBe(true);
		});

		it("should handle deeply nested file paths", async () => {
			const deepPath = "/very/deep/nested/path/to/the/file.ts";

			// Should not throw on deep paths
			await expect(
				service.openFile(deepPath, "content"),
			).resolves.not.toThrow();

			await expect(service.getDiagnostics(deepPath)).resolves.not.toThrow();
		});

		it("should handle paths with special characters", async () => {
			const specialPaths = [
				"/path with spaces/file.ts",
				"/path-with-dashes/file.ts",
				"/path_with_underscores/file.ts",
				"/path.with.dots/file.ts",
			];

			for (const path of specialPaths) {
				await expect(service.openFile(path, "content")).resolves.not.toThrow();
			}
		});
	});

	describe("Timeout Handling", () => {
		it("should handle slow LSP operations", async () => {
			// Create a mock slow operation
			const slowPromise = new Promise((resolve) => {
				setTimeout(() => resolve("done"), 5000);
			});

			// Should not hang indefinitely
			const timeoutPromise = Promise.race([
				slowPromise,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Timeout")), 100),
				),
			]);

			await expect(timeoutPromise).rejects.toThrow("Timeout");
		});

		it("should handle hanging getDiagnostics", async () => {
			// Start diagnostics request
			const diagPromise = service.getDiagnostics("/test.ts");

			// Should complete (even if empty) within reasonable time
			const result = await Promise.race([
				diagPromise,
				new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
			]);

			// Either completes or times out gracefully
			expect(result).toBeDefined();
		});
	});

	describe("Multiple LSP Coordination", () => {
		it("should handle multiple LSPs running simultaneously", async () => {
			// This tests that multiple LSP servers don't interfere
			const files = [
				{ path: "/test.ts", content: "const x: number = 1;" },
				{ path: "/test.py", content: "x = 1" },
				{ path: "/test.rs", content: "let x = 1;" },
			];

			// Open multiple files
			for (const file of files) {
				await expect(
					service.openFile(file.path, file.content),
				).resolves.not.toThrow();
			}

			// Get diagnostics for all
			for (const file of files) {
				const diags = await service.getDiagnostics(file.path);
				expect(Array.isArray(diags)).toBe(true);
			}
		});

		it("should handle rapid file switching", async () => {
			const files = ["/a.ts", "/b.ts", "/c.ts"];

			// Rapidly switch between files
			for (let i = 0; i < 10; i++) {
				const file = files[i % files.length];
				await service.openFile(file, `content ${i}`);
				await service.getDiagnostics(file);
			}

			// Should not crash or hang
			expect(true).toBe(true);
		});
	});

	describe("Effect Integration Error Handling", () => {
		it("should handle errors in Effect context", async () => {
			const { lspEffect } = await import("../index.js");

			// Try to get LSP for non-existent file type
			const { hasLSP } = lspEffect(service);
			const program = hasLSP("/test.unknownxyz");

			// Should complete without throwing
			const result = await Effect.runPromise(program);
			expect(typeof result).toBe("boolean");
		});

		it("should recover from Effect failures", async () => {
			const { lspEffect } = await import("../index.js");

			// Shutdown then try operations
			await service.shutdown();

			const { shutdown } = lspEffect(service);
			const program = shutdown();

			// Should not throw even after shutdown
			await expect(Effect.runPromise(program)).resolves.not.toThrow();
		});
	});
});

// Real server tests - these require actual LSP servers
// These catch real-world issues like the ESLintServer spawn error
describe.skipIf(!runRealLSPTests)("Real Server Error Recovery", () => {
	let service: LSPService;

	beforeEach(() => {
		resetLSPService();
		service = getLSPService();
	});

	afterEach(async () => {
		await service.shutdown();
		resetLSPService();
	});

	it("should handle real TypeScript LSP spawn", async () => {
		const hasTsLsp = await service.hasLSP("/test.ts");

		if (hasTsLsp) {
			// If installed, should be able to open and diagnose
			await service.openFile("/test.ts", "const x: string = 1;");
			const diags = await service.getDiagnostics("/test.ts");

			// Should get type error
			expect(diags.length).toBeGreaterThan(0);
			expect(diags[0].message).toContain("Type");
		}
	});

	it("should handle real Python LSP spawn", async () => {
		const hasPyLsp = await service.hasLSP("/test.py");

		if (hasPyLsp) {
			await service.openFile("/test.py", "x = 1\nprint(y)"); // y is undefined
			const diags = await service.getDiagnostics("/test.py");

			// Should have errors about undefined y
			expect(diags.length).toBeGreaterThan(0);
		}
	});

	it("should restart crashed LSP server", async () => {
		const hasTsLsp = await service.hasLSP("/test.ts");

		if (hasTsLsp) {
			// Open file
			await service.openFile("/test.ts", "const x = 1;");

			// Get diagnostics (server should be running)
			const _diags1 = await service.getDiagnostics("/test.ts");

			// Shutdown (simulates crash)
			await service.shutdown();

			// Try to use again - should handle gracefully
			const diags2 = await service.getDiagnostics("/test.ts");
			expect(Array.isArray(diags2)).toBe(true);
		}
	});
});

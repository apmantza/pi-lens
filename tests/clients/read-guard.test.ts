/**
 * Read-Before-Edit Guard Tests
 *
 * Tests both Phase 1 (zero-read + FileTime) and Phase 2 (range coverage + LSP expansion)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReadGuard, type ReadRecord } from "../../clients/read-guard.js";
import { setupTestEnvironment } from "./test-utils.js";

// Mock FileTime
vi.mock("../../clients/file-time.js", () => ({
	createFileTime: (_sessionId: string) => ({
		read: vi.fn(),
		hasChanged: vi.fn(() => false),
		assert: vi.fn(),
		get: vi.fn(),
	}),
	FileTimeError: class FileTimeError extends Error {
		constructor(
			message: string,
			readonly filePath: string,
			readonly reason: "not-read" | "modified",
		) {
			super(message);
		}
	},
}));

describe("ReadGuard", () => {
	describe("Phase 1: Zero-read and FileTime checks", () => {
		it("blocks edit on never-read file", () => {
			const guard = createReadGuard("test-session");

			const verdict = guard.checkEdit("/src/api.ts");

			expect(verdict.action).toBe("block");
			expect(verdict.reason).toContain("Edit without read");
		});

		it("allows edit on previously read file", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(createReadRecord("/src/api.ts"));

			const verdict = guard.checkEdit("/src/api.ts");

			expect(verdict.action).toBe("allow");
		});

		it("tracks read history per file", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(createReadRecord("/src/api.ts", { effectiveOffset: 1 }));
			guard.recordRead(
				createReadRecord("/src/api.ts", { effectiveOffset: 50 }),
			);
			guard.recordRead(createReadRecord("/src/db.ts", { effectiveOffset: 1 }));

			expect(guard.getReadHistory("/src/api.ts")).toHaveLength(2);
			expect(guard.getReadHistory("/src/db.ts")).toHaveLength(1);
			expect(guard.getReadHistory("/src/unknown.ts")).toHaveLength(0);
		});

		it("respects one-time user exemptions", () => {
			const guard = createReadGuard("test-session");
			guard.addExemption("/src/api.ts");

			// First edit should be allowed via exemption
			const verdict1 = guard.checkEdit("/src/api.ts");
			expect(verdict1.action).toBe("allow");

			// Second edit should be blocked (exemption consumed)
			const verdict2 = guard.checkEdit("/src/api.ts");
			expect(verdict2.action).toBe("block");
		});

		it("exempts new files from guard", () => {
			const env = setupTestEnvironment("read-guard-");
			try {
				const guard = createReadGuard("test-session");
				const newFilePath = path.join(env.tmpDir, "new-file.ts");

				// File doesn't exist yet
				expect(guard.isNewFile(newFilePath)).toBe(true);
			} finally {
				env.cleanup();
			}
		});

		it("does not exempt existing files", () => {
			const env = setupTestEnvironment("read-guard-");
			try {
				const guard = createReadGuard("test-session");
				const existingFile = path.join(env.tmpDir, "existing.ts");
				fs.writeFileSync(existingFile, "export const x = 1;");

				expect(guard.isNewFile(existingFile)).toBe(false);
			} finally {
				env.cleanup();
			}
		});
	});

	describe("Phase 2: Range coverage checks", () => {
		it("allows edit within read range", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 10,
					effectiveLimit: 20, // lines 10-30
				}),
			);

			const verdict = guard.checkEdit("/src/api.ts", [15, 20]);

			expect(verdict.action).toBe("allow");
		});

		it("allows edit within context window of read range", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 10,
					effectiveLimit: 10, // lines 10-20
				}),
			);

			// Edit at line 23, context window (3 lines) extends to 23
			const verdict = guard.checkEdit("/src/api.ts", [23, 23]);

			expect(verdict.action).toBe("allow");
		});

		it("blocks edit outside read range", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 10,
					effectiveLimit: 5, // lines 10-15
				}),
			);

			const verdict = guard.checkEdit("/src/api.ts", [50, 55]);

			expect(verdict.action).toBe("block");
			expect(verdict.reason).toContain("outside read range");
			expect(verdict.details?.editRange).toEqual([50, 55]);
		});

		it("allows edit via LSP symbol expansion", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					requestedOffset: 30,
					requestedLimit: 1, // read single line
					effectiveOffset: 30,
					effectiveLimit: 1,
					expandedByLsp: true,
					enclosingSymbol: {
						name: "handleRequest",
						kind: "function",
						startLine: 25,
						endLine: 60,
					},
				}),
			);

			// Edit inside the symbol but outside literal read range
			const verdict = guard.checkEdit("/src/api.ts", [45, 48]);

			expect(verdict.action).toBe("allow");
		});

		it("blocks edit outside symbol even with LSP expansion", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					requestedOffset: 30,
					requestedLimit: 1,
					effectiveOffset: 30,
					effectiveLimit: 1,
					expandedByLsp: true,
					enclosingSymbol: {
						name: "handleRequest",
						kind: "function",
						startLine: 25,
						endLine: 60,
					},
				}),
			);

			// Edit outside the symbol
			const verdict = guard.checkEdit("/src/api.ts", [70, 75]);

			expect(verdict.action).toBe("block");
		});

		it("considers all previous reads, not just the last one", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 1,
					effectiveLimit: 10, // lines 1-11
				}),
			);
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 50,
					effectiveLimit: 10, // lines 50-60
				}),
			);

			// Edit at line 5 (covered by first read)
			const verdict = guard.checkEdit("/src/api.ts", [5, 5]);

			expect(verdict.action).toBe("allow");
		});
	});

	describe("Edge cases and error handling", () => {
		it("allows edit when no line info is provided", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(createReadRecord("/src/api.ts"));

			// No touchedLines provided
			const verdict = guard.checkEdit("/src/api.ts");

			expect(verdict.action).toBe("allow");
		});

		it("handles multiple files independently", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(createReadRecord("/src/a.ts"));

			// Can edit a.ts (was read)
			expect(guard.checkEdit("/src/a.ts", [1, 10]).action).toBe("allow");

			// Cannot edit b.ts (was not read)
			expect(guard.checkEdit("/src/b.ts", [1, 10]).action).toBe("block");
		});

		it("respects pattern exemptions", () => {
			const guard = createReadGuard("test-session", {
				exemptions: [{ pattern: "*.md", mode: "allow" }],
			});

			// Can edit markdown files even without reading
			const verdict = guard.checkEdit("/docs/readme.md");
			expect(verdict.action).toBe("allow");

			// Still blocks other files
			const tsVerdict = guard.checkEdit("/src/api.ts");
			expect(tsVerdict.action).toBe("block");
		});

		it("supports warn mode instead of block", () => {
			const guard = createReadGuard("test-session", { mode: "warn" });

			const verdict = guard.checkEdit("/src/api.ts");

			expect(verdict.action).toBe("warn");
			expect(verdict.reason).toContain("Edit without read");
		});

		it("handles empty read history gracefully", () => {
			const guard = createReadGuard("test-session");

			expect(guard.getReadHistory("/nonexistent.ts")).toEqual([]);
			expect(guard.getEditHistory("/nonexistent.ts")).toEqual([]);
		});
	});

	describe("Telemetry and summary", () => {
		it("tracks edit history", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(createReadRecord("/src/api.ts"));

			// Allowed edit
			guard.checkEdit("/src/api.ts", [1, 10]);

			// Blocked edit (different file)
			guard.checkEdit("/src/other.ts", [1, 10]);

			const history = guard.getEditHistory("/src/api.ts");
			expect(history).toHaveLength(1);
			expect(history[0].verdict).toBe("allowed");

			const otherHistory = guard.getEditHistory("/src/other.ts");
			expect(otherHistory).toHaveLength(1);
			expect(otherHistory[0].verdict).toBe("blocked");
		});

		it("provides summary statistics", () => {
			const guard = createReadGuard("test-session");

			// Set up some reads and edits
			guard.recordRead(createReadRecord("/src/api.ts"));
			guard.recordRead(createReadRecord("/src/db.ts"));

			guard.checkEdit("/src/api.ts", [1, 10]); // allowed
			guard.checkEdit("/src/other.ts", [1, 10]); // blocked
			guard.checkEdit("/src/db.ts", [100, 110]); // blocked (out of range)

			const summary = guard.getSummary();

			expect(summary.totalEdits).toBe(3);
			expect(summary.totalBlocks).toBe(2);
			expect(summary.byFile["/src/api.ts"].edits).toBe(1);
			expect(summary.byFile["/src/api.ts"].blocks).toBe(0);
			expect(summary.byFile["/src/other.ts"].blocks).toBe(1);
		});
	});
});

// --- Helpers ---

function createReadRecord(
	filePath: string,
	overrides: Partial<ReadRecord> = {},
): ReadRecord {
	return {
		filePath,
		requestedOffset: 1,
		requestedLimit: 100,
		effectiveOffset: 1,
		effectiveLimit: 100,
		expandedByLsp: false,
		turnIndex: 1,
		writeIndex: 1,
		timestamp: Date.now(),
		...overrides,
	};
}

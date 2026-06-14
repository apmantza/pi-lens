/**
 * Read-Before-Edit Guard Tests
 *
 * Tests both Phase 1 (zero-read + FileTime) and Phase 2 (range coverage + LSP expansion)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createReadGuard,
	currentLinesMatchReadSnapshot,
	type ReadRecord,
} from "../../clients/read-guard.js";
import { logReadGuardEvent } from "../../clients/read-guard-logger.js";
import { setupTestEnvironment } from "./test-utils.js";

const fileTimeState = vi.hoisted(() => ({ hasChanged: false }));

// Suppress log writes — tests care about verdicts, not log output
vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));

// Mock FileTime
vi.mock("../../clients/file-time.js", () => ({
	createFileTime: (_sessionId: string) => ({
		read: vi.fn(),
		hasChanged: vi.fn(() => fileTimeState.hasChanged),
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
	beforeEach(() => {
		fileTimeState.hasChanged = false;
		vi.mocked(logReadGuardEvent).mockClear();
	});
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

		it("allows zero-read edit when noteCreatedFile + recordWritten ran (full Write tool path)", () => {
			const env = setupTestEnvironment("read-guard-write-then-edit-");
			try {
				const filePath = path.join(env.tmpDir, "fresh.ts");
				const guard = createReadGuard("test-session");

				// Simulate the pi Write tool's full lifecycle: pre-tool-call notes
				// the pending creation, the tool writes the file, then tool_result
				// fires recordWritten which injects a synthetic read.
				guard.noteCreatedFile(filePath, 0, 0);
				fs.writeFileSync(filePath, "export const x = 1;\n");
				guard.recordWritten(filePath);

				// Edit follows with no real Read — must be allowed.
				const verdict = guard.checkEdit(filePath);
				expect(verdict.action).toBe("allow");
			} finally {
				env.cleanup();
			}
		});

		it("allows zero-read edit via session_authored when recordWritten ran without noteCreatedFile and mtime is stale", () => {
			// Covers FAT32 / NFS / clock-skew cases where mtime is unreliable AND
			// path-mismatch cases where noteCreatedFile keyed a different path so
			// injectCreationRead didn't fire. The explicit writtenThisSession set
			// guarantees the edit is allowed regardless of mtime.
			const env = setupTestEnvironment("read-guard-mtime-skew-");
			try {
				const filePath = path.join(env.tmpDir, "skewed.ts");
				fs.writeFileSync(filePath, "export const x = 1;\n");
				// Backdate mtime to before this session would have started.
				const longAgo = new Date("2000-01-01T00:00:00Z");
				fs.utimesSync(filePath, longAgo, longAgo);

				const guard = createReadGuard("test-session");
				// recordWritten only — no pending creation, no synthetic read.
				guard.recordWritten(filePath);

				const verdict = guard.checkEdit(filePath);
				expect(verdict.action).toBe("allow");
				expect(logReadGuardEvent).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "edit_allowed",
						metadata: expect.objectContaining({
							reasonKind: "session_authored",
						}),
					}),
				);
			} finally {
				env.cleanup();
			}
		});

		it("blocks zero-read edit on a file the agent never wrote and was last touched before this session", () => {
			const env = setupTestEnvironment("read-guard-old-file-");
			try {
				const filePath = path.join(env.tmpDir, "old.ts");
				fs.writeFileSync(filePath, "export const x = 1;\n");
				const longAgo = new Date("2000-01-01T00:00:00Z");
				fs.utimesSync(filePath, longAgo, longAgo);

				const guard = createReadGuard("test-session");
				// No recordWritten — agent did NOT write this file in this session.
				const verdict = guard.checkEdit(filePath);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("Edit without read");
			} finally {
				env.cleanup();
			}
		});

		it("ignores mtime staleness when read line hashes still match", () => {
			const env = setupTestEnvironment("read-guard-hash-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "export const value = 1;\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(createReadRecord(filePath, { effectiveLimit: 1 }));

				// Whitespace-only change: content hash strips whitespace, so the read is still valid.
				fs.writeFileSync(filePath, "export   const   value=1;\n");
				fileTimeState.hasChanged = true;

				const verdict = guard.checkEdit(filePath, [1, 1]);
				expect(verdict.action).toBe("allow");
				expect(guard.getEditHistory(filePath)[0]).toMatchObject({
					verdict: "allowed",
				});
			} finally {
				env.cleanup();
			}
		});

		it("blocks mtime staleness when read line hashes changed", () => {
			const env = setupTestEnvironment("read-guard-hash-block-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "export const value = 1;\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(createReadRecord(filePath, { effectiveLimit: 1 }));

				fs.writeFileSync(filePath, "export const value = 2;\n");
				fileTimeState.hasChanged = true;

				const verdict = guard.checkEdit(filePath, [1, 1]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("File modified since read");
			} finally {
				env.cleanup();
			}
		});
	});

	describe("Range snapshot validation building blocks", () => {
		it("detects when current lines still match the remembered read snapshot", () => {
			const env = setupTestEnvironment("read-guard-snapshot-match-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\n");
				const guard = createReadGuard("test-session");
				const read = createReadRecord(filePath, {
					effectiveOffset: 1,
					effectiveLimit: 3,
				});
				guard.recordRead(read);
				const storedRead = guard.getReadHistory(filePath)[0];

				expect(
					currentLinesMatchReadSnapshot(filePath, storedRead, [2, 3]),
				).toMatchObject({
					checked: true,
					matches: true,
					missingLines: [],
					mismatchedLines: [],
				});
			} finally {
				env.cleanup();
			}
		});

		it("blocks stale target lines when the remembered read snapshot differs", () => {
			const env = setupTestEnvironment("read-guard-snapshot-stale-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
					}),
				);
				const storedRead = guard.getReadHistory(filePath)[0];
				fs.writeFileSync(filePath, "one\nTWO\nthree\n");

				expect(
					currentLinesMatchReadSnapshot(filePath, storedRead, [2, 2]),
				).toMatchObject({
					checked: true,
					matches: false,
					mismatchedLines: [2],
				});
				fileTimeState.hasChanged = false;
				const verdict = guard.checkEdit(filePath, [2, 2]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("Edit range changed since read");
				expect(verdict.details?.snapshot).toMatchObject({
					status: "mismatch",
					mismatchedLines: [2],
				});
			} finally {
				env.cleanup();
			}
		});

		it("hints the relocated range when read content shifted position", () => {
			const env = setupTestEnvironment("read-guard-relocate-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(
					filePath,
					"alpha\nbeta\ntargetOne\ntargetTwo\ngamma\n",
				);
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 5,
					}),
				);
				// Insert three lines at the top — targetOne/targetTwo shift 3-4 → 6-7.
				fs.writeFileSync(
					filePath,
					"x\ny\nz\nalpha\nbeta\ntargetOne\ntargetTwo\ngamma\n",
				);
				fileTimeState.hasChanged = false;

				const verdict = guard.checkEdit(filePath, [3, 4]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("Edit range changed since read");
				expect(verdict.reason).toContain("now appears unchanged at lines 6-7");
				expect(verdict.details?.relocation).toEqual({
					from: [3, 4],
					to: [6, 7],
				});
				// Single-range edit → actionable auto-apply signal is offered.
				expect(verdict.relocation).toEqual({ from: [3, 4], to: [6, 7] });
			} finally {
				env.cleanup();
			}
		});

		it("omits the relocation hint when the shifted content is ambiguous", () => {
			const env = setupTestEnvironment("read-guard-relocate-ambig-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "alpha\ntargetA\ntargetB\nbeta\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 4,
					}),
				);
				// Lines 2-3 are overwritten (→ range-stale) and the original
				// targetA/targetB pair now reappears in TWO places → relocation
				// must refuse (ambiguous, safety).
				fs.writeFileSync(
					filePath,
					"alpha\nCHANGED\nLINE\nbeta\ntargetA\ntargetB\nfiller\ntargetA\ntargetB\n",
				);
				fileTimeState.hasChanged = false;

				const verdict = guard.checkEdit(filePath, [2, 3]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("Edit range changed since read");
				expect(verdict.reason).not.toContain("now appears unchanged");
				expect(verdict.details?.relocation).toBeUndefined();
				expect(verdict.relocation).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});

		it("does not offer auto-apply relocation for a multi-range stale edit", () => {
			const env = setupTestEnvironment("read-guard-relocate-multi-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(
					filePath,
					"alpha\ntargetOne\ntargetTwo\nbeta\nkeepA\nkeepB\n",
				);
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 6,
					}),
				);
				// targetOne/targetTwo shift 2-3 → 5-6; the edit is multi-range, so the
				// stale sub-range gets a HINT but no actionable auto-apply signal.
				fs.writeFileSync(
					filePath,
					"x\ny\nz\nalpha\ntargetOne\ntargetTwo\nbeta\nkeepA\nkeepB\n",
				);
				fileTimeState.hasChanged = false;

				const verdict = guard.checkEdit(
					filePath,
					[2, 6],
					[
						[2, 3],
						[5, 6],
					],
				);
				expect(verdict.action).toBe("block");
				expect(verdict.relocation).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});

		it("relocates via the adaptive window when content is duplicated far away but locally unique", () => {
			const env = setupTestEnvironment("read-guard-relocate-window-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(
					filePath,
					"alpha\nbeta\nneedleOne\nneedleTwo\ngamma\n",
				);
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 5,
					}),
				);
				// Prepend 3 lines (needles shift 3-4 → 6-7) AND add a second copy of
				// the pair far below (line ~59-60), outside the adaptive window. The
				// whole-file scan sees two matches; the window fallback keeps the
				// near, locally-unique one.
				const filler = Array.from({ length: 50 }, (_, i) => `filler${i}`).join(
					"\n",
				);
				fs.writeFileSync(
					filePath,
					`x\ny\nz\nalpha\nbeta\nneedleOne\nneedleTwo\ngamma\n${filler}\nneedleOne\nneedleTwo\n`,
				);
				fileTimeState.hasChanged = false;

				const verdict = guard.checkEdit(filePath, [3, 4]);
				expect(verdict.action).toBe("block");
				expect(verdict.relocation).toEqual({ from: [3, 4], to: [6, 7] });
			} finally {
				env.cleanup();
			}
		});

		it("still relocates a far-shifted edit when the content is globally unique", () => {
			const env = setupTestEnvironment("read-guard-relocate-far-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(
					filePath,
					"alpha\nbeta\nuniqueOne\nuniqueTwo\ngamma\n",
				);
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 5,
					}),
				);
				// Prepend 60 lines — far beyond the window — but the content stays
				// unique, so global uniqueness still relocates it (no regression).
				const filler = Array.from({ length: 60 }, (_, i) => `pad${i}`).join(
					"\n",
				);
				fs.writeFileSync(
					filePath,
					`${filler}\nalpha\nbeta\nuniqueOne\nuniqueTwo\ngamma\n`,
				);
				fileTimeState.hasChanged = false;

				const verdict = guard.checkEdit(filePath, [3, 4]);
				expect(verdict.action).toBe("block");
				expect(verdict.relocation).toEqual({ from: [3, 4], to: [63, 64] });
			} finally {
				env.cleanup();
			}
		});

		it("skips snapshot check when skipSnapshotCheck is set (content-match validated)", () => {
			const env = setupTestEnvironment("read-guard-snapshot-skip-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
					}),
				);
				fs.writeFileSync(filePath, "one\nTWO\nthree\n");
				fileTimeState.hasChanged = false;

				// Without skipSnapshotCheck: blocks (stale snapshot)
				expect(guard.checkEdit(filePath, [2, 2]).action).toBe("block");

				// With skipSnapshotCheck: allows (content match bypasses range staleness)
				expect(
					guard.checkEdit(filePath, [2, 2], undefined, {
						skipSnapshotCheck: true,
					}).action,
				).toBe("allow");
			} finally {
				env.cleanup();
			}
		});

		it("allows edits when only unrelated lines changed after read", () => {
			const env = setupTestEnvironment("read-guard-snapshot-unrelated-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
					}),
				);

				fs.writeFileSync(filePath, "ONE\ntwo\nthree\n");
				fileTimeState.hasChanged = true;

				const verdict = guard.checkEdit(filePath, [2, 2]);
				expect(verdict.action).toBe("allow");
				expect(guard.getEditHistory(filePath)[0]).toMatchObject({
					verdict: "allowed",
				});
			} finally {
				env.cleanup();
			}
		});

		it("blocks a multi-range edit when one target range is stale", () => {
			const env = setupTestEnvironment("read-guard-snapshot-multirange-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\nfour\nfive\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 2,
					}),
				);
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 4,
						effectiveLimit: 2,
					}),
				);

				fs.writeFileSync(filePath, "one\ntwo\nthree\nFOUR\nfive\n");
				fileTimeState.hasChanged = false;

				const verdict = guard.checkEdit(
					filePath,
					[1, 5],
					[
						[2, 2],
						[4, 4],
					],
				);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("Edit range changed since read");
				expect(verdict.details?.editRange).toEqual([4, 4]);
			} finally {
				env.cleanup();
			}
		});

		it("falls back to range coverage when snapshot hashes are unavailable", () => {
			const env = setupTestEnvironment("read-guard-snapshot-unavailable-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
						lineHashes: {},
					}),
				);

				fs.writeFileSync(filePath, "one\nTWO\nthree\n");
				fileTimeState.hasChanged = false;

				const verdict = guard.checkEdit(filePath, [2, 2]);
				expect(verdict.action).toBe("allow");
			} finally {
				env.cleanup();
			}
		});

		it("reports unavailable when a read lacks line hashes for the range", () => {
			const env = setupTestEnvironment("read-guard-snapshot-missing-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\n");
				const read = createReadRecord(filePath, {
					effectiveOffset: 1,
					effectiveLimit: 2,
					lineHashes: {},
				});

				expect(
					currentLinesMatchReadSnapshot(filePath, read, [1, 1]),
				).toMatchObject({
					checked: false,
					matches: false,
					missingLines: [1],
				});
			} finally {
				env.cleanup();
			}
		});

		it("suppresses stale mismatch when a newer re-read covers most of the edit range via context-zone boundary", () => {
			// Scenario: agent had a large old read [1-3] that is now stale (file changed).
			// Agent re-reads [1-2] (newer timestamp) and then edits [2-3]:
			//   - Old read [1-3]: effective candidate, mismatch (line 2 changed)
			//   - New re-read [1-2]: contextual candidate (line 3 in context zone), unavailable
			// Expected: do NOT block — the re-read is newer than the mismatch.
			const env = setupTestEnvironment("read-guard-snapshot-rereed-suppress-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\n");
				const guard = createReadGuard("test-session");

				const t1 = Date.now() - 1000;
				const t2 = Date.now();

				// Old large read (stale — will mismatch after file changes)
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
						timestamp: t1,
					}),
				);

				// File changes (simulating a prior successful edit shifting content)
				fs.writeFileSync(filePath, "one\nTWO\nthree\n");
				fileTimeState.hasChanged = false;

				// Agent re-reads [1-2] after the change (newer timestamp)
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 2,
						timestamp: t2,
					}),
				);

				// Edit at [2-3]: line 3 is 1 beyond the re-read boundary [1-2],
				// falls in context zone (contextLines=3), so re-read is "unavailable"
				// for line 3 but should still suppress the old mismatch.
				const verdict = guard.checkEdit(filePath, [2, 3]);
				expect(verdict.action).toBe("allow");
			} finally {
				env.cleanup();
			}
		});

		it("does not carry missing lines from one snapshot candidate into mismatch telemetry", () => {
			const env = setupTestEnvironment("read-guard-snapshot-telemetry-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\n");
				const guard = createReadGuard("test-session");

				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
						lineHashes: {},
					}),
				);
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
					}),
				);
				vi.mocked(logReadGuardEvent).mockClear();

				fs.writeFileSync(filePath, "one\nTWO\nthree\n");
				expect(guard.checkEdit(filePath, [2, 2]).action).toBe("allow");

				const validationEntry = vi
					.mocked(logReadGuardEvent)
					.mock.calls.find(
						([entry]) => entry.event === "range_snapshot_validation",
					)?.[0];

				expect(validationEntry?.metadata).toMatchObject({
					status: "mismatch",
					candidateReadCount: 2,
					checkedCandidateCount: 1,
					unavailableCandidateCount: 1,
					missingLineCount: 0,
					mismatchedLineCount: 1,
					missingLines: [],
					mismatchedLines: [2],
					enforced: false,
				});
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
					effectiveLimit: 11, // lines 10-20
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

		it("warns (not blocks) out-of-range edit when oldText was resolved", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 10,
					effectiveLimit: 5, // lines 10-15
				}),
			);

			// oldTextResolved: true — content was found in file, line drift is the likely cause
			const verdict = guard.checkEdit("/src/api.ts", [50, 55], undefined, {
				oldTextResolved: true,
			});

			expect(verdict.action).toBe("warn");
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

		it("allows multi-range edit when each range is individually covered", () => {
			// Reproduces the pattern: grep finds 4 tool names, agent reads 4 small
			// chunks around each, then submits a single edit touching all 4 spots.
			// The bounding box spans unread lines, but each edit point was read.
			const guard = createReadGuard("test-session");
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 10,
					effectiveLimit: 5,
				}),
			);
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 30,
					effectiveLimit: 5,
				}),
			);
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 60,
					effectiveLimit: 5,
				}),
			);
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 90,
					effectiveLimit: 5,
				}),
			);

			const boundingBox: [number, number] = [10, 94];
			const editRanges: [number, number][] = [
				[10, 10],
				[30, 30],
				[60, 60],
				[90, 94],
			];
			const verdict = guard.checkEdit("/src/api.ts", boundingBox, editRanges);

			expect(verdict.action).toBe("allow");
		});

		it("blocks multi-range edit when any individual range is not covered", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 10,
					effectiveLimit: 5,
				}),
			);
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 30,
					effectiveLimit: 5,
				}),
			);
			// Line 60 was NOT read
			guard.recordRead(
				createReadRecord("/src/api.ts", {
					effectiveOffset: 90,
					effectiveLimit: 5,
				}),
			);

			const boundingBox: [number, number] = [10, 94];
			const editRanges: [number, number][] = [
				[10, 10],
				[30, 30],
				[60, 60],
				[90, 94],
			];
			const verdict = guard.checkEdit("/src/api.ts", boundingBox, editRanges);

			expect(verdict.action).toBe("block");
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

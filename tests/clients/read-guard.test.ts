/**
 * Read-Before-Edit Guard Tests
 *
 * Tests both Phase 1 (zero-read + FileTime) and Phase 2 (range coverage + LSP expansion)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import {
	captureReadContentBinding,
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
	it("revokes an unseen blocked read without dropping delivered evidence", () => {
		const filePath = "/tmp/blocked-read-release.ts";
		const guard = createReadGuard("blocked-read-release-session");
		// Recurrence: a later extension can block after the read tool_call, so no
		// tool_result arrives; that unseen capture must not license an edit.
		guard.recordRead(
			createReadRecord(filePath, {
				provisional: true,
				source: "native-read:blocked-call:provisional",
			}),
		);
		guard.recordRead(
			createReadRecord(filePath, { toolCallId: "delivered-result" }),
		);

		expect(guard.dropProvisionalReadByCall("blocked-call")).toBe(true);
		expect(guard.getReadHistory(filePath)).toEqual([
			expect.objectContaining({ toolCallId: "delivered-result" }),
		]);
	});

	it("releases every provisional capture at the turn boundary", () => {
		const guard = createReadGuard("blocked-read-turn-end-session");
		for (const [filePath, source] of [
			["/tmp/a.ts", "native-read:a:provisional"],
			["/tmp/b.ts", "native-read:b:provisional"],
		] as const)
			guard.recordRead(
				createReadRecord(filePath, { provisional: true, source }),
			);

		expect(guard.dropProvisionalReads()).toBe(2);
		expect(guard.getReadHistory("/tmp/a.ts")).toEqual([]);
		expect(guard.getReadHistory("/tmp/b.ts")).toEqual([]);
	});
	it("supersedes only the correlated provisional native read", () => {
		const filePath = "/tmp/native-read-identity.ts";
		const guard = createReadGuard("native-read-identity-session");
		const recordRead = guard.recordRead.bind(guard) as unknown as (
			record: ReadRecord,
			opts?: { supersedes?: { toolCallId: string } },
		) => void;

		// The recurrence is identity laundering: a concurrent result must not
		// replace another native read's provisional range.
		recordRead(
			createReadRecord(filePath, {
				effectiveLimit: 3000,
				source: "native-read:c1:provisional",
				provisional: true,
			}),
		);
		recordRead(
			createReadRecord(filePath, {
				effectiveOffset: 2000,
				effectiveLimit: 2000,
				source: "native-read:c2:provisional",
				provisional: true,
			}),
		);

		recordRead(createReadRecord(filePath, { effectiveLimit: 2000 }), {
			supersedes: { toolCallId: "c2" },
		});

		expect(
			guard
				.getReadHistory(filePath)
				.map((record) => [record.effectiveLimit, record.source]),
		).toEqual([
			[3000, "native-read:c1:provisional"],
			[2000, undefined],
		]);
		expect(guard.checkEdit(filePath, [2500, 2500]).action).toBe("block");
		expect(guard.checkEdit(filePath, [1500, 1500]).action).toBe("allow");
	});

	it("records delivered coverage when its provisional identity is missing", () => {
		const filePath = "/tmp/native-read-missing-provisional.ts";
		const guard = createReadGuard("native-read-missing-provisional-session");
		guard.recordRead(createReadRecord(filePath, { effectiveLimit: 2000 }), {
			supersedes: { toolCallId: "evicted-call" },
		});

		// The recurrence is cap/path eviction: losing the provisional must not
		// discard the delivered read and force an endless re-read loop.
		expect(guard.checkEdit(filePath, [1500, 1500]).action).toBe("allow");
		expect(guard.checkEdit(filePath, [2500, 2500]).action).toBe("block");
	});
	describe("content-binding supersession (#3962)", () => {
		it("reports whether the newest full-file read still matches the file", () => {
			const env = setupTestEnvironment("read-guard-last-content-");
			try {
				const filePath = path.join(env.tmpDir, "file.ts");
				fs.writeFileSync(filePath, "const value = 1;\n");
				const guard = createReadGuard("last-content-session");
				const binding = captureReadContentBinding(filePath, 1, 100);
				expect(binding?.fullFile).toBe(true);
				guard.recordRead(
					createReadRecord(filePath, { contentBinding: binding }),
				);
				expect(guard.contentMatchesLastRead(filePath)).toBe(true);
				fs.writeFileSync(filePath, "const value = 2;\n");
				expect(guard.contentMatchesLastRead(filePath)).toBe(false);
			} finally {
				env.cleanup();
			}
		});

		const before = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
		const after = "const a = 99;\nconst b = 2;\nconst c = 3;\n";
		const span20 = `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")}\n`;
		const span20GapChanged = span20.replace("line10", "line10-changed");

		function recordBridgeBinding(
			guard: ReturnType<typeof createReadGuard>,
			filePath: string,
			limit: number,
		): void {
			const binding = captureReadContentBinding(filePath, 1, limit);
			expect(binding).toBeDefined();
			guard.recordRead(
				createReadRecord(filePath, {
					effectiveOffset: 1,
					effectiveLimit: limit,
					source: "bridge:test",
					contentBinding: binding,
				}),
			);
		}

		function recordNativeRead(
			guard: ReturnType<typeof createReadGuard>,
			filePath: string,
			offset: number,
			limit: number,
			source = "native-read:test",
		): void {
			guard.recordRead(
				createReadRecord(filePath, {
					source,
					effectiveOffset: offset,
					effectiveLimit: limit,
				}),
			);
		}

		it("allows an edit a newer covering native re-read supersedes", () => {
			const env = setupTestEnvironment("read-guard-supersede-");
			try {
				const filePath = path.join(env.tmpDir, "supersede.ts");
				fs.writeFileSync(filePath, before);
				const guard = createReadGuard("supersede-session");
				recordBridgeBinding(guard, filePath, 1);
				// An external tool changes the bytes after the bridge read.
				fs.writeFileSync(filePath, after);
				// The remedy the block message asks for: a native re-read of disk.
				recordNativeRead(guard, filePath, 1, 3);

				expect(guard.checkEdit(filePath, [1, 1])).toEqual({ action: "allow" });
			} finally {
				env.cleanup();
			}
		});

		it("still blocks when no newer read covers the edited lines", () => {
			const env = setupTestEnvironment("read-guard-supersede-noncover-");
			try {
				const filePath = path.join(env.tmpDir, "noncover.ts");
				fs.writeFileSync(filePath, before);
				const guard = createReadGuard("supersede-noncover-session");
				recordBridgeBinding(guard, filePath, 1);
				fs.writeFileSync(filePath, after);
				// Newer, but only line 1 was delivered; the edit targets line 3.
				recordNativeRead(guard, filePath, 1, 1);

				const verdict = guard.checkEdit(filePath, [3, 3]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("content no longer matches");
			} finally {
				env.cleanup();
			}
		});

		it("still blocks when the newer read is stale against disk", () => {
			const env = setupTestEnvironment("read-guard-supersede-stale-");
			try {
				const filePath = path.join(env.tmpDir, "stale.ts");
				fs.writeFileSync(filePath, before);
				const guard = createReadGuard("supersede-stale-session");
				recordBridgeBinding(guard, filePath, 1);
				// The newer read happened BEFORE the external change: its hashes
				// describe the old bytes, so it cannot vouch for the new ones.
				recordNativeRead(guard, filePath, 1, 3);
				fs.writeFileSync(filePath, after);

				const verdict = guard.checkEdit(filePath, [1, 1]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("content no longer matches");
			} finally {
				env.cleanup();
			}
		});

		it("still blocks when the newer read carries no hashes for the edit", () => {
			const env = setupTestEnvironment("read-guard-supersede-unhashed-");
			try {
				const filePath = path.join(env.tmpDir, "unhashed.ts");
				fs.writeFileSync(filePath, before);
				const guard = createReadGuard("supersede-unhashed-session");
				recordBridgeBinding(guard, filePath, 1);
				fs.writeFileSync(filePath, after);
				guard.recordRead(
					createReadRecord(filePath, {
						source: "native-read:test",
						effectiveOffset: 1,
						effectiveLimit: 1,
						lineHashes: {},
					}),
				);

				const verdict = guard.checkEdit(filePath, [1, 1]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("content no longer matches");
			} finally {
				env.cleanup();
			}
		});

		it("allows when a fresh bridge read re-binds the edited bytes", () => {
			const env = setupTestEnvironment("read-guard-supersede-rebind-");
			try {
				const filePath = path.join(env.tmpDir, "rebind.ts");
				fs.writeFileSync(filePath, before);
				const guard = createReadGuard("supersede-rebind-session");
				recordBridgeBinding(guard, filePath, 1);
				fs.writeFileSync(filePath, after);
				// The bridge read that DELIVERED the changed bytes is the newest
				// bound record, so its binding matches and no block fires.
				recordBridgeBinding(guard, filePath, 1);

				expect(guard.checkEdit(filePath, [1, 1])).toEqual({ action: "allow" });
			} finally {
				env.cleanup();
			}
		});

		it("keeps the stale block when no edit range is supplied", () => {
			const env = setupTestEnvironment("read-guard-supersede-norange-");
			try {
				const filePath = path.join(env.tmpDir, "norange.ts");
				fs.writeFileSync(filePath, before);
				const guard = createReadGuard("supersede-norange-session");
				recordBridgeBinding(guard, filePath, 1);
				fs.writeFileSync(filePath, after);
				recordNativeRead(guard, filePath, 1, 3);

				const verdict = guard.checkEdit(filePath);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("content no longer matches");
			} finally {
				env.cleanup();
			}
		});

		it("allows when a newer covering read matches both edited ranges but a gap line changed", () => {
			// Kills mutation IDs 7 and 11, which collapse `editRanges` into the
			// bounding box: lines 2 and 20 are the edit, both fresh in the newer
			// read, and only the gap line 10 between them is stale. A box check
			// would drop the one fresh answer this filter exists to keep.
			const env = setupTestEnvironment("read-guard-supersede-gap-");
			try {
				const filePath = path.join(env.tmpDir, "gap.ts");
				fs.writeFileSync(filePath, span20);
				const guard = createReadGuard("supersede-gap-session");
				recordBridgeBinding(guard, filePath, 1);
				// The newer delivered read covers the whole span the edit brackets.
				recordNativeRead(guard, filePath, 2, 19);
				// Only the GAP line 10 changes; the edited lines 2 and 20 stay fresh.
				fs.writeFileSync(filePath, span20GapChanged);

				expect(
					guard.checkEdit(
						filePath,
						[2, 20],
						[
							[2, 2],
							[20, 20],
						],
					),
				).toEqual({
					action: "allow",
				});
			} finally {
				env.cleanup();
			}
		});

		it("still blocks when only the bound read's own hashes match (no newer read)", () => {
			// Kills mutation ID 20 (`boundIndex + 1` -> `boundIndex - 1`), which
			// reaches back to the bound read itself. Its whitespace-stripped line
			// hash survives a whitespace-only reformat, so the stale binding would
			// clear its own anchor instead of asking for the re-read it remediates.
			const env = setupTestEnvironment("read-guard-supersede-self-");
			try {
				const filePath = path.join(env.tmpDir, "self.ts");
				fs.writeFileSync(filePath, before);
				const guard = createReadGuard("supersede-self-session");
				recordBridgeBinding(guard, filePath, 3);
				fs.writeFileSync(
					filePath,
					"const  a = 1;\nconst  b = 2;\nconst  c = 3;\n",
				);

				const verdict = guard.checkEdit(filePath, [1, 1]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("content no longer matches");
			} finally {
				env.cleanup();
			}
		});

		it("still blocks when only a provisional newer read covers the line", () => {
			// Kills mutation IDs 23 and 25 (the provisional skip). A host with no
			// correlation id records the read probe as a source-less provisional
			// (runtime-tool-call.ts) and the clipped delivery beside it without
			// `supersedes` (runtime-tool-result.ts); evidence the agent never saw
			// must not clear the anchor.
			const env = setupTestEnvironment("read-guard-supersede-provisional-");
			try {
				const filePath = path.join(env.tmpDir, "provisional.ts");
				fs.writeFileSync(filePath, before);
				const guard = createReadGuard("supersede-provisional-session");
				recordBridgeBinding(guard, filePath, 3);
				// External change the bridge never saw: the binding goes stale.
				fs.writeFileSync(filePath, after);
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
						provisional: true,
					}),
				);
				// The delivered record is clipped to line 1, so the provisional
				// beside it is the only record that covers the edited line 3.
				recordNativeRead(guard, filePath, 1, 1);

				const verdict = guard.checkEdit(filePath, [3, 3]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("content no longer matches");
			} finally {
				env.cleanup();
			}
		});

		it("still blocks when two partial newer reads cover the edit ranges separately", () => {
			// Kills mutation ID 26 (`.every` -> `.some`): one fresh partial read
			// per edited range does not make a single record that delivered both,
			// so the binding is not superseded by combining them.
			const env = setupTestEnvironment("read-guard-supersede-partials-");
			try {
				const filePath = path.join(env.tmpDir, "partials.ts");
				fs.writeFileSync(filePath, span20);
				const guard = createReadGuard("supersede-partials-session");
				recordBridgeBinding(guard, filePath, 1);
				// External change the bridge never saw: the binding goes stale.
				fs.writeFileSync(filePath, span20GapChanged);
				// One fresh partial read per edited range; neither covers both.
				recordNativeRead(guard, filePath, 2, 1);
				recordNativeRead(guard, filePath, 20, 1);

				const verdict = guard.checkEdit(
					filePath,
					[2, 20],
					[
						[2, 2],
						[20, 20],
					],
				);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("content no longer matches");
			} finally {
				env.cleanup();
			}
		});
	});

	describe("Phase 1: Zero-read and FileTime checks", () => {
		it("blocks edit on never-read file", () => {
			const guard = createReadGuard("test-session");

			const verdict = guard.checkEdit("/src/api.ts");

			expect(verdict.action).toBe("block");
			// Full-message pin, built through the same canonicalizer the guard
			// uses so the assertion holds on every platform (Windows resolves
			// /src/api.ts to a drive-qualified path -- AGENTS.md shape 2/7).
			const canonical = normalizeFilePath("/src/api.ts");
			expect(verdict.reason).toBe(
				`🔄 RETRYABLE — Edit without read: you have not read \`${canonical}\` in this conversation. Read it first, then retry: \`read path="${canonical}"\`.`,
			);
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

		it("retains an outstanding read past the former file cap (#1397)", () => {
			const guard = createReadGuard("test-session");
			guard.recordRead(createReadRecord("/src/read-first.ts"));

			// Fill beyond the old 256-file bound. None of these reads has been
			// consumed by a published edit, so eviction must not turn the first file
			// into a false zero-read block.
			for (let i = 0; i < 256; i++) {
				guard.recordRead(createReadRecord(`/src/activity-${i}.ts`));
			}

			expect(guard.checkEdit("/src/read-first.ts").action).toBe("allow");
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

		// #4131, #4187 F10: the retirement is its own decision. Recurrence:
		// round 1 logged it as `file_modified`, indistinguishable in
		// read-guard.log from a FileTime block on a file the agent had read.
		it("records an authorship another writer ended as authorship_retired, once", () => {
			const env = setupTestEnvironment("read-guard-authorship-retired-");
			resetDegradationLedger();
			try {
				const filePath = path.join(env.tmpDir, "authored.ts");
				fs.writeFileSync(filePath, "export const x = 1;\n");
				const guard = createReadGuard("test-session");
				guard.recordWritten(filePath, { toolCallId: "call_bash" });
				// Another writer: different bytes (and size, so no same-tick stat tie).
				fs.writeFileSync(filePath, "export const x = 22;\n");

				expect(guard.checkEdit(filePath, [1, 1]).action).toBe("block");
				expect(guard.checkEdit(filePath, [1, 1]).action).toBe("block");

				const calls = vi
					.mocked(logReadGuardEvent)
					.mock.calls.map(([entry]) => entry);
				expect(
					calls.filter((entry) => entry.event === "authorship_retired"),
				).toEqual([
					expect.objectContaining({
						filePath: normalizeFilePath(filePath),
						metadata: expect.objectContaining({
							hashed: true,
							toolCallId: "call_bash",
						}),
					}),
				]);
				expect(
					calls
						.filter((entry) => entry.event === "edit_blocked")
						.map((entry) => entry.metadata?.reasonKind),
				).toEqual(["authorship_retired", "authorship_retired"]);
				// The pilens_health ledger row, counted once per retirement.
				expect(
					getDegradationSummary().find(
						(group) => group.kind === "read-guard-authorship-retired",
					),
				).toMatchObject({
					count: 1,
					latestReasons: [
						expect.objectContaining({
							subject: normalizeFilePath(filePath),
						}),
					],
				});
			} finally {
				env.cleanup();
			}
		});

		// #4187 R2-4: a bridge write ends the authorship after the fact, so its
		// row names the writer. Recurrence: without it, read-guard.log cannot
		// tell a retirement a bridge write caused from one an edit check found.
		it("records an authorship a bridge write ended as authorship_retired with its writer, once", () => {
			const env = setupTestEnvironment("read-guard-authorship-bridge-");
			resetDegradationLedger();
			try {
				const filePath = path.join(env.tmpDir, "authored.ts");
				fs.writeFileSync(filePath, "export const x = 1;\n");
				const guard = createReadGuard("test-session");
				guard.recordWritten(filePath, { toolCallId: "call_bash" });
				fs.writeFileSync(filePath, "export const x = 22;\n");
				for (let call = 0; call < 2; call++)
					guard.recordWritten(filePath, {
						stampFileTime: false,
						advanceAuthorship: false,
					});

				expect(
					vi
						.mocked(logReadGuardEvent)
						.mock.calls.map(([entry]) => entry)
						.filter((entry) => entry.event === "authorship_retired"),
				).toEqual([
					expect.objectContaining({
						filePath: normalizeFilePath(filePath),
						metadata: expect.objectContaining({
							writer: "bridge",
							toolCallId: "call_bash",
						}),
					}),
				]);
				expect(
					getDegradationSummary().find(
						(group) => group.kind === "read-guard-authorship-retired",
					)?.count,
				).toBe(1);
				expect(guard.checkEdit(filePath, [1, 1]).action).toBe("block");
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

		it("blocks zero-read edit on a file another writer touched after the guard started (#3520)", () => {
			const env = setupTestEnvironment("read-guard-foreign-write-");
			try {
				const guard = createReadGuard("test-session");
				// An external editor, a second pi-lens or git wrote it: no recordWritten.
				const filePath = path.join(env.tmpDir, "foreign.ts");
				fs.writeFileSync(filePath, "export const x = 1;\n");
				const later = new Date(Date.now() + 60_000);
				fs.utimesSync(filePath, later, later);

				const verdict = guard.checkEdit(filePath, [1, 1]);

				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("Edit without read");
				expect(guard.getReadHistory(filePath)).toEqual([]);
				expect(logReadGuardEvent).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "edit_blocked",
						metadata: expect.objectContaining({ reasonKind: "zero_read" }),
					}),
				);
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

		it("softens file_modified when oldText uniquely resolves against live bytes", () => {
			const env = setupTestEnvironment("read-guard-oldtext-live-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "alpha\nunique target\nomega\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(createReadRecord(filePath, { effectiveLimit: 1 }));
				fileTimeState.hasChanged = true;

				const verdict = guard.checkEdit(filePath, [2, 2], undefined, {
					skipSnapshotCheck: true,
					oldTextResolved: true,
				});

				expect(verdict.action).toBe("allow");
				expect(logReadGuardEvent).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "edit_allowed",
						metadata: expect.objectContaining({
							reasonKind: "file_modified_oldtext_unique",
							oldTextResolved: true,
						}),
					}),
				);
			} finally {
				env.cleanup();
			}
		});

		it("keeps file_modified blocked when oldText does not resolve uniquely", () => {
			const env = setupTestEnvironment("read-guard-oldtext-unresolved-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "alpha\nduplicate\nduplicate\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(createReadRecord(filePath, { effectiveLimit: 1 }));
				fileTimeState.hasChanged = true;

				const verdict = guard.checkEdit(filePath, [2, 2], undefined, {
					skipSnapshotCheck: false,
					oldTextResolved: false,
				});

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

		it("allows an edit whose lines each match the newest read that delivered them, though an older read is stale on one", () => {
			// Old read [1-3] is stale on line 2 (the file changed); the agent then
			// re-read [1-2]. Editing [2-3]: line 2's newest view is the re-read
			// (matches), line 3's is the old read (matches). #3522 replaced the
			// "a newer read cancels the mismatch" rule with this per-line question.
			const env = setupTestEnvironment("read-guard-snapshot-rereed-per-line-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\n");
				const guard = createReadGuard("test-session");

				const t1 = Date.now() - 1000;
				const t2 = Date.now();

				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
						timestamp: t1,
					}),
				);

				fs.writeFileSync(filePath, "one\nTWO\nthree\n");
				fileTimeState.hasChanged = false;

				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 2,
						timestamp: t2,
					}),
				);

				const verdict = guard.checkEdit(filePath, [2, 3]);
				expect(verdict.action).toBe("allow");
			} finally {
				env.cleanup();
			}
		});

		it("blocks a line only a newer read context-covers, whatever that read's timestamp", () => {
			// #3522 ContextSuppress: the newer read [4-4] shows line 3 only through
			// its context zone, so it cannot cancel the old read's mismatch on 3.
			const env = setupTestEnvironment("read-guard-snapshot-ctx-only-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\nfour\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
						timestamp: Date.now() - 1000,
					}),
				);
				fs.writeFileSync(filePath, "one\ntwo\nTHREE\nfour\n");
				fileTimeState.hasChanged = false;
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 4,
						effectiveLimit: 1,
						timestamp: Date.now(),
					}),
				);
				vi.mocked(logReadGuardEvent).mockClear();

				expect(guard.checkEdit(filePath, [3, 3]).action).toBe("block");
				expect(lastValidationMetadata()).toMatchObject({
					status: "mismatch",
					mismatchedLines: [3],
					enforced: true,
					outcome: "enforced-block",
				});
			} finally {
				env.cleanup();
			}
		});

		it("does not carry missing lines from an older unhashed read into mismatch telemetry", () => {
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
				// The newest read that delivered line 2 is the hashed one, and it
				// no longer matches: the older unhashed read cannot speak for it.
				expect(guard.checkEdit(filePath, [2, 2]).action).toBe("block");

				const validationEntry = vi
					.mocked(logReadGuardEvent)
					.mock.calls.find(
						([entry]) => entry.event === "range_snapshot_validation",
					)?.[0];

				expect(validationEntry?.metadata).toMatchObject({
					status: "mismatch",
					viewRunCount: 1,
					checkedLineCount: 1,
					missingLineCount: 0,
					mismatchedLineCount: 1,
					missingLines: [],
					mismatchedLines: [2],
					enforced: true,
				});
			} finally {
				env.cleanup();
			}
		});

		it("does not let an older hashed read block a line whose newest view carries no hashes", () => {
			// Unchanged not-decidable rule: the newest view of the line cannot be
			// checked, and the older read it replaced no longer stands for it.
			const env = setupTestEnvironment("read-guard-snapshot-unhashed-newest-");
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
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
						lineHashes: {},
					}),
				);
				fs.writeFileSync(filePath, "one\nTWO\nthree\n");
				vi.mocked(logReadGuardEvent).mockClear();

				expect(guard.checkEdit(filePath, [2, 2]).action).toBe("allow");
				expect(lastValidationMetadata()).toMatchObject({
					status: "unavailable",
					missingLines: [2],
					enforced: false,
					outcome: "not-decidable",
				});
			} finally {
				env.cleanup();
			}
		});

		it("never takes a provisional record for the agent's view of a line", () => {
			// A provisional native read was requested, not delivered. Its hashes
			// come from the disk at tool_call, so counting it would vouch for bytes
			// the agent never saw.
			const env = setupTestEnvironment("read-guard-snapshot-provisional-");
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
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
						provisional: true,
					}),
				);

				expect(guard.checkEdit(filePath, [2, 2]).action).toBe("block");
			} finally {
				env.cleanup();
			}
		});

		it("checks each line only against its own newest read when an older read brackets a newer one", () => {
			// Old read A [1-6]; line 5 changes and the agent re-reads it alone (B).
			// Editing [4-6]: 4 and 6 come from A, 5 from B. A's stale hash for line
			// 5 must not be held against the edit (one run per read, not one span).
			const env = setupTestEnvironment("read-guard-snapshot-bracket-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "l1\nl2\nl3\nl4\nl5\nl6\n");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 6,
					}),
				);
				fs.writeFileSync(filePath, "l1\nl2\nl3\nl4\nL5\nl6\n");
				fileTimeState.hasChanged = false;
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 5,
						effectiveLimit: 1,
					}),
				);
				vi.mocked(logReadGuardEvent).mockClear();

				expect(guard.checkEdit(filePath, [4, 6]).action).toBe("allow");
				expect(lastValidationMetadata()).toMatchObject({
					status: "match",
					viewRunCount: 3,
					checkedLineCount: 3,
					enforced: true,
				});
			} finally {
				env.cleanup();
			}
		});

		it("blocks a stale hashed line even when the range also holds lines the read has no hash for", () => {
			// The read's effective range (1-10) outruns the 6-line file it hashed,
			// so lines 7-8 (appended later) have no hash. They are missing, not a
			// reason to stop checking line 5.
			const env = setupTestEnvironment("read-guard-snapshot-partial-hash-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "l1\nl2\nl3\nl4\nl5\nl6");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 10,
					}),
				);
				fs.writeFileSync(filePath, "l1\nl2\nl3\nl4\nL5\nl6\nl7\nl8");
				vi.mocked(logReadGuardEvent).mockClear();

				expect(guard.checkEdit(filePath, [5, 8]).action).toBe("block");
				expect(lastValidationMetadata()).toMatchObject({
					status: "mismatch",
					viewRunCount: 1,
					checkedLineCount: 2,
					mismatchedLines: [5],
					missingLines: [7, 8],
				});
			} finally {
				env.cleanup();
			}
		});

		it("does not judge a line whose newest view is unhashed by the older read on both sides of it", () => {
			// A [1-6] hashed; line 5 changes and the agent re-reads it unhashed (B).
			// Line 5 is missing, so [4-6] is two runs of A (4 and 6): merging them
			// would hold A's stale hash for line 5 against the edit.
			const env = setupTestEnvironment("read-guard-snapshot-gap-run-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "l1\nl2\nl3\nl4\nl5\nl6");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 6,
					}),
				);
				fs.writeFileSync(filePath, "l1\nl2\nl3\nl4\nL5\nl6");
				fileTimeState.hasChanged = false;
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 5,
						effectiveLimit: 1,
						lineHashes: {},
					}),
				);
				vi.mocked(logReadGuardEvent).mockClear();

				expect(guard.checkEdit(filePath, [4, 6]).action).toBe("allow");
				expect(lastValidationMetadata()).toMatchObject({
					status: "unavailable",
					viewRunCount: 2,
					checkedLineCount: 2,
					missingLines: [5],
					enforced: false,
				});
			} finally {
				env.cleanup();
			}
		});

		it("reports a line only a context zone covers as unavailable and blocks nothing", () => {
			// ContextSlack (admitted): line 3 was never delivered, so nothing can
			// check it, and it must not read as a match.
			const env = setupTestEnvironment("read-guard-snapshot-ctx-line-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "l1\nl2\nl3\nl4\nl5\nl6");
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 5,
						effectiveLimit: 2,
					}),
				);
				vi.mocked(logReadGuardEvent).mockClear();

				expect(guard.checkEdit(filePath, [3, 3]).action).toBe("allow");
				expect(lastValidationMetadata()).toMatchObject({
					status: "unavailable",
					missingLines: [3],
					enforced: false,
					outcome: "not-decidable",
				});
			} finally {
				env.cleanup();
			}
		});

		it("does not hash-check an edit the coverage gate refuses", () => {
			// The per-line check walks the range line by line, so it must only ever
			// run on a range some read covers, never on a caller-supplied
			// [1, 50_000].
			const env = setupTestEnvironment("read-guard-snapshot-after-coverage-");
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
				vi.mocked(logReadGuardEvent).mockClear();

				expect(guard.checkEdit(filePath, [1, 50_000]).action).toBe("block");
				expect(
					vi
						.mocked(logReadGuardEvent)
						.mock.calls.some(
							([entry]) => entry.event === "range_snapshot_validation",
						),
				).toBe(false);
			} finally {
				env.cleanup();
			}
		});

		// ── #1904 item 1: log the caller's outcome, not just the intent ───────

		function lastValidationMetadata(): Record<string, unknown> | undefined {
			const entry = vi
				.mocked(logReadGuardEvent)
				.mock.calls.filter(([e]) => e.event === "range_snapshot_validation")
				.at(-1)?.[0];
			return entry?.metadata as Record<string, unknown> | undefined;
		}

		it("reports bypassed-content-match when the caller skips the gate", () => {
			const env = setupTestEnvironment("read-guard-snapshot-bypass-");
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
				vi.mocked(logReadGuardEvent).mockClear();

				const verdict = guard.checkEdit(filePath, [2, 2], undefined, {
					skipSnapshotCheck: true,
				});

				expect(verdict.action).toBe("allow");
				expect(lastValidationMetadata()).toMatchObject({
					status: "mismatch",
					enforced: true,
					outcome: "bypassed-content-match",
				});
			} finally {
				env.cleanup();
			}
		});

		it("reports enforced-block when the caller honors the gate", () => {
			const env = setupTestEnvironment("read-guard-snapshot-block-");
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
				vi.mocked(logReadGuardEvent).mockClear();

				expect(guard.checkEdit(filePath, [2, 2]).action).toBe("block");
				expect(lastValidationMetadata()).toMatchObject({
					enforced: true,
					outcome: "enforced-block",
				});
			} finally {
				env.cleanup();
			}
		});

		it("reports enforced-pass when a hash-checked read still matches", () => {
			const env = setupTestEnvironment("read-guard-snapshot-pass-");
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
				vi.mocked(logReadGuardEvent).mockClear();

				expect(guard.checkEdit(filePath, [2, 2]).action).toBe("allow");
				expect(lastValidationMetadata()).toMatchObject({
					status: "match",
					enforced: true,
					outcome: "enforced-pass",
				});
			} finally {
				env.cleanup();
			}
		});

		it("reports not-decidable when no candidate carries hashes", () => {
			const env = setupTestEnvironment("read-guard-snapshot-undecidable-");
			try {
				const filePath = path.join(env.tmpDir, "api.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\n");
				const guard = createReadGuard("test-session");
				// An empty hash map means the read delivered no checkable snapshot.
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 3,
						lineHashes: {},
					}),
				);
				vi.mocked(logReadGuardEvent).mockClear();

				expect(guard.checkEdit(filePath, [2, 2]).action).toBe("allow");
				expect(lastValidationMetadata()).toMatchObject({
					status: "unavailable",
					enforced: false,
					outcome: "not-decidable",
				});
			} finally {
				env.cleanup();
			}
		});
	});

	// ── #1904 item 3: the per-file read store is bounded ─────────────────────

	describe("per-file read record cap", () => {
		/**
		 * #1907 review F1: the shape that overflows the cap is read-once-then-
		 * grep-often. Under pure age order the whole-file read is evicted first,
		 * and it is the only record whose hashes can rescue the edit after an
		 * unrelated mtime touch. Search credits must be spent before it.
		 */
		it("spends search credits before a genuine read when trimming", () => {
			const env = setupTestEnvironment("read-guard-cap-credit-first-");
			try {
				const filePath = path.join(env.tmpDir, "hot.ts");
				fs.writeFileSync(
					filePath,
					Array.from({ length: 400 }, (_, i) => `line${i + 1}`).join("\n"),
				);
				const guard = createReadGuard("test-session");
				// 1. One whole-file read — the oldest record on the file.
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 400,
						requestedOffset: 1,
						requestedLimit: 400,
					}),
				);
				// 2. 130 search credits, enough to overflow the 128 cap.
				for (let i = 1; i <= 130; i++) {
					guard.recordRead(
						createReadRecord(filePath, {
							requestedOffset: i,
							requestedLimit: 1,
							effectiveOffset: i,
							effectiveLimit: 1,
							searchCredit: {
								marginBefore: 0,
								marginAfter: 0,
								reason: "match-lines-only",
							},
						}),
					);
				}
				// 3. An unrelated touch makes the file look stale. The surviving
				// whole-file read's hashes still match, so the edit is rescued.
				// Under pure age order that read is gone and this edit BLOCKS.
				fileTimeState.hasChanged = true;
				expect(guard.checkEdit(filePath, [200, 200]).action).toBe("allow");

				// The mechanism: the whole-file read is the one surviving non-credit.
				const stored = guard.getReadHistory(filePath);
				expect(stored.length).toBeLessThanOrEqual(128);
				expect(stored.filter((r) => r.searchCredit === undefined)).toHaveLength(
					1,
				);
			} finally {
				fileTimeState.hasChanged = false;
				env.cleanup();
			}
		});

		it("bounds records per file and keeps the newest", () => {
			const env = setupTestEnvironment("read-guard-record-cap-");
			try {
				const filePath = path.join(env.tmpDir, "hot.ts");
				fs.writeFileSync(
					filePath,
					Array.from({ length: 400 }, (_, i) => `line${i + 1}`).join("\n"),
				);
				const guard = createReadGuard("test-session");
				for (let i = 1; i <= 400; i++) {
					guard.recordRead(
						createReadRecord(filePath, {
							requestedOffset: i,
							requestedLimit: 1,
							effectiveOffset: i,
							effectiveLimit: 1,
						}),
					);
				}
				const stored = guard.getReadHistory(filePath);
				expect(stored.length).toBeLessThanOrEqual(128);
				// Oldest-first eviction: the newest read survives, the oldest is gone.
				expect(stored.at(-1)?.effectiveOffset).toBe(400);
				expect(stored.some((r) => r.effectiveOffset === 1)).toBe(false);
				// #1907 review F5: growth stays observable past the cap.
				const trimEntry = vi
					.mocked(logReadGuardEvent)
					.mock.calls.filter(([e]) => e.event === "read_recorded")
					.at(-1)?.[0];
				expect(trimEntry?.metadata).toMatchObject({
					readCountForFile: 128,
					rawReadCountForFile: 129,
					evictedRecordCount: 1,
				});
			} finally {
				env.cleanup();
			}
		});

		// ── #1913: eviction telemetry must survive at default verbosity ──────

		it("emits exactly one bounded read_cap_trimmed record across many trims", () => {
			// #1913 review F1: the array is always AT the cap before each push
			// once it's past 128, so every push past the cap trims exactly 1
			// record — 300 reads on one hot file trims ~172 times. A naive
			// "log every trim" design (this test's pre-fix behavior) emits ~172
			// identical always-on lines; the fix must emit exactly ONE.
			const env = setupTestEnvironment("read-guard-cap-trim-event-");
			try {
				const filePath = path.join(env.tmpDir, "hot.ts");
				fs.writeFileSync(
					filePath,
					Array.from({ length: 400 }, (_, i) => `line${i + 1}`).join("\n"),
				);
				const guard = createReadGuard("test-session");
				for (let i = 1; i <= 300; i++) {
					guard.recordRead(
						createReadRecord(filePath, {
							requestedOffset: i,
							requestedLimit: 1,
							effectiveOffset: i,
							effectiveLimit: 1,
						}),
					);
				}
				const trimCalls = vi
					.mocked(logReadGuardEvent)
					.mock.calls.filter(([e]) => e.event === "read_cap_trimmed");
				expect(trimCalls).toHaveLength(1);
				// The ONE emitted line is the first trim's own snapshot — an
				// unbounded design can't be reconciled with a single log line
				// per session (each trim genuinely evicts only 1 record), so
				// the running total across all 172 trims lives in
				// `getTrimStats`, checked below, not in this line.
				expect(trimCalls[0][0]).toMatchObject({
					event: "read_cap_trimmed",
					filePath: normalizeFilePath(filePath),
					metadata: {
						trimEventCount: 1,
						evictedRecordCount: 1,
						evictedGenuineCount: 1,
						evictedCreditCount: 0,
					},
				});

				// The running totals across ALL 172 trims stay observable via
				// getTrimStats even though logging stopped after the first.
				const stats = guard.getTrimStats(filePath);
				expect(stats).toEqual({
					totalEvicted: 172,
					evictedCreditCount: 0,
					evictedGenuineCount: 172,
					trimEventCount: 172,
				});
			} finally {
				env.cleanup();
			}
		});

		it("splits evicted credit vs. genuine reads in the trim accumulator", () => {
			// #1913 review F3: `evictedCreditCount`/`evictedGenuineCount` must
			// actually discriminate — a no-op'd increment would leave this
			// green only if every trimmed record happened to be genuine (the
			// prior test's fixture). Mix search-credit and genuine reads so a
			// trim spends credits first, then genuine reads, and prove both
			// counters move.
			const env = setupTestEnvironment("read-guard-cap-trim-split-");
			try {
				const filePath = path.join(env.tmpDir, "hot.ts");
				fs.writeFileSync(
					filePath,
					Array.from({ length: 400 }, (_, i) => `line${i + 1}`).join("\n"),
				);
				const guard = createReadGuard("test-session");
				// 3 search-credit reads, then 130 genuine reads: 133 records vs.
				// a 128 cap. Eviction spends credits first (3), then 2 genuine
				// reads, across 5 trim events (each push past the cap trims 1).
				for (let i = 1; i <= 3; i++) {
					guard.recordRead(
						createReadRecord(filePath, {
							requestedOffset: i,
							requestedLimit: 1,
							effectiveOffset: i,
							effectiveLimit: 1,
							searchCredit: {
								marginBefore: 0,
								marginAfter: 0,
								reason: "match-lines-only",
							},
						}),
					);
				}
				for (let i = 4; i <= 133; i++) {
					guard.recordRead(
						createReadRecord(filePath, {
							requestedOffset: i,
							requestedLimit: 1,
							effectiveOffset: i,
							effectiveLimit: 1,
						}),
					);
				}
				const stats = guard.getTrimStats(filePath);
				expect(stats).toEqual({
					totalEvicted: 5,
					evictedCreditCount: 3,
					evictedGenuineCount: 2,
					trimEventCount: 5,
				});
			} finally {
				env.cleanup();
			}
		});

		it("emits no read_cap_trimmed record when the cap is never reached", () => {
			const env = setupTestEnvironment("read-guard-cap-no-trim-event-");
			try {
				const filePath = path.join(env.tmpDir, "warm.ts");
				fs.writeFileSync(
					filePath,
					Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n"),
				);
				const guard = createReadGuard("test-session");
				for (let i = 1; i <= 5; i++) {
					guard.recordRead(
						createReadRecord(filePath, {
							requestedOffset: i,
							requestedLimit: 1,
							effectiveOffset: i,
							effectiveLimit: 1,
						}),
					);
				}
				const trimCalls = vi
					.mocked(logReadGuardEvent)
					.mock.calls.filter(([e]) => e.event === "read_cap_trimmed");
				expect(trimCalls).toHaveLength(0);
			} finally {
				env.cleanup();
			}
		});

		it("keeps the newest read usable for coverage after the cap trims", () => {
			const env = setupTestEnvironment("read-guard-record-cap-cover-");
			try {
				const filePath = path.join(env.tmpDir, "hot.ts");
				fs.writeFileSync(
					filePath,
					Array.from({ length: 400 }, (_, i) => `line${i + 1}`).join("\n"),
				);
				const guard = createReadGuard("test-session");
				for (let i = 1; i <= 400; i++) {
					guard.recordRead(
						createReadRecord(filePath, {
							requestedOffset: i,
							requestedLimit: 1,
							effectiveOffset: i,
							effectiveLimit: 1,
						}),
					);
				}
				expect(guard.checkEdit(filePath, [400, 400]).action).toBe("allow");
			} finally {
				env.cleanup();
			}
		});

		it("bounds the per-file edit history too (class sweep)", () => {
			const env = setupTestEnvironment("read-guard-edit-cap-");
			try {
				const filePath = path.join(env.tmpDir, "hot.ts");
				fs.writeFileSync(
					filePath,
					Array.from({ length: 400 }, (_, i) => `line${i + 1}`).join("\n"),
				);
				const guard = createReadGuard("test-session");
				guard.recordRead(
					createReadRecord(filePath, {
						effectiveOffset: 1,
						effectiveLimit: 400,
					}),
				);
				for (let i = 1; i <= 400; i++) guard.checkEdit(filePath, [i, i]);
				expect(guard.getEditHistory(filePath).length).toBeLessThanOrEqual(256);
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
			// byFile is keyed by the canonical path (read-guard normalizes all keys),
			// so look up via the same normalization rather than the raw input string.
			expect(summary.byFile[normalizeFilePath("/src/api.ts")].edits).toBe(1);
			expect(summary.byFile[normalizeFilePath("/src/api.ts")].blocks).toBe(0);
			expect(summary.byFile[normalizeFilePath("/src/other.ts")].blocks).toBe(1);
		});
	});
});

describe("ReadGuard Tier-2 idle decay and bounds (#1389)", () => {
	it("evicts the oldest consumed read at the file cap and requires a re-read", () => {
		const guard = createReadGuard("tier2-consumed-cap");
		const consumedPath = "/tmp/consumed-tier2.ts";
		guard.recordRead(createReadRecord(consumedPath));
		expect(guard.checkEdit(consumedPath).action).toBe("allow");
		guard.recordWritten(consumedPath);

		for (let i = 0; i < 256; i += 1) {
			const filePath = `/tmp/consumed-tier2-${i}.ts`;
			guard.recordRead(createReadRecord(filePath));
			expect(guard.checkEdit(filePath).action).toBe("allow");
			guard.recordWritten(filePath);
		}

		expect(guard.getReadHistory(consumedPath)).toHaveLength(0);
		expect(guard.checkEdit(consumedPath).action).toBe("block");
		guard.recordRead(createReadRecord(consumedPath));
		expect(guard.checkEdit(consumedPath).action).toBe("allow");
	});

	it("bounds unconsumed reads with oldest-to-re-read eviction", () => {
		const guard = createReadGuard("tier2-unconsumed-cap");
		const oldestPath = "/tmp/unconsumed-tier2-oldest.ts";
		guard.recordRead(createReadRecord(oldestPath));

		for (let i = 0; i < 4096; i += 1) {
			guard.recordRead(createReadRecord(`/tmp/unconsumed-tier2-${i}.ts`));
		}

		expect(guard.getReadHistory(oldestPath)).toHaveLength(0);
		expect(guard.checkEdit(oldestPath).action).toBe("block");
		guard.recordRead(createReadRecord(oldestPath));
		expect(guard.checkEdit(oldestPath).action).toBe("allow");
	});

	it("does not idle-evict an outstanding read", () => {
		vi.useFakeTimers();
		try {
			const guard = createReadGuard("tier2-read-guard");
			const oldPath = "/tmp/old-tier2.ts";
			const recentPath = "/tmp/recent-tier2.ts";
			guard.recordRead(
				createReadRecord(oldPath, { timestamp: Date.now() - 31 * 60_000 }),
			);
			guard.recordRead(createReadRecord(recentPath));
			vi.advanceTimersByTime(35 * 60_000 + 1);
			expect(guard.getReadHistory(oldPath)).toHaveLength(1);
			expect(guard.checkEdit(recentPath).action).toBe("allow");
		} finally {
			vi.useRealTimers();
		}
	});

	// #4210 F-4210-1: successive own credits must compose their produced
	// ranges instead of dropping the first range and vouching for the file.
	it("unions disjoint and overlapping successive own-credit ranges (#4210)", () => {
		const env = setupTestEnvironment("read-guard-authorship-union-");
		try {
			const filePath = path.join(env.tmpDir, "union.ts");
			fs.writeFileSync(filePath, "one\ntwo\nthree\nfour\n");
			const guard = createReadGuard("authorship-union");

			fs.writeFileSync(filePath, "one\ntwo\nbridge\nfour\n");
			guard.recordWritten(filePath, {
				stampFileTime: false,
				authoredRanges: [[3, 3]],
				allowFirstAuthorship: true,
			});
			fs.writeFileSync(filePath, "own\ntwo\nbridge\nfour\n");
			guard.recordWritten(filePath, {
				stampFileTime: false,
				toolCallId: "call-own",
				authoredRanges: [[1, 1]],
			});
			expect(guard.checkEdit(filePath, [2, 2]).action).toBe("block");
			expect(guard.checkEdit(filePath, [3, 3]).action).toBe("allow");
			expect(guard.checkEdit(filePath, [1, 1]).action).toBe("allow");

			const overlapPath = path.join(env.tmpDir, "overlap.ts");
			fs.writeFileSync(overlapPath, "one\ntwo\nthree\nfour\n");
			const overlapGuard = createReadGuard("authorship-overlap");
			fs.writeFileSync(overlapPath, "one\nowned\nbridge\nfour\n");
			overlapGuard.recordWritten(overlapPath, {
				stampFileTime: false,
				authoredRanges: [[2, 3]],
				allowFirstAuthorship: true,
			});
			fs.writeFileSync(overlapPath, "own\nowned-again\nbridge\nfour\n");
			overlapGuard.recordWritten(overlapPath, {
				stampFileTime: false,
				toolCallId: "call-overlap",
				authoredRanges: [[3, 3]],
			});
			expect(overlapGuard.checkEdit(overlapPath, [2, 2]).action).toBe("allow");

			const wholePath = path.join(env.tmpDir, "whole.ts");
			fs.writeFileSync(wholePath, "one\ntwo\nthree\nfour\n");
			const wholeGuard = createReadGuard("authorship-whole");
			fs.writeFileSync(wholePath, "one\nbridge\nthree\nfour\n");
			wholeGuard.recordWritten(wholePath, {
				stampFileTime: false,
				authoredRanges: [[2, 2]],
				allowFirstAuthorship: true,
			});
			fs.writeFileSync(wholePath, "own\nbridge\nthree\nfour\n");
			wholeGuard.recordWritten(wholePath, {
				stampFileTime: false,
				toolCallId: "call-whole",
				authorship: "partial",
				authoredRanges: [[1, 1]],
			});
			expect(wholeGuard.checkEdit(wholePath, [4, 4]).action).toBe("block");
		} finally {
			env.cleanup();
		}
	});

	// #4210 F-4210-2: a partial credit is a license only for the lines its
	// writer produced. Recurrence: injectCreationRead widened the first
	// allowed inside edit into a whole-file license.
	it("keeps partial authorship narrow after an allowed inside edit (#4210)", () => {
		const env = setupTestEnvironment("read-guard-authorship-narrow-");
		try {
			const filePath = path.join(env.tmpDir, "narrow.ts");
			fs.writeFileSync(filePath, "one\ntwo\nthree\nfour\n");
			const guard = createReadGuard("authorship-narrow");
			guard.recordWritten(filePath, {
				stampFileTime: false,
				authoredRanges: [[2, 2]],
				allowFirstAuthorship: true,
			});

			expect(guard.checkEdit(filePath, [4, 4]).action).toBe("block");
			expect(guard.checkEdit(filePath, [2, 2]).action).toBe("allow");
			expect(guard.checkEdit(filePath, [4, 4]).action).toBe("block");

			const reverse = createReadGuard("authorship-narrow-reverse");
			reverse.recordWritten(filePath, {
				stampFileTime: false,
				authoredRanges: [[2, 2]],
				allowFirstAuthorship: true,
			});
			expect(reverse.checkEdit(filePath, [2, 2]).action).toBe("allow");
			expect(reverse.checkEdit(filePath, [4, 4]).action).toBe("block");
		} finally {
			env.cleanup();
		}
	});

	// #4210 N3 recurrence: an observed licensed partial replay must not narrow
	// an existing whole-file authorship to the replay's reported range.
	it("keeps whole-file authorship when a licensed partial credit follows it (#4210 N3)", () => {
		const env = setupTestEnvironment("read-guard-authorship-whole-union-");
		try {
			const filePath = path.join(env.tmpDir, "whole-union.ts");
			fs.writeFileSync(filePath, "one\ntwo\nthree\nfour\n");
			const guard = createReadGuard("authorship-whole-union");
			guard.recordWritten(filePath, {
				stampFileTime: false,
				authorship: "whole-file",
				allowFirstAuthorship: true,
			});
			fs.writeFileSync(filePath, "one\nobserved\nthree\nfour\n");
			guard.recordWritten(filePath, {
				stampFileTime: false,
				authorship: "partial",
				authoredRanges: [[2, 2]],
			});
			expect(guard.checkEdit(filePath, [4, 4]).action).toBe("allow");
		} finally {
			env.cleanup();
		}
	});

	it("records unknown authored-range retirement distinctly", () => {
		const env = setupTestEnvironment("read-guard-authorship-unknown-");
		resetDegradationLedger();
		try {
			const filePath = path.join(env.tmpDir, "unknown.ts");
			fs.writeFileSync(filePath, "one\ntwo\n");
			const guard = createReadGuard("authorship-unknown");
			guard.recordWritten(filePath, {
				stampFileTime: false,
				authoredRanges: [[1, 1]],
				allowFirstAuthorship: true,
			});
			guard.recordWritten(filePath, {
				stampFileTime: false,
				authorship: "unknown",
			});
			expect(guard.checkEdit(filePath, [1, 1]).action).toBe("block");
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "read-guard-authorship-retired",
				)?.latestReasons[0]?.reason,
			).toContain("authored range was unknown");
		} finally {
			env.cleanup();
		}
	});

	it("drops malformed persisted authored ranges without throwing", () => {
		const guard = createReadGuard("authorship-import-validation");
		expect(() =>
			guard.importAuthorship(
				{
					entries: [
						{
							filePath: "/tmp/malformed-authored-range.ts",
							size: 1,
							mtimeMs: 1,
							ctimeMs: 1,
							toolCallId: "call-import",
							authoredRanges: [null],
						},
					],
				},
				new Set(["call-import"]),
			),
		).not.toThrow();
	});

	// #4210 F-4210-1: when a later own write changes line positions, the
	// existing range cannot be remapped from AuthoredBytes, so retire that
	// shifted scope rather than silently licensing the wrong line.
	it("retires an authored range when a later own write shifts lines above it (#4210)", () => {
		const env = setupTestEnvironment("read-guard-authorship-shift-");
		try {
			const filePath = path.join(env.tmpDir, "shift.ts");
			fs.writeFileSync(filePath, "one\ntwo\nthree\nfour\n");
			const guard = createReadGuard("authorship-shift");

			fs.writeFileSync(filePath, "one\ntwo\nbridge\nfour\n");
			guard.recordWritten(filePath, {
				stampFileTime: false,
				authoredRanges: [[3, 3]],
				allowFirstAuthorship: true,
			});
			fs.writeFileSync(filePath, "inserted\none\ntwo\nbridge\nfour\n");
			guard.recordWritten(filePath, {
				stampFileTime: false,
				toolCallId: "call-shift",
				authoredRanges: [[1, 1]],
			});

			expect(guard.checkEdit(filePath, [3, 3]).action).toBe("block");
			expect(guard.checkEdit(filePath, [1, 1]).action).toBe("allow");
		} finally {
			env.cleanup();
		}
	});

	it("forgets the authorship of an idle-evicted file, so it needs a read again (#3520)", () => {
		const env = setupTestEnvironment("read-guard-idle-authorship-");
		vi.useFakeTimers();
		try {
			const filePath = path.join(env.tmpDir, "idle.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			// The kernel's coarse clock can stamp the file before the fake clock's
			// start; pin a newer mtime so the mtime fallback of the code before
			// #3520 fires on every run.
			const later = new Date(Date.now() + 60_000);
			fs.utimesSync(filePath, later, later);
			const guard = createReadGuard("tier2-idle-authorship");
			guard.recordRead(createReadRecord(filePath));
			guard.recordWritten(filePath); // consumes the read; arms the idle timer
			expect(guard.exportAuthorship().written).toHaveLength(1);

			vi.advanceTimersByTime(31 * 60_000);

			expect(guard.exportAuthorship().written).toEqual([]);
			expect(guard.checkEdit(filePath).action).toBe("block");
		} finally {
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("retains an old read until an edit consumes it", () => {
		vi.useFakeTimers();
		try {
			const guard = createReadGuard("tier2-read-recovery");
			const filePath = "/tmp/recover-tier2.ts";
			guard.recordRead(createReadRecord(filePath));
			vi.advanceTimersByTime(61 * 60_000 + 1);
			expect(guard.checkEdit(filePath).action).toBe("allow");
		} finally {
			vi.useRealTimers();
		}
	});
});

// #1918: the record-cap trim's population siblings. `evictFile` (whole-file
// eviction, three internal call sites plus `forgetPath`) and the per-file
// edits-cap splice evicted state with zero telemetry before this fix.
describe("ReadGuard eviction-path telemetry (#1918)", () => {
	function evictionEvents(event: string) {
		return vi
			.mocked(logReadGuardEvent)
			.mock.calls.filter(([entry]) => entry.event === event);
	}

	// #1918 review F2: idle-timeout is routine housekeeping, not a fault, so it
	// stays out of the ledger and logs nothing for a file that carried no
	// authorship. Recurrence: a record per idle eviction would flood the log in
	// every healthy session (an edit-history-only file idles out too).
	it("evicts an idle file that carried no write record without any read_file_evicted record", () => {
		vi.useFakeTimers();
		try {
			const guard = createReadGuard("1918-idle-evict-session");
			const filePath = "/tmp/1918-idle-evict.ts";
			// A blocked zero-read edit leaves an edit history and arms the idle timer.
			expect(guard.checkEdit(filePath, [1, 1]).action).toBe("block");
			expect(guard.getEditHistory(filePath)).toHaveLength(1);
			vi.mocked(logReadGuardEvent).mockClear();

			vi.advanceTimersByTime(31 * 60_000);

			expect(guard.getEditHistory(filePath)).toHaveLength(0);
			expect(evictionEvents("read_file_evicted")).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	// #3520: an idle-evicted write record is one read_file_evicted line per file
	// per session. Recurrence: the eviction was silent, so a later zero_read
	// block of an edited file had nothing in read-guard.log to explain it.
	it("records an idle-evicted write record once per file per session (#3520)", () => {
		vi.useFakeTimers();
		try {
			const guard = createReadGuard("3520-idle-record-session");
			const filePath = "/tmp/3520-idle-record.ts";
			const otherPath = "/tmp/3520-idle-record-other.ts";
			guard.recordRead(createReadRecord(filePath));
			guard.recordWritten(filePath);
			vi.mocked(logReadGuardEvent).mockClear();

			vi.advanceTimersByTime(31 * 60_000);

			const first = evictionEvents("read_file_evicted");
			expect(first).toHaveLength(1);
			expect(first[0][0]).toMatchObject({
				event: "read_file_evicted",
				filePath: normalizeFilePath(filePath),
				metadata: { reason: "idle-timeout", authorshipDropped: true },
			});

			// The same file written and evicted again: no second line.
			guard.recordRead(createReadRecord(filePath));
			guard.recordWritten(filePath);
			vi.advanceTimersByTime(31 * 60_000);
			expect(evictionEvents("read_file_evicted")).toHaveLength(1);

			// Another file gets its own line.
			guard.recordRead(createReadRecord(otherPath));
			guard.recordWritten(otherPath);
			vi.advanceTimersByTime(31 * 60_000);
			expect(
				evictionEvents("read_file_evicted").map(([entry]) => entry.filePath),
			).toEqual([normalizeFilePath(filePath), normalizeFilePath(otherPath)]);
		} finally {
			vi.useRealTimers();
		}
	});

	// #3520: the zero_read text claims "you have not read X in this
	// conversation". For a file the agent wrote, that is false. Recurrence: the
	// agent argued with the guard about a file it had just edited.
	it("tells an edit of a file whose write record idle-expired that the record expired (#3520)", () => {
		vi.useFakeTimers();
		try {
			const guard = createReadGuard("3520-idle-text-session");
			const filePath = "/tmp/3520-idle-text.ts";
			const neverPath = "/tmp/3520-never-written.ts";
			guard.recordRead(createReadRecord(filePath));
			guard.recordWritten(filePath);
			vi.advanceTimersByTime(31 * 60_000);
			vi.mocked(logReadGuardEvent).mockClear();

			const expired = guard.checkEdit(filePath, [1, 1]);
			const never = guard.checkEdit(neverPath, [1, 1]);

			const canonical = normalizeFilePath(filePath);
			expect(expired.action).toBe("block");
			expect(expired.reason).toBe(
				`🔄 RETRYABLE — Edit without read: the earlier write record for \`${canonical}\` expired, so it needs a read again. Read it first, then retry: \`read path="${canonical}"\`.`,
			);
			expect(expired.reason).not.toContain("have not read");
			// A file that was never written keeps the zero_read text.
			expect(never.reason).toContain("you have not read");
			const blocked = vi
				.mocked(logReadGuardEvent)
				.mock.calls.filter(([entry]) => entry.event === "edit_blocked");
			expect(blocked.map(([entry]) => entry.metadata)).toEqual([
				expect.objectContaining({
					reasonKind: "zero_read",
					writeRecordExpired: true,
				}),
				expect.not.objectContaining({ writeRecordExpired: true }),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	// #3520: the marker set is bounded like the file store. Recurrence guarded:
	// a long session that edits many files grows the set without bound.
	it("keeps the expired write records of at most 256 files (#3520)", () => {
		vi.useFakeTimers();
		try {
			const guard = createReadGuard("3520-idle-cap-session");
			const paths = Array.from(
				{ length: 257 },
				(_, i) => `/tmp/3520-idle-cap-${i}.ts`,
			);
			for (const filePath of paths) guard.recordWritten(filePath);

			vi.advanceTimersByTime(31 * 60_000);

			expect(guard.checkEdit(paths[0], [1, 1]).reason).toContain(
				"you have not read",
			);
			expect(guard.checkEdit(paths[256], [1, 1]).reason).toContain(
				"write record",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("emits read_file_evicted with reason file-cap-consumed at the consumed-file cap", () => {
		const guard = createReadGuard("1918-file-cap-consumed-session");
		const victimPath = "/tmp/1918-file-cap-consumed-victim.ts";
		guard.recordRead(createReadRecord(victimPath));
		guard.recordWritten(victimPath);
		vi.mocked(logReadGuardEvent).mockClear();

		for (let i = 0; i < 256; i += 1) {
			const filePath = `/tmp/1918-file-cap-consumed-${i}.ts`;
			guard.recordRead(createReadRecord(filePath));
			guard.recordWritten(filePath);
		}

		const evictions = evictionEvents("read_file_evicted");
		expect(evictions).toHaveLength(1);
		expect(evictions[0][0]).toMatchObject({
			event: "read_file_evicted",
			filePath: normalizeFilePath(victimPath),
			metadata: { reason: "file-cap-consumed" },
		});
		expect(guard.getReadHistory(victimPath)).toHaveLength(0);
	});

	it("emits read_file_evicted with reason file-cap-unconsumed at the unconsumed-file cap", () => {
		const guard = createReadGuard("1918-file-cap-unconsumed-session");
		const victimPath = "/tmp/1918-file-cap-unconsumed-victim.ts";
		guard.recordRead(createReadRecord(victimPath));
		vi.mocked(logReadGuardEvent).mockClear();

		for (let i = 0; i < 4096; i += 1) {
			guard.recordRead(
				createReadRecord(`/tmp/1918-file-cap-unconsumed-${i}.ts`),
			);
		}

		const evictions = evictionEvents("read_file_evicted");
		expect(evictions).toHaveLength(1);
		expect(evictions[0][0]).toMatchObject({
			event: "read_file_evicted",
			filePath: normalizeFilePath(victimPath),
			metadata: { reason: "file-cap-unconsumed" },
		});
		expect(guard.getReadHistory(victimPath)).toHaveLength(0);
	});

	it("emits read_file_evicted with reason external-delete via forgetPath", () => {
		const guard = createReadGuard("1918-forget-path-session");
		const filePath = "/tmp/1918-forget-path.ts";
		guard.recordRead(createReadRecord(filePath));
		vi.mocked(logReadGuardEvent).mockClear();

		guard.forgetPath(filePath);

		const evictions = evictionEvents("read_file_evicted");
		expect(evictions).toHaveLength(1);
		expect(evictions[0][0]).toMatchObject({
			event: "read_file_evicted",
			filePath: normalizeFilePath(filePath),
			metadata: { reason: "external-delete" },
		});
	});

	it("emits exactly one edits_cap_trimmed record when the per-file edit history overflows", () => {
		const guard = createReadGuard("1918-edits-cap-session");
		const filePath = "/tmp/1918-edits-cap.ts";
		guard.recordRead(
			createReadRecord(filePath, { requestedLimit: 500, effectiveLimit: 500 }),
		);
		vi.mocked(logReadGuardEvent).mockClear();

		for (let i = 0; i < 257; i += 1) {
			guard.checkEdit(filePath, [1, 1]);
		}

		const trims = evictionEvents("edits_cap_trimmed");
		expect(trims).toHaveLength(1);
		expect(trims[0][0]).toMatchObject({
			event: "edits_cap_trimmed",
			filePath: normalizeFilePath(filePath),
			metadata: { trimmedCount: 1, cappedLength: 256 },
		});
		expect(guard.getEditHistory(filePath)).toHaveLength(256);
	});

	it("emits no edits_cap_trimmed record while the edit history stays within the cap", () => {
		const guard = createReadGuard("1918-edits-cap-no-trim-session");
		const filePath = "/tmp/1918-edits-cap-no-trim.ts";
		guard.recordRead(createReadRecord(filePath));
		vi.mocked(logReadGuardEvent).mockClear();

		for (let i = 0; i < 10; i += 1) {
			guard.checkEdit(filePath, [1, 1]);
		}

		expect(evictionEvents("edits_cap_trimmed")).toHaveLength(0);
	});

	// #1918 review F3: pin the (kind, subject) key the rising edge is keyed
	// on — two DISTINCT files evicted via forgetPath must each get their own
	// line, not share one rising edge because they hit the same `kind`.
	it("emits one read_file_evicted line per distinct file, not one per session", () => {
		const guard = createReadGuard("1918-distinct-files-session");
		const firstPath = "/tmp/1918-distinct-first.ts";
		const secondPath = "/tmp/1918-distinct-second.ts";
		guard.recordRead(createReadRecord(firstPath));
		guard.recordRead(createReadRecord(secondPath));
		vi.mocked(logReadGuardEvent).mockClear();

		guard.forgetPath(firstPath);
		guard.forgetPath(secondPath);

		const evictions = evictionEvents("read_file_evicted");
		expect(evictions).toHaveLength(2);
		expect(evictions.map(([entry]) => entry.filePath).sort()).toEqual(
			[normalizeFilePath(firstPath), normalizeFilePath(secondPath)].sort(),
		);
	});

	// #4187 R3-3: authorship-cap pressure is counted for every eviction, but
	// read-guard.log gets only the rising-edge witness. Recurrence: one log row
	// per over-cap file flooded the sink during a steady-state credit stream.
	// #4187 R4-3 (T9b): one eviction proves nothing about the gate — a single
	// row is also what an ungated `if (true)` emits — so this credits 104 files
	// past the cap and pins 104 counted against ONE row.
	it("counts authorship-cap evictions and logs only its rising edge", () => {
		resetDegradationLedger();
		const guard = createReadGuard("4187-authorship-cap-observability");
		const overCap = 104;
		for (let i = 0; i < 4096 + overCap; i += 1) {
			const filePath = `/tmp/4187-authorship-cap-${i}.ts`;
			guard.recordWritten(filePath);
		}
		const evictions = evictionEvents("read_file_evicted").filter(
			([entry]) => entry.metadata?.reason === "authorship-cap",
		);
		expect(evictions).toHaveLength(1);
		expect(evictions[0][0]).toMatchObject({
			metadata: { reason: "authorship-cap", authorshipDropped: true },
		});
		expect(
			getDegradationSummary().find(
				(group) => group.kind === "read-guard-authorship-cap",
			)?.count,
		).toBe(overCap);
	});

	// #1918 review F3: pin session re-arm — the SAME file evicted twice within
	// one session logs once (rising edge), but a fresh session (which is what
	// resetDegradationLedger models: the ledger's own generation bump, wired
	// into session start) re-arms the edge so the next eviction of that same
	// path logs again.
	it("re-emits for the same file after resetDegradationLedger (fresh session)", () => {
		const guard = createReadGuard("1918-rearm-session");
		const filePath = "/tmp/1918-rearm.ts";
		guard.recordRead(createReadRecord(filePath));
		vi.mocked(logReadGuardEvent).mockClear();

		guard.forgetPath(filePath);
		expect(evictionEvents("read_file_evicted")).toHaveLength(1);

		// Second eviction of the SAME path in the SAME session: rising edge
		// already tripped, so no second line.
		guard.recordRead(createReadRecord(filePath));
		guard.forgetPath(filePath);
		expect(evictionEvents("read_file_evicted")).toHaveLength(1);

		resetDegradationLedger();
		guard.recordRead(createReadRecord(filePath));
		guard.forgetPath(filePath);
		expect(evictionEvents("read_file_evicted")).toHaveLength(2);
	});
});

describe("ReadGuard.hasKnownPath / forgetPath (#1668)", () => {
	it("returns false for a path pi-lens never read or wrote", () => {
		const guard = createReadGuard("test-session");
		expect(guard.hasKnownPath("/src/never-touched.ts")).toBe(false);
	});

	it("returns true after a recordRead", () => {
		const guard = createReadGuard("test-session");
		guard.recordRead(createReadRecord("/src/api.ts"));
		expect(guard.hasKnownPath("/src/api.ts")).toBe(true);
	});

	it("returns true after a recordWritten", () => {
		const guard = createReadGuard("test-session");
		guard.recordWritten("/src/api.ts");
		expect(guard.hasKnownPath("/src/api.ts")).toBe(true);
	});

	it("forgetPath drops the record so hasKnownPath goes back to false", () => {
		const guard = createReadGuard("test-session");
		guard.recordWritten("/src/api.ts");
		expect(guard.hasKnownPath("/src/api.ts")).toBe(true);

		guard.forgetPath("/src/api.ts");
		expect(guard.hasKnownPath("/src/api.ts")).toBe(false);
	});

	it("forgetPath on an unknown path is a no-op, not a throw", () => {
		const guard = createReadGuard("test-session");
		expect(() => guard.forgetPath("/src/never-touched.ts")).not.toThrow();
	});

	/**
	 * #1668 review F1 (BLOCKING, Windows-only — CI can't see it): a REAL file
	 * with a mixed-case basename, actually deleted from disk, checked through
	 * the REAL guard (no stubbed hasKnownPath, no never-existing path — both
	 * of those hid the defect). `this.key()` (normalizeFilePath) branches on
	 * whether the path currently exists: real casing via `realpathSync.native`
	 * while it's on disk, a lowercased tail once it's gone. `recordWritten`/
	 * `recordRead` key while the file is still there; `hasKnownPath`/
	 * `forgetPath` run in production AFTER the delete already landed. Before
	 * the fix, `MyModule.ts` and any other mixed-case basename silently
	 * dropped its record the moment the file went away — exactly the
	 * `mymodule.ts` (works) vs `MyModule.ts` (fails) split the review probed.
	 */
	it("a real mixed-case file, actually deleted, is still a known path afterward", () => {
		const env = setupTestEnvironment("read-guard-mixed-case-delete-");
		try {
			const filePath = path.join(env.tmpDir, "MyModule.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const guard = createReadGuard("test-session");
			guard.recordWritten(filePath);
			expect(guard.hasKnownPath(filePath)).toBe(true);

			// The delete this whole feature exists to detect — happens for real,
			// not simulated by skipping the write.
			fs.rmSync(filePath);

			expect(guard.hasKnownPath(filePath)).toBe(true);
			guard.forgetPath(filePath);
			expect(guard.hasKnownPath(filePath)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("a real mixed-case file recorded via recordRead survives the same post-delete lookup", () => {
		const env = setupTestEnvironment("read-guard-mixed-case-read-delete-");
		try {
			const filePath = path.join(env.tmpDir, "Button.tsx");
			fs.writeFileSync(filePath, "export const Button = () => null;\n");

			const guard = createReadGuard("test-session");
			guard.recordRead(createReadRecord(filePath));
			expect(guard.hasKnownPath(filePath)).toBe(true);

			fs.rmSync(filePath);

			expect(guard.hasKnownPath(filePath)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("a lowercase basename (the case the pre-fix code accidentally got right) still works", () => {
		const env = setupTestEnvironment("read-guard-lowercase-delete-");
		try {
			const filePath = path.join(env.tmpDir, "mymodule.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const guard = createReadGuard("test-session");
			guard.recordWritten(filePath);
			fs.rmSync(filePath);

			expect(guard.hasKnownPath(filePath)).toBe(true);
		} finally {
			env.cleanup();
		}
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

/**
 * #3521: the read guard's branch rule, unit by unit, with the REAL FileTime
 * (no mock: clearing the stamps is part of the rule) and pi's real
 * `SessionManager` for the branch.
 *
 * The recurrence these prevent: after `/tree`, `/fork` or a resume, a record
 * or a stamp from a branch the conversation no longer shows vouches for an
 * edit (a blind or stale allow), or a record the conversation still shows is
 * dropped (a false block). `tests/index-3521-fork-tree-witness.test.ts`
 * drives the same rule through pi's real runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createReadGuard,
	lineContentHash,
	type PersistedReadGuardState,
	READ_GUARD_STATE_VERSION,
	type ReadGuard,
	type ReadRecord,
} from "../../clients/read-guard.js";
import {
	branchToolResultIds,
	readSessionHeaderId,
} from "../../clients/read-guard-branch.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { sanitizeCorrelationId } from "../../clients/read-guard-logger.js";
import { setupTestEnvironment } from "./test-utils.js";

const LONG_AGO = new Date("2000-01-01T00:00:00Z");

let env: ReturnType<typeof setupTestEnvironment>;
beforeEach(() => {
	env = setupTestEnvironment("read-guard-branch-");
});
afterEach(() => {
	vi.useRealTimers();
	env.cleanup();
});

/** A file authored before any guard in this test existed. */
function oldFile(name: string, lines: number): string {
	const filePath = path.join(env.tmpDir, name);
	fs.writeFileSync(
		filePath,
		Array.from({ length: lines }, (_, i) => `line${i + 1}`).join("\n"),
	);
	fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
	return filePath;
}

/** Rewrite one line on disk with a later mtime (another branch's write). */
function rewriteLine(filePath: string, line: number, text: string): void {
	const lines = fs.readFileSync(filePath, "utf8").split("\n");
	lines[line - 1] = text;
	fs.writeFileSync(filePath, lines.join("\n"));
	const later = new Date(LONG_AGO.getTime() + 60_000);
	fs.utimesSync(filePath, later, later);
}

function fullRead(
	filePath: string,
	lines: number,
	toolCallId?: string,
	extra: Partial<ReadRecord> = {},
): ReadRecord {
	return {
		filePath,
		requestedOffset: 1,
		requestedLimit: lines,
		effectiveOffset: 1,
		effectiveLimit: lines,
		expandedByLsp: false,
		turnIndex: 1,
		writeIndex: 0,
		timestamp: Date.now(),
		...(toolCallId !== undefined && { toolCallId }),
		...extra,
	};
}

function verdict(guard: ReadGuard, filePath: string, line: number): string {
	const result = guard.checkEdit(filePath, [line, line]);
	return result.action === "block"
		? `block: ${String(result.reason).split("\n")[0]}`
		: result.action;
}

describe("ReadGuard.retainBranch (#3521)", () => {
	it("keeps the records whose tool result is on the branch and deletes the rest", () => {
		const a = oldFile("a.ts", 6);
		const b = oldFile("b.ts", 6);
		const guard = createReadGuard("retain-keep");
		guard.recordRead(fullRead(a, 6, "call_a"));
		guard.recordRead(fullRead(b, 6, "call_b"));

		expect(guard.retainBranch(new Set(["call_a"]))).toEqual({
			kept: 1,
			dropped: 1,
		});

		expect(verdict(guard, a, 2)).toBe("allow");
		expect(verdict(guard, b, 2)).toMatch(/^block: .*Edit without read/);
	});

	// #3520: the idle-expiry marker describes the branch that wrote the file.
	// Recurrence: a /tree cleared the write record, and the old marker then
	// blamed an expiry that never happened on this branch.
	it("forgets an idle-expired write record, so the block names no expiry (#3520)", () => {
		vi.useFakeTimers();
		const a = oldFile("a.ts", 6);
		const guard = createReadGuard("retain-expired-write");
		guard.recordWritten(a);
		vi.advanceTimersByTime(31 * 60_000);
		expect(verdict(guard, a, 2)).toMatch(/^block: .*write record/);

		guard.retainBranch(new Set());

		expect(verdict(guard, a, 2)).toMatch(/^block: .*you have not read/);
	});

	it("deletes a record with no tool-call id (a bridge read)", () => {
		const a = oldFile("a.ts", 6);
		const guard = createReadGuard("retain-no-id");
		guard.recordRead(fullRead(a, 6, undefined, { source: "bridge:other" }));

		expect(guard.retainBranch(new Set(["call_a"]))).toEqual({
			kept: 0,
			dropped: 1,
		});
		expect(verdict(guard, a, 2)).toMatch(/^block: .*Edit without read/);
	});

	it("judges a kept record line by line: the rewritten line blocks, an untouched one passes (A3, A11)", () => {
		const a = oldFile("a.ts", 6);
		const guard = createReadGuard("retain-stale");
		guard.recordRead(fullRead(a, 6, "call_read"));
		// The abandoned branch's own edit of line 2: the #3523 own-edit record,
		// the write, and recordWritten's fresh FileTime stamp.
		guard.recordRead(
			fullRead(a, 1, "call_edit", {
				requestedOffset: 2,
				effectiveOffset: 2,
				source: "own-edit",
				lineHashes: { 2: lineContentHash("EDITED-ON-ABANDONED-BRANCH") },
			}),
		);
		rewriteLine(a, 2, "EDITED-ON-ABANDONED-BRANCH");
		guard.recordWritten(a);
		expect(verdict(guard, a, 2)).toBe("allow");

		guard.retainBranch(new Set(["call_read"]));

		expect(verdict(guard, a, 2)).toMatch(/^block: /);
		expect(verdict(guard, a, 4)).toBe("allow");
	});

	it("clears the FileTime stamp, so an unhashed record is refused until re-read (A10)", () => {
		// Past READ_HASH_MAX_LINES (3000): recordRead captures no hashes.
		const big = oldFile("big.ts", 3100);
		const guard = createReadGuard("retain-unhashed");
		guard.recordRead(fullRead(big, 3100, "call_big"));
		expect(verdict(guard, big, 2)).toBe("allow");

		guard.retainBranch(new Set(["call_big"]));

		expect(verdict(guard, big, 2)).toMatch(
			/^block: .*File modified since read/,
		);
	});

	it("clears writtenThisSession: a file written only on the abandoned branch needs a read", () => {
		const c = path.join(env.tmpDir, "c.ts");
		const guard = createReadGuard("retain-written");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		guard.recordWritten(c);
		expect(verdict(guard, c, 2)).toBe("allow");

		guard.retainBranch(new Set());

		expect(verdict(guard, c, 2)).toMatch(/^block: .*Edit without read/);
	});

	it("keeps a creation read whose write is on the branch", () => {
		const c = oldFile("c.ts", 3);
		const guard = createReadGuard("retain-creation");
		guard.noteCreatedFile(c, 1, 0, "call_write");
		guard.recordWritten(c);

		guard.retainBranch(new Set(["call_write"]));

		expect(verdict(guard, c, 2)).toBe("allow");
	});

	it("forgets a pending creation, so a later write of the path injects no creation read", () => {
		const c = oldFile("c.ts", 3);
		const guard = createReadGuard("retain-pending");
		guard.noteCreatedFile(c, 1, 0, "call_write");

		guard.retainBranch(new Set(["call_write"]));
		guard.recordWritten(c);

		expect(guard.getReadHistory(c)).toEqual([]);
	});
});

/**
 * #3612 (D5): the authorship a `/reload` carries. The recurrences: a file the
 * session wrote and never read needs a re-read after a reload although the
 * conversation still shows the write; and a malformed sidecar payload (the
 * reload's fallback source) throwing inside the reload's session start.
 */
describe("ReadGuard authorship export/import (#3612)", () => {
	it("hands the written files to another guard, as JSON", () => {
		const c = path.join(env.tmpDir, "c.ts");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		const before = createReadGuard("authorship-before");
		before.recordWritten(c);
		const after = createReadGuard("authorship-after");
		expect(verdict(after, c, 2)).toMatch(/^block: .*Edit without read/);

		after.importAuthorship(
			JSON.parse(JSON.stringify(before.exportAuthorship())),
		);

		expect(verdict(after, c, 2)).toBe("allow");
	});

	it("skips a malformed payload instead of throwing", () => {
		const c = oldFile("c.ts", 3);
		const guard = createReadGuard("authorship-malformed");
		for (const payload of [
			undefined,
			null,
			{},
			{ written: [42, null] },
			{ written: "c.ts" },
		])
			expect(() => guard.importAuthorship(payload)).not.toThrow();
		expect(guard.exportAuthorship().written).toEqual([]);
		expect(verdict(guard, c, 2)).toMatch(/^block: .*Edit without read/);
	});

	// A released writer (#3612) also exported `sessionStartMs`; its row still
	// restores the written files, and the retired anchor decides nothing.
	it("imports a released writer's row and ignores its retired sessionStartMs (#3520)", () => {
		const c = oldFile("c.ts", 3);
		const guard = createReadGuard("authorship-released");

		guard.importAuthorship({
			written: [normalizeFilePath(c)],
			sessionStartMs: 0,
		});

		expect(verdict(guard, c, 2)).toBe("allow");
		expect(guard.exportAuthorship()).toEqual({
			written: [normalizeFilePath(c)],
		});
	});
});

describe("ReadGuard.importBranch (#3521, replaces #1041's importState)", () => {
	function exported(records: ReadRecord[]): PersistedReadGuardState {
		const source = createReadGuard("export-source");
		for (const record of records) source.recordRead(record);
		return source.exportState();
	}

	it("imports a persisted read whose tool result is on the branch, and only that one", () => {
		const a = oldFile("a.ts", 6);
		const b = oldFile("b.ts", 6);
		const state = exported([
			fullRead(a, 6, "call_a"),
			fullRead(b, 6, "call_b"),
		]);
		expect(state.version).toBe(READ_GUARD_STATE_VERSION);

		const guard = createReadGuard("import-keep");
		expect(guard.importBranch(state, new Set(["call_a"]))).toEqual({
			imported: 1,
			dropped: 1,
		});

		expect(verdict(guard, a, 2)).toBe("allow");
		expect(verdict(guard, b, 2)).toMatch(/^block: .*Edit without read/);
	});

	it("drops a pre-#3833 record that holds the sliced form of a long id, and keeps one under the new form (#3833)", () => {
		// Sidecars written before #3833 stored `slice(0, 64)` of a long call id.
		// They still parse; they no longer name a tool result on the branch, so
		// the read is dropped (fail closed: a re-read, never a blind allow).
		const longId = `call_${"x".repeat(40)}|fc_${"y".repeat(45)}`;
		const a = oldFile("a.ts", 6);
		const b = oldFile("b.ts", 6);
		const legacyId = longId.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 64);
		const currentId = sanitizeCorrelationId(longId) as string;
		expect(legacyId).not.toBe(currentId);
		const state = exported([
			fullRead(a, 6, legacyId),
			fullRead(b, 6, currentId),
		]);
		const onBranch = new Set([currentId]);

		const guard = createReadGuard("import-legacy-long-id");
		expect(guard.importBranch(state, onBranch)).toEqual({
			imported: 1,
			dropped: 1,
		});
		expect(verdict(guard, a, 2)).toMatch(/^block: .*Edit without read/);
		expect(verdict(guard, b, 2)).toBe("allow");
	});

	it("keeps a changed record whole: the changed line blocks, an untouched line passes", () => {
		// #1041's importState dropped the whole record when any line changed,
		// which blocked edits of lines the agent still sees exactly (T5/F1).
		const a = oldFile("a.ts", 6);
		const state = exported([fullRead(a, 6, "call_a")]);
		rewriteLine(a, 2, "CHANGED");

		const guard = createReadGuard("import-whole");
		expect(guard.importBranch(state, new Set(["call_a"])).imported).toBe(1);

		expect(verdict(guard, a, 2)).toMatch(/^block: /);
		expect(verdict(guard, a, 4)).toBe("allow");
	});

	it("never re-hashes a record without hashes from today's disk", () => {
		const a = oldFile("a.ts", 6);
		const state: PersistedReadGuardState = {
			version: READ_GUARD_STATE_VERSION,
			reads: [
				[
					normalizeFilePath(a),
					[fullRead(a, 6, "call_a", { lineHashes: undefined })],
				],
			],
		};
		// Another branch rewrote line 2 after the read.
		rewriteLine(a, 2, "CHANGED");

		const guard = createReadGuard("import-unhashed");
		guard.importBranch(state, new Set(["call_a"]));

		expect(verdict(guard, a, 2)).toMatch(/^block: .*File modified since read/);
	});

	it("drops a read for a file that no longer exists", () => {
		const a = oldFile("gone.ts", 6);
		const state = exported([fullRead(a, 6, "call_a")]);
		fs.rmSync(a);

		const guard = createReadGuard("import-missing");
		expect(guard.importBranch(state, new Set(["call_a"]))).toEqual({
			imported: 0,
			dropped: 1,
		});
	});

	it("loads undefined, a version-1 or an unknown version as no reads", () => {
		const guard = createReadGuard("import-compat");
		const any = new Set(["call_a"]);
		expect(guard.importBranch(undefined, any)).toEqual({
			imported: 0,
			dropped: 0,
		});
		expect(guard.importBranch({ version: 1, reads: [] }, any)).toEqual({
			imported: 0,
			dropped: 0,
		});
		expect(guard.importBranch({ version: 999, reads: [] }, any)).toEqual({
			imported: 0,
			dropped: 0,
		});
	});

	it("degrades to no reads on a malformed payload instead of throwing", () => {
		const guard = createReadGuard("import-malformed");
		const any = new Set(["call_a"]);
		const nonArray = {
			version: READ_GUARD_STATE_VERSION,
			reads: {},
		} as unknown as PersistedReadGuardState;
		expect(guard.importBranch(nonArray, any)).toEqual({
			imported: 0,
			dropped: 0,
		});
		const badElement = {
			version: READ_GUARD_STATE_VERSION,
			reads: [[normalizeFilePath("/src/x.ts"), []], 5],
		} as unknown as PersistedReadGuardState;
		expect(guard.importBranch(badElement, any)).toEqual({
			imported: 0,
			dropped: 0,
		});
		expect(guard.getReadHistory("/src/x.ts")).toHaveLength(0);
	});
});

describe("branchToolResultIds (#3521)", () => {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	function call(sm: SessionManager, id: string): string {
		return sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: {} }],
			api: "x",
			provider: "x",
			model: "x",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as never);
	}
	function result(sm: SessionManager, id: string): string {
		return sm.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [],
			isError: false,
			timestamp: Date.now(),
		} as never);
	}

	it("collects the tool results on the current branch, in record form", () => {
		const sm = SessionManager.inMemory(env.tmpDir);
		sm.appendMessage({ role: "user", content: "p1", timestamp: 1 } as never);
		call(sm, "call_a");
		const afterA = result(sm, "call_a");
		// An OpenAI Responses id carries `|`; records hold the sanitized form.
		call(sm, "call_b|fc_1");
		result(sm, "call_b|fc_1");
		const callC = call(sm, "call_c");

		expect(branchToolResultIds(sm)).toEqual({
			ids: new Set(["call_a", "call_b_fc_1"]),
			readable: true,
		});
		// A call without its result on the branch is not credited.
		expect(branchToolResultIds(sm).ids.has("call_c")).toBe(false);

		sm.branch(afterA);
		expect(branchToolResultIds(sm).ids).toEqual(new Set(["call_a"]));
		sm.branch(callC);
		expect(branchToolResultIds(sm).ids.has("call_c")).toBe(false);
	});

	it("keeps two long call ids that share their first 64 characters apart (#3833)", () => {
		const parent = `call_${"x".repeat(40)}|fc_${"y".repeat(45)}`;
		const sm = SessionManager.inMemory(env.tmpDir);
		sm.appendMessage({ role: "user", content: "p1", timestamp: 1 } as never);
		result(sm, `${parent}/1`);
		result(sm, `${parent}/2`);

		const { ids } = branchToolResultIds(sm);
		expect(ids.size).toBe(2);
		expect(ids).toEqual(
			new Set([
				sanitizeCorrelationId(`${parent}/1`),
				sanitizeCorrelationId(`${parent}/2`),
			]),
		);
	});

	it("reports an unreadable session manager as no ids", () => {
		expect(branchToolResultIds(undefined)).toEqual({
			ids: new Set(),
			readable: false,
		});
		const throwing = {
			getBranch: () => {
				throw new Error("stale ctx");
			},
		};
		expect(branchToolResultIds(throwing)).toEqual({
			ids: new Set(),
			readable: false,
		});
	});
});

describe("readSessionHeaderId (#3521)", () => {
	function parentFile(id: string): string {
		const file = path.join(env.tmpDir, `${id}.jsonl`);
		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id, cwd: env.tmpDir })}\n`,
		);
		return file;
	}

	it("reads the stable id from a session file's header, and nothing from a bad one", async () => {
		expect(await readSessionHeaderId(parentFile("abc"))).toBe("abc");
		const bad = path.join(env.tmpDir, "bad.jsonl");
		fs.writeFileSync(bad, "not json\n");
		expect(await readSessionHeaderId(bad)).toBeUndefined();
		// A corrupt header whose id is not a string must not reach the sidecar
		// path builder, which would throw inside session_start.
		const numeric = path.join(env.tmpDir, "numeric.jsonl");
		fs.writeFileSync(numeric, '{"type":"session","id":42}\n');
		expect(await readSessionHeaderId(numeric)).toBeUndefined();
		expect(
			await readSessionHeaderId(path.join(env.tmpDir, "missing.jsonl")),
		).toBeUndefined();
	});
});

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

	// #4187 F9: a retirement is the file's state. Recurrence: one that
	// outlived the idle eviction of its file would refuse authorship to every
	// later write of it for the rest of the session.
	it("forgets a retirement with its file's idle eviction (#4131)", () => {
		vi.useFakeTimers();
		const c = path.join(env.tmpDir, "c.ts");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		const guard = createReadGuard("retire-evict");
		guard.recordWritten(c, { stampFileTime: false });
		rewriteLine(c, 2, "OTHER-WRITER");
		expect(verdict(guard, c, 2)).toMatch(
			/^block: .*File modified since your write/,
		);
		guard.recordRead(fullRead(c, 3, "call_read"));
		guard.recordWritten(c, { stampFileTime: false });
		vi.advanceTimersByTime(31 * 60_000);
		expect(guard.getReadHistory(c)).toEqual([]);

		guard.recordWritten(c, { stampFileTime: false });

		expect(verdict(guard, c, 2)).toBe("allow");
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

	it("drops the authorship of a write on the abandoned branch: the file needs a read", () => {
		const c = path.join(env.tmpDir, "c.ts");
		const guard = createReadGuard("retain-written");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		guard.recordWritten(c, { toolCallId: "call_write" });
		expect(verdict(guard, c, 2)).toBe("allow");

		guard.retainBranch(new Set(["call_other"]));

		expect(verdict(guard, c, 2)).toMatch(/^block: .*Edit without read/);
	});

	// #3603: a file the agent created has no read record, only authorship.
	// Recurrence: /tree cleared every authorship, so the agent's next edit of
	// its own file, whose write the branch still shows, needed a re-read.
	it("keeps the authorship of a write whose tool result is on the branch (#3603)", () => {
		const c = path.join(env.tmpDir, "c.ts");
		const guard = createReadGuard("retain-written-kept");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		guard.recordWritten(c, { toolCallId: "call_write" });

		guard.retainBranch(new Set(["call_write"]));

		expect(verdict(guard, c, 2)).toBe("allow");
	});

	it("keeps the authorship only while the bytes hold, after the move too (#3603, #4131)", () => {
		const c = path.join(env.tmpDir, "c.ts");
		const guard = createReadGuard("retain-written-changed");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		guard.recordWritten(c, { toolCallId: "call_write" });
		rewriteLine(c, 2, "OTHER-WRITER");

		guard.retainBranch(new Set(["call_write"]));

		expect(verdict(guard, c, 2)).toMatch(
			/^block: .*File modified since your write/,
		);
	});

	// A drain or immediate autofix names no write of its own: the bytes it
	// rewrote descend from the agent's write, whose id the authorship keeps.
	it("keeps the write's id through a writer that names none (#3603)", () => {
		const c = path.join(env.tmpDir, "c.ts");
		const guard = createReadGuard("retain-written-inherit");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		guard.recordWritten(c, { toolCallId: "call_write" });
		rewriteLine(c, 1, "c1;");
		guard.recordWritten(c, { stampFileTime: false });

		guard.retainBranch(new Set(["call_write"]));

		expect(verdict(guard, c, 2)).toBe("allow");
	});

	// #4187 F9: a retirement is part of its write's authorship, so a move
	// keeps or drops it by the same branch rule. Recurrences: one dropped
	// while its write stays on the branch let a later bash write re-author
	// the other writer's bytes; one that outlived its write's branch refused
	// authorship to every later write of the file.
	it("keeps a retirement with its write on the branch, drops it with the write (#4131)", () => {
		const c = path.join(env.tmpDir, "c.ts");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		const guard = createReadGuard("retain-retired");
		guard.recordWritten(c, { toolCallId: "call_write" });
		rewriteLine(c, 2, "OTHER-WRITER");
		expect(verdict(guard, c, 2)).toMatch(
			/^block: .*File modified since your write/,
		);

		guard.retainBranch(new Set(["call_write"]));
		guard.recordWritten(c, { stampFileTime: false });
		expect(verdict(guard, c, 2)).toMatch(
			/^block: .*File modified since your write/,
		);

		guard.retainBranch(new Set());
		guard.recordWritten(c, { stampFileTime: false });
		expect(verdict(guard, c, 2)).toBe("allow");
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
		before.recordWritten(c, { toolCallId: "call_write" });
		const after = createReadGuard("authorship-after");
		expect(verdict(after, c, 2)).toMatch(/^block: .*Edit without read/);

		after.importAuthorship(
			JSON.parse(JSON.stringify(before.exportAuthorship())),
			new Set(["call_write"]),
		);

		expect(verdict(after, c, 2)).toBe("allow");
	});

	// #4131: the hash decides, not the size. Recurrence: an identity of
	// stat fields alone misses an equal-size rewrite inside one mtime tick,
	// and round 1 of #4187 ended authorship on a touch.
	it("ends authorship on an equal-size rewrite and keeps it over a touch, refreshing the pre-filter (#4131)", () => {
		const c = path.join(env.tmpDir, "c.ts");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		const guard = createReadGuard("authorship-identity");
		guard.recordWritten(c, { toolCallId: "call_write" });
		const touched = new Date(LONG_AGO.getTime() + 60_000);
		fs.utimesSync(c, touched, touched);
		expect(verdict(guard, c, 2)).toBe("allow");
		// The hash matched, so the pre-filter now holds the touched stat.
		expect(guard.exportAuthorship().entries?.[0]?.mtimeMs).toBe(
			fs.statSync(c).mtimeMs,
		);

		const other = path.join(env.tmpDir, "d.ts");
		fs.writeFileSync(other, "d1\nd2\nd3\n");
		fs.utimesSync(other, LONG_AGO, LONG_AGO);
		const guard2 = createReadGuard("authorship-identity-2");
		guard2.recordWritten(other, { toolCallId: "call_write" });
		fs.writeFileSync(other, "d1\nXX\nd3\n");
		expect(fs.statSync(other).size).toBe(9);
		expect(verdict(guard2, other, 2)).toMatch(
			/^block: .*File modified since your write/,
		);
	});

	// #4131: content identity covers "no file yet". Recurrence: a write record
	// of a path not on disk had no bytes to compare, so another writer's
	// creation of the file would have ridden on it.
	it("keeps an authorship credited while the file was absent only until another writer creates it", () => {
		const c = path.join(env.tmpDir, "absent.ts");
		const guard = createReadGuard("authorship-absent");
		guard.recordWritten(c, { toolCallId: "call_write" });
		expect(verdict(guard, c, 2)).toBe("allow");

		fs.writeFileSync(c, "x1\nx2\nx3\n");

		expect(verdict(guard, c, 2)).toMatch(
			/^block: .*File modified since your write/,
		);
	});

	// A /reload keeps the conversation, so a retirement crosses with its
	// write; a released reader of `written` must not see it as authored.
	it("hands a retirement to the next guard, never as a written path (#4131)", () => {
		const c = path.join(env.tmpDir, "c.ts");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		const before = createReadGuard("authorship-retired-before");
		before.recordWritten(c, { toolCallId: "call_write" });
		rewriteLine(c, 2, "OTHER-WRITER");
		expect(verdict(before, c, 2)).toMatch(
			/^block: .*File modified since your write/,
		);
		const payload = JSON.parse(JSON.stringify(before.exportAuthorship()));
		expect(payload.written).toEqual([]);
		const after = createReadGuard("authorship-retired-after");

		after.importAuthorship(payload, new Set(["call_write"]));
		after.recordWritten(c, { stampFileTime: false });

		expect(verdict(after, c, 2)).toMatch(
			/^block: .*File modified since your write/,
		);
	});

	// #3603: /fork and resume adopt authorship through the read-set's branch
	// rule. Recurrence: the store reset on every start but /reload, so a file
	// the agent created needed a re-read after /fork or resume.
	it("imports only the authorship whose write is on the starting branch (#3603)", () => {
		const c = path.join(env.tmpDir, "c.ts");
		const d = path.join(env.tmpDir, "d.ts");
		for (const f of [c, d]) {
			fs.writeFileSync(f, "x1\nx2\nx3\n");
			fs.utimesSync(f, LONG_AGO, LONG_AGO);
		}
		const before = createReadGuard("authorship-branch-before");
		before.recordWritten(c, { toolCallId: "call_c" });
		before.recordWritten(d, { toolCallId: "call_d" });
		const after = createReadGuard("authorship-branch-after");

		expect(
			after.importAuthorship(
				JSON.parse(JSON.stringify(before.exportAuthorship())),
				new Set(["call_c"]),
			),
		).toEqual({ imported: 1, dropped: 1 });

		expect(verdict(after, c, 2)).toBe("allow");
		expect(verdict(after, d, 2)).toMatch(/^block: .*Edit without read/);
	});

	it("ends an imported authorship whose bytes another writer changed (#4131)", () => {
		const c = path.join(env.tmpDir, "c.ts");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		fs.utimesSync(c, LONG_AGO, LONG_AGO);
		const before = createReadGuard("authorship-import-changed-before");
		before.recordWritten(c, { toolCallId: "call_write" });
		const payload = JSON.parse(JSON.stringify(before.exportAuthorship()));
		rewriteLine(c, 2, "OTHER-WRITER");
		const after = createReadGuard("authorship-import-changed-after");

		after.importAuthorship(payload, new Set(["call_write"]));

		expect(verdict(after, c, 2)).toMatch(
			/^block: .*File modified since your write/,
		);
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
			expect(() =>
				guard.importAuthorship(payload, new Set(["call_write"])),
			).not.toThrow();
		expect(guard.exportAuthorship().written).toEqual([]);
		expect(verdict(guard, c, 2)).toMatch(/^block: .*Edit without read/);
	});

	// A released writer (#3612) exported paths only, maybe with a
	// `sessionStartMs`. The row still parses; it names no write a branch can
	// show and no bytes to compare, so it imports nothing (a re-read, never an
	// allow over bytes another writer may have changed meanwhile, #4131).
	it("parses a released writer's path-only row and imports nothing from it (#3520, #4131)", () => {
		const c = oldFile("c.ts", 3);
		const guard = createReadGuard("authorship-released");

		expect(
			guard.importAuthorship(
				{ written: [normalizeFilePath(c)], sessionStartMs: 0 },
				new Set(["call_write"]),
			),
		).toEqual({ imported: 0, dropped: 1 });

		expect(verdict(guard, c, 2)).toMatch(/^block: .*Edit without read/);
		expect(guard.exportAuthorship()).toEqual({ written: [], entries: [] });
	});

	// #4187 R2-6: every adopting start (resume, fork, reload) imports the last
	// guard's authorship and exports it again with the new writes, so an
	// uncapped store grows with every start (probe: 100, 200 ... 600 entries
	// over six starts) into the sidecar. Bounded at 4096 files, the read
	// guard's unconsumed-read cap: retired entries go first, then the oldest.
	it("bounds the authorship it carries across starts, dropping retired entries first (#4187 R2-6)", () => {
		const live = (i: number) => ({
			filePath: normalizeFilePath(path.join(env.tmpDir, `gone-${i}.ts`)),
			size: -1,
			mtimeMs: 0,
			ctimeMs: 0,
			toolCallId: "call_write",
		});
		const entries = [
			...Array.from({ length: 4100 }, (_, i) => live(i)),
			...Array.from({ length: 5 }, (_, i) => ({
				...live(10_000 + i),
				retired: true as const,
			})),
		];
		const guard = createReadGuard("authorship-cap");
		guard.importAuthorship({ written: [], entries }, new Set(["call_write"]));
		const c = path.join(env.tmpDir, "c.ts");
		fs.writeFileSync(c, "c1\nc2\nc3\n");
		guard.recordWritten(c, { toolCallId: "call_new" });

		const exported = guard.exportAuthorship().entries ?? [];
		expect(exported).toHaveLength(4096);
		expect(exported.some((entry) => entry.retired)).toBe(false);
		const kept = new Set(exported.map((entry) => entry.filePath));
		// 4106 credited, 10 over: the 5 retired, then the 5 oldest live.
		for (let i = 0; i < 5; i++) expect(kept.has(live(i).filePath)).toBe(false);
		expect(kept.has(live(5).filePath)).toBe(true);
		expect(verdict(guard, c, 2)).toBe("allow");
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

	it("loads an old record without an id but does not credit it to a branch", () => {
		const guard = createReadGuard("import-compat");
		const any = new Set(["call_a"]);
		const legacy = oldFile("legacy.ts", 6);
		expect(guard.importBranch(undefined, any)).toEqual({
			imported: 0,
			dropped: 0,
		});
		expect(guard.importBranch({ version: 1, reads: [] }, any)).toEqual({
			imported: 0,
			dropped: 0,
		});
		expect(
			guard.importBranch(
				{
					version: READ_GUARD_STATE_VERSION,
					reads: [[normalizeFilePath(legacy), [fullRead(legacy, 6)]]],
				},
				any,
			),
		).toEqual({ imported: 0, dropped: 1 });
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

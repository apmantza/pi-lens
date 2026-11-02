import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	isExactAppliedRetry,
	MAX_APPLIED_RECORD_FILES,
	PartialApplyRecordStore,
} from "../../clients/partial-edit-apply.js";
import { createReadGuardEditBatchSummary } from "../../clients/read-guard-logger.js";

// #5120: the writer this file tested (`applyPartiallyApplicableEdits`) is gone.
// A partial apply rewrites the call's edits and the host edit writes them;
// tests/clients/runtime-tool-call.test.ts drives that flow around pi's own
// edit tool, and tests/index-5120-partial-apply-composition.test.ts in a real
// session. What stays here is the module's record store and its evidence.
describe("createReadGuardEditBatchSummary", () => {
	it("keeps true batch totals beside bounded index samples", () => {
		const summary = createReadGuardEditBatchSummary({
			requestedIndexes: Array.from({ length: 150 }, (_, index) => index),
			resolvedIndexes: Array.from({ length: 150 }, (_, index) => index),
			appliedIndexes: Array.from({ length: 150 }, (_, index) => index),
			alreadyAppliedIndexes: Array.from({ length: 150 }, (_, index) => index),
			participantIds: Array.from(
				{ length: 150 },
				(_, index) => `call-${index}`,
			),
			requestedTotal: 150,
			resolvedTotal: 150,
			appliedTotal: 150,
			alreadyAppliedTotal: 150,
			participantTotal: 150,
		});

		expect(summary.requestedIndexes).toHaveLength(100);
		expect(summary.requestedTotal).toBe(150);
		expect(summary.appliedTotal).toBe(150);
		expect(summary.alreadyAppliedTotal).toBe(150);
		expect(summary.participantIds).toHaveLength(100);
		expect(summary.indexesTruncated).toBe(true);
		expect(summary.participantIdsTruncated).toBe(true);
	});
});

describe("PartialApplyRecordStore", () => {
	it("requires exact submitted whitespace in the retry pair", () => {
		const store = new PartialApplyRecordStore();
		store.record("/f.ts", "old  ", "new\n");
		expect(store.find("/f.ts", "old  ", "new\n")).toBeDefined();
		expect(store.find("/f.ts", "old", "new\n")).toBeUndefined();
		expect(store.find("/f.ts", "old  ", "new")).toBeUndefined();
	});

	it("finds a record keyed under the other path separator (path-key invariant)", () => {
		// Record with one separator form, look up with the other. The store keys
		// through normalizeMapKey, so a retry whose path arrives back-slashed must
		// still resolve a record written slash-formed (read-guard path-key
		// invariant, #210).
		const forward = new PartialApplyRecordStore();
		forward.record("C:/proj/src/file.ts", "old", "new");
		expect(forward.find("C:\\proj\\src\\file.ts", "old", "new")).toBeDefined();

		const backward = new PartialApplyRecordStore();
		backward.record("C:\\proj\\src\\file.ts", "old", "new");
		expect(backward.find("C:/proj/src/file.ts", "old", "new")).toBeDefined();
	});

	it("stamps an afterWrite hash under the other path separator (path-key invariant)", () => {
		const store = new PartialApplyRecordStore();
		store.record("C:/proj/src/file.ts", "old", "new", "commit-hash");
		// Stamp with the back-slashed spelling; read back the slash spelling.
		store.noteAfterWriteHash(
			"C:\\proj\\src\\file.ts",
			"old",
			"new",
			"format-hash",
		);
		expect(
			store.find("C:/proj/src/file.ts", "old", "new")?.afterWriteContentHash,
		).toBe("format-hash");
	});

	it("bounded per-file and per-store eviction keeps the newest records", () => {
		const store = new PartialApplyRecordStore();
		for (let i = 0; i < 10; i += 1) {
			store.record("/f.ts", `old-${i}`, `new-${i}`);
		}
		// Oldest entries evict; the newest 8 stay.
		expect(store.find("/f.ts", "old-0", "new-0")).toBeUndefined();
		expect(store.find("/f.ts", "old-1", "new-1")).toBeUndefined();
		expect(store.find("/f.ts", "old-2", "new-2")).toBeDefined();
		expect(store.find("/f.ts", "old-9", "new-9")).toBeDefined();

		for (let i = 0; i < 70; i += 1) {
			store.record(`/f${i}.ts`, "old", "new");
		}
		expect(store.fileCount).toBe(MAX_APPLIED_RECORD_FILES);
		expect(store.find("/f0.ts", "old", "new")).toBeUndefined();
		expect(store.find("/f69.ts", "old", "new")).toBeDefined();

		store.clear();
		expect(store.fileCount).toBe(0);
	});

	it("a re-record of a resident file at capacity evicts nothing (#2442)", () => {
		// The hand-rolled `keys().next().value` block this replaced evicted
		// BEFORE inserting whenever `size >= cap`, so re-recording an edit for a
		// file ALREADY in the store dropped an unrelated file and the store
		// silently shrank by one. The bound now lives on the PathKeyedMap
		// itself, which inserts first and evicts only while genuinely over
		// capacity.
		const store = new PartialApplyRecordStore();
		for (let i = 0; i < MAX_APPLIED_RECORD_FILES; i += 1) {
			store.record(`/cap${i}.ts`, "old", "new");
		}
		expect(store.fileCount).toBe(MAX_APPLIED_RECORD_FILES);

		// A second edit to a file already in the store — an UPDATE, not a new key.
		store.record("/cap0.ts", "old-2", "new-2");

		expect(store.fileCount).toBe(MAX_APPLIED_RECORD_FILES);
		// Nothing was displaced: every original file is still findable.
		expect(store.find("/cap1.ts", "old", "new")).toBeDefined();
		expect(store.find("/cap0.ts", "old-2", "new-2")).toBeDefined();
	});

	it("a re-record does not refresh a file's eviction position (FIFO, #2442)", () => {
		const store = new PartialApplyRecordStore();
		for (let i = 0; i < MAX_APPLIED_RECORD_FILES; i += 1) {
			store.record(`/fifo${i}.ts`, "old", "new");
		}
		// Read AND re-write the oldest file, then overflow. `find` is the
		// store's production read (`files.get`); under an LRU-backed store
		// either access would promote fifo0 and fifo1 would be evicted instead.
		expect(store.find("/fifo0.ts", "old", "new")).toBeDefined();
		store.record("/fifo0.ts", "old-again", "new-again");

		store.record("/overflow.ts", "old", "new");

		expect(store.find("/fifo0.ts", "old-again", "new-again")).toBeUndefined();
		expect(store.find("/fifo1.ts", "old", "new")).toBeDefined();
	});
});

describe("isExactAppliedRetry", () => {
	it("confirms the not-contained case: oldText gone, newText present", () => {
		const content = "const b = 20;\nconst tail = 1;\n";
		expect(
			isExactAppliedRetry({
				contentLf: content,
				oldKey: "const b = 2;",
				newKey: "const b = 20;",
			}),
		).toBe(true);
	});

	it("refuses the not-contained case when the applied newText vanished", () => {
		const content = "const tail = 1;\n";
		expect(
			isExactAppliedRetry({
				contentLf: content,
				oldKey: "const b = 2;",
				newKey: "const b = 20;",
			}),
		).toBe(false);
	});

	it("refuses coincidental newText presence after an intervening change", () => {
		const recordedContent = "const b = 20;\nconst tail = 1;\n";
		const currentContent = "const b = 20;\nconst tail = 2;\n";
		const recordedHash = createHash("sha256")
			.update(recordedContent, "utf8")
			.digest("hex");
		const currentHash = createHash("sha256")
			.update(currentContent, "utf8")
			.digest("hex");
		expect(
			isExactAppliedRetry({
				contentLf: currentContent,
				contentHash: currentHash,
				expectedContentHash: recordedHash,
				oldKey: "const b = 2;",
				newKey: "const b = 20;",
			}),
		).toBe(false);
	});

	it("accepts the post-afterWrite formatter state as a known applied state", () => {
		// A formatter rewrote the file after the commit, so the current bytes match
		// neither the submitted content nor the post-commit hash — but they DO match
		// the recorded post-afterWrite hash, so recognition holds (#2402).
		const formattedContent = "const b = 20;\nconst tail = 1;\n\n";
		const postCommitHash = createHash("sha256")
			.update("const b = 20;\nconst tail = 1;\n", "utf8")
			.digest("hex");
		const afterWriteHash = createHash("sha256")
			.update(formattedContent, "utf8")
			.digest("hex");
		expect(
			isExactAppliedRetry({
				contentLf: formattedContent,
				contentHash: afterWriteHash,
				expectedContentHash: postCommitHash,
				expectedAfterWriteHash: afterWriteHash,
				oldKey: "const b = 2;",
				newKey: "const b = 20;",
			}),
		).toBe(true);
	});

	it("still refuses an unknown third state even with an afterWrite hash on record", () => {
		// Neither the post-commit nor the post-afterWrite hash matches the current
		// bytes: this is an unrecognized third-party change, and the guard stays
		// fail-safe by refusing rather than re-resolving against it.
		const currentContent = "const b = 20;\nconst tail = 2;\n";
		const currentHash = createHash("sha256")
			.update(currentContent, "utf8")
			.digest("hex");
		expect(
			isExactAppliedRetry({
				contentLf: currentContent,
				contentHash: currentHash,
				expectedContentHash: createHash("sha256")
					.update("const b = 20;\nconst tail = 1;\n", "utf8")
					.digest("hex"),
				expectedAfterWriteHash: createHash("sha256")
					.update("const b = 20;\nconst tail = 1;\n\n", "utf8")
					.digest("hex"),
				oldKey: "const b = 2;",
				newKey: "const b = 20;",
			}),
		).toBe(false);
	});

	it("confirms the contained case: every oldText occurrence lies inside newText", () => {
		const content = "import { A } from 'm';\nimport { B } from 'm';\n";
		expect(
			isExactAppliedRetry({
				contentLf: content,
				oldKey: "import { A } from 'm';",
				newKey: "import { A } from 'm';\nimport { B } from 'm';",
			}),
		).toBe(true);
	});

	it("refuses the contained case when an oldText occurrence escaped newText", () => {
		const content =
			"import { A } from 'm';\nimport { B } from 'm';\nconst a = 1;\n";
		expect(
			isExactAppliedRetry({
				contentLf: content,
				oldKey: "const a = 1;",
				newKey: "const a = 1;\nconst b = 2;",
			}),
		).toBe(false);
	});

	it("models a pure deletion as oldText gone", () => {
		expect(
			isExactAppliedRetry({
				contentLf: "const tail = 1;\n",
				oldKey: "const a = 1;",
				newKey: "",
			}),
		).toBe(true);
	});
});

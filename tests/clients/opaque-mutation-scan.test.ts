/**
 * Opaque-mutation recovery (#2000 phase 2) — real-filesystem tests: actual
 * stat walks over temp trees and real diffs. This file pins the SEAM contract
 * only; handler wiring coverage (real node -e / python -c child writes through
 * handleToolCall/handleToolResult) is PR-B scope and NOT covered here.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	captureFileStats,
	diffFileStats,
	OPAQUE_SCAN_MAX_FILES,
	OpaqueSnapshotStore,
} from "../../clients/opaque-mutation-scan.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir = "";

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opaque-scan-"));
	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
});

afterEach(() => {
	removeTempDirSync(tmpDir);
});

describe("captureFileStats", () => {
	it("snapshots existing project sources with normalized keys", async () => {
		const file = path.join(tmpDir, "src", "a.ts");
		fs.writeFileSync(file, "const x = 1;\n", "utf8");
		const outcome = await captureFileStats(tmpDir);
		expect(outcome.unknownReason).toBeUndefined();
		expect(outcome.snapshot?.has(normalizeMapKey(file))).toBe(true);
		const entry = outcome.snapshot?.get(normalizeMapKey(file));
		expect(entry?.size).toBe("const x = 1;\n".length);
		expect(typeof entry?.mtimeMs).toBe("number");
	});

	it("reports file-cap-exceeded rather than an unbounded walk", async () => {
		for (let i = 0; i < OPAQUE_SCAN_MAX_FILES + 10; i++) {
			fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), "x", "utf8");
		}
		const outcome = await captureFileStats(tmpDir);
		expect(outcome.unknownReason).toBe("file-cap-exceeded");
		expect(outcome.scannedCount).toBeGreaterThan(OPAQUE_SCAN_MAX_FILES);
	});
});

describe("diffFileStats", () => {
	it("detects modified, added — not deleted or unchanged", async () => {
		const modifiedPath = path.join(tmpDir, "m.ts");
		const unchangedPath = path.join(tmpDir, "u.ts");
		fs.writeFileSync(modifiedPath, "v1", "utf8");
		fs.writeFileSync(unchangedPath, "same", "utf8");
		const before = await captureFileStats(tmpDir);

		// Real child-process-style mutation: rewrite + add.
		fs.writeFileSync(modifiedPath, "v2-longer", "utf8");
		const addedPath = path.join(tmpDir, "added.ts");
		fs.writeFileSync(addedPath, "new", "utf8");
		fs.rmSync(unchangedPath);
		const after = await captureFileStats(tmpDir);

		const changed = diffFileStats(
			before.snapshot ?? new Map(),
			after.snapshot ?? new Map(),
		);
		const keys = changed.map((k) => k);
		expect(keys).toContain(normalizeMapKey(modifiedPath));
		expect(keys).toContain(normalizeMapKey(addedPath));
		expect(keys).not.toContain(normalizeMapKey(unchangedPath));
	});
});

describe("OpaqueSnapshotStore", () => {
	it("one slot per cwd: take consumes, replacement evicts with a count", () => {
		const store = new OpaqueSnapshotStore();
		store.record("/p", new Map([["a", { mtimeMs: 1, size: 1 }]]));
		store.record("/p", new Map([["b", { mtimeMs: 2, size: 2 }]]));
		expect(store.evictionCount).toBe(1);
		const taken = store.take("/p");
		expect(taken?.get("b")).toEqual({ mtimeMs: 2, size: 2 });
		expect(store.take("/p")).toBeUndefined();
	});
});

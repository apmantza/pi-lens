/**
 * Tests for clients/atomic-write.ts (#762) — the shared tmp+rename atomic
 * writer that replaces the five hand-rolled `${target}.tmp-${pid}` +
 * `renameSync`/`rename` writers (instance-registry.ts, session-state-store.ts,
 * recent-touches.ts, review-graph/builder.ts, diagnostic-dispositions.ts).
 *
 * Covers the sync (`writeFileAtomic`) and async (`writeFileAtomicAsync`)
 * variants: success replaces content atomically, no tmp file is left behind
 * on success or on a swallowed failure, `bestEffort: true` (default) swallows
 * a rename failure, and `bestEffort: false` rethrows it (the #757
 * diagnostic-dispositions policy) after the same best-effort tmp cleanup.
 *
 * Rename failures are induced with a REAL filesystem obstruction (renaming a
 * file onto an existing non-empty directory), not a mocked `fs` — this repo's
 * `atomic-write.ts` uses `import * as fs from "node:fs"`, and Node's builtin
 * module namespace bindings don't reliably re-bind under `vi.spyOn` here, so
 * a genuine EPERM/ENOTEMPTY/EISDIR exercises the real failure path end to end
 * on every platform (verified: renaming onto a non-empty dir fails with EPERM
 * on Windows, ENOTEMPTY/EISDIR on POSIX).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	writeFileAtomic,
	writeFileAtomicAsync,
} from "../../clients/atomic-write.js";

let dir: string;

function tmpLeftovers(): string[] {
	return fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

/** A target path that already exists as a non-empty directory: renaming a
 * file onto it reliably fails on every platform. */
function makeUnrenamableTarget(): string {
	const target = path.join(dir, "state.json");
	fs.mkdirSync(target);
	fs.writeFileSync(path.join(target, "keep.txt"), "occupied");
	return target;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-atomic-write-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic (sync)", () => {
	it("replaces the target's content atomically on success", () => {
		const target = path.join(dir, "state.json");
		fs.writeFileSync(target, "old");
		writeFileAtomic(target, "new");
		expect(fs.readFileSync(target, "utf-8")).toBe("new");
	});

	it("creates the target when it doesn't exist yet", () => {
		const target = path.join(dir, "state.json");
		writeFileAtomic(target, "hello");
		expect(fs.readFileSync(target, "utf-8")).toBe("hello");
	});

	it("leaves no tmp-<pid> file behind on success", () => {
		const target = path.join(dir, "state.json");
		writeFileAtomic(target, "hello");
		expect(tmpLeftovers()).toEqual([]);
	});

	it("leaves no tmp-<pid> file behind when the rename fails (bestEffort)", () => {
		const target = makeUnrenamableTarget();
		expect(() => writeFileAtomic(target, "hello")).not.toThrow();
		expect(tmpLeftovers()).toEqual([]);
		// The obstruction directory is untouched — only the tmp file was cleaned up.
		expect(fs.readdirSync(target)).toEqual(["keep.txt"]);
	});

	it("bestEffort: true (default) swallows a rename failure", () => {
		const target = makeUnrenamableTarget();
		expect(() => writeFileAtomic(target, "hello")).not.toThrow();
	});

	it("bestEffort: false rethrows a rename failure after best-effort cleanup", () => {
		const target = makeUnrenamableTarget();
		expect(() =>
			writeFileAtomic(target, "hello", { bestEffort: false }),
		).toThrow();
		expect(tmpLeftovers()).toEqual([]);
	});

	it("bestEffort: false lets a successful write/rename through untouched", () => {
		const target = path.join(dir, "state.json");
		writeFileAtomic(target, "hello", { bestEffort: false });
		expect(fs.readFileSync(target, "utf-8")).toBe("hello");
		expect(tmpLeftovers()).toEqual([]);
	});
});

describe("writeFileAtomicAsync", () => {
	it("replaces the target's content atomically on success", async () => {
		const target = path.join(dir, "state.json");
		fs.writeFileSync(target, "old");
		await writeFileAtomicAsync(target, "new");
		expect(fs.readFileSync(target, "utf-8")).toBe("new");
	});

	it("leaves no tmp-<pid> file behind on success", async () => {
		const target = path.join(dir, "state.json");
		await writeFileAtomicAsync(target, "hello");
		expect(tmpLeftovers()).toEqual([]);
	});

	it("bestEffort: true (default) swallows a rename failure and leaves no tmp file", async () => {
		const target = makeUnrenamableTarget();
		await expect(
			writeFileAtomicAsync(target, "hello"),
		).resolves.toBeUndefined();
		expect(tmpLeftovers()).toEqual([]);
		expect(fs.readdirSync(target)).toEqual(["keep.txt"]);
	});

	it("bestEffort: false rethrows a rename failure after best-effort cleanup", async () => {
		const target = makeUnrenamableTarget();
		await expect(
			writeFileAtomicAsync(target, "hello", { bestEffort: false }),
		).rejects.toThrow();
		expect(tmpLeftovers()).toEqual([]);
	});
});

import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2626 review round 2, F4: `vi.spyOn(fs, "readdirSync")` cannot redefine a
// node: built-in's ESM namespace export directly — wrap via vi.mock, default
// to the REAL implementation via `vi.fn(actual.readdirSync)`, and only the
// EACCES test below overrides it for a single call.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

import * as fs from "node:fs";
import {
	classifyBundledResourceDir,
	describeBundledResourceHealth,
	reportBundledResourceDirHealth,
} from "../../clients/bundled-resource-health.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { removeTempDirSync } from "./test-utils.js";

/**
 * #2636 (the #2626 class sweep): `classifyBundledResourceDir` +
 * `reportBundledResourceDirHealth` are the shared classify/report pair
 * `clients/ast-grep-client.ts`, `clients/cache/rule-cache.ts`, and
 * `clients/tree-sitter-query-loader.ts` all now route through, so the
 * ENOENT/EACCES/empty distinction (#2626 review F4) is pinned once here
 * rather than reproved per call site.
 */

const notified: Array<{ message: string; level: string | undefined }> = [];
let tmpDirs: string[] = [];

beforeEach(() => {
	notified.length = 0;
	tmpDirs = [];
	resetDegradationLedger();
	vi.mocked(fs.readdirSync).mockClear();
	wireUserNotifier(() => (message, level) => {
		notified.push({ message, level });
	});
});

afterEach(() => {
	resetUserNotifier();
	resetDegradationLedger();
	vi.restoreAllMocks();
	for (const dir of tmpDirs) {
		removeTempDirSync(dir);
	}
});

function freshTempDir(): string {
	const dir = fsSync.mkdtempSync(
		path.join(os.tmpdir(), "pilens-bundled-resource-health-"),
	);
	tmpDirs.push(dir);
	return dir;
}

describe("classifyBundledResourceDir", () => {
	it("reports absent for a directory that does not exist", () => {
		const dir = path.join(freshTempDir(), "does-not-exist");
		expect(classifyBundledResourceDir(dir)).toEqual({ status: "absent" });
	});

	it("reports empty for a real, empty directory", () => {
		const dir = freshTempDir();
		expect(classifyBundledResourceDir(dir)).toEqual({ status: "empty" });
	});

	it("reports healthy with the real entry count for a populated directory", () => {
		const dir = freshTempDir();
		fsSync.writeFileSync(path.join(dir, "a.yml"), "id: a\n");
		fsSync.writeFileSync(path.join(dir, "b.yml"), "id: b\n");
		expect(classifyBundledResourceDir(dir)).toEqual({
			status: "healthy",
			entryCount: 2,
		});
	});

	it("distinguishes an unreadable directory (EACCES) from absent (ENOENT)", () => {
		const dir = freshTempDir();
		const error = Object.assign(new Error("permission denied"), {
			code: "EACCES",
		});
		vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
			throw error;
		});
		expect(classifyBundledResourceDir(dir)).toEqual({
			status: "unreadable",
			fsErrorCode: "EACCES",
		});
	});
});

// #2636 review round 2 (rail deliverable): pins the literal reason strings
// every caller that does NOT override `emptyDescription`/`reasonOverride`
// (ast-grep, tree-sitter — skills always overrides both, pinned in
// skills-resolver.test.ts) ships in its degradation-ledger row and notify
// message. Neither string exists on master (this shared module is new); this
// is the pin that makes the shape a deliberate, reviewable one going forward.
describe("describeBundledResourceHealth", () => {
	it("names the directory for absent and unreadable, generically for empty by default", () => {
		expect(describeBundledResourceHealth({ status: "absent" }, "/r")).toBe(
			"no such directory: /r",
		);
		expect(
			describeBundledResourceHealth(
				{ status: "unreadable", fsErrorCode: "EACCES" },
				"/r",
			),
		).toBe("cannot read /r (EACCES)");
		expect(describeBundledResourceHealth({ status: "empty" }, "/r")).toBe(
			"/r exists but holds nothing",
		);
	});

	it("lets a caller replace the empty-case description without touching absent/unreadable", () => {
		expect(
			describeBundledResourceHealth({ status: "empty" }, "/r", "custom empty"),
		).toBe("custom empty");
		expect(
			describeBundledResourceHealth({ status: "absent" }, "/r", "custom empty"),
		).toBe("no such directory: /r");
	});
});

describe("reportBundledResourceDirHealth", () => {
	it("is a no-op when healthy: no degradation, no notify", () => {
		reportBundledResourceDirHealth(
			"ast-grep-rules-dir-missing",
			"/fake/rules",
			{ status: "healthy", entryCount: 3 },
			"fake resource",
		);
		expect(
			getDegradationSummary().find(
				(g) => g.kind === "ast-grep-rules-dir-missing",
			),
		).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	it("records a degradation and notifies once for an absent directory", () => {
		reportBundledResourceDirHealth(
			"ast-grep-rules-dir-missing",
			"/fake/rules",
			{ status: "absent" },
			"fake resource",
		);
		const group = getDegradationSummary().find(
			(g) => g.kind === "ast-grep-rules-dir-missing",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.reason).toContain(
			"no such directory: /fake/rules",
		);
		expect(notified).toHaveLength(1);
		expect(notified[0].message).toContain("fake resource unavailable");
		expect(notified[0].level).toBe("warning");
	});

	it("carries the fsErrorCode into ledger metadata for an unreadable directory", () => {
		reportBundledResourceDirHealth(
			"tree-sitter-queries-dir-missing",
			"/fake/queries",
			{ status: "unreadable", fsErrorCode: "EACCES" },
			"fake queries",
		);
		const group = getDegradationSummary().find(
			(g) => g.kind === "tree-sitter-queries-dir-missing",
		);
		expect(group?.latestReasons.at(-1)?.reason).toContain(
			"cannot read /fake/queries (EACCES)",
		);
	});

	it("notifies exactly once per (kind, subject) across repeated calls", () => {
		reportBundledResourceDirHealth(
			"tree-sitter-queries-dir-missing",
			"/fake/queries",
			{ status: "absent" },
			"fake queries",
		);
		reportBundledResourceDirHealth(
			"tree-sitter-queries-dir-missing",
			"/fake/queries",
			{ status: "absent" },
			"fake queries",
		);
		reportBundledResourceDirHealth(
			"tree-sitter-queries-dir-missing",
			"/fake/queries",
			{ status: "absent" },
			"fake queries",
		);
		expect(notified).toHaveLength(1);
		const group = getDegradationSummary().find(
			(g) => g.kind === "tree-sitter-queries-dir-missing",
		);
		// the exact call TOTAL, not just the rising-edge notify count.
		expect(group?.count).toBe(3);
	});
});

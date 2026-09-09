import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectDataDir } from "../../clients/file-utils.js";
import type { LSPCodeAction } from "../../clients/lsp/client.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { removeTempDirSync } from "./test-utils.js";

// LSP service mock — collects which methods were called so we can assert that
// the slow path is skipped when the cache is hot.
const openFile = vi.fn(async () => undefined);
const getDiagnostics = vi.fn(async () => []);
const codeAction = vi.fn(async (): Promise<LSPCodeAction[]> => []);
let lastKnownReturn: unknown[] | undefined = undefined;
// When set, the mock honours the content-hash guard the way the real service
// does: it returns the cached value only if the caller's expectedContentHash
// matches the hash this entry was primed for. Left undefined for the legacy
// tests that don't exercise the guard.
let cachedForHash: string | undefined = undefined;
const getLastKnownDiagnostics = vi.fn(
	(_filePath: string, expectedContentHash?: string) => {
		if (expectedContentHash !== undefined && cachedForHash !== undefined) {
			return expectedContentHash === cachedForHash
				? lastKnownReturn
				: undefined;
		}
		return lastKnownReturn;
	},
);

vi.mock("../../clients/lsp/index.js", () => ({
	// Factory-seeded, with the five methods this suite asserts call counts on
	// overridden (#2592). The cache-hit assertions below count `openFile` /
	// `getDiagnostics` calls, so the defaults must not shadow them.
	getLSPService: () =>
		makeLspServiceDouble({
			supportsLSP: (filePath: string) => filePath.endsWith(".ts"),
			openFile,
			getDiagnostics,
			codeAction,
			getLastKnownDiagnostics,
		}),
}));

let tmpDir: string;

beforeEach(() => {
	openFile.mockClear();
	getDiagnostics.mockClear();
	codeAction.mockClear();
	getLastKnownDiagnostics.mockClear();
	lastKnownReturn = undefined;
	cachedForHash = undefined;
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-cache-"));
	const src = path.join(tmpDir, "src");
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(
		path.join(src, "main.ts"),
		"export function main(): void {}\n",
	);
});

afterEach(() => {
	removeTempDirSync(tmpDir);
});

/** #2504: settle the off-hook fresh-pull loop, if this call deferred one. */
async function awaitDeferred(): Promise<void> {
	const { _awaitDeferredLspPullForTest } =
		await import("../../clients/actionable-warnings.js");
	await _awaitDeferredLspPullForTest();
}

async function buildReport(args: { dispatchWarnings?: never[] } = {}) {
	const { buildActionableWarningsReport } =
		await import("../../clients/actionable-warnings.js");
	return buildActionableWarningsReport({
		cwd: tmpDir,
		sessionId: "lens-test",
		turnIndex: 1,
		files: ["src/main.ts"],
		modifiedRangesByFile: new Map(),
		dispatchWarnings: args.dispatchWarnings ?? [],
		includeLspCodeActions: true,
	});
}

describe("actionable-warnings LSP cache short-circuit (#fix-1)", () => {
	it("uses the cached LSP diagnostics when getLastKnownDiagnostics returns a value", async () => {
		lastKnownReturn = []; // cache present, file has no LSP diagnostics
		await buildReport();
		expect(getLastKnownDiagnostics).toHaveBeenCalledTimes(1);
		expect(openFile).not.toHaveBeenCalled();
		expect(getDiagnostics).not.toHaveBeenCalled();
	});

	it("uses cached diagnostics even when they include real warnings (no fresh round trip)", async () => {
		lastKnownReturn = [
			{
				severity: 2,
				message: "Some warning",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
				source: "ts",
			},
		];
		await buildReport();
		expect(getLastKnownDiagnostics).toHaveBeenCalledTimes(1);
		expect(openFile).not.toHaveBeenCalled();
		expect(getDiagnostics).not.toHaveBeenCalled();
		expect(codeAction).toHaveBeenCalledTimes(1);
	});

	it("falls through to the slow path only when the cache is empty (undefined)", async () => {
		lastKnownReturn = undefined; // cache miss — dispatch never touched this file
		await buildReport();
		expect(getLastKnownDiagnostics).toHaveBeenCalledTimes(1);
		// #2504: the fresh pull still happens, but a turn that primed NO cache
		// runs it OFF the awaited turn_end hook — 147 serial ~880 ms pulls on
		// the hook is what blocked the terminal for 187 s. Await the deferral to
		// assert the slow path still runs.
		await awaitDeferred();
		expect(openFile).toHaveBeenCalledTimes(1);
		expect(getDiagnostics).toHaveBeenCalledTimes(1);
	});

	it("distinguishes 'cache empty' (`[]`) from 'cache missing' (undefined)", async () => {
		// Empty cache is a real result — file is LSP-clean — and must not trigger
		// a re-fetch. The fix would regress if `[]` was confused with undefined.
		lastKnownReturn = [];
		await buildReport();
		expect(openFile).not.toHaveBeenCalled();
		expect(getDiagnostics).not.toHaveBeenCalled();
	});

	it("passes the current file content hash to the guarded getter", async () => {
		lastKnownReturn = [];
		await buildReport();
		const passedHash = getLastKnownDiagnostics.mock.calls[0][1];
		const expected = createHash("sha256")
			.update(fs.readFileSync(path.join(tmpDir, "src", "main.ts"), "utf-8"))
			.digest("hex");
		expect(passedHash).toBe(expected);
	});

	it("reuses the cache when the hash matches the current content (no fresh read)", async () => {
		lastKnownReturn = [];
		cachedForHash = createHash("sha256")
			.update(fs.readFileSync(path.join(tmpDir, "src", "main.ts"), "utf-8"))
			.digest("hex");
		await buildReport();
		expect(openFile).not.toHaveBeenCalled();
		expect(getDiagnostics).not.toHaveBeenCalled();
	});

	it("does NOT serve a stale entry: hash mismatch falls through to a fresh read", async () => {
		// A previous turn's diagnostics are present but were primed for different
		// bytes — the guard must reject them and force a fresh LSP round trip.
		lastKnownReturn = [
			{
				severity: 2,
				message: "stale warning from a previous turn",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
				source: "ts",
			},
		];
		cachedForHash = "hash-of-some-older-content";
		await buildReport();
		expect(getLastKnownDiagnostics).toHaveBeenCalledTimes(1);
		// A hash mismatch is a cache MISS, so this turn primed nothing and the
		// fresh read is deferred off the hook (#2504) — it still happens.
		await awaitDeferred();
		expect(openFile).toHaveBeenCalledTimes(1);
		expect(getDiagnostics).toHaveBeenCalledTimes(1);
	});
});

// PRE-#1816 id formula, reproduced here (not imported — it no longer exists
// in source) only so the two-turn probe below can seed a suppression store
// exactly as it would have been written by a pre-fix build. Mirrors
// actionable-warnings.test.ts's own copy.
function legacyActionableWarningIdForTest(args: {
	cwd: string;
	filePath: string;
	tool?: string;
	source?: string;
	code?: string | number;
	rule?: string;
	message: string;
	line?: number;
}): string {
	const rel = path.relative(args.cwd, args.filePath).replace(/\\/g, "/");
	const legacyRelativeFile =
		rel && !rel.startsWith("..") ? rel : normalizeMapKey(args.filePath);
	const normalized = args.message.replace(/\s+/g, " ").trim().toLowerCase();
	const parts = [
		legacyRelativeFile,
		args.tool ?? "",
		args.source ?? "",
		String(args.code ?? ""),
		args.rule ?? "",
		normalized,
		String(args.line ?? ""),
	];
	return `aw:${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 10)}`;
}

describe("actionable-warning-state.json migration — LSP two-turn probe (review-round F1, #1816)", () => {
	// F1: updateWarningState used to re-derive the legacy id from the
	// RECORD's public `rule` field. recordFromLspDiagnostic computes the
	// current id from identityArgs carrying NO `rule` (LSP diagnostics don't
	// have one), then sets `record.rule` afterward to `${source}:${code}`
	// purely for display. Re-deriving from `record.rule` therefore computed
	// a DIFFERENT legacy id than the one `suppressionFor` actually checked —
	// so turn 1 correctly reported the warning as suppressed (via
	// suppressionFor's own correct legacy lookup), but updateWarningState's
	// mismatched recompute then wrote a FRESH "active" entry under the
	// current id (since neither `state.warnings[id]` nor its own,
	// wrongly-computed "legacy" key existed yet). Turn 2 then found that
	// "active" entry under the current id FIRST — short-circuiting before
	// ever falling back to the true legacy key — and the warning silently
	// un-suppressed itself. The fix carries `legacyId` on the record from
	// `suppressionFor`'s own computation; `updateWarningState` now only
	// ever reads that field.
	it("stays suppressed on a second turn for an LSP-origin warning suppressed under the pre-#1816 id", async () => {
		const diag = {
			severity: 2,
			message: "'x' is declared but never used",
			code: 6133,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 5 },
			},
			source: "ts",
		};
		lastKnownReturn = [diag];
		codeAction.mockImplementation(async () => [
			{ title: "Remove unused declaration", kind: "quickfix" },
		]);

		const filePath = path.join(tmpDir, "src", "main.ts");
		// The true pre-#1816 write: LSP identity args carry NO `rule` — only
		// `tool`/`source`/`code`/`message`/`line`.
		const legacyId = legacyActionableWarningIdForTest({
			cwd: tmpDir,
			filePath,
			tool: "lsp",
			source: "ts",
			code: "6133",
			message: diag.message,
			line: 1,
		});

		const statePath = path.join(
			getProjectDataDir(tmpDir),
			"cache",
			"actionable-warning-state.json",
		);
		fs.mkdirSync(path.dirname(statePath), { recursive: true });
		fs.writeFileSync(
			statePath,
			JSON.stringify({
				warnings: {
					[legacyId]: { status: "suppressed", reason: "pre-#1816 LSP mark" },
				},
			}),
		);

		const findLspWarning = (report: {
			files: Array<{ warnings: Array<{ tool: string; suppressed: boolean }> }>;
		}) => report.files.flatMap((f) => f.warnings).find((w) => w.tool === "lsp");

		const turn1 = await buildReport();
		const turn1Warning = findLspWarning(turn1);
		expect(turn1Warning).toBeDefined();
		expect(turn1Warning?.suppressed).toBe(true);

		const turn2 = await buildReport();
		const turn2Warning = findLspWarning(turn2);
		expect(turn2Warning).toBeDefined();
		expect(turn2Warning?.suppressed).toBe(true);
	});
});

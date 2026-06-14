import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LSP service mock — collects which methods were called so we can assert that
// the slow path is skipped when the cache is hot.
const openFile = vi.fn(async () => undefined);
const getDiagnostics = vi.fn(async () => []);
const codeAction = vi.fn(async () => []);
let lastKnownReturn: unknown[] | undefined = undefined;
// When set, the mock honours the content-hash guard the way the real service
// does: it returns the cached value only if the caller's expectedContentHash
// matches the hash this entry was primed for. Left undefined for the legacy
// tests that don't exercise the guard.
let cachedForHash: string | undefined = undefined;
const getLastKnownDiagnostics = vi.fn(
	(_filePath: string, expectedContentHash?: string) => {
		if (expectedContentHash !== undefined && cachedForHash !== undefined) {
			return expectedContentHash === cachedForHash ? lastKnownReturn : undefined;
		}
		return lastKnownReturn;
	},
);

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => ({
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
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function buildReport(args: { dispatchWarnings?: never[] } = {}) {
	const { buildActionableWarningsReport } = await import(
		"../../clients/actionable-warnings.js"
	);
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
		expect(openFile).toHaveBeenCalledTimes(1);
		expect(getDiagnostics).toHaveBeenCalledTimes(1);
	});
});

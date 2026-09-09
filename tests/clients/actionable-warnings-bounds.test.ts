/**
 * #2504 AC3 — `buildActionableWarningsReport` must be bounded.
 *
 * The reported turn awaited this function on the turn_end hook with 154 files
 * and NO primed LSP cache: it opened every one of them in an LSP client and
 * pulled fresh per-file diagnostics serially at ~880 ms each —
 * `actionable_warnings_report durationMs 187891` for `warnings: 0`, with
 * `~/.claude/plans/*.md` among the files it opened.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LSPCodeAction, LSPDiagnostic } from "../../clients/lsp/client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { removeTempDirSync } from "./test-utils.js";

const openFile = vi.fn(
	async (_filePath: string, _content?: string) => undefined,
);
let getDiagnosticsDelayMs = 0;
const getDiagnostics = vi.fn(async (_filePath: string) => {
	if (getDiagnosticsDelayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, getDiagnosticsDelayMs));
	}
	return [];
});
/**
 * #2504 review round 4. Both new bounds are about the cost of ONE file, so the
 * double has to be able to cost something per round trip and the primed cache
 * has to be able to hold real warnings.
 */
let codeActionDelayMs = 0;
const codeAction = vi.fn(async (): Promise<LSPCodeAction[]> => {
	if (codeActionDelayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, codeActionDelayMs));
	}
	return [];
});
/** Files whose diagnostics the dispatch pipeline primed this turn. */
let primedFiles = new Set<string>();
/** What a PRIMED file's cache entry holds. Default: clean. */
let primedDiagnostics: LSPDiagnostic[] = [];
const getLastKnownDiagnostics = vi.fn((filePath: string) =>
	primedFiles.has(filePath.replace(/\\/g, "/").toLowerCase())
		? primedDiagnostics
		: undefined,
);

/** `count` warning-severity diagnostics, one per line, all on modified lines. */
function warningDiagnostics(count: number): LSPDiagnostic[] {
	return Array.from({ length: count }, (_unused, i) => ({
		severity: 2 as const,
		message: `unused symbol #${i}`,
		range: {
			start: { line: i, character: 0 },
			end: { line: i, character: 4 },
		},
		source: "ts",
		code: 6133,
	}));
}

vi.mock("../../clients/lsp/index.js", () => ({
	// The five methods `buildActionableWarningsReport` actually reads, overridden
	// on a factory-seeded surface (#2592): a sixth one added to the production
	// path would otherwise TypeError into the report's swallow-all catch and
	// silently blank this suite's bounds assertions.
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
let outsideDir: string;

function prime(filePath: string): void {
	primedFiles.add(filePath.replace(/\\/g, "/").toLowerCase());
}

function makeFiles(dir: string, count: number, prefix = "f"): string[] {
	fs.mkdirSync(dir, { recursive: true });
	const made: string[] = [];
	for (let i = 0; i < count; i++) {
		const p = path.join(dir, `${prefix}${i}.ts`);
		fs.writeFileSync(p, `export const v${i} = ${i};\n`);
		made.push(p);
	}
	return made;
}

beforeEach(() => {
	openFile.mockClear();
	getDiagnostics.mockClear();
	codeAction.mockClear();
	getLastKnownDiagnostics.mockClear();
	getDiagnosticsDelayMs = 0;
	codeActionDelayMs = 0;
	primedDiagnostics = [];
	primedFiles = new Set();
	resetDegradationLedger();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2504-aw-"));
	outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2504-out-"));
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	removeTempDirSync(outsideDir);
	resetDegradationLedger();
});

async function load() {
	return await import("../../clients/actionable-warnings.js");
}

describe("#2504 AC3 — project-root filter", () => {
	it("never opens a file from outside the project root", async () => {
		const { buildActionableWarningsReport } = await load();
		const inside = makeFiles(path.join(tmpDir, "src"), 1)[0];
		const outside = makeFiles(outsideDir, 1, "stray")[0];
		prime(inside);
		prime(outside);

		await buildActionableWarningsReport({
			cwd: tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files: [inside, outside],
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
		});

		const touched = [
			...getLastKnownDiagnostics.mock.calls.map((c) => String(c[0])),
			...openFile.mock.calls.map((c) => String(c[0])),
			...getDiagnostics.mock.calls.map((c) => String(c[0])),
		].map((p) => p.replace(/\\/g, "/"));
		expect(touched.length).toBeGreaterThan(0);
		for (const p of touched) {
			expect(p).not.toContain("stray0.ts");
		}
	});
});

describe("#2504 AC3 — file cap", () => {
	it("stops after the file cap and records a visible degradation", async () => {
		const { buildActionableWarningsReport } = await load();
		const files = makeFiles(path.join(tmpDir, "src"), 40);
		for (const f of files) prime(f);

		await buildActionableWarningsReport({
			cwd: tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspFileCap: 8,
		});

		expect(getLastKnownDiagnostics.mock.calls.length).toBeLessThanOrEqual(8);
		const kinds = getDegradationSummary().map((g) => g.kind);
		expect(kinds).toContain("actionable-warnings-cap");
	});
});

describe("#2504 AC3 — wall budget", () => {
	it("stops the in-band fresh-pull loop when the total budget is spent", async () => {
		const { buildActionableWarningsReport } = await load();
		const files = makeFiles(path.join(tmpDir, "src"), 20);
		// One primed file, so the turn HAS primed the cache and the cold pulls
		// stay on the awaited hook — the budget is the only thing that can stop
		// them.
		prime(files[0]);
		getDiagnosticsDelayMs = 20;

		await buildActionableWarningsReport({
			cwd: tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspBudgetMs: 60,
		});

		expect(getDiagnostics.mock.calls.length).toBeLessThan(19);
		const kinds = getDegradationSummary().map((g) => g.kind);
		expect(kinds).toContain("actionable-warnings-cap");
	});
});

describe("#2504 AC3 — cold cache moves the fresh-pull loop off the awaited hook", () => {
	it("returns without a single fresh pull and delivers via the cached channel", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await load();
		const files = makeFiles(path.join(tmpDir, "src"), 6);
		// Nothing primed: every file would need a ~880 ms fresh round trip.
		const deferred: unknown[] = [];

		const report = await buildActionableWarningsReport({
			cwd: tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			onDeferredReport: (r: unknown) => deferred.push(r),
		});

		expect(report).toBeDefined();
		// The awaited hook did NO fresh LSP work.
		expect(getDiagnostics).not.toHaveBeenCalled();
		expect(openFile).not.toHaveBeenCalled();

		await _awaitDeferredLspPullForTest();

		// ...but the work still happened, off-hook, and was delivered.
		expect(getDiagnostics.mock.calls.length).toBeGreaterThan(0);
		expect(deferred.length).toBe(1);
	});
});

/**
 * #2504 review round 4 (F2) — the wall budget must bound work INSIDE a file.
 *
 * Round 3 re-checked the budget BETWEEN files only, on the stated ground that
 * a file already opened should be finished rather than half-enriched. But one
 * file costs an openFile, a getDiagnostics and up to
 * ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE codeAction round trips, each
 * bounded only by the 10 s per-round-trip timeout: 270 s on the AWAITED
 * turn_end hook, from a batch budget of 2500 ms. Measured on the pre-fix
 * build: a 1 ms budget still cost 1012 ms.
 */
describe("#2504 r4 F2 — the wall budget bounds one file's round trips", () => {
	it("stops between a file's codeAction pulls once the budget is spent", async () => {
		const { buildActionableWarningsReport } = await load();
		const files = makeFiles(path.join(tmpDir, "src"), 1);
		// PRIMED, so this is the in-band path with no open/pull to pay for: the
		// only cost left is the per-diagnostic codeAction fan-out, which is
		// precisely what no bound reached.
		prime(files[0]);
		primedDiagnostics = warningDiagnostics(40);
		codeActionDelayMs = 20;

		const startedAt = Date.now();
		await buildActionableWarningsReport({
			cwd: tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map([
				// Keyed exactly as production keys it, per the read-guard
				// path-key rule: normalizeMapKey, never a hand-rolled lowercase.
				[normalizeMapKey(files[0]), [{ start: 1, end: 200 }]],
			]),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspBudgetMs: 60,
		});
		const elapsedMs = Date.now() - startedAt;

		// Pre-fix: the per-file cap (25) was the only thing that stopped it, so
		// 25 x 20 ms of codeAction ran with the batch budget long gone.
		expect(codeAction.mock.calls.length).toBeLessThan(10);
		expect(elapsedMs).toBeLessThan(400);
		const inFileBudget = getDegradationSummary()
			.flatMap((group) => group.latestReasons)
			.filter((entry) => entry.subject.includes("in-file-budget"));
		expect(inFileBudget.length).toBe(1);
		expect(inFileBudget[0].reason).toContain(
			"were NOT checked for fix actions",
		);
	});
});

/**
 * #2504 review round 4 (S-1) — the per-file code-action cap had NO test.
 *
 * Round 3 added ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE and its
 * code-action-fanout degradation; deleting both left the whole suite green.
 */
describe("#2504 r4 S-1 — the per-file code-action fan-out cap", () => {
	it("stops at the cap and records the warnings it did NOT report", async () => {
		const {
			buildActionableWarningsReport,
			ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE,
		} = await load();
		const files = makeFiles(path.join(tmpDir, "src"), 1);
		prime(files[0]);
		primedDiagnostics = warningDiagnostics(40);

		await buildActionableWarningsReport({
			cwd: tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map([
				// Keyed exactly as production keys it, per the read-guard
				// path-key rule: normalizeMapKey, never a hand-rolled lowercase.
				[normalizeMapKey(files[0]), [{ start: 1, end: 200 }]],
			]),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			// Room to spare: the CAP, not the clock, has to be what stops this.
			lspBudgetMs: 60_000,
		});

		expect(ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE).toBe(25);
		expect(codeAction.mock.calls.length).toBe(
			ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE,
		);
		const fanout = getDegradationSummary()
			.flatMap((group) => group.latestReasons)
			.filter((entry) => entry.subject.includes("code-action-fanout"));
		expect(fanout.length).toBe(1);
		// #2504 r4 (S-2): a capped warning is skipped BEFORE its record exists,
		// and an action-less record is dropped, so it is not reported at all.
		expect(fanout[0].reason).toContain("were NOT reported");
		expect(fanout[0].reason).not.toContain("reported without fix actions");
	});
});

// flake-shape: raw-timer-wait — the budget test's contract is real elapsed time: bounded() races the touch against a live wall deadline, and fake timers would settle the bound instantly, making the budget semantics unmeasurable. The assertions are on outcomes and counts, never elapsed ms.
/**
 * #3170 — the bounded persistent-reverify pass.
 *
 * Recurrence: a finding whose own file is unchanged re-serves turn after turn
 * from the persisted actionable-warnings report without ever being
 * re-observed — the in-band publish carries DEFERRED-origin entries while
 * their file has not moved, and the delta freshness gate passes them because
 * the file's mtime has not moved either. When the root cause was fixed in a
 * DIFFERENT file, the carried finding is stale in fact but fresh by every
 * on-disk axis.
 *
 * #3176 review-round contracts pinned here:
 * - **F3**: an empty touch is clean ONLY when the touch itself answers
 *   `confirmation: "confirmed"` — the house double's bare `{diags: []}`
 * silent empty is UNCONFIRMED (the false-clean the review caught).
 * - **F1**: the replacement folds into the turn's single in-band publish —
 *   the merge-level proof runs through the REAL CacheManager and publisher.
 * - Proof gaps: the candidate cap pinned to the LITERAL 4 (the constant
 *   →1000 mutation reds), `skippedChanged` asserted in the result AND the
 *   latency record, the budget break and the abort check mutation-sensitive.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const logLatencyMock = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	logLatency: (...args: unknown[]) => logLatencyMock(...args),
}));

import {
	runPersistentReverify,
	type ReverifyLspService,
} from "../../clients/persistent-reverify.js";
import type { TouchFileResult } from "../../clients/lsp/diagnostic-binding.js";
import type { LSPDiagnostic } from "../../clients/lsp/client.js";
import {
	formatActionableWarningsAdvisory,
	getActionableWarningsHistoryPath,
	publishActionableWarningsReport,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

const WARNING_MESSAGE = "'x' is declared but its value is never read.";

function makeCarriedReport(filePath: string): ActionableWarningsReport {
	const stamp = new Date().toISOString();
	return {
		generatedAt: stamp,
		scope: "turn_delta",
		sessionId: "s1",
		turnIndex: 1,
		deltaOnly: true,
		includeLspCodeActions: false,
		files: [
			{
				filePath,
				displayPath: "src/a.ts",
				origin: "deferred",
				generatedAt: stamp,
				warnings: [
					{
						id: "w1",
						filePath,
						displayPath: "src/a.ts",
						line: 1,
						severity: "warning",
						tool: "typescript",
						source: "ts",
						code: "6133",
						rule: "ts:6133",
						message: WARNING_MESSAGE,
						actions: [],
						suppressed: false,
						origin: "lsp",
					},
				],
			},
		],
		summary: {
			warnings: 1,
			unsuppressed: 1,
			suppressed: 0,
			files: 1,
			actions: 0,
			autoFixEligible: 0,
		},
	};
}

function makeDiag(): LSPDiagnostic {
	return {
		severity: 2,
		message: WARNING_MESSAGE,
		range: {
			start: { line: 0, character: 6 },
			end: { line: 0, character: 7 },
		},
		source: "ts",
		code: 6133,
	};
}

/** The touch double with the FULL TouchFileResult surface — the review's F3
 * point was that a narrowed type could not express `confirmation`, which is
 * exactly the field that separates a confirmed clean from a silent empty. */
interface TouchDouble {
	diags: LSPDiagnostic[];
	confirmation?: "confirmed" | "partial";
	unconfirmedServerIds?: string[];
	inconclusive?: boolean;
	skipReason?: "outside-project-root";
	diagnosticsUnsupportedServerIds?: string[];
}

function makeService(
	touchResult: TouchDouble | "throw",
	delayMs = 0,
	codeActions: Array<{ title: string; isPreferred?: boolean }> = [
		{ title: "Fix", isPreferred: true },
	],
): ReverifyLspService {
	const touchFile = vi.fn(async (): Promise<TouchFileResult> => {
		if (delayMs > 0)
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		if (touchResult === "throw") throw new Error("wedged server");
		// The silent-empty shape: `{diags: []}` with NO `confirmation` — the
		// house double's answer, and exactly the false-clean the review's F3
		// probe fired on.
		return touchResult;
	});
	const codeAction = vi.fn(async () => codeActions);
	// SAFETY: the pass reads only `touchFile`, and `enrichFileFromLsp` reads
	// only `codeAction` (the cached arm skips the pull) — the double provides
	// exactly the members the re-verify path reaches, cast to the real
	// service type whose remaining members this path never touches.
	return {
		touchFile,
		codeAction,
		getDiagnostics: vi.fn(async () => []),
		openFile: vi.fn(async () => undefined),
	} as unknown as import("../../clients/lsp/index.js").LSPService;
}

describe("persistent reverify (#3170)", () => {
	let tmpDir: string;
	let cwd: string;
	let filePath: string;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-reverify-"));
		cwd = tmpDir;
		filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const x = 1;\n");
		// Deterministic staleness fixtures: sub-millisecond mtime precision vs
		// integer-ms ISO stamps makes write-then-stamp ordering a coin flip —
		// pin the file's mtime to a known past instant instead.
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(filePath, past, past);
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
		logLatencyMock.mockClear();
		resetProjectLensConfigCache();
	});

	afterEach(() => {
		if (previousDataDir === undefined) {
			delete process.env.PILENS_DATA_DIR;
		} else {
			process.env.PILENS_DATA_DIR = previousDataDir;
		}
		removeTempDirSync(tmpDir);
	});

	it("C1: a confirmed-clean touch drops the carried finding — through the real CacheManager and publisher", async () => {
		const carried = makeCarriedReport(filePath);
		const cacheManager = new CacheManager(false);
		cacheManager.writeCache("actionable-warnings", carried, cwd);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({
				diags: [],
				confirmation: "confirmed",
			}),
		});
		expect(result.outcomes[0]?.outcome).toBe("clean");
		expect(result.touched).toBe(1);

		// F1: the replacement folds into the turn's single in-band publish —
		// through the REAL publisher and store, the carried warning is gone.
		publishActionableWarningsReport(
			cacheManager,
			cwd,
			{ ...carried, files: result.replacementFiles },
			{ origin: "in-band" },
		);
		const merged = cacheManager.readCache("actionable-warnings", cwd)
			?.data as ActionableWarningsReport;
		const mergedFile = merged.files.find((f) => f.filePath === filePath);
		expect(mergedFile?.warnings ?? []).toEqual([]);
	});

	it("C2: a re-confirmed finding is re-delivered as a fresh observation — supersede, not union", async () => {
		const carried = makeCarriedReport(filePath);
		const cacheManager = new CacheManager(false);
		cacheManager.writeCache("actionable-warnings", carried, cwd);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({
				diags: [makeDiag()],
				confirmation: "confirmed",
			}),
		});
		expect(result.outcomes[0]?.outcome).toBe("reconfirmed");
		const replacement = result.replacementFiles[0];
		expect(replacement?.warnings).toHaveLength(1);
		expect(replacement?.reVerified).toBe(true);

		publishActionableWarningsReport(
			cacheManager,
			cwd,
			{ ...carried, files: result.replacementFiles },
			{ origin: "in-band" },
		);
		const merged = cacheManager.readCache("actionable-warnings", cwd)
			?.data as ActionableWarningsReport;
		const mergedFile = merged.files.find((f) => f.filePath === filePath);
		// Supersede, not union: the carried record and the fresh record share
		// an id, but the assertion pins the fresh stamp won — one warning, and
		// it is the re-verified entry's.
		expect(mergedFile?.warnings).toHaveLength(1);
		expect(mergedFile?.generatedAt).toBeDefined();
	});

	it("F3: a silent empty touch (no confirmation) is UNCONFIRMED — the carried warnings are kept and the gap is labeled", async () => {
		const carried = makeCarriedReport(filePath);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			// The house double's silent-empty shape: `{diags: []}` with no
			// confirmation — exactly what the review's F3 probe fired on.
			lspService: makeService({ diags: [] }),
		});
		expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
		const replacement = result.replacementFiles[0];
		expect(replacement?.warnings).toHaveLength(1);
		expect(replacement?.warnings[0]?.message).toBe(WARNING_MESSAGE);
		expect(replacement?.reVerifyIncomplete).toBe(true);
	});

	it("R3-3: a PARTIAL confirmation is a completed touch — the primary's answer is honored, not labelled incomplete", async () => {
		const carried = makeCarriedReport(filePath);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			// Recurrence this guards (shape 10, silencing-as-fixing): the gate
			// read the literal `confirmation !== "confirmed"`, which
			// `diagnostic-binding.ts:274-288` exists to forbid. `partial` means
			// every server EXCEPT the named cut-off auxiliaries answered — the
			// notify write and the diagnostics wait both ran to completion, so
			// the primary's observation is exactly as trustworthy as a full
			// confirmation. Reading the literal labels a file the primary fully
			// answered `(re-verify incomplete)` and keeps a finding the fresh
			// observation just re-derived.
			lspService: makeService({
				diags: [makeDiag()],
				confirmation: "partial",
				unconfirmedServerIds: ["opengrep"],
			}),
		});
		expect(result.outcomes[0]?.outcome).toBe("reconfirmed");
		expect(result.touched).toBe(1);
		const replacement = result.replacementFiles[0];
		expect(replacement?.reVerified).toBe(true);
		expect(replacement?.reVerifyIncomplete).toBeUndefined();
	});

	it("F3b: a skipReason touch is unconfirmed for the same reason", async () => {
		const carried = makeCarriedReport(filePath);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({
				diags: [],
				skipReason: "outside-project-root",
			}),
		});
		expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
	});

	it("C3: a throwing touch keeps the carried entry verbatim and marks the gap", async () => {
		const carried = makeCarriedReport(filePath);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService("throw"),
		});
		expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
		const replacement = result.replacementFiles[0];
		expect(replacement?.warnings).toHaveLength(1);
		expect(replacement?.reVerifyIncomplete).toBe(true);
	});

	it("#3205: repeated incomplete re-verifies stay visible but do not grow observed history", async () => {
		// Recurrence: a failed re-verify is carried, not observed; publishing it
		// on successive turns must not append duplicate history rows.
		const carried = makeCarriedReport(filePath);
		const cacheManager = new CacheManager(false);
		cacheManager.writeCache("actionable-warnings", carried, cwd);
		const historyPath = getActionableWarningsHistoryPath(cwd);
		const historyLineCount = () =>
			fs.existsSync(historyPath)
				? fs.readFileSync(historyPath, "utf8").trimEnd().split("\n").length
				: 0;
		const failReverifyAndPublish = async () => {
			const result = await runPersistentReverify({
				report: carried,
				cwd,
				lspService: makeService("throw"),
			});
			expect(result.replacementFiles[0]?.reVerifyIncomplete).toBe(true);
			publishActionableWarningsReport(
				cacheManager,
				cwd,
				{ ...carried, files: result.replacementFiles },
				{ origin: "in-band" },
			);
		};

		await failReverifyAndPublish();
		const firstTurnLines = historyLineCount();
		const persisted = cacheManager.readCache("actionable-warnings", cwd)
			?.data as ActionableWarningsReport;
		const persistedFile = persisted.files.find(
			(file) => file.filePath === filePath,
		);
		expect(persistedFile?.reVerifyIncomplete).toBe(true);
		expect(formatActionableWarningsAdvisory(persisted, cwd)).toContain(
			"(re-verify incomplete)",
		);

		await failReverifyAndPublish();
		const secondTurnLines = historyLineCount();
		expect(secondTurnLines).toBe(firstTurnLines);
		expect(secondTurnLines).toBe(0);

		const fresh = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({
				diags: [makeDiag()],
				confirmation: "confirmed",
			}),
		});
		expect(fresh.replacementFiles[0]?.reVerified).toBe(true);
		publishActionableWarningsReport(
			cacheManager,
			cwd,
			{ ...carried, files: fresh.replacementFiles },
			{ origin: "in-band" },
		);
		expect(historyLineCount()).toBe(secondTurnLines + 1);
	});

	it("F6: an entry re-arms — the pass re-verifies it again on the next run", async () => {
		const carried = makeCarriedReport(filePath);
		const service = makeService({
			diags: [makeDiag()],
			confirmation: "confirmed",
		});
		const first = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: service,
		});
		expect(first.outcomes[0]?.outcome).toBe("reconfirmed");
		// The replacement IS the next turn's persisted state — and the entry
		// re-verifies AGAIN (no skip guard, #3176 F6). The skip-guard mutation
		// reds this: the second run would find zero candidates.
		const updated = { ...carried, files: first.replacementFiles };
		const second = await runPersistentReverify({
			report: updated,
			cwd,
			lspService: service,
		});
		expect(second.outcomes[0]?.outcome).toBe("reconfirmed");
		expect(second.touched).toBe(1);
	});

	it("F3-population: an entry with auxiliary-sourced warnings is not re-verified by a primary-scope touch", async () => {
		const carried = makeCarriedReport(filePath);
		carried.files[0]!.warnings[0]!.source = "opengrep";
		carried.files[0]!.warnings[0]!.rule = "opengrep:secret-rule";
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({
				diags: [],
				confirmation: "confirmed",
			}),
		});
		// A primary-scope touch cannot re-observe an auxiliary-lane finding —
		// the entry is kept verbatim (never scored dropped): outcomes empty,
		// no replacement.
		expect(result.outcomes).toEqual([]);
		expect(result.replacementFiles).toEqual([]);
	});

	it("C4: a file changed since its observation stamp is skipped — counted in the result and the latency record", async () => {
		const carried = makeCarriedReport(filePath);
		// The observation stamp predates the file's last write: the file has
		// moved since, so the edit path already re-observed it.
		carried.files[0]!.generatedAt = new Date(
			Date.now() - 120_000,
		).toISOString();
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({ diags: [], confirmation: "confirmed" }),
		});
		expect(result.outcomes).toEqual([]);
		expect(result.skippedChanged).toBe(1);
		// The proof gap the review named: `skippedChanged` was permanently 0.
		expect(logLatencyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "persistent_reverify",
				metadata: expect.objectContaining({ skippedChanged: 1 }),
			}),
		);
	});

	it("C5: the pass caps at exactly 4 candidates (the literal pin — the constant →1000 mutation reds this)", async () => {
		const carried = makeCarriedReport(filePath);
		const extra: ActionableWarningsReport["files"] = [];
		for (let i = 0; i < 5; i += 1) {
			const p = path.join(cwd, "src", `f${i}.ts`);
			fs.writeFileSync(p, `const v${i} = 1;\n`);
			const past = new Date(Date.now() - 60_000);
			fs.utimesSync(p, past, past);
			extra.push({
				...carried.files[0]!,
				filePath: p,
				displayPath: `src/f${i}.ts`,
			});
		}
		carried.files = [...extra, ...carried.files];
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({
				diags: [],
				confirmation: "confirmed",
			}),
		});
		// 6 deferred candidates, at most 4 re-observed — the literal pin.
		expect(result.candidates).toBe(4);
		expect(result.outcomes.length).toBe(4);
	});

	it("the abort signal stops the pass before any touch", async () => {
		const carried = makeCarriedReport(filePath);
		const controller = new AbortController();
		controller.abort();
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({
				diags: [],
				confirmation: "confirmed",
			}),
			signal: controller.signal,
		});
		expect(result.outcomes).toEqual([]);
		expect(result.touched).toBe(0);
	});

	it("the wall budget stops the pass between files — later candidates are re-armed, not half-verified", async () => {
		const carried = makeCarriedReport(filePath);
		const second = path.join(cwd, "src", "b.ts");
		fs.writeFileSync(second, "const y = 1;\n");
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(second, past, past);
		carried.files = [
			carried.files[0]!,
			{ ...carried.files[0]!, filePath: second, displayPath: "src/b.ts" },
		];
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			// The touch sleeps 400ms against a 200ms budget: the bound-wrapped
			// touch comes back unconfirmed and the pass re-arms the rest.
			lspService: makeService({ diags: [], confirmation: "confirmed" }, 400, [
				{ title: "Fix", isPreferred: true },
			]),
			budgetMs: 200,
		});
		// The first candidate's touch is bound-wrapped at the remaining
		// budget and comes back unconfirmed; the loop then breaks — the
		// second candidate is re-armed for the next turn, never half-verified.
		expect(result.outcomes.length).toBeLessThanOrEqual(1);
		expect(result.touched).toBe(0);
		// R3-4: the record says how many candidates the budget cut. Without
		// `skippedBudget` the phase row reads "2 candidates, 0 touched" and
		// nothing distinguishes a budget cut from a server that answered
		// nothing — the pull-only-observability shape (31) the review named.
		expect(logLatencyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "persistent_reverify",
				metadata: expect.objectContaining({
					candidates: 2,
					skippedBudget: 1,
				}),
			}),
		);
	});

	it("F1-probe: a re-confirmed finding is still in the advisory after the fold", async () => {
		const carried = makeCarriedReport(filePath);
		const cacheManager = new CacheManager(false);
		cacheManager.writeCache("actionable-warnings", carried, cwd);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({
				diags: [makeDiag()],
				confirmation: "confirmed",
			}),
		});
		// The maintainer's demanded F1 proof: the re-confirmed finding is
		// still in the turn-end advisory after the fold — not deleted by the
		// marker spend.
		publishActionableWarningsReport(
			cacheManager,
			cwd,
			{ ...carried, files: result.replacementFiles },
			{ origin: "in-band" },
		);
		const merged = cacheManager.readCache("actionable-warnings", cwd)
			?.data as ActionableWarningsReport;
		const advisory = formatActionableWarningsAdvisory(merged, cwd);
		// The advisory renders per-file counts: the re-confirmed finding is
		// still in it — the file entry survived the marker spend with its
		// warning intact and counted.
		expect(advisory).toContain("src/a.ts: 1");
		expect(advisory).not.toContain("(re-verify incomplete)");
		const mergedFile = merged.files.find((f) => f.filePath === filePath);
		expect(mergedFile?.warnings).toHaveLength(1);
		expect(mergedFile?.warnings[0]?.message).toBe(WARNING_MESSAGE);
	});

	it("the advisory renders the re-verify gap label", () => {
		const carried = makeCarriedReport(filePath);
		carried.files[0]!.reVerifyIncomplete = true;
		const advisory = formatActionableWarningsAdvisory(carried, cwd);
		expect(advisory).toContain("(re-verify incomplete)");
	});
});

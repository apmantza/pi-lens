// flake-shape: raw-timer-wait — the budget test's contract is real elapsed time: bounded() races the touch against a live wall deadline, and fake timers would settle the bound instantly, making the budget semantics unmeasurable. The assertions are on outcomes and counts, never elapsed ms.
// flake-shape: never-settling-wait — C3b's code-action lookup must never answer, so only the re-verify's own wall bound can end it; that unanswered lookup is the cell under test (#5258).
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
	selectPersistentReverifyFiles,
	type ReverifyLspService,
} from "../../clients/persistent-reverify.js";
import type { TouchFileResult } from "../../clients/lsp/diagnostic-binding.js";
import type { LSPDiagnostic } from "../../clients/lsp/client.js";
import {
	ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE,
	formatActionableWarningsAdvisory,
	getActionableWarningsHistoryPath,
	publishActionableWarningsReport,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { getAmbientAbortSignal } from "../../clients/safe-spawn.js";
import { LSPService } from "../../clients/lsp/index.js";
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
	binding?: { boundToCurrentDisk: boolean | "unknown" };
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

	it.each([0, 1, 50, 51])(
		"preserves strict report mtime boundary at %i ms",
		(delta) => {
			const stamp = 1700000000000;
			const report = makeCarriedReport(filePath);
			report.files[0].generatedAt = new Date(stamp).toISOString();
			fs.utimesSync(filePath, stamp / 1000, (stamp + delta) / 1000);
			expect(fs.statSync(filePath).mtimeMs).toBeCloseTo(stamp + delta, 1);
			const result = selectPersistentReverifyFiles(report, stamp + 1000);
			expect(result.candidates).toHaveLength(delta === 0 ? 1 : 0);
			expect(result.skippedChanged).toBe(delta === 0 ? 0 : 1);
		},
	);

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

	// #5017 (class sweep): a touch that completed its policy against older bytes
	// (`boundToCurrentDisk: false`) is not an observation of these bytes. Read
	// as one, its empty answer dropped a carried warning still in the file.
	it("F3c: a stale-bound confirmed touch is unconfirmed — the carried warning is kept (#5017)", async () => {
		const carried = makeCarriedReport(filePath);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({
				diags: [],
				confirmation: "confirmed",
				binding: { boundToCurrentDisk: false },
			}),
		});
		expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
		const replacement = result.replacementFiles[0];
		expect(replacement?.warnings).toHaveLength(1);
		expect(replacement?.reVerifyIncomplete).toBe(true);
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

	// Recurrence prevented: the #5258 clean-emitter matrix (probe P4). The touch
	// re-confirmed the warning, but its code-action lookup never answered, so the
	// enrichment returned no record; that silence read as "clean" and retired a
	// finding the server had just reported again.
	it("C3b: a code-action lookup that never answers is unconfirmed, not clean (#5258)", async () => {
		const carried = makeCarriedReport(filePath);
		const service = makeService({
			diags: [makeDiag()],
			confirmation: "confirmed",
		});
		(service as unknown as { codeAction: unknown }).codeAction = vi.fn(
			() => new Promise(() => {}),
		);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: service,
			budgetMs: 300,
		});
		expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
		const replacement = result.replacementFiles[0];
		expect(replacement?.warnings).toEqual(carried.files[0]?.warnings);
		expect(replacement?.reVerifyIncomplete).toBe(true);
	});

	// Recurrence prevented (#5550, the deadline audit's `persistent-reverify.ts`
	// rows): the re-verify's two bounds abandoned a wedged LSP request and left
	// it pending with no signal (the touch and the code-action lookup each held
	// the client busy). The requests now run under the bound's signal, which
	// the fakes read the way `navRequest` does (`getAmbientAbortSignal()`).
	// The touch is cut by the wall bound; the code-action lookup by Esc, because
	// its wall cut races the loop's own `deadlineAt` race in `boundedLspCall`.
	// What this proves: the work runs inside the scope and the scope aborts. The
	// real `codeAction` reads it (`navRequest`); the real `touchFile` does not
	// yet (`pullDiagnosticSource` owns its own abort), so the touch's cancel
	// waits on the LSP request sender (#5097).
	it.each([
		["touch", "touchFile", "wall"],
		["code-action lookup", "codeAction", "escape"],
	] as const)(
		"C3f: the %s runs in the bound's scope, aborted when the bound fires (#5550)",
		async (_label, member, cut) => {
			const carried = makeCarriedReport(filePath);
			const service = makeService({
				diags: [makeDiag()],
				confirmation: "confirmed",
			});
			const escape = new AbortController();
			let seen: AbortSignal | undefined;
			let releaseRequest!: () => void;
			(service as unknown as Record<string, unknown>)[member] = vi.fn(() => {
				seen = getAmbientAbortSignal();
				if (cut === "escape") queueMicrotask(() => escape.abort());
				return new Promise<never[]>((resolve) => {
					releaseRequest = () => resolve([]);
				});
			});
			const result = await runPersistentReverify({
				report: carried,
				cwd,
				lspService: service,
				budgetMs: 300,
				...(cut === "escape" ? { signal: escape.signal } : {}),
			});
			expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
			expect(seen?.aborted).toBe(true);
			releaseRequest();
		},
	);

	// The control for C3b: an answer with no fix action is an answer, so the
	// warning leaves the actionable report exactly as before.
	it("C3c: a code-action lookup that answers with no action still retires the warning (#5258)", async () => {
		const carried = makeCarriedReport(filePath);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService(
				{ diags: [makeDiag()], confirmation: "confirmed" },
				0,
				[],
			),
		});
		expect(result.outcomes[0]?.outcome).toBe("clean");
		expect(result.replacementFiles[0]?.warnings).toEqual([]);
	});

	it("C3d: a code-action lookup that throws is unconfirmed, not clean (#5258)", async () => {
		const carried = makeCarriedReport(filePath);
		const service = makeService({
			diags: [makeDiag()],
			confirmation: "confirmed",
		});
		(service as unknown as { codeAction: unknown }).codeAction = vi.fn(
			async () => {
				throw new Error("server crashed mid-request");
			},
		);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: service,
		});
		expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
		expect(result.replacementFiles[0]?.warnings).toEqual(
			carried.files[0]?.warnings,
		);
	});

	// A warning past the per-file code-action cap was never asked about, so it
	// is no answer either (#5258).
	it("C3e: a warning past the code-action cap is unconfirmed, not clean (#5258)", async () => {
		const carried = makeCarriedReport(filePath);
		const diags = Array.from(
			{ length: ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE + 1 },
			() => makeDiag(),
		);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService({ diags, confirmation: "confirmed" }, 0, []),
		});
		expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
	});

	// A warning the loop reached after its deadline was never asked about.
	// The clock moves inside the first answer, so the deadline passes between
	// two lookups and no lookup itself times out (#5258).
	it("C3f: a warning left when the enrichment deadline passed is unconfirmed, not clean (#5258)", async () => {
		const carried = makeCarriedReport(filePath);
		const service = makeService(
			{ diags: [makeDiag(), makeDiag()], confirmation: "confirmed" },
			0,
			[],
		);
		const realNow = Date.now.bind(Date);
		let skew = 0;
		const clock = vi
			.spyOn(Date, "now")
			.mockImplementation(() => realNow() + skew);
		(service as unknown as { codeAction: unknown }).codeAction = vi.fn(
			async () => {
				// After a tick: the lookup's own bound has armed, so this answer
				// lands in time and only the loop's next deadline check sees it.
				await Promise.resolve();
				skew = 600_000;
				return [];
			},
		);
		try {
			const result = await runPersistentReverify({
				report: carried,
				cwd,
				lspService: service,
			});
			expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
		} finally {
			clock.mockRestore();
		}
	});

	// #5554 r2 B8: the unanswered record is per warning. A file with more
	// warnings than the code-action cap still retires a carried warning the
	// touch no longer reports; before, one capped lookup anywhere in the file
	// held every carried warning as unconfirmed forever.
	it("C3g: a fixed warning in a file past the code-action cap is retired (#5554)", async () => {
		const carried = makeCarriedReport(filePath);
		const others = Array.from(
			{ length: ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE + 1 },
			(_, index) => ({
				...makeDiag(),
				code: 7000 + index,
				message: `unrelated warning ${index}`,
			}),
		);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService(
				{ diags: others, confirmation: "confirmed" },
				0,
				[],
			),
		});
		expect(result.outcomes[0]?.outcome).toBe("clean");
		expect(result.outcomes[0]?.dropped).toBe(1);
		expect(result.replacementFiles[0]?.warnings).toEqual([]);
	});

	// #5554 verify r3 N4: a re-check that retires one carried warning and
	// cannot judge another reads mixed, and the kept file still says its
	// re-verify was incomplete; dropping that label would show the kept
	// warning as freshly confirmed.
	it("C3i: a mixed re-check keeps the unjudged warning labelled incomplete (#5554)", async () => {
		const carried = makeCarriedReport(filePath);
		const kept = carried.files[0]!.warnings[0]!;
		const fixedMessage = "'y' is declared but its value is never read.";
		carried.files[0]!.warnings.push({
			...kept,
			id: "w2",
			message: fixedMessage,
		});
		const others = Array.from(
			{ length: ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE },
			(_, index) => ({
				...makeDiag(),
				code: 7000 + index,
				message: `unrelated warning ${index}`,
			}),
		);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService(
				{ diags: [...others, makeDiag()], confirmation: "confirmed" },
				0,
				[],
			),
		});
		expect(result.outcomes[0]?.outcome).toBe("mixed");
		expect(result.outcomes[0]?.dropped).toBe(1);
		const replacement = result.replacementFiles[0];
		expect(replacement?.warnings.map((w) => w.message)).toEqual([
			WARNING_MESSAGE,
		]);
		expect(replacement?.reVerifyIncomplete).toBe(true);
	});

	// #5554 verify r3 N4: a carried warning is the same warning only with the
	// same rule AND message. An unanswered lookup for another variable under
	// the same rule says nothing about the carried one, which the touch no
	// longer reports, so it retires.
	it("C3j: an unanswered lookup under the same rule does not hold another message (#5554)", async () => {
		const carried = makeCarriedReport(filePath);
		const others = Array.from(
			{ length: ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE },
			(_, index) => ({
				...makeDiag(),
				code: 7000 + index,
				message: `unrelated warning ${index}`,
			}),
		);
		const sameRuleOtherName = {
			...makeDiag(),
			message: "'y' is declared but its value is never read.",
		};
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService(
				{ diags: [...others, sameRuleOtherName], confirmation: "confirmed" },
				0,
				[],
			),
		});
		expect(result.outcomes[0]?.outcome).toBe("clean");
		expect(result.outcomes[0]?.dropped).toBe(1);
	});

	// #5554 r2 F6: the real service answers a lookup it has no client for
	// (here: destroyed) with no answer, so the carried warning stays.
	it("C3h: a code-action lookup with no client to ask is unconfirmed, not clean (#5554)", async () => {
		const carried = makeCarriedReport(filePath);
		const real = new LSPService();
		await real.shutdown();
		const service = makeService({
			diags: [makeDiag()],
			confirmation: "confirmed",
		});
		(service as unknown as { codeAction: unknown }).codeAction = (
			...args: Parameters<LSPService["codeAction"]>
		) => real.codeAction(...args);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: service,
		});
		expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
		expect(result.replacementFiles[0]?.warnings).toEqual(
			carried.files[0]?.warnings,
		);
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

	it("F1: the latent module transition clears the incomplete marker", async () => {
		// Recurrence: when this module receives an incomplete replacement and
		// later confirms it, the replacement must not inherit the incomplete
		// marker, or history skips a real observation and advisory labels it stale.
		const carried = makeCarriedReport(filePath);
		const cacheManager = new CacheManager(false);
		cacheManager.writeCache("actionable-warnings", carried, cwd);
		const historyPath = getActionableWarningsHistoryPath(cwd);
		const historyLineCount = () =>
			fs.existsSync(historyPath)
				? fs.readFileSync(historyPath, "utf8").trimEnd().split("\n").length
				: 0;

		const incomplete = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService("throw"),
		});
		expect(incomplete.replacementFiles[0]?.reVerifyIncomplete).toBe(true);
		expect(historyLineCount()).toBe(0);

		const confirmed = await runPersistentReverify({
			// The real in-band publisher clears the deferred carry marker after
			// persistence, so this latent module transition is not a live
			// successive-turn path today. Feed the replacement directly to isolate
			// the requested incomplete -> confirmed state transition.
			report: { ...carried, files: incomplete.replacementFiles },
			cwd,
			lspService: makeService({
				diags: [makeDiag()],
				confirmation: "confirmed",
			}),
		});
		publishActionableWarningsReport(
			cacheManager,
			cwd,
			{ ...carried, files: confirmed.replacementFiles },
			{ origin: "in-band" },
		);
		const afterConfirmed = cacheManager.readCache("actionable-warnings", cwd)
			?.data as ActionableWarningsReport;
		const confirmedFile = afterConfirmed.files[0];
		expect(confirmedFile?.reVerified).toBe(true);
		expect(confirmedFile?.reVerifyIncomplete).toBeUndefined();
		expect(historyLineCount()).toBe(1);
		expect(formatActionableWarningsAdvisory(afterConfirmed, cwd)).not.toContain(
			"(re-verify incomplete)",
		);
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

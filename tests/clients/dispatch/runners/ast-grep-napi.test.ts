import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	makeRunnerCtx,
	type RunnerCtxOverrides,
} from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { mockAuxiliaryLspPublished, fsSyncOverrides } = vi.hoisted(() => ({
	mockAuxiliaryLspPublished: vi.fn().mockResolvedValue(false),
	// #2324 R3-B: `vi.spyOn` cannot redefine a `node:fs` ESM namespace export
	// ("Module namespace is not configurable"). Route `statSync`/`readFileSync`
	// through an overridable indirection instead — real `node:fs` by default
	// for every OTHER test in this file, throwing only when a test sets its
	// own override, always reset to undefined afterward.
	fsSyncOverrides: {
		statSync: undefined as ((...args: unknown[]) => unknown) | undefined,
		readFileSync: undefined as ((...args: unknown[]) => unknown) | undefined,
	},
}));

vi.mock("../../../../clients/lsp/index.js", () => ({
	hasAuxiliaryLspPublishedForRoot: mockAuxiliaryLspPublished,
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		statSync: (...args: unknown[]) =>
			fsSyncOverrides.statSync
				? fsSyncOverrides.statSync(...args)
				: // biome-ignore lint/suspicious/noExplicitAny: node:fs overload set
					(actual.statSync as any)(...args),
		readFileSync: (...args: unknown[]) =>
			fsSyncOverrides.readFileSync
				? fsSyncOverrides.readFileSync(...args)
				: // biome-ignore lint/suspicious/noExplicitAny: node:fs overload set
					(actual.readFileSync as any)(...args),
	};
});

// Mock heavy dependencies before importing the runner
vi.mock("../../../../clients/tool-policy.js", () => ({
	hasEslintConfig: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../../clients/dispatch/runners/yaml-rule-parser.js", () => ({
	loadYamlRules: vi.fn().mockReturnValue([]),
	// #3053 round 2 F3: the fold's shared `ast-grep-catalog.ts` calls this for
	// every "project"-origin source (`buildEffectiveAstGrepCatalog`), which
	// `evaluateAstGrepRules` now reaches transitively — no case in this file
	// creates a project rules dir today, so the gap was silent, but any
	// future one would hit vitest's "No export defined on the mock" instead
	// of a clean empty-array skip.
	loadYamlRulesFresh: vi.fn().mockReturnValue([]),
	isOverlyBroadPattern: vi.fn().mockReturnValue(false),
	isStructuredRule: vi.fn().mockReturnValue(false),
	calculateRuleComplexity: vi.fn().mockReturnValue(1),
	MAX_BLOCKING_RULE_COMPLEXITY: 10,
}));

vi.mock("../../../../clients/package-root.js", () => ({
	resolvePackagePath: vi.fn().mockReturnValue("/nonexistent/path"),
}));

function createCtx(filePath: string, overrides: RunnerCtxOverrides = {}) {
	return makeRunnerCtx(filePath, path.dirname(filePath), {
		blockingOnly: false,
		// Default to the fallback path: the ast-grep LSP supersedes this runner
		// when its binary is available (#239 Phase 2), so to exercise napi's own
		// matching we simulate the binary being ABSENT. The gate is tested
		// explicitly below by overriding hasTool.
		hasTool: async (cmd: string) => cmd !== "ast-grep",
		...overrides,
	});
}

function mockWorkingSgLoad(): void {
	vi.doMock("@ast-grep/napi", () => ({
		ts: {
			parse: vi.fn().mockReturnValue({
				root: () => ({
					children: () => [],
					kind: () => "program",
					range: () => ({
						start: { line: 0, column: 0 },
						end: { line: 1, column: 0 },
					}),
					findAll: () => [],
				}),
			}),
		},
		// #2324 R2-B: declared but undefined, matching an addon build that
		// dropped a grammar (#2215) — `getLang` must read this as "no parser
		// for html", not throw on an undeclared mock export.
		html: undefined,
	}));
}

// Every case installs its own @ast-grep/napi double; resetModules does not clear
// the mock registry, so drop it after each case (#2883).
afterEach(() => {
	vi.doUnmock("@ast-grep/napi");
});

describe("ast-grep-napi runner — LSP supersede gate (#239 Phase 2)", () => {
	beforeEach(() => {
		vi.resetModules();
		mockAuxiliaryLspPublished.mockResolvedValue(false);
	});

	it("runs until the bundled LSP completes its first root publication", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-gate-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const r = arr.sort();\n"); // would match no-sort-without-comparator
			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("succeeded");
			expect(result.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("runs when the launcher binary and PATH are unavailable and no client is live", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-gate-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("succeeded");
		} finally {
			env.cleanup();
		}
	});

	it("skips after the ast-grep LSP completes its first root publication", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-gate-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			mockAuxiliaryLspPublished.mockResolvedValue(true);
			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	// The fallback-RUNS direction (binary absent → napi matches) is covered
	// comprehensively by ast-grep-sonar-rules.test.ts, whose ctx now defaults to
	// hasTool('ast-grep') === false. Asserting it here too would require a working
	// @ast-grep/napi mock and collides with the doMock in the skip-path suite.
});

describe("ast-grep-napi runner — late-auxiliary dedupe (#2324 F3/R2)", () => {
	beforeEach(() => {
		vi.resetModules();
		mockAuxiliaryLspPublished.mockResolvedValue(false);
	});

	// #2324 R2-A: production can NEVER see a pending pair for THIS touch by
	// the time napi's clear runs — the wait that marks a pair for this touch
	// takes up to its own grace budget (~1800ms), strictly LONGER than napi's
	// Gate-B check plus rule evaluation. Any pair visible here is therefore a
	// LEFTOVER from an EARLIER touch, describing a PREVIOUS revision this
	// fresh evaluation supersedes — clearing it is correct. The mark-vs-clear
	// RACE for THIS touch's own pair is closed on the OTHER side, in
	// service-aux-grace.test.ts, where the aux-grace wait consults
	// `napiFallbackCoveredSince` before it ever marks.
	it("clears a leftover pending pair from an earlier touch once it actually evaluates rules", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-dedupe-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			// A leftover pair from an EARLIER touch, still undelivered.
			pendingAux.markPendingAuxiliaryCoverage(filePath, ["ast-grep"]);
			expect(pendingAux.hasPendingAuxiliaryCoverage(filePath, "ast-grep")).toBe(
				true,
			);

			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("succeeded");

			// This fresh evaluation supersedes the leftover pair.
			expect(pendingAux.hasPendingAuxiliaryCoverage(filePath, "ast-grep")).toBe(
				false,
			);
			pendingAux.resetPendingAuxiliaryCoverage();
		} finally {
			env.cleanup();
		}
	});

	// #2324 R2-B: the clear/record must sit AFTER every early-return skip —
	// loadSg failure, missing file, unresolved language, stat/size/read/parse
	// failure — not at Gate B's decision point. A run that never reaches rule
	// evaluation did not actually cover the file, so it must not consume a
	// pending pair a genuine late LSP delivery still needs. Reproduces the
	// reviewer's probe: an .html file the mocked sg module has no parser for
	// (`mockWorkingSgLoad` only registers `ts`), so `getLang` returns
	// undefined and napi skips before ever touching rules.
	it("preserves a pending late-auxiliary pair when napi never reaches rule evaluation", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-dedupe-");
		try {
			const filePath = path.join(env.tmpDir, "file.html");
			fs.writeFileSync(
				filePath,
				"<div>unparsed by the mocked sg module</div>\n",
			);
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			pendingAux.markPendingAuxiliaryCoverage(filePath, ["ast-grep"]);
			expect(pendingAux.hasPendingAuxiliaryCoverage(filePath, "ast-grep")).toBe(
				true,
			);

			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");

			// Napi never evaluated a rule for this file — the pending pair, and
			// the LSP's legitimate late delivery it represents, must survive.
			expect(pendingAux.hasPendingAuxiliaryCoverage(filePath, "ast-grep")).toBe(
				true,
			);
			pendingAux.resetPendingAuxiliaryCoverage();
		} finally {
			env.cleanup();
		}
	});
});

describe("ast-grep-napi runner — skip paths", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("skips unsupported file extensions", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-");
		try {
			const filePath = path.join(env.tmpDir, "file.py");
			fs.writeFileSync(filePath, "print('hello')\n");

			// Mock @ast-grep/napi so loadSg succeeds
			vi.doMock("@ast-grep/napi", () => ({
				ts: { parse: vi.fn() },
				js: { parse: vi.fn() },
				tsx: { parse: vi.fn() },
				css: { parse: vi.fn() },
				html: { parse: vi.fn() },
			}));

			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const runner = mod.default;
			const result = await runner.run(createCtx(filePath) as any);
			expect(result.status).toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	it("skips when @ast-grep/napi cannot be loaded", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			vi.doMock("@ast-grep/napi", () => {
				throw new Error("module not found");
			});

			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const runner = mod.default;
			const result = await runner.run(createCtx(filePath) as any);
			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("skips when file does not exist", async () => {
		vi.doMock("@ast-grep/napi", () => ({
			ts: { parse: vi.fn() },
			js: { parse: vi.fn() },
			tsx: { parse: vi.fn() },
			css: { parse: vi.fn() },
			html: { parse: vi.fn() },
		}));

		const mod =
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
		const runner = mod.default;
		const result = await runner.run(createCtx("/nonexistent/file.ts") as any);
		expect(result.status).toBe("skipped");
	});

	it("returns succeeded with no diagnostics when no rules are loaded", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			const mockParse = vi.fn().mockReturnValue({
				root: vi.fn().mockReturnValue({
					children: vi.fn().mockReturnValue([]),
					kind: vi.fn().mockReturnValue("program"),
					range: vi.fn().mockReturnValue({
						start: { line: 0, column: 0 },
						end: { line: 1, column: 0 },
					}),
					findAll: vi.fn().mockReturnValue([]),
				}),
			});

			vi.doMock("@ast-grep/napi", () => ({
				ts: { parse: mockParse },
				js: { parse: mockParse },
				tsx: { parse: mockParse },
				css: { parse: mockParse },
				html: { parse: mockParse },
			}));

			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const runner = mod.default;
			const result = await runner.run(createCtx(filePath) as any);
			expect(result.diagnostics).toHaveLength(0);
			expect(["skipped", "succeeded"]).toContain(result.status);
		} finally {
			env.cleanup();
		}
	});
});

describe("ast-grep-napi runner — real shipped rule", () => {
	it("loads and matches no-sort-without-comparator through the real YAML parser", async () => {
		vi.resetModules();
		mockAuxiliaryLspPublished.mockResolvedValue(false);
		vi.doUnmock("../../../../clients/dispatch/runners/yaml-rule-parser.js");
		vi.doUnmock("../../../../clients/package-root.js");
		// Earlier skip-path cases install per-test NAPI mocks. Replace any
		// lingering doMock registration with the package's real implementation.
		vi.doMock("@ast-grep/napi", async (importOriginal) => importOriginal());
		const env = setupTestEnvironment("pi-lens-ast-grep-real-rule-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const sorted = values.sort();\n");
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			expect(await mod.loadSg()).toBeDefined();

			const result = await mod.default.run(
				createCtx(filePath, {
					cwd: env.tmpDir,
					hasTool: async () => false,
				}) as any,
			);

			expect(result.status).toBe("succeeded");
			expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).toContain(
				"no-sort-without-comparator",
			);
		} finally {
			env.cleanup();
		}
	}, 30_000);
});

describe("ast-grep-napi runner — metadata", () => {
	it("has expected runner id and appliesTo", async () => {
		vi.resetModules();
		const mod =
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
		const runner = mod.default;
		expect(runner.id).toBe("ast-grep-napi");
		expect(runner.appliesTo).toContain("jsts");
	});
});

// #2324 F2/R2-C: the residual "published once, silent now" loss is a bounded
// `aux-runner-findings-lost` degradation, not a re-run. Neutering the branch
// that records it must turn this test red — the finding the review round
// caught was that no test referenced the record at all, so the branch could
// be deleted with the suite staying green.
describe("ast-grep-napi runner — aux-runner-findings-lost degradation (#2324 R2-C)", () => {
	beforeEach(() => {
		vi.resetModules();
		mockAuxiliaryLspPublished.mockResolvedValue(false);
	});

	it("records the loss when Gate B skips on a leftover pending pair", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-loss-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			// #2324 R2-C: dynamically imported AFTER vi.resetModules() so this is
			// the SAME module instance (and the same ledger state) the runner
			// module below resolves — a static top-of-file import would bind to
			// a stale pre-reset instance and this test would fail for the wrong
			// reason.
			const ledger = await import("../../../../clients/degradation-ledger.js");
			ledger.resetDegradationLedger();
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			// A leftover pair from an earlier touch — by R2-A's ordering, the
			// only shape a pair can take by the time this synchronous check
			// runs (this touch's own mark, if any, is decided strictly later).
			pendingAux.markPendingAuxiliaryCoverage(filePath, ["ast-grep"]);

			// Gate B: the per-file publication gate reads "published" (a prior
			// touch's publication), so napi is about to skip.
			mockAuxiliaryLspPublished.mockResolvedValue(true);
			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");

			const group = ledger
				.getDegradationSummary()
				.find((g) => g.kind === "aux-runner-findings-lost");
			expect(group).toBeDefined();
			expect(group?.count).toBe(1);
			expect(group?.latestReasons[0]?.subject).toBe("ast-grep");
			// The reason must describe an EARLIER-touch leftover, not this
			// touch's own aux-grace outcome — R2-C's corrected claim.
			expect(group?.latestReasons[0]?.reason).toContain("EARLIER touch");
			pendingAux.resetPendingAuxiliaryCoverage();
			ledger.resetDegradationLedger();
		} finally {
			env.cleanup();
		}
	});

	it("does not record the loss when no pending pair exists (a clean skip)", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-loss-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			const ledger = await import("../../../../clients/degradation-ledger.js");
			ledger.resetDegradationLedger();
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();

			mockAuxiliaryLspPublished.mockResolvedValue(true);
			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
			expect(
				ledger
					.getDegradationSummary()
					.find((g) => g.kind === "aux-runner-findings-lost"),
			).toBeUndefined();
			ledger.resetDegradationLedger();
		} finally {
			env.cleanup();
		}
	});
});

// #2324 R3-B: the R2-A ordering fix depends on the PRODUCER write
// (`recordNapiFallbackCoverage`) actually firing when napi evaluates rules,
// and NOT firing on any of napi's early-return skips. The prior round's
// tests only exercised the CONSUMER side (`hasPendingAuxiliaryCoverage`
// after a manually pre-marked pair), so no-opping the producer write left
// every existing test green — this pins the write directly.
describe("ast-grep-napi runner — napiFallbackCoveredSince producer pin (#2324 R3-B)", () => {
	beforeEach(() => {
		vi.resetModules();
		mockAuxiliaryLspPublished.mockResolvedValue(false);
	});

	it("ARM A: records coverage after a real rule evaluation", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-r3b-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			const before = Date.now();

			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).not.toBe("skipped");
			expect(pendingAux.napiFallbackCoveredSince(filePath, before)).toBe(true);
			pendingAux.resetPendingAuxiliaryCoverage();
		} finally {
			env.cleanup();
		}
	});

	it("ARM B1: does not record coverage when loadSg fails", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-r3b-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			const before = Date.now();

			vi.doMock("@ast-grep/napi", () => {
				throw new Error("native module failed");
			});
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
			expect(pendingAux.napiFallbackCoveredSince(filePath, before)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("ARM B2: does not record coverage when the file does not exist", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-r3b-");
		try {
			const filePath = path.join(env.tmpDir, "missing.ts");
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			const before = Date.now();

			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
			expect(pendingAux.napiFallbackCoveredSince(filePath, before)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("ARM B3: does not record coverage when the language grammar is unresolved", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-r3b-");
		try {
			const filePath = path.join(env.tmpDir, "file.html");
			fs.writeFileSync(filePath, "<div>no html export in the mock</div>\n");
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			const before = Date.now();

			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
			expect(pendingAux.napiFallbackCoveredSince(filePath, before)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("ARM B4: does not record coverage when statSync throws", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-r3b-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			const before = Date.now();

			fsSyncOverrides.statSync = () => {
				throw new Error("stat failed");
			};
			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
			expect(pendingAux.napiFallbackCoveredSince(filePath, before)).toBe(false);
		} finally {
			fsSyncOverrides.statSync = undefined;
			env.cleanup();
		}
	});

	it("ARM B5: does not record coverage when the file exceeds the size cap", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-r3b-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				`const big = "${"x".repeat(1024 * 1024 + 1)}";\n`,
			);
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			const before = Date.now();

			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
			expect(pendingAux.napiFallbackCoveredSince(filePath, before)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("ARM B6: does not record coverage when readFileSync throws", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-r3b-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			const before = Date.now();

			fsSyncOverrides.readFileSync = () => {
				throw new Error("read failed");
			};
			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
			expect(pendingAux.napiFallbackCoveredSince(filePath, before)).toBe(false);
		} finally {
			fsSyncOverrides.readFileSync = undefined;
			env.cleanup();
		}
	});

	it("ARM B7: does not record coverage when the grammar fails to parse", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-r3b-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			const before = Date.now();

			vi.doMock("@ast-grep/napi", () => ({
				ts: {
					parse: vi.fn(() => {
						throw new Error("parse failed");
					}),
				},
			}));
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
			expect(pendingAux.napiFallbackCoveredSince(filePath, before)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("ARM B8: does not record coverage when the parsed root cannot be read", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-r3b-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			const pendingAux =
				await import("../../../../clients/lsp/pending-aux-coverage.js");
			pendingAux.resetPendingAuxiliaryCoverage();
			const before = Date.now();

			vi.doMock("@ast-grep/napi", () => ({
				ts: {
					parse: vi.fn().mockReturnValue({
						root: () => {
							throw new Error("root failed");
						},
					}),
				},
			}));
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
			expect(pendingAux.napiFallbackCoveredSince(filePath, before)).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

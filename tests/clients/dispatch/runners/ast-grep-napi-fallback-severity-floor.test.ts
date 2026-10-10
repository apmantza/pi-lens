/**
 * #2336 — the napi fallback must publish at the ast-grep LSP's severity floor.
 *
 * `ast-grep-napi` exists to SUBSTITUTE for the ast-grep auxiliary LSP when that
 * server has not published for the file's root (#239 Phase 2 Gate B, #2324/#2329
 * Gate B). The LSP publishes every rule at its declared severity — the auxiliary
 * profile says so in words (clients/dispatch/auxiliary-lsp.ts:179-183: "the rule
 * severity is deliberate, so preserve ast-grep's severity semantics"). The
 * substitute did not: it applied the per-edit `blockingOnly` floor, which drops
 * every rule whose declared severity is not `error` — 380 of the 481 bundled
 * rules. Result: across the entire retained log history the napi runner reported
 * zero diagnostics in 255 dispatch records, so the #2329 dedupe seam had never
 * once run with a finding in hand.
 *
 * These tests drive the REAL dispatch path (`dispatchLintDetailed`, real context,
 * real file-kind to runner selection, real napi engine, real bundled rules) with
 * the production per-edit floor `blockingOnly: true`.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	napiFallbackCoveredSince,
	resetNapiFallbackCoverageForTests,
} from "../../../../clients/lsp/pending-aux-coverage.js";
import {
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

const { mockAuxiliaryLspPublished, recordEntitySnapshotDiffMock } = vi.hoisted(
	() => ({
		mockAuxiliaryLspPublished: vi.fn().mockResolvedValue(false),
		recordEntitySnapshotDiffMock: vi.fn(() => ({
			added: [] as string[],
			removed: [] as string[],
			modified: [] as string[],
		})),
	}),
);

// Environment only: whether the ast-grep LSP has published for this root is LSP
// state, not the behavior under test. Everything else in `clients/lsp/index.js`
// stays real so the dispatch module graph still resolves.
vi.mock("../../../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/lsp/capabilities.js")
	>()),
	hasAuxiliaryLspPublishedForRoot: mockAuxiliaryLspPublished,
}));

vi.mock(
	"../../../../clients/review-graph/service.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/review-graph/service.js")
		>()),
		recordEntitySnapshotDiff: recordEntitySnapshotDiffMock,
	}),
);

const { dispatchLintDetailed } =
	await import("../../../../clients/dispatch/integration.js");

/**
 * Violates `no-any-type` (rules/ast-grep-rules/rules/no-any-type.yml,
 * `severity: hint`) on line 2 and nothing at `severity: error`. A fixture whose
 * only finding is error-severity would keep every assertion here vacuous.
 */
const HINT_ONLY_SOURCE = [
	"export function widen(input: string) {",
	"\tconst loosened: any = input;",
	"\treturn loosened;",
	"}",
	"",
].join("\n");

const HINT_RULE = "no-any-type";
const HINT_RULE_LINE = 2;

/** No `no-ast-grep`, so the ast-grep auxiliary stays ENABLED — the substitute
 *  role only exists while the LSP is expected but has not published. `no-lsp`
 *  keeps the separate LSP dispatch runner from spawning real servers. */
const FALLBACK_FLAGS = { getFlag: (flag: string) => flag === "no-lsp" };
/** `no-ast-grep` retires the auxiliary entirely: napi is then not standing in
 *  for anything, so it keeps the per-edit blocking floor. */
const AST_GREP_DISABLED_FLAGS = {
	getFlag: (flag: string) => flag === "no-lsp" || flag === "no-ast-grep",
};

let env: RealRunnerEnv;
beforeAll(() => {
	env = makeRealRunnerEnv();
});
afterAll(() => env?.cleanup());

beforeEach(() => {
	mockAuxiliaryLspPublished.mockResolvedValue(false);
	resetNapiFallbackCoverageForTests();
});

function napiDiagnosticsFor(
	runners: { runnerId: string; result: { diagnostics: unknown[] } }[],
): { rule?: string; line?: number; severity?: string }[] {
	const napi = runners.find(({ runnerId }) => runnerId === "ast-grep-napi");
	return (napi?.result.diagnostics ?? []) as {
		rule?: string;
		line?: number;
		severity?: string;
	}[];
}

describe("ast-grep-napi fallback severity floor (#2336)", () => {
	it("emits a hint-severity finding on the production per-edit floor", async () => {
		const { filePath } = env.addFile(
			"napi-floor-fallback.ts",
			HINT_ONLY_SOURCE,
		);

		const { runners } = await dispatchLintDetailed(
			filePath,
			env.cwd,
			FALLBACK_FLAGS,
			// The production per-edit dispatch value: `dispatchLintWithResult`
			// defaults `blockingOnly` to true (clients/dispatch/integration.ts:2625)
			// and `clients/pipeline.ts:1439` never overrides it.
			{ blockingOnly: true },
		);

		expect(runners.map(({ runnerId }) => runnerId)).toContain("ast-grep-napi");
		const hits = napiDiagnosticsFor(runners).filter(
			(d) => d.rule === HINT_RULE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(HINT_RULE_LINE);
		expect(hits[0]?.severity).toBe("hint");
	}, 30_000);

	it("keeps the blocking floor when the ast-grep auxiliary is disabled", async () => {
		const { filePath } = env.addFile(
			"napi-floor-disabled.ts",
			HINT_ONLY_SOURCE,
		);

		const { runners } = await dispatchLintDetailed(
			filePath,
			env.cwd,
			AST_GREP_DISABLED_FLAGS,
			{ blockingOnly: true },
		);

		expect(runners.map(({ runnerId }) => runnerId)).toContain("ast-grep-napi");
		expect(
			napiDiagnosticsFor(runners).filter((d) => d.rule === HINT_RULE),
		).toHaveLength(0);
	}, 30_000);

	it("honors an explicit non-blocking floor unchanged", async () => {
		const { filePath } = env.addFile(
			"napi-floor-explicit.ts",
			HINT_ONLY_SOURCE,
		);

		const { runners } = await dispatchLintDetailed(
			filePath,
			env.cwd,
			AST_GREP_DISABLED_FLAGS,
			{ blockingOnly: false },
		);

		expect(
			napiDiagnosticsFor(runners).filter((d) => d.rule === HINT_RULE),
		).toHaveLength(1);
	}, 30_000);
});

describe("ast-grep-napi / late-aux dedupe with a real finding (#2329, #2336)", () => {
	it("delivers the finding once through napi and suppresses the late-aux mark", async () => {
		const { filePath } = env.addFile(
			"napi-dedupe-napi-first.ts",
			HINT_ONLY_SOURCE,
		);
		const touchStartedAt = Date.now();

		const { runners } = await dispatchLintDetailed(
			filePath,
			env.cwd,
			FALLBACK_FLAGS,
			{ blockingOnly: true },
		);

		// Surface 1 carries the finding — this is what made every earlier
		// exercise of the seam vacuous.
		expect(
			napiDiagnosticsFor(runners).filter((d) => d.rule === HINT_RULE),
		).toHaveLength(1);

		// Surface 2 is suppressed by the same predicate the aux-grace producer
		// evaluates before marking a pending pair (clients/lsp/index.ts, the
		// `o.serverId === "ast-grep" && napiFallbackCoveredSince(...)` exclusion).
		expect(napiFallbackCoveredSince(filePath, touchStartedAt)).toBe(true);
	}, 30_000);

	it("delivers the finding once through the LSP when it published first", async () => {
		const { filePath } = env.addFile(
			"napi-dedupe-lsp-first.ts",
			HINT_ONLY_SOURCE,
		);
		mockAuxiliaryLspPublished.mockResolvedValue(true);
		const touchStartedAt = Date.now();

		const { runners } = await dispatchLintDetailed(
			filePath,
			env.cwd,
			FALLBACK_FLAGS,
			{ blockingOnly: true },
		);

		// Gate B skipped napi entirely, so the LSP's own publication of the same
		// rule and line is the only delivery surface.
		expect(
			napiDiagnosticsFor(runners).filter((d) => d.rule === HINT_RULE),
		).toHaveLength(0);
		expect(napiFallbackCoveredSince(filePath, touchStartedAt)).toBe(false);
	}, 30_000);
});

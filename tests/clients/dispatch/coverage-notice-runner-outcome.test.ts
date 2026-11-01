/**
 * #3867: the analyze coverage notice keys on the runner OUTCOME, not the bare
 * `status`. A primary runner that timed out or failed to spawn reports
 * `status: "failed"` but produced no usable result — it did not analyse the
 * file, so the pull must still carry the coverage notice. Only a `failed` run
 * whose own findings failed it (`failureKind: "blocking_diagnostics"`, the
 * `hasUsableResult` contract in clients/dispatch/types.ts) counts as coverage,
 * beside a plain `succeeded` run.
 *
 * Drives the real `dispatchForFile` — the entry the MCP `pilens_analyze` pull
 * uses with `dedupeCoverageNotice: false` — with a single primary (`lsp`)
 * runner and no fallback linters, so the coverage decision is the only thing
 * under test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	COLLECT_LATER_THRESHOLD_MS,
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../../../clients/dispatch/collect-later-tier.js";
import {
	clearCoverageNoticeState,
	clearLatencyReports,
	createDispatchContext,
	dispatchForFile,
	getLatencyReports,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { resetPendingRunnerFindings } from "../../../clients/dispatch/pending-runner-findings.js";
import {
	findingsResult,
	type RunnerGroup,
	type RunnerResult,
} from "../../../clients/dispatch/types.js";

const COVERAGE_NOTICE = "Pi-lens jsts analysis unavailable";
const PYTHON_COVERAGE_NOTICE = "Pi-lens python analysis unavailable";

describe("coverage notice keys on the primary runner's usable result (#3867)", () => {
	let registry: RunnerRegistry;
	const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["lsp"] }];

	// The pull surface: every call is a deliberate question, so the notice must
	// come back every time (no session latch) — see buildCoverageNotice.
	const pull = (ctx: Parameters<typeof dispatchForFile>[0]) =>
		dispatchForFile(ctx, groups, registry, undefined, {
			dedupeCoverageNotice: false,
		});

	// A fallback-linter cell needs the fallback runner in the dispatch group.
	const pullWith = (
		ctx: Parameters<typeof dispatchForFile>[0],
		runGroups: RunnerGroup[],
	) =>
		dispatchForFile(ctx, runGroups, registry, undefined, {
			dedupeCoverageNotice: false,
		});

	function context() {
		return contextFor("test.ts");
	}

	function contextFor(filePath: string) {
		return createDispatchContext(
			filePath,
			"/project",
			{ getFlag: () => false },
			new FactStore(),
		);
	}

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
		clearLatencyReports();
		// The pending cell records a collect-later observation and a deferred
		// finding in module-level state; both must not leak into later cells.
		resetObservedRunnerLatency();
		resetPendingRunnerFindings();
	});

	it("carries the notice when the only primary runner timed out", async () => {
		// Fake timers drive the dispatcher's timeout; no real wall-clock wait
		// enters the test. `vi.useFakeTimers` precedes the never-settling promise
		// so the flake-shape scan reads it as a faked timer scope.
		vi.useFakeTimers();
		try {
			// Never resolves: only the dispatcher's runner timeout settles it, so
			// the latency row is a real `failed`/`failureKind: "timeout"`.
			registry.register({
				id: "lsp",
				appliesTo: ["jsts"],
				priority: 4,
				timeoutMs: 1,
				async run(): Promise<RunnerResult> {
					return new Promise(() => {});
				},
			});

			const pending = pull(context());
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			// Let the pipeline reach the runner race, then fire its timeout timer.
			for (let i = 0; i < 100 && !settled; i += 1) {
				await vi.advanceTimersByTimeAsync(1);
			}
			const result = await pending;

			expect(result.output).toContain(COVERAGE_NOTICE);
			expect(result.warnings.map((w) => w.message)).toContainEqual(
				expect.stringContaining(COVERAGE_NOTICE),
			);
			// The row says WHY: `runRunner` classifies a timeout from the error's own
			// words ("timed out"), so a timeout re-worded by a shared race reads
			// `exception` and the collect-later tier never sees a timed-out run.
			const row = getLatencyReports()
				.at(-1)
				?.runners.find((r) => r.runnerId === "lsp");
			expect(row?.status).toBe("failed");
			expect(row?.failureKind).toBe("timeout");
		} finally {
			vi.useRealTimers();
		}
	}, 500);

	it("carries the notice when the only primary runner failed to spawn", async () => {
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				throw new Error("spawn lsp ENOENT");
			},
		});

		const result = await pull(context());

		expect(result.output).toContain(COVERAGE_NOTICE);
	});

	it("does not carry the notice when the primary runner's findings failed it", async () => {
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "lsp-blocker",
							message: "Type error",
							filePath: "test.ts",
							severity: "error",
							semantic: "blocking",
							tool: "lsp",
						},
					],
					semantic: "blocking",
					failureKind: "blocking_diagnostics",
				};
			},
		});

		const result = await pull(context());

		expect(result.output).not.toContain(COVERAGE_NOTICE);
	});

	it("does not carry the notice when the primary runner succeeded", async () => {
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			},
		});

		const result = await pull(context());

		expect(result.output).not.toContain(COVERAGE_NOTICE);
	});

	it("does not carry the notice when the primary runner is deferred", async () => {
		// A deferred primary may still deliver findings at turn end, so it
		// withholds the notice. Its `unconfirmedServerIds` are unset, so the
		// scanner-coverage branch cannot mask the in-flight gate.
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				return { status: "deferred", diagnostics: [], semantic: "none" };
			},
		});

		const result = await pull(context());

		expect(result.output).not.toContain(COVERAGE_NOTICE);
	});

	it("does not carry the notice when the primary runner is pending (collect-later)", async () => {
		// A runner observed over the collect-later threshold parks on the edit as
		// `pending`; the same in-flight gate must withhold the notice for it.
		observeRunnerLatency({
			projectRoot: "/project",
			runnerId: "lsp",
			durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
		});
		let settle!: (result: RunnerResult) => void;
		const parked = new Promise<RunnerResult>((resolve) => {
			settle = resolve;
		});
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				return parked;
			},
		});
		const ctx = context();
		Object.defineProperty(ctx, "writeIndex", { value: 1 });

		const result = await pull(ctx);

		expect(result.output).toContain("Pending runners");
		expect(result.output).not.toContain(COVERAGE_NOTICE);
		// Settle the parked run so no promise outlives the test.
		settle({ status: "succeeded", diagnostics: [], semantic: "none" });
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("carries the notice when the primary and fallback linters both fault", async () => {
		// The fallback coverage test must key on the usable-result rule too: a
		// fallback linter that timed out or failed to spawn covered nothing.
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				throw new Error("spawn lsp ENOENT");
			},
		});
		registry.register({
			id: "eslint",
			appliesTo: ["jsts"],
			priority: 5,
			async run(): Promise<RunnerResult> {
				throw new Error("spawn eslint ENOENT");
			},
		});

		const result = await pullWith(context(), [
			{ mode: "all", runnerIds: ["lsp", "eslint"] },
		]);

		expect(result.output).toContain(COVERAGE_NOTICE);
	});

	it("keeps the notice when a type-bearing file's fallback linter finds an issue", async () => {
		// A fallback run whose own findings failed it (`blocking_diagnostics`) still
		// covered lint, but not the type capability required by this plan.
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				throw new Error("spawn lsp ENOENT");
			},
		});
		registry.register({
			id: "eslint",
			appliesTo: ["jsts"],
			priority: 5,
			async run(): Promise<RunnerResult> {
				return findingsResult(
					[
						{
							id: "eslint-blocker",
							message: "Lint error",
							filePath: "test.ts",
							severity: "error",
							semantic: "blocking",
							tool: "eslint",
						},
					],
					{ status: "failed", semantic: "blocking" },
				);
			},
		});

		const result = await pullWith(context(), [
			{ mode: "all", runnerIds: ["lsp", "eslint"] },
		]);

		expect(result.output).toContain(COVERAGE_NOTICE);
	});

	it("keeps the type-coverage notice for any type-bearing file when lint fallback finds an issue (#3928)", async () => {
		// #3928: an unavailable primary plus a successful lint-only fallback was
		// rendered clean. The fallback finding is real,
		// but it cannot stand in for the missing type-checking verdict.
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				throw new Error("spawn typescript-language-server ENOENT");
			},
		});
		registry.register({
			id: "oxlint",
			appliesTo: ["jsts"],
			priority: 10,
			async run(): Promise<RunnerResult> {
				return {
					status: "succeeded",
					diagnostics: [
						{
							id: "oxlint-github-finding",
							message: "lint issue in hidden project directory",
							filePath: ".github/bad.ts",
							severity: "warning",
							semantic: "warning",
							tool: "oxlint",
						},
					],
					semantic: "warning",
				};
			},
		});

		const result = await pullWith(contextFor(".github/bad.ts"), [
			{ mode: "all", runnerIds: ["lsp", "oxlint"] },
		]);

		expect(result.diagnostics.map((d) => d.id)).toContain(
			"oxlint-github-finding",
		);
		expect(result.output).toContain(COVERAGE_NOTICE);
	});

	it("applies the same type-coverage rule to Python fallback lint", async () => {
		registry.register({
			id: "lsp",
			appliesTo: ["python"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				throw new Error("spawn pyright-langserver ENOENT");
			},
		});
		registry.register({
			id: "ruff-lint",
			appliesTo: ["python"],
			priority: 10,
			async run(): Promise<RunnerResult> {
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			},
		});

		const result = await pullWith(contextFor(".config/bad.py"), [
			{ mode: "all", runnerIds: ["lsp", "ruff-lint"] },
		]);

		expect(result.output).toContain(PYTHON_COVERAGE_NOTICE);
	});

	it("lets a non-type-bearing file stay clean when its fallback succeeds", async () => {
		// #3928 F1: the type-capability guard must not turn ordinary lint
		// coverage into an incomplete result for JSON and similar file kinds.
		registry.register({
			id: "lsp",
			appliesTo: ["json"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				throw new Error("lsp skipped: server is not ready");
			},
		});
		registry.register({
			id: "trivy-config",
			appliesTo: ["json"],
			priority: 10,
			async run(): Promise<RunnerResult> {
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			},
		});

		const result = await pullWith(contextFor(".github/workflow.json"), [
			{ mode: "all", runnerIds: ["lsp", "trivy-config"] },
		]);

		expect(result.output).not.toContain("analysis unavailable");
	});

	it("accepts a successful type-capable fallback for Python", async () => {
		registry.register({
			id: "lsp",
			appliesTo: ["python"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				throw new Error("spawn pyright-langserver ENOENT");
			},
		});
		registry.register({
			id: "pyright",
			appliesTo: ["python"],
			priority: 5,
			async run(): Promise<RunnerResult> {
				throw new Error("spawn pyright ENOENT");
			},
		});
		registry.register({
			id: "mypy",
			appliesTo: ["python"],
			priority: 10,
			async run(): Promise<RunnerResult> {
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			},
		});

		const result = await pullWith(contextFor("src/typed.py"), [
			{ mode: "all", runnerIds: ["lsp", "pyright"] },
			{ mode: "fallback", runnerIds: ["mypy"] },
		]);

		expect(result.output).not.toContain(PYTHON_COVERAGE_NOTICE);
	});

	it("names which check covered the file, and only when one did (#4733 r2)", async () => {
		// RECURRENCE GUARDED: #4733 r2 (#4734's review). The commit gate's
		// whole-file verdict read "the primary checked the file" from an unset
		// `unconfirmedStatus`, which also holds when a defined primary group
		// never ran. `coverage` is the rule's positive answer, set only where it
		// found the file checked; each cell drives the real coverage rule.
		const succeeded = async (): Promise<RunnerResult> => ({
			status: "succeeded",
			diagnostics: [],
			semantic: "none",
		});
		const deferred = async (): Promise<RunnerResult> => ({
			status: "deferred",
			diagnostics: [],
			semantic: "none",
		});
		const spawnFails = async (): Promise<RunnerResult> => {
			throw new Error("spawn lsp ENOENT");
		};
		const cells: Array<{
			name: string;
			runners: Array<[string, () => Promise<RunnerResult>]>;
			groups: RunnerGroup[];
			file: string;
			noLsp?: true;
			expected: string | undefined;
		}> = [
			{
				name: "the primary answered",
				runners: [["lsp", succeeded]],
				groups,
				file: "test.ts",
				expected: "primary",
			},
			{
				name: "the primary is still in flight",
				runners: [["lsp", deferred]],
				groups,
				file: "test.ts",
				expected: "in_flight",
			},
			{
				name: "a type-capable fallback answered for a broken primary",
				runners: [
					["lsp", spawnFails],
					["mypy", succeeded],
				],
				groups: [
					{ mode: "all", runnerIds: ["lsp"] },
					{ mode: "fallback", runnerIds: ["mypy"] },
				],
				file: "src/typed.py",
				expected: "fallback",
			},
			{
				name: "the mode defines no primary group (--no-lsp)",
				runners: [["eslint", succeeded]],
				groups: [{ mode: "all", runnerIds: ["eslint"] }],
				file: "test.ts",
				noLsp: true,
				expected: "unconfigured",
			},
			{
				name: "the primary broke and nothing stood in",
				runners: [["lsp", spawnFails]],
				groups,
				file: "test.ts",
				expected: undefined,
			},
			{
				name: "a defined primary group never ran, only a linter did",
				runners: [["eslint", succeeded]],
				groups: [{ mode: "all", runnerIds: ["eslint"] }],
				file: "test.ts",
				expected: undefined,
			},
		];
		const seen: Array<[string, string | undefined]> = [];
		for (const cell of cells) {
			registry = new RunnerRegistry();
			clearCoverageNoticeState();
			for (const [id, run] of cell.runners) {
				registry.register({
					id,
					appliesTo: ["jsts", "python"],
					priority: 4,
					run,
				});
			}
			const ctx = createDispatchContext(
				cell.file,
				"/project",
				{ getFlag: (flag: string) => cell.noLsp === true && flag === "no-lsp" },
				new FactStore(),
			);
			const result = await pullWith(ctx, cell.groups);
			seen.push([cell.name, result.coverage]);
		}
		expect(seen).toEqual(cells.map((cell) => [cell.name, cell.expected]));
	});

	it("carries the notice when a failed primary has a diagnostic but no failureKind", async () => {
		// A `failed` with no `failureKind` is indistinguishable from a runner
		// break (#3781); the parse-error arms carry a kind since #3796 item 3.
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "lsp-kindless",
							message: "Type error",
							filePath: "test.ts",
							severity: "error",
							semantic: "blocking",
							tool: "lsp",
						},
					],
					semantic: "blocking",
				};
			},
		});

		const result = await pull(context());

		expect(result.output).toContain(COVERAGE_NOTICE);
	});
});

// Recurrence: #4734 verify r2 F4. The clean advisory said a language server
// checked a `--no-lsp` edit and found nothing, because an unset
// `unconfirmedStatus` was read as "a primary answered". The dispatcher's one
// return that knows is `primaryHasCoverage`, and only when the `lsp` runner is
// what covered the file. Rows of the #4734 round-3 state table.
describe("the language-server verdict the clean advisory reads (#4734 r3)", () => {
	type Row = {
		label: string;
		file: string;
		noLsp?: boolean;
		runners: Record<string, () => Promise<RunnerResult>>;
		groups: RunnerGroup[];
		/** Dispatch this many times on the push surface; the last result counts. */
		pushes?: number;
		expected: true | undefined;
		/**
		 * #5008 review r2 (F1): the status line the latched partial notice still
		 * owes. The latch suppresses the NOTICE, not the claim, so this row no
		 * longer reaches the pipeline as the clean-line shape.
		 */
		expectedUnconfirmed?: string;
	};
	const succeeded = async (): Promise<RunnerResult> => ({
		status: "succeeded",
		diagnostics: [],
		semantic: "none",
	});
	const rows: Row[] = [
		{
			label: "row 14: the lsp runner answered",
			file: "test.ts",
			runners: { lsp: succeeded },
			groups: [{ mode: "all", runnerIds: ["lsp"] }],
			expected: true,
		},
		{
			label: "row 8: --no-lsp leaves jsts no primary group",
			file: "test.ts",
			noLsp: true,
			runners: { oxlint: succeeded },
			groups: [{ mode: "all", runnerIds: ["oxlint"] }],
			expected: undefined,
		},
		{
			label: "row 10: --no-lsp, the pyright CLI primary answered",
			file: "src/app.py",
			noLsp: true,
			runners: { pyright: succeeded },
			groups: [{ mode: "all", runnerIds: ["pyright"] }],
			expected: undefined,
		},
		{
			label: "row 10: the lsp runner skipped, the pyright CLI answered",
			file: "src/app.py",
			runners: {
				lsp: async () => ({
					status: "skipped",
					diagnostics: [],
					semantic: "none",
				}),
				pyright: succeeded,
			},
			groups: [{ mode: "all", runnerIds: ["lsp", "pyright"] }],
			expected: undefined,
		},
		{
			label: "row 11: a silent server's partial notice, latched",
			file: "test.ts",
			runners: {
				lsp: async () => ({
					status: "skipped",
					diagnostics: [],
					semantic: "none",
					unconfirmedServerIds: ["opengrep"],
				}),
			},
			groups: [{ mode: "all", runnerIds: ["lsp"] }],
			pushes: 2,
			expected: undefined,
			expectedUnconfirmed: "opengrep silent (diagnostics are incomplete)",
		},
		{
			// Review r3 (F7): the status sentence's DEFERRED half, the sibling of
			// row 11. Recurrence: emptying `statusParts.push` for the deferred set
			// survived every suite, so a #2810 late-delivery scanner's latched
			// notice rendered `unconfirmed —  (diagnostics are incomplete)` — the
			// same unnamed-scanner defect row 11 covers, one scanner class over.
			label: "row 11b: a deferred server's partial notice, latched",
			file: "test.ts",
			runners: {
				lsp: async () => ({
					status: "deferred",
					diagnostics: [],
					semantic: "none",
					unconfirmedServerIds: ["typos"],
					deferredServerIds: ["typos"],
				}),
			},
			groups: [{ mode: "all", runnerIds: ["lsp"] }],
			pushes: 2,
			expected: undefined,
			expectedUnconfirmed: "typos deferred (diagnostics are incomplete)",
		},
		{
			label: "row 12: the lsp runner is deferred",
			file: "test.ts",
			runners: {
				lsp: async () => ({
					status: "deferred",
					diagnostics: [],
					semantic: "none",
				}),
			},
			groups: [{ mode: "all", runnerIds: ["lsp"] }],
			expected: undefined,
		},
		{
			label: "row 13: the lsp runner failed, a fallback linter covered",
			file: ".github/workflow.json",
			runners: {
				lsp: async () => {
					throw new Error("lsp skipped: server is not ready");
				},
				"trivy-config": succeeded,
			},
			groups: [{ mode: "all", runnerIds: ["lsp", "trivy-config"] }],
			expected: undefined,
		},
	];

	beforeEach(() => {
		clearCoverageNoticeState();
		clearLatencyReports();
		resetObservedRunnerLatency();
		resetPendingRunnerFindings();
	});

	it.for(rows)("$label", async (row) => {
		const registry = new RunnerRegistry();
		for (const [id, run] of Object.entries(row.runners)) {
			registry.register({
				id,
				appliesTo: ["jsts", "python", "json"],
				priority: id === "lsp" ? 4 : 5,
				run,
			});
		}
		const ctx = () =>
			createDispatchContext(
				row.file,
				"/project",
				{ getFlag: (flag: string) => row.noLsp === true && flag === "no-lsp" },
				new FactStore(),
			);
		let result = await dispatchForFile(ctx(), row.groups, registry);
		for (let push = 1; push < (row.pushes ?? 1); push += 1) {
			result = await dispatchForFile(ctx(), row.groups, registry);
		}

		// Every row but 14 reaches the pipeline as the clean-line shape: no text,
		// no `unconfirmedStatus`. Only the verdict tells them apart. Row 11 is the
		// exception since review r2: its notice is latched away on the second
		// push, and the write must still name the silent scanner.
		expect({
			output: result.output,
			unconfirmedStatus: result.unconfirmedStatus,
			primaryLspChecked: result.primaryLspChecked,
		}).toEqual({
			output: "",
			unconfirmedStatus: row.expectedUnconfirmed,
			primaryLspChecked: row.expected,
		});
	});
});

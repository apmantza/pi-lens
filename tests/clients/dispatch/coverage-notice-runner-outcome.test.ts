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
		return createDispatchContext(
			"test.ts",
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

	it("does not carry the notice when a fallback linter's findings failed it", async () => {
		// The mirror of the cell above: a fallback run whose own findings failed
		// it (`blocking_diagnostics`) did cover the file.
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

		expect(result.output).not.toContain(COVERAGE_NOTICE);
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

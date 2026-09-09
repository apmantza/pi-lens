import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotAdvisoryProvenance } from "../../../clients/advisory-provenance.js";
import { CacheManager } from "../../../clients/cache-manager.js";
import { testRunnerFindingsToProjectDiagnostics } from "../../../clients/project-diagnostics/runner-adapters/runner-findings.js";
import { peekTestFindings } from "../../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { removeTempDirSync } from "../test-utils.js";

describe("test finding provenance adapter (#1413)", () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach(removeTempDirSync));

	function fixture() {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-runner-provenance-"),
		);
		dirs.push(cwd);
		const file = path.join(cwd, "src", "foo.test.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "test('foo', () => {});\n");
		const provenance = snapshotAdvisoryProvenance({
			cwd,
			runtime: { telemetrySessionId: "adapter", projectSeq: 0, turnIndex: 0 },
			generation: 2,
			files: [{ path: file, role: "test" }],
		});
		const result = {
			file,
			sourceFile: file,
			runner: "vitest",
			passed: 0,
			failed: 1,
			skipped: 0,
			failures: [],
			duration: 1,
		};
		return { cwd, file, provenance, result };
	}

	it("keeps validated failures blocking", () => {
		const { cwd, provenance, result } = fixture();
		expect(
			testRunnerFindingsToProjectDiagnostics(
				{ content: "fail", results: [result], provenance },
				cwd,
			)[0],
		).toMatchObject({ severity: "error", semantic: "blocking" });
	});

	it("makes superseded and legacy failures non-blocking", () => {
		const { cwd, provenance, result } = fixture();
		for (const cache of [
			{ content: "fail", results: [result], provenance, superseded: true },
			{ content: "fail", results: [result] },
		]) {
			expect(
				testRunnerFindingsToProjectDiagnostics(cache, cwd)[0],
			).toMatchObject({ severity: "info", semantic: "none" });
		}
	});

	it("classifies a session-mismatched record identically on context and project surfaces", () => {
		const { cwd, provenance, result } = fixture();
		const cache = { content: "fail", results: [result], provenance };
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "different-session" });
		const cacheManager = new CacheManager(false);
		cacheManager.writeCache("test-runner-findings", cache, cwd);
		expect(
			peekTestFindings(cacheManager, cwd, runtime)?.messages[0]?.content,
		).toContain("Historical finding");
		expect(
			testRunnerFindingsToProjectDiagnostics(cache, cwd, runtime)[0],
		).toMatchObject({ severity: "info", semantic: "none" });
	});

	/**
	 * #2532: `lens_diagnostics mode=full` rendered a runner error (timeout,
	 * missing provider/binary — the suite itself never produced a verdict) as
	 * `semantic: "blocking"`, the identical event the turn-end message
	 * (#2522) already delivers as advisory. `isRunnerErrorResult` classifies
	 * `failed === 0 && !!error` as advisory regardless of `error`'s cause —
	 * NOT "failed is 0 whenever error is set" (review round 1 S2: that is
	 * false — see the mixed-batch case below and `isRunnerErrorResult`'s doc).
	 */
	it("makes a runner-error result advisory instead of blocking", () => {
		const { cwd, provenance, file } = fixture();
		const runnerErrorResult = {
			file,
			sourceFile: file,
			runner: "pytest",
			passed: 0,
			failed: 0,
			skipped: 0,
			failures: [],
			duration: 1,
			error: "pytest: error: unrecognized arguments (exit code 4)",
		};
		expect(
			testRunnerFindingsToProjectDiagnostics(
				{ content: "fail", results: [runnerErrorResult], provenance },
				cwd,
			)[0],
		).toMatchObject({ severity: "info", semantic: "none" });
	});

	/**
	 * #2532 inversion guard: a genuine failing test reported only as a bare
	 * count (no per-test `failures[]` detail — some parsers summarize this
	 * way) must NOT be swept into the same advisory treatment as a runner
	 * error just because it also falls through to the "no individual
	 * failures listed" branch. `failed > 0` with no `error` is a real test
	 * failure, always blocking.
	 */
	it("keeps a genuine failing test blocking even with no per-test failure detail", () => {
		const { cwd, provenance, file } = fixture();
		const countOnlyFailure = {
			file,
			sourceFile: file,
			runner: "vitest",
			passed: 0,
			failed: 3,
			skipped: 0,
			failures: [],
			duration: 1,
		};
		expect(
			testRunnerFindingsToProjectDiagnostics(
				{ content: "fail", results: [countOnlyFailure], provenance },
				cwd,
			)[0],
		).toMatchObject({ severity: "error", semantic: "blocking" });
	});

	/**
	 * #2532 review round 1, S3: the bottom branch used to keep a
	 * `result.error ? "Test run error: …" : "N test(s) failed"` ternary so a
	 * counted failure that ALSO carried a runner error (pytest exit 2
	 * "Interrupted" after `2 failed, 1 passed`) still said so. The PR's first
	 * version dropped the ternary — this is a mixed result the S2 inversion
	 * guard above keeps blocking, but the message must not silently lose the
	 * interruption while doing so.
	 */
	it("keeps the runner error visible in the message for a counted failure that also errored", () => {
		const { cwd, provenance, file } = fixture();
		const interruptedWithFailure = {
			file,
			sourceFile: file,
			runner: "pytest",
			passed: 1,
			failed: 2,
			skipped: 0,
			failures: [],
			duration: 1,
			error: "Pytest interrupted",
		};
		const diagnostic = testRunnerFindingsToProjectDiagnostics(
			{ content: "fail", results: [interruptedWithFailure], provenance },
			cwd,
		)[0];
		expect(diagnostic).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
		expect(diagnostic.message).toContain("2 test(s) failed");
		expect(diagnostic.message).toContain("Pytest interrupted");
	});

	it("drops deleted targets and returns none after consumption", () => {
		const { cwd, file, provenance, result } = fixture();
		fs.unlinkSync(file);
		expect(
			testRunnerFindingsToProjectDiagnostics(
				{ content: "fail", results: [result], provenance },
				cwd,
			),
		).toEqual([]);
		expect(
			testRunnerFindingsToProjectDiagnostics({ content: "" }, cwd),
		).toEqual([]);
	});
});

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBoundedTelemetry } from "../../clients/bounded-telemetry.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	RUNNERS,
	TestRunnerClient,
	type TestResult,
} from "../../clients/test-runner-client.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Only the resolveExec matrix below (#1098) needs this mocked; every other
// test in this file never reaches a `findGlobalBinary` call.
const findGlobalBinary =
	vi.fn<(command: string) => Promise<string | undefined>>();
vi.mock("../../clients/package-manager.js", () => ({
	findGlobalBinary: (command: string) => findGlobalBinary(command),
}));

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

describe("test-runner-client", () => {
	it("does not infer vitest from vite config alone", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "vite.config.ts"),
			"export default {}\n",
		);
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "tmp", version: "1.0.0" }),
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).not.toBe("vitest");
	});

	it("parses cargo summary in generic runner output", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseGenericRunnerOutput(
			"test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out",
			"",
			0,
			"/tmp/test.rs",
			"cargo",
		);

		expect(result.passed).toBe(3);
		expect(result.failed).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("parses rspec summary in generic runner output", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseGenericRunnerOutput(
			"3 examples, 1 failure",
			"",
			1,
			"/tmp/spec/foo_spec.rb",
			"rspec",
		);

		expect(result.passed).toBe(2);
		expect(result.failed).toBe(1);
	});

	// #1479: the agent-facing surface asks the same "was this measured at all"
	// question the turn-end log asks, and now reads it from the same predicate.
	describe("formatResult duration suffix (#1479)", () => {
		const format = (duration?: number) =>
			new TestRunnerClient(false).formatResult({
				file: "/tmp/foo.test.ts",
				sourceFile: "",
				runner: "vitest",
				passed: 2,
				failed: 0,
				skipped: 0,
				failures: [],
				duration,
			});

		it("prints the suffix for a measured run", () => {
			expect(format(1230)).toContain(" (1.23s)");
		});

		it("omits the suffix for an unmeasured run", () => {
			expect(format(undefined)).not.toContain("(");
		});

		// Scope decision carried over from #1479 and deliberately unchanged: a
		// measured zero rounds to `(0.00s)`, which is prompt noise, so the
		// agent-facing string suppresses it. The turn-end log still says `0ms`
		// for the same result — that surface is where the distinction matters.
		it("omits the suffix for a measured zero, unlike the turn-end log", () => {
			expect(format(0)).not.toContain("(");
		});

		it("omits the suffix for a non-finite duration rather than printing it", () => {
			expect(format(Number.POSITIVE_INFINITY)).not.toContain("(");
			expect(format(Number.NaN)).not.toContain("(");
		});
	});

	// #1480: `parseGenericRunnerOutput` hardcoded duration 0 for every runner
	// but go, so the turn-end log printed a constant that looked like a
	// measurement — the very thing #1479 set out to stop it doing. Durations
	// are pinned to EXACT values here: a `> 0` assertion would accept the next
	// plausible constant, which is how this defect class survived #1452's
	// sweep in the first place.
	describe("generic runner durations (#1480)", () => {
		const parse = (output: string, runner: string, exitCode = 0) =>
			(new TestRunnerClient(false) as any).parseGenericRunnerOutput(
				output,
				"",
				exitCode,
				`/tmp/test.${runner}`,
				runner,
			);

		// Format from the libtest printer shipped with the local rustc 1.94.1
		// (`formatters/pretty.rs` + `time.rs`), NOT a live `cargo test` — this
		// box has no MSVC linker, so cargo cannot link a test binary.
		it("parses the cargo test-result summary duration", () => {
			const result = parse(
				[
					"running 3 tests",
					"test tests::ok1 ... ok",
					"test tests::ign ... ignored",
					"",
					"test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.25s",
					"",
				].join("\n"),
				"cargo",
			);

			expect(result.passed).toBe(2);
			expect(result.skipped).toBe(1);
			expect(result.duration).toBe(250);
		});

		it("ignores a cargo panic message that mimics the summary suffix", () => {
			// First-match hazard: the assertion diff below carries the same
			// "; finished in ..." text the summary does. The pattern is anchored
			// to the start of the `test result:` line so the diff cannot win.
			const result = parse(
				[
					"thread 'tests::bad' panicked at src/lib.rs:9:",
					'  left: "; finished in 99.9s"',
					"",
					"test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.50s",
				].join("\n"),
				"cargo",
				101,
			);

			expect(result.duration).toBe(500);
		});

		it("leaves cargo unmeasured when the summary carries no elapsed time", () => {
			// Older rustc omits the suffix entirely. Absent, not 0: 0 would
			// claim libtest reported a sub-millisecond run.
			const result = parse(
				"test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
				"cargo",
			);

			expect(result.passed).toBe(2);
			expect(result.duration).toBeUndefined();
		});

		// Format from the vstest.console.dll shipped with the local .NET SDK
		// 8.0.423 (summary literal plus the " h"/" m"/" s"/" ms"/"< 1 ms" unit
		// literals), NOT a live `dotnet test` — NuGet restore has no network.
		it("parses the dotnet/vstest summary duration in ms", () => {
			const result = parse(
				"Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3, Duration: 250 ms - t.dll (net8.0)",
				"dotnet",
				1,
			);

			expect(result.failed).toBe(1);
			expect(result.passed).toBe(2);
			expect(result.duration).toBe(250);
		});

		it("sums the dotnet/vstest multi-unit duration token list", () => {
			// vstest joins unit tokens with spaces rather than printing one
			// number, so "1 m 30 s" is 90s and "2 s 345 ms" is 2345ms.
			const minutes = parse(
				"Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 1 m 30 s - t.dll (net8.0)",
				"dotnet",
			);
			const seconds = parse(
				"Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 2 s 345 ms - t.dll (net8.0)",
				"dotnet",
			);
			const hours = parse(
				"Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 1 h 2 m - t.dll (net8.0)",
				"dotnet",
			);

			expect(minutes.duration).toBe(90_000);
			expect(seconds.duration).toBe(2345);
			expect(hours.duration).toBe(3_720_000);
		});

		it("reports vstest's sub-millisecond run as a measured zero", () => {
			// `< 1 ms` is vstest saying it timed the run and the figure rounds
			// below its resolution. With duration optional that is exactly 0 —
			// measured, rounds to nothing. Under the old 0-means-unmeasured
			// representation this case could not be expressed at all and was
			// reported as absent.
			const result = parse(
				"Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: < 1 ms - t.dll (net8.0)",
				"dotnet",
			);

			expect(result.passed).toBe(1);
			expect(result.duration).toBe(0);
		});

		it("leaves dotnet unmeasured when the duration tail carries no units", () => {
			// A tail that matched but yields no unit token is an unrecognised
			// format, not a zero-length run.
			const result = parse(
				"Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: whenever",
				"dotnet",
			);

			expect(result.duration).toBeUndefined();
		});

		// Surefire format from its console reporter, NOT a live maven run —
		// there is no mvn on this box.
		it("sums the maven/surefire per-class Time elapsed lines", () => {
			const result = parse(
				[
					"[INFO] Running com.example.AppTest",
					"[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.05 s -- in com.example.AppTest",
					"[INFO] Running com.example.OtherTest",
					"[INFO] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.125 s -- in com.example.OtherTest",
					"[INFO] Results:",
					"[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0",
					"[INFO] Total time:  9.876 s",
				].join("\n"),
				"maven",
				1,
			);

			// 50 + 125. NOT 9876: "[INFO] Total time" is whole-build wall clock
			// including compile, and reporting it as test time would be a wrong
			// number rather than an absent one.
			expect(result.duration).toBe(175);
			expect(result.failed).toBe(1);
		});

		it("reports a surefire class that ran in 0.00 s as a measured zero", () => {
			// The guard is "did a line match", not "is the sum positive".
			// Surefire prints `Time elapsed: 0.00 s` for a trivial class and
			// that IS a reading; calling it unmeasured would be the `> 0`
			// mistake this port exists to avoid.
			const result = parse(
				"[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.00 s -- in com.example.TrivialTest",
				"maven",
			);

			expect(result.duration).toBe(0);
		});

		it("leaves maven unmeasured when no Time elapsed line survives -q", () => {
			// `mvn test -q` suppresses surefire's INFO lines, so the aggregate
			// alone is what reaches us. Absent is the honest report.
			const result = parse(
				[
					"[INFO] Results:",
					"[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0",
				].join("\n"),
				"maven",
				1,
			);

			expect(result.duration).toBeUndefined();
		});

		it("accepts the surefire 2.x 'sec' spelling", () => {
			const result = parse(
				"Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.012 sec - in com.example.AppTest",
				"maven",
			);

			expect(result.duration).toBe(12);
		});

		// REAL capture: rspec-core 3.13.6 on ruby 3.4.10.
		it("parses the rspec Finished-in line", () => {
			const result = parse(
				[
					".F",
					"",
					"Finished in 0.32394 seconds (files took 0.49427 seconds to load)",
					"2 examples, 1 failure",
				].join("\n"),
				"rspec",
				1,
			);

			expect(result.passed).toBe(1);
			expect(result.failed).toBe(1);
			// 323.94ms, NOT the 494.27ms file-load time that trails it on the
			// same line.
			expect(result.duration).toBe(324);
		});

		it("parses the rspec minutes form", () => {
			// From RSpec::Core::Formatters::Helpers.format_duration in the
			// installed gem: past 60s it prints "N minutes M.MM seconds".
			const result = parse(
				[
					"Finished in 2 minutes 15.14 seconds (files took 0.5 seconds to load)",
					"2 examples, 0 failures",
				].join("\n"),
				"rspec",
			);

			expect(result.duration).toBe(135_140);
		});

		it("ignores an rspec failure diff that mimics the Finished-in line", () => {
			// First-match hazard: the quoted expectation below would win an
			// unanchored /m match. The pattern requires the line to START with
			// "Finished in", which rspec's own summary does and a diff does not.
			const result = parse(
				[
					"Failures:",
					"",
					"  1) demo fails",
					"     Failure/Error: expect(log).to eq 'Finished in 99 seconds'",
					"",
					"Finished in 0.32394 seconds (files took 0.49427 seconds to load)",
					"2 examples, 1 failure",
				].join("\n"),
				"rspec",
				1,
			);

			expect(result.duration).toBe(324);
		});

		// REAL capture: minitest 5.25.4 on ruby 3.4.10.
		it("parses the minitest Finished-in line", () => {
			const result = parse(
				[
					"Run options: --seed 63795",
					"",
					"F.",
					"",
					"Finished in 0.254594s, 7.8557 runs/s, 7.8557 assertions/s.",
					"",
					"2 runs, 2 assertions, 1 failures, 0 errors, 0 skips",
				].join("\n"),
				"minitest",
				1,
			);

			expect(result.passed).toBe(1);
			expect(result.failed).toBe(1);
			expect(result.duration).toBe(255);
		});

		// Gradle's console summary carries no elapsed time and "BUILD
		// SUCCESSFUL in 3s" is whole-build wall clock, so this stays unmeasured
		// on purpose. #1479 makes that absence legible in the log.
		it("leaves gradle unmeasured rather than borrowing the build time", () => {
			const result = parse(
				[
					"> Task :test FAILED",
					"4 tests completed, 1 failed",
					"BUILD FAILED in 3s",
				].join("\n"),
				"gradle",
				1,
			);

			expect(result.failed).toBe(1);
			expect(result.passed).toBe(3);
			expect(result.duration).toBeUndefined();
		});

		it("still parses the go package summary duration", () => {
			const result = parse("ok  \texample.com/pkg\t0.253s\n", "go");

			expect(result.duration).toBe(253);
		});

		it("leaves an unrecognised runner summary unmeasured", () => {
			const result = parse("everything is fine\n", "somethingelse");

			expect(result.duration).toBeUndefined();
		});

		// #1480 review: the probes used to run over EVERY runner's output, so
		// "gradle carries no elapsed time" was a claim about gradle's text, not
		// a property of the code. It was false. Real gradle output satisfies
		// go's `ok <pkg> <n>s` probe, and the build wall clock came out as test
		// time — the one number this function exists to refuse.
		it("does not let gradle borrow the build wall clock via go's probe", () => {
			const result = parse(
				"> Task :test\nsome output ok\nin 3s\nBUILD SUCCESSFUL in 3s\n",
				"gradle",
			);

			expect(result.duration).toBeUndefined();
		});

		it("does not score an unknown runner with another runner's pattern", () => {
			// The `default:` arm of the switch sends every custom or
			// unrecognised runner here, so its arbitrary output must not be
			// mined for other runners' summaries. This payload satisfies the
			// go, cargo, dotnet, maven, rspec AND minitest probes at once.
			const result = parse(
				[
					"ok  \texample.com/pkg\t9.000s",
					"test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s",
					"Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 9 s - t.dll (net8.0)",
					"Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 9.0 s -- in com.example.AppTest",
					"Finished in 9.0 seconds (files took 0.1 seconds to load)",
					"Finished in 9.0s, 1.0 runs/s, 1.0 assertions/s.",
				].join("\n"),
				"mytestrunner",
			);

			expect(result.duration).toBeUndefined();
		});

		it("does not score one known runner with another known runner's pattern", () => {
			// rspec's own line, handed to minitest. Probe selection is by
			// runner name, so no fallthrough scores it.
			const result = parse(
				[
					"Finished in 0.32394 seconds (files took 0.49427 seconds to load)",
					"2 examples, 0 failures",
				].join("\n"),
				"minitest",
			);

			expect(result.duration).toBeUndefined();
		});

		it("stops the dotnet duration scan at the assembly separator", () => {
			// The `-` stop in `Duration:\s*([^\r\n-]+)` is the only thing
			// keeping the assembly NAME out of the unit scan. This name carries
			// a unit-shaped token on purpose: without the stop it adds 30
			// seconds that vstest never reported.
			const result = parse(
				"Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 250 ms - Timeouts.30s.Tests.dll (net8.0)",
				"dotnet",
			);

			expect(result.duration).toBe(250);
		});

		it("reads minitest's own Finished-in line, not a decoy", () => {
			// Two decoys, one per guard in `/^Finished in\s+([\d.]+)s\s*,/im`.
			// The indented one is what `^` rejects. The column-0 one is what the
			// trailing `,` rejects — `^` alone does not rank two line-start
			// matches, so without the comma the suite's own printf wins.
			const result = parse(
				[
					"Run options: --seed 63795",
					'  left: "Finished in 99.9s, boom"',
					"Finished in 42s",
					"",
					"Finished in 0.254594s, 7.8557 runs/s, 7.8557 assertions/s.",
					"",
					"2 runs, 2 assertions, 0 failures, 0 errors, 0 skips",
				].join("\n"),
				"minitest",
			);

			expect(result.duration).toBe(255);
		});

		// KNOWN LIMIT, pinned so it stays known. cargo across crates, dotnet
		// across assemblies and `go test ./...` across packages print one
		// summary per unit and only the first is read, so a multi-unit run
		// under-reports. Left as-is because the count parsers have the same
		// first-match shape: duration and counts describe the same scope.
		it("reads only the first summary of a multi-crate cargo run", () => {
			const result = parse(
				[
					"test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s",
					"",
					"test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.00s",
				].join("\n"),
				"cargo",
			);

			// 100, not 2100. Under-reported, and deliberately so.
			expect(result.duration).toBe(100);
		});
	});

	// #1480 review: the maven aggregate is per MODULE, not per reactor.
	describe("maven multi-module counts (#1480)", () => {
		const parse = (output: string, exitCode: number) =>
			(new TestRunnerClient(false) as any).parseGenericRunnerOutput(
				output,
				"",
				exitCode,
				"/tmp/pom.xml",
				"maven",
			);

		// `--fail-at-end` keeps building after a module fails, so the LAST
		// `Results:` block belongs to the last module — which can be green
		// while the reactor is red. Reachable without pi-lens passing the flag:
		// maven also reads `.mvn/maven.config` and `MAVEN_ARGS`.
		const failAtEndReactor = [
			"[INFO] --- Building module-one ---",
			"[INFO] Tests run: 10, Failures: 3, Errors: 0, Skipped: 0, Time elapsed: 1.0 s -- in com.example.OneTest",
			"[INFO] Results:",
			"[ERROR] Tests run: 10, Failures: 3, Errors: 0, Skipped: 0",
			"[INFO] --- Building module-two ---",
			"[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.5 s -- in com.example.TwoTest",
			"[INFO] Results:",
			"[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0",
			"[ERROR] BUILD FAILURE",
		].join("\n");

		it("sums every module's aggregate instead of reporting the last one", () => {
			const result = parse(failAtEndReactor, 1);

			// 11 run reactor-wide, 3 failed. Reading the last aggregate alone
			// reported 1 passed / 0 failed and printed PASS over a red build.
			expect(result.failed).toBe(3);
			expect(result.passed).toBe(8);
		});

		it("counts the same scope the duration sums over", () => {
			const result = parse(failAtEndReactor, 1);

			// Both reactor-wide: 1.0s + 0.5s across the same two modules the
			// counts came from. Before this, duration was every module and
			// counts were the last one.
			expect(result.duration).toBe(1500);
		});

		it("never reports a non-zero exit as a pass", () => {
			// A green last module, or any parse that finds no failure, must not
			// talk the runner's own exit code out of a failure.
			const result = parse(
				[
					"[INFO] Results:",
					"[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0",
					"[ERROR] BUILD FAILURE",
				].join("\n"),
				1,
			);

			expect(result.failed).toBeGreaterThan(0);
		});

		it("still scores a single-module run by its aggregate, not by its classes twice", () => {
			const result = parse(
				[
					"[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.05 s -- in com.example.AppTest",
					"[INFO] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.125 s -- in com.example.OtherTest",
					"[INFO] Results:",
					"[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0",
				].join("\n"),
				1,
			);

			// 4 tests, not 8: per-class lines carry `Time elapsed` and the
			// aggregate does not, which is how the two are told apart.
			expect(result.failed).toBe(1);
			expect(result.passed).toBe(3);
		});
	});

	// #1487: a runner that never ran (spawn/config/load failure) must not be
	// reported to the agent as a failing test. `failed` used to be pre-seeded
	// to 1 for any non-zero exit, which made the runner-error branch
	// (`failed === 0`) unreachable on exactly the path it exists for.
	describe("runner-start failures report as errors, not test failures (#1487)", () => {
		const parse = (output: string, exitCode: number, runner = "cargo") =>
			(new TestRunnerClient(false) as any).parseGenericRunnerOutput(
				"",
				output,
				exitCode,
				`/tmp/test.${runner}`,
				runner,
			);

		it("reports a non-zero exit with no counts and error text as a runner error, not a failing test", () => {
			const result = parse("error: could not load configuration file", 1);

			expect(result.error).toBe("Runner cargo exited with 1");
			expect(result.passed).toBe(0);
			expect(result.failed).toBe(0);
		});

		it("does not invent a failure name for a runner-start error", () => {
			const result = parse("error: could not load configuration file", 1);

			expect(result.failures).toEqual([]);
		});

		it("renders the runner-error surface, not a failed-test surface", () => {
			const client = new TestRunnerClient(false);
			const result = parse("error: could not load configuration file", 1);

			expect(client.formatResult(result)).toBe(
				"[Tests] ⚠ Could not run tests: Runner cargo exited with 1",
			);
		});

		it("still reports parsed counts, and never PASS, for a non-zero exit with real counts", () => {
			// Counts DID parse (0 failed via the cargo summary), so this is a
			// real run, not a runner-start failure — the #1480 guard must
			// still force at least one failure rather than reading it as a
			// runner error.
			const result = parse(
				"test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out",
				1,
			);

			expect(result.error).toBeUndefined();
			expect(result.failed).toBeGreaterThan(0);
		});

		it("still reports a failure for a non-zero exit with no counts and no error text", () => {
			// No count parser matched AND no "error" text — ambiguous, but
			// still a non-zero exit, so the #1480 exit-code-distrust guard
			// must still apply and this must not render as PASS.
			const result = parse("unexpected termination", 1);

			expect(result.error).toBeUndefined();
			expect(result.failed).toBeGreaterThan(0);
		});
	});

	// #1524: a REAL failing run must never be downgraded to "could not run
	// tests" just because its runner has no count parser in
	// `parseGenericRunnerDuration`/the count-matching block above. go (the
	// `default:` case's only text-only runner with no cargo/dotnet/maven/
	// rspec/minitest/gradle summary shape) never sets `matched`, so before
	// this fix `exitCode !== 0 && !matched && lower.includes("error")` fired
	// on a genuine `--- FAIL:`/panic that happened to mention the word
	// "error" — a real failing test rendered as a runner-start error, and
	// the failing test's own name was extracted into `failures` and then
	// discarded because `runnerError` was already decided first.
	describe("a real failing run is never downgraded to a runner error (#1524)", () => {
		const parse = (
			output: string,
			exitCode: number,
			runner = "go",
			runnerFile = `/tmp/test.${runner}`,
		) =>
			(new TestRunnerClient(false) as any).parseGenericRunnerOutput(
				"",
				output,
				exitCode,
				runnerFile,
				runner,
			);

		it("reports a go test failure by name, not as a runner error", () => {
			const result = parse(
				"--- FAIL: TestParse\n    parse_test.go:22: unexpected error: bad token\nFAIL\texample.com/pkg\t0.01s\n",
				1,
			);

			expect(result.error).toBeUndefined();
			expect(result.failed).toBeGreaterThan(0);
			expect(result.failures).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "TestParse" }),
				]),
			);
		});

		it("reports a go panic by name, not as a runner error", () => {
			const result = parse(
				"--- FAIL: TestBoom\npanic: runtime error: index out of range [3] with length 3\n\ngoroutine 1 [running]:\nFAIL\texample.com/pkg\t0.01s\n",
				2,
			);

			expect(result.error).toBeUndefined();
			expect(result.failed).toBeGreaterThan(0);
			expect(result.failures).toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "TestBoom" })]),
			);
		});

		it("reports an unknown-runner (bazel) failure with a parseable count summary, not a runner error", () => {
			// #1524-r3: updated from the original round's fixture, which
			// relied on a bare `FAILED ...`/`Error: ...` text pair alone to
			// veto the runner-error branch. That is exactly the ambiguous
			// shape #1524-r3 removed the veto from — see the gradle/maven/
			// rspec runner-error tests below, which use the same bare-text
			// shape and now correctly render AS runner errors. An
			// unrecognised runner with no `--- FAIL:` marker of its own can
			// still report a real failure, but only via a count summary a
			// parser actually recognises (rspec's `N examples, N failures`
			// applies to any runner name, not just `rspec`).
			const result = parse(
				"3 examples, 1 failure\nError: expected 1 to equal 2\n",
				1,
				"bazel",
			);

			expect(result.error).toBeUndefined();
			expect(result.failed).toBeGreaterThan(0);
		});

		it("still reports a genuine runner-start failure as an error (no failure names, #1487 stays green)", () => {
			const result = parse(
				"go: cannot find main module; error initializing",
				1,
			);

			expect(result.error).toBe("Runner go exited with 1");
			expect(result.failed).toBe(0);
			expect(result.failures).toEqual([]);
		});
	});

	// #1524-r3: a round-2 review found the fix itself had two defects.
	//
	// S2: the `FAILED`/`Failure:` name regexes let their own `\s+` gap cross
	// a newline. A bare keyword at end-of-line has nothing after it on that
	// line, so the gap ate the newline and the capture grabbed the FIRST
	// TOKEN OF THE NEXT LINE as the "test name" — and, worse, that invented
	// name then counted as evidence a test ran, vetoing the runner-error
	// branch for build-tool failures (a gradle task failing to compile, a
	// maven goal failing before surefire runs, an rspec file that never
	// loaded) that have nothing to do with any test.
	//
	// S3: go's only text evidence was `--- FAIL: TestName`, which a panic in
	// `TestMain`/package `init` never prints — the process dies before any
	// test runs, so there is no test to name. That real go failure (exit 2,
	// `FAIL\t<pkg>`, no `--- FAIL:`) still hit the runner-error branch.
	describe("failure-name regexes and go's count parser (#1524-r3)", () => {
		const parse = (
			output: string,
			exitCode: number,
			runner: string,
			runnerFile = `/tmp/test.${runner}`,
		) =>
			(new TestRunnerClient(false) as any).parseGenericRunnerOutput(
				"",
				output,
				exitCode,
				runnerFile,
				runner,
			);

		it("reports a gradle compile failure as a runner error, not a fabricated test failure", () => {
			const result = parse(
				"> Task :compileJava FAILED\n\nFAILURE: Build failed with an exception.\n\n* What went wrong:\nexecution failed\nerror: cannot find symbol\n",
				1,
				"gradle",
			);

			expect(result.error).toBe("Runner gradle exited with 1");
			expect(result.failed).toBe(0);
			expect(result.failures).toEqual([]);
		});

		it("reports a maven failed-goal build as a runner error, not a fabricated test failure", () => {
			const result = parse(
				"[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project foo: Compilation failure: FAILED\n[ERROR] error: cannot find symbol\n",
				1,
				"maven",
			);

			expect(result.error).toBe("Runner maven exited with 1");
			expect(result.failed).toBe(0);
			expect(result.failures).toEqual([]);
		});

		it("reports an rspec load error as a runner error, not a fabricated test failure", () => {
			const result = parse(
				"An error occurred while loading ./spec/foo_spec.rb.\nFailure:\n  cannot load such file -- foo\n",
				1,
				"rspec",
			);

			expect(result.error).toBe("Runner rspec exited with 1");
			expect(result.failed).toBe(0);
			expect(result.failures).toEqual([]);
		});

		it("reports a go panic in TestMain as a test failure, not a runner error", () => {
			// No `--- FAIL:` — the process died in TestMain/init before any
			// individual test ran — but `FAIL\t<pkg>` is go's own verdict
			// line for exactly this case, and the go count parser reads it.
			// Uses go's real nil-pointer panic wording, which contains
			// "error" ("runtime error: ...") — the S3 scenario specifically
			// requires that word present, or the old code's `lower.includes
			// ("error")` gate would never have fired in the first place and
			// this test would not prove the bug.
			const result = parse(
				"panic: runtime error: invalid memory address or nil pointer dereference [signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x476f00]\n\ngoroutine 1 [running]:\nexample.com/pkg.TestMain(0x0)\n\t/repo/main_test.go:10 +0x20\nFAIL\texample.com/pkg\t0.00s\n",
				2,
				"go",
			);

			expect(result.error).toBeUndefined();
			expect(result.failed).toBeGreaterThan(0);
		});

		it("does not invent a failure name from the line after a newline-spanning FAILED", () => {
			const result = parse("FAILED\n\nsome trailing note\n", 1, "cargo");

			expect(
				result.failures.some(
					(f: { name: string }) => f.name === "some trailing note",
				),
			).toBe(false);
		});
	});

	// #1524-r4: a third review pass found three residuals in the go count
	// parser round 3 added.
	//
	// S3: `/^FAIL[^\S\n]+\S+/m` (a real per-package verdict line) also
	// matched go's INFRASTRUCTURE verdict lines — `FAIL <pkg> [build
	// failed]` (a compile error) and `FAIL <pkg> [setup failed]` (no
	// packages to test). Neither ran a single test, but both rendered as a
	// fabricated `✗ 1/1 failed` instead of the runner error they are.
	//
	// S4a: the ok-package pass count was in an `else if` off the fail
	// branch, so a mixed multi-package run — some packages clean, one
	// package with a real failure — silently dropped the clean packages'
	// pass count.
	//
	// S4b: every `--- FAIL:` line was counted, but go prints one PER LEVEL
	// of a failing subtest tree — a parent `TestA` and its child
	// `TestA/sub` both get a line for what is one underlying failure — so
	// counting lines inflated `failed`.
	describe("go infrastructure verdicts, mixed-package counts, subtests (#1524-r4)", () => {
		const parse = (output: string, exitCode: number, runner = "go") =>
			(new TestRunnerClient(false) as any).parseGenericRunnerOutput(
				"",
				output,
				exitCode,
				`/tmp/test.${runner}`,
				runner,
			);

		it("reports a go compile failure ([build failed]) as a runner error", () => {
			const result = parse(
				"# example.com/pkg\n./main_test.go:8:2: undefined: Bar (compile error)\nFAIL\texample.com/pkg [build failed]\n",
				1,
			);

			expect(result.error).toBe("Runner go exited with 1");
			expect(result.failed).toBe(0);
			expect(result.failures).toEqual([]);
		});

		it("reports a go setup failure ([setup failed]) as a runner error", () => {
			const result = parse(
				"FAIL\texample.com/pkg [setup failed]\nerror: no packages to test\n",
				1,
			);

			expect(result.error).toBe("Runner go exited with 1");
			expect(result.failed).toBe(0);
			expect(result.failures).toEqual([]);
		});

		it("counts clean packages as passed alongside a real failure in the same run", () => {
			const result = parse(
				"ok  \texample.com/a\t0.01s\n--- FAIL: TestB\n    b_test.go:5: assertion failed\nFAIL\texample.com/b\t0.01s\nok  \texample.com/c\t0.02s\n",
				1,
			);

			expect(result.passed).toBe(2);
			expect(result.failed).toBe(1);
		});

		it("does not double-count a failing subtest against its already-counted parent", () => {
			const result = parse(
				"--- FAIL: TestA\n--- FAIL: TestA/sub1\n--- FAIL: TestA/sub2\nFAIL\texample.com/pkg\t0.01s\n",
				1,
			);

			expect(result.failed).toBe(1);
		});
	});

	// #1524-r4 (tidy): a runner-error result must not also carry leftover
	// failure names — the two branches of `formatResult` are mutually
	// exclusive, so a `TestResult` claiming both is self-contradictory.
	describe("a runner-error result has no leftover failure names (#1524-r4 tidy)", () => {
		it("clears failures when the rspec load-error text also matches a same-line Failure: name", () => {
			const result = (
				new TestRunnerClient(false) as any
			).parseGenericRunnerOutput(
				"",
				"An error occurred while loading ./spec/foo_spec.rb.\nFailure: cannot load such file -- foo\n",
				1,
				"/tmp/spec/foo_spec.rb",
				"rspec",
			);

			expect(result.error).toBe("Runner rspec exited with 1");
			expect(result.failures).toEqual([]);
		});
	});

	// #1480 P3: `parseFloat(seconds) * 1000` is not an integer count of
	// milliseconds. `in 2.01s` is 2009.9999999999998, and the turn-end log
	// prints the number as it stands.
	describe("summary durations are whole milliseconds (#1480)", () => {
		it("rounds the pytest summary duration", () => {
			const result = (new TestRunnerClient(false) as any).parsePytestOutput(
				"===== 3 passed in 2.01s =====",
				"",
				0,
				"/tmp/test_foo.py",
				"/tmp",
				"pytest",
			);

			expect(result.duration).toBe(2010);
		});

		it("parses an ANSI-colored pytest summary through the real output parser", () => {
			const result = (new TestRunnerClient(false) as any).parsePytestOutput(
				"\u001b[1m2 failed, 1 passed, 3 skipped in 2.19s\u001b[0m",
				"",
				1,
				"/tmp/test_foo.py",
				"/tmp",
				"pytest",
			);

			expect(result.passed).toBe(1);
			expect(result.failed).toBe(2);
			expect(result.skipped).toBe(3);
			expect(result.duration).toBe(2190);
		});

		it("ignores a count-and-duration lookalike after the genuine summary", () => {
			const result = (new TestRunnerClient(false) as any).parsePytestOutput(
				[
					"===== 2 passed, 1 failed in 1.25s =====",
					"post-run: 55432 failed in 4s",
				].join("\n"),
				"",
				1,
				"/tmp/test_foo.py",
				"/tmp",
				"pytest",
			);

			expect(result.passed).toBe(2);
			expect(result.failed).toBe(1);
			expect(result.duration).toBe(1250);
		});

		it("uses the terminal summary when output repeats summary-looking lines", () => {
			const result = (new TestRunnerClient(false) as any).parsePytestOutput(
				[
					"===== 1 passed in 0.10s =====",
					"===== 2 failed, 3 passed in 0.20s =====",
				].join("\n"),
				"",
				1,
				"/tmp/test_foo.py",
				"/tmp",
				"pytest",
			);

			expect(result.passed).toBe(3);
			expect(result.failed).toBe(2);
			expect(result.duration).toBe(200);
		});

		it("parses a CRLF-terminated pytest summary", () => {
			const result = (new TestRunnerClient(false) as any).parsePytestOutput(
				"===== 2 passed, 1 skipped in 0.50s =====\r\n",
				"",
				0,
				"/tmp/test_foo.py",
				"/tmp",
				"pytest",
			);

			expect(result.passed).toBe(2);
			expect(result.skipped).toBe(1);
			expect(result.duration).toBe(500);
		});

		it("recognizes pytest's outcome token variants in one summary", () => {
			const result = (new TestRunnerClient(false) as any).parsePytestOutput(
				"===== 4 passed, 2 failed, 3 skipped, 1 error, 5 warnings, 6 deselected, 7 xfailed, 8 xpassed in 3.21s =====",
				"",
				1,
				"/tmp/test_foo.py",
				"/tmp",
				"pytest",
			);

			expect(result.passed).toBe(4);
			expect(result.failed).toBe(2);
			expect(result.skipped).toBe(3);
			expect(result.duration).toBe(3210);
		});

		it("recognizes rerun outcomes with ANSI, CRLF, and a trailing lookalike", () => {
			const result = (new TestRunnerClient(false) as any).parsePytestOutput(
				[
					"\u001b[1m===== 1 rerun, 2 failed, 3 passed, 4 skipped in 0.50s =====\u001b[0m\r",
					"post-run: 55432 failed in 4s",
				].join("\n"),
				"",
				1,
				"/tmp/test_foo.py",
				"/tmp",
				"pytest",
			);

			expect(result.passed).toBe(3);
			expect(result.failed).toBe(2);
			expect(result.skipped).toBe(4);
			expect(result.duration).toBe(500);
		});

		it("rounds the mix test summary duration", () => {
			const result = (new TestRunnerClient(false) as any).parseMixTestOutput(
				"Finished in 2.01 seconds (0.00s async, 2.01s sync)\n3 tests, 0 failures",
				"",
				0,
				"/tmp/foo_test.exs",
				"mix",
			);

			expect(result.duration).toBe(2010);
		});
	});

	it("prefers failed-first target when failure cache exists", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/tmp\n");
		const src = path.join(tmpDir, "sum.go");
		const testFile = path.join(tmpDir, "sum_test.go");
		fs.writeFileSync(src, "package main\n");
		fs.writeFileSync(testFile, "package main\n");

		const client = new TestRunnerClient(false);
		const seeded = await client.runTestFileAsync(testFile, tmpDir, "go", {
			...RUNNERS.go,
			command: process.execPath,
			binName: "pi-lens-failed-first-fixture",
			args: (target) => [
				"-e",
				"console.log('--- FAIL: fixture'); process.exitCode = 1;",
				target,
			],
		});
		expect(seeded.failed).toBe(1);

		const target = client.getTestRunTarget(src, tmpDir);
		expect(target?.strategy).toBe("failed-first");
		expect(target?.testFile).toBe(path.resolve(testFile));
	});

	describe("failed-first target retirement (#2044)", () => {
		const failingNodeConfig = {
			...RUNNERS.go,
			command: process.execPath,
			binName: "pi-lens-2044-fixture-runner",
			args: (testFile: string) => [
				"-e",
				"console.log('--- FAIL: fixture'); process.exitCode = 1;",
				testFile,
			],
		};

		it("retires one deleted failed target and falls back to normal discovery", async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-2044-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/tmp\n");
			const sourceFile = path.join(tmpDir, "widget.go");
			const staleTest = path.join(tmpDir, "MixedCase_Test.go");
			const relatedTest = path.join(tmpDir, "widget_test.go");
			fs.writeFileSync(sourceFile, "package widget\n");
			fs.writeFileSync(staleTest, "package widget\n");
			fs.writeFileSync(relatedTest, "package widget\n");

			const client = new TestRunnerClient(false);
			const seeded = await client.runTestFileAsync(
				staleTest,
				tmpDir,
				"go",
				failingNodeConfig,
			);
			expect(seeded.failed).toBe(1);
			fs.rmSync(staleTest);

			const target = client.getTestRunTarget(sourceFile, tmpDir);
			expect(target).toMatchObject({
				testFile: path.resolve(relatedTest),
				runner: "go",
				strategy: "related",
			});

			// Recreating the same mixed-case path must not resurrect a stale entry.
			// On Windows this also proves deletion survives the normalizer changing
			// from real on-disk casing to a lowercased missing-path tail.
			fs.writeFileSync(staleTest, "package widget\n");
			expect(client.getTestRunTarget(sourceFile, tmpDir)).toMatchObject({
				testFile: path.resolve(relatedTest),
				strategy: "related",
			});
		});

		it("keeps the next valid failed target after missing execution", async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-2044-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/tmp\n");
			const sourceFile = path.join(tmpDir, "widget.go");
			const staleTest = path.join(tmpDir, "stale_test.go");
			const validFailedTest = path.join(tmpDir, "other_test.go");
			fs.writeFileSync(sourceFile, "package widget\n");
			fs.writeFileSync(staleTest, "package widget\n");
			fs.writeFileSync(validFailedTest, "package widget\n");

			const client = new TestRunnerClient(false);
			for (const testFile of [staleTest, validFailedTest]) {
				const seeded = await client.runTestFileAsync(
					testFile,
					tmpDir,
					"go",
					failingNodeConfig,
				);
				expect(seeded.failed).toBe(1);
			}
			fs.rmSync(staleTest);

			const missing = await client.runTestFileAsync(
				staleTest,
				tmpDir,
				"go",
				failingNodeConfig,
			);
			expect(missing.error).toBe("Test file not found");

			const target = client.getTestRunTarget(sourceFile, tmpDir);
			expect(target).toMatchObject({
				testFile: path.resolve(validFailedTest),
				runner: "go",
				strategy: "failed-first",
			});
		});

		it("retires one runner without clearing another in the same project", async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-2044-");
			const aliasRoot = `${tmpDir}-alias`;
			fs.symlinkSync(
				tmpDir,
				aliasRoot,
				process.platform === "win32" ? "junction" : "dir",
			);
			cleanups.push(
				() => fs.rmSync(aliasRoot, { recursive: true, force: true }),
				cleanup,
			);

			fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/tmp\n");
			fs.writeFileSync(
				path.join(tmpDir, "Cargo.toml"),
				"[package]\nname='tmp'\n",
			);
			const goSource = path.join(tmpDir, "widget.go");
			const staleGoTest = path.join(tmpDir, "stale_test.go");
			const cargoSource = path.join(tmpDir, "widget.rs");
			const cargoTest = path.join(aliasRoot, "widget_test.rs");
			for (const file of [goSource, staleGoTest, cargoSource, cargoTest]) {
				fs.writeFileSync(file, "fixture\n");
			}

			const cargoConfig = {
				...RUNNERS.cargo,
				command: process.execPath,
				binName: "pi-lens-2044-cargo-runner",
				args: (testFile: string) => [
					"-e",
					"console.log('test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out'); process.exitCode = 1;",
					testFile,
				],
			};
			const client = new TestRunnerClient(false);
			const goFailure = await client.runTestFileAsync(
				staleGoTest,
				tmpDir,
				"go",
				failingNodeConfig,
			);
			const cargoFailure = await client.runTestFileAsync(
				cargoTest,
				tmpDir,
				"cargo",
				cargoConfig,
			);
			expect(goFailure.failed).toBe(1);
			expect(cargoFailure.failed).toBe(1);

			fs.rmSync(staleGoTest);
			expect(client.getTestRunTarget(goSource, tmpDir)).toBeNull();

			// Seed the target through its symlink spelling, then consume the project
			// through the aliased root. Keys collapse while the returned target keeps
			// caller spelling and Cargo survives retirement of the missing Go target.
			fs.rmSync(path.join(tmpDir, "go.mod"));
			const cargoTarget = client.getTestRunTarget(cargoSource, aliasRoot);
			expect(cargoTarget).toMatchObject({
				runner: "cargo",
				strategy: "failed-first",
				testFile: path.resolve(cargoTest),
			});
		});

		it("retains indeterminate paths and writes bounded real telemetry", async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-2044-");
			cleanups.push(cleanup);
			fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/tmp\n");
			const sourceFile = path.join(tmpDir, "widget.go");
			const failedTest = path.join(tmpDir, "widget_test.go");
			fs.writeFileSync(sourceFile, "package widget\n");
			fs.writeFileSync(failedTest, "package widget\n");

			const denied = Object.assign(new Error("access denied"), {
				code: "EACCES",
			});
			const client = new TestRunnerClient(false, {
				statFailedTarget: () => {
					throw denied;
				},
			});
			const seeded = await client.runTestFileAsync(
				failedTest,
				tmpDir,
				"go",
				failingNodeConfig,
			);
			expect(seeded.failed).toBe(1);

			const previousTestMode = process.env.PI_LENS_TEST_MODE;
			process.env.PI_LENS_TEST_MODE = "0";
			try {
				resetBoundedTelemetry();
				clearLatencyLog();
				await flushLatencyLog();
				const target = client.getTestRunTarget(sourceFile, tmpDir, 2044);
				expect(target).toMatchObject({
					strategy: "failed-first",
					testFile: fs.realpathSync.native(failedTest),
				});
				await flushLatencyLog();
				const records = fs
					.readFileSync(getLatencyLogPath(), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(records).toContainEqual(
					expect.objectContaining({
						phase: "test_runner_failed_target_state",
						metadata: expect.objectContaining({
							outcome: "retained-indeterminate",
							runner: "go",
							errorCode: "EACCES",
						}),
					}),
				);
			} finally {
				if (previousTestMode === undefined) {
					delete process.env.PI_LENS_TEST_MODE;
				} else {
					process.env.PI_LENS_TEST_MODE = previousTestMode;
				}
			}
		});

		it("keeps long target identities distinct in the degradation ledger", () => {
			resetDegradationLedger();
			resetBoundedTelemetry();
			const client = new TestRunnerClient(false);
			const record = (
				client as unknown as {
					recordFailedTargetState(value: {
						outcome: "retired-missing";
						runner: string;
						candidate: string;
						errorCode: string;
						turnIndex: number;
					}): void;
				}
			).recordFailedTargetState.bind(client);
			const sharedPrefix = `C:/${"a".repeat(260)}`;
			record({
				outcome: "retired-missing",
				runner: "vitest",
				candidate: `${sharedPrefix}/one.test.ts`,
				errorCode: "ENOENT",
				turnIndex: 9,
			});
			record({
				outcome: "retired-missing",
				runner: "vitest",
				candidate: `${sharedPrefix}/two.test.ts`,
				errorCode: "ENOENT",
				turnIndex: 9,
			});

			const group = getDegradationSummary().find(
				(entry) => entry.kind === "test-runner-failed-target-state",
			);
			expect(group?.count).toBe(2);
			expect(group?.droppedCount).toBe(0);
			expect(
				new Set(group?.latestReasons.map((entry) => entry.subject)).size,
			).toBe(2);
		});

		it("bounds missing-target probes and carries the remainder forward", async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-2044-");
			cleanups.push(cleanup);
			fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/tmp\n");
			const sourceFile = path.join(tmpDir, "widget.go");
			const relatedTest = path.join(tmpDir, "widget_test.go");
			fs.writeFileSync(sourceFile, "package widget\n");
			fs.writeFileSync(relatedTest, "package widget\n");

			let statCalls = 0;
			const client = new TestRunnerClient(false, {
				statFailedTarget: (filePath) => {
					statCalls += 1;
					void fs.statSync(filePath);
				},
			});
			const staleTests = Array.from({ length: 12 }, (_, index) =>
				path.join(tmpDir, `stale-${index}_test.go`),
			);
			for (const testFile of staleTests) {
				fs.writeFileSync(testFile, "package widget\n");
				const seeded = await client.runTestFileAsync(
					testFile,
					tmpDir,
					"go",
					failingNodeConfig,
				);
				expect(seeded.failed).toBe(1);
				fs.rmSync(testFile);
			}

			expect(client.getTestRunTarget(sourceFile, tmpDir, 88)?.testFile).toBe(
				path.resolve(relatedTest),
			);
			expect(statCalls).toBe(8);
			expect(client.getTestRunTarget(sourceFile, tmpDir, 88)?.testFile).toBe(
				path.resolve(relatedTest),
			);
			expect(statCalls).toBe(12);
		});

		it("caps each runner at the newest 32 failed targets", async () => {
			const first = setupTestEnvironment("pi-lens-tests-2044-first-");
			const second = setupTestEnvironment("pi-lens-tests-2044-second-");
			cleanups.push(first.cleanup, second.cleanup);
			for (const root of [first.tmpDir, second.tmpDir]) {
				fs.writeFileSync(path.join(root, "go.mod"), "module example.com/tmp\n");
			}
			const sourceFile = path.join(first.tmpDir, "widget.go");
			const oldest = path.join(first.tmpDir, "oldest_test.go");
			const newest = path.join(first.tmpDir, "newest_test.go");
			fs.writeFileSync(sourceFile, "package widget\n");
			const middle = Array.from({ length: 31 }, (_, index) =>
				path.join(second.tmpDir, `failure-${index}_test.go`),
			);
			const client = new TestRunnerClient(false);
			// The cap is the behavior under test. Feed the real client failed results
			// at its recording seam instead of paying for 33 process startups.
			const recordFailedTarget = (root: string, testFile: string): void => {
				fs.writeFileSync(testFile, "package widget\n");
				(
					client as unknown as {
						recordResult(record: {
							cwd: string;
							runner: string;
							testFile: string;
							result: TestResult;
							turnIndex: number;
						}): void;
					}
				).recordResult({
					cwd: root,
					runner: "go",
					testFile,
					result: {
						file: testFile,
						sourceFile: "",
						runner: "go",
						passed: 0,
						failed: 1,
						skipped: 0,
						failures: [],
					},
					turnIndex: 2045,
				});
			};
			const previousTestMode = process.env.PI_LENS_TEST_MODE;
			process.env.PI_LENS_TEST_MODE = "0";
			try {
				resetBoundedTelemetry();
				clearLatencyLog();
				await flushLatencyLog();
				for (const [root, testFile] of [
					[first.tmpDir, oldest],
					...middle.map((testFile) => [second.tmpDir, testFile]),
					[first.tmpDir, newest],
				]) {
					recordFailedTarget(root, testFile);
				}

				expect(
					client.getTestRunTarget(sourceFile, first.tmpDir)?.testFile,
				).toBe(fs.realpathSync.native(newest));
				await flushLatencyLog();
				const log = fs.readFileSync(getLatencyLogPath(), "utf8");
				expect(log).toContain('"outcome":"capacity-evicted"');
				expect(log).toContain('"phase":"test_runner_failed_target_state"');
			} finally {
				if (previousTestMode === undefined) {
					delete process.env.PI_LENS_TEST_MODE;
				} else {
					process.env.PI_LENS_TEST_MODE = previousTestMode;
				}
			}
		});

		it("evicts the globally oldest target after a cross-root refresh", async () => {
			const first = setupTestEnvironment("pi-lens-tests-2044-hot-");
			const second = setupTestEnvironment("pi-lens-tests-2044-cold-");
			cleanups.push(first.cleanup, second.cleanup);
			for (const root of [first.tmpDir, second.tmpDir]) {
				fs.writeFileSync(path.join(root, "go.mod"), "module example.com/tmp\n");
				fs.writeFileSync(path.join(root, "widget.go"), "package widget\n");
			}
			const hot = path.join(first.tmpDir, "hot_test.go");
			const cold = Array.from({ length: 31 }, (_, index) =>
				path.join(second.tmpDir, `cold-${index}_test.go`),
			);
			const newest = path.join(second.tmpDir, "newest_test.go");
			const client = new TestRunnerClient(false);
			const recordFailure = (
				client: TestRunnerClient,
				root: string,
				testFile: string,
			): void => {
				fs.writeFileSync(testFile, "package widget\n");
				(
					client as unknown as {
						recordResult(record: {
							cwd: string;
							runner: string;
							testFile: string;
							result: TestResult;
							turnIndex: number;
						}): void;
					}
				).recordResult({
					cwd: root,
					runner: "go",
					testFile,
					result: {
						file: testFile,
						sourceFile: "",
						runner: "go",
						passed: 0,
						failed: 1,
						skipped: 0,
						failures: [],
					},
					turnIndex: 2045,
				});
			};

			const previousTestMode = process.env.PI_LENS_TEST_MODE;
			process.env.PI_LENS_TEST_MODE = "0";
			try {
				resetBoundedTelemetry();
				clearLatencyLog();
				await flushLatencyLog();
				recordFailure(client, first.tmpDir, hot);
				for (const testFile of cold) {
					recordFailure(client, second.tmpDir, testFile);
				}
				// Refresh A after every original B entry, then force one eviction in B.
				recordFailure(client, first.tmpDir, hot);
				recordFailure(client, second.tmpDir, newest);

				expect(
					client.getTestRunTarget(
						path.join(first.tmpDir, "widget.go"),
						first.tmpDir,
					)?.testFile,
				).toBe(path.resolve(hot));
				expect(
					client.getTestRunTarget(
						path.join(second.tmpDir, "widget.go"),
						second.tmpDir,
					)?.testFile,
				).toBe(path.resolve(cold[1]));

				// Refresh another root, then evict the sole target in this root. The
				// new target must be inserted into a reacquired root map.
				const reacquisitionClient = new TestRunnerClient(false);
				const reacquisitionNewest = path.join(
					first.tmpDir,
					"reacquired_test.go",
				);
				recordFailure(reacquisitionClient, first.tmpDir, hot);
				for (const testFile of cold) {
					recordFailure(reacquisitionClient, second.tmpDir, testFile);
				}
				recordFailure(reacquisitionClient, second.tmpDir, cold[0]);
				recordFailure(reacquisitionClient, first.tmpDir, reacquisitionNewest);
				expect(
					reacquisitionClient.getTestRunTarget(
						path.join(first.tmpDir, "widget.go"),
						first.tmpDir,
					)?.testFile,
				).toBe(path.resolve(reacquisitionNewest));

				await flushLatencyLog();
				const log = fs.readFileSync(getLatencyLogPath(), "utf8");
				expect(log).toContain('"outcome":"capacity-evicted"');
				expect(log).toContain('"phase":"test_runner_failed_target_state"');
			} finally {
				if (previousTestMode === undefined) {
					delete process.env.PI_LENS_TEST_MODE;
				} else {
					process.env.PI_LENS_TEST_MODE = previousTestMode;
				}
			}
		});
	});

	it("does not infer pytest from pyproject without pytest section", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "pyproject.toml"),
			"[project]\nname='demo'\nversion='0.1.0'\n",
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir, path.join(tmpDir, "index.ts"));
		expect(detected?.runner).not.toBe("pytest");
	});

	it("infers pytest when pyproject has pytest.ini_options", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "pyproject.toml"),
			"[tool.pytest.ini_options]\naddopts='-q'\n",
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir, path.join(tmpDir, "main.py"));
		expect(detected?.runner).toBe("pytest");
	});

	it("does not use global pytest fallback for non-Python files", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir, path.join(tmpDir, "index.ts"));
		expect(detected).toBeNull();
	});

	describe("findTestFile — mirrored test-tree layout (#547)", () => {
		it("finds a TS test mirrored under tests/<subdir>/, matching this repo's own layout", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				"export default {}\n",
			);
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "knip-client.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const testDir = path.join(tmpDir, "tests", "clients");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "knip-client.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("finds a mirrored test under __tests__/<subdir>/", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				"export default {}\n",
			);
			const srcDir = path.join(tmpDir, "lib", "utils");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "format.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const testDir = path.join(tmpDir, "__tests__", "lib", "utils");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "format.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("finds a Python test mirrored under tests/<subdir>/ (test_*.py)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg", "sub");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			const testDir = path.join(tmpDir, "tests", "pkg", "sub");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "test_foo.py");
			fs.writeFileSync(testFile, "def test_x(): pass\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("still finds a colocated test file (no regression)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				"export default {}\n",
			);
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "widget.ts");
			fs.writeFileSync(src, "export const x = 1;\n");
			const testFile = path.join(srcDir, "widget.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("still finds a flat top-level tests/ test file (no regression)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				"export default {}\n",
			);
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "gadget.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const testDir = path.join(tmpDir, "tests");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "gadget.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("prefers same-directory test over mirrored tests/ when both exist", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				"export default {}\n",
			);
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "dual.ts");
			fs.writeFileSync(src, "export const x = 1;\n");
			const colocated = path.join(srcDir, "dual.test.ts");
			fs.writeFileSync(colocated, "// colocated\n");

			const mirroredDir = path.join(tmpDir, "tests", "clients");
			fs.mkdirSync(mirroredDir, { recursive: true });
			fs.writeFileSync(path.join(mirroredDir, "dual.test.ts"), "// mirrored\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(colocated);
		});
	});

	describe("detectRunner — hoisted monorepo node_modules", () => {
		it("finds vitest hoisted to the workspace root from a nested package cwd", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			// Simulate npm/yarn/pnpm workspace hoisting: vitest only lives in
			// node_modules at the workspace root, not in the package's own
			// node_modules (which may not even exist).
			fs.mkdirSync(path.join(tmpDir, "node_modules", "vitest"), {
				recursive: true,
			});
			const pkgDir = path.join(tmpDir, "packages", "foo");
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(
				path.join(pkgDir, "package.json"),
				JSON.stringify({ name: "foo", version: "1.0.0" }),
			);

			const client = new TestRunnerClient(false);
			const detected = client.detectRunner(pkgDir);
			expect(detected?.runner).toBe("vitest");
		});

		it("finds jest hoisted two levels up (scoped package nesting)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.mkdirSync(path.join(tmpDir, "node_modules", "jest"), {
				recursive: true,
			});
			const pkgDir = path.join(tmpDir, "packages", "@scope", "bar");
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(
				path.join(pkgDir, "package.json"),
				JSON.stringify({ name: "@scope/bar", version: "1.0.0" }),
			);

			const client = new TestRunnerClient(false);
			const detected = client.detectRunner(pkgDir);
			expect(detected?.runner).toBe("jest");
		});

		it("does not walk up past the bounded depth", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.mkdirSync(path.join(tmpDir, "node_modules", "vitest"), {
				recursive: true,
			});
			// Nest the cwd deeper than MAX_NODE_MODULES_WALK_UP (5) so the
			// hoisted node_modules at tmpDir is out of range.
			const deepDir = path.join(tmpDir, "a", "b", "c", "d", "e", "f", "g");
			fs.mkdirSync(deepDir, { recursive: true });
			fs.writeFileSync(
				path.join(deepDir, "package.json"),
				JSON.stringify({ name: "deep", version: "1.0.0" }),
			);

			const client = new TestRunnerClient(false);
			const detected = client.detectRunner(deepDir);
			expect(detected).toBeNull();
		});
	});

	describe("findTestFile — bounded recursive Python test discovery", () => {
		it("finds a test file grouped by kind (tests/unit/) rather than mirrored", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			// Grouped-by-kind layout: tests/unit/test_foo.py, not the mirrored
			// tests/pkg/test_foo.py the exact-match candidates would look for.
			const testDir = path.join(tmpDir, "tests", "unit");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "test_foo.py");
			fs.writeFileSync(testFile, "def test_x(): pass\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("does not recurse past the bounded depth", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			// Nest the test file deeper than MAX_PYTEST_RECURSE_DEPTH (3)
			// below tests/, so the bounded recursive search must not find it.
			const testDir = path.join(tmpDir, "tests", "a", "b", "c", "d");
			fs.mkdirSync(testDir, { recursive: true });
			fs.writeFileSync(
				path.join(testDir, "test_foo.py"),
				"def test_x(): pass\n",
			);

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found).toBeNull();
		});

		it("still prefers the mirrored subdir match over the recursive fallback", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			const mirroredDir = path.join(tmpDir, "tests", "pkg");
			fs.mkdirSync(mirroredDir, { recursive: true });
			const mirroredTest = path.join(mirroredDir, "test_foo.py");
			fs.writeFileSync(mirroredTest, "def test_mirrored(): pass\n");

			const groupedDir = path.join(tmpDir, "tests", "unit");
			fs.mkdirSync(groupedDir, { recursive: true });
			fs.writeFileSync(
				path.join(groupedDir, "test_foo.py"),
				"def test_grouped(): pass\n",
			);

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(mirroredTest);
		});
	});

	describe("getTestRunTarget — editing a test file directly (#547 follow-up)", () => {
		it("returns a .test.ts file itself as the target, not a discovered nonsense file", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				"export default {}\n",
			);
			const src = path.join(tmpDir, "foo.test.ts");
			fs.writeFileSync(src, "// test\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(src));
			expect(target?.strategy).toBe("self");
		});

		it("returns a .spec.ts file itself as the target", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				"export default {}\n",
			);
			const src = path.join(tmpDir, "bar.spec.ts");
			fs.writeFileSync(src, "// test\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(src));
			expect(target?.strategy).toBe("self");
		});

		it("returns a Python test_foo.py file itself as the target", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const src = path.join(tmpDir, "test_foo.py");
			fs.writeFileSync(src, "def test_x(): pass\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(src));
			expect(target?.strategy).toBe("self");
		});

		it("still uses findTestFile discovery for a normal (non-test) source file — no regression", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				"export default {}\n",
			);
			const src = path.join(tmpDir, "widget.ts");
			fs.writeFileSync(src, "export const x = 1;\n");
			const testFile = path.join(tmpDir, "widget.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(testFile));
			expect(target?.strategy).toBe("related");
		});

		it("prefers failed-first over self when the edited test file is itself in the failed set", async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				"export default {}\n",
			);
			const src = path.join(tmpDir, "flaky.test.ts");
			fs.writeFileSync(src, "// test\n");
			const vitestFailureConfig = {
				...RUNNERS.vitest,
				command: process.execPath,
				binName: "pi-lens-failed-vitest-fixture",
				args: (testFile: string) => [
					"-e",
					`console.log(JSON.stringify({ numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, testResults: [{ name: ${JSON.stringify(testFile)}, assertionResults: [{ status: "failed", title: "fixture", failureMessages: ["boom"] }] }] })); process.exitCode = 1;`,
				],
			};

			const client = new TestRunnerClient(false);
			const seeded = await client.runTestFileAsync(
				src,
				tmpDir,
				"vitest",
				vitestFailureConfig,
			);
			expect(seeded.failed).toBe(1);

			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).toBe("failed-first");
			expect(target?.testFile).toBe(path.resolve(src));
		});
	});

	describe("parseVitestTestGlobs — best-effort vitest config scrape", () => {
		it("extracts include/exclude string-literal arrays from a simple config", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['src/**/*.check.ts', \"e2e/**/*.flow.ts\"],",
					"    exclude: ['src/legacy/**'],",
					"  },",
					"};",
				].join("\n"),
			);

			const client = new TestRunnerClient(false);
			const globs = client.parseVitestTestGlobs(tmpDir);
			expect(globs?.include).toEqual(["src/**/*.check.ts", "e2e/**/*.flow.ts"]);
			expect(globs?.exclude).toEqual(["src/legacy/**"]);
		});

		it("returns null when there is no vitest config", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			const client = new TestRunnerClient(false);
			expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();
		});

		it("returns null when include/exclude is built dynamically (unparseable)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: computeIncludes(),",
					"  },",
					"};",
				].join("\n"),
			);

			const client = new TestRunnerClient(false);
			expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();
		});

		it("caches the parsed result — does not re-read the config file on repeated calls", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			const configPath = path.join(tmpDir, "vitest.config.ts");
			fs.writeFileSync(
				configPath,
				"export default { test: { include: ['a.ts'] } };\n",
			);

			const client = new TestRunnerClient(false);
			const first = client.parseVitestTestGlobs(tmpDir);
			expect(first?.include).toEqual(["a.ts"]);

			// Rewrite the config with a different include array. If the result
			// were re-read/re-parsed on the next call, this would change the
			// returned globs — the cache must keep returning the first result.
			fs.writeFileSync(
				configPath,
				"export default { test: { include: ['b.ts', 'c.ts'] } };\n",
			);
			const second = client.parseVitestTestGlobs(tmpDir);
			expect(second?.include).toEqual(["a.ts"]);
			expect(second).toBe(first);
		});

		it("uses a custom include glob to correct classification of an unconventionally-named test file", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['**/*.check.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			const src = path.join(tmpDir, "widget.check.ts");
			fs.writeFileSync(src, "// unconventional test naming\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).toBe("self");
			expect(target?.testFile).toBe(path.resolve(src));
		});

		// #628 pin: a broad `include` glob (any `.ts` file under `src/`) must NOT
		// alone classify a plain source file as its own test target. This is the
		// exact shape of the real dogfooding bug — background-review.ts / index.ts
		// got treated as strategy "self" and vitest reported a vacuous
		// `PASS 0p/0f (0ms)` because the project's include glob happened to match
		// every .ts file, not just test files.
		it("does NOT classify a plain source file as self-test from a broad include glob alone (#628)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['src/**/*.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			fs.mkdirSync(path.join(tmpDir, "src"));
			const src = path.join(tmpDir, "src", "background-review.ts");
			fs.writeFileSync(src, "export function review() {}\n");
			// No companion test file exists — this file has nothing to run.

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).not.toBe("self");
			expect(target).toBeNull();
		});

		// Same shape, but the broad glob is the maximally-generic `**/*.ts` (no
		// directory restriction at all) — still must not self-classify.
		it("does NOT classify a plain source file as self-test from an unrestricted **/*.ts include (#628)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['**/*.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			const src = path.join(tmpDir, "index.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).not.toBe("self");
		});

		// The legitimate case the include-override exists for: a project whose
		// tests live under a conventional `tests/` directory without `.test.` in
		// the filename. This is a narrower signal (a literal test-ish directory
		// segment) than "any file with this extension", so it must still work.
		it("still classifies a file under a bare tests/ directory glob as self-test (legitimate override, #628)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['tests/**/*.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			fs.mkdirSync(path.join(tmpDir, "tests"));
			const src = path.join(tmpDir, "tests", "widget.ts");
			fs.writeFileSync(src, "// lives in tests/, no .test. in the name\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).toBe("self");
			expect(target?.testFile).toBe(path.resolve(src));
		});
	});

	// --- PHPUnit ---

	it("detects phpunit via phpunit.xml.dist", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "phpunit.xml.dist"),
			"<phpunit></phpunit>\n",
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).toBe("phpunit");
	});

	it("detects phpunit via composer.json require-dev", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "composer.json"),
			JSON.stringify({
				name: "acme/demo",
				"require-dev": { "phpunit/phpunit": "^10.0" },
			}),
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).toBe("phpunit");
	});

	it("does not infer phpunit from composer.json without a phpunit dependency", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "composer.json"),
			JSON.stringify({ name: "acme/demo", "require-dev": {} }),
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).not.toBe("phpunit");
	});

	it("finds the mirrored PHPUnit test file (src/Foo/Bar.php -> tests/Foo/BarTest.php)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "phpunit.xml"), "<phpunit></phpunit>\n");
		const src = createTempFile(
			tmpDir,
			"src/Foo/Bar.php",
			"<?php\nclass Bar {}\n",
		);
		const testFile = createTempFile(
			tmpDir,
			"tests/Foo/BarTest.php",
			"<?php\nclass BarTest {}\n",
		);

		const client = new TestRunnerClient(false);
		const found = client.findTestFile(src, tmpDir);
		expect(found?.runner).toBe("phpunit");
		expect(found?.testFile).toBe(testFile);
	});

	it("parses a passing PHPUnit OK summary", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePhpunitOutput(
			"...\n\nOK (12 tests, 34 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.passed).toBe(12);
		expect(result.failed).toBe(0);
		expect(result.skipped).toBe(0);
	});

	it("parses a failing PHPUnit summary with individual failures", () => {
		const client = new TestRunnerClient(false) as any;
		const output = [
			"FAILURES!",
			"",
			"1) Foo\\BarTest::testSomething",
			"Failed asserting that false is true.",
			"",
			"Tests: 12, Assertions: 34, Errors: 1, Failures: 2, Skipped: 1.",
		].join("\n");
		const result = client.parsePhpunitOutput(
			output,
			"",
			1,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.passed).toBe(8);
		expect(result.failed).toBe(3);
		expect(result.skipped).toBe(1);
		expect(result.failures[0].name).toBe("Foo\\BarTest::testSomething");
	});

	// #1452: PHPUnit's own elapsed time was never parsed, so every PHPUnit run
	// reported 0ms. The summary line changed shape across supported majors, so
	// both are pinned. Literal lines, not a live run — there is no PHP toolchain
	// on the machine this was written on.
	it("parses the PHPUnit >= 9.3 clock Time line (MM:SS.mmm)", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePhpunitOutput(
			"...\n\nTime: 00:00.123, Memory: 8.00 MB\n\nOK (12 tests, 34 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.passed).toBe(12);
		expect(result.duration).toBe(123);
	});

	it("reads a PHPUnit fractional second as tenths, not as milliseconds", () => {
		const client = new TestRunnerClient(false) as any;
		// "00:00.1" is a TENTH of a second. Parsing the fraction as an integer
		// would report 1ms for a 100ms run.
		const result = client.parsePhpunitOutput(
			"Time: 00:00.1, Memory: 8.00 MB\nOK (1 test, 1 assertion)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.duration).toBe(100);
	});

	it("parses a PHPUnit Time line carrying hours", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePhpunitOutput(
			"Time: 01:02:03.456, Memory: 8.00 MB\nOK (1 test, 1 assertion)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.duration).toBe(3_723_456);
	});

	it("parses the legacy PHPUnit <= 9.2 Time line (seconds and ms)", () => {
		const client = new TestRunnerClient(false) as any;
		const seconds = client.parsePhpunitOutput(
			"Time: 1.23 seconds, Memory: 10.00MB\nOK (2 tests, 2 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);
		const millis = client.parsePhpunitOutput(
			"Time: 123 ms, Memory: 10.00MB\nOK (2 tests, 2 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(seconds.duration).toBe(1230);
		expect(millis.duration).toBe(123);
	});

	it("leaves the PHPUnit duration unmeasured when no Time line is present", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePhpunitOutput(
			"...\n\nOK (12 tests, 34 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		// #1479: this assertion used to read `toBe(0)` while its own comment
		// said the parser "must degrade to unmeasured". It could not — the type
		// had no way to say so, and 0 is what a sub-millisecond run reports.
		// Now it can, so the assertion says what the comment always meant.
		expect(result.duration).toBeUndefined();
	});

	// --- vitest / jest JSON reporter (#1452) ---
	//
	// The payloads below are trimmed captures of REAL runs of a three-test file
	// (one 120ms pass, one fail, one skip) under vitest 4.1.10 and jest 30.4.2
	// on node 24.5.0. Trimmed of `snapshot`/`failureMessages`/suite counters
	// only — every field these assertions read is verbatim, including vitest's
	// float `endTime` and jest's `duration: null` on the skipped assertion.
	//
	// Note what is NOT in either capture: `perfStats`. It lives on jest's
	// internal TestResult, not on the JSON reporter's output, so a duration fix
	// that reads it would still report 0.

	const VITEST_JSON = JSON.stringify({
		numPassedTests: 1,
		numFailedTests: 1,
		numPendingTests: 1,
		numTodoTests: 0,
		startTime: 1786866554004,
		testResults: [
			{
				name: "/tmp/vtjson/sample.test.js",
				status: "failed",
				startTime: 1786866554330,
				endTime: 1786866554461.674,
				assertionResults: [
					{
						status: "passed",
						title: "slow pass",
						duration: 122.60340400000001,
					},
					{ status: "failed", title: "quick fail", duration: 8.674104 },
					{ status: "skipped", title: "skipped" },
				],
			},
		],
	});

	const JEST_JSON = JSON.stringify({
		numPassedTests: 1,
		numFailedTests: 1,
		numPendingTests: 1,
		numTodoTests: 0,
		startTime: 1786866618394,
		testResults: [
			{
				name: "/tmp/jestjson/sample.test.js",
				status: "failed",
				startTime: 1786866618477,
				endTime: 1786866619206,
				assertionResults: [
					{ status: "passed", title: "slow pass", duration: 124 },
					{ status: "failed", title: "quick fail", duration: 3 },
					{ status: "pending", title: "skipped", duration: null },
				],
			},
		],
	});

	it("extracts a real duration from a vitest --reporter=json payload", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseVitestOutput(
			VITEST_JSON,
			"",
			"/tmp/vtjson/sample.test.js",
			"/tmp/vtjson",
			"vitest",
		);

		expect(result.passed).toBe(1);
		expect(result.failed).toBe(1);
		// 1786866554461.674 - 1786866554330, rounded. Pinned exactly rather than
		// "> 0": the whole defect was a plausible-looking constant.
		expect(result.duration).toBe(132);
	});

	it("extracts a real duration from a jest --json payload", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseJestOutput(
			JEST_JSON,
			"",
			"/tmp/jestjson/sample.test.js",
			"/tmp/jestjson",
			"jest",
		);

		expect(result.passed).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.duration).toBe(729);
	});

	it("counts a skipped test from numPendingTests, which is what both reporters emit", () => {
		const client = new TestRunnerClient(false) as any;
		const vitest = client.parseVitestOutput(
			VITEST_JSON,
			"",
			"/tmp/vtjson/sample.test.js",
			"/tmp/vtjson",
			"vitest",
		);
		const jest = client.parseJestOutput(
			JEST_JSON,
			"",
			"/tmp/jestjson/sample.test.js",
			"/tmp/jestjson",
			"jest",
		);

		// Neither payload has `numSkippedTests`, which is the field the parser
		// used to read — so this was always 0 for a file with skips in it.
		expect(vitest.skipped).toBe(1);
		expect(jest.skipped).toBe(1);
	});

	// Both captures above happen to carry `numTodoTests: 0`, so the todo half of
	// the skip count is unasserted and can be deleted without failing anything.
	// Real runs do emit it: a `test.todo` alongside a `test.skip` gives
	// numPendingTests 1 / numTodoTests 1 on vitest 4.1.10 and jest 30.4.2.
	// Synthetic rather than captured — kept minimal so it is obviously not
	// passing itself off as one of the recorded payloads above.
	it("folds numTodoTests into the same skipped figure as numPendingTests", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseVitestOutput(
			JSON.stringify({
				numPassedTests: 1,
				numFailedTests: 0,
				numPendingTests: 1,
				numTodoTests: 2,
				testResults: [
					{
						name: "/tmp/vtjson/todo.test.js",
						status: "passed",
						startTime: 1786866554330,
						endTime: 1786866554430,
						assertionResults: [{ status: "passed", title: "p", duration: 1 }],
					},
				],
			}),
			"",
			"/tmp/vtjson/todo.test.js",
			"/tmp/vtjson",
			"vitest",
		);

		expect(result.skipped).toBe(3);
	});

	// A reporter that emits `numSkippedTests: 0` while a skip really did happen
	// must not resurrect the defect: `??` accepts a present 0, so the count has
	// to be the larger of the two readings rather than the first one found.
	it("does not let a zero numSkippedTests mask a real pending count", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseVitestOutput(
			JSON.stringify({
				numPassedTests: 1,
				numFailedTests: 0,
				numSkippedTests: 0,
				numPendingTests: 3,
				numTodoTests: 0,
				testResults: [
					{
						name: "/tmp/vtjson/mask.test.js",
						status: "passed",
						startTime: 1786866554330,
						endTime: 1786866554430,
						assertionResults: [{ status: "passed", title: "p", duration: 1 }],
					},
				],
			}),
			"",
			"/tmp/vtjson/mask.test.js",
			"/tmp/vtjson",
			"vitest",
		);

		expect(result.skipped).toBe(3);
	});

	it("falls back to summed assertion durations when a payload carries only perfStats", () => {
		const client = new TestRunnerClient(false) as any;
		// The pre-#1452 suggestion was to read `testResults[].perfStats`. This
		// payload is that hypothetical shape: perfStats present, the per-suite
		// epoch pair absent. The fallback keeps a real figure rather than 0.
		const result = client.parseVitestOutput(
			JSON.stringify({
				numPassedTests: 2,
				numFailedTests: 0,
				testResults: [
					{
						name: "/tmp/a.test.js",
						status: "passed",
						perfStats: { start: 1000, end: 1400, runtime: 400, slow: false },
						assertionResults: [
							{ status: "passed", title: "a", duration: 30.4 },
							{ status: "passed", title: "b", duration: 11.2 },
						],
					},
				],
			}),
			"",
			"/tmp/a.test.js",
			"/tmp",
			"vitest",
		);

		expect(result.duration).toBe(42);
	});

	it("reports the wall-clock span, not the sum, across parallel suites", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseJestOutput(
			JSON.stringify({
				numPassedTests: 2,
				numFailedTests: 0,
				testResults: [
					{
						name: "/tmp/a.test.js",
						status: "passed",
						startTime: 1000,
						endTime: 1500,
					},
					{
						name: "/tmp/b.test.js",
						status: "passed",
						startTime: 1100,
						endTime: 1900,
					},
				],
			}),
			"",
			"/tmp/a.test.js",
			"/tmp",
			"jest",
		);

		// Summing the two suites would claim 1300ms of elapsed time for a run
		// that took 900ms of wall clock.
		expect(result.duration).toBe(900);
	});

	it("reports unmeasured rather than a negative duration when suite timestamps are inverted", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseVitestOutput(
			JSON.stringify({
				numPassedTests: 1,
				numFailedTests: 0,
				testResults: [
					{
						name: "/tmp/a.test.js",
						status: "passed",
						startTime: 2000,
						endTime: 1000,
						assertionResults: [
							{ status: "passed", title: "a", duration: null },
						],
					},
				],
			}),
			"",
			"/tmp/a.test.js",
			"/tmp",
			"vitest",
		);

		// #1479: an inverted pair is garbage, not a measurement of zero. The
		// assertion sum is unavailable too (`duration: null`), so there is
		// nothing to report and the result says exactly that.
		expect(result.duration).toBeUndefined();
	});

	// --- #1479: unmeasured is a distinct state from zero ---
	//
	// Every case below pins an EXACT value rather than a relation. `> 0` would
	// accept the next plausible constant and `toBeFalsy()` would accept both
	// states at once, which is the confusion being removed.

	it("reports a measured zero when a readable suite pair has no elapsed span", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseVitestOutput(
			JSON.stringify({
				numPassedTests: 1,
				numFailedTests: 0,
				testResults: [
					{
						name: "/tmp/a.test.js",
						status: "passed",
						startTime: 1_760_000_000_000,
						endTime: 1_760_000_000_000,
						assertionResults: [
							{ status: "passed", title: "a", duration: null },
						],
					},
				],
			}),
			"",
			"/tmp/a.test.js",
			"/tmp",
			"vitest",
		);

		// The timestamps were read and they were equal. That is a sub-millisecond
		// run, not a missing measurement, and 0 is the honest figure.
		expect(result.duration).toBe(0);
	});

	it("reports unmeasured when a JSON payload carries no suite timing at all", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseVitestOutput(
			JSON.stringify({
				numPassedTests: 1,
				numFailedTests: 0,
				testResults: [
					{
						name: "/tmp/a.test.js",
						status: "passed",
						assertionResults: [
							{ status: "passed", title: "a", duration: null },
						],
					},
				],
			}),
			"",
			"/tmp/a.test.js",
			"/tmp",
			"vitest",
		);

		expect(result.duration).toBeUndefined();
	});

	it("reports unmeasured when a runner's output cannot be parsed at all", () => {
		const client = new TestRunnerClient(false) as any;
		// Unparseable stdout takes the emptyResult path — the same object a
		// runner crash and a spawn failure return. Nothing ran, so there is no
		// elapsed time; this used to carry `duration: 0`.
		const result = client.parseVitestOutput(
			"FAIL  not json at all\n",
			"",
			"/tmp/a.test.js",
			"/tmp",
			"vitest",
		);

		expect(result.error).toBe("Tests failed (could not parse output)");
		expect(result.duration).toBeUndefined();
	});

	it("reports unmeasured for pytest output with no summary line", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePytestOutput(
			"collected 0 items\n\nno tests ran\n",
			"",
			0,
			"/tmp/test_foo.py",
			"/tmp",
			"pytest",
		);

		expect(result.duration).toBeUndefined();
	});

	it("reports unmeasured when pytest's summary is detected but not extractable", () => {
		const client = new TestRunnerClient(false) as any;
		// PRE-EXISTING AND NOT CHANGED HERE: the summary DETECTOR carries `/i`
		// and every extractor below it does not, so an upper-cased summary is
		// recognised and then reads back as nothing — passed included. This
		// fixture is the only way to reach the parser's inner duration branch.
		// #1479's point is narrow: that branch used to substitute 0, and a 0 in
		// the turn-end log is a claim. It now declines to claim one.
		const result = client.parsePytestOutput(
			"=== 3 PASSED IN 0.50S ===\n",
			"",
			0,
			"/tmp/test_foo.py",
			"/tmp",
			"pytest",
		);

		expect(result.passed).toBe(0);
		expect(result.duration).toBeUndefined();
	});

	it("reports a measured zero for pytest's own `in 0.00s`", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePytestOutput(
			"=== 3 passed in 0.00s ===\n",
			"",
			0,
			"/tmp/test_foo.py",
			"/tmp",
			"pytest",
		);

		// pytest prints this for a fast file. It is a real reading and the only
		// reason `0` has to stay distinguishable from absence at all.
		expect(result.passed).toBe(3);
		expect(result.duration).toBe(0);
	});

	it("reports unmeasured for mix test output with no `Finished in` line", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseMixTestOutput(
			"3 tests, 0 failures\n",
			"",
			0,
			"/tmp/foo_test.exs",
			"mix",
		);

		expect(result.passed).toBe(3);
		expect(result.duration).toBeUndefined();
	});

	// --- mix test (ExUnit) ---

	it("detects mix via mix.exs", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "mix.exs"),
			"defmodule Demo.MixProject do\nend\n",
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).toBe("mix");
	});

	it("finds the mirrored ExUnit test file (lib/accounts/user.ex -> test/accounts/user_test.exs)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "mix.exs"),
			"defmodule Demo.MixProject do\nend\n",
		);
		const src = createTempFile(
			tmpDir,
			"lib/accounts/user.ex",
			"defmodule Demo.Accounts.User do\nend\n",
		);
		const testFile = createTempFile(
			tmpDir,
			"test/accounts/user_test.exs",
			"defmodule Demo.Accounts.UserTest do\nend\n",
		);

		const client = new TestRunnerClient(false);
		const found = client.findTestFile(src, tmpDir);
		expect(found?.runner).toBe("mix");
		expect(found?.testFile).toBe(testFile);
	});

	it("parses a passing mix test summary", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseMixTestOutput(
			"..\n\nFinished in 0.05 seconds\n2 tests, 0 failures\n",
			"",
			0,
			"/tmp/user_test.exs",
			"mix",
		);

		expect(result.passed).toBe(2);
		expect(result.failed).toBe(0);
		expect(result.duration).toBeCloseTo(50, 0);
	});

	it("parses a failing mix test summary with individual failures", () => {
		const client = new TestRunnerClient(false) as any;
		const output = [
			"  1) test creates a user (Demo.Accounts.UserTest)",
			"     test/accounts/user_test.exs:5",
			"     Assertion with == failed",
			"",
			"Finished in 0.08 seconds",
			"3 tests, 1 failure",
		].join("\n");
		const result = client.parseMixTestOutput(
			output,
			"",
			1,
			"/tmp/user_test.exs",
			"mix",
		);

		expect(result.passed).toBe(2);
		expect(result.failed).toBe(1);
		expect(result.failures[0].name).toBe("test creates a user");
		expect(result.failures[0].location).toBe("Demo.Accounts.UserTest");
	});
});

/**
 * Regression matrix for #1098: `resolveExec` used to drop
 * `config.args(testFile, cwd)[0]` UNCONDITIONALLY whenever local-bin or
 * global-bin resolution succeeded — an npx-wrapper-convention assumption
 * (arg 0 names the binary, like `npx vitest run …`) that only holds for
 * wrapper-style runners (vitest/jest/pytest). For direct runners whose
 * args() leads with a REAL subcommand (`cargo test --no-fail-fast`,
 * `go test -run . ./pkg`, `dotnet test --no-build`, `mvn test -q`,
 * `mix test <file>`), the same unconditional `.slice(1)` silently ate the
 * subcommand — e.g. `cargo test --no-fail-fast` became the argv-invalid
 * `cargo --no-fail-fast` (a clap usage error), which the runner then
 * misreported as "1/1 failed" at turn-end.
 *
 * The fix (`stripWrapperArgs` in clients/test-runner-client.ts) only drops
 * the leading arg(s) when they actually NAME the resolved binary — either
 * `[binName, ...]` (vitest/jest) or `["-m", binName, ...]` (pytest) — and
 * leaves everything else untouched.
 *
 * This asserts the invariant generically by iterating the EXPORTED
 * `RUNNERS` config table (not a hand-copied runner list), across every
 * resolution path `resolveExec` can take:
 *   - local-bin hit  (a real file dropped in node_modules/.bin, or
 *                      vendor/bin for phpunit's Composer convention)
 *   - global-bin hit (findGlobalBinary mocked to resolve)
 *   - fallback       (neither resolves; config.command is used verbatim)
 * so a future runner added to RUNNERS is automatically covered.
 *
 * The expected argv for each case is computed independently of the
 * production `stripWrapperArgs` helper (a local re-statement of the same
 * contract), so a regression that reintroduces unconditional stripping (or
 * any other over/under-stripping) fails this test rather than trivially
 * agreeing with whatever the implementation currently does.
 */
describe("resolveExec argv preservation matrix (#1098)", () => {
	const resolveCleanups: Array<() => void> = [];

	beforeEach(() => {
		findGlobalBinary.mockReset();
		findGlobalBinary.mockResolvedValue(undefined);
	});

	afterEach(() => {
		for (const c of resolveCleanups.splice(0)) c();
	});

	function expectedStrippedArgs(binName: string, args: string[]): string[] {
		if (args[0] === binName) return args.slice(1);
		if (args[0] === "-m" && args[1] === binName) return args.slice(2);
		return args;
	}

	function binSuffix(): string {
		return process.platform === "win32" ? ".cmd" : "";
	}

	for (const [runnerKey, config] of Object.entries(RUNNERS)) {
		const binName = config.binName ?? runnerKey;

		describe(`runner: ${runnerKey}`, () => {
			it("preserves argv on local-bin resolution", () => {
				const { tmpDir, cleanup } = setupTestEnvironment(
					"pi-lens-resolve-exec-",
				);
				resolveCleanups.push(cleanup);
				const client = new TestRunnerClient(false) as any;

				let localBinPath: string;
				if (runnerKey === "phpunit") {
					const phpSuffix = process.platform === "win32" ? ".bat" : "";
					localBinPath = path.join(
						tmpDir,
						"vendor",
						"bin",
						`phpunit${phpSuffix}`,
					);
				} else {
					localBinPath = path.join(
						tmpDir,
						"node_modules",
						".bin",
						`${binName}${binSuffix()}`,
					);
				}
				fs.mkdirSync(path.dirname(localBinPath), { recursive: true });
				fs.writeFileSync(localBinPath, "");

				const testFile = path.join(
					tmpDir,
					`sample_test${runnerKey === "go" ? ".go" : ".txt"}`,
				);
				const rawArgs = config.args(testFile, tmpDir);

				return client
					.resolveExec(runnerKey, config, testFile, tmpDir)
					.then((resolved: { command: string; args: string[] }) => {
						expect(resolved.command).toBe(localBinPath);
						// phpunit's local (vendor/bin) resolution never strips —
						// see the dedicated branch in resolveExec.
						const expected =
							runnerKey === "phpunit"
								? rawArgs
								: expectedStrippedArgs(binName, rawArgs);
						expect(resolved.args).toEqual(expected);
					});
			});

			if (runnerKey !== "phpunit") {
				// phpunit has no separate global-bin resolution step — its
				// non-local branch falls straight through to the fallback
				// (`command: "phpunit"`), so it's covered by the fallback case
				// below instead of duplicated here.
				it("preserves argv on global-bin resolution", () => {
					const { tmpDir, cleanup } = setupTestEnvironment(
						"pi-lens-resolve-exec-",
					);
					resolveCleanups.push(cleanup);
					const client = new TestRunnerClient(false) as any;

					const globalBinPath = path.join(tmpDir, "global-bin", binName);
					findGlobalBinary.mockImplementation(async (name: string) =>
						name === binName ? globalBinPath : undefined,
					);

					const testFile = path.join(
						tmpDir,
						`sample_test${runnerKey === "go" ? ".go" : ".txt"}`,
					);
					const rawArgs = config.args(testFile, tmpDir);

					return client
						.resolveExec(runnerKey, config, testFile, tmpDir)
						.then((resolved: { command: string; args: string[] }) => {
							expect(resolved.command).toBe(globalBinPath);
							expect(resolved.args).toEqual(
								expectedStrippedArgs(binName, rawArgs),
							);
						});
				});
			}

			it("preserves argv verbatim on fallback (no local/global bin)", () => {
				const { tmpDir, cleanup } = setupTestEnvironment(
					"pi-lens-resolve-exec-",
				);
				resolveCleanups.push(cleanup);
				const client = new TestRunnerClient(false) as any;

				const testFile = path.join(
					tmpDir,
					`sample_test${runnerKey === "go" ? ".go" : ".txt"}`,
				);
				const rawArgs = config.args(testFile, tmpDir);

				return client
					.resolveExec(runnerKey, config, testFile, tmpDir)
					.then((resolved: { command: string; args: string[] }) => {
						expect(resolved.command).toBe(
							runnerKey === "phpunit" ? "phpunit" : config.command,
						);
						// Fallback never resolves a binary to become the command, so
						// there is nothing to strip — args() is used verbatim.
						expect(resolved.args).toEqual(rawArgs);
					});
			});
		});
	}

	it("cargo's subcommand survives local-bin resolution (the reported #1098 case)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-resolve-exec-");
		resolveCleanups.push(cleanup);
		const client = new TestRunnerClient(false) as any;

		const localBinPath = path.join(
			tmpDir,
			"node_modules",
			".bin",
			`cargo${binSuffix()}`,
		);
		fs.mkdirSync(path.dirname(localBinPath), { recursive: true });
		fs.writeFileSync(localBinPath, "");

		const testFile = path.join(tmpDir, "src", "lib.rs");

		return client
			.resolveExec("cargo", RUNNERS.cargo, testFile, tmpDir)
			.then((resolved: { command: string; args: string[] }) => {
				expect(resolved.command).toBe(localBinPath);
				// Pre-fix, this was ["--no-fail-fast"] (the "test" subcommand was
				// eaten), producing a clap usage error at spawn time.
				expect(resolved.args).toEqual(["test", "--no-fail-fast"]);
			});
	});

	it("rspec resolves the real binary name (bundle), not the runner key", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-resolve-exec-");
		resolveCleanups.push(cleanup);
		const client = new TestRunnerClient(false) as any;

		const bundleBinPath = path.join(tmpDir, "global-bin", "bundle");
		findGlobalBinary.mockImplementation(async (name: string) =>
			name === "bundle" ? bundleBinPath : undefined,
		);

		const testFile = path.join(tmpDir, "spec", "foo_spec.rb");

		return client
			.resolveExec("rspec", RUNNERS.rspec, testFile, tmpDir)
			.then((resolved: { command: string; args: string[] }) => {
				expect(resolved.command).toBe(bundleBinPath);
				// "exec" is a real bundle subcommand, not the binary name — must
				// survive intact so `bundle exec rspec <file>` reaches bundle.
				expect(resolved.args).toEqual(["exec", "rspec", testFile]);
				expect(findGlobalBinary).toHaveBeenCalledWith("bundle");
			});
	});
});

// Unit tests for the CI failure classifier (#2103): infra-kill / infra-net /
// real, plus the once-per-SHA rerun guard and the sticky-comment upsert
// shape.
//
// Log fixtures under tests/fixtures/ci-failure-logs/ named *.real.log or
// *.composite.log are REAL captured output (AGENTS.md shape 16 -- never
// hand-write a fixture for an external system's behavior):
// The #2848 capture is a complete raw job log fetched for this round.
//   - real-assertion-failure.real.log: run 32913518938, job 98012237782
//     (fetch: `gh api repos/apmantza/pi-lens/actions/jobs/98012237782/logs`)
//   - infra-kill-wrapper-killed.real.log: run 32908647308 attempt 1, job
//     97998085238 -- the with-memory-watch.mjs wrapper was killed after its
//     last sample but before it could print a "[mem-watch] done"/"KILLED"
//     verdict line
//   - infra-kill-bare-killed-pre-wrapper.real.log: run 32888174877 (PR #2058,
//     pre-#2042), job 97933472353 -- predates the wrapper entirely, so a
//     bare "Killed" is the only signal
//   - real-failure-then-oom-kill.composite.log (review round 1, F2/P1): a
//     splice of two real excerpts -- job 98012237782's real inline
//     "❯ ... (5 tests | 1 failed)"/"× ..." markers (lines 534-539 of that
//     job's raw log) followed by job 97998085238's real "Killed"+exit-137
//     tail -- reproducing "OOM kill AFTER a test failed, before the
//     end-of-run summary prints" without fabricating either half's bytes.
// Files named *.unverified.log or *.synthetic.log are NOT captured fixtures
// (documented per shape 16, never claimed as verified):
//   - infra-net-getaddrinfo.unverified.log: no real pi-lens Unit-tests run
//     with a DNS/network failure was found in the accessible run history.
//   - file-level-collection-failure.synthetic.log (F2/P2): a representative
//     vitest file-level FAIL shape (import/collection error, no ">"
//     test-name separator) -- not pulled from a real pi-lens run.
//   - econnreset-in-test-output.synthetic.log (F2/P3): reuses the REAL
//     literal string this repo's own corpus ships
//     (tests/clients/smells-rollup.test.ts:124,
//     `{"outcome":"emit_failed","error":"ECONNRESET"}`) inside a synthetic
//     surrounding log, to prove that string alone must not flip an
//     unrecognized real failure to infra-net.
//   - infra-net-registry-reset-beside-test-timeout.real.log (#2839): run
//     34389495533 attempt 1, job 102594125043 (PR #2834, fetched via
//     `gh api repos/apmantza/pi-lens/actions/jobs/102594125043/logs`), raw
//     lines 2241-2259 (the npm-retry unit tests' own registry failures:
//     three `npm error code ECONNRESET`, `npm-retry: attempt 1..3 network
//     error`, the `##[error]infra: registry unreachable` annotations) joined
//     with raw lines 3928-3947 (the run's only test failure, a vitest
//     timeout: `FAIL ... tests/clients/flake-shape-ratchet.test.ts > ...` +
//     `Error: Test timed out in 5000ms.` + the summary block). One real
//     capture, two regions of it, nothing else omitted. Pre-#2839 this
//     classified real and no rerun was armed.
//   - infra-net-windows-crlf-prefix.real.log: runner-shaped evidence with
//     CRLF and leading annotations, based on the real Windows job
//     102669734529 from run 34412416504 (`gh run view --log`). The successful
//     job supplied the timestamp, annotation, and vitest line shapes; the
//     timeout/network combination is the #2839 fixture case.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildCommentBody,
	buildMarker,
	classifyFailureLog,
	decideClassifierAction,
	describeKernelKillEvidence,
	parseClassifierMarker,
	readCgroupOomKillCount,
	runClassifier,
	shouldTriggerRerun,
} from "../../scripts/lib/ci-failure-classifier.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures", "ci-failure-logs");
function fixture(name: string) {
	return readFileSync(join(fixturesDir, name), "utf8");
}

describe("classifyFailureLog (#2103)", () => {
	it("classifies a real assertion failure and extracts the failing test", () => {
		const result = classifyFailureLog(
			fixture("real-assertion-failure.real.log"),
		);
		expect(result.kind).toBe("real");
		expect(result.detail).toContain(
			"tests/clients/word-index-lifecycle.test.ts",
		);
		expect(result.detail).toContain(
			"reuses a fresh persisted snapshot without rebuilding",
		);
	});

	it("requires a compiler diagnostic line shape for TypeScript evidence", () => {
		expect(
			classifyFailureLog('echo "error TS2322: Type string is not assignable"'),
		).not.toEqual(
			expect.objectContaining({
				detail: expect.stringContaining("error TS2322:"),
			}),
		);
		expect(
			classifyFailureLog(
				"src/x.ts:12:3 - error TS2322: Type string is not assignable",
			),
		).toEqual(
			expect.objectContaining({
				kind: "real",
				detail: expect.stringContaining("error TS2322:"),
			}),
		);
	});

	it("classifies the wrapper-as-victim OOM shape (no mem-watch verdict at all)", () => {
		const result = classifyFailureLog(
			fixture("infra-kill-wrapper-killed.real.log"),
		);
		expect(result.kind).toBe("infra-kill");
		// The real log's last sample before the kill (line 30 of the fixture) --
		// proves the classifier reads the actual samples rather than emitting a
		// generic "OOM happened" string with no evidence behind it.
		expect(result.detail).toContain("availableMb=12999 of 15989");
	});

	it("classifies the #2848 exit-137 log as infra despite incidental output needles", () => {
		const result = classifyFailureLog(fixture("infra-kill-2848.real.log"));
		expect(result.kind).toBe("infra-kill");
		expect(result.detail).toContain(
			"tests/index-integration.test.ts (1406 MB)",
		);
		expect(result.detail).toContain(
			"tests/clients/flake-shape-ratchet.test.ts (1300 MB)",
		);
		expect(result.detail).toContain(
			"tests/config/lsp-service-double-sweep.test.ts (945 MB)",
		);
		expect(result.detail).toMatch(
			/heaviest files by peak RSS: tests\/index-integration\.test\.ts \(1406 MB\), tests\/clients\/flake-shape-ratchet\.test\.ts \(1300 MB\), tests\/config\/lsp-service-double-sweep\.test\.ts \(945 MB\)/,
		);
	});

	it.each([
		"2026-09-09T00:00:00.0000000Z  FAIL default tests/a.test.ts > broken\n",
		"2026-09-09T00:00:00.0000000Z  Test Files  1 failed | 2 passed (3)\n",
		"2026-09-09T00:00:00.0000000Z  Tests  1 failed | 2 passed (3)\n",
	])("keeps summary failure evidence real beside exit 137 (%s)", (failure) => {
		const result = classifyFailureLog(
			`${failure}[mem-watch] KILLED WITH HEADROOM signal=SIGKILL totalMb=15989 lowWaterAvailableMb=12564\nexit code 137\n`,
		);
		expect(result.kind).toBe("real");
	});

	it("ignores malformed peak-RSS rows without throwing", () => {
		expect(() =>
			classifyFailureLog(
				"[mem-file] peakRssMb=not-a-number tests/bad.test.ts\n" +
					"[mem-file] peakRssMb=42\n" +
					"[mem-watch] KILLED WITH HEADROOM signal=SIGKILL totalMb=15989 lowWaterAvailableMb=12564\n",
			),
		).not.toThrow();
	});

	it("classifies the pre-#2042 bare-Killed OOM shape (no wrapper existed yet)", () => {
		const result = classifyFailureLog(
			fixture("infra-kill-bare-killed-pre-wrapper.real.log"),
		);
		expect(result.kind).toBe("infra-kill");
		expect(result.detail).toContain(
			"no [mem-watch] verdict line -- the run ended before any verdict was printed",
		);
	});

	it("classifies the mem-watch KILLED verdict when the wrapper survives to report it", () => {
		// Exercises the literal string formatVerdict() in
		// scripts/lib/memory-watch.mjs actually emits (verified against that
		// shipped source, not guessed) -- no real captured log has this shape
		// on hand because it requires the wrapper to survive the kill, which
		// the two real OOM fixtures above did not.
		const log =
			"...\n[mem-watch] KILLED — no failing assertion means the OS reclaimed memory, not a test failure. signal=SIGKILL totalMb=15990 lowWaterAvailableMb=102 lowWaterAt=12:00:00\n##[error]Process completed with exit code 137.\n";
		const result = classifyFailureLog(log);
		expect(result.kind).toBe("infra-kill");
		expect(result.detail).toContain("[mem-watch] KILLED");
	});

	// #2230's re-home comment on #2103, point 1: ci.yml's "Kernel kill
	// evidence" step (`if: failure()`) runs inside the SAME job as "Run
	// tests", so its dmesg/cgroup output is already in the log this module
	// reads. UNVERIFIED (AGENTS.md shape 16): no real captured log with this
	// step's output exists yet (both real OOM fixtures predate the step), so
	// these sections are built from the step's own echoed strings in ci.yml
	// (lines 194-231), quoted verbatim, not guessed. Additive only: kind and
	// the rerun decision are unchanged either way.
	describe("kernel kill-evidence enrichment (#2103, additive, UNVERIFIED)", () => {
		it("appends a dmesg OOM hit to the detail", () => {
			const log =
				`${fixture("infra-kill-wrapper-killed.real.log")}\n` +
				"--- kernel OOM/kill records ---\n" +
				"[12345.678901] Out of memory: Killed process 2464 (npm) total-vm:123456kB\n" +
				"--- systemd-oomd ---\n";
			const result = classifyFailureLog(log);
			expect(result.kind).toBe("infra-kill");
			expect(result.detail).toContain(
				"kernel evidence: dmesg -- [12345.678901] Out of memory: Killed process 2464 (npm) total-vm:123456kB",
			);
		});

		it("appends a cgroup oom_kill counter to the detail", () => {
			const log =
				`${fixture("infra-kill-wrapper-killed.real.log")}\n` +
				"--- cgroup memory.events ---\n" +
				"cgroup=/actions_job file=/sys/fs/cgroup/actions_job/memory.events\n" +
				"low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n";
			const result = classifyFailureLog(log);
			expect(result.kind).toBe("infra-kill");
			expect(result.detail).toContain("kernel evidence: cgroup oom_kill=1");
		});

		it("notes when dmesg and cgroup both show no records, without changing kind", () => {
			const log =
				`${fixture("infra-kill-wrapper-killed.real.log")}\n` +
				"--- kernel OOM/kill records ---\n" +
				"(dmesg readable, zero OOM/kill records - the kernel OOM killer did not fire)\n" +
				"--- systemd-oomd ---\n" +
				"(journalctl unavailable)\n" +
				"--- cgroup memory.events ---\n" +
				"cgroup=/actions_job file=/sys/fs/cgroup/actions_job/memory.events\n" +
				"low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n";
			const result = classifyFailureLog(log);
			expect(result.kind).toBe("infra-kill");
			expect(result.detail).toContain(
				"kernel evidence: dmesg and cgroup both show no OOM/kill records",
			);
		});

		it("adds nothing when the kernel kill-evidence step never ran (today's real fixtures)", () => {
			// Mutation-proof for "additive": this is the exact real fixture with
			// NO kernel-evidence section, so the enrichment must be a no-op --
			// the pre-#2230 detail text is unchanged.
			const result = classifyFailureLog(
				fixture("infra-kill-wrapper-killed.real.log"),
			);
			expect(result.detail).not.toContain("kernel evidence");
		});
	});

	describe("describeKernelKillEvidence / readCgroupOomKillCount (unit, #2103)", () => {
		it("returns null when the log has no kernel-evidence section", () => {
			expect(describeKernelKillEvidence("plain log, no sections\n")).toBeNull();
			expect(readCgroupOomKillCount("plain log, no sections\n")).toBeNull();
		});

		it("returns null when dmesg is unavailable and cgroup file is unreadable", () => {
			const log =
				"--- kernel OOM/kill records ---\n" +
				"(dmesg unavailable or empty - no evidence either way)\n" +
				"--- systemd-oomd ---\n" +
				"(journalctl unavailable)\n" +
				"--- cgroup memory.events ---\n" +
				"(memory.events absent or unreadable from '/actions_job' up to root - no cgroup evidence either way)\n";
			expect(describeKernelKillEvidence(log)).toBeNull();
			expect(readCgroupOomKillCount(log)).toBeNull();
		});
	});

	it("classifies a getaddrinfo/DNS network failure as infra-net (UNVERIFIED shape, see file header)", () => {
		const result = classifyFailureLog(
			fixture("infra-net-getaddrinfo.unverified.log"),
		);
		expect(result.kind).toBe("infra-net");
		expect(result.detail).toContain("ENOTFOUND");
	});

	// Acceptance criterion: "Real failures are never rerun automatically and
	// never labeled infra." A real FAIL block can coexist with an unrelated
	// "Killed" elsewhere in the same log (a spawned linter's child process,
	// noise from a different tool) -- the real classification must win.
	it("never labels a log infra when it also contains a FAIL block, even alongside Killed/137 noise", () => {
		const log =
			`${fixture("infra-kill-wrapper-killed.real.log")}\n` +
			`${fixture("real-assertion-failure.real.log")}`;
		const result = classifyFailureLog(log);
		expect(result.kind).toBe("real");
	});

	// Spec default (#2103 proposal step 1: "otherwise real"). An unrecognized
	// failure shape must default to real, not infra -- treating "we don't
	// understand this" as infra would make an unknown, possibly-persistent
	// failure eligible for an automatic rerun loop.
	it("defaults an unrecognized failure shape to real, not infra", () => {
		const log =
			"some tool crashed with a stack trace\n##[error]Process completed with exit code 1.\n";
		const result = classifyFailureLog(log);
		expect(result.kind).toBe("real");
	});

	// --- Review round 1 findings ---------------------------------------

	// F1 (BLOCKING, vacuous guard): the ONLY thing distinguishing "an OOM
	// kill" from "the word Killed appeared in unrelated output" is the
	// EXIT_137_SHAPED conjunct. This fixture has NO real fixture behind it
	// on purpose -- it exists to pin the CODE's requirement, not to claim a
	// real run produces this shape. Mutation-proof: deleting `&&
	// EXIT_137_SHAPED.test(log)` from classifyFailureLog leaves this exact
	// assertion red (the log falls through to the "otherwise real" default
	// either way, but only because of that conjunct -- see the probe log in
	// the PR body).
	it("F1: a bare 'Killed' with NO exit-137/SIGKILL evidence anywhere is NOT infra-kill", () => {
		const log =
			"some-subprocess: Killed by user request, exiting cleanly\n" +
			"##[error]Process completed with exit code 1.\n";
		const result = classifyFailureLog(log);
		expect(result.kind).not.toBe("infra-kill");
	});

	// F2/P1 (BLOCKING): an OOM kill immediately after a test's inline failure
	// marker prints, but before vitest's end-of-run "Failed Tests" summary
	// block ever gets a chance to print, must still classify real -- the kill
	// destroyed the summary, not the fact that a test failed.
	it("F2/P1: an OOM kill AFTER an inline test failure (no end-of-run summary ever printed) classifies real", () => {
		const result = classifyFailureLog(
			fixture("real-failure-then-oom-kill.composite.log"),
		);
		expect(result.kind).toBe("real");
		expect(result.detail).toContain(
			"tests/clients/word-index-lifecycle.test.ts",
		);
	});

	// F2/P2 (BLOCKING): a file-level FAIL (import/collection error) has no
	// test to name, so it has no "> testname" segment -- FAIL_LINE alone
	// misses it entirely.
	it("F2/P2: a file-level FAIL with no '> testname' segment classifies real", () => {
		const result = classifyFailureLog(
			fixture("file-level-collection-failure.synthetic.log"),
		);
		expect(result.kind).toBe("real");
		expect(result.detail).toContain("tests/clients/broken-import.test.ts");
	});

	// F2/P3 (BLOCKING): NET_PATTERN's bare \bECONNRESET\b matched ANYWHERE in
	// the log, including inside a test's own console output -- this repo's
	// own corpus ships that literal string. An unrecognized real failure
	// must not flip to infra-net just because that text appears somewhere
	// unrelated.
	it("F2/P3: ECONNRESET inside unrelated test output does not flip an unrecognized failure to infra-net", () => {
		const result = classifyFailureLog(
			fixture("econnreset-in-test-output.synthetic.log"),
		);
		expect(result.kind).toBe("real");
	});

	// F2/P3 companion: the genuine infra-net shape (network error text on a
	// line that ALSO carries an explicit "npm error"/"##[error]" prefix)
	// must still classify infra-net -- the fix scopes the pattern, it
	// doesn't disable it.
	it("F2/P3 companion: a genuine npm-error-prefixed network failure still classifies infra-net", () => {
		const result = classifyFailureLog(
			fixture("infra-net-getaddrinfo.unverified.log"),
		);
		expect(result.kind).toBe("infra-net");
	});

	// Round 3 HIGH: the shared CI pattern must not treat a token mentioned by
	// a real compiler/linter/knip error, URL, or test name as network evidence.
	it("round 3: token mentions in real error contexts remain real", () => {
		const logs = [
			'##[error] src/foo.ts(1,7): error TS2322: Type "ETIMEDOUT" is not assignable',
			"##[error] /src/foo.js:1:1 error socket hang up no-socket-rule",
			"##[error] knip: https://example.test/502/status unused export",
			"##[error] test name: retries after ECONNRESET (expected real failure)",
		];
		for (const log of logs) {
			expect(classifyFailureLog(log).kind, log).toBe("real");
		}
	});

	// Round 3 MEDIUM: inspect all bounded eligible error lines, not only the
	// first one, so npm's deterministic preamble cannot hide later network data.
	it("round 3: a later eligible npm error line still classifies infra-net", () => {
		const result = classifyFailureLog(
			"npm error ERESOLVE unable to resolve dependency tree\nnpm error ECONNRESET\n",
		);
		expect(result.kind).toBe("infra-net");
	});

	// Regression proof for the shared NET_PATTERN consumer: a newly recognized
	// npm network line must reach the real classifier, not only npm-retry.
	it("recognizes the shared npm and registry network shapes as infra-net", () => {
		const shapes = [
			"ENOTFOUND",
			"ECONNRESET",
			"tarball package download failed",
			"net::ERR_NAME_NOT_RESOLVED",
		];
		for (const shape of shapes) {
			expect(classifyFailureLog(`npm error ${shape}`).kind, shape).toBe(
				"infra-net",
			);
		}
	});

	it("recognizes today's quoted CI infrastructure needles", () => {
		const excerpts = [
			["SARIF upload", "Error: Unable to upload SARIF file: HTTP 503"],
			[
				"CodeQL initialization",
				"Initialize CodeQL: The request failed with HTTP 503",
			],
			[
				"codeload 429",
				"npm error request to https://codeload.github.com/acme/repo/tar.gz failed: 429 Too Many Requests",
			],
			[
				"codeload 503",
				"npm error request to https://codeload.github.com/acme/repo/tar.gz failed: 503 Service Unavailable",
			],
			[
				"npm ci timeout",
				"npm ci --no-audit\nnpm error code ETIMEDOUT\nnpm error network request timed out",
			],
		];
		for (const [name, excerpt] of excerpts) {
			expect(classifyFailureLog(excerpt).kind, name).toBe("infra-net");
		}
	});

	it("keeps quoted Vitest and TypeScript failures real", () => {
		const excerpts = [
			"Test Files 1 failed | 42 passed",
			"AssertionError: expected 1 to be 2",
			"error TS2322: Type 'string' is not assignable to type 'number'",
		];
		for (const excerpt of excerpts) {
			expect(classifyFailureLog(excerpt).kind, excerpt).toBe("real");
		}
	});

	it("round 3: npm-only network shapes stay real for the CI classifier", () => {
		const shapes = [
			"ETIMEDOUT",
			"EAI_AGAIN",
			"503 Service Unavailable",
			"429 Too Many Requests",
			"socket hang up",
			"network error",
			"ECONNREFUSED",
			"EPIPE",
			"ENETUNREACH",
			"EHOSTUNREACH",
			"FETCH_ERROR",
			"ERR_SOCKET_TIMEOUT",
			"502",
			"504",
			"registry unreachable",
		];
		for (const shape of shapes) {
			expect(classifyFailureLog(`npm error ${shape}`).kind, shape).toBe("real");
		}
	});

	// F5: empty log is distinguishable from "read something, didn't
	// recognize it" -- the two are different failure modes (fetch itself
	// failed / raced the upload, vs. a genuinely new failure shape).
	it("F5: an empty log is classified real with a distinct 'empty log' detail", () => {
		const result = classifyFailureLog("");
		expect(result.kind).toBe("real");
		expect(result.detail).toContain("empty log");
		const whitespaceOnly = classifyFailureLog("   \n\t \n");
		expect(whitespaceOnly.detail).toContain("empty log");
	});

	it("F5: an unrecognized NON-empty log gets a different detail than an empty one", () => {
		const nonEmpty = classifyFailureLog("nothing recognizable happened here");
		const empty = classifyFailureLog("");
		expect(nonEmpty.detail).not.toBe(empty.detail);
		expect(nonEmpty.detail).not.toContain("empty log");
	});

	// F5: bound the read BEFORE interpretation (#2096 shape). A signal that
	// exists only in the discarded HEAD of an oversized log must have no
	// effect -- this is deliberately lossy, and the test proves the cap is
	// actually applied (not merely documented): removing the truncation
	// step would let the head-of-log signal through and flip this from
	// "real" to "infra-net".
	it("F5: content beyond the log-size cap is not seen by the classifier", () => {
		const oversizedHead = `npm error getaddrinfo ENOTFOUND registry.npmjs.org\n${"x".repeat(3 * 1024 * 1024)}`;
		const log = `${oversizedHead}\n##[error]Process completed with exit code 1.\n`;
		const result = classifyFailureLog(log);
		expect(result.kind).toBe("real");
	});

	// Round 4 recurrence: the eligible-line bound must remain active, or a
	// pathological log can make a late network token change a real verdict.
	it("round 4: the 1,001st eligible line is outside the scan bound", () => {
		const log = [
			...Array.from({ length: 1_000 }, () => "npm error unrelated"),
			"npm error code ECONNRESET",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("real");
	});

	// V4 (BLOCKING, red-proof with the reviewer's fabricated-title shape): a
	// PASSING test titled "does not FAIL when tests/b.test.ts is absent"
	// contains the literal word "FAIL" and a filename-shaped token in its own
	// title -- an unanchored BARE_FAIL_LINE fabricated "tests/b.test.ts" as
	// the failing file and misclassified a genuine OOM kill as real (safe
	// direction, but reimposes the manual-read tax this classifier exists to
	// remove). Fixture: real OOM-kill log (infra-kill-wrapper-killed.real.log)
	// with that exact fabricated-title line spliced in among the passing
	// tests -- every surrounding byte is the real capture; only the inserted
	// line is synthetic.
	it("V4: a fabricated FAIL inside a passing test's own title does not mask a genuine OOM kill", () => {
		const result = classifyFailureLog(
			fixture("fabricated-fail-in-passing-title.composite.log"),
		);
		expect(result.kind).toBe("infra-kill");
	});

	// --- #2839: a test timeout beside network-unreachable evidence is infra --
	//
	// Recurrence (#2839): PR #2834 and, within the hour, PR #2835 both logged
	// registry ECONNRESET through every npm-retry attempt plus ONE test-level
	// failure shaped as a vitest timeout, and the classifier labelled both
	// `ci:real` because the timeout prints as a FAIL block (FAIL_LINE outranks
	// network evidence) -- no rerun was armed, and the maintainer re-ran both
	// by hand. The demotion below is deliberately narrow: the network
	// evidence AND the absence of any AssertionError/compiler diagnostic are
	// both required, so a genuine assertion failure beside network noise
	// still wins as real.

	// (a) The real #2834 excerpt (see the file header for provenance). Red
	// first: on pre-#2839 code this classified real.
	it("#2839 (a): the #2834 log's timeout beside registry ECONNRESET classifies infra-net", () => {
		const result = classifyFailureLog(
			fixture("infra-net-registry-reset-beside-test-timeout.real.log"),
		);
		expect(result.kind).toBe("infra-net");
		expect(result.detail).toContain("Test timed out in 5000ms");
		expect(result.detail).toContain("ECONNRESET");
	});

	// (b) The same record with a different timeout line: the rule keys on the
	// timeout shape, not the 5000ms value or the specific test name.
	it("#2839 (b): a different timeout line beside the same network evidence still classifies infra-net", () => {
		const log = fixture(
			"infra-net-registry-reset-beside-test-timeout.real.log",
		).replace("Test timed out in 5000ms.", "Test timed out in 10000ms.");
		expect(log).toContain("Test timed out in 10000ms.");
		expect(classifyFailureLog(log).kind).toBe("infra-net");
	});

	// Vitest emits both spellings from one template: `${isHook ? "Hook" :
	// "Test"} timed out in ${timeout}ms`. Keep the hook member in the same
	// regression family so a hook starved by registry load gets the same retry.
	it("#2839 (b2): a vitest hook timeout beside network evidence classifies infra-net", () => {
		const log = [
			"npm error code ECONNRESET",
			"npm-retry: attempt 1 network error: ECONNRESET",
			" FAIL default tests/a.test.ts > hook-backed test",
			"Error: Hook timed out in 300ms.",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("infra-net");
	});

	it("#2839: Windows CRLF and GitHub error annotations normalize once", () => {
		expect(
			classifyFailureLog(fixture("infra-net-windows-crlf-prefix.real.log"))
				.kind,
		).toBe("infra-net");
	});

	// The demotion is positive evidence: every test-level FAIL block must have
	// a timeout as its first error. A neighboring thrown failure stays real.
	it("#2839 F2: a TypeError in a second FAIL block stays real", () => {
		const log = [
			"npm error code ECONNRESET",
			"npm-retry: attempt 1 network error: ECONNRESET",
			" FAIL default tests/a.test.ts > slow sweep",
			"Error: Test timed out in 5000ms.",
			" FAIL default tests/b.test.ts > parses payload",
			"TypeError: Cannot read properties of undefined (reading 'map')",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("real");
	});

	// Mutation proof for the FAIL-block count guard: the file-level FAIL has no
	// FAIL_LINE match, so dropping the count comparison would demote the timeout.
	it("#2839 F2: an unparsed file-level FAIL keeps the run real", () => {
		const log = [
			"npm error code ECONNRESET",
			" FAIL default tests/collection.test.ts",
			"Error: Cannot find module './missing'",
			" FAIL default tests/a.test.ts > slow sweep",
			"Error: Test timed out in 5000ms.",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("real");
	});

	// Shape 43 recurrence: detector needles must not consume a test title or
	// console echo as evidence. Only the FAIL block's error and npm-owned lines
	// can arm this demotion.
	it("#2839 F3: echoed timeout and network text stays real", () => {
		const log = [
			'console.log "npm error code ECONNRESET"',
			" FAIL default tests/a.test.ts > mentions Test timed out in 5000ms",
			"TypeError: Cannot read properties of undefined (reading 'map')",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("real");
	});

	it("#2839 F3: a console echo of npm error stays out of network evidence", () => {
		const log = [
			'console.log "npm error code ECONNRESET"',
			" FAIL default tests/a.test.ts > starved test",
			"Error: Test timed out in 5000ms.",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("real");
	});

	// Mutation proof for the first-error predicate: a later echoed timeout must
	// not replace a block whose first error is a TypeError.
	it("#2839 F3: a later timeout echo does not replace the first real error", () => {
		const log = [
			"npm error code ECONNRESET",
			" FAIL default tests/a.test.ts > broken parser",
			"TypeError: Cannot read properties of undefined (reading 'map')",
			"console.log Test timed out in 5000ms",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("real");
	});

	// (c) An AssertionError beside the same network evidence still wins as
	// real -- the demotion must never eat a genuine assertion failure.
	it("#2839 (c): an AssertionError beside registry ECONNRESET stays real", () => {
		const log = [
			"npm error code ECONNRESET",
			"npm error code ECONNRESET",
			"npm-retry: attempt 1 network error: ECONNRESET",
			" FAIL default tests/a.test.ts > assertion beside timeout",
			"Error: Test timed out in 5000ms.",
			"AssertionError: expected 2 to be 1",
			"",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("real");
	});

	it("#2839 F4: a compiler diagnostic beside a timeout stays real", () => {
		const log = [
			"npm error code ECONNRESET",
			"npm-retry: attempt 1 network error: ECONNRESET",
			" FAIL default tests/a.test.ts > compiler-backed test",
			"Error: Test timed out in 5000ms.",
			"src/a.ts(12,34): error TS2322: Type string is not assignable",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("real");
	});

	// (d) A lone timeout with NO network evidence is unchanged from
	// pre-#2839: real. This is the mutation-proof anchor for the network
	// precondition -- deleting that precondition flips this log to infra-net.
	it("#2839 (d): a lone test timeout with no network evidence stays real", () => {
		expect(classifyFailureLog("Error: Test timed out in 5000ms.\n").kind).toBe(
			"real",
		);
	});

	// (e) The npm-retry wrapper's own attempt line is network evidence on its
	// own. The line shape is quoted from scripts/npm-retry.mjs's literal
	// `npm-retry: attempt ${attempt + 1} ${reason}` print (verified against
	// that shipped source, like the mem-watch KILLED fixture above); no real
	// capture has this shape alone because the wrapper echoes npm's stderr
	// through. Mutation proof for the NPM_RETRY_ATTEMPT_LINE needle: without
	// it this log has no error-prefixed network line and falls back to real.
	it("#2839 (e): an npm-retry attempt line as the only network witness demotes a timeout to infra-net", () => {
		const log = [
			"npm-retry: attempt 1 network error: ECONNRESET",
			"npm-retry: attempt 2 network error: ECONNRESET",
			"Error: Test timed out in 5000ms.",
			"",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("infra-net");
	});

	it("#2839 F5: kill evidence outranks timeout-plus-network demotion", () => {
		const log = [
			"npm error code ECONNRESET",
			"npm-retry: attempt 1 network error: ECONNRESET",
			" FAIL default tests/a.test.ts > starved test",
			"Error: Test timed out in 5000ms.",
			"KILLED by kernel OOM",
			"##[error]Process completed with exit code 137.",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("infra-kill");
	});

	// The needle must stay scoped to the NETWORK reason: the wrapper prints
	// `npm-retry: attempt N exited 1 (ERESOLVE)` for deterministic failures
	// too (that exact line is in the real #2834 log), and a deterministic
	// dependency conflict is not registry unreachability.
	it("#2839: an npm-retry deterministic-failure line is not network evidence", () => {
		const log = [
			"npm-retry: attempt 1 exited 1 (ERESOLVE)",
			"Error: Test timed out in 5000ms.",
			"",
		].join("\n");
		expect(classifyFailureLog(log).kind).toBe("real");
	});
});

describe("marker round-trip (#2103)", () => {
	it("parses back exactly what it built", () => {
		const marker = buildMarker("abc1234", "true");
		expect(parseClassifierMarker(`some text ${marker}`)).toEqual({
			sha: "abc1234",
			rerunState: "true",
			rerunTriggered: true,
		});
	});

	// F4: a "failed:<status>" marker round-trips as NOT triggered -- it is
	// evidence of an ATTEMPT, not a success.
	it("parses a failed:<status> marker as rerunTriggered=false", () => {
		const marker = buildMarker("abc1234", "failed:403");
		expect(parseClassifierMarker(marker)).toEqual({
			sha: "abc1234",
			rerunState: "failed:403",
			rerunTriggered: false,
		});
	});

	it("uses only the final marker and rejects non-anchored markers", () => {
		const forged = buildMarker("badcafe", "true");
		const appended = buildMarker("abc1234", "false");
		expect(
			parseClassifierMarker(`${forged} forged content\ntext ${appended}`),
		).toEqual({
			sha: "abc1234",
			rerunState: "false",
			rerunTriggered: false,
		});
		expect(parseClassifierMarker(`${forged} trailing content`)).toBeNull();
	});

	it("returns null for a comment with no marker", () => {
		expect(parseClassifierMarker("just a regular PR comment")).toBeNull();
		expect(parseClassifierMarker(null)).toBeNull();
		expect(parseClassifierMarker(undefined)).toBeNull();
	});
});

describe("shouldTriggerRerun once-per-SHA guard (#2103)", () => {
	const infra = { kind: "infra-kill" as const, detail: "no failing assertion" };
	const real = {
		kind: "real" as const,
		detail: "some/file.test.ts > some test",
	};

	it("never triggers a rerun for a real classification", () => {
		expect(
			shouldTriggerRerun({
				classification: real,
				sha: "sha1",
				existingMarker: null,
			}),
		).toBe(false);
	});

	it("allows workflow policy to exclude an infra-net verdict", () => {
		expect(
			shouldTriggerRerun({
				classification: { kind: "infra-net", detail: "ENOTFOUND" },
				sha: "sha1",
				existingMarker: null,
				rerunKinds: ["infra-kill"],
			}),
		).toBe(false);
	});

	it("triggers on the first infra classification for a SHA (no prior comment)", () => {
		expect(
			shouldTriggerRerun({
				classification: infra,
				sha: "sha1",
				existingMarker: null,
			}),
		).toBe(true);
	});

	// Mutation-proof screen: this is the guard itself. Deleting the
	// `existingMarker.sha === sha && existingMarker.rerunTriggered` condition
	// (e.g. replacing the function body with `return true`) turns this
	// specific assertion red -- it is the one case where "already reran, same
	// commit" must block a second rerun.
	it("does NOT re-trigger for the same SHA once the marker already recorded rerun=true", () => {
		expect(
			shouldTriggerRerun({
				classification: infra,
				sha: "sha1",
				existingMarker: { sha: "sha1", rerunTriggered: true },
			}),
		).toBe(false);
	});

	it("does trigger again for a NEW sha, even if the previous sha was already rerun", () => {
		expect(
			shouldTriggerRerun({
				classification: infra,
				sha: "sha2",
				existingMarker: { sha: "sha1", rerunTriggered: true },
			}),
		).toBe(true);
	});

	it("still allows a rerun when the prior marker for this SHA recorded rerun=false", () => {
		// e.g. the first pass classified this SHA as real (rerun=false stored),
		// and a later re-run of the classifier on the same SHA reclassifies as
		// infra -- the guard only blocks an ALREADY-TRIGGERED rerun, not every
		// repeat visit to the SHA.
		expect(
			shouldTriggerRerun({
				classification: infra,
				sha: "sha1",
				existingMarker: { sha: "sha1", rerunTriggered: false },
			}),
		).toBe(true);
	});

	// F4: a prior "failed:<status>" marker (a rerun ATTEMPT that itself
	// failed, e.g. a 403 because actions:write isn't granted) must still
	// allow a retry -- only a confirmed SUCCESS blocks.
	it("still allows a rerun when the prior marker for this SHA recorded a failed rerun attempt", () => {
		expect(
			shouldTriggerRerun({
				classification: infra,
				sha: "sha1",
				existingMarker: {
					sha: "sha1",
					rerunTriggered: false,
					rerunState: "failed:403",
				},
			}),
		).toBe(true);
	});

	it("simulates two consecutive classifier passes on the same SHA end-to-end via decideClassifierAction", () => {
		const rawLog = fixture("infra-kill-wrapper-killed.real.log");
		const sha = "deadbeef";

		const first = decideClassifierAction({
			rawLog,
			sha,
			existingCommentBody: null,
		});
		expect(first.rerunTriggeredThisPass).toBe(true);

		// The second pass reads back the comment the first pass would have
		// posted -- this is the realistic call shape the CLI's runClassifier
		// uses (existing comment body -> marker -> guard).
		const second = decideClassifierAction({
			rawLog,
			sha,
			existingCommentBody: first.commentBody,
		});
		expect(second.rerunTriggeredThisPass).toBe(false);
	});
});

describe("runClassifier orchestration against a mocked, STATEFUL GitHub API (#2103)", () => {
	function jsonResponse(body: unknown, status = 200) {
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
			text: async () => JSON.stringify(body),
		};
	}
	function textResponse(body: string, status = 200) {
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => JSON.parse(body),
			text: async () => body,
		};
	}
	function noContentResponse(status = 204) {
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => {
				throw new Error("no body");
			},
			text: async () => "",
		};
	}

	/**
	 * A stateful fake: comments actually persist across calls (POST appends,
	 * PATCH updates, DELETE removes), which is what makes the F3 concurrent
	 * -invocation and F4 retry-after-failure scenarios meaningfully testable
	 * -- a static per-call fixture can't reproduce either race.
	 */
	function makeStatefulApi({
		initialComments = [] as Array<{ id: number; body: string }>,
		rerunHandler,
		concurrentInvocations = 0,
	}: {
		initialComments?: Array<{ id: number; body: string }>;
		rerunHandler?: () => { ok: boolean; status: number };
		/**
		 * F3/V1 only: force every GROUP of N concurrent GET .../comments calls
		 * (across N overlapping runClassifier invocations sharing this same
		 * api) to arrive before any of them proceeds. This is what actually
		 * reproduces "every read happens before any write" deterministically
		 * -- a single-invocation test that also hits this endpoint twice
		 * (initial read, then the reconcile read) would otherwise deadlock
		 * waiting for group-mates that never come, since those two calls are
		 * sequential within one invocation. 0 (default) disables the barrier;
		 * only pass N for exactly N genuinely concurrent invocations sharing
		 * one api instance.
		 */
		concurrentInvocations?: number;
	} = {}) {
		const calls: Array<{ method: string; url: string; body?: unknown }> = [];
		const rawLog = fixture("infra-kill-wrapper-killed.real.log");
		const comments = [...initialComments];
		let nextId = comments.reduce((max, c) => Math.max(max, c.id), 100) + 1;
		let rerunCallCount = 0;

		let commentsGetCount = 0;
		let pendingBarrierResolvers: Array<() => void> = [];
		async function commentsGetBarrier() {
			commentsGetCount++;
			const posInGroup = ((commentsGetCount - 1) % concurrentInvocations) + 1;
			if (posInGroup < concurrentInvocations) {
				await new Promise<void>((resolve) => {
					pendingBarrierResolvers.push(resolve);
				});
			} else {
				const resolvers = pendingBarrierResolvers;
				pendingBarrierResolvers = [];
				for (const resolve of resolvers) resolve();
			}
		}

		const fetcher = async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				method,
				url,
				body:
					typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			if (
				concurrentInvocations > 1 &&
				method === "GET" &&
				url.includes("/comments")
			) {
				await commentsGetBarrier();
			}

			if (url.endsWith("/actions/runs/999")) {
				return jsonResponse({
					head_sha: "deadbeef",
					pull_requests: [{ number: 42 }],
				});
			}
			if (url.endsWith("/actions/runs/999/jobs")) {
				return jsonResponse({
					jobs: [
						{ id: 111, name: "Unit tests", conclusion: "failure" },
						{ id: 222, name: "Lint & type-check", conclusion: "success" },
					],
				});
			}
			if (url.endsWith("/actions/jobs/111/logs")) {
				return textResponse(rawLog);
			}
			if (method === "GET" && url.includes("/issues/42/comments")) {
				return jsonResponse([...comments]);
			}
			if (method === "POST" && url.includes("/issues/42/comments")) {
				const body = JSON.parse((init?.body as string) ?? "{}");
				const created = { id: nextId++, body: body.body };
				comments.push(created);
				return jsonResponse(created, 201);
			}
			const patchMatch =
				method === "PATCH" && /\/issues\/comments\/(\d+)$/.exec(url);
			if (patchMatch) {
				const id = Number(patchMatch[1]);
				const body = JSON.parse((init?.body as string) ?? "{}");
				const existing = comments.find((c) => c.id === id);
				if (existing) existing.body = body.body;
				return jsonResponse(existing ?? null);
			}
			const deleteMatch =
				method === "DELETE" && /\/issues\/comments\/(\d+)$/.exec(url);
			if (deleteMatch) {
				const id = Number(deleteMatch[1]);
				const index = comments.findIndex((c) => c.id === id);
				if (index === -1) {
					// V1, production-faithful: GitHub 404s a DELETE against a
					// comment id that no longer exists -- exactly what happens
					// when a second concurrent loser tries to delete the same
					// duplicate a first loser already removed.
					return jsonResponse({ message: "Not Found" }, 404);
				}
				comments.splice(index, 1);
				return noContentResponse();
			}
			if (url.endsWith("/actions/runs/999/rerun-failed-jobs")) {
				rerunCallCount++;
				if (rerunHandler) {
					const result = rerunHandler();
					return jsonResponse({}, result.status);
				}
				return jsonResponse({}, 201);
			}
			throw new Error(`unmocked URL in test: ${method} ${url}`);
		};
		return {
			fetcher,
			calls,
			comments,
			get rerunCallCount() {
				return rerunCallCount;
			},
		};
	}

	it("posts a new comment and triggers a rerun on the first infra failure for a SHA", async () => {
		const { fetcher, calls } = makeStatefulApi();
		const result = await runClassifier({
			fetcher,
			owner: "acme",
			repo: "repo",
			runId: 999,
		});

		expect(result.classification.kind).toBe("infra-kill");
		expect(result.rerunTriggeredThisPass).toBe(true);

		const posted = calls.find(
			(c) => c.method === "POST" && c.url.includes("/comments"),
		);
		expect(posted).toBeDefined();
		expect((posted?.body as { body: string }).body).toContain(
			"ci-classifier: infra-kill",
		);
		expect((posted?.body as { body: string }).body).toContain(
			"auto-rerun triggered",
		);

		const reran = calls.find((c) => c.url.includes("rerun-failed-jobs"));
		expect(reran).toBeDefined();
	});

	it("comments classification failure when the Unit-tests log download fails", async () => {
		const api = makeStatefulApi();
		const failingLogFetcher = async (url: string, init?: RequestInit) => {
			if (url.endsWith("/actions/jobs/111/logs")) {
				return jsonResponse({ message: "log unavailable" }, 502);
			}
			return api.fetcher(url, init);
		};

		await expect(
			runClassifier({
				fetcher: failingLogFetcher,
				owner: "acme",
				repo: "repo",
				runId: 999,
				prNumber: 42,
				sha: "deadbeef",
				rerunKinds: ["infra-kill"],
			}),
		).rejects.toThrow("HTTP 502");
		expect(api.comments).toHaveLength(1);
		expect(api.comments[0].body).toContain("classification failed");
		expect(api.comments[0].body).toContain(buildMarker("deadbeef", "false"));
		expect(api.rerunCallCount).toBe(0);
	});

	it("skips a failed run when Unit tests itself did not fail", async () => {
		const api = makeStatefulApi();
		const lintOnlyFailureFetcher = async (url: string, init?: RequestInit) => {
			if (url.endsWith("/actions/runs/999/jobs")) {
				return jsonResponse({
					jobs: [
						{ id: 111, name: "Unit tests", conclusion: "success" },
						{ id: 222, name: "Lint & type-check", conclusion: "failure" },
					],
				});
			}
			return api.fetcher(url, init);
		};

		const result = await runClassifier({
			fetcher: lintOnlyFailureFetcher,
			owner: "acme",
			repo: "repo",
			runId: 999,
			jobName: "Unit tests",
			skipMissingJob: true,
		});
		expect(result).toEqual({
			skipped: true,
			reason: 'run 999 has no failed job named "Unit tests"',
		});
		expect(api.comments).toHaveLength(0);
		expect(api.rerunCallCount).toBe(0);
	});

	it("updates the existing sticky comment in place instead of posting a second one, and skips the rerun once already triggered for this SHA", async () => {
		const priorBody = `ci-classifier: infra-kill (no failing assertion; auto-rerun triggered) ${buildMarker("deadbeef", "true")}`;
		const { fetcher, calls } = makeStatefulApi({
			initialComments: [{ id: 555, body: priorBody }],
		});

		const result = await runClassifier({
			fetcher,
			owner: "acme",
			repo: "repo",
			runId: 999,
		});

		// this-pass semantics: no NEW rerun was attempted this invocation, even
		// though the marker/comment still reflect the earlier success.
		expect(result.rerunTriggeredThisPass).toBe(false);
		expect(result.commentBody).toContain("auto-rerun triggered");

		const posted = calls.find(
			(c) => c.method === "POST" && c.url.includes("/comments"),
		);
		expect(posted).toBeUndefined();
		const patched = calls.find(
			(c) => c.method === "PATCH" && c.url.endsWith("/issues/comments/555"),
		);
		expect(patched).toBeDefined();

		const reran = calls.find((c) => c.url.includes("rerun-failed-jobs"));
		expect(reran).toBeUndefined();
	});

	// F4 (BLOCKING, red-proof with a throwing rerun stub): the marker must
	// reflect the ACTUAL outcome of the rerun call, not an assumed one. A
	// 403 (the realistic first outcome while actions:write is undecided,
	// per the PR body) must NOT write rerun=true.
	it("F4: a failing rerun attempt (403) is recorded honestly and does not lie in the marker", async () => {
		const { fetcher, calls } = makeStatefulApi({
			rerunHandler: () => ({ ok: false, status: 403 }),
		});

		const result = await runClassifier({
			fetcher,
			owner: "acme",
			repo: "repo",
			runId: 999,
		});

		expect(result.rerunTriggeredThisPass).toBe(false);
		expect(result.commentBody).toContain("failed:403");
		expect(result.commentBody).not.toContain("auto-rerun triggered");

		const posted = calls.find(
			(c) => c.method === "POST" && c.url.includes("/comments"),
		);
		expect((posted?.body as { body: string }).body).toContain(
			"rerun attempt failed",
		);
	});

	// F4 continued: the SAME SHA must remain eligible for a retry after a
	// recorded failure -- this is what "don't lie in the marker" is FOR.
	it("F4: after a recorded rerun failure, the same SHA is still eligible for a retry", async () => {
		const first = makeStatefulApi({
			rerunHandler: () => ({ ok: false, status: 403 }),
		});
		await runClassifier({
			fetcher: first.fetcher,
			owner: "acme",
			repo: "repo",
			runId: 999,
		});
		expect(first.comments[0].body).toContain("failed:403");

		// Second invocation reuses the same (now-populated) comment state, but
		// this time the rerun endpoint succeeds.
		const second = makeStatefulApi({
			initialComments: [...first.comments],
		});
		const result = await runClassifier({
			fetcher: second.fetcher,
			owner: "acme",
			repo: "repo",
			runId: 999,
		});
		expect(result.rerunTriggeredThisPass).toBe(true);
		expect(second.rerunCallCount).toBe(1);
	});

	// F4: a thrown network error from the fetcher itself (not just a non-2xx
	// response) must be caught and recorded the same honest way, never
	// propagate as an unhandled rejection that skips the comment entirely.
	it("F4: a throwing rerun stub (network-level failure) is recorded, not thrown", async () => {
		const { fetcher, calls } = makeStatefulApi();
		const throwingFetcher = async (url: string, init?: RequestInit) => {
			if (url.endsWith("/rerun-failed-jobs")) {
				throw new Error("ECONNRESET talking to api.github.com");
			}
			return fetcher(url, init);
		};

		const result = await runClassifier({
			fetcher: throwingFetcher,
			owner: "acme",
			repo: "repo",
			runId: 999,
		});

		expect(result.rerunTriggeredThisPass).toBe(false);
		expect(result.commentBody).toContain("failed:0");
		void calls;
	});

	// F3 (medium, red-proof with the reviewer's concurrent-invocation shape):
	// two overlapping runClassifier calls for the SAME sha, both reading
	// "no existing comment" before either writes, must converge to exactly
	// ONE comment and must not both believe they own the rerun.
	it("F3: two concurrent invocations for the same SHA converge to one comment, not two", async () => {
		const { fetcher, comments } = makeStatefulApi({
			concurrentInvocations: 2,
		});

		const [first, second] = await Promise.all([
			runClassifier({ fetcher, owner: "acme", repo: "repo", runId: 999 }),
			runClassifier({ fetcher, owner: "acme", repo: "repo", runId: 999 }),
		]);

		expect(comments).toHaveLength(1);
		// Exactly one of the two invocations reports itself as superseded --
		// the reconciliation loser -- and the other does not.
		const supersededCount = [first, second].filter(
			(r) =>
				"supersededByCommentId" in r && r.supersededByCommentId !== undefined,
		).length;
		expect(supersededCount).toBe(1);
	});

	// V1 (BLOCKING, red-proof with production-faithful DELETE semantics: a
	// repeat DELETE against an already-deleted comment 404s, per
	// makeStatefulApi's DELETE handler above). With 3 concurrent invocations,
	// TWO are losers -- both try to DELETE the same duplicate comment ids,
	// so the second DELETE against each id must 404, not crash the caller.
	// Pre-fix, restJson threw on that 404 and the losing invocations
	// rejected AFTER their own successful rerun/comment work had already
	// landed -- a spurious failure report for work that, in fact, succeeded.
	it("V1: three concurrent invocations for the same SHA all settle, converging to one comment", async () => {
		const { fetcher, comments } = makeStatefulApi({
			concurrentInvocations: 3,
		});

		const settled = await Promise.allSettled([
			runClassifier({ fetcher, owner: "acme", repo: "repo", runId: 999 }),
			runClassifier({ fetcher, owner: "acme", repo: "repo", runId: 999 }),
			runClassifier({ fetcher, owner: "acme", repo: "repo", runId: 999 }),
		]);

		// The headline assertion: every invocation FULFILLED. Pre-fix, at
		// least one of the two losers rejected with an unhandled "HTTP 404"
		// error from restJson's DELETE handling.
		const rejected = settled.filter((r) => r.status === "rejected");
		expect(rejected).toEqual([]);

		expect(comments).toHaveLength(1);
	});

	// #2668: a master-push run's workflow_run event carries an empty
	// pull_requests array -- there is no PR at all, not merely an unresolved
	// lookup. allowMissingPr lets classification and the rerun proceed
	// without one while skipping every PR-comment step (there is no issue
	// thread to post to).
	describe("allowMissingPr: master-push runs with no PR to comment on (#2668)", () => {
		function makePushApi({
			rerunHandler,
		}: {
			rerunHandler?: () => { ok: boolean; status: number };
		} = {}) {
			const calls: Array<{ method: string; url: string }> = [];
			const rawLog = fixture("infra-kill-wrapper-killed.real.log");
			let rerunCallCount = 0;
			const fetcher = async (url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push({ method, url });
				if (url.endsWith("/actions/runs/999")) {
					// Production-faithful: a push run's `pull_requests` array is
					// always empty, never merely unpopulated.
					return jsonResponse({ head_sha: "deadbeef", pull_requests: [] });
				}
				if (url.endsWith("/actions/runs/999/jobs")) {
					return jsonResponse({
						jobs: [{ id: 111, name: "Unit tests", conclusion: "failure" }],
					});
				}
				if (url.endsWith("/actions/jobs/111/logs")) {
					return textResponse(rawLog);
				}
				if (url.endsWith("/actions/runs/999/rerun-failed-jobs")) {
					rerunCallCount++;
					if (rerunHandler) {
						const result = rerunHandler();
						return jsonResponse({}, result.status);
					}
					return jsonResponse({}, 201);
				}
				throw new Error(`unmocked URL in test: ${method} ${url}`);
			};
			return {
				fetcher,
				calls,
				get rerunCallCount() {
					return rerunCallCount;
				},
			};
		}

		it("without allowMissingPr, a PR-less run still throws (guard unchanged)", async () => {
			const { fetcher } = makePushApi();
			await expect(
				runClassifier({ fetcher, owner: "acme", repo: "repo", runId: 999 }),
			).rejects.toThrow("has no associated pull request");
		});

		it("with allowMissingPr, classifies and reruns without ever touching the comments API", async () => {
			const api = makePushApi();
			const result = await runClassifier({
				fetcher: api.fetcher,
				owner: "acme",
				repo: "repo",
				runId: 999,
				allowMissingPr: true,
			});

			expect(result.classification.kind).toBe("infra-kill");
			expect(result.rerunTriggeredThisPass).toBe(true);
			expect(result.prNumber).toBeNull();
			expect(result.commentBody).toContain("ci-classifier: infra-kill");
			expect(api.rerunCallCount).toBe(1);

			// The whole point of the flag: a push run has no comment thread, so
			// nothing in this call may hit the issues/comments endpoints.
			const commentCalls = api.calls.filter((c) => c.url.includes("/comments"));
			expect(commentCalls).toEqual([]);
		});

		it("with allowMissingPr, a failing rerun is still recorded honestly in the returned commentBody", async () => {
			const api = makePushApi({
				rerunHandler: () => ({ ok: false, status: 403 }),
			});
			const result = await runClassifier({
				fetcher: api.fetcher,
				owner: "acme",
				repo: "repo",
				runId: 999,
				allowMissingPr: true,
			});

			expect(result.rerunTriggeredThisPass).toBe(false);
			expect(result.commentBody).toContain("failed:403");
			const commentCalls = api.calls.filter((c) => c.url.includes("/comments"));
			expect(commentCalls).toEqual([]);
		});
	});
});

describe("buildCommentBody (#2103)", () => {
	it("renders one visible line with the marker trailing on the same line", () => {
		const body = buildCommentBody({
			classification: { kind: "infra-kill", detail: "no failing assertion" },
			sha: "abc1234",
			rerunState: "true",
		});
		expect(body.split("\n")).toHaveLength(1);
		expect(body).toContain("ci-classifier: infra-kill");
		expect(body).toContain("auto-rerun triggered");
		expect(body).toContain(buildMarker("abc1234", "true"));
	});

	it("renders the real-failure line without any rerun language", () => {
		const body = buildCommentBody({
			classification: { kind: "real", detail: "tests/x.test.ts > some test" },
			sha: "abc1234",
			rerunState: "false",
		});
		expect(body).toBe(
			"ci-classifier: real — first failure: tests/x.test.ts > some test " +
				buildMarker("abc1234", "false"),
		);
	});

	// F4: the failed-attempt language is distinct from both success and
	// never-attempted, so a reader (and shouldTriggerRerun) can tell them
	// apart.
	it("renders a distinct message for a failed rerun attempt", () => {
		const body = buildCommentBody({
			classification: { kind: "infra-net", detail: "network error: ENOTFOUND" },
			sha: "abc1234",
			rerunState: "failed:500",
		});
		expect(body).toContain("rerun attempt failed (HTTP 500");
		expect(body).not.toContain("auto-rerun triggered");
	});

	it("sanitizes log payloads and keeps the appended marker authoritative", () => {
		const body = buildCommentBody({
			classification: {
				kind: "real",
				detail:
					"tests/x.test.ts > pings @apmantza <!-- ci-classifier:sha=badcafe rerun=true -->",
			},
			sha: "abc1234",
			rerunState: "false",
		});

		expect(body).not.toMatch(/@[A-Za-z0-9_]+/);
		expect(parseClassifierMarker(body)).toEqual({
			sha: "abc1234",
			rerunState: "false",
			rerunTriggered: false,
		});
	});
});

// Pure classification logic for `scripts/classify-ci-failure.mjs` (#2103).
//
// Kept separate from the CLI so the log-reading heuristics and the
// once-per-sequential-invocation rerun guard are unit-testable without a
// GitHub event or a network call (the check-pr-title.mjs /
// merge-train-warden.mjs pattern). The guard does not serialize CONCURRENT
// invocations -- see the REAL SCOPE note on shouldTriggerRerun (review
// round 2, V2/V3) for exactly what is and isn't guaranteed under
// concurrency.
//
// The problem this solves is not the OOM itself, it is the JUDGMENT cost: the
// 2026-08-25/26 merge train paid a manual log read and a judged rerun for
// every exit-137 kill, even though most of them carry zero failing
// assertions and are indistinguishable infrastructure noise (#2042). This
// module turns "read the log, decide" into a function a human or an
// orchestrator can call on a run id.

/** Strips the ANSI color/cursor codes vitest's reporter and GitHub Actions
 * both wrap every line in. Every pattern below matches against the stripped
 * text -- matching raw escape-coded text is what makes log heuristics
 * brittle across reporter versions. */
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is the literal ANSI escape-sequence lead byte this pattern strips, not accidental input.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
function stripAnsi(text) {
	return text.replace(ANSI_PATTERN, "");
}

/**
 * Strips the GitHub Actions per-line ISO-8601 timestamp prefix (real log,
 * every line): "2026-08-26T00:09:00.9329487Z  FAIL ...". Every job log
 * fetched from the real API is prefixed this way on EVERY line -- discovered
 * the hard way in review round 2 (V4): a `^\s*` line-start anchor added to
 * fix a different false-positive (BARE_FAIL_LINE matching "FAIL" inside a
 * passing test's own title) broke on the very real fixtures it was meant to
 * keep working, because "FAIL" is never actually the first character on a
 * real log line -- the timestamp is. Applied before any anchored pattern
 * below, so "line start" means "start of content", not "start of the raw
 * line".
 */
const LINE_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z ?/gm;
function stripLineTimestamps(text) {
	return text.replace(LINE_TIMESTAMP_PREFIX, "");
}

/**
 * Normalizes transport details that GitHub's Windows log surface can add to
 * runner lines. Keep this at the one preprocessing seam so every anchored
 * needle sees the same line starts.
 */
function normalizeLogLines(text) {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/^\s*##\[(?:error|warning)\]\s?/gm, "");
}

// #2096 shape (review round 1, F5): bound the read BEFORE interpretation. A
// classifier that scans an unbounded log is itself a resource-exhaustion
// risk, and the signal this classifier looks for -- a FAIL block, a
// mem-watch verdict, an OOM kill line -- is always near the END of a vitest
// run's stdout, so keeping the tail is the same trade capture-runner-output
// fixtures make. This is a lossy read by design: content dropped by the cap
// is invisible to every pattern below, matching how a human skimming "the
// end of the log" would triage it too.
//
// Review round 2, V5 (measured, not assumed): a complete real Unit-tests
// job log covering all 9,886 tests (run 32913518938, job 98012237782) is
// 212,150 bytes. The 2MB cap is roughly a 10x margin over that real-world
// size -- comfortably large enough to never truncate a normal run, while
// still bounding the read against a pathological one.
const MAX_LOG_BYTES = 2 * 1024 * 1024;

// vitest's summary block for a failing test: (real log, run 32913518938,
// job 98012237782) " FAIL  default tests/clients/word-index-lifecycle.test.ts
// > word-index lifecycle — full mode (#348) > reuses a fresh persisted
// snapshot without rebuilding". The project label ("default") sits between
// FAIL and the file path.
const FAIL_LINE = /^\s*FAIL\s+\S+\s+(\S+\.test\.tsx?)\s*>\s*(.+)$/gm;
// A file-level FAIL with no "> testname" -- a collection/import error never
// reaches a single test, so vitest has no test name to print (review round
// 1, F2/P2). Deliberately looser than FAIL_LINE: only used when FAIL_LINE
// itself doesn't match.
//
// Review round 2, V4: anchored to the vitest badge SHAPE -- "FAIL" is the
// first non-whitespace token on its own line, exactly how vitest prints the
// badge (real and synthetic fixtures alike start the line with optional
// indentation then "FAIL"). An earlier, unanchored version matched "FAIL"
// anywhere in the line, including inside a PASSING test's own title, e.g.
// "✓ does not FAIL when tests/b.test.ts is absent" -- fabricating
// "tests/b.test.ts" as the failing file and burying a genuine OOM kill
// elsewhere in the same log under a fake real classification (safe
// direction, but reimposes the manual-read tax this classifier exists to
// remove). See the "V4 fabricated FAIL in a passing test title" fixture.
const BARE_FAIL_LINE = /^\s*FAIL\b.*?(\S+\.test\.tsx?)(?=\s|$)/m;
// (real log, same run) "AssertionError: expected false to be true //
// Object.is equality"
const ASSERTION_LINE = /AssertionError:\s*(.+)/;
// vitest prints this inline, AS EACH FILE FINISHES, before the end-of-run
// "Failed Tests" summary block ever gets a chance to print (real log, run
// 32913518938, job 98012237782, line 536): " ❯  default
// tests/clients/word-index-lifecycle.test.ts (5 tests | 1 failed) 460ms".
// This is the review's F2/P1 fix: an OOM kill immediately AFTER this line
// prints, but before the summary block, must still classify real -- the
// summary block is not the only place a failure is visible.
//
// Review round 2, V4: anchored to line start (the "❯" badge is always the
// first non-whitespace glyph vitest prints on this line) for the same
// reason as BARE_FAIL_LINE above -- defense in depth, even though "❯"
// followed by this exact "(N tests | M failed)" shape is already narrow
// enough that no fixture has produced a false match mid-line.
const INLINE_SUITE_FAIL =
	/^\s*❯\s+\S+\s+(\S+\.test\.tsx?)\s*\(\d+\s*tests?\s*\|\s*(\d+)\s*failed\)/m;
// The per-test inline marker inside that same block (real log, same run,
// line 539): "     × reuses a fresh persisted snapshot without rebuilding
// 127ms" -- a fallback when the suite-level line above got lost to log
// truncation but an individual test's "×" line survived.
const INLINE_TEST_FAIL_MARKER = /^\s*×\s+(.+?)\s*\d*m?s?\s*$/m;
// Vitest's compact summary and TypeScript's compiler diagnostic are real
// failure evidence even when an infrastructure-looking line appears later.
// Keep these explicit: the classifier must not let a new infra needle outrank
// a genuine assertion or compile failure.
const TEST_FILES_FAILED = /\bTest Files\s+\d+\s+failed\b/i;
const TYPESCRIPT_ERROR =
	/^\s*\S+\.tsx?\(\d+,\d+\): error TS\d+:|^\s*\S+\.tsx?:\d+:\d+ - error TS\d+:/m;
// The run's own final tally line (real log, same run): " Tests  1 failed |
// 9837 passed | 48 skipped (9886)". No file/test detail, but a nonzero
// failed count here is unambiguous.
const OVERALL_TESTS_FAILED = /\bTests\s+(\d+)\s+failed\b/;
// #2839: vitest's timeout failure text (real log, run 34389495533 attempt 1,
// job 102594125043, PR #2834): "Error: Test timed out in 5000ms." Vitest's
// runner uses the same template for hooks: "Error: Hook timed out in 300ms."
// A timeout is demotion-eligible only when each FAIL block's first error line
// is one of these shapes and the job also has network evidence.
const TEST_TIMEOUT_LINE = /\b(?:Test|Hook) timed out in \d+ms\b/;
const TEST_TIMEOUT_ERROR_LINE =
	/^\s*Error:\s*(?:Test|Hook) timed out in \d+ms\./;
const ERROR_LINE = /^\s*(?:Error|[A-Za-z]+Error):[^\r\n]*$/;

// The wrapper's own verdict when it survives long enough to observe the
// kill (clients/scripts/lib/memory-watch.mjs:formatVerdict, quoted
// verbatim -- this is the literal string the shipped code emits, not a
// guess at one).
const MEM_WATCH_KILLED = /\[mem-watch\] KILLED[^\r\n]*/;
const MEM_WATCH_SAMPLE = /\[mem-watch\][^\r\n]*availableMb=\d+ of \d+/g;
const MEM_FILE_PEAK = /\[mem-file\] peakRssMb=(\d+)[^\r\n]*? (tests\/\S+)/g;
const EXIT_137_SHAPED = /exit code 137|exitCode=137|signal=SIGKILL/;
// (real log, run 32908647308, job 97998085238) the OOM killer took the
// wrapper process itself, mid test run, before it could print any verdict:
// "<runner tmp>/....sh: line 1:  2464 Killed
// node scripts/with-memory-watch.mjs -- npm test". A bare "Killed" with no
// [mem-watch] line anywhere in the log is the pre-#2042 shape (run
// 32888174877, PR #2058): the wrapper didn't exist yet, so a plain "Killed"
// mid npm-test output is the only signal.
//
// Review round 1, F1: this pattern alone is NOT sufficient -- "Killed" can
// appear in unrelated output (a message from a spawned tool, a test
// description). It is only evaluated ALONGSIDE EXIT_137_SHAPED below;
// deleting that conjunct is the exact vacuous-guard shape the review
// caught (no fixture exercised a bare "Killed" without 137/SIGKILL
// evidence -- see the "bare Killed, no exit evidence" test).
const KILLED_LINE = /\b(?:Killed|KILLED)(?:\s|$)/m;

// UNVERIFIED (AGENTS.md shape 16): no real captured pi-lens Unit-tests log
// with a DNS/network failure was found in the accessible run history for
// this issue (the "CodeQL tarball DNS error" #2103 cites ran in a different
// job). This pattern is the documented Node.js/npm error text for a failed
// DNS resolution or registry fetch, not a fixture pulled from a real run --
// flagged here and in the test file so a real occurrence can replace it.
//
// Review round 1, F2/P3: matching this ANYWHERE in the log is unsafe. The
// repo's OWN test corpus ships the literal string
// `{"outcome":"emit_failed","error":"ECONNRESET"}` (tests/clients/
// smells-rollup.test.ts:124), so a recovered warning or a test's own
// console output can contain "ECONNRESET" with no network failure involved.
// Scoped to npm error/ERR! lines, registry request lines, and this wrapper's
// own infra annotation. Arbitrary compiler/linter/test output is not evidence.
// Keep this shared pattern at origin/master's conservative scope. npm-retry
// composes it with npm-only shapes below because the two consumers have
// opposite false-positive costs.
export const NET_PATTERN =
	/getaddrinfo\s+\w+\s+\S+|\bENOTFOUND\b|\bECONNRESET\b|tarball.{0,40}(?:download|fetch).{0,20}fail|net::ERR_NAME_NOT_RESOLVED|\bcodeload\.github\.com\b.{0,120}\b(?:429|503)\b/i;
const ERROR_PREFIXED_LINE =
	/^(?:\s*npm (?:error\b|ERR!)(?:\s|$).*|.*::error::infra:.*|.*\brequest to https?:\/\/\S+ failed, reason:.*)$/gim;
const CI_INFRA_LINE =
	/^(?:.*(?:Unable to upload SARIF file|SARIF upload).*(?:\b(?:429|5\d\d)\b|failed).*$|.*Initialize CodeQL.*(?:\b(?:429|5\d\d)\b|failed).*$|.*codeload\.github\.com.*\b(?:429|503)\b.*|.*npm ci[\s\S]{0,200}\bETIMEDOUT\b.*)$/gim;
// #2839: the npm-retry wrapper's own retry witness. scripts/npm-retry.mjs
// prints `npm-retry: attempt ${attempt + 1} ${reason}` for EVERY failed
// attempt, so the needle is scoped to the network reason -- the same log
// legitimately carries `npm-retry: attempt 1 exited 1 (ERESOLVE)` lines for
// deterministic dependency conflicts, and those are not registry evidence.
// Line-start anchored like the other log-shaped patterns above.
const NPM_RETRY_ATTEMPT_LINE = /^\s*npm-retry: attempt \d+ network error\b/m;

/**
 * @typedef {{ kind: "real" | "infra-kill" | "infra-net", detail: string }} Classification
 */

// #2230's re-home comment on #2103: a kill with confirmed available memory
// headroom is not an OOM, so the classification `kind` must not say
// "infra-oom" for either shape. `.github/workflows/ci.yml`'s "Kernel kill
// evidence" step runs `if: failure()` inside the SAME job as "Run tests", so
// its dmesg/cgroup output already lives in the log this module reads --
// nothing new to fetch, just something in the log this module wasn't reading.
//
// UNVERIFIED (AGENTS.md shape 16): no real captured Unit-tests log with this
// step's output on hand yet -- the two real OOM fixtures in
// tests/fixtures/ci-failure-logs/ predate the step. The patterns below match
// the step's OWN echoed strings verbatim (ci.yml lines 194-231), not a guess,
// and are additive: they only enrich `detail`, never change `kind` or the
// rerun decision, so a log without this section (every fixture on hand today)
// classifies exactly as before.
const KERNEL_EVIDENCE_SECTION =
	/--- kernel OOM\/kill records ---\r?\n([\s\S]*?)(?=\r?\n---|\r?\n?$)/;
const KERNEL_NO_RECORDS =
	/\(dmesg readable, zero OOM\/kill records - the kernel OOM killer did not fire\)/;
const KERNEL_UNAVAILABLE =
	/\(dmesg unavailable or empty - no evidence either way\)/;
const CGROUP_EVENTS_SECTION =
	/--- cgroup memory\.events ---\r?\n([\s\S]*?)(?=\r?\n---|\r?\n?$)/;
const CGROUP_OOM_KILL_LINE = /^oom_kill\s+(\d+)/m;

/**
 * Reads the "Kernel kill evidence" step's cgroup `oom_kill` counter out of
 * the same log, when that step ran and found the file (ci.yml:216-231
 * resolves the process's own cgroup, so an absent/unreadable file is a
 * distinct outcome from "found it, counter is zero").
 *
 * Exported standalone for unit testing, but only ever CALLED internally
 * (from classifyFailureLog / describeKernelKillEvidence) on the
 * timestamp-stripped log, after stripLineTimestamps has run. Every real
 * GitHub Actions log line carries a per-line ISO-8601 prefix, which shifts
 * this function's section-header regex off the start of the line; called
 * directly on a RAW log, it returns null even when the section is present.
 *
 * @param {string} log timestamp-stripped log text
 * @returns {number | null} the counter, or null when the section is absent
 *   or the file could not be read
 */
export function readCgroupOomKillCount(log) {
	const section = CGROUP_EVENTS_SECTION.exec(log);
	if (!section) return null;
	const match = CGROUP_OOM_KILL_LINE.exec(section[1]);
	return match ? Number(match[1]) : null;
}

/**
 * Summarizes whatever the kernel kill-evidence step recorded, for appending
 * to a kill classification's detail. Returns null when the step's output
 * isn't in the log at all (older runs, or a job that never reached that
 * `if: failure()` step) -- silence there means "nothing to add", not "no
 * evidence".
 *
 * @param {string} log
 * @returns {string | null}
 */
export function describeKernelKillEvidence(log) {
	const cgroupCount = readCgroupOomKillCount(log);
	if (cgroupCount !== null && cgroupCount > 0) {
		return `kernel evidence: cgroup oom_kill=${cgroupCount}`;
	}
	const dmesgSection = KERNEL_EVIDENCE_SECTION.exec(log);
	if (dmesgSection) {
		const body = dmesgSection[1].trim();
		if (KERNEL_NO_RECORDS.test(body)) {
			return cgroupCount === 0
				? "kernel evidence: dmesg and cgroup both show no OOM/kill records"
				: "kernel evidence: dmesg shows no OOM/kill records";
		}
		if (!KERNEL_UNAVAILABLE.test(body) && body.length > 0) {
			return `kernel evidence: dmesg -- ${body.split(/\r?\n/)[0]}`;
		}
	}
	if (cgroupCount === 0) {
		return "kernel evidence: cgroup shows zero OOM kills";
	}
	return null;
}

/**
 * Find the strongest "this is a real failure" signal in the (already
 * ANSI-stripped) log, trying the most specific/informative pattern first.
 * Returns null when none of the real-failure shapes are present.
 *
 * @param {string} log
 * @returns {{ detail: string } | null}
 */
function findRealFailureSignal(log) {
	const failMatch = FAIL_LINE.exec(log);
	if (failMatch) {
		return { detail: `${failMatch[1]} > ${failMatch[2].trim()}` };
	}
	const assertionMatch = ASSERTION_LINE.exec(log);
	if (assertionMatch) {
		return { detail: `unknown file > ${assertionMatch[1].trim()}` };
	}
	if (TEST_FILES_FAILED.test(log)) {
		return { detail: log.match(TEST_FILES_FAILED)?.[0] ?? "Test Files failed" };
	}
	const typescriptMatch = TYPESCRIPT_ERROR.exec(log);
	if (typescriptMatch) {
		return { detail: typescriptMatch[0] };
	}
	const inlineSuite = INLINE_SUITE_FAIL.exec(log);
	if (inlineSuite) {
		return {
			detail: `${inlineSuite[1]} (${inlineSuite[2]} failed, inline marker -- no end-of-run summary printed)`,
		};
	}
	const bareFail = BARE_FAIL_LINE.exec(log);
	if (bareFail) {
		return {
			detail: `${bareFail[1]} (file-level failure -- no ">"-separated test name, e.g. an import/collection error)`,
		};
	}
	const overallFailed = OVERALL_TESTS_FAILED.exec(log);
	if (overallFailed && Number(overallFailed[1]) > 0) {
		return {
			detail: `${overallFailed[1]} test(s) failed (overall tally line; no per-file detail found)`,
		};
	}
	const inlineTest = INLINE_TEST_FAIL_MARKER.exec(log);
	if (inlineTest) {
		return {
			detail: `unknown file > ${inlineTest[1].trim()} (inline "×" marker -- no end-of-run summary printed)`,
		};
	}
	return null;
}

/**
 * Find network-unreachable evidence in the (already ANSI-stripped,
 * timestamp-stripped) log: a scoped npm/registry error line carrying a shared
 * NET_PATTERN token, a CI-infrastructure outage line (SARIF/CodeQL/codeload
 * 429/503, `npm ci` ETIMEDOUT), or the npm-retry wrapper's own
 * `npm-retry: attempt N network error` witness. One bounded scan drives BOTH
 * the #2839 timeout demotion and the plain infra-net fallback, so the two
 * paths can never disagree about what counts as network evidence.
 *
 * @param {string} log
 * @returns {{ family: "npm-net" | "ci-infra", text: string } | null}
 */
function findNetworkUnreachableEvidence(log) {
	let inspectedErrorLines = 0;
	for (const errorLine of log.matchAll(ERROR_PREFIXED_LINE)) {
		if (++inspectedErrorLines > 1_000) break;
		const netMatch = NET_PATTERN.exec(errorLine[0]);
		if (netMatch) {
			return { family: "npm-net", text: netMatch[0].trim() };
		}
	}
	for (const infraLine of log.matchAll(CI_INFRA_LINE)) {
		return { family: "ci-infra", text: infraLine[0].trim() };
	}
	const retryMatch = NPM_RETRY_ATTEMPT_LINE.exec(log);
	if (retryMatch) {
		return { family: "npm-net", text: retryMatch[0].trim() };
	}
	return null;
}

/**
 * #2839: is this log's real-failure evidence ONLY a vitest test timeout?
 * A timeout is the one real-failure shape a registry-starved runner
 * fabricates on otherwise-healthy code. Demotion therefore requires every
 * FAIL test block's first error line to be a timeout; unrelated prose and a
 * neighboring thrown failure cannot arm it.
 *
 * @param {string} log
 * @returns {boolean}
 */
function isTimeoutOnlyFailure(log) {
	const failLines = [...log.matchAll(/^\s*FAIL\b[^\r\n]*$/gm)];
	const testFailures = [...log.matchAll(FAIL_LINE)];
	if (failLines.length === 0 || testFailures.length !== failLines.length) {
		return false;
	}
	if (ASSERTION_LINE.test(log) || TYPESCRIPT_ERROR.test(log)) return false;
	return testFailures.every((match, index) => {
		const start = match.index + match[0].length;
		const end = testFailures[index + 1]?.index ?? log.length;
		const block = log.slice(start, end);
		const firstError = block
			.split(/\r?\n/)
			.find((line) => ERROR_LINE.test(line));
		return firstError !== undefined && TEST_TIMEOUT_ERROR_LINE.test(firstError);
	});
}

function findKillClassification(log) {
	const peakFiles = [...log.matchAll(MEM_FILE_PEAK)]
		.map((match) => ({ rss: Number(match[1]), file: match[2] }))
		.sort((left, right) => right.rss - left.rss)
		.slice(0, 3);
	const peakDetail = peakFiles.length
		? `; heaviest files by peak RSS: ${peakFiles.map(({ file, rss }) => `${file} (${rss} MB)`).join(", ")}`
		: "";
	const killedVerdict = MEM_WATCH_KILLED.exec(log);
	if (killedVerdict) {
		const evidence = describeKernelKillEvidence(log);
		const detail = `no failing assertion; ${killedVerdict[0].trim()}${peakDetail}${evidence ? `; ${evidence}` : ""}`;
		return { kind: "infra-kill", detail };
	}
	if (
		EXIT_137_SHAPED.test(log) &&
		(KILLED_LINE.test(log) ||
			/exit code 137|exitCode=137/i.test(log) ||
			/signal=SIGKILL/i.test(log))
	) {
		const samples = log.match(MEM_WATCH_SAMPLE);
		const lastSample = samples?.[samples.length - 1]?.trim();
		const evidence = describeKernelKillEvidence(log);
		const baseDetail = lastSample
			? `no failing assertion; last sample before the kill: ${lastSample}`
			: "no failing assertion; no [mem-watch] verdict line -- the run ended before any verdict was printed";
		const detail = `${baseDetail}${peakDetail}${evidence ? `; ${evidence}` : ""}`;
		return { kind: "infra-kill", detail };
	}
	return null;
}

/**
 * Classify one failed job's log. A real failure -- ANY of the shapes
 * findRealFailureSignal recognizes -- wins over infra-shaped noise elsewhere
 * in the same log (acceptance criterion: "real failures are never labeled
 * infra"), so that check runs before any OOM/network pattern is considered.
 * #2839's one exception runs BEFORE it: a failure whose ONLY evidence is a
 * test timeout (`Test timed out in Nms`, no AssertionError, no compiler
 * diagnostic) demotes to infra-net when the log also carries
 * network-unreachable evidence, because a registry-starved runner times tests
 * out on otherwise-healthy code; an AssertionError or an `error TS` line
 * beside the same network noise still wins as real.
 *
 * @param {string} rawLog
 * @returns {Classification}
 */
export function classifyFailureLog(rawLog) {
	const original = rawLog ?? "";
	if (original.trim().length === 0) {
		// Review round 1, F5: distinguish "we read nothing" from "we read
		// something and didn't recognize it" -- an empty log usually means the
		// fetch itself failed or raced the job's log upload, which is a
		// different failure mode than a genuinely unrecognized failure shape.
		return {
			kind: "real",
			detail:
				"empty log (0 bytes read) -- nothing to classify, treated as real out of caution",
		};
	}
	// F5: cap BEFORE any interpretation, not after -- a pattern that happened
	// to match in the discarded head of the log must have no effect on the
	// result (see the truncation test).
	const bounded =
		original.length > MAX_LOG_BYTES ? original.slice(-MAX_LOG_BYTES) : original;
	const log = normalizeLogLines(stripLineTimestamps(stripAnsi(bounded)));

	// #2839's one demotion, checked BEFORE the real-signal branch: a vitest
	// timeout in every FAIL block beside network evidence is infra, not real.
	// Kill evidence wins this inference above; a real signal beside a kill
	// still wins below when the log is not timeout-only.
	const timeoutOnly = isTimeoutOnlyFailure(log);
	const killClassification = findKillClassification(log);
	// Kill evidence is stronger than the network+timeout inference, but a
	// genuine assertion/compiler failure beside a kill remains real below.
	if (timeoutOnly && killClassification) return killClassification;
	if (
		killClassification &&
		!ASSERTION_LINE.test(log) &&
		!TYPESCRIPT_ERROR.test(log) &&
		!INLINE_SUITE_FAIL.test(log) &&
		!INLINE_TEST_FAIL_MARKER.test(log)
	)
		return killClassification;

	if (timeoutOnly) {
		const netEvidence = findNetworkUnreachableEvidence(log);
		if (netEvidence) {
			return {
				kind: "infra-net",
				detail: `no failing assertion; test timeout beside network-unreachable evidence: ${TEST_TIMEOUT_LINE.exec(log)[0]}; network: ${netEvidence.text}`,
			};
		}
	}

	const realSignal = findRealFailureSignal(log);
	if (realSignal) {
		return { kind: "real", detail: realSignal.detail };
	}

	if (killClassification) return killClassification;

	const networkEvidence = findNetworkUnreachableEvidence(log);
	if (networkEvidence) {
		if (networkEvidence.family === "ci-infra") {
			return {
				kind: "infra-net",
				detail: `infrastructure error: ${networkEvidence.text}`,
			};
		}
		return {
			kind: "infra-net",
			detail: `no failing assertion; network error: ${networkEvidence.text}`,
		};
	}

	// Spec default (#2103 proposal step 1): "otherwise real". A failing job
	// this classifier doesn't recognize the shape of is never assumed to be
	// infra -- an unrecognized shape must not be eligible for an automatic
	// rerun (see shouldTriggerRerun).
	return {
		kind: "real",
		detail:
			"no FAIL/AssertionError/OOM/network signature recognized in the log",
	};
}

// rerun marker state: "true" once the rerun POST actually succeeded,
// "false" when no rerun was attempted (a real classification, or a not-yet
// -eligible infra one), or "failed:<http-status>" when an attempt was made
// but the API call itself failed (review round 1, F4) -- see
// shouldTriggerRerun for why only "true" blocks a future retry.
const MARKER_PATTERN =
	/<!--\s*ci-classifier:sha=([0-9a-fA-F]{7,40})\s+rerun=(true|false|failed:\d+)\s*-->(?=\s*$)/g;

/**
 * @param {string} sha
 * @param {string} rerunState "true" | "false" | `failed:${number}`
 */
export function buildMarker(sha, rerunState) {
	return `<!-- ci-classifier:sha=${sha} rerun=${rerunState} -->`;
}

/**
 * @param {string | null | undefined} commentBody
 * @returns {{ sha: string, rerunState: string, rerunTriggered: boolean } | null}
 */
export function parseClassifierMarker(commentBody) {
	if (!commentBody) return null;
	let match = null;
	for (const candidate of commentBody.matchAll(MARKER_PATTERN)) {
		match = candidate;
	}
	if (!match) return null;
	return {
		sha: match[1],
		rerunState: match[2],
		rerunTriggered: match[2] === "true",
	};
}

function sanitizeCommentDetail(detail) {
	return detail
		.replaceAll("<!--", "&lt;!--")
		.replaceAll("-->", "--&gt;")
		.replace(/@(?=[A-Za-z0-9_])/g, "@\u200b");
}

/**
 * The once-per-SHA rerun guard. A real failure is never rerun, full stop.
 * An infra classification is rerun-eligible UNLESS the PR's current
 * classifier comment already carries a `rerun=true` marker for this EXACT
 * SHA -- a different SHA (a new push) always gets to try again, because the
 * guard's job is "don't loop on the same commit", not "never rerun this PR
 * again". Review round 1, F4: a marker of "failed:<status>" (the rerun API
 * call itself failed) is NOT "already triggered" -- it must remain eligible
 * so the next invocation can retry.
 *
 * REAL SCOPE OF THE "ONCE PER SHA" GUARANTEE (review round 2, V2/V3 --
 * measured, not assumed): this guard serializes SEQUENTIAL invocations
 * against one PR's comment history. It does NOT serialize CONCURRENT
 * invocations -- there is no lock around "read the marker, then rerun".
 * Two known, accepted ways the guarantee can still under- or over-fire:
 *
 *   V2: N concurrent invocations for the same SHA can all read the SAME
 *   "not yet triggered" marker state before any of them writes, so all N
 *   attempt the rerun POST (measured: 3 concurrent invocations -> 3 rerun
 *   calls). This is accepted, not serialized: GitHub's own
 *   rerun-failed-jobs answers a duplicate rerun on an already-
 *   queued/in-progress run with 403, which attemptRerun records as
 *   `failed:403` -- a losing invocation's marker write (if it wins the
 *   comment race) or the next sequential invocation's read both see an
 *   honest failure record, not a false "never happened". The guarantee
 *   this code actually provides is "once per SEQUENTIAL invocation", not
 *   "once across any concurrency".
 *
 *   V3: the attempt-then-record order (F4) fixed "the marker lies", but it
 *   opens a narrower window: if the rerun POST succeeds and the FOLLOWING
 *   comment POST fails (a separate network call, after the rerun already
 *   fired), this invocation throws having already triggered a real rerun
 *   with no marker recorded. The next invocation finds no comment, so it
 *   reruns again (measured: 2 total reruns across 2 sequential attempts
 *   with an injected comment-POST failure). Judged the right trade against
 *   the alternative (recording the marker BEFORE the attempt, which lies
 *   whenever the attempt itself fails, per F4) -- an extra rerun is
 *   wasteful, a permanently-blocked SHA is worse.
 *
 * Neither gap is silent: every attempt, successful or not, is recorded in
 * SOME comment (this invocation's own, or a later reconciled one), and a
 * duplicate rerun is GitHub's own no-op, not a runaway loop.
 *
 * @param {{ classification: Classification, sha: string, existingMarker: { sha: string, rerunTriggered: boolean } | null }} args
 */
export function shouldTriggerRerun({
	classification,
	sha,
	existingMarker,
	rerunKinds = ["infra-kill", "infra-net"],
}) {
	if (!rerunKinds.includes(classification.kind)) return false;
	if (
		existingMarker &&
		existingMarker.sha === sha &&
		existingMarker.rerunTriggered
	) {
		return false;
	}
	return true;
}

/**
 * Build the one-line sticky comment body (issue #2103's own examples, kind
 * renamed to infra-kill per #2103's re-home comment on PR #2230:
 * "ci-classifier: infra-kill (0 assertions; auto-rerun triggered)" /
 * "ci-classifier: real — first failure: <file> > <test>"), with the
 * machine-readable marker appended on the same line so the comment stays
 * one visible line and is still upsertable per SHA.
 *
 * @param {{ classification: Classification, sha: string, rerunState: string }} args
 */
export function buildCommentBody({ classification, sha, rerunState }) {
	const detail = sanitizeCommentDetail(classification.detail);
	classification = { ...classification, detail };
	const suffix = rerunState.startsWith("failed:")
		? `; rerun attempt failed (HTTP ${rerunState.slice("failed:".length)}, will retry next check)`
		: rerunState === "true"
			? "; auto-rerun triggered"
			: "";
	const line =
		classification.kind === "real"
			? `ci-classifier: real — first failure: ${classification.detail}`
			: `ci-classifier: ${classification.kind} (${classification.detail}${suffix})`;
	return `${line} ${buildMarker(sha, rerunState)}`;
}

/**
 * Decide a classification and the comment body ASSUMING any eligible rerun
 * would succeed. Pure -- no I/O -- used for testing the classification and
 * guard logic in isolation. The real orchestration (runClassifier) does NOT
 * use this to decide the final marker state: it attempts the rerun FIRST
 * and only then knows whether "true" or "failed:<status>" is honest (review
 * round 1, F4) -- see runClassifier.
 *
 * @param {{ rawLog: string, sha: string, existingCommentBody: string | null | undefined }} args
 */
export function decideClassifierAction({ rawLog, sha, existingCommentBody }) {
	const classification = classifyFailureLog(rawLog);
	const existingMarker = parseClassifierMarker(existingCommentBody);
	const eligibleForRerun = shouldTriggerRerun({
		classification,
		sha,
		existingMarker,
	});
	const rerunState = eligibleForRerun
		? "true"
		: existingMarker &&
			  existingMarker.sha === sha &&
			  existingMarker.rerunTriggered
			? "true"
			: "false";
	const commentBody = buildCommentBody({ classification, sha, rerunState });
	// Review round 2, V5: `rerunTriggeredThisPass` (not `rerunTriggered`,
	// which parseClassifierMarker's return keeps for the CUMULATIVE
	// marker-state meaning) -- this field means "did THIS pass trigger a
	// rerun". eligibleForRerun already IS that this-pass answer (this pure
	// function assumes an eligible attempt always succeeds; see
	// runClassifier for the real, attempt-then-record version).
	return {
		classification,
		rerunTriggeredThisPass: eligibleForRerun,
		commentBody,
	};
}

// ---------------------------------------------------------------------------
// I/O layer. Every function below takes an injected `fetcher` (the
// merge-train-warden.mjs pattern, scripts/lib/merge-train-warden.mjs:138) so
// the orchestration in runClassifier is testable against a mocked GitHub API
// with no network call and no gh CLI dependency.
// ---------------------------------------------------------------------------

async function restJson(fetcher, method, url, body) {
	const response = await fetcher(url, {
		method,
		headers: {
			accept: "application/vnd.github+json",
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		// Review round 2, V1: reconcileDuplicateClassifierComments lets every
		// LOSER among N concurrent invocations attempt to DELETE the same set
		// of duplicate comment ids. The first DELETE to reach GitHub actually
		// removes the comment; every later DELETE against that same id gets
		// 404 (or 410 Gone, GitHub's other "already gone" shape) -- which IS
		// the caller's desired end state ("this comment no longer exists"),
		// not a failure. Without this, restJson threw on the 404 and the
		// losing invocations exited 1 AFTER their own rerun/comment work had
		// already landed successfully -- a crash that reported failure for
		// work that, in fact, succeeded.
		if (
			method === "DELETE" &&
			(response.status === 404 || response.status === 410)
		) {
			return null;
		}
		const text = await response.text().catch(() => "");
		throw new Error(
			`${method} ${url} -> HTTP ${response.status} ${text}`.trim(),
		);
	}
	// A DELETE (comment cleanup, review round 1 F3) returns 204 with no body --
	// response.json() would throw parsing empty text, and no caller needs the
	// return value for that verb.
	try {
		return await response.json();
	} catch {
		return null;
	}
}

/** Job logs are served as plain text (via a redirect the injected fetcher
 * must follow), not JSON -- kept separate from restJson for that reason. */
async function fetchText(fetcher, url) {
	const response = await fetcher(url, {
		headers: { accept: "application/vnd.github+json" },
	});
	if (!response.ok) {
		throw new Error(`GET ${url} -> HTTP ${response.status}`);
	}
	return response.text();
}

/**
 * Resolve a run's head SHA, its associated PR number (when GitHub reports
 * one -- same-repo pushes and PRs both do; a fork PR or a bare workflow_run
 * event may not, so callers can pass an explicit PR number instead), and the
 * id of the job to classify.
 *
 * @param {{ fetcher: typeof fetch, owner: string, repo: string, runId: number | string, jobName?: string }} args
 */
async function fetchRunAndFailedJob({ fetcher, owner, repo, runId, jobName }) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	const run = await restJson(fetcher, "GET", `${base}/actions/runs/${runId}`);
	const jobsResponse = await restJson(
		fetcher,
		"GET",
		`${base}/actions/runs/${runId}/jobs`,
	);
	const jobs = jobsResponse.jobs ?? [];
	const failedJob = jobName
		? jobs.find((job) => job.conclusion === "failure" && job.name === jobName)
		: jobs.find((job) => job.conclusion === "failure");
	if (!failedJob) {
		throw new Error(
			`run ${runId} has no failed job${jobName ? ` named "${jobName}"` : ""}`,
		);
	}
	const prNumber = run.pull_requests?.[0]?.number ?? null;
	return {
		sha: run.head_sha,
		prNumber,
		jobId: failedJob.id,
		jobName: failedJob.name,
	};
}

async function fetchJobLog({ fetcher, owner, repo, jobId }) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	return fetchText(fetcher, `${base}/actions/jobs/${jobId}/logs`);
}

/**
 * Find this PR's existing classifier comment, if any -- there is at most one
 * at a time (upsert, never append), so the first match wins.
 */
async function findExistingClassifierComment({
	fetcher,
	owner,
	repo,
	prNumber,
}) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	const comments = await restJson(
		fetcher,
		"GET",
		`${base}/issues/${prNumber}/comments?per_page=100`,
	);
	return (
		comments.find((comment) => parseClassifierMarker(comment.body) !== null) ??
		null
	);
}

async function upsertComment({
	fetcher,
	owner,
	repo,
	prNumber,
	existingComment,
	body,
}) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	if (existingComment) {
		return restJson(
			fetcher,
			"PATCH",
			`${base}/issues/comments/${existingComment.id}`,
			{ body },
		);
	}
	return restJson(fetcher, "POST", `${base}/issues/${prNumber}/comments`, {
		body,
	});
}

/**
 * Review round 1, F3: two concurrent invocations for the same SHA can both
 * read "no existing comment" before either writes, each posting its own
 * comment. Called only after THIS call posted a brand-new comment (a PATCH
 * to an already-existing single comment can't itself create a duplicate).
 * Re-reads the comment list; if more than one classifier comment now claims
 * this SHA, the earliest (lowest id) wins and every later duplicate is
 * deleted -- including this call's own comment, if it lost the race.
 *
 * @returns {Promise<{ isWinner: boolean, winningCommentId: number | undefined }>}
 */
async function reconcileDuplicateClassifierComments({
	fetcher,
	owner,
	repo,
	prNumber,
	sha,
	postedCommentId,
}) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	const comments = await restJson(
		fetcher,
		"GET",
		`${base}/issues/${prNumber}/comments?per_page=100`,
	);
	const forSha = comments
		.filter((comment) => {
			const marker = parseClassifierMarker(comment.body);
			return marker && marker.sha === sha;
		})
		.sort((a, b) => a.id - b.id);
	if (forSha.length <= 1) {
		return { isWinner: true, winningCommentId: postedCommentId };
	}
	const winner = forSha[0];
	for (const duplicate of forSha.slice(1)) {
		await restJson(
			fetcher,
			"DELETE",
			`${base}/issues/comments/${duplicate.id}`,
		);
	}
	return {
		isWinner: winner.id === postedCommentId,
		winningCommentId: winner.id,
	};
}

/**
 * Attempt the rerun. Returns a result instead of throwing on an HTTP
 * failure (review round 1, F4) so the caller can record an honest
 * "failed:<status>" marker rather than either lying (marking rerun=true
 * before knowing the call succeeded) or crashing the whole classification.
 *
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
async function attemptRerun({ fetcher, owner, repo, runId }) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	try {
		const response = await fetcher(
			`${base}/actions/runs/${runId}/rerun-failed-jobs`,
			{
				method: "POST",
				headers: { accept: "application/vnd.github+json" },
			},
		);
		if (response.ok || response.status === 201)
			return { ok: true, status: response.status };
		return { ok: false, status: response.status };
	} catch {
		// A thrown network error carries no HTTP status -- 0 is not a real
		// status code, so it can never collide with a genuine server response
		// and still round-trips through the marker's `failed:<status>` shape.
		return { ok: false, status: 0 };
	}
}

/**
 * Orchestrate one run: classify, attempt the rerun (when eligible) BEFORE
 * writing any marker that claims it happened (review round 1, F4), upsert
 * the sticky comment with the ACTUAL outcome, and reconcile a concurrent
 * duplicate comment for the same SHA (review round 1, F3; the 404/410
 * -on-DELETE handling for a THIRD-or-later concurrent loser is review
 * round 2, V1). See shouldTriggerRerun's REAL SCOPE note (V2/V3) for what
 * "once per SHA" does and doesn't cover under concurrency.
 *
 * `allowMissingPr` (#2668): a master-push run has no associated pull
 * request at all -- `run.pull_requests` is always empty for a push event,
 * not merely unpopulated. Without this flag that is indistinguishable from
 * the original defect this function guards against (a PR run whose PR
 * lookup failed) and throws. With it, classification and the rerun attempt
 * still run in full, but every PR-comment step (find/upsert/reconcile) is
 * skipped -- there is no issue thread to post to. That also means the
 * cross-invocation "already reran this SHA" marker guard (shouldTriggerRerun
 * reading `existingMarker`) has no comment to read for a push run; the
 * workflow's own `run_attempt == 1` gate is what bounds a push rerun to
 * once per completed run, the same way it bounds the PR path.
 *
 * @param {{ fetcher: typeof fetch, owner: string, repo: string, runId: number | string, jobName?: string, prNumber?: number, allowMissingPr?: boolean }} args
 */
export async function runClassifier({
	fetcher,
	owner,
	repo,
	runId,
	jobName,
	prNumber: prNumberOverride,
	sha: shaOverride,
	rerunKinds,
	skipMissingJob = false,
	allowMissingPr = false,
}) {
	let runAndJob;
	try {
		runAndJob = await fetchRunAndFailedJob({
			fetcher,
			owner,
			repo,
			runId,
			jobName,
		});
	} catch (error) {
		if (
			skipMissingJob &&
			error instanceof Error &&
			error.message.includes("has no failed job")
		) {
			return { skipped: true, reason: error.message };
		}
		await commentClassificationFailure({
			fetcher,
			owner,
			repo,
			prNumber: prNumberOverride,
			sha: shaOverride,
			error,
		});
		throw error;
	}
	const {
		sha,
		prNumber: resolvedPrNumber,
		jobId,
		jobName: resolvedJobName,
	} = runAndJob;
	const prNumber = prNumberOverride ?? resolvedPrNumber;
	if (!prNumber && !allowMissingPr) {
		throw new Error(
			`run ${runId} has no associated pull request; pass an explicit PR number`,
		);
	}

	let rawLog;
	try {
		rawLog = await fetchJobLog({ fetcher, owner, repo, jobId });
	} catch (error) {
		await commentClassificationFailure({
			fetcher,
			owner,
			repo,
			prNumber,
			sha,
			error,
		});
		throw error;
	}
	// No PR to read a sticky comment on for a commentless (push) run --
	// there is never a prior marker to recover, so this pass is always the
	// first look at this SHA.
	const existingComment = prNumber
		? await findExistingClassifierComment({
				fetcher,
				owner,
				repo,
				prNumber,
			})
		: null;
	let classification;
	try {
		classification = classifyFailureLog(rawLog);
	} catch (error) {
		await commentClassificationFailure({
			fetcher,
			owner,
			repo,
			prNumber,
			sha,
			error,
		});
		throw error;
	}
	const existingMarker = parseClassifierMarker(existingComment?.body);
	const eligibleForRerun = shouldTriggerRerun({
		classification,
		sha,
		existingMarker,
		rerunKinds,
	});

	// F4: the rerun attempt happens BEFORE the marker is built, so the
	// comment can only ever claim what actually happened.
	let rerunState = "false";
	// `rerunTriggeredThisPass` answers "did THIS invocation just cause a
	// rerun" (what the CLI's own log line reports) -- distinct from
	// `rerunState`, the CUMULATIVE marker/comment state, which stays "true"
	// on a later re-invocation that finds the rerun already succeeded
	// earlier for this exact SHA (see the `else if` below).
	let rerunTriggeredThisPass = false;
	if (eligibleForRerun) {
		const result = await attemptRerun({ fetcher, owner, repo, runId });
		rerunState = result.ok ? "true" : `failed:${result.status}`;
		rerunTriggeredThisPass = result.ok;
	} else if (
		existingMarker &&
		existingMarker.sha === sha &&
		existingMarker.rerunTriggered
	) {
		// Not eligible BECAUSE a prior invocation already succeeded for this
		// exact SHA -- carry that forward so the comment keeps reflecting it,
		// rather than regressing to "false" and implying nothing ever ran.
		// This pass itself triggered nothing, though (rerunTriggeredThisPass
		// stays false).
		rerunState = "true";
	}

	const commentBody = buildCommentBody({ classification, sha, rerunState });
	// A push run has no issue thread to post the sticky comment to -- the
	// classify job's own log (this function's caller prints commentBody) is
	// the only trace for that run, by design (#2668).
	const postedComment = prNumber
		? await upsertComment({
				fetcher,
				owner,
				repo,
				prNumber,
				existingComment,
				body: commentBody,
			})
		: null;

	let result = {
		classification,
		rerunTriggeredThisPass,
		commentBody,
		sha,
		prNumber,
		jobId,
		jobName: resolvedJobName,
	};

	// F3: only a brand-new comment can race a concurrent invocation's brand
	// -new comment into a duplicate -- a PATCH to an existing single comment
	// cannot itself create one. No PR means no comment thread to reconcile.
	if (prNumber && !existingComment) {
		const reconciled = await reconcileDuplicateClassifierComments({
			fetcher,
			owner,
			repo,
			prNumber,
			sha,
			postedCommentId: postedComment?.id,
		});
		if (!reconciled.isWinner) {
			// A concurrent invocation's earlier comment owns this SHA now; this
			// call's own rerun attempt (if any) already fired and can't be
			// undone -- GitHub's own rerun-failed-jobs idempotency (rerunning an
			// already-queued/in-progress run is a no-op) covers that overlap.
			result = {
				...result,
				rerunTriggeredThisPass: false,
				supersededByCommentId: reconciled.winningCommentId,
			};
		}
	}

	return result;
}

/**
 * Records an absent classification as an explicit PR comment. The workflow
 * supplies the event's PR and SHA so a failed run/job/log API read cannot turn
 * into a silent no-op. When those identifiers are unavailable, the original
 * error remains authoritative and no broader permission is assumed.
 */
async function commentClassificationFailure({
	fetcher,
	owner,
	repo,
	prNumber,
	sha,
	error,
}) {
	if (!prNumber || !sha) return false;
	const rawDetail = error instanceof Error ? error.message : String(error);
	// Same untrusted-text rule as buildCommentBody: the error message can
	// carry GitHub API response text, which is attacker-influenced on the
	// same axis as job logs (mentions, HTML comments).
	const detail = sanitizeCommentDetail(
		rawDetail.replace(/\s+/g, " ").slice(0, 500),
	);
	const body =
		`ci-classifier: classification failed; no rerun was triggered: ${detail} ` +
		buildMarker(sha, "false");
	const existingComment = await findExistingClassifierComment({
		fetcher,
		owner,
		repo,
		prNumber,
	});
	await upsertComment({
		fetcher,
		owner,
		repo,
		prNumber,
		existingComment,
		body,
	});
	return true;
}

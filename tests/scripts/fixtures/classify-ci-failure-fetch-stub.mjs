// Fetch stub for the end-to-end CLI test (#2668 review F2). Loaded via
// `node --import` BEFORE scripts/classify-ci-failure.mjs runs, so it can
// replace globalThis.fetch before the CLI's own module-level code executes.
// This is what makes the test exercise the REAL CLI argv-parsing and
// process wiring (spawned as a genuine child process) rather than calling
// the exported library functions directly -- the axis the pre-existing
// `tests/scripts/ci-failure-classifier.test.ts` suite cannot reach, per
// review F2 ("the shipped seam scripts/classify-ci-failure.mjs has zero
// tests").
//
// Configuration is via env vars (the parent test process controls the
// child's env when spawning): a `--import` module takes no CLI args of its
// own.
//   CLASSIFY_CLI_TEST_CALL_LOG   required: path this stub appends one JSON
//                                 line per intercepted fetch call to, so the
//                                 parent test can assert on them after the
//                                 child process exits (a different process
//                                 can't share the parent's in-memory array).
//   CLASSIFY_CLI_TEST_RERUN_STATUS  optional (default "201"): HTTP status
//                                 the rerun-failed-jobs endpoint returns.
//
// Fixed to run id 999 / job id 111 / job name "Unit tests", matching the
// exact production argv this test exercises
// (`--run 999 --sha deadbeef --infra-kill-only --skip-missing-job
// --allow-missing-pr`) and the same real infra-kill log fixture the
// library's own unit tests use.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rawLog = readFileSync(
	join(
		here,
		"..",
		"..",
		"fixtures",
		"ci-failure-logs",
		"infra-kill-wrapper-killed.real.log",
	),
	"utf8",
);

const callLogPath = process.env.CLASSIFY_CLI_TEST_CALL_LOG;
const rerunStatus = Number(process.env.CLASSIFY_CLI_TEST_RERUN_STATUS ?? "201");

function record(method, url) {
	if (!callLogPath) return;
	appendFileSync(callLogPath, `${JSON.stringify({ method, url })}\n`);
}

globalThis.fetch = async (url, init = {}) => {
	const method = init?.method ?? "GET";
	const urlStr = String(url);
	record(method, urlStr);

	if (urlStr.endsWith("/actions/runs/999")) {
		// Production-faithful: a push/repository_dispatch run's
		// `pull_requests` array is always empty (#2668).
		return new Response(
			JSON.stringify({ head_sha: "deadbeef", pull_requests: [] }),
			{ status: 200 },
		);
	}
	if (urlStr.endsWith("/actions/runs/999/jobs")) {
		return new Response(
			JSON.stringify({
				jobs: [{ id: 111, name: "Unit tests", conclusion: "failure" }],
			}),
			{ status: 200 },
		);
	}
	if (urlStr.endsWith("/actions/jobs/111/logs")) {
		return new Response(rawLog, { status: 200 });
	}
	if (urlStr.endsWith("/actions/runs/999/rerun-failed-jobs")) {
		return new Response("{}", { status: rerunStatus });
	}
	throw new Error(`unmocked URL in CLI fetch stub: ${method} ${urlStr}`);
};

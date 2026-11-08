// flake-shape: real-process-spawn — the subject is the helper's own bash fetch step (curl, then sha256sum, then mv); only a real bash shows that a failed verify leaves no file behind, and the one fake is curl, a network boundary a test cannot reach.
// The fetch-verified helper's fetch step, run for real under bash. The only fake
// is curl, a network boundary a test cannot reach: a shell script on PATH that
// serves a fixture body the way curl does. Real curl with --fail exits 22 and
// writes nothing on an HTTP error; without --fail it saves the error page and
// exits 0, which is how #5409's 504 became a "checksum did NOT match" failure.
//
// Recurrence #5409 (2026-11-08): a 504 page was saved as the archive and failed
// its sha256 check. The helper must name the HTTP error, keep a verified cache
// hit off the network, re-download a corrupt cache entry, and never place a file
// that failed its pinned digest. Lives in tests/scripts, not tests/config: the
// Windows unit lane runs tests/config and has no bash shim for this fake.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workflowDocument } from "../../scripts/dispatch-safety.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const HELPER_FILE = resolve(ROOT, ".github/actions/fetch-verified/action.yml");
const ASSET_URL = "https://github.com/o/r/releases/download/v1/asset.bin";
const PAYLOAD = Buffer.from("pinned release bytes\n");
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

/** The helper's fetch step: the one composite step that runs curl. */
function fetchScript(): string {
	const doc = workflowDocument(readFileSync(HELPER_FILE, "utf8")) as {
		runs?: { steps?: Array<{ run?: unknown }> };
	};
	const step = doc.runs?.steps?.find(
		(candidate) =>
			typeof candidate.run === "string" && candidate.run.includes("curl"),
	);
	if (typeof step?.run !== "string")
		throw new Error("fetch-verified has no curl step");
	return step.run;
}

const FAKE_CURL = `#!/bin/sh
echo "$*" >> "$FAKE_CURL_LOG"
out=""; fail=0; prev=""
for arg in "$@"; do
  case "$prev" in --output|-o) out="$arg" ;; esac
  [ "$arg" = "--fail" ] && fail=1
  prev="$arg"
done
if [ "$FAKE_CURL_STATUS" != 200 ]; then
  if [ "$fail" = 1 ]; then echo "curl: (22) The requested URL returned error: $FAKE_CURL_STATUS" >&2; exit 22; fi
  printf '<h1>%s Gateway Time-out</h1>\\n' "$FAKE_CURL_STATUS" > "$out"; exit 0
fi
cp "$FAKE_CURL_BODY" "$out"
`;

type Outcome = {
	status: number | null;
	stdout: string;
	stderr: string;
	curlCalls: string[];
	downloaded: boolean;
	dest: Buffer | null;
};

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function runFetch(options: {
	cached?: Buffer;
	served: Buffer;
	status?: number;
	expectSha?: string;
}): Outcome {
	const work = mkdtempSync(join(tmpdir(), "pi-lens-fetch-verified-"));
	scratch.push(work);
	const bin = join(work, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
	const body = join(work, "served");
	writeFileSync(body, options.served);
	const dest = join(work, "cache", "asset.bin");
	if (options.cached) {
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, options.cached);
	}
	const log = join(work, "curl.log");
	const githubOutput = join(work, "github-output");
	writeFileSync(githubOutput, "");
	const result = spawnSync("bash", ["-c", fetchScript()], {
		encoding: "utf8",
		env: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			HOME: work,
			TMPDIR: work,
			URL: ASSET_URL,
			SHA256: options.expectSha ?? PAYLOAD_SHA,
			DEST: dest,
			GITHUB_OUTPUT: githubOutput,
			FAKE_CURL_LOG: log,
			FAKE_CURL_BODY: body,
			FAKE_CURL_STATUS: String(options.status ?? 200),
		},
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		curlCalls: existsSync(log)
			? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
			: [],
		downloaded: readFileSync(githubOutput, "utf8").includes("downloaded=true"),
		dest: existsSync(dest) ? readFileSync(dest) : null,
	};
}

describe("fetch-verified fetch step", () => {
	it("keeps a verified cache hit off the network", () => {
		const outcome = runFetch({
			cached: PAYLOAD,
			served: Buffer.from("unused"),
		});
		expect(outcome.status).toBe(0);
		expect(outcome.curlCalls).toEqual([]);
		expect(outcome.downloaded).toBe(false);
	});

	it("downloads on a miss with --fail and retries, verifies, then places the file", () => {
		const outcome = runFetch({ served: PAYLOAD });
		expect(outcome.status).toBe(0);
		expect(outcome.curlCalls).toHaveLength(1);
		expect(outcome.curlCalls[0]).toMatch(/--fail/);
		expect(outcome.curlCalls[0]).toMatch(/--retry 5 --retry-all-errors/);
		expect(outcome.dest?.equals(PAYLOAD)).toBe(true);
		expect(outcome.downloaded).toBe(true);
	});

	it("names an HTTP 504 as an HTTP error and places nothing", () => {
		const outcome = runFetch({ served: PAYLOAD, status: 504 });
		expect(outcome.status).toBe(22);
		expect(outcome.stderr).toMatch(/returned error: 504/);
		expect(outcome.dest).toBeNull();
		expect(outcome.downloaded).toBe(false);
	});

	it("never places a served file that fails the pinned sha256", () => {
		const outcome = runFetch({
			served: Buffer.from("a different file"),
			expectSha: PAYLOAD_SHA,
		});
		expect(outcome.status).not.toBe(0);
		expect(`${outcome.stdout}${outcome.stderr}`).toMatch(/FAILED/);
		expect(outcome.dest).toBeNull();
		expect(outcome.downloaded).toBe(false);
	});

	it("replaces a corrupt cached file with a verified download", () => {
		const outcome = runFetch({
			cached: Buffer.from("corrupt entry"),
			served: PAYLOAD,
		});
		expect(outcome.status).toBe(0);
		expect(outcome.curlCalls).toHaveLength(1);
		expect(outcome.dest?.equals(PAYLOAD)).toBe(true);
		expect(outcome.downloaded).toBe(true);
	});
});

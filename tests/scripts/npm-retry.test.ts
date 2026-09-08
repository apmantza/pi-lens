// flake-shape: real-process-spawn — the CLI's actual exit code and its
// distinct `::error::infra:` label are the subject under test; an in-process
// stub of npm-retry.mjs would just re-assert whatever exit code the test
// author typed, not what the script actually does when the wrapped `npm`
// keeps failing (#2613 review S3a).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFailureLog } from "../../scripts/lib/ci-failure-classifier.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLI = path.join(REPO_ROOT, "scripts/npm-retry.mjs");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// A stub `npm` on PATH ahead of the real one, so this is hermetic (no live
// registry) while exercising the real spawn path end to end. Fails
// `failTimes` times (tracked via a counter file, since each attempt is a
// separate process) before succeeding, or forever for the exhaustion case.
function stubNpm(
	root: string,
	failTimes: number,
	failure = "stub: simulated registry failure",
) {
	const binDir = path.join(root, "bin");
	fs.mkdirSync(binDir);
	const npmStub = path.join(binDir, "npm");
	const counterFile = path.join(root, ".npm-stub-calls");
	fs.writeFileSync(counterFile, "0");
	fs.writeFileSync(
		npmStub,
		[
			"#!/usr/bin/env node",
			`const fs = require("fs");`,
			`const counterFile = ${JSON.stringify(counterFile)};`,
			`const n = Number(fs.readFileSync(counterFile, "utf8")) + 1;`,
			`fs.writeFileSync(counterFile, String(n));`,
			`if (n <= ${failTimes}) { console.error(${JSON.stringify(failure)}); process.exit(1); }`,
			`console.log("stub: ok, args=" + process.argv.slice(2).join(" "));`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return binDir;
}

function runCli(binDir: string, args: string[]) {
	return execFileSync(process.execPath, [CLI, ...args], {
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH}`,
			// Instant retries — the retry COUNT and eventual outcome are this
			// test's subject, not real backoff timing.
			NPM_RETRY_BACKOFF_MS: "0,0,0",
		},
		encoding: "utf-8",
	});
}

describe("npm-retry.mjs (#2613 review S3a)", () => {
	it("passes through a successful npm call with no retry", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-npm-retry-"));
		tempDirs.push(root);
		const binDir = stubNpm(root, 0);
		const stdout = runCli(binDir, ["ci", "--ignore-scripts"]);
		expect(stdout).toContain("stub: ok, args=ci --ignore-scripts");
		expect(stdout).not.toContain("npm-retry: succeeded on attempt");
	});

	it("retries a failing npm call and succeeds once it recovers", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-npm-retry-"));
		tempDirs.push(root);
		const binDir = stubNpm(root, 2, "npm error code ECONNRESET");
		const stdout = runCli(binDir, ["install", "--no-save"]);
		expect(stdout).toContain("stub: ok, args=install --no-save");
	});

	// Review follow-through: the "succeeded on attempt N" diagnostic must go
	// to STDERR, never stdout — a caller capturing this script's stdout for
	// the wrapped command's OWN output (resolve-newest-in-range-host.mjs's
	// `npm view`, captured via `$(...)`) must see ONLY that output, or a
	// retry that succeeds silently corrupts the captured value.
	it("prints the 'succeeded on attempt' diagnostic to stderr, never stdout", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-npm-retry-"));
		tempDirs.push(root);
		const binDir = stubNpm(root, 1, "npm error code ECONNRESET");
		const result = spawnSync(process.execPath, [CLI, "install", "--no-save"], {
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				NPM_RETRY_BACKOFF_MS: "0,0,0",
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).not.toContain("npm-retry: succeeded");
		expect(result.stdout).toContain("stub: ok, args=install --no-save");
		expect(result.stderr).toContain("npm-retry: succeeded on attempt 2");
	});

	it("exits non-zero with a distinct infra label when every retry fails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-npm-retry-"));
		tempDirs.push(root);
		const binDir = stubNpm(root, 999, "npm error code ECONNRESET");
		try {
			runCli(binDir, ["ci", "--ignore-scripts"]);
			expect.unreachable("expected the CLI to exit nonzero");
		} catch (err) {
			const e = err as { status?: number; stderr?: string };
			expect(e.status).not.toBe(0);
			expect(e.stderr).toMatch(/::error::infra: registry unreachable/);
			expect(e.stderr).toMatch(
				/npm ci --ignore-scripts failed after 3 attempts/,
			);
		}
	});

	it("does not retry or label a deterministic ERESOLVE failure as infra", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-npm-retry-"));
		tempDirs.push(root);
		const binDir = stubNpm(root, 999, "npm error code ERESOLVE");
		try {
			runCli(binDir, ["ci", "--ignore-scripts"]);
			expect.unreachable("expected the CLI to exit nonzero");
		} catch (err) {
			const e = err as { status?: number; stderr?: string };
			expect(e.status).toBe(1);
			expect(e.stderr).not.toContain("infra: registry unreachable");
			expect(e.stderr).toContain(
				"npm ci --ignore-scripts failed after 1 attempt",
			);
			expect(e.stderr).not.toMatch(/failed after 1 attempt.*infra/);
			expect(fs.readFileSync(path.join(root, ".npm-stub-calls"), "utf8")).toBe(
				"1",
			);
			expect(classifyFailureLog(e.stderr ?? "").kind).toBe("real");
		}
	});
});

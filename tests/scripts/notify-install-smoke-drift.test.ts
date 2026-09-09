// flake-shape: real-process-spawn — `--dry-run`'s env-reading/action-deciding
// wiring, and (round-2 review F1) the real `gh` subcommands this script
// actually invokes for each of the four decideAction outcomes, are the
// subject under test; an in-process stub of this CLI would just re-assert
// whatever the test author typed, not what the script actually does when
// wired to a real (stubbed) `gh` (#2613).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLI = path.join(REPO_ROOT, "scripts/notify-install-smoke-drift.mjs");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function runDryRun(env: Record<string, string>) {
	return execFileSync(process.execPath, [CLI, "--dry-run"], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
	});
}

describe("notify-install-smoke-drift.mjs --dry-run (#2613)", () => {
	it("plans a filing when a step failed", () => {
		const out = runDryRun({
			RESOLVED_VERSION: "0.86.0",
			RESOLVE_OUTCOME: "success",
			INSTALL_CI_OUTCOME: "success",
			INSTALL_DEPS_OUTCOME: "success",
			GRAMMARS_OUTCOME: "success",
			BUILD_DIST_OUTCOME: "failure",
			PACK_OUTCOME: "skipped",
			INSTALL_TARBALL_OUTCOME: "skipped",
			SELFTEST_OUTCOME: "skipped",
		});
		expect(out).toContain("action=file-or-refresh");
		expect(out).toContain("Failing step: **build:dist**");
	});

	it("plans a close when every step succeeded", () => {
		const out = runDryRun({
			RESOLVED_VERSION: "0.86.0",
			RESOLVE_OUTCOME: "success",
			INSTALL_CI_OUTCOME: "success",
			INSTALL_DEPS_OUTCOME: "success",
			GRAMMARS_OUTCOME: "success",
			BUILD_DIST_OUTCOME: "success",
			PACK_OUTCOME: "success",
			INSTALL_TARBALL_OUTCOME: "success",
			SELFTEST_OUTCOME: "success",
		});
		expect(out).toContain("action=close-if-open");
	});

	// Review S2 correctness follow-through: a registry failure resolving
	// @latest itself (every later step consequently "skipped", never
	// "failure") must still read as drift -- see
	// tests/scripts/install-smoke-drift.test.ts for the pure-function proof;
	// this proves the CLI's env wiring actually reaches RESOLVE_OUTCOME.
	it("plans a filing when ONLY the resolve step failed (everything after it skipped)", () => {
		const out = runDryRun({
			RESOLVED_VERSION: "",
			RESOLVE_OUTCOME: "failure",
			INSTALL_CI_OUTCOME: "skipped",
			INSTALL_DEPS_OUTCOME: "skipped",
			GRAMMARS_OUTCOME: "skipped",
			BUILD_DIST_OUTCOME: "skipped",
			PACK_OUTCOME: "skipped",
			INSTALL_TARBALL_OUTCOME: "skipped",
			SELFTEST_OUTCOME: "skipped",
		});
		expect(out).toContain("action=file-or-refresh");
		expect(out).toContain("Failing step: **resolve @latest**");
	});

	// Round-2 review F1, attack A: cancel-in-progress interrupts a nightly
	// mid-run. Must plan NEITHER a filing NOR a close.
	it("plans NO action for a cancelled-mid-run report (attack A)", () => {
		const out = runDryRun({
			RESOLVED_VERSION: "0.86.0",
			RESOLVE_OUTCOME: "success",
			INSTALL_CI_OUTCOME: "cancelled",
			INSTALL_DEPS_OUTCOME: "skipped",
			GRAMMARS_OUTCOME: "skipped",
			BUILD_DIST_OUTCOME: "skipped",
			PACK_OUTCOME: "skipped",
			INSTALL_TARBALL_OUTCOME: "skipped",
			SELFTEST_OUTCOME: "skipped",
		});
		expect(out).toContain("action=no-action");
	});

	// Attack B: cancelled before any step ran.
	it("plans NO action for a cancelled-before-any-step report (attack B)", () => {
		const out = runDryRun({
			RESOLVED_VERSION: "",
			RESOLVE_OUTCOME: "cancelled",
			INSTALL_CI_OUTCOME: "skipped",
			INSTALL_DEPS_OUTCOME: "skipped",
			GRAMMARS_OUTCOME: "skipped",
			BUILD_DIST_OUTCOME: "skipped",
			PACK_OUTCOME: "skipped",
			INSTALL_TARBALL_OUTCOME: "skipped",
			SELFTEST_OUTCOME: "skipped",
		});
		expect(out).toContain("action=no-action");
	});

	// Attack C: the invoking workflow step never set any outcome env var at
	// all (a caller wiring bug) -- must plan "unknown" and warn (on stderr,
	// via console.error), not guess.
	it("plans 'unknown' and warns when every outcome env var is absent (attack C)", () => {
		const result = spawnSync(process.execPath, [CLI, "--dry-run"], {
			env: {
				...process.env,
				RESOLVE_OUTCOME: undefined as unknown as string,
				INSTALL_CI_OUTCOME: undefined as unknown as string,
				INSTALL_DEPS_OUTCOME: undefined as unknown as string,
				GRAMMARS_OUTCOME: undefined as unknown as string,
				BUILD_DIST_OUTCOME: undefined as unknown as string,
				PACK_OUTCOME: undefined as unknown as string,
				INSTALL_TARBALL_OUTCOME: undefined as unknown as string,
				SELFTEST_OUTCOME: undefined as unknown as string,
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("missing or not a real");
		expect(result.stderr).toContain("taking NO action");
		expect(result.stdout).toBe("");
	});
});

// ── Real (stubbed) `gh` wiring — round-2 review F1's own probe shape ───────
//
// The reviewer's probe ran this CLI for real (not --dry-run) against a stub
// `gh` that reports an existing open tracker (#4242) and observed
// "closed tracking issue #4242" printed for all three attacks. These tests
// reproduce that exact probe: a JSONL log of every `gh` invocation proves
// which subcommand (if any) actually ran.

function stubGh(
	root: string,
	existingIssue: { number: number; title: string } | null,
) {
	const binDir = path.join(root, "bin");
	fs.mkdirSync(binDir);
	const logFile = path.join(root, "gh-calls.jsonl");
	fs.writeFileSync(logFile, "");
	const ghStub = path.join(binDir, "gh");
	fs.writeFileSync(
		ghStub,
		[
			"#!/usr/bin/env node",
			`const fs = require("fs");`,
			`fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
			`const args = process.argv.slice(2);`,
			`if (args[0] === "issue" && args[1] === "list") {`,
			`  console.log(JSON.stringify(${existingIssue ? `[${JSON.stringify(existingIssue)}]` : "[]"}));`,
			`} else {`,
			`  console.log("ok");`,
			`}`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return { binDir, logFile };
}

function runReal(binDir: string, env: Record<string, string>) {
	return execFileSync(process.execPath, [CLI], {
		env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env },
		encoding: "utf-8",
	});
}

function readGhCalls(logFile: string): string[][] {
	return fs
		.readFileSync(logFile, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

const EXISTING_TRACKER = {
	number: 4242,
	title: "install-smoke: pi-coding-agent@latest install drift detected",
};

describe("notify-install-smoke-drift.mjs against a real (stubbed) gh — round-2 review F1", () => {
	it("attack A (cancelled mid-run): never calls gh issue close", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-drift-gh-"));
		tempDirs.push(root);
		const { binDir, logFile } = stubGh(root, EXISTING_TRACKER);
		const out = runReal(binDir, {
			RESOLVED_VERSION: "0.86.0",
			RESOLVE_OUTCOME: "success",
			INSTALL_CI_OUTCOME: "cancelled",
			INSTALL_DEPS_OUTCOME: "skipped",
			GRAMMARS_OUTCOME: "skipped",
			BUILD_DIST_OUTCOME: "skipped",
			PACK_OUTCOME: "skipped",
			INSTALL_TARBALL_OUTCOME: "skipped",
			SELFTEST_OUTCOME: "skipped",
		});
		expect(out).not.toContain("closed tracking issue");
		const calls = readGhCalls(logFile);
		expect(calls.some((c) => c[0] === "issue" && c[1] === "close")).toBe(false);
	});

	it("attack B (cancelled before any step): never calls gh issue close", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-drift-gh-"));
		tempDirs.push(root);
		const { binDir, logFile } = stubGh(root, EXISTING_TRACKER);
		const out = runReal(binDir, {
			RESOLVED_VERSION: "",
			RESOLVE_OUTCOME: "cancelled",
			INSTALL_CI_OUTCOME: "skipped",
			INSTALL_DEPS_OUTCOME: "skipped",
			GRAMMARS_OUTCOME: "skipped",
			BUILD_DIST_OUTCOME: "skipped",
			PACK_OUTCOME: "skipped",
			INSTALL_TARBALL_OUTCOME: "skipped",
			SELFTEST_OUTCOME: "skipped",
		});
		expect(out).not.toContain("closed tracking issue");
		const calls = readGhCalls(logFile);
		expect(calls.some((c) => c[0] === "issue" && c[1] === "close")).toBe(false);
		// Attack A/B take no action at all -- gh is never even queried.
		expect(calls.length).toBe(0);
	});

	it("attack C (env vars absent): never calls gh at all, warns instead", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-drift-gh-"));
		tempDirs.push(root);
		const { binDir, logFile } = stubGh(root, EXISTING_TRACKER);
		const result = spawnSync(process.execPath, [CLI], {
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				RESOLVE_OUTCOME: undefined as unknown as string,
				INSTALL_CI_OUTCOME: undefined as unknown as string,
				INSTALL_DEPS_OUTCOME: undefined as unknown as string,
				GRAMMARS_OUTCOME: undefined as unknown as string,
				BUILD_DIST_OUTCOME: undefined as unknown as string,
				PACK_OUTCOME: undefined as unknown as string,
				INSTALL_TARBALL_OUTCOME: undefined as unknown as string,
				SELFTEST_OUTCOME: undefined as unknown as string,
			},
			encoding: "utf-8",
		});
		expect(result.stdout).not.toContain("closed tracking issue");
		expect(result.stderr).toContain("::warning::");
		const calls = readGhCalls(logFile);
		expect(calls.length).toBe(0);
	});

	// The POSITIVE case: a genuinely clean run (every step "success") with an
	// existing tracker DOES close it -- proves the fix didn't just make
	// close() unreachable altogether.
	it("a genuinely clean run (every step success) DOES close an existing tracker", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-drift-gh-"));
		tempDirs.push(root);
		const { binDir, logFile } = stubGh(root, EXISTING_TRACKER);
		const out = runReal(binDir, {
			RESOLVED_VERSION: "0.86.0",
			RESOLVE_OUTCOME: "success",
			INSTALL_CI_OUTCOME: "success",
			INSTALL_DEPS_OUTCOME: "success",
			GRAMMARS_OUTCOME: "success",
			BUILD_DIST_OUTCOME: "success",
			PACK_OUTCOME: "success",
			INSTALL_TARBALL_OUTCOME: "success",
			SELFTEST_OUTCOME: "success",
		});
		expect(out).toContain("closed tracking issue #4242");
		const calls = readGhCalls(logFile);
		expect(calls.some((c) => c[0] === "issue" && c[1] === "close")).toBe(true);
	});

	// A real failure DOES file/refresh -- proves the fix didn't make the
	// original, working filing path unreachable either.
	it("a real failure DOES file/refresh the tracker", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-drift-gh-"));
		tempDirs.push(root);
		const { binDir, logFile } = stubGh(root, null);
		const out = runReal(binDir, {
			RESOLVED_VERSION: "0.86.0",
			RESOLVE_OUTCOME: "success",
			INSTALL_CI_OUTCOME: "success",
			INSTALL_DEPS_OUTCOME: "success",
			GRAMMARS_OUTCOME: "success",
			BUILD_DIST_OUTCOME: "failure",
			PACK_OUTCOME: "skipped",
			INSTALL_TARBALL_OUTCOME: "skipped",
			SELFTEST_OUTCOME: "skipped",
		});
		expect(out).toContain("filed a new tracking issue");
		const calls = readGhCalls(logFile);
		expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(true);
	});

	// Outcome-table completeness (round-2 rail): (failure, tracker: open) —
	// refreshes the EXISTING tracker rather than filing a second one.
	it("a real failure with an EXISTING tracker refreshes it (edit + comment), never creates a second", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-drift-gh-"));
		tempDirs.push(root);
		const { binDir, logFile } = stubGh(root, EXISTING_TRACKER);
		const out = runReal(binDir, {
			RESOLVED_VERSION: "0.86.0",
			RESOLVE_OUTCOME: "success",
			INSTALL_CI_OUTCOME: "success",
			INSTALL_DEPS_OUTCOME: "success",
			GRAMMARS_OUTCOME: "success",
			BUILD_DIST_OUTCOME: "failure",
			PACK_OUTCOME: "skipped",
			INSTALL_TARBALL_OUTCOME: "skipped",
			SELFTEST_OUTCOME: "skipped",
		});
		expect(out).toContain("updated tracking issue #4242");
		const calls = readGhCalls(logFile);
		expect(calls.some((c) => c[0] === "issue" && c[1] === "edit")).toBe(true);
		expect(calls.some((c) => c[0] === "issue" && c[1] === "comment")).toBe(
			true,
		);
		expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(
			false,
		);
	});

	// Outcome-table completeness (round-2 rail): (success, tracker: none) —
	// nothing to close, no-op, and (crucially) never files anything either.
	it("a genuinely clean run with NO existing tracker does nothing at all", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-drift-gh-"));
		tempDirs.push(root);
		const { binDir, logFile } = stubGh(root, null);
		const out = runReal(binDir, {
			RESOLVED_VERSION: "0.86.0",
			RESOLVE_OUTCOME: "success",
			INSTALL_CI_OUTCOME: "success",
			INSTALL_DEPS_OUTCOME: "success",
			GRAMMARS_OUTCOME: "success",
			BUILD_DIST_OUTCOME: "success",
			PACK_OUTCOME: "success",
			INSTALL_TARBALL_OUTCOME: "success",
			SELFTEST_OUTCOME: "success",
		});
		expect(out).toContain("no drift, no open tracking issue — nothing to do");
		const calls = readGhCalls(logFile);
		expect(
			calls.some(
				(c) => c[0] === "issue" && (c[1] === "close" || c[1] === "create"),
			),
		).toBe(false);
	});
});

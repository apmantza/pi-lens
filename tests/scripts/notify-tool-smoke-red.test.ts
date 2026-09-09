// flake-shape: real-process-spawn — this CLI's env-reading/action-deciding
// wiring, and the real `gh` subcommands it actually invokes, are the subject
// under test; an in-process stub would just re-assert whatever the test
// author typed, not what the script does when wired to a real (stubbed)
// `gh` — same rationale as tests/scripts/notify-install-smoke-drift.test.ts
// (#2613), which this file otherwise mirrors for #2723's second, independent
// notifier.
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
const CLI = path.join(REPO_ROOT, "scripts/notify-tool-smoke-red.mjs");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function mkTempDir(prefix: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeLog(dir: string, name: string, text: string) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, text);
	return file;
}

// Acceptance #4's exact vector (see tests/scripts/tool-smoke-drift.test.ts's
// module doc for provenance: run 34116176046, job 101723408154).
const REPLAY_LOG = [
	"Live tool-smoke (#209) — LSP handshake (install → spawn → initialize)",
	"",
	"   LANG         RUNNER/SERVER                DIAG  DETAIL",
	"✗  php          intelephense                 0     ensureTool(intelephense) failed (npm toolchain present): install failed",
	"",
	"36 passed · 1 failed · 0 setup-failed · 12 skipped (tool/config unavailable)",
	"Legend: ✓ ok  ✗ failure/setup-failed  ⚠ unavailable (not a failure)",
	"",
].join("\n");

function runDryRun(env: Record<string, string>) {
	return execFileSync(process.execPath, [CLI, "--dry-run"], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
	});
}

describe("notify-tool-smoke-red.mjs --dry-run (#2723)", () => {
	it("acceptance #4: replaying run 34116176046 plans a filing naming php/intelephense and the summary counts", () => {
		const dir = mkTempDir("pi-lens-tool-smoke-replay-");
		const out = runDryRun({
			TOOL_LAYER_OUTCOME: "success",
			TOOL_LAYER_LOG: writeLog(
				dir,
				"tool-layer.log",
				"40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n",
			),
			LSP_HANDSHAKE_OUTCOME: "failure",
			LSP_HANDSHAKE_LOG: writeLog(dir, "lsp-handshake.log", REPLAY_LOG),
			LSP_GATE_OUTCOME: "skipped",
			LSP_GATE_LOG: writeLog(dir, "lsp-gate.log", ""),
			FORMAT_LAYER_OUTCOME: "skipped",
			FORMAT_LAYER_LOG: writeLog(dir, "format-layer.log", ""),
		});
		expect(out).toContain("action=file-or-refresh");
		expect(out).toContain("Failing layer: **LSP handshake layer**");
		expect(out).toContain(
			"`php` / `intelephense` — ensureTool(intelephense) failed (npm toolchain present): install failed",
		);
		expect(out).toContain("36 passed · 1 failed · 0 setup-failed · 12 skipped");
	});

	it("plans a close when all four gating layers succeeded", () => {
		const dir = mkTempDir("pi-lens-tool-smoke-clean-");
		const out = runDryRun({
			TOOL_LAYER_OUTCOME: "success",
			TOOL_LAYER_LOG: writeLog(
				dir,
				"tool.log",
				"40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n",
			),
			LSP_HANDSHAKE_OUTCOME: "success",
			LSP_HANDSHAKE_LOG: writeLog(
				dir,
				"lsp.log",
				"38 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n",
			),
			LSP_GATE_OUTCOME: "success",
			LSP_GATE_LOG: writeLog(
				dir,
				"lsp-gate.log",
				"38 passed · 0 failed · 0 setup-failed · 0 skipped\n",
			),
			FORMAT_LAYER_OUTCOME: "success",
			FORMAT_LAYER_LOG: writeLog(
				dir,
				"fmt.log",
				"10 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n",
			),
		});
		expect(out).toContain("action=close-if-open");
	});

	it("tracks a gate-only red with its outcome and log", () => {
		const dir = mkTempDir("pi-lens-tool-smoke-gate-red-");
		const out = runDryRun({
			TOOL_LAYER_OUTCOME: "success",
			TOOL_LAYER_LOG: writeLog(
				dir,
				"tool.log",
				"1 passed · 0 failed · 0 setup-failed · 0 skipped\n",
			),
			LSP_HANDSHAKE_OUTCOME: "success",
			LSP_HANDSHAKE_LOG: writeLog(
				dir,
				"lsp.log",
				"1 passed · 0 failed · 0 setup-failed · 0 skipped\n",
			),
			LSP_GATE_OUTCOME: "failure",
			LSP_GATE_LOG: writeLog(
				dir,
				"lsp-gate.log",
				"✗  lua          lua-language-server          0     lens_diagnostics returned 0 diagnostic(s) but 0 primary findings\n1 passed · 1 failed · 0 setup-failed · 0 skipped\n",
			),
			FORMAT_LAYER_OUTCOME: "skipped",
			FORMAT_LAYER_LOG: writeLog(dir, "fmt.log", ""),
		});
		expect(out).toContain("Failing layer: **LSP diagnostics clean-gate**");
		expect(out).toContain("lua-language-server");
	});

	// Acceptance #3, the green-path-only regression this file's own module
	// doc calls out (#2723): a run where an earlier layer failed and a later
	// one was therefore SKIPPED must still be read as drift, not "no-action" --
	// this is the exact GitHub Actions shape the bug reproduced against.
	it("plans a filing when the Tool layer itself failed (LSP handshake + Format consequently skipped)", () => {
		const dir = mkTempDir("pi-lens-tool-smoke-early-fail-");
		const out = runDryRun({
			TOOL_LAYER_OUTCOME: "failure",
			TOOL_LAYER_LOG: writeLog(
				dir,
				"tool.log",
				"0 passed · 1 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n",
			),
			LSP_HANDSHAKE_OUTCOME: "skipped",
			LSP_HANDSHAKE_LOG: writeLog(dir, "lsp.log", ""),
			LSP_GATE_OUTCOME: "skipped",
			LSP_GATE_LOG: writeLog(dir, "lsp-gate.log", ""),
			FORMAT_LAYER_OUTCOME: "skipped",
			FORMAT_LAYER_LOG: writeLog(dir, "fmt.log", ""),
		});
		expect(out).toContain("action=file-or-refresh");
		expect(out).toContain("Failing layer: **Tool layer**");
	});

	// No-action is checked (and short-circuits) BEFORE the dry-run body
	// preview, unlike the sibling notify-install-smoke-drift.mjs -- building
	// buildToolSmokeDriftBody for a no-action report would print a
	// meaningless "Failing layer: unknown" preview, since firstFailingStep is
	// null when nothing genuinely failed.
	it("plans NO action for a cancelled-mid-run report (no failure, not fully clean)", () => {
		const dir = mkTempDir("pi-lens-tool-smoke-cancelled-");
		const out = runDryRun({
			TOOL_LAYER_OUTCOME: "success",
			TOOL_LAYER_LOG: writeLog(
				dir,
				"tool.log",
				"40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n",
			),
			LSP_HANDSHAKE_OUTCOME: "cancelled",
			LSP_HANDSHAKE_LOG: writeLog(dir, "lsp.log", ""),
			LSP_GATE_OUTCOME: "skipped",
			LSP_GATE_LOG: writeLog(dir, "lsp-gate.log", ""),
			FORMAT_LAYER_OUTCOME: "skipped",
			FORMAT_LAYER_LOG: writeLog(dir, "fmt.log", ""),
		});
		expect(out).toContain("taking no action");
		expect(out).not.toContain("action=");
	});

	it("plans 'unknown' and warns when the outcome env vars are absent (wiring bug, not a run state)", () => {
		const result = spawnSync(process.execPath, [CLI, "--dry-run"], {
			env: {
				...process.env,
				TOOL_LAYER_OUTCOME: undefined as unknown as string,
				LSP_HANDSHAKE_OUTCOME: undefined as unknown as string,
				LSP_GATE_OUTCOME: undefined as unknown as string,
				FORMAT_LAYER_OUTCOME: undefined as unknown as string,
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("missing or not a real");
		expect(result.stdout).toBe("");
	});
});

// ── Real (stubbed) `gh` wiring — acceptance #1/#2/#5 ────────────────────────

function stubGh(
	root: string,
	existingIssue: { number: number; title: string } | null,
	existingBody = "",
	// #2723 review F1: the reviewer's own probe -- `gh issue create --label
	// a,b` validates every label up front and refuses to create the issue
	// at all if any of them is unknown to the repo (reproduced for real:
	// `nightly-drift` 404'd against `gh api repos/.../labels/nightly-drift`
	// before it was added to .github/labels.yml). "labeled" fails only the
	// create call that carries `--label`; a retry without one must succeed,
	// so a mode is needed to fail EVERY create regardless of `--label`,
	// proving the total-failure path is still handled gracefully.
	failCreate: false | "labeled" | "always" = false,
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
			`} else if (args[0] === "issue" && args[1] === "view") {`,
			`  console.log(JSON.stringify({ body: ${JSON.stringify(existingBody)} }));`,
			`} else if (args[0] === "issue" && args[1] === "create" && ${JSON.stringify(failCreate)} === "always") {`,
			`  process.stderr.write("HTTP 422: Validation Failed\\n");`,
			`  process.exit(1);`,
			`} else if (args[0] === "issue" && args[1] === "create" && ${JSON.stringify(failCreate)} === "labeled" && args.includes("--label")) {`,
			`  process.stderr.write("could not add label: 'nightly-drift' not found\\n");`,
			`  process.exit(1);`,
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

const RED_ENV = (dir: string) => ({
	TOOL_LAYER_OUTCOME: "success",
	TOOL_LAYER_LOG: writeLog(
		dir,
		"tool.log",
		"40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n",
	),
	LSP_HANDSHAKE_OUTCOME: "failure",
	LSP_HANDSHAKE_LOG: writeLog(dir, "lsp.log", REPLAY_LOG),
	LSP_GATE_OUTCOME: "skipped",
	LSP_GATE_LOG: writeLog(dir, "lsp-gate.log", ""),
	FORMAT_LAYER_OUTCOME: "skipped",
	FORMAT_LAYER_LOG: writeLog(dir, "fmt.log", ""),
});

const GREEN_ENV = (dir: string) => ({
	TOOL_LAYER_OUTCOME: "success",
	TOOL_LAYER_LOG: writeLog(
		dir,
		"tool.log",
		"40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n",
	),
	LSP_HANDSHAKE_OUTCOME: "success",
	LSP_HANDSHAKE_LOG: writeLog(
		dir,
		"lsp.log",
		"38 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n",
	),
	LSP_GATE_OUTCOME: "success",
	LSP_GATE_LOG: writeLog(
		dir,
		"lsp-gate.log",
		"38 passed · 0 failed · 0 setup-failed · 0 skipped\n",
	),
	FORMAT_LAYER_OUTCOME: "success",
	FORMAT_LAYER_LOG: writeLog(
		dir,
		"fmt.log",
		"10 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n",
	),
});

describe("notify-tool-smoke-red.mjs against a real (stubbed) gh (#2723)", () => {
	// Acceptance #1: "a simulated red run creates exactly one tracking issue".
	it("a red run with NO existing tracker creates exactly one issue", () => {
		const root = mkTempDir("pi-lens-tool-smoke-gh-");
		const logDir = mkTempDir("pi-lens-tool-smoke-logs-");
		const { binDir, logFile } = stubGh(root, null);
		const out = runReal(binDir, RED_ENV(logDir));
		expect(out).toContain("filed a new tracking issue");
		const calls = readGhCalls(logFile);
		const creates = calls.filter((c) => c[0] === "issue" && c[1] === "create");
		expect(creates.length).toBe(1);
	});

	// #2723 review F1: the reviewer's own reproduction -- `gh issue create
	// --label nightly-drift,area:tests` 404'd on the (at the time, missing)
	// label and the ORIGINAL script had no retry, so the issue was never
	// filed at all on the first red night. This is the red-first proof
	// (quoted in the PR body) that a single non-retrying create call drops
	// the issue entirely, and the fixed script's retry-without-labels
	// recovers it.
	it("acceptance F1: a create that rejects the label retries without labels and still files the issue", () => {
		const root = mkTempDir("pi-lens-tool-smoke-gh-label-");
		const logDir = mkTempDir("pi-lens-tool-smoke-logs-");
		const { binDir, logFile } = stubGh(root, null, "", "labeled");
		const out = runReal(binDir, RED_ENV(logDir));
		expect(out).toContain("filed a new tracking issue");
		const calls = readGhCalls(logFile);
		const creates = calls.filter((c) => c[0] === "issue" && c[1] === "create");
		expect(creates.length).toBe(2);
		expect(creates[0]).toContain("--label");
		expect(creates[1]).not.toContain("--label");
	});

	// The total-failure case: even when BOTH the labeled and label-less
	// create attempts fail, the script logs the failure and does not crash
	// (acceptance #5's exit-0 contract, exercised through this specific path
	// for the first time -- previously nothing in this suite could make a
	// `create` call fail at all, so this path was untested).
	it("acceptance F1: a create that fails outright (both attempts) logs the failure and never files anything", () => {
		const root = mkTempDir("pi-lens-tool-smoke-gh-label-fail-");
		const logDir = mkTempDir("pi-lens-tool-smoke-logs-");
		const { binDir, logFile } = stubGh(root, null, "", "always");
		const out = runReal(binDir, RED_ENV(logDir));
		expect(out).not.toContain("filed a new tracking issue");
		const calls = readGhCalls(logFile);
		const creates = calls.filter((c) => c[0] === "issue" && c[1] === "create");
		expect(creates.length).toBe(2);
	});

	// Acceptance #1: "a second consecutive red updates it (assert count, not
	// presence)" -- proves the fix refreshes (edit + comment) the SAME
	// tracker rather than filing a second one.
	it("a second consecutive red UPDATES the existing tracker, never creates a second", () => {
		const root = mkTempDir("pi-lens-tool-smoke-gh-");
		const logDir = mkTempDir("pi-lens-tool-smoke-logs-");
		const existing = {
			number: 4343,
			title: "tool-smoke: nightly Live tool + LSP smoke job is red",
		};
		const { binDir, logFile } = stubGh(
			root,
			existing,
			"Consecutive red nights: **1**",
		);
		const out = runReal(binDir, RED_ENV(logDir));
		expect(out).toContain("updated tracking issue #4343");
		expect(out).toContain("consecutive red: 2");
		const calls = readGhCalls(logFile);
		expect(
			calls.filter((c) => c[0] === "issue" && c[1] === "create").length,
		).toBe(0);
		expect(calls.some((c) => c[0] === "issue" && c[1] === "edit")).toBe(true);
		expect(calls.some((c) => c[0] === "issue" && c[1] === "comment")).toBe(
			true,
		);
	});

	// Acceptance #2: "a green run closes it."
	it("a green run closes an existing open tracker", () => {
		const root = mkTempDir("pi-lens-tool-smoke-gh-");
		const logDir = mkTempDir("pi-lens-tool-smoke-logs-");
		const existing = {
			number: 4343,
			title: "tool-smoke: nightly Live tool + LSP smoke job is red",
		};
		const { binDir, logFile } = stubGh(root, existing);
		const out = runReal(binDir, GREEN_ENV(logDir));
		expect(out).toContain("closed tracking issue #4343");
		const calls = readGhCalls(logFile);
		expect(calls.some((c) => c[0] === "issue" && c[1] === "close")).toBe(true);
	});

	it("a green run with no existing tracker is a no-op (never files anything)", () => {
		const root = mkTempDir("pi-lens-tool-smoke-gh-");
		const logDir = mkTempDir("pi-lens-tool-smoke-logs-");
		const { binDir, logFile } = stubGh(root, null);
		const out = runReal(binDir, GREEN_ENV(logDir));
		expect(out).toContain("no drift, no open tracking issue");
		const calls = readGhCalls(logFile);
		expect(
			calls.some(
				(c) => c[0] === "issue" && (c[1] === "create" || c[1] === "close"),
			),
		).toBe(false);
	});

	// Acceptance #5, the genuinely discriminating case: every `gh` call in
	// this script already sits behind its OWN local try/catch (findTrackingIssue,
	// the create/edit/comment block, the close block), so a throwing `gh`
	// alone never reaches the OUTER try/catch around main() -- that test
	// below passes even with the outer try/catch deleted (proved by mutation
	// during this PR's own mutation-proofing pass). `writeBodyToTempFile`
	// (an `fs.mkdtempSync` under `os.tmpdir()`) is the one call in the
	// "file-or-refresh" path that ISN'T behind a local try/catch -- pointing
	// TMPDIR at a nonexistent directory forces exactly that failure, so only
	// the outer wrapper can save the exit code.
	it("acceptance #5: an uncaught internal throw (TMPDIR unwritable) still exits 0 on a red run", () => {
		const dir = mkTempDir("pi-lens-tool-smoke-tmpdir-");
		// #2723 review F5: main() calls findTrackingIssue() (a real `gh
		// issue list`) BEFORE writeBodyToTempFile() ever runs, so without a
		// stub on PATH this spawned a LIVE, authenticated `gh issue list`
		// against the real repo from inside a unit test (AGENTS.md: ordinary
		// tests are network-free) -- and once F1's retry-on-label-rejection
		// landed, would also have reached a real `gh issue view` on
		// whatever tracker currently exists. Stub it like every other case.
		const root = mkTempDir("pi-lens-tool-smoke-tmpdir-gh-");
		const { binDir } = stubGh(root, null);
		const result = spawnSync(process.execPath, [CLI], {
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				TMPDIR: "/nonexistent-dir-2723-xyz",
				...RED_ENV(dir),
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("unexpected error");
	});
});

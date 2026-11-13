#!/usr/bin/env node
/**
 * Lane 4 (#1605): exclusion-scope smoke -- would have caught #1562/#1574.
 *
 * gitleaks (and any directory-scanning runner) hands its `--source <dir>` to
 * the EXTERNAL binary, which walks the tree itself -- bypassing pi-lens's own
 * in-process walker exclusions entirely. #1562 was exactly this: a gitignored
 * pi-ecosystem scratch cache (`.pi/greedysearch-sources/`) got scanned and a
 * doc-example placeholder was served to the agent as a "leaked secret". #1574
 * fixed it with `clients/scratch-tree-policy.ts`'s narrow secrets-lane tier
 * (`SECRETS_LANE_SCRATCH_DIR_NAMES`) -- but every regression test for that fix
 * (`tests/clients/gitleaks-scratch-exclusion.test.ts`) drives
 * `classifyAndFilterFindings` directly against HAND-BUILT finding objects,
 * never a real gitleaks spawn over a real tree. This script is the seam
 * those unit tests can't cover: a real gitleaks binary, a real fixture repo
 * with a fake secret planted in a tracked file and another in a gitignored
 * scratch dir, and an assertion on what `GitleaksClient.scan()` actually
 * returns end to end.
 *
 * Fixture secrets are alternating-character placeholder strings shaped like
 * a GitHub Personal Access Token (`ghp_` + 36 chars, gitleaks's `github-pat`
 * rule) -- structurally valid enough to trip the real default ruleset
 * (gitleaks matches SHAPE, not content), but obviously synthetic
 * (`A1b2C3d4...`/`Z9y8X7w6...` counting patterns) and never issued by
 * GitHub. NOTE: a value containing the literal word "example" is silently
 * dropped by gitleaks's own default generic-placeholder allowlist -- verified
 * live; that ruled out the more common `AKIA...EXAMPLE`-style AWS doc
 * placeholders for this fixture.
 *
 * Usage: node scripts/smoke-gitleaks-scratch-exclusion.mjs
 * Exit codes: 0 pass (exactly the tracked hit surfaced, scratch demoted);
 * 1 an assertion failed (the #1562 defect shape reproduced); 2 infra failure
 * (gitleaks not on PATH, dist build missing).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const problems = [];
function assertEq(label, actual, expected) {
	if (actual !== expected) {
		problems.push(
			`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
		return;
	}
	console.log(`  [PASS] ${label} === ${JSON.stringify(expected)}`);
}
function assertTrue(label, cond, detail) {
	if (!cond) {
		problems.push(`${label}${detail ? `: ${detail}` : ""}`);
		return;
	}
	console.log(`  [PASS] ${label}`);
}

// A SECRETS_LANE_SCRATCH_DIR_NAMES entry (clients/scratch-tree-policy.ts) --
// the narrow tier gitleaks's generated allowlist + TS-side backstop both use.
const SCRATCH_REL = path.join(".pi-lens", "cache", "notes.md");
const TRACKED_REL = path.join("src", "config.ts");

function git(cwd, args) {
	gitExecFileSync(args, { cwd, stdio: "ignore" });
}

// The fixture project sits under a scratch-named ANCESTOR, Claude Code's own
// worktree layout: the scratch exclusion must judge paths below the scan root
// only, so every tracked finding here must still surface (#5500: the absolute
// `File` matched `.claude` and dropped them all, at gitleaks and in the TS
// backstop).
function buildFixtureRepo() {
	const base = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-gitleaks-smoke-"),
	);
	const cwd = path.join(base, ".claude", "worktrees", "smoke-lane");
	fs.mkdirSync(cwd, { recursive: true });
	git(cwd, ["init", "-q"]);
	git(cwd, ["config", "user.email", "smoke@pi-lens.test"]);
	git(cwd, ["config", "user.name", "pi-lens smoke"]);

	fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, TRACKED_REL),
		'export const token = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";\n',
	);
	fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi-lens/\n");
	git(cwd, ["add", "src/config.ts", ".gitignore"]);
	git(cwd, ["commit", "-q", "-m", "add tracked fixture secret"]);

	fs.mkdirSync(path.join(cwd, ".pi-lens", "cache"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, SCRATCH_REL),
		'cached research note: token = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"\n',
	);

	return { base, cwd };
}

function findGitleaks() {
	const finder = process.platform === "win32" ? "where" : "which";
	try {
		const res = execFileSync(finder, ["gitleaks"], { encoding: "utf8" });
		return res.split(/\r?\n/).find(Boolean) ?? null;
	} catch {
		return null;
	}
}

async function main() {
	const distEntry = path.join(
		repoRoot,
		"dist",
		"clients",
		"gitleaks-client.js",
	);
	const adapterEntry = path.join(
		repoRoot,
		"dist",
		"clients",
		"project-diagnostics",
		"runner-adapters",
		"gitleaks.js",
	);
	if (!fs.existsSync(distEntry) || !fs.existsSync(adapterEntry)) {
		console.error(
			`dist build missing under ${repoRoot}/dist -- run \`npm run build:dist\` first.`,
		);
		process.exit(2);
	}
	if (!findGitleaks()) {
		console.error(
			"INFRA FAILURE: gitleaks not found on PATH -- install it before running this lane.",
		);
		process.exit(2);
	}

	const { base, cwd } = buildFixtureRepo();
	try {
		const { GitleaksClient } = await import(pathToFileURL(distEntry).href);
		const { gitleaksFindingToProjectDiagnostic } = await import(
			pathToFileURL(adapterEntry).href
		);

		const client = new GitleaksClient();
		const result = await client.scan(cwd, { requireSignal: false });

		assertTrue(
			"scan succeeded",
			result.success === true,
			`summary: ${result.summary ?? "(none)"}`,
		);
		console.log(
			`  found ${result.findings.length} raw finding(s): ${result.findings.map((f) => `${f.file} [${f.pathStatus}]`).join(", ") || "(none)"}`,
		);

		// gitleaks's `File` field may be relative to `--source` OR absolute,
		// depending on version/platform -- normalize via path.relative so the
		// comparison holds either way.
		const relOf = (file) => {
			const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
			return path.relative(cwd, abs).replace(/\\/g, "/");
		};
		const tracked = result.findings.filter(
			(f) => relOf(f.file) === TRACKED_REL.replace(/\\/g, "/"),
		);
		const scratch = result.findings.filter(
			(f) => relOf(f.file) === SCRATCH_REL.replace(/\\/g, "/"),
		);

		assertTrue(
			"tracked fixture file was found by gitleaks",
			tracked.length >= 1,
			`no finding at ${TRACKED_REL}`,
		);
		if (tracked.length >= 1) {
			assertEq("tracked finding pathStatus", tracked[0].pathStatus, "tracked");
		}
		// The scratch secret must never surface as a visible/blocking finding.
		// The PRIMARY mechanism is `writeScopedGitleaksConfig`'s generated
		// `[allowlist] paths` regex, which stops gitleaks's own walk from
		// reporting it at all (0 raw findings here is the expected, healthy
		// case). `classifyAndFilterFindings`'s TS-side `pathStatus: "scratch"`
		// demotion is a documented BACKSTOP for when that generated regex ever
		// mismatches gitleaks's own path normalization -- so either shape is
		// acceptable, but a scratch finding surfacing with any OTHER
		// pathStatus (i.e. treated as a real, blocking leak) is the #1562
		// defect this lane exists to catch.
		if (scratch.length === 0) {
			console.log(
				`  [PASS] scratch fixture file excluded at the gitleaks source (0 raw findings at ${SCRATCH_REL})`,
			);
		} else {
			assertEq(
				"scratch finding demoted via the TS-side backstop",
				scratch[0].pathStatus,
				"scratch",
			);
		}

		// The lane's core assertion: among findings that could actually surface
		// as a blocking "leaked secret" alarm (pathStatus !== "scratch"),
		// EXACTLY the tracked hit -- the scratch one is demoted, never dropped
		// (#1562 review-round F2 observability requirement), so it must still
		// be PRESENT in `findings`, just never counted as visible/blocking.
		const visible = result.findings.filter((f) => f.pathStatus !== "scratch");
		assertEq("exactly one visible (non-scratch) finding", visible.length, 1);
		if (visible.length === 1) {
			assertEq(
				"the one visible finding is the tracked file",
				relOf(visible[0].file),
				TRACKED_REL.replace(/\\/g, "/"),
			);
		}

		if (tracked.length >= 1) {
			const diag = gitleaksFindingToProjectDiagnostic(cwd, tracked[0]);
			assertEq(
				"tracked finding surfaces as blocking",
				diag.semantic,
				"blocking",
			);
		}
		if (scratch.length >= 1) {
			const diag = gitleaksFindingToProjectDiagnostic(cwd, scratch[0]);
			assertEq(
				"scratch finding demoted to non-blocking",
				diag.semantic,
				"none",
			);
			assertEq(
				"scratch finding demoted to info severity",
				diag.severity,
				"info",
			);
		}
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}

	console.log(
		`\n${problems.length === 0 ? "EXCLUSION SCOPE VERIFIED (tracked visible, scratch demoted)" : "EXCLUSION SCOPE MISMATCH DETECTED"}`,
	);
	for (const p of problems) console.log(`  FAIL: ${p}`);
	process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("smoke-gitleaks-scratch-exclusion.mjs crashed:", err);
	process.exit(2);
});

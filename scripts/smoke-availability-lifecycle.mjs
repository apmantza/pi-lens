#!/usr/bin/env node
/**
 * Lane 2 (#1605): availability-lifecycle smoke -- the latch class
 * (#1490/#1494/#1495/#1496/#1537/#1535, #1556-F1).
 *
 * The arc's most recurrent shape: a transient failure gets recorded as
 * durable, latching a tool off for the rest of the session with no path
 * back. Every fix in that family was only ever proven with a MOCKED spawn
 * (`vi.fn()` on `safeSpawnAsync`); this script drives the same production
 * code path (`clients/zizmor-config.ts`'s `resolveZizmorGitHubToken`,
 * built on the shared `clients/dispatch/runners/utils/availability-policy.ts`
 * latch + `clients/degradation-ledger.ts`) against a REAL spawned process.
 *
 * Representative tool: the `gh auth token` probe zizmor's online-mode
 * resolver runs (#1535). Chosen over a plain "rename a linter binary"
 * scenario because a missing-binary ("missing"/"not-found") verdict is
 * DELIBERATELY session-durable by design (`isLatchingOutcome` -- see
 * `availability-policy.ts`) and only re-arms at `session_start`, not on a
 * cooldown; #1605's "restore -> advance past cooldown -> assert recovery"
 * wording describes a TRANSIENT verdict instead, and the gh-token probe's
 * timeout/host-stall path is exactly that: `classifyGhTokenFailure` keeps a
 * probe that never got a fair hearing as `transient`, which
 * `TRANSIENT_BASE_COOLDOWN_MS` (30s, capped at the module's own 120s
 * ceiling) genuinely expires.
 *
 * We never touch the real `gh` CLI. A FIXTURE `gh`/`gh.cmd` shim, written by
 * this script into a scratch directory prepended to PATH, shadows it only
 * for this process's children -- the system's real `gh` (if any) is
 * untouched. "Renaming a fixture-installed binary" from the binary's own
 * bin directory is exactly what phase 3 below does.
 *
 * Phases (one process -- the transient latch is meant to survive within a
 * process across a real cooldown, unlike lane 1's session-durable latches):
 *   1. Fixture `gh` HANGS past the probe budget -> `resolveZizmorGitHubToken()`
 *      times out -> assert transient/latched-false decision AND a degradation
 *      recorded via `incrementDegradationCount` (kind "zizmor-offline",
 *      subject "zizmor").
 *   2. Immediate second call, still inside the cooldown -> assert it is
 *      served from cache (no new probe) and the SAME degradation entry's
 *      count increments (recordDegradationOnce/incrementDegradationCount
 *      semantics: one visible ledger entry, an accumulating count) --
 *      never a second row.
 *   3. Restore: rename the fixture `gh` away and write a working one that
 *      answers instantly with a fake token. Poll past the real cooldown
 *      (read `TRANSIENT_BASE_COOLDOWN_MS` from the built module rather than
 *      hardcoding it, and keep polling instead of a single fixed sleep, so an
 *      exponential-ladder bump lengthens the wait instead of failing this
 *      phase as "recovery failed").
 *   4. Assert a GENUINE re-probe happened (the fixture token is returned, not
 *      the cached `undefined`) and the decision log shows a fresh
 *      `available`/`success` record with no new degradation.
 *   5. The OTHER latch half this lane's real subject is: a `missing`
 *      ("not-found") verdict is process-lifetime durable by design
 *      (`isLatchingOutcome`) and does NOT expire on any cooldown -- remove
 *      the fixture entirely and confirm the verdict latches, then RESTORE the
 *      fixture (without resetting the latch) and confirm a second call still
 *      returns `undefined` -- the binding check: gh being merely present
 *      again must not be what re-arms it. Only THEN call
 *      `resetZizmorTokenAvailability()` (the real `session_start` reset) and
 *      confirm that is what re-probes and recovers. (Asserting "still
 *      undefined" against an absent gh would be vacuous -- indistinguishable
 *      from a broken latch re-probing and independently getting the same
 *      missing answer.)
 *
 * Usage: node scripts/smoke-availability-lifecycle.mjs
 * Exit codes: 0 pass; 1 an assertion failed (the latch/cooldown defect this
 * lane exists to catch); 2 infra failure (dist build missing, can't write
 * the fixture).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scratchHomeEnv } from "./lib/scratch-home-env.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const isWindows = process.platform === "win32";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const problems = [];
function assertEq(label, actual, expected) {
	if (actual !== expected) {
		problems.push(
			`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
		return false;
	}
	console.log(`  [PASS] ${label} === ${JSON.stringify(expected)}`);
	return true;
}
function assertTrue(label, cond, detail) {
	if (!cond) {
		problems.push(`${label}${detail ? `: ${detail}` : ""}`);
		return false;
	}
	console.log(`  [PASS] ${label}`);
	return true;
}

function writeFixtureGh(binDir, mode) {
	const posixPath = path.join(binDir, "gh");
	const cmdPath = path.join(binDir, "gh.cmd");
	if (mode === "hang") {
		fs.writeFileSync(posixPath, "#!/bin/sh\nsleep 10\n");
		fs.writeFileSync(cmdPath, "@echo off\r\nping -n 11 127.0.0.1 >nul\r\n");
	} else if (mode === "ok") {
		fs.writeFileSync(posixPath, "#!/bin/sh\necho gh-fixture-token-recovered\n");
		fs.writeFileSync(
			cmdPath,
			"@echo off\r\necho gh-fixture-token-recovered\r\n",
		);
	} else {
		throw new Error(`unknown fixture mode ${mode}`);
	}
	if (!isWindows) fs.chmodSync(posixPath, 0o755);
}

/**
 * Every ambient system `gh` on PATH.
 *
 * #1651 review round 3: this used to take only the FIRST `which`/`where`
 * hit, on the assumption a host has at most one `gh` on PATH. GitHub-hosted
 * ubuntu-latest runners don't hold that assumption -- they carry a second,
 * independently-resolvable `gh` (observed at a location `which gh` doesn't
 * report first) alongside the apt-installed one `which` DOES report.
 * Excluding only the reported one left phase 5's "genuinely absent gh"
 * setup silently answering a REAL `gh auth token` call ("no oauth token
 * found for github.com", a real completed run, exit 1, no spawn error) --
 * that real, correctly-classified `non-installable` answer is what phase 5
 * was actually asserting against, not a missing binary at all. `which -a`
 * (POSIX) / `where` (Windows already lists every match) surfaces all of them.
 */
function findAllOnPath(binName) {
	const finder = process.platform === "win32" ? "where" : "which";
	const args = process.platform === "win32" ? [binName] : ["-a", binName];
	const res = spawnSync(finder, args, { encoding: "utf8" });
	if (res.status !== 0) return [];
	return res.stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
}

/** Symlink (falling back to a hardlink, then a copy, for filesystems/platforms
 * that reject symlinks without elevated privilege) `src` at `dest`. */
function shadowFile(src, dest) {
	try {
		fs.symlinkSync(src, dest);
		return;
	} catch {
		// fall through
	}
	try {
		fs.linkSync(src, dest);
		return;
	} catch {
		// fall through
	}
	try {
		fs.copyFileSync(src, dest);
	} catch {
		// Best-effort: one unreadable/unlinkable sibling (a broken symlink, a
		// permission-denied device node under /dev-adjacent dirs, ...) must not
		// abort the whole PATH setup over a tool this lane never calls.
	}
}

/**
 * A real PATH directory that (also) holds `gh`, reproduced as a SHADOW
 * directory that links every OTHER entry but omits `gh`/`gh.exe`/`gh.cmd`.
 *
 * #1651 review round 3 F1: excluding the WHOLE directory (this function's
 * predecessor) breaks any other tool that directory also carries --
 * GitHub-hosted ubuntu-latest keeps `getconf` in the very same `/usr/bin` a
 * second `gh` lives in, and stripping that directory silently took `getconf`
 * off PATH too (pi-lens's own resource sampler shells out to it, and the
 * "hang"/"ok" fixtures' own `#!/bin/sh` scripts need `/bin/sh` reachable).
 * Masking one file instead of a whole directory keeps everything else in
 * that directory exactly as discoverable as it was.
 */
function maskedGhDir(dir, maskRoot, index) {
	const shadowDir = path.join(maskRoot, `path-mask-${index}`);
	fs.mkdirSync(shadowDir, { recursive: true });
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch {
		// Directory vanished or is unreadable between `which` reporting it and
		// now -- an empty shadow dir is the safe (if inert) fallback.
		return shadowDir;
	}
	for (const name of entries) {
		if (name === "gh" || name === "gh.exe" || name === "gh.cmd") continue;
		shadowFile(path.join(dir, name), path.join(shadowDir, name));
	}
	return shadowDir;
}

/** Rebuild `fullPath` with every directory that holds one of `ghPaths`
 * replaced by its `maskedGhDir` shadow -- every other entry is untouched. */
function pathWithGhMasked(fullPath, ghPaths, maskRoot) {
	const ghDirs = new Set(ghPaths.map((p) => path.resolve(path.dirname(p))));
	const sep = path.delimiter;
	let maskIndex = 0;
	return fullPath
		.split(sep)
		.map((entry) => {
			const resolved = path.resolve(entry || ".");
			if (!ghDirs.has(resolved)) return entry;
			return maskedGhDir(resolved, maskRoot, maskIndex++);
		})
		.join(sep);
}

function removeFixtureGh(binDir) {
	for (const name of ["gh", "gh.cmd"]) {
		const p = path.join(binDir, name);
		if (fs.existsSync(p)) fs.unlinkSync(p);
	}
}

const FLUSH_TIMEOUT_MS = 10_000;

async function readDecisions(scratch, tool, flush) {
	// latency.log writes go through an async queue (`createNdjsonLogger`) --
	// flush it first so a read immediately after an `await` doesn't race a
	// still-pending write and miss (or misorder) the decision it just made.
	// Bounded: an unbounded await here would let a wedged writer hang this
	// script all the way to the CI job timeout instead of failing legibly.
	await Promise.race([
		flush(),
		sleep(FLUSH_TIMEOUT_MS).then(() => {
			throw new Error(
				`flushLatencyLog() did not settle within ${FLUSH_TIMEOUT_MS}ms`,
			);
		}),
	]);
	const latencyLogPath = path.join(scratch, "latency.log");
	if (!fs.existsSync(latencyLogPath)) return [];
	return fs
		.readFileSync(latencyLogPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(
			(e) =>
				e && e.phase === "availability_decision" && e.metadata?.tool === tool,
		);
}

async function main() {
	const distEntry = path.join(repoRoot, "dist", "clients", "zizmor-config.js");
	const ledgerEntry = path.join(
		repoRoot,
		"dist",
		"clients",
		"degradation-ledger.js",
	);
	if (!fs.existsSync(distEntry) || !fs.existsSync(ledgerEntry)) {
		console.error(
			`dist build missing under ${repoRoot}/dist -- run \`npm run build:dist\` first.`,
		);
		process.exit(2);
	}

	const scratch = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-smoke-avail-"),
	);
	const binDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-smoke-avail-bin-"),
	);
	const maskRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-smoke-avail-mask-"),
	);
	Object.assign(process.env, scratchHomeEnv(scratch));
	// Mask every REAL system `gh` (GitHub-hosted runners can ship more than
	// one on PATH -- see `findAllOnPath`'s doc comment, #1651 round 3), don't
	// strip PATH down to just the fixture dir -- phase 5 removes the fixture
	// to reproduce a genuinely-absent `gh` (ENOENT), and a bare "prepend the
	// fixture dir" would silently fall through to a real system `gh` the
	// moment the fixture is deleted (exactly the "never touch the real gh
	// CLI" contract this lane promises). `pathWithGhMasked` only omits `gh`
	// itself from each affected directory (round 3 F1) -- unlike excluding
	// the whole directory, every OTHER tool that directory also carries
	// (`getconf`, `sh`, ...) stays exactly as reachable as it was.
	const realGhPaths = findAllOnPath("gh");
	const pathWithGhHidden = realGhPaths.length
		? pathWithGhMasked(process.env.PATH ?? "", realGhPaths, maskRoot)
		: (process.env.PATH ?? "");
	process.env.PATH = `${binDir}${path.delimiter}${pathWithGhHidden}`;
	// Never let a real ambient token short-circuit the fixture probe.
	delete process.env.GH_TOKEN;
	delete process.env.GITHUB_TOKEN;
	delete process.env.ZIZMOR_GITHUB_TOKEN;

	try {
		const { resolveZizmorGitHubToken, resetZizmorTokenAvailability } =
			await import(pathToFileURL(distEntry).href);
		const { getDegradationSummary } = await import(
			pathToFileURL(ledgerEntry).href
		);
		const { flushLatencyLog } = await import(
			pathToFileURL(path.join(repoRoot, "dist", "clients", "latency-logger.js"))
				.href
		);
		const { resetSafeSpawnWindowsCommandCache } = await import(
			pathToFileURL(path.join(repoRoot, "dist", "clients", "safe-spawn.js"))
				.href
		);
		const { TRANSIENT_BASE_COOLDOWN_MS } = await import(
			pathToFileURL(
				path.join(
					repoRoot,
					"dist",
					"clients",
					"dispatch",
					"runners",
					"utils",
					"availability-policy.js",
				),
			).href
		);
		resetZizmorTokenAvailability();

		console.log("phase 1: fixture gh hangs past the probe budget");
		writeFixtureGh(binDir, "hang");
		const t1 = await resolveZizmorGitHubToken();
		assertEq("phase1 token", t1, undefined);
		const d1 = (
			await readDecisions(scratch, "zizmor-gh-token", flushLatencyLog)
		).at(-1);
		assertTrue(
			"phase1 decision recorded",
			!!d1,
			"no availability_decision for zizmor-gh-token",
		);
		if (d1) {
			assertEq("phase1 decision.outcome", d1.metadata.outcome, "transient");
			assertEq("phase1 decision.latched", d1.metadata.latched, false);
		}
		let summary = getDegradationSummary();
		let group = summary.find((g) => g.kind === "zizmor-offline");
		assertTrue(
			"phase1 degradation group exists",
			!!group,
			"no zizmor-offline group in the ledger",
		);
		if (group) {
			assertEq("phase1 degradation count", group.count, 1);
			assertTrue(
				"phase1 degradation subject is zizmor",
				group.latestReasons.some((r) => r.subject === "zizmor"),
			);
		}

		console.log("\nphase 2: immediate re-call inside the cooldown (cache hit)");
		const t2 = await resolveZizmorGitHubToken();
		assertEq("phase2 token (still cached-unavailable)", t2, undefined);
		summary = getDegradationSummary();
		group = summary.find((g) => g.kind === "zizmor-offline");
		assertTrue("phase2 degradation group still exists", !!group);
		if (group) {
			// recordDegradationOnce/incrementDegradationCount semantics: ONE
			// ledger entry (never a duplicate row), an ACCUMULATING count.
			assertEq(
				"phase2 degradation entry count (one visible row)",
				group.latestReasons.length,
				1,
			);
			assertEq("phase2 degradation tally", group.count, 2);
		}

		console.log("\nphase 3: restore the fixture");
		removeFixtureGh(binDir);
		writeFixtureGh(binDir, "ok");

		console.log("phase 4: poll past the real cooldown for a genuine re-probe");
		// `retryAtMs` is set INSIDE `noteUnavailable`, which only runs AFTER
		// phase 1's probe already failed -- the cooldown window starts counting
		// from THAT moment, not from when the probe began. So the real margin
		// here is the cooldown itself plus a couple of seconds, not "cooldown
		// minus however long the probe took" (that reasoning is backwards and
		// was this comment's own former bug). Poll rather than a single fixed
		// sleep so an exponential-ladder bump (attempts > 1 would double the
		// wait) lengthens this loop instead of failing the phase as "recovery
		// failed" -- bounded at 4x the base cooldown, matching the module's own
		// ZIZMOR_TOKEN_MAX_COOLDOWN_MS (120s) ceiling.
		// V2: capture the degradation count at the TOP of each iteration, not
		// after the loop exits -- reading it only once, after a successful call
		// already happened, would silently absorb a spurious degradation the
		// successful call itself recorded into the "before" baseline, making
		// the later "added nothing" comparison vacuous. Capturing per-iteration
		// isolates exactly the call that succeeded.
		const pollDeadlineMs = Date.now() + TRANSIENT_BASE_COOLDOWN_MS * 4;
		let t3;
		let countBeforeSuccess;
		do {
			summary = getDegradationSummary();
			group = summary.find((g) => g.kind === "zizmor-offline");
			countBeforeSuccess = group?.count ?? 0;
			t3 = await resolveZizmorGitHubToken();
			if (t3 !== undefined) break;
			await sleep(2000);
		} while (Date.now() < pollDeadlineMs);
		assertEq(
			"phase4 token (real re-probe recovered)",
			t3,
			"gh-fixture-token-recovered",
		);
		const d4 = (
			await readDecisions(scratch, "zizmor-gh-token", flushLatencyLog)
		).at(-1);
		assertTrue(
			"phase4 decision recorded",
			!!d4,
			"no fresh availability_decision after recovery",
		);
		if (d4) {
			assertEq("phase4 decision.verdict", d4.metadata.verdict, "available");
			assertEq("phase4 decision.outcome", d4.metadata.outcome, "success");
		}
		assertTrue(
			"phase4 degradation count reached recovery with at least phase 1+2's 2",
			countBeforeSuccess >= 2,
			`count before the successful call: ${countBeforeSuccess}`,
		);
		summary = getDegradationSummary();
		group = summary.find((g) => g.kind === "zizmor-offline");
		assertEq(
			"phase4 the successful re-probe call itself added no degradation",
			group?.count ?? 0,
			countBeforeSuccess,
		);

		console.log(
			"\nphase 5: the OTHER latch half -- a missing verdict is process-lifetime durable, not cooldown-bound",
		);
		// Phase 4 left the latch genuinely `available` -- that answer is cached
		// FOREVER by design (no cooldown ever applies to a success), so it would
		// keep being served even with the fixture removed. Start this phase's
		// own fresh "session" so `missing` is being tested from a clean latch,
		// not fighting phase 4's cached good answer.
		resetZizmorTokenAvailability();
		removeFixtureGh(binDir);
		const t5a = await resolveZizmorGitHubToken();
		assertEq("phase5 token (gh genuinely absent)", t5a, undefined);
		const d5a = (
			await readDecisions(scratch, "zizmor-gh-token", flushLatencyLog)
		).at(-1);
		assertTrue(
			"phase5 decision recorded",
			!!d5a,
			"no availability_decision for the missing-gh probe",
		);
		if (d5a) {
			assertEq("phase5 decision.outcome", d5a.metadata.outcome, "missing");
			assertEq("phase5 decision.latched", d5a.metadata.latched, true);
		}
		// V1: restore the fixture BEFORE the second call, without resetting the
		// latch. Calling again with gh STILL missing would return `undefined`
		// either way -- whether the latch genuinely held, or it re-probed an
		// absent gh and got the same missing answer independently -- so that
		// assertion alone is vacuous (a deleted durable-latch guard in
		// `availability-policy.ts` would read identically). Restoring gh first
		// makes this the BINDING check: if the latch is not durable, this call
		// re-probes, finds the now-working fixture, and returns the recovered
		// token -- turning the assertion red. `resetSafeSpawnWindowsCommandCache()`
		// clears safe-spawn's OWN Windows PATH/PATHEXT cache so a stale "not
		// found" there can't be mistaken for the zizmor latch holding.
		writeFixtureGh(binDir, "ok");
		resetSafeSpawnWindowsCommandCache();
		const t5b = await resolveZizmorGitHubToken();
		assertEq(
			"phase5 latch holds even after gh comes back (no reset yet)",
			t5b,
			undefined,
		);

		// Only the real session_start reset re-arms it -- never gh's own
		// return, and never elapsed time. A real session_start fires MULTIPLE
		// resets together (`clients/runtime-session.ts`); besides the zizmor
		// latch itself, `resetSafeSpawnWindowsCommandCache` is wired into the
		// same `handleSessionStart` call.
		resetZizmorTokenAvailability();
		const t5c = await resolveZizmorGitHubToken();
		assertEq(
			"phase5 resetZizmorTokenAvailability() re-probes and recovers",
			t5c,
			"gh-fixture-token-recovered",
		);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(binDir, { recursive: true, force: true });
		fs.rmSync(maskRoot, { recursive: true, force: true });
	}

	console.log(
		`\n${problems.length === 0 ? "AVAILABILITY LIFECYCLE VERIFIED (latch + degradation + real recovery)" : "AVAILABILITY LIFECYCLE MISMATCH DETECTED"}`,
	);
	for (const p of problems) console.log(`  FAIL: ${p}`);
	process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("smoke-availability-lifecycle.mjs crashed:", err);
	process.exit(2);
});

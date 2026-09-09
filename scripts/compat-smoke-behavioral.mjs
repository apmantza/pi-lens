#!/usr/bin/env node
/**
 * Layer B: real-pi behavioral smoke (#476).
 *
 * Layer A (compat-contracts.mjs) verifies the third-party SOURCE still has
 * the shape we depend on. This layer goes one step further: it installs the
 * PUBLISHED pi-lens tarball into a real `pi`, the way `install-smoke.yml`'s
 * `pi-load` job does, and drives it through the RPC mode (`--mode rpc`) so
 * `session_start` fires and `get_commands` proves the extension loaded —
 * all without an LLM turn, hence no model API key needed.
 *
 * On top of that base (which install-smoke.yml already covers), this script
 * asserts pi-lens's OWN observability (the latency log) reacted correctly to
 * the subagent-compat env levers, and that no LSP server process survives
 * after pi exits cleanly (the #472 orphan class #474 fixed).
 *
 * IMPORTANT — forcing full startup mode: pi-lens's cold-start-quick
 * optimization (see AGENTS.md "Session-start critical path") forces the
 * FIRST session_start of any process to the fast "quick" path regardless of
 * `--print`, which returns before the subagent-light-mode check even runs
 * (verified empirically against a locally packed tarball — see
 * docs/subagent-compat.md). Every pi invocation here sets
 * `PI_LENS_STARTUP_MODE=full` so the assertions are deterministic.
 *
 * Assertions run (each independently, all continue-on-error at the workflow
 * level — see docs/subagent-compat.md):
 *   1. PI_SUBAGENT_CHILD=1 -> `subagent_light_mode` phase logged, no
 *      heavyweight-scan phase (knip/jscpd/madge/dead_code/govulncheck/
 *      gitleaks/trivy) logged (#475).
 *   2. PI_SUBAGENT_CHILD=1 + PI_LENS_SUBAGENT_FULL=1 -> NO
 *      `subagent_light_mode` phase logged (override path).
 *   3. After each pi exit (graceful RPC shutdown, not SIGKILL): zero
 *      surviving LSP-server child processes that were not already running
 *      before the smoke started (#472 orphan class, #474's fix).
 *   4. avtc-pi-subagent PAIR only (PI_SUBAGENT_CHILD_AGENT +
 *      PI_SUBAGENT_PARENT_PID, no PI_SUBAGENT_CHILD) -> `subagent_light_mode`
 *      phase logged, no heavyweight-scan phase logged — the same detection
 *      as assertion 1, exercised through the second vocabulary (#507/#518).
 *   5. avtc-pi-subagent LONE var (only PI_SUBAGENT_CHILD_AGENT set, no
 *      PI_SUBAGENT_PARENT_PID) -> the inverse guard: NO
 *      `subagent_light_mode` phase logged. `subagent-mode.ts`'s doc comment
 *      requires the PAIR — a lone var set by some unrelated tool must not
 *      trigger light mode (#507/#518).
 *   6. concurrent_session_bind (#473's in-process guard) and its #2249
 *      session-end summary concurrent_session_bind_rollup — NOT asserted.
 *      The guard IS fully wired on master (PR #477: `decideSessionStart` is
 *      called from `index.ts`'s `session_start` handler), so both phases
 *      exist — but OBSERVING either requires reproducing tintinweb's
 *      in-process model for real (a second `createAgentSession()` +
 *      `bindExtensions()` in the same process), and session construction
 *      needs model/provider config that can't cheaply be stubbed without a
 *      real key. #476 explicitly asks not to ship something flaky here.
 *      Documented as a TODO in docs/subagent-compat.md; revisit if the SDK
 *      grows a model-free session constructor or a stub provider.
 *
 * Usage: node scripts/compat-smoke-behavioral.mjs [--keep] [--tarball <path>]
 *   --keep            don't delete the scratch project/install dirs
 *   --tarball <path>  install this pi-lens tarball instead of `npm pack`-ing
 *                      the current repo (CI passes the just-packed tarball)
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	evaluateNoSurvivingLspProcesses,
	snapshotProcesses,
} from "./lib/process-scan.mjs";
import {
	noPhasesLogged,
	parseNdjsonEntries,
	phaseWasLogged,
	countEntriesSince,
} from "./lib/latency-log-phases.mjs";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";

const isWindows = process.platform === "win32";
const HEAVYWEIGHT_SCAN_PHASES = [
	"knip",
	"jscpd",
	"madge",
	"dead-code",
	"govulncheck",
	"gitleaks",
	"trivy",
];

function parseArgs(argv) {
	const opts = { keep: false, tarball: undefined };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--keep") opts.keep = true;
		else if (argv[i] === "--tarball") opts.tarball = argv[++i];
	}
	return opts;
}

function packTarball(repoRoot) {
	const out = execFileSync("npm", ["pack", "--silent"], {
		cwd: repoRoot,
		encoding: "utf8",
		shell: isWindows,
	});
	const name = out.trim().split(/\r?\n/).pop();
	return path.join(repoRoot, name);
}

function setUpFixtureProject(dir) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "a.ts"), "export const x: number = 1;\n");
	fs.writeFileSync(
		path.join(dir, "package.json"),
		'{ "name": "d", "version": "1.0.0", "type": "module" }\n',
	);
	gitExecFileSync(["init", "-q"], { cwd: dir });
	gitExecFileSync(["config", "user.email", "t@t.t"], { cwd: dir });
	gitExecFileSync(["config", "user.name", "t"], { cwd: dir });
	gitExecFileSync(["add", "-A"], { cwd: dir });
	gitExecFileSync(["commit", "-qm", "init"], { cwd: dir });
}

function installPiLens(projectDir, tarball) {
	execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
		cwd: projectDir,
		stdio: "inherit",
		shell: isWindows,
	});
	return path.join(projectDir, "node_modules", "pi-lens", "dist", "index.js");
}

function resolvePiBin() {
	// Mirrors install-smoke.yml's pi-load job: pi is expected to already be on
	// PATH (npm/pnpm/bun-global or the curl installer ran earlier in the
	// workflow). Locally, whatever `pi` resolves to is used as-is.
	return isWindows ? "pi.cmd" : "pi";
}

/**
 * Drive one headless `pi --mode rpc` invocation with the given extra env,
 * waiting for `get_commands` to confirm pi-lens loaded, then closing stdin
 * so pi's own graceful shutdown path runs (NOT SIGKILL — a hard kill skips
 * pi-lens's session_shutdown LSP teardown, which would make assertion 3
 * meaningless). Resolves with `{ commandCount, timedOut }`.
 */
function runPiRpc({
	piBin,
	extensionPath,
	cwd,
	env,
	logHome,
	timeoutMs = 45000,
}) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			piBin,
			[
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--extension",
				extensionPath,
			],
			{
				cwd,
				shell: isWindows,
				stdio: ["pipe", "pipe", "inherit"],
				env: {
					...process.env,
					PI_LENS_HOME: logHome,
					...env,
					ANTHROPIC_API_KEY:
						process.env.ANTHROPIC_API_KEY || "sk-ant-dummy-compat-smoke",
				},
			},
		);

		let buf = "";
		let settled = false;
		let commandCount = -1;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				child.kill("SIGKILL");
			} catch {}
			reject(new Error("TIMEOUT waiting for pi RPC session"));
		}, timeoutMs);

		function finish() {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ commandCount });
		}

		function handleLine(line) {
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (msg.type === "response" && msg.command === "get_commands") {
				const cmds = (msg.data && msg.data.commands) || [];
				commandCount = cmds.length;
				// Close stdin -> pi's RPC mode treats stdin "end" as a shutdown
				// trigger and runs its normal teardown path (session_shutdown
				// fires, pi-lens tears down its LSP fleet) before exiting.
				try {
					child.stdin.end();
				} catch {}
			}
		}

		child.stdout.on("data", (chunk) => {
			buf += chunk.toString();
			let i = buf.indexOf("\n");
			while (i >= 0) {
				const line = buf.slice(0, i).replace(/\r$/, "");
				buf = buf.slice(i + 1);
				if (line.trim()) handleLine(line);
				i = buf.indexOf("\n");
			}
		});

		child.on("exit", () => finish());
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});

		// Give extensions a moment to register before asking for the command list.
		setTimeout(() => {
			try {
				child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
			} catch {}
		}, 3000);
	});
}

// --- Process snapshot (Windows CIM / POSIX ps), narrow LSP markers only ---
//
// The listing itself is scripts/lib/process-scan.mjs (PR #2438 review round
// 3, F2). This script asks only for pid + command: it diffs two snapshots by
// pid and matches LSP markers on the command line, and has no use for a
// parent pid.

function snapshotLspCandidates() {
	return snapshotProcesses(["pid", "command"]);
}

// The log is read from the PI_LENS_HOME pin every `pi` invocation below
// runs under — never from the real `~/.pi-lens`. Since #2534 (#2506) the
// global dir of any process whose cwd is under `os.tmpdir()` is redirected to
// a per-project probe home, and this smoke's fixture project lives exactly
// there; reading the real home returned an empty log and the two
// absence-of-phase assertions passed vacuously (#2570).
function readLatencyLogEntries(logHome) {
	const logPath = path.join(logHome, "latency.log");
	try {
		return parseNdjsonEntries(fs.readFileSync(logPath, "utf8"));
	} catch {
		return [];
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const repoRoot = path.resolve(
		path.dirname(
			new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		),
		"..",
	);
	const scratchRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-compat-smoke-behavioral-"),
	);
	const piBin = resolvePiBin();

	const results = [];
	let infraFailure = null;
	let tarball;

	try {
		tarball = opts.tarball ?? packTarball(repoRoot);
	} catch (err) {
		infraFailure = `npm pack failed: ${err instanceof Error ? err.message : err}`;
	}

	if (infraFailure) {
		console.error(`INFRA FAILURE: ${infraFailure}`);
		process.exit(2);
	}

	const projectDir = path.join(scratchRoot, "proj");
	setUpFixtureProject(projectDir);
	// Pin the global dir for every child `pi` so the latency log lands where
	// `readLatencyLogEntries` reads it (same pattern as the other smokes).
	const logHome = path.join(scratchRoot, "pi-lens-home");
	fs.mkdirSync(logHome, { recursive: true });

	let extensionPath;
	try {
		extensionPath = installPiLens(projectDir, tarball);
		if (!fs.existsSync(extensionPath)) {
			throw new Error(`extension entry not found at ${extensionPath}`);
		}
	} catch (err) {
		console.error(
			`INFRA FAILURE: could not install pi-lens tarball: ${err instanceof Error ? err.message : err}`,
		);
		if (!opts.keep) {
			try {
				fs.rmSync(scratchRoot, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 200,
				});
			} catch (cleanupErr) {
				console.warn(
					`cleanup warning: could not remove ${scratchRoot}: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`,
				);
			}
		}
		process.exit(2);
	}

	// --- Assertion 1: subagent light mode engages under PI_SUBAGENT_CHILD=1 ---
	{
		const sinceIso = new Date().toISOString();
		try {
			await runPiRpc({
				piBin,
				extensionPath,
				cwd: projectDir,
				logHome,
				env: { PI_SUBAGENT_CHILD: "1", PI_LENS_STARTUP_MODE: "full" },
			});
			const entries = readLatencyLogEntries(logHome);
			const lightModeLogged = phaseWasLogged(
				entries,
				"subagent_light_mode",
				sinceIso,
			);
			const heavyweightSkipped = noPhasesLogged(
				entries,
				HEAVYWEIGHT_SCAN_PHASES,
				sinceIso,
			);
			const logged = countEntriesSince(entries, sinceIso);
			results.push({
				id: "subagent-light-mode-engages",
				pass: logged > 0 && lightModeLogged && heavyweightSkipped,
				detail: `entries since run=${logged}, subagent_light_mode logged=${lightModeLogged}, heavyweight scans absent=${heavyweightSkipped}`,
			});
		} catch (err) {
			results.push({
				id: "subagent-light-mode-engages",
				pass: false,
				detail: `pi invocation failed: ${err instanceof Error ? err.message : err}`,
			});
		}
	}

	// --- Assertion 2: PI_LENS_SUBAGENT_FULL=1 overrides light mode off ---
	{
		const sinceIso = new Date().toISOString();
		try {
			await runPiRpc({
				piBin,
				extensionPath,
				cwd: projectDir,
				logHome,
				env: {
					PI_SUBAGENT_CHILD: "1",
					PI_LENS_SUBAGENT_FULL: "1",
					PI_LENS_STARTUP_MODE: "full",
				},
			});
			const entries = readLatencyLogEntries(logHome);
			const lightModeAbsent = !phaseWasLogged(
				entries,
				"subagent_light_mode",
				sinceIso,
			);
			results.push({
				id: "subagent-full-override",
				pass: lightModeAbsent,
				detail: `subagent_light_mode absent under PI_LENS_SUBAGENT_FULL=1: ${lightModeAbsent}`,
			});
		} catch (err) {
			results.push({
				id: "subagent-full-override",
				pass: false,
				detail: `pi invocation failed: ${err instanceof Error ? err.message : err}`,
			});
		}
	}

	// --- Assertion 3: zero surviving LSP-server processes after clean exit ---
	{
		try {
			const before = await snapshotLspCandidates();
			await runPiRpc({
				piBin,
				extensionPath,
				cwd: projectDir,
				logHome,
				env: { PI_LENS_STARTUP_MODE: "full" },
			});
			// Grace period: pi's own teardown (session_shutdown -> LSP fast
			// teardown -> child SIGTERM) is async and completes shortly after
			// the parent process exits, not synchronously with it (verified
			// empirically — see docs/subagent-compat.md).
			await new Promise((r) => setTimeout(r, 3000));
			const after = await snapshotLspCandidates();
			results.push(evaluateNoSurvivingLspProcesses(before, after));
		} catch (err) {
			results.push({
				id: "no-surviving-lsp-processes",
				pass: false,
				detail: `pi invocation failed: ${err instanceof Error ? err.message : err}`,
			});
		}
	}

	// --- Assertion 4: avtc-pi-subagent PAIR engages light mode (#507/#518) ---
	{
		const sinceIso = new Date().toISOString();
		try {
			await runPiRpc({
				piBin,
				extensionPath,
				cwd: projectDir,
				logHome,
				env: {
					PI_SUBAGENT_CHILD_AGENT: "compat-smoke-worker",
					PI_SUBAGENT_PARENT_PID: "4242",
					PI_LENS_STARTUP_MODE: "full",
				},
			});
			const entries = readLatencyLogEntries(logHome);
			const lightModeLogged = phaseWasLogged(
				entries,
				"subagent_light_mode",
				sinceIso,
			);
			const heavyweightSkipped = noPhasesLogged(
				entries,
				HEAVYWEIGHT_SCAN_PHASES,
				sinceIso,
			);
			const logged = countEntriesSince(entries, sinceIso);
			results.push({
				id: "avtc-pair-engages-light-mode",
				pass: logged > 0 && lightModeLogged && heavyweightSkipped,
				detail: `entries since run=${logged}, subagent_light_mode logged=${lightModeLogged}, heavyweight scans absent=${heavyweightSkipped}`,
			});
		} catch (err) {
			results.push({
				id: "avtc-pair-engages-light-mode",
				pass: false,
				detail: `pi invocation failed: ${err instanceof Error ? err.message : err}`,
			});
		}
	}

	// --- Assertion 5: avtc-pi-subagent LONE var must NOT engage light mode
	// (the inverse guard subagent-mode.ts's doc comment calls out — #507/#518) ---
	{
		const sinceIso = new Date().toISOString();
		try {
			await runPiRpc({
				piBin,
				extensionPath,
				cwd: projectDir,
				logHome,
				env: {
					PI_SUBAGENT_CHILD_AGENT: "compat-smoke-worker",
					PI_LENS_STARTUP_MODE: "full",
				},
			});
			const entries = readLatencyLogEntries(logHome);
			const lightModeAbsent = !phaseWasLogged(
				entries,
				"subagent_light_mode",
				sinceIso,
			);
			results.push({
				id: "avtc-lone-var-does-not-engage-light-mode",
				pass: lightModeAbsent,
				detail: `subagent_light_mode absent with only PI_SUBAGENT_CHILD_AGENT set (no PI_SUBAGENT_PARENT_PID): ${lightModeAbsent}`,
			});
		} catch (err) {
			results.push({
				id: "avtc-lone-var-does-not-engage-light-mode",
				pass: false,
				detail: `pi invocation failed: ${err instanceof Error ? err.message : err}`,
			});
		}
	}

	// --- Assertion 6 (concurrent_session_bind + concurrent_session_bind_rollup,
	// #473 / #2249) — documented TODO ---
	results.push({
		id: "concurrent-session-bind-in-process",
		pass: true,
		skipped: true,
		detail:
			"NOT ASSERTED — decideSessionStart() (clients/session-lifecycle.ts) IS wired " +
			"into index.ts's session_start handler, so both the per-bind " +
			"concurrent_session_bind phase and #2249's session-end " +
			"concurrent_session_bind_rollup phase exist to observe. Reproducing " +
			"tintinweb's in-process bindExtensions() model needs a full " +
			"createAgentSession() + model config that isn't cheaply stubbable without a " +
			"real model key. See docs/subagent-compat.md.",
	});

	console.log("\nbehavioral smoke assertions:");
	for (const r of results) {
		const label = r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL";
		console.log(`  [${label}] ${r.id}`);
		console.log(`         ${r.detail}`);
	}

	const failed = results.filter((r) => !r.skipped && !r.pass);
	console.log(
		`\n${failed.length === 0 ? "ALL ASSERTIONS PASSED" : `${failed.length} ASSERTION(S) FAILED`}`,
	);
	const exitCode = failed.length === 0 ? 0 : 1;

	// Cleanup runs after results are reported so a cleanup crash (e.g. an
	// ENOTEMPTY race with a just-exited pi child still releasing files)
	// can never discard already-collected assertion results or flip the
	// exit code (#785).
	if (!opts.keep) {
		try {
			fs.rmSync(scratchRoot, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		} catch (err) {
			console.warn(
				`cleanup warning: could not remove ${scratchRoot}: ${err instanceof Error ? err.message : err}`,
			);
		}
		try {
			fs.rmSync(tarball, { force: true, maxRetries: 5, retryDelay: 200 });
		} catch (err) {
			console.warn(
				`cleanup warning: could not remove ${tarball}: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	process.exit(exitCode);
}

main().catch((err) => {
	console.error("compat-smoke-behavioral.mjs crashed:", err);
	process.exit(2);
});

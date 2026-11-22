// flake-shape: real-process-spawn — the regression is a detached safeSpawnAsync child surviving a SIGKILLed real pi host and being reaped by the next real pi host.
// flake-shape: raw-timer-wait — host and runner death are only observable through their real pid transitions; each poll is bounded by waitFor's real-clock deadline.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { realIsPidAlive } from "../../clients/pid-liveness.js";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
} from "../../scripts/lib/scratch-dir.mjs";
import { removeTempDirSync } from "../clients/test-utils.js";
import { adoptProcessTree } from "../support/kill-guard.js";
import { createRealPiProject, withRealPi } from "../support/real-pi-harness.js";

const FIXTURE = "lsp-host-exit";
const EXTENSION = fileURLToPath(
	new URL(
		"../fixtures/real-harness/runner-host-exit-5703-extension.mjs",
		import.meta.url,
	),
);
const RUNNER_SERVER_ID = "safe-spawn:real-harness-runner-5703";
const REAP_WAIT_MS = 30_000;
const dirs: string[] = [];
const childPids: number[] = [];

afterEach(() => {
	for (const pid of childPids.splice(0)) {
		if (!realIsPidAlive(pid)) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

/**
 * Start one runner through the fixture command and return its pid. The pid
 * file is removed first: every runner writes the same file, so a leftover
 * from the previous runner would answer for this one (#5745 r4, F2: the
 * normal-exit check read the reaped runner's pid and passed with removal
 * disabled).
 */
async function startRunner(
	pi: { prompt(message: string): Promise<unknown> },
	pidFile: string,
): Promise<number> {
	fs.rmSync(pidFile, { force: true });
	await pi.prompt("/real-harness-runner-5703");
	const deadline = Date.now() + REAP_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			const pid = Number(fs.readFileSync(pidFile, "utf8"));
			if (pid > 0) return pid;
		} catch {
			// child has not reached its first instruction yet
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("timed out waiting for safeSpawnAsync runner pid");
}

async function waitGone(pid: number): Promise<void> {
	const deadline = Date.now() + REAP_WAIT_MS;
	while (Date.now() < deadline) {
		if (!realIsPidAlive(pid)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`runner child ${pid} remained alive`);
}

/** The pid of the host whose `instances.json` entry holds the runner's row. */
function rowOwner(home: string, child: number): number | undefined {
	const file = JSON.parse(
		fs.readFileSync(path.join(home, "instances.json"), "utf8"),
	) as {
		instances: Array<{
			pid: number;
			lspChildren?: Array<{ pid: number; serverId?: string }>;
		}>;
	};
	return file.instances.find((instance) =>
		instance.lspChildren?.some(
			(row) => row.pid === child && row.serverId === RUNNER_SERVER_ID,
		),
	)?.pid;
}

describe.runIf(process.platform === "linux")(
	"a SIGKILLed pi host's safeSpawnAsync child is reaped by the next pi host (#5703)",
	() => {
		it("records, survives host death, then reaps the runner at session start", async () => {
			const home = claimScratchDir(
				SCRATCH_DIR_ROOT,
				"runner-host-exit-5703-home",
			);
			const project = createRealPiProject(FIXTURE, home);
			const pidFile = path.join(home, "runner.pid");
			const ownerFile = path.join(home, "runner.owner");
			const releaseFile = path.join(home, "runner.release");
			dirs.push(home, project);
			const env = {
				REAL_HARNESS_RUNNER_PID_FILE: pidFile,
				REAL_HARNESS_RUNNER_OWNER_FILE: ownerFile,
				REAL_HARNESS_RUNNER_RELEASE_FILE: releaseFile,
				PI_LENS_TEST_MODE: "0",
			};
			const first = await withRealPi(
				{
					fixture: FIXTURE,
					script: "script.json",
					home,
					project,
					env,
					extensions: [EXTENSION],
				},
				async (pi) => {
					const runner = await startRunner(pi, pidFile);
					const ownerTag = fs.readFileSync(ownerFile, "utf8");
					expect(ownerTag).toMatch(/^\d+:\d+@[0-9a-f-]{36}$/);
					let host: number | undefined;
					const ledgerDeadline = Date.now() + REAP_WAIT_MS;
					while (host === undefined && Date.now() < ledgerDeadline) {
						host = rowOwner(home, runner);
						if (host === undefined)
							await new Promise<void>((resolve) => setTimeout(resolve, 50));
					}
					if (host === undefined)
						throw new Error("runner ledger row never landed");
					adoptProcessTree(host, [runner]);
					childPids.push(runner);
					process.kill(host, "SIGKILL");
					// Observe the host's exit before the harness tears down. Teardown
					// tree-kills a child it has not seen exit, and while the kernel
					// is still tearing the SIGKILLed host down its `ps` walk lists the
					// runner as the host's child and kills it too (#5745 r4, F3).
					await pi.quit();
					return { runner };
				},
			);
			await expect
				.poll(() => realIsPidAlive(first.runner), { timeout: 2_000 })
				.toBe(true);

			await withRealPi(
				{
					fixture: FIXTURE,
					script: "script.json",
					home,
					project,
					env: { ...env, REAL_HARNESS_REJECT_AFTER_FIRST: "1" },
					extensions: [EXTENSION],
				},
				async (pi) => {
					// The pi host's session_start reaper is fire-and-forget; keep this
					// real next host alive until its reaper has had its bounded window.
					await waitGone(first.runner);

					// A runner that exits on its own leaves no row: the row lands while
					// it runs, and its observed exit removes it.
					const normalRunner = await startRunner(pi, pidFile);
					childPids.push(normalRunner);
					await expect
						.poll(() => rowOwner(home, normalRunner), {
							timeout: REAP_WAIT_MS,
							interval: 50,
						})
						.toBeDefined();
					fs.writeFileSync(releaseFile, "");
					await waitGone(normalRunner);
					await expect
						.poll(() => rowOwner(home, normalRunner), {
							timeout: REAP_WAIT_MS,
							interval: 50,
						})
						.toBeUndefined();

					// Both ledger operations reject from here on; the runner exits at
					// once (the release file exists), and the host keeps answering.
					const rejectedRunner = await startRunner(pi, pidFile);
					childPids.push(rejectedRunner);
					await waitGone(rejectedRunner);
					await expect(pi.getState()).resolves.toBeDefined();
				},
			);
		}, 180_000);
	},
);

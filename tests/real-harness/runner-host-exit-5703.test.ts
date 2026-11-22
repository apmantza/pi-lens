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

async function waitForPid(pidFile: string): Promise<number> {
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

function registeredHostPid(home: string, child?: number): number {
	const file = JSON.parse(
		fs.readFileSync(path.join(home, "instances.json"), "utf8"),
	) as {
		instances: Array<{
			pid: number;
			lspChildren?: Array<{ pid: number; serverId?: string }>;
		}>;
	};
	const pid = file.instances[0]?.pid;
	if (!pid) throw new Error("pi host did not register");
	if (
		child !== undefined &&
		!file.instances[0]?.lspChildren?.some(
			(row) =>
				row.pid === child &&
				row.serverId === "safe-spawn:real-harness-runner-5703",
		)
	)
		throw new Error("runner child is not in instances.json yet");
	return pid;
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
			dirs.push(home, project);
			const first = await withRealPi(
				{
					fixture: FIXTURE,
					script: "script.json",
					home,
					project,
					env: {
						REAL_HARNESS_RUNNER_PID_FILE: pidFile,
						REAL_HARNESS_RUNNER_OWNER_FILE: ownerFile,
						PI_LENS_TEST_MODE: "0",
					},
					extensions: [EXTENSION],
				},
				async (pi) => {
					await pi.prompt("/real-harness-runner-5703");
					const runner = await waitForPid(pidFile);
					const ownerTag = fs.readFileSync(ownerFile, "utf8");
					expect(ownerTag).toMatch(/^\d+:\d+@[0-9a-f-]{36}$/);
					let host: number | undefined;
					const ledgerDeadline = Date.now() + REAP_WAIT_MS;
					while (host === undefined && Date.now() < ledgerDeadline) {
						try {
							host = registeredHostPid(home, runner);
						} catch {
							await new Promise<void>((resolve) => setTimeout(resolve, 50));
						}
					}
					if (host === undefined)
						throw new Error("runner ledger row never landed");
					adoptProcessTree(host, [runner]);
					childPids.push(runner);
					process.kill(host, "SIGKILL");
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
					env: {
						REAL_HARNESS_RUNNER_PID_FILE: pidFile,
						REAL_HARNESS_RUNNER_OWNER_FILE: ownerFile,
						PI_LENS_TEST_MODE: "0",
					},
				},
				async () => {
					// The pi host's session_start reaper is fire-and-forget; keep this
					// real next host alive until its reaper has had its bounded window.
					await waitGone(first.runner);
				},
			);
		}, 180_000);
	},
);

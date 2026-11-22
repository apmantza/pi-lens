// flake-shape: real-process-spawn — six real Node writers must rendezvous on the OS barrier and persist registrations through the production cross-process lock; an in-process double cannot reproduce #2173.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const worker = path.resolve("tests/fixtures/instance-registry-race-worker.mjs");
const WRITERS = 6;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
});

interface RoundResult {
	/** Live writers whose pid is absent from the registry. */
	missing: number[];
	/** Writers whose bounded lock wait ran out (recorded, by design). */
	timedOut: number[];
	/** Missing writers with NO recorded timeout: a lost update under the lock. */
	unexplained: number[];
}

interface WriterReport {
	pid: number;
	lockTimedOut: boolean;
}

/** The writer's report line, read while the writer may still be alive. */
function firstLine(
	run: ReturnType<typeof execFileAsync>,
): Promise<WriterReport> {
	return new Promise((resolve, reject) => {
		let out = "";
		run.child.stdout?.on("data", (chunk: Buffer | string) => {
			out += String(chunk);
			const end = out.indexOf("\n");
			if (end >= 0) resolve(JSON.parse(out.slice(0, end)) as WriterReport);
		});
		run.catch(reject);
	});
}

async function raceRound(round: number, stallMs = 0): Promise<RoundResult> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-registry-race-"));
	tempDirs.push(home);
	const barrier = path.join(home, `barrier-${round}`);
	const release = path.join(home, `release-${round}`);
	// #5733: an exiting process removes its own row (#5699), so only a writer
	// still alive at the read can show a lost update. Even writers stay alive;
	// odd ones exit at once, and their exit removal races the live writes.
	const writers = Array.from({ length: WRITERS }, (_, writer) => {
		const live = writer % 2 === 0;
		const run = execFileAsync(
			process.execPath,
			[
				worker,
				home,
				barrier,
				`/race/${round}/${writer}`,
				String(stallMs),
				live ? release : "",
			],
			{
				cwd: process.cwd(),
				env: { ...process.env, PI_LENS_HOME: home },
				windowsHide: true,
			},
		);
		return { live, run, report: firstLine(run) };
	});
	fs.writeFileSync(barrier, "go\n");
	try {
		const reports = await Promise.all(writers.map((w) => w.report));
		await Promise.all(writers.filter((w) => !w.live).map((w) => w.run));
		const registered = new Set(
			(
				JSON.parse(
					fs.readFileSync(path.join(home, "instances.json"), "utf8"),
				) as { instances: Array<{ pid: number }> }
			).instances.map((entry) => entry.pid),
		);
		const missing = reports
			.filter((report, i) => writers[i]?.live && !registered.has(report.pid))
			.map((report) => report.pid);
		const timedOut = reports
			.filter((report) => report.lockTimedOut)
			.map((report) => report.pid);
		return {
			missing,
			timedOut,
			unexplained: missing.filter((pid) => !timedOut.includes(pid)),
		};
	} finally {
		fs.writeFileSync(release, "done\n");
		await Promise.allSettled(writers.map((w) => w.run));
	}
}

describe("instance registry cross-process writer exclusion", () => {
	it("retains every registration across real node writer races", async () => {
		// Pre-lock probe result: 9/72 registrations lost at N=6 over 12 rounds.
		// #3447: the lock's wait is bounded (LOCK_WAIT_MS), so a holder the CI
		// scheduler stalls past it makes a waiter give up and record
		// `instance-registry-lock-timeout` -- by design, not a lost update. A
		// round with a timeout proves nothing about exclusion and is re-run;
		// the test still needs `rounds` rounds where no writer timed out and no
		// registration was lost, and ANY registration missing without its own
		// recorded timeout fails at once.
		const rounds = 12;
		const maxAttempts = 24;
		const unexplained: string[] = [];
		const timedOutRounds: number[] = [];
		let clean = 0;
		for (let attempt = 0; attempt < maxAttempts && clean < rounds; attempt++) {
			const result = await raceRound(attempt);
			if (result.unexplained.length > 0)
				unexplained.push(`${attempt}: ${result.unexplained.length}`);
			if (result.timedOut.length > 0) timedOutRounds.push(attempt);
			else if (result.missing.length === 0) clean += 1;
		}
		expect(
			unexplained,
			`registrations lost without a lock timeout, by round`,
		).toEqual([]);
		expect(
			clean,
			`clean rounds (rounds with a lock timeout: ${timedOutRounds.join(", ") || "none"})`,
		).toBe(rounds);
	}, 60_000);

	it("accounts for every registration a stalled lock holder drops (#3447)", async () => {
		// Every writer parks 700 ms on its first registry read, inside the lock:
		// the waiters' 500 ms bound runs out, as on the CI run that redded
		// PR #3432's head (1 of 6 lost). Each drop must carry its timeout record.
		const result = await raceRound(0, 700);
		expect(result.timedOut.length).toBeGreaterThan(0);
		expect(result.missing.length).toBeGreaterThan(0);
		expect(result.unexplained).toEqual([]);
	}, 60_000);
});

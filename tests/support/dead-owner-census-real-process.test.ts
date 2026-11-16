// flake-shape: real-process-spawn — the census's claim is that it finds a real
// managed process whose real `PI_LENS_OWNER` tag names a reaped pid, through
// the production readers (`ps`, the `/proc` environ read, the managed-name
// match, the liveness check). A fabricated table and a faked tag read, which
// `dead-owner-census.test.ts` uses for the decision rules, would answer only
// what they were told, and the 40+ shard-5 jobs that printed "0 dead-owner
// pids" would be unfalsifiable.
/**
 * #5528: the per-file dead-owner census, driven over real processes.
 *
 * Recurrence it guards: CI shard 5 ended with `ast-grep` children alive under
 * a reaped owner pid, and the census that was meant to name the file printed
 * "0 dead-owner pids" on every run since. Whether that silence means clean or
 * means the readers cannot see a leak (an environ read that returns nothing,
 * a managed-name match that misses the argv) was never checked on a real
 * process. This file plants one and asks the census to name it.
 *
 * The population is real: a `sleep` execed under a managed-binary argv0 so the
 * production name match sees it, carrying a tag whose owner pid was reaped. The
 * only injected value is the seen-after file name.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatOwnerTag } from "../../clients/process-snapshot.js";
import {
	loadActualCensusSeams,
	recordCensusWorker,
	runDeadOwnerCensus,
} from "./dead-owner-census.js";

/** The start spelling `parseOwnerTag` accepts; the census never compares it. */
const TAG_START = "1@00000000-0000-0000-0000-000000000000";
/** argv0 only: the binary is `/bin/sleep`, so nothing here runs a real analyzer. */
const DECOY_ARGV0 = "ast-grep-5528-census-decoy";
/** Long enough for the case, short enough that a leaked decoy ends by itself. */
const DECOY_LIFE_S = "120";

/** A pid the OS has reaped: a child that already exited and was waited for. */
function reapedPid(): number {
	const done = spawnSync("/bin/true", { stdio: "ignore" });
	if (done.pid === undefined) throw new Error("reaped owner: no pid");
	return done.pid;
}

describe.skipIf(process.platform === "win32")(
	"#5528 dead-owner census over real processes",
	() => {
		let dir: string;
		let log: string;
		let lines: string[];
		const decoys: ChildProcess[] = [];
		const write = (line: string) => lines.push(line);

		/** A decoy this worker owns, started with `env` over the worker's own. */
		function plant(tag: string | undefined): number {
			const env: NodeJS.ProcessEnv = { ...process.env };
			delete env.PI_LENS_OWNER;
			if (tag !== undefined) env.PI_LENS_OWNER = tag;
			const child = spawn("/bin/sleep", [DECOY_LIFE_S], {
				argv0: DECOY_ARGV0,
				env,
				stdio: "ignore",
			});
			if (child.pid === undefined) throw new Error("decoy: no pid");
			decoys.push(child);
			return child.pid;
		}

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5528-real-"));
			log = path.join(dir, "census.log");
			lines = [];
		});
		afterEach(async () => {
			for (const child of decoys.splice(0)) {
				if (child.exitCode === null && child.signalCode === null) {
					const exited = once(child, "exit");
					child.kill("SIGKILL");
					await exited;
				}
			}
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it("names the file behind a real managed process whose owner pid was reaped", async () => {
			const ownerPid = reapedPid();
			recordCensusWorker("clients/leaky.test.ts", ownerPid, log);
			const pid = plant(formatOwnerTag({ pid: ownerPid, start: TAG_START }));
			const printed = await runDeadOwnerCensus("tests/next.test.ts", {
				log,
				seams: await loadActualCensusSeams(),
				write,
			});
			const mine = printed.filter((line) => line.includes(`pid=${pid} `));
			expect(mine).toHaveLength(1);
			expect(mine[0]).toContain(`owner=${ownerPid} `);
			expect(mine[0]).toContain("owner_file=clients/leaky.test.ts ");
			expect(mine[0]).toContain("seen_after=tests/next.test.ts ");
			expect(mine[0]).toContain(`cmd=${DECOY_ARGV0} ${DECOY_LIFE_S}`);
		});

		it("spares a real managed process whose owner is this live worker", async () => {
			const pid = plant(formatOwnerTag({ pid: process.pid, start: TAG_START }));
			const printed = await runDeadOwnerCensus("tests/next.test.ts", {
				log,
				seams: await loadActualCensusSeams(),
				write,
			});
			expect(printed.filter((line) => line.includes(`pid=${pid} `))).toEqual(
				[],
			);
		});

		// A managed process the tag read returns nothing for (an unreadable
		// environ, a foreign pid namespace, or a process that never had a tag)
		// cannot be judged by the owner rule. The worker is its parent here, so
		// it is owned and must not be listed; the orphan form is covered over
		// the fake table in `dead-owner-census.test.ts`, because a real orphan
		// needs a parent this worker does not own.
		it("does not list a real managed process with no tag while a live parent owns it", async () => {
			const pid = plant(undefined);
			const printed = await runDeadOwnerCensus("tests/next.test.ts", {
				log,
				seams: await loadActualCensusSeams(),
				write,
			});
			expect(printed.filter((line) => line.includes(`pid=${pid} `))).toEqual(
				[],
			);
		});
	},
);

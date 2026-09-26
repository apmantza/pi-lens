/**
 * #1217 regression: `pruneDeadInstances` (clients/instance-reaper.ts) staged
 * the machine-global `instances.json` at a hand-rolled
 * `${target}.tmp-${process.pid}` instead of going through `atomic-write.ts`,
 * so it never inherited the #1205 per-call staging fix.
 *
 * Two concurrent prunes in one process computed the identical staging path,
 * both wrote into it, and the first rename published that inode while the
 * second was still writing — publishing a torn `instances.json`. This store
 * degrades a parse failure to empty (`readInstanceRegistry`), so a tear drops
 * EVERY registered instance rather than the one entry being pruned.
 *
 * Concurrency here is by design, not exceptional: `instance-registry.ts`'s
 * `getResourceFootprint` fires `prunePids(...)` fire-and-forget while the
 * reaper runs its own sweep, with nothing serializing the two.
 *
 * Payload sizes are mismatched (many instances vs few) so a hybrid is
 * detectable, and the file is asserted to parse AND to be one of the two
 * intended states — a truncated JSON object that happens to still parse would
 * otherwise pass. Nothing branches on `process.platform`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneDeadInstances } from "../../clients/instance-reaper.js";
import type { InstanceEntry } from "../../clients/instance-registry.js";
import { removeTempDirSync } from "./test-utils.js";

let home: string;
let registryPath: string;
const savedHome = process.env.PI_LENS_HOME;

/**
 * Tracks the currently-awaited `pruneDeadInstances` call(s) so `afterEach` can
 * drain them before the next test's `beforeEach` repoints `PI_LENS_HOME`
 * (#1629).
 *
 * `pruneDeadInstances` reads `process.env.PI_LENS_HOME` fresh on every call
 * (via `getGlobalPiLensDir`, clients/file-utils.ts) rather than once per test.
 * Vitest's per-test timeout does not cancel in-flight async work — it only
 * races a timer against the test's promise and reports failure when the timer
 * wins, while the test body keeps running in the background. So a test that
 * times out mid-loop leaves its `for` loop still executing: the next
 * iteration reads `PI_LENS_HOME` again, but by then this file's `afterEach` +
 * the next test's `beforeEach` have already repointed it at the NEXT test's
 * temp dir, and the zombie write lands there instead — failing the next
 * test's `stageLeftovers()` assertion with the PRIOR test's litter (observed
 * 2026-08-19 on CI, reproduced locally under contention: e.g.
 * `instances.json.tmp-35960-0-36` appearing in the wrong test's directory).
 * Awaiting the last-known in-flight promise here closes that window: the next
 * `beforeEach` cannot run until this one's zombie work has settled.
 */
let inFlight: Promise<unknown> | null = null;

function entry(pid: number, pad = 0): InstanceEntry {
	return {
		pid,
		startedAt: "2026-01-01T00:00:00.000Z",
		projectRoot: `/proj/${pid}${"x".repeat(pad)}`,
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 0,
		heartbeatAt: "2026-01-01T00:00:00.000Z",
	};
}

/** `count` instances with pids 1..count, each `pad` bytes wider. */
function seedRegistry(count: number, pad = 0): void {
	const instances = Array.from({ length: count }, (_, i) => entry(i + 1, pad));
	fs.writeFileSync(registryPath, JSON.stringify({ instances }), "utf-8");
}

function readPids(): number[] {
	const parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
	return (parsed.instances as InstanceEntry[]).map((i) => i.pid);
}

function stageLeftovers(): string[] {
	return fs.readdirSync(home).filter((name) => name.includes(".tmp-"));
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-prune-"));
	process.env.PI_LENS_HOME = home;
	registryPath = path.join(home, "instances.json");
});

afterEach(async () => {
	// Drain any zombie prune write from a timed-out test before this file's
	// PI_LENS_HOME repoints to the next test's dir — see `inFlight`'s doc
	// comment (#1629). Bounded re-check loop: a zombie loop iteration that is
	// itself still running can set `inFlight` to a NEW pending promise the
	// instant the awaited one settles, so a single `await` can race it.
	for (let guard = 0; guard < 50 && inFlight; guard++) {
		await inFlight.catch(() => {});
	}
	if (savedHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = savedHome;
	removeTempDirSync(home);
});

describe("pruneDeadInstances", () => {
	it("drops exactly the named pids", async () => {
		seedRegistry(5);
		await pruneDeadInstances([{ pid: 2 }, { pid: 4 }]);
		expect(readPids()).toEqual([1, 3, 5]);
	});

	it("leaves the file untouched when no pid matches", async () => {
		seedRegistry(3);
		const before = fs.readFileSync(registryPath, "utf-8");
		await pruneDeadInstances([{ pid: 99 }]);
		expect(fs.readFileSync(registryPath, "utf-8")).toBe(before);
	});

	it("leaves no staging file behind", async () => {
		seedRegistry(3);
		await pruneDeadInstances([{ pid: 1 }]);
		expect(stageLeftovers()).toEqual([]);
	});

	it("is best-effort on a missing registry", async () => {
		await expect(pruneDeadInstances([{ pid: 1 }])).resolves.toBeUndefined();
	});
});

// #1629: solo runs of the 40-iteration test measured 1.7-3.3s (well inside
// the vitest default 5000ms), but 8 contended runs (this file run alongside
// 5 sibling suites, PI_LENS_TEST_MAX_WORKERS=2 to force fork contention on a
// 16-core box) put it over that budget 3/8 times (37.5%), ranging 5.1-6.4s —
// a genuine test-budget problem, not a production regression (#1738's
// registryChildMutationTail landed after this file existed and did not
// change these numbers; the write path itself is unchanged fs I/O). 30s
// matches this repo's existing HEAVY_IO_TIMEOUT_MS convention
// (ast-grep-rule-precedence-followups.test.ts) and gives ~5x headroom over
// the worst contended run observed, including CI's weaker 4-core runner.
const PRUNE_CONCURRENCY_TIMEOUT_MS = 30_000;

describe(
	"concurrent pruneDeadInstances on one registry (#1217)",
	{
		timeout: PRUNE_CONCURRENCY_TIMEOUT_MS,
	},
	() => {
		const ITERATIONS = 40;
		// BOTH results have to be large, and differ in size: the tear comes from two
		// writers overlapping INSIDE the shared inode (the second `open(O_TRUNC)`s
		// while the first is mid-write, and each fd carries its own offset), not
		// from the rename alone. Pairing a big result with a tiny one does not
		// reproduce it — the tiny writer is long finished before the big one starts,
		// and the big writer then simply overwrites the whole file with its own
		// complete content. Each writer also reads and parses the same ~2 MB file
		// first, which desynchronizes them further, so the payloads must be big
		// enough that the writes still overlap after that. ~2 MB vs ~1 MB here;
		// #1205 measured its Linux reproduction at 21/40 on the same scale.
		const TOTAL = 1200;
		const PAD = 1600;
		const EVENS = Array.from({ length: TOTAL / 2 }, (_, n) => (n + 1) * 2);

		it("always publishes a parseable registry that is one of the two results", async () => {
			const outcomes: string[] = [];
			for (let i = 0; i < ITERATIONS; i++) {
				seedRegistry(TOTAL, PAD);
				// One prune drops a single pid (~2 MB result); the other drops every
				// even pid (~1 MB result).
				const pruneOne = [{ pid: 2 }];
				const pruneEvens = EVENS.map((pid) => ({ pid }));
				// Alternate launch order so neither writer is systematically first.
				const [first, second] =
					i % 2 === 0 ? [pruneOne, pruneEvens] : [pruneEvens, pruneOne];
				const settling = Promise.all([
					pruneDeadInstances(first),
					pruneDeadInstances(second),
				]);
				inFlight = settling;
				await settling;
				inFlight = null;

				const raw = fs.readFileSync(registryPath, "utf-8");
				let pids: number[];
				try {
					pids = (JSON.parse(raw).instances as InstanceEntry[]).map(
						(e) => e.pid,
					);
				} catch {
					outcomes.push(`UNPARSABLE(len=${raw.length})`);
					continue;
				}
				// Either writer may win — but the winner's whole result must be
				// published, never one spliced into the other.
				if (pids.length === TOTAL - 1 && !pids.includes(2))
					outcomes.push("ONE_PRUNED");
				else if (pids.length === TOTAL / 2 && pids.every((p) => p % 2 === 1))
					outcomes.push("EVENS_PRUNED");
				else outcomes.push(`HYBRID(entries=${pids.length}, len=${raw.length})`);
			}
			expect(
				outcomes.filter(
					(o) => o.startsWith("HYBRID") || o.startsWith("UNPARS"),
				),
			).toEqual([]);
		});

		it("leaves no staging files behind after concurrent prunes", async () => {
			seedRegistry(TOTAL, PAD);
			const settling = Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					pruneDeadInstances([{ pid: i + 2 }]),
				),
			);
			inFlight = settling;
			await settling;
			inFlight = null;
			expect(stageLeftovers()).toEqual([]);
		});
	},
);

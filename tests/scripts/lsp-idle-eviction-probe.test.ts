/**
 * #3645: the per-server idle-eviction measurement.
 *
 * Recurrence this file prevents: the idle-eviction allowlist was assigned by
 * whichever servers a human remembered (#3622 widened a key-prefix regex from
 * one server to four), because nothing measured the cost or the safety of
 * eviction per server. The probe is the instrument; these tests pin the
 * verdicts it may reach. Every verdict has an inverse test, because a probe
 * that can only say "eligible" would launder an unsafe server into a policy
 * proposal.
 *
 * The driver double runs on a VIRTUAL clock: `sleep` advances time and
 * `isTargetAlive` only turns false once the armed window has elapsed, exactly
 * as the production timer behaves. A probe that never arms, never waits, or
 * disarms late therefore cannot pass by accident. No timer, child or
 * wall-clock wait is involved.
 */
import { describe, expect, it } from "vitest";
import {
	findingKey,
	probePopulation,
	probeServer,
	residentTreeBytes,
	selectFixtureForServer,
	type IdleEvictionDriver,
	type ProbeBudgets,
	type ProbeFinding,
} from "../../scripts/lib/lsp-idle-eviction-probe.mjs";

const budgets: ProbeBudgets = {
	baselineAttempts: 3,
	baselineSettleMs: 1_750,
	evictionWaitMs: 15_000,
	recordWaitMs: 5_000,
	pollMs: 500,
	coldStartWaitMs: 90_000,
};

const at = (line: number, message: string, serverId = "srv"): ProbeFinding => ({
	serverId,
	source: serverId,
	severity: 1,
	message,
	range: {
		start: { line, character: 0 },
		end: { line, character: 1 },
	},
});

type Script = {
	windowMs?: number;
	coldSpawnMs?: number;
	warmTouchMs?: number;
	prepare?: string | undefined;
	/** findings per touch number (1-based, counted across respawns); undefined = no client ready */
	touches?: (n: number, generation: number) => ProbeFinding[] | undefined;
	rss?: number | null | "throw";
	neverEvicts?: boolean;
	/** the client vanishes at the window but no eviction record ever lands */
	diesInsteadOfEvicting?: boolean;
	/** ms between the client being retired and the eviction record landing */
	recordLagMs?: number;
	touchThrowsAfterEviction?: boolean;
	baselineThrows?: boolean;
	/** the touch reports findings, but the target is never among the live clients */
	targetNeverAlive?: boolean;
};

function virtualDriver(script: Script = {}) {
	const windowMs = script.windowMs ?? 3_000;
	let t = 0;
	let alive = false;
	let generation = 0;
	let touchNo = 0;
	let armedAt: number | undefined;
	let evicted = false;
	const log = {
		armCalls: 0,
		restoreCalls: 0,
		armedWhenRespawnTouched: undefined as boolean | undefined,
		disposed: 0,
		touches: 0,
	};
	let armed = false;
	let recorded = 0;
	let recordAt: number | undefined;
	const driver: IdleEvictionDriver = {
		now: () => t,
		sleep: async (ms) => {
			t += ms;
			if (
				armed &&
				!script.neverEvicts &&
				armedAt !== undefined &&
				t - armedAt >= windowMs &&
				alive
			) {
				alive = false;
				evicted = true;
				if (!script.diesInsteadOfEvicting)
					recordAt = t + (script.recordLagMs ?? 0);
			}
			if (recordAt !== undefined && t >= recordAt) {
				recorded += 1;
				recordAt = undefined;
			}
		},
		prepare: async () => script.prepare,
		touch: async () => {
			// Production: a respawn queues behind the retiring client's teardown on
			// the spawn gate, so a touch that beats the record pays the remaining lag.
			if (recordAt !== undefined) {
				t = Math.max(t, recordAt);
				recorded += 1;
				recordAt = undefined;
			}
			log.touches += 1;
			touchNo += 1;
			if (evicted && generation >= 1 && !alive) {
				log.armedWhenRespawnTouched ??= armed;
				if (script.touchThrowsAfterEviction) {
					t += 1_000;
					throw new Error("respawn failed");
				}
			}
			if (script.baselineThrows && touchNo === 1) throw new Error("boom");
			const found = (script.touches ?? (() => [at(1, "bad")]))(
				touchNo,
				generation,
			);
			if (found === undefined) {
				t += 500;
				return undefined;
			}
			if (!alive) {
				t += script.coldSpawnMs ?? 4_000;
				alive = true;
				generation += 1;
				evicted = false;
			} else {
				t += script.warmTouchMs ?? 300;
			}
			return found;
		},
		isTargetAlive: () => alive && !script.targetNeverAlive,
		evictionsRecorded: () => recorded,
		rssBytes: async () => {
			if (script.rss === "throw") throw new Error("no process table");
			return script.rss === undefined ? 200 * 1024 * 1024 : script.rss;
		},
		armEviction: async () => {
			log.armCalls += 1;
			armed = true;
			armedAt = t;
			return () => {
				if (!armed) return;
				armed = false;
				log.restoreCalls += 1;
			};
		},
		dispose: async () => {
			log.disposed += 1;
		},
	};
	return { driver, log, state: () => ({ armed, alive, t }) };
}

const server = {
	id: "srv",
	idleEviction: "unmeasured",
	extensions: [".srv"],
};
const fixture = { lang: "srv", file: "a.srv" };

async function run(
	script: Script = {},
	overrides: Record<string, unknown> = {},
) {
	const made = virtualDriver(script);
	const row = await probeServer({
		server: { ...server, ...(overrides.server as object) },
		fixture:
			(overrides.fixture as typeof fixture | null | undefined) === null
				? null
				: { ...fixture, ...(overrides.fixture as object) },
		createDriver: () => made.driver,
		budgets,
	});
	return { row, ...made };
}

describe("probeServer verdicts (#3645)", () => {
	it("reports an eligible row with init, rss, respawn ok and cold start measured on the virtual clock", async () => {
		const { row } = await run({ coldSpawnMs: 4_000, rss: 300 * 1024 * 1024 });
		expect(row).toMatchObject({
			serverId: "srv",
			declared: "unmeasured",
			result: "eligible",
			respawn: "ok",
			coverage: "preserved",
			initMs: 4_000,
			rssBytes: 300 * 1024 * 1024,
		});
		expect(row.reason).toBeUndefined();
		expect(row.widened).toBeUndefined();
	});

	it("times cold start from the eviction, not from arming", async () => {
		// Armed at t=4000 (after the 4000ms baseline); the poll loop sleeps in
		// 500ms steps, so eviction is observed at t=7000 and the respawn costs
		// 6000ms of cold spawn. Measuring from arming would add the 3000ms window.
		const { row } = await run({ coldSpawnMs: 6_000, windowMs: 3_000 });
		expect(row.coldStartMs).toBe(6_000);
	});

	it("reports unavailable/no-fixture without creating a driver", async () => {
		let created = 0;
		const row = await probeServer({
			server,
			fixture: null,
			createDriver: () => {
				created += 1;
				return virtualDriver().driver;
			},
			budgets,
		});
		expect(row).toMatchObject({ result: "unavailable", reason: "no-fixture" });
		expect(created).toBe(0);
		expect(row.initMs).toBeUndefined();
		expect(row.rssBytes).toBeUndefined();
	});

	it("reports unavailable with the driver's reason when the fixture cannot be prepared", async () => {
		const { row, log } = await run({ prepare: "tool-unavailable" });
		expect(row).toMatchObject({
			result: "unavailable",
			reason: "tool-unavailable",
		});
		expect(row.initMs).toBeUndefined();
		expect(log.armCalls).toBe(0);
		expect(log.disposed).toBe(1);
	});

	it("reports unavailable/server-not-started when no client becomes ready", async () => {
		const { row } = await run({ touches: () => undefined });
		expect(row).toMatchObject({
			result: "unavailable",
			reason: "server-not-started",
		});
		expect(row.rssBytes).toBeUndefined();
	});

	it("reports unavailable/server-not-started when findings arrive but the target is not a live client", async () => {
		// A fixture that routes to another server can still hand back unattributed
		// findings; measuring eviction of a server that never ran would be a lie.
		const { row, log } = await run({ targetNeverAlive: true });
		expect(row).toMatchObject({
			result: "unavailable",
			reason: "server-not-started",
		});
		expect(row.rssBytes).toBeUndefined();
		expect(log.armCalls).toBe(0);
	});

	it("reports inconclusive/no-baseline with coverage unproven when the server reports nothing", async () => {
		const { row, log } = await run({ touches: () => [] });
		expect(row).toMatchObject({
			result: "inconclusive",
			reason: "no-baseline",
			coverage: "unproven",
		});
		expect(log.touches).toBe(budgets.baselineAttempts);
		expect(log.armCalls).toBe(0);
	});

	it("measures a fixture whose confirmed protocol result is empty", async () => {
		const { row } = await run(
			{
				touches: () => [],
			},
			{ fixture: { allowEmptyBaseline: true } },
		);
		expect(row).toMatchObject({
			result: "eligible",
			coverage: "preserved",
			respawn: "ok",
		});
	});

	it("retries an empty baseline and uses the first attempt that reports something", async () => {
		const { row, log } = await run({
			touches: (n) => (n < 3 ? [] : [at(2, "late")]),
		});
		expect(row.result).toBe("eligible");
		// Two empty baseline attempts, the answer, then the post-eviction touch.
		expect(log.touches).toBe(4);
	});

	it("vetoes with findings-narrowed when the respawned server reports fewer findings", async () => {
		const { row } = await run({
			touches: (_n, generation) =>
				generation === 0 ? [at(1, "a"), at(2, "b")] : [at(1, "a")],
		});
		expect(row).toMatchObject({
			result: "vetoed",
			reason: "findings-narrowed",
			respawn: "ok",
			coverage: "narrowed",
		});
	});

	it("treats extra post-respawn findings as preserved coverage, not narrowed", async () => {
		const { row } = await run({
			touches: (_n, generation) =>
				generation === 0 ? [at(1, "a")] : [at(1, "a"), at(9, "new")],
		});
		expect(row).toMatchObject({
			result: "eligible",
			coverage: "preserved",
			widened: 1,
		});
	});

	it("vetoes with respawn-failed when the next request never brings the target back", async () => {
		const { row } = await run({ touchThrowsAfterEviction: true });
		expect(row).toMatchObject({
			result: "vetoed",
			reason: "respawn-failed",
			respawn: "failed",
		});
		expect(row.coldStartMs).toBeUndefined();
	});

	it("reports inconclusive/not-evicted when the timer never fires within the bound", async () => {
		const { row } = await run({ neverEvicts: true });
		expect(row).toMatchObject({
			result: "inconclusive",
			reason: "not-evicted",
			respawn: "not-evicted",
		});
		expect(row.coldStartMs).toBeUndefined();
	});

	it("reports inconclusive/client-died when the client vanishes without an eviction record", async () => {
		const { row } = await run({ diesInsteadOfEvicting: true });
		expect(row).toMatchObject({
			result: "inconclusive",
			reason: "client-died",
			respawn: "not-evicted",
		});
		expect(row.coldStartMs).toBeUndefined();
	});

	it("waits for the eviction record that trails the release before it respawns", async () => {
		// The release is visible at t=7000 but the record lands 2000ms later; a
		// probe that respawned on the first !alive would time the cold start from
		// 7000 and report 8000 instead of 6000.
		const { row } = await run({ recordLagMs: 2_000, coldSpawnMs: 6_000 });
		expect(row).toMatchObject({ result: "eligible" });
		expect(row.coldStartMs).toBe(6_000);
	});

	it("reports a thrown baseline touch as inconclusive/probe-error and still disposes", async () => {
		const { row, log } = await run({ baselineThrows: true });
		expect(row).toMatchObject({
			result: "inconclusive",
			reason: "probe-error",
		});
		expect(log.disposed).toBe(1);
	});

	it("keeps an rss that cannot be read as null, never zero", async () => {
		const unreadable = await run({ rss: "throw" });
		expect(unreadable.row.rssBytes).toBeNull();
		expect(unreadable.row.result).toBe("eligible");
		const absent = await run({ rss: null });
		expect(absent.row.rssBytes).toBeNull();
	});

	it("disarms before the respawn so the replacement is not evicted while it is timed", async () => {
		const { log } = await run();
		expect(log.armedWhenRespawnTouched).toBe(false);
	});

	it("restores the armed policy on every exit path", async () => {
		const scripts: Script[] = [
			{},
			{ neverEvicts: true },
			{ touchThrowsAfterEviction: true },
			{
				touches: (_n, generation) =>
					generation === 0 ? [at(1, "a")] : [at(7, "other")],
			},
		];
		for (const script of scripts) {
			const { log, state } = await run(script);
			expect(log.armCalls, JSON.stringify(script)).toBe(1);
			expect(state().armed, JSON.stringify(script)).toBe(false);
			expect(log.restoreCalls, JSON.stringify(script)).toBe(1);
			expect(log.disposed, JSON.stringify(script)).toBe(1);
		}
	});

	it("restores and disposes when the driver throws mid-measurement", async () => {
		const made = virtualDriver();
		const original = made.driver.isTargetAlive;
		let polls = 0;
		made.driver.isTargetAlive = () => {
			polls += 1;
			// Healthy through the baseline check, then the eviction poll explodes.
			if (polls === 2) throw new Error("service torn down");
			return original();
		};
		const row = await probeServer({
			server,
			fixture,
			createDriver: () => made.driver,
			budgets,
		});
		expect(row).toMatchObject({
			result: "inconclusive",
			reason: "probe-error",
		});
		expect(made.state().armed).toBe(false);
		expect(made.log.disposed).toBe(1);
	});

	describe("auxiliary coverage probe (criterion 3)", () => {
		const aux = { role: "auxiliary" };
		const auxFixture = { auxiliarySourceMatch: "srv" };

		it("narrows on the auxiliary's own findings even when the primary's are intact", async () => {
			const { row } = await run(
				{
					touches: (_n, generation) =>
						generation === 0
							? [at(1, "primary", "ts"), at(2, "scan-a"), at(3, "scan-b")]
							: [at(1, "primary", "ts"), at(2, "scan-a")],
				},
				{ server: aux, fixture: auxFixture },
			);
			expect(row).toMatchObject({
				role: "auxiliary",
				result: "vetoed",
				reason: "findings-narrowed",
				coverage: "narrowed",
			});
		});

		it("has no baseline when only other servers reported, so it cannot prove coverage", async () => {
			const { row } = await run(
				{ touches: () => [at(1, "primary", "ts")] },
				{ server: aux, fixture: { auxiliarySourceMatch: "never-matches" } },
			);
			expect(row).toMatchObject({
				role: "auxiliary",
				result: "inconclusive",
				reason: "no-baseline",
				coverage: "unproven",
			});
		});

		it("is eligible when the auxiliary's findings survive the respawn", async () => {
			const { row } = await run(
				{
					touches: () => [at(1, "primary", "ts"), at(2, "scan-a")],
				},
				{ server: aux, fixture: auxFixture },
			);
			expect(row).toMatchObject({ role: "auxiliary", result: "eligible" });
		});
	});
});

describe("findingKey", () => {
	it("distinguishes position, message and server, and ignores list order", () => {
		const a = at(1, "x");
		expect(findingKey(a)).toBe(findingKey({ ...a }));
		expect(findingKey(a)).not.toBe(findingKey(at(2, "x")));
		expect(findingKey(a)).not.toBe(findingKey(at(1, "y")));
		expect(findingKey(a)).not.toBe(findingKey(at(1, "x", "other")));
	});
});

describe("selectFixtureForServer", () => {
	const fixtures = [
		{ lang: "clean", file: "c.srv", clean: true },
		{ lang: "custom", file: "d.srv", customServer: { id: "x" } },
		{ lang: "ext", file: "a.srv" },
		{ lang: "named", file: "b.other", serverId: "srv" },
		{ lang: "aux", file: "e.js", auxiliaryServerIds: ["aux-only"] },
		{ lang: "dockerfile", file: "Dockerfile" },
	];

	it("prefers a fixture that names the server over an extension match", () => {
		expect(selectFixtureForServer(server, fixtures)?.lang).toBe("named");
	});

	it("falls back to a fixture that lists the server as auxiliary", () => {
		expect(
			selectFixtureForServer({ id: "aux-only", extensions: [".js"] }, fixtures)
				?.lang,
		).toBe("aux");
	});

	it("falls back to the language fixture the extensions claim, by extension or basename", () => {
		expect(
			selectFixtureForServer({ id: "p", extensions: [".SRV"] }, [
				{ lang: "ext", file: "sub/a.srv" },
			])?.lang,
		).toBe("ext");
		expect(
			selectFixtureForServer(
				{ id: "docker", extensions: ["dockerfile"] },
				fixtures,
			)?.lang,
		).toBe("dockerfile");
	});

	it("skips clean and custom-server fixtures", () => {
		expect(
			selectFixtureForServer({ id: "p", extensions: [".srv"] }, [
				fixtures[0],
				fixtures[1],
			]),
		).toBeNull();
	});

	it("returns null for a server no fixture reaches", () => {
		expect(
			selectFixtureForServer({ id: "lonely", extensions: [".zzz"] }, fixtures),
		).toBeNull();
	});

	it("does not route a language fixture owned by another server id", () => {
		expect(
			selectFixtureForServer({ id: "fallback", extensions: [".cs"] }, [
				{ lang: "csharp", file: "a.cs", serverId: "csharp" },
			]),
		).toBeNull();
	});
});

describe("probePopulation", () => {
	it("yields one entry per server in registry order, with null for a server no fixture reaches", () => {
		const servers = [
			{ id: "a", extensions: [".a"] },
			{ id: "b", extensions: [".b"] },
		];
		expect(
			probePopulation(servers, [{ lang: "a", file: "x.a" }]).map((e) => [
				e.server.id,
				e.fixture?.lang ?? null,
			]),
		).toEqual([
			["a", "a"],
			["b", null],
		]);
	});
});

describe("residentTreeBytes", () => {
	const walk = (root: number, pairs: [number, number][]) => {
		const out: number[] = [];
		const queue = [root];
		while (queue.length) {
			const cur = queue.shift() as number;
			for (const [pid, ppid] of pairs)
				if (ppid === cur) {
					out.push(pid);
					queue.push(pid);
				}
		}
		return out;
	};

	it("sums the server pid and every descendant", async () => {
		const total = await residentTreeBytes(100, {
			readProcessPairs: async () => [
				[101, 100],
				[102, 101],
				[300, 1],
			],
			sampleRss: async (pids) =>
				new Map(pids.map((p) => [p, p === 100 ? 10 : p === 101 ? 20 : 40])),
			walkDescendantPids: walk,
		});
		expect(total).toBe(70);
	});

	it("is null, never zero, when the process table is unreadable or the pid was not sampled", async () => {
		const unreadable = await residentTreeBytes(100, {
			readProcessPairs: async () => null,
			sampleRss: async () => new Map(),
			walkDescendantPids: walk,
		});
		expect(unreadable).toBeNull();
		const unsampled = await residentTreeBytes(100, {
			readProcessPairs: async () => [],
			sampleRss: async () => new Map([[999, 5]]),
			walkDescendantPids: walk,
		});
		expect(unsampled).toBeNull();
		expect(
			await residentTreeBytes(0, {
				readProcessPairs: async () => [],
				sampleRss: async () => new Map(),
				walkDescendantPids: walk,
			}),
		).toBeNull();
	});
});

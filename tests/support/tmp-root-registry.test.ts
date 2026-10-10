/**
 * The tmp-root registry's rules (#2912), driven over doubles for the decision
 * table and over the REAL shared setup for the wiring. The end-to-end reds live
 * in `tests/support/tmp-root-teardown.test.ts`; this file pins the seams whose
 * removal a child run could not tell apart:
 *
 *  - a swept entry dropped from the registry (AGENTS.md shape 47), which makes
 *    the SIGTERM sweep blind to a straggler that recreates the path;
 *  - a sweep that removes a root its file never removed, which turns the
 *    hygiene owner blind to every forgotten cleanup;
 *  - an interposer that is installed but never published to ESM importers, so
 *    `import * as fs` callers (most of the 454 raw `mkdtemp` files) go unseen.
 */
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import {
	MAX_TMP_ROOTS,
	createTmpRootRegistry,
	formatTmpRootCreators,
	formatTmpRootSweep,
	getTmpRootRegistry,
	installTmpRootInterposer,
	recordedTmpRootCreators,
	registerTmpRoot,
	sampleTmpRoots,
	sweepTmpRoots,
	type MkdtempTarget,
} from "./tmp-root-registry.js";

/** An in-memory filesystem: which paths exist, and what a remove does. */
function memoryIo(existing: string[]) {
	const present = new Set(existing);
	return {
		present,
		exists: (dir: string) => present.has(dir),
		remove: (dir: string) => void present.delete(dir),
	};
}

describe("tmp-root registry decisions (#2912)", () => {
	it("removes a registered root that still exists, whatever happened to its test", () => {
		const registry = createTmpRootRegistry();
		const io = memoryIo(["/tmp/pi-lens-a"]);
		registerTmpRoot(registry, "/tmp/pi-lens-a", "registered");
		const sweep = sweepTmpRoots(registry, io);
		expect(sweep.removed).toEqual([
			{ dir: "/tmp/pi-lens-a", kind: "registered" },
		]);
		expect(io.present.size).toBe(0);
	});

	it("does not report a recorded root that is already gone as removed", () => {
		const registry = createTmpRootRegistry();
		registerTmpRoot(registry, "/tmp/pi-lens-gone", "registered");
		const io = memoryIo([]);
		expect(sweepTmpRoots(registry, io)).toEqual({ removed: [], failed: [] });
	});

	it("keeps an observed root the file never removed and removes one it removed then saw return", () => {
		const registry = createTmpRootRegistry();
		const io = memoryIo(["/tmp/pi-lens-forgotten", "/tmp/pi-lens-straggler"]);
		registerTmpRoot(registry, "/tmp/pi-lens-forgotten", "observed");
		registerTmpRoot(registry, "/tmp/pi-lens-straggler", "observed");
		// The file removes one root; the setup's afterEach samples; a deferred
		// write brings it back.
		io.present.delete("/tmp/pi-lens-straggler");
		sampleTmpRoots(registry, io.exists);
		io.present.add("/tmp/pi-lens-straggler");
		const sweep = sweepTmpRoots(registry, io);
		expect(sweep.removed.map((r) => r.dir)).toEqual(["/tmp/pi-lens-straggler"]);
		expect([...io.present]).toEqual(["/tmp/pi-lens-forgotten"]);
	});

	it("keeps a swept root recorded so a later recreation is found by the next sweep", () => {
		const registry = createTmpRootRegistry();
		const io = memoryIo(["/tmp/pi-lens-a"]);
		registerTmpRoot(registry, "/tmp/pi-lens-a", "registered");
		sweepTmpRoots(registry, io);
		io.present.add("/tmp/pi-lens-a");
		expect(sweepTmpRoots(registry, io).removed).toHaveLength(1);
	});

	it("lets the harness claim win over an earlier observed record", () => {
		const registry = createTmpRootRegistry();
		registerTmpRoot(registry, "/tmp/pi-lens-a", "observed");
		registerTmpRoot(registry, "/tmp/pi-lens-a", "registered");
		expect(registry.roots.get("/tmp/pi-lens-a")?.kind).toBe("registered");
	});

	it("bounds the registry and counts what it dropped", () => {
		const registry = createTmpRootRegistry();
		for (let index = 0; index < MAX_TMP_ROOTS + 3; index++)
			registerTmpRoot(registry, `/tmp/pi-lens-${index}`, "observed");
		expect(registry.roots.size).toBe(MAX_TMP_ROOTS);
		expect(registry.dropped).toBe(3);
	});

	it("reports a removal that throws or leaves the root behind, and keeps sweeping", () => {
		const registry = createTmpRootRegistry();
		registerTmpRoot(registry, "/tmp/pi-lens-throws", "registered");
		registerTmpRoot(registry, "/tmp/pi-lens-stays", "registered");
		registerTmpRoot(registry, "/tmp/pi-lens-ok", "registered");
		const io = memoryIo([
			"/tmp/pi-lens-throws",
			"/tmp/pi-lens-stays",
			"/tmp/pi-lens-ok",
		]);
		const sweep = sweepTmpRoots(registry, {
			exists: io.exists,
			remove: (dir) => {
				if (dir === "/tmp/pi-lens-throws") throw new Error("EBUSY");
				if (dir !== "/tmp/pi-lens-stays") io.remove(dir);
			},
		});
		expect(sweep.failed).toEqual(["/tmp/pi-lens-throws", "/tmp/pi-lens-stays"]);
		expect(sweep.removed.map((r) => r.dir)).toEqual(["/tmp/pi-lens-ok"]);
	});

	it("writes one record per file, says nothing when there is nothing to say, and counts drops once", () => {
		const registry = createTmpRootRegistry();
		const nothing = { removed: [], failed: [] };
		expect(formatTmpRootSweep("a.test.ts", nothing, registry, "afterAll")).toBe(
			undefined,
		);
		registry.dropped = 2;
		expect(formatTmpRootSweep("a.test.ts", nothing, registry, "afterAll")).toBe(
			"[tmp-hygiene-sweep] tests/a.test.ts via=afterAll registered=0 stragglers=0 failed=0 dropped=2\n",
		);
		expect(formatTmpRootSweep("a.test.ts", nothing, registry, "SIGTERM")).toBe(
			undefined,
		);
		const swept = {
			removed: [
				{ dir: "/x", kind: "registered" as const },
				{ dir: "/y", kind: "observed" as const },
			],
			failed: ["/z"],
		};
		expect(formatTmpRootSweep("a.test.ts", swept, registry, "SIGTERM")).toBe(
			"[tmp-hygiene-sweep] tests/a.test.ts via=SIGTERM registered=1 stragglers=1 failed=1 dropped=0\n",
		);
	});
});

describe("tmp-root interposer (#2912)", () => {
	function fakeTarget() {
		const made: string[] = [];
		const target = {
			mkdtempSync: (prefix: string) => {
				made.push(`${prefix}AAAAAA`);
				return `${prefix}AAAAAA`;
			},
			mkdtemp: (
				prefix: string,
				done: (error: Error | null, dir?: string) => void,
			) => {
				done(
					prefix.includes("fail") ? new Error("EACCES") : null,
					`${prefix}BBBBBB`,
				);
			},
			promises: {
				mkdtemp: async (prefix: string) => `${prefix}CCCCCC`,
			},
		};
		return { target: target as unknown as MkdtempTarget, made };
	}

	it("records pi-lens roots directly under the tmpdir, from all three mkdtemp shapes", async () => {
		const registry = createTmpRootRegistry();
		const { target } = fakeTarget();
		installTmpRootInterposer(registry, target, "/var/tmp");
		(target.mkdtempSync as (p: string) => string)("/var/tmp/pi-lens-sync-");
		await new Promise<void>((resolve) =>
			(target.mkdtemp as (p: string, cb: () => void) => void)(
				"/var/tmp/pi-lens-cb-",
				resolve,
			),
		);
		await (target.promises.mkdtemp as (p: string) => Promise<string>)(
			"/var/tmp/pi-lens-promise-",
		);
		expect([...registry.roots.keys()].sort()).toEqual([
			"/var/tmp/pi-lens-cb-BBBBBB",
			"/var/tmp/pi-lens-promise-CCCCCC",
			"/var/tmp/pi-lens-sync-AAAAAA",
		]);
		expect(
			[...registry.roots.values()].every((e) => e.kind === "observed"),
		).toBe(true);
	});

	it("ignores other prefixes, nested directories, other parents and failed creates", () => {
		const registry = createTmpRootRegistry();
		const { target } = fakeTarget();
		installTmpRootInterposer(registry, target, "/var/tmp");
		const sync = target.mkdtempSync as (p: string) => string;
		sync("/var/tmp/other-");
		sync("/var/tmp/pi-lens-outer/pi-lens-nested-");
		sync("/home/user/pi-lens-elsewhere-");
		(target.mkdtemp as (p: string, cb: () => void) => void)(
			"/var/tmp/pi-lens-fail-",
			() => {},
		);
		expect(registry.roots.size).toBe(0);
	});

	it("returns exactly what the wrapped function returned", () => {
		const registry = createTmpRootRegistry();
		const { target } = fakeTarget();
		installTmpRootInterposer(registry, target, "/var/tmp");
		expect(
			(target.mkdtempSync as (p: string) => string)("/var/tmp/pi-lens-r-"),
		).toBe("/var/tmp/pi-lens-r-AAAAAA");
	});

	it("records the test file running when each entry appeared, one record per entry", () => {
		const registry = createTmpRootRegistry();
		const { target } = fakeTarget();
		installTmpRootInterposer(
			registry,
			target,
			"/var/tmp",
			() => "leaking.test.ts",
		);
		const sync = target.mkdtempSync as (p: string) => string;
		sync("/var/tmp/pi-lens-sync-");
		sync("/var/tmp/pi-lens-other-");
		expect(recordedTmpRootCreators(registry)).toEqual(
			new Map([
				["pi-lens-sync-AAAAAA", "leaking.test.ts"],
				["pi-lens-other-AAAAAA", "leaking.test.ts"],
			]),
		);
		// One line per entry, sorted: the record a worker appends for the
		// serialized owner is deterministic and never per mkdtemp call.
		expect(formatTmpRootCreators(registry)).toBe(
			"pi-lens-other-AAAAAA\tleaking.test.ts\npi-lens-sync-AAAAAA\tleaking.test.ts\n",
		);
		// The harness claim upgrades the kind but never rewrites the creator.
		registerTmpRoot(registry, "/var/tmp/pi-lens-sync-AAAAAA", "registered");
		expect(registry.roots.get("/var/tmp/pi-lens-sync-AAAAAA")?.createdBy).toBe(
			"leaking.test.ts",
		);
	});

	it("says nothing about creators when no interposer observed the creation", () => {
		const registry = createTmpRootRegistry();
		expect(formatTmpRootCreators(registry)).toBeUndefined();
		expect(recordedTmpRootCreators(registry).size).toBe(0);
	});
});

describe("tmp-root registry wiring in the shared setup (#2912)", () => {
	const spelled = (dir: string) => getTmpRootRegistry().roots.get(dir)?.kind;

	it("publishes the interposer to every way a test file spells mkdtemp", async () => {
		const viaNamespace = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-2912-live-ns-"),
		);
		const viaNamed = mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-2912-live-named-"),
		);
		const viaPromises = await fsp.mkdtemp(
			path.join(os.tmpdir(), "pi-lens-2912-live-promises-"),
		);
		const viaCallback = await new Promise<string>((resolve, reject) =>
			fs.mkdtemp(
				path.join(os.tmpdir(), "pi-lens-2912-live-cb-"),
				(error, dir) => (error ? reject(error) : resolve(dir)),
			),
		);
		try {
			expect(
				[viaNamespace, viaNamed, viaPromises, viaCallback].map(spelled),
			).toEqual(["observed", "observed", "observed", "observed"]);
		} finally {
			for (const dir of [viaNamespace, viaNamed, viaPromises, viaCallback])
				fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves a directory made by mkdirSync out of the registry", () => {
		const dir = path.join(os.tmpdir(), `pi-lens-2912-plain-${process.pid}`);
		fs.mkdirSync(dir);
		try {
			expect(spelled(dir)).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers setupTestEnvironment roots as harness-owned", () => {
		const env = setupTestEnvironment("pi-lens-2912-helper-");
		try {
			expect(spelled(env.tmpDir)).toBe("registered");
		} finally {
			env.cleanup();
		}
	});

	it("shares one registry across re-evaluated module copies", async () => {
		const before = getTmpRootRegistry();
		vi.resetModules();
		const copy = await import("./tmp-root-registry.js");
		expect(copy.getTmpRootRegistry()).toBe(before);
	});
});

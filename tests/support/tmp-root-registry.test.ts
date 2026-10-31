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
	formatTmpRootSweepRecords,
	getTmpRootRegistry,
	installTmpRootInterposer,
	recordedRepoRootDirs,
	recordedTmpRootCreators,
	registerRepoRootDir,
	registerTmpRoot,
	registerTmpSibling,
	sampleTmpRoots,
	sweepTmpRoots,
	type TmpRootFsTarget,
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

	// #4560 N2: sibling admissions share the roots budget; repeat observations
	// upgrade an unknown creator without replacing the first known creator.
	it("bounds siblings alongside roots and upgrades existing creators (#4560)", () => {
		const registry = createTmpRootRegistry();
		registerTmpRoot(registry, "/tmp/pi-lens-budget", "observed");
		registerTmpSibling(registry, "/tmp/repeated");
		registerTmpSibling(registry, "/tmp/repeated", "first.test.ts");
		registerTmpSibling(registry, "/tmp/repeated", "second.test.ts");
		expect(recordedTmpRootCreators(registry).get("repeated")).toBe(
			"first.test.ts",
		);
		for (let i = 0; i < MAX_TMP_ROOTS; i++)
			registerTmpSibling(registry, `/tmp/sibling-${i}`, "cap.test.ts");
		expect(registry.siblings.size).toBe(MAX_TMP_ROOTS - 1);
		expect(registry.dropped).toBe(2);
		registerTmpSibling(registry, "/tmp/repeated", "third.test.ts");
		expect(registry.dropped).toBe(2);
		expect(recordedTmpRootCreators(registry).get("repeated")).toBe(
			"first.test.ts",
		);
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
	// #4591: the census must tell "the registry held the root at sweep time and a
	// deferred writer recreated it" from "the interposer never recorded it". The
	// per-root record is that evidence; the cells are the four outcomes a sweep
	// can find, decided from the registry and the sweep alone.
	it("records what a sweep found at every registered root, one line per root (#4591)", () => {
		const registry = createTmpRootRegistry();
		registerTmpRoot(registry, "/tmp/pi-lens-removed", "registered");
		registerTmpRoot(registry, "/tmp/pi-lens-failed", "registered");
		registerTmpRoot(registry, "/tmp/pi-lens-gone", "registered");
		registerTmpRoot(registry, "/tmp/pi-lens-held", "observed");
		registerTmpRoot(registry, "/tmp/pi-lens-straggler", "observed");
		const io = memoryIo([
			"/tmp/pi-lens-removed",
			"/tmp/pi-lens-failed",
			"/tmp/pi-lens-held",
		]);
		// The straggler was seen absent after its file removed it, then recreated.
		registry.roots.get("/tmp/pi-lens-straggler")!.sawAbsent = true;
		io.present.add("/tmp/pi-lens-straggler");
		const sweep = sweepTmpRoots(registry, {
			exists: io.exists,
			remove: (dir) => {
				if (dir !== "/tmp/pi-lens-failed") io.remove(dir);
			},
		});
		expect(
			formatTmpRootSweepRecords(registry, sweep, "afterAll", 1234.4),
		).toEqual([
			"sweep:afterAll:pi-lens-removed\tregistered,removed,1234",
			"sweep:afterAll:pi-lens-failed\tregistered,failed,1234",
			"sweep:afterAll:pi-lens-gone\tregistered,absent,1234",
			"sweep:afterAll:pi-lens-held\tobserved,held,1234",
			"sweep:afterAll:pi-lens-straggler\tobserved,removed,1234",
		]);
		// A second hook is its own key, so both sweeps stay on record.
		expect(formatTmpRootSweepRecords(registry, sweep, "SIGTERM", 5)[0]).toBe(
			"sweep:SIGTERM:pi-lens-removed\tregistered,removed,5",
		);
		expect(
			formatTmpRootSweepRecords(
				createTmpRootRegistry(),
				{ removed: [], failed: [] },
				"afterAll",
				1,
			),
		).toEqual([]);
	});

	// #4864: the ledger is keyed by NAME, not path -- two workers that build the
	// same fixture name are the collision it records -- and the first creator
	// wins, exactly like the tmp-root entries.
	it("keeps one record per named repository-root directory (#4864)", () => {
		const registry = createTmpRootRegistry();
		registerRepoRootDir(registry, "/repo/.probe-a", "a.test.ts");
		registerRepoRootDir(registry, "/repo/.probe-a", "b.test.ts");
		registerRepoRootDir(registry, "/repo/.probe-b");
		expect(recordedRepoRootDirs(registry)).toEqual(
			new Map([
				[".probe-a", "a.test.ts"],
				[".probe-b", undefined],
			]),
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
				mkdir: async (dir: string) => dir,
			},
			mkdirSync: (dir: string) => dir,
			mkdir: (_dir: string, done: (error: Error | null) => void) => done(null),
		};
		return { target: target as unknown as TmpRootFsTarget, made };
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

	it("records a fixture sibling of ANY name created by mkdir, and only a direct tmp child (#4560)", () => {
		const registry = createTmpRootRegistry();
		const { target } = fakeTarget();
		installTmpRootInterposer(
			registry,
			target,
			"/var/tmp",
			() => "leaking.test.ts",
		);
		const mkdir = target.mkdirSync as (dir: string) => string;
		mkdir("/var/tmp/capture");
		mkdir("/var/tmp/capture/nested");
		mkdir("/home/user/elsewhere");
		expect(recordedTmpRootCreators(registry)).toEqual(
			new Map([["capture", "leaking.test.ts"]]),
		);
	});

	// #4560 N1: Node's created path may vary drive casing and separators.
	it("judges Windows created paths through the same parent comparison (#4560)", () => {
		const registry = createTmpRootRegistry();
		const { target } = fakeTarget();
		target.mkdirSync = (() => path.win32.join("c:/TEMP", "made")) as never;
		installTmpRootInterposer(
			registry,
			target,
			"C:\\Temp",
			() => "windows.test.ts",
		);
		(target.mkdirSync as (p: string, o: { recursive: boolean }) => unknown)(
			"C:/Temp/made/src",
			{ recursive: true },
		);
		expect([...registry.siblings.values()]).toEqual([
			{ createdBy: "windows.test.ts" },
		]);
	});

	it("judges canonical parent aliases through setup-owned fs (#3703)", () => {
		// V1: retain realpath alias equivalence without preloading clients/path-utils.
		const env = setupTestEnvironment("pi-lens-4560-alias-");
		try {
			const real = path.join(env.tmpDir, "real");
			const alias = path.join(env.tmpDir, "alias");
			fs.mkdirSync(real);
			fs.symlinkSync(real, alias, "junction");
			const registry = createTmpRootRegistry();
			const { target } = fakeTarget();
			installTmpRootInterposer(registry, target, alias, () => "alias.test.ts");
			(target.mkdirSync as (p: string) => unknown)(path.join(real, "made"));
			expect([...registry.siblings.values()]).toEqual([
				{ createdBy: "alias.test.ts" },
			]);
		} finally {
			env.cleanup();
		}
	});

	// #4864: a directory NAMED directly at the repository root is recorded, so the
	// serialized owner can fail the CREATION even when the cell removes it before
	// the run ends (the leftover census cannot see a transient tree). #4867: a
	// `mkdtemp` root at that root is the SAME shape to a repo-walking scan, so it
	// is recorded too -- its unique name does not shorten the window in which the
	// scan lists it and the cell removes it.
	it("records a directory created directly at the watched repository root, whatever made it (#4864, #4867)", async () => {
		const registry = createTmpRootRegistry();
		const { target } = fakeTarget();
		const repoRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-4864-root-"),
		);
		try {
			installTmpRootInterposer(
				registry,
				target,
				"/var/tmp",
				() => "named.test.ts",
				repoRoot,
			);
			const mkdirSync = target.mkdirSync as (dir: string) => string;
			mkdirSync(path.join(repoRoot, ".probe-language-roots"));
			// Not the repository root: a child of that fixture, a tmp-root sibling,
			// and a `mkdtemp` root INSIDE the fixture all stay out of the ledger.
			mkdirSync(path.join(repoRoot, ".probe-language-roots", "packages"));
			mkdirSync("/var/tmp/capture");
			const sync = target.mkdtempSync as (p: string) => string;
			sync(path.join(repoRoot, "pi-lens-unique-"));
			sync(path.join(repoRoot, ".probe-language-roots", "pi-lens-nested-"));
			// All three `mkdtemp` shapes, because each is its own call site in the
			// interposer and a fix at one of them leaves the other two open.
			await new Promise<void>((resolve) =>
				(target.mkdtemp as (p: string, cb: () => void) => void)(
					path.join(repoRoot, "pi-lens-cb-"),
					resolve,
				),
			);
			await (target.promises.mkdtemp as (p: string) => Promise<string>)(
				path.join(repoRoot, "pi-lens-promise-"),
			);
			expect(recordedRepoRootDirs(registry)).toEqual(
				new Map([
					[".probe-language-roots", "named.test.ts"],
					["pi-lens-unique-AAAAAA", "named.test.ts"],
					["pi-lens-cb-BBBBBB", "named.test.ts"],
					["pi-lens-promise-CCCCCC", "named.test.ts"],
				]),
			);
			expect(formatTmpRootCreators(registry)).toBe(
				"capture\tnamed.test.ts\n" +
					"repo-root:.probe-language-roots\tnamed.test.ts\n" +
					"repo-root:pi-lens-cb-BBBBBB\tnamed.test.ts\n" +
					"repo-root:pi-lens-promise-CCCCCC\tnamed.test.ts\n" +
					"repo-root:pi-lens-unique-AAAAAA\tnamed.test.ts\n",
			);
		} finally {
			fs.rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("returns exactly what the wrapped function returned", () => {
		const registry = createTmpRootRegistry();
		const { target } = fakeTarget();
		installTmpRootInterposer(registry, target, "/var/tmp");
		expect(
			(target.mkdtempSync as (p: string) => string)("/var/tmp/pi-lens-r-"),
		).toBe("/var/tmp/pi-lens-r-AAAAAA");
	});

	// #4560 F3, both directions over REAL filesystem calls: the census used to
	// judge the REQUESTED path, so the ancestor a recursive `mkdir` created at
	// the tmp root was observed and never judged, and a recursive re-mkdir of a
	// directory another process made was blamed on this test. `fs.mkdirSync`
	// returns the FIRST directory it created, and nothing when it created none.
	it("judges the ancestor a recursive mkdir created, and records nothing when it created none (#4560)", async () => {
		const root = fs.realpathSync(
			mkdtempSync(path.join(os.tmpdir(), "pi-lens-4560-rec-")),
		);
		const registry = createTmpRootRegistry();
		const target = {
			mkdtempSync: fs.mkdtempSync,
			mkdtemp: fs.mkdtemp,
			mkdirSync: fs.mkdirSync,
			mkdir: fs.mkdir,
			promises: { mkdtemp: fsp.mkdtemp, mkdir: fsp.mkdir },
		} as unknown as TmpRootFsTarget;
		installTmpRootInterposer(registry, target, root, () => "recursive.test.ts");
		const mkdirSync = target.mkdirSync as (
			dir: string,
			options?: { recursive?: boolean },
		) => string | undefined;
		try {
			// The requested path is `<root>/rec/src`; what the call CREATED at the
			// tmp root is `rec`, and that is the entry the census must judge.
			expect(
				mkdirSync(path.join(root, "rec", "src"), { recursive: true }),
			).toBe(path.join(root, "rec"));
			expect(recordedTmpRootCreators(registry)).toEqual(
				new Map([["rec", "recursive.test.ts"]]),
			);
			// A recursive re-mkdir of an existing child creates nothing, so it is a
			// no-op. A directory that was already there and this call did not make —
			// another writer's, or one the run's baseline already held — is never
			// attributed to this file (#4560 F3, second direction).
			fs.mkdirSync(path.join(root, "foreign"));
			mkdirSync(path.join(root, "rec"), { recursive: true });
			mkdirSync(path.join(root, "foreign"), { recursive: true });
			expect(recordedTmpRootCreators(registry).has("foreign")).toBe(false);
			// #4560 N4: callback recursive mkdir also reports its first-created path.
			await new Promise<void>((resolve, reject) => {
				(target.mkdir as typeof fs.mkdir)(
					path.join(root, "callback", "nested"),
					{ recursive: true },
					(error) => (error ? reject(error) : resolve()),
				);
			});
			expect(recordedTmpRootCreators(registry).get("callback")).toBe(
				"recursive.test.ts",
			);
			// The promise form reports the same first-created path.
			await (
				target.promises.mkdir as (
					dir: string,
					options?: { recursive?: boolean },
				) => Promise<string | undefined>
			)(path.join(root, "promised", "nested"), { recursive: true });
			expect(recordedTmpRootCreators(registry)).toEqual(
				new Map([
					["rec", "recursive.test.ts"],
					["callback", "recursive.test.ts"],
					["promised", "recursive.test.ts"],
				]),
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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

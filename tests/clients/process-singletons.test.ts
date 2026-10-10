/**
 * #2146 — state that must exist once per PROCESS must survive a second
 * evaluation of the pi-lens module graph.
 *
 * pi evaluates the graph up to nine times in one pid (dogfood pass 3: one host
 * emitted `host_boot` nine times). `vi.resetModules()` plus a dynamic import is
 * the standard in-repo way to reproduce that: it gives the test a genuinely
 * second module instance of the file under test, exactly as pi's second
 * evaluation does.
 *
 * Every import here uses the `.js` specifier — the artifact the runtime loads
 * (catalog shape 14). A `.ts` spelling would give this file a private module
 * copy and the assertions would pass without observing production state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { removeTempDirSync } from "./test-utils.js";

// Seeded before any module import so the mocked `getGlobalPiLensDir` never
// returns `undefined` to a log-file module that resolves its path at module
// scope. The registry suite re-points it at a per-test dir.
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2146-base-"));
let dir: string = baseDir;

afterAll(() => removeTempDirSync(baseDir));

vi.mock("../../clients/file-utils.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/file-utils.js")>();
	return { ...actual, getGlobalPiLensDir: () => dir };
});

type SessionLifecycleModule =
	typeof import("../../clients/session-lifecycle.js");
type InstanceRegistryModule =
	typeof import("../../clients/instance-registry.js");
type StartupTimingModule = typeof import("../../clients/startup-timing.js");

/** A ctx whose `isIdle` probe throws the SDK's stale-ctx error. */
function staleCtx(): unknown {
	return {
		isIdle: () => {
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		},
	};
}

async function freshEvaluation<T>(specifier: string): Promise<T> {
	vi.resetModules();
	return (await import(specifier)) as T;
}

describe("#2146 — session-lifecycle registration is one per process", () => {
	beforeEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	afterEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	it("a second module evaluation sees the first evaluation's registered primary", async () => {
		const first = await freshEvaluation<SessionLifecycleModule>(
			"../../clients/session-lifecycle.js",
		);
		const hostRoot = path.join(os.tmpdir(), "pi-lens-2146-host");
		first.registerPrimarySession(staleCtx(), "host-session", hostRoot);

		// pi's SECOND evaluation of the same graph. Before #2146 this module got a
		// fresh, empty registration here, so the subagent temp root below read
		// `hasPrior === false`, classified `primary`, and ran the full
		// session_start battery the #473/#2129/#2133 guard exists to decline.
		const second = await freshEvaluation<SessionLifecycleModule>(
			"../../clients/session-lifecycle.js",
		);
		expect(second).not.toBe(first);

		expect(second.getActiveSessionId()).toBe("host-session");
		expect(second.getActivePrimaryRoot()).toBeDefined();

		const tempRoot = path.join(os.tmpdir(), "pi-lens-2146-subagent-temp");
		const decision = second.decideSessionStart(
			staleCtx(),
			"subagent-session",
			tempRoot,
		);
		expect(decision.classification).toBe("secondary-root");
		expect(decision.runFullSessionStart).toBe(false);
	});

	it("a secondary registered by one evaluation is counted by the other", async () => {
		const first = await freshEvaluation<SessionLifecycleModule>(
			"../../clients/session-lifecycle.js",
		);
		first.registerPrimarySession(staleCtx(), "host-session", os.tmpdir());
		first.registerSecondarySession();

		const second = await freshEvaluation<SessionLifecycleModule>(
			"../../clients/session-lifecycle.js",
		);
		expect(second.getSecondarySessionCount()).toBe(1);

		// And the release path clears the PROCESS registration, not a local copy.
		second.releasePrimarySession();
		expect(first.getActiveSessionId()).toBeUndefined();
		expect(first.getSecondarySessionCount()).toBe(0);
	});

	it("the test reset clears the process state both evaluations read", async () => {
		const first = await freshEvaluation<SessionLifecycleModule>(
			"../../clients/session-lifecycle.js",
		);
		first.registerPrimarySession(staleCtx(), "host-session", os.tmpdir());
		const second = await freshEvaluation<SessionLifecycleModule>(
			"../../clients/session-lifecycle.js",
		);
		second._resetSessionLifecycleForTests();
		expect(first.getActiveSessionId()).toBeUndefined();
		expect(first.getActivePrimaryRoot()).toBeUndefined();
	});
});

describe("#2146 — the registry mutation tail is one per process", () => {
	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2146-reg-"));
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	afterEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
		removeTempDirSync(dir);
	});

	it("concurrent mutations from two module evaluations do not lose an update", async () => {
		const first = await freshEvaluation<InstanceRegistryModule>(
			"../../clients/instance-registry.js",
		);
		const hostRoot = path.join(dir, "host");
		fs.mkdirSync(hostRoot, { recursive: true });
		await first.registerInstance(hostRoot);
		await first._settleRegistryMutationsForTests();

		const second = await freshEvaluation<InstanceRegistryModule>(
			"../../clients/instance-registry.js",
		);
		expect(second).not.toBe(first);

		const rootA = path.join(dir, "temp-a");
		const rootB = path.join(dir, "temp-b");
		fs.mkdirSync(rootA, { recursive: true });
		fs.mkdirSync(rootB, { recursive: true });

		// Both evaluations mutate at once. With one shared tail these serialize,
		// so the second read sees the first write. With one tail per evaluation
		// they both read the pre-mutation file and the later write reverts the
		// earlier one — the torn read-modify-write that lost two project roots
		// and one live instance from `instances.json` in the dogfood run.
		await Promise.all([
			first.registerInstanceRoot(rootA, "holder-a"),
			second.registerInstanceRoot(rootB, "holder-b"),
		]);
		await first._settleRegistryMutationsForTests();
		await second._settleRegistryMutationsForTests();

		const file = JSON.parse(
			fs.readFileSync(path.join(dir, "instances.json"), "utf8"),
		) as { instances: Array<{ pid: number; projectRoots?: string[] }> };
		const entry = file.instances.find((e) => e.pid === process.pid);
		expect(entry).toBeDefined();
		const roots = (entry?.projectRoots ?? []).map((root) =>
			path.basename(root),
		);
		expect(roots).toContain("temp-a");
		expect(roots).toContain("temp-b");
	});

	it("both evaluations queue onto the same tail, so a settle from one awaits the other", async () => {
		const first = await freshEvaluation<InstanceRegistryModule>(
			"../../clients/instance-registry.js",
		);
		const hostRoot = path.join(dir, "host");
		fs.mkdirSync(hostRoot, { recursive: true });
		await first.registerInstance(hostRoot);
		await first._settleRegistryMutationsForTests();

		const second = await freshEvaluation<InstanceRegistryModule>(
			"../../clients/instance-registry.js",
		);
		const lateRoot = path.join(dir, "late");
		fs.mkdirSync(lateRoot, { recursive: true });

		// Queue on `second`, settle through `first`. One tail means this waits;
		// two tails mean it returns before the write lands.
		void second.registerInstanceRoot(lateRoot, "holder-late");
		await first._settleRegistryMutationsForTests();

		const file = JSON.parse(
			fs.readFileSync(path.join(dir, "instances.json"), "utf8"),
		) as { instances: Array<{ pid: number; projectRoots?: string[] }> };
		const entry = file.instances.find((e) => e.pid === process.pid);
		expect((entry?.projectRoots ?? []).map((r) => path.basename(r))).toContain(
			"late",
		);
	});

	it("re-reads and merges registrations when independent writers lose an update", async () => {
		let releaseFirstWrite: () => void = () => {};
		let firstWriteStarted!: () => void;
		const firstWriteReady = new Promise<void>((resolve) => {
			firstWriteStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		let writes = 0;
		vi.doMock("../../clients/atomic-write.js", async (importOriginal) => {
			const actual =
				await importOriginal<typeof import("../../clients/atomic-write.js")>();
			return {
				...actual,
				writeFileAtomicAsync: async (
					...args: Parameters<typeof actual.writeFileAtomicAsync>
				) => {
					writes++;
					if (writes === 1) {
						firstWriteStarted();
						await gate;
					}
					return actual.writeFileAtomicAsync(...args);
				},
			};
		});
		const first = await freshEvaluation<InstanceRegistryModule>(
			"../../clients/instance-registry.js",
		);
		// Deliberately model two independent processes: each has its own
		// in-process tail, while both point at the same registry file.
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
		const second = await freshEvaluation<InstanceRegistryModule>(
			"../../clients/instance-registry.js",
		);
		fs.mkdirSync(path.join(dir, "root-a"), { recursive: true });
		fs.mkdirSync(path.join(dir, "root-b"), { recursive: true });
		const originalPid = process.pid;
		const pidDescriptor = Object.getOwnPropertyDescriptor(process, "pid");
		try {
			Object.defineProperty(process, "pid", { value: 21731 });
			const firstRegistration = first.registerInstance(
				path.join(dir, "root-a"),
			);
			await firstWriteReady;
			Object.defineProperty(process, "pid", { value: 21732 });
			const secondRegistration = second.registerInstance(
				path.join(dir, "root-b"),
			);
			releaseFirstWrite();
			await Promise.all([firstRegistration, secondRegistration]);

			const entries = JSON.parse(
				fs.readFileSync(path.join(dir, "instances.json"), "utf8"),
			).instances as Array<{ pid: number; projectRoot: string }>;
			expect(entries.map((entry) => entry.pid)).toEqual(
				expect.arrayContaining([21731, 21732]),
			);
			expect(
				entries.find((entry) => entry.pid === 21731)?.projectRoot,
			).toContain("root-a");
			expect(
				entries.find((entry) => entry.pid === 21732)?.projectRoot,
			).toContain("root-b");
		} finally {
			releaseFirstWrite();
			vi.doUnmock("../../clients/atomic-write.js");
			if (pidDescriptor) Object.defineProperty(process, "pid", pidDescriptor);
			else Object.defineProperty(process, "pid", { value: originalPid });
		}
	});
});

describe("#2146 — host_boot carries the module-evaluation ordinal", () => {
	beforeEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	afterEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	it("the ordinal advances once per module evaluation", async () => {
		const first = await freshEvaluation<StartupTimingModule>(
			"../../clients/startup-timing.js",
		);
		expect(first.PI_LENS_EVALUATION_ORDINAL).toBe(1);

		const second = await freshEvaluation<StartupTimingModule>(
			"../../clients/startup-timing.js",
		);
		expect(second.PI_LENS_EVALUATION_ORDINAL).toBe(2);

		const hostBoot = second
			.buildStartupTimingRecords({ loadMs: 10, evalMs: 4 })
			.find((record) => record.phase === "host_boot");
		expect(hostBoot?.metadata?.evaluationOrdinal).toBe(2);
	});

	it("index.ts emits the startup records through the builder", async () => {
		// The builder is the production path, so pin that index.ts routes through
		// it rather than re-emitting `host_boot` inline without the ordinal.
		const source = fs.readFileSync(
			path.join(import.meta.dirname, "..", "..", "index.ts"),
			"utf8",
		);
		expect(source).toContain("buildStartupTimingRecords(");
		expect(source).not.toContain('phase: "host_boot"');
	});
});

describe("#2146 — the versioned adopt-or-reset protocol", () => {
	beforeEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
		const ledger = await import("../../clients/degradation-ledger.js");
		ledger.resetDegradationLedger();
	});

	afterEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	it("adopts a cell written at the same version", async () => {
		const singletons = await import("../../clients/process-singletons.js");
		const a = singletons.getProcessSingleton("fam", 1, () => ({ n: 1 }));
		a.n = 7;
		const b = singletons.getProcessSingleton("fam", 1, () => ({ n: 1 }));
		expect(b).toBe(a);
		expect(b.n).toBe(7);
	});

	it("discards an OLDER-version cell and records one bounded degradation", async () => {
		const singletons = await import("../../clients/process-singletons.js");
		const ledger = await import("../../clients/degradation-ledger.js");
		singletons._seedProcessSingletonCellForTests("fam", {
			schema: "pi-lens.process-singletons",
			version: 1,
			value: { legacy: true },
		});

		const fresh = singletons.getProcessSingleton("fam", 2, () => ({ n: 0 }));
		expect(fresh).toEqual({ n: 0 });

		// Bounded: nine evaluations must not write nine rows.
		singletons.getProcessSingleton("fam", 2, () => ({ n: 0 }));

		// The ledger PULLS the reset log at read time; `process-singletons.ts` is
		// a dependency leaf and never pushes into the ledger (see its header).
		const group = ledger
			.getDegradationSummary()
			.find((g) => g.kind === singletons.PROCESS_SINGLETON_RESET_KIND);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe("fam");
	});

	it("declines a NEWER-version cell rather than mis-reading it", async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._seedProcessSingletonCellForTests("fam", {
			schema: "pi-lens.process-singletons",
			version: 99,
			value: { fromTheFuture: true },
		});
		const fresh = singletons.getProcessSingleton("fam", 1, () => ({ n: 5 }));
		expect(fresh).toEqual({ n: 5 });
	});

	it("declines a cell carrying a foreign schema", async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._seedProcessSingletonCellForTests("fam", {
			schema: "someone-elses.container",
			version: 1,
			value: { n: 42 },
		});
		const fresh = singletons.getProcessSingleton("fam", 1, () => ({ n: 5 }));
		expect(fresh).toEqual({ n: 5 });
	});
});

// --- Fix round 1 ---

describe("#2146 F1 — a subagent shutdown must not clear the shared registration", () => {
	beforeEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	afterEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	/**
	 * The #2146 dogfood state, exactly: the host's ctx is already invalidated,
	 * which is WHY `secondary-root` fires on the start side. `decideSessionStart`
	 * grew a root discriminator for that; `noteSessionShutdown` did not, so a
	 * subagent's teardown read "the primary's ctx is dead, so I must be the
	 * primary" and index.ts's primary path wiped the shared registration.
	 */
	it("a subagent shutdown in a different root classifies secondary", async () => {
		const lifecycle = await import("../../clients/session-lifecycle.js");
		const hostRoot = path.join(baseDir, "host");
		lifecycle.registerPrimarySession(staleCtx(), "host-session", hostRoot);

		const subRoot = path.join(baseDir, "subagent-1");
		expect(lifecycle.noteSessionShutdown(staleCtx(), "sub-1", subRoot)).toBe(
			"secondary",
		);
	});

	it("the registration survives one subagent teardown, so the NEXT subagent still declines", async () => {
		const lifecycle = await import("../../clients/session-lifecycle.js");
		const hostRoot = path.join(baseDir, "host");
		lifecycle.registerPrimarySession(staleCtx(), "host-session", hostRoot);

		// Sub 1 tears down. index.ts only reaches `releasePrimarySession()` on the
		// primary path, so classifying this shutdown correctly is what keeps the
		// registration alive.
		const classification = lifecycle.noteSessionShutdown(
			staleCtx(),
			"sub-1",
			path.join(baseDir, "subagent-1"),
		);
		if (classification === "primary") lifecycle.releasePrimarySession();

		expect(lifecycle.getActiveSessionId()).toBe("host-session");

		// Sub 2 arrives after sub 1 left. Pre-fix this classified `primary` and
		// ran the full session_start battery again.
		const decision = lifecycle.decideSessionStart(
			staleCtx(),
			"sub-2",
			path.join(baseDir, "subagent-2"),
		);
		expect(decision.classification).toBe("secondary-root");
		expect(decision.runFullSessionStart).toBe(false);
	});

	// Positive control: the fix must not turn the primary's own teardown into a
	// no-op. Without this the change could pass by classifying everything
	// secondary, which leaks the LSP fleet on every clean exit (#472).
	it("the primary's own shutdown in its own root still classifies primary and releases", async () => {
		const lifecycle = await import("../../clients/session-lifecycle.js");
		const hostRoot = path.join(baseDir, "host");
		lifecycle.registerPrimarySession(staleCtx(), "host-session", hostRoot);

		expect(
			lifecycle.noteSessionShutdown(staleCtx(), "host-session", hostRoot),
		).toBe("primary");
		lifecycle.releasePrimarySession();
		expect(lifecycle.getActiveSessionId()).toBeUndefined();
	});

	it("a shutdown with an unknown root leaves today's verdict untouched", async () => {
		// Fail-safe direction: `undefined` means "root unknown", never
		// "different root", so it must not manufacture a secondary verdict.
		const lifecycle = await import("../../clients/session-lifecycle.js");
		lifecycle.registerPrimarySession(
			staleCtx(),
			"host-session",
			path.join(baseDir, "host"),
		);
		expect(lifecycle.noteSessionShutdown(staleCtx(), "other-session")).toBe(
			"primary",
		);
	});

	it("index.ts hands the shutdown classifier the session's own root", async () => {
		const source = fs.readFileSync(
			path.join(import.meta.dirname, "..", "..", "index.ts"),
			"utf8",
		);
		expect(source).toMatch(
			/classifyOwnedSessionShutdown\([\s\S]{0,160}shutdownCwd/,
		);
	});
});

describe("#2146 F2 — the reset log's own family cannot recurse", () => {
	beforeEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	afterEach(async () => {
		const singletons = await import("../../clients/process-singletons.js");
		singletons._resetProcessSingletonsForTests();
	});

	it("an incompatible reset-log cell degrades bounded instead of blowing the stack", async () => {
		const singletons = await import("../../clients/process-singletons.js");
		// Two builds meet, and the RESET LOG itself is one of the families whose
		// shape changed. Recording that family's own reset re-enters the log,
		// which is incompatible again — unbounded recursion without the guard.
		singletons._seedProcessSingletonCellForTests(
			singletons.PROCESS_SINGLETON_RESET_LOG_FAMILY,
			{ schema: "pi-lens.process-singletons", version: 99, value: {} },
		);
		singletons._seedProcessSingletonCellForTests("fam", {
			schema: "pi-lens.process-singletons",
			version: 99,
			value: { legacy: true },
		});

		expect(() =>
			singletons.getProcessSingleton("fam", 1, () => ({ n: 3 })),
		).not.toThrow();
		expect(singletons.getProcessSingleton("fam", 1, () => ({ n: 3 }))).toEqual({
			n: 3,
		});
		// The ordinary family's reset is still recorded; the log's own is not,
		// because the log it would be written to is the thing being discarded.
		const families = singletons
			.getProcessSingletonResets()
			.map((entry) => entry.family);
		expect(families).toEqual(["fam"]);
	});
});

/**
 * #2423 — the in-process mutation bridge, sibling of `clients/read-bridge.ts`.
 *
 * These tests drive the bridge against a REAL `RuntimeCoordinator` and a REAL
 * `CacheManager`, so what they assert is the durable turn state and change log
 * a later phase actually reads, not a spy's call log.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	MUTATION_BRIDGE_KEY,
	getMutationBridge,
	isValidMutationEntry,
	recordMutationThroughSeam,
	registerMutationBridge,
	type MutationBridgeDeps,
} from "../../clients/mutation-bridge.js";
import {
	_observedMutationStateForTests,
	resetObservedMutationNet,
} from "../../clients/observed-mutation.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { retireScope } from "../../clients/session-scope.js";
import { setupTestEnvironment } from "./test-utils.js";

const SOURCE = ["import a from 'a';", "const b = 2;", "const c = 3;", ""].join(
	"\n",
);

function makeDeps(args: {
	tmpDir: string;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	isRecordable?: (filePath: string) => boolean;
	shouldStampReadGuard?: () => boolean;
}): MutationBridgeDeps {
	return {
		getRuntime: () => args.runtime as never,
		getCacheManager: () => args.cacheManager,
		getProjectRoot: () => args.tmpDir,
		getDispatchCwd: () => args.tmpDir,
		countFileLines,
		isRecordable: args.isRecordable ?? (() => true),
		shouldStampReadGuard: args.shouldStampReadGuard,
		dbg: () => {},
	};
}

describe("mutation bridge payload validation", () => {
	it("accepts a well-formed entry", () => {
		expect(
			isValidMutationEntry({
				filePath: "/a.ts",
				kind: "edit",
				editRanges: [[2, 4]],
				consumer: "x",
			}),
		).toBe(true);
	});

	it("rejects malformed entries rather than recording a guess", () => {
		expect(isValidMutationEntry(null)).toBe(false);
		expect(isValidMutationEntry({ filePath: "", kind: "edit" })).toBe(false);
		expect(isValidMutationEntry({ filePath: "/a.ts", kind: "patch" })).toBe(
			false,
		);
		expect(
			isValidMutationEntry({ filePath: "/a.ts", kind: "edit", editRanges: [] }),
		).toBe(false);
		expect(
			isValidMutationEntry({
				filePath: "/a.ts",
				kind: "edit",
				touchedLines: [4, 2],
			}),
		).toBe(false);
		expect(
			isValidMutationEntry({
				filePath: "/a.ts",
				kind: "edit",
				touchedLines: [0, 2],
			}),
		).toBe(false);
	});
});

describe("mutation bridge bookkeeping", () => {
	it("writes turn state, an attributed change-log entry, and a deferred queue entry", () => {
		const env = setupTestEnvironment("pi-lens-2423-bridge-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "bridged.ts");
			fs.writeFileSync(filePath, SOURCE);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-bridge" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const accepted = recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					editRanges: [
						[2, 2],
						[3, 3],
					],
					consumer: "my-extension",
				},
				makeDeps({ tmpDir: env.tmpDir, runtime, cacheManager }),
			);

			expect(accepted).toBe(true);

			const files = Object.keys(
				cacheManager.readTurnState(env.tmpDir).files ?? {},
			);
			expect(files).toHaveLength(1);
			expect(files[0]).toContain("bridged.ts");

			// One change-log entry, attributed to the producer rather than folded
			// onto agent-edit, carrying the bounding box of the recorded ranges.
			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{
					source: "agent-tool:my-extension",
					filePath,
					changedRange: { start: 2, end: 3 },
				},
			]);

			// Deferred, never immediate.
			expect(runtime.pendingDeferredFormatCount).toBe(1);
			const queued = runtime.consumeDeferredFormatFiles();
			expect(queued[0].kinds).toEqual(new Set(["autofix", "format"]));
			expect(queued[0].toolNames).toEqual(new Set(["my-extension"]));
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("treats a write with no stated range as the whole file", () => {
		const env = setupTestEnvironment("pi-lens-2423-bridge-write-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "whole.ts");
			fs.writeFileSync(filePath, SOURCE);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-bridge-write" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			recordMutationThroughSeam(
				{ filePath, kind: "write", consumer: "my-extension" },
				makeDeps({ tmpDir: env.tmpDir, runtime, cacheManager }),
			);

			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{ changedRange: { start: 1, end: countFileLines(filePath) } },
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("#2465: under no-read-guard, a recordable write still gets turn-state + receipt + the observed-handled mark, but skips only the read-guard stamp", () => {
		const env = setupTestEnvironment("pi-lens-2465-no-read-guard-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "noguard.ts");
			fs.writeFileSync(filePath, SOURCE);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-bridge-no-read-guard" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			// #2423's own recordability gate (`isRecordable`) is the wiring
			// `index.ts` produces AFTER #2465: path-scope only, no `no-read-guard`
			// clause. `shouldStampReadGuard` is the live `getLensFlag("no-read-guard")`
			// read `index.ts` threads separately — `false` here is the
			// `--no-read-guard` case under test.
			const recordWrittenSpy = vi.spyOn(runtime.readGuard, "recordWritten");
			resetObservedMutationNet();

			const accepted = recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					touchedLines: [1, 2],
					consumer: "my-extension",
				},
				makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager,
					isRecordable: () => true,
					shouldStampReadGuard: () => false,
				}),
			);

			expect(accepted).toBe(true);

			// The stamp alone is suppressed.
			expect(recordWrittenSpy).not.toHaveBeenCalled();

			// Turn-state, the change-log receipt, and the deferred format queue —
			// none of them consult the flag — are all still present.
			const files = Object.keys(
				cacheManager.readTurnState(env.tmpDir).files ?? {},
			);
			expect(files).toHaveLength(1);
			expect(files[0]).toContain("noguard.ts");
			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{ source: "agent-tool:my-extension", filePath },
			]);
			expect(runtime.pendingDeferredFormatCount).toBe(1);

			// The observed-mutation net's handled mark (#2430/#2449) — reached
			// only when `isRecordable` lets the call through the early return —
			// is present too, so the `agent_settled` sweep re-baselines this file
			// instead of reporting it as unattributed drift.
			expect(_observedMutationStateForTests().handled).toContain(
				normalizeMapKey(path.resolve(filePath)),
			);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			resetObservedMutationNet();
			env.cleanup();
		}
	});

	it("drops an out-of-scope path without touching any store", () => {
		const env = setupTestEnvironment("pi-lens-2423-bridge-scope-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "ignored.ts");
			fs.writeFileSync(filePath, SOURCE);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-bridge-scope" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const accepted = recordMutationThroughSeam(
				{ filePath, kind: "edit", touchedLines: [1, 2] },
				makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager,
					isRecordable: () => false,
				}),
			);

			expect(accepted).toBe(false);
			expect(
				Object.keys(cacheManager.readTurnState(env.tmpDir).files ?? {}),
			).toHaveLength(0);
			expect(readChangesSince(env.tmpDir, 0)).toEqual([]);
			expect(runtime.pendingDeferredFormatCount).toBe(0);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("never lets a bookkeeping failure escape to the producer", () => {
		const env = setupTestEnvironment("pi-lens-2423-bridge-throw-");
		try {
			const filePath = path.join(env.tmpDir, "boom.ts");
			fs.writeFileSync(filePath, SOURCE);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const deps = makeDeps({
				tmpDir: env.tmpDir,
				runtime,
				cacheManager: {
					addModifiedRange: () => {
						throw new Error("turn state exploded");
					},
				} as never,
			});
			expect(() =>
				recordMutationThroughSeam({ filePath, kind: "write" }, deps),
			).not.toThrow();
			expect(recordMutationThroughSeam({ filePath, kind: "write" }, deps)).toBe(
				false,
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("#3677: a foreign readGuardBranchEpoch cannot poison a deferred record", () => {
	// Recurrence: #3669 taught `deferMutation` to merge epochs with `Math.max`,
	// and the bridge forwarded a foreign `entry.readGuardBranchEpoch` into that
	// merge without validation. NaN, a negative, a fraction, and a non-number
	// all poisoned (or were misread by) the legitimate record. Round 1's upper
	// bound then misread a genuine prior-session capture as "from the future"
	// and credited it to the new session (F1, covered below).
	const malformed: ReadonlyArray<readonly [string, string, unknown]> = [
		["a NaN", "nan", Number.NaN],
		["a negative", "negative", -1],
		["a fractional", "fraction", 1.5],
		["a string", "string", "5"],
	];

	for (const [label, slug, value] of malformed) {
		it(`ignores ${label} epoch and still credits the write`, () => {
			const env = setupTestEnvironment(`pi-lens-3677-${slug}-`);
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			resetDegradationLedger();
			try {
				const filePath = path.join(env.tmpDir, "epoch.ts");
				fs.writeFileSync(filePath, SOURCE);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.setTelemetryIdentity({ sessionId: `s-3677-${slug}` });
				runtime.beginTurn();
				const cacheManager = new CacheManager(false);
				const deps = makeDeps({ tmpDir: env.tmpDir, runtime, cacheManager });

				// A legitimate record first, so the foreign value has something to
				// merge into. Epoch 0 is current on a fresh session.
				expect(
					recordMutationThroughSeam(
						{
							filePath,
							kind: "edit",
							touchedLines: [1, 2],
							consumer: "legit",
							readGuardBranchEpoch: 0,
						},
						deps,
					),
				).toBe(true);

				// The foreign value arrives on a second touch of the same path.
				expect(
					recordMutationThroughSeam(
						{
							filePath,
							kind: "edit",
							touchedLines: [2, 3],
							consumer: "foreign",
							readGuardBranchEpoch: value as number,
						},
						deps,
					),
				).toBe(true);

				const [record] = runtime.consumeDeferredFormatFiles();
				expect(record.readGuardBranchEpoch).toBe(0);

				const summary = getDegradationSummary();
				// The foreign value is named once, and the read-guard stamp is still
				// credited: pre-fix the raw value reached `recordWritten`, whose
				// `!==` check refused the write and recorded the sibling kind.
				expect(
					summary.find(
						(group) => group.kind === "mutation-bridge-invalid-branch-epoch",
					)?.count,
				).toBe(1);
				expect(
					summary.find(
						(group) => group.kind === "read-guard-write-after-branch-move",
					),
				).toBeUndefined();
			} finally {
				if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = previousDataDir;
				env.cleanup();
			}
		});
	}

	it("does not credit a write whose captured epoch predates a session reset", () => {
		// #3677 review round 1 F1. `ReadGuard.branchEpoch` lives on the guard
		// INSTANCE, and `resetForSession` nulls `_readGuard`, so a new session
		// restarts at 0. Round 1 read "captured 2 > current 0" as a foreign
		// future value, stripped it to undefined, and credited the dead
		// session's write to the new one — the exact false credit #3521 exists
		// to prevent. The captured epoch must stay fail-closed at the stamp.
		const env = setupTestEnvironment("pi-lens-3677-reset-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		resetDegradationLedger();
		try {
			const filePath = path.join(env.tmpDir, "reset.ts");
			fs.writeFileSync(filePath, SOURCE);
			// Age the file past the guard's session start, so the
			// `wasWrittenThisSession` mtime fallback cannot mask a credited
			// write: only an explicit `recordWritten` credit can make it true.
			const anHourAgo = new Date(Date.now() - 3_600_000);
			fs.utimesSync(filePath, anHourAgo, anHourAgo);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-3677-reset" });
			runtime.beginTurn();
			runtime.readGuard.retainBranch(new Set());
			runtime.readGuard.retainBranch(new Set());
			const captured = runtime.readGuard.currentBranchEpoch;
			expect(captured).toBe(2);

			// The real reset seam: a new session's guard restarts at 0.
			runtime.resetForSession();
			runtime.beginTurn();
			expect(runtime.readGuard.currentBranchEpoch).toBe(0);

			const accepted = recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					touchedLines: [1, 2],
					provenance: "settled-sweep",
					readGuardBranchEpoch: captured,
				},
				makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager: new CacheManager(false),
				}),
			);
			expect(accepted).toBe(true);

			// Fail closed: the pre-reset capture is NOT credited to the new session.
			expect((runtime.readGuard as any).wasWrittenThisSession(filePath)).toBe(
				false,
			);
			// ... and the refusal is observable through the read guard's own record.
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "read-guard-write-after-branch-move",
				)?.count,
			).toBe(1);
			// No bridge record: the epoch is well-formed, just not this guard's.
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "mutation-bridge-invalid-branch-epoch",
				),
			).toBeUndefined();
			// Nothing is queued (#3677 round 3, verify r2 V2): round 2 queued the
			// write at the CURRENT epoch, and the drain's own `recordWritten`
			// then credited it (tests/clients/runtime-agent-end.test.ts, "drains
			// nothing a dead session's sweep replay queued after a session reset").
			expect(runtime.consumeDeferredFormatFiles()).toEqual([]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("ignores a null-proto epoch object without dropping the record", () => {
		// #3677 review round 1 F3. `String(Object.create(null))` throws (no
		// prototype), and the reason template is built INSIDE the bridge's try,
		// so the throw dropped the whole record — turn state, receipt, and
		// deferral — and returned false. `typeof value` closes it.
		const env = setupTestEnvironment("pi-lens-3677-nullproto-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		resetDegradationLedger();
		try {
			const filePath = path.join(env.tmpDir, "nullproto.ts");
			fs.writeFileSync(filePath, SOURCE);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-3677-nullproto" });
			runtime.beginTurn();

			const accepted = recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					touchedLines: [1, 2],
					readGuardBranchEpoch: Object.create(null) as number,
				},
				makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager: new CacheManager(false),
				}),
			);
			expect(accepted).toBe(true);
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "mutation-bridge-invalid-branch-epoch",
				)?.count,
			).toBe(1);
			const [record] = runtime.consumeDeferredFormatFiles();
			expect(record.readGuardBranchEpoch).toBe(0);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("forwards a legitimately stale epoch captured before a /tree", () => {
		// The upper bound is `<=`, not `==`: the field exists to carry an epoch
		// captured before an await, so a `/tree` during that await must not turn
		// a real epoch into a rejection.
		const env = setupTestEnvironment("pi-lens-3677-stale-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		resetDegradationLedger();
		try {
			const filePath = path.join(env.tmpDir, "stale.ts");
			fs.writeFileSync(filePath, SOURCE);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-3677-stale" });
			runtime.beginTurn();
			runtime.readGuard.retainBranch(new Set());
			expect(runtime.readGuard.currentBranchEpoch).toBe(1);
			const cacheManager = new CacheManager(false);
			const deps = makeDeps({ tmpDir: env.tmpDir, runtime, cacheManager });

			expect(
				recordMutationThroughSeam(
					{
						filePath,
						kind: "edit",
						touchedLines: [1, 2],
						readGuardBranchEpoch: 0,
					},
					deps,
				),
			).toBe(true);

			const [record] = runtime.consumeDeferredFormatFiles();
			expect(record.readGuardBranchEpoch).toBe(0);

			// The boundary itself (#3677 round 3): an epoch EQUAL to the live one
			// is this session's and still queues. Only one above it queues
			// nothing; with `<` there, a current write lost its deferral and
			// no other test noticed.
			expect(
				recordMutationThroughSeam(
					{
						filePath,
						kind: "edit",
						touchedLines: [1, 2],
						readGuardBranchEpoch: 1,
					},
					deps,
				),
			).toBe(true);
			const [current] = runtime.consumeDeferredFormatFiles();
			expect(current?.readGuardBranchEpoch).toBe(1);
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "mutation-bridge-invalid-branch-epoch",
				),
			).toBeUndefined();
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("ignores a fraction at or below the current epoch", () => {
		// `Number.isInteger` is load-bearing on its own: 0.5 passes both the
		// `>= 0` and `<= currentEpoch` bounds, so only the integer check rejects
		// it. The guard's 1.5 row is caught by the upper bound instead.
		const env = setupTestEnvironment("pi-lens-3677-subfraction-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		resetDegradationLedger();
		try {
			const filePath = path.join(env.tmpDir, "subfraction.ts");
			fs.writeFileSync(filePath, SOURCE);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-3677-subfraction" });
			runtime.beginTurn();
			runtime.readGuard.retainBranch(new Set());
			expect(runtime.readGuard.currentBranchEpoch).toBe(1);
			const deps = makeDeps({
				tmpDir: env.tmpDir,
				runtime,
				cacheManager: new CacheManager(false),
			});

			recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					touchedLines: [1, 2],
					readGuardBranchEpoch: 0,
				},
				deps,
			);
			recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					touchedLines: [2, 3],
					readGuardBranchEpoch: 0.5,
				},
				deps,
			);

			const [record] = runtime.consumeDeferredFormatFiles();
			// Ignoring the field falls back to the CURRENT epoch (1), which is the
			// same credit a producer that omitted the field would get.
			expect(record.readGuardBranchEpoch).toBe(1);
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "mutation-bridge-invalid-branch-epoch",
				)?.count,
			).toBe(1);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("records nothing when the entry omits the epoch", () => {
		const env = setupTestEnvironment("pi-lens-3677-omitted-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		resetDegradationLedger();
		try {
			const filePath = path.join(env.tmpDir, "omitted.ts");
			fs.writeFileSync(filePath, SOURCE);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-3677-omitted" });
			runtime.beginTurn();
			recordMutationThroughSeam(
				{ filePath, kind: "edit", touchedLines: [1, 2] },
				makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager: new CacheManager(false),
				}),
			);
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "mutation-bridge-invalid-branch-epoch",
				),
			).toBeUndefined();
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("records ONE bounded degradation for repeated foreign values", () => {
		const env = setupTestEnvironment("pi-lens-3677-once-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		resetDegradationLedger();
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-3677-once" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const deps = makeDeps({ tmpDir: env.tmpDir, runtime, cacheManager });

			for (const [index, value] of [Number.NaN, -1, 1.5, "5"].entries()) {
				const filePath = path.join(env.tmpDir, `once-${index}.ts`);
				fs.writeFileSync(filePath, SOURCE);
				recordMutationThroughSeam(
					{
						filePath,
						kind: "edit",
						touchedLines: [1, 2],
						readGuardBranchEpoch: value as number,
					},
					deps,
				);
			}

			const groups = getDegradationSummary().filter(
				(group) => group.kind === "mutation-bridge-invalid-branch-epoch",
			);
			expect(groups).toHaveLength(1);
			expect(groups[0].count).toBe(1);
			// The one row names the field and the first value's type against the
			// live epoch (#3677 round 3: Stryker left the subject and the reason
			// unread by every test).
			expect(groups[0].latestReasons).toEqual([
				{
					subject: "readGuardBranchEpoch",
					reason:
						"ignored a foreign readGuardBranchEpoch (typeof number) (current 0)",
				},
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#3620/#3709: a retired scope's replay writes no session state", () => {
	// Recurrence: #3709. The branch epoch restarts at 0 in every scope, so a
	// settled sweep that captured epoch 0 and replayed after `/new` passed the
	// #3521 epoch check and was credited to the new session (#3620's NS-RACE).
	// The in-process producer now hands its lineage handle over, and the bridge
	// keeps the handle's scope out of every later scope's state.
	const LONG_AGO = new Date("2000-01-01T00:00:00Z");

	function withScopes(
		slug: string,
		body: (args: {
			filePath: string;
			tmpDir: string;
			runtime: RuntimeCoordinator;
			cacheManager: CacheManager;
			deps: MutationBridgeDeps;
		}) => void,
	): void {
		const env = setupTestEnvironment(`pi-lens-3709-${slug}-`);
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		resetDegradationLedger();
		try {
			const filePath = path.join(env.tmpDir, `${slug}.ts`);
			fs.writeFileSync(filePath, SOURCE);
			// Aged, so the mtime fallback cannot answer for an explicit credit.
			fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: `s-3709-${slug}` });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			body({
				filePath,
				tmpDir: env.tmpDir,
				runtime,
				cacheManager,
				deps: makeDeps({ tmpDir: env.tmpDir, runtime, cacheManager }),
			});
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	}

	const turnFiles = (cacheManager: CacheManager, tmpDir: string) =>
		Object.keys(cacheManager.readTurnState(tmpDir).files ?? {});

	it("does not credit or queue a retired scope's replay at the same epoch value", () => {
		withScopes(
			"same-epoch",
			({ filePath, tmpDir, runtime, cacheManager, deps }) => {
				const lineage = runtime.captureSessionGeneration();
				expect(lineage.branchEpoch).toBe(0);
				runtime.resetForSession();
				runtime.beginTurn();
				expect(runtime.readGuard.currentBranchEpoch).toBe(0);

				const accepted = recordMutationThroughSeam(
					{
						filePath,
						kind: "edit",
						touchedLines: [1, 2],
						consumer: "settled-sweep",
						provenance: "settled-sweep",
						readGuardBranchEpoch: 0,
						lineage,
					},
					deps,
				);

				expect({
					accepted,
					verdict: runtime.readGuard.checkEdit(filePath, [1, 1]).action,
					queued: runtime.consumeDeferredFormatFiles(),
					turnFiles: turnFiles(cacheManager, tmpDir),
					// The bytes did change: the change log still says so (I5).
					receipts: readChangesSince(tmpDir, 0).map((c) => c.source),
					dropped: getDegradationSummary()
						.find((group) => group.kind === "generation-guard-stale-write")
						?.latestReasons.map((r) => r.subject),
				}).toEqual({
					accepted: true,
					verdict: "block",
					queued: [],
					turnFiles: [],
					receipts: ["agent-tool:settled-sweep"],
					dropped: [`runtime-session:${filePath}`],
				});
			},
		);
	});

	it("credits and queues a replay whose scope is still live", () => {
		withScopes("live", ({ filePath, tmpDir, runtime, cacheManager, deps }) => {
			const lineage = runtime.captureSessionGeneration();
			recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					touchedLines: [1, 2],
					consumer: "settled-sweep",
					provenance: "settled-sweep",
					readGuardBranchEpoch: 0,
					lineage,
				},
				deps,
			);
			expect({
				verdict: runtime.readGuard.checkEdit(filePath, [1, 1]).action,
				queued: runtime.consumeDeferredFormatFiles().map((r) => [...r.kinds]),
				turnFiles: turnFiles(cacheManager, tmpDir).length,
			}).toEqual({
				verdict: "allow",
				queued: [["autofix", "format"]],
				turnFiles: 1,
			});
		});
	});

	it("keeps a v1 producer entry without a lineage fail-open after a reset", () => {
		// The external-producer shape documented in the bridge header: no
		// lineage, no epoch. It carries no scope, so it stays credited (I4).
		withScopes("v1", ({ filePath, tmpDir, runtime, cacheManager, deps }) => {
			runtime.resetForSession();
			runtime.beginTurn();
			const v1Entry = JSON.parse(
				JSON.stringify({
					filePath,
					kind: "edit",
					touchedLines: [1, 2],
					consumer: "my-extension",
				}),
			);
			expect(isValidMutationEntry(v1Entry)).toBe(true);
			expect(recordMutationThroughSeam(v1Entry, deps)).toBe(true);
			expect({
				verdict: runtime.readGuard.checkEdit(filePath, [1, 1]).action,
				queued: runtime.consumeDeferredFormatFiles().length,
				turnFiles: turnFiles(cacheManager, tmpDir).length,
			}).toEqual({ verdict: "allow", queued: 1, turnFiles: 1 });
		});
	});

	it("counts a dropped replay by its scope's retirement reason", () => {
		// F1 (maintainer decision on #3609): a read-guard write dropped after
		// `/reload` is a false block while its entry is still on the branch, so
		// it is counted by the reason the scope retired with.
		withScopes("reload", ({ filePath, runtime, deps }) => {
			const lineage = runtime.captureSessionGeneration();
			retireScope(runtime.sessionScope, "reload");
			runtime.resetForSession();
			recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					touchedLines: [1, 2],
					provenance: "settled-sweep",
					lineage,
				},
				deps,
			);
			expect(
				getDegradationSummary()
					.find((group) => group.kind === "session-scope-read-dropped")
					?.latestReasons.map((r) => r.subject),
			).toEqual(["reload:settled-sweep"]);
		});
	});

	it("counts no false block when the entry was captured on an earlier branch than its handle", () => {
		// Recurrence: S1's F1 over-count. The write's queue-time epoch is the
		// entry's, not the handle's: an entry captured before a /tree that its
		// handle postdates is not on the branch, so its drop is no false block.
		withScopes("moved", ({ filePath, runtime, deps }) => {
			runtime.readGuard.retainBranch(new Set());
			const lineage = runtime.captureSessionGeneration();
			expect(lineage.branchEpoch).toBe(1);
			retireScope(runtime.sessionScope, "reload");
			runtime.resetForSession();
			recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					touchedLines: [1, 2],
					provenance: "settled-sweep",
					readGuardBranchEpoch: 0,
					lineage,
				},
				deps,
			);
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "session-scope-read-dropped",
				),
			).toBeUndefined();
		});
	});

	it("counts no false block under no-read-guard, where no credit was due", () => {
		withScopes("no-guard", ({ filePath, tmpDir, runtime, cacheManager }) => {
			const lineage = runtime.captureSessionGeneration();
			retireScope(runtime.sessionScope, "reload");
			runtime.resetForSession();
			recordMutationThroughSeam(
				{
					filePath,
					kind: "edit",
					touchedLines: [1, 2],
					provenance: "settled-sweep",
					lineage,
				},
				makeDeps({
					tmpDir,
					runtime,
					cacheManager,
					shouldStampReadGuard: () => false,
				}),
			);
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "session-scope-read-dropped",
				),
			).toBeUndefined();
		});
	});

	it("never lets a non-handle lineage escape to the producer", () => {
		withScopes("foreign", ({ filePath, runtime, deps }) => {
			const entry = {
				filePath,
				kind: "edit" as const,
				touchedLines: [1, 2] as [number, number],
				lineage: {} as never,
			};
			expect(() => recordMutationThroughSeam(entry, deps)).not.toThrow();
			expect(recordMutationThroughSeam(entry, deps)).toBe(false);
			expect(runtime.readGuard.checkEdit(filePath, [1, 1]).action).toBe(
				"block",
			);
		});
	});
});

describe("mutation bridge registration", () => {
	it("mounts once, first-wins, and is reachable through the public symbol", () => {
		const env = setupTestEnvironment("pi-lens-2423-bridge-register-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const first = vi.fn(() => true);
			registerMutationBridge({
				...makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager: { addModifiedRange: first } as never,
				}),
			});
			const bridge = getMutationBridge();
			expect(bridge?.version).toBe(1);
			expect((globalThis as Record<symbol, unknown>)[MUTATION_BRIDGE_KEY]).toBe(
				bridge,
			);

			// A second registration is a no-op: the mounted bridge keeps its deps.
			const second = vi.fn(() => true);
			registerMutationBridge({
				...makeDeps({
					tmpDir: env.tmpDir,
					runtime,
					cacheManager: { addModifiedRange: second } as never,
				}),
			});
			expect(getMutationBridge()).toBe(bridge);

			const filePath = path.join(env.tmpDir, "registered.ts");
			fs.writeFileSync(filePath, SOURCE);
			bridge?.recordMutation({ filePath, kind: "write", consumer: "probe" });
			expect(first).toHaveBeenCalled();
			expect(second).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("keeps the deps its live-getter claim depends on at module scope", () => {
		// #2423 review round 1 (F6). The module header claims "every dep is a
		// GETTER resolved at call time, so a replaced runtime or cache manager is
		// picked up without re-registration". Registration happens ONCE per
		// process, so the claim only holds if what the getters close over
		// outlives one activation. `runtime` always did; `cacheManager` was
		// declared INSIDE `activateExtension`, which pinned the first
		// activation's instance for the life of the process.
		//
		// A source assertion, deliberately: both instances write the same
		// on-disk turn state, so the difference is invisible at runtime right up
		// until something holds per-activation state in memory. The invariant is
		// the thing worth pinning.
		const indexSource = fs.readFileSync(
			path.resolve(import.meta.dirname, "..", "..", "index.ts"),
			"utf8",
		);
		const declarations = indexSource
			.split("\n")
			.filter((line) => /\bcacheManager\s*=\s*new CacheManager\(/.test(line));
		expect(declarations).toHaveLength(1);
		// Module scope: everything inside `activateExtension` is indented.
		expect(declarations[0]).toMatch(/^const cacheManager = new CacheManager\(/);
		expect(
			indexSource
				.split("\n")
				.filter((line) => /\bruntime\s*=\s*new RuntimeCoordinator\(/.test(line))
				.every((line) => !/^\s/.test(line)),
		).toBe(true);
	});
});

/**
 * #3525: the settled sweep replays drift no tool_result described, whoever
 * wrote it (an external editor, a second pi-lens instance), and the agent was
 * never shown those bytes. Recurrence: its `recordWritten` re-stamped FileTime,
 * the only staleness check a line without a hash has, so an edit of a line
 * another writer changed passed on a record past READ_HASH_MAX_LINES.
 */
describe("mutation bridge FileTime credit (#3525)", () => {
	const LONG_AGO = new Date("2000-01-01T00:00:00Z");
	for (const provenance of ["settled-sweep", "observed"] as const) {
		it(`${provenance === "settled-sweep" ? "does not stamp" : "stamps"} FileTime for a ${provenance} replay`, () => {
			const env = setupTestEnvironment("pi-lens-3525-bridge-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = path.join(env.tmpDir, "big.ts");
				const big = Array.from({ length: 3100 }, (_, i) => `line${i + 1}`);
				fs.writeFileSync(filePath, big.join("\n"));
				fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				// A whole-file read past READ_HASH_MAX_LINES: no line hashes.
				runtime.readGuard.recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: big.length,
					effectiveOffset: 1,
					effectiveLimit: big.length,
					expandedByLsp: false,
					turnIndex: 0,
					writeIndex: 0,
					timestamp: Date.now(),
				});
				big[10] = "EXTERNAL11";
				fs.writeFileSync(filePath, big.join("\n"));
				expect(
					recordMutationThroughSeam(
						{ filePath, kind: "edit", touchedLines: [11, 11], provenance },
						makeDeps({
							tmpDir: env.tmpDir,
							runtime,
							cacheManager: new CacheManager(false),
						}),
					),
				).toBe(true);
				expect(runtime.readGuard.checkEdit(filePath, [11, 11]).action).toBe(
					provenance === "settled-sweep" ? "block" : "allow",
				);
			} finally {
				if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = previousDataDir;
				env.cleanup();
			}
		});
	}
});

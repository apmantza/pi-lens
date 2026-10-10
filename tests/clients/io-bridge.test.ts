/**
 * #3654 — the unified File I/O Lifecycle Bridge v2.
 *
 * These tests drive the bridge through its production seams: `registerIOBridge`
 * is mounted once (the process-bridge slot is first-wins and non-configurable),
 * and every case resets the live deps it reads through the mounted closures. The
 * bookkeeping assertions run against a REAL `RuntimeCoordinator` (its real
 * `ReadGuard`) and a REAL `CacheManager`, so what is checked is the durable
 * record a later phase reads, not a spy's call log.
 *
 * Frozen v1 shims (`read-bridge`, `mutation-bridge`) are mounted in the same
 * file, wired as `index.ts` wires them (the read shim over `recordIOEntry` and
 * these deps, the mutation shim over the same bookkeeping owner), so their
 * delegation and their unchanged return types are proven together (D14).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import {
	type BridgeEntry,
	IO_BRIDGE_SYMBOL,
	type IOBridgeDeps,
	type RecordOutcome,
	type RecordReason,
	getIOBridge,
	recordIOEntry,
	registerIOBridge,
} from "../../clients/io-bridge.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	type MutationBridgeDeps,
	getMutationBridge,
	registerMutationBridge,
} from "../../clients/mutation-bridge.js";
import {
	READ_BRIDGE_KEY,
	registerReadBridge,
} from "../../clients/read-bridge.js";
import { readChangesSince } from "../../clients/project-changes.js";
import type { ReadRecord } from "../../clients/read-guard.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { retireScope } from "../../clients/session-scope.js";
import { setupTestEnvironment, useTrackedTempDirs } from "./test-utils.js";

const TMP_PREFIX = "pi-lens-3654-io-";
useTrackedTempDirs(TMP_PREFIX);

const FILE_LINES = Array.from(
	{ length: 40 },
	(_, i) => `const line${i + 1} = ${i + 1};`,
);

interface CapturedRead {
	record: ReadRecord;
	opts?: { captureLineHashes?: boolean };
}

// ── Shared mutable per-test state (the bridge is registered once) ────────────

let tmpDir: string;
let runtime: RuntimeCoordinator;
let cacheManager: CacheManager;
let currentReadGuard: {
	recordRead(record: ReadRecord, opts?: { captureLineHashes?: boolean }): void;
	forgetPath(filePath: string): void;
	hasKnownPath(filePath: string): boolean;
};
let currentIsRecordable: (filePath: string) => boolean;
let currentFlags: Map<string, boolean>;
let currentExternal: (filePath: string) => boolean;
let currentIgnored: (filePath: string) => boolean;
let currentExists: (filePath: string) => boolean;
let currentStatSize: (filePath: string) => number;
let previousTestMode: string | undefined;
let capturedReads: CapturedRead[];
let forgetCalls: string[];
let isRecordableSpy: Mock<(filePath: string) => void>;
let notifySpy: Mock<(filePath: string, type: number) => void>;
let publishSpy: Mock<(args: unknown) => void>;

const ioDeps: IOBridgeDeps = {
	getRuntime: () => runtime as never,
	getCacheManager: () => cacheManager,
	getProjectRoot: () => tmpDir,
	getDispatchCwd: () => tmpDir,
	countFileLines,
	isRecordable: (filePath) => {
		isRecordableSpy(filePath);
		return currentIsRecordable(filePath);
	},
	shouldStampReadGuard: () => !currentFlags.get("no-read-guard"),
	dbg: () => {},
	getReadGuard: () => currentReadGuard,
	getTurnIndex: () => runtime.turnIndex,
	peekWriteIndex: () => runtime.peekWriteIndex(),
	getFlag: (name) => currentFlags.get(name),
	isExternalOrVendorFile: (filePath) => currentExternal(filePath),
	isPathIgnoredByProject: (filePath) => currentIgnored(filePath),
	notifyExternalFileChange: (...args) => notifySpy(...args),
	nodeFs: {
		existsSync: (filePath) => currentExists(filePath),
		statSync: (filePath) => ({ size: currentStatSize(filePath) }),
	},
	publishFormatQueued: (args) => {
		publishSpy(args);
	},
};

const mutationDeps: MutationBridgeDeps = {
	getRuntime: () => runtime as never,
	getCacheManager: () => cacheManager,
	getProjectRoot: () => tmpDir,
	getDispatchCwd: () => tmpDir,
	countFileLines,
	isRecordable: (filePath) => currentIsRecordable(filePath),
	shouldStampReadGuard: () => !currentFlags.get("no-read-guard"),
	dbg: () => {},
	publishFormatQueued: (args) => {
		publishSpy(args);
	},
};

// ── Bridge absent — must run before the describe's beforeAll fires ───────────

it("bridge is absent before registerIOBridge is called", () => {
	expect(IO_BRIDGE_SYMBOL in (globalThis as object)).toBe(false);
});

describe("io-bridge v2", () => {
	beforeAll(() => {
		registerIOBridge(ioDeps);
		registerReadBridge({
			isRecordable: (filePath) => currentIsRecordable(filePath),
			forward: (entry) => recordIOEntry(entry, ioDeps),
		});
		registerMutationBridge(mutationDeps);
	});

	beforeEach(() => {
		// The degradation sink is a real disk write; latency logging is a no-op
		// under the harness's test mode, so this file turns it off and restores it.
		previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		const env = setupTestEnvironment(TMP_PREFIX);
		tmpDir = env.tmpDir;
		process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
		runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "s-io-bridge" });
		runtime.beginTurn();
		cacheManager = new CacheManager(false);
		const realGuard = runtime.readGuard;
		capturedReads = [];
		forgetCalls = [];
		isRecordableSpy = vi.fn<(filePath: string) => void>();
		notifySpy = vi.fn<(filePath: string, type: number) => void>();
		publishSpy = vi.fn<(args: unknown) => void>();
		currentIsRecordable = () => true;
		currentFlags = new Map();
		currentExternal = () => false;
		currentIgnored = () => false;
		currentExists = (filePath) => fs.existsSync(filePath);
		currentStatSize = (filePath) =>
			fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
		currentReadGuard = {
			recordRead: (record, opts) => {
				capturedReads.push({ record, opts });
				realGuard.recordRead(record, opts);
			},
			forgetPath: (filePath) => {
				forgetCalls.push(filePath);
				realGuard.forgetPath(filePath);
			},
			hasKnownPath: (filePath) => realGuard.hasKnownPath(filePath),
		};
		resetDegradationLedger();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
		delete process.env.PILENS_DATA_DIR;
	});

	function bridge() {
		const mounted = getIOBridge();
		if (mounted === undefined) throw new Error("io-bridge not mounted");
		return mounted;
	}

	function writeFile(relative = "src/app.ts", lines = FILE_LINES): string {
		const filePath = path.join(tmpDir, relative);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	function record(entry: BridgeEntry) {
		return bridge().record(entry);
	}

	async function ledgerRows(): Promise<
		Array<{ kind?: string; subject?: string }>
	> {
		await flushLatencyLog();
		const file = getLatencyLogPath();
		if (!fs.existsSync(file)) return [];
		return fs
			.readFileSync(file, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { phase?: string; metadata?: unknown })
			.filter((entry) => entry.phase === "degradation_ledger")
			.map((entry) => {
				const meta = (entry.metadata ?? {}) as {
					kind?: string;
					subject?: string;
				};
				return { kind: meta.kind, subject: meta.subject };
			});
	}

	// ── Bridge metadata ──────────────────────────────────────────────────────

	it("round-trips registerIOBridge / getIOBridge with version 2", () => {
		expect(
			(globalThis as Record<symbol, unknown>)[IO_BRIDGE_SYMBOL],
		).toBeDefined();
		expect(bridge().version).toBe(2);
	});

	it("global mount is non-writable and non-configurable (first-wins)", () => {
		expect(() => {
			(globalThis as Record<symbol, unknown>)[IO_BRIDGE_SYMBOL] = {};
		}).toThrow(TypeError);
		expect(() => {
			delete (globalThis as Record<symbol, unknown>)[IO_BRIDGE_SYMBOL];
		}).toThrow(TypeError);
	});

	it("returns an outcome for every facet and never throws", () => {
		const filePath = writeFile();
		expect(() => record(null as never)).not.toThrow();
		expect(record(null as never).read?.accepted).toBe(false);
		const compound = record({
			filePath,
			consumer: "t",
			mutate: { kind: "edit", ranges: [[2, 4]] },
			read: { ranges: [[1, 10]], content: FILE_LINES.slice(0, 10).join("\n") },
		});
		expect(compound).toEqual({
			mutate: { accepted: true },
			read: { accepted: true },
		});
	});

	// ── 1. Facet validation matrix → malformed ───────────────────────────────

	it("rejects an empty filePath as malformed", () => {
		expect(record({ filePath: "", read: { ranges: [[1, 2]] } }).read).toEqual({
			accepted: false,
			reason: "malformed",
		});
		expect(
			record({ filePath: "", mutate: { kind: "edit", ranges: [[1, 2]] } })
				.mutate,
		).toEqual({ accepted: false, reason: "malformed" });
	});

	it.each([
		["zero-indexed", [[0, 10]]],
		["inverted", [[10, 5]]],
		["non-integer", [[1.5, 3]]],
		["non-numeric", [["1", "3"]]],
	])("rejects %s ranges as malformed", (_label, ranges) => {
		const filePath = writeFile();
		expect(
			reasonOf(record({ filePath, read: { ranges: ranges as never } }).read),
		).toBe("malformed");
		expect(
			reasonOf(
				record({ filePath, mutate: { kind: "edit", ranges: ranges as never } })
					.mutate,
			),
		).toBe("malformed");
	});

	it("rejects content with more than one range as malformed", () => {
		const filePath = writeFile();
		expect(
			reasonOf(
				record({
					filePath,
					read: {
						ranges: [
							[1, 5],
							[10, 15],
						],
						content: "x",
					},
				}).read,
			),
		).toBe("malformed");
	});

	it("rejects a lineHashes key outside the declared ranges as malformed", () => {
		const filePath = writeFile();
		expect(
			reasonOf(
				record({
					filePath,
					read: { ranges: [[1, 10]], lineHashes: { 3: "aaa", 30: "bbb" } },
				}).read,
			),
		).toBe("malformed");
	});

	it("rejects an edit with empty ranges as malformed", () => {
		const filePath = writeFile();
		expect(
			reasonOf(
				record({ filePath, mutate: { kind: "edit", ranges: [] } }).mutate,
			),
		).toBe("malformed");
	});

	// #3654 mutation table: each row below is the only red for one read-facet
	// validator (every one of them survived its mutation before this table).
	// Without the check, the facet either throws into the never-throw wrapper
	// (`bookkeeping-error`, so a caller cannot tell a typo from a pi-lens fault)
	// or is accepted with evidence the caller never shaped.
	it.each([
		["missing ranges", {}],
		["an unknown evidence mode", { ranges: [[1, 2]], evidence: "network" }],
		["non-string content", { ranges: [[1, 2]], content: 5 }],
		["a non-string source", { ranges: [[1, 2]], source: 5 }],
		["a non-object lineHashes", { ranges: [[1, 2]], lineHashes: 5 }],
		[
			"a fractional lineHashes key",
			{ ranges: [[1, 10]], lineHashes: { "1.5": "aa" } },
		],
		[
			"a non-string lineHashes value",
			{ ranges: [[1, 10]], lineHashes: { 1: 5 } },
		],
	])("rejects a read facet with %s as malformed", (_label, read) => {
		const filePath = writeFile();
		expect(reasonOf(record({ filePath, read: read as never }).read)).toBe(
			"malformed",
		);
		expect(capturedReads).toHaveLength(0);
	});

	it("rejects an entry with neither facet, and a null mutate facet, as malformed", () => {
		const filePath = writeFile();
		expect(record({ filePath } as BridgeEntry)).toEqual({
			read: { accepted: false, reason: "malformed" },
			mutate: { accepted: false, reason: "malformed" },
		});
		expect(reasonOf(record({ filePath, mutate: null as never }).mutate)).toBe(
			"malformed",
		);
	});

	it("rejects a delete with an empty filePath as malformed", () => {
		expect(record({ filePath: "", mutate: { kind: "delete" } }).mutate).toEqual(
			{ accepted: false, reason: "malformed" },
		);
		expect(forgetCalls).toHaveLength(0);
	});

	// D9: `record()` never throws. A dep that throws becomes that facet's
	// `bookkeeping-error`, on both facets, instead of escaping into the caller.
	it("turns a throwing dependency into bookkeeping-error on each facet", () => {
		const filePath = writeFile();
		currentIsRecordable = () => {
			throw new Error("scope probe failed");
		};
		let result: ReturnType<typeof record> | undefined;
		expect(() => {
			result = record({
				filePath,
				mutate: { kind: "edit", ranges: [[1, 1]] },
				read: { ranges: [[1, 2]] },
			});
		}).not.toThrow();
		expect(result).toEqual({
			mutate: { accepted: false, reason: "bookkeeping-error" },
			read: { accepted: false, reason: "bookkeeping-error" },
		});
	});

	it("rejects delete combined with read as malformed for both facets", () => {
		const filePath = writeFile();
		const result = record({
			filePath,
			mutate: { kind: "delete" },
			read: { ranges: [[1, 5]] },
		});
		expect(result.mutate).toEqual({ accepted: false, reason: "malformed" });
		expect(result.read).toEqual({ accepted: false, reason: "malformed" });
	});

	// ── 2. F1 path parity / display preservation ────────────────────────────

	it("preserves the caller's raw relative path across v1 and v2", () => {
		currentExists = () => true; // disk mode is admitted; the raw path stays raw
		const relative = "src/app.ts";
		const v1Read = (globalThis as Record<symbol, unknown>)[READ_BRIDGE_KEY] as
			| { recordRead(entry: unknown): void }
			| undefined;
		expect(v1Read).toBeDefined();
		v1Read!.recordRead({
			filePath: relative,
			requestedOffset: 1,
			requestedLimit: 10,
		});
		expect(capturedReads.at(-1)?.record.filePath).toBe(relative);
		expect(isRecordableSpy).toHaveBeenCalledWith(relative);

		expect(
			getMutationBridge()!.recordMutation({
				filePath: relative,
				kind: "edit",
				editRanges: [[1, 2]],
			}),
		).toBe(true);
		expect(isRecordableSpy).toHaveBeenCalledWith(relative);

		expect(
			record({
				filePath: relative,
				consumer: "v2",
				mutate: { kind: "edit", ranges: [[1, 2]] },
			}).mutate,
		).toEqual({ accepted: true });
		expect(isRecordableSpy).toHaveBeenCalledWith(relative);

		// The guard normalizes its own key; the entry never pre-resolves.
		expect(
			cacheManager.readTurnState(tmpDir).files?.[
				Object.keys(cacheManager.readTurnState(tmpDir).files ?? {})[0] ?? ""
			],
		).toBeDefined();
	});

	// ── 3. Scope & flag matrix (#2465) ──────────────────────────────────────

	it("returns out-of-scope for an unrecordable path on both facets", () => {
		currentIsRecordable = () => false;
		const filePath = writeFile();
		expect(record({ filePath, read: { ranges: [[1, 5]] } }).read).toEqual({
			accepted: false,
			reason: "out-of-scope",
		});
		expect(
			record({ filePath, mutate: { kind: "edit", ranges: [[1, 2]] } }).mutate,
		).toEqual({ accepted: false, reason: "out-of-scope" });
	});

	it("drops the read under no-read-guard while still bookkeeping the mutate", () => {
		currentFlags.set("no-read-guard", true);
		const filePath = writeFile();
		const recordWritten = vi.spyOn(runtime.readGuard, "recordWritten");
		const result = record({
			filePath,
			mutate: { kind: "edit", ranges: [[2, 4]] },
			read: { ranges: [[1, 10]] },
		});
		expect(result.read).toEqual({ accepted: false, reason: "no-read-guard" });
		expect(result.mutate).toEqual({ accepted: true });
		// #2465: the flag suppresses the staleness stamp alone; turn state and
		// the change-log receipt still land.
		expect(recordWritten).not.toHaveBeenCalled();
		expect(
			Object.keys(cacheManager.readTurnState(tmpDir).files ?? {}),
		).toHaveLength(1);
	});

	// ── 4. F3 delete matrix ─────────────────────────────────────────────────

	it("refuses delete under no-read-guard with no eviction", () => {
		const filePath = writeFile();
		currentReadGuard.recordRead(readRecordFor(filePath), {
			captureLineHashes: false,
		});
		currentFlags.set("no-read-guard", true);
		currentExists = () => false;
		expect(record({ filePath, mutate: { kind: "delete" } }).mutate).toEqual({
			accepted: false,
			reason: "no-read-guard",
		});
		expect(forgetCalls).toHaveLength(0);
	});

	it("evicts but suppresses the LSP notify under no-lsp", () => {
		const filePath = writeFile();
		currentReadGuard.recordRead(readRecordFor(filePath), {
			captureLineHashes: false,
		});
		expect(currentReadGuard.hasKnownPath(filePath)).toBe(true);
		fs.rmSync(filePath);
		currentFlags.set("no-lsp", true);
		expect(record({ filePath, mutate: { kind: "delete" } }).mutate).toEqual({
			accepted: true,
		});
		expect(forgetCalls).toEqual([filePath]);
		expect(notifySpy).not.toHaveBeenCalled();
	});

	it("returns out-of-scope for an external path and ignored for an ignored one", () => {
		const filePath = writeFile();
		currentExternal = (candidate) => candidate === filePath;
		expect(record({ filePath, mutate: { kind: "delete" } }).mutate).toEqual({
			accepted: false,
			reason: "out-of-scope",
		});
		currentExternal = () => false;
		currentIgnored = (candidate) => candidate === filePath;
		expect(record({ filePath, mutate: { kind: "delete" } }).mutate).toEqual({
			accepted: false,
			reason: "ignored",
		});
	});

	it("accepts an untracked, absent delete without notifying LSP", () => {
		const filePath = path.join(tmpDir, "never-seen.ts");
		currentExists = () => false;
		expect(record({ filePath, mutate: { kind: "delete" } }).mutate).toEqual({
			accepted: true,
		});
		expect(forgetCalls).toHaveLength(0);
		expect(notifySpy).not.toHaveBeenCalled();
	});

	it("reports bookkeeping-error for an untracked delete target still on disk", () => {
		// The caller recorded before deleting: say so, even for a path pi-lens
		// never saw, rather than accept a delete that did not happen.
		const filePath = writeFile("src/never-read.ts");
		expect(record({ filePath, mutate: { kind: "delete" } }).mutate).toEqual({
			accepted: false,
			reason: "bookkeeping-error",
		});
		expect(forgetCalls).toHaveLength(0);
		expect(notifySpy).not.toHaveBeenCalled();
	});

	it("reports bookkeeping-error when the delete target still exists", () => {
		const filePath = writeFile();
		currentReadGuard.recordRead(readRecordFor(filePath), {
			captureLineHashes: false,
		});
		expect(record({ filePath, mutate: { kind: "delete" } }).mutate).toEqual({
			accepted: false,
			reason: "bookkeeping-error",
		});
	});

	it("evicts and notifies type 3 on a confirmed delete with no fabricated receipt", () => {
		const filePath = writeFile();
		currentReadGuard.recordRead(readRecordFor(filePath), {
			captureLineHashes: false,
		});
		const addModifiedRange = vi.spyOn(cacheManager, "addModifiedRange");
		const recordProjectMutation = vi.spyOn(runtime, "recordProjectMutation");
		fs.rmSync(filePath);
		expect(record({ filePath, mutate: { kind: "delete" } }).mutate).toEqual({
			accepted: true,
		});
		expect(forgetCalls).toEqual([filePath]);
		expect(currentReadGuard.hasKnownPath(filePath)).toBe(false);
		expect(notifySpy).toHaveBeenCalledWith(filePath, 3);
		expect(addModifiedRange).not.toHaveBeenCalled();
		expect(recordProjectMutation).not.toHaveBeenCalled();
	});

	// ── 5. F5 ledger ────────────────────────────────────────────────────────

	it("writes io-bridge-read-dropped and io-bridge-mutate-dropped to the real sink", async () => {
		currentIsRecordable = () => false;
		const filePath = writeFile();
		record({ filePath, consumer: "f5", read: { ranges: [[1, 2]] } });
		record({
			filePath,
			consumer: "f5",
			mutate: { kind: "edit", ranges: [[1, 1]] },
		});
		const rows = await ledgerRows();
		expect(rows).toContainEqual({
			kind: "io-bridge-read-dropped",
			subject: "f5:out-of-scope",
		});
		expect(rows).toContainEqual({
			kind: "io-bridge-mutate-dropped",
			subject: "f5:out-of-scope",
		});
		// #4185 round 1 F5: the v1 seam's `mutation-bridge-out-of-scope` is for
		// v1 callers; an io-bridge drop has its own row and never a second one.
		expect(rows.map((row) => row.kind)).not.toContain(
			"mutation-bridge-out-of-scope",
		);
	});

	it("records stale-lineage and a malformed epoch in the real sink", async () => {
		const filePath = writeFile();
		const lineage = runtime.captureSessionGeneration();
		retireScope(runtime.sessionScope, "reload");
		const stale = record({
			filePath,
			consumer: "f5",
			mutate: { kind: "edit", ranges: [[1, 1]], lineage },
		});
		expect(stale.mutate).toEqual({ accepted: false, reason: "stale-lineage" });

		const malformed = record({
			filePath,
			consumer: "f5",
			mutate: {
				kind: "edit",
				ranges: [[1, 1]],
				readGuardBranchEpoch: "bogus" as never,
			},
		});
		expect(malformed.mutate).toEqual({ accepted: true });

		const kinds = (await ledgerRows()).map((row) => row.kind);
		expect(kinds).toContain("session-scope-read-dropped");
		expect(kinds).toContain("mutation-bridge-invalid-branch-epoch");
	});

	// ── 6. Write-before-read ordering ───────────────────────────────────────

	// D10's observable effect (#3654 F5). `recordWritten` marks a file's
	// existing reads consumed, and only a consumed read may idle out;
	// `recordRead` makes the file's reads outstanding again. Mutate-then-read
	// leaves the preview read outstanding; read-then-mutate would consume it,
	// so the read the producer just reported would be evicted on idle and the
	// next edit would block as never read.
	it("keeps the compound call's preview read outstanding through idle eviction", () => {
		const filePath = writeFile();
		const previousIdle = process.env.PI_LENS_READ_GUARD_IDLE_EVICT_MS;
		process.env.PI_LENS_READ_GUARD_IDLE_EVICT_MS = "1000";
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const result = record({
				filePath,
				mutate: { kind: "edit", ranges: [[10, 15]] },
				read: {
					ranges: [[5, 25]],
					content: FILE_LINES.slice(4, 25).join("\n"),
				},
			});
			expect(result).toEqual({
				mutate: { accepted: true },
				read: { accepted: true },
			});
			vi.advanceTimersByTime(5_000);
			expect(runtime.readGuard.getReadHistory(filePath)).toHaveLength(1);
			expect(runtime.readGuard.checkEdit(filePath, [12, 12]).action).toBe(
				"allow",
			);
		} finally {
			vi.useRealTimers();
			if (previousIdle === undefined) {
				delete process.env.PI_LENS_READ_GUARD_IDLE_EVICT_MS;
			} else {
				process.env.PI_LENS_READ_GUARD_IDLE_EVICT_MS = previousIdle;
			}
		}
	});

	it("lets a later checkEdit on an edited line pass after a compound edit+read", () => {
		const filePath = writeFile();
		// A prior read, then the producer edits the bytes on disk before recording.
		currentReadGuard.recordRead(readRecordFor(filePath, 1, 40), {
			captureLineHashes: true,
		});
		const edited = [...FILE_LINES];
		edited[11] = "const line12 = 'edited';";
		fs.writeFileSync(filePath, `${edited.join("\n")}\n`);

		const result = record({
			filePath,
			mutate: { kind: "edit", ranges: [[10, 15]] },
			read: {
				ranges: [[5, 25]],
				content: edited.slice(4, 25).join("\n"),
			},
		});
		expect(result).toEqual({
			mutate: { accepted: true },
			read: { accepted: true },
		});
		expect(runtime.readGuard.checkEdit(filePath, [12, 12]).action).toBe(
			"allow",
		);
	});

	// ── 7. D5 coverage-only witness ─────────────────────────────────────────

	it("records coverage-only with no lineHashes and no disk hashing", () => {
		const filePath = writeFile();
		const result = record({
			filePath,
			consumer: "coverage",
			read: { ranges: [[1, 10]] },
		});
		expect(result.read).toEqual({ accepted: true });
		const captured = capturedReads.at(-1);
		expect(captured?.opts?.captureLineHashes).toBe(false);
		expect(captured?.record.lineHashes).toBeUndefined();
		const stored = runtime.readGuard.getReadHistory(filePath).at(-1);
		expect(stored?.lineHashes).toBeUndefined();
		expect(stored?.source).toBe("io-bridge:coverage");
	});

	// #3654 F2: the size gate is the only thing between `ranges: []` on a
	// non-empty file and whole-file coverage of lines the agent never saw (a
	// NoBlindAllow allow, #3652).
	it("refuses a zero-line read of a non-empty file and records nothing", () => {
		const filePath = writeFile();
		const result = record({
			filePath,
			consumer: "zero",
			read: { ranges: [] },
		});
		expect(result.read).toEqual({
			accepted: false,
			reason: "bookkeeping-error",
		});
		expect(capturedReads).toHaveLength(0);
		expect(runtime.readGuard.getReadHistory(filePath)).toHaveLength(0);
		expect(runtime.readGuard.checkEdit(filePath, [1, 1]).action).toBe("block");
	});

	it("credits whole-file coverage for a zero-line read of an empty file", () => {
		const filePath = writeFile("src/empty.ts", []);
		fs.writeFileSync(filePath, "");
		const result = record({
			filePath,
			consumer: "zero",
			read: { ranges: [] },
		});
		expect(result.read).toEqual({ accepted: true });
		const stored = runtime.readGuard.getReadHistory(filePath);
		expect(
			stored.map((r) => [r.effectiveOffset, r.effectiveLimit, r.source]),
		).toEqual([[1, Number.MAX_SAFE_INTEGER, "io-bridge:zero"]]);
		expect(stored[0]?.lineHashes).toBeUndefined();
	});

	it("refuses a disk-evidence read of an absent file and records nothing", () => {
		const filePath = path.join(tmpDir, "src/absent.ts");
		expect(
			record({
				filePath,
				consumer: "disk",
				read: { ranges: [[1, 5]], evidence: "disk" },
			}).read,
		).toEqual({ accepted: false, reason: "bookkeeping-error" });
		expect(capturedReads).toHaveLength(0);
	});

	it('admits content "" with ranges [] as the explicit zero-line read', () => {
		const filePath = writeFile("src/empty-content.ts", []);
		fs.writeFileSync(filePath, "");
		expect(
			record({ filePath, consumer: "zero", read: { ranges: [], content: "" } })
				.read,
		).toEqual({ accepted: true });
		expect(runtime.readGuard.getReadHistory(filePath)).toHaveLength(1);
	});

	it("stores each range's caller lineHashes on that range's record only", () => {
		const filePath = writeFile();
		const result = record({
			filePath,
			consumer: "multi",
			read: {
				ranges: [
					[1, 2],
					[5, 6],
				],
				lineHashes: { 1: "h1", 2: "h2", 5: "h5", 6: "h6" },
			},
		});
		expect(result.read).toEqual({ accepted: true });
		expect(capturedReads.map((c) => c.record.lineHashes)).toEqual([
			{ 1: "h1", 2: "h2" },
			{ 5: "h5", 6: "h6" },
		]);
	});

	it("hashes in memory when content is supplied, without a contentBinding", () => {
		const filePath = writeFile();
		const result = record({
			filePath,
			consumer: "memory",
			read: {
				ranges: [[1, 10]],
				content: FILE_LINES.slice(0, 10).join("\n"),
			},
		});
		expect(result.read).toEqual({ accepted: true });
		const captured = capturedReads.at(-1);
		expect(captured?.opts?.captureLineHashes).toBe(false);
		expect(Object.keys(captured?.record.lineHashes ?? {})).toHaveLength(10);
		expect(captured?.record.contentBinding).toBeUndefined();
	});

	// ── 8. Event-bus parity witness ─────────────────────────────────────────

	it("publishes pilens:format:queued for a newly-queued deferred edit", () => {
		const filePath = writeFile();
		record({ filePath, mutate: { kind: "edit", ranges: [[2, 4]] } });
		expect(publishSpy).toHaveBeenCalledTimes(1);
		expect(publishSpy.mock.calls[0]?.[0]).toMatchObject({
			filePath,
			cwd: tmpDir,
			tool: "edit",
			kinds: ["autofix", "format"],
		});
	});

	it("publishes once per file: a re-touch that queues nothing new is silent", () => {
		const filePath = writeFile();
		record({ filePath, mutate: { kind: "edit", ranges: [[2, 4]] } });
		record({ filePath, mutate: { kind: "edit", ranges: [[6, 8]] } });
		expect(publishSpy).toHaveBeenCalledTimes(1);
	});

	it("names the v2 consumer in the change-log receipt", () => {
		const filePath = writeFile();
		record({
			filePath,
			consumer: "my-tool",
			mutate: { kind: "edit", ranges: [[2, 4]] },
		});
		expect(
			readChangesSince(tmpDir, 0)
				.filter((change) => change.filePath === filePath)
				.map((change) => change.source),
		).toEqual(["agent-tool:my-tool"]);
	});

	it("suppresses queueing and emission when deferAutofix is false", () => {
		const filePath = writeFile();
		record({
			filePath,
			mutate: { kind: "edit", ranges: [[2, 4]], deferAutofix: false },
		});
		expect(publishSpy).not.toHaveBeenCalled();
		expect(runtime.pendingDeferredFormatCount).toBe(0);
	});

	// ── 9. v1 shim return-type parity ───────────────────────────────────────

	it("keeps v1 return types across the matrix", () => {
		const filePath = writeFile();
		const readBridge = (globalThis as Record<symbol, unknown>)[
			READ_BRIDGE_KEY
		] as {
			recordRead(entry: unknown): unknown;
		};
		expect(
			readBridge.recordRead({
				filePath,
				requestedOffset: 1,
				requestedLimit: 10,
			}),
		).toBeUndefined();
		expect(
			typeof getMutationBridge()!.recordMutation({
				filePath,
				kind: "edit",
				editRanges: [[1, 2]],
			}),
		).toBe("boolean");
	});

	it("keeps the v1 retired-lineage answer true while v2 reports stale-lineage", () => {
		const filePath = writeFile();
		const lineage = runtime.captureSessionGeneration();
		retireScope(runtime.sessionScope, "reload");
		// v1 shim: the retired lineage's receipt is still taken, so `true`.
		expect(
			getMutationBridge()!.recordMutation({
				filePath,
				kind: "edit",
				editRanges: [[1, 1]],
				lineage,
			}),
		).toBe(true);
		// v2: the same write is a live-state rejection.
		expect(
			record({
				filePath,
				consumer: "v2",
				mutate: { kind: "edit", ranges: [[1, 1]], lineage },
			}).mutate,
		).toEqual({ accepted: false, reason: "stale-lineage" });
	});
});

/** The reason on a rejected facet outcome, or `undefined` when accepted. */
function reasonOf(
	outcome: RecordOutcome | undefined,
): RecordReason | undefined {
	return outcome !== undefined && !outcome.accepted
		? outcome.reason
		: undefined;
}

function readRecordFor(filePath: string, offset = 1, limit = 40): ReadRecord {
	return {
		filePath,
		requestedOffset: offset,
		requestedLimit: limit,
		effectiveOffset: offset,
		effectiveLimit: limit,
		expandedByLsp: false,
		turnIndex: 0,
		writeIndex: 0,
		timestamp: Date.now(),
	};
}

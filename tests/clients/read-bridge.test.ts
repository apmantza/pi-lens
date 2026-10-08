/**
 * Tests for the generic read-recording bridge (clients/read-bridge.ts).
 *
 * Verifies:
 * - registerReadBridge mounts the bridge at globalThis[READ_BRIDGE_KEY]
 * - recordRead forwards entries into the read-guard with correct fields
 * - isRecordable gates forwarding (no-read-guard flag, scope checks)
 * - Second call to registerReadBridge is a no-op (singleton)
 * - turnIndex / writeIndex are sampled at call-time, not registration-time
 * - undefined requestedLimit maps to MAX_SAFE_INTEGER (whole-file coverage)
 *
 * Locked-bridge behaviour:
 * - global property is non-writable and non-configurable (TypeError on assign/delete)
 * - bridge object is frozen (TypeError on mutation)
 *
 * Adversarial / hardening cases:
 * - Malformed payloads (null, non-object, empty/non-string filePath,
 *   non-number/non-finite/non-integer/out-of-range offsets and limits) are
 *   silently dropped
 * - timestamp is always stamped by the bridge (Date.now()), never caller-supplied
 * - bridge.version is 1
 * - consumer field sets source provenance in forwarded record
 * - Full read-then-edit authorization path: bridge-registered read unblocks
 *   a subsequent edit that would otherwise be blocked
 *
 * ## The real delegated path (#3654)
 *
 * The shim is a translator over the unified bridge body. This file mounts it
 * exactly as `index.ts` does: `forward` is the real `recordIOEntry` bound to a
 * deps object whose read guard is the per-test capture below. There is no v1
 * fallback body to test instead (that body is how #3654 F1, a dropped
 * zero-line read, shipped green). v2 reads `disk` evidence, so every
 * forwarded path is a real fixture file; a read of an absent file records
 * nothing.
 *
 * ## Test structure
 *
 * The bridge is registered with `configurable: false` — once set the global
 * property cannot be deleted or reconfigured between tests. To handle this:
 *
 * - The "bridge absent" assertion runs as a top-level `it` BEFORE the describe
 *   that owns `beforeAll`, so it executes before registration fires.
 * - All other tests live inside a single `describe` whose `beforeAll` registers
 *   the bridge once using closures that delegate to mutable per-test state.
 * - `beforeEach` resets that mutable state — it never touches the global.
 */

import * as fs from "node:fs";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { type IOBridgeDeps, recordIOEntry } from "../../clients/io-bridge.js";
import {
	READ_BRIDGE_KEY,
	type ReadBridge,
	type ReadBridgeEntry,
	registerReadBridge,
} from "../../clients/read-bridge.js";
import type { ReadContentBinding } from "../../clients/read-guard.js";
import {
	_currentContentMatchesBindingForTests,
	captureReadContentBinding,
	ReadGuard,
} from "../../clients/read-guard.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));

type RecordReadArgs = {
	filePath: string;
	requestedOffset: number;
	requestedLimit: number;
	effectiveOffset: number;
	effectiveLimit: number;
	expandedByLsp: boolean;
	turnIndex: number;
	writeIndex: number;
	timestamp: number;
	source?: string;
	contentBinding?: ReadContentBinding;
};

// ── Shared mutable per-test bridge state ─────────────────────────────────────
//
// Registered once in beforeAll; each test resets these in beforeEach.

type RecordReadOpts = { captureLineHashes?: boolean };

let _calls: RecordReadArgs[];
let _guardFn: (r: RecordReadArgs, opts?: RecordReadOpts) => void;
let _turnIndex: number;
let _writeIndex: number;
let _isRecordable: (fp: string) => boolean;
let _fixtureDir: string | undefined;

/** A real 200-line fixture file (created on first use), so v2's disk read admits it. */
function fx(name: string): string {
	_fixtureDir ??= mkdtempSync(join(tmpdir(), "pi-lens-read-bridge-fixtures-"));
	const filePath = join(_fixtureDir, name);
	if (!fs.existsSync(filePath)) {
		const lines = Array.from({ length: 200 }, (_, i) => `const l${i + 1} = 0;`);
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
	}
	return filePath;
}

/** The unused mutation half of the bridge deps: a read must never reach it. */
function unusedDep(name: string): never {
	throw new Error(`read-bridge test: unexpected ${name} call`);
}

/**
 * The v2 deps a read reaches, wired as `index.ts` wires them; the read guard
 * is the per-test capture. `guard` lets a test mount a separate capture.
 */
function readDeps(guard: {
	recordRead(r: RecordReadArgs, opts?: RecordReadOpts): void;
}): IOBridgeDeps {
	return {
		getRuntime: () => unusedDep("getRuntime"),
		getCacheManager: () => unusedDep("getCacheManager"),
		getProjectRoot: () => unusedDep("getProjectRoot"),
		getDispatchCwd: () => unusedDep("getDispatchCwd"),
		countFileLines: () => unusedDep("countFileLines"),
		isRecordable: () => true,
		getReadGuard: () => ({
			recordRead: (record, opts) => guard.recordRead(record, opts),
			forgetPath: () => unusedDep("forgetPath"),
			hasKnownPath: () => unusedDep("hasKnownPath"),
		}),
		getTurnIndex: () => _turnIndex,
		peekWriteIndex: () => _writeIndex,
		getFlag: () => undefined,
		isExternalOrVendorFile: () => unusedDep("isExternalOrVendorFile"),
		isPathIgnoredByProject: () => unusedDep("isPathIgnoredByProject"),
		notifyExternalFileChange: () => unusedDep("notifyExternalFileChange"),
		nodeFs: { existsSync: fs.existsSync, statSync: fs.statSync },
	};
}

/** A well-formed entry that always passes validation. */
function validEntry(overrides: Partial<ReadBridgeEntry> = {}): ReadBridgeEntry {
	return {
		filePath: fx("main.go"),
		requestedOffset: 10,
		requestedLimit: 50,
		...overrides,
	};
}

// ── Bridge absent — must run before the describe below fires its beforeAll ───

it("bridge is absent before registerReadBridge is called", () => {
	expect(READ_BRIDGE_KEY in (globalThis as object)).toBe(false);
});

// ── All other tests — bridge registered once, state reset per test ───────────

describe("read-bridge", () => {
	beforeAll(() => {
		const deps = readDeps({
			recordRead: (r, opts) => {
				_guardFn(r, opts);
				_calls.push(r);
			},
		});
		registerReadBridge({
			isRecordable: (fp) => _isRecordable(fp),
			forward: (entry) => recordIOEntry(entry, deps),
		});
	});

	afterAll(() => {
		if (_fixtureDir !== undefined) {
			rmSync(_fixtureDir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		_calls = [];
		_guardFn = vi.fn();
		_turnIndex = 0;
		_writeIndex = 0;
		_isRecordable = () => true;
		resetDegradationLedger();
	});

	// ── Bridge metadata ──────────────────────────────────────────────────────

	it("bridge is defined after registration", () => {
		expect((globalThis as any)[READ_BRIDGE_KEY]).toBeDefined();
	});

	it("bridge.version is 1", () => {
		const bridge: ReadBridge = (globalThis as any)[READ_BRIDGE_KEY];
		expect(bridge.version).toBe(1);
	});

	// ── Locked-bridge behaviour ──────────────────────────────────────────────

	it("global is non-writable — assigning throws", () => {
		const original = (globalThis as any)[READ_BRIDGE_KEY];
		expect(() => {
			(globalThis as any)[READ_BRIDGE_KEY] = {};
		}).toThrow(TypeError);
		expect((globalThis as any)[READ_BRIDGE_KEY]).toBe(original);
	});

	it("global is non-configurable — delete throws", () => {
		expect(() => {
			// In strict mode (TS modules) deleting a non-configurable property
			// throws; verify the global is still intact afterwards.
			delete (globalThis as any)[READ_BRIDGE_KEY];
		}).toThrow(TypeError);
		expect(READ_BRIDGE_KEY in (globalThis as object)).toBe(true);
	});

	it("bridge object is frozen — adding or replacing a property throws", () => {
		const bridge: ReadBridge = (globalThis as any)[READ_BRIDGE_KEY];
		expect(() => {
			(bridge as any).recordRead = () => {};
		}).toThrow(TypeError);
		expect(() => {
			(bridge as any).newProp = "x";
		}).toThrow(TypeError);
	});

	// ── First-wins registration ──────────────────────────────────────────────

	it("second call to registerReadBridge is a no-op — first registration wins", () => {
		const separateGuard = { recordRead: vi.fn() };
		const separateDeps = readDeps(separateGuard);
		registerReadBridge({
			isRecordable: () => true,
			forward: (entry) => recordIOEntry(entry, separateDeps),
		});

		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ filePath: fx("a.ts") }),
		);

		// Original bridge captured the call
		expect(_guardFn).toHaveBeenCalledOnce();
		// The ignored second registration's guard was never invoked
		expect(separateGuard.recordRead).not.toHaveBeenCalled();
	});

	// ── Baseline forwarding ──────────────────────────────────────────────────

	it("recordRead forwards the entry into the read-guard with correct fields", () => {
		_turnIndex = 3;
		_writeIndex = 7;
		const before = Date.now();

		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ requestedOffset: 10, requestedLimit: 50 }),
		);

		expect(_guardFn).toHaveBeenCalledOnce();
		const call = _calls[0];
		expect(call.filePath).toBe(fx("main.go"));
		expect(call.requestedOffset).toBe(10);
		expect(call.requestedLimit).toBe(50);
		expect(call.effectiveOffset).toBe(10);
		expect(call.effectiveLimit).toBe(50);
		expect(call.expandedByLsp).toBe(false);
		expect(call.turnIndex).toBe(3);
		expect(call.writeIndex).toBe(7);
		expect(call.timestamp).toBeGreaterThanOrEqual(before);
		expect(call.timestamp).toBeLessThanOrEqual(Date.now());
	});

	it("undefined requestedLimit maps to MAX_SAFE_INTEGER (whole-file coverage)", () => {
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ requestedLimit: undefined }),
		);
		expect(_calls[0].requestedLimit).toBe(Number.MAX_SAFE_INTEGER);
		expect(_calls[0].effectiveLimit).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("isRecordable returning false suppresses forwarding", () => {
		_isRecordable = () => false;
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry());
		expect(_guardFn).not.toHaveBeenCalled();
	});

	it("isRecordable receives the entry filePath", () => {
		const seen: string[] = [];
		_isRecordable = (fp) => {
			seen.push(fp);
			return true;
		};
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ filePath: fx("checked.ts") }),
		);
		expect(seen).toEqual([fx("checked.ts")]);
	});

	it("turnIndex and writeIndex are sampled at call-time, not registration-time", () => {
		_turnIndex = 5;
		_writeIndex = 2;
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ filePath: fx("a.ts") }),
		);
		expect(_calls[0].turnIndex).toBe(5);
		expect(_calls[0].writeIndex).toBe(2);

		_turnIndex = 9;
		_writeIndex = 4;
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ filePath: fx("b.ts") }),
		);
		expect(_calls[1].turnIndex).toBe(9);
		expect(_calls[1].writeIndex).toBe(4);
	});

	// ── Malformed payload validation ─────────────────────────────────────────

	describe("malformed payloads", () => {
		it("null entry is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(null);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("non-object entry (string) is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead("not-an-object");
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("empty filePath is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ filePath: "" }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("numeric filePath is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead({
				...validEntry(),
				filePath: 42 as any,
			});
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedOffset = 0 (below minimum) is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedOffset: 0 }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedOffset = NaN is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedOffset: NaN }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedOffset = Infinity is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedOffset: Infinity }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("non-integer requestedOffset (1.5) is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedOffset: 1.5 }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("string requestedOffset is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead({
				...validEntry(),
				requestedOffset: "10" as any,
			});
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedLimit = NaN is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedLimit: NaN }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedLimit = Infinity is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedLimit: Infinity }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("string requestedLimit is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead({
				...validEntry(),
				requestedLimit: "50" as any,
			});
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("non-integer requestedLimit (3.7) is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedLimit: 3.7 }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});

		it("requestedLimit = -1 (below minimum) is silently dropped", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedLimit: -1 }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
		});
	});

	// ── Zero-line reads of empty files ───────────────────────────────────────

	// #3654 F1: these run the v2 zero-line read the shim delegates to. The
	// shim used to spell `requestedLimit: 0` as the range `[1, 0]`, which v2
	// rejects as malformed: the first case is the red for that shape.
	describe("zero-line reads of empty files", () => {
		const zeroLineDrops = () =>
			getDegradationSummary().filter(
				(group) => group.kind === "io-bridge-read-dropped",
			);

		it("accepts a zero-line read of a real empty file with whole-file coverage and no content binding", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-bridge-empty-"));
			try {
				const filePath = join(dir, "empty.ts");
				writeFileSync(filePath, "", "utf-8");
				(globalThis as any)[READ_BRIDGE_KEY].recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: 0,
				});
				expect(_guardFn).toHaveBeenCalledOnce();
				expect(_calls[0].requestedLimit).toBe(0);
				expect(_calls[0].effectiveOffset).toBe(1);
				expect(_calls[0].effectiveLimit).toBe(Number.MAX_SAFE_INTEGER);
				expect(_calls[0].contentBinding).toBeUndefined();
				expect(zeroLineDrops()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("drops a zero-line read of a non-empty file", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-bridge-nonempty-"));
			try {
				const filePath = join(dir, "nonempty.ts");
				writeFileSync(filePath, "const value = 1;\n", "utf-8");
				(globalThis as any)[READ_BRIDGE_KEY].recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: 0,
				});
				expect(_guardFn).not.toHaveBeenCalled();
				const groups = zeroLineDrops();
				expect(groups).toHaveLength(1);
				expect(groups[0].latestReasons[0].subject).toBe(
					"unknown:bookkeeping-error",
				);
				expect(groups[0].latestReasons[0].reason).toContain(
					"zero-line read of a non-empty file",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("requestedLimit = 0 on a non-existent file is dropped", () => {
			fx("main.go");
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({
					filePath: join(_fixtureDir!, "absent.ts"),
					requestedLimit: 0,
				}),
			);
			expect(_guardFn).not.toHaveBeenCalled();
			const groups = zeroLineDrops();
			expect(groups).toHaveLength(1);
			expect(groups[0].latestReasons[0].reason).toContain("ENOENT");
		});
	});

	// ── Consumer provenance ──────────────────────────────────────────────────

	describe("consumer provenance", () => {
		it('source defaults to "bridge:unknown" when consumer is omitted', () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry());
			expect(_calls[0].source).toBe("bridge:unknown");
		});

		it('source is "bridge:<consumer>" when consumer is provided', () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ consumer: "my-extension" }),
			);
			expect(_calls[0].source).toBe("bridge:my-extension");
		});
	});

	// ── Full read-then-edit authorization path ───────────────────────────────

	describe("read-then-edit authorization path", () => {
		it("rejects a same-length mutation through the content-binding verifier itself", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-binding-"));
			try {
				const filePath = join(dir, "binding.ts");
				writeFileSync(filePath, "const value = 1;\n", "utf-8");
				const binding = captureReadContentBinding(filePath, 1, 1);
				expect(binding).toBeDefined();
				writeFileSync(filePath, "const value = 2;\n", "utf-8");
				expect(_currentContentMatchesBindingForTests(filePath, binding!)).toBe(
					false,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("range bindings cap at 3,000 lines with inclusive boundaries", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-binding-range-"));
			try {
				const filePath = join(dir, "large.ts");
				const original = Array.from(
					{ length: 3_101 },
					(_, i) => `line ${i + 1}`,
				);
				writeFileSync(filePath, original.join("\n"), "utf-8");
				const binding = captureReadContentBinding(filePath, 1, 3_101);
				expect(binding).toMatchObject({
					fullFile: false,
					offset: 1,
					limit: 3_000,
				});

				for (const lineNumber of [1, 3_000]) {
					const mutated = [...original];
					mutated[lineNumber - 1] = `MUTATED ${lineNumber}`;
					writeFileSync(filePath, mutated.join("\n"), "utf-8");
					expect(
						_currentContentMatchesBindingForTests(filePath, binding!),
					).toBe(false);
				}

				const outside = [...original];
				outside[3_000] = "MUTATED 3001";
				writeFileSync(filePath, outside.join("\n"), "utf-8");
				expect(_currentContentMatchesBindingForTests(filePath, binding!)).toBe(
					true,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("range binding hashes are coherent across LF and CRLF", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-binding-eol-"));
			try {
				const filePath = join(dir, "large.ts");
				const lines = Array.from({ length: 3_001 }, (_, i) => `line ${i + 1}`);
				writeFileSync(filePath, lines.join("\r\n"), "utf-8");
				const binding = captureReadContentBinding(filePath, 2, 10);
				expect(binding?.fullFile).toBe(false);
				writeFileSync(filePath, lines.join("\n"), "utf-8");
				expect(_currentContentMatchesBindingForTests(filePath, binding!)).toBe(
					true,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("skips binding capture above the 4 MiB hot-path ceiling", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-binding-size-"));
			try {
				const filePath = join(dir, "oversized.ts");
				writeFileSync(filePath, "x".repeat(4 * 1024 * 1024 + 1), "utf-8");
				expect(captureReadContentBinding(filePath, 1, 1)).toBeUndefined();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("allows verification when bridge-bound disk content is unchanged", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-bridge-"));
			try {
				const filePath = join(dir, "green.ts");
				writeFileSync(filePath, "const value = 1;\n", "utf-8");
				const guard = new ReadGuard("bridge-green", { mode: "block" });
				_guardFn = (record, opts) => guard.recordRead(record, opts);
				(globalThis as any)[READ_BRIDGE_KEY].recordRead(
					validEntry({
						filePath,
						requestedOffset: 1,
						requestedLimit: undefined,
					}),
				);
				expect(guard.checkEdit(filePath, [1, 1]).action).toBe("allow");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("blocks verification when bridge-bound disk content has mutated", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-read-bridge-"));
			try {
				const filePath = join(dir, "mutated.ts");
				writeFileSync(filePath, "const value = 1;\n", "utf-8");
				const guard = new ReadGuard("bridge-mismatch", { mode: "block" });
				_guardFn = (record, opts) => guard.recordRead(record, opts);
				(globalThis as any)[READ_BRIDGE_KEY].recordRead(
					validEntry({
						filePath,
						requestedOffset: 1,
						requestedLimit: undefined,
					}),
				);
				// Isolate the binding path: FileTime must report unchanged so it cannot
				// mask a broken hash comparison with its own stale-file rejection.
				const fileTime = (
					guard as unknown as { fileTime: { hasChanged: () => boolean } }
				).fileTime;
				fileTime.hasChanged = vi.fn(() => false);
				writeFileSync(filePath, "const value = 2;\n", "utf-8");
				const verdict = guard.checkEdit(filePath, [1, 1]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("content no longer matches");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("bridge-registered read forwards all fields the guard needs to authorize a subsequent edit", () => {
			_turnIndex = 1;
			_writeIndex = 0;
			const filePath = fx("handler.ts");
			const beforeCall = Date.now();

			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({
					filePath,
					requestedOffset: 1,
					requestedLimit: 100,
					consumer: "test-ext",
				}),
			);

			expect(_guardFn).toHaveBeenCalledOnce();
			const read = _calls[0];
			expect(read.filePath).toBe(filePath);
			expect(read.requestedOffset).toBe(1);
			expect(read.requestedLimit).toBe(100);
			expect(read.effectiveOffset).toBe(1);
			expect(read.effectiveLimit).toBe(100);
			expect(read.expandedByLsp).toBe(false);
			expect(read.turnIndex).toBe(1);
			expect(read.writeIndex).toBe(0);
			expect(read.timestamp).toBeGreaterThanOrEqual(beforeCall);
			expect(read.timestamp).toBeLessThanOrEqual(Date.now());
			expect(read.source).toBe("bridge:test-ext");
		});

		it("a ranged read stores disk line hashes for exactly the lines it covered", () => {
			const guard = new ReadGuard("bridge-disk-hashes", { mode: "block" });
			_guardFn = (record, opts) => guard.recordRead(record, opts);
			const filePath = fx("hashed.ts");
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ filePath, requestedOffset: 10, requestedLimit: 5 }),
			);
			const stored = guard.getReadHistory(filePath);
			expect(stored).toHaveLength(1);
			expect(Object.keys(stored[0]?.lineHashes ?? {})).toEqual([
				"10",
				"11",
				"12",
				"13",
				"14",
			]);
		});

		// #3654: v2's disk-evidence read refuses a file that is gone, where the
		// v1 body recorded coverage for it. The drop is visible in the ledger.
		it("a read of an absent file records nothing and leaves one drop row", () => {
			fx("main.go");
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ filePath: join(_fixtureDir!, "gone.ts"), consumer: "x" }),
			);
			expect(_guardFn).not.toHaveBeenCalled();
			const groups = getDegradationSummary().filter(
				(group) => group.kind === "io-bridge-read-dropped",
			);
			expect(groups).toHaveLength(1);
			expect(groups[0].latestReasons[0].subject).toBe("x:bookkeeping-error");
		});

		it("a read for file A does not authorize edits on file B", () => {
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ filePath: fx("a.ts") }),
			);
			expect(_guardFn).toHaveBeenCalledOnce();
			expect(_calls[0].filePath).toBe(fx("a.ts"));
			const readsForB = _calls.filter((c) => c.filePath === fx("b.ts"));
			expect(readsForB).toHaveLength(0);
		});

		it("multiple reads on the same file are all forwarded", () => {
			const bridge = (globalThis as any)[READ_BRIDGE_KEY];
			const filePath = fx("big.ts");
			bridge.recordRead(
				validEntry({ filePath, requestedOffset: 1, requestedLimit: 50 }),
			);
			bridge.recordRead(
				validEntry({ filePath, requestedOffset: 51, requestedLimit: 50 }),
			);
			bridge.recordRead(
				validEntry({
					filePath,
					requestedOffset: 101,
					requestedLimit: undefined,
				}),
			);
			expect(_guardFn).toHaveBeenCalledTimes(3);
			expect(_calls[0].requestedOffset).toBe(1);
			expect(_calls[1].requestedOffset).toBe(51);
			expect(_calls[2].requestedLimit).toBe(Number.MAX_SAFE_INTEGER);
		});

		it("a zero-line read of an empty file authorizes a subsequent multi-line insert", () => {
			const dir = mkdtempSync(
				join(tmpdir(), "pi-lens-read-bridge-empty-edit-"),
			);
			try {
				const filePath = join(dir, "empty.ts");
				writeFileSync(filePath, "", "utf-8");
				// Backdate mtime so the guard cannot attribute this fixture to the session:
				// only the bridged read may authorize the later edit.
				utimesSync(filePath, new Date(0), new Date(0));
				const guard = new ReadGuard("bridge-empty", { mode: "block" });
				_guardFn = (record, opts) => guard.recordRead(record, opts);
				(globalThis as any)[READ_BRIDGE_KEY].recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: 0,
				});
				expect(guard.checkEdit(filePath, [1, 10]).action).toBe("allow");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
		it("a landed edit after a zero-line read does not stick a stale binding", () => {
			const dir = mkdtempSync(
				join(tmpdir(), "pi-lens-read-bridge-empty-reread-"),
			);
			try {
				const filePath = join(dir, "empty.ts");
				writeFileSync(filePath, "", "utf-8");
				// Backdate mtime so the guard cannot attribute this fixture to the session:
				// only the bridged read may authorize the later edit.
				utimesSync(filePath, new Date(0), new Date(0));
				const guard = new ReadGuard("bridge-empty-reread", { mode: "block" });
				_guardFn = (record, opts) => guard.recordRead(record, opts);
				(globalThis as any)[READ_BRIDGE_KEY].recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: 0,
				});
				expect(guard.checkEdit(filePath, [1, 10]).action).toBe("allow");
				// Simulate the landed edit: content arrives and the write is recorded.
				writeFileSync(filePath, "const value = 1;\n", "utf-8");
				guard.recordWritten(filePath, { writtenContent: "const value = 1;\n" });
				expect(guard.checkEdit(filePath, [1, 10]).action).toBe("allow");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("a native re-read supersedes a stale non-zero bridge content binding (#3962)", () => {
			const dir = mkdtempSync(
				join(tmpdir(), "pi-lens-read-bridge-binding-supersede-"),
			);
			try {
				const filePath = join(dir, "binding.ts");
				writeFileSync(
					filePath,
					"const a = 1;\nconst b = 2;\nconst c = 3;\n",
					"utf-8",
				);
				// Backdate mtime so the guard cannot attribute this fixture to the session:
				// only the bridged read may authorize the first edit.
				utimesSync(filePath, new Date(0), new Date(0));
				const guard = new ReadGuard("bridge-binding-supersede", {
					mode: "block",
				});
				_guardFn = (record, opts) => guard.recordRead(record, opts);
				(globalThis as any)[READ_BRIDGE_KEY].recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: 1,
				});
				expect(guard.checkEdit(filePath, [1, 1]).action).toBe("allow");
				// External change the bridge never saw: the binding goes stale.
				writeFileSync(
					filePath,
					"const a = 99;\nconst b = 2;\nconst c = 3;\n",
					"utf-8",
				);
				// A native re-read observes the new bytes; it must supersede the binding.
				guard.recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: 3,
					effectiveOffset: 1,
					effectiveLimit: 3,
					expandedByLsp: false,
					turnIndex: 0,
					writeIndex: 0,
					timestamp: Date.now(),
				});
				const verdict = guard.checkEdit(filePath, [1, 1]);
				expect(verdict.action).toBe("allow");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("a native re-read supersedes a stale binding only for the lines it delivered (#3962)", () => {
			const dir = mkdtempSync(
				join(tmpdir(), "pi-lens-read-bridge-binding-noncover-"),
			);
			try {
				const filePath = join(dir, "binding.ts");
				writeFileSync(
					filePath,
					"const a = 1;\nconst b = 2;\nconst c = 3;\n",
					"utf-8",
				);
				utimesSync(filePath, new Date(0), new Date(0));
				const guard = new ReadGuard("bridge-binding-noncover", {
					mode: "block",
				});
				_guardFn = (record, opts) => guard.recordRead(record, opts);
				(globalThis as any)[READ_BRIDGE_KEY].recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: 1,
				});
				writeFileSync(
					filePath,
					"const a = 99;\nconst b = 2;\nconst c = 3;\n",
					"utf-8",
				);
				// Newer, but line 1 was not the edited line: the stale binding still blocks it.
				guard.recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: 1,
					effectiveOffset: 1,
					effectiveLimit: 1,
					expandedByLsp: false,
					turnIndex: 0,
					writeIndex: 0,
					timestamp: Date.now(),
				});
				const verdict = guard.checkEdit(filePath, [3, 3]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("content no longer matches");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("a zero-line read of an empty file does not authorize edits after content appears", () => {
			const dir = mkdtempSync(
				join(tmpdir(), "pi-lens-read-bridge-empty-stale-"),
			);
			try {
				const filePath = join(dir, "stale.ts");
				writeFileSync(filePath, "", "utf-8");
				// Backdate mtime so the guard cannot attribute this fixture to the session:
				// only the bridged read may authorize the later edit.
				utimesSync(filePath, new Date(0), new Date(0));
				const guard = new ReadGuard("bridge-empty-stale", { mode: "block" });
				_guardFn = (record, opts) => guard.recordRead(record, opts);
				(globalThis as any)[READ_BRIDGE_KEY].recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: 0,
				});
				// External change the bridge never saw: the FileTime cause must fire.
				writeFileSync(filePath, "const value = 1;\n", "utf-8");
				const verdict = guard.checkEdit(filePath, [1, 10]);
				expect(verdict.action).toBe("block");
				expect(verdict.reason).toContain("modified on disk");
				// A native re-read observes the new content and authorizes the edit.
				guard.recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: Number.MAX_SAFE_INTEGER,
					effectiveOffset: 1,
					effectiveLimit: Number.MAX_SAFE_INTEGER,
					expandedByLsp: false,
					turnIndex: 0,
					writeIndex: 0,
					timestamp: Date.now(),
				});
				expect(guard.checkEdit(filePath, [1, 10]).action).toBe("allow");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
		it("a zero-line read normalizes coverage to line 1 regardless of offset", () => {
			const dir = mkdtempSync(
				join(tmpdir(), "pi-lens-read-bridge-empty-offset-"),
			);
			try {
				const filePath = join(dir, "empty.ts");
				writeFileSync(filePath, "", "utf-8");
				// Backdate mtime so the guard cannot attribute this fixture to the session:
				// only the bridged read may authorize the later edit.
				utimesSync(filePath, new Date(0), new Date(0));
				const guard = new ReadGuard("bridge-empty-offset", { mode: "block" });
				_guardFn = (record, opts) => guard.recordRead(record, opts);
				(globalThis as any)[READ_BRIDGE_KEY].recordRead({
					filePath,
					requestedOffset: 5,
					requestedLimit: 0,
				});
				expect(guard.checkEdit(filePath, [1, 10]).action).toBe("allow");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("a negative-limit read records no evidence and does not authorize an edit", () => {
			const dir = mkdtempSync(
				join(tmpdir(), "pi-lens-read-bridge-negative-limit-"),
			);
			try {
				const filePath = join(dir, "file.ts");
				writeFileSync(filePath, "const value = 1;\n", "utf-8");
				// Backdate mtime so the guard cannot attribute this fixture to the session:
				// only a recorded read could authorize the later edit.
				utimesSync(filePath, new Date(0), new Date(0));
				const guard = new ReadGuard("bridge-negative-limit", { mode: "block" });
				const forward = vi.fn((record: RecordReadArgs) =>
					guard.recordRead(record),
				);
				_guardFn = forward;
				(globalThis as any)[READ_BRIDGE_KEY].recordRead({
					filePath,
					requestedOffset: 1,
					requestedLimit: -1,
				});
				// The invalid read never reaches the guard: no read evidence is recorded.
				expect(forward).not.toHaveBeenCalled();
				expect(guard.checkEdit(filePath, [1, 10]).action).toBe("block");
				// A rejected read vouches for nothing: not even the single line the
				// guard would otherwise treat a negative limit as covering.
				expect(guard.checkEdit(filePath, [1, 1]).action).toBe("block");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

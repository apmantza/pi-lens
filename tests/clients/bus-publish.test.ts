import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeFilePath } from "../../clients/path-utils.js";

const appendRecentTouches = vi.fn().mockResolvedValue(undefined);
vi.mock("../../clients/recent-touches.js", () => ({
	appendRecentTouches: (...args: unknown[]) => appendRecentTouches(...args),
}));

import { installBusSinkReader } from "../support/bus-sink-reader.js";
const { busRows, clearBusRows } = installBusSinkReader();

import {
	_resetForTests,
	BUS_FILES_TOUCHED_EVENT,
	BUS_FILES_TOUCHED_VERSION,
	isBusPublishEnabled,
	publishFilesTouched,
	wireBusEmitter,
	wireBusEmitterGetter,
} from "../../clients/bus-publish.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	createBusPublisher,
	createLiveBusEmitter,
} from "../../clients/live-bus-emitter.js";
import {
	_resetDiagnosticsPublishForTests,
	publishDiagnostics,
	wireDiagnosticsBusEmitterGetter,
} from "../../clients/diagnostics-publish.js";
import {
	_resetDispositionPublishForTests,
	publishDisposition,
	wireDispositionBusEmitterGetter,
} from "../../clients/disposition-publish.js";
import {
	_resetFormatEventsPublishForTests,
	publishAutofixStart,
	publishFormatDone,
	publishFormatQueued,
	publishFormatStart,
	wireFormatEventsBusEmitterGetter,
} from "../../clients/format-events-publish.js";
import {
	_resetForTests as _resetLensEventsForTests,
	emitLensTurnFindings,
	initLensEventsGetter,
} from "../../clients/lens-events.js";

describe("bus-publish — pilens:files:touched (#482)", () => {
	const originalEnv = process.env.PI_LENS_BUS_PUBLISH;

	beforeEach(async () => {
		_resetForTests();
		resetDegradationLedger();
		appendRecentTouches.mockClear();
		appendRecentTouches.mockResolvedValue(undefined);
		await clearBusRows();
	});

	afterEach(async () => {
		_resetForTests();
		resetDegradationLedger();
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_BUS_PUBLISH;
		} else {
			process.env.PI_LENS_BUS_PUBLISH = originalEnv;
		}
	});

	it("resolves the live emitter after session replacement", async () => {
		const oldEmit = vi.fn(() => {
			throw new Error("This extension ctx is stale after session replacement");
		});
		const newEmit = vi.fn();
		let currentEmit: (channel: string, data: unknown) => void = oldEmit;
		wireBusEmitterGetter(() => currentEmit);
		currentEmit = newEmit;

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/src/a.ts"],
			cwd: "/repo",
		});

		expect(oldEmit).not.toHaveBeenCalled();
		expect(newEmit).toHaveBeenCalledTimes(1);
		expect(
			(await busRows())
				.map((entry) => [entry])
				.some(
					([entry]) =>
						(entry as { outcome?: string }).outcome === "emit_failed",
				),
		).toBe(false);
	});

	it("skips a resolved emitter whose session ctx is stale", async () => {
		const emit = vi.fn();
		const staleCtx = {
			isIdle: () => {
				throw new Error(
					"This extension ctx is stale after session replacement or reload",
				);
			},
		};
		wireBusEmitterGetter(() => ({ emit, ctx: staleCtx }));

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/src/a.ts"],
			cwd: "/repo",
		});

		expect(emit).not.toHaveBeenCalled();
		expect(await busRows()).toContainEqual(
			expect.objectContaining({
				event: BUS_FILES_TOUCHED_EVENT,
				outcome: "skipped_stale_session",
				level: "info",
				ctxSource: "own",
			}),
		);
		expect(
			(await busRows())
				.map((entry) => [entry])
				.some(
					([entry]) =>
						(entry as { outcome?: string }).outcome === "emit_failed",
				),
		).toBe(false);
	});

	it("fails open when the probe cannot classify the ctx", async () => {
		// The tri-state matters: only a CONFIRMED-stale ctx (probe === false)
		// may skip delivery. A ctx without isIdle (undefined) and a ctx whose
		// probe throws a NON-stale error (undefined — "don't guess") must both
		// fall through to the emit, where a real failure still logs
		// emit_failed. Silent inversion here would drop telemetry for any
		// odd-shaped ctx.
		for (const oddCtx of [
			{},
			{
				isIdle: () => {
					throw new Error("boom, not the stale fragment");
				},
			},
		]) {
			const emit = vi.fn();
			wireBusEmitterGetter(() => ({ emit, ctx: oddCtx }));
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/src/a.ts"],
				cwd: "/repo",
			});
			expect(emit).toHaveBeenCalledTimes(1);
			expect(
				(await busRows())
					.map((entry) => [entry])
					.some(
						([entry]) =>
							(entry as { outcome?: string }).outcome ===
							"skipped_stale_session",
					),
			).toBe(false);
			vi.clearAllMocks();
		}
	});

	it("re-resolves and publishes through the fresh session ctx", async () => {
		const staleEmit = vi.fn();
		const freshEmit = vi.fn();
		let current: {
			emit: (channel: string, data: unknown) => void;
			ctx: { isIdle: () => unknown };
		} = {
			emit: staleEmit,
			ctx: {
				isIdle: () => {
					throw new Error(
						"This extension ctx is stale after session replacement or reload",
					);
				},
			},
		};
		wireBusEmitterGetter(() => current);
		current = { emit: freshEmit, ctx: { isIdle: () => false } };

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/src/a.ts"],
			cwd: "/repo",
		});

		expect(staleEmit).not.toHaveBeenCalled();
		expect(freshEmit).toHaveBeenCalledTimes(1);
	});

	it("emits the exact payload shape from the issue: v, source, reason, paths, cwd", async () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
			cwd: "/repo",
		});

		expect(emit).toHaveBeenCalledTimes(1);
		const [channel, payload] = emit.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(channel).toBe(BUS_FILES_TOUCHED_EVENT);
		expect(payload).toMatchObject({
			v: BUS_FILES_TOUCHED_VERSION,
			source: "pi-lens",
			reason: "autofix",
		});
		expect(payload.paths).toHaveLength(2);
		expect(payload.cwd).toEqual(expect.any(String));
	});

	it("normalizes paths and cwd (backslashes -> forward slashes)", async () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({
			reason: "format",
			paths: ["C:\\repo\\src\\a.ts"],
			cwd: "C:\\repo",
		});

		const payload = emit.mock.calls[0][1] as { paths: string[]; cwd: string };
		expect(payload.paths[0]).not.toContain("\\");
		expect(payload.cwd).not.toContain("\\");
	});

	it("batches: one emit call per publishFilesTouched invocation regardless of path count", async () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({
			reason: "format",
			paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
			cwd: "/repo",
		});

		expect(emit).toHaveBeenCalledTimes(1);
		expect((emit.mock.calls[0][1] as { paths: string[] }).paths).toHaveLength(
			3,
		);
	});

	it("does not emit for an empty paths batch", async () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({ reason: "autofix", paths: [], cwd: "/repo" });

		expect(emit).not.toHaveBeenCalled();
	});

	it("kill switch: PI_LENS_BUS_PUBLISH=0 disables publishing", async () => {
		process.env.PI_LENS_BUS_PUBLISH = "0";
		_resetForTests(); // re-arm lazy env read after mutating env
		const emit = vi.fn();
		wireBusEmitter(emit);

		expect(isBusPublishEnabled()).toBe(false);

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/a.ts"],
			cwd: "/repo",
		});

		expect(emit).not.toHaveBeenCalled();
	});

	it("is enabled by default (no env var set)", async () => {
		delete process.env.PI_LENS_BUS_PUBLISH;
		_resetForTests();
		expect(isBusPublishEnabled()).toBe(true);
	});

	it("origin-flag loop guard: events originating from an ingested bus event never re-publish", async () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/a.ts"],
			cwd: "/repo",
			origin: "bus",
		});

		expect(emit).not.toHaveBeenCalled();
	});

	it("swallows emit throws and logs once via dbg without affecting the caller", async () => {
		const emit = vi.fn(() => {
			throw new Error("bus explosion");
		});
		wireBusEmitter(emit);
		const dbg = vi.fn();

		expect(() =>
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
				dbg,
			}),
		).not.toThrow();
		expect(dbg).toHaveBeenCalledTimes(1);

		// Second failure is swallowed but NOT re-logged (log-once).
		expect(() =>
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/b.ts"],
				cwd: "/repo",
				dbg,
			}),
		).not.toThrow();
		expect(dbg).toHaveBeenCalledTimes(1);
	});

	it("logs and ledgers each stale occurrence after a successful recovery", async () => {
		const stale = vi.fn(() => {
			throw new Error(
				"This extension ctx is stale after session replacement or reload",
			);
		});
		const recovered = vi.fn();
		let currentEmit: (channel: string, data: unknown) => void = stale;
		wireBusEmitterGetter(() => currentEmit);
		const dbg = vi.fn();
		const publish = (path: string) =>
			publishFilesTouched({
				reason: "autofix",
				paths: [path],
				cwd: "/repo",
				dbg,
			});

		publish("/repo/a.ts");
		publish("/repo/b.ts");
		expect(dbg).toHaveBeenCalledTimes(1);
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({ kind: "bus-stale", count: 1 }),
		]);

		currentEmit = recovered;
		publish("/repo/recovered.ts");
		expect(recovered).toHaveBeenCalledTimes(1);

		currentEmit = stale;
		publish("/repo/c.ts");
		expect(dbg).toHaveBeenCalledTimes(2);
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({ kind: "bus-stale", count: 2 }),
		]);
	});

	it("records the pi-lens writer and bounded paths for drift correlation", async () => {
		const emit = vi.fn();
		wireBusEmitter(emit);
		const paths = Array.from(
			{ length: 70 },
			(_, index) => `/repo/src/file-${index}.ts`,
		);

		publishFilesTouched({
			reason: "autofix",
			paths,
			cwd: "/repo",
		});

		expect(await busRows()).toContainEqual(
			expect.objectContaining({
				event: BUS_FILES_TOUCHED_EVENT,
				outcome: "emitted",
				writer: "pi-lens",
				paths: expect.arrayContaining([
					normalizeFilePath(paths[0]),
					normalizeFilePath(paths[63]),
				]),
			}),
		);
		const record = (await busRows()).map((entry) => [entry])[0]?.[0] as {
			paths?: string[];
		};
		expect(record.paths).toHaveLength(64);
	});

	describe("#502: fix-provenance additive fields", () => {
		it("omits fixes when not provided (old-shape payload unaffected)", async () => {
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "format",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});

			const payload = emit.mock.calls[0][1] as Record<string, unknown>;
			expect(payload.fixes).toBeUndefined();
		});

		it("includes fixes when provided, normalizing each entry's path", async () => {
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "format",
				paths: ["C:\\repo\\a.ts"],
				cwd: "C:\\repo",
				fixes: [{ path: "C:\\repo\\a.ts", tool: "prettier", kind: "format" }],
			});

			const payload = emit.mock.calls[0][1] as {
				fixes: Array<{ path: string; tool: string; kind: string }>;
			};
			expect(payload.fixes).toHaveLength(1);
			expect(payload.fixes[0].tool).toBe("prettier");
			expect(payload.fixes[0].kind).toBe("format");
			expect(payload.fixes[0].path).not.toContain("\\");
		});

		it("omits fixes when an empty array is passed", async () => {
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
				fixes: [],
			});

			const payload = emit.mock.calls[0][1] as Record<string, unknown>;
			expect(payload.fixes).toBeUndefined();
		});

		it("supports multiple fix entries per path (multi-tool autofix batch)", async () => {
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
				fixes: [
					{ path: "/repo/a.ts", tool: "ruff", kind: "autofix" },
					{ path: "/repo/a.ts", tool: "biome", kind: "autofix" },
				],
			});

			const payload = emit.mock.calls[0][1] as {
				fixes: Array<{ path: string; tool: string; kind: string }>;
			};
			expect(payload.fixes).toHaveLength(2);
			expect(payload.fixes.map((f) => f.tool)).toEqual(["ruff", "biome"]);
		});
	});

	describe("#492: recent-touches producer seam", () => {
		it("appends to the cross-process record at the same call, even with no busEmit wired", async () => {
			// No wireBusEmitter call — mirrors a bare/MCP host with no pi.events.
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});

			expect(appendRecentTouches).toHaveBeenCalledTimes(1);
			expect(appendRecentTouches).toHaveBeenCalledWith(
				expect.objectContaining({
					cwd: "/repo",
					reason: "autofix",
					paths: ["/repo/a.ts"],
				}),
			);
		});

		it("passes sessionId through to the record when provided", async () => {
			publishFilesTouched({
				reason: "format",
				paths: ["/repo/b.ts"],
				cwd: "/repo",
				sessionId: "session-123",
			});

			expect(appendRecentTouches).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: "session-123" }),
			);
		});

		it("does not append for an empty paths batch (same guard as the bus emit)", async () => {
			publishFilesTouched({ reason: "autofix", paths: [], cwd: "/repo" });
			expect(appendRecentTouches).not.toHaveBeenCalled();
		});

		it("does not append when origin is 'bus' (loop guard applies to both deliveries)", async () => {
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
				origin: "bus",
			});
			expect(appendRecentTouches).not.toHaveBeenCalled();
		});

		it("does not append when PI_LENS_BUS_PUBLISH=0 (same kill switch as the bus emit)", async () => {
			process.env.PI_LENS_BUS_PUBLISH = "0";
			_resetForTests();
			appendRecentTouches.mockClear();

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});
			expect(appendRecentTouches).not.toHaveBeenCalled();
		});

		it("a record-append rejection is swallowed and dbg-logged, never thrown into the publish path", async () => {
			appendRecentTouches.mockRejectedValueOnce(new Error("disk full"));
			const dbg = vi.fn();

			expect(() =>
				publishFilesTouched({
					reason: "autofix",
					paths: ["/repo/a.ts"],
					cwd: "/repo",
					dbg,
				}),
			).not.toThrow();

			// The append is fire-and-forget (not awaited by publishFilesTouched) —
			// flush the microtask queue so the rejection handler has run.
			await new Promise((r) => setImmediate(r));
			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining("recent-touches append failed"),
			);
		});

		// #5377: the append's locked commit publishes with a throwing atomic
		// write, so a lost batch now reaches this catch instead of vanishing.
		// The dbg line is caller-local; the degradation row is what an operator
		// sees, bounded to one row per project per session.
		it("records one bounded degradation row for a rejected append", async () => {
			appendRecentTouches
				.mockRejectedValueOnce(new Error("Timed out waiting for a lock"))
				.mockRejectedValueOnce(new Error("Timed out waiting for a lock"));

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo-5377/a.ts"],
				cwd: "/repo-5377",
			});
			publishFilesTouched({
				reason: "format",
				paths: ["/repo-5377/b.ts"],
				cwd: "/repo-5377",
			});
			await new Promise((r) => setImmediate(r));

			const groups = getDegradationSummary().filter(
				(group) => group.kind === "recent-touches-append-failed",
			);
			expect(groups).toHaveLength(1);
			expect(groups[0].count).toBe(1);
		});
	});

	describe("bus-events.log (persistent trace)", () => {
		it("logs 'emitted' with a file count on a successful emit", async () => {
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts", "/repo/b.ts"],
				cwd: "/repo",
			});

			expect(await busRows()).toContainEqual(
				expect.objectContaining({
					event: BUS_FILES_TOUCHED_EVENT,
					outcome: "emitted",
					reason: "autofix",
					fileCount: 2,
				}),
			);
		});

		it("logs 'skipped_unwired' once when busEmit was never wired", async () => {
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/b.ts"],
				cwd: "/repo",
			});

			const unwiredCalls = (await busRows())
				.map((entry) => [entry])
				.filter(
					(c) => (c[0] as { outcome: string }).outcome === "skipped_unwired",
				);
			expect(unwiredCalls).toHaveLength(1);
		});

		it("logs 'skipped_disabled' once when the kill switch is off", async () => {
			process.env.PI_LENS_BUS_PUBLISH = "0";
			_resetForTests();
			await clearBusRows();
			const emit = vi.fn();
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/b.ts"],
				cwd: "/repo",
			});

			const disabledCalls = (await busRows())
				.map((entry) => [entry])
				.filter(
					(c) => (c[0] as { outcome: string }).outcome === "skipped_disabled",
				);
			expect(disabledCalls).toHaveLength(1);
		});

		it("logs 'emit_failed' with the error message when emit throws", async () => {
			const emit = vi.fn(() => {
				throw new Error("bus explosion");
			});
			wireBusEmitter(emit);

			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/a.ts"],
				cwd: "/repo",
			});

			expect(await busRows()).toContainEqual(
				expect.objectContaining({
					event: BUS_FILES_TOUCHED_EVENT,
					outcome: "emit_failed",
					reason: "autofix",
					error: expect.stringContaining("bus explosion"),
					ctxSource: "global-fallback",
				}),
			);
		});

		it("repeats the files:touched reason on its skip rows", async () => {
			const touch = () =>
				publishFilesTouched({
					reason: "autofix",
					paths: ["/repo/a.ts"],
					cwd: "/repo",
				});
			touch();
			process.env.PI_LENS_BUS_PUBLISH = "0";
			_resetForTests();
			touch();
			const skipped = (await busRows())
				.map((entry) => [entry])
				.map(([entry]) => entry as { outcome: string; reason?: string })
				.filter((entry) => entry.outcome.startsWith("skipped_"));
			expect(skipped.map((entry) => entry.outcome)).toEqual([
				"skipped_unwired",
				"skipped_disabled",
			]);
			expect(skipped.map((entry) => entry.reason)).toEqual([
				"autofix",
				"autofix",
			]);
		});

		it("does not log anything for an empty paths batch", async () => {
			publishFilesTouched({ reason: "autofix", paths: [], cwd: "/repo" });
			expect(await busRows()).toEqual([]);
		});
	});
});

/**
 * Recurrence these cells prevent (shape 83): eight publish functions in
 * five producers each hand-copied the disabled / unwired / stale / failure-latch
 * dance, and only some of the copies had a cell for each branch (the format
 * start, done and autofix events, the disposition event and the lens events had
 * none). Each producer's public caller is driven through `createBusPublisher`
 * with its real wiring, so a fault in the shared path reds every row.
 */
describe("shared publish seam: every pi.events producer", () => {
	const originalEnv = process.env.PI_LENS_BUS_PUBLISH;
	const staleCtx = {
		isIdle: () => {
			throw new Error("This extension ctx is stale after session replacement");
		},
	};
	const liveCtx = { isIdle: () => {} };

	type Site = {
		name: string;
		event: string;
		wireGetter: (getter: () => unknown) => void;
		/** Invoke the public caller once; resolves after a deferred emit settles. */
		call: (dbg: (msg: string) => void) => Promise<void>;
		/** The caller writes its unwired drop to the bus log (lens-events does not). */
		unwiredRow: boolean;
		/** The caller honours the kill switch and takes a `dbg` callback. */
		killSwitch: boolean;
	};
	const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
	const sites: Site[] = [
		{
			name: "files:touched",
			event: "pilens:files:touched",
			wireGetter: (g) => wireBusEmitterGetter(g as never),
			call: async (dbg) =>
				publishFilesTouched({
					reason: "format",
					paths: ["/repo/a.ts"],
					cwd: "/repo",
					dbg,
				}),
			unwiredRow: true,
			killSwitch: true,
		},
		{
			name: "diagnostics",
			event: "pilens:diagnostics",
			wireGetter: (g) => wireDiagnosticsBusEmitterGetter(g as never),
			call: async (dbg) =>
				publishDiagnostics({
					cwd: "/repo",
					files: [{ path: "/repo/a.ts", diagnostics: [] }],
					dbg,
				}),
			unwiredRow: true,
			killSwitch: true,
		},
		{
			name: "diagnostic:disposition",
			event: "pilens:diagnostic:disposition",
			wireGetter: (g) => wireDispositionBusEmitterGetter(g as never),
			call: async (dbg) =>
				publishDisposition({
					cwd: "/repo",
					filePath: "/repo/a.ts",
					disposition: "suppress",
					anchor: "x",
					dbg,
				}),
			unwiredRow: true,
			killSwitch: true,
		},
		{
			name: "format:queued",
			event: "pilens:format:queued",
			wireGetter: (g) => wireFormatEventsBusEmitterGetter(g as never),
			call: async (dbg) =>
				publishFormatQueued({
					cwd: "/repo",
					filePath: "/repo/a.ts",
					tool: "edit",
					kinds: ["format"],
					dbg,
				}),
			unwiredRow: true,
			killSwitch: true,
		},
		{
			name: "format:start",
			event: "pilens:format:start",
			wireGetter: (g) => wireFormatEventsBusEmitterGetter(g as never),
			call: async (dbg) =>
				publishFormatStart({ cwd: "/repo", paths: ["/repo/a.ts"], dbg }),
			unwiredRow: true,
			killSwitch: true,
		},
		{
			name: "format:done",
			event: "pilens:format:done",
			wireGetter: (g) => wireFormatEventsBusEmitterGetter(g as never),
			call: async (dbg) =>
				publishFormatDone({ cwd: "/repo", paths: ["/repo/a.ts"], dbg }),
			unwiredRow: true,
			killSwitch: true,
		},
		{
			name: "autofix:start",
			event: "pilens:autofix:start",
			wireGetter: (g) => wireFormatEventsBusEmitterGetter(g as never),
			call: async (dbg) =>
				publishAutofixStart({
					cwd: "/repo",
					paths: ["/repo/a.ts"],
					eligibleCount: 1,
					dbg,
				}),
			unwiredRow: true,
			killSwitch: true,
		},
		{
			name: "lens turn-findings",
			event: "pi-lens/turn-findings",
			wireGetter: (g) => initLensEventsGetter(g as never),
			call: async () => {
				emitLensTurnFindings({
					cwd: "/repo",
					filePaths: ["/repo/a.ts"],
					sessionId: "s",
					turnIndex: 1,
					blockerSections: 0,
					advisorySections: 0,
					content: "c",
				});
				await tick();
			},
			unwiredRow: false,
			killSwitch: false,
		},
	];

	const resetAll = async () => {
		_resetForTests();
		_resetDiagnosticsPublishForTests();
		_resetDispositionPublishForTests();
		_resetFormatEventsPublishForTests();
		_resetLensEventsForTests();
		resetDegradationLedger();
		await clearBusRows();
	};
	const rows = async (event: string, outcome: string) =>
		(await busRows())
			.map((entry) => [entry])
			.map(([entry]) => entry as { event: string; outcome: string })
			.filter((entry) => entry.event === event && entry.outcome === outcome);

	beforeEach(async () => {
		delete process.env.PI_LENS_BUS_PUBLISH;
		await resetAll();
	});
	afterEach(async () => {
		if (originalEnv === undefined) delete process.env.PI_LENS_BUS_PUBLISH;
		else process.env.PI_LENS_BUS_PUBLISH = originalEnv;
		await resetAll();
	});

	it("hands the first unwired publish of a process to onUnwired, with its event, instead of a bus row", async () => {
		// The lens producer writes its drop to the extension log, so the seam owns
		// that once-per-process latch for it (the log line itself is a no-op in
		// test mode).
		const onUnwired = vi.fn();
		const publisher = createBusPublisher(createLiveBusEmitter(), {
			module: "probe",
			onUnwired,
		});
		const call = (event: "pi-lens/findings" | "pi-lens/turn-findings") =>
			publisher.publish({ event, cwd: "/repo", build: () => ({}) });
		call("pi-lens/findings");
		call("pi-lens/turn-findings");
		expect(onUnwired.mock.calls).toEqual([["pi-lens/findings"]]);
		expect(await rows("pi-lens/findings", "skipped_unwired")).toHaveLength(0);
		publisher.reset();
		call("pi-lens/turn-findings");
		expect(onUnwired.mock.calls).toEqual([
			["pi-lens/findings"],
			["pi-lens/turn-findings"],
		]);
	});

	for (const site of sites) {
		describe(site.name, () => {
			it("emits to a live target and logs one emitted row", async () => {
				const emit = vi.fn();
				site.wireGetter(() => ({ emit, ctx: liveCtx }));
				await site.call(() => {});
				expect(emit).toHaveBeenCalledTimes(1);
				expect(emit.mock.calls[0][0]).toBe(site.event);
				expect(await rows(site.event, "emitted")).toHaveLength(1);
			});

			if (site.unwiredRow) {
				it("logs skipped_unwired once per process when no bus was wired", async () => {
					await site.call(() => {});
					await site.call(() => {});
					expect(await rows(site.event, "skipped_unwired")).toHaveLength(1);
				});
			}

			if (!site.unwiredRow) {
				it("writes its unwired drop to the extension log, never to the bus log", async () => {
					await site.call(() => {});
					await site.call(() => {});
					expect(await rows(site.event, "skipped_unwired")).toHaveLength(0);
				});
			}

			if (site.killSwitch) {
				it("logs skipped_disabled once and never emits when the kill switch is off", async () => {
					process.env.PI_LENS_BUS_PUBLISH = "0";
					await resetAll();
					const emit = vi.fn();
					site.wireGetter(() => ({ emit, ctx: liveCtx }));
					await site.call(() => {});
					await site.call(() => {});
					expect(emit).not.toHaveBeenCalled();
					expect(await rows(site.event, "skipped_disabled")).toHaveLength(1);
				});
			}

			it("declines a stale-session target, logging each decline and never emitting", async () => {
				const emit = vi.fn();
				site.wireGetter(() => ({ emit, ctx: staleCtx }));
				await site.call(() => {});
				await site.call(() => {});
				expect(emit).not.toHaveBeenCalled();
				expect(await rows(site.event, "skipped_stale_session")).toHaveLength(2);
			});

			it("logs every emit failure with its ctx source but reports the first of a run once, re-armed by a success", async () => {
				const dbg = vi.fn();
				let mode: "throw" | "ok" = "throw";
				const emit = vi.fn(() => {
					if (mode === "throw") {
						throw new Error(
							"This extension ctx is stale after session replacement",
						);
					}
				});
				site.wireGetter(() => ({ emit, ctx: liveCtx }));
				await site.call(dbg);
				await site.call(dbg);
				expect(await rows(site.event, "emit_failed")).toHaveLength(2);
				expect((await rows(site.event, "emit_failed"))[0]).toMatchObject({
					ctxSource: "own",
					error: expect.stringContaining("stale after session replacement"),
				});
				expect(getDegradationSummary()).toEqual([
					expect.objectContaining({ kind: "bus-stale", count: 1 }),
				]);
				if (site.killSwitch) expect(dbg).toHaveBeenCalledTimes(1);
				mode = "ok";
				await site.call(dbg);
				mode = "throw";
				await site.call(dbg);
				expect(await rows(site.event, "emit_failed")).toHaveLength(3);
				expect(getDegradationSummary()).toEqual([
					expect.objectContaining({ kind: "bus-stale", count: 2 }),
				]);
				if (site.killSwitch) expect(dbg).toHaveBeenCalledTimes(2);
			});
		});
	}
});

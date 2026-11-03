import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installBusSinkReader } from "../support/bus-sink-reader.js";
const { busRows, clearBusRows } = installBusSinkReader();

import { _resetForTests as _resetBusPublishForTests } from "../../clients/bus-publish.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_resetDiagnosticsPublishForTests,
	BUS_DIAGNOSTICS_EVENT,
	BUS_DIAGNOSTICS_VERSION,
	MAX_DIAGNOSTICS_PER_FILE_EVENT,
	publishDiagnostics,
	wasPreviouslyReportedDirty,
	wireDiagnosticsBusEmitter,
	wireDiagnosticsBusEmitterGetter,
	type PilensDiagnosticEntry,
	type PilensDiagnosticsPayload,
} from "../../clients/diagnostics-publish.js";

function diag(
	overrides: Partial<PilensDiagnosticEntry> = {},
): PilensDiagnosticEntry {
	return {
		severity: "error",
		message: "boom",
		tool: "eslint",
		...overrides,
	};
}

describe("diagnostics-publish — pilens:diagnostics (#502)", () => {
	const originalEnv = process.env.PI_LENS_BUS_PUBLISH;

	beforeEach(async () => {
		_resetDiagnosticsPublishForTests();
		_resetBusPublishForTests();
		resetDegradationLedger();
		await clearBusRows();
	});

	afterEach(async () => {
		_resetDiagnosticsPublishForTests();
		_resetBusPublishForTests();
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_BUS_PUBLISH;
		} else {
			process.env.PI_LENS_BUS_PUBLISH = originalEnv;
		}
	});

	it("emits the exact payload shape: v, source, cwd, seq, ts, files", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "/repo",
			files: [
				{
					path: "/repo/a.ts",
					diagnostics: [diag({ ruleId: "no-unused-vars" })],
				},
			],
		});

		expect(emit).toHaveBeenCalledTimes(1);
		const [channel, payload] = emit.mock.calls[0] as [
			string,
			PilensDiagnosticsPayload,
		];
		expect(channel).toBe(BUS_DIAGNOSTICS_EVENT);
		expect(payload.v).toBe(BUS_DIAGNOSTICS_VERSION);
		expect(payload.source).toBe("pi-lens");
		expect(payload.cwd).toEqual(expect.any(String));
		expect(payload.seq).toBe(1);
		expect(payload.ts).toEqual(expect.any(Number));
		expect(payload.files).toEqual([
			{
				path: expect.any(String),
				diagnostics: [
					expect.objectContaining({ ruleId: "no-unused-vars", tool: "eslint" }),
				],
			},
		]);
	});

	it("normalizes paths and cwd (backslashes -> forward slashes)", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "C:\\repo",
			files: [{ path: "C:\\repo\\src\\a.ts", diagnostics: [diag()] }],
		});

		const payload = emit.mock.calls[0][1] as PilensDiagnosticsPayload;
		expect(payload.cwd).not.toContain("\\");
		expect(payload.files[0].path).not.toContain("\\");
	});

	it("full-replace: an event mentioning a path carries the COMPLETE diagnostic set, not a delta", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [diag(), diag(), diag()] }],
		});
		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
		});

		const secondPayload = emit.mock.calls[1][1] as PilensDiagnosticsPayload;
		expect(secondPayload.files[0].diagnostics).toHaveLength(1);
	});

	it("explicit-clean: emits {path, diagnostics: []} exactly once on the dirty->clean transition", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		// dirty
		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
		});
		expect(wasPreviouslyReportedDirty("/repo/a.ts")).toBe(true);

		// transitions to clean -> caller passes explicit []
		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [] }],
		});
		expect(emit).toHaveBeenCalledTimes(2);
		const cleanPayload = emit.mock.calls[1][1] as PilensDiagnosticsPayload;
		expect(cleanPayload.files).toEqual([
			{ path: expect.any(String), diagnostics: [] },
		]);
		expect(wasPreviouslyReportedDirty("/repo/a.ts")).toBe(false);
	});

	it("does not repeatedly fire the clean event for an already-clean file", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
		});
		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [] }],
		});
		expect(emit).toHaveBeenCalledTimes(2);

		// A caller that (incorrectly) re-announces clean for an already-clean
		// path still gets an emit (the function doesn't suppress caller-driven
		// re-announcements) — but wasPreviouslyReportedDirty correctly reports
		// false so a well-behaved caller (the pipeline seam) would not call
		// again. This test documents that the SUPPRESSION responsibility is the
		// caller's (via wasPreviouslyReportedDirty), not this function's.
		expect(wasPreviouslyReportedDirty("/repo/a.ts")).toBe(false);
	});

	it("seq is monotonic across multiple emissions", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
		});
		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/b.ts", diagnostics: [diag()] }],
		});
		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/c.ts", diagnostics: [diag()] }],
		});

		const seqs = emit.mock.calls.map(
			(c) => (c[1] as PilensDiagnosticsPayload).seq,
		);
		expect(seqs).toEqual([1, 2, 3]);
	});

	it("caps diagnostics per file and marks truncated: true", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		const many = Array.from(
			{ length: MAX_DIAGNOSTICS_PER_FILE_EVENT + 5 },
			(_, i) =>
				diag({
					message: `issue ${i}`,
					severity: i % 2 === 0 ? "error" : "warning",
				}),
		);
		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: many }],
		});

		const payload = emit.mock.calls[0][1] as PilensDiagnosticsPayload;
		expect(payload.files[0].diagnostics.length).toBe(
			MAX_DIAGNOSTICS_PER_FILE_EVENT,
		);
		expect(payload.files[0].truncated).toBe(true);
	});

	it("does not set truncated when under the cap", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
		});

		const payload = emit.mock.calls[0][1] as PilensDiagnosticsPayload;
		expect(payload.files[0].truncated).toBeUndefined();
	});

	it("kill switch: PI_LENS_BUS_PUBLISH=0 disables publishing", async () => {
		process.env.PI_LENS_BUS_PUBLISH = "0";
		_resetBusPublishForTests();
		_resetDiagnosticsPublishForTests();
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
		});

		expect(emit).not.toHaveBeenCalled();
	});

	it("does not emit for an empty files batch", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({ cwd: "/repo", files: [] });

		expect(emit).not.toHaveBeenCalled();
	});

	it("origin-flag loop guard: events originating from an ingested bus event never re-publish", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			origin: "bus",
		});

		expect(emit).not.toHaveBeenCalled();
	});

	it("swallows emit throws and logs once via dbg without affecting the caller", async () => {
		const emit = vi.fn(() => {
			throw new Error("bus explosion");
		});
		wireDiagnosticsBusEmitter(emit);
		const dbg = vi.fn();

		expect(() =>
			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
				dbg,
			}),
		).not.toThrow();
		expect(dbg).toHaveBeenCalledTimes(1);

		expect(() =>
			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/b.ts", diagnostics: [diag()] }],
				dbg,
			}),
		).not.toThrow();
		expect(dbg).toHaveBeenCalledTimes(1);
	});

	it("batches multiple files in one event", async () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "/repo",
			files: [
				{ path: "/repo/a.ts", diagnostics: [diag()] },
				{ path: "/repo/b.ts", diagnostics: [] },
			],
		});

		expect(emit).toHaveBeenCalledTimes(1);
		const payload = emit.mock.calls[0][1] as PilensDiagnosticsPayload;
		expect(payload.files).toHaveLength(2);
	});

	// #4365 batch 1: the per-file cap (`capDiagnostics`) is the only bound on an
	// event's size, and its error-first selection decides which findings a bus
	// consumer ever sees. Each case below pins one branch of it.
	describe("per-file cap (#4365)", () => {
		const publishOne = (diagnostics: PilensDiagnosticEntry[]) => {
			const emit = vi.fn();
			wireDiagnosticsBusEmitter(emit);
			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics }],
			});
			return (emit.mock.calls[0][1] as PilensDiagnosticsPayload).files[0];
		};
		const many = (
			severity: PilensDiagnosticEntry["severity"],
			n: number,
			p: string,
		) =>
			Array.from({ length: n }, (_, i) =>
				diag({ severity, message: `${p}${i}` }),
			);

		it("passes exactly MAX diagnostics through untouched: same order, not truncated", async () => {
			// Pins `diagnostics.length <= MAX` (survivor: `<`). At exactly MAX the
			// mutant sent the set through the error-first reorder and set
			// `truncated: true` though nothing was dropped. Warnings come first so a
			// reorder is visible.
			const set = [
				...many("warning", MAX_DIAGNOSTICS_PER_FILE_EVENT - 3, "w"),
				...many("error", 3, "e"),
			];
			expect(set).toHaveLength(MAX_DIAGNOSTICS_PER_FILE_EVENT);

			const entry = publishOne(set);

			expect(entry.diagnostics.map((d) => d.message)).toEqual(
				set.map((d) => d.message),
			);
			expect(entry.truncated).toBeUndefined();
		});

		it("over the cap, keeps every error first, then the first warnings in input order", async () => {
			// Pins the `errors` / `rest` partition and the `MAX - errors.length`
			// fill (survivors on both filter predicates and their `"error"`
			// literals). Errors and warnings are interleaved, so a `rest` that still
			// held errors would repeat them in the tail, and a plain `slice(0, MAX)`
			// would keep the early warnings ahead of the later errors.
			const w = many("warning", 10, "w");
			const e = many("error", 5, "e");
			const entry = publishOne([
				w[0],
				w[1],
				e[0],
				w[2],
				w[3],
				e[1],
				w[4],
				e[2],
				w[5],
				w[6],
				e[3],
				w[7],
				e[4],
				w[8],
				w[9],
			]);

			expect(entry.diagnostics.map((d) => d.message)).toEqual([
				"e0",
				"e1",
				"e2",
				"e3",
				"e4",
				"w0",
				"w1",
				"w2",
				"w3",
				"w4",
				"w5",
				"w6",
			]);
			expect(entry.truncated).toBe(true);
		});

		it("with more than MAX errors, sends the first MAX errors and no warning", async () => {
			// Pins the `errors.length >= MAX` branch (survivors: `false`, and the
			// uncovered block, object, `errors.slice(0, MAX)` and `truncated: true`
			// inside it). Without the branch the fill count goes negative and
			// `rest.slice(0, -n)` leaks warnings and every error past the cap.
			const errors = many("error", MAX_DIAGNOSTICS_PER_FILE_EVENT + 3, "e");

			const entry = publishOne([...many("warning", 5, "w"), ...errors]);

			expect(entry.diagnostics.map((d) => d.message)).toEqual(
				errors.slice(0, MAX_DIAGNOSTICS_PER_FILE_EVENT).map((d) => d.message),
			);
			expect(entry.truncated).toBe(true);
		});

		it("treats every non-error severity as rest: info and hint fill the tail behind the errors", async () => {
			// Pins `rest` as the exact complement of `errors` (survivors on the
			// `rest` filter's `!==` and its `"error"` literal): info and hint
			// entries must neither displace the error nor be dropped or doubled.
			const entry = publishOne([
				...many("info", 8, "i"),
				...many("hint", 8, "h"),
				diag({ severity: "error", message: "e0" }),
			]);

			expect(entry.diagnostics.map((d) => d.message)).toEqual([
				"e0",
				...many("info", 8, "i").map((d) => d.message),
				"h0",
				"h1",
				"h2",
			]);
		});
	});

	describe("emitter wiring (#4365)", () => {
		it("resolves a getter-wired emitter at each publish, so a rewire is honoured", async () => {
			// Pins `wireDiagnosticsBusEmitterGetter` (uncovered: block and the
			// `liveEmitter.wireGetter(getter)` call). Session replacement re-wires
			// the getter; the next publish must reach the NEW emitter.
			const first = vi.fn();
			const second = vi.fn();
			let current = first;
			wireDiagnosticsBusEmitterGetter(() => current);

			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			});
			current = second;
			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/b.ts", diagnostics: [diag()] }],
			});

			expect(first).toHaveBeenCalledTimes(1);
			expect(second).toHaveBeenCalledTimes(1);
		});

		it("declines a stale-session target without emitting, and logs the decline with event and cwd", async () => {
			// Pins the `stale-session` early return and its log thunk (survivors:
			// `outcome === "stale-session"` to `false` / `""`, the thunk
			// `() => ({...})` to `() => undefined`, and the uncovered object
			// literal). A stale ctx throws on use, so emitting would crash the
			// turn; the decline must be recorded against this event and cwd.
			const emit = vi.fn();
			const staleCtx = {
				isIdle: () => {
					throw new Error(
						"This extension ctx is stale after session replacement or reload",
					);
				},
			};
			wireDiagnosticsBusEmitterGetter(() => ({ emit, ctx: staleCtx }));

			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			});

			expect(emit).not.toHaveBeenCalled();
			expect(await busRows()).toContainEqual(
				expect.objectContaining({
					event: BUS_DIAGNOSTICS_EVENT,
					outcome: "skipped_stale_session",
					cwd: expect.stringContaining("repo"),
				}),
			);
			// The decline is the ONLY row: no emit_failed from a fall-through to the
			// emit path with a missing emitter.
			expect(
				(await busRows())
					.map((entry) => [entry])
					.map((c) => (c[0] as { outcome: string }).outcome),
			).toEqual(["skipped_stale_session"]);
		});

		it("logs and ledgers each stale emit failure after a successful recovery", async () => {
			// Sibling of bus-publish's "logs and ledgers each stale occurrence
			// after a successful recovery". Pins `hasLoggedFailure = false` on a
			// successful emit (survivor: `true`, which silences every later
			// failure) and `recordStaleBusFailure` (survivor: removed, so the
			// dead-activation row never reaches the degradation ledger).
			const stale = vi.fn(() => {
				throw new Error(
					"This extension ctx is stale after session replacement or reload",
				);
			});
			const recovered = vi.fn();
			let currentEmit: (channel: string, data: unknown) => void = stale;
			wireDiagnosticsBusEmitterGetter(() => currentEmit);
			const dbg = vi.fn();
			const publish = (file: string) =>
				publishDiagnostics({
					cwd: "/repo",
					files: [{ path: file, diagnostics: [diag()] }],
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

		it("records each one-time degradation on the first occurrence in a fresh process", async () => {
			// Pins the module-initial value of the three once-only latches
			// (survivors: `let hasLoggedFailure/Unwired/Disabled = false` to
			// `true`). `_resetDiagnosticsPublishForTests` re-arms them, so only a
			// fresh module instance sees the real initial state.
			vi.resetModules();
			const fresh = await import("../../clients/diagnostics-publish.js");
			const freshBus = await import("../../clients/bus-publish.js");
			freshBus._resetForTests();
			const entry = {
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			};
			const outcomes = async () =>
				(await busRows())
					.map((entry) => [entry])
					.map((c) => (c[0] as { outcome: string }).outcome);

			// Unwired: nothing wired yet.
			fresh.publishDiagnostics(entry);
			expect(await outcomes()).toContain("skipped_unwired");

			// Failure: a throwing emitter reports through `dbg` on the first throw.
			const dbg = vi.fn();
			fresh.wireDiagnosticsBusEmitter(() => {
				throw new Error("boom");
			});
			fresh.publishDiagnostics({ ...entry, dbg });
			expect(dbg).toHaveBeenCalledTimes(1);

			// Disabled: the kill switch logs once.
			process.env.PI_LENS_BUS_PUBLISH = "0";
			freshBus._resetForTests();
			fresh.publishDiagnostics(entry);
			expect(await outcomes()).toContain("skipped_disabled");
		});
	});

	describe("bus-events.log (persistent trace)", () => {
		it("logs 'emitted' with fileCount and seq on a successful emit", async () => {
			const emit = vi.fn();
			wireDiagnosticsBusEmitter(emit);

			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			});

			expect(await busRows()).toContainEqual(
				expect.objectContaining({
					event: BUS_DIAGNOSTICS_EVENT,
					outcome: "emitted",
					fileCount: 1,
					seq: 1,
				}),
			);
		});

		it("logs 'skipped_unwired' once when busEmit was never wired", async () => {
			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			});
			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/b.ts", diagnostics: [diag()] }],
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
			_resetBusPublishForTests();
			_resetDiagnosticsPublishForTests();
			await clearBusRows();
			const emit = vi.fn();
			wireDiagnosticsBusEmitter(emit);

			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			});
			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/b.ts", diagnostics: [diag()] }],
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
			wireDiagnosticsBusEmitter(emit);

			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			});

			expect(await busRows()).toContainEqual(
				expect.objectContaining({
					event: BUS_DIAGNOSTICS_EVENT,
					outcome: "emit_failed",
					error: expect.stringContaining("bus explosion"),
				}),
			);
		});

		it("does not log anything for an empty files batch", async () => {
			publishDiagnostics({ cwd: "/repo", files: [] });
			expect(await busRows()).toEqual([]);
		});
	});
});

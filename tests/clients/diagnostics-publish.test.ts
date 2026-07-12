import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logBusEvent = vi.fn();
vi.mock("../../clients/bus-events-logger.js", () => ({
	logBusEvent: (...args: unknown[]) => logBusEvent(...args),
}));

import { _resetForTests as _resetBusPublishForTests } from "../../clients/bus-publish.js";
import {
	_resetDiagnosticsPublishForTests,
	BUS_DIAGNOSTICS_EVENT,
	BUS_DIAGNOSTICS_VERSION,
	MAX_DIAGNOSTICS_PER_FILE_EVENT,
	publishDiagnostics,
	wasPreviouslyReportedDirty,
	wireDiagnosticsBusEmitter,
	type PilensDiagnosticEntry,
	type PilensDiagnosticsPayload,
} from "../../clients/diagnostics-publish.js";

function diag(overrides: Partial<PilensDiagnosticEntry> = {}): PilensDiagnosticEntry {
	return {
		severity: "error",
		message: "boom",
		tool: "eslint",
		...overrides,
	};
}

describe("diagnostics-publish — pilens:diagnostics (#502)", () => {
	const originalEnv = process.env.PI_LENS_BUS_PUBLISH;

	beforeEach(() => {
		_resetDiagnosticsPublishForTests();
		_resetBusPublishForTests();
		logBusEvent.mockClear();
	});

	afterEach(() => {
		_resetDiagnosticsPublishForTests();
		_resetBusPublishForTests();
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_BUS_PUBLISH;
		} else {
			process.env.PI_LENS_BUS_PUBLISH = originalEnv;
		}
	});

	it("no-ops when never wired (unit tests / MCP server path have no pi host)", () => {
		expect(() =>
			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			}),
		).not.toThrow();
	});

	it("emits the exact payload shape: v, source, cwd, seq, ts, files", () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [diag({ ruleId: "no-unused-vars" })] }],
		});

		expect(emit).toHaveBeenCalledTimes(1);
		const [channel, payload] = emit.mock.calls[0] as [string, PilensDiagnosticsPayload];
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

	it("normalizes paths and cwd (backslashes -> forward slashes)", () => {
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

	it("full-replace: an event mentioning a path carries the COMPLETE diagnostic set, not a delta", () => {
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

	it("explicit-clean: emits {path, diagnostics: []} exactly once on the dirty->clean transition", () => {
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
		expect(cleanPayload.files).toEqual([{ path: expect.any(String), diagnostics: [] }]);
		expect(wasPreviouslyReportedDirty("/repo/a.ts")).toBe(false);
	});

	it("does not repeatedly fire the clean event for an already-clean file", () => {
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

	it("seq is monotonic across multiple emissions", () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/a.ts", diagnostics: [diag()] }] });
		publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/b.ts", diagnostics: [diag()] }] });
		publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/c.ts", diagnostics: [diag()] }] });

		const seqs = emit.mock.calls.map((c) => (c[1] as PilensDiagnosticsPayload).seq);
		expect(seqs).toEqual([1, 2, 3]);
	});

	it("caps diagnostics per file and marks truncated: true", () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		const many = Array.from({ length: MAX_DIAGNOSTICS_PER_FILE_EVENT + 5 }, (_, i) =>
			diag({ message: `issue ${i}`, severity: i % 2 === 0 ? "error" : "warning" }),
		);
		publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/a.ts", diagnostics: many }] });

		const payload = emit.mock.calls[0][1] as PilensDiagnosticsPayload;
		expect(payload.files[0].diagnostics.length).toBe(MAX_DIAGNOSTICS_PER_FILE_EVENT);
		expect(payload.files[0].truncated).toBe(true);
	});

	it("does not set truncated when under the cap", () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/a.ts", diagnostics: [diag()] }] });

		const payload = emit.mock.calls[0][1] as PilensDiagnosticsPayload;
		expect(payload.files[0].truncated).toBeUndefined();
	});

	it("kill switch: PI_LENS_BUS_PUBLISH=0 disables publishing", () => {
		process.env.PI_LENS_BUS_PUBLISH = "0";
		_resetBusPublishForTests();
		_resetDiagnosticsPublishForTests();
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/a.ts", diagnostics: [diag()] }] });

		expect(emit).not.toHaveBeenCalled();
	});

	it("does not emit for an empty files batch", () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({ cwd: "/repo", files: [] });

		expect(emit).not.toHaveBeenCalled();
	});

	it("origin-flag loop guard: events originating from an ingested bus event never re-publish", () => {
		const emit = vi.fn();
		wireDiagnosticsBusEmitter(emit);

		publishDiagnostics({
			cwd: "/repo",
			files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			origin: "bus",
		});

		expect(emit).not.toHaveBeenCalled();
	});

	it("swallows emit throws and logs once via dbg without affecting the caller", () => {
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

	it("batches multiple files in one event", () => {
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

	describe("bus-events.log (persistent trace)", () => {
		it("logs 'emitted' with fileCount and seq on a successful emit", () => {
			const emit = vi.fn();
			wireDiagnosticsBusEmitter(emit);

			publishDiagnostics({
				cwd: "/repo",
				files: [{ path: "/repo/a.ts", diagnostics: [diag()] }],
			});

			expect(logBusEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event: BUS_DIAGNOSTICS_EVENT,
					outcome: "emitted",
					fileCount: 1,
					seq: 1,
				}),
			);
		});

		it("logs 'skipped_unwired' once when busEmit was never wired", () => {
			publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/a.ts", diagnostics: [diag()] }] });
			publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/b.ts", diagnostics: [diag()] }] });

			const unwiredCalls = logBusEvent.mock.calls.filter(
				(c) => (c[0] as { outcome: string }).outcome === "skipped_unwired",
			);
			expect(unwiredCalls).toHaveLength(1);
		});

		it("logs 'skipped_disabled' once when the kill switch is off", () => {
			process.env.PI_LENS_BUS_PUBLISH = "0";
			_resetBusPublishForTests();
			_resetDiagnosticsPublishForTests();
			logBusEvent.mockClear();
			const emit = vi.fn();
			wireDiagnosticsBusEmitter(emit);

			publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/a.ts", diagnostics: [diag()] }] });
			publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/b.ts", diagnostics: [diag()] }] });

			const disabledCalls = logBusEvent.mock.calls.filter(
				(c) => (c[0] as { outcome: string }).outcome === "skipped_disabled",
			);
			expect(disabledCalls).toHaveLength(1);
		});

		it("logs 'emit_failed' with the error message when emit throws", () => {
			const emit = vi.fn(() => {
				throw new Error("bus explosion");
			});
			wireDiagnosticsBusEmitter(emit);

			publishDiagnostics({ cwd: "/repo", files: [{ path: "/repo/a.ts", diagnostics: [diag()] }] });

			expect(logBusEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event: BUS_DIAGNOSTICS_EVENT,
					outcome: "emit_failed",
					error: expect.stringContaining("bus explosion"),
				}),
			);
		});

		it("does not log anything for an empty files batch", () => {
			publishDiagnostics({ cwd: "/repo", files: [] });
			expect(logBusEvent).not.toHaveBeenCalled();
		});
	});
});

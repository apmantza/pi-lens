import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logBusEvent = vi.fn();
vi.mock("../../clients/bus-events-logger.js", () => ({
	logBusEvent: (...args: unknown[]) => logBusEvent(...args),
}));

import {
	_resetFormatEventsPublishForTests,
	BUS_AUTOFIX_START_EVENT,
	BUS_AUTOFIX_START_VERSION,
	BUS_FORMAT_QUEUED_EVENT,
	BUS_FORMAT_QUEUED_VERSION,
	BUS_FORMAT_START_EVENT,
	BUS_FORMAT_START_VERSION,
	publishAutofixStart,
	publishFormatQueued,
	publishFormatStart,
	wireFormatEventsBusEmitter,
} from "../../clients/format-events-publish.js";
import { _resetForTests as _resetBusPublishForTests } from "../../clients/bus-publish.js";

describe("format-events-publish — pilens:format:queued / pilens:format:start (#673)", () => {
	const originalEnv = process.env.PI_LENS_BUS_PUBLISH;

	beforeEach(() => {
		_resetFormatEventsPublishForTests();
		_resetBusPublishForTests();
		logBusEvent.mockClear();
	});

	afterEach(() => {
		_resetFormatEventsPublishForTests();
		_resetBusPublishForTests();
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_BUS_PUBLISH;
		} else {
			process.env.PI_LENS_BUS_PUBLISH = originalEnv;
		}
	});

	describe("pilens:format:queued", () => {
		it("no-ops when never wired (unit tests / MCP server path have no pi host)", () => {
			expect(() =>
				publishFormatQueued({
					filePath: "/repo/src/a.ts",
					cwd: "/repo",
					tool: "write",
				}),
			).not.toThrow();
		});

		it("emits the exact payload shape: v, source, filePath, cwd, tool", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishFormatQueued({
				filePath: "/repo/src/a.ts",
				cwd: "/repo",
				tool: "edit",
			});

			expect(emit).toHaveBeenCalledTimes(1);
			const [channel, payload] = emit.mock.calls[0] as [
				string,
				Record<string, unknown>,
			];
			expect(channel).toBe(BUS_FORMAT_QUEUED_EVENT);
			expect(payload).toMatchObject({
				v: BUS_FORMAT_QUEUED_VERSION,
				source: "pi-lens",
				tool: "edit",
			});
			expect(payload.filePath).toEqual(expect.any(String));
			expect(payload.cwd).toEqual(expect.any(String));
		});

		it("normalizes filePath and cwd (backslashes -> forward slashes)", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishFormatQueued({
				filePath: "C:\\repo\\src\\a.ts",
				cwd: "C:\\repo",
				tool: "write",
			});

			const payload = emit.mock.calls[0][1] as {
				filePath: string;
				cwd: string;
			};
			expect(payload.filePath).not.toContain("\\");
			expect(payload.cwd).not.toContain("\\");
		});

		it("kill switch: PI_LENS_BUS_PUBLISH=0 disables publishing", () => {
			process.env.PI_LENS_BUS_PUBLISH = "0";
			_resetBusPublishForTests();
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishFormatQueued({
				filePath: "/repo/a.ts",
				cwd: "/repo",
				tool: "write",
			});

			expect(emit).not.toHaveBeenCalled();
		});

		it("swallows emit throws and logs once via dbg without affecting the caller", () => {
			const emit = vi.fn(() => {
				throw new Error("bus explosion");
			});
			wireFormatEventsBusEmitter(emit);
			const dbg = vi.fn();

			expect(() =>
				publishFormatQueued({
					filePath: "/repo/a.ts",
					cwd: "/repo",
					tool: "write",
					dbg,
				}),
			).not.toThrow();
			expect(dbg).toHaveBeenCalledTimes(1);

			expect(() =>
				publishFormatQueued({
					filePath: "/repo/b.ts",
					cwd: "/repo",
					tool: "write",
					dbg,
				}),
			).not.toThrow();
			// Second failure is swallowed but NOT re-logged (log-once).
			expect(dbg).toHaveBeenCalledTimes(1);
		});

		it("logs 'emitted' with fileCount 1 on a successful emit", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishFormatQueued({
				filePath: "/repo/a.ts",
				cwd: "/repo",
				tool: "write",
			});

			expect(logBusEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event: BUS_FORMAT_QUEUED_EVENT,
					outcome: "emitted",
					fileCount: 1,
				}),
			);
		});

		it("logs 'skipped_unwired' once when busEmit was never wired", () => {
			publishFormatQueued({ filePath: "/repo/a.ts", cwd: "/repo", tool: "write" });
			publishFormatQueued({ filePath: "/repo/b.ts", cwd: "/repo", tool: "write" });

			const unwiredCalls = logBusEvent.mock.calls.filter(
				(c) => (c[0] as { outcome: string }).outcome === "skipped_unwired",
			);
			expect(unwiredCalls).toHaveLength(1);
		});
	});

	describe("pilens:format:start", () => {
		it("no-ops when never wired", () => {
			expect(() =>
				publishFormatStart({ cwd: "/repo", paths: ["/repo/a.ts"] }),
			).not.toThrow();
		});

		it("emits the exact payload shape: v, source, cwd, paths, fileCount", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishFormatStart({
				cwd: "/repo",
				paths: ["/repo/a.ts", "/repo/b.ts"],
			});

			expect(emit).toHaveBeenCalledTimes(1);
			const [channel, payload] = emit.mock.calls[0] as [
				string,
				Record<string, unknown>,
			];
			expect(channel).toBe(BUS_FORMAT_START_EVENT);
			expect(payload).toMatchObject({
				v: BUS_FORMAT_START_VERSION,
				source: "pi-lens",
				fileCount: 2,
			});
			expect(payload.paths).toHaveLength(2);
		});

		it("does not emit for an empty paths batch", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishFormatStart({ cwd: "/repo", paths: [] });

			expect(emit).not.toHaveBeenCalled();
		});

		it("does not log anything for an empty paths batch", () => {
			publishFormatStart({ cwd: "/repo", paths: [] });
			expect(logBusEvent).not.toHaveBeenCalled();
		});

		it("normalizes paths and cwd", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishFormatStart({
				cwd: "C:\\repo",
				paths: ["C:\\repo\\a.ts"],
			});

			const payload = emit.mock.calls[0][1] as {
				paths: string[];
				cwd: string;
			};
			expect(payload.paths[0]).not.toContain("\\");
			expect(payload.cwd).not.toContain("\\");
		});

		it("kill switch: PI_LENS_BUS_PUBLISH=0 disables publishing", () => {
			process.env.PI_LENS_BUS_PUBLISH = "0";
			_resetBusPublishForTests();
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishFormatStart({ cwd: "/repo", paths: ["/repo/a.ts"] });

			expect(emit).not.toHaveBeenCalled();
		});

		it("swallows emit throws and logs once via dbg without affecting the caller", () => {
			const emit = vi.fn(() => {
				throw new Error("bus explosion");
			});
			wireFormatEventsBusEmitter(emit);
			const dbg = vi.fn();

			expect(() =>
				publishFormatStart({ cwd: "/repo", paths: ["/repo/a.ts"], dbg }),
			).not.toThrow();
			expect(dbg).toHaveBeenCalledTimes(1);

			expect(() =>
				publishFormatStart({ cwd: "/repo", paths: ["/repo/b.ts"], dbg }),
			).not.toThrow();
			expect(dbg).toHaveBeenCalledTimes(1);
		});

		it("logs 'emitted' with the file count on a successful emit", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishFormatStart({
				cwd: "/repo",
				paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
			});

			expect(logBusEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event: BUS_FORMAT_START_EVENT,
					outcome: "emitted",
					fileCount: 3,
				}),
			);
		});
	});

	describe("pilens:autofix:start (#684)", () => {
		it("no-ops when never wired", () => {
			expect(() =>
				publishAutofixStart({
					cwd: "/repo",
					paths: ["/repo/a.ts"],
					eligibleCount: 1,
				}),
			).not.toThrow();
		});

		it("emits the exact payload shape: v, source, cwd, paths, fileCount, eligibleCount", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishAutofixStart({
				cwd: "/repo",
				paths: ["/repo/a.ts", "/repo/b.ts"],
				eligibleCount: 3,
			});

			expect(emit).toHaveBeenCalledTimes(1);
			const [channel, payload] = emit.mock.calls[0] as [
				string,
				Record<string, unknown>,
			];
			expect(channel).toBe(BUS_AUTOFIX_START_EVENT);
			expect(payload).toMatchObject({
				v: BUS_AUTOFIX_START_VERSION,
				source: "pi-lens",
				fileCount: 2,
				eligibleCount: 3,
			});
			expect(payload.paths).toHaveLength(2);
		});

		it("does not emit for an empty paths batch", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishAutofixStart({ cwd: "/repo", paths: [], eligibleCount: 0 });

			expect(emit).not.toHaveBeenCalled();
		});

		it("does not log anything for an empty paths batch", () => {
			publishAutofixStart({ cwd: "/repo", paths: [], eligibleCount: 0 });
			expect(logBusEvent).not.toHaveBeenCalled();
		});

		it("normalizes paths and cwd", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishAutofixStart({
				cwd: "C:\\repo",
				paths: ["C:\\repo\\a.ts"],
				eligibleCount: 1,
			});

			const payload = emit.mock.calls[0][1] as {
				paths: string[];
				cwd: string;
			};
			expect(payload.paths[0]).not.toContain("\\");
			expect(payload.cwd).not.toContain("\\");
		});

		it("kill switch: PI_LENS_BUS_PUBLISH=0 disables publishing", () => {
			process.env.PI_LENS_BUS_PUBLISH = "0";
			_resetBusPublishForTests();
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishAutofixStart({
				cwd: "/repo",
				paths: ["/repo/a.ts"],
				eligibleCount: 1,
			});

			expect(emit).not.toHaveBeenCalled();
		});

		it("swallows emit throws and logs once via dbg without affecting the caller", () => {
			const emit = vi.fn(() => {
				throw new Error("bus explosion");
			});
			wireFormatEventsBusEmitter(emit);
			const dbg = vi.fn();

			expect(() =>
				publishAutofixStart({
					cwd: "/repo",
					paths: ["/repo/a.ts"],
					eligibleCount: 1,
					dbg,
				}),
			).not.toThrow();
			expect(dbg).toHaveBeenCalledTimes(1);

			expect(() =>
				publishAutofixStart({
					cwd: "/repo",
					paths: ["/repo/b.ts"],
					eligibleCount: 1,
					dbg,
				}),
			).not.toThrow();
			expect(dbg).toHaveBeenCalledTimes(1);
		});

		it("logs 'emitted' with the file count on a successful emit", () => {
			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			publishAutofixStart({
				cwd: "/repo",
				paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
				eligibleCount: 5,
			});

			expect(logBusEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event: BUS_AUTOFIX_START_EVENT,
					outcome: "emitted",
					fileCount: 3,
				}),
			);
		});
	});
});

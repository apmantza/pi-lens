import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetForTests,
	BUS_FILES_TOUCHED_EVENT,
	BUS_FILES_TOUCHED_VERSION,
	isBusPublishEnabled,
	publishFilesTouched,
	wireBusEmitter,
} from "../../clients/bus-publish.js";

describe("bus-publish — pilens:files:touched (#482)", () => {
	const originalEnv = process.env.PI_LENS_BUS_PUBLISH;

	beforeEach(() => {
		_resetForTests();
	});

	afterEach(() => {
		_resetForTests();
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_BUS_PUBLISH;
		} else {
			process.env.PI_LENS_BUS_PUBLISH = originalEnv;
		}
	});

	it("no-ops when never wired (unit tests / MCP server path have no pi host)", () => {
		expect(() =>
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/src/a.ts"],
				cwd: "/repo",
			}),
		).not.toThrow();
	});

	it("emits the exact payload shape from the issue: v, source, reason, paths, cwd", () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({
			reason: "autofix",
			paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
			cwd: "/repo",
		});

		expect(emit).toHaveBeenCalledTimes(1);
		const [channel, payload] = emit.mock.calls[0] as [string, Record<string, unknown>];
		expect(channel).toBe(BUS_FILES_TOUCHED_EVENT);
		expect(payload).toMatchObject({
			v: BUS_FILES_TOUCHED_VERSION,
			source: "pi-lens",
			reason: "autofix",
		});
		expect(payload.paths).toHaveLength(2);
		expect(payload.cwd).toEqual(expect.any(String));
	});

	it("normalizes paths and cwd (backslashes -> forward slashes)", () => {
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

	it("batches: one emit call per publishFilesTouched invocation regardless of path count", () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({
			reason: "format",
			paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
			cwd: "/repo",
		});

		expect(emit).toHaveBeenCalledTimes(1);
		expect((emit.mock.calls[0][1] as { paths: string[] }).paths).toHaveLength(3);
	});

	it("does not emit for an empty paths batch", () => {
		const emit = vi.fn();
		wireBusEmitter(emit);

		publishFilesTouched({ reason: "autofix", paths: [], cwd: "/repo" });

		expect(emit).not.toHaveBeenCalled();
	});

	it("kill switch: PI_LENS_BUS_PUBLISH=0 disables publishing", () => {
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

	it("is enabled by default (no env var set)", () => {
		delete process.env.PI_LENS_BUS_PUBLISH;
		_resetForTests();
		expect(isBusPublishEnabled()).toBe(true);
	});

	it("origin-flag loop guard: events originating from an ingested bus event never re-publish", () => {
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

	it("swallows emit throws and logs once via dbg without affecting the caller", () => {
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
});

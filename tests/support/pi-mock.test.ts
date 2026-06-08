import { describe, expect, it } from "vitest";
import { createPiMock, makeCtx } from "./pi-mock.js";

describe("createPiMock", () => {
	it("records flags and exposes defaults via getFlag", () => {
		const pi = createPiMock();
		pi.registerFlag("no-lens", { type: "boolean", default: false });
		pi.registerFlag("lens-semgrep-config", { type: "string" });
		expect(pi.flags.has("no-lens")).toBe(true);
		expect(pi.getFlag("no-lens")).toBe(false); // seeded from default
		expect(pi.getFlag("lens-semgrep-config")).toBeUndefined();
	});

	it("setFlag overrides getFlag (and pre-set wins over default)", () => {
		const pi = createPiMock({ "no-lens-context": true });
		pi.registerFlag("no-lens-context", { type: "boolean", default: false });
		expect(pi.getFlag("no-lens-context")).toBe(true); // pre-set, not default
		pi.setFlag("no-lens-context", false);
		expect(pi.getFlag("no-lens-context")).toBe(false);
	});

	it("records tools and throws on duplicate names (like the host)", () => {
		const pi = createPiMock();
		pi.registerTool({ name: "lens_diagnostics" });
		expect(pi.getTool("lens_diagnostics")).toBeDefined();
		expect(() => pi.registerTool({ name: "lens_diagnostics" })).toThrow(
			/already registered/,
		);
	});

	it("records multiple handlers per event and emit runs them in order", async () => {
		const pi = createPiMock();
		const calls: number[] = [];
		pi.on("turn_end", () => {
			calls.push(1);
		});
		pi.on("turn_end", () => {
			calls.push(2);
			return { done: true };
		});
		const result = await pi.emit("turn_end", { foo: 1 }, makeCtx());
		expect(calls).toEqual([1, 2]);
		expect(result).toEqual({ done: true }); // last defined result
	});

	it("emit passes payload + ctx through to the handler", async () => {
		const pi = createPiMock();
		let seen: { event: unknown; cwd: unknown } | undefined;
		pi.on("context", (event, ctx) => {
			seen = { event, cwd: (ctx as { cwd: string }).cwd };
			return undefined;
		});
		await pi.emit("context", { messages: [] }, makeCtx({ cwd: "/tmp/x" }));
		expect(seen).toEqual({ event: { messages: [] }, cwd: "/tmp/x" });
	});

	it("getHandlerOrThrow throws when an event has no handler", () => {
		const pi = createPiMock();
		expect(() => pi.getHandlerOrThrow("session_start")).toThrow(/no handler/);
	});

	it("runCommand invokes the handler and captures notifications", async () => {
		const pi = createPiMock();
		pi.registerCommand("greet", {
			handler: (_args, ctx) => {
				ctx.ui.notify("hello", "info");
			},
		});
		const ctx = makeCtx();
		await pi.runCommand("greet", "", ctx);
		expect(ctx.notifications).toEqual([{ message: "hello", type: "info" }]);
	});
});

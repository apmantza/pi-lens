import { describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { makeRunnerCtx } from "./runner-ctx.js";

describe("makeRunnerCtx", () => {
	it("builds a DispatchContext with sane defaults from filePath/cwd", async () => {
		const ctx = makeRunnerCtx("/tmp/proj/sample.ts", "/tmp/proj");

		expect(ctx.filePath).toBe("/tmp/proj/sample.ts");
		expect(ctx.cwd).toBe("/tmp/proj");
		expect(ctx.kind).toBe("jsts");
		expect(ctx.fileRole).toBe("source");
		expect(ctx.autofix).toBe(false);
		expect(ctx.deltaMode).toBe(true);
		expect(ctx.facts).toBeInstanceOf(FactStore);
		expect(ctx.pi.getFlag("anything")).toBeUndefined();
		expect(await ctx.hasTool("ruff")).toBe(true);
		expect(ctx.log("hello")).toBeUndefined(); // no-op, doesn't throw
	});

	it("applies overrides on top of the defaults", async () => {
		const ctx = makeRunnerCtx("/tmp/proj/sample.py", "/tmp/proj", {
			kind: "python",
			autofix: true,
			hasTool: async () => false,
		});

		expect(ctx.kind).toBe("python");
		expect(ctx.autofix).toBe(true);
		expect(await ctx.hasTool("ruff")).toBe(false);
		// Un-overridden defaults are still present.
		expect(ctx.fileRole).toBe("source");
		expect(ctx.deltaMode).toBe(true);
	});

	it("each call gets its own fresh FactStore instance", () => {
		const a = makeRunnerCtx("/a.ts", "/");
		const b = makeRunnerCtx("/b.ts", "/");
		expect(a.facts).not.toBe(b.facts);
	});
});

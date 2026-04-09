import { describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { functionFactProvider } from "../../../../clients/dispatch/facts/function-facts.js";
import { asyncNoiseRule } from "../../../../clients/dispatch/rules/async-noise.js";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import type { FileKind } from "../../../../clients/file-kinds.js";

function makeCtx(filePath: string, facts: FactStore): DispatchContext {
  return {
    filePath,
    cwd: "/tmp",
    kind: "jsts" as FileKind,
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts,
    hasTool: async () => false,
    log: () => {},
  };
}

describe("asyncNoiseRule", () => {
  it("flags async function with no await", () => {
    const filePath = "/tmp/noise.ts";
    const content = `
async function noisy(v: number) {
  return v + 1;
}
`;

    const facts = new FactStore();
    const ctx = makeCtx(filePath, facts);
    facts.setFileFact(filePath, "file.content", content);
    functionFactProvider.run(ctx, facts);

    const diagnostics = asyncNoiseRule.evaluate(ctx, facts);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].rule).toBe("async-noise");
  });

  it("does not flag async function with await", () => {
    const filePath = "/tmp/awaited.ts";
    const content = `
async function good(v: Promise<number>) {
  return await v;
}
`;

    const facts = new FactStore();
    const ctx = makeCtx(filePath, facts);
    facts.setFileFact(filePath, "file.content", content);
    functionFactProvider.run(ctx, facts);

    const diagnostics = asyncNoiseRule.evaluate(ctx, facts);
    expect(diagnostics).toHaveLength(0);
  });

  it("does not flag pass-through wrappers", () => {
    const filePath = "/tmp/wrapper.ts";
    const content = `
async function wrapper(v: number) {
  return transform(v);
}
`;

    const facts = new FactStore();
    const ctx = makeCtx(filePath, facts);
    facts.setFileFact(filePath, "file.content", content);
    functionFactProvider.run(ctx, facts);

    const diagnostics = asyncNoiseRule.evaluate(ctx, facts);
    expect(diagnostics).toHaveLength(0);
  });
});

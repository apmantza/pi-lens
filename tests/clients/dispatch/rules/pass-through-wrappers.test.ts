import { describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { commentFactProvider } from "../../../../clients/dispatch/facts/comment-facts.js";
import { functionFactProvider } from "../../../../clients/dispatch/facts/function-facts.js";
import { passThroughWrappersRule } from "../../../../clients/dispatch/rules/pass-through-wrappers.js";
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

function seedFacts(filePath: string, content: string): { facts: FactStore; ctx: DispatchContext } {
  const facts = new FactStore();
  const ctx = makeCtx(filePath, facts);
  facts.setFileFact(filePath, "file.content", content);
  functionFactProvider.run(ctx, facts);
  commentFactProvider.run(ctx, facts);
  return { facts, ctx };
}

describe("passThroughWrappersRule", () => {
  it("flags trivial pass-through wrappers", () => {
    const { facts, ctx } = seedFacts(
      "/tmp/wrap.ts",
      `
function wrap(a: number) {
  return inner(a);
}
`,
    );

    const diagnostics = passThroughWrappersRule.evaluate(ctx, facts);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].rule).toBe("pass-through-wrappers");
  });

  it("does not flag intentional boundary wrappers", () => {
    const { facts, ctx } = seedFacts(
      "/tmp/boundary.ts",
      `
function fetchUser(id: string) {
  return fetch(id);
}
`,
    );

    const diagnostics = passThroughWrappersRule.evaluate(ctx, facts);
    expect(diagnostics).toHaveLength(0);
  });

  it("does not flag wrappers documented as alias/compat", () => {
    const { facts, ctx } = seedFacts(
      "/tmp/alias.ts",
      `
// alias kept for backward compat
function oldName(v: number) {
  return newName(v);
}
`,
    );

    const diagnostics = passThroughWrappersRule.evaluate(ctx, facts);
    expect(diagnostics).toHaveLength(0);
  });
});

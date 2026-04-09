import { describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { commentFactProvider } from "../../../../clients/dispatch/facts/comment-facts.js";
import { placeholderCommentsRule } from "../../../../clients/dispatch/rules/placeholder-comments.js";
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
    baselines: { get: () => undefined, set: () => {}, clear: () => {} },
    facts,
    hasTool: async () => false,
    log: () => {},
  };
}

describe("placeholderCommentsRule", () => {
  it("flags placeholder AI-style comments", () => {
    const filePath = "/tmp/comments.ts";
    const content = `
// add more validation here
const x = 1;
`;
    const facts = new FactStore();
    const ctx = makeCtx(filePath, facts);
    facts.setFileFact(filePath, "file.content", content);
    commentFactProvider.run(ctx, facts);

    const diagnostics = placeholderCommentsRule.evaluate(ctx, facts);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].rule).toBe("placeholder-comments");
  });

  it("does not flag ordinary TODO or descriptive comments", () => {
    const filePath = "/tmp/comments-ok.ts";
    const content = `
// TODO: fix later
// Processes payment batches.
const y = 2;
`;
    const facts = new FactStore();
    const ctx = makeCtx(filePath, facts);
    facts.setFileFact(filePath, "file.content", content);
    commentFactProvider.run(ctx, facts);

    const diagnostics = placeholderCommentsRule.evaluate(ctx, facts);
    expect(diagnostics).toHaveLength(0);
  });
});

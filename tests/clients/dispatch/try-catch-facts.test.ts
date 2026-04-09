import { describe, it, expect, afterEach } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
  registerProvider,
  runProviders,
  clearProviders,
} from "../../../clients/dispatch/fact-runner.js";
import {
  registerRule,
  evaluateRules,
  clearRules,
} from "../../../clients/dispatch/fact-rule-runner.js";
import { tryCatchFactProvider, type TryCatchSummary } from "../../../clients/dispatch/facts/try-catch-facts.js";
import { errorObscuringRule } from "../../../clients/dispatch/rules/error-obscuring.js";
import { errorSwallowingRule } from "../../../clients/dispatch/rules/error-swallowing.js";
import type { DispatchContext } from "../../../clients/dispatch/types.js";
import type { FileKind } from "../../../clients/file-kinds.js";

function makeCtx(filePath: string, facts: FactStore): DispatchContext {
  return {
    filePath,
    cwd: "/tmp",
    kind: "jsts" as FileKind,
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts,
    blockingOnly: false,
    modifiedRanges: undefined,
    hasTool: async () => false,
    log: () => {},
  };
}

async function runProviderWithContent(content: string, filePath = "/fake/test.ts") {
  const facts = new FactStore();
  facts.setFileFact(filePath, "file.content", content);
  const ctx = makeCtx(filePath, facts);
  registerProvider(tryCatchFactProvider);
  await runProviders(ctx);
  return { facts, ctx };
}

describe("tryCatchFactProvider", () => {
  afterEach(() => {
    clearProviders();
    clearRules();
  });

  it("extracts catch block with a named parameter", async () => {
    const code = `
try {
  doSomething();
} catch (err) {
  console.log(err);
}
`;
    const { facts } = await runProviderWithContent(code);
    const summaries = facts.getFileFact<TryCatchSummary[]>("/fake/test.ts", "file.tryCatchSummaries");
    expect(summaries).toBeDefined();
    expect(summaries!.length).toBe(1);
    expect(summaries![0].catchParam).toBe("err");
    expect(summaries![0].hasLogging).toBe(true);
  });

  it("marks isEmpty: true for empty catch body", async () => {
    const code = `
try {
  doSomething();
} catch (e) {}
`;
    const { facts } = await runProviderWithContent(code);
    const summaries = facts.getFileFact<TryCatchSummary[]>("/fake/test.ts", "file.tryCatchSummaries");
    expect(summaries![0].isEmpty).toBe(true);
  });

  it("marks isEmpty: true for catch body with only a comment", async () => {
    const code = `
try {
  doSomething();
} catch (e) {
  // intentionally empty
}
`;
    const { facts } = await runProviderWithContent(code);
    const summaries = facts.getFileFact<TryCatchSummary[]>("/fake/test.ts", "file.tryCatchSummaries");
    expect(summaries![0].isEmpty).toBe(true);
  });

  it("marks hasRethrow: true when body contains throw", async () => {
    const code = `
try {
  doSomething();
} catch (e) {
  throw e;
}
`;
    const { facts } = await runProviderWithContent(code);
    const summaries = facts.getFileFact<TryCatchSummary[]>("/fake/test.ts", "file.tryCatchSummaries");
    expect(summaries![0].hasRethrow).toBe(true);
  });

  it("marks hasLogging: true for console.log in body", async () => {
    const code = `
try {
  doSomething();
} catch (e) {
  console.log("oops", e);
}
`;
    const { facts } = await runProviderWithContent(code);
    const summaries = facts.getFileFact<TryCatchSummary[]>("/fake/test.ts", "file.tryCatchSummaries");
    expect(summaries![0].hasLogging).toBe(true);
  });

  it("marks hasLogging: true for console.error", async () => {
    const code = `
try {
  doSomething();
} catch (e) {
  console.error(e);
}
`;
    const { facts } = await runProviderWithContent(code);
    const summaries = facts.getFileFact<TryCatchSummary[]>("/fake/test.ts", "file.tryCatchSummaries");
    expect(summaries![0].hasLogging).toBe(true);
  });

  it("marks hasLogging: true for logger. usage", async () => {
    const code = `
try {
  doSomething();
} catch (e) {
  logger.warn(e);
}
`;
    const { facts } = await runProviderWithContent(code);
    const summaries = facts.getFileFact<TryCatchSummary[]>("/fake/test.ts", "file.tryCatchSummaries");
    expect(summaries![0].hasLogging).toBe(true);
  });

  it("handles catch without a parameter (catchParam is null)", async () => {
    const code = `
try {
  doSomething();
} catch {
  doFallback();
}
`;
    const { facts } = await runProviderWithContent(code);
    const summaries = facts.getFileFact<TryCatchSummary[]>("/fake/test.ts", "file.tryCatchSummaries");
    expect(summaries![0].catchParam).toBeNull();
  });

  it("extracts multiple catch blocks", async () => {
    const code = `
try { a(); } catch (e) { console.log(e); }
try { b(); } catch (err) {}
`;
    const { facts } = await runProviderWithContent(code);
    const summaries = facts.getFileFact<TryCatchSummary[]>("/fake/test.ts", "file.tryCatchSummaries");
    expect(summaries!.length).toBe(2);
  });

  it("returns empty array when content has no try-catch", async () => {
    const code = `const x = 1;\n`;
    const { facts } = await runProviderWithContent(code);
    const summaries = facts.getFileFact<TryCatchSummary[]>("/fake/test.ts", "file.tryCatchSummaries");
    expect(summaries).toEqual([]);
  });
});

describe("error-swallowing rule", () => {
  afterEach(() => {
    clearProviders();
    clearRules();
  });

  it("flags empty catch blocks", async () => {
    const code = `
try {
  doSomething();
} catch (e) {}
`;
    const { facts, ctx } = await runProviderWithContent(code);
    registerRule(errorSwallowingRule);
    const diagnostics = evaluateRules(ctx);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].message).toContain("Empty catch block");
    expect(diagnostics[0].severity).toBe("warning");
    expect(diagnostics[0].semantic).toBe("warning");
  });

  it("does not flag non-empty catch blocks", async () => {
    const code = `
try {
  doSomething();
} catch (e) {
  console.log(e);
}
`;
    const { ctx } = await runProviderWithContent(code);
    registerRule(errorSwallowingRule);
    const diagnostics = evaluateRules(ctx);
    expect(diagnostics.length).toBe(0);
  });
});

describe("error-obscuring rule", () => {
  afterEach(() => {
    clearProviders();
    clearRules();
  });

  it("flags catch blocks that ignore the caught error parameter", async () => {
    const code = `
try {
  doSomething();
} catch (err) {
  doFallback();
}
`;
    const { facts, ctx } = await runProviderWithContent(code);
    registerRule(errorObscuringRule);
    const diagnostics = evaluateRules(ctx);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].message).toContain("err");
    expect(diagnostics[0].message).toContain("obscured");
    expect(diagnostics[0].severity).toBe("warning");
  });

  it("does not flag catch blocks that reference the caught error", async () => {
    const code = `
try {
  doSomething();
} catch (err) {
  console.log(err);
}
`;
    const { ctx } = await runProviderWithContent(code);
    registerRule(errorObscuringRule);
    const diagnostics = evaluateRules(ctx);
    expect(diagnostics.length).toBe(0);
  });

  it("does not flag empty catch blocks (that is error-swallowing's job)", async () => {
    const code = `
try {
  doSomething();
} catch (e) {}
`;
    const { ctx } = await runProviderWithContent(code);
    registerRule(errorObscuringRule);
    const diagnostics = evaluateRules(ctx);
    expect(diagnostics.length).toBe(0);
  });

  it("does not flag catch blocks that rethrow", async () => {
    const code = `
try {
  doSomething();
} catch (e) {
  doCleanup();
  throw e;
}
`;
    const { ctx } = await runProviderWithContent(code);
    registerRule(errorObscuringRule);
    const diagnostics = evaluateRules(ctx);
    expect(diagnostics.length).toBe(0);
  });

  it("does not flag catch blocks with no param (catchParam is null)", async () => {
    const code = `
try {
  doSomething();
} catch {
  doFallback();
}
`;
    const { ctx } = await runProviderWithContent(code);
    registerRule(errorObscuringRule);
    const diagnostics = evaluateRules(ctx);
    expect(diagnostics.length).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
  functionFactProvider,
  type FunctionSummary,
} from "../../../clients/dispatch/facts/function-facts.js";

async function run(content: string): Promise<FunctionSummary[]> {
  const facts = new FactStore();
  const filePath = "/tmp/fn.ts";
  facts.setFileFact(filePath, "file.content", content);
  await functionFactProvider.run({ filePath } as never, facts);
  return facts.getFileFact<FunctionSummary[]>(filePath, "file.functionSummaries") ?? [];
}

const byName = (s: FunctionSummary[], name: string) =>
  s.find((f) => f.name === name);

describe("functionFactProvider — names & forms", () => {
  it("names function declarations, methods, and const-bound arrows/expressions", async () => {
    const s = await run(`
function decl(a: number) { return a; }
class K { method(x: number) { return x; } }
const arrow = (y: number) => { return y; };
const fnExpr = function (z: number) { return z; };
`);
    expect(byName(s, "decl")).toBeDefined();
    expect(byName(s, "method")).toBeDefined();
    expect(byName(s, "arrow")).toBeDefined();
    expect(byName(s, "fnExpr")).toBeDefined();
  });

  it("labels anonymous callbacks as <anonymous>", async () => {
    const s = await run(`const r = [1, 2].map((n) => { return n * 2; });`);
    expect(byName(s, "<anonymous>")).toBeDefined();
  });

  it("skips expression-bodied arrows (no statement block)", async () => {
    const s = await run(`const id = (x: number) => x;`);
    // No block body ⇒ no summary (matches the old !isBlock skip).
    expect(s).toHaveLength(0);
  });
});

describe("functionFactProvider — async / await", () => {
  it("detects async + await", async () => {
    const s = await run(`async function go(v: Promise<number>) { const x = await v; return x; }`);
    const go = byName(s, "go")!;
    expect(go.isAsync).toBe(true);
    expect(go.hasAwait).toBe(true);
  });

  it("flags async with no await (isAsync, !hasAwait)", async () => {
    const s = await run(`async function noisy(v: number) { return v + 1; }`);
    const f = byName(s, "noisy")!;
    expect(f.isAsync).toBe(true);
    expect(f.hasAwait).toBe(false);
  });

  it("detects return await call()", async () => {
    const s = await run(`async function w(v: Promise<number>) { return await fetchIt(v); }`);
    expect(byName(s, "w")!.hasReturnAwaitCall).toBe(true);
  });
});

describe("functionFactProvider — pass-through & boundary wrappers", () => {
  it("detects a pass-through wrapper + its target", async () => {
    const s = await run(`function wrap(a: number, b: number) { return inner(a, b); }`);
    const w = byName(s, "wrap")!;
    expect(w.isPassThroughWrapper).toBe(true);
    expect(w.passThroughTarget).toBe("inner");
    expect(w.isBoundaryWrapper).toBe(false);
  });

  it("marks boundary wrappers (return fetch(...))", async () => {
    const s = await run(`function load(id: string) { return fetch(id); }`);
    const l = byName(s, "load")!;
    expect(l.isPassThroughWrapper).toBe(true);
    expect(l.isBoundaryWrapper).toBe(true);
  });

  it("is not a pass-through when args differ from params", async () => {
    const s = await run(`function w(a: number) { return inner(a, 1); }`);
    expect(byName(s, "w")!.isPassThroughWrapper).toBe(false);
  });
});

describe("functionFactProvider — metrics", () => {
  it("counts cyclomatic complexity (branches + logical ops + 1)", async () => {
    const s = await run(`
function c(n: number) {
  if (n > 0 && n < 10) {}
  for (const i of xs) {}
  return n ? 1 : 2;
}
`);
    // base 1 + if + (&&) + for + ternary = 5
    expect(byName(s, "c")!.cyclomaticComplexity).toBe(5);
  });

  it("computes parameter and statement counts", async () => {
    const s = await run(`function p(a: number, b: number, c: number) { const x = 1; return x; }`);
    const p = byName(s, "p")!;
    expect(p.parameterCount).toBe(3);
    expect(p.statementCount).toBe(2);
  });

  it("collects distinct outgoing calls", async () => {
    const s = await run(`function f() { a(); b(); a(); }`);
    const calls = byName(s, "f")!.outgoingCalls;
    expect(calls).toContain("a");
    expect(calls).toContain("b");
    expect(calls.filter((c) => c === "a")).toHaveLength(1); // distinct
  });

  it("measures nesting depth", async () => {
    const flat = await run(`function a() { if (x) {} }`);
    const nested = await run(`function b() { if (x) { for (const i of y) { if (z) {} } } }`);
    expect(byName(nested, "b")!.maxNestingDepth).toBeGreaterThan(
      byName(flat, "a")!.maxNestingDepth,
    );
  });
});

describe("functionFactProvider — degradation", () => {
  it("returns empty on empty content", async () => {
    expect(await run("")).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { scheduleProviders } from "../../../clients/dispatch/fact-scheduler.js";
import type { FactProvider } from "../../../clients/dispatch/fact-provider-types.js";

function makeProvider(
  id: string,
  provides: string[],
  requires: string[],
): FactProvider {
  return {
    id,
    provides,
    requires,
    appliesTo: () => true,
    run: async () => {},
  };
}

describe("scheduleProviders", () => {
  it("single provider — returned as-is", () => {
    const p = makeProvider("a", ["a.fact"], []);
    const result = scheduleProviders([p]);
    expect(result).toEqual([p]);
  });

  it("two providers A→B (B requires A's output) — A comes first", () => {
    const a = makeProvider("provider.a", ["fact.a"], []);
    const b = makeProvider("provider.b", ["fact.b"], ["fact.a"]);
    const result = scheduleProviders([b, a]);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(b);
  });

  it("tie-break: two independent providers sorted by id ascending", () => {
    const x = makeProvider("provider.x", ["fact.x"], []);
    const m = makeProvider("provider.m", ["fact.m"], []);
    const result = scheduleProviders([x, m]);
    expect(result[0]).toBe(m);
    expect(result[1]).toBe(x);
  });

  it("three providers with 2-wave dependency chain — correct order", () => {
    const a = makeProvider("provider.a", ["fact.a"], []);
    const b = makeProvider("provider.b", ["fact.b"], ["fact.a"]);
    const c = makeProvider("provider.c", ["fact.c"], ["fact.b"]);
    const result = scheduleProviders([c, b, a]);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(b);
    expect(result[2]).toBe(c);
  });

  it("cycle detection — throws an error mentioning the cycle", () => {
    const a = makeProvider("provider.a", ["fact.a"], ["fact.b"]);
    const b = makeProvider("provider.b", ["fact.b"], ["fact.a"]);
    expect(() => scheduleProviders([a, b])).toThrowError(/cycle/i);
    expect(() => scheduleProviders([a, b])).toThrowError("provider.a");
    expect(() => scheduleProviders([a, b])).toThrowError("provider.b");
  });

  it("provider requiring a fact with no provider (external dep) — treated as in-degree 0, works fine", () => {
    const p = makeProvider("provider.x", ["fact.x"], ["external.fact"]);
    const result = scheduleProviders([p]);
    expect(result).toEqual([p]);
  });

  it("empty array — returns empty array", () => {
    expect(scheduleProviders([])).toEqual([]);
  });
});

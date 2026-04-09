import { describe, it, expect } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";

describe("FactStore lifecycle contract", () => {
  it("clearFileFactsFor on a non-existent path is a no-op", () => {
    const store = new FactStore();
    store.setFileFact("src/b.ts", "file.content", "bbb");
    expect(() => store.clearFileFactsFor("src/nonexistent.ts")).not.toThrow();
    expect(store.getFileFact("src/b.ts", "file.content")).toBe("bbb");
  });

  it("session facts survive clearFileFactsFor", () => {
    const store = new FactStore();
    store.setSessionFact("session.toolCache.biome", true);
    store.setFileFact("src/a.ts", "file.content", "aaa");
    store.clearFileFactsFor("src/a.ts");
    expect(store.getSessionFact("session.toolCache.biome")).toBe(true);
  });

  it("store is fully usable after clearAll — re-population works", () => {
    const store = new FactStore();
    store.setFileFact("/src/a.ts", "content", "original");
    store.setSessionFact("tool.ruff", true);
    store.clearAll();
    // Re-populate after clearAll
    store.setFileFact("/src/a.ts", "content", "repopulated");
    store.setSessionFact("tool.ruff", false);
    expect(store.getFileFact("/src/a.ts", "content")).toBe("repopulated");
    expect(store.getSessionFact("tool.ruff")).toBe(false);
  });

  it("two files do not share file facts — setting on fileA does not appear on fileB", () => {
    const store = new FactStore();
    store.setFileFact("src/a.ts", "file.content", "aaa");
    expect(store.getFileFact("src/b.ts", "file.content")).toBeUndefined();
  });
});

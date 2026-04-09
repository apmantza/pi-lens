import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeCacheKey } from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";

// ---------------------------------------------------------------------------
// normalizeCacheKey unit tests
// ---------------------------------------------------------------------------

describe("normalizeCacheKey", () => {
  it("lowercases the command", () => {
    expect(normalizeCacheKey("Ruff")).toBe("session.toolCache.ruff");
  });

  it("strips .exe suffix (case-insensitive)", () => {
    expect(normalizeCacheKey("ruff.exe")).toBe("session.toolCache.ruff");
    expect(normalizeCacheKey("RUFF.EXE")).toBe("session.toolCache.ruff");
  });

  it("strips .cmd suffix (case-insensitive)", () => {
    expect(normalizeCacheKey("sg.cmd")).toBe("session.toolCache.sg");
    expect(normalizeCacheKey("SG.CMD")).toBe("session.toolCache.sg");
  });

  it("does not strip other extensions", () => {
    expect(normalizeCacheKey("tool.sh")).toBe("session.toolCache.tool.sh");
  });

  it("prefixes with session.toolCache.", () => {
    expect(normalizeCacheKey("biome")).toBe("session.toolCache.biome");
  });
});

// ---------------------------------------------------------------------------
// FactStore session caching integration tests
// ---------------------------------------------------------------------------

describe("tool availability caching via FactStore session facts", () => {
  let facts: FactStore;

  beforeEach(() => {
    facts = new FactStore();
  });

  it("stores tool availability as a session fact after a check", () => {
    // Simulate what checkToolAvailability does: set fact after probe
    const key = normalizeCacheKey("ruff");
    facts.setSessionFact(key, true);
    expect(facts.hasSessionFact(key)).toBe(true);
    expect(facts.getSessionFact<boolean>(key)).toBe(true);
  });

  it("stores false for unavailable tools", () => {
    const key = normalizeCacheKey("nonexistent-tool");
    facts.setSessionFact(key, false);
    expect(facts.hasSessionFact(key)).toBe(true);
    expect(facts.getSessionFact<boolean>(key)).toBe(false);
  });

  it("second call uses cached value (hasSessionFact is true, no re-probe needed)", () => {
    const key = normalizeCacheKey("biome");
    // First probe result stored
    facts.setSessionFact(key, true);
    // Subsequent reads see the cached value without touching the filesystem
    expect(facts.getSessionFact<boolean>(key)).toBe(true);
    expect(facts.hasSessionFact(key)).toBe(true);
  });

  it("keys for .exe-suffixed and plain command are the same", () => {
    const keyPlain = normalizeCacheKey("ruff");
    const keyExe = normalizeCacheKey("ruff.exe");
    expect(keyPlain).toBe(keyExe);

    // Writing under one alias is visible under the other
    facts.setSessionFact(keyExe, true);
    expect(facts.getSessionFact<boolean>(keyPlain)).toBe(true);
  });

  it("keys for .cmd-suffixed and plain command are the same", () => {
    const keyPlain = normalizeCacheKey("sg");
    const keyCmd = normalizeCacheKey("sg.cmd");
    expect(keyPlain).toBe(keyCmd);
  });

  it("different commands produce distinct keys", () => {
    const keyA = normalizeCacheKey("ruff");
    const keyB = normalizeCacheKey("biome");
    expect(keyA).not.toBe(keyB);

    facts.setSessionFact(keyA, true);
    facts.setSessionFact(keyB, false);
    expect(facts.getSessionFact<boolean>(keyA)).toBe(true);
    expect(facts.getSessionFact<boolean>(keyB)).toBe(false);
  });
});

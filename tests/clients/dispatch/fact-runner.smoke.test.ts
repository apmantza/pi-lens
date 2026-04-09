import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { registerProvider, runProviders, clearProviders } from "../../../clients/dispatch/fact-runner.js";
import { fileContentProvider } from "../../../clients/dispatch/facts/file-content.js";
import type { DispatchContext } from "../../../clients/dispatch/types.js";

function makeCtx(filePath: string, facts: FactStore): DispatchContext {
  return {
    filePath,
    cwd: path.dirname(filePath),
    kind: undefined,
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

describe("runProviders smoke test", () => {
  afterEach(() => clearProviders());

  it("runProviders with no providers registered is a no-op", async () => {
    const filePath = "/nonexistent/path/empty.ts";
    const facts = new FactStore();
    const ctx = makeCtx(filePath, facts);

    // No providers registered — runProviders should complete without error
    await runProviders(ctx);

    // Facts store should remain empty
    const content = facts.getFileFact(filePath, "file.content");
    expect(content).toBeUndefined();
  });

  it("runProviders populates file.content via registered provider", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-test-"));
    const filePath = path.join(dir, "sample.ts");
    await fs.writeFile(filePath, "export const y = 2;\n", "utf-8");

    const facts = new FactStore();
    const ctx = makeCtx(filePath, facts);

    registerProvider(fileContentProvider);
    await runProviders(ctx);

    const content = facts.getFileFact<string>(filePath, "file.content");
    expect(typeof content).toBe("string");
    expect(content).toContain("export const y = 2;");

    await fs.rm(dir, { recursive: true });
  });

  it("second call to runProviders is a no-op (fact already present)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-test-"));
    const filePath = path.join(dir, "noop.ts");
    await fs.writeFile(filePath, "const z = 3;\n", "utf-8");

    const facts = new FactStore();
    const ctx = makeCtx(filePath, facts);

    // Track call count with a custom provider using a unique fact key
    let callCount = 0;
    const trackingProvider = {
      id: "fact.test.tracking.noop",
      provides: ["test.tracking.noop"],
      requires: [],
      appliesTo: () => true,
      run: async () => {
        callCount++;
        facts.setFileFact(filePath, "test.tracking.noop", "tracked");
      },
    };

    registerProvider(trackingProvider);
    await runProviders(ctx);
    expect(callCount).toBe(1);

    // Second call — fact is already present, provider should be skipped
    await runProviders(ctx);
    expect(callCount).toBe(1);

    await fs.rm(dir, { recursive: true });
  });

  it("returns null for file.content when file does not exist", async () => {
    const filePath = "/nonexistent/path/missing.ts";
    const facts = new FactStore();
    const ctx = makeCtx(filePath, facts);

    await fileContentProvider.run(ctx, facts);

    const content = facts.getFileFact(filePath, "file.content");
    expect(content).toBeNull();
  });
});

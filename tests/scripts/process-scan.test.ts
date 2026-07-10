/**
 * Tests for scripts/lib/process-scan.mjs — the pure process-table matching
 * used by scripts/compat-smoke-behavioral.mjs (#476, Layer B assertion 3:
 * zero surviving LSP-server processes after pi exits, the #472 orphan class).
 */

import { describe, expect, it } from "vitest";
import {
  diffSurvivingLspProcesses,
  isLspServerCommand,
  LSP_PROCESS_MARKERS,
} from "../../scripts/lib/process-scan.mjs";

describe("LSP_PROCESS_MARKERS", () => {
  it("is a non-empty array of distinctive command fragments", () => {
    expect(Array.isArray(LSP_PROCESS_MARKERS)).toBe(true);
    expect(LSP_PROCESS_MARKERS.length).toBeGreaterThan(0);
  });
});

describe("isLspServerCommand", () => {
  it("matches typescript-language-server command lines", () => {
    expect(
      isLspServerCommand(
        "/usr/local/bin/node /usr/local/lib/node_modules/typescript-language-server/lib/cli.mjs --stdio",
      ),
    ).toBe(true);
  });

  it("matches ast-grep lsp invocations", () => {
    expect(isLspServerCommand("ast-grep lsp --sgconfig /tmp/sgconfig-1234.yml")).toBe(true);
  });

  it("is case-insensitive (Windows command lines often differ in case)", () => {
    expect(
      isLspServerCommand("C:\\Windows\\node.exe TYPESCRIPT-LANGUAGE-SERVER\\lib\\cli.mjs"),
    ).toBe(true);
  });

  it("does not match an unrelated node process", () => {
    expect(isLspServerCommand("/usr/local/bin/node /home/user/app/server.js")).toBe(false);
  });

  it("does not match a bare 'node' or 'language-server' fragment alone", () => {
    expect(isLspServerCommand("node --version")).toBe(false);
    expect(isLspServerCommand("some-other-language-server --stdio")).toBe(false);
  });
});

describe("diffSurvivingLspProcesses", () => {
  it("returns LSP rows present in after but not before (new + still alive)", () => {
    const before = [{ pid: 100, command: "bash" }];
    const after = [
      { pid: 100, command: "bash" },
      { pid: 200, command: "node .../typescript-language-server/cli.mjs --stdio" },
    ];
    const surviving = diffSurvivingLspProcesses(before, after);
    expect(surviving).toEqual([
      { pid: 200, command: "node .../typescript-language-server/cli.mjs --stdio" },
    ]);
  });

  it("excludes a pid present in both snapshots even if it looks like an LSP server", () => {
    // A pre-existing LSP server on the runner (unrelated to this run) must not
    // be misattributed as something this run leaked.
    const before = [{ pid: 200, command: "node .../typescript-language-server/cli.mjs" }];
    const after = [{ pid: 200, command: "node .../typescript-language-server/cli.mjs" }];
    expect(diffSurvivingLspProcesses(before, after)).toEqual([]);
  });

  it("excludes new non-LSP processes", () => {
    const before: Array<{ pid: number; command: string }> = [];
    const after = [{ pid: 300, command: "npm install" }];
    expect(diffSurvivingLspProcesses(before, after)).toEqual([]);
  });

  it("returns [] when nothing survived", () => {
    expect(diffSurvivingLspProcesses([], [])).toEqual([]);
  });
});

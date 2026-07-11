/**
 * Tests for the pure helpers behind scripts/probe-clean-signal.mjs (#460):
 *   - scripts/lib/clean-signal.mjs  — classifyCleanBehavior, the PHASE-AWARE
 *     4-way classifier (2 publishes-versioned / 2* publishes-unversioned /
 *     3 silent / unknown). The phase dimension matters: a server that published
 *     only on the dirty touch and went silent on clean transitions (typescript —
 *     the true budget-wait case) must NOT be conflated with one that actively
 *     re-publishes version-lessly on clean transitions (opengrep — early-returns
 *     the wait at runtime).
 *   - scripts/lib/md-matrix.mjs     — the partial-doc MERGE guard (#390): a run
 *     that couldn't measure a server must NOT drop or blank its row.
 *
 * These are the classifier + merge logic the nightly relies on; spawning a server
 * is out of scope for a unit test (mirrors the repo pattern of testing script
 * helpers, not the scripts, per tests/scripts/changelog.test.ts).
 */

import { describe, expect, it } from "vitest";
import {
  checkCleanSignalDrift,
  classifyCleanBehavior,
  findCleanSignalDrift,
} from "../../scripts/lib/clean-signal.mjs";
import {
  mergeRows,
  mergeSrc,
  parseTable,
  replaceTable,
} from "../../scripts/lib/md-matrix.mjs";

describe("classifyCleanBehavior (phase-aware 4-way)", () => {
  it("classifies a versioned clean-transition publisher as publishes-versioned (tier 2)", () => {
    // ast-grep-shaped: re-publishes WITH a version on a clean transition.
    const v = classifyCleanBehavior({
      dirtyPublishes: 2,
      dirtyVersioned: 2,
      cleanTransitionPublishes: 1,
      cleanTransitionVersioned: 1,
    });
    expect(v.behavior).toBe("publishes-versioned");
    expect(v.tier).toBe(2);
    expect(v.tierLabel).toBe("2");
  });

  it("classifies a version-less clean-transition publisher as publishes-unversioned (tier 2*)", () => {
    // opengrep-shaped: re-publishes on the clean transition but every push is
    // version-less — the wait still early-returns at runtime (the client accepts
    // a version-less publish as fresh), so this is NOT the budget-wait case.
    const v = classifyCleanBehavior({
      dirtyPublishes: 2,
      dirtyVersioned: 0,
      cleanTransitionPublishes: 1,
      cleanTransitionVersioned: 0,
    });
    expect(v.behavior).toBe("publishes-unversioned");
    expect(v.tier).toBe(2);
    expect(v.tierLabel).toBe("2*");
  });

  it("classifies dirty-publish + clean-silence as silent (tier 3 — the #458 target)", () => {
    // typescript-shaped: demonstrably alive (published on the dirty touch) but
    // demonstrably silent on clean transitions — the budget-wait case.
    const v = classifyCleanBehavior({
      dirtyPublishes: 2,
      dirtyVersioned: 0,
      cleanTransitionPublishes: 0,
      cleanTransitionVersioned: 0,
    });
    expect(v.behavior).toBe("silent");
    expect(v.tier).toBe(3);
    expect(v.tierLabel).toBe("3");
  });

  it("a versioned clean publish wins even when the dirty phase was version-less", () => {
    // The clean-transition phase is the discriminator, not the dirty phase.
    const v = classifyCleanBehavior({
      dirtyPublishes: 1,
      dirtyVersioned: 0,
      cleanTransitionPublishes: 2,
      cleanTransitionVersioned: 1,
    });
    expect(v.behavior).toBe("publishes-versioned");
    expect(v.tierLabel).toBe("2");
  });

  it("reports unknown (not tier 3) when the server never published at all", () => {
    // Conservative: a slow/absent server must not be mislabeled as measured-silent.
    const v = classifyCleanBehavior({
      dirtyPublishes: 0,
      dirtyVersioned: 0,
      cleanTransitionPublishes: 0,
      cleanTransitionVersioned: 0,
    });
    expect(v.behavior).toBe("unknown");
    expect(v.tier).toBe(0);
    expect(v.tierLabel).toBe("");
  });

  it("tolerates missing/garbage observation fields", () => {
    expect(classifyCleanBehavior({}).behavior).toBe("unknown");
    expect(
      classifyCleanBehavior(undefined as unknown as Record<string, never>)
        .behavior,
    ).toBe("unknown");
  });
});

describe("checkCleanSignalDrift (#529)", () => {
  it("flags marked-not-silent when the marker says silent but the probe observed a publish", () => {
    // The stale-marker direction: server-strategies.ts is too pessimistic.
    const d = checkCleanSignalDrift(
      { lang: "typescript", behavior: "publishes-unversioned" },
      true,
    );
    expect(d.kind).toBe("marked-not-silent");
    expect(d.detail).toContain("typescript");
    expect(d.detail).toContain("publishes-unversioned");
  });

  it("flags silent-not-marked when the probe observed silence but no marker is set", () => {
    // The pre-#458 tsserver situation: cascade burns a full wait it could skip.
    const d = checkCleanSignalDrift({ lang: "python", behavior: "silent" }, undefined);
    expect(d.kind).toBe("silent-not-marked");
    expect(d.detail).toContain("python");
  });

  it("is consistent when a silent observation matches a true marker", () => {
    const d = checkCleanSignalDrift({ lang: "typescript", behavior: "silent" }, true);
    expect(d.kind).toBe("consistent");
  });

  it("is consistent when a non-silent observation matches an absent/false marker", () => {
    const d = checkCleanSignalDrift(
      { lang: "yaml", behavior: "publishes-unversioned" },
      undefined,
    );
    expect(d.kind).toBe("consistent");
  });

  it("never treats 'unknown' as drift evidence in either direction (#240 doctrine)", () => {
    // A server marked silentOnClean:true whose probe came back unknown (slow/absent
    // this run) must NOT be reported as "marker says silent, observed not-silent" —
    // unknown means we didn't see it publish at all, not that it's not silent.
    const markedButUnknown = checkCleanSignalDrift(
      { lang: "typescript", behavior: "unknown" },
      true,
    );
    expect(markedButUnknown.kind).toBe("not-comparable");

    const unmarkedAndUnknown = checkCleanSignalDrift(
      { lang: "some-new-server", behavior: "unknown" },
      undefined,
    );
    expect(unmarkedAndUnknown.kind).toBe("not-comparable");
  });

  it("tolerates a falsy marker value explicitly set to false (same as undefined)", () => {
    const d = checkCleanSignalDrift({ lang: "rust-analyzer", behavior: "silent" }, false);
    expect(d.kind).toBe("silent-not-marked");
  });

  // #541: probe-clean-signal.mjs used to exclude typescript7/typescript7-clean
  // from this comparison entirely (PR #526's fail-safe — silentOnClean was
  // documented CLASSIC-only). The #529/#540 probe has since measured native-ts7
  // silent too, so the marker now covers both variants and the script routes
  // typescript7[-clean] to the shared "typescript" strategy key instead of
  // skipping the row. These cases exercise that lifted comparison directly
  // against the pure checker (the routing itself lives in the script's
  // lookupSilentOnClean, out of unit-test scope — see the file header).
  it("is consistent when native-ts7 is observed silent and routed to the shared typescript marker (#541, the expected steady state)", () => {
    const d = checkCleanSignalDrift({ lang: "typescript7", behavior: "silent" }, true);
    expect(d.kind).toBe("consistent");
  });

  it("flags marked-not-silent when a FUTURE native-ts7 build starts publishing on clean (#541 regression watch)", () => {
    // The safety net this change exists for: if a future TS7 build diverges
    // from classic's silent behavior, the shared marker now catches it instead
    // of the row being silently skipped.
    const d = checkCleanSignalDrift(
      { lang: "typescript7-clean", behavior: "publishes-unversioned" },
      true,
    );
    expect(d.kind).toBe("marked-not-silent");
    expect(d.detail).toContain("typescript7-clean");
  });
});

describe("findCleanSignalDrift (#529)", () => {
  it("returns only the drifting rows, dropping consistent and not-comparable ones", () => {
    const rows = [
      { lang: "typescript", behavior: "publishes-unversioned" }, // marked-not-silent
      { lang: "python", behavior: "silent" }, // silent-not-marked
      { lang: "yaml", behavior: "publishes-unversioned" }, // consistent
      { lang: "rust-analyzer", behavior: "unknown" }, // not-comparable
    ];
    const markers: Record<string, boolean | undefined> = {
      typescript: true,
      python: undefined,
      yaml: undefined,
      "rust-analyzer": undefined,
    };
    const warnings = findCleanSignalDrift(rows, (lang) => markers[lang]);
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.lang).sort()).toEqual(["python", "typescript"]);
    expect(warnings.every((w) => w.kind !== "consistent" && w.kind !== "not-comparable")).toBe(
      true,
    );
  });

  it("returns an empty array when everything is consistent", () => {
    const rows = [{ lang: "yaml", behavior: "publishes-unversioned" }];
    const warnings = findCleanSignalDrift(rows, () => undefined);
    expect(warnings).toHaveLength(0);
  });

  // #541: with the typescript7 exclusion lifted, a native-ts7 row now
  // participates in the drift scan like any other row — routed (by the
  // caller's lookup, mirroring probe-clean-signal.mjs's LANG_TO_STRATEGY_KEY)
  // to the shared "typescript" marker.
  it("includes a native-ts7 row routed to the shared typescript marker, flagging drift if it diverges (#541)", () => {
    const rows = [
      { lang: "typescript", behavior: "silent" }, // consistent
      { lang: "typescript7-clean", behavior: "publishes-versioned" }, // marked-not-silent
    ];
    const strategyKeyFor = (lang: string) =>
      lang === "typescript7-clean" || lang === "typescript7"
        ? "typescript"
        : lang;
    const markers: Record<string, boolean | undefined> = { typescript: true };
    const warnings = findCleanSignalDrift(rows, (lang) => markers[strategyKeyFor(lang)]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].lang).toBe("typescript7-clean");
    expect(warnings[0].kind).toBe("marked-not-silent");
  });
});

describe("mergeSrc", () => {
  it("combines dev + ci deterministically (dev before ci)", () => {
    expect(mergeSrc("dev", "ci")).toBe("dev+ci");
    expect(mergeSrc("ci", "dev")).toBe("dev+ci");
  });
  it("is idempotent and ignores placeholder dashes", () => {
    expect(mergeSrc("dev+ci", "ci")).toBe("dev+ci");
    expect(mergeSrc("—", "dev")).toBe("dev");
    expect(mergeSrc("", "ci")).toBe("ci");
  });
});

const DOC = `# matrix

| lang | server | mode | clean-behavior | tier | src |
|---|---|---|---|---|---|
| json | vscode-json-language-server | pull | — | 1 | dev |
| typescript | typescript-language-server | push-only | TBD | 2/3? | dev |
| ast-grep | ast-grep (aux) | push-only | TBD | 2/3? | dev+ci |

tail text preserved
`;

describe("md-matrix merge guard (#390)", () => {
  it("parses the table and locates its bounds", () => {
    const tbl = parseTable(DOC, "| lang | server |");
    expect(tbl).not.toBeNull();
    expect(tbl!.header).toEqual([
      "lang",
      "server",
      "mode",
      "clean-behavior",
      "tier",
      "src",
    ]);
    expect(tbl!.rows).toHaveLength(3);
  });

  it("updates only owned columns of measured rows, preserving the rest", () => {
    const tbl = parseTable(DOC, "| lang | server |")!;
    const merged = mergeRows(
      tbl.rows,
      tbl.header,
      [
        {
          lang: "typescript",
          "clean-behavior": "silent",
          tier: "3",
          src: "dev+ci",
        },
      ],
      "lang",
      ["clean-behavior", "tier", "src"],
      { updateOnly: true },
    );
    const ts = merged.find((r) => r[0] === "typescript")!;
    expect(ts[3]).toBe("silent"); // clean-behavior updated
    expect(ts[4]).toBe("3"); // tier updated
    // `mode` (not owned) is untouched:
    expect(ts[2]).toBe("push-only");
  });

  it("preserves rows a run did NOT measure (no regression on ubuntu-poor host)", () => {
    const tbl = parseTable(DOC, "| lang | server |")!;
    // Only typescript measured this run; json + ast-grep must survive verbatim.
    const merged = mergeRows(
      tbl.rows,
      tbl.header,
      [{ lang: "typescript", "clean-behavior": "silent", tier: "3" }],
      "lang",
      ["clean-behavior", "tier"],
      { updateOnly: true },
    );
    expect(merged).toHaveLength(3); // never shrinks
    expect(merged.find((r) => r[0] === "json")).toEqual(tbl.rows[0]);
    expect(merged.find((r) => r[0] === "ast-grep")![3]).toBe("TBD"); // untouched
  });

  it("updateOnly drops a measured key with no existing row (curated table)", () => {
    const tbl = parseTable(DOC, "| lang | server |")!;
    const merged = mergeRows(
      tbl.rows,
      tbl.header,
      [{ lang: "typescript-clean", "clean-behavior": "silent", tier: "3" }],
      "lang",
      ["clean-behavior", "tier"],
      { updateOnly: true },
    );
    expect(merged).toHaveLength(3); // the unknown lang is NOT appended
    expect(merged.some((r) => r[0] === "typescript-clean")).toBe(false);
  });

  it("round-trips through replaceTable, preserving surrounding text", () => {
    const tbl = parseTable(DOC, "| lang | server |")!;
    const merged = mergeRows(
      tbl.rows,
      tbl.header,
      [{ lang: "json", mode: "pull", src: "dev+ci" }],
      "lang",
      ["src"],
      { updateOnly: true },
    );
    const out = replaceTable(DOC, "| lang | server |", tbl.header, tbl.sep, merged)!;
    expect(out).toContain("tail text preserved");
    expect(out).toContain("| json | vscode-json-language-server | pull | — | 1 | dev+ci |");
  });
});

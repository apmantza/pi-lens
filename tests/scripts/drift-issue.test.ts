/**
 * Tests for the pure helpers behind scripts/notify-clean-signal-drift.mjs
 * (#594) — scripts/lib/drift-issue.mjs's `buildDriftIssueBody` and
 * `findDriftTrackingIssue`. Mirrors the repo pattern of testing script
 * helpers, not the scripts themselves (tests/scripts/clean-signal.test.ts):
 * shelling out to a live `gh` CLI is out of scope for a unit test, so
 * notify-clean-signal-drift.mjs's `gh` invocations are untested here (same
 * as scripts/backfill-github-releases.mjs's own `gh` calls elsewhere in this
 * repo).
 */

import { describe, expect, it } from "vitest";
import {
  buildDriftIssueBody,
  DRIFT_ISSUE_LABEL,
  DRIFT_ISSUE_TITLE,
  findDriftTrackingIssue,
} from "../../scripts/lib/drift-issue.mjs";

describe("buildDriftIssueBody (#594)", () => {
  it("includes every warning, telemetry-only framing, and the finding count", () => {
    const body = buildDriftIssueBody({
      generatedAt: "2026-07-13T06:00:00.000Z",
      count: 2,
      warnings: [
        { lang: "typescript7", kind: "silent-not-marked", detail: "alive but silent on clean" },
        { lang: "python", kind: "marked-not-silent", detail: "marker too pessimistic" },
      ],
    });
    expect(body).toContain("telemetry only");
    expect(body).toContain("never gates CI");
    expect(body).toContain("2 findings");
    expect(body).toContain("2026-07-13T06:00:00.000Z");
    expect(body).toContain("[silent-not-marked]");
    expect(body).toContain("`typescript7`");
    expect(body).toContain("alive but silent on clean");
    expect(body).toContain("[marked-not-silent]");
    expect(body).toContain("`python`");
    expect(body).toContain("closed automatically once a nightly run finds no drift");
  });

  it("uses singular 'finding' for a count of exactly one", () => {
    const body = buildDriftIssueBody({
      generatedAt: "2026-07-13T06:00:00.000Z",
      warnings: [{ lang: "yaml", kind: "silent-not-marked", detail: "detail" }],
    });
    expect(body).toContain("1 finding)");
    expect(body).not.toContain("1 findings");
  });

  it("tolerates a missing/malformed warnings array", () => {
    const body = buildDriftIssueBody({ generatedAt: "unknown-run" });
    expect(body).toContain("0 findings");
    expect(() => buildDriftIssueBody(undefined as unknown as { warnings: never[] })).not.toThrow();
  });

  it("appends the workflow run URL only when provided", () => {
    const withUrl = buildDriftIssueBody(
      { generatedAt: "t", warnings: [] },
      { runUrl: "https://github.com/apmantza/pi-lens/actions/runs/123" },
    );
    expect(withUrl).toContain("Workflow run: https://github.com/apmantza/pi-lens/actions/runs/123");

    const withoutUrl = buildDriftIssueBody({ generatedAt: "t", warnings: [] });
    expect(withoutUrl).not.toContain("Workflow run:");
  });
});

describe("findDriftTrackingIssue (#594)", () => {
  it("finds the tracking issue by exact title match among label-filtered issues", () => {
    const issues = [
      { number: 10, title: "some unrelated open issue" },
      { number: 42, title: DRIFT_ISSUE_TITLE },
    ];
    const found = findDriftTrackingIssue(issues);
    expect(found).toEqual({ number: 42, title: DRIFT_ISSUE_TITLE });
  });

  it("returns null when no issue matches the fixed title", () => {
    expect(findDriftTrackingIssue([{ number: 1, title: "unrelated" }])).toBeNull();
  });

  it("tolerates null/undefined/empty issue lists", () => {
    expect(findDriftTrackingIssue(null)).toBeNull();
    expect(findDriftTrackingIssue(undefined)).toBeNull();
    expect(findDriftTrackingIssue([])).toBeNull();
  });

  it("exposes stable, fixed identifiers so the tracker is always found the same way", () => {
    expect(DRIFT_ISSUE_LABEL).toBe("nightly-drift");
    expect(DRIFT_ISSUE_TITLE).toBe("nightly: silentOnClean drift detected");
  });
});

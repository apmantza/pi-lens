/**
 * Finding-cited path FRESHNESS — #1622.
 *
 * #1460's gate asks "does the cited file still exist?". #1622's live case is
 * the next question: "does the cited file still look the way the scan saw it?".
 * A gitleaks blocker replayed src:397 for ~13 minutes after that file was
 * edited, because the 30-minute TTL says the cache is young and the existence
 * gate says the file is there. Neither says the LINE is still true.
 *
 * The asymmetry these tests pin is the security contract: a deleted path DROPS,
 * an edited path DEMOTES. If an edit could drop a finding, touching a file would
 * be a one-step mute button for a real credential.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency,
}));

import {
	findingPathFreshness,
	gateFindingsByPathFreshness,
	parseScannedAtMs,
	partitionFindingsByCitedPath,
	type FindingPathFreshness,
} from "../../clients/advisory-provenance.js";
import { MTIME_DRIFT_TOLERANCE_MS } from "../../clients/blocker-freshness.js";
import { setupTestEnvironment } from "./test-utils.js";

interface Finding {
	file?: string;
	rule: string;
	line?: number;
}

const citedPath = (finding: Finding): string | undefined => finding.file;

/** Set a file's mtime `deltaMs` after `scannedAt`. */
function setMtime(file: string, ms: number): void {
	const when = new Date(ms);
	fs.utimesSync(file, when, when);
}

describe("partitionFindingsByCitedPath freshness verdict (#1622)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		cleanups.splice(0).forEach((cleanup) => cleanup());
		logLatency.mockReset();
	});

	function setup(prefix = "pi-lens-finding-freshness-") {
		const env = setupTestEnvironment(prefix);
		cleanups.push(env.cleanup);
		const scannedAtMs = Date.now() - 60_000;
		const scannedAt = new Date(scannedAtMs).toISOString();
		const make = (relative: string, mtimeMs: number): string => {
			const file = path.join(env.tmpDir, relative);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "const k = 'AKIA...';\n");
			setMtime(file, mtimeMs);
			return file;
		};
		return { env, scannedAt, scannedAtMs, make };
	}

	// THE test of this change. A file edited after the scan must keep its
	// finding, at a demoted tier, and must NOT carry the cached line forward.
	it("DEMOTES a finding whose cited file was edited after the scan — never drops it", () => {
		const { env, scannedAt, scannedAtMs, make } = setup();
		const edited = make("src/config.ts", scannedAtMs + 5_000);

		const result = partitionFindingsByCitedPath<Finding>({
			findings: [{ file: edited, rule: "aws-access-token", line: 397 }],
			cwd: env.tmpDir,
			scannedAt,
			citedPath,
		});

		expect(result.stale.map((f) => f.rule)).toEqual(["aws-access-token"]);
		// The security invariant: an edit must never silence a real secret.
		expect(result.dropped).toEqual([]);
		expect(result.live).toEqual([]);
		expect(result.stalePaths).toHaveLength(1);
		expect(result.deadPaths).toEqual([]);
	});

	it("keeps an unmodified file's finding at full severity", () => {
		const { env, scannedAt, scannedAtMs, make } = setup();
		const untouched = make("src/untouched.ts", scannedAtMs - 5_000);

		const result = partitionFindingsByCitedPath<Finding>({
			findings: [{ file: untouched, rule: "aws-access-token", line: 397 }],
			cwd: env.tmpDir,
			scannedAt,
			citedPath,
		});

		expect(result.live.map((f) => f.rule)).toEqual(["aws-access-token"]);
		expect(result.stale).toEqual([]);
		expect(result.dropped).toEqual([]);
	});

	it("still DROPS a deleted path when a scan timestamp is present (#1460 holds)", () => {
		const { env, scannedAt, scannedAtMs, make } = setup();
		const dead = make("gone/secrets.json", scannedAtMs - 5_000);
		fs.rmSync(path.dirname(dead), { recursive: true, force: true });

		const result = partitionFindingsByCitedPath<Finding>({
			findings: [{ file: dead, rule: "generic-api-key", line: 1341 }],
			cwd: env.tmpDir,
			scannedAt,
			citedPath,
		});

		expect(result.dropped.map((f) => f.rule)).toEqual(["generic-api-key"]);
		expect(result.stale).toEqual([]);
		expect(result.live).toEqual([]);
	});

	it("partitions all three arms in one pass", () => {
		const { env, scannedAt, scannedAtMs, make } = setup();
		const edited = make("src/edited.ts", scannedAtMs + 5_000);
		const untouched = make("src/untouched.ts", scannedAtMs - 5_000);
		const dead = make("gone/dead.json", scannedAtMs - 5_000);
		fs.rmSync(path.dirname(dead), { recursive: true, force: true });

		const result = partitionFindingsByCitedPath<Finding>({
			findings: [
				{ file: edited, rule: "edited" },
				{ file: untouched, rule: "untouched" },
				{ file: dead, rule: "dead" },
			],
			cwd: env.tmpDir,
			scannedAt,
			citedPath,
		});

		expect(result.stale.map((f) => f.rule)).toEqual(["edited"]);
		expect(result.live.map((f) => f.rule)).toEqual(["untouched"]);
		expect(result.dropped.map((f) => f.rule)).toEqual(["dead"]);
		expect(result.statCount).toBe(3);
	});

	// Fail-safe: a bad clock or an empty envelope field must not demote a whole
	// store. Existing stores write `scannedAt: ""` in tests and older caches.
	it("skips the stale arm entirely when scannedAt is absent or unparseable", () => {
		const { env, scannedAtMs, make } = setup();
		const edited = make("src/config.ts", scannedAtMs + 5_000);
		for (const scannedAt of [undefined, "", "not-a-date"]) {
			const result = partitionFindingsByCitedPath<Finding>({
				findings: [{ file: edited, rule: "aws-access-token" }],
				cwd: env.tmpDir,
				scannedAt,
				citedPath,
			});
			expect(result.stale).toEqual([]);
			expect(result.live.map((f) => f.rule)).toEqual(["aws-access-token"]);
		}
		expect(parseScannedAtMs(undefined)).toBeUndefined();
		expect(parseScannedAtMs("")).toBeUndefined();
		expect(parseScannedAtMs("not-a-date")).toBeUndefined();
		expect(parseScannedAtMs(1234)).toBe(1234);
	});

	// The memo is per call, not per process. A module-level cache here would be
	// the process-lifetime latch shape: it would pin turn 1's verdict forever.
	it("re-probes on every call — the stat memo does not survive the delivery", () => {
		const probe = vi.fn((): FindingPathFreshness => "stale");
		const args = {
			findings: [
				{ file: "/repo/a.ts", rule: "a" },
				{ file: "/repo/a.ts", rule: "b" },
			],
			cwd: "/repo",
			scannedAt: new Date().toISOString(),
			citedPath,
			existence: probe,
		};
		partitionFindingsByCitedPath<Finding>(args);
		expect(probe).toHaveBeenCalledTimes(1); // memoized WITHIN the call
		partitionFindingsByCitedPath<Finding>(args);
		expect(probe).toHaveBeenCalledTimes(2); // fresh memo on the next delivery
	});

	it("reports stale for a newer mtime and live for an equal one", () => {
		const { scannedAtMs, make } = setup("pi-lens-freshness-probe-");
		const file = make("src/probe.ts", scannedAtMs + 5_000);
		expect(findingPathFreshness(file, scannedAtMs)).toBe("stale");
		expect(findingPathFreshness(file, scannedAtMs + 60_000)).toBe("live");
		// No timestamp: existence-only, exactly #1460's behaviour.
		expect(findingPathFreshness(file)).toBe("live");
	});
});

describe("gateFindingsByPathFreshness records (#1622 criterion 5)", () => {
	afterEach(() => logLatency.mockReset());

	it("logs one bounded finding_stale_line_demote naming the store and count", () => {
		const scannedAt = "2026-08-18T07:00:00.000Z";
		const gate = gateFindingsByPathFreshness<Finding>({
			store: "gitleaks",
			findings: [
				{ file: "/repo/stale/a.ts", rule: "a" },
				{ file: "/repo/stale/b.ts", rule: "b" },
				{ file: "/repo/stale/c.ts", rule: "c" },
				{ file: "/repo/stale/d.ts", rule: "d" },
				{ file: "/repo/kept.ts", rule: "kept" },
			],
			cwd: "/repo",
			scannedAt,
			citedPath,
			existence: (resolved) =>
				resolved.replace(/\\/g, "/").includes("/stale/") ? "stale" : "live",
		});

		expect(gate.live.map((f) => f.rule)).toEqual(["kept"]);
		expect(gate.stale.map((f) => f.rule)).toEqual(["a", "b", "c", "d"]);
		expect(logLatency).toHaveBeenCalledTimes(1);
		const entry = logLatency.mock.calls[0]![0] as {
			phase: string;
			metadata: Record<string, unknown>;
		};
		// Mirrors finding_dead_path_drop's shape, field for field.
		expect(entry.phase).toBe("finding_stale_line_demote");
		expect(entry.metadata).toMatchObject({
			store: "gitleaks",
			demotedStalePaths: 4,
			stalePathCount: 4,
			deliveredCount: 1,
			statCount: 5,
			scannedAt,
		});
		expect(entry.metadata.samplePaths).toHaveLength(3);
	});

	it("emits the drop record and the demote record independently", () => {
		gateFindingsByPathFreshness<Finding>({
			store: "trivy-secrets",
			findings: [
				{ file: "/repo/gone/a.ts", rule: "gone" },
				{ file: "/repo/stale/b.ts", rule: "stale" },
			],
			cwd: "/repo",
			scannedAt: "2026-08-18T07:00:00.000Z",
			citedPath,
			existence: (resolved) => {
				const p = resolved.replace(/\\/g, "/");
				if (p.includes("/gone/")) return "missing";
				return p.includes("/stale/") ? "stale" : "live";
			},
		});
		const phases = logLatency.mock.calls.map(
			(call) => (call[0] as { phase: string }).phase,
		);
		expect(phases).toEqual([
			"finding_dead_path_drop",
			"finding_stale_line_demote",
		]);
	});

	it("stays silent when every cited path is fresh", () => {
		const gate = gateFindingsByPathFreshness<Finding>({
			store: "gitleaks",
			findings: [{ file: "/repo/kept.ts", rule: "kept" }],
			cwd: "/repo",
			scannedAt: "2026-08-18T07:00:00.000Z",
			citedPath,
			existence: () => "live",
		});
		expect(gate.stale).toEqual([]);
		expect(gate.live).toHaveLength(1);
		expect(logLatency).not.toHaveBeenCalled();
	});
});

// ── Review round L1: the staleness boundary ──────────────────────────────────

describe("freshness boundary (#1622 review L1)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		cleanups.splice(0).forEach((cleanup) => cleanup());
		logLatency.mockReset();
	});

	/**
	 * Pins both sides of the comparison so a `>` / `>=` mutation, and a
	 * deleted-or-widened tolerance, cannot survive: mtime exactly AT the scan
	 * and at the edge of `MTIME_DRIFT_TOLERANCE_MS` (#1708's write-then-scan
	 * tolerance) are unchanged; one millisecond past the tolerance is modified.
	 */
	it("treats mtime <= scannedAt + MTIME_DRIFT_TOLERANCE_MS as live, one past it as stale", () => {
		const env = setupTestEnvironment("pi-lens-freshness-boundary-");
		cleanups.push(env.cleanup);
		const scannedAtMs = Date.UTC(2026, 7, 18, 7, 0, 0);
		const file = path.join(env.tmpDir, "src/boundary.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "const k = 1;\n");

		setMtime(file, scannedAtMs);
		expect(findingPathFreshness(file, scannedAtMs)).toBe("live");

		setMtime(file, scannedAtMs + MTIME_DRIFT_TOLERANCE_MS);
		expect(findingPathFreshness(file, scannedAtMs)).toBe("live");

		setMtime(file, scannedAtMs + MTIME_DRIFT_TOLERANCE_MS + 1);
		expect(findingPathFreshness(file, scannedAtMs)).toBe("stale");
	});

	it("carries the same boundary through the partition", () => {
		const env = setupTestEnvironment("pi-lens-freshness-boundary-part-");
		cleanups.push(env.cleanup);
		const scannedAtMs = Date.UTC(2026, 7, 18, 7, 0, 0);
		const scannedAt = new Date(scannedAtMs).toISOString();
		const at = path.join(env.tmpDir, "at.ts");
		const past = path.join(env.tmpDir, "past.ts");
		fs.writeFileSync(at, "1\n");
		fs.writeFileSync(past, "1\n");
		setMtime(at, scannedAtMs);
		setMtime(past, scannedAtMs + MTIME_DRIFT_TOLERANCE_MS + 1);

		const result = partitionFindingsByCitedPath<Finding>({
			findings: [
				{ file: at, rule: "at-scan" },
				{ file: past, rule: "past-tolerance" },
			],
			cwd: env.tmpDir,
			scannedAt,
			citedPath,
		});

		expect(result.live.map((f) => f.rule)).toEqual(["at-scan"]);
		expect(result.stale.map((f) => f.rule)).toEqual(["past-tolerance"]);
	});
});

// ── Review round H1: onMissing=demote for whole-artifact findings ─────────────

// ── #1708: same-millisecond write-then-scan race ─────────────────────────────

describe("freshness boundary same-millisecond tolerance (#1708)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		cleanups.splice(0).forEach((cleanup) => cleanup());
	});

	// Fabricates the mtime/scannedAt pair directly rather than relying on a
	// real write race — a file written and scanned in the same millisecond
	// must not demote. A bare +1ms tolerance
	// (`reconcileProjectDiagnosticsSnapshot`'s convention) was not enough:
	// measured Windows host skew between a file's mtime and the immediately
	// following `Date.now()` read runs up to ~11.4ms (#1491/#1498), the same
	// skew `MTIME_DRIFT_TOLERANCE_MS` already covers in `blocker-freshness.ts`
	// / `reconcileStaleWidgetFiles`. Without it, #1628's trivy-secrets
	// turn_end test flaked ~1-in-5 (a STOP blocker read back as a demoted
	// ACTION NEEDED tier).
	it("does not demote a file whose mtime lands within MTIME_DRIFT_TOLERANCE_MS of scannedAt", () => {
		const env = setupTestEnvironment("pi-lens-freshness-1708-");
		cleanups.push(env.cleanup);
		const scannedAtMs = Date.UTC(2026, 7, 18, 7, 0, 0);
		const file = path.join(env.tmpDir, "src/race.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "const k = 1;\n");
		setMtime(file, scannedAtMs + MTIME_DRIFT_TOLERANCE_MS);

		expect(findingPathFreshness(file, scannedAtMs)).toBe("live");
	});

	it("still demotes a file whose mtime lands past MTIME_DRIFT_TOLERANCE_MS of scannedAt", () => {
		const env = setupTestEnvironment("pi-lens-freshness-1708-outside-");
		cleanups.push(env.cleanup);
		const scannedAtMs = Date.UTC(2026, 7, 18, 7, 0, 0);
		const file = path.join(env.tmpDir, "src/genuine-edit.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "const k = 1;\n");
		setMtime(file, scannedAtMs + MTIME_DRIFT_TOLERANCE_MS + 1);

		expect(findingPathFreshness(file, scannedAtMs)).toBe("stale");
	});
});

describe("gateFindingsByPathFreshness onMissing (#1622 review H1)", () => {
	afterEach(() => logLatency.mockReset());

	// A govulncheck CVE is pinned by go.mod, not by the call site. Deleting one
	// traced file does not un-pin it, so `missing` must demote, not drop.
	it("routes a missing path into stale when onMissing is demote", () => {
		const gate = gateFindingsByPathFreshness<Finding>({
			store: "govulncheck",
			findings: [{ file: "/repo/gone/main.go", rule: "GO-2024-1234" }],
			cwd: "/repo",
			scannedAt: "2026-08-18T07:00:00.000Z",
			citedPath,
			onMissing: "demote",
			existence: () => "missing",
		});
		expect(gate.stale.map((f) => f.rule)).toEqual(["GO-2024-1234"]);
		expect(gate.live).toEqual([]);
		const phases = logLatency.mock.calls.map(
			(call) => (call[0] as { phase: string }).phase,
		);
		// Nothing was dropped, so no drop record — only the demote record.
		expect(phases).toEqual(["finding_stale_line_demote"]);
	});

	it("still drops by default, so the secrets lanes are unchanged", () => {
		const gate = gateFindingsByPathFreshness<Finding>({
			store: "gitleaks",
			findings: [{ file: "/repo/gone/a.json", rule: "generic-api-key" }],
			cwd: "/repo",
			scannedAt: "2026-08-18T07:00:00.000Z",
			citedPath,
			existence: () => "missing",
		});
		expect(gate.live).toEqual([]);
		expect(gate.stale).toEqual([]);
		const phases = logLatency.mock.calls.map(
			(call) => (call[0] as { phase: string }).phase,
		);
		expect(phases).toEqual(["finding_dead_path_drop"]);
	});
});

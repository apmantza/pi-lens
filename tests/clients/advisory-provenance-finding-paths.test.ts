/**
 * Finding-cited path existence — #1461 slice 1 (#1460).
 *
 * `validateAdvisoryProvenance` asks whether the files the agent EDITED changed.
 * These tests cover the other question: does the file a cached finding NAMES
 * still exist? The live case was a gitleaks 🔴 blocker for a directory deleted
 * eleven minutes before delivery, certified `current` seven times because the
 * edited files were all intact.
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
	dropFindingsForMissingPaths,
	findingPathExistence,
	partitionFindingsByCitedPath,
	type FindingPathExistence,
} from "../../clients/advisory-provenance.js";
import { setupTestEnvironment } from "./test-utils.js";

interface Finding {
	file?: string;
	rule: string;
}

const citedPath = (finding: Finding): string | undefined => finding.file;

describe("partitionFindingsByCitedPath (#1461 slice 1)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		cleanups.splice(0).forEach((cleanup) => cleanup());
		logLatency.mockReset();
	});

	function setup() {
		const env = setupTestEnvironment("pi-lens-finding-paths-");
		cleanups.push(env.cleanup);
		const live = path.join(env.tmpDir, "src", "live.ts");
		fs.mkdirSync(path.dirname(live), { recursive: true });
		fs.writeFileSync(live, "export const value = 1;\n");
		const dead = path.join(env.tmpDir, "gone", "secrets.json");
		fs.mkdirSync(path.dirname(dead), { recursive: true });
		fs.writeFileSync(dead, '{"key":"AKIA..."}\n');
		return { env, live, dead };
	}

	it("partitions a mixed record: the deleted path drops, the live one stays", () => {
		const { env, live, dead } = setup();
		fs.rmSync(path.dirname(dead), { recursive: true, force: true });
		const result = partitionFindingsByCitedPath<Finding>({
			findings: [
				{ file: dead, rule: "generic-api-key" },
				{ file: live, rule: "aws-access-token" },
			],
			cwd: env.tmpDir,
			citedPath,
		});
		expect(result.live.map((f) => f.rule)).toEqual(["aws-access-token"]);
		expect(result.dropped.map((f) => f.rule)).toEqual(["generic-api-key"]);
		expect(result.deadPaths).toHaveLength(1);
		expect(result.statCount).toBe(2);
		expect(result.truncated).toBe(false);
	});

	it("keeps every finding when nothing was deleted", () => {
		const { env, live } = setup();
		const result = partitionFindingsByCitedPath<Finding>({
			findings: [
				{ file: live, rule: "a" },
				{ file: live, rule: "b" },
			],
			cwd: env.tmpDir,
			citedPath,
		});
		expect(result.dropped).toEqual([]);
		expect(result.live).toHaveLength(2);
		// Deduped: two findings about one file cost ONE stat.
		expect(result.statCount).toBe(1);
	});

	it("stats each unique path once — a 256-finding record over one dead dir costs one stat", () => {
		const probe = vi.fn((): FindingPathExistence => "missing");
		const findings: Finding[] = Array.from({ length: 256 }, (_, i) => ({
			file: `/gone/dir/file-${i % 4}.ts`,
			rule: `rule-${i}`,
		}));
		const result = partitionFindingsByCitedPath<Finding>({
			findings,
			cwd: "/repo",
			citedPath,
			existence: probe,
		});
		expect(result.dropped).toHaveLength(256);
		expect(result.statCount).toBe(4);
		expect(probe).toHaveBeenCalledTimes(4);
	});

	it("fails open: no cited path, and an unreadable path, are both delivered", () => {
		const result = partitionFindingsByCitedPath<Finding>({
			findings: [
				{ rule: "no-path" },
				{ file: "", rule: "empty-path" },
				{ file: "/locked/secrets.json", rule: "unreadable" },
			],
			cwd: "/repo",
			citedPath,
			existence: () => "unknown",
		});
		expect(result.dropped).toEqual([]);
		expect(result.live).toHaveLength(3);
		// Only the one non-empty path was worth a stat.
		expect(result.statCount).toBe(1);
	});

	it("fails open past the stat budget, but still drops paths already probed", () => {
		const result = partitionFindingsByCitedPath<Finding>({
			findings: [
				{ file: "/gone/a.ts", rule: "probed-dead" },
				{ file: "/gone/b.ts", rule: "over-budget" },
				{ file: "/gone/a.ts", rule: "probed-dead-again" },
			],
			cwd: "/repo",
			citedPath,
			maxUniquePaths: 1,
			existence: () => "missing",
		});
		expect(result.dropped.map((f) => f.rule)).toEqual([
			"probed-dead",
			"probed-dead-again",
		]);
		expect(result.live.map((f) => f.rule)).toEqual(["over-budget"]);
		expect(result.statCount).toBe(1);
		expect(result.truncated).toBe(true);
	});

	it("treats an ENOENT path as missing and an existing one as live", () => {
		const { live, dead } = setup();
		expect(findingPathExistence(live)).toBe("live");
		fs.rmSync(path.dirname(dead), { recursive: true, force: true });
		expect(findingPathExistence(dead)).toBe("missing");
	});

	// #1461 HIGH-1: the drop decision must resolve a cited path the SAME way
	// `toRunnerDisplayPath` resolves it for the message the agent actually
	// sees (runtime-turn.ts). A bare `path.resolve(cwd, cited)` cannot find a
	// file that only exists via the ancestor-walk-up `resolveRunnerPath`
	// performs — so a scanner root one level above `cwd` would strictly
	// "not exist" and get dropped, while the display path would have found
	// and rendered it correctly.
	it("delivers a finding whose cited path only resolves via an ancestor root", () => {
		const env = setupTestEnvironment("pi-lens-finding-paths-ancestor-");
		cleanups.push(env.cleanup);
		const cwd = path.join(env.tmpDir, "packages", "sub");
		fs.mkdirSync(cwd, { recursive: true });
		// The scanner ran from `env.tmpDir` and cited a path relative to THAT
		// root; the agent's cwd at delivery time is the nested `packages/sub`.
		// `path.resolve(cwd, cited)` lands one level too deep and finds
		// nothing; only walking up from `cwd` finds the real file.
		const sharedDir = path.join(env.tmpDir, "shared");
		fs.mkdirSync(sharedDir, { recursive: true });
		const cited = path.join("shared", "secret.env");
		fs.writeFileSync(path.join(sharedDir, "secret.env"), "KEY=AKIA...\n");

		const result = partitionFindingsByCitedPath<Finding>({
			findings: [{ file: cited, rule: "ancestor-root" }],
			cwd,
			citedPath,
		});
		expect(result.live.map((f) => f.rule)).toEqual(["ancestor-root"]);
		expect(result.dropped).toEqual([]);
	});

	// Shape 7 / shape 1 probe: spellings that the FILESYSTEM confirms name one
	// file must fold to one key, one stat, one verdict. Which extra spellings
	// exist is decided by probing the FS, never by `process.platform` — on a
	// case-insensitive or backslash-speaking host that adds real variants; on
	// Linux CI the relative/absolute pair still keeps the assertion honest.
	it("folds every filesystem-confirmed spelling of one path into one stat", () => {
		const { env, dead } = setup();
		const spellings = [dead, path.relative(env.tmpDir, dead)];
		const identity = (candidate: string): string | undefined => {
			try {
				const stat = fs.statSync(path.resolve(env.tmpDir, candidate));
				return `${stat.dev}:${stat.ino}`;
			} catch {
				return undefined;
			}
		};
		const target = identity(dead);
		for (const candidate of [
			dead.replace(/\\/g, "/"),
			dead.replace(/\//g, "\\"),
			path.join(path.dirname(dead), path.basename(dead).toUpperCase()),
		]) {
			if (!spellings.includes(candidate) && identity(candidate) === target) {
				spellings.push(candidate);
			}
		}
		expect(spellings.length).toBeGreaterThan(1);

		fs.rmSync(path.dirname(dead), { recursive: true, force: true });
		const result = partitionFindingsByCitedPath<Finding>({
			findings: spellings.map((file, i) => ({ file, rule: `rule-${i}` })),
			cwd: env.tmpDir,
			citedPath,
		});
		expect(result.dropped).toHaveLength(spellings.length);
		expect(result.live).toEqual([]);
		expect(result.statCount).toBe(1);
		expect(result.deadPaths).toHaveLength(1);
	});
});

describe("dropFindingsForMissingPaths drop record (#1432 Gap 1)", () => {
	afterEach(() => logLatency.mockReset());

	it("logs one bounded record naming the store and the drop count", () => {
		const delivered = dropFindingsForMissingPaths<Finding>({
			store: "gitleaks",
			findings: [
				{ file: "/repo/gone/a.json", rule: "a" },
				{ file: "/repo/gone/b.json", rule: "b" },
				{ file: "/repo/gone/c.json", rule: "c" },
				{ file: "/repo/gone/d.json", rule: "d" },
				{ file: "/repo/kept.ts", rule: "kept" },
			],
			cwd: "/repo",
			citedPath,
			existence: (resolved) =>
				resolved.replace(/\\/g, "/").includes("/gone/") ? "missing" : "live",
		});
		expect(delivered.map((f) => f.rule)).toEqual(["kept"]);
		expect(logLatency).toHaveBeenCalledTimes(1);
		const entry = logLatency.mock.calls[0]![0] as {
			phase: string;
			metadata: Record<string, unknown>;
		};
		expect(entry.phase).toBe("finding_dead_path_drop");
		expect(entry.metadata).toMatchObject({
			store: "gitleaks",
			droppedDeadPaths: 4,
			deadPathCount: 4,
			deliveredCount: 1,
			statCount: 5,
		});
		// Sample is capped — a drop record never grows with the finding count.
		expect(entry.metadata.samplePaths).toHaveLength(3);
	});

	it("stays silent when every cited path still exists", () => {
		const findings: Finding[] = [{ file: "/repo/kept.ts", rule: "kept" }];
		expect(
			dropFindingsForMissingPaths<Finding>({
				store: "gitleaks",
				findings,
				cwd: "/repo",
				citedPath,
				existence: () => "live",
			}),
		).toEqual(findings);
		expect(logLatency).not.toHaveBeenCalled();
	});
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import {
	_resetBaselineSgconfigForTests,
	resolveBaselineSgconfig,
} from "../../clients/sgconfig.js";
import { removeTempDirSync } from "./test-utils.js";

// flake-shape: elapsed-time-assertion — #3403 measures the real scratch-tree
// filesystem work; fake timers cannot observe cold CI disk latency.

// Entry-cap bound on the shared sgconfig scratch dir (#2912: it held
// ~703,000 entries after one merge train). Drives the real
// resolveBaselineSgconfig writer and asserts the independent observables: the
// directory entry count and the bounded record on disk. The seam is
// language-neutral (rule baselines merge every bundled language), so no
// per-language matrix applies.

const ROOTS_OVER_CAP = 20;

describe("sgconfig scratch bound", () => {
	const roots: string[] = [];
	let prevTestMode: string | undefined;

	beforeEach(() => {
		// Recurrence (#4561, shuffle seed 202): `recordDegradationOnce` spends the
		// (kind, subject) key in the module-scope ledger, and the sibling case
		// drives the same shared scratch dir in test mode, so it consumed the key
		// without writing the row the other case reads. Each case starts from a
		// fresh session ledger.
		resetDegradationLedger();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0)) removeTempDirSync(root);
		_resetBaselineSgconfigForTests();
		if (prevTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = prevTestMode;
	});

	it("caps baseline entries and records the eviction once per session", async () => {
		const startedAt = Date.now();
		_resetBaselineSgconfigForTests();
		prevTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		for (let i = 0; i < ROOTS_OVER_CAP; i++) {
			const root = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-sgcap-root-"),
			);
			try {
				expect(resolveBaselineSgconfig(root)).toBeDefined();
			} finally {
				removeTempDirSync(root);
			}
		}
		const dir = path.join(os.tmpdir(), "pi-lens-ast-grep");
		const entries = fs.readdirSync(dir);
		expect(entries.length).toBeLessThanOrEqual(24);

		await flushLatencyLog();
		const rows = fs
			.readFileSync(path.join(getGlobalPiLensDir(), "latency.log"), "utf8")
			.split("\n")
			.filter((line) => line.includes("sgconfig-baseline-cap-evict"));
		expect(rows.length).toBeGreaterThan(0);
		expect(Date.now() - startedAt).toBeLessThan(10_000);
	}, 10_000);

	// Recurrence (the scanner temp-root fold, refs #4907): the baseline scratch
	// dir was joined onto a bare `os.tmpdir()`, so an ast-grep LSP spawn from a
	// harness that owns a scanner root (`PI_LENS_TEST_SCANNER_TMPDIR`) left its
	// config and merged rules outside the root the harness sweeps.
	it("materializes the baseline under the scanner report root", () => {
		_resetBaselineSgconfigForTests();
		const scannerRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-sgcap-scanner-root-"),
		);
		const project = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-sgcap-proj-"),
		);
		roots.push(scannerRoot, project);
		vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", scannerRoot);
		const configPath = resolveBaselineSgconfig(project);
		expect(configPath).toBeDefined();
		const dir = path.join(scannerRoot, "pi-lens-ast-grep");
		expect(path.dirname(configPath as string)).toBe(dir);
		expect(
			fs
				.readdirSync(dir)
				.filter((name) => name.endsWith(".rules"))
				.map((name) => fs.statSync(path.join(dir, name)).isDirectory()),
		).toEqual([true]);
	});

	it("evicts the oldest baselines first and keeps the newest", () => {
		_resetBaselineSgconfigForTests();
		const dir = path.join(os.tmpdir(), "pi-lens-ast-grep");
		fs.mkdirSync(dir, { recursive: true });
		const oldConfig = path.join(dir, "baseline-999980.sgconfig.yml");
		const oldRules = path.join(dir, "baseline-999980.rules");
		fs.writeFileSync(oldConfig, "ruleDirs: []\n");
		fs.mkdirSync(oldRules, { recursive: true });
		const old = new Date(Date.now() - 60 * 60 * 1000);
		fs.utimesSync(oldConfig, old, old);
		fs.utimesSync(oldRules, old, old);
		try {
			for (let i = 0; i < ROOTS_OVER_CAP; i++) {
				const root = fs.mkdtempSync(
					path.join(os.tmpdir(), "pi-lens-sgcap-new-"),
				);
				try {
					_resetBaselineSgconfigForTests();
					expect(resolveBaselineSgconfig(root)).toBeDefined();
				} finally {
					removeTempDirSync(root);
				}
			}
			expect(fs.existsSync(oldConfig)).toBe(false);
			expect(fs.existsSync(oldRules)).toBe(false);
			expect(fs.readdirSync(dir).length).toBeLessThanOrEqual(24);
		} finally {
			fs.rmSync(oldConfig, { force: true });
			fs.rmSync(oldRules, { recursive: true, force: true });
		}
	});
});

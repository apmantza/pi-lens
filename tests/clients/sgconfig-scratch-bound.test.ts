import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import {
	_resetBaselineSgconfigForTests,
	resolveBaselineSgconfig,
} from "../../clients/sgconfig.js";
import { removeTempDirSync } from "./test-utils.js";

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

	afterEach(() => {
		for (const root of roots.splice(0)) removeTempDirSync(root);
		_resetBaselineSgconfigForTests();
		if (prevTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = prevTestMode;
	});

	it("caps baseline entries and records the eviction once per session", async () => {
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

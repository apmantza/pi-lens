// #1940: `formatter_selected` fired only on a detection-cache miss, so cache hit
// rate was invisible and a cache-churning regression had no baseline.
// These tests pin the outcome discriminator ("hit" vs "miss") and cache-hit
// record emission in `getFormattersForFile`.
//
// MUTATION PROOFS:
//   - delete `outcome` from either `formatter_selected` metadata block and
//     the reachable outcome tests red;
//   - delete the `formatter_selected` log in the cache-hit branch and the hit
//     test reds;
//   - set `outcome: "miss"` on cache hit and the hit test reds;
//   - set `outcome: "hit"` on miss and the cold miss test reds.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const { safeSpawnAsync, logLatencySpy } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	logLatencySpy: vi.fn(),
}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	getAmbientAbortSignal: () => undefined,
	isCommandAvailableAsync: async () => false,
}));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

import {
	clearFormatterCache,
	getFormattersForFile,
} from "../../clients/formatters.js";

const notFoundResult = { stdout: "", stderr: "", status: 1 };
const foundResult = (binary: string) => ({
	stdout: `/usr/bin/${binary}\n`,
	stderr: "",
	status: 0,
});

const finder = () => (process.platform === "win32" ? "where" : "which");
const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) removeTempDirSync(tempDirs.pop() as string);
});

function pathLookups(verdicts: Record<string, "found" | "missing">) {
	return async (cmd: string, args: string[]) => {
		if (cmd !== finder()) return notFoundResult;
		const command = args[0] ?? "";
		const verdict = verdicts[command] ?? "missing";
		if (verdict === "found") return foundResult(command);
		return notFoundResult;
	};
}

const selections = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "formatter_selected");

function rubyProject(): { cwd: string; filePath: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-outcome-rb-"));
	tempDirs.push(cwd);
	fs.writeFileSync(
		path.join(cwd, ".rubocop.yml"),
		"AllCops:\n  NewCops: enable\n",
	);
	fs.writeFileSync(path.join(cwd, "Gemfile"), "gem 'rubocop'\n");
	const filePath = path.join(cwd, "app.rb");
	fs.writeFileSync(filePath, "puts 1\n");
	return { cwd, filePath };
}

function emptyRubyProject(): { cwd: string; filePath: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-outcome-bare-"));
	tempDirs.push(cwd);
	const filePath = path.join(cwd, "bare.rb");
	fs.writeFileSync(filePath, "puts 1\n");
	return { cwd, filePath };
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	logLatencySpy.mockReset();
	clearFormatterCache();
});

describe("formatter_selected outcome discriminator (#1940)", () => {
	it("records outcome 'miss' on cold detection and 'hit' on cache hit", async () => {
		const { cwd, filePath } = rubyProject();
		safeSpawnAsync.mockImplementation(pathLookups({ rubocop: "found" }));

		// Cold detection pass: misses cache, runs detection, logs outcome "miss"
		const first = await getFormattersForFile(filePath, cwd);
		expect(first.map((f) => f.name)).toEqual(["rubocop"]);
		expect(selections()).toHaveLength(1);
		expect(selections()[0]?.metadata).toMatchObject({
			formatter: "rubocop",
			reason: "detect",
			outcome: "miss",
			cwd,
		});
		expect(selections()[0]?.metadata?.cached).toBeUndefined();

		// Second pass on same file: answers from cache, logs outcome "hit"
		safeSpawnAsync.mockClear();
		const second = await getFormattersForFile(filePath, cwd);
		expect(second.map((f) => f.name)).toEqual(["rubocop"]);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(selections()).toHaveLength(2);
		expect(selections()[1]?.metadata).toMatchObject({
			formatter: "rubocop",
			reason: "cache",
			outcome: "hit",
			cached: true,
			cwd,
		});
	});

	it("records outcome 'miss' then 'hit' for empty (no formatter) selections", async () => {
		const { cwd, filePath } = emptyRubyProject();
		safeSpawnAsync.mockImplementation(pathLookups({ rubocop: "missing" }));

		// Cold pass finding no formatter
		const first = await getFormattersForFile(filePath, cwd);
		expect(first).toEqual([]);
		expect(selections()).toHaveLength(1);
		expect(selections()[0]?.metadata).toMatchObject({
			formatter: null,
			reason: "none",
			outcome: "miss",
			cwd,
		});
		expect(selections()[0]?.metadata?.cached).toBeUndefined();

		// Warm pass finding no formatter from cache
		safeSpawnAsync.mockClear();
		const second = await getFormattersForFile(filePath, cwd);
		expect(second).toEqual([]);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(selections()).toHaveLength(2);
		expect(selections()[1]?.metadata).toMatchObject({
			formatter: null,
			reason: "cache",
			outcome: "hit",
			cached: true,
			cwd,
		});
	});

	it("allows calculating detection cache hit rate with a single denominator", async () => {
		const { cwd, filePath } = rubyProject();
		safeSpawnAsync.mockImplementation(pathLookups({ rubocop: "found" }));

		// 1 miss + 3 hits
		await getFormattersForFile(filePath, cwd);
		await getFormattersForFile(filePath, cwd);
		await getFormattersForFile(filePath, cwd);
		await getFormattersForFile(filePath, cwd);

		const allSelections = selections();
		expect(allSelections).toHaveLength(4);

		const hits = allSelections.filter((s) => s.metadata?.outcome === "hit");
		const misses = allSelections.filter((s) => s.metadata?.outcome === "miss");
		expect(hits).toHaveLength(3);
		expect(misses).toHaveLength(1);

		const hitRate = hits.length / allSelections.length;
		expect(hitRate).toBe(0.75);
	});
});

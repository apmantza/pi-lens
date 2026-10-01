#!/usr/bin/env node
/**
 * Project-snapshot persist bench (#3789).
 *
 * Measures what ONE `saveProjectSnapshot` costs the extension host on a
 * realistic large snapshot, through the production entry point (the worker
 * persist path and the `PI_LENS_SNAPSHOT_PERSIST_SYNC=1` main-thread path):
 *
 *   - the synchronous time `saveProjectSnapshot` holds the main thread,
 *   - the longest event-loop stall (a 1 ms timer's worst gap) over the whole
 *     persist, which is what the host feels,
 *   - the RSS jump per persist (peak RSS minus the settled RSS right before
 *     the save; worker threads share the process RSS, so this counts them).
 *
 * Run after `npm run build`; it spawns one fresh child per mode so one mode's
 * heap never colours the other:
 *
 *   node scripts/bench-snapshot-persist.mjs \
 *     [--modes worker,sync] [--files 11500] [--persists 3] [--label <tree>] [--out <file.json>]
 *
 * `--files` sizes the synthetic snapshot (the default lands near the issue's
 * 68 MB raw / 19 MB gzip field measurement). The committed artifact
 * `tests/fixtures/snapshot-persist-measurement.json` is this script's raw
 * output for the before and after trees; `tests/clients/
 * snapshot-persist-measurement.test.ts` pins it.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const readArg = (flag, fallback) => {
	const at = args.indexOf(flag);
	return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const MB = 1024 * 1024;
const round = (n, digits = 1) => Number(n.toFixed(digits));

/** Deterministic synthetic snapshot shaped like a large TS + C# repo. */
export function buildSyntheticSnapshot(fileCount, projectRoot) {
	let state = 0x2545f491;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
	const pick = (list) => list[Math.floor(next() * list.length)];
	const kinds = ["function", "class", "method", "interface", "variable"];
	// Identifiers are drawn from a large random pool so gzip sees real-source
	// entropy (the issue's field snapshot compressed 68 MB to 18.9 MB, ~3.6x);
	// a small word list compresses 15x and under-measures the gzip cost.
	const token = () =>
		Array.from({ length: 5 + Math.floor(next() * 9) }, () =>
			String.fromCharCode(97 + Math.floor(next() * 26)),
		).join("");
	const words = Array.from({ length: 60_000 }, token);
	const hex = () =>
		Array.from({ length: 5 }, () =>
			Math.floor(next() * 0x100000000)
				.toString(16)
				.padStart(8, "0"),
		).join("");
	const files = {};
	const symbols = {};
	const reverseDeps = {};
	const cachedExports = [];
	const fileSeqByPath = [];
	const paths = [];
	for (let i = 0; i < fileCount; i++) {
		const dir = `${projectRoot}/src/${words[i % 211]}/${words[(i * 7) % 5000]}`;
		paths.push(`${dir}/${pick(words)}${i}.ts`);
	}
	for (let i = 0; i < fileCount; i++) {
		const filePath = paths[i];
		const symbolCount = 3 + Math.floor(next() * 6);
		files[filePath] = {
			path: filePath,
			mtimeMs: 1_780_000_000_000 + Math.floor(next() * 1e9),
			size: 500 + Math.floor(next() * 40_000),
			hash: hex(),
			language: i % 5 === 0 ? "csharp" : "typescript",
			lineCount: 20 + Math.floor(next() * 900),
			imports: Array.from({ length: 4 }, () => pick(paths)),
			symbolCount,
			lastSeq: 1 + Math.floor(next() * 5000),
		};
		symbols[filePath] = Array.from({ length: symbolCount }, (_, s) => {
			const name = `${pick(words)}${s}`;
			if (s % 4 === 0) cachedExports.push([name, filePath]);
			const startLine = 1 + Math.floor(next() * 800);
			return {
				name,
				kind: pick(kinds),
				filePath,
				startLine,
				endLine: startLine + Math.floor(next() * 60),
			};
		});
		reverseDeps[filePath] = Array.from(
			{ length: 1 + Math.floor(next() * 6) },
			() => pick(paths),
		);
		fileSeqByPath.push([filePath, 1 + Math.floor(next() * 5000)]);
	}
	// The word index is most of a real snapshot: `postings` is one small number
	// array per token and `forward` one small pair array per (file, token), so it
	// is the part that makes the structured clone allocation-heavy.
	const wordIndex = {
		version: 2,
		files: paths,
		postings: Array.from({ length: fileCount * 12 }, () => [
			pick(words),
			Array.from({ length: 2 * (1 + Math.floor(next() * 14)) }, () =>
				Math.floor(next() * fileCount),
			),
		]),
		docLengths: paths.map(() => 50 + Math.floor(next() * 4000)),
		totalTokens: fileCount * 900,
		indexedFileCount: fileCount,
		fileMtimes: paths.map(() => 1_780_000_000_000 + Math.floor(next() * 1e9)),
		fileSizes: paths.map(() => 500 + Math.floor(next() * 40_000)),
		forward: paths.map((_, fileIdx) => [
			fileIdx,
			Array.from({ length: 40 }, () => [
				pick(words),
				1 + Math.floor(next() * 9),
			]),
		]),
	};
	return {
		version: 2,
		projectRoot,
		generatedAt: new Date(1_790_000_000_000).toISOString(),
		seq: 1,
		files,
		symbols,
		reverseDeps,
		cachedExports,
		sequenceIndex: { projectSeq: 1, fileSeqByPath },
		wordIndex,
	};
}

async function runChild(mode, fileCount, persists) {
	const homeDir = process.env.PILENS_DATA_DIR;
	if (!homeDir) throw new Error("child requires a pinned PILENS_DATA_DIR");
	const cwd = path.join(homeDir, "bench-project");
	fs.mkdirSync(cwd, { recursive: true });
	const snapshotUrl = pathToFileURL(
		path.join(root, "clients", "project-snapshot.js"),
	).href;
	const {
		saveProjectSnapshot,
		getProjectSnapshotPath,
		getProjectSnapshotPersistStateForTests,
	} = await import(snapshotUrl);
	const snapshot = buildSyntheticSnapshot(fileCount, cwd);
	const rawBytes = Buffer.byteLength(JSON.stringify(snapshot));
	const rssNow = () => process.memoryUsage.rss();
	const settle = async (ms) => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		globalThis.gc?.();
		await new Promise((resolve) => setTimeout(resolve, 50));
	};
	const persistIdle = () => {
		const state = getProjectSnapshotPersistStateForTests(cwd);
		return !state.active && !state.queued;
	};
	const runs = [];
	// Persist 0 warms the worker and the module graph; it is reported but the
	// steady-state numbers are the later ones (the issue measured medians).
	for (let n = 0; n <= persists; n++) {
		snapshot.seq = n + 1;
		snapshot.sequenceIndex.projectSeq = n + 1;
		snapshot.generatedAt = new Date(1_790_000_000_000 + n * 1000).toISOString();
		await settle(300);
		const rssBefore = rssNow();
		let peakRss = rssBefore;
		let maxGapMs = 0;
		let lastTick = performance.now();
		const sampler = setInterval(() => {
			const now = performance.now();
			maxGapMs = Math.max(maxGapMs, now - lastTick - 1);
			lastTick = now;
			peakRss = Math.max(peakRss, rssNow());
		}, 1);
		const started = performance.now();
		saveProjectSnapshot(cwd, snapshot);
		const syncCallMs = performance.now() - started;
		peakRss = Math.max(peakRss, rssNow());
		while (!persistIdle()) {
			if (performance.now() - started > 120_000) {
				throw new Error("persist did not settle within 120 s");
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const persistMs = performance.now() - started;
		// Let the post-persist idle tick land so a stall at the tail is counted.
		await new Promise((resolve) => setTimeout(resolve, 100));
		clearInterval(sampler);
		const gzBytes = fs.statSync(getProjectSnapshotPath(cwd)).size;
		runs.push({
			persist: n,
			syncCallMs: round(syncCallMs),
			maxEventLoopStallMs: round(maxGapMs),
			persistWallMs: round(persistMs),
			rssJumpMB: round((peakRss - rssBefore) / MB),
			gzBytes,
		});
	}
	return { mode, fileCount, rawBytes, runs };
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(child) {
	const steady = child.runs.filter((run) => run.persist > 0);
	return {
		steadyPersists: steady.length,
		medianSyncCallMs: round(median(steady.map((r) => r.syncCallMs))),
		medianMaxEventLoopStallMs: round(
			median(steady.map((r) => r.maxEventLoopStallMs)),
		),
		medianPersistWallMs: round(median(steady.map((r) => r.persistWallMs))),
		medianRssJumpMB: round(median(steady.map((r) => r.rssJumpMB))),
		maxRssJumpMB: round(Math.max(...steady.map((r) => r.rssJumpMB))),
	};
}

async function main() {
	if (args.includes("--child")) {
		const mode = readArg("--child", "worker");
		const result = await runChild(
			mode,
			Number(readArg("--files", "11500")),
			Number(readArg("--persists", "3")),
		);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exit(0);
	}
	const modes = readArg("--modes", "worker,sync").split(",");
	const fileCount = Number(readArg("--files", "11500"));
	const persists = Number(readArg("--persists", "3"));
	const base = path.resolve(
		readArg("--home", path.join(root, ".probe-home", "bench-snapshot-persist")),
	);
	const results = [];
	for (const mode of modes) {
		const home = path.join(base, mode);
		fs.rmSync(home, { recursive: true, force: true });
		fs.mkdirSync(home, { recursive: true });
		const loadavg1mAtStart = round(os.loadavg()[0], 2);
		const child = spawnSync(
			process.execPath,
			[
				"--expose-gc",
				fileURLToPath(import.meta.url),
				"--child",
				mode,
				"--files",
				String(fileCount),
				"--persists",
				String(persists),
			],
			{
				encoding: "utf8",
				maxBuffer: 16 * MB,
				env: {
					...process.env,
					HOME: path.join(home, "home"),
					PI_LENS_HOME: path.join(home, "lens"),
					PILENS_DATA_DIR: path.join(home, "data"),
					PI_LENS_SNAPSHOT_PERSIST_SYNC: mode === "sync" ? "1" : "",
				},
			},
		);
		if (child.status !== 0) {
			throw new Error(`bench child ${mode} failed: ${child.stderr}`);
		}
		const parsed = JSON.parse(child.stdout.trim().split("\n").pop());
		results.push({
			...parsed,
			loadavg1mAtStart,
			summary: summarize(parsed),
		});
	}
	const report = {
		schemaVersion: 1,
		measuredAt: new Date().toISOString().slice(0, 10),
		command: `node scripts/bench-snapshot-persist.mjs --modes ${modes.join(",")} --files ${fileCount} --persists ${persists}`,
		node: process.version,
		platform: `${os.platform()} ${os.release()} ${os.arch()}`,
		cpus: os.cpus().length,
		label: readArg("--label", ""),
		results,
	};
	const out = readArg("--out", "");
	const text = `${JSON.stringify(report, null, 2)}\n`;
	if (out) fs.writeFileSync(path.resolve(out), text);
	process.stdout.write(text);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}

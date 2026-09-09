/**
 * Precise V8 coverage for a workload — the TypeScript analogue of
 * "run pyinstrument and report what percent of the code it touched."
 *
 * Occupancy tests already guard event-loop stalls. This reports *reach*:
 * of the compiled client modules in `include`, how many functions and
 * block ranges actually executed while `work` ran. Scripts compiled
 * before coverage starts still count subsequent calls.
 */

import { Session } from "node:inspector/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { toPosix } from "../../clients/path-utils.js";

export interface ScriptCoverageLike {
	url: string;
	functions: readonly {
		functionName: string;
		ranges: readonly { count: number }[];
	}[];
}

interface FileCoverage {
	file: string;
	functionCount: number;
	functionsHit: number;
	blockCount: number;
	blocksHit: number;
	functionPct: number;
	blockPct: number;
}

export interface CoverageSummary {
	files: FileCoverage[];
	filesTouched: number;
	filesTotal: number;
	functionPct: number;
	blockPct: number;
}

export function fileFromScriptUrl(
	url: string,
	root: string,
): string | undefined {
	if (!url.startsWith("file:")) return undefined;
	try {
		const absolute = fileURLToPath(url);
		const relative = toPosix(path.relative(root, absolute));
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
			return undefined;
		}
		return relative;
	} catch {
		return undefined;
	}
}

function ratio(hit: number, total: number): number {
	return total === 0 ? 0 : (hit / total) * 100;
}

export function summarizePreciseCoverage(
	scripts: readonly ScriptCoverageLike[],
	options: { root: string; include: readonly string[] },
): CoverageSummary {
	const wanted = new Map(options.include.map((file) => [toPosix(file), true]));
	const byFile = new Map<
		string,
		{
			functionCount: number;
			functionsHit: number;
			blockCount: number;
			blocksHit: number;
		}
	>();
	for (const file of wanted.keys()) {
		byFile.set(file, {
			functionCount: 0,
			functionsHit: 0,
			blockCount: 0,
			blocksHit: 0,
		});
	}

	for (const script of scripts) {
		const file = fileFromScriptUrl(script.url, options.root);
		if (!file || !wanted.has(file)) continue;
		const bucket = byFile.get(file);
		if (!bucket) continue;
		for (const fn of script.functions) {
			bucket.functionCount += 1;
			if (fn.ranges.some((range) => range.count > 0)) bucket.functionsHit += 1;
			for (const range of fn.ranges) {
				bucket.blockCount += 1;
				if (range.count > 0) bucket.blocksHit += 1;
			}
		}
	}

	const files: FileCoverage[] = [...byFile.entries()]
		.map(([file, counts]) => ({
			file,
			...counts,
			functionPct: ratio(counts.functionsHit, counts.functionCount),
			blockPct: ratio(counts.blocksHit, counts.blockCount),
		}))
		.sort((a, b) => a.file.localeCompare(b.file));

	let functionCount = 0;
	let functionsHit = 0;
	let blockCount = 0;
	let blocksHit = 0;
	let filesTouched = 0;
	for (const file of files) {
		functionCount += file.functionCount;
		functionsHit += file.functionsHit;
		blockCount += file.blockCount;
		blocksHit += file.blocksHit;
		if (file.functionsHit > 0) filesTouched += 1;
	}

	return {
		files,
		filesTouched,
		filesTotal: files.length,
		functionPct: ratio(functionsHit, functionCount),
		blockPct: ratio(blocksHit, blockCount),
	};
}

export async function withPreciseCoverage<T>(
	work: () => Promise<T>,
): Promise<{ result: T; scripts: ScriptCoverageLike[] }> {
	const session = new Session();
	session.connect();
	try {
		await session.post("Profiler.enable");
		await session.post("Profiler.startPreciseCoverage", {
			callCount: true,
			detailed: true,
		});
		const result = await work();
		const { result: scripts } = await session.post(
			"Profiler.takePreciseCoverage",
		);
		return { result, scripts };
	} finally {
		try {
			await session.post("Profiler.stopPreciseCoverage");
		} catch {
			// coverage may already be stopped if takePreciseCoverage failed
		}
		try {
			await session.post("Profiler.disable");
		} catch {
			// ignore
		}
		session.disconnect();
	}
}

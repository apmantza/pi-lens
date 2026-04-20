/**
 * Biome benchmark script
 * Measures lint performance for optimization verification
 */

import * as os from "node:os";
import * as path from "node:path";
import { resolvePackagePath } from "../clients/package-root.js";
import { safeSpawnAsync } from "../clients/safe-spawn.js";

const testFile = "clients/biome-client.ts";
const iterations = 5;

async function benchmark() {
	const isWin = process.platform === "win32";
	const piLensBin = path.join(
		os.homedir(),
		".pi-lens",
		"tools",
		"node_modules",
		".bin",
		isWin ? "biome.cmd" : "biome",
	);
	const configPath = resolvePackagePath(
		import.meta.url,
		"../config/biome/core.jsonc",
	);

	console.log(`Benchmarking biome lint on ${testFile}`);
	console.log(`Config: ${configPath}`);
	console.log(`Binary: ${piLensBin}`);
	console.log(`Iterations: ${iterations}`);
	console.log("---");

	const times: number[] = [];

	for (let i = 0; i < iterations; i++) {
		const start = Date.now();

		const result = await safeSpawnAsync(
			piLensBin,
			[
				"lint",
				"--reporter=json",
				"--no-errors-on-unmatched",
				`--config-path=${configPath}`,
				testFile,
			],
			{ timeout: 30000, cwd: process.cwd() },
		);

		const duration = Date.now() - start;
		times.push(duration);
		console.log(`Run ${i + 1}: ${duration}ms (exit: ${result.status})`);
	}

	const avg = times.reduce((a, b) => a + b, 0) / times.length;
	const min = Math.min(...times);
	const max = Math.max(...times);

	console.log("---");
	console.log(`Average: ${avg.toFixed(0)}ms`);
	console.log(`Min: ${min}ms`);
	console.log(`Max: ${max}ms`);

	// Compare to target
	const target = 800;
	const baseline = 1400;
	const improvement = ((baseline - avg) / baseline) * 100;

	console.log("---");
	console.log(`Baseline: ~${baseline}ms`);
	console.log(`Target: <${target}ms`);
	console.log(`Improvement: ${improvement.toFixed(1)}%`);

	if (avg < target) {
		console.log("✓ Target met!");
	} else {
		console.log("✗ Target not met - may need additional optimization");
	}
}

benchmark().catch((err) => {
	console.error("Benchmark failed:", err);
	process.exit(1);
});

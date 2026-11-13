import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatFile, type FormatterInfo } from "../../clients/formatters.js";
import { resetObservedRunnerLatency } from "../../clients/dispatch/collect-later-tier.js";
import { resetSpawnTimeoutCooldowns } from "../../clients/spawn-timeout-cooldown.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { setupTestEnvironment } from "./test-utils.js";

// flake-shape: raw-timer-wait — real child-flight recurrence requires bounded inter-call timing.

describe("formatFile live child flight", () => {
	afterEach(() => {
		resetObservedRunnerLatency();
		resetSpawnTimeoutCooldowns();
		resetProjectTrust();
	});

	it("does not spawn a second child while the first real shim is alive (#5549)", async () => {
		const env = setupTestEnvironment("pi-lens-format-live-flight-");
		try {
			setProjectTrustState("trusted");
			const { getDegradationSummary, resetDegradationLedger } =
				await import("../../clients/degradation-ledger.js");
			resetDegradationLedger();
			const filePath = path.join(env.tmpDir, "main.go");
			const countPath = path.join(env.tmpDir, "spawn-count");
			fs.writeFileSync(
				path.join(env.tmpDir, "go.mod"),
				"module example.test\n",
			);
			fs.writeFileSync(filePath, "package main\n");
			const script =
				"require('fs').appendFileSync(process.argv[1], '1'); setTimeout(() => {}, 60000)";
			const formatter: FormatterInfo = {
				name: "gofmt",
				command: [process.execPath, "-e", script, countPath, "$FILE"],
				extensions: [".go"],
				detect: async () => true,
				resolveCommand: async () => [
					process.execPath,
					"-e",
					script,
					countPath,
					filePath,
				],
			};

			const first = formatFile(filePath, formatter);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const second = formatFile(filePath, formatter);
			const third = formatFile(filePath, formatter);
			await new Promise((resolve) => setTimeout(resolve, 100));

			await first;
			const spawnedWhileLive = fs.existsSync(countPath)
				? fs.readFileSync(countPath, "utf8").length
				: 0;
			expect(spawnedWhileLive).toBe(1);
			expect((await second).outcome).toBe("skipped");
			expect((await third).outcome).toBe("skipped");
			expect(getDegradationSummary()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "formatter-skip",
					}),
				]),
			);
		} finally {
			env.cleanup();
		}
	}, 20_000);
});

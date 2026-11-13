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
import { getFormatService } from "../../clients/format-service.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

// flake-shape: raw-timer-wait — real child-flight recurrence requires bounded inter-call timing.

const spawnCount = (countPath: string): number =>
	fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8").length : 0;

describe("formatFile live child flight", () => {
	afterEach(() => {
		resetObservedRunnerLatency();
		resetSpawnTimeoutCooldowns();
		resetProjectTrust();
	});

	it("spawns one child for three simultaneous calls over a wedged shim, then cools it (#5549)", async () => {
		// RECURRENCE GUARDED: #5549 r2 checked the flight before two awaits and
		// claimed it after them, so three calls at once spawned three wedged
		// children; and no test made a call after the first child's own timeout,
		// so the cooldown check and its arming subject could be deleted green (F9).
		const env = setupTestEnvironment("pi-lens-format-live-flight-");
		try {
			setProjectTrustState("trusted");
			const { getDegradationSummary, resetDegradationLedger } =
				await import("../../clients/degradation-ledger.js");
			resetDegradationLedger();
			fs.writeFileSync(
				path.join(env.tmpDir, "go.mod"),
				"module example.test\n",
			);
			const files = ["a.go", "b.go", "c.go", "d.go"].map((name) => {
				const filePath = path.join(env.tmpDir, name);
				fs.writeFileSync(filePath, "package main\n");
				return filePath;
			});
			const countPath = path.join(env.tmpDir, "spawn-count");
			const script =
				"require('fs').appendFileSync(process.argv[1], '1'); setTimeout(() => {}, 60000)";
			const formatter: FormatterInfo = {
				name: "gofmt",
				command: [process.execPath, "-e", script, countPath, "$FILE"],
				extensions: [".go"],
				detect: async () => true,
				resolveCommand: async (filePath) => [
					process.execPath,
					"-e",
					script,
					countPath,
					filePath,
				],
			};

			const [first, second, third] = files
				.slice(0, 3)
				.map((filePath) => formatFile(filePath, formatter));
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(spawnCount(countPath)).toBe(1);

			// The child uses its own 15 s spawn budget, which arms the cooldown
			// before its turn ends; the two waiting calls then see it.
			expect((await first!).outcome).toBe("failed");
			const waiters = await Promise.race([
				Promise.all([second!, third!]),
				new Promise<"still waiting">((resolve) =>
					setTimeout(() => resolve("still waiting"), 1_000),
				),
			]);
			expect(spawnCount(countPath)).toBe(1);
			expect(waiters).not.toBe("still waiting");
			// A fresh call after the timeout answers the cooldown skip too.
			const fourth = await formatFile(files[3]!, formatter);
			expect(spawnCount(countPath)).toBe(1);
			for (const result of [...(waiters as unknown[]), fourth]) {
				expect(result).toMatchObject({
					success: true,
					changed: false,
					outcome: "skipped",
					error: "gofmt: spawn timeout cooldown is active",
				});
			}
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "formatter-skip",
				),
			).toMatchObject({
				count: 1,
				latestReasons: [
					{
						subject: "formatter:gofmt",
						reason: "formatter spawn timeout cooldown is active",
					},
				],
			});
		} finally {
			env.cleanup();
		}
	}, 25_000);

	// lane: the Linux unit shards; the shim is a `#!/bin/sh` script on PATH.
	it.skipIf(process.platform === "win32")(
		"formats every file of a real agent-end drain through a healthy shared formatter (#5549)",
		async () => {
			// RECURRENCE GUARDED: #5549 r2 skipped a write whose formatter had any
			// child alive in the project, healthy ones too. The drain runs three
			// workers, so files 4-6 met children of files 2-3 and stayed
			// unformatted with success:true, which nothing requeues (F8).
			const env = setupTestEnvironment("pi-lens-format-live-drain-");
			const previousPath = process.env.PATH;
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				setProjectTrustState("trusted");
				const proj = path.join(env.tmpDir, "proj");
				const bin = path.join(env.tmpDir, "bin");
				fs.mkdirSync(proj, { recursive: true });
				fs.mkdirSync(bin, { recursive: true });
				fs.writeFileSync(path.join(proj, "go.mod"), "module x\n\ngo 1.21\n");
				const countPath = path.join(env.tmpDir, "spawn-count");
				// gofmt -w FILE: the first file is quick, the rest overlap it.
				fs.writeFileSync(
					path.join(bin, "gofmt"),
					`#!/bin/sh\nprintf 1 >> '${countPath}'\ncase "$2" in */a.go) sleep 0.1;; *) sleep 0.6;; esac\necho "// formatted" >> "$2"\n`,
					{ mode: 0o755 },
				);
				process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
				const names = ["a", "b", "c", "d", "e", "f"];
				const files = names.map((name) => {
					const filePath = path.join(proj, `${name}.go`);
					fs.writeFileSync(filePath, "package main\n");
					return filePath;
				});
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = proj;
				for (const filePath of files)
					runtime.deferFormat(filePath, proj, "edit", proj);

				await handleAgentEnd({
					ctxCwd: proj,
					getFlag: (name) => name === "no-lsp",
					notify: () => {},
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: () => {} } as never,
					getFormatService: () =>
						getFormatService(runtime.telemetrySessionId, true),
				});

				expect(
					files.map(
						(filePath) =>
							`${path.basename(filePath)}=${fs.readFileSync(filePath, "utf8").includes("// formatted")}`,
					),
				).toEqual(names.map((name) => `${name}.go=true`));
				expect(runtime.pendingDeferredFormatCount).toBe(0);
				expect(spawnCount(countPath)).toBe(6);
			} finally {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = previousDataDir;
				env.cleanup();
			}
		},
		20_000,
	);
});

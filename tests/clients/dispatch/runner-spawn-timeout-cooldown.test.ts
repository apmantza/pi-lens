/**
 * #5413: a hung runner binary is spawned once per session, not once per edit.
 *
 * Recurrence: the timeout cooldown (#1995) was armed and read only by the
 * markdownlint runner and the autofix lane, so a wedged swiftlint paid its
 * 15 s spawn budget on every edit (the 2026-11-08 tool-alignment probe saw it
 * spawned twice across two edits). `safeSpawnAsync` now arms the cooldown for
 * the runner whose dispatch scope it ran in, and the dispatcher skips a
 * cooled runner before its availability probe.
 *
 * This drives the REAL dispatcher and the REAL swiftlint runner against a
 * stub `swiftlint` on PATH that answers `--version` and hangs on a lint run,
 * so the timeout, the kill and the cooldown are production's own. Each lint
 * invocation appends one line to a counter file before it hangs, which is how
 * the test counts spawns. POSIX-only: the stub is a shebang script.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetObservedRunnerLatency } from "../../../clients/dispatch/collect-later-tier.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	resetPendingRunnerFindings,
	settlePendingRunnerFindingsForTests,
} from "../../../clients/dispatch/pending-runner-findings.js";
import swiftlintRunner from "../../../clients/dispatch/runners/swiftlint.js";
import { safeSpawnAsync } from "../../../clients/safe-spawn.js";
import { createSingleFlight } from "../../../clients/single-flight.js";
import {
	isInSpawnTimeoutCooldown,
	resetSpawnTimeoutCooldowns,
} from "../../../clients/spawn-timeout-cooldown.js";
import { resolveCommandArgsWithInstallFallback } from "../../../clients/dispatch/runners/utils/runner-helpers.js";
import { probeToolAsync } from "../../../clients/tool-probe.js";
import { setupTestEnvironment } from "../test-utils.js";

// lane: dev-box-only on win32 (the stub is a POSIX shebang script); the
// ubuntu and macOS Unit tests legs run it.
describe.skipIf(process.platform === "win32")(
	"a hung runner binary is spawned once per session (#5413)",
	() => {
		let env: ReturnType<typeof setupTestEnvironment>;
		let counterFile: string;

		beforeEach(() => {
			resetSpawnTimeoutCooldowns();
			resetDegradationLedger();
			resetObservedRunnerLatency();
			resetPendingRunnerFindings();
			env = setupTestEnvironment("pi-lens-runner-cooldown-5413-");
			const stubDir = path.join(env.tmpDir, "stub-bin");
			fs.mkdirSync(stubDir, { recursive: true });
			counterFile = path.join(env.tmpDir, "lint-spawns.txt");
			const stub = path.join(stubDir, "swiftlint");
			fs.writeFileSync(
				stub,
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo 0.56.0; exit 0; fi',
					`echo spawned >> '${counterFile}'`,
					"exec sleep 120",
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
			vi.stubEnv("PATH", `${stubDir}${path.delimiter}${process.env.PATH}`);
		});

		afterEach(() => {
			vi.unstubAllEnvs();
			resetSpawnTimeoutCooldowns();
			resetObservedRunnerLatency();
			resetPendingRunnerFindings();
			env.cleanup();
		});

		function lintSpawns(): number {
			if (!fs.existsSync(counterFile)) return 0;
			return fs.readFileSync(counterFile, "utf8").split("\n").filter(Boolean)
				.length;
		}

		async function edit(writeIndex: number) {
			const filePath = path.join(env.tmpDir, "main.swift");
			fs.writeFileSync(filePath, `let edit = ${writeIndex}\n`);
			const ctx = createDispatchContext(
				filePath,
				env.tmpDir,
				{ getFlag: () => false },
				new FactStore(),
			);
			Object.defineProperty(ctx, "writeIndex", { value: writeIndex });
			const registry = new RunnerRegistry();
			registry.register(swiftlintRunner);
			return dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["swiftlint"] }],
				registry,
			);
		}

		it("spawns the wedged tool once across three edits and records the skip once", async () => {
			await edit(1);
			expect(lintSpawns()).toBe(1);
			await edit(2);
			await edit(3);
			// A collect-later rerun would spawn off the edit path; wait for every
			// deferred run so a second spawn cannot land after the count.
			await settlePendingRunnerFindingsForTests();

			expect(lintSpawns()).toBe(1);
			const skips = getDegradationSummary().filter(
				(group) => group.kind === "runner-spawn-timeout-cooldown",
			);
			expect(skips).toHaveLength(1);
			expect(skips[0]?.count).toBe(1);
			expect(skips[0]?.latestReasons[0]?.subject).toBe("swiftlint");
		}, 90_000);
	},
);

/**
 * The arming rules, through the real dispatcher and the real `safeSpawnAsync`
 * on a real node child that never exits. A runner spawns `process.execPath`,
 * the launcher shape markdownlint, spotbugs and credo use, so each case also
 * shows the cooldown is keyed by runner id, never by the launcher.
 */
describe("which runner spawns arm the cooldown (#5413)", () => {
	const HANG = ["-e", "setInterval(() => {}, 1 << 30)"];
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		resetSpawnTimeoutCooldowns();
		resetDegradationLedger();
		resetObservedRunnerLatency();
		env = setupTestEnvironment("pi-lens-runner-cooldown-arm-5413-");
	});

	afterEach(() => {
		resetSpawnTimeoutCooldowns();
		resetObservedRunnerLatency();
		env.cleanup();
	});

	/** Dispatch twice; `runs` counts how often the runner body ran. */
	async function dispatchTwice(
		runnerId: string,
		spawn: () => Promise<unknown>,
	): Promise<number> {
		let runs = 0;
		const registry = new RunnerRegistry();
		registry.register({
			id: runnerId,
			appliesTo: ["jsts"],
			priority: 1,
			run: async () => {
				runs += 1;
				await spawn();
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			},
		});
		const filePath = path.join(env.tmpDir, "a.ts");
		fs.writeFileSync(filePath, "export const a = 1;\n");
		for (let i = 0; i < 2; i++) {
			const ctx = createDispatchContext(
				filePath,
				env.tmpDir,
				{ getFlag: () => false },
				new FactStore(),
			);
			await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: [runnerId] }],
				registry,
			);
		}
		return runs;
	}

	it("a runner's own spawn timeout arms its id, not the launcher, and the next dispatch skips it", async () => {
		const runs = await dispatchTwice("launched-runner", () =>
			safeSpawnAsync(process.execPath, HANG, { timeout: 300 }),
		);
		expect(runs).toBe(1);
		expect(isInSpawnTimeoutCooldown("launched-runner")).toBe(true);
		expect(isInSpawnTimeoutCooldown(process.execPath)).toBe(false);
		const skip = getDegradationSummary().find(
			(group) => group.kind === "runner-spawn-timeout-cooldown",
		);
		expect(skip?.latestReasons[0]?.subject).toBe("launched-runner");
	}, 30_000);

	it("a probe (cooldown: false) that times out arms nothing (#1467)", async () => {
		const runs = await dispatchTwice("probe-runner", () =>
			probeToolAsync(process.execPath, HANG, { timeout: 300 }),
		);
		expect(runs).toBe(2);
		expect(isInSpawnTimeoutCooldown("probe-runner")).toBe(false);
	}, 30_000);

	it("the runner-helpers version checks (cooldown: false) that time out arm nothing", async () => {
		// Both version checks hang: the bundler-form check and the on-disk
		// verify it falls back to, so neutering either opt-out arms the runner.
		const runs = await dispatchTwice("version-check-runner", () =>
			resolveCommandArgsWithInstallFallback(
				{ cmd: process.execPath, args: [] },
				"version-check-runner",
				env.tmpDir,
				HANG,
				300,
			),
		);
		expect(runs).toBe(2);
		expect(isInSpawnTimeoutCooldown("version-check-runner")).toBe(false);
	}, 30_000);

	it("a timeout inside a shared single flight arms nothing", async () => {
		const flights = createSingleFlight<unknown>();
		const runs = await dispatchTwice("flight-runner", () =>
			flights.run("probe", () =>
				safeSpawnAsync(process.execPath, HANG, { timeout: 300 }),
			),
		);
		expect(runs).toBe(2);
		expect(isInSpawnTimeoutCooldown("flight-runner")).toBe(false);
	}, 30_000);

	it("an install-shaped spawn (ignoreAmbientSignal) that times out arms nothing", async () => {
		const runs = await dispatchTwice("install-runner", () =>
			safeSpawnAsync(process.execPath, HANG, {
				timeout: 300,
				ignoreAmbientSignal: true,
			}),
		);
		expect(runs).toBe(2);
		expect(isInSpawnTimeoutCooldown("install-runner")).toBe(false);
	}, 30_000);

	it("a budget a deadline cut short arms nothing: the caller's budget lapsed, not the tool's", async () => {
		const runs = await dispatchTwice("deadline-runner", () =>
			safeSpawnAsync(process.execPath, HANG, {
				timeout: 30_000,
				deadlineAt: Date.now() + 300,
			}),
		);
		expect(runs).toBe(2);
		expect(isInSpawnTimeoutCooldown("deadline-runner")).toBe(false);
	}, 30_000);
});
// flake-shape: real-process-spawn — a real child must use up its own spawn budget: the cooldown is armed by safeSpawnAsync's own timeout and teardown, which no double reproduces

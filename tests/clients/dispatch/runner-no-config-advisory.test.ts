/**
 * The #2811 recurrence: a constant per-file advisory on a runner path
 * ("no config detected", the markdownlint spawn-timeout cooldown notice)
 * logged once PER FILE at error level — 17 lines in one session for one
 * tool. The guards here red when the once-per-(tool, resolved root)
 * throttle is dropped (two lines, error level) and when the debug level is
 * lost (a line lands at the sink's error default).
 *
 * These drive the REAL dispatcher (createDispatchContext + dispatchForFile)
 * with the REAL runner modules and assert against the REAL extension.log
 * sink. PI_LENS_TEST_MODE=0 is the sanctioned single-file opt-out for real
 * writes; the log lives under the worker's hermetic PI_LENS_HOME.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import markdownlintRunner from "../../../clients/dispatch/runners/markdownlint.js";
import sqlfluffRunner from "../../../clients/dispatch/runners/sqlfluff.js";
import stylelintRunner from "../../../clients/dispatch/runners/stylelint.js";
import yamllintRunner from "../../../clients/dispatch/runners/yamllint.js";
import type { RunnerDefinition } from "../../../clients/dispatch/types.js";
import {
	flushExtensionLog,
	getExtensionLogPath,
} from "../../../clients/extension-log.js";
import {
	noteSpawnTimeout,
	resetSpawnTimeoutCooldowns,
} from "../../../clients/spawn-timeout-cooldown.js";

interface AdvisoryLine {
	level?: string;
	message?: string;
	metadata?: { filePath?: string };
}

let tempRoot: string;
const savedEnv: Record<string, string | undefined> = {};

function readDispatchLines(messagePrefix: string): AdvisoryLine[] {
	const logFile = getExtensionLogPath();
	if (!fs.existsSync(logFile)) return [];
	return fs
		.readFileSync(logFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as AdvisoryLine)
		.filter(
			(line) =>
				line.message?.startsWith(messagePrefix) &&
				line.metadata?.filePath?.startsWith(tempRoot),
		);
}

/** Dispatch one file through the real dispatcher with only the given runner. */
async function dispatchReal(
	registry: RunnerRegistry,
	runnerId: string,
	fileName: string,
): Promise<void> {
	const filePath = path.join(tempRoot, fileName);
	const ctx = createDispatchContext(
		filePath,
		tempRoot,
		{ getFlag: () => false },
		new FactStore(),
	);
	await dispatchForFile(
		ctx,
		[{ mode: "all", runnerIds: [runnerId] }],
		registry,
	);
}

function writeProjectFile(name: string, content: string): void {
	fs.writeFileSync(path.join(tempRoot, name), content);
}

function register(
	registry: RunnerRegistry,
	runners: RunnerDefinition[],
): RunnerRegistry {
	for (const runner of runners) registry.register(runner);
	return registry;
}

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2811-"));
	savedEnv.PI_LENS_TEST_MODE = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
});

afterEach(async () => {
	resetSpawnTimeoutCooldowns();
	if (savedEnv.PI_LENS_TEST_MODE === undefined) {
		delete process.env.PI_LENS_TEST_MODE;
	} else {
		process.env.PI_LENS_TEST_MODE = savedEnv.PI_LENS_TEST_MODE;
	}
	await flushExtensionLog();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("runner per-file advisories throttle once per tool and root (#2811)", () => {
	it("logs the yamllint no-config advisory once at debug level across two dispatches", async () => {
		const registry = register(new RunnerRegistry(), [yamllintRunner]);
		writeProjectFile("a.yml", "key: value\n");
		writeProjectFile("b.yml", "other: value\n");

		await dispatchReal(registry, "yamllint", "a.yml");
		await dispatchReal(registry, "yamllint", "b.yml");
		await flushExtensionLog();

		const lines = readDispatchLines("yamllint: no config detected");
		expect(lines).toHaveLength(1);
		expect(lines[0]?.level).toBe("debug");
		expect(lines.filter((line) => line.level === "error")).toHaveLength(0);
	}, 30_000);

	it("logs the stylelint and sqlfluff no-config advisories once each across two dispatches", async () => {
		const registry = register(new RunnerRegistry(), [
			stylelintRunner,
			sqlfluffRunner,
		]);
		writeProjectFile("a.css", "a { color: red; }\n");
		writeProjectFile("b.css", "b { color: blue; }\n");
		writeProjectFile("q.sql", "SELECT 1;\n");
		writeProjectFile("r.sql", "SELECT 2;\n");

		await dispatchReal(registry, "stylelint", "a.css");
		await dispatchReal(registry, "stylelint", "b.css");
		await dispatchReal(registry, "sqlfluff", "q.sql");
		await dispatchReal(registry, "sqlfluff", "r.sql");
		await flushExtensionLog();

		for (const prefix of [
			"stylelint: no config detected",
			"sqlfluff: no config detected",
		]) {
			const lines = readDispatchLines(prefix);
			expect(lines, prefix).toHaveLength(1);
			expect(lines[0]?.level, prefix).toBe("debug");
			expect(
				lines.filter((line) => line.level === "error"),
				prefix,
			).toHaveLength(0);
		}
	}, 30_000);

	// Skips on Windows with a stated reason: the cooldown shim is a POSIX
	// shebang script, so on win32 the availability probe cannot resolve it and
	// the runner skips before the cooldown branch (no Windows behavior pinned).
	it.skipIf(process.platform === "win32")(
		"logs the markdownlint spawn-timeout cooldown advisory once at debug level",
		{ timeout: 30_000 },
		async () => {
			const registry = register(new RunnerRegistry(), [markdownlintRunner]);
			const shimDir = path.join(tempRoot, "venv", "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			// The availability checker probes "markdownlint-cli2", so the shim must
			// carry that name to resolve.
			const shimPath = path.join(shimDir, "markdownlint-cli2");
			fs.writeFileSync(shimPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			writeProjectFile("a.md", "# hello\n");
			writeProjectFile("b.md", "# world\n");
			writeProjectFile("c.md", "# again\n");

			// First dispatch: the shim resolves and verifies, the cooldown is not
			// armed, so the runner completes without the cooldown advisory.
			await dispatchReal(registry, "markdownlint", "a.md");
			// Arm the runtime cooldown the same way a spawn timeout would; the next
			// two dispatches take the cooldown branch, which must not log per file.
			noteSpawnTimeout({
				tool: "markdownlint",
				command: shimPath,
				phase: "lint",
				durationMs: 1,
			});
			await dispatchReal(registry, "markdownlint", "b.md");
			await dispatchReal(registry, "markdownlint", "c.md");
			await flushExtensionLog();

			const lines = readDispatchLines("markdownlint: ");
			expect(lines).toHaveLength(1);
			expect(lines[0]?.level).toBe("debug");
		},
	);

	it("re-arms the advisory after the session-start ledger reset", async () => {
		const registry = register(new RunnerRegistry(), [yamllintRunner]);
		writeProjectFile("a.yml", "key: value\n");

		await dispatchReal(registry, "yamllint", "a.yml");
		// session_start resets the degradation ledger, which is the throttle's
		// generation source; the next dispatch in the same session-as-root
		// must record again instead of staying silent forever.
		resetDegradationLedger();
		await dispatchReal(registry, "yamllint", "a.yml");
		await flushExtensionLog();

		const lines = readDispatchLines("yamllint: no config detected");
		expect(lines).toHaveLength(2);
		expect(lines.map((line) => line.level)).toEqual(["debug", "debug"]);
	}, 30_000);
});

/**
 * #3721: a test process must never truncate a log under the REAL machine-global
 * home (`<homedir>/.pi-lens`).
 *
 * The recurrence this pins: on 2026-09-30 a maintainer's real `latency.log`
 * lost 76 minutes of rows (11:52Z to 13:08Z, 0 latency rows against 928
 * `sessionstart` rows in the same window). The first row of the live log was a
 * degradation-ledger row from a TEST pid naming the #3521 witness's home, and
 * 33 rows of that pid sat in the real log: the witness's `beforeEach` calls
 * `clearLatencyLog()`, and in a checkout whose witness lacked the home pin the
 * logger had resolved the real path at module load. Test-side pins fix one
 * witness at a time; the truncating primitive (`createNdjsonLogger`'s
 * `truncate()`, behind `clearLatencyLog`) is the one place every such file
 * funnels through, so it refuses.
 *
 * Hermetic: the "real home" here is `<tmp>/.pi-lens` under a fake HOME /
 * USERPROFILE, which `os.homedir()` reads at call time. Nothing here can touch
 * the maintainer's actual `~/.pi-lens`, with the guard present or mutated away.
 *
 * Both directions, because the dangerous one is the guard that blocks a
 * pinned home too (every test that clears a log would silently stop clearing):
 * the first two cases refuse, the next two still truncate.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

const ROWS = '{"phase":"a"}\n{"phase":"b"}\n{"phase":"c"}\n';

const saved = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_LENS_HOME: process.env.PI_LENS_HOME,
	PI_LENS_TEST_MODE: process.env.PI_LENS_TEST_MODE,
	VITEST: process.env.VITEST,
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

let fakeHome: string;
let realGlobalDir: string;
let realLatencyLog: string;
let cleanup: () => void;

beforeEach(() => {
	const env = setupTestEnvironment("pi-lens-3721-truncate-guard-");
	cleanup = env.cleanup;
	// Resolved through realpath so an aliased tmpdir (macOS /var) cannot make the
	// fixture's "home" differ in spelling from what the guard resolves.
	fakeHome = fs.realpathSync(env.tmpDir);
	process.env.HOME = fakeHome;
	process.env.USERPROFILE = fakeHome;
	// Precondition, not a case: every assertion below is only hermetic while
	// `os.homedir()` follows the fake HOME. If a platform ignored it, fail here,
	// before any case could reach the maintainer's actual `~/.pi-lens`.
	expect(os.homedir()).toBe(fakeHome);
	realGlobalDir = path.join(fakeHome, ".pi-lens");
	realLatencyLog = path.join(realGlobalDir, "latency.log");
	fs.mkdirSync(realGlobalDir, { recursive: true });
	fs.writeFileSync(realLatencyLog, ROWS);
	vi.resetModules();
});

afterEach(() => {
	restoreEnv();
	cleanup();
});

/** The #3521 witness shape: test mode off, PI_LENS_HOME naming `home`, a fresh
 *  module graph so the latency logger resolves its path at load, exactly as a
 *  checkout without the pin does. */
async function loadLatencyLogger(home: string) {
	process.env.PI_LENS_HOME = home;
	process.env.PI_LENS_TEST_MODE = "0";
	const latency = await import("../../clients/latency-logger.js");
	const ledger = await import("../../clients/degradation-ledger.js");
	ledger.resetDegradationLedger();
	return { latency, ledger };
}

describe("a test process never truncates a log under the real home (#3721)", () => {
	it("clearLatencyLog() against the real home leaves the rows and records the refusal", async () => {
		const { latency, ledger } = await loadLatencyLogger(realGlobalDir);
		expect(latency.getLatencyLogPath()).toBe(realLatencyLog);

		latency.clearLatencyLog();
		await latency.flushLatencyLog();

		expect(fs.readFileSync(realLatencyLog, "utf8")).toBe(ROWS);
		const refused = ledger
			.getDegradationSummary()
			.find((group) => group.kind === "log-sink-truncate-refused");
		expect(refused?.count).toBe(1);
		expect(refused?.latestReasons.map((entry) => entry.subject)).toEqual([
			realLatencyLog,
		]);
	});

	it("records once per sink however many clears are refused, and re-arms with the ledger", async () => {
		const { latency, ledger } = await loadLatencyLogger(realGlobalDir);
		for (let i = 0; i < 4; i++) latency.clearLatencyLog();
		await latency.flushLatencyLog();

		const groups = ledger
			.getDegradationSummary()
			.filter((group) => group.kind === "log-sink-truncate-refused");
		expect(groups).toHaveLength(1);
		expect(groups[0].count).toBe(4);
		expect(groups[0].latestReasons).toHaveLength(1);
		expect(fs.readFileSync(realLatencyLog, "utf8")).toBe(ROWS);

		ledger.resetDegradationLedger();
		expect(
			ledger
				.getDegradationSummary()
				.some((group) => group.kind === "log-sink-truncate-refused"),
		).toBe(false);
	});

	it("warns once on the 0 -> 1 refusal edge, so the test process sees the refusal on stderr (#3892 F1)", async () => {
		const { latency } = await loadLatencyLogger(realGlobalDir);
		// `emitWarning` is the terminal channel a `clients/` module may use: it
		// lands on stderr, while a raw `process.stderr.write` is refused by the
		// #1333 terminal-silence guard.
		const emitWarning = vi
			.spyOn(process, "emitWarning")
			.mockImplementation(() => undefined as never);
		try {
			latency.clearLatencyLog();
			latency.clearLatencyLog();
			expect(emitWarning).toHaveBeenCalledTimes(1);
			const [message, options] = emitWarning.mock.calls[0] ?? [];
			expect(String(message)).toContain(realLatencyLog);
			expect(String(message)).toContain("refused");
			expect(options).toEqual({ code: "PI_LENS_LOG_SINK_TRUNCATE_REFUSED" });
		} finally {
			emitWarning.mockRestore();
		}
	});

	it("refuses when the real home is reached through a link", async () => {
		const alias = path.join(fakeHome, "home-alias");
		fs.symlinkSync(fakeHome, alias, "junction");
		process.env.HOME = alias;
		process.env.USERPROFILE = alias;
		const { latency } = await loadLatencyLogger(realGlobalDir);

		latency.clearLatencyLog();
		await latency.flushLatencyLog();

		expect(fs.readFileSync(realLatencyLog, "utf8")).toBe(ROWS);
	});

	it("a pinned private home still truncates (the guard does not over-block)", async () => {
		const privateHome = path.join(fakeHome, "pinned-private-home");
		fs.mkdirSync(privateHome, { recursive: true });
		const privateLog = path.join(privateHome, "latency.log");
		fs.writeFileSync(privateLog, ROWS);
		const { latency, ledger } = await loadLatencyLogger(privateHome);
		expect(latency.getLatencyLogPath()).toBe(privateLog);

		latency.clearLatencyLog();
		await latency.flushLatencyLog();

		expect(fs.readFileSync(privateLog, "utf8")).toBe("");
		expect(
			ledger
				.getDegradationSummary()
				.some((group) => group.kind === "log-sink-truncate-refused"),
		).toBe(false);
	});

	it("a process that is not a test runner (no VITEST) truncates its own real home as production always has", async () => {
		const { latency } = await loadLatencyLogger(realGlobalDir);
		delete process.env.VITEST;

		latency.clearLatencyLog();
		await latency.flushLatencyLog();

		expect(fs.readFileSync(realLatencyLog, "utf8")).toBe("");
	});
});

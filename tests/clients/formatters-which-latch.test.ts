/**
 * #1495 — `which()` in formatters.ts is a spawn on a 5 s budget, and around a
 * dozen `detect*` implementations gate on it. A transient timeout dropped the
 * formatter AND wrote the resulting empty enabled-list into `detectionCache`, a
 * cache invalidated only by a formatter-config file's mtime or size. One stalled
 * `which rustfmt` therefore disabled Rust formatting for the rest of the session
 * unless the user happened to edit a config file.
 *
 * `.rs` is the vehicle: its policy makes rustfmt the smart default, rustfmt is
 * not auto-installable, so selection runs `detect()` and `detect()` runs
 * `which("rustfmt")`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.js";

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

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

/** `which`/`where` ran and found nothing: a genuine absence. */
const notFoundResult = { stdout: "", stderr: "", status: 1 };

/**
 * The prober itself could not run. Not a timeout, so it lands in
 * `classifyProbeFailure`'s unclassified arm — where the `missing` override used
 * to turn it into "rustfmt is not installed", for every which-gated formatter at
 * once, for the session.
 */
const proberUnspawnableResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn where EACCES"), { code: "EACCES" }),
	failure: "spawn",
	spawnFailure: { kind: "permission-denied" },
};
const foundResult = (binary: string) => ({
	stdout: `/usr/bin/${binary}\n`,
	stderr: "",
	status: 0,
});

const finder = () => (process.platform === "win32" ? "where" : "which");

const whichCalls = (command: string) =>
	safeSpawnAsync.mock.calls.filter(
		(call) => call[0] === finder() && (call[1] as string[])[0] === command,
	);

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");

function rustFile(): { cwd: string; filePath: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-which-latch-"));
	const filePath = path.join(cwd, "lib.rs");
	fs.writeFileSync(filePath, "fn main() {}\n");
	return { cwd, filePath };
}

const names = async (cwd: string, filePath: string): Promise<string[]> =>
	(await getFormattersForFile(filePath, cwd)).map((f) => f.name);

beforeEach(() => {
	safeSpawnAsync.mockReset();
	logLatencySpy.mockReset();
	clearFormatterCache();
	vi.useFakeTimers({ toFake: ["Date"] });
	return () => vi.useRealTimers();
});

describe("formatter PATH probes (#1495)", () => {
	it("does not cache an empty result caused by a stalled which", async () => {
		const { cwd, filePath } = rustFile();
		safeSpawnAsync.mockImplementation(async () => timeoutResult);

		expect(await names(cwd, filePath)).toEqual([]);
		expect(whichCalls("rustfmt")).toHaveLength(1);

		// Inside the cooldown the transient verdict is reused: no probe storm, and
		// still no cache entry to unstick later.
		expect(await names(cwd, filePath)).toEqual([]);
		expect(whichCalls("rustfmt")).toHaveLength(1);

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		safeSpawnAsync.mockImplementation(async () => foundResult("rustfmt"));
		expect(await names(cwd, filePath)).toEqual(["rustfmt"]);
	});

	it("records the timeout as a probe timeout, not a missing install", async () => {
		const { cwd, filePath } = rustFile();
		safeSpawnAsync.mockImplementation(async () => timeoutResult);
		await names(cwd, filePath);

		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "rustfmt",
			verdict: "unavailable",
			outcome: "transient",
			cause: "probe-timeout",
			latched: false,
			retryAfterMs: TRANSIENT_BASE_COOLDOWN_MS,
			// classifyProbeFailure already answered "transient" on its own —
			// nothing here overrode it (#2226 review F1).
			classifiedBy: "probe",
		});
	});

	it("latches a genuine absence and stops probing for it", async () => {
		const { cwd, filePath } = rustFile();
		safeSpawnAsync.mockImplementation(async () => notFoundResult);

		expect(await names(cwd, filePath)).toEqual([]);
		expect(whichCalls("rustfmt")).toHaveLength(1);
		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "rustfmt",
			outcome: "missing",
			cause: "not-found",
			latched: true,
			classifiedBy: "probe",
		});

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS * 4));
		expect(await names(cwd, filePath)).toEqual([]);
		expect(whichCalls("rustfmt")).toHaveLength(1);
	});

	it("does not latch when the prober itself could not run", async () => {
		const { cwd, filePath } = rustFile();
		safeSpawnAsync.mockImplementation(async () => proberUnspawnableResult);

		expect(await names(cwd, filePath)).toEqual([]);
		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "rustfmt",
			outcome: "transient",
			cause: "probe-rejected",
			latched: false,
			// The prober itself couldn't run, so this call site forced the
			// outcome/cause — a caller assertion, not classifyProbeFailure's
			// own answer (#2226 review F1).
			classifiedBy: "caller",
		});

		// An unspawnable prober is shared by every which-gated formatter, so a
		// durable verdict here would take out a dozen languages at once.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		safeSpawnAsync.mockImplementation(async () => foundResult("rustfmt"));
		expect(await names(cwd, filePath)).toEqual(["rustfmt"]);
	});

	it("keeps a stalled probe from suppressing an unrelated language", async () => {
		// The first cut counted transients process-wide, so one stalled
		// `which rustfmt` stopped a shell detection from caching and stamped
		// `reason: "probe-timeout"` on a selection where nothing timed out.
		const rust = rustFile();
		const shellCwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-which-latch-sh-"),
		);
		const shellFile = path.join(shellCwd, "script.sh");
		fs.writeFileSync(shellFile, "echo hi\n");

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			(args as string[])[0] === "shfmt" ? foundResult("shfmt") : timeoutResult,
		);

		// Overlapping passes: the stalled one must not change the healthy one.
		const [rustNames, shellNames] = await Promise.all([
			names(rust.cwd, rust.filePath),
			names(shellCwd, shellFile),
		]);
		expect(rustNames).toEqual([]);
		expect(shellNames).toEqual(["shfmt"]);

		const selections = logLatencySpy.mock.calls
			.map((call) => call[0])
			.filter((entry) => entry?.phase === "formatter_selected");
		expect(
			selections.find((entry) => entry.metadata?.formatter === "shfmt")
				?.metadata?.reason,
		).not.toBe("probe-timeout");
		expect(
			selections.find((entry) => entry.metadata?.reason === "probe-timeout")
				?.metadata?.stalledProbes,
		).toEqual(["rustfmt"]);

		// The shell result is cached; the stalled Rust one is not.
		safeSpawnAsync.mockClear();
		expect(await names(shellCwd, shellFile)).toEqual(["shfmt"]);
		expect(whichCalls("shfmt")).toHaveLength(0);
	});

	it("caches a positive verdict per command, not just per directory", async () => {
		// Two directories, so `detectionCache` cannot be what answers the second
		// call: the PATH latch is what keeps this to one probe.
		const first = rustFile();
		const second = rustFile();
		safeSpawnAsync.mockImplementation(async () => foundResult("rustfmt"));

		expect(await names(first.cwd, first.filePath)).toEqual(["rustfmt"]);
		expect(await names(second.cwd, second.filePath)).toEqual(["rustfmt"]);
		expect(whichCalls("rustfmt")).toHaveLength(1);
	});
});

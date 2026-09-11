/**
 * #1539 — a stalled probe for the PREFERRED formatter lets a lesser one win,
 * and that non-empty (merely wrong) result is written to `detectionCache`.
 *
 * #1495/#1532's poison guard only covers the EMPTY result, so this case walked
 * straight past it: the project is formatted by its second-choice formatter for
 * the rest of the session, and `formatter_selected` reports the reason as
 * `detect` because the reason is computed from config presence, not from how
 * the candidates were eliminated.
 *
 * `.rb` is the vehicle. It is the one live degraded pair in the registry: it has
 * no formatter policy, so selection runs the `detect()` loop over
 * `[rubocop, standardrb]` in that priority order, and both `detect()`s gate on
 * `which`.
 *
 * The second half of the file covers the guard's `command[0]` approximation.
 * `command[0]` is not the only binary a `detect()` consults, and the extras were
 * assumed harmless because "they are reached only after the primary already
 * answered". That is false when the primary answered a GENUINE absence and the
 * fallback is what stalled: `rustfmt` missing plus a stalled `which rustup`
 * skips the lazy install and caches the empty result for the session.
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
const foundResult = (binary: string) => ({
	stdout: `/usr/bin/${binary}\n`,
	stderr: "",
	status: 0,
});

const finder = () => (process.platform === "win32" ? "where" : "which");

/**
 * Route by the binary being looked up. Anything that is not a PATH lookup (the
 * `gem install rubocop` lazy install, say) fails: a SUCCESSFUL install resets
 * every which latch, which would erase the very transient verdict under test.
 */
function pathLookups(verdicts: Record<string, "found" | "missing" | "stall">) {
	return async (cmd: string, args: string[]) => {
		if (cmd !== finder()) return notFoundResult;
		const command = args[0] ?? "";
		const verdict = verdicts[command] ?? "missing";
		if (verdict === "found") return foundResult(command);
		if (verdict === "stall") return timeoutResult;
		return notFoundResult;
	};
}

const selections = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "formatter_selected");

const decisionsFor = (tool: string) =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter(
			(entry) =>
				entry?.phase === "availability_decision" &&
				entry.metadata?.tool === tool,
		);

/** A Ruby project that has elected BOTH rubocop and standardrb. */
function rubyProject(): { cwd: string; filePath: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-degraded-rb-"));
	fs.writeFileSync(
		path.join(cwd, ".rubocop.yml"),
		"AllCops:\n  NewCops: enable\n",
	);
	fs.writeFileSync(
		path.join(cwd, "Gemfile"),
		"gem 'standard'\ngem 'rubocop'\n",
	);
	const filePath = path.join(cwd, "app.rb");
	fs.writeFileSync(filePath, "puts 1\n");
	return { cwd, filePath };
}

/** A Rust project, so rustfmt's `rustup` install fallback is reachable. */
function rustProject(): { cwd: string; filePath: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-degraded-rs-"));
	fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]\nname='a'\n");
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

describe("a degraded formatter selection is not cached (#1539)", () => {
	it("does not cache the runner-up when the preferred probe stalled", async () => {
		const { cwd, filePath } = rubyProject();
		safeSpawnAsync.mockImplementation(
			pathLookups({ rubocop: "stall", standardrb: "found" }),
		);

		// standardrb wins this pass, but only because rubocop was never asked.
		expect(await names(cwd, filePath)).toEqual(["standardrb"]);

		// The verdict must not outlive rubocop's cooldown. Pre-fix the non-empty
		// result was cached, and `detectionCache` is invalidated only by a config
		// file's mtime or size — so standardrb owned the session.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		safeSpawnAsync.mockImplementation(
			pathLookups({ rubocop: "found", standardrb: "found" }),
		);
		expect(await names(cwd, filePath)).toEqual(["rubocop"]);
	});

	it("says in formatter_selected that the preferred candidate was unreachable", async () => {
		const { cwd, filePath } = rubyProject();
		safeSpawnAsync.mockImplementation(
			pathLookups({ rubocop: "stall", standardrb: "found" }),
		);
		await names(cwd, filePath);

		expect(selections()[0]?.metadata).toMatchObject({
			formatter: "standardrb",
			reason: "preferred-unreachable",
			cached: false,
			unreachablePreferred: ["rubocop"],
			stalledProbes: ["rubocop"],
		});
	});

	it("still caches — and still reports plainly — when the preferred one is genuinely absent", async () => {
		// The whole point of carrying a CAUSE: "rubocop is not installed" is a real
		// finding about this project and must keep caching exactly as before.
		const { cwd, filePath } = rubyProject();
		safeSpawnAsync.mockImplementation(
			pathLookups({ rubocop: "missing", standardrb: "found" }),
		);

		expect(await names(cwd, filePath)).toEqual(["standardrb"]);
		expect(selections()[0]?.metadata).toMatchObject({
			formatter: "standardrb",
			reason: "detect",
		});
		expect(selections()[0]?.metadata?.cached).toBeUndefined();

		safeSpawnAsync.mockClear();
		expect(await names(cwd, filePath)).toEqual(["standardrb"]);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});
});

describe("the poison guard sees every binary a detect probed (#1539)", () => {
	it("covers a stalled install fallback, not just command[0]", async () => {
		// rustfmt is genuinely absent, so "rustfmt" is NOT in the transient set and
		// the `command[0]` guard saw nothing. But `which rustup` stalled, so the
		// lazy `rustup component add rustfmt` never ran: this empty result is a
		// verdict about the probe, not about the project.
		const { cwd, filePath } = rustProject();
		safeSpawnAsync.mockImplementation(
			pathLookups({ rustfmt: "missing", rustup: "stall" }),
		);

		expect(await names(cwd, filePath)).toEqual([]);
		expect(selections()[0]?.metadata).toMatchObject({
			formatter: null,
			reason: "probe-timeout",
			cached: false,
		});
		expect(selections()[0]?.metadata?.stalledProbes).toContain("rustup");

		// And the recovery this used to foreclose: once `which rustup` answers, the
		// lazy `rustup component add rustfmt` runs, which resets every PATH latch.
		// Pre-fix the empty result was already cached, so this pass never happened.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		let installed = false;
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === "rustup") {
				installed = true;
				return { stdout: "", stderr: "", status: 0 };
			}
			if (cmd !== finder()) return notFoundResult;
			const command = args[0] ?? "";
			if (command === "rustup") return foundResult("rustup");
			if (command === "rustfmt" && installed) return foundResult("rustfmt");
			return notFoundResult;
		});
		expect(await names(cwd, filePath)).toEqual(["rustfmt"]);
	});

	it("does not claim a stall for a candidate this pass never probed", async () => {
		// The binding case for replacing the `command[0]` derivation, and the one
		// an earlier version of this test missed: its scenario produced a NON-empty
		// result, and `poisonedByTransientProbe` is gated on empty, so master's
		// derivation passed it too.
		//
		// Here the second pass is genuinely EMPTY. Directory A has a `.rubocop.yml`
		// and a stalled `which rubocop`, which puts "rubocop" in the transient set.
		// Directory B is a `.rb` file with NO rubocop and NO standardrb config, so
		// BOTH detections return false from the filesystem without probing
		// anything. Nothing stalled for THIS decision — "no Ruby formatter is
		// configured here" is a real finding and must cache.
		//
		// Master's derivation matches candidates on `command[0]`, sees "rubocop" in
		// the transient set, and refuses to cache a correct answer on every save,
		// stamping `probe-timeout` on a pass where no probe ran.
		const dirA = rubyProject();
		safeSpawnAsync.mockImplementation(pathLookups({ rubocop: "stall" }));
		expect(await names(dirA.cwd, dirA.filePath)).toEqual([]);

		const dirB = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-degraded-rb-bare-"),
		);
		const bareFile = path.join(dirB, "bare.rb");
		fs.writeFileSync(bareFile, "puts 1\n");
		logLatencySpy.mockClear();
		safeSpawnAsync.mockClear();

		expect(await names(dirB, bareFile)).toEqual([]);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(selections()[0]?.metadata).toMatchObject({ reason: "none" });
		expect(selections()[0]?.metadata?.cached).toBeUndefined();
		expect(selections()[0]?.metadata?.stalledProbes).toBeUndefined();

		// And it is genuinely cached: a second pass is served from the cache, so
		// it logs a cache-hit selection record (#1940).
		expect(await names(dirB, bareFile)).toEqual([]);
		expect(selections()).toHaveLength(2);
		expect(selections()[1]?.metadata).toMatchObject({
			formatter: null,
			reason: "cache",
			cached: true,
			outcome: "hit",
		});
	});
});

describe("a cooldown-served PATH verdict is observable (#1539)", () => {
	it("records one bounded decision row per cooldown window", async () => {
		// The memo branch returned before `logAvailabilityDecision`, so a formatter
		// held off by a transient cooldown produced ONE record for many decisions.
		// A reader counting `availability_decision` rows undercounted how long it
		// had been off.
		const { cwd, filePath } = rustProject();
		safeSpawnAsync.mockImplementation(
			pathLookups({ rustfmt: "stall", rustup: "missing" }),
		);

		await names(cwd, filePath);
		const afterProbe = decisionsFor("rustfmt");
		expect(afterProbe).toHaveLength(1);
		expect(afterProbe[0]?.metadata?.servedFromCooldown).toBeUndefined();

		// Three more decisions inside the same cooldown window: exactly one extra
		// row, marked as cache-served, so the cadence stays bounded.
		await names(cwd, filePath);
		await names(cwd, filePath);
		await names(cwd, filePath);
		const served = decisionsFor("rustfmt").filter(
			(entry) => entry.metadata?.servedFromCooldown === true,
		);
		expect(served).toHaveLength(1);
		expect(served[0]?.metadata).toMatchObject({
			verdict: "unavailable",
			outcome: "transient",
			cause: "probe-timeout",
			latched: false,
		});
		expect(served[0]?.metadata?.retryAfterMs).toBeGreaterThan(0);
		expect(decisionsFor("rustfmt")).toHaveLength(2);
	});
});

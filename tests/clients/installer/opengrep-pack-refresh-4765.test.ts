/**
 * #4765: the background refresh of the Opengrep registry pack, through the
 * managed-tool refresh entry point (`runManagedToolRefresh`).
 *
 * Real seams: a local HTTP server stands in for semgrep.dev (the network is the
 * boundary), and a real executable stands in for the managed `opengrep` binary
 * (a process boundary; the genuine `--validate` is measured by hand in the PR).
 * The stamp file, the degradation ledger, the install gate and the cache swap
 * all run for real against a temp `PI_LENS_HOME`.
 *
 * Recurrences these cases prevent: a refresh that replaces a working pack with a
 * broken one (the language server then initializes with no rules at all), a
 * refresh that retries every session while offline, and one degradation record
 * per occurrence instead of per session.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { waitFor } from "../interleaving-kit.js";
import { withEnv } from "../../support/with-env.js";
import { acquireManagedInstallGate } from "../../../clients/installer/index.js";

vi.unmock("../../../clients/installer/index.js");

const TEST_HOME = vi.hoisted(() => {
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const dir = nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-4765-"),
	);
	// The installer's bin dir is a module-level const: the override must land
	// before it is imported. Undone by `vi.unstubAllEnvs()` in afterAll.
	vi.stubEnv("PI_LENS_HOME", dir);
	return dir;
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { resolveOpengrepConfig } from "../../../clients/opengrep-config.js";
import {
	getManagedToolRefreshStatePath,
	readManagedToolRefreshState,
	refreshOpengrepRulePack,
	runManagedToolRefresh,
} from "../../../clients/installer/managed-tool-refresh.js";
import { resetManagedToolRefreshSession } from "../../../clients/installer/managed-tool-refresh-session.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";

const BIN_DIR = path.join(TEST_HOME, "bin");
const CACHED = path.join(TEST_HOME, "rules", "opengrep-registry.yaml");
const SHIM_LOG = path.join(TEST_HOME, "shim.log");
const SHIM_MODE = path.join(TEST_HOME, "shim.mode");
const SHIM_SEEN = path.join(TEST_HOME, "shim.seen");
const SHIM_RELEASE = path.join(TEST_HOME, "shim.release");
// Test-only delay hook: when this file exists the shim sleeps for the seconds it
// holds at the point where the race is forced. See installOpengrepShim.
const SHIM_DELAY = path.join(TEST_HOME, "shim.delay");
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** A pack of `n` rules in the registry's shape. */
function packOf(n: number, tag: string): string {
	const rules = Array.from(
		{ length: n },
		(_, i) =>
			`- id: x.${tag}.${i}\n  pattern: foo(...)\n  languages: [python]\n`,
	).join("");
	return `rules:\n${rules}`;
}

type ServerMode =
	| "ok"
	| "http500"
	| "garbage"
	| "oversize"
	| "offline"
	| "gzip-json"
	| "json"
	| "drip";
let server: http.Server;
let baseUrl: string;
let mode: ServerMode;
let body: string;
let hits: number;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		hits += 1;
		if (mode === "http500") {
			res.writeHead(500).end("boom");
		} else if (mode === "garbage") {
			res.writeHead(200).end("<html>captive portal</html>");
		} else if (mode === "drip") {
			// One byte per ~20 ms, forever: it never trips an idle timeout. Paced by
			// the governed `waitFor`, not a raw timer (the flake-shape ratchet).
			res.writeHead(200);
			let closed = false;
			res.on("close", () => {
				closed = true;
			});
			void (async () => {
				while (!closed) {
					res.write("x");
					const next = Date.now() + 20;
					await waitFor(
						() => (closed ? Number.POSITIVE_INFINITY : Date.now()),
						(now) => now >= next,
						{ timeoutMs: 2000 },
					);
				}
			})();
		} else if (mode === "oversize") {
			res.writeHead(200);
			const chunk = Buffer.alloc(1024 * 1024, "a");
			for (let i = 0; i < 17; i++) res.write(chunk);
			res.end();
		} else if (
			mode === "json" ||
			(mode === "gzip-json" && req.headers["accept-encoding"] !== "identity")
		) {
			const rules = body.match(/^- id: .*/gm) ?? [];
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ rules: rules.map((r) => ({ id: r.slice(6) })) }));
		} else {
			res.writeHead(200, { "content-type": "text/yaml" }).end(body);
		}
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/c/auto`;
});

afterAll(async () => {
	vi.unstubAllEnvs();
	// A downloader that ignored its deadline leaves the drip connection open;
	// close it so the failure is the test's assertion, not a hung hook.
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

/**
 * The managed `opengrep`: answers `scan --validate --config <file>` the way the
 * real one does (`Configuration is valid ... N rule(s).`), counting rules in the
 * file it was handed. `shim.mode` drives `fail` (exit 5) and `few` (a stub of 3
 * rules). One line per call goes to `shim.log`, and the cached pack as the shim
 * saw it (a reader running DURING validation) goes to `shim.seen`.
 */
function installOpengrepShim(): void {
	fs.mkdirSync(BIN_DIR, { recursive: true });
	const shim = path.join(BIN_DIR, "opengrep");
	fs.writeFileSync(
		shim,
		[
			"#!/bin/sh",
			// The mode is latched before the log line, so a logged call means the mode
			// is fixed: a test that flips the mode after the log line cannot flip it
			// (log line written before mode latch let setShim flip a parked loser, #4796).
			`mode=$(cat "${SHIM_MODE}" 2>/dev/null || echo ok)`,
			`[ -f "${SHIM_DELAY}" ] && sleep "$(cat "${SHIM_DELAY}")"`,
			// The call line carries the latched mode, so a log line written before the
			// latch has no `latched=<mode>` value to show.
			`echo "$@" "latched=$mode" >> "${SHIM_LOG}"`,
			`cat "${CACHED}" > "${SHIM_SEEN}" 2>/dev/null`,
			`[ "$mode" = fail ] && { echo "invalid rule" >&2; exit 5; }`,
			// `hold` parks the validate until the test releases it, so the test can
			// act while a refresh is mid-validation (bounded: 20 s, then it goes on).
			`if [ "$mode" = hold ]; then i=0; while [ ! -f "${SHIM_RELEASE}" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; fi`,
			// `holdfail` parks the same way and then FAILS: a refresh that started
			// before its winner and settles after it.
			`if [ "$mode" = holdfail ]; then i=0; while [ ! -f "${SHIM_RELEASE}" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; echo "invalid rule" >&2; exit 5; fi`,
			`n=$(grep -o -E '^ *- id:|"id":' "$4" | wc -l)`,
			`[ "$mode" = few ] && n=3`,
			// `color`: the real CLI colours its summary when the host forces colour.
			`[ "$mode" = color ] && { printf 'Configuration is valid - found 0 configuration error(s), and \\033[1;32m%s\\033[0m rule(s).\\n' "$n"; exit 0; }`,
			`echo "Configuration is valid - found 0 configuration error(s), and $n rule(s)."`,
			"",
		].join("\n"),
	);
	fs.chmodSync(shim, 0o755);
}

function setShim(
	value: "ok" | "fail" | "few" | "hold" | "holdfail" | "color",
): void {
	fs.writeFileSync(SHIM_MODE, value);
}

/** Candidate files beside the cached pack: every refresh names and removes its own. */
function leftoverCandidates(): string[] {
	const dir = path.dirname(CACHED);
	return fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter((name) => name.startsWith(`${path.basename(CACHED)}.candidate`))
		: [];
}

const shimCalls = (): number =>
	fs.existsSync(SHIM_LOG)
		? fs.readFileSync(SHIM_LOG, "utf-8").trim().split("\n").length
		: 0;

function packDegradations(): Array<{ subject: string; reason: string }> {
	return (
		getDegradationSummary()
			.find((g) => g.kind === "managed-tool-refresh")
			?.latestReasons.filter((r) => r.subject === "opengrep-rules") ?? []
	);
}

async function packStamp() {
	const read = await readManagedToolRefreshState();
	return read.status === "ok" ? read.state.tools["opengrep-rules"] : undefined;
}

let restoreEnv: () => void;

beforeEach(() => {
	fs.rmSync(path.join(TEST_HOME, "rules"), { recursive: true, force: true });
	fs.rmSync(path.join(TEST_HOME, "tools"), { recursive: true, force: true });
	fs.rmSync(SHIM_LOG, { force: true });
	fs.rmSync(SHIM_MODE, { force: true });
	fs.rmSync(SHIM_SEEN, { force: true });
	fs.rmSync(SHIM_RELEASE, { force: true });
	fs.rmSync(SHIM_DELAY, { force: true });
	installOpengrepShim();
	mode = "ok";
	body = packOf(150, "v1");
	hits = 0;
	resetDegradationLedger();
	resetManagedToolRefreshSession();
	resetProjectTrust();
	setProjectTrustState("trusted");
	restoreEnv = withEnv({
		PI_LENS_DISABLE_TOOL_INSTALL: "0",
		PI_LENS_DISABLE_TOOL_REFRESH: undefined,
		PI_LENS_TOOL_REFRESH_INTERVAL_MS: undefined,
		PI_LENS_TOOL_REFRESH_RETRY_MS: undefined,
		// The shim makes `opengrep` a present managed tool, so the binary refresh
		// that runs before the pack would ask GitHub for a release. No slots, no
		// network; the pack step has its own cadence and spends none.
		PI_LENS_TOOL_REFRESH_MAX_PER_SESSION: "0",
		PI_LENS_TEST_OPENGREP_PACK_URL: baseUrl,
		// A probe that waits on the shared install lock gives up in 2 s, not 150 s.
		PI_LENS_INSTALL_LOCK_TIMEOUT_MS: "2000",
	});
});

afterEach(() => {
	restoreEnv();
	resetProjectTrust();
});

describe.skipIf(process.platform === "win32")(
	"opengrep registry pack refresh (#4765)",
	() => {
		it("downloads, validates and swaps in the pack through runManagedToolRefresh, and the next spawn uses it", async () => {
			const project = path.join(TEST_HOME, "proj");
			fs.mkdirSync(project, { recursive: true });
			// Before the first refresh there is no pack: `auto`, as before.
			expect(resolveOpengrepConfig(project, { enabled: true }).configArg).toBe(
				"auto",
			);

			await runManagedToolRefresh(NOW);

			expect(fs.readFileSync(CACHED, "utf-8")).toBe(body);
			expect(shimCalls()).toBe(1);
			expect(
				fs.readFileSync(SHIM_LOG, "utf-8").split(" ").slice(0, 3).join(" "),
			).toBe("scan --validate --config");
			expect(resolveOpengrepConfig(project, { enabled: true }).configArg).toBe(
				CACHED,
			);
			expect(await packStamp()).toMatchObject({ checkedAt: NOW });
			expect((await packStamp())?.failed).toBeUndefined();
			expect(packDegradations()).toHaveLength(0);
			// The candidate file never outlives the run.
			expect(leftoverCandidates()).toEqual([]);
		});

		it("follows a cadence: a fresh stamp fetches nothing, a week later it fetches again", async () => {
			await refreshOpengrepRulePack(NOW);
			expect(hits).toBe(1);

			body = packOf(160, "v2");
			expect(await refreshOpengrepRulePack(NOW + DAY_MS)).toBe("skipped");
			expect(hits).toBe(1);
			expect(fs.readFileSync(CACHED, "utf-8")).toContain("x.v1.0");

			expect(await refreshOpengrepRulePack(NOW + 8 * DAY_MS)).toBe("refreshed");
			expect(hits).toBe(2);
			expect(fs.readFileSync(CACHED, "utf-8")).toBe(body);
		});

		it("an unchanged pack is not re-validated or rewritten", async () => {
			await refreshOpengrepRulePack(NOW);
			expect(shimCalls()).toBe(1);
			const before = fs.statSync(CACHED).mtimeMs;
			expect(await refreshOpengrepRulePack(NOW + 8 * DAY_MS)).toBe("unchanged");
			expect(shimCalls()).toBe(1);
			expect(fs.statSync(CACHED).mtimeMs).toBe(before);
			expect(await packStamp()).toMatchObject({ checkedAt: NOW + 8 * DAY_MS });
		});

		it("asks for an uncompressed body, because the registry answers a gzip client with JSON", async () => {
			// Recurrence: semgrep.dev/c/auto answers Node's default
			// `Accept-Encoding: gzip` with the rule set as JSON and an `identity`
			// client with YAML. The CLI loaded the JSON-in-.yaml cache but the
			// language server read zero rules from it and published empty
			// diagnostics (measured 2026-10-23), so a JSON cache would silently
			// turn every scan into a silent clean one.
			mode = "gzip-json";
			expect(await refreshOpengrepRulePack(NOW)).toBe("refreshed");
			expect(fs.readFileSync(CACHED, "utf-8")).toBe(body);
			expect(fs.readFileSync(CACHED, "utf-8").startsWith("rules:")).toBe(true);
		});

		// #5781 F1/F4: the pack was bounded by `AbortSignal.timeout(60 s)` before it
		// moved onto the shared downloader, which only had an idle timeout; a server
		// dripping a byte per window then held the single-flight refresh slot for as
		// long as it liked. The 60 s is the pack's own constant, so the test swaps
		// only that timer for a short one and asserts the call asked for 60 s.
		it("fails a slow-drip registry at its 60 s elapsed deadline instead of holding the refresh slot", async () => {
			mode = "drip";
			const realTimeout = AbortSignal.timeout.bind(AbortSignal);
			const asked: number[] = [];
			const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
				asked.push(ms);
				return realTimeout(ms === 60_000 ? 200 : ms);
			});
			try {
				expect(await refreshOpengrepRulePack(NOW)).toBe("failed");
			} finally {
				spy.mockRestore();
			}
			expect(asked).toContain(60_000);
			expect(fs.existsSync(CACHED)).toBe(false);
			expect(leftoverCandidates()).toEqual([]);
			expect(packDegradations().map((d) => d.reason)).toEqual([
				expect.stringMatching(/elapsed deadline/),
			]);
			expect(shimCalls()).toBe(0);
			expect(await packStamp()).toMatchObject({ checkedAt: NOW, failed: true });
		});

		it("rejects a JSON body outright, keeping the current pack", async () => {
			mode = "json";
			expect(await refreshOpengrepRulePack(NOW)).toBe("failed");
			expect(fs.existsSync(CACHED)).toBe(false);
			expect(packDegradations().map((d) => d.reason)).toEqual([
				expect.stringMatching(/registry answered JSON/),
			]);
			expect(shimCalls()).toBe(0);
		});

		it("does not hold the shared install lock while it validates, so an unrelated install is not starved", async () => {
			// Recurrence (#4780 review): the refresh held the global tools install
			// lock across a 60 s download and a 180 s validate, while an on-demand
			// `ensureTool` for any missing tool gives up after 150 s and reports the
			// tool unavailable for the session.
			setShim("hold");
			const refresh = refreshOpengrepRulePack(NOW);
			await waitFor(shimCalls, (calls) => calls === 1);

			const probe = await acquireManagedInstallGate("test: unrelated install");
			expect(probe.ok, probe.reason).toBe(true);
			await probe.release?.();

			fs.writeFileSync(SHIM_RELEASE, "");
			expect(await refresh).toBe("refreshed");
		});

		it("gives each overlapping refresh its own candidate, and only one of them swaps", async () => {
			// Recurrence (#4780 review): two refreshes of one cache (a suspended
			// process that lost its lock, or two sessions in the cadence window)
			// shared a fixed `.candidate` name, so the older could publish or delete
			// the newer one's file before it was validated.
			setShim("hold");
			const first = refreshOpengrepRulePack(NOW);
			const second = refreshOpengrepRulePack(NOW);
			await waitFor(shimCalls, (calls) => calls === 2);
			const validated = fs
				.readFileSync(SHIM_LOG, "utf-8")
				.trim()
				.split("\n")
				.map((line) => line.split(" ")[3]);
			expect(new Set(validated).size).toBe(2);
			expect(fs.existsSync(CACHED)).toBe(false);

			fs.writeFileSync(SHIM_RELEASE, "");
			expect((await Promise.all([first, second])).sort()).toEqual([
				"refreshed",
				"skipped",
			]);
			expect(fs.readFileSync(CACHED, "utf-8")).toBe(body);
			expect(leftoverCandidates()).toEqual([]);
		});

		it("keeps a newer successful stamp when a late refresh fails", async () => {
			// Recurrence (#4780 review, AGENTS.md shape 21): a refresh that STARTED
			// before the winner and failed after it replaced the winner's
			// `{checkedAt, version}` with `{failed: true}`, erasing the version and
			// demoting the tool to the one-day retry. `writeRefreshStamp` now decides
			// under the durable-store lock, against the bytes a sibling wrote.
			// Force the window: the shim parks 0.3 s after latching its mode, so the
			// loser's validate stays parked while the test flips the mode below
			// (a log-before-latch shim would read `ok` here instead, #4796).
			fs.writeFileSync(SHIM_DELAY, "0.3");
			setShim("holdfail");
			const loser = refreshOpengrepRulePack(NOW);
			await waitFor(shimCalls, (calls) => calls === 1);
			// Deterministic pin (#4796): the logged call must carry the mode the shim
			// latched, whatever the timing of the flip below. A log-before-latch shim
			// logs `latched=` with no value and reds here.
			expect(
				fs.readFileSync(SHIM_LOG, "utf-8").trim().split("\n")[0],
			).toContain("latched=holdfail");

			setShim("ok");
			body = packOf(155, "v2");
			expect(await refreshOpengrepRulePack(NOW + 60_000)).toBe("refreshed");
			expect(fs.readFileSync(CACHED, "utf-8")).toBe(body);
			expect(await packStamp()).toMatchObject({ checkedAt: NOW + 60_000 });

			fs.writeFileSync(SHIM_RELEASE, "");
			expect(await loser).toBe("failed");

			// The failure is still recorded — only its stamp write is withheld.
			expect(packDegradations()).toHaveLength(1);
			expect(packDegradations()[0]?.reason).toMatch(
				/opengrep --validate failed/,
			);
			// The winner's success survives, version included.
			const stamp = await packStamp();
			expect(stamp?.failed).toBeUndefined();
			expect(stamp?.checkedAt).toBe(NOW + 60_000);
			expect(stamp?.version).toBeDefined();
			// And its cadence: the next refresh is a week away, not a day.
			const hitsAfter = hits;
			expect(await refreshOpengrepRulePack(NOW + 60_000 + DAY_MS - 1000)).toBe(
				"skipped",
			);
			expect(hits).toBe(hitsAfter);
		});

		it("reads the rule count through colour codes", async () => {
			// Recurrence (#4780 review, AGENTS.md shape 63): a count split from
			// `rule(s)` by an escape read as zero and rejected a valid download.
			setShim("color");
			const restore = withEnv({ FORCE_COLOR: "1" });
			try {
				expect(await refreshOpengrepRulePack(NOW)).toBe("refreshed");
			} finally {
				restore();
			}
			expect(fs.readFileSync(CACHED, "utf-8")).toBe(body);
		});

		it("removes candidates a killed refresh left behind, and only the stale ones", async () => {
			fs.mkdirSync(path.dirname(CACHED), { recursive: true });
			const stale = `${CACHED}.candidate-1-dead`;
			const live = `${CACHED}.candidate-2-live`;
			fs.writeFileSync(stale, "x");
			fs.writeFileSync(live, "x");
			const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
			fs.utimesSync(stale, old, old);

			expect(await refreshOpengrepRulePack(NOW)).toBe("refreshed");

			expect(fs.existsSync(stale)).toBe(false);
			expect(fs.existsSync(live)).toBe(true);
		});

		it("leaves the pack alone when the session has Opengrep disabled", async () => {
			// Recurrence (#4780 review): `--no-opengrep` / `opengrep.enabled=false`
			// still downloaded the 2.5 MB registry pack every week.
			await runManagedToolRefresh(NOW, { rulePack: false });
			expect(hits).toBe(0);
			expect(fs.existsSync(CACHED)).toBe(false);

			await runManagedToolRefresh(NOW);
			expect(hits).toBe(1);
			expect(fs.existsSync(CACHED)).toBe(true);
		});

		describe.each([
			["the registry answers HTTP 500", () => (mode = "http500"), /HTTP 500/],
			[
				"a captive portal answers 200 with HTML",
				() => {
					mode = "garbage";
					setShim("fail");
				},
				/opengrep --validate failed/,
			],
			[
				"the pack fails the installed opengrep's own validation",
				() => setShim("fail"),
				/opengrep --validate failed/,
			],
			[
				"the pack validates as a stub below the rule floor",
				() => setShim("few"),
				/reported 3 rules \(floor 100\)/,
			],
			["the body is larger than the cap", () => (mode = "oversize"), /exceeds/],
		])("when %s", (_name, arrange, reasonPattern) => {
			it("keeps the working pack, records ONE degradation per session, and backs off a day", async () => {
				await refreshOpengrepRulePack(NOW);
				const good = fs.readFileSync(CACHED, "utf-8");
				body = packOf(170, "v2");
				arrange();

				expect(await refreshOpengrepRulePack(NOW + 8 * DAY_MS)).toBe("failed");
				expect(fs.readFileSync(CACHED, "utf-8")).toBe(good);
				expect(leftoverCandidates()).toEqual([]);
				expect(packDegradations()).toHaveLength(1);
				expect(packDegradations()[0]?.reason).toMatch(reasonPattern);
				expect(await packStamp()).toMatchObject({
					checkedAt: NOW + 8 * DAY_MS,
					failed: true,
				});

				// Inside the retry cooldown nothing is fetched.
				const hitsAfterFailure = hits;
				expect(await refreshOpengrepRulePack(NOW + 8 * DAY_MS + 1000)).toBe(
					"skipped",
				);
				expect(hits).toBe(hitsAfterFailure);

				// A second failing refresh in the SAME session adds no second record.
				expect(await refreshOpengrepRulePack(NOW + 10 * DAY_MS)).toBe("failed");
				expect(packDegradations()).toHaveLength(1);
			});
		});

		it("offline (connection refused) with no pack yet leaves `auto` in charge", async () => {
			const dead = http.createServer();
			await new Promise<void>((resolve) =>
				dead.listen(0, "127.0.0.1", () => resolve()),
			);
			const port = (dead.address() as AddressInfo).port;
			await new Promise<void>((resolve) => dead.close(() => resolve()));
			const restore = withEnv({
				PI_LENS_TEST_OPENGREP_PACK_URL: `http://127.0.0.1:${port}/c/auto`,
			});
			try {
				expect(await refreshOpengrepRulePack(NOW)).toBe("failed");
			} finally {
				restore();
			}
			expect(fs.existsSync(CACHED)).toBe(false);
			expect(shimCalls()).toBe(0);
			expect(packDegradations()).toHaveLength(1);
			const project = path.join(TEST_HOME, "proj");
			fs.mkdirSync(project, { recursive: true });
			expect(resolveOpengrepConfig(project, { enabled: true }).configArg).toBe(
				"auto",
			);
		});

		// Recurrence: writing the download over the working pack, then validating it.
		// The shim is a second process reading the cache path while it validates.
		it("swaps atomically: a reader during validation sees the whole old pack, afterwards the whole new one", async () => {
			await refreshOpengrepRulePack(NOW);
			const oldPack = fs.readFileSync(CACHED, "utf-8");
			body = packOf(180, "v2");

			expect(await refreshOpengrepRulePack(NOW + 8 * DAY_MS)).toBe("refreshed");

			// What the validating process saw at the cache path: the old pack.
			expect(fs.readFileSync(SHIM_SEEN, "utf-8")).toBe(oldPack);
			expect(fs.readFileSync(CACHED, "utf-8")).toBe(body);
			expect(leftoverCandidates()).toEqual([]);
		});

		it("skips without fetching when there is no managed opengrep to validate with", async () => {
			fs.rmSync(path.join(BIN_DIR, "opengrep"));
			expect(await refreshOpengrepRulePack(NOW)).toBe("skipped");
			expect(hits).toBe(0);
			expect(await packStamp()).toBeUndefined();
		});

		it("declines without a stamp or a record when installs are disabled (kill switch)", async () => {
			const restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
			try {
				expect(await refreshOpengrepRulePack(NOW)).toBe("declined");
			} finally {
				restore();
			}
			expect(hits).toBe(0);
			expect(await packStamp()).toBeUndefined();
			expect(packDegradations()).toHaveLength(0);
		});

		it("declines when the project is untrusted", async () => {
			setProjectTrustState("untrusted");
			expect(await refreshOpengrepRulePack(NOW)).toBe("declined");
			expect(hits).toBe(0);
		});

		it("honours PI_LENS_DISABLE_TOOL_REFRESH=1", async () => {
			const restore = withEnv({ PI_LENS_DISABLE_TOOL_REFRESH: "1" });
			try {
				expect(await refreshOpengrepRulePack(NOW)).toBe("skipped");
			} finally {
				restore();
			}
			expect(hits).toBe(0);
		});

		it("never reaches the real registry from a test: no override URL, no fetch", async () => {
			const restore = withEnv({ PI_LENS_TEST_OPENGREP_PACK_URL: undefined });
			try {
				expect(await refreshOpengrepRulePack(NOW)).toBe("skipped");
			} finally {
				restore();
			}
			expect(hits).toBe(0);
		});

		it("an unreadable stamp file refreshes nothing and says so once", async () => {
			fs.mkdirSync(getManagedToolRefreshStatePath(), { recursive: true });
			expect(await refreshOpengrepRulePack(NOW)).toBe("skipped");
			expect(hits).toBe(0);
			const reasons = getDegradationSummary()
				.find((g) => g.kind === "managed-tool-refresh")
				?.latestReasons.map((r) => r.subject);
			expect(reasons).toEqual(["refresh-state"]);
		});
	},
);

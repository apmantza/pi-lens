// flake-shape: raw-timer-wait — the guarded case asserts a NEGATIVE (a `/reload`
// cancelled the previous activation's refresh timer, so nothing is fetched,
// validated or cached), and a cancelled timer produces no event to await. A
// bounded real window is the only observer; every assertion is a count (the
// local server's hits, the shim's calls, the cached pack), never elapsed ms.
/**
 * #4780 review: a `/reload` after `opengrep.enabled=false` used to leave the
 * PREVIOUS activation's managed-tool refresh timer armed, holding that
 * activation's own `rulePack: true`. Reload stays in one process, and nothing
 * stored or cancelled the handle (`grep -n clearTimeout
 * clients/runtime-session.ts` found only an unrelated one), so the stale timer
 * fired 30 s later and downloaded the 2.5 MB registry pack and spent up to 180 s
 * validating it for a scanner nobody runs.
 *
 * Recurrence this case prevents: the one F4 repair left open — the fix landed
 * on the fresh activation's flag resolution only, so "disabled" was honoured by
 * every NEW start and by no OLD timer.
 *
 * Real seams: two real `handleSessionStart` calls in one process (the second is
 * the reload), a local HTTP server standing in for semgrep.dev (the network is
 * the boundary) and a real `/bin/sh` shim standing in for the managed
 * `opengrep` binary (a process boundary, the same double its sibling
 * `tests/clients/installer/opengrep-pack-refresh-4765.test.ts` uses). The
 * managed refresh, its cadence stamp and the pack swap all run for real.
 *
 * A green run spawns NOTHING: the guarded timer is cancelled before it fires,
 * and the reload's own timer runs with `rulePack: false`. Only a regression
 * reaches the shim, which is what makes the red below legible.
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

const TEST_HOME = vi.hoisted(() => {
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const dir = nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-4780-"),
	);
	// The installer's bin dir is a module-level const: the override must land
	// before it is imported. Undone by `vi.unstubAllEnvs()` in afterAll.
	vi.stubEnv("PI_LENS_HOME", dir);
	return dir;
});

import { getProjectSnapshotPersistStateForTests } from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { resetLSPConfigStateForTests } from "../../clients/lsp/config.js";
import { resetManagedToolRefreshSession } from "../../clients/installer/managed-tool-refresh-session.js";
import {
	handleSessionStart,
	resetSessionScopedState,
} from "../../clients/runtime-session.js";
import { withResidentBootstrap } from "../support/bootstrap-access.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { withEnv } from "../support/with-env.js";
import { waitFor } from "./interleaving-kit.js";
import {
	drainBackgroundWritesForTests,
	pinFixtureHome,
	setupTestEnvironment,
} from "./test-utils.js";

const BIN_DIR = path.join(TEST_HOME, "bin");
const CACHED = path.join(TEST_HOME, "rules", "opengrep-registry.yaml");
const SHIM_LOG = path.join(TEST_HOME, "shim.log");

function packYaml(): string {
	const rules = Array.from(
		{ length: 150 },
		(_, i) =>
			`  - id: test.filler.rule-${i}\n    languages: [python]\n    severity: INFO\n    message: filler\n    pattern: filler_${i}($X)\n`,
	).join("");
	return `rules:\n${rules}`;
}

let server: http.Server;
let baseUrl: string;
let hits: number;
let restoreEnv: (() => void) | undefined;
let restoreMode: (() => void) | undefined;
let restoreHome: (() => void) | undefined;
let env: ReturnType<typeof setupTestEnvironment> | undefined;

beforeAll(async () => {
	server = http.createServer((_req, res) => {
		hits += 1;
		res.writeHead(200, { "content-type": "text/yaml" }).end(packYaml());
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/c/auto`;
	await installLspServiceDouble();
});

afterAll(async () => {
	// #4958: the session-start snapshot persist is fire-and-forget and writes
	// under TEST_HOME. Wait for it on the event with a real-clock deadline that
	// throws (the drain below stops at a silent 2 s cap), while the env is
	// still pinned, or a late write recreates TEST_HOME after the rmSync below.
	// env?.cleanup() does not cover it.
	if (env) {
		await waitFor(
			() =>
				getProjectSnapshotPersistStateForTests(
					path.join(env!.tmpDir, "project"),
				),
			(state) => !state.active && !state.queued,
		);
	}
	await drainBackgroundWritesForTests();
	vi.unstubAllEnvs();
	// projectCwd() creates this root lazily and no teardown removed it, so the
	// file-level tmp-fixture sweep reported it (registered=1, #4958 siblings).
	env?.cleanup();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

/** A managed `opengrep` that answers `--validate` like the real one. */
function installShim(): void {
	fs.rmSync(BIN_DIR, { recursive: true, force: true });
	fs.mkdirSync(BIN_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(BIN_DIR, "opengrep"),
		[
			"#!/bin/sh",
			`echo "$@" >> "${SHIM_LOG}"`,
			`n=$(grep -o -E '^ *- id:' "$4" | wc -l)`,
			`echo "Configuration is valid - found 0 configuration error(s), and $n rule(s)."`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
}

function shimCalls(): number {
	return fs.existsSync(SHIM_LOG)
		? fs.readFileSync(SHIM_LOG, "utf-8").trim().split("\n").filter(Boolean)
				.length
		: 0;
}

/** One activation's `dbg` sink, so the stale timer's line is attributable. */
function dbgSink(): { dbg: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { dbg: (line: string) => lines.push(line), lines };
}

function makeDeps(
	ctxCwd: string,
	dbg: (line: string) => void,
	opengrepDisabled: boolean,
) {
	return withResidentBootstrap({
		ctxCwd,
		getFlag: (name: string) => name === "no-opengrep" && opengrepDisabled,
		notify: () => {},
		dbg,
		log: () => {},
		runtime: new RuntimeCoordinator(),
		cacheManager: { writeCache: () => {}, readCache: () => null },
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		astGrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			scanExports: async () => new Map(),
		},
		biomeClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		knipClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		jscpdClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		testRunnerClient: {
			detectRunner: () => null,
			runTestFile: () => ({ failed: 0, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: async () => null,
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
	}) as never;
}

function projectCwd(): string {
	env ??= setupTestEnvironment("pi-lens-4780-reload-refresh-");
	const cwd = path.join(env.tmpDir, "project");
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "index.ts"), "export const x = 1;\n");
	return cwd;
}

/**
 * Give any armed timer time to fire and finish: the pack step is a GET plus a
 * sub-second shim validate, measured at tens of milliseconds here. The
 * assertion is a NEGATIVE (nothing fetched), so the window has to be long
 * enough for a regression's whole run, not merely its first instruction.
 */
async function settleWindow(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
}

describe("a reload cancels the previous activation's refresh timer (#4780)", () => {
	let previousWarmup: boolean | undefined;
	const globals = globalThis as unknown as {
		__piLensWarmupScheduled?: boolean;
		__piLensFirstSessionDone?: boolean;
	};

	beforeEach(() => {
		restoreHome = pinFixtureHome("pi-lens-4780-reload").restore;
		restoreMode = withEnv({ PI_LENS_STARTUP_MODE: "full" });
		restoreEnv = withEnv({
			PI_LENS_DISABLE_TOOL_INSTALL: "0",
			PI_LENS_DISABLE_TOOL_REFRESH: undefined,
			// Long enough that no other case's timer can be confused for ours,
			// short enough that the stale one would fire inside the settle window.
			PI_LENS_TOOL_REFRESH_DELAY_MS: "1",
			// The binary refresh spends no slot, so only the pack step can work.
			PI_LENS_TOOL_REFRESH_MAX_PER_SESSION: "0",
			PI_LENS_INSTALL_LOCK_TIMEOUT_MS: "2000",
			PI_LENS_TEST_OPENGREP_PACK_URL: baseUrl,
		});
		resetManagedToolRefreshSession();
		resetLSPConfigStateForTests();
		fs.rmSync(path.join(TEST_HOME, "rules"), { recursive: true, force: true });
		fs.rmSync(path.join(TEST_HOME, "tools"), { recursive: true, force: true });
		fs.rmSync(SHIM_LOG, { force: true });
		installShim();
		hits = 0;
		// The session-start warmup is a separate once-per-process latch; this case
		// measures the refresh timer only.
		previousWarmup = globals.__piLensWarmupScheduled;
		globals.__piLensWarmupScheduled = true;
	});

	afterEach(() => {
		// A case that leaves a timer armed for the next case is the defect itself.
		resetSessionScopedState(projectCwd());
		globals.__piLensWarmupScheduled = previousWarmup;
		restoreEnv?.();
		restoreEnv = undefined;
		restoreMode?.();
		restoreMode = undefined;
		restoreHome?.();
		restoreHome = undefined;
		resetLSPConfigStateForTests();
	});

	it("a reload with Opengrep disabled neither downloads nor validates the registry pack", async () => {
		const cwd = projectCwd();
		const enabled = dbgSink();
		await handleSessionStart(makeDeps(cwd, enabled.dbg, false));

		// The reload: same process, the scanner now off.
		const disabled = dbgSink();
		await handleSessionStart(makeDeps(cwd, disabled.dbg, true));

		await settleWindow();

		// The stale activation's timer never ran at all.
		expect(
			enabled.lines.filter((line) =>
				line.startsWith("session_start tool-refresh"),
			),
		).toEqual([]);
		// ... so no pack was fetched, validated or cached for a disabled scanner.
		expect(hits).toBe(0);
		expect(shimCalls()).toBe(0);
		expect(fs.existsSync(CACHED)).toBe(false);
		// The reload's OWN timer still runs: the fix cancels the previous
		// activation's handle, not the current one's.
		expect(
			disabled.lines.filter((line) =>
				line.startsWith("session_start tool-refresh"),
			).length,
		).toBeGreaterThan(0);
	}, 60_000);

	it("a reload with Opengrep enabled still refreshes the pack once", async () => {
		// The other direction of the same guard: cancelling must not disarm the
		// timer the CURRENT activation armed from its own flag.
		const cwd = projectCwd();
		const first = dbgSink();
		await handleSessionStart(makeDeps(cwd, first.dbg, false));
		const reload = dbgSink();
		await handleSessionStart(makeDeps(cwd, reload.dbg, false));

		await settleWindow();

		expect(hits).toBe(1);
		expect(fs.readFileSync(CACHED, "utf-8")).toBe(packYaml());
		expect(shimCalls()).toBe(1);
	}, 60_000);
});

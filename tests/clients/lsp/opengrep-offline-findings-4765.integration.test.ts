// real-home: read-only path probe for the maintainer's managed opengrep (`~/.pi-lens/bin/opengrep`); the pinned home has no managed tools tree, so without the real home the file skips on the one host that has opengrep.
/**
 * #4765 acceptance, over a real Opengrep: after a successful refresh the spawn
 * produces findings with the network cut, and with no pack at all an offline
 * spawn is reported as unconfirmed, never as a clean scan.
 *
 * Recurrence this prevents: `opengrep lsp` started with `--config auto` needs
 * the network for its rules. Offline it published `[]` for every file, forever,
 * and nothing said so (#4764, #4765). The unit cases of this change prove WHICH
 * file the spawn is handed; only a real binary can prove the file loads, so a
 * pack the installed Opengrep rejects, or a registry format change, passes every
 * config assertion and fails case one here. Case two is the no-pack path: the
 * spawn falls back to `auto` (pi-lens ships no rules), the network is cut, and
 * the server's config-load failure must reach the degradation ledger.
 *
 * Production chain: the cached pack (what `refreshOpengrepRulePack` leaves), then
 * the real `OpengrepServer.spawn`, stdio wire and LSP client. A third case runs
 * the real refresh itself (download from a local HTTP server standing in for
 * semgrep.dev, real `opengrep scan --validate`, the real atomic swap); the
 * validate fetches `p/semgrep-rule-lints` from semgrep.dev (measured on
 * 1.30.0), so that case is skipped, with a named reason, where it is unreachable.
 * Only the launcher is wrapped: `opengrep` (managed bin dir and PATH) is
 * a script that runs the real binary under `unshare -rn` (no network at all)
 * when the host allows it, and otherwise with a dead proxy. It records which.
 *
 * Skipped, with a named reason, when no `opengrep` binary exists: the unit lanes
 * install no managed tools. Set `PI_LENS_TEST_OPENGREP_BIN` to point at one;
 * otherwise `opengrep` on PATH, then the real home's `~/.pi-lens/bin/opengrep`
 * (through `REAL_HOME`), is used.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.unmock("../../../clients/installer/index.js");

// The installer's bin dir is a module-level const: PI_LENS_HOME must land before
// anything imports it. Undone by `vi.unstubAllEnvs()` in afterAll.
const HOME = vi.hoisted(() => {
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	// Only the path: the directory is created by the first case that runs, so a
	// file whose cases are all skipped (no opengrep binary) leaks nothing.
	const dir = nodePath.join(
		nodeOs.tmpdir(),
		`pi-lens-4765-live-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
	);
	vi.stubEnv("PI_LENS_HOME", dir);
	return dir;
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { refreshOpengrepRulePack } from "../../../clients/installer/managed-tool-refresh.js";
import { resetManagedToolRefreshSession } from "../../../clients/installer/managed-tool-refresh-session.js";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { OpengrepServer } from "../../../clients/lsp/server.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { REAL_HOME } from "../../support/vitest-setup.js";
import { withEnv } from "../../support/with-env.js";
import { waitFor } from "../interleaving-kit.js";
import { pinFixtureHome, removeTempDirSync } from "../test-utils.js";

const EXE = process.platform === "win32" ? "opengrep.exe" : "opengrep";

/**
 * Resolved once at module load. The harness pins HOME per worker (#4789), so the
 * managed candidate reads the real home through `REAL_HOME`, a named read-only
 * opt-out in `tests/support/real-home-readers.ts`; this file's own PI_LENS_HOME
 * stub moves the install dir, never the maintainer's bin dir.
 */
function findOpengrepBinary(): string | undefined {
	const candidates: string[] = [];
	if (process.env.PI_LENS_TEST_OPENGREP_BIN)
		candidates.push(process.env.PI_LENS_TEST_OPENGREP_BIN);
	for (const dir of (process.env.PATH ?? "").split(path.delimiter))
		if (dir) candidates.push(path.join(dir, EXE));
	candidates.push(path.join(REAL_HOME, ".pi-lens", "bin", EXE));
	return candidates.find((file) => {
		try {
			fs.accessSync(file, fs.constants.X_OK);
			return fs.statSync(file).isFile();
		} catch {
			return false;
		}
	});
}

const REAL_OPENGREP = findOpengrepBinary();
const SKIP_REASON =
	process.platform === "win32"
		? "POSIX-only: the offline wrapper is a shell script"
		: REAL_OPENGREP
			? undefined
			: "no opengrep binary: set PI_LENS_TEST_OPENGREP_BIN, or put opengrep on PATH or at ~/.pi-lens/bin";

const PLANTED = [
	"import subprocess",
	"",
	"def run(cmd):",
	"    subprocess.call(cmd, shell=True)",
	"",
].join("\n");

/** The real `--validate` needs semgrep.dev for its rule-lint metarules. */
async function semgrepDevReachable(): Promise<boolean> {
	if (SKIP_REASON !== undefined) return false;
	try {
		await fetch("https://semgrep.dev/", {
			method: "HEAD",
			signal: AbortSignal.timeout(4_000),
		});
		return true;
	} catch {
		return false;
	}
}
const ONLINE = await semgrepDevReachable();

const CACHED = path.join(HOME, "rules", "opengrep-registry.yaml");
const BIN_DIR = path.join(HOME, "bin");

/** A registry-shaped pack: the planted rule plus fillers to clear the refresh's rule floor. */
function packYaml(): string {
	const rules = [
		"  - id: python.lang.security.audit.subprocess-shell-true.subprocess-shell-true",
		"    languages: [python]",
		"    severity: WARNING",
		"    message: subprocess call with shell=True",
		"    pattern: subprocess.call(..., shell=True)",
	];
	for (let n = 0; n < 150; n++)
		rules.push(
			`  - id: test.filler.rule-${n}`,
			"    languages: [python]",
			"    severity: INFO",
			"    message: filler",
			`    pattern: filler_${n}($X)`,
		);
	return `rules:\n${rules.join("\n")}\n`;
}

/**
 * Resolve the binary once, then pin HOME for every case: the real `opengrep`
 * child writes its own settings and caches under `$HOME/.config/.opengrep` and
 * `$HOME/.config/.semgrep`, so a case that pins only `PI_LENS_HOME` still writes
 * into the developer's home (AGENTS.md "Paths, data, and operating systems";
 * #4780 review). A probe over the strace of this file records zero writes to the
 * real `~/.config/.opengrep` and `~/.config/.semgrep`.
 */
let restorePinnedHome: (() => void) | undefined;
let restoreXdg: (() => void) | undefined;

let work: string;
let restoreEnv: (() => void) | undefined;
let server: http.Server | undefined;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	fs.mkdirSync(HOME, { recursive: true });
	const pinned = pinFixtureHome("opengrep-live-4765");
	restorePinnedHome = pinned.restore;
	// The XDG variables override HOME for everything that honours them, so they
	// are pinned to the same fixture home rather than left to the developer's.
	// Both directories must EXIST: opengrep raises `Sys_error(... .config: No
	// such file or directory)` instead of creating a missing XDG root.
	const xdgConfig = path.join(pinned.home, ".config");
	const xdgCache = path.join(pinned.home, ".cache");
	fs.mkdirSync(xdgConfig, { recursive: true });
	fs.mkdirSync(xdgCache, { recursive: true });
	restoreXdg = withEnv({
		XDG_CONFIG_HOME: xdgConfig,
		XDG_CACHE_HOME: xdgCache,
	});
	work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opengrep-live-4765-"));
	fs.rmSync(path.join(HOME, "rules"), { recursive: true, force: true });
	fs.rmSync(path.join(HOME, "tools"), { recursive: true, force: true });
	resetDegradationLedger();
	resetManagedToolRefreshSession();
	resetProjectTrust();
	setProjectTrustState("trusted");
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	await new Promise<void>((resolve) =>
		server ? server.close(() => resolve()) : resolve(),
	);
	server = undefined;
	restoreEnv?.();
	restoreEnv = undefined;
	// Restore in the reverse order of the pins: the XDG pair first, then HOME.
	restoreXdg?.();
	restoreXdg = undefined;
	restorePinnedHome?.();
	restorePinnedHome = undefined;
	resetProjectTrust();
	removeTempDirSync(work);
});

afterAll(() => {
	vi.unstubAllEnvs();
	removeTempDirSync(HOME);
});

/** `opengrep` on PATH and in the managed bin dir: the real binary, network cut. */
function installOfflineWrapper(): string {
	const wrapperDir = path.join(work, "wrapper-bin");
	fs.mkdirSync(wrapperDir, { recursive: true });
	// Remove the directory first: an earlier case leaves `opengrep` there as a
	// SYMLINK to the real binary, and writing through it would overwrite the
	// real managed binary with this wrapper (it did, once, on 2026-10-23).
	fs.rmSync(BIN_DIR, { recursive: true, force: true });
	fs.mkdirSync(BIN_DIR, { recursive: true });
	const isolation = path.join(work, "isolation");
	const script = [
		"#!/bin/sh",
		`if unshare -rn true 2>/dev/null; then echo isolated > "${isolation}"; exec unshare -rn "${REAL_OPENGREP}" "$@"; fi`,
		`echo proxy > "${isolation}"`,
		`HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 exec "${REAL_OPENGREP}" "$@"`,
		"",
	].join("\n");
	for (const dir of [wrapperDir, BIN_DIR]) {
		fs.writeFileSync(path.join(dir, "opengrep"), script, { mode: 0o755 });
	}
	restoreEnv = withEnv({
		PATH: `${wrapperDir}${path.delimiter}${process.env.PATH ?? ""}`,
		PI_LENS_DISABLE_TOOL_INSTALL: "0",
		PI_LENS_DISABLE_TOOL_REFRESH: undefined,
		// The wrapper makes `opengrep` a present managed tool; no binary refresh
		// (GitHub) runs, only the pack step.
		PI_LENS_TOOL_REFRESH_MAX_PER_SESSION: "0",
	});
	return isolation;
}

async function spawnClient(project: string, file: string) {
	const launched = await OpengrepServer.spawn(project, { allowInstall: false });
	if (!launched) throw new Error("OpengrepServer.spawn declined");
	const client = await createLSPClient({
		serverId: "opengrep",
		process: launched.process,
		root: project,
		initialization: launched.initialization,
		// The production client registry passes the registry entry's declared
		// `role` (`client-registry.ts`: `role: server.role`). This case builds the
		// client directly, so it must pass the same declaration: without it the
		// client is created with no role, #4786's auxiliary hold never arms, and
		// opengrep's late empty publication erases the finding this case asserts
		// (#4790 fixed that hold; the case had never exercised it).
		role: OpengrepServer.role,
		initializeTimeoutMs: 30_000,
	});
	cleanups.push(async () => {
		await client.shutdown().catch(() => undefined);
		await stopLSP(launched.process).catch(() => undefined);
	});
	await client.notify.open(file, PLANTED, "python");
	const configuration = (
		launched.initialization as { scan: { configuration: string[] } }
	).scan.configuration;
	return { client, configuration };
}

function projectWithPlantedFile(): { project: string; file: string } {
	const project = path.join(work, "project");
	fs.mkdirSync(project, { recursive: true });
	const file = path.join(project, "app.py");
	fs.writeFileSync(file, PLANTED);
	return { project, file };
}

describe.skipIf(SKIP_REASON !== undefined)(
	`an offline Opengrep spawn (#4765)${
		SKIP_REASON ? ` [skipped: ${SKIP_REASON}]` : ""
	}`,
	() => {
		it("with a refreshed pack in the cache, reports the planted finding with the network cut", async () => {
			const isolation = installOfflineWrapper();
			// What a successful refresh leaves: the whole pack at the cache path.
			fs.mkdirSync(path.dirname(CACHED), { recursive: true });
			fs.writeFileSync(CACHED, packYaml());

			const { project, file } = projectWithPlantedFile();
			const { client, configuration } = await spawnClient(project, file);
			await client.waitForDiagnostics(file, 30_000);

			const rules = client
				.getDiagnostics(file)
				.map((d) => String(d.code ?? d.message));
			expect(rules.join(" ")).toMatch(/subprocess-shell-true/);
			// The spawn is handed the local file, never `auto`.
			expect(configuration).toEqual([CACHED]);
			expect(fs.readFileSync(isolation, "utf-8").trim()).toMatch(
				/^(isolated|proxy)$/,
			);
		}, 120_000);

		it.skipIf(!ONLINE)(
			`the real refresh validates and swaps in a pack the real binary accepts${
				ONLINE
					? ""
					: " [skipped: semgrep.dev unreachable, --validate fetches its rule lints]"
			}`,
			async () => {
				fs.rmSync(BIN_DIR, { recursive: true, force: true });
				fs.mkdirSync(BIN_DIR, { recursive: true });
				fs.symlinkSync(REAL_OPENGREP as string, path.join(BIN_DIR, "opengrep"));
				restoreEnv = withEnv({
					PI_LENS_DISABLE_TOOL_INSTALL: "0",
					PI_LENS_DISABLE_TOOL_REFRESH: undefined,
					PI_LENS_TOOL_REFRESH_MAX_PER_SESSION: "0",
				});
				const body = packYaml();
				server = http.createServer((_req, res) => {
					res.writeHead(200, { "content-type": "text/yaml" });
					res.end(body);
				});
				await new Promise<void>((resolve) =>
					server?.listen(0, "127.0.0.1", () => resolve()),
				);
				const port = (server.address() as AddressInfo).port;
				const restoreUrl = withEnv({
					PI_LENS_TEST_OPENGREP_PACK_URL: `http://127.0.0.1:${port}/c/auto`,
				});
				cleanups.push(async () => restoreUrl());

				const outcome = await refreshOpengrepRulePack(Date.now());
				expect(
					outcome,
					JSON.stringify(
						getDegradationSummary().find(
							(g) => g.kind === "managed-tool-refresh",
						)?.latestReasons,
					),
				).toBe("refreshed");
				expect(fs.readFileSync(CACHED, "utf-8")).toBe(body);
			},
			120_000,
		);

		it("with no pack at all, an offline spawn is recorded as a failed config load, not a clean scan", async () => {
			// Recurrence: #4764. Before the gate, the empty publish of an offline
			// `auto` spawn read as a confirmed-clean scan of a file never evaluated.
			installOfflineWrapper();
			const { project, file } = projectWithPlantedFile();
			const { client, configuration } = await spawnClient(project, file);

			// No pack, no repo file: the fallback is `auto`, and the network is cut.
			expect(configuration).toEqual(["auto"]);
			const recorded = await waitFor(
				() =>
					getDegradationSummary().find(
						(g) => g.kind === "lsp-server-config-load-failed",
					),
				(group) => group !== undefined,
				{ timeoutMs: 60_000, intervalMs: 250 },
			);
			expect(recorded?.kind).toBe("lsp-server-config-load-failed");
			expect(client.getDiagnostics(file)).toEqual([]);
		}, 120_000);
	},
);

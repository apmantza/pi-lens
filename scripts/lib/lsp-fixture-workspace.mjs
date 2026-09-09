import * as fs from "node:fs";
import * as path from "node:path";
import { gitExecFileSync } from "./git-fixture-env.mjs";
import { assertFixtureWorkspaceRegistered } from "./lsp-fixture-session-guard.mjs";
import { safeRm } from "./safe-rm.mjs";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
	sweepScratchDirs,
} from "./scratch-dir.mjs";
/**
 * #2670 (folds #2658). The one "copy fixture → register session root →
 * optional `.pi-lens/lsp.json` disable + reload → optional `git init` →
 * assert registered" bootstrap every LSP dev-harness script needs, shared
 * instead of hand-copied. Before this module, `characterize-lsp.mjs` and
 * `server-capabilities.mjs` carried a byte-identical 23-line block,
 * `probe-clean-signal.mjs` the same shape with two flags read from different
 * local names, `smoke-tools.mjs` its own (order-shifted, `fx.setup`/
 * `fx.lombokJar` interleaved) variant, and `bench-lsp.mjs` (#2658) skipped
 * the unconditional register entirely — the exact #2369/#2655 ordering bug,
 * a fifth time.
 *
 * `initLSPConfig` is caller-supplied rather than imported here: each script
 * loads it from a slightly different `dist/` entry point (some via a
 * top-level `await import()`, smoke-tools.mjs from inside a function), and
 * this module has no opinion on that — see lsp-fixture-session-guard.mjs's
 * own doc comment for the identical reasoning about not importing
 * `initLSPConfig` itself.
 *
 * `disableServers`:
 *   - omitted → falls back to `fx.disableServers` (a fixture's own static
 *     list), matching every caller except bench-lsp.
 *   - an array → an explicit override.
 *   - a function `({ workspace, absFile, fx }) => string[]` → computed AFTER
 *     the workspace exists and is registered but BEFORE anything is
 *     disabled — bench-lsp's shape: it disables whatever
 *     `getServersForFileWithConfig(absFile)` returns that isn't this
 *     fixture's measurement target, which needs a real file path inside a
 *     real (already-copied) workspace to compute.
 *
 * `workspace`, when given, is used as-is instead of a fresh `mkdtempSync` —
 * probe-clean-signal.mjs pre-creates its temp dir outside this call so its
 * own `withTimeout` wrapper and `finally` cleanup can own it start to finish
 * even if bootstrapping itself times out.
 *
 * Returns `{ workspace, absFile, cleanup, disabledServers }` — `cleanup()`
 * removes the workspace (Windows-safe retry, matching smoke-tools.mjs's
 * existing `safeRm`); a caller that pre-supplied `workspace` and owns its
 * own cleanup is free to ignore it.
 */
export async function bootstrapFixtureWorkspace(fx, opts) {
	const {
		initLSPConfig,
		repoRoot,
		tmpPrefix = "lsp-fixture-",
		workspace: preMadeWorkspace,
		gitInit = fx.gitInit,
		disableServers,
	} = opts;

	let workspace = preMadeWorkspace;
	if (!workspace) {
		sweepScratchDirs(SCRATCH_DIR_ROOT, tmpPrefix);
		workspace = claimScratchDir(SCRATCH_DIR_ROOT, tmpPrefix);
	}
	fs.cpSync(path.join(repoRoot, fx.dir), workspace, { recursive: true });
	if (fx.customServer) {
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify(
				{
					servers: { [fx.customServer.id]: fx.customServer },
					disabledServers: fx.disableServers ?? [],
				},
				null,
				2,
			),
		);
	}

	// #2369/#2655/#2658: every fixture registers its OWN workspace
	// unconditionally — never only inside the `disableServers` branch below.
	// `clients/lsp/session-roots.ts` fails OPEN (declines nothing) only while
	// its registry is empty; the moment ANY fixture registers its own
	// workspace, every OTHER still-unregistered workspace is silently
	// declined. See lsp-fixture-session-guard.mjs for the full writeup.
	await initLSPConfig(workspace);
	const absFile = path.join(workspace, fx.file);

	if (gitInit) {
		try {
			gitExecFileSync(["init", "-q"], { cwd: workspace, stdio: "ignore" });
		} catch {
			// git unavailable — caller-specific fallback behavior is unaffected
		}
	}

	const resolvedDisable =
		typeof disableServers === "function"
			? disableServers({ workspace, absFile, fx })
			: (disableServers ?? fx.disableServers);

	if (resolvedDisable && resolvedDisable.length) {
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		const configPath = path.join(workspace, ".pi-lens", "lsp.json");
		let config = {};
		try {
			config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		} catch {
			// No prior fixture config; the disable list below is still valid.
		}
		fs.writeFileSync(
			configPath,
			JSON.stringify({ ...config, disabledServers: resolvedDisable }, null, 2),
		);
		// The disabled-server list must land in the CACHED config, so reload
		// after writing it — the early call above exists only for session-root
		// registration, which `initLSPConfig` performs before touching disk.
		await initLSPConfig(workspace);
	}

	// Harness guard (#2369/#2655/#2658): every fixture must register its own
	// workspace as a session root before it is touched.
	await assertFixtureWorkspaceRegistered(fx.lang, workspace);

	const cleanup = () => safeRm(workspace);

	return {
		workspace,
		absFile,
		cleanup,
		disabledServers: resolvedDisable ?? [],
	};
}

/**
 * #2670/#2506-shape. The four sibling scripts' now-unconditional
 * `initLSPConfig` (and smoke-tools.mjs's own) each emit a
 * `config_resolution_pending` + `config_resolved` pair per fixture — 49 on a
 * full `--lsp` run, up from 3 pre-#2369 — into whatever `~/.pi-lens/
 * latency.log`/`sessionstart.log` `getGlobalPiLensLogDir()`/
 * `getGlobalPiLensDir()` resolve to. Both resolve from `PI_LENS_HOME`
 * FIRST, before any other fallback (`clients/file-utils.ts`,
 * `clients/probe-home-state.ts`) — so pinning that one env var (plus its
 * project-scoped sibling `PILENS_DATA_DIR`) is sufficient, and must happen
 * before the first `dist/` import: `dist/clients/latency-logger.js` reads
 * its log directory into a top-level `const` at module load, not lazily
 * per write.
 *
 * Pins only when the caller hasn't already chosen a home (an explicit
 * `PI_LENS_HOME` — set by an operator, a wrapper script, or a test spawning
 * one of these harness scripts as a child — always wins, matching
 * `getGlobalPiLensLogDir()`'s own "PI_LENS_HOME wins over any redirect"
 * contract instead of silently clobbering it). Pass `{ realHome: true }`
 * (with a comment explaining why) to skip pinning even when unset — no
 * caller in this repo does today.
 *
 * Deliberately a FRESH directory per call (an actual "per-run" scratch
 * home, matching what the caller asked for), not a stable one reused across
 * invocations: a stable global path would let concurrent scripts/agents on
 * the same machine race on one `instances.json`/tool tree. The cost is that
 * `--install` runs of these scripts no longer share a tool cache ACROSS
 * separate script invocations (each of the five nightly steps installs its
 * own copy) — acceptable for a nightly, manual-dispatch harness whose
 * runner is itself thrown away every night; see the PR body for the
 * tradeoff this was weighed against.
 */
export function withScratchHome(opts = {}) {
	const { realHome = false, tmpPrefix = "lsp-fixture-home-" } = opts;
	if (realHome) {
		return { dir: undefined, pinned: false, restore: () => {} };
	}
	if (process.env.PI_LENS_HOME?.trim()) {
		// Already pinned by the caller (or a parent process) — respect it.
		return { dir: process.env.PI_LENS_HOME, pinned: false, restore: () => {} };
	}
	// Startup sweep BEFORE minting this run's own dir, so it never sweeps
	// itself (#2670 review F2).
	sweepScratchDirs(SCRATCH_DIR_ROOT, tmpPrefix);
	const dir = claimScratchDir(SCRATCH_DIR_ROOT, tmpPrefix);
	process.env.PI_LENS_HOME = dir;
	const dataDirWasUnset = !process.env.PILENS_DATA_DIR?.trim();
	if (dataDirWasUnset) process.env.PILENS_DATA_DIR = dir;
	// #2670 review F3: the redirect otherwise announces itself nowhere — the
	// pin runs BEFORE `getGlobalPiLensLogDir()`'s own `global-dir-probe-redirect`
	// degradation row could ever fire (that row only exists for the DIFFERENT,
	// unpinned probe-redirect path; `PI_LENS_HOME` wins ahead of it and leaves
	// no trace of its own). One line naming the dir is the only way a human
	// reading this run's output can find where its telemetry/tool installs went.
	console.error(
		`[lsp-fixture-workspace] PI_LENS_HOME pinned to ${dir} (#2506 shape) — this run's tool installs and config_resolved/sessionstart telemetry land there, not the real ~/.pi-lens.`,
	);
	let announcedEnd = false;
	const announceEnd = () => {
		if (announcedEnd) return;
		announcedEnd = true;
		console.error(`[lsp-fixture-workspace] scratch home complete: ${dir}`);
	};
	process.once("exit", announceEnd);
	return {
		dir,
		pinned: true,
		restore() {
			delete process.env.PI_LENS_HOME;
			if (dataDirWasUnset) delete process.env.PILENS_DATA_DIR;
			process.off("exit", announceEnd);
			announceEnd();
		},
	};
}

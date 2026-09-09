/**
 * #2518: an operator's LSP denial must not be lifted by traffic to OTHER cwds.
 *
 * The production shape this reproduces is `ensureReady` (`mcp/server.ts:196`):
 * it calls `initLSPConfig` for the cwd of every `pilens_*` tool call, then
 * short-circuits on `shouldInitializeSessionRoot`. Before the fix the config
 * payload lived in a 32-entry cache while the session-root registry held 128,
 * so ~33 foreign cwds evicted a LIVE root's config while the registry still
 * reported it ready — nothing re-initialized it, and `isServerDisabled` (the
 * predicate the runtime gate reads) answered `false` for a server the operator
 * had turned off.
 *
 * Every call below is the production function: the real `initLSPConfig`, the
 * real `shouldInitializeSessionRoot` against a memo shaped exactly like
 * `mcp/server.ts`'s `lspReadyCwds`, and the real denial predicate. No mocks —
 * a double here would only prove the double's own cap.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	initLSPConfig,
	isServerDisabled,
	loadLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import {
	isSessionRootRegistered,
	shouldInitializeSessionRoot,
} from "../../../clients/lsp/session-roots.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { normalizeFilePath } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

const DENIED_SERVER = "typos";
const dirs: string[] = [];
let previousHome: string | undefined;
let previousTestMode: string | undefined;

/**
 * Every `config_resolved` row this process wrote NAMING `root` — the positive
 * record that a resolution HAPPENED, which `recordConfigResolved`
 * (`clients/lsp/config.ts`) claims once per (session, root). Read from the
 * real latency log.
 *
 * Trailing separators are trimmed off BOTH sides before comparing, so a row
 * written under a non-canonical spelling of the same root still counts. That
 * is the whole point (review F6): an exact-match filter would silently hide a
 * duplicate row written under `"/proj/"` while the canonical `"/proj"` row was
 * counted, and the count is what these cases assert.
 */
async function configResolvedRowsFor(root: string): Promise<unknown[]> {
	await flushLatencyLog();
	const file = getLatencyLogPath();
	const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const trimTrailing = (value: string) => value.replace(/[\\/]+$/, "");
	const wanted = trimTrailing(normalizeFilePath(root));
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter(
			(entry) =>
				entry.phase === "config_resolved" &&
				trimTrailing(String(entry.filePath ?? "")) === wanted,
		);
}

/** A project root whose `.pi-lens.json` denies {@link DENIED_SERVER}. */
function denyingRoot(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2518-deny-")),
	);
	dirs.push(dir);
	fs.writeFileSync(
		path.join(dir, ".pi-lens.json"),
		JSON.stringify({ lsp: { disabledServers: [DENIED_SERVER] } }),
	);
	fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n");
	return dir;
}

/** A foreign cwd — the kind another `pilens_analyze` call names. */
function foreignRoot(index: number): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-2518-other-${index}-`)),
	);
	dirs.push(dir);
	return dir;
}

beforeEach(async () => {
	previousHome = process.env.PI_LENS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2518-home-"));
	dirs.push(home);
	process.env.PI_LENS_HOME = home;
	// The latency sink is off under test mode, and the `config_resolved` row is
	// half of what this file asserts (review F1).
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	resetLSPConfigStateForTests();
	resetDegradationLedger();
	clearLatencyLog();
	await flushLatencyLog();
});

afterEach(async () => {
	await flushLatencyLog();
	resetLSPConfigStateForTests();
	resetDegradationLedger();
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("#2518 a live session root's denial survives foreign cwd traffic", () => {
	it("keeps the operator's denial after 40 other cwds pass through ensureReady", async () => {
		const root = denyingRoot();
		const file = path.join(root, "notes.md");
		// `mcp/server.ts`'s `lspReadyCwds`: the readiness memo `ensureReady`
		// consults before it re-initializes anything.
		const readyCwds = new Set<string>();

		await initLSPConfig(root);
		readyCwds.add(root);
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);

		// The reviewer's probe from the issue: ~40 `ensureReady` calls naming
		// OTHER directories, each one a legitimate `pilens_analyze` /
		// `pilens_diagnostics` invocation.
		for (let index = 0; index < 40; index++) {
			const other = foreignRoot(index);
			await initLSPConfig(other);
			readyCwds.add(other);
		}

		// The root is still served, so `ensureReady` returns early and NOTHING
		// re-initializes it — which is why the config below must still be there.
		expect(isSessionRootRegistered(root)).toBe(true);
		expect(shouldInitializeSessionRoot(root, readyCwds)).toBe(false);
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);
	}, 60_000);

	it("serves a config for exactly the roots the registry still serves", async () => {
		// The structural coupling, stated over the whole population: a root is
		// registered if and only if its denial still applies. Past the cap the
		// oldest roots ARE dropped — that is the designed bound — but they are
		// dropped from BOTH answers at once, so `shouldInitializeSessionRoot`
		// sends the next caller back through `initLSPConfig` for exactly the
		// roots whose denial is no longer loaded.
		const roots = Array.from({ length: 130 }, () => denyingRoot());
		for (const root of roots) await initLSPConfig(root);

		const decoupled = roots.filter(
			(root) =>
				isSessionRootRegistered(root) !==
				isServerDisabled(DENIED_SERVER, path.join(root, "notes.md")),
		);
		expect(decoupled).toEqual([]);
	}, 120_000);

	it("keeps a served root's denial applied while it re-initializes", async () => {
		const root = denyingRoot();
		const file = path.join(root, "notes.md");
		await initLSPConfig(root);

		// A second session declaring the same root. `initLSPConfig` re-registers
		// it synchronously, before its loader await — so a registration that
		// overwrote the stored config with the "not loaded yet" placeholder would
		// blank this live root's denial for the length of the load.
		const reinit = initLSPConfig(root);
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);
		await reinit;
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);
	}, 60_000);

	it("applies an ancestor root's denial while a nested root is still loading", async () => {
		const parent = denyingRoot();
		const child = path.join(parent, "sub");
		fs.mkdirSync(child);
		fs.writeFileSync(path.join(child, "notes.md"), "# nested\n");
		await initLSPConfig(parent);

		// The nested root is registered but has no config until its load
		// settles. That in-flight entry must not shadow the ancestor whose
		// config IS loaded: pre-#2518 the store simply had no entry for it, and
		// the longest-prefix walk fell through to the parent. It still must.
		const loading = initLSPConfig(child);
		expect(isServerDisabled(DENIED_SERVER, path.join(child, "notes.md"))).toBe(
			true,
		);
		await loading;
	}, 60_000);

	it("claims ONE config_resolved row per root across the two loaders", async () => {
		// `clients/runtime-session.ts`'s warm paths call `loadLSPConfig(cwd)`
		// directly — no registry, no `initLSPConfig` — with the session cwd
		// verbatim, while the session's own init passes the registry-resolved
		// spelling. Both take the SAME once-per-(session, root) claim, so the
		// row stays one per root; a key normalized per caller instead of once
		// at the record would let the two spellings claim twice (review F6).
		const root = denyingRoot();
		await loadLSPConfig(`${root}${path.sep}`);
		await initLSPConfig(root);
		expect(await configResolvedRowsFor(root)).toHaveLength(1);
	}, 60_000);

	it("records one bounded degradation when the cap drops a served root", async () => {
		for (let index = 0; index < 130; index++) {
			await initLSPConfig(foreignRoot(index));
		}

		const evictions = getDegradationSummary().filter(
			(group) => group.kind === "lsp-session-root-evicted",
		);
		expect(evictions).toHaveLength(1);
		// Two roots were dropped (130 registered, cap 128). The tally is the
		// event total an operator tunes the cap against...
		expect(evictions[0]?.count).toBe(2);
		// ... and it stays ONE entry, because the subject is the cap and not the
		// evicted root: a process cycling roots must not grow the ledger.
		expect(evictions[0]?.latestReasons).toHaveLength(1);
		expect(evictions[0]?.latestReasons[0]?.reason).toContain("(count: 2)");
	}, 120_000);

	// `initLSPConfig`'s cwd is NOT canonical in production: `analysisRoot` comes
	// out of `.pi-lens.json` verbatim and `clients/runtime-session.ts` hands the
	// session cwd straight to the warm paths, so a trailing slash reaches here.
	// Both spellings must key the same claim, or the release misses it (review
	// F6) — parameterized rather than duplicated so the canonical case cannot
	// drift away from the non-canonical one.
	for (const spelling of ["canonical", "trailing slash"] as const) {
		it(`re-arms the config_resolved record for a root the cap dropped (${spelling} cwd)`, async () => {
			const canonical = denyingRoot();
			const root =
				spelling === "canonical" ? canonical : `${canonical}${path.sep}`;
			await initLSPConfig(root);
			expect(await configResolvedRowsFor(canonical)).toHaveLength(1);

			// A second resolution of a root that is STILL served needs no second
			// row — the store already holds that answer.
			await initLSPConfig(root);
			expect(await configResolvedRowsFor(canonical)).toHaveLength(1);

			for (let index = 0; index < 129; index++) {
				await initLSPConfig(foreignRoot(index));
			}
			expect(isSessionRootRegistered(canonical)).toBe(false);

			// Now the answer is GONE, so the reload is a real second resolution and
			// must say what it resolved to. Without releasing the once-claim with
			// the entry, the reload publishes a `config_resolution_pending` mark
			// that no row ever answers.
			await initLSPConfig(root);
			expect(await configResolvedRowsFor(canonical)).toHaveLength(2);
		}, 120_000);
	}
});

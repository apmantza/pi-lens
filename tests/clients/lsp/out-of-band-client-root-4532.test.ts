/**
 * #4532 half 1 / gap 7: the install look runs at the roots of the LIVE primary
 * clients, not only at the session's cwd.
 *
 * Recurrence it prevents: a pi session whose cwd was a main checkout edited a
 * file in a LINKED WORKTREE that had no `node_modules`. The `typescript` server
 * rooted at the worktree published seven `@types/node` gaps; the agent
 * symlinked another checkout's install into the worktree and `tsc` was clean,
 * and the server kept republishing the same seven codes for fourteen minutes.
 * The out-of-band install look (#4476) ran only at `opaquePrescanRoot(deps.cwd,
 * workspaceRoot)` — the session cwd — so no look ever read the worktree's
 * install stamp and no client restarted. The session log held zero
 * `lsp_out_of_band_change` rows.
 *
 * Real: `handleToolResult` (the bash branch pi actually runs), the real
 * out-of-band look, the real disk-change publisher and its two subscribers, the
 * real diagnostics-cache refusal clock, and the real degradation ledger.
 * Doubled only at the process boundary: the language-server service behind the
 * real `clients/lsp/capabilities.js` lifecycle seam, so nothing here spawns a
 * server and the restart is observed as the call production makes.
 *
 * A `ln -s` writes no project file, so the look is keyed on the live client
 * ROOTS, not on the command's written set — that is the cell "a symlink alone
 * restarts the worktree's client". The first look at a root is the other half:
 * it may only publish an install that appeared AFTER that root's client
 * spawned, which is what the `since` epoch decides.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	getLSPService,
	resetLSPService,
} from "../../../clients/lsp/capabilities.js";
import { workspaceFileCreatedAtFor } from "../../../clients/lsp/workspace-diagnostics-session.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	canWriteAnalysisRoot,
	isSessionBookkeepingRoot,
	resolveAnalysisRoot,
} from "../../../clients/analysis-root.js";
import { lookForOutOfBandChanges } from "../../../clients/out-of-band-changes.js";
import {
	getRecentLoggedPhases,
	_setRecentPhasesForTest,
} from "../../../clients/latency-logger.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../../clients/runtime-tool-result.js";
import { createLspDiagnosticsTool } from "../../../tools/lsp-diagnostics.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { installLspService } from "../../support/lsp-service-seam.js";
import { setupTestEnvironment } from "../test-utils.js";

let env: { tmpDir: string; cleanup: () => void };
let main: string;
let worktree: string;
let runtime: RuntimeCoordinator;
let restarts: string[];
let forwarded: Array<{ filePath: string; type: number }>;
let clientRoots: Array<{ root: string; spawnedAt: number }>;

function installService(): void {
	resetLSPService();
	installLspService(
		makeLspServiceDouble({
			livePrimaryClientRoots: () => clientRoots,
			restartPrimaryClientsUnder: async (root: string) => {
				restarts.push(normalizeMapKey(root));
				return 1;
			},
			getOpenDocumentPaths: () => [],
			notifyOutOfBandFileChanges: (
				events: ReadonlyArray<{ filePath: string; type: number }>,
			) => {
				forwarded.push(...events);
			},
		}),
	);
	// The look under test reads the LIVE service through `peekLSPService`, so the
	// double has to exist before it runs — the same eager call the hand-rolled
	// install made.
	getLSPService();
}

/** One bash `tool_result`, the shape pi delivers for a finished command. */
async function bashResult(command: string): Promise<void> {
	const deps = {
		event: {
			toolName: "bash",
			toolCallId: `4532-${Math.random().toString(36).slice(2)}`,
			input: { command },
			content: [{ type: "text", text: "ok" }],
		},
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cwd: main,
		cacheManager: new CacheManager(false),
		biomeClient: {},
		ruffClient: {},
		testRunnerClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
		sessionId: "pi-lens-4532-client-root",
	} as unknown as Parameters<typeof handleToolResult>[0];
	await handleToolResult(deps);
}

/** The deferred engine's install markers, as a real checkout carries them. */
function plantInstall(root: string): void {
	fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "node_modules", "dep", "index.d.ts"),
		"export type Dep = number;\n",
	);
	fs.writeFileSync(
		path.join(root, "node_modules", ".package-lock.json"),
		"{}\n",
	);
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-4532-client-root-");
	main = path.join(env.tmpDir, "main-checkout");
	worktree = path.join(env.tmpDir, "linked-worktree");
	fs.mkdirSync(path.join(main, "src"), { recursive: true });
	fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
	fs.writeFileSync(path.join(main, "package.json"), "{}\n");
	fs.writeFileSync(path.join(worktree, "package.json"), "{}\n");
	fs.writeFileSync(
		path.join(worktree, "src", "admission-limiter.ts"),
		'import { randomUUID } from "node:crypto";\nexport const x = randomUUID();\n',
	);
	plantInstall(main);
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = main;
	runtime.setTelemetryIdentity({ sessionId: "pi-lens-4532-client-root" });
	runtime.beginTurn();
	restarts = [];
	forwarded = [];
	clientRoots = [];
	resetDegradationLedger();
	// The recent-phase ring is process-wide and `resetDegradationLedger` does
	// not clear it, so the scope cells would otherwise read a sibling case's row.
	_setRecentPhasesForTest([]);
});

afterEach(() => {
	resetLSPService();
	env.cleanup();
});

describe("the install look at a live client root (#4532 gap 7)", () => {
	it("restarts the worktree's client when node_modules is symlinked in after it spawned", async () => {
		// The server is already rooted at the worktree and spawned BEFORE the
		// install: exactly the reported order. The epoch is `Date.now()` itself —
		// a file's mtime comes from the kernel's coarse clock and can trail it by
		// a tick, and the slack that absorbs that now lives in the production
		// comparison (`COARSE_MTIME_SLACK_MS`), not in this fixture (#4532
		// round 4, LOW-5).
		const spawnedAt = Date.now();
		clientRoots = [{ root: worktree, spawnedAt }];
		installService();
		fs.symlinkSync(
			path.join(main, "node_modules"),
			path.join(worktree, "node_modules"),
		);

		// The command that made the install ran; a `ln -s` writes no project file.
		await bashResult("ln -s ../main-checkout/node_modules node_modules");

		// The look at the CLIENT root published the install and restarted that
		// root's primary client. Pre-fix this array was empty: the only look ran
		// at the session cwd (`main`), whose stamp never changed.
		expect(restarts).toContain(normalizeMapKey(worktree));
		// …and the diagnostics cache refuses every entry scanned before the
		// install, which is what makes the next read miss the stale finding.
		expect(
			workspaceFileCreatedAtFor(
				() => true,
				() => true,
			),
		).toBeGreaterThan(0);
	});

	// Recurrence (#5501 r3, F3): the root's first look recorded the manifests it
	// found and forwarded none, so a `Cargo.toml` fixed after the client spawned
	// but before this root's first look never reached rust-analyzer (real
	// service and server: 4 of 4 touches `server-load-failed`).
	it("forwards a manifest edited after the client spawned, at the client root's first look", async () => {
		const manifest = path.join(worktree, "Cargo.toml");
		fs.writeFileSync(manifest, '[package]\nname = "w"\n');
		clientRoots = [{ root: worktree, spawnedAt: Date.now() - 10_000 }];
		installService();

		await bashResult("true");

		expect(forwarded).toEqual([{ filePath: manifest, type: 2 }]);
		// A config is no install: the client is not restarted for it.
		expect(restarts).toEqual([]);
	});

	it("only records a manifest the client's spawn already followed", async () => {
		const manifest = path.join(worktree, "Cargo.toml");
		fs.writeFileSync(manifest, '[package]\nname = "w"\n');
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(manifest, past, past);
		clientRoots = [{ root: worktree, spawnedAt: Date.now() - 10_000 }];
		installService();

		await bashResult("true");

		expect(forwarded).toEqual([]);
	});

	// The gate the look asks: the session root and its repository's linked
	// worktrees may allocate session bookkeeping; an adopted project may not
	// (AGENTS.md "What it is" (analysis-root invariant), Greptile round 3).
	it("calls the session root and its linked worktrees bookkeeping roots, an adopted project not", () => {
		// A linked worktree laid out the way git writes it: a `.git` FILE naming
		// a gitdir under the session checkout's own `.git/worktrees/`.
		const linked = path.join(env.tmpDir, "linked-checkout");
		const gitDir = path.join(main, ".git", "worktrees", "linked-checkout");
		fs.mkdirSync(gitDir, { recursive: true });
		fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
		// git writes a HEAD in both the checkout's `.git` and the worktree's
		// gitdir; a `.git` directory without one is not a repository (#4508).
		fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
		fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/linked\n");
		fs.mkdirSync(linked, { recursive: true });
		fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${gitDir}\n`);

		expect(isSessionBookkeepingRoot(main, main)).toBe(true);
		expect(isSessionBookkeepingRoot(linked, main)).toBe(true);
		// A sibling project with its own marker is adopted.
		expect(isSessionBookkeepingRoot(worktree, main)).toBe(false);
		// Review F7: a client rooted at a package INSIDE the session root (a
		// monorepo package) is the session's, as `resolveAnalysisRoot` says for
		// its files; so is a subdirectory of a session root that is no checkout.
		const pkg = path.join(main, "packages", "a");
		fs.mkdirSync(pkg, { recursive: true });
		expect(isSessionBookkeepingRoot(pkg, main)).toBe(true);
		const plain = path.join(env.tmpDir, "plain-session");
		const plainSub = path.join(plain, "sub");
		fs.mkdirSync(plainSub, { recursive: true });
		expect(isSessionBookkeepingRoot(plainSub, plain)).toBe(true);
		// #4532 round 6 (verify r5, section 13): a vendor root under the session
		// (a client rooted at an installed package) answered true while
		// `resolveAnalysisRoot` refuses every file under it.
		const vendor = path.join(main, "node_modules", "pkg");
		fs.mkdirSync(vendor, { recursive: true });
		expect(isSessionBookkeepingRoot(vendor, main)).toBe(false);
		// One rule in two forms: the root form agrees with the file form the
		// owner gives a file under each root.
		for (const [root, session] of [
			[main, main],
			[pkg, main],
			[linked, main],
			[worktree, main],
			[plainSub, plain],
			[vendor, main],
		] as const) {
			expect(isSessionBookkeepingRoot(root, session), root).toBe(
				canWriteAnalysisRoot(
					resolveAnalysisRoot(path.join(root, "x.ts"), session),
				),
			);
		}
	});

	// Greptile round 3: AGENTS.md "What it is" (analysis-root invariant) — an adopted root may
	// host a client and receive the look, but never session bookkeeping, so the
	// look must allocate no project sequence for it.
	it("restarts an adopted root's client without session bookkeeping", async () => {
		// The look must still PUBLISH at an adopted root — its client restarts
		// when its install lands — so the population here is a declaration
		// change, the input that would allocate a project sequence if the look
		// handed it the session runtime.
		const previousLookMs = process.env.PI_LENS_DECLARATION_LOOK_MS;
		process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
		const declaration = path.join(worktree, "types.d.ts");
		fs.writeFileSync(declaration, "declare const A: number;\n");
		installService();
		fs.symlinkSync(
			path.join(main, "node_modules"),
			path.join(worktree, "node_modules"),
		);
		clientRoots = [{ root: worktree, spawnedAt: Date.now() }];
		try {
			await bashResult("ln -s ../main-checkout/node_modules node_modules");
			expect(restarts).toContain(normalizeMapKey(worktree));
			fs.writeFileSync(declaration, "declare const A: string;\n");
			await bashResult("true");
		} finally {
			if (previousLookMs === undefined)
				delete process.env.PI_LENS_DECLARATION_LOOK_MS;
			else process.env.PI_LENS_DECLARATION_LOOK_MS = previousLookMs;
		}
		expect(restarts).toContain(normalizeMapKey(worktree));
		// No sequence, receipt or change-log entry for a foreign root: the
		// session's own look published nothing (main's install is unchanged).
		expect(runtime.projectSeq).toBe(0);
	});

	// LOW-5 (round 4): the coarse-mtime slack lives in the production
	// comparison now. An install stamped a fraction of a second BEFORE the
	// client's spawn epoch is a first look that must still publish; comparing
	// exactly would record it as the baseline and publish nothing afterwards.
	it("publishes an install whose coarse mtime trails the client's spawn epoch", async () => {
		const root = path.join(env.tmpDir, "coarse-mtime-root");
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, "package.json"), "{}\n");
		const lockfile = path.join(root, "package-lock.json");
		fs.writeFileSync(lockfile, '{"lockfileVersion":3}\n');
		const trailing = new Date(Date.now() - 400);
		fs.utimesSync(lockfile, trailing, trailing);
		installService();

		await lookForOutOfBandChanges(root, "tool_call", runtime, {
			since: Date.now(),
		});

		expect(latestScope()).toBe("first-look");
	});

	// M1 (round 4): the GRANT arm of the bookkeeping gate. A root git writes as
	// a linked worktree of the SESSION checkout is a bookkeeping root, so a
	// declaration change there allocates a project sequence. Every other cell
	// points the look at a root with no `.git` (an adopted root), so only the
	// refusal arm was observed and this predicate could drift to `false`
	// silently.
	it("allocates session bookkeeping for a client root that is a linked worktree", async () => {
		const linked = path.join(env.tmpDir, "git-worktree");
		const gitDir = path.join(main, ".git", "worktrees", "git-worktree");
		fs.mkdirSync(gitDir, { recursive: true });
		fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
		// git writes a HEAD in both the checkout's `.git` and the worktree's
		// gitdir; a `.git` directory without one is not a repository (#4508).
		fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
		fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/linked\n");
		fs.mkdirSync(path.join(linked, "src"), { recursive: true });
		fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${gitDir}\n`);
		fs.writeFileSync(path.join(linked, "package.json"), "{}\n");
		const declaration = path.join(linked, "types.d.ts");
		fs.writeFileSync(declaration, "declare const A: number;\n");
		const previousLookMs = process.env.PI_LENS_DECLARATION_LOOK_MS;
		process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
		installService();
		clientRoots = [{ root: linked, spawnedAt: Date.now() }];
		try {
			// The first look records the baseline; the second sees a declaration
			// change at a root that may carry session bookkeeping.
			await bashResult("true");
			fs.writeFileSync(declaration, "declare const A: string;\n");
			await bashResult("true");
		} finally {
			if (previousLookMs === undefined)
				delete process.env.PI_LENS_DECLARATION_LOOK_MS;
			else process.env.PI_LENS_DECLARATION_LOOK_MS = previousLookMs;
		}

		expect(runtime.projectSeq).toBeGreaterThan(0);
	});

	it("publishes nothing on a first look at a root whose install predates its client", async () => {
		// A lockfile the package manager wrote BEFORE the server spawned: the
		// client already read it, so a restart would be pure churn.
		const lockfile = path.join(worktree, "package-lock.json");
		fs.writeFileSync(lockfile, "{}\n");
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lockfile, old, old);
		clientRoots = [{ root: worktree, spawnedAt: Date.now() }];
		installService();

		await bashResult("true");

		expect(restarts).not.toContain(normalizeMapKey(worktree));
	});

	it("restarts only the root whose install changed, never an unrelated one", async () => {
		// The unrelated root's own install predates its client, so its first look
		// must record it and change nothing: only `main`'s install is fresh.
		const other = path.join(env.tmpDir, "other-project");
		plantInstall(other);
		const old = new Date(Date.now() - 60_000);
		for (const marker of ["node_modules/.package-lock.json"]) {
			const target = path.join(other, marker);
			fs.utimesSync(target, old, old);
		}
		clientRoots = [
			{ root: worktree, spawnedAt: Date.now() },
			{ root: other, spawnedAt: Date.now() },
		];
		installService();
		const mainLock = path.join(main, "package-lock.json");
		fs.writeFileSync(mainLock, '{"lockfileVersion":3}\n');

		// First look records every root and changes nothing.
		await bashResult("true");
		expect(restarts).toEqual([]);

		// An install at the SESSION root only.
		fs.writeFileSync(mainLock, '{"lockfileVersion":3,"packages":{}}\n');
		await bashResult("true");

		expect(restarts).toEqual([normalizeMapKey(main)]);
		expect(restarts).not.toContain(normalizeMapKey(worktree));
		expect(restarts).not.toContain(
			normalizeMapKey(path.join(env.tmpDir, "other-project")),
		);
	});

	// LOW-1 (round 3): the row's `scope` metadata is the observable that says a
	// publish came from a FIRST look (only a named live-client epoch can make
	// that publish, #4532) or from a later look compared against the record.
	// Nothing read it, so the field and its comment asserted different things.
	it("labels its row as first-look or recorded (#4532 LOW-1)", async () => {
		const root = path.join(env.tmpDir, "scope-root");
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, "package.json"), "{}\n");
		// An install younger than the client's epoch: a FIRST look publishes it.
		const spawnedAt = Date.now() - 60_000;
		const lockfile = path.join(root, "package-lock.json");
		fs.writeFileSync(lockfile, '{"lockfileVersion":3}\n');
		installService();

		await lookForOutOfBandChanges(root, "tool_call", runtime, {
			since: spawnedAt,
		});
		expect(latestScope()).toBe("first-look");

		// A later look compared against that record is the recorded shape. The
		// longer content alone changes the stamp's size component, so the case
		// needs no wall-clock wait.
		fs.writeFileSync(lockfile, '{"lockfileVersion":3,"packages":{}}\n');
		await lookForOutOfBandChanges(root, "tool_call", runtime);
		expect(latestScope()).toBe("recorded");
	});

	/**
	 * `count` client roots outside the session root, each holding an install
	 * younger than its client's epoch, so a FIRST look at any of them restarts
	 * it: the restarts list is the set of roots the look actually reached.
	 */
	function freshInstallRoots(count: number): string[] {
		return Array.from({ length: count }, (_, index) => {
			const root = path.join(env.tmpDir, `project-${index}`);
			fs.mkdirSync(path.join(root, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(root, "package-lock.json"),
				'{"lockfileVersion":3}\n',
			);
			return root;
		});
	}

	const cappedRecords = () =>
		getDegradationSummary().filter(
			(group) => group.kind === "lsp-client-root-look-capped",
		);

	// Review F4: the cap record had a cell, the slice that enforces the cap did
	// not, so a mutant that recorded the cap and looked at every root anyway
	// stayed green.
	it("looks at the first four client roots, and records the cap instead of silently skipping the rest", async () => {
		const roots = freshInstallRoots(6);
		const spawnedAt = Date.now() - 60_000;
		clientRoots = roots.map((root) => ({ root, spawnedAt }));
		installService();

		await bashResult("true");

		expect([...restarts].sort()).toEqual(
			roots
				.slice(0, 4)
				.map((root) => normalizeMapKey(root))
				.sort(),
		);
		expect(cappedRecords()).toHaveLength(1);
		expect(cappedRecords()[0].count).toBe(1);
	});

	// Review F4: two spellings of one root are one root. Without the path-key
	// dedupe the second spelling takes a cap slot, the cap fires, and a real
	// fourth root is never looked at.
	it("counts two spellings of one client root once against the cap", async () => {
		const roots = freshInstallRoots(4);
		const spawnedAt = Date.now() - 60_000;
		const [first, ...rest] = roots;
		const respelled = `${path.dirname(first!)}/./${path.basename(first!)}`;
		clientRoots = [first!, respelled, ...rest].map((root) => ({
			root,
			spawnedAt,
		}));
		installService();

		await bashResult("true");

		expect([...new Set(restarts)].sort()).toEqual(
			roots.map((root) => normalizeMapKey(root)).sort(),
		);
		expect(cappedRecords()).toHaveLength(0);
	});

	// Review F4: an extra root's look walks its declarations at most once per
	// `PI_LENS_DECLARATION_LOOK_MS` (`walk: "interval"`), never on every bash
	// result as the session root's own look does, so a big worktree's walk
	// cannot run per command. The control runs the same two results with the
	// interval at 0.
	it("walks an extra client root's declarations at most once per interval", async () => {
		const declaration = path.join(worktree, "types.d.ts");
		// The ring keeps a row's metadata only; the session root's own look sees
		// no declaration change here, so a `changed` row is the worktree's.
		const declarationRows = () =>
			getRecentLoggedPhases().filter(
				(row) =>
					row.phase === "lsp_out_of_band_change" &&
					Number(row.metadata?.changed) > 0,
			);
		const previousLookMs = process.env.PI_LENS_DECLARATION_LOOK_MS;
		installService();
		clientRoots = [{ root: worktree, spawnedAt: Date.now() }];
		try {
			for (const lookMs of ["600000", "0"]) {
				process.env.PI_LENS_DECLARATION_LOOK_MS = lookMs;
				fs.writeFileSync(declaration, `declare const A${lookMs}: number;\n`);
				_setRecentPhasesForTest([]);
				// The baseline look, then a declaration change inside the interval.
				await bashResult("true");
				// A longer body, so the change shows in the size within one mtime tick.
				fs.writeFileSync(declaration, `declare const A${lookMs}: boolean;\n`);
				await bashResult("true");
				if (lookMs === "0") expect(declarationRows().length).toBeGreaterThan(0);
				else expect(declarationRows()).toHaveLength(0);
			}
		} finally {
			if (previousLookMs === undefined)
				delete process.env.PI_LENS_DECLARATION_LOOK_MS;
			else process.env.PI_LENS_DECLARATION_LOOK_MS = previousLookMs;
		}
	});
});

/**
 * #5501: the session root's look (`resyncHeadMove`, every tool_call and bash
 * result) and the MCP cwd's look (the `lsp_diagnostics` body) named no client
 * epoch, so their FIRST look only recorded the manifests it found. A
 * `Cargo.toml` fixed after rust-analyzer spawned, and before that first look,
 * never reached the server: real rust-analyzer through the MCP tool layer, a
 * hover then `pilens_diagnostics`, read `workspace failed to load` 4 of 4
 * times. These looks now name the earliest launch of the live primary clients
 * whose root overlaps theirs, and that epoch judges config files only: an
 * install there is recorded as before, so no client restarts at these first
 * looks (the restart cell #5593 named).
 */
describe("the session root's and the MCP cwd's first look (#5501)", () => {
	const writeManifest = (root: string, rel = "Cargo.toml"): string => {
		const manifest = path.join(root, rel);
		fs.mkdirSync(path.dirname(manifest), { recursive: true });
		fs.writeFileSync(manifest, '[package]\nname = "m"\n');
		return manifest;
	};

	/** One `lsp_diagnostics` answer with `cwd` as the MCP server passes it. */
	async function diagnoseAt(cwd: string): Promise<void> {
		const file = path.join(cwd, "src", "lib.rs");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "pub fn f() {}\n");
		await createLspDiagnosticsTool().execute(
			"5501-mcp-cwd",
			{ path: file, serverScope: "primary", waitMs: 0 },
			undefined,
			null,
			{ cwd },
		);
	}

	it("forwards a manifest edited after the client spawned, at the session root's first look", async () => {
		const manifest = writeManifest(main);
		clientRoots = [{ root: main, spawnedAt: Date.now() - 10_000 }];
		installService();

		await bashResult("true");

		expect(forwarded).toEqual([{ filePath: manifest, type: 2 }]);
	});

	// The restart cell: `beforeEach` planted `main`'s install markers after this
	// epoch, which a client root's look restarts for (#4532). The session root's
	// first look restarted nothing for it before #5501, and must not start now:
	// rust-analyzer's own `cargo metadata` writes `Cargo.lock` after its spawn
	// (measured), which would read as an install here.
	it("restarts no client for an install at the session root's first look", async () => {
		const manifest = writeManifest(main);
		clientRoots = [{ root: main, spawnedAt: Date.now() - 10_000 }];
		installService();

		await bashResult("true");

		expect(restarts).toEqual([]);
		expect(forwarded).toEqual([{ filePath: manifest, type: 2 }]);
	});

	it("forwards a manifest edited after the client spawned, at the MCP cwd's first look", async () => {
		const cwd = path.join(env.tmpDir, "mcp-cwd");
		const manifest = writeManifest(cwd);
		clientRoots = [{ root: cwd, spawnedAt: Date.now() - 10_000 }];
		installService();

		await diagnoseAt(cwd);

		expect(forwarded).toEqual([{ filePath: manifest, type: 2 }]);
	});

	// The MCP route has no client-root look, so a server rooted in a subdirectory
	// of the cwd (a crate in a monorepo) is reached only through the cwd's walk,
	// with the epoch of the client whose root sits below it.
	it("forwards a member manifest when the client is rooted below the MCP cwd", async () => {
		const cwd = path.join(env.tmpDir, "mcp-monorepo");
		const crate = path.join(cwd, "svc", "api");
		const manifest = writeManifest(crate);
		clientRoots = [{ root: crate, spawnedAt: Date.now() - 10_000 }];
		installService();

		await diagnoseAt(cwd);

		expect(forwarded).toEqual([{ filePath: manifest, type: 2 }]);
	});

	it("names no epoch from a client of an unrelated root", async () => {
		const cwd = path.join(env.tmpDir, "mcp-cwd");
		writeManifest(cwd);
		clientRoots = [
			{
				root: path.join(env.tmpDir, "mcp-cwd-sibling"),
				spawnedAt: Date.now() - 10_000,
			},
		];
		installService();

		await diagnoseAt(cwd);

		expect(forwarded).toEqual([]);
	});

	it("restarts no client for an install at the MCP cwd's first look", async () => {
		const cwd = path.join(env.tmpDir, "mcp-cwd");
		const manifest = writeManifest(cwd);
		plantInstall(cwd);
		clientRoots = [{ root: cwd, spawnedAt: Date.now() - 10_000 }];
		installService();

		await diagnoseAt(cwd);

		expect(restarts).toEqual([]);
		expect(forwarded).toEqual([{ filePath: manifest, type: 2 }]);
	});
});

/** The newest `lsp_out_of_band_change` row's `scope`, read from the process ring. */
function latestScope(): unknown {
	const row = getRecentLoggedPhases().find(
		(entry) => entry.phase === "lsp_out_of_band_change",
	);
	return row?.metadata?.scope;
}

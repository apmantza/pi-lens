/**
 * #2465 round 2 — the `agent_settled` observed-mutation SWEEP (not just the
 * mutation bridge's own recording seam) under `--no-read-guard`.
 *
 * `tests/index-mutation-bridge-recordability.test.ts` proved that a DIRECT
 * `bridge.recordMutation(...)` call under `--no-read-guard` still records
 * turn-state and the change-log receipt, skipping only the read-guard
 * staleness stamp. It never drives `index.ts`'s `runObservedSettledSweepSafely`
 * or `refreshObservedLedgerSafely` — both of which used to blanket-return
 * under `no-read-guard`, on the theory that the sweep's baseline only exists
 * because the read-guard is active.
 *
 * That theory is false: `clients/runtime-tool-call.ts`'s `recordRead` (the
 * call that seeds `collectTrackedPaths`/`storedLineHashesFor`, the sweep's
 * baseline) has no flag gate at all — only the pre-edit BLOCKING checks are
 * gated, matching `no-read-guard`'s documented meaning ("disable
 * read-before-edit behavior monitor",
 * `clients/lens-flag-registry.ts`). So under `no-read-guard` a read is still
 * recorded, the sweep still has real drift to catch, and the blanket early
 * return dropped turn-state, the change-log receipt, and the
 * `noteMutationHandled` mark right along with the read-guard stamp — the same
 * bridge-recordability conflation the first round of #2465 fixed one layer
 * down.
 *
 * This file drives the REAL production path: `session_start` → a `read`
 * `tool_call` (seeds the read-guard baseline) → `agent_settled` (seeds the
 * ledger) → an external, out-of-band `fs.writeFileSync` (a third-party
 * producer that never touches pi-lens's tool-event path or the mutation
 * bridge) → a second `agent_settled`, whose sweep must notice the drift and
 * replay it through the bridge.
 *
 * `handleAgentEnd` (the deferred autofix/format drain) is stubbed the same
 * way `tests/index-integration.test.ts` isolates drain-adjacent behavior from
 * the sweep — this file's target is `runObservedSettledSweepSafely` and
 * `refreshObservedLedgerSafely`, not the drain's own formatting.
 *
 * Tier 2, inline-factory mode (#4937 L6). The extension runs in a real pi
 * session on THIS test graph's modules, which is what the `ReadGuard`
 * prototype spy, the producer-entry capture and the `vi.mock`s below need. The
 * flag is pi's own `--no-read-guard`, handed to `extensionFlagValues` and
 * applied after the factory exactly as the CLI does (#4913), not a global
 * config key standing in for it. The events are pi's: `tool_call` from a
 * scripted `read`, and `agent_settled` from the end of each prompt.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: {
			recordToolCall: () => {},
			formatWarnings: () => "",
		},
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: () => null,
		},
	}));
});
// The stub keeps the two per-session re-arms of production's
// `handleSessionStart` that a second session in this file depends on.
// `index.ts` holds ONE module-level `RuntimeCoordinator`, and every session
// here ends with `session_shutdown`, which retires its session scope and shuts
// the analyzer bootstrap's gate. Production's `handleSessionStart` begins the
// next scope (`runtime.resetForSession()`, #3611) and re-arms the gate
// (#2467); `index.ts` then binds the process bridges to that new scope. Without
// them the next case's session ran on the retired scope: the bridge answered
// "no live primary", the settled sweep's replay recorded nothing, and no turn
// state was written. Recurrence: the #2465 case failed when it ran after the
// #4535 case (CI shuffle seed 202).
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async (deps: {
		runtime: { projectRoot: string; resetForSession: () => void };
		ctxCwd?: string;
	}) => {
		// Synchronous, before the first await: `index.ts` takes
		// `runtime.sessionScope` right after this call returns its promise and
		// binds the process bridges to it (#3611, #3612), exactly as production's
		// `resetForSession` runs before its own first await.
		deps.runtime.resetForSession();
		resetAnalyzerBootstrapSessionState();
		if (deps.ctxCwd) deps.runtime.projectRoot = deps.ctxCwd;
	},
}));
// Isolates the sweep/refresh under test from the deferred autofix/format
// drain, which is a different mechanism this file makes no claim about (same
// isolation `tests/index-integration.test.ts`'s `mockDrainDeps` applies).
vi.mock("../clients/runtime-agent-end.js", () => ({
	handleAgentEnd: vi.fn(async () => undefined),
}));
// #3763 item 5 / #3824 S2: observe what the REAL settled-sweep producer hands
// the bridge. The mounted bridge is frozen, so the capture rides the producer's
// own recorder (index.ts's `runObservedSettledSweepSafely`) instead. The floor
// below proves this probe saw the producer's epoch; the safety clause pins that
// no real producer sends an epoch without the lineage it captured beside it.
const replayedProducerEntries = vi.hoisted(
	() => [] as Array<{ epoch: number | undefined; hasLineage: boolean }>,
);
vi.mock("../clients/observed-mutation-sources.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../clients/observed-mutation-sources.js")
		>();
	return {
		...actual,
		replayThroughMutationBridge: (
			entry: Parameters<typeof actual.replayThroughMutationBridge>[0],
		) => {
			replayedProducerEntries.push({
				epoch: entry.readGuardBranchEpoch,
				hasLineage: entry.lineage !== undefined,
			});
			return actual.replayThroughMutationBridge(entry);
		},
	};
});

import {
	isAnalyzerBootstrapShutdown,
	resetAnalyzerBootstrapSessionState,
} from "../clients/bootstrap.js";
import { CacheManager } from "../clients/cache-manager.js";
import {
	type DiskChange,
	subscribeDiskChange,
} from "../clients/disk-changes.js";
import { HOOK_WALL_BUDGET_MS } from "../clients/hook-budgets.js";
import extension from "../index.js";
import { getLSPService, resetLSPService } from "../clients/lsp/capabilities.js";
import { configureLspServiceLifecycle } from "../clients/lsp/service-singleton.js";
import {
	resetWorkspaceDiagnosticsCacheSession,
	workspaceFileCreatedAtFor,
} from "../clients/lsp/workspace-diagnostics-session.js";
import { resetObservedMutationNet } from "../clients/observed-mutation.js";
import { normalizeFilePath, normalizeMapKey } from "../clients/path-utils.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { readChangesSince } from "../clients/project-changes.js";
import { ReadGuard } from "../clients/read-guard.js";
import { makeLspServiceDouble } from "./support/lsp-service-double.js";
import { endTurn, readTarget, step } from "./support/pi-session-commit-gate.js";
import { piSessionFixture, startPiSession } from "./support/pi-session.js";

const fixture = piSessionFixture();

/** The flag set both cases run with: pi's own `--no-read-guard`. */
const NO_READ_GUARD = new Map([["no-read-guard", true]]);

/** A project of its own under the file's one fixture root. */
function project(slug: string): string {
	const cwd = path.join(fixture.root, slug, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	return cwd;
}

describe("#2465 round 2: the observed-mutation settled sweep runs under --no-read-guard", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = project("sweep-2465");
		resetObservedMutationNet();
		_resetSessionLifecycleForTests();
		replayedProducerEntries.length = 0;
	});

	afterEach(() => {
		resetObservedMutationNet();
	});

	it("a third-party write under --no-read-guard is still caught by the settled sweep and replayed through the bridge, skipping only the read-guard stamp", async () => {
		// The class method every RuntimeCoordinator's lazily-constructed
		// ReadGuard shares — spying on the prototype catches the call
		// regardless of which instance index.ts's closure holds.
		const recordWrittenSpy = vi.spyOn(ReadGuard.prototype, "recordWritten");

		const filePath = path.join(tmp, "sweep-target.ts");
		fs.writeFileSync(filePath, "export const a = 1;\n");
		// Prompt 1 seeds the read-guard's tracked-path set and per-line hash
		// baseline through the REAL production read path (recordRead is
		// unconditional — it is not gated on `no-read-guard`), exactly like an
		// agent reading the file before some external process touches it; pi's
		// `agent_settled` at its end is the FIRST settle: nothing has drifted
		// yet, so this pass only seeds the ledger's baseline for the file the
		// read tracked.
		const handle = await startPiSession({
			root: fixture.root,
			cwd: tmp,
			flags: NO_READ_GUARD,
			inlineFactory: async () => extension,
			responses: [step(readTarget(filePath)), endTurn(), endTurn()],
		});
		await handle.prompt("read it");

		// A producer OUTSIDE pi-lens's tool-event path rewrites the file — a
		// plain fs write, exactly like a co-process extension or a background
		// formatter would, never going through the mutation bridge or a tool
		// call at all.
		fs.writeFileSync(
			filePath,
			"export const a = 2;\nexport const b = 3;\n",
			"utf-8",
		);

		// Second settle: the sweep must notice the drift and replay it through
		// the mutation bridge — this is the call the blanket `no-read-guard`
		// early return used to skip entirely.
		await handle.prompt("anything new?");
		expect(handle.errors).toEqual([]);
		// The session ran with the analyzer bootstrap armed, whichever case ran
		// before it (the previous session's `session_shutdown` shut the gate).
		expect(isAnalyzerBootstrapShutdown()).toBe(false);

		// The stamp alone is suppressed under --no-read-guard. The sweep
		// replays through the bridge with a NORMALIZED map key (`uriToPath`-
		// style forward-slash form on win32), not the raw `path.join` spelling,
		// so the comparison normalizes both sides the same way the guard's own
		// key() does (#210 — a raw-string comparison here would pass
		// vacuously regardless of whether the stamp fired).
		const stampedPaths = recordWrittenSpy.mock.calls.map((call) =>
			normalizeFilePath(String(call[0])),
		);
		expect(stampedPaths).not.toContain(normalizeFilePath(filePath));

		// Turn-state and the change-log receipt are NOT dropped — this is what
		// the blanket early return used to take down along with the stamp.
		const turnFiles = Object.keys(
			new CacheManager(false).readTurnState(tmp).files ?? {},
		);
		expect(turnFiles.some((f) => f.includes("sweep-target.ts"))).toBe(true);
		expect(readChangesSince(tmp, 0)).toContainEqual(
			expect.objectContaining({
				filePath,
				source: "agent-tool:settled-sweep",
			}),
		);

		// Floor: the probe observed the settled sweep's own replay with an epoch.
		expect(
			replayedProducerEntries.some((entry) => entry.epoch !== undefined),
		).toBe(true);
		// Safety: no production entry carries an epoch without its lineage, so no
		// real producer can reach the bridge's no-lineage above-live branch.
		expect(
			replayedProducerEntries
				.filter((entry) => entry.epoch !== undefined)
				.every((entry) => entry.hasLineage),
		).toBe(true);
	});
});

/**
 * #4535 slice 3: the same sweep is the settled-sweep detector (D4). Before it
 * published, a swept change reached the mutation bridge only: the language
 * servers kept the pre-change bytes and the diagnostics cache kept serving the
 * findings that depended on the file. The recurrence is the audit's "the settled
 * sweep's replays never reach LSP, dispatch or the graph" (#4535, first
 * comment), which no test could see because no consumer was listed against the
 * detector.
 */
describe("#4535 slice 3: the settled sweep publishes what it finds", () => {
	let tmp: string;
	const cleanups: Array<() => void> = [];
	const primaries: Array<{ paths: string[]; drainMs: number }> = [];
	// The publish is detached from the settle; the language server's primary
	// send is its last observable step, so the case waits on that, not on a timer.
	let primarySent: () => void = () => undefined;
	let primaryReached: Promise<void>;

	beforeEach(async () => {
		tmp = project("sweep-4535");
		resetObservedMutationNet();
		replayedProducerEntries.length = 0;
		primaries.length = 0;
		primaryReached = new Promise<void>((resolve) => {
			primarySent = resolve;
		});
		// The case before this one left its session registered as the primary, so
		// this case's session would be classified a concurrent secondary and its
		// `agent_settled` skipped.
		_resetSessionLifecycleForTests();
		resetWorkspaceDiagnosticsCacheSession(0);
		resetLSPService();
		const service = makeLspServiceDouble({
			getOpenDocumentPaths: () => [normalizeMapKey(path.join(tmp, "swept.ts"))],
			getTrackedContent: () => ({ hash: "the-bytes-the-server-holds" }),
			resyncHeldPrimaries: async (
				paths: readonly string[],
				drainMs: number,
			) => {
				primaries.push({ paths: [...paths], drainMs });
				primarySent();
				return { sent: paths.length, drained: true };
			},
			resyncGitChangedFiles: async () => new Map<string, string>(),
		});
		configureLspServiceLifecycle<Record<string, unknown>>({
			create: () => service,
			beforeReset: () => undefined,
			destroy: async () => undefined,
		});
		getLSPService();
	});

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		resetLSPService();
		_resetSessionLifecycleForTests();
		resetObservedMutationNet();
	});

	it("tells the language server and the diagnostics cache about a file nothing explains", async () => {
		const published: DiskChange[] = [];
		// The fan-out is detached from the settle and runs its subscribers one
		// after another, so the language server's primary send can resolve
		// `primaryReached` before this observer is called: the case waits on both.
		let observed: () => void = () => undefined;
		const observedSweep = new Promise<void>((resolve) => {
			observed = resolve;
		});
		cleanups.push(
			subscribeDiskChange("sweep-4535-observer", (change) => {
				published.push(change);
				if (change.origin === "settled-sweep") observed();
			}),
		);
		const filePath = path.join(tmp, "swept.ts");
		fs.writeFileSync(filePath, "export const a = 1;\n");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: tmp,
			flags: NO_READ_GUARD,
			inlineFactory: async () => extension,
			responses: [step(readTarget(filePath)), endTurn(), endTurn()],
		});
		await handle.prompt("read it");

		// The first settle (the end of the prompt above) only seeds the baseline:
		// nothing drifted, nothing to say.
		expect(published.filter((c) => c.origin === "settled-sweep")).toEqual([]);

		fs.writeFileSync(filePath, "export const a = 2;\nexport const b = 3;\n");
		await handle.prompt("anything new?");
		expect(handle.errors).toEqual([]);
		await Promise.all([primaryReached, observedSweep]);
		expect(published.filter((c) => c.origin === "settled-sweep")).toHaveLength(
			1,
		);

		const [change] = published.filter((c) => c.origin === "settled-sweep");
		const key = normalizeMapKey(filePath);
		expect(change).toMatchObject({
			root: normalizeMapKey(tmp),
			kind: "observed",
			// The mutation bridge already recorded this path; a second allocation
			// would bump it twice.
			seq: 0,
			paths: [key],
		});
		// The language server consumer sent the stale held document to a primary.
		expect(primaries).toEqual([
			{ paths: [key], drainMs: HOOK_WALL_BUDGET_MS.agent_settled },
		]);
		// The diagnostics cache refuses the entries that depend on the path.
		expect(
			workspaceFileCreatedAtFor(
				() => false,
				() => true,
				(creation) => creation.path === key,
			),
		).toBe(change.at);
	});
});

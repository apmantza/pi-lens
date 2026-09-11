/**
 * Analyzer bootstrap: the 17 shell-out analysis clients, loaded ON DEMAND.
 *
 * #2467: nothing about extension activation needs these clients. They are
 * consumed by session startup's background scans, by the bootstrap-dependent
 * `tool_call` branches, and by the project-diagnostics tools — every one of
 * which can prove it needs them before the graph is paid for. So activation
 * never touches this seam, and the load itself sits behind ONE shared
 * retryable promise every consumer joins: `clients/single-flight.ts`'s
 * primitive owns the identity-guarded release, so a rejected load frees the
 * key for the next demand instead of latching (#1690/#1674) and concurrent
 * demands never start a second load.
 *
 * The measured cost this moves off the interactive path is ~16ms of module
 * evaluation plus ~3ms of construction, on top of whatever the 17 client
 * modules are not already resident for — see the PR body for the numbers.
 * The first session of a process runs in QUICK mode, which uses none of these
 * clients, so that whole cost used to be paid for nothing on exactly the
 * start the user is waiting on.
 *
 * Two accessors, deliberately different contracts:
 *
 * - {@link loadBootstrapClients} is the STRICT form the callers that cannot
 *   proceed without the clients keep using. It rejects rather than inventing
 *   an answer.
 * - {@link requestBootstrapClients} is the BOUNDED, FAIL-OPEN form (#2467):
 *   it bounds the caller's wait on both axes AGENTS.md requires — a
 *   wall-clock ceiling and the caller's abort signal — and returns `null`
 *   rather than throwing, so the caller proceeds without the clients and the
 *   degradation is counted once in the ledger instead of surfacing as a
 *   failed tool call.
 *
 * Neither bound cancels the LOAD; promises are not cancellable and a dynamic
 * import has no abort seam. They bound the WAIT. The shared flight keeps
 * running, so a later demand reuses whatever it produced — the same
 * abandon-the-wait, keep-the-work shape as `lsp-pull-late-answer`.
 */
import { logExtension } from "./extension-log.js";
import { bounded } from "./deadline-utils.js";
import type { LedgerHookKey } from "./hook-budgets.js";
import { logLatency } from "./latency-logger.js";
import { emitBounded } from "./bounded-telemetry.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { createSingleFlight } from "./single-flight.js";
import type { AgentBehaviorClient } from "./agent-behavior-client.js";
import type { BiomeClient } from "./biome-client.js";
import type { ComplexityClient } from "./complexity-client.js";
import type { DependencyChecker } from "./dependency-checker.js";
import type { GitleaksClient } from "./gitleaks-client.js";
import type { GoClient } from "./go-client.js";
import type { GovulncheckClient } from "./govulncheck-client.js";
import type { JscpdClient } from "./jscpd-client.js";
import type { KnipClient } from "./knip-client.js";
import type { MetricsClient } from "./metrics-client.js";
import type { OpengrepClient } from "./opengrep-client.js";
import type { RuffClient } from "./ruff-client.js";
import type { RustClient } from "./rust-client.js";
import type { TestRunnerClient } from "./test-runner-client.js";
import type { DeadCodeClient } from "./dead-code-client.js";
import type { TodoScanner } from "./todo-scanner.js";
import type { TrivyClient } from "./trivy-client.js";
import { agentBehaviorClient } from "./agent-behavior-client.js";

export interface BootstrapClients {
	ruffClient: RuffClient;
	biomeClient: BiomeClient;
	knipClient: KnipClient;
	todoScanner: TodoScanner;
	jscpdClient: JscpdClient;
	depChecker: DependencyChecker;
	testRunnerClient: TestRunnerClient;
	metricsClient: MetricsClient;
	complexityClient: ComplexityClient;
	goClient: GoClient;
	govulncheckClient: GovulncheckClient;
	gitleaksClient: GitleaksClient;
	trivyClient: TrivyClient;
	opengrepClient: OpengrepClient;
	rustClient: RustClient;
	agentBehaviorClient: AgentBehaviorClient;
	deadCodeClients: DeadCodeClient[];
}

/**
 * The clients of a COMPLETED load, or `null` while none has completed.
 *
 * Process-lifetime on purpose: the 17 clients are stateless constructions and
 * every session-scoped latch that lives ON them is re-armed at `session_start`
 * by its own registered reset (`resetInstallRetryLatches`, #1497, is the
 * canonical one). Dropping the clients at a session boundary would re-pay the
 * whole load for nothing and would silently orphan those resets.
 *
 * Only a SUCCESSFUL load writes it, which is what makes retry-after-failure
 * work at all: a rejected load leaves this `null`, so the next demand starts a
 * fresh flight instead of replaying the rejection (#1570's eviction, now owned
 * by the single-flight primitive's identity-guarded release).
 */
let residentClients: BootstrapClients | null = null;

/** Behaviour history remains available before analyzer bootstrap completes. */
export function getAgentBehaviorClient(): AgentBehaviorClient {
	return agentBehaviorClient;
}

/**
 * Set by {@link markAnalyzerBootstrapShutdown} when the PRIMARY session tears
 * down. It refuses NEW loads only — a demand that already joined the in-flight
 * load keeps its promise and still settles (#2467 AC4). Session-scoped, not
 * process-scoped: a replacement session in the same process must be able to
 * load again, which is what {@link resetAnalyzerBootstrapSessionState} restores.
 */
let bootstrapShutdown = false;

/**
 * The abort signal every BOUNDED demand races, aborted by
 * {@link markAnalyzerBootstrapShutdown} and replaced at `session_start`.
 *
 * #2467 review: the two session-start schedulers must NOT bind the ambient
 * TURN signal — a `session_start` that lands mid-turn (sequential
 * replacement, `/new`) would otherwise cancel every startup scan with no
 * retry, which is #1394's exact lesson. They are not turn-scoped work. But
 * "no abort at all" is not the answer either: AGENTS.md's both-bounds rule
 * wants a wall-clock ceiling AND an abort race, and the bound that is
 * genuinely theirs is the SESSION's own teardown. So the seam supplies it,
 * for every caller, rather than each caller inventing one.
 */
let bootstrapShutdownController = new AbortController();

/**
 * Consecutive BUILD failures, reset by a successful build and by
 * `session_start`. See {@link BOOTSTRAP_FAILURE_STRIKE_LIMIT}.
 */
let bootstrapFailureStrikes = 0;

/**
 * How many BUILDS have been started this process (not how many demands were
 * made — concurrent demands share one build). Stamped into the
 * `bootstrap_clients_load` record as `attempt`, which is the discrimination
 * #2467's observability section asks for: it tells a field reader whether a
 * record is the initial attempt or a retry after a transient failure, without
 * adding a per-demand record.
 */
let bootstrapLoadAttempts = 0;

/**
 * The one key in the flight registry. `createSingleFlight` is keyed because
 * most of its sites dedupe per file or per server; this one has a single
 * subject, so it pays one map entry for the four guards the primitive owns.
 */
const BOOTSTRAP_FLIGHT_KEY = "analyzer-bootstrap";

/**
 * No `generation` hook. The primitive's own doc states the rule: a generation
 * is for an answer a session boundary INVALIDATES. These clients are stateless
 * and outlive every session in the process, so a pre-reset flight's result is
 * exactly as correct for a post-reset caller — a generation check here could
 * never kill a test, which is the vacuous guard this repo keeps deleting.
 */
const bootstrapFlight = createSingleFlight<BootstrapClients>();

/**
 * Wall-clock ceiling on ONE caller's wait, not on the load.
 *
 * Measured cold cost of the load is ~100ms from an empty module graph and
 * ~19ms once `index.ts`'s own graph is resident, so 10s is not a performance
 * budget — it is the liveness bound AGENTS.md's both-bounds rule requires, so
 * a wedged module evaluation cannot park a `tool_call` handler forever.
 */
const BOOTSTRAP_LOAD_TIMEOUT_MS = 10_000;

/**
 * How many consecutive failed builds before the seam stops rebuilding.
 *
 * Retry-after-failure is right for a TRANSIENT fault, which is the case the
 * flight's identity-guarded release was written for. It is wrong for a
 * PERMANENT one: an analyzer module that cannot resolve under the host's
 * package layout (#285/#335) fails identically every time, and without a
 * latch every later demand re-ran seventeen dynamic imports plus
 * `collectInstallDiagnostics` — on the tool-call hot path — for an answer
 * that could not change. Three strikes distinguishes "the filesystem
 * hiccuped" from "this environment cannot load these analyzers"; after that
 * the demand fails OPEN immediately, and `session_start` re-arms the latch so
 * a repaired environment is never locked out for the life of the process.
 */
const BOOTSTRAP_FAILURE_STRIKE_LIMIT = 3;

/**
 * A stand-in for an analysis client whose module failed to load (an unresolved
 * runtime dependency under a package-manager layout the resolver can't traverse
 * — #285/#335). Every method call no-ops to `undefined`, which every analyzer
 * consumer already treats as "nothing to report", so a single failed analyzer
 * degrades to silence instead of taking down the whole extension. This keeps the
 * fail-soft in ONE seam (the bootstrap) so consumers never special-case it —
 * the same single-seam principle as the clients/deps/* accessors.
 */
export function degradedClient<T extends object>(): T {
	return new Proxy({} as T, {
		get(_target, prop) {
			// Not thenable (so `await stub` / Promise.resolve(stub) won't treat it
			// as a promise), not iterable, no surprising coercion.
			if (typeof prop === "symbol" || prop === "then") return undefined;
			return () => undefined;
		},
	});
}

/**
 * One or more client modules failed to load — almost always an unresolved
 * runtime dependency under a package-manager layout the runtime's resolver can't
 * traverse (#285/#335). Name each disabled analyzer, then emit ONE paste-able
 * environment fingerprint so a reporter can tell us exactly what failed and
 * where. Best-effort: never let the diagnostic itself mask the failure.
 */
async function logBootstrapFailures(
	failures: { name: string; err: unknown }[],
): Promise<void> {
	for (const { name, err } of failures) {
		logExtension({
			subsystem: "bootstrap",
			message: `analyzer "${name}" disabled (degraded mode): ${
				(err as Error)?.message ?? String(err)
			}`,
			metadata: { analyzer: name },
		});
	}
	try {
		const { collectInstallDiagnostics, formatInstallDiagnostics } =
			await import("./install-diagnostics.js");
		logExtension({
			subsystem: "bootstrap",
			message: formatInstallDiagnostics(
				collectInstallDiagnostics(),
				failures[0]?.err,
			),
			metadata: { kind: "install_diagnostics" },
		});
	} catch {
		// the per-analyzer lines above already named the failures
	}
}

/**
 * Build the 17 clients once. Every per-client load below is individually
 * fail-soft (`load`/`loadList` degrade to a stub instead of throwing), so this
 * is not expected to reject in practice — a genuinely unexpected throw (e.g.
 * `logBootstrapFailures`) is what the retryable flight above exists for.
 *
 * Not exported: callers go through {@link loadBootstrapClients} or
 * {@link requestBootstrapClients} so the sharing, the retry, and the shutdown
 * gate cannot be bypassed by a new call site.
 */
async function buildBootstrapClients(): Promise<BootstrapClients> {
	const failures: { name: string; err: unknown }[] = [];
	// Load + construct one client in isolation; on failure record it and
	// substitute a degraded no-op stub so the others still load — single-seam
	// fail-soft, consumers never special-case it.
	async function load<T extends object>(
		name: string,
		make: () => Promise<T>,
	): Promise<T> {
		try {
			return await make();
		} catch (err) {
			failures.push({ name, err });
			return degradedClient<T>();
		}
	}
	// Lists degrade to empty (a stub Proxy isn't iterable), e.g. dead-code.
	async function loadList<T>(
		name: string,
		make: () => Promise<T[]>,
	): Promise<T[]> {
		try {
			return await make();
		} catch (err) {
			failures.push({ name, err });
			return [];
		}
	}

	const [
		ruffClient,
		biomeClient,
		knipClient,
		todoScanner,
		jscpdClient,
		depChecker,
		testRunnerClient,
		metricsClient,
		complexityClient,
		goClient,
		govulncheckClient,
		gitleaksClient,
		trivyClient,
		opengrepClient,
		rustClient,
		agentBehaviorClient,
		deadCodeClients,
	] = await Promise.all([
		load(
			"ruff",
			async () => new (await import("./ruff-client.js")).RuffClient(),
		),
		load(
			"biome",
			async () => new (await import("./biome-client.js")).BiomeClient(),
		),
		load(
			"knip",
			async () => new (await import("./knip-client.js")).KnipClient(),
		),
		load(
			"todo",
			async () => new (await import("./todo-scanner.js")).TodoScanner(),
		),
		load(
			"jscpd",
			async () => new (await import("./jscpd-client.js")).JscpdClient(),
		),
		load(
			"dependency-checker",
			async () =>
				new (await import("./dependency-checker.js")).DependencyChecker(),
		),
		load(
			"test-runner",
			async () =>
				new (await import("./test-runner-client.js")).TestRunnerClient(),
		),
		load(
			"metrics",
			async () => new (await import("./metrics-client.js")).MetricsClient(),
		),
		load(
			"complexity",
			async () =>
				new (await import("./complexity-client.js")).ComplexityClient(),
		),
		// The process-wide singleton, NOT a fresh instance (#2455 fix round 4,
		// F2). `handleSessionStart` reads this object for its "Active tools"
		// line while `resetGoAvailability` re-arms the singleton's latch; a
		// second instance here meant the reset never reached the surface a
		// user actually sees.
		load("go", async () => (await import("./go-client.js")).goClient),
		load(
			"govulncheck",
			async () =>
				new (await import("./govulncheck-client.js")).GovulncheckClient(),
		),
		load(
			"gitleaks",
			async () => new (await import("./gitleaks-client.js")).GitleaksClient(),
		),
		load(
			"trivy",
			async () => new (await import("./trivy-client.js")).TrivyClient(),
		),
		load(
			"opengrep",
			async () => new (await import("./opengrep-client.js")).OpengrepClient(),
		),
		// The process-wide singleton, for the same reason as "go" above.
		load("rust", async () => (await import("./rust-client.js")).rustClient),
		load(
			"agent-behavior",
			async () =>
				(await import("./agent-behavior-client.js")).agentBehaviorClient,
		),
		loadList("dead-code", async () =>
			(await import("./dead-code-client.js")).getDeadCodeClients(),
		),
	]);

	if (failures.length > 0) await logBootstrapFailures(failures);

	return {
		ruffClient,
		biomeClient,
		knipClient,
		todoScanner,
		jscpdClient,
		depChecker,
		testRunnerClient,
		metricsClient,
		complexityClient,
		goClient,
		govulncheckClient,
		gitleaksClient,
		trivyClient,
		opengrepClient,
		rustClient,
		agentBehaviorClient,
		deadCodeClients,
	};
}

/**
 * Why a demand could not be served: `shutdown` (the primary session already
 * tore down, so no new load may start), `timeout` (the caller's wall-clock
 * ceiling elapsed), `aborted` (the caller's own signal fired — Escape, turn
 * abort), `failed` (the load itself rejected), or `latched`
 * ({@link BOOTSTRAP_FAILURE_STRIKE_LIMIT} consecutive builds failed, so the
 * seam stopped rebuilding). A `null` from
 * {@link requestBootstrapClients} never says which on its own, so the reason
 * travels in the bounded record and the ledger entry instead.
 */
const BOOTSTRAP_UNAVAILABLE_REASONS = [
	"shutdown",
	"timeout",
	"aborted",
	"failed",
	"latched",
] as const;

/** One of {@link BOOTSTRAP_UNAVAILABLE_REASONS}. */
type BootstrapUnavailableReason =
	(typeof BOOTSTRAP_UNAVAILABLE_REASONS)[number];

/** A demand that could not be served. Carries the discriminating reason. */
class BootstrapUnavailableError extends Error {
	readonly unavailableReason: BootstrapUnavailableReason;

	constructor(unavailableReason: BootstrapUnavailableReason, message: string) {
		super(message);
		this.name = "BootstrapUnavailableError";
		this.unavailableReason = unavailableReason;
	}
}

/**
 * The clients a completed load produced, or `null`.
 *
 * NEVER starts a load. This is the accessor for work that must touch the
 * clients only if they already exist — session start's `metricsClient.reset()`
 * and `knipClient.resetSessionState()` are exactly that: re-arming state on a
 * client that was never constructed is vacuous, and loading 17 modules in
 * order to reset nothing is the cost #2467 removes.
 */
export function peekBootstrapClients(): BootstrapClients | null {
	return residentClients;
}

/**
 * The analyzer-bootstrap seam a long-lived handler consumes (#2467).
 *
 * `index.ts` binds it once and hands it to `handleSessionStart`, which used
 * to receive fifteen already-constructed clients — i.e. an awaited load on
 * the interactive path. The two methods are deliberately different
 * questions: `peek` is for work that is VACUOUS when nothing is loaded,
 * `request` is for work that needs the clients and can proceed without
 * them.
 */
export interface SessionBootstrapAccess {
	/** Resident clients only; never starts a load. */
	peek(): BootstrapClients | null;
	/**
	 * Bounded, fail-open demand. `null` means proceed without them.
	 *
	 * Deliberately takes NO abort signal. Session start is not turn-scoped
	 * work: a `session_start` can land mid-turn (sequential replacement,
	 * `/new`), and binding the ambient turn signal there cancelled every
	 * startup scan with no retry — #1394's lesson, found in review. Both
	 * bounds still hold, because {@link requestBootstrapClients} races the
	 * wall-clock ceiling against the seam's own session-teardown signal, which
	 * IS the bound that belongs to this work. Leaving the parameter off means
	 * no future call site can quietly rebind the wrong one.
	 */
	request(reason: string): Promise<BootstrapClients | null>;
}

/**
 * A {@link SessionBootstrapAccess} over clients that are ALREADY loaded.
 *
 * `clients/mcp/session.ts` builds its whole session context up front — an MCP
 * call has nothing to defer to — so it holds the seventeen clients before it
 * ever calls `handleSessionStart`. This is the two-line adapter that lets the
 * handler take ONE shape instead of admitting a second, untyped one in which
 * fifteen individually-optional client fields stood in for the seam ("exactly
 * one of the two is supplied" was prose, not a type; a dropped
 * `metricsClient` compiled and silently skipped every startup scan).
 */
export function residentBootstrapAccess(
	clients: BootstrapClients,
): SessionBootstrapAccess {
	return {
		peek: () => clients,
		request: async () => clients,
	};
}

/**
 * The STRICT accessor: resolve the shared clients or reject.
 *
 * Concurrent callers join one flight (identity-guarded by
 * `clients/single-flight.ts`, so a late settle can never evict a successor's
 * entry). A rejected load releases the key, so the NEXT demand retries rather
 * than replaying the rejection — with the caveat `clients/lazy-import.ts`
 * documents: a module that threw during EVALUATION is memoized as rejected by
 * Node's ESM loader, so a retry re-runs `buildBootstrapClients` but that one
 * module's `import()` replays its cached rejection. Every per-client load is
 * individually fail-soft, so that case degrades one analyzer, not the set.
 */
export function loadBootstrapClients(): Promise<BootstrapClients> {
	// The memo short-circuit sits ABOVE the flight check deliberately, and is
	// written only on success — so it can never hide the in-flight path from a
	// concurrent caller the way #1690's did. Before the first success there is
	// no memo, which is exactly the window sharing has to cover.
	if (residentClients) return Promise.resolve(residentClients);
	// #2467: refuse to START a load after primary shutdown, but never
	// invalidate a waiter. `has()` is the whole guard: when a flight is already
	// running the call below joins it, so the demand that was mid-air when
	// shutdown landed still settles with real clients.
	if (bootstrapShutdown && !bootstrapFlight.has(BOOTSTRAP_FLIGHT_KEY)) {
		return Promise.reject(
			new BootstrapUnavailableError(
				"shutdown",
				"analyzer bootstrap declined: primary session is shutting down",
			),
		);
	}
	// Unlike the shutdown gate above, this one has no `!has()` half: strikes
	// only ever reach the limit inside `noteBootstrapBuildFailure`, which runs
	// synchronously INSIDE this flight's own callback, immediately before it
	// rethrows and the flight's `release` runs — there is no synchronous window
	// in which a fresh call can observe strikes at the limit while that same
	// flight is still registered. A `!has()` half here would only ever be
	// false, so it stayed an untested branch (#2467 review, F2) rather than a
	// second guard.
	if (bootstrapFailureStrikes >= BOOTSTRAP_FAILURE_STRIKE_LIMIT) {
		return Promise.reject(
			new BootstrapUnavailableError(
				"latched",
				`analyzer bootstrap declined: ${bootstrapFailureStrikes} consecutive load failures`,
			),
		);
	}
	return bootstrapFlight.run(BOOTSTRAP_FLIGHT_KEY, async () => {
		const attempt = (bootstrapLoadAttempts += 1);
		const startedAt = Date.now();
		let clients: BootstrapClients;
		try {
			clients = await buildBootstrapClients();
		} catch (err) {
			noteBootstrapBuildFailure(err);
			throw err;
		}
		// A SUCCESS is what makes the strikes consecutive rather than a running
		// total, so one bad build in a healthy process never edges the latch shut.
		bootstrapFailureStrikes = 0;
		residentClients = clients;
		// The one timing record #2467's observability section keeps. It used to
		// be emitted by `handleSessionStart` from timestamps `index.ts` took
		// around its eager pre-handler load; now it is emitted where the load
		// actually happens, so it stays truthful once the load is on demand.
		// `attempt` distinguishes a retry from the initial attempt without
		// adding a per-demand record.
		logLatency({
			type: "phase",
			phase: "bootstrap_clients_load",
			filePath: process.cwd(),
			startedAt: new Date(startedAt).toISOString(),
			durationMs: Date.now() - startedAt,
			metadata: { attempt },
		});
		return clients;
	});
}

/**
 * Count a failed build and, on the transition that closes the latch, write the
 * ONE durable row saying this environment has stopped being retried.
 *
 * `recordDegradationOnce` is the repo's own once-per-kind/subject recorder, so
 * the latch needs no parallel "have I logged this yet" boolean beside the one
 * the ledger already keeps.
 */
function noteBootstrapBuildFailure(err: unknown): void {
	bootstrapFailureStrikes += 1;
	if (bootstrapFailureStrikes !== BOOTSTRAP_FAILURE_STRIKE_LIMIT) return;
	recordDegradationOnce({
		kind: "analyzer-bootstrap-latched",
		subject: BOOTSTRAP_FLIGHT_KEY,
		reason: `${BOOTSTRAP_FAILURE_STRIKE_LIMIT} consecutive load failures; no further builds this session: ${
			(err as Error)?.message ?? String(err)
		}`,
	});
}

/**
 * The BOUNDED, FAIL-OPEN accessor (#2467).
 *
 * Bounds the caller's WAIT on both axes AGENTS.md's both-bounds rule names —
 * a wall-clock ceiling AND the caller's abort signal — and answers `null`
 * instead of throwing, so the caller proceeds without the clients. Every
 * `null` caused by the SEAM (shutdown, timeout, a rejected load, or the
 * strike latch) is counted in the degradation ledger under
 * `analyzer-bootstrap-unavailable`, rising-edge per subject, so a repeated
 * failure stays one record with an exact count rather than per-demand spam.
 * A `null` caused by the CALLER'S OWN signal firing is not: that is the
 * caller choosing to stop waiting (Escape, a turn ending), not the analyzer
 * graph degrading, and counting it inverted the two in `pilens_health`.
 */
export async function requestBootstrapClients(options: {
	/** Who is asking. Becomes the ledger subject, so keep it stable and coarse. */
	reason: string;
	/**
	 * Which HOOK the demand runs under (#2557 review F7).
	 *
	 * Separate from {@link reason} because they answer different questions and
	 * a ledger row needs both: the hook says whose wall budget the wait is
	 * spending, the reason says which demand spent it. Passing the reason as
	 * the hook — what this seam did before — put `"session-start-scans"` on the
	 * ledger's hook axis, where nothing could join it against
	 * `HOOK_WALL_BUDGET_MS` or against any other hook-keyed record.
	 */
	hook: LedgerHookKey;
	/** The caller's abort signal (turn abort / Escape). */
	signal?: AbortSignal;
	/** Override the default wall-clock ceiling. */
	timeoutMs?: number;
}): Promise<BootstrapClients | null> {
	if (residentClients) return residentClients;
	// The seam's own session-teardown bound travels with EVERY demand, so a
	// caller whose work is not turn-scoped (the two session-start schedulers)
	// still satisfies AGENTS.md's both-bounds rule without binding a turn
	// signal that would cancel it for the wrong reason.
	const shutdownSignal = bootstrapShutdownController.signal;
	const timeoutMs = options.timeoutMs ?? BOOTSTRAP_LOAD_TIMEOUT_MS;
	try {
		// #2523 slice 2: this used to be `awaitWithinBounds`, a private copy of
		// exactly what `bounded()` does — same three-way precedence, same
		// remove-the-listener-in-`finally`, same abandon-the-wait-keep-the-work
		// contract. `bounded()` is a true superset of it (it also records the
		// abandonment), so the copy is gone rather than kept in sync by hand.
		//
		// `undefined` here can only mean a bound fired: `loadBootstrapClients`
		// resolves `BootstrapClients` or rejects, never `undefined`.
		const clients = await bounded(loadBootstrapClients(), {
			ms: timeoutMs,
			// Genuinely absent for the three session-start schedulers — see
			// `SessionBootstrapAccess.request` for why binding a turn signal
			// there is the wrong bound. `shutdownSignal` is the second live
			// bound in that case, so both still hold.
			signal: options.signal,
			shutdownSignal,
			// The hook on the hook axis, the demand on the label (#2557 F7).
			// `<hook>:loadBootstrapClients:<reason>` joins against
			// `HOOK_WALL_BUDGET_MS` and still says WHICH demand blew the budget.
			hook: options.hook,
			label: `loadBootstrapClients:${options.reason}`,
		});
		if (clients) return clients;
		throw abandonedError(options.signal, shutdownSignal, timeoutMs);
	} catch (err) {
		const unavailableReason =
			err instanceof BootstrapUnavailableError
				? err.unavailableReason
				: "failed";
		// "aborted" means the CALLER'S OWN signal fired — a user pressing Escape
		// mid-tool-call, a turn ending. That is the caller choosing to stop
		// waiting, not the analyzer graph degrading, and writing it to the ledger
		// inverted the two: a deliberate cancel surfaced identically to an
		// unhealthy environment in `pilens_health`. `shutdown`/`timeout`/`failed`/
		// `latched` all describe the SEAM failing to serve the demand, so those
		// still count.
		if (unavailableReason !== "aborted") {
			emitBounded(
				"bootstrap_clients_unavailable",
				options.reason,
				{
					durationMs: 0,
					metadata: {
						unavailableReason,
						attempt: bootstrapLoadAttempts,
						detail: (err as Error)?.message ?? String(err),
					},
				},
				{
					ledgerKind: "analyzer-bootstrap-unavailable",
					risingEdgePer: "identity",
					reason: unavailableReason,
				},
			);
		}
		return null;
	}
}

/**
 * Which bound won, read off the caller's own signal rather than guessed.
 *
 * Read AFTER `bounded()` has settled, exactly as the deleted `awaitWithinBounds`
 * read it after its own race — and in the same precedence `bounded()` applies
 * internally (caller, then teardown, then the clock), so the reason this
 * reconstructs is the reason that fired.
 */
function abandonedError(
	signal: AbortSignal | undefined,
	shutdownSignal: AbortSignal,
	timeoutMs: number,
): BootstrapUnavailableError {
	if (signal?.aborted) {
		return new BootstrapUnavailableError(
			"aborted",
			"analyzer bootstrap wait abandoned: caller aborted",
		);
	}
	if (shutdownSignal.aborted) {
		return new BootstrapUnavailableError(
			"shutdown",
			"analyzer bootstrap wait abandoned: primary session is shutting down",
		);
	}
	return new BootstrapUnavailableError(
		"timeout",
		`analyzer bootstrap wait abandoned after ${timeoutMs}ms`,
	);
}

/**
 * Refuse NEW loads from here on — the primary session is tearing down.
 *
 * Deliberately does NOT clear `residentClients` or the in-flight entry: a
 * demand already waiting must still settle (#2467), and the clients a
 * completed load produced stay usable for whatever teardown work is still
 * draining. Nothing here spawns, which is what AGENTS.md's #234 teardown rule
 * requires of a `session_shutdown`-time call.
 */
export function markAnalyzerBootstrapShutdown(): void {
	bootstrapShutdown = true;
	// Unparks any bounded demand still waiting on a load rather than leaving it
	// to burn the full wall-clock ceiling for clients its session will never use.
	bootstrapShutdownController.abort();
}

/**
 * Re-arm the shutdown gate at `session_start`.
 *
 * The gate is a per-SESSION claim ("this session is over") held in
 * process-lived storage — AGENTS.md defect shape 17 exactly. Without this a
 * replacement session in the same process would find the analyzers refused
 * for the rest of the process. The resident clients are NOT dropped: see
 * `residentClients`' own comment for why re-paying the load at every session
 * boundary would be wrong.
 */
export function resetAnalyzerBootstrapSessionState(): void {
	bootstrapShutdown = false;
	bootstrapShutdownController = new AbortController();
	// The strike latch is a per-SESSION claim too: an environment repaired
	// between sessions (a dependency installed, a package layout fixed) must be
	// retried, not written off for the life of the process.
	bootstrapFailureStrikes = 0;
}

/**
 * Is the shutdown gate closed — i.e. would a fresh demand be refused?
 *
 * A synchronous read of the same flag {@link loadBootstrapClients} checks,
 * so the session-state registry's probe can prove the session_start reset
 * re-arms it without awaiting a load.
 */
export function isAnalyzerBootstrapShutdown(): boolean {
	return bootstrapShutdown;
}

/**
 * How many consecutive builds have failed — the session-state registry's probe
 * for the strike latch, which cannot be read off {@link isAnalyzerBootstrapShutdown}.
 */
export function _analyzerBootstrapFailureStrikes(): number {
	return bootstrapFailureStrikes;
}

/** Test-only: close the strike latch without paying three real failed builds. */
export function _armAnalyzerBootstrapLatchForTests(): void {
	bootstrapFailureStrikes = BOOTSTRAP_FAILURE_STRIKE_LIMIT;
}

/** Test-only: drop the resident clients, the flight, and the gate. */
export function _resetAnalyzerBootstrapForTests(): void {
	residentClients = null;
	bootstrapShutdown = false;
	bootstrapShutdownController = new AbortController();
	bootstrapFailureStrikes = 0;
	bootstrapLoadAttempts = 0;
	bootstrapFlight.clear();
}

/** Test/diagnostic: how many builds have been STARTED this process. */
export function _analyzerBootstrapLoadAttempts(): number {
	return bootstrapLoadAttempts;
}

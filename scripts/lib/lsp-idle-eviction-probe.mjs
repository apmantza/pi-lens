// The per-server idle-eviction measurement (#3645): spawn a server on its smoke
// fixture, record what it reports, let the REAL idle-eviction timer release it,
// respawn it through the ordinary request path and compare what it reports
// now. Nothing here decides policy; the row it returns is evidence for the
// `idleEviction` declaration in clients/lsp/server.ts.
//
// Every side effect sits behind an injected driver (spawn, clock, process
// table), so the state machine is unit-testable with a virtual clock and no
// real child. `createServiceDriver` is the production driver over an
// `LSPService`; tests run it over the real service class with fake clients.

/** Fixture extension/basename match, the same rule `selectionReason` applies. */
function fixtureMatchesExtension(server, fixture) {
	const file = String(fixture.file ?? "");
	const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 ? base.slice(dot) : "";
	return server.extensions.some((value) => {
		const lower = String(value).toLowerCase();
		return lower === ext || lower === base;
	});
}

/**
 * The smoke fixture that exercises `server`, or null when none does. Order is
 * explicit identity first (a fixture that names the server), then a fixture
 * that lists it as an auxiliary, then the language fixture whose file the
 * server's extensions claim. A fixture chosen by the last rule can still
 * route to a different server; the probe verifies the target is alive after
 * the first touch and reports `server-not-started` otherwise, so a wrong
 * guess is a disclosed gap and never a wrong measurement.
 *
 * @param {{ id: string, extensions: readonly string[] }} server
 * @param {readonly Record<string, any>[]} fixtures
 */
export function selectFixtureForServer(server, fixtures) {
	const usable = fixtures.filter((f) => !f.clean && !f.customServer);
	return (
		usable.find(
			(f) => f.serverId === server.id || f.expectServerId === server.id,
		) ??
		usable.find((f) => f.auxiliaryServerIds?.includes(server.id)) ??
		usable.find(
			(f) =>
				!f.serverId &&
				!f.expectServerId &&
				!f.auxiliaryServerIds?.length &&
				fixtureMatchesExtension(server, f),
		) ??
		null
	);
}

/**
 * The measurement population: one entry per registry server, in registry
 * order, with the fixture that exercises it (or null). The nightly iterates
 * exactly this list, so a server added to the registry appears as a row (or an
 * explicit `no-fixture` one) with no edit here.
 */
export function probePopulation(servers, fixtures) {
	return servers.map((server) => ({
		server,
		fixture: selectFixtureForServer(server, fixtures),
	}));
}

/**
 * Measure every server of the registry in order. `probe({ server, fixture })`
 * returns one row; `beforeEach` runs before each probe (the script resets the
 * LSP service there, so one server's state never reaches the next row). A
 * server reached after `budgetMs` still gets a row, marked `budget-exhausted`:
 * a coverage gap is disclosed, never silently dropped. `filter`, when
 * non-empty, limits the run to those ids.
 */
export async function measureRegistry({
	registry,
	fixtures,
	filter = [],
	budgetMs,
	now,
	probe,
	beforeEach,
}) {
	// The registry module itself, not an array the caller could slice: the only
	// population this walks is `registry.LSP_SERVERS` (review round 1 F2).
	const servers = registry.LSP_SERVERS;
	const startedAt = now();
	const rows = [];
	for (const { server, fixture } of probePopulation(servers, fixtures)) {
		if (filter.length > 0 && !filter.includes(server.id)) continue;
		if (now() - startedAt > budgetMs) {
			rows.push({
				serverId: server.id,
				role: server.role === "auxiliary" ? "auxiliary" : "primary",
				declared: server.idleEviction,
				fixture: null,
				result: "unavailable",
				reason: "budget-exhausted",
			});
			continue;
		}
		await beforeEach?.();
		rows.push(await probe({ server, fixture }));
	}
	return rows;
}

/** Stable identity of one finding, independent of its position in a list. */
export function findingKey(d) {
	const r = d.range ?? {};
	return [
		d.serverId ?? "",
		d.source ?? "",
		d.code ?? "",
		d.severity ?? "",
		`${r.start?.line}:${r.start?.character}-${r.end?.line}:${r.end?.character}`,
		d.message ?? "",
	].join("|");
}

/** Keys present in `before` and absent from `after` (narrowing, or widening when swapped). */
function missingKeys(before, after) {
	const kept = new Set(after);
	return [...before].filter((key) => !kept.has(key));
}

/**
 * Sum of resident bytes over `pid` and every descendant. `deps` is injected:
 * `readProcessPairs()` resolves to `[pid, ppid][]`, or null when the process
 * table could not be read, `sampleRss(pids)` resolves to a pid -> bytes Map,
 * and `walkDescendantPids(root, pairs)` is the shared tree walk. A tree that
 * cannot be read is `null` (rendered `n/a`), never zero.
 */
export async function residentTreeBytes(pid, deps) {
	if (!Number.isFinite(pid) || pid <= 0) return null;
	const pairs = await deps.readProcessPairs();
	if (pairs === null) return null;
	const pids = [pid, ...deps.walkDescendantPids(pid, pairs)];
	const usage = await deps.sampleRss(pids);
	if (usage === null || !usage.has(pid)) return null;
	let total = 0;
	for (const bytes of usage.values()) total += bytes;
	return total;
}

const unavailable = (base, reason) => ({
	...base,
	result: "unavailable",
	reason,
});

/**
 * Measure one registry server.
 *
 * @param {{
 *   server: { id: string, idleEviction: string, role?: string },
 *   fixture: Record<string, any> | null,
 *   createDriver: (fixture: Record<string, any>) => IdleEvictionDriver,
 *   budgets: { baselineAttempts: number, baselineSettleMs: number, evictionWaitMs: number, recordWaitMs: number, pollMs: number, coldStartWaitMs: number },
 * }} args
 *
 * @typedef {Object} IdleEvictionDriver
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => Promise<string | undefined>} prepare  an unavailable reason code, or undefined when ready
 * @property {() => Promise<Record<string, any>[] | undefined>} touch  findings; undefined when no client became ready
 * @property {() => boolean} isTargetAlive
 * @property {() => number} evictionsRecorded  idle evictions observed on the armed client so far
 * @property {() => Promise<number | null>} rssBytes
 * @property {() => Promise<() => void>} armEviction  makes the target evictable, returns the restore
 * @property {() => Promise<void>} dispose
 */
export async function probeServer({ server, fixture, createDriver, budgets }) {
	const role = server.role === "auxiliary" ? "auxiliary" : "primary";
	const base = {
		serverId: server.id,
		role,
		declared: server.idleEviction,
		fixture: fixture?.lang ?? null,
	};
	if (!fixture) return unavailable(base, "no-fixture");

	const driver = createDriver(fixture);
	let restore = () => {};
	try {
		const notReady = await driver.prepare();
		if (notReady) return unavailable(base, notReady);

		// Baseline: a scanner's first scan may overrun and only cache its result,
		// so an empty answer is re-asked a bounded number of times.
		const auxRe =
			role === "auxiliary" && fixture.auxiliarySourceMatch
				? new RegExp(fixture.auxiliarySourceMatch, "i")
				: null;
		const attributed = (findings) =>
			findings.filter((d) =>
				auxRe
					? d.serverId === server.id || auxRe.test(d.source ?? "")
					: d.serverId === undefined || d.serverId === server.id,
			);
		let initMs;
		let baseline;
		let touched = false;
		for (let attempt = 1; attempt <= budgets.baselineAttempts; attempt++) {
			const startedAt = driver.now();
			let findings;
			try {
				findings = await driver.touch();
			} catch {
				return { ...base, result: "inconclusive", reason: "probe-error" };
			}
			if (findings === undefined) break;
			touched = true;
			initMs ??= driver.now() - startedAt;
			baseline = attributed(findings);
			if (baseline.length > 0) break;
			if (attempt < budgets.baselineAttempts)
				await driver.sleep(budgets.baselineSettleMs);
		}
		if (!touched || !driver.isTargetAlive())
			return unavailable(base, "server-not-started");
		if (!baseline || baseline.length === 0) {
			return {
				...base,
				result: "inconclusive",
				reason: "no-baseline",
				initMs,
				coverage: "unproven",
			};
		}
		const baselineKeys = new Set(baseline.map(findingKey));
		let rssBytes = null;
		try {
			rssBytes = await driver.rssBytes();
		} catch {
			// An unreadable process table is `n/a`, not a failed measurement.
		}
		const measured = { ...base, initMs, rssBytes };

		const evictionsBefore = driver.evictionsRecorded();
		restore = await driver.armEviction();
		const armedAt = driver.now();
		while (driver.isTargetAlive()) {
			if (driver.now() - armedAt >= budgets.evictionWaitMs) {
				return {
					...measured,
					result: "inconclusive",
					reason: "not-evicted",
					respawn: "not-evicted",
				};
			}
			await driver.sleep(budgets.pollMs);
		}
		// The client stops being alive when it is retired, before the timer's
		// teardown finishes and its eviction record lands. Wait for the record, so
		// a server that simply died is never read as evicted and respawned.
		const releasedAt = driver.now();
		while (driver.evictionsRecorded() <= evictionsBefore) {
			if (driver.now() - releasedAt >= budgets.recordWaitMs) {
				return {
					...measured,
					result: "inconclusive",
					reason: "client-died",
					respawn: "not-evicted",
				};
			}
			await driver.sleep(budgets.pollMs);
		}
		// Disarm before the respawn so the replacement is not evicted again while
		// its cold-start is being timed.
		restore();

		const evictedAt = driver.now();
		let respawned = false;
		let narrowed = [];
		while (driver.now() - evictedAt < budgets.coldStartWaitMs) {
			let findings;
			try {
				findings = await driver.touch();
			} catch {
				findings = undefined;
			}
			if (findings !== undefined && driver.isTargetAlive()) {
				respawned = true;
				const postKeys = attributed(findings).map(findingKey);
				narrowed = missingKeys(baselineKeys, postKeys);
				if (narrowed.length === 0) {
					// Extra findings are not a veto, but they are disclosed: a first scan
					// that grows on respawn may have been partial.
					const widened = missingKeys(new Set(postKeys), baselineKeys).length;
					return {
						...measured,
						result: "eligible",
						respawn: "ok",
						coldStartMs: driver.now() - evictedAt,
						coverage: "preserved",
						...(widened > 0 ? { widened } : {}),
					};
				}
			}
			await driver.sleep(budgets.pollMs);
		}
		return respawned
			? {
					...measured,
					result: "vetoed",
					reason: "findings-narrowed",
					respawn: "ok",
					coverage: "narrowed",
				}
			: {
					...measured,
					result: "vetoed",
					reason: "respawn-failed",
					respawn: "failed",
				};
	} catch {
		return { ...base, result: "inconclusive", reason: "probe-error" };
	} finally {
		restore();
		await driver.dispose().catch(() => {});
	}
}

/**
 * The production driver over an `LSPService`. `target` is filled in by
 * `prepare` once the fixture workspace exists.
 *
 * Eviction is measured through the service's own idle timer, not a parallel
 * retire path: arming flips `server.idleEviction` to `transparent` on the
 * registry object the service reads, shortens the shared window, and issues
 * one ordinary request so the timer is scheduled under the new policy (a timer
 * is scheduled at spawn and at use, never retroactively). `restore` puts both
 * back. Nothing is changed in any other process.
 *
 * @param {{
 *   lsp: any,
 *   server: { id: string, idleEviction: string },
 *   target: { absFile: string, content: string },
 *   windowMs: number,
 *   touchBudgets: { maxClientWaitMs: number, maxDiagnosticsWaitMs: number },
 *   residentBytesOf: (pid: number) => Promise<number | null>,
 *   prepare: () => Promise<string | undefined>,
 *   dispose: () => Promise<void>,
 *   now: () => number,
 *   sleep: (ms: number) => Promise<void>,
 *   env?: Record<string, string | undefined>,
 * }} args
 * @returns {IdleEvictionDriver}
 */
export function createServiceDriver(args) {
	const { lsp, server, target } = args;
	const env = args.env ?? process.env;
	// The registry, not the fixture, says whether this is a scanner (`role`;
	// opengrep, ast-grep, zizmor and typos today). Only the target is attached,
	// so another scanner's spawn and eviction never enter the row.
	const isAuxiliary = server.role === "auxiliary";
	const auxIds = isAuxiliary ? [server.id] : [];
	const touchOptions = {
		diagnostics: "document",
		collectDiagnostics: true,
		clientScope: auxIds.length ? "with-auxiliary" : "primary",
		...(auxIds.length ? { auxiliaryServerIds: auxIds } : {}),
		maxClientWaitMs: args.touchBudgets.maxClientWaitMs,
		maxDiagnosticsWaitMs: args.touchBudgets.maxDiagnosticsWaitMs,
		source: "lsp-idle-eviction-probe",
	};
	// Idle evictions observed on the armed client's own shutdown. The service's
	// eviction path calls `client.shutdown({ reason: "idle_eviction" })`, which no
	// other retirement does, so a release counted here is an eviction and a client
	// that merely stopped being alive is not. The degradation ledger records the
	// same event but caps at 32 distinct kinds and folds later ones into `other`,
	// so it cannot be the witness (review round 1 F4).
	let evictions = 0;
	// One ordinary request for the target's client: the spawned entry when it is
	// warm, and the use that (re)schedules its idle timer.
	const acquire = async () =>
		isAuxiliary
			? (
					await lsp.getAuxiliaryClientsForFile(
						target.absFile,
						new Set([server.id]),
					)
				)[0]
			: await lsp.getClientForFile(target.absFile);
	return {
		now: args.now,
		sleep: args.sleep,
		prepare: args.prepare,
		dispose: args.dispose,
		async touch() {
			const result = await lsp.touchFile(
				target.absFile,
				target.content,
				touchOptions,
			);
			const diags = Array.isArray(result) ? result : result?.diags;
			return diags === undefined ? undefined : [...diags];
		},
		isTargetAlive: () => lsp.getAliveServerIds().includes(server.id),
		evictionsRecorded: () => evictions,
		async rssBytes() {
			const pid = (await acquire())?.client?.getProcessPid?.();
			return pid === undefined ? null : args.residentBytesOf(pid);
		},
		async armEviction() {
			const policy = server.idleEviction;
			const hadGenericWindow = Object.hasOwn(env, "PI_LENS_LSP_IDLE_EVICT_MS");
			const priorGenericWindow = env.PI_LENS_LSP_IDLE_EVICT_MS;
			const hadEphemeralWindow = Object.hasOwn(
				env,
				"PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS",
			);
			const priorEphemeralWindow = env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS;
			let restored = false;
			const restore = () => {
				if (restored) return;
				restored = true;
				server.idleEviction = policy;
				if (hadGenericWindow)
					env.PI_LENS_LSP_IDLE_EVICT_MS = priorGenericWindow;
				else delete env.PI_LENS_LSP_IDLE_EVICT_MS;
				if (hadEphemeralWindow)
					env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS = priorEphemeralWindow;
				else delete env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS;
			};
			server.idleEviction = "transparent";
			env.PI_LENS_LSP_IDLE_EVICT_MS = String(args.windowMs);
			env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS = String(args.windowMs);
			try {
				const client = (await acquire())?.client;
				if (client && typeof client.shutdown === "function") {
					const original = client.shutdown;
					const observed = async function (...shutdownArgs) {
						try {
							return await original.apply(this, shutdownArgs);
						} finally {
							if (shutdownArgs[0]?.reason === "idle_eviction") evictions += 1;
						}
					};
					client.shutdown = observed;
				}
			} catch (err) {
				restore();
				throw err;
			}
			return restore;
		},
	};
}

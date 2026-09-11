/**
 * One production-faithful double for `clients/bootstrap.ts`'s module shape
 * (#2467).
 *
 * Thirty-odd `vi.mock("…/bootstrap.js")` factories used to return a single
 * `loadBootstrapClients` key. That was enough while the module exported one
 * accessor; it is not enough now that `index.ts` and `clients/runtime-tool-call.ts`
 * consume the on-demand seam as well, and a named import of a key the factory
 * omits fails at link time rather than at the assertion that cares. Worse, a
 * factory that supplied `loadBootstrapClients` alone while production had
 * moved to `requestBootstrapClients` would be the inert double AGENTS.md keeps
 * catching: green, and testing nothing.
 *
 * So the module shape lives here once. A new bootstrap export lands in every
 * mock at the same moment instead of being discovered one red suite at a time.
 *
 * Fidelity on the axis these tests exercise:
 *
 * - `requestBootstrapClients` resolves through the SAME loader as
 *   `loadBootstrapClients`, so a test cannot pass because the fail-open path
 *   quietly returned a different (or absent) client set.
 * - `peekBootstrapClients` answers `null` until a load has actually completed,
 *   exactly as production does — a peek that pretended the clients were
 *   already resident would hide the very laziness this issue introduced.
 */

/**
 * NOTHING here may statically import `clients/bootstrap.js`: this module is
 * loaded from INSIDE `vi.doMock` factories for that module, and importing the
 * module under mock from its own factory deadlocks resolution — every case in
 * `bootstrap-lazy-liveness.test.ts` sat until its 30s timeout. The
 * fixture-side `withResidentBootstrap` wrapper therefore lives in
 * `bootstrap-access.ts`.
 */

import { agentBehaviorClient } from "../../clients/agent-behavior-client.js";

/** The options `requestBootstrapClients` is called with in production. */
interface BootstrapDemandOptions {
	reason: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** The module shape a `vi.mock` factory for `clients/bootstrap.js` must return. */
export interface BootstrapSeamMock {
	loadBootstrapClients: () => Promise<unknown>;
	requestBootstrapClients: (
		options?: BootstrapDemandOptions,
	) => Promise<unknown>;
	peekBootstrapClients: () => unknown;
	markAnalyzerBootstrapShutdown: () => void;
	resetAnalyzerBootstrapSessionState: () => void;
	isAnalyzerBootstrapShutdown: () => boolean;
	residentBootstrapAccess: (clients: unknown) => {
		peek: () => unknown;
		request: () => Promise<unknown>;
	};
	degradedClient: () => unknown;
	/** Process-wide behaviour history, available before bootstrap (#2523). */
	getAgentBehaviorClient: () => unknown;
	BOOTSTRAP_LOAD_TIMEOUT_MS: number;
}

/**
 * Build the module double from the loader a call site already wrote.
 *
 * Pass the existing `async () => ({ …clients })` arrow unchanged; everything
 * else is derived from it.
 */
export function bootstrapSeamMock(
	load: () => Promise<unknown>,
): BootstrapSeamMock {
	let resident: unknown = null;
	let shutdown = false;
	const loadOnce = async (): Promise<unknown> => {
		const clients = await load();
		resident = clients;
		return clients;
	};
	return {
		loadBootstrapClients: loadOnce,
		// Production CONSUMES the caller's signal: an already-aborted one ends
		// the wait and the demand answers `null` (fail open). A double that
		// ignored it would turn every "this signal must not be bound here"
		// assertion green without the seam ever honouring one — the inert
		// double AGENTS.md keeps catching.
		requestBootstrapClients: async (options?: BootstrapDemandOptions) => {
			if (options?.signal?.aborted) return null;
			if (shutdown && resident === null) return null;
			return await loadOnce();
		},
		peekBootstrapClients: () => resident,
		markAnalyzerBootstrapShutdown: () => {
			shutdown = true;
		},
		resetAnalyzerBootstrapSessionState: () => {
			shutdown = false;
		},
		isAnalyzerBootstrapShutdown: () => shutdown,
		// Deliberately re-stated rather than delegated: see this file's header
		// for why nothing here may import the module it doubles. The
		// fixture-side wrapper (`bootstrap-access.ts`) is the one that
		// delegates to production.
		residentBootstrapAccess: (clients: unknown) => ({
			peek: () => clients,
			request: async () => clients,
		}),
		degradedClient: () => ({}),
		// The real seam returns the process-wide singleton, which is not a
		// bootstrap client and needs no load; the double returns the same
		// singleton so the read-only tool_result path records exactly as in
		// production (#2523 round 4 added the export; #2897 verify v4 F2).
		getAgentBehaviorClient: () => agentBehaviorClient,
		BOOTSTRAP_LOAD_TIMEOUT_MS: 10_000,
	};
}

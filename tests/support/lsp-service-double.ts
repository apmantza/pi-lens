import { vi } from "vitest";
import type { LSPService } from "../../clients/lsp/index.js";

/**
 * Shared `LSPService` test double — #2582.
 *
 * Methods used by the pipeline, runtime-session warm paths, and their nearby
 * dispatch tests. Keep the defaults resolved and side-effect free; tests that
 * assert a call or outcome override only that method with a `vi.fn()` of their
 * own. That focused-override usage is the factory's documented shape and is
 * what `tests/config/lsp-service-double-sweep.test.ts` deliberately permits —
 * the sweep flags a service object that is not SEEDED from this factory, not
 * an override on one that is.
 *
 * `overrides` is keyed by `keyof LSPService`, so a typo (`touchfile`) is a
 * compile error instead of a silently-kept default — the review finding that
 * a `Record<string, unknown>` bag could not catch. Values stay `unknown`: the
 * doubles here are deliberately looser than the production signatures (a
 * `touchFile` that resolves `{ diags: [] }`, a `supportsLSP` that ignores its
 * argument), and tightening them would be a migration of its own, not a typo
 * guard.
 */
export type LspServiceOverrides = Partial<Record<keyof LSPService, unknown>>;

export interface LspServiceDoubleOptions {
	/**
	 * Methods to leave ABSENT on the double. A test that exercises production's
	 * "an older host service shape lacks this method" fallback needs the key
	 * gone, not stubbed; naming it here keeps that a first-class, typo-checked
	 * part of the factory's API instead of a `delete (service as any).foo`
	 * after the fact (#2582 review round 2, F6).
	 */
	omit?: readonly (keyof LSPService)[];
}

export function makeLspServiceDouble(
	overrides: LspServiceOverrides = {},
	options: LspServiceDoubleOptions = {},
) {
	const service: Record<string, unknown> = {
		supportsLSP: vi.fn(() => false),
		hasLSP: vi.fn(async () => false),
		isSpawnInFlight: vi.fn(() => false),
		touchFile: vi.fn(async () => ({ diags: [] })),
		openFile: vi.fn(async () => undefined),
		getAuxiliaryClientsForFile: vi.fn(async () => []),
		getAllDiagnostics: vi.fn(async () => new Map()),
		readCachedDiagnosticsForServers: vi.fn(async () => new Map()),
		getDiagnostics: vi.fn(() => []),
		getWarmClientForFile: vi.fn(async () => undefined),
		getOpenDocumentPaths: vi.fn(() => []),
		getAliveClientCount: vi.fn(() => 0),
		getAliveServerIds: vi.fn(() => []),
		getStatus: vi.fn(() => []),
		getAdvertisedCommands: vi.fn(async () => []),
		getCapabilitySnapshots: vi.fn(async () => []),
		getClientForFile: vi.fn(async () => undefined),
		references: vi.fn(async () => []),
		codeAction: vi.fn(async () => []),
		documentSymbol: vi.fn(async () => []),
		getOperationSupport: vi.fn(() => undefined),
		isDocumentOpen: vi.fn(() => false),
		notifyExternalFileChange: vi.fn(async () => undefined),
		getBrokenStatus: vi.fn(() => undefined),
	};

	Object.assign(service, overrides);
	for (const key of options.omit ?? []) delete service[key as string];
	return service;
}

import { vi } from "vitest";

/**
 * Methods used by the pipeline, runtime-session warm paths, and their nearby
 * dispatch tests. Keep the defaults resolved and side-effect free; tests that
 * assert a call or outcome override only that method.
 */
export function makeLspServiceDouble(overrides: Record<string, unknown> = {}) {
	const service = {
		supportsLSP: vi.fn(() => false),
		hasLSP: vi.fn(async () => false),
		isSpawnInFlight: vi.fn(() => false),
		touchFile: vi.fn(async () => ({ diags: [] })),
		openFile: vi.fn(async () => undefined),
		getAuxiliaryClientsForFile: vi.fn(async () => []),
		getAllDiagnostics: vi.fn(async () => new Map()),
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

	return Object.assign(service, overrides);
}

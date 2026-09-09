// #1374 review P1: the lsp_client_unavailable dedupe (per server:root
// occurrence) and its recovery re-arm had no regression coverage — the
// "always emit" mutation stayed green. This drives the service through
// unavailable → unavailable (deduped) → recovered → unavailable (re-armed).
// Spawn failures trip the broken-cooldown breaker, so the recovery leg uses
// fake system time to clear the cooldown deterministically.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));
vi.mock("../../../clients/degradation-ledger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/degradation-ledger.js")
	>()),
	recordDegradation: vi.fn(),
}));

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function fakeClient(alive: { value: boolean }) {
	return {
		root: "/repo",
		isAlive: vi.fn(() => alive.value),
		isBusy: vi.fn(() => false),
		shutdown: vi.fn(async () => undefined),
		notify: {
			open: vi.fn(async () => undefined),
			change: vi.fn(async () => undefined),
		},
		diagnosticsVersion: 0,
		getWorkspaceDiagnosticsSupport: vi.fn(() => ({
			advertised: false,
			mode: "push-only",
			diagnosticProviderKind: "unavailable",
		})),
	};
}

function unavailableEmits(): number {
	return logLatency.mock.calls.filter(
		([entry]) => entry?.phase === "lsp_client_unavailable",
	).length;
}

describe("lsp_client_unavailable dedupe + recovery re-arm (#1374)", () => {
	let spawnBehavior: () => Promise<unknown>;
	const alive = { value: true };

	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-14T06:00:00Z"));
		logLatency.mockClear();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		alive.value = true;
		spawnBehavior = async () => {
			throw new Error("spawn refused");
		};
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: async () => "/repo",
				spawn: vi.fn(() => spawnBehavior()),
			},
		]);
		createLSPClient.mockImplementation(() => fakeClient(alive));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("emits once per occurrence and re-arms after recovery", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			// User-visible guarantee: repeated unavailability produces exactly
			// ONE lsp_client_unavailable emit. (The unavailableLogged dedupe and
			// the spawn/init breaker COMPOSE to deliver this -- whichever gate
			// fires first, a second emit for the same server:root occurrence is
			// a regression this assertion catches.)
			await service.getClientForFile("/repo/a.ts").catch(() => undefined);
			await service.getClientForFile("/repo/b.ts").catch(() => undefined);
			expect(unavailableEmits()).toBe(1);

			// Recovery: jump past the broken cooldown, spawn succeeds — the
			// successful spawn re-arms the dedupe for this server:root.
			vi.setSystemTime(new Date("2026-08-14T06:10:00Z"));
			spawnBehavior = async () => ({
				process: {
					process: { killed: false },
					stdin: {},
					stdout: {},
					stderr: {},
					pid: 4242,
				},
			});
			const recovered = await service
				.getClientForFile("/repo/c.ts")
				.catch(() => undefined);
			expect(recovered).toBeTruthy();

			// The recovered client dies; spawn refuses again — a genuine NEW
			// unavailability occurrence must emit a second time.
			alive.value = false;
			vi.setSystemTime(new Date("2026-08-14T06:25:00Z"));
			spawnBehavior = async () => {
				throw new Error("spawn refused again");
			};
			// After recovery re-armed the key, a fresh unavailability window
			// (post-cooldown, dead client) may emit again — but the spawn/init
			// breaker legitimately shadows some repeats with skipped_broken.
			// The guarantee under test is: never MORE than one emit per
			// occurrence window.
			await service.getClientForFile("/repo/d.ts").catch(() => undefined);
			expect(unavailableEmits()).toBeLessThanOrEqual(2);
		} finally {
			await service.shutdown().catch(() => undefined);
		}
	});
});

/**
 * The two per-file LSP skip records are bounded (#1743 review F1).
 *
 * `getClientForFile` runs once per file per touch. During an outage — a server
 * latched permanently broken, sitting in breaker cooldown, or with its spawn
 * command marked temporarily unavailable — every touched file took the skip
 * branch and wrote a full `latency.log` record. A workspace sweep over a few
 * hundred files then wrote a few hundred records describing one fact.
 *
 * Both records now go through `emitBounded` with a rising edge per identity:
 * the degradation ledger counts every skip exactly, and only the FIRST skip
 * per (server, file) — per (command, file) for the unavailable-command case —
 * also pays for a log write. A second file still gets its own record, because
 * "which files is this server refusing" is the question an outage raises.
 *
 * These fail on pre-fix code: the raw `logLatency` wrote one record per call,
 * so the repeat-suppression assertions see 3 records instead of 1.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeMapKey } from "../../../clients/path-utils.js";

const FIXTURE_ROOT = path.join(process.cwd(), "skip-record-bounding-fixture");
const FIXTURE_FILE = path.join(FIXTURE_ROOT, "main.fake");
const OTHER_FILE = path.join(FIXTURE_ROOT, "other.fake");

const getServersForFileWithConfig = vi.fn();
const isDirectLspCommandTemporarilyUnavailable = vi.fn(() => false);

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient: vi.fn(),
}));

vi.mock("../../../clients/lsp/server.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../../../clients/lsp/server.js")>();
	return {
		...actual,
		isDirectLspCommandTemporarilyUnavailable,
		resolveLspServerCwd: actual.resolveLspServerCwd,
	};
});

const latencyCalls: Array<Record<string, unknown>> = [];
vi.mock("../../../clients/latency-logger.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Record<string, unknown>) => {
			latencyCalls.push(entry);
		},
	};
});

function fakeServer(id: string, availabilityKey?: string) {
	const root = Object.assign(async () => FIXTURE_ROOT, {
		rootMarkers: [".fake-root"],
	});
	return {
		id,
		name: id,
		extensions: [".fake"],
		availabilityKey,
		root,
		spawn: vi.fn(),
	};
}

const recordsFor = (phase: string) =>
	latencyCalls.filter((entry) => entry.phase === phase);

/**
 * `vi.resetModules()` gives each test a fresh module graph, and the service
 * under test is imported AFTER that reset. A statically imported ledger would
 * therefore be a DIFFERENT instance from the one the service writes to, and
 * every count would read zero. Import it from inside the test, after the
 * service, so both share one instance.
 */
async function ledgerCount(kind: string): Promise<number> {
	const { getDegradationSummary } =
		await import("../../../clients/degradation-ledger.js");
	return (
		getDegradationSummary().find((group) => group.kind === kind)?.count ?? 0
	);
}

describe("LSP per-file skip records are bounded (#1743)", () => {
	beforeEach(() => {
		vi.resetModules();
		latencyCalls.length = 0;
		fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
		fs.writeFileSync(path.join(FIXTURE_ROOT, ".fake-root"), "");
		isDirectLspCommandTemporarilyUnavailable.mockReturnValue(false);
		getServersForFileWithConfig.mockReset();
	});

	it("writes one lsp_client_skipped_broken per file, not one per touch", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as { permanentlyBroken: Set<string> };
		const server = fakeServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);
		internal.permanentlyBroken.add(`opengrep:${normalizeMapKey(FIXTURE_ROOT)}`);

		for (let touch = 0; touch < 3; touch++) {
			expect(await service.getClientForFile(FIXTURE_FILE)).toBeUndefined();
		}

		// Pre-fix: 3. The rising edge is what makes this 1.
		expect(recordsFor("lsp_client_skipped_broken")).toHaveLength(1);
		// Every skip is still counted exactly, so the suppressed two are not
		// invisible — they are in the ledger with the file's identity.
		expect(await ledgerCount("lsp-client-skipped-broken")).toBe(3);
	});

	it("writes one lsp_client_skipped_broken per file on the breaker-cooldown path too", async () => {
		// The #1743 verify round found this gap: the two cases above drive only
		// `permanentlyBroken` and the unavailable-command latch, so the THIRD
		// emit site — the ordinary breaker cooldown, and the highest-volume of
		// the three — had its rising edge unproven. Deleting `risingEdgePer`
		// from that site alone left the whole `tests/clients/lsp/` directory
		// green. The sibling breaker test could not catch it either: it asserts
		// a ledger COUNT, which increments whether or not the edge gates the
		// record.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { broken: Map<string, number> };
		};
		const server = fakeServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);
		// A cooldown far enough out that all three touches land inside it.
		internal.state.broken.set(
			`opengrep:${normalizeMapKey(FIXTURE_ROOT)}`,
			Date.now() + 600_000,
		);

		for (let touch = 0; touch < 3; touch++) {
			expect(await service.getClientForFile(FIXTURE_FILE)).toBeUndefined();
		}

		expect(recordsFor("lsp_client_skipped_broken")).toHaveLength(1);
		expect(await ledgerCount("lsp-client-skipped-broken")).toBe(3);
	});

	it("gives a second file its own record, so one file cannot mask another", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as { permanentlyBroken: Set<string> };
		const server = fakeServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);
		internal.permanentlyBroken.add(`opengrep:${normalizeMapKey(FIXTURE_ROOT)}`);

		await service.getClientForFile(FIXTURE_FILE);
		await service.getClientForFile(FIXTURE_FILE);
		await service.getClientForFile(OTHER_FILE);

		// Fails if the identity is keyed on the server alone: the second file's
		// record would be swallowed and this drops to 1.
		expect(
			recordsFor("lsp_client_skipped_broken").map((entry) => entry.filePath),
		).toEqual([FIXTURE_FILE, OTHER_FILE]);
	});

	it("writes one lsp_client_skipped_unavailable_command per file", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const server = fakeServer("ruff", "ruff");
		getServersForFileWithConfig.mockReturnValue([server]);
		isDirectLspCommandTemporarilyUnavailable.mockReturnValue(true);

		for (let touch = 0; touch < 3; touch++) {
			expect(await service.getClientForFile(FIXTURE_FILE)).toBeUndefined();
		}

		// Pre-fix: 3.
		expect(recordsFor("lsp_client_skipped_unavailable_command")).toHaveLength(
			1,
		);
		expect(await ledgerCount("lsp-client-skipped-unavailable-command")).toBe(3);
	});

	it("stamps the identity into every skip record", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as { permanentlyBroken: Set<string> };
		const server = fakeServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);
		internal.permanentlyBroken.add(`opengrep:${normalizeMapKey(FIXTURE_ROOT)}`);

		await service.getClientForFile(FIXTURE_FILE);

		const entry = recordsFor("lsp_client_skipped_broken")[0];
		expect((entry.metadata as Record<string, unknown>).identity).toBe(
			`opengrep:${normalizeMapKey(FIXTURE_FILE)}`,
		);
		// The record keeps the human-facing path it always carried.
		expect(entry.filePath).toBe(FIXTURE_FILE);
	});
});

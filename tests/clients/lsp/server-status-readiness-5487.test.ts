// flake-shape: real-process-spawn — the order of the readiness notice, the empty pull and the empty publish comes from a real server over stdio; a stub cannot send that sequence
// flake-shape: elapsed-time-assertion — two cases assert a real touch ends well inside its budget (a failed workspace load must not spend the 60 s budget; a silent server must not hold the touch for loading time plus a whole budget); the bound is the behaviour under test and the margin is several seconds against a 900 ms fixture window
/**
 * #5487: a cold rust-analyzer touch read clean while the server was still
 * loading.
 *
 * Recurrence this file prevents: rust-analyzer answers `textDocument/diagnostic`
 * with an empty authoritative report (and publishes an empty set) about 12 ms
 * after the request while it loads its workspace, and pi-lens read that as a
 * clean file: 2 of 5 cold `pilens_diagnostics` calls on a file with a real
 * E0308 returned `clean=1` (review of #5486, F3). The server announces its
 * readiness through `experimental/serverStatus` (`quiescent`) to a client that
 * asks for it in `CLIENT_CAPABILITIES.experimental`.
 *
 * The real `LSPService` and `createLSPClient` run over the fixture server
 * (`tests/fixtures/fake-lsp-server.mjs`, `FAKE_LSP_LOADING_*`), which models
 * that cold start: empty answers until its loading window ends, and the status
 * notices only when the client asked. The server id is not in the strategy
 * table, so the touch budget is the default 1500 ms (a case caps it lower).
 * Ordering is by the fixture's own window and the touch's budget, never a
 * sleep in the test.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBoundedTelemetry } from "../../../clients/bounded-telemetry.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import { LSPService } from "../../../clients/lsp/index.js";
import type { LSPProcess } from "../../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { readNdjsonRows } from "../../support/ndjson-rows.js";
import { waitFor } from "../interleaving-kit.js";
import { removeTempDirSync } from "../test-utils.js";

const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));

/** The fixture finds an error in any document without this marker. */
const DIRTY = "let v: Vec<i32> = 1;\n";
const CLEAN = "// fake-lsp-clean\nfn main() {}\n";

/** The durable `latency.log` rows of the gated phase, drained first (shape 67). */
async function gatedRows() {
	await flushLatencyLog();
	return readNdjsonRows<{ phase?: string; metadata?: Record<string, unknown> }>(
		getLatencyLogPath(),
	).rows.filter((row) => row.phase === "lsp_server_loading_gated");
}

function gatedLedgerCount(): number {
	return (
		getDegradationSummary().find(
			(entry) => entry.kind === "lsp-server-loading-gated",
		)?.count ?? 0
	);
}

describe("a server that is still loading is not a clean file (#5487)", () => {
	let tmp: string;
	let service: LSPService;
	const procs: LSPProcess[] = [];
	// The durable sink is off in test mode; the rows case turns it on.
	const writeDurableLatencyRows = () => {
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
	};

	beforeEach(() => {
		_setServersForFileForTests(getServersForFileWithConfig);
		tmp = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-status-5487-")),
		);
		resetDegradationLedger();
		resetBoundedTelemetry();
		clearLatencyLog();
		service = new LSPService();
	});
	afterEach(async () => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		vi.unstubAllEnvs();
		await service.shutdown();
		procs.length = 0;
		removeTempDirSync(tmp);
	});

	/** One pull-mode "rust" server on `.fkr` files whose fixture env is `fixtureEnv`. */
	function register(fixtureEnv: Record<string, string>): string {
		const filePath = path.join(tmp, "main.fkr");
		const server = {
			id: "fake-rust",
			name: "fake-rust",
			extensions: [".fkr"],
			idleEviction: "resident",
			root: async () => tmp,
			spawn: async () => {
				const proc = await spawnFakeLspServer({
					cwd: tmp,
					env: { ...process.env, ...fixtureEnv },
				});
				procs.push(proc);
				return { process: proc, source: "test" };
			},
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".fkr") ? [server] : [],
		);
		return filePath;
	}

	const touch = (
		filePath: string,
		content: string,
		extra: { maxDiagnosticsWaitMs?: number } = {},
	) => {
		fs.writeFileSync(filePath, content);
		return service.touchFile(filePath, content, {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			source: "dispatch",
			...extra,
		});
	};

	// Before the fix the first pull's empty report was the verdict: `diags` [],
	// `confirmation: "confirmed"`, while the server was still loading.
	it("returns the error once the server reports quiescent, not a clean read", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "500",
			FAKE_LSP_LOADING_REFRESH: "1",
			FAKE_LSP_LOADING_PUSH_EMPTY: "1",
		});
		const result = await touch(filePath, DIRTY);

		expect(result?.diags).toEqual([
			expect.objectContaining({ code: "FAKE1001" }),
		]);
		expect(result?.inconclusive).not.toBe(true);
		expect(result?.confirmation).toBe("confirmed");
	}, 30_000);

	// Same cold start, a budget that ends first: the touch must say it does not
	// know, with the cause, instead of the clean read the empty answer would give.
	it("reports inconclusive with a loading reason when the budget ends first", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "20000",
			FAKE_LSP_LOADING_REFRESH: "1",
			FAKE_LSP_LOADING_PUSH_EMPTY: "1",
		});
		const result = await touch(filePath, DIRTY, { maxDiagnosticsWaitMs: 600 });

		expect(result?.diags).toEqual([]);
		expect(result?.inconclusive).toBe(true);
		expect(result?.inconclusiveReason).toBe("server-loading");
		expect(result?.inconclusiveServerIds).toEqual(["fake-rust"]);
		expect(result?.confirmation).not.toBe("confirmed");
	}, 30_000);

	it("confirms a genuinely clean file only after the server is quiescent, and a warm touch is not gated again", async () => {
		const filePath = register({ FAKE_LSP_LOADING_MS: "500" });

		const cold = await touch(filePath, CLEAN);
		expect(cold?.diags).toEqual([]);
		expect(cold?.confirmation).toBe("confirmed");
		const gatedAfterCold = gatedLedgerCount();
		expect(gatedAfterCold).toBeGreaterThan(0);

		const warm = await touch(filePath, `${CLEAN}// edit\n`);
		expect(warm?.confirmation).toBe("confirmed");
		expect(gatedLedgerCount()).toBe(gatedAfterCold);
	}, 30_000);

	// The recurrence guard for observability: many gated pulls, one record per
	// server per session, every occurrence counted in the ledger.
	it("writes one gated record per server per session while the ledger counts every occurrence", async () => {
		writeDurableLatencyRows();
		clearLatencyLog();
		const filePath = register({
			FAKE_LSP_LOADING_MS: "20000",
			FAKE_LSP_LOADING_REFRESH: "1",
			FAKE_LSP_LOADING_PUSH_EMPTY: "1",
		});
		await touch(filePath, DIRTY, { maxDiagnosticsWaitMs: 400 });
		await touch(filePath, `${DIRTY}// again\n`, { maxDiagnosticsWaitMs: 400 });

		const rows = await gatedRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata).toMatchObject({
			serverId: "fake-rust",
			quiescent: false,
		});
		expect(gatedLedgerCount()).toBeGreaterThan(1);
	}, 30_000);

	// rust-analyzer cancels the pulls it had queued when it goes quiescent
	// (-32802, measured on 1.99.1). The first pull after the wait is such a pull:
	// it must be asked again, not read as a server that went silent.
	it("asks again when the first pull after quiescence is cancelled", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "500",
			FAKE_LSP_LOADING_CANCEL_FIRST_PULL_AFTER: "1",
		});
		const result = await touch(filePath, DIRTY);

		expect(result?.diags).toEqual([
			expect.objectContaining({ code: "FAKE1001" }),
		]);
		expect(result?.confirmation).toBe("confirmed");
	}, 30_000);

	// The whole loading window passes inside one pull's flight: status false,
	// status true, then the empty reply it computed while loading. No status reads
	// loading when the reply is processed, so only the changed revision tells the
	// reply was not given by a ready server.
	it("distrusts an empty reply that was in flight across a status change", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "20000",
			FAKE_LSP_LOADING_FLIP_AROUND_FIRST_PULL: "1",
		});
		const result = await touch(filePath, DIRTY);

		expect(result?.diags).toEqual([
			expect.objectContaining({ code: "FAKE1001" }),
		]);
		expect(result?.confirmation).toBe("confirmed");
	}, 30_000);

	// A ready server that repeats its unchanged notice before each answer is not
	// changing readiness: a repeat must not read as a status change, or every pull
	// in flight across one is asked again and a warm touch never settles.
	it("does not treat a repeated quiescent notice as a status change", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "300",
			FAKE_LSP_LOADING_REPEAT_STATUS: "1",
		});
		const result = await touch(filePath, CLEAN);

		expect(result?.diags).toEqual([]);
		expect(result?.inconclusive).not.toBe(true);
		expect(result?.confirmation).toBe("confirmed");
	}, 30_000);

	// The gate applies only to a server that announces. This shape (loads, answers
	// empty, announces nothing) is today's behaviour and must not move: it is the
	// "every other server keeps its behaviour" half of the acceptance.
	it("leaves a server that never announces readiness alone", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "20000",
			FAKE_LSP_LOADING_NO_STATUS: "1",
		});
		const result = await touch(filePath, DIRTY);

		expect(result?.diags).toEqual([]);
		expect(result?.confirmation).toBe("confirmed");
		expect(await gatedRows()).toHaveLength(0);
		expect(gatedLedgerCount()).toBe(0);
	}, 30_000);

	// A notice whose `quiescent` is not a boolean says nothing: it must read as
	// "announced nothing", never as loading (a hang) or as ready.
	it("ignores a status notice without a boolean quiescent", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "20000",
			FAKE_LSP_LOADING_MALFORMED_STATUS: "1",
		});
		const result = await touch(filePath, DIRTY);

		expect(result?.confirmation).toBe("confirmed");
		expect(await gatedRows()).toHaveLength(0);
	}, 30_000);

	// Recurrence: a handler that took any notice at face value would let a garbled
	// completion notice replace the real `quiescent:false` and read the server
	// as ready while it is still loading (a false clean).
	it("does not let a garbled notice replace a real loading status", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "500",
			FAKE_LSP_LOADING_MALFORMED_STATUS: "done",
		});
		const result = await touch(filePath, DIRTY, { maxDiagnosticsWaitMs: 1500 });

		expect(result?.inconclusive).toBe(true);
		expect(result?.inconclusiveReason).toBe("server-loading");
		expect(result?.confirmation).not.toBe("confirmed");
	}, 30_000);

	// The server dies while the wait is held on its quiescence: the wait ends
	// with the connection, not at its budget, and the touch is not clean.
	it("ends the wait when the server dies while loading", async () => {
		// The flat env cap is the touch budget (a strategy row's 1500 ms would end
		// the wait first and hide the dead-connection exit).
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "60000";
		const filePath = register({ FAKE_LSP_LOADING_MS: "20000" });
		let result: Awaited<ReturnType<typeof touch>> | undefined;
		let settled = false;
		const pending = touch(filePath, DIRTY);
		void pending.then((value) => {
			result = value;
			settled = true;
		});
		await waitFor(() => procs.length === 1 && gatedLedgerCount() > 0, Boolean, {
			timeoutMs: 10_000,
		});
		expect(settled).toBe(false);
		procs[0].process.kill("SIGKILL");

		// The touch budget is 60 s; the wait must end with the connection.
		await waitFor(() => settled, Boolean, { timeoutMs: 10_000 });
		expect(result?.confirmation).not.toBe("confirmed");
		expect(result?.diags).toEqual([]);
	}, 40_000);

	// Recurrence (review of #5495, F1): rust-analyzer reports a workspace it
	// could not load (a broken Cargo.toml) as `health:"error"` with
	// `quiescent:true`, and answers every pull empty. The client read that as a
	// ready server's clean file. The failure is its own reason, reported at
	// once (no budget is spent waiting for a manifest nobody is fixing), with the
	// server's message.
	it("reports a failed workspace load as inconclusive with the server's message, at once", async () => {
		writeDurableLatencyRows();
		// The flat env cap is the touch budget (a strategy row's 1500 ms would
		// end the wait first and hide whether a failed load is waited on).
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "60000";
		const filePath = register({
			FAKE_LSP_LOADING_MS: "200",
			FAKE_LSP_LOADING_HEALTH: "error",
		});
		const started = Date.now();
		const first = await touch(filePath, DIRTY, {
			maxDiagnosticsWaitMs: 20_000,
		});
		const elapsedMs = Date.now() - started;

		expect(first?.diags).toEqual([]);
		expect(first?.inconclusive).toBe(true);
		expect(first?.inconclusiveReason).toBe("server-load-failed");
		expect(first?.inconclusiveDetail).toBe("Failed to load workspaces.");
		expect(first?.confirmation).not.toBe("confirmed");
		// Loading takes 200 ms; the 20 s budget is not spent on a failed load.
		expect(elapsedMs).toBeLessThan(8_000);

		// A second touch is as inconclusive, and the session has ONE failure record.
		const second = await touch(filePath, CLEAN, {
			maxDiagnosticsWaitMs: 20_000,
		});
		expect(second?.inconclusiveReason).toBe("server-load-failed");
		const failedRows = (await gatedRows()).filter(
			(row) => row.metadata?.loadFailed === true,
		);
		expect(failedRows).toHaveLength(1);
		expect(failedRows[0]?.metadata).toMatchObject({
			serverId: "fake-rust",
			message: "Failed to load workspaces.",
		});
	}, 40_000);

	// `health:"warning"` is a ready server (rust-analyzer says so for proc-macro
	// and build-script problems): its answers stay verdicts.
	it("treats health warning as ready", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "200",
			FAKE_LSP_LOADING_HEALTH: "warning",
		});
		const result = await touch(filePath, DIRTY);

		expect(result?.diags).toEqual([
			expect.objectContaining({ code: "FAKE1001" }),
		]);
		expect(result?.inconclusive).not.toBe(true);
		expect(result?.confirmation).toBe("confirmed");
	}, 30_000);

	// Recurrence (review of #5495, F6): a loading server's empty report that
	// carries a finding for ANOTHER document (`relatedDocuments`) was stored as
	// the answer and the file read clean while the server was loading.
	it("does not confirm a loading server's empty report because it carries a related finding", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "20000",
			FAKE_LSP_LOADING_RELATED: "1",
		});
		const result = await touch(filePath, DIRTY, { maxDiagnosticsWaitMs: 600 });

		expect(result?.inconclusive).toBe(true);
		expect(result?.inconclusiveReason).toBe("server-loading");
		expect(result?.confirmation).not.toBe("confirmed");
	}, 30_000);

	// Recurrence (review of #5495, F2, mutation M3): only EMPTY publishes from a
	// loading server are refused. A finding it pushes while loading is evidence
	// and must reach the touch; dropping every publish would hide it.
	it("keeps a finding a loading server pushes", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "20000",
			FAKE_LSP_LOADING_PUSH_FINDING: "1",
		});
		const result = await touch(filePath, DIRTY, { maxDiagnosticsWaitMs: 600 });

		expect(result?.diags).toEqual([
			expect.objectContaining({ code: "LOADPUSH1" }),
		]);
	}, 30_000);

	// Recurrence (review of #5495, F2, mutation M5): a lapse is named
	// `server-loading` only for a server that announced loading. A non-announcer
	// that never answers is a plain diagnostics-wait lapse.
	it("does not call a silent non-announcer's lapse a loading one", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "20000",
			FAKE_LSP_LOADING_NO_STATUS: "1",
			FAKE_LSP_IGNORE_PULL: "1",
		});
		const result = await touch(filePath, DIRTY, { maxDiagnosticsWaitMs: 600 });

		expect(result?.inconclusive).toBe(true);
		expect(result?.inconclusiveReason).toBe("diagnostics-wait");
	}, 30_000);

	// Recurrence (review of #5495, F2, mutation M7): a pull that was in flight
	// across the first status change is unsettled, so the pull after it is part
	// of a readiness wait; when that one is cancelled (-32802) it is asked again
	// like any cancelled post-quiescence pull, not read as a silent server.
	it("asks again when the pull after an unsettled one is cancelled", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "20000",
			FAKE_LSP_LOADING_FLIP_AROUND_FIRST_PULL: "1",
			FAKE_LSP_LOADING_CANCEL_FIRST_PULL_AFTER: "1",
		});
		const result = await touch(filePath, DIRTY);

		expect(result?.diags).toEqual([
			expect.objectContaining({ code: "FAKE1001" }),
		]);
		expect(result?.confirmation).toBe("confirmed");
	}, 30_000);

	// Recurrence (review of #5495, F2, mutation M11): the pull sent after the
	// readiness wait gets the budget that is LEFT, not the whole call's budget,
	// or a server that then goes silent holds the touch for loading time plus a
	// whole budget.
	it("spends no more than the touch budget when the server goes silent after loading", async () => {
		const filePath = register({
			FAKE_LSP_LOADING_MS: "900",
			FAKE_LSP_LOADING_IGNORE_PULL_AFTER: "1",
		});
		const started = Date.now();
		const result = await touch(filePath, DIRTY, {
			maxDiagnosticsWaitMs: 1_000,
		});
		const elapsedMs = Date.now() - started;

		expect(result?.confirmation).not.toBe("confirmed");
		// Budget 1000 ms plus process start; the unfixed pull ran 900 + 1000 ms.
		expect(elapsedMs).toBeLessThan(1_900);
	}, 30_000);

	// Recurrence (review of #5495, F3): `clientShutdownOnce` removed the emitter's
	// listeners before the dispose event, so a graceful shutdown never woke a wait
	// held on a loading server and the touch outlived it by its whole budget.
	it("ends a held wait when the service shuts down", async () => {
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "60000";
		const filePath = register({ FAKE_LSP_LOADING_MS: "20000" });
		let settled = false;
		const pending = touch(filePath, DIRTY).then((value) => {
			settled = true;
			return value;
		});
		await waitFor(() => procs.length === 1 && gatedLedgerCount() > 0, Boolean, {
			timeoutMs: 10_000,
		});
		expect(settled).toBe(false);
		void service.shutdown();

		// The budget is 60 s; the shutdown, not the budget, ends the touch.
		await waitFor(() => settled, Boolean, { timeoutMs: 10_000 });
		expect((await pending)?.confirmation).not.toBe("confirmed");
	}, 40_000);
});

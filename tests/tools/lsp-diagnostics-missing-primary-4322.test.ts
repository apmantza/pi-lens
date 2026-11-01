/**
 * #4322: invalid JSON was reported clean when the JSON language server could
 * not start but typos-lsp, an auxiliary spell checker, answered. typos speaks
 * for spelling only; an answer from it says nothing about JSON syntax. The hole
 * is in `LSPService.touchFile`, which the explicit check, pi's write-time LSP
 * runner and the `mode=full` sweep share: a touch that acquired
 * auxiliaries but no language server still resolved `confirmation:
 * "confirmed"`. A primary-only check reaches the same answer another way: its
 * touch acquires no client, and the `getDiagnostics` fallback acquires typos.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, the real LSPService
 * and the real client over a stdio JSON-RPC wire. The JSON server's command is
 * overridden to a path that does not exist, the reporter's reproduction; typos
 * is overridden to the shared fake server, which answers a pull with one
 * finding, or none for content carrying its `fake-lsp-clean` marker.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	getFileDiagnostics,
	reconcileScanDiagnostics,
} from "../../clients/widget-state.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { makeRunnerCtx } from "../support/runner-ctx.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-4322-svc-");
// The real path: on macOS the tmpdir is a `/var` -> `/private/var` alias, and
// an adopted root is compared against the classifier's realpath.
const workspace = fs.realpathSync(env.tmpDir);
const probe = path.join(workspace, "probe.json");
const secondProbe = path.join(workspace, "second.json");
const TYPOS_FINDING = "typos stand-in finding";

type LatencyRow = {
	phase?: string;
	filePath?: string;
	metadata?: Record<string, unknown>;
};

/**
 * Runs `work` with the latency sink on: `logLatency` writes nothing in test
 * mode (`isTestMode`, read live), and this case reads the record it writes.
 */
async function withLatencySink<T>(work: () => Promise<T>): Promise<T> {
	const saved = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	try {
		return await work();
	} finally {
		if (saved === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = saved;
	}
}

/** The real latency sink's lines, after a flush. */
async function latencyLines(): Promise<string[]> {
	await flushLatencyLog();
	const logPath = getLatencyLogPath();
	return fs.existsSync(logPath)
		? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean)
		: [];
}

/** `phase` rows for `file` from line `from` on, so earlier cases' rows are
 *  never read as this case's evidence. */
async function latencyRows(
	phase: string,
	file: string,
	from: number,
): Promise<LatencyRow[]> {
	const name = path.basename(file).toLowerCase();
	return (await latencyLines())
		.slice(from)
		.map((line) => JSON.parse(line) as LatencyRow)
		.filter(
			(row) =>
				row.phase === phase &&
				String(row.filePath ?? "")
					.toLowerCase()
					.endsWith(name),
		);
}

async function diagnose(
	serverScope: "primary" | "all",
	target: { path: string } | { paths: string[] } = { path: probe },
	onConfirmedNoBlockers?: (info: { coveredSources: string[] }) => void,
): Promise<{
	text: string;
	details: Record<string, unknown>;
}> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool(
		undefined,
		onConfirmedNoBlockers,
	).execute(
		"probe-4322",
		{ ...target, serverScope, waitMs: 3000 },
		undefined,
		null,
		{ cwd: workspace },
	)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return {
		text: String(result.content[0]?.text),
		details: result.details ?? {},
	};
}

describe("a JSON file whose language server cannot start (#4322)", () => {
	let service: { shutdown: () => Promise<void> } | undefined;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

	beforeAll(async () => {
		// Never fetch a real vscode-json-language-server for the missing primary.
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		// Host-boundary stub: the command overrides are project config, which
		// #4248 admits only in a project pi has trusted.
		setProjectTrustState("trusted");
		const typosShim = path.join(workspace, "typos-server.mjs");
		fs.writeFileSync(
			typosShim,
			[
				// typos answers every pull: one finding, or none for content that
				// carries the fake's `fake-lsp-clean` marker.
				'process.env.FAKE_LSP_DIAGNOSTIC_SOURCE = "typos";',
				`process.env.FAKE_LSP_DIAGNOSTIC_MESSAGE = ${JSON.stringify(TYPOS_FINDING)};`,
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		// A CSS primary that holds its pulls past the check's wait budget.
		const slowCssShim = path.join(workspace, "slow-css-server.mjs");
		fs.writeFileSync(
			slowCssShim,
			[
				'process.env.FAKE_LSP_DELAY_FIRST_PULL = "1";',
				'process.env.FAKE_LSP_DELAY_AFTER_FIRST_PULL_MS = "20000";',
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(workspace, "package.json"),
			'{"name":"synthetic-json-fixture","private":true}\n',
		);
		// typos roots at the nearest `.git` (clients/lsp/server.ts `TyposServer`);
		// without one it falls back to this process's cwd, outside the workspace.
		// The shared fixture marker IS that `.git` (#4560); planting a second one
		// threw EEXIST here and skipped the whole suite.
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				serverOverrides: {
					json: {
						command: [
							path.join(workspace, "missing", "json-language-server"),
							"--stdio",
						],
					},
					css: { command: [process.execPath, slowCssShim] },
					typos: { command: [process.execPath, typosShim] },
				},
				disabledServers: ["ast-grep", "opengrep", "zizmor"],
			}),
		);
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-4322-svc-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	});

	it("does not report invalid JSON clean on typos' clean answer alone", async () => {
		// Invalid JSON that typos answers clean for.
		fs.writeFileSync(probe, '{"fake-lsp-clean": }\n');

		const from = (await latencyLines()).length;
		const result = await withLatencySink(() => diagnose("all"));

		expect(result.details.unconfirmed).toBe(true);
		expect(result.details.primaryUnavailable).toContain("Primary LSP (json)");
		expect(result.text).toContain("Primary LSP (json): not available");
		expect(result.text).not.toContain("confirmed clean");
		// A server that never started is not a check that ran out of time.
		expect(result.details.timedOut).not.toBe(true);
		// The touch's own record names the reason and the server (real sink).
		expect(
			(await latencyRows("lsp_touch_file", probe, from)).map(
				(row) => row.metadata,
			),
		).toContainEqual(
			expect.objectContaining({
				inconclusive: true,
				inconclusiveReason: "primary-unavailable",
				inconclusiveServerIds: ["json"],
			}),
		);
	}, 30_000);

	it("names the missing language server in a batch check", async () => {
		fs.writeFileSync(probe, '{"fake-lsp-clean": }\n');
		fs.writeFileSync(secondProbe, '{"fake-lsp-clean": 1,}\n');

		const result = await diagnose("all", { paths: [probe, secondProbe] });

		expect(result.text).toContain(
			"0 files confirmed clean, 2 unconfirmed: 2 with no primary language server " +
				"answer (it could not be started, or was still starting).",
		);
		// typos did answer, so the files are inconclusive, not "unavailable":
		// that outcome means no client answered at all.
		const outcomes = result.details.outcomes as Array<{ outcome?: string }>;
		expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
			"inconclusive",
			"inconclusive",
		]);
	}, 30_000);

	it("keeps a file typos answered inconclusive beside an earlier read's no-client record", async () => {
		fs.writeFileSync(probe, '{"fake-lsp-clean": }\n');
		fs.writeFileSync(secondProbe, '{"fake-lsp-clean": 1,}\n');
		// The record an earlier read that acquired no client leaves behind. Only
		// `getDiagnostics` writes this record, so a later touch does not replace it.
		const { normalizeMapKey } = await import("../../clients/path-utils.js");
		const health = (
			service as unknown as {
				lastDiagnosticsHealth: Map<string, Record<string, unknown>>;
			}
		).lastDiagnosticsHealth;
		for (const file of [probe, secondProbe]) {
			health.set(normalizeMapKey(file), {
				health: "no_clients",
				failureKind: "no_clients",
				serverCountAttempted: 1,
				serverCountReady: 0,
				candidateServerIds: ["json"],
				mergedCount: 0,
				dedupDroppedCount: 0,
				checkedAt: new Date().toISOString(),
				unavailablePrimaryServerIds: ["json"],
			});
		}

		try {
			const result = await diagnose("all", { paths: [probe, secondProbe] });

			// typos answered this read, so the old record does not make it
			// "unavailable".
			const outcomes = result.details.outcomes as Array<{ outcome?: string }>;
			expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
				"inconclusive",
				"inconclusive",
			]);
		} finally {
			for (const file of [probe, secondProbe]) {
				health.delete(normalizeMapKey(file));
			}
		}
	}, 30_000);

	it("names each reason when a batch mixes a missing language server with a timed-out check", async () => {
		// Recurrence: `unconfirmedReasonClause`'s mixed branch (`rest > 0`) was
		// replaced by the head alone and every test still passed, so a batch that
		// lost files to two causes named only one of them.
		const slow = path.join(workspace, "slow.css");
		// Its own file: no earlier case has left a document on typos for it.
		const mixed = path.join(workspace, "mixed.json");
		fs.writeFileSync(mixed, '{"fake-lsp-clean": }\n');
		fs.writeFileSync(slow, "a { color: red; } /* fake-lsp-clean */\n");

		// Warm-up: typos answers a pull for a document it has not been sent with a
		// finding (the fake serves "" for an unopened uri). A full check opens
		// `probe` on it, so the batch below sees the clean answer an earlier case
		// would otherwise have supplied; run alone, the case is order-independent.
		await diagnose("all", { path: mixed });

		// #3801: the css shim holds its pull for 20 s and the tool waits out the
		// production diagnostics budget (25.8 s). The case asserts the reason
		// clause, which needs the check to time out, not how long it waited, so
		// the window is capped for this call alone.
		vi.stubEnv("PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS", "3000");
		let result: Awaited<ReturnType<typeof diagnose>>;
		try {
			result = await diagnose("primary", { paths: [mixed, slow] });
		} finally {
			vi.unstubAllEnvs();
		}

		expect(result.text).toContain(
			"1 with no primary language server answer (it could not be started, or was " +
				"still starting); the other 1: 1 timed out",
		);
	}, 60_000);

	it("still shows typos' findings while the JSON check is unavailable", async () => {
		fs.writeFileSync(probe, '{"probe": }\n');

		const result = await diagnose("all");

		// typos really answered for this file: its finding is delivered.
		expect(result.details.auxiliaryDiagnosticsCount).toBe(1);
		expect(result.text).toContain(TYPOS_FINDING);
		expect(result.details.unconfirmed).toBe(true);
		expect(result.text).toContain("Primary LSP (json): not available");
	}, 30_000);

	it("does not retire a language-server blocker or replace its footer rows on typos' finding alone", async () => {
		// typos' finding is not blocking, so an answer taken as the file's
		// current view would read as "nothing blocking here, the LSP checked it".
		fs.writeFileSync(probe, '{"probe": }\n');
		const retired: string[][] = [];
		// The footer holds the JSON server's last answer for this file.
		const lastAnswer = [
			{ severity: "error", message: "JSON server's last answer", tool: "lsp" },
		];
		expect(reconcileScanDiagnostics(probe, lastAnswer, true)).toBe(true);

		const result = await diagnose("all", { path: probe }, (info) =>
			retired.push(info.coveredSources),
		);

		expect(result.details.auxiliaryDiagnosticsCount).toBe(1);
		expect(retired).toEqual([]);
		// typos' rows alone do not replace the footer's language-server rows.
		expect(getFileDiagnostics(probe)?.map((d) => d.message)).toEqual([
			"JSON server's last answer",
		]);
	}, 30_000);

	it("names the missing language server in a batch that shows typos' findings", async () => {
		fs.writeFileSync(probe, '{"probe": }\n');
		fs.writeFileSync(secondProbe, '{"fake-lsp-clean": 1,}\n');
		const retired: string[][] = [];

		const result = await diagnose(
			"all",
			{ paths: [probe, secondProbe] },
			(info) => retired.push(info.coveredSources),
		);

		expect(result.text).toContain(TYPOS_FINDING);
		expect(result.text).toContain(
			"1 file with auxiliary or fallback findings only: no primary language server answered",
		);
		const outcomes = result.details.outcomes as Array<{ reason?: string }>;
		expect(outcomes.map((outcome) => outcome.reason)).toEqual([
			expect.stringContaining("Primary LSP (json): not available"),
			expect.stringContaining("Primary LSP (json): not available"),
		]);
		expect(retired).toEqual([]);
	}, 30_000);

	it("names the missing language server in a directory that shows typos' findings", async () => {
		const dir = path.join(workspace, "dir");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "only.json"), '{"probe": }\n');

		const result = await diagnose("all", { path: dir });

		expect(result.text).toContain(TYPOS_FINDING);
		expect(result.text).toContain(
			"1 file with auxiliary or fallback findings only: no primary language server answered",
		);
		const outcomes = result.details.outcomes as Array<{ reason?: string }>;
		expect(outcomes.map((outcome) => outcome.reason)).toEqual([
			expect.stringContaining("Primary LSP (json): not available"),
		]);
	}, 30_000);

	it("does not report the primary-only check clean when no language server ran", async () => {
		fs.writeFileSync(probe, '{"fake-lsp-clean":"valid"}\n');

		const from = (await latencyLines()).length;
		const result = await withLatencySink(() => diagnose("primary"));

		expect(result.details.unconfirmed).toBe(true);
		expect(result.text).toContain("Primary LSP (json): not available");
		expect(result.text).not.toContain("confirmed clean");
		// The fallback read's health record names the server that did not answer.
		const health = (
			service as unknown as {
				getDiagnosticsHealth: (
					file: string,
				) => { unavailablePrimaryServerIds?: string[] } | undefined;
			}
		).getDiagnosticsHealth(probe);
		expect(health?.unavailablePrimaryServerIds).toEqual(["json"]);
		// ...and so does the fallback read's own record (real sink).
		expect(
			(await latencyRows("lsp_diagnostics_aggregate", probe, from)).map(
				(row) => row.metadata?.unavailablePrimaryServerIds,
			),
		).toContainEqual(["json"]);
	}, 30_000);

	it("pi's write-time LSP runner does not report the file as checked clean", async () => {
		// The dispatch runner's own touch (`with-auxiliary`), not the tool's.
		const { default: lspRunner } =
			await import("../../clients/dispatch/runners/lsp.js");
		fs.writeFileSync(probe, '{"fake-lsp-clean": }\n');

		const clean = await lspRunner.run(
			makeRunnerCtx(probe, workspace, { kind: "json" }),
		);
		expect(clean.status).toBe("skipped");

		fs.writeFileSync(probe, '{"probe": }\n');
		const withFinding = await lspRunner.run(
			makeRunnerCtx(probe, workspace, { kind: "json" }),
		);
		// typos' finding is kept, and the result names the missing language server.
		expect(withFinding.diagnostics.map((d) => d.message)).toEqual([
			expect.stringContaining(TYPOS_FINDING),
		]);
		expect(withFinding.unconfirmedServerIds).toContain("json");
	}, 30_000);
});

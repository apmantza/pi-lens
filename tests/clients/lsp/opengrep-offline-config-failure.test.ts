// flake-shape: real-process-spawn — Real child transport and lifecycle are the subject; a process stub cannot exercise the wire and teardown behavior.
/**
 * #4764: an offline opengrep reads as a clean scan; its rule-download error is
 * unhandled.
 *
 * Measured with the managed binary (opengrep 1.30.0), home and TMPDIR pinned
 * under a probe directory, config `auto` pointed at a refused endpoint:
 * `textDocument/publishDiagnostics` arrives EMPTY (count 0) for the opened
 * file, then one `window/showMessage` (type 1) says
 * `Fatal error: Failed to download config from …`, and no further publication
 * follows. The empty set was the only answer, so pi-lens reported the scanner
 * as confirmed-clean for a file it never evaluated.
 *
 * What must hold now:
 *   1. `window/showMessage` is handled. An error-level message reporting that
 *      the server's own config/rules failed to load records one bounded
 *      degradation per distinct message per session, naming the server and the
 *      message.
 *   2. After that message an AUXILIARY scanner's empty publication is not
 *      evidence of a clean scan: it is refused at receipt, refused again at
 *      debounce-store time (the measured order puts the publish first), and an
 *      empty answer already stored is retracted. The touch then reports the
 *      scanner unconfirmed (`confirmation: "partial"` +
 *      `unconfirmedServerIds`) instead of clean.
 *   3. A NON-empty publication still flows: a broken rule download does not
 *      erase findings the server did produce.
 *   4. Other `window/showMessage` traffic is bounded: one record per distinct
 *      message per session, at most `MAX_TRACKED_SERVER_MESSAGES` distinct
 *      texts per client, and a language-role server is recorded but never
 *      gated (its config message can name one optional feature while its
 *      analysis still answers).
 *
 * Real stdio fake-server children; the shapes come from the fixture's
 * `FAKE_LSP_SHOW_MESSAGE*` and `FAKE_LSP_PUBLISH_SEQUENCE` knobs.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { getRecentLoggedPhases } from "../../../clients/latency-logger.js";
import { createLSPClient } from "../../../clients/lsp/client.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";
import { waitFor } from "../interleaving-kit.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";

const fakeServer = fileURLToPath(
	new URL("../../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const OFFLINE_MESSAGE =
	"Fatal error: Failed to download config from https://semgrep.dev/c/p/default: Unix_error: Connection refused connect";

let env: ReturnType<typeof setupTestEnvironment> | undefined;

function workspace(): string {
	env ??= setupTestEnvironment("pi-lens-4764-offline-opengrep-");
	return fs.realpathSync(env.tmpDir);
}

/**
 * The drop record as the phase ring holds it. `logLatency` records into the
 * ring BEFORE its test-mode gate, so the ring is the trainable half of the
 * record inside a Vitest process (the durable row is asserted separately, via
 * the degradation summary).
 */
function dropPhases(): Array<{
	phase: string;
	metadata?: Record<string, unknown>;
}> {
	return getRecentLoggedPhases().filter(
		(entry) => entry.phase === "lsp_publish_dropped_server_config_failed",
	);
}

function group(kind: string) {
	return getDegradationSummary().find((entry) => entry.kind === kind);
}

/** The message entries of one kind, subjects shaped `<server>:message:<digest>`. */
function messageEntries(kind: string) {
	return (group(kind)?.latestReasons ?? []).filter((entry) =>
		entry.subject.includes(":message:"),
	);
}

/**
 * The server's messages and publishes travel the socket asynchronously, so the
 * assertion waits for the record instead of racing the read loop. `read` is
 * in-memory (`getDegradationSummary`), so the default timer yield sees the
 * ledger write as soon as the client's notification handler runs.
 */
async function awaitLedger(read: () => boolean, label: string): Promise<void> {
	await waitFor(read, Boolean, { timeoutMs: 5_000 });
	expect(read(), label).toBe(true);
}

describe("an auxiliary's failed config is not a clean scan (#4764)", () => {
	const spawned: Array<{ shutdown: () => Promise<void> }> = [];

	beforeEach(() => {
		resetDegradationLedger();
	});

	afterEach(async () => {
		for (const live of spawned.splice(0)) {
			try {
				await live.shutdown();
			} catch {
				/* the child may already be gone */
			}
		}
	});

	async function openClient(
		extraEnv: Record<string, string>,
		onDiagnosticsPublished?: (serverId: string) => void,
	) {
		const proc = await spawnFakeLspServer({
			cwd: workspace(),
			env: {
				...process.env,
				FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
				...extraEnv,
			},
		});
		const created = await createLSPClient({
			serverId: "opengrep",
			role: "auxiliary",
			process: proc,
			root: workspace(),
			...(onDiagnosticsPublished ? { onDiagnosticsPublished } : {}),
		});
		spawned.push(created);
		return created;
	}

	async function openFile(created: Awaited<ReturnType<typeof openClient>>) {
		const file = path.join(workspace(), "probe.py");
		fs.writeFileSync(file, "import os\n");
		await created.notify.open(file, "import os\n", "python");
		return file;
	}

	it("refuses an empty publish that follows the rule-download error", async () => {
		// A refused publication must not tell the first-publication gate that this
		// server reported for the file: `onDiagnosticsPublished` feeds that gate
		// (`hasServerPublishedForFileRoot`), so the receipt-time refusal is what
		// keeps a rule-less scanner from superseding a fallback runner.
		let publishedNotifications = 0;
		const created = await openClient(
			{
				FAKE_LSP_SHOW_MESSAGE: OFFLINE_MESSAGE,
				FAKE_LSP_PUBLISH_SEQUENCE: "empty",
			},
			() => {
				publishedNotifications += 1;
			},
		);
		const file = await openFile(created);
		// The publish is refused, so no answer resolves this wait: it laps its
		// own budget, which is exactly the pre-fix false clean's inverse.
		await created.waitForDiagnostics(file, 900);

		expect(created.getDiagnosticsVersionForPath(file)).toBe(0);
		expect(created.getDiagnostics(file)).toEqual([]);
		expect(created.getDiagnosticBinding(file)).toBeUndefined();
		expect(publishedNotifications).toBe(0);

		const failure = group("lsp-server-config-load-failed");
		expect(failure).toBeDefined();
		expect(failure?.latestReasons).toContainEqual(
			expect.objectContaining({
				subject: expect.stringMatching(/^opengrep:message:/),
				reason: expect.stringContaining("Failed to download config"),
			}),
		);
		await awaitLedger(
			() =>
				group("lsp-server-config-load-failed")?.latestReasons.some((entry) =>
					entry.subject.startsWith("opengrep:dropped:"),
				) ?? false,
			"the refused publication is recorded",
		);
		const drops = dropPhases().filter(
			(entry) => entry.metadata?.serverId === "opengrep",
		);
		expect(drops.length).toBeGreaterThan(0);
		expect(drops[0]?.metadata?.via).toBe("publish");
	}, 30_000);

	// The MEASURED opengrep order: the empty publish lands first, and the
	// download error follows in the same tick. The publish is still inside its
	// 250ms debounce, so the decision has to be made at store time.
	it("never stores the empty publish the server sent just before it reported the failure", async () => {
		// #4763 holds this pre-rules empty (the rules never loaded), so it never
		// reaches the cache; the failure then leaves nothing to retract. The
		// store-time gate for an empty that is NOT held is pinned in the
		// acceptance table of opengrep-pre-rules-publish-4763.test.ts.
		const created = await openClient({
			FAKE_LSP_SHOW_MESSAGE: OFFLINE_MESSAGE,
			FAKE_LSP_SHOW_MESSAGE_AFTER_FIRST_PUBLISH: "1",
			FAKE_LSP_PUBLISH_SEQUENCE: "empty",
		});
		const file = await openFile(created);

		await awaitLedger(
			() => messageEntries("lsp-server-config-load-failed").length > 0,
			"the failure is recorded",
		);
		expect(created.getDiagnosticsVersionForPath(file)).toBe(0);
		expect(created.getDiagnosticBinding(file)).toBeUndefined();
	}, 30_000);

	it("keeps a real finding the scanner published after the failure", async () => {
		const created = await openClient({
			FAKE_LSP_SHOW_MESSAGE: OFFLINE_MESSAGE,
			FAKE_LSP_PUBLISH_SEQUENCE: "dirty",
		});
		const file = await openFile(created);
		await created.waitForDiagnostics(file, 3_000);

		expect(created.getDiagnosticsVersionForPath(file)).toBeGreaterThan(0);
		expect(created.getDiagnostics(file)).toHaveLength(1);
	}, 30_000);

	// A failure reported LATER than the empty answer (a rule refresh after the
	// first scan) cannot rely on either store-time gate: the empty set is already
	// in the cache and has to be retracted.
	it("retracts an empty answer it stored before the failure was reported", async () => {
		const created = await openClient({
			FAKE_LSP_SHOW_MESSAGE: OFFLINE_MESSAGE,
			FAKE_LSP_SHOW_MESSAGE_AFTER_FIRST_PUBLISH: "1",
			FAKE_LSP_SHOW_MESSAGE_DELAY_MS: "700",
			// Rules loaded first, so the empty is a stored clean answer (#4763
			// holds it otherwise); the failure then arrives 700 ms later.
			FAKE_LSP_PUBLISH_SEQUENCE: "refreshed,empty",
		});
		const file = await openFile(created);
		await waitFor(
			() => created.getDiagnosticsVersionForPath(file) > 0,
			Boolean,
			{ timeoutMs: 5_000 },
		);

		await waitFor(
			() =>
				dropPhases().some(
					(entry) =>
						entry.metadata?.serverId === "opengrep" &&
						entry.metadata?.via === "retracted",
				),
			Boolean,
			{ timeoutMs: 5_000 },
		);
		expect(created.getDiagnosticsVersionForPath(file)).toBe(0);
		expect(created.getDiagnosticBinding(file)).toBeUndefined();
	}, 30_000);

	// The other direction of the same retraction: a real finding stored before a
	// late failure is evidence and must survive it.
	it("keeps a finding it stored before the failure was reported", async () => {
		const created = await openClient({
			FAKE_LSP_SHOW_MESSAGE: OFFLINE_MESSAGE,
			FAKE_LSP_SHOW_MESSAGE_AFTER_FIRST_PUBLISH: "1",
			FAKE_LSP_SHOW_MESSAGE_DELAY_MS: "700",
			FAKE_LSP_PUBLISH_SEQUENCE: "dirty",
		});
		const file = await openFile(created);
		await waitFor(
			() => created.getDiagnosticsVersionForPath(file) > 0,
			Boolean,
			{ timeoutMs: 5_000 },
		);
		await awaitLedger(
			() => messageEntries("lsp-server-config-load-failed").length === 1,
			"the failure is recorded",
		);

		expect(created.getDiagnosticsVersionForPath(file)).toBeGreaterThan(0);
		expect(created.getDiagnostics(file)).toHaveLength(1);
	}, 30_000);

	it("records one entry per distinct message and counts its repeats", async () => {
		const created = await openClient({
			FAKE_LSP_SHOW_MESSAGES: JSON.stringify([
				{ type: 3, message: "indexing folder a" },
				{ type: 3, message: "indexing folder a" },
			]),
		});
		await openFile(created);

		await awaitLedger(
			() => (group("lsp-server-message")?.count ?? 0) >= 2,
			"both messages are counted",
		);
		const messages = messageEntries("lsp-server-message");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.reason).toContain("indexing folder a");
		expect(group("lsp-server-message")?.count).toBe(2);
		// The phase record exists on its own (the durable half is the ledger), so
		// the Observability section's `lsp_server_message` is read back here.
		expect(
			getRecentLoggedPhases().some(
				(entry) => entry.phase === "lsp_server_message",
			),
		).toBe(true);
	}, 30_000);

	// The cap must never swallow the one message that changes a verdict: a
	// narrating server that used up its eight texts can still report that its
	// rules failed to load, and that report still stops the empty publish.
	it("admits the first failed-config report even at the message cap", async () => {
		const created = await openClient({
			FAKE_LSP_SHOW_MESSAGES: JSON.stringify([
				...Array.from({ length: 8 }, (_, index) => ({
					type: 3,
					message: `indexing folder ${index}`,
				})),
				{ type: 1, message: OFFLINE_MESSAGE },
			]),
			FAKE_LSP_PUBLISH_SEQUENCE: "empty",
		});
		const file = await openFile(created);

		await awaitLedger(
			() => messageEntries("lsp-server-config-load-failed").length === 1,
			"the failure is recorded past the cap",
		);
		expect(
			group("lsp-server-message")?.latestReasons.some(
				(entry) => entry.subject === "opengrep:showMessage-cap",
			),
		).toBeFalsy();
		expect(created.getDiagnosticsVersionForPath(file)).toBe(0);
	}, 30_000);

	it("caps distinct message texts and counts the overflow", async () => {
		const created = await openClient({
			FAKE_LSP_SHOW_MESSAGES: JSON.stringify(
				Array.from({ length: 10 }, (_, index) => ({
					type: 3,
					message: `indexing folder ${index}`,
				})),
			),
		});
		await openFile(created);

		await awaitLedger(
			() =>
				group("lsp-server-message")?.latestReasons.some(
					(entry) => entry.subject === "opengrep:showMessage-cap",
				) ?? false,
			"the overflow is counted",
		);
		const summary = group("lsp-server-message");
		expect(messageEntries("lsp-server-message")).toHaveLength(8);
		expect(summary?.latestReasons).toContainEqual(
			expect.objectContaining({
				subject: "opengrep:showMessage-cap",
				reason: expect.stringContaining("distinct showMessage texts"),
			}),
		);
	}, 30_000);

	it("records a language-role server's message without gating its answer", async () => {
		const proc = await spawnFakeLspServer({
			cwd: workspace(),
			env: {
				...process.env,
				FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
				FAKE_LSP_SHOW_MESSAGE: OFFLINE_MESSAGE,
				FAKE_LSP_PUBLISH_SEQUENCE: "empty",
			},
		});
		// No declared role: a language server whose optional feature failed must
		// keep its empty answer, or every clean file becomes unconfirmed.
		const created = await createLSPClient({
			serverId: "fake-language",
			process: proc,
			root: workspace(),
		});
		spawned.push(created);
		const file = await openFile(created);
		await created.waitForDiagnostics(file, 2_000);

		await awaitLedger(
			() => messageEntries("lsp-server-config-load-failed").length === 1,
			"the language server's message is recorded",
		);
		expect(created.getDiagnosticsVersionForPath(file)).toBeGreaterThan(0);
	}, 30_000);
});

/**
 * The touch-level half: the production `LSPService` over a real primary and a
 * real auxiliary, both stdio fake-server children. The auxiliary is
 * reconfigured through a project command override (trusted, as #4248 admits
 * one) so it reports the rule-download failure in the measured order.
 */
describe("the touch reports a failed auxiliary scanner as unconfirmed (#4764)", () => {
	const envPrefix = "pi-lens-4764-touch-opengrep-";
	let service:
		| {
				shutdown: () => Promise<void>;
				touchFile: (
					file: string,
					content: string,
					options: Record<string, unknown>,
				) => Promise<unknown>;
		  }
		| undefined;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

	beforeAll(async () => {
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		setProjectTrustState("trusted");
		const root = workspace();
		fs.mkdirSync(path.join(root, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".pi-lens", "lsp.json"),
			JSON.stringify({
				serverOverrides: {
					// A language server that answers cleanly, so the touch's
					// confirmation is decided by the auxiliary alone.
					python: {
						command: [process.execPath, fakeServer],
						env: { FAKE_LSP_RESPOND_PULL_WITH: "empty" },
					},
					// The measured opengrep shape: push-only, an empty publish on
					// didOpen, then the rule-download error in the same tick.
					opengrep: {
						command: [process.execPath, fakeServer],
						env: {
							FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
							FAKE_LSP_PUBLISH_SEQUENCE: "empty",
							FAKE_LSP_SHOW_MESSAGE: OFFLINE_MESSAGE,
							FAKE_LSP_SHOW_MESSAGE_AFTER_FIRST_PUBLISH: "1",
						},
					},
				},
				disabledServers: ["ast-grep", "typos", "zizmor"],
			}),
		);
		const config = await import("../../../clients/lsp/config.js");
		await config.initLSPConfig(root);
		const lsp = await import("../../../clients/lsp/index.js");
		service = lsp.getLSPService() as unknown as typeof service;
	});

	beforeEach(() => {
		resetDegradationLedger();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained(envPrefix, {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
		if (savedInstall === undefined) {
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		} else {
			process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
		}
	});

	it("names the scanner and does not claim a confirmed clean", async () => {
		const root = workspace();
		const file = path.join(root, "probe.py");
		const content = "import os\n";
		fs.writeFileSync(file, content);

		const touched = (await service!.touchFile(file, content, {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			maxClientWaitMs: 5_000,
			maxDiagnosticsWaitMs: 1_000,
			source: "test-4764",
		})) as {
			diags?: unknown[];
			confirmation?: string;
			unconfirmedServerIds?: string[];
		};

		expect(touched.diags).toEqual([]);
		expect(touched.confirmation).toBe("partial");
		expect(touched.unconfirmedServerIds).toContain("opengrep");
		expect(group("lsp-server-config-load-failed")).toBeDefined();
		// The pre-existing coverage-gap record names the scanner and the file,
		// which is the touch's own disclosure that it is not a clean scan.
		expect(
			group("lsp-scanner-coverage-gap")?.latestReasons.some((entry) =>
				entry.subject.startsWith("opengrep:"),
			),
		).toBe(true);
		// #4764: the per-touch reason carries WHY the scanner did not answer, not
		// only that it did not. Recurrence: "no diagnostics answer" alone read
		// like a timeout; the reason was only in the session ledger entry.
		const gap = group("lsp-scanner-coverage-gap")?.latestReasons.find((entry) =>
			entry.subject.startsWith("opengrep:"),
		);
		expect(gap?.reason).toContain("no diagnostics answer");
		expect(gap?.reason).toContain("Failed to download config");
	}, 45_000);
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained("pi-lens-4764-offline-opengrep-");
});

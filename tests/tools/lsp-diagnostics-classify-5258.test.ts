/**
 * #5258 (shape 10): a classification that threw read as "Primary LSP: confirmed
 * clean." `classifyEmptyResult` and `resolveEmptyResult` in
 * `tools/lsp-diagnostics.ts` both ended in a `catch` that answered clean. The
 * touch had already settled; the catch decides only whether the file is a
 * silent-on-clean server's empty answer, so a lookup that could not run is
 * unproven, never a pass.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, the real LSPService and
 * the real client over a stdio wire to the shared fake server. The only fault
 * is the service's capability read rejecting, as a root-resolution filesystem
 * error would make it; no real getter rejects on a healthy client.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-5258-classify-");
const workspace = fs.realpathSync(env.tmpDir);

type LspService = {
	shutdown: () => Promise<void>;
	getCapabilitySnapshots: (...args: unknown[]) => Promise<unknown[]>;
};

// One file per case: a clean answer is cached per file, and a replay would
// answer the second case without asking the classification at all.
async function diagnose(
	severity: string,
	name: string,
	// `fake-lsp-clean` makes the fake answer the pull with no finding at all.
	body = "export const a = 1;",
): Promise<{
	text: string;
	details: Record<string, unknown>;
}> {
	const probe = path.join(workspace, name);
	fs.writeFileSync(probe, `/* ${name} */\n${body}\n`);
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-5258",
		{ path: probe, severity, serverScope: "all", waitMs: 3000 },
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

describe("a thrown empty-result classification is not clean (#5258)", () => {
	let service: LspService;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;
	const savedSeverity = process.env.FAKE_LSP_DIAGNOSTIC_SEVERITY;

	beforeAll(async () => {
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		// The fake answers each pull with a WARNING, so a check filtered to
		// errors sees a non-empty answer it filters away: the branch that asks
		// `classifyEmptyResult`.
		process.env.FAKE_LSP_DIAGNOSTIC_SEVERITY = "2";
		setProjectTrustState("trusted");
		const shim = path.join(workspace, "ts-server.mjs");
		fs.writeFileSync(
			shim,
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});\n`,
		);
		fs.writeFileSync(
			path.join(workspace, "package.json"),
			'{"name":"synthetic-ts-fixture","private":true}\n',
		);
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				serverOverrides: { typescript: { command: [process.execPath, shim] } },
				disabledServers: ["ast-grep", "opengrep", "zizmor", "typos"],
			}),
		);
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService() as unknown as LspService;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetDegradationLedger();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-5258-classify-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
		if (savedSeverity === undefined)
			delete process.env.FAKE_LSP_DIAGNOSTIC_SEVERITY;
		else process.env.FAKE_LSP_DIAGNOSTIC_SEVERITY = savedSeverity;
	});

	// The control: the classification ran and found the server confirms its
	// own empty answers, so a warning-only file is clean at the error tier.
	it("a warning-only file is confirmed clean at severity=error when the classification runs", async () => {
		const result = await diagnose("error", "control.ts");
		expect(result.text).toContain("Primary LSP (typescript): confirmed clean.");
		expect(result.details.unconfirmed).not.toBe(true);
	}, 30_000);

	it("a capability read that rejects reads unconfirmed, with a record, never confirmed clean", async () => {
		vi.spyOn(service, "getCapabilitySnapshots").mockRejectedValue(
			new Error("EACCES: root resolution failed"),
		);
		const result = await diagnose("error", "rejected.ts");
		expect(result.text).not.toContain("confirmed clean");
		expect(result.details.unconfirmed).toBe(true);
		expect(result.text).toContain("Primary LSP (typescript): unconfirmed");
		expect(
			getDegradationSummary().some(
				(row) => row.kind === "lsp-empty-classification-failed",
			),
		).toBe(true);
	}, 30_000);

	// The same fail-open catch sat in `resolveEmptyResult`, the read for a file
	// whose server answered with nothing at all.
	it("an empty answer is confirmed clean when the classification runs", async () => {
		const result = await diagnose(
			"all",
			"empty-control.ts",
			"export const a = 1; // fake-lsp-clean",
		);
		expect(result.text).toContain("Primary LSP (typescript): confirmed clean.");
	}, 30_000);

	it("an empty answer whose classification rejects reads unconfirmed, never confirmed clean", async () => {
		vi.spyOn(service, "getCapabilitySnapshots").mockRejectedValue(
			new Error("EACCES: root resolution failed"),
		);
		const result = await diagnose(
			"all",
			"empty-rejected.ts",
			"export const a = 1; // fake-lsp-clean",
		);
		expect(result.text).not.toContain("confirmed clean");
		expect(result.details.unconfirmed).toBe(true);
		expect(
			getDegradationSummary().some(
				(row) => row.kind === "lsp-empty-classification-failed",
			),
		).toBe(true);
	}, 30_000);
});

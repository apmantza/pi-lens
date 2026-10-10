// #2776: this regression must run against the real fake-server wire. The
// handler verdict depends on a custom primary server pushing a diagnostic
// after the pull request is ignored, so mocked clients cannot reproduce the
// server-id provenance path. Admit this file to the serialized
// lsp-spawn-heavy lane to keep its real initialize/diagnostics exchange out
// of the default project's fork storm.
/**
 * Regression coverage for #2776: a custom primary LSP's server-authored
 * diagnostic source must not make its finding render as auxiliary.
 *
 * This drives the real custom-server loader, LSPService, and tool handler.
 * The fake server declares pull diagnostics, ignores the pull, and pushes the
 * diagnostic so the collection path must preserve the delivering server id.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";

const fixture = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const probe = setupTestEnvironment("pi-lens-2776-");
const root = probe.tmpDir;
const probeFixture = path.join(root, "fake-lsp-server.mjs");
const fixtureSource = fs.readFileSync(fixture, "utf8");
fs.writeFileSync(
	probeFixture,
	fixtureSource
		.replace(
			'if (data.method === "textDocument/diagnostic") {',
			'if (data.method === "textDocument/diagnostic") {\n\t\tif (process.env.PROBE_IGNORE_PULL === "1") return;',
		)
		.replace(
			"diagnostics: [],",
			'diagnostics: [{ severity: 1, source: "probe-2776", code: "P2776", message: "syntax error from push", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],',
		),
);

// #3715: module-scope pins, restored in afterAll so nothing here outlives the file.
const ENV_PINS = {
	PI_LENS_HOME: path.join(root, ".pi-lens-home"),
	FAKE_LSP_NOTIFY_BACKLOG_WEDGE: "1",
	PROBE_IGNORE_PULL: "1",
};
const previousEnv = Object.fromEntries(
	Object.keys(ENV_PINS).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, ENV_PINS);

describe("#2776 custom primary diagnostic provenance", () => {
	const workspace = path.join(root, "workspace");
	const file = path.join(workspace, "broken.lua");
	let service: { shutdown: () => Promise<void> } | undefined;

	beforeAll(async () => {
		// Host-boundary stub: this fixture intentionally tests a project custom
		// server in a project pi has trusted.
		setProjectTrustState("trusted");
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(file, "syntax error\n");
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					emmylua: {
						name: "probe custom emmylua",
						extensions: [".lua"],
						command: process.execPath,
						args: [probeFixture],
						rootMarkers: [".luarc.json", ".git"],
					},
				},
				disabledServers: ["lua"],
			}),
		);
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService();
	});

	afterAll(async () => {
		resetProjectTrust();
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await service?.shutdown();
		probe.cleanup();
	});

	it("reports a pushed primary diagnostic even when source is server-authored", async () => {
		const { createLspDiagnosticsTool } =
			await import("../../tools/lsp-diagnostics.js");
		const result = (await createLspDiagnosticsTool().execute(
			"probe-2776",
			{ path: file, waitMs: 2000, serverScope: "primary" },
			undefined,
			null,
			{ cwd: workspace },
		)) as any;
		const text = String(result.content[0]?.text);

		expect(text).toContain("Primary LSP (emmylua): 1 diagnostic.");
		expect(text).not.toContain("Primary LSP (emmylua): confirmed clean.");
		expect(result.details?.primaryDiagnosticsCount).toBe(1);
		expect(result.details?.auxiliaryDiagnosticsCount).toBe(0);
	});
});

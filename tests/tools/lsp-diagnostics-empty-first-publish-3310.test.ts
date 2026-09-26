/**
 * #3310: an asynchronously-indexing push server publishes an EMPTY diagnostic
 * set on `didOpen` (before its whole-workspace index is warm) and the real set
 * once indexing ends. pi-lens's publish handler used to resolve the push wait
 * on the FIRST publish whatever it contained, so `lsp_diagnostics` reported a
 * file with an error as CLEAN — the false clean the wait policy exists to
 * prevent ("a timeout is *not* a false clean", docs/lsp-capability-matrix.md).
 *
 * These cases drive the REAL `lsp_diagnostics` handler, the real LSPService and
 * the real `PHPServer` registry entry — the server that carries the measured
 * `emptyFirstPublish: "indexing"` marker — over a real stdio JSON-RPC wire. The
 * fake server is launched THROUGH that production entry by putting an
 * executable `node_modules/.bin/intelephense` shim in each workspace, which is
 * the first candidate `nodeBinCandidates` resolves (clients/lsp/server.ts), so
 * the strategy lookup under test is the production one, keyed by the real
 * server id, not a hand-set flag.
 *
 * Each case gets its own workspace (hence its own client and its own one-shot
 * hold latch) and its own shim, which sets the wire sequence in its own
 * environment before importing the fixture — so four publish shapes are
 * exercised in one file without a process-wide knob.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
// The fixture root goes through `setupTestEnvironment` rather than a raw
// `mkdtempSync`: the tmp-fixture hygiene gate's owner index is built by grepping
// tests/ for `setupTestEnvironment("<prefix>")`, so a raw root is BOTH
// unattributed (`owner: tests/unknown`) and un-swept, which is how this file
// leaked `pi-lens-3310-*` into /tmp on the #3310 round-1 head. The spawned
// servers hold these workspaces past the last assertion, so the removal is
// `cleanupTestEnvironmentsDrained` in `afterAll` — it keeps the root tracked
// while it drains them, then removes it on the last tick.
//
// PI_LENS_HOME is deliberately NOT repointed here. `tests/support/vitest-setup.ts`
// already pins a per-worker home and heartbeats an owner marker inside it, so a
// module-scope override both sends the LSP service's logs into a directory this
// file then deletes AND makes the worker read as dead to the hygiene sweep
// ("live owners: none") — the second half of that same leak.
const env = setupTestEnvironment("pi-lens-3310-");
const root = env.tmpDir;

const DIRTY_PHP = `<?php\nfunction greet(string $name): string\n{\n    return "Hello " . $undeclared;\n}\n`;

/**
 * A workspace whose `node_modules/.bin/intelephense` is the fake server,
 * pinned to one publish sequence. `composer.json` is what `PHPServer`'s root
 * detector keys on, so the workspace IS the LSP root and the shim is the first
 * launch candidate.
 */
function createWorkspace(
	name: string,
	sequence: string,
	gapMs = 250,
	firstMs = 50,
): string {
	const workspace = path.join(root, name);
	fs.mkdirSync(path.join(workspace, "node_modules", ".bin"), {
		recursive: true,
	});
	fs.writeFileSync(path.join(workspace, "composer.json"), "{}\n");
	const shim = path.join(workspace, "node_modules", ".bin", "intelephense");
	fs.writeFileSync(
		shim,
		[
			"#!/usr/bin/env node",
			// No pull provider: the measured intelephense shape, and what makes
			// this a PUSH-wait session rather than a Tier 1 pull-authoritative one.
			'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
			`process.env.FAKE_LSP_PUBLISH_SEQUENCE = ${JSON.stringify(sequence)};`,
			`process.env.FAKE_LSP_PUBLISH_SEQUENCE_GAP_MS = ${JSON.stringify(String(gapMs))};`,
			// #3484: intelephense carries the reply-first fence marker; measured, it
			// answers the fence before it publishes, so the fake does too.
			`process.env.FAKE_LSP_PUBLISH_SEQUENCE_FIRST_MS = ${JSON.stringify(String(firstMs))};`,
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	fs.chmodSync(shim, 0o755);
	if (process.platform === "win32") {
		fs.writeFileSync(`${shim}.cmd`, `@node "%~dp0intelephense" %*\r\n`);
	}
	return workspace;
}

async function runDiagnostics(
	workspace: string,
	file: string,
	waitMs: number,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(workspace);
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-3310",
		{ path: file, waitMs, serverScope: "primary" },
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

describe("#3310 empty first publish from an indexing push server", () => {
	let service: { shutdown: () => Promise<void> } | undefined;

	beforeAll(async () => {
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService();
	});

	afterAll(async () => {
		// The spawned servers hold the workspaces (and PI_LENS_HOME's log writers
		// sit under the same root), so the service teardown is the drain that has
		// to finish before the root can be removed for good.
		await cleanupTestEnvironmentsDrained("pi-lens-3310-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
	});

	it("reports the finding the indexing server publishes after its empty first push", async () => {
		const workspace = createWorkspace("dirty", "empty,dirty");
		const file = path.join(workspace, "bad.php");
		fs.writeFileSync(file, DIRTY_PHP);

		const { text, details } = await runDiagnostics(workspace, file, 3000);

		expect(details.primaryDiagnosticsCount).toBe(1);
		expect(text).toContain("Primary LSP (php): 1 diagnostic.");
		expect(text).not.toContain("Primary LSP (php): confirmed clean.");
	});

	it("still confirms a clean file on the indexing server's second empty publish", async () => {
		const workspace = createWorkspace("clean", "empty,empty");
		const file = path.join(workspace, "ok.php");
		fs.writeFileSync(
			file,
			`<?php\nfunction ok(string $name): string\n{\n    return "Hello " . $name;\n}\n`,
		);

		const { text, details } = await runDiagnostics(workspace, file, 3000);

		// The affirmative clean comes from the server's own post-index publish,
		// so it is a confirmed clean, never a timeout.
		expect(details.primaryDiagnosticsCount).toBe(0);
		expect(text).toContain("Primary LSP (php): confirmed clean.");
		expect(text).not.toContain("check timed out");
	});

	// #3484: if the first publish ever lands before the fence reply (didOpen
	// order is not measured), the fence drops it. That dropped publish is the
	// one the hold skips; holding the next one too swallowed the real answer.
	it("spends the hold on a publish the diagnostics fence dropped", async () => {
		const workspace = createWorkspace("fenced", "empty,empty", 250, 0);
		const file = path.join(workspace, "fenced.php");
		fs.writeFileSync(
			file,
			`<?php\nfunction ok(string $name): string\n{\n    return "Hello " . $name;\n}\n`,
		);

		const { text } = await runDiagnostics(workspace, file, 3000);

		expect(text).toContain("Primary LSP (php): confirmed clean.");
		expect(text).not.toContain("check timed out");
	});

	it("honours an empty publish that clears an earlier non-empty one inside the debounce window", async () => {
		// The publish that CLEARS a finding arrives while the non-empty one is
		// still in its debounce window, so no push is cached yet and the clearing
		// publish is the client's second publication for a document with no cache
		// entry — the arrival order the hold must not swallow.
		const workspace = createWorkspace("cleared", "dirty,empty", 0);
		const file = path.join(workspace, "fixed.php");
		fs.writeFileSync(file, DIRTY_PHP);

		const { text, details } = await runDiagnostics(workspace, file, 3000);

		expect(details.primaryDiagnosticsCount).toBe(0);
		expect(text).toContain("Primary LSP (php): confirmed clean.");
	});

	it("holds at most one publish per session, so a later touch resolves on an empty publish", async () => {
		const workspace = createWorkspace("oneshot", "empty");
		const file = path.join(workspace, "lonely.php");
		fs.writeFileSync(file, DIRTY_PHP);

		// The only publish is the held one, so this touch has no answer and must
		// report the honest timeout — never a clean bill of health.
		const first = await runDiagnostics(workspace, file, 800);
		expect(first.text).toContain("check timed out");
		expect(first.text).not.toContain("Primary LSP (php): confirmed clean.");

		// The hold is one-shot: the index has now had a full budget to build, so
		// the next touch's empty publish resolves the wait as before.
		fs.writeFileSync(file, `${DIRTY_PHP}// edited\n`);
		const second = await runDiagnostics(workspace, file, 3000);
		expect(second.text).toContain("Primary LSP (php): confirmed clean.");
		expect(second.text).not.toContain("check timed out");
	});
});

// flake-shape: real-process-spawn — a late empty publication after the didOpen scan is the event under test; it arrives on a real server's stdio, which a stub cannot time
/**
 * #4786: a late empty opengrep publication erases its finding, so the file
 * reads clean.
 *
 * Measured with the managed binary (opengrep 1.30.0, opengrep@acf67b4), home
 * pinned, one CPU (`taskset -c 0`), a repo `.opengrep.yml`: after
 * `semgrep/rulesRefreshed` the didOpen scan (`Scan_helpers.scan_file`, never
 * bracketed) publishes the finding, then the open-documents scan
 * (`Scan_helpers.scan_open_documents`) publishes `[]` for the same file right
 * after its `$/progress` end. Both are unversioned. The `[]` is that scan's
 * reset of every file in `Session.scanned_files` it did not target
 * (`scan_something`: "LSP expects empty diagnostics to clear problems"), not a
 * scan of the file.
 *
 * Real stdio fake-server child; the shape comes from the fixture's
 * `FAKE_LSP_PUBLISH_SEQUENCE` knob (`refreshed,dirty,empty`).
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { waitFor } from "../interleaving-kit.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";

let env: ReturnType<typeof setupTestEnvironment> | undefined;

function workspace(): string {
	env ??= setupTestEnvironment("pi-lens-4786-late-empty-");
	return fs.realpathSync(env.tmpDir);
}

afterAll(async () => {
	await cleanupTestEnvironmentsDrained("pi-lens-4786-late-empty-");
});

describe("a late empty opengrep publication (#4786)", () => {
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

	async function openClient(gapMs: string) {
		const proc = await spawnFakeLspServer({
			cwd: workspace(),
			env: {
				...process.env,
				FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
				FAKE_LSP_PUBLISH_SEQUENCE: "refreshed,dirty,empty",
				FAKE_LSP_PUBLISH_SEQUENCE_GAP_MS: gapMs,
			},
		});
		const created = await createLSPClient({
			serverId: "opengrep",
			role: "auxiliary",
			process: proc,
			root: workspace(),
		});
		spawned.push(created);
		return created;
	}

	for (const [label, gapMs] of [
		["inside one debounce window", "0"],
		["after the finding was stored", "400"],
	] as const) {
		it(`keeps the finding when the empty lands ${label}`, async () => {
			const created = await openClient(gapMs);
			const file = path.join(workspace(), `probe-${gapMs}.py`);
			fs.writeFileSync(file, "import subprocess\n");
			await created.notify.open(file, "import subprocess\n", "python");
			await created.waitForDiagnostics(file, 3_000);
			// Settled once the empty has landed (its refusal is recorded under its
			// own kind, naming the file) and the finding is stored. Pre-fix the
			// empty is stored instead, so the finding never is.
			const settled = await waitFor(
				() => ({
					codes: created.getDiagnostics(file).map((d) => d.code),
					refused: getDegradationSummary().find(
						(group) => group.kind === "lsp-auxiliary-empty-after-finding",
					),
				}),
				({ codes, refused }) => codes.length > 0 && refused !== undefined,
				{ timeoutMs: 5_000 },
			);
			expect(settled.codes).toEqual(["P3310"]);
			expect(settled.refused?.count).toBe(1);
			expect(settled.refused?.latestReasons[0]?.subject).toMatch(
				/^opengrep:empty-after-finding:.*probe-\d+\.py$/,
			);
		}, 15_000);
	}
});

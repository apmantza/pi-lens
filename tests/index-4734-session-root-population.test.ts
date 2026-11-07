/**
 * Session-root registry population, by property: #4734 (closes #2657).
 *
 * Recurrence it prevents (shape 9, one-axis bound). `handleToolCall` registered
 * `path.dirname(filePath)` of every file a tool call named, so every directory
 * an agent read became a session root. The registry is FIFO(128)
 * (`SESSION_ROOT_CAP`, `clients/lsp/session-roots.ts`): a session that touched
 * 128 directories of ONE workspace cycled it and evicted the project root
 * itself, the entry carrying the operator's `lsp.disabledServers` denial, which
 * then failed open. #4734 registers the workspace root by identity, so the
 * population of registered roots follows workspaces, not directories touched.
 *
 * The property: for any K, reading one file in each of K directories of one
 * workspace evicts no session root. The signal is the ledger row the issue
 * names, a durable `degradation_ledger` latency row of kind
 * `lsp-session-root-evicted`. K is generated from both sides of the cap
 * (1-6 and 126-140, the cap being 128), because the defect lives past it and a
 * hand test at one K says nothing about the next.
 *
 * Tier 2 (#4632): the BUILT extension in a real pi `AgentSession`, LSP flag on
 * (the `tool_call` seam registers roots only then), the model scripted at the
 * provider boundary. The cases never spawn a language server: the files are
 * `.txt` and nothing resolves a server for them. fast-check runs a bounded
 * `numRuns` under a fixed seed; `examples` carries the K the parent fails on.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	CLEAN_FILE,
	endTurn,
	readTarget,
	step,
} from "./support/pi-session-commit-gate.js";
import { piSessionFixture, startPiSession } from "./support/pi-session.js";

const fixture = piSessionFixture();
let workspaces = 0;

/** One tier-2 session reading K files: ~1 s for K past the cap on the dev box. */
const POPULATION_TIMEOUT_MS = 120_000;

describe("#4734: touching K directories of one workspace never evicts a session root", () => {
	it(
		"records no lsp-session-root-evicted row for any K around the registry cap",
		{ timeout: POPULATION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4734 / #2657. Reading a file in each of 126+
			// directories of one workspace cycled the registry and evicted a session
			// root (the parent at K=126: 9 `lsp-session-root-evicted` ledger rows).
			await fc.assert(
				fc.asyncProperty(
					fc.oneof(
						fc.integer({ min: 1, max: 6 }),
						fc.integer({ min: 126, max: 140 }),
					),
					async (k) => {
						const root = path.join(fixture.root, `w${workspaces++}`, "proj");
						fs.mkdirSync(root, { recursive: true });
						fs.writeFileSync(path.join(root, "package.json"), "{}");
						fs.writeFileSync(path.join(root, "seed.ts"), CLEAN_FILE);
						const files = Array.from({ length: k }, (_, i) => {
							const dir = path.join(root, "src", `d${i}`);
							fs.mkdirSync(dir, { recursive: true });
							const file = path.join(dir, "notes.txt");
							fs.writeFileSync(file, "notes\n");
							return file;
						});
						const handle = await startPiSession({
							root: fixture.root,
							cwd: root,
							flags: new Map([["no-lsp", false]]),
							responses: [
								...files.map((file) => step(readTarget(file), "reading")),
								endTurn("done"),
							],
						});
						await handle.prompt("read them all");
						const { rows, skipped } = await handle.latencyRows();
						expect(handle.errors).toEqual([]);
						await handle.dispose();
						// The reader drops a line it cannot parse and reports the count
						// (AGENTS.md "Test requirements"): a damaged eviction row would
						// otherwise read as no eviction, so the count is asserted first.
						expect({ k, skipped }).toEqual({ k, skipped: 0 });
						const evictions = rows.filter(
							(row) =>
								row.phase === "degradation_ledger" &&
								(row.metadata as { kind?: string } | undefined)?.kind ===
									"lsp-session-root-evicted",
						).length;
						expect({ k, evictions }).toEqual({ k, evictions: 0 });
					},
				),
				{ numRuns: 4, seed: 5370, examples: [[128]] },
			);
		},
	);
});

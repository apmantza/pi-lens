/**
 * Vitest globalSetup: pre-fetch any missing tree-sitter grammar wasms ONCE,
 * before any worker process spawns.
 *
 * `clients/tree-sitter-client.ts`'s `ensureGrammar()` only de-duplicates a
 * concurrent fetch of the same grammar WITHIN one process (an in-flight-promise
 * cache on that process's singleton `TreeSitterClient`). Vitest runs multiple
 * worker PROCESSES in parallel, each with its own independent singleton — so
 * when a grammar is missing from disk (a fresh checkout/worktree where
 * `npm run prepare`'s grammar download didn't run, or was skipped), every
 * worker that needs it at that moment fires its OWN runtime fetch to the same
 * CDN URL simultaneously. The write itself is race-safe (a per-pid temp file +
 * atomic rename, see `clients/grammar-source.ts`), but N simultaneous real
 * network requests to the same endpoint is more likely to hit a transient
 * failure (rate-limit, timeout, drop) than one — and a failed fetch degrades
 * SILENTLY (no thrown exception, see `ensureGrammar`'s doc comment), so
 * whichever test happened to need that grammar in that exact worker at that
 * exact moment just gets an empty/degraded parse. Symptom: a symbol quietly
 * missing from extraction with no error, appearing and disappearing across
 * repeated runs of the same test file with no code change — a classic
 * resource-contention flake, confirmed in dogfooding (2026-07-14) by running
 * the same test batch 3 times back to back and getting 3 different results.
 *
 * Fix: do this ONCE, here, in `globalSetup` (which vitest guarantees runs in
 * a single process before any worker exists) rather than in `setupFiles`
 * (which runs once PER WORKER — that would still let N workers race each
 * other at their own startup, just narrow the window instead of closing it).
 * By the time any worker spawns, every core grammar this repo bundles is
 * already on disk, so `ensureGrammar` never needs to fetch anything at all
 * during the actual test run.
 *
 * Best-effort and cheap in the common case (the main repo already has every
 * grammar downloaded via `prepare`): the existence check below is synchronous
 * and skips the fetch entirely for anything already present, so this adds
 * negligible overhead when nothing is missing.
 */

import { downloadGrammar } from "../../clients/grammar-source.js";
import { CORE } from "../../scripts/download-grammars.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const grammarsDir = path.join(repoRoot, "grammars");

export default async function setup(): Promise<void> {
	// Only the CORE set (`scripts/download-grammars.js`'s own list — the same
	// set `npm run prepare --core` ships in the tarball) — these are the
	// commonly-loaded grammars (ts/tsx/js/py/go/rust/json/yaml/bash/html/css/
	// java) actually exercised across most of the suite, and thus the ones at
	// real risk of the N-workers-race-the-CDN scenario this fixes. The long
	// tail (kotlin/dart/c/cpp/elixir/ruby/…) is lazy-fetched at runtime by
	// design and rarely loaded by more than one worker at once — pre-warming
	// all of it here would just add unconditional startup latency to every
	// test run for grammars that mostly aren't racing in practice.
	const missing = CORE.filter(
		(filename) => !fs.existsSync(path.join(grammarsDir, filename)),
	);
	if (missing.length === 0) return;

	console.error(
		`[pi-lens test setup] pre-fetching ${missing.length} missing tree-sitter grammar(s) once, before test workers spawn: ${missing.join(", ")}`,
	);
	// Sequential, not Promise.all: this already only runs when grammars are
	// missing (rare outside a fresh worktree), and staying sequential avoids
	// firing a burst of simultaneous requests at the CDN from this single
	// process too — the whole point is to stop racing it, not just relocate
	// the race to fewer callers.
	for (const filename of missing) {
		const ok = await downloadGrammar(grammarsDir, filename);
		if (!ok) {
			console.error(
				`[pi-lens test setup] could not pre-fetch grammar '${filename}' (offline or CDN unreachable) — tests needing it will see the existing per-worker degrade path.`,
			);
		}
	}
}

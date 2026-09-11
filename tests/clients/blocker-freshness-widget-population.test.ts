/**
 * #1790: `sweepInlineBlockerFreshness`'s population was built solely from
 * `RuntimeCoordinator`'s inline-blocker map — a live-dispatch-only store. A
 * workspace-diagnostics CACHE HIT never touches that map; it writes straight into
 * `widget-state.ts`'s `files` store (the cache-serve branch of
 * `tools/lsp-diagnostics.ts` calling `reconcileScanDiagnostics`). During the
 * 2026-08-20 dogfood the turn-end sweep logged `total:1 kept:1` while five stale
 * cache-served blocking rows rendered in the widget — the sweep's population never
 * saw them, so its drift check never ran over them either.
 *
 * These tests exercise the fix at the same call shape `runtime-turn.ts` uses:
 * `sweepInlineBlockerFreshness(runtime, cwd, { additionalEntries })`, where
 * `additionalEntries` comes from `widget-state.ts`'s `getWidgetBlockingFilesForSweep`
 * and each entry's `demote` is `markWidgetFileBlockersStale`. Red-first: on pre-fix
 * code `additionalEntries` does not exist on `BlockerFreshnessOptions`, so a
 * cache-served-only row is invisible to `total`/`kept`/`revalidated` and the widget
 * store's `stale` flag is never set by the sweep.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepInlineBlockerFreshness } from "../../clients/blocker-freshness.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	clearWidgetState,
	getFileDiagnostics,
	getWidgetBlockingFilesForSweep,
	isBlocking,
	markWidgetFileBlockersStale,
	recordDiagnostics,
} from "../../clients/widget-state.js";

const tempDirs: string[] = [];
function makeDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	clearWidgetState();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function driftIntoFuture(filePath: string): void {
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(filePath, future, future);
}

function pushIntoPast(filePath: string): void {
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(filePath, past, past);
}

/** Simulates a workspace-diagnostics CACHE-HIT replay: `recordDiagnostics` with an
 * `observedAt` in the past, exactly as `tools/lsp-diagnostics.ts`'s cache-serve
 * branch passes the cache entry's own `scannedAt` — never touching
 * `RuntimeCoordinator`'s inline-blocker map. */
function recordCacheServedBlocking(
	filePath: string,
	message: string,
	observedAt: number,
): void {
	recordDiagnostics(
		filePath,
		[
			{
				severity: "error",
				semantic: "blocking",
				message,
				tool: "lsp",
				rule: "ts(2305)",
				line: 1,
			},
		],
		1,
		observedAt,
	);
}

/** Builds the same `additionalEntries` shape `runtime-turn.ts` passes. */
function widgetAdditionalEntries() {
	return getWidgetBlockingFilesForSweep().map((row) => ({
		filePath: row.filePath,
		recordedAtMs: row.recordedAtMs,
		demote: () => markWidgetFileBlockersStale(row.filePath, "dependency-drift"),
	}));
}

describe("blocker freshness sweep — widget-store population (#1790)", () => {
	it("counts a cache-served-only blocking row in the sweep's population", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-count-");
		const consumer = path.join(dir, "consumer.ts");
		fs.writeFileSync(consumer, "export const y = 1;\n");

		// No RuntimeCoordinator.recordInlineBlockers call at all — this row only
		// exists because a cache hit replayed it into the widget store.
		recordCacheServedBlocking(consumer, "cached blocking finding", Date.now());

		const runtime = new RuntimeCoordinator();
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);

		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		expect(counts.total).toBe(1);
		expect(counts.kept).toBe(1);
	});

	it("demotes a cache-served-only blocking row whose dependency drifted out-of-band", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-demote-");
		const consumer = path.join(dir, "git-env.test.ts");
		const dep = path.join(dir, "worktree.ts");
		fs.writeFileSync(dep, "export const other = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { gitEnv } from "./worktree.js";\nexport const t = gitEnv;\n',
		);

		// Verdict observed 60s ago, replayed from cache — the dependency's real fix
		// (or, per #1782/#1786, the cache simply outliving its own validity) lands
		// after that.
		recordCacheServedBlocking(
			consumer,
			"No exported member 'gitEnv'",
			Date.now() - 60_000,
		);
		expect(
			(getFileDiagnostics(consumer) ?? []).some((d) => isBlocking(d)),
		).toBe(true);

		driftIntoFuture(dep);

		const runtime = new RuntimeCoordinator();
		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		expect(counts.total).toBe(1);
		expect(counts.revalidated).toBe(1);
		expect(counts.kept).toBe(0);

		// Demoted, not dropped: the widget row survives but is no longer blocking.
		const diags = getFileDiagnostics(consumer) ?? [];
		expect(diags).toHaveLength(1);
		expect(diags.some((d) => d.stale === true)).toBe(true);
		expect(diags.some((d) => isBlocking(d))).toBe(false);
	});

	it("keeps a cache-served-only blocking row whose dependency did not drift", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-keep-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);
		pushIntoPast(dep);

		recordCacheServedBlocking(consumer, "cached blocking finding", Date.now());

		const runtime = new RuntimeCoordinator();
		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		expect(counts.total).toBe(1);
		expect(counts.kept).toBe(1);
		expect(counts.revalidated).toBe(0);
		expect(
			(getFileDiagnostics(consumer) ?? []).some((d) => isBlocking(d)),
		).toBe(true);
	});

	// #1790 review F1: the LIVE shape is not a stale widget remnant sitting next to
	// an inline blocker — every live dispatch writes BOTH stores for the SAME
	// verdict (`runtime-tool-result.ts`'s inline-blocker write, `pipeline.ts`'s
	// widget-store write). An earlier revision of this fix DROPPED the widget row
	// on a duplicate path instead of chaining its demote onto the inline entry's:
	// the sweep reported `revalidated:1` while the widget's OWN `isBlocking` for
	// the file still read true — the exact ghost #1790 exists to kill, just moved
	// one store over. This test asserts the WIDGET row's state, not merely the
	// sweep's counts, so that regression cannot hide behind a passing count again.
	it("processes a file present in BOTH stores once, but demotes BOTH stores (F1)", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-dedup-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		// A live dispatch writes BOTH stores for the same verdict.
		runtime.recordInlineBlockers(consumer, "🔴 live blocker", 1, ["lsp"]);
		recordCacheServedBlocking(consumer, "live blocker", Date.now());
		expect(
			(getFileDiagnostics(consumer) ?? []).some((d) => isBlocking(d)),
		).toBe(true);

		driftIntoFuture(dep);

		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		// One population: the file counted once (via its inline-blocker entry), not
		// twice just because it also has a widget-store row.
		expect(counts.total).toBe(1);
		expect(counts.revalidated).toBe(1);

		// Both stores must reflect the demotion. The inline blocker...
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);
		// ...AND the widget row it was deduped against — the row a live TUI/footer
		// render actually reads. Before the F1 fix this stayed `isBlocking: true`.
		const widgetDiags = getFileDiagnostics(consumer) ?? [];
		expect(widgetDiags.some((d) => d.stale === true)).toBe(true);
		expect(widgetDiags.some((d) => isBlocking(d))).toBe(false);
	});

	// #1790 review F5 (P1c): the dependency-drift demotion is a ONE-WAY LATCH for
	// the session (#1631: "cleared only by a fresh dispatch or confirmed-clean
	// retire"). Once an inline entry demotes, it stays `stale` and the main sweep
	// loop short-circuits BEFORE calling `demote()` on every later turn
	// (`if (entry.stale) { counts.alreadyStale += 1; continue; }`). If the widget
	// demote for a LATER cache-served row at the same path was chained onto that
	// already-stale inline entry, it would never fire — a forever-ghost: the
	// widget row demotes NEVER, on ANY future turn, because the entry it was
	// chained to never reaches `demote()` again.
	it("does not create a forever-ghost when a cache-served row lands after the inline entry already latched stale (F5/P1c)", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-alreadystale-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 live blocker", 1, ["lsp"]);
		driftIntoFuture(dep);

		// Turn 1: no widget row yet. The inline entry latches stale, permanently,
		// per the #1631 one-way-latch contract.
		const first = await sweepInlineBlockerFreshness(runtime, dir);
		expect(first.revalidated).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);

		// Turn 2: a cache-served row for the SAME file lands (e.g. a later
		// workspace-diagnostics cache hit). `dep` is already drifted into the
		// future relative to this brand-new baseline, so this row is drifted too.
		recordCacheServedBlocking(consumer, "cached blocking finding", Date.now());
		expect(
			(getFileDiagnostics(consumer) ?? []).some((d) => isBlocking(d)),
		).toBe(true);

		const second = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		// #1790 review F5: the ineligible (already-stale) inline entry and the
		// eligible widget row are now two separate population rows — the widget
		// row is NOT silently absorbed into the inline entry's dead-end demote.
		expect(second.total).toBe(2);
		expect(second.alreadyStale).toBe(1);
		expect(second.revalidated).toBe(1);

		const widgetDiags = getFileDiagnostics(consumer) ?? [];
		expect(widgetDiags.some((d) => d.stale === true)).toBe(true);
		expect(widgetDiags.some((d) => isBlocking(d))).toBe(false);
	});

	// #1790 review F5 (P1d): the reviewer's inversion pair. The SAME widget drift
	// on the SAME file, demoted correctly when it is the ONLY population entry
	// for that file (see the earlier "counts a cache-served-only..." tests) — but
	// adding an UNRELATED ast-grep inline blocker on that file (a hardcoded
	// secret, say — nothing to do with the LSP finding or the drifted import)
	// must not resurrect the ghost just because the path now collides with an
	// ineligible inline entry.
	it("does not resurrect the ghost when an unrelated non-LSP inline blocker shares the same file (F5/P1d)", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-nonlsp-dup-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		// An UNRELATED ast-grep finding on the same file — not LSP, not invalidated
		// by import drift, and (per #1631 review F4) never demoted by this gate.
		runtime.recordInlineBlockers(consumer, "🔴 hardcoded secret", 1, [
			"ast-grep",
		]);
		// The cache-served LSP row landed on the SAME file, with its own baseline.
		recordCacheServedBlocking(consumer, "cached blocking finding", Date.now());
		driftIntoFuture(dep);

		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		// Two separate rows for one file: the ast-grep inline entry (kept, correctly
		// never eligible for import-drift demotion) and the widget's own LSP row
		// (independently drift-checked and demoted).
		expect(counts.total).toBe(2);
		expect(counts.kept).toBe(1);
		expect(counts.revalidated).toBe(1);

		// The unrelated ast-grep blocker is untouched.
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);
		// The widget's own LSP row demoted — the ghost does not reappear just
		// because an unrelated blocker happens to share the file.
		const widgetDiags = getFileDiagnostics(consumer) ?? [];
		expect(widgetDiags.some((d) => d.stale === true)).toBe(true);
		expect(widgetDiags.some((d) => isBlocking(d))).toBe(false);
	});

	it("bounds the added cost to the widget store's own currently-blocking files", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-bound-");
		const files: string[] = [];
		for (let i = 0; i < 5; i++) {
			const f = path.join(dir, `consumer${i}.ts`);
			fs.writeFileSync(f, "export const y = 1;\n");
			recordCacheServedBlocking(f, `cached blocking finding ${i}`, Date.now());
			files.push(f);
		}
		// A clean (non-blocking) widget row must not inflate the population.
		const clean = path.join(dir, "clean.ts");
		fs.writeFileSync(clean, "export const z = 1;\n");
		recordDiagnostics(clean, [], 1, Date.now());

		const runtime = new RuntimeCoordinator();
		const entries = widgetAdditionalEntries();
		expect(entries).toHaveLength(5);
		expect(entries.map((e) => e.filePath).sort()).toEqual([...files].sort());

		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: entries,
		});
		expect(counts.total).toBe(5);
	});
	// Self-drift axis regression: a non-LSP inline entry is now drift-checked, so
	// "is it eligible" no longer answers "may a widget row chain onto it". Here the
	// inline tree-sitter entry demotes on its OWN file's drift while the widget's
	// pure-LSP row is demoted by an IMPORT that drifted. Chaining would have let
	// the inline entry's self-only check stand in for both and never consult the
	// import — so these must stay two independently checked rows.
	it("does not chain a widget row onto a self-only (non-LSP) inline entry (#1790 F5, self-drift axis)", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-selfaxis-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 incomplete assertion", 1, [
			"tree-sitter",
		]);
		recordCacheServedBlocking(consumer, "cached blocking finding", Date.now());
		// Both axes drift: the blocker's own bytes (a real change, since the self
		// axis is content-confirmed) AND the import it does not consult.
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x + 1234567;\n',
		);
		driftIntoFuture(dep);
		driftIntoFuture(consumer);

		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		// Two rows, both demoted on their own axis — not one row standing in for both.
		expect(counts.total).toBe(2);
		expect(counts.revalidated).toBe(2);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);

		const widgetDiags = getFileDiagnostics(consumer) ?? [];
		expect(widgetDiags.some((d) => d.stale === true)).toBe(true);
		expect(widgetDiags.some((d) => isBlocking(d))).toBe(false);
	});
});

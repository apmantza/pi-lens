/**
 * Turn-boundary freshness gate for cached inline blockers (#1631).
 *
 * The live defect: a blocker recorded on a consumer file F re-served at every turn
 * end for the rest of the session after the CAUSE was fixed in a dependency G —
 * because every existing invalidation path keys on F alone. Two shapes:
 *   Case A — G was re-dispatched clean, F never re-verified.
 *   Case B — G was edited out-of-band (bash), never dispatched at all.
 * In both, F is untouched, so no same-path event fires and the stale verdict replays.
 *
 * The fix (fix direction 1 + 2 of #1631) is a READ-time freshness sweep before the
 * cached blocker is re-served: stat F and its forward imports; if any drifted since
 * the verdict, DEMOTE the entry (#1419 demote-not-drop) to a
 * `[stale — re-run to confirm]` advisory instead of re-asserting it at full authority.
 *
 * Red-first: every behavioral test here FAILS on the pre-fix code, where the sweep
 * does not exist / does not demote and the turn-end re-serves the blocker unchanged.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	extractForwardImportPaths,
	sweepInlineBlockerFreshness,
} from "../../clients/blocker-freshness.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";

const tempDirs: string[] = [];

function makeDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Record a blocker on `consumer` then push `dep`'s mtime into the future so it is
 * strictly newer than the verdict's recordedAtMs baseline, regardless of filesystem
 * timestamp granularity. This simulates the dependency changing after the verdict —
 * the exact out-of-band / cross-file shape of #1631.
 */
function driftIntoFuture(filePath: string): void {
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(filePath, future, future);
}

function pushIntoPast(filePath: string): void {
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(filePath, past, past);
}

describe("blocker freshness — forward-import resolution (#1631)", () => {
	it("resolves a relative ESM import to the in-project dependency file", async () => {
		const dir = makeDir("pi-lens-fresh-resolve-");
		const consumer = path.join(dir, "consumer.test.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const imports = await extractForwardImportPaths(dir, consumer);
		expect(imports.map((p) => path.resolve(p))).toContain(path.resolve(dep));
	});

	it("returns empty for a file with no tree-sitter language", async () => {
		const dir = makeDir("pi-lens-fresh-nolang-");
		const file = path.join(dir, "notes.unknownext");
		fs.writeFileSync(file, "not code\n");
		expect(await extractForwardImportPaths(dir, file)).toEqual([]);
	});

	/**
	 * #2424 disclosed behavior change. This sweep resolves its language through
	 * `resolveTreeSitterLanguage`, which before #2424 answered only the twelve
	 * grammars `tree-sitter-shared.ts` hand-listed. `.java` was not one of them,
	 * so a Java blocker's forward imports were ALWAYS `[]` and only the blocker
	 * file's own drift could demote it — even though the java grammar, its
	 * `IMPORT_QUERIES` entry and `resolveJava` in import-resolvers.ts all
	 * shipped. Projecting the map from the registry's grammar column reconnects
	 * them, so cross-file demotion now works for the widened languages
	 * (.java/.kt/.kts/.swift/.dart/.lua/.zig/.ml/.mli/.ex/.exs/.sh/.bash).
	 *
	 * Red on pre-#2424 `clients/`: `expected [] to contain '<dir>/app/Helper.java'`.
	 */
	it("resolves a .java blocker's forward imports (#2424 ext->grammar widening)", async () => {
		const dir = makeDir("pi-lens-fresh-java-");
		fs.mkdirSync(path.join(dir, "app"));
		const dep = path.join(dir, "app", "Helper.java");
		fs.writeFileSync(dep, "package app;\nclass Helper { }\n");
		const consumer = path.join(dir, "Main.java");
		fs.writeFileSync(
			consumer,
			"import app.Helper;\nclass Main { Helper h; }\n",
		);

		const imports = await extractForwardImportPaths(dir, consumer);
		expect(imports.map((p) => path.resolve(p))).toContain(path.resolve(dep));
	});
});

describe("blocker freshness sweep — drift demotion (#1631)", () => {
	it("Case B: demotes a blocker whose dependency drifted out-of-band", async () => {
		// The strongest live shape: the dependency was edited out-of-band (bash), so
		// it was never dispatched and no same-path invalidation could ever fire.
		const dir = makeDir("pi-lens-fresh-caseb-");
		const consumer = path.join(dir, "git-env.test.ts");
		const dep = path.join(dir, "worktree.ts");
		fs.writeFileSync(dep, "export const other = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { gitEnv } from "./worktree.js";\nexport const t = gitEnv;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(
			consumer,
			"🔴 L1 No exported member 'gitEnv' on './worktree.js'",
			1,
			["lsp"],
		);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);

		// The out-of-band fix lands in the dependency after the verdict.
		driftIntoFuture(dep);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(counts.kept).toBe(0);

		const entry = runtime.getInlineBlockersSnapshot()[0];
		expect(entry?.stale).toBe(true);
	});

	it("Case A: demotes a blocker whose dependency was re-dispatched clean", async () => {
		// Same outcome when the dependency change came through a normal edit: the gate
		// keys on disk mtime vs the verdict baseline, not on HOW the dependency changed.
		const dir = makeDir("pi-lens-fresh-casea-");
		const consumer = path.join(dir, "project-path.test.ts");
		const dep = path.join(dir, "project-router.ts");
		fs.writeFileSync(dep, "export const a = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { projectPathFromUrl } from "./project-router.js";\nexport const p = projectPathFromUrl;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(
			consumer,
			"🔴 L1 No exported member 'projectPathFromUrl'",
			1,
			["lsp"],
		);

		// The edit-tool fix rewrites the dependency (content + mtime advance).
		fs.writeFileSync(
			dep,
			"export const a = 1;\nexport const projectPathFromUrl = () => '';\n",
		);
		driftIntoFuture(dep);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);
	});

	it("keeps a blocker whose file and imports did not drift", async () => {
		const dir = makeDir("pi-lens-fresh-keep-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 real blocker", 1, ["lsp"]);
		// Pin the dependency firmly in the past so it cannot read as drifted.
		pushIntoPast(dep);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.revalidated).toBe(0);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);
	});

	it("demotes when the blocker's own file drifted out-of-band", async () => {
		const dir = makeDir("pi-lens-fresh-self-");
		const consumer = path.join(dir, "consumer.ts");
		fs.writeFileSync(consumer, "export const y = 1;\n");

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 blocker", 1, ["lsp"]);
		driftIntoFuture(consumer);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);
	});

	it("counts an already-stale entry once and does not reprocess it", async () => {
		const dir = makeDir("pi-lens-fresh-already-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 blocker", 1, ["lsp"]);
		driftIntoFuture(dep);

		const first = await sweepInlineBlockerFreshness(runtime, dir);
		expect(first.revalidated).toBe(1);
		expect(first.alreadyStale).toBe(0);

		// Second turn: the entry is already stale; it must not be revalidated again.
		const second = await sweepInlineBlockerFreshness(runtime, dir);
		expect(second.revalidated).toBe(0);
		expect(second.alreadyStale).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);
	});

	it("a re-record of the blocker resets the stale flag and baseline", async () => {
		const dir = makeDir("pi-lens-fresh-rerecord-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 blocker", 1, ["lsp"]);
		driftIntoFuture(dep);
		await sweepInlineBlockerFreshness(runtime, dir);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);

		// A fresh dispatch re-records the blocker (new verdict, new baseline) and the
		// dependency is pinned back in the past — the entry is authoritative again.
		runtime.recordInlineBlockers(consumer, "🔴 blocker v2", 2, ["lsp"]);
		pushIntoPast(dep);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);
	});

	it("leaves an unstamped (legacy) record untouched", async () => {
		const dir = makeDir("pi-lens-fresh-legacy-");
		const consumer = path.join(dir, "consumer.ts");
		fs.writeFileSync(consumer, "export const y = 1;\n");

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 blocker", 1, ["lsp"]);
		driftIntoFuture(consumer);
		// Strip the timestamp baseline to model a pre-fix/legacy record.
		const key = path.resolve(consumer);
		const map = (
			runtime as unknown as {
				_pendingInlineBlockers: {
					get(p: string): { recordedAtMs?: number } | undefined;
					set(p: string, v: unknown): void;
				};
			}
		)._pendingInlineBlockers;
		const existing = map.get(key);
		expect(existing).toBeDefined();
		map.set(key, { ...existing, recordedAtMs: undefined });

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.revalidated).toBe(0);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);
	});

	// #1631 review F2: on Windows a file's mtime can LEAD the `Date.now()` baseline
	// by a measurable margin (reviewer measurement: up to ~11.4ms across 200 writes),
	// not just sub-millisecond rounding. A +1ms tolerance falsely demoted a blocker
	// with zero real drift; +50ms must absorb that lead without absorbing an actual
	// edit gap.
	it("does not demote for a small mtime lead within host-clock skew tolerance (#1631 review F2)", async () => {
		const dir = makeDir("pi-lens-fresh-skew-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 blocker", 1, ["lsp"]);
		const recordedAtMs = runtime.getInlineBlockersSnapshot()[0]?.recordedAtMs;
		expect(recordedAtMs).toBeDefined();

		// Simulate the host-clock skew directly rather than depending on real OS
		// timing: the dependency's mtime leads the verdict baseline by 10ms — beyond
		// the old +1ms tolerance, comfortably inside the measured Windows skew.
		const skewed = new Date((recordedAtMs as number) + 10);
		fs.utimesSync(dep, skewed, skewed);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.revalidated).toBe(0);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);
	});

	// #1631 review F4: an inline blocker whose recorded `sources` are NOT (all)
	// `"lsp"` — an ast-grep secret, a CVE, any non-language-server verdict — must
	// not demote on import drift. Its truth doesn't depend on what the file imports.
	it("does not demote a non-LSP-sourced blocker on dependency drift (#1631 review F4)", async () => {
		const dir = makeDir("pi-lens-fresh-nonlsp-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 hardcoded secret", 1, [
			"ast-grep",
		]);
		driftIntoFuture(dep);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.revalidated).toBe(0);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);
	});

	// A blocker with MIXED sources (some lsp, some not) is provenance the sweep
	// cannot fully vouch for either — same fail-closed shape as
	// `retireInlineBlockerOnConfirmedClean`'s coverage gate.
	it("does not demote a mixed-sources blocker on dependency drift (#1631 review F4)", async () => {
		const dir = makeDir("pi-lens-fresh-mixed-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 mixed blocker", 1, [
			"lsp",
			"ast-grep",
		]);
		driftIntoFuture(dep);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.revalidated).toBe(0);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);
	});
});

// #1561 remainder: the self axis. #1631 review F4 correctly excluded a non-LSP
// record from IMPORT drift, but excluded it from its OWN file's drift with it —
// and no other path could clear such a record, because
// `retireInlineBlockerOnConfirmedClean` needs `coveredSources` to cover
// `"tree-sitter"` and `coveredSourcesForCheck` can only ever name registered LSP
// servers. Live shape: a `ts-incomplete-assertion` blocker re-served every turn
// for a whole session against a file proven clean by grep, LSP, and a passing test.
describe("blocker freshness sweep — self-drift on non-LSP provenance", () => {
	it("demotes a tree-sitter blocker when its own file drifted", async () => {
		const dir = makeDir("pi-lens-fresh-selfts-");
		const target = path.join(dir, "consult.test.ts");
		fs.writeFileSync(target, "expect(foo).toBe;\n");

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(target, "🔴 L153: Incomplete assertion", 1, [
			"tree-sitter",
		]);
		driftIntoFuture(target);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);
	});

	it("demotes an ast-grep blocker when its own file drifted", async () => {
		const dir = makeDir("pi-lens-fresh-selfsg-");
		const target = path.join(dir, "consumer.ts");
		fs.writeFileSync(target, "export const y = 1;\n");

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(target, "🔴 hardcoded secret", 1, [
			"ast-grep",
		]);
		driftIntoFuture(target);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);
	});

	// Deliberate: `pipeline.ts` contributes the literal `"unknown"` for an
	// untagged diagnostic so an LSP check cannot claim coverage for it. That
	// pins it against a COVERAGE claim; it says nothing about the file's bytes
	// changing underneath the verdict, which invalidates it whatever raised it.
	it('demotes an "unknown"-tagged blocker when its own file drifted', async () => {
		const dir = makeDir("pi-lens-fresh-selfunk-");
		const target = path.join(dir, "consumer.ts");
		fs.writeFileSync(target, "export const y = 1;\n");

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(target, "🔴 untagged blocker", 1, ["unknown"]);
		driftIntoFuture(target);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);
	});

	// The import axis stays excluded for non-LSP provenance — #1631 review F4's
	// actual claim. Only the file's own bytes may demote these.
	it("still keeps a tree-sitter blocker when only a dependency drifted", async () => {
		const dir = makeDir("pi-lens-fresh-selftsdep-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 tree-sitter blocker", 1, [
			"tree-sitter",
		]);
		driftIntoFuture(dep);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.revalidated).toBe(0);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);
	});

	// A record with NO recorded provenance stays fail-closed, matching the test
	// `retireInlineBlockerOnConfirmedClean` applies before it will retire.
	it("leaves a record with no recorded sources untouched on own-file drift", async () => {
		const dir = makeDir("pi-lens-fresh-selfnoprov-");
		const target = path.join(dir, "consumer.ts");
		fs.writeFileSync(target, "export const y = 1;\n");

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(target, "🔴 unknown provenance", 1);
		driftIntoFuture(target);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.revalidated).toBe(0);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);
	});
});

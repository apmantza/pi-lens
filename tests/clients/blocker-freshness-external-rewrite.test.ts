/**
 * All-LSP own-file freshness via the content-confirmed self-drift axis
 * (#2982 remainder, stacked on #2983).
 *
 * The reported defect: an out-of-band auto-reformatter rewrote a file outside
 * the edit pipeline, and the mtime-only own-file check in `detectDrift` re-served
 * the pre-rewrite blocking findings at every turn boundary. An external write can
 * land at-or-before the `recordedAtMs` baseline, so mtime alone is blind to the
 * own-file drift — the content axis (size → hash, re-arming) must own the
 * all-LSP own-file verdict when a baseline was captured.
 *
 * These tests are red-first on the pre-#2982-remainder code, where the all-LSP
 * own file is checked by mtime alone and the size-changing / at-or-before-mtime
 * rewrite is re-served as authoritative.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepInlineBlockerFreshness } from "../../clients/blocker-freshness.js";
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

function driftIntoFuture(filePath: string): void {
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(filePath, future, future);
}

/**
 * Record an all-LSP verdict against `before` AND attach its content baseline
 * (size + hash) through the production `recordInlineBlockers` seam. This is
 * the synchronous dispatch-path shape (#2982 review round 2). Returns
 * `recordedAtMs` so a test can pin the file's mtime against the baseline.
 */
function recordAllLspWithBaseline(
	runtime: RuntimeCoordinator,
	filePath: string,
	summary: string,
	before: string,
): number {
	fs.writeFileSync(filePath, before);
	const content = fs.readFileSync(filePath);
	const recordedAtMs = runtime.recordInlineBlockers(
		filePath,
		summary,
		1,
		["lsp"],
		undefined,
		{
			size: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
		},
	);
	return recordedAtMs;
}

/** Pin the file's mtime to `recordedAtMs` so it is at-or-before the baseline. */
function pinMtimeToBaseline(filePath: string, recordedAtMs: number): void {
	const d = new Date(recordedAtMs);
	fs.utimesSync(filePath, d, d);
}

describe("all-LSP own-file freshness via the content axis (#2982 remainder)", () => {
	// The discriminating case: a size-changing own-file rewrite whose mtime lands
	// at-or-before the baseline. The mtime-only check reads the file as unchanged
	// (mtime never advanced past the baseline) and re-serves the stale findings;
	// the size gate fires regardless of the mtime relationship and demotes.
	it("demotes an all-LSP blocker on a size-changing own-file rewrite whose mtime is at-or-before the baseline", async () => {
		const dir = makeDir("pi-lens-alllsp-owndrift-");
		const target = path.join(dir, "consumer.ts");
		const runtime = new RuntimeCoordinator();
		const recordedAtMs = recordAllLspWithBaseline(
			runtime,
			target,
			"🔴 L1: Type statement is only supported in Python 3.12",
			"export const a = 1;\n",
		);
		// An external reformatter rewrites the file (different size) and its mtime
		// lands at-or-before the baseline — the mtime-only check is blind.
		fs.writeFileSync(
			target,
			"export const a = 1;\n// reformatted by an external tool\n",
		);
		pinMtimeToBaseline(target, recordedAtMs);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		const entry = runtime.getInlineBlockersSnapshot()[0];
		expect(entry?.stale).toBe(true);
		expect(entry?.staleReason).toBe("self-drift");
	});

	// No false positive: a same-length `touch` (mtime advanced, every byte put)
	// is confirmed unchanged by the hash tier, so the own file is skipped in the
	// mtime check and the blocker stays authoritative.
	it("keeps an all-LSP blocker when a same-length own-file touch is confirmed unchanged", async () => {
		const dir = makeDir("pi-lens-alllsp-touch-");
		const target = path.join(dir, "consumer.ts");
		const runtime = new RuntimeCoordinator();
		recordAllLspWithBaseline(
			runtime,
			target,
			"🔴 L1: hardcoded secret",
			"const limit = 10;\n",
		);
		// A `touch`: mtime advanced, every byte where it was.
		driftIntoFuture(target);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(0);
		expect(counts.kept).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(false);
	});

	// HIGH F1: an all-LSP baseline must force content confirmation even when mtime
	// did not move. This is red on the pre-fix mtime fast path, which keeps the
	// changed bytes authoritative.
	it("demotes a same-length all-LSP rewrite that lands at-or-before the baseline", async () => {
		const dir = makeDir("pi-lens-alllsp-sameatbase-");
		const target = path.join(dir, "consumer.ts");
		const runtime = new RuntimeCoordinator();
		const recordedAtMs = recordAllLspWithBaseline(
			runtime,
			target,
			"🔴 L1: incomplete assertion",
			"const limit = 10;\n",
		);
		// Same length, one character swapped, mtime pinned at-or-before the baseline.
		fs.writeFileSync(target, "const limit = 99;\n");
		pinMtimeToBaseline(target, recordedAtMs);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);
	});

	// No baseline (the bounded read never landed): the content axis cannot decide,
	// so the own file falls back to the mtime check (the pre-#2982 behavior,
	// fail-open). A drifted own file is still demoted through that path.
	it("demotes an all-LSP blocker with no content baseline via the mtime fallback", async () => {
		const dir = makeDir("pi-lens-alllsp-nobaseline-");
		const target = path.join(dir, "consumer.ts");
		const runtime = new RuntimeCoordinator();
		fs.writeFileSync(target, "export const a = 1;\n");
		// No `setInlineBlockerContentBaseline`: the record has no baseline.
		runtime.recordInlineBlockers(target, "🔴 L1: some issue", 1, ["lsp"]);
		// The own file drifted (mtime advanced past the baseline).
		driftIntoFuture(target);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBe(true);
	});
});

/**
 * #3383 — every stream `data` handler in the shipped trees is registered with
 * the bound that keeps its accumulation finite.
 *
 * ## The recurrence this guards
 *
 * #3375: `safeSpawnAsync`'s chunk handler grew one JS string per chunk with no
 * ceiling, V8 refused the next concatenation with `RangeError: Invalid string
 * length`, and because that throw is raised inside a `data` handler — delivered
 * to the process, never to the awaiting caller — it terminated the Pi host (Pi
 * 0.86.1, 2026-09-22). #3375 fixed ONE seam. #3383's sweep then found nine more
 * accumulators in `data` handlers that never reach that seam: two forked-worker
 * pipes, the unref'd process-table collector, two installer interpreter probes,
 * four newline-framing buffers. Every one of them was the identical shape, and
 * nothing in the tree could have told a reviewer that adding the tenth was a
 * defect.
 *
 * So this sweep is a POPULATION pin, not a heuristic: it finds every
 * `on("data"` / `once("data"` registration under `clients/`, `mcp/`, `tools/`
 * and `index.ts`, and requires each FILE to be registered below with how many
 * it has and what bounds them. A new handler in a registered file trips the
 * count; a handler in a new file trips the registry; a bound whose evidence
 * disappears from the file trips the evidence check.
 *
 * PER-NEEDLE STRING POLICY. The handler needle's own evidence IS a string
 * literal (`.on("data"`), so the site scan strips COMMENTS but keeps string
 * contents (`strings: "keep"`) — under the default policy `"data"` blanks to
 * `""` and the sweep matches nothing at all, which is how the first draft of
 * this file reported a clean zero across 370 files. The self-test below pins
 * that direction. Bound EVIDENCE is matched on the default strip instead, where
 * string contents are blanked too: a bound named in a comment or a message
 * string must never satisfy the evidence check.
 *
 * What it deliberately does NOT do is judge boundedness mechanically. "This
 * `+=` has a ceiling" is a data-flow question a line scan cannot answer (the
 * bound can be a constant three lines up, a ring buffer's `shift`, a sink
 * object's own invariant, or the absence of retention altogether), and a
 * detector that guessed would either miss the real shape or fire on every
 * healthy handler. The registry makes the human verdict explicit and dated
 * instead — which is the same trade `tests/clients/…-sweep` files already make
 * across this repo.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** `x.on("data"` / `x.once("data"`, including the multi-line argument form. */
const DATA_HANDLER = /\.(?:on|once)\(\s*"data"/g;

interface BoundedHandlers {
	/** How many `data` handlers this file registers. */
	handlers: number;
	/** What keeps each accumulation finite — the reviewed verdict. */
	bound: string;
	/**
	 * Needles that must still be present in the file for `bound` to be true.
	 * Each one is an EXPRESSION, never a bare name: an unused `import
	 * { createBoundedOutputSink }` satisfied the first draft's name-shaped
	 * needles, so deleting the sink's only call left this sweep green
	 * (mutation M10c).
	 */
	evidence: readonly string[];
}

/**
 * Every file in the shipped trees that attaches a `data` handler, with the
 * bound that makes it safe. Verdicts recorded by #3383's sweep; a file that
 * gains or loses a handler re-enters review by failing the count.
 */
const REGISTRY: Readonly<Record<string, BoundedHandlers>> = {
	"clients/safe-spawn.ts": {
		handlers: 2,
		bound:
			"#3375: `maxOutputBytes`, resolved to DEFAULT_MAX_OUTPUT_BYTES when the caller passes none; the handler is total and the child is killed at the cap.",
		evidence: [
			"retainedOutputBytes + bytes <= maxOutputBytes",
			": DEFAULT_MAX_OUTPUT_BYTES;",
		],
	},
	"clients/child-unref.ts": {
		handlers: 1,
		bound:
			"#3383: createBoundedOutputSink() at the shared default; a truncated process table is the partial-output ending this collector already documents.",
		evidence: ["createBoundedOutputSink()", "out.append(chunk)"],
	},
	"clients/mcp/review.ts": {
		handlers: 2,
		bound:
			"#3383: createBoundedOutputSink() per pipe; a truncated stdout kills the worker and resolves the cap as the outcome.",
		evidence: [
			"createBoundedOutputSink()",
			"stdout.append(chunk)",
			"stderr.append(chunk)",
		],
	},
	"clients/mcp/ipc.ts": {
		handlers: 2,
		bound:
			"#3383: both replies are framed by createWarmIpcLineReader, bounded by MAX_FRAMED_LINE_BYTES per line.",
		evidence: ["bufferedBytes <= MAX_FRAMED_LINE_BYTES", "onOverflow: () =>"],
	},
	"clients/warm-attach.ts": {
		handlers: 1,
		bound:
			"#3383: createWarmIpcLineReader (one-shot), bounded by MAX_FRAMED_LINE_BYTES per line.",
		evidence: ["createWarmIpcLineReader(", "onOverflow: () =>"],
	},
	"clients/installer/index.ts": {
		handlers: 2,
		bound:
			"The two interpreter user-base probes (#3383's createBoundedOutputSink pair) moved onto the spawn seam's own output cap in #4530 and attach no handler here. The two Buffer[] sinks — the HTTPS asset body and the gunzip of it — are deliberately UNBOUNDED: `Buffer.concat` has no reachable length ceiling (buffer.constants.MAX_LENGTH is 9007199254740991 on Node 22), so there is no throw to convert into a bounded result, the failure mode is host OOM, and any byte cap would refuse an asset the user explicitly asked to install (#3383 non-goal).",
		evidence: ["Buffer.concat(chunks)"],
	},
	"clients/lsp/launch.ts": {
		handlers: 2,
		bound:
			"Both stderr previews stop retaining at 4000 characters (`if (… .length >= 4000) return;`).",
		evidence: ["stderrPreview.length >= 4000", "startupStderr.length >= 4000"],
	},
	"clients/lsp/client.ts": {
		handlers: 1,
		bound:
			"The stderr ring shifts past MAX_STDERR_LINES and the startup preview stops at 4096 characters.",
		evidence: [
			"stderrRing.length > MAX_STDERR_LINES",
			"startupState.stderr.length < 4096",
		],
	},
	"mcp/server.ts": {
		handlers: 2,
		bound:
			"#3383: both the warm socket reader and the host's stdin loop are framed by createWarmIpcLineReader, bounded by MAX_FRAMED_LINE_BYTES per line.",
		evidence: ["createWarmIpcLineReader(", "onOverflow: () =>"],
	},
};

interface Site {
	relPath: string;
	count: number;
	source: string;
}

function scanShippedTrees(): { sites: Site[]; filesScanned: number } {
	const roots = ["clients", "mcp", "tools"].map((dir) =>
		path.join(REPO_ROOT, dir),
	);
	const files = [
		...roots.flatMap((root) => listSourceFiles(root, { skipTests: true })),
		path.join(REPO_ROOT, "index.ts"),
	];
	const sites: Site[] = [];
	for (const { file, source } of readWalkedFiles(files)) {
		const matches = stripSource(source, { strings: "keep" }).match(
			DATA_HANDLER,
		);
		if (!matches) continue;
		sites.push({
			relPath: relativePosix(REPO_ROOT, file),
			count: matches.length,
			source,
		});
	}
	return { sites, filesScanned: files.length };
}

describe("data-handler bounds sweep (#3383)", () => {
	const { sites, filesScanned } = scanShippedTrees();

	it("is only as good as its needle: the default strip finds nothing", () => {
		// The direction that makes a sweep lie. `stripSource`'s default blanks
		// string CONTENTS, so `.on("data"` becomes `.on(""` and every real site
		// vanishes while the sweep still reports success.
		const withDefaultStrip = readWalkedFiles([
			path.join(REPO_ROOT, "clients/safe-spawn.ts"),
		]).flatMap(({ source }) => stripSource(source).match(DATA_HANDLER) ?? []);
		expect(withDefaultStrip).toEqual([]);
		expect(
			readWalkedFiles([path.join(REPO_ROOT, "clients/safe-spawn.ts")]).flatMap(
				({ source }) =>
					stripSource(source, { strings: "keep" }).match(DATA_HANDLER) ?? [],
			),
		).toHaveLength(2);
	});

	it(
		"registers every file that attaches a stream data handler",
		() => {
			assertNonEmptyScan("data-handler bounds", sites.length, 9);
			const audit = auditRegistry({
				sweepName: "data-handler bounds",
				flagged: sites.map((site) => ({
					key: site.relPath,
					detail: `${site.relPath} (${site.count} handler(s))`,
				})),
				registered: Object.keys(REGISTRY),
				scannedCount: filesScanned,
				minScanned: 200,
				minFlagged: 9,
				remediation:
					"A new stream `data` handler must state what bounds its accumulation: add the file to REGISTRY in this sweep with the handler count, the bound, and a needle proving the bound is in the file. If nothing bounds it, that is the defect #3375/#3383 exist to prevent — bound it first.",
			});
			expect(audit.problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"pins how many handlers each registered file attaches",
		() => {
			const counts = Object.fromEntries(
				sites.map((site) => [site.relPath, site.count]),
			);
			const expected = Object.fromEntries(
				Object.entries(REGISTRY).map(([file, entry]) => [file, entry.handlers]),
			);
			expect(counts).toEqual(expected);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"keeps each registered bound's evidence present in its own file",
		() => {
			const missing: string[] = [];
			for (const site of sites) {
				const entry = REGISTRY[site.relPath];
				if (!entry) continue;
				const code = stripSource(site.source);
				for (const needle of entry.evidence) {
					if (!code.includes(needle))
						missing.push(`${site.relPath}: bound evidence "${needle}" is gone`);
				}
			}
			expect(missing).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});

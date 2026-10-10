#!/usr/bin/env node

// The CLI flushes the snapshot explicitly and verifies the write — a user
// debounce (especially 0) races the fire-and-forget background writer and can
// consume the pending payload before our flush sees it (#943 review). The
// builder reads this env lazily on every persist, so forcing it here (before
// any build runs; import hoisting is irrelevant) keeps the queued payload in
// place for flushReviewGraphPersist to claim.
process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";

import { setProjectTrustState } from "../clients/project-trust.js";
import { logExtension } from "../clients/extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { FactStore } from "../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	flushReviewGraphPersist,
	getGraphBuildInfoForGraph,
	getLastGraphBuildInfo,
	getLastReviewGraphBuildAttempt,
	graphWasmTrapDetail,
	reviewGraphCachePath,
} from "../clients/review-graph/builder.js";
import { isTreeSitterWasmAborted } from "../clients/tree-sitter-shared.js";

function cwdArg(): string {
	const equals = process.argv.find((arg) => arg.startsWith("--cwd="));
	if (equals) return equals.slice("--cwd=".length);
	const index = process.argv.indexOf("--cwd");
	if (index >= 0) {
		const value = process.argv[index + 1];
		if (!value || value.startsWith("-"))
			throw new Error("--cwd requires a directory");
		return value;
	}
	return process.cwd();
}

/** Sentinel so main()'s catch doesn't double-print a reason fail() already wrote. */
const FAILED = Symbol("build-graph-failed");

// Soft-fail: write the reason, set the exit code, and let the event loop
// drain naturally. A hard process.exit(1) here aborted with a libuv
// assertion on Windows whenever async fs handles (log appends) were still
// live (#943 review finding 3). Exit hooks (persist teardown, log flushSync)
// still run on natural exit.
function fail(reason: string): never {
	process.stderr.write(`pi-lens build-graph failed: ${reason}\n`);
	process.exitCode = 1;
	throw FAILED;
}

async function buildGraph(): Promise<void> {
	const cwd = path.resolve(cwdArg());
	let stat: fs.Stats;
	try {
		stat = fs.statSync(cwd);
	} catch (err) {
		fail(`cannot access cwd ${cwd}: ${(err as Error).message}`);
	}
	if (!stat.isDirectory()) fail(`cwd is not a directory: ${cwd}`);

	const startedAt = Date.now();
	// Subject labels this store's capacity-eviction telemetry distinctly from
	// the other five production FactStore instances (#2243 review round 3, F1).
	const graph = await buildOrUpdateGraph(cwd, [], new FactStore("mcp-cli"));
	const attempt = getLastReviewGraphBuildAttempt(cwd);
	// "succeeded" can still carry a `reason` string — persistGraph() stamps one
	// on to explain a partial (over-cap) persist, which is NOT a failure (#960
	// made a capped persist honest-but-successful). Only "failed"/"skipped"
	// (unsafe_root, source-file cap, thrown build error) are real failures; a
	// benign reason on a succeeded build is surfaced later via coverage
	// instead of being treated as fatal here.
	if (!attempt || attempt.outcome !== "succeeded") {
		fail(attempt?.reason ?? attempt?.outcome ?? "build produced no result");
	}

	const persisted = flushReviewGraphPersist(cwd);
	if (!persisted.ok) {
		// An unchanged repo queues no persist — the disk-cache hit and the
		// pure-drift incremental path both deliberately skip rewriting the
		// blob. That is SUCCESS for a scheduled build (#943 review finding 1:
		// a nightly cron on a quiet repo must not fail every run), provided
		// the snapshot actually exists on disk.
		const buildInfo = getLastGraphBuildInfo();
		const snapshotPath = reviewGraphCachePath(cwd);
		if (!buildInfo.graphChanged && fs.existsSync(snapshotPath)) {
			const bytes = fs.statSync(snapshotPath).size;
			const durationMs = Date.now() - startedAt;
			process.stdout.write(
				`pi-lens build-graph: snapshot already current (mode=${buildInfo.mode}) ` +
					`files=${graph.fileNodes.size} nodes=${graph.nodes.size} ` +
					`edges=${graph.edges.length} jsonBytes=${bytes} durationMs=${durationMs}\n`,
			);
			return;
		}
		fail(persisted.reason ?? "graph snapshot was not persisted");
	}

	const durationMs = Date.now() - startedAt;
	const coverage = persisted.coverage;
	const wasmTrappedFiles =
		getGraphBuildInfoForGraph(graph).wasmTrappedFiles ?? 0;
	// #3678: the build persisted, but tree-sitter lost symbols — either a
	// per-file web-tree-sitter trap (#3605) or the process-wide runtime abort
	// that follows a 4th trap or an abort-class error. Both are
	// honest-but-successful, matching the over-cap PARTIAL persist (#960): exit
	// 0 so a scheduled nightly build is not failed, but never print the clean
	// line. An abort is process-lifetime, so only a restart recovers it.
	const wasmAborted = isTreeSitterWasmAborted();
	if (wasmAborted || wasmTrappedFiles > 0) {
		const degraded = wasmAborted
			? "review graph degraded — tree-sitter disabled for this process until restart"
			: graphWasmTrapDetail(wasmTrappedFiles);
		const recovery = wasmAborted
			? ""
			: "those files were skipped and are re-extracted on the next build; ";
		process.stdout.write(
			`pi-lens build-graph: ${degraded}; ${recovery}` +
				(coverage?.partial
					? `PARTIAL persist (cap=${coverage.cap} exceeded) ` +
						`persistedNodes=${coverage.persistedNodes}/${coverage.totalNodes} ` +
						`persistedEdges=${coverage.persistedEdges}/${coverage.totalEdges} `
					: "") +
				`files=${graph.fileNodes.size} nodes=${graph.nodes.size} ` +
				`edges=${graph.edges.length} elements=${persisted.elements} ` +
				`jsonBytes=${persisted.bytes} durationMs=${durationMs}\n`,
		);
		return;
	}
	if (coverage?.partial) {
		// #533/#936 honesty: an over-cap build DID succeed and DID persist, but
		// only a subgraph — say so plainly instead of printing the same line a
		// full build would, which would silently misrepresent a capped repo as
		// fully covered.
		process.stdout.write(
			`pi-lens build-graph: PARTIAL persist (cap=${coverage.cap} exceeded) ` +
				`files=${graph.fileNodes.size} nodes=${graph.nodes.size} ` +
				`edges=${graph.edges.length} persistedNodes=${coverage.persistedNodes}/${coverage.totalNodes} ` +
				`persistedEdges=${coverage.persistedEdges}/${coverage.totalEdges} ` +
				`elements=${persisted.elements} jsonBytes=${persisted.bytes} durationMs=${durationMs}\n`,
		);
		return;
	}
	process.stdout.write(
		`pi-lens build-graph: files=${graph.fileNodes.size} nodes=${graph.nodes.size} ` +
			`edges=${graph.edges.length} elements=${persisted.elements} ` +
			`jsonBytes=${persisted.bytes} durationMs=${durationMs}\n`,
	);
}

async function main(): Promise<void> {
	// #4300: this process runs outside pi; its caller owns workspace trust.
	setProjectTrustState("trusted");
	logExtension({
		subsystem: "project-trust",
		level: "debug",
		message:
			"build-graph: workspace trust belongs to the calling client; pi trust not consulted",
	});

	const command = process.argv[2];
	if (command !== "build-graph") {
		fail("usage: pi-lens build-graph [--cwd <dir>]");
	}
	await buildGraph();
}

main().catch((err) => {
	if (err === FAILED) return;
	process.stderr.write(
		`pi-lens build-graph failed: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exitCode = 1;
});

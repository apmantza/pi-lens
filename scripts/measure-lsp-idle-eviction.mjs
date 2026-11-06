#!/usr/bin/env node
/**
 * Nightly measurement of per-server LSP idle-eviction cost (#3645).
 *
 * For every server in the registry (`LSP_SERVERS`, never a hand list) this
 * spawns the server on its smoke fixture, then lets the REAL idle-eviction
 * timer release it and respawns it through the ordinary request path. The row
 * it writes says whether the respawned server still reports every finding it
 * reported before eviction, how long init and the post-eviction cold start
 * took, and how much memory the server held. The probe changes no server's
 * policy: it flips `idleEviction` in THIS process only, for the one server
 * under test, and restores it.
 *
 *   node scripts/measure-lsp-idle-eviction.mjs [serverId ...] [--install]
 *       [--doc <path>] [--summary <path>] [--drift-body <path>]
 *       [--budget-seconds <n>] [--window-ms <n>]
 *
 * Requires `npm run build:dist`. Writes docs/lsp-idle-eviction.md (stable
 * columns only, regenerated from scratch each run so an absent server reads `unavailable`,
 * never a stale or zero row), appends the timing and memory figures to the job summary when
 * `GITHUB_STEP_SUMMARY` is set, and optionally writes them as JSON.
 *
 * `--drift-body` writes the tracking-issue body when a server is in hard drift
 * and removes the file otherwise; `--drift-state` writes `drift`, `clean` or
 * `unknown`. The nightly's notify step files or refreshes the single tracking
 * issue on `drift`, closes it only on `clean` (every transparent server
 * eligible), and leaves it alone on `unknown`
 * (scripts/upsert-tracking-issue.mjs).
 *
 * Exit code: 1 only for drift (a server the registry declares `transparent`
 * that the measurement vetoes). The nightly step is `continue-on-error`, so
 * drift shows as a failed step without failing the job; an absent toolchain or
 * offline registry is `unavailable` and exits 0.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeEvaluatedRecord } from "./lib/assert-evaluated.mjs";
import {
	buildIdleEvictionDriftBody,
	driftIssueState,
	idleEvictionDrift,
	renderIdleEvictionDoc,
	renderRawTable,
	summarizeRows,
} from "./lib/lsp-idle-eviction-doc.mjs";
import {
	createServiceDriver,
	fixtureWorkspaceLifecycle,
	measureRegistry,
	probeServer,
	residentTreeBytes,
} from "./lib/lsp-idle-eviction-probe.mjs";
import {
	adoptFixtureProjectTrust,
	bootstrapFixtureWorkspace,
	withScratchHome,
} from "./lib/lsp-fixture-workspace.mjs";
import { snapshotProcesses } from "./lib/process-scan.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : fallback;
};
const flagNames = new Set([
	"--doc",
	"--summary",
	"--drift-body",
	"--drift-state",
	"--budget-seconds",
	"--window-ms",
]);
const serverFilter = argv.filter(
	(a, i) => !a.startsWith("--") && !flagNames.has(argv[i - 1]),
);
const docPath = path.resolve(
	flagValue("--doc", path.join(repoRoot, "docs", "lsp-idle-eviction.md")),
);
const summaryPath = flagValue("--summary", undefined);
// The job cap is 35 minutes; earlier steps have measured ~14. Stopping here
// leaves a disclosed `budget-exhausted` row for every server not reached
// instead of letting the job timeout discard the whole artifact. The default is
// the nightly's value (tool-smoke.yml passes the same 600), so a local run and
// the nightly stop at the same point.
const budgetMs = Number(flagValue("--budget-seconds", "600")) * 1000;
const windowMs = Number(flagValue("--window-ms", "3000"));
const driftBodyPath = flagValue("--drift-body", undefined);
const driftStatePath = flagValue("--drift-state", undefined);

// #2670/#2506-shape: pin PI_LENS_HOME/PILENS_DATA_DIR to a scratch dir BEFORE
// the first dist/ import below; the latency logger reads its directory at
// module load.
withScratchHome();

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { LSP_FIXTURES, ensureSmokeLombokJar, runFixtureSetup } = await imp(
	"scripts/smoke-tools.mjs",
);
const { getLSPService, resetLSPService } = await imp(
	"dist/clients/lsp/index.js",
);
const serverModule = await imp("dist/clients/lsp/server.js");
const { LSP_SERVERS } = serverModule;
const { initLSPConfig } = await imp("dist/clients/lsp/config.js");
// #4514: this script is a standalone host, not pi. Adopt project trust before
// the first touch, or the launch gate refuses every project-local and
// project-code server and the rows read as unavailable.
await adoptFixtureProjectTrust({ repoRoot });
const { sampleProcesses, walkDescendantPids } = await imp(
	"dist/clients/resource-sampler.js",
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const residentBytesOf = (pid) =>
	residentTreeBytes(pid, {
		readProcessPairs: async () => {
			const { rows, ok } = await snapshotProcesses(["pid", "ppid"]);
			return ok ? rows.map((row) => [row.pid, row.ppid]) : null;
		},
		sampleRss: async (pids) => {
			const usage = await sampleProcesses(pids);
			return usage
				? new Map([...usage].map(([p, u]) => [p, u.rssBytes]))
				: null;
		},
		walkDescendantPids,
	});

const budgets = {
	baselineAttempts: 3,
	// Past the touch-notify debounce (default 1500ms) so a retry re-opens the
	// document instead of re-reading a deduped empty answer; same reasoning as
	// smoke-tools.mjs's AUX_RETRY_SETTLE_MS.
	baselineSettleMs: 1750,
	evictionWaitMs: windowMs + 12_000,
	// Graceful teardown of a heavy server runs before the eviction record lands.
	recordWaitMs: 10_000,
	pollMs: 500,
	coldStartWaitMs: 90_000,
};

let lsp;
const rows = await measureRegistry({
	registry: serverModule,
	fixtures: LSP_FIXTURES,
	filter: serverFilter,
	budgetMs,
	now: () => Date.now(),
	// A fresh service per server bounds memory (no 40 resident servers) and keeps
	// one server's breaker or lease state out of the next row.
	beforeEach: () => {
		if (lsp) {
			try {
				resetLSPService?.({ fast: true });
			} catch {}
		}
		lsp = getLSPService();
	},
	probe: async ({ server, fixture }) => {
		const row = await probeServer({
			server,
			fixture,
			budgets,
			createDriver: (fx) => {
				const target = { absFile: "", content: "" };
				return createServiceDriver({
					lsp,
					server,
					target,
					windowMs,
					touchBudgets: {
						maxClientWaitMs: 30_000,
						maxDiagnosticsWaitMs: 8_000,
					},
					residentBytesOf,
					now: () => Date.now(),
					sleep,
					...fixtureWorkspaceLifecycle(fx, target, {
						lsp,
						bootstrapFixtureWorkspace,
						initLSPConfig,
						repoRoot,
						runFixtureSetup,
						ensureSmokeLombokJar,
					}),
				});
			},
		});
		console.error(
			`[${server.id}] ${row.result}${row.reason ? ` (${row.reason})` : ""} declared=${server.idleEviction}`,
		);
		return row;
	},
});
const declared = new Map(LSP_SERVERS.map((s) => [s.id, s.idleEviction]));

try {
	resetLSPService?.({ fast: true });
} catch {}

const counts = summarizeRows(rows);
const drift = idleEvictionDrift(rows, declared);
// A filtered run measured a slice; overwriting the document with it would
// drop every other server's row, so only a full run writes the artifact.
if (serverFilter.length === 0) {
	const doc = renderIdleEvictionDoc({
		rows,
		declared,
		date: new Date().toISOString().slice(0, 10),
		platform: process.platform,
	});
	fs.writeFileSync(docPath, doc);
	console.error(
		`\nWrote ${path.relative(repoRoot, docPath)}. Its stable rows:`,
	);
	console.error(
		doc
			.split("\n")
			.filter((l) => l.startsWith("|"))
			.join("\n"),
	);
} else {
	console.error("\nFiltered run: document not written.");
}
// #4514: a server that was spawned is one the run evaluated; `unavailable` is
// the symptom a refused or missing launch lands as. The step's only failing
// exit is a declared-versus-measured veto, so the floor step reads this.
writeEvaluatedRecord({
	producer: "measure-lsp-idle-eviction",
	input: counts,
});
console.error(
	`${counts.total} registry servers: ${counts.eligible} eligible, ${counts.vetoed} vetoed, ${counts.inconclusive} inconclusive, ${counts.unavailable} unavailable (${counts.budget} not reached: budget).`,
);
// The timings and memory the committed document omits, in the log as well as
// the job summary: a step log is what a reviewer of one run can fetch.
console.error(`\n${renderRawTable(rows)}`);
for (const f of drift) {
	const line = `${f.serverId} [${f.severity}] ${f.detail}`;
	console.error(f.severity === "drift" ? `::error::${line}` : line);
}
if (summaryPath)
	fs.writeFileSync(
		summaryPath,
		JSON.stringify({ counts, rows, drift }, null, 2),
	);
if (driftBodyPath) {
	const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
	const body = buildIdleEvictionDriftBody(drift, {
		runUrl:
			GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
				? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
				: null,
	});
	if (body) fs.writeFileSync(driftBodyPath, body);
	else fs.rmSync(driftBodyPath, { force: true });
}
// drift | clean | unknown: the tracking issue closes only on `clean` (every
// transparent server eligible), never on the mere absence of drift.
if (driftStatePath)
	fs.writeFileSync(driftStatePath, driftIssueState(rows, declared));
if (process.env.GITHUB_STEP_SUMMARY) {
	fs.appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		`## LSP idle-eviction measurement (raw)\n\n${renderRawTable(rows)}\n`,
	);
}
process.exit(drift.some((f) => f.severity === "drift") ? 1 : 0);

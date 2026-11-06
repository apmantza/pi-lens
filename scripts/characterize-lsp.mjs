#!/usr/bin/env node
/**
 * #240 affirmative-clean-signal characterization across servers. For each
 * installed server, reports its diagnostic mode (pull vs push-only) — the first
 * cut at "how can we confirm a clean file is clean":
 *   - pull        → active pull gives an authoritative clean answer
 *   - push-only   → depends on whether it re-publishes empty (ast-grep) or goes
 *                   silent (typescript) on a clean edit — needs behavior testing
 *
 *   node scripts/characterize-lsp.mjs [lang ...]
 * Requires `npm run build:dist`. Measures only already-installed servers.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeEvaluatedRecord } from "./lib/assert-evaluated.mjs";
import { mergeCharacterization } from "./lib/md-matrix.mjs";
import { resolveFixtureProvenance } from "./lib/server-provenance.mjs";
import {
	adoptFixtureProjectTrust,
	bootstrapFixtureWorkspace,
	fixtureTrustRefusal,
	withScratchHome,
} from "./lib/lsp-fixture-workspace.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const argv = process.argv.slice(2);
const install = argv.includes("--install");
const langs = argv.filter((a) => !a.startsWith("--"));

// #2670/#2506-shape: pin PI_LENS_HOME/PILENS_DATA_DIR to a scratch temp dir
// BEFORE the first dist/ import below — dist/clients/latency-logger.js reads
// its log dir into a top-level const at module load, not lazily per write.
withScratchHome();

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { LSP_FIXTURES } = await imp("scripts/smoke-tools.mjs");
const { getLSPService, resetLSPService } = await imp(
	"dist/clients/lsp/index.js",
);
const { initLSPConfig } = await imp("dist/clients/lsp/config.js");
// #4514: this script is a standalone host, not pi. Adopt project trust before
// the first touch, or the launch gate refuses every project-local and
// project-code server and the rows read as unavailable.
await adoptFixtureProjectTrust({ repoRoot });
const installer = await imp("dist/clients/installer/index.js");
const { ensureTool } = installer;
// #5323: only the fixture `probePopulation` picks for a registry server can
// add a matrix row; a variant fixture (a clean file, nested roots, a baseline,
// a custom server) measures its server but never becomes a row.
const { LSP_SERVERS } = await imp("dist/clients/lsp/server.js");
const { probePopulation } = await imp(
	"scripts/lib/lsp-idle-eviction-probe.mjs",
);
const serverLangs = probePopulation(LSP_SERVERS, LSP_FIXTURES).flatMap(
	({ fixture }) => (fixture ? [fixture.lang] : []),
);

const fixtures = langs.length
	? LSP_FIXTURES.filter((f) => langs.includes(f.lang))
	: LSP_FIXTURES;
const lsp = getLSPService();
const rows = [];

for (const fx of fixtures) {
	const { absFile, cleanup } = await bootstrapFixtureWorkspace(fx, {
		initLSPConfig,
		repoRoot,
		tmpPrefix: "char-lsp-",
	});
	try {
		if (install && ensureTool) {
			for (const t of fx.tools ?? [])
				await ensureTool(t).catch(() => undefined);
		}
		if (!lsp.supportsLSP(absFile)) {
			rows.push({ lang: fx.lang, server: fx.serverHint, mode: "no-lsp" });
			continue;
		}
		const auxIds = fx.auxiliaryServerIds ?? [];
		const content = fs.readFileSync(absFile, "utf8");
		await lsp.touchFile(absFile, content, {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: auxIds.length ? "with-auxiliary" : "primary",
			...(auxIds.length ? { auxiliaryServerIds: auxIds } : {}),
			maxClientWaitMs: 30000,
			maxDiagnosticsWaitMs: 2500,
			source: "characterize",
		});
		const support = await lsp.getWorkspaceDiagnosticsSupport(absFile);
		// #4514: a server trust kept from launching is `refused: <reason>`, never
		// the "unknown" a slow or absent server also reads as.
		const mode =
			support?.mode ?? (await fixtureTrustRefusal(repoRoot)) ?? "unknown";
		rows.push({ lang: fx.lang, server: fx.serverHint, mode });
		console.error(`[${fx.lang}] mode=${mode}`);
	} catch (e) {
		rows.push({
			lang: fx.lang,
			server: fx.serverHint,
			mode: `error: ${e?.message ?? e}`,
		});
	} finally {
		cleanup();
	}
}

// #4512: what each server ran (version, install source), read after the
// installs above.
const provenance = await resolveFixtureProvenance(fixtures, installer);
for (const [lang, p] of [...provenance].sort())
	console.error(`[${lang}] install=${p.install} version=${p.version ?? "—"}`);

console.log("\nDiagnostic-mode matrix (affirmative-clean-signal first cut)\n");
console.log(`  ${"LANG".padEnd(16)} ${"MODE".padEnd(12)} SERVER`);
for (const r of rows.sort((a, b) =>
	String(a.mode).localeCompare(String(b.mode)),
)) {
	console.log(
		`  ${r.lang.padEnd(16)} ${String(r.mode).padEnd(12)} ${r.server}`,
	);
}
const pull = rows.filter((r) => r.mode === "pull").length;
const push = rows.filter((r) => r.mode === "push-only").length;
console.log(`\n  pull-capable (clean confirmable via pull): ${pull}`);
console.log(
	`  push-only (needs re-publish-empty, else silent → budget-bound): ${push}`,
);
// #4514: the step exits 0 by design, so the nightly's floor step reads this.
writeEvaluatedRecord({ producer: "characterize-lsp", input: rows });

// Merge the measured `mode` (and derived tier for pull servers) into
// docs/lsp-capability-matrix.md — MERGE, don't overwrite: a row we couldn't
// measure here (server unavailable on this host) is preserved, so an
// ubuntu-poor nightly can't regress a dev-box row (#390). This script owns the
// `mode`/`tier` columns; probe-clean-signal owns `clean-behavior`; both bump
// `src`. Rows whose mode came back "unknown"/"no-lsp"/error are NOT written
// (don't blank a prior good value).
try {
	updateMatrix(rows, provenance);
} catch (e) {
	console.error(`matrix update skipped: ${e?.message ?? e}`);
}

try {
	await resetLSPService?.({ fast: true });
} catch {}
process.exit(0);

function updateMatrix(measuredRows, provenance) {
	const src = process.env.CI ? "ci" : "dev";
	const docPath = path.join(repoRoot, "docs", "lsp-capability-matrix.md");
	if (!fs.existsSync(docPath)) {
		console.error(
			`matrix update skipped: ${docPath} not found (gitignored — nothing to merge)`,
		);
		return;
	}
	const text = fs.readFileSync(docPath, "utf8");
	const tbl = mergeCharacterization(
		text,
		measuredRows,
		provenance,
		src,
		undefined,
		{
			serverLangs,
			// A subset run says nothing about the servers it did not run.
			...(langs.length ? { probedLangs: fixtures.map((f) => f.lang) } : {}),
		},
	);
	if (!tbl) {
		console.error("matrix update skipped: capability table not found in doc");
		return;
	}
	const out = tbl.text;
	if (out && out !== text) {
		fs.writeFileSync(docPath, out);
		console.error(
			`Updated docs/lsp-capability-matrix.md mode column (${tbl.measured} servers measured, ${tbl.rows} rows preserved, ${tbl.held} held).`,
		);
	} else {
		console.error("matrix mode column: no changes.");
	}
}

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
import {
	mergeRows,
	mergeSrc,
	parseTable,
	replaceTable,
} from "./lib/md-matrix.mjs";
import {
	bootstrapFixtureWorkspace,
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
let ensureTool;
if (install) ({ ensureTool } = await imp("dist/clients/installer/index.js"));

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
		rows.push({
			lang: fx.lang,
			server: fx.serverHint,
			mode: support?.mode ?? "unknown",
		});
		console.error(`[${fx.lang}] mode=${support?.mode ?? "unknown"}`);
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

// Merge the measured `mode` (and derived tier for pull servers) into
// docs/lsp-capability-matrix.md — MERGE, don't overwrite: a row we couldn't
// measure here (server unavailable on this host) is preserved, so an
// ubuntu-poor nightly can't regress a dev-box row (#390). This script owns the
// `mode`/`tier` columns; probe-clean-signal owns `clean-behavior`; both bump
// `src`. Rows whose mode came back "unknown"/"no-lsp"/error are NOT written
// (don't blank a prior good value).
try {
	updateMatrix(rows);
} catch (e) {
	console.error(`matrix update skipped: ${e?.message ?? e}`);
}

try {
	await resetLSPService?.({ fast: true });
} catch {}
process.exit(0);

function updateMatrix(measuredRows) {
	const src = process.env.CI ? "ci" : "dev";
	const docPath = path.join(repoRoot, "docs", "lsp-capability-matrix.md");
	if (!fs.existsSync(docPath)) {
		console.error(
			`matrix update skipped: ${docPath} not found (gitignored — nothing to merge)`,
		);
		return;
	}
	const text = fs.readFileSync(docPath, "utf8");
	const marker = "| lang | server |";
	const tbl = parseTable(text, marker);
	if (!tbl) {
		console.error("matrix update skipped: capability table not found in doc");
		return;
	}
	// Only rows we actually measured a mode for (pull/push-only) are authoritative.
	const measurable = measuredRows.filter(
		(r) => r.mode === "pull" || r.mode === "push-only",
	);
	// pull ⇒ Tier 1 by protocol; push-only tier is decided by the clean-behavior
	// probe, so leave `tier` untouched for push rows (don't clobber a probed value).
	// Key on `lang` (the matrix's first column + the fixture's stable id) — the
	// hand-written `server` column doesn't always equal a fixture's serverHint.
	const keyIdx = tbl.header.indexOf("lang");
	const srcIdx = tbl.header.indexOf("src");
	const existingByLang = new Map(tbl.rows.map((c) => [c[keyIdx], c]));
	const measured = measurable.map((r) => {
		const cell = { lang: r.lang, mode: r.mode };
		if (r.mode === "pull") cell.tier = "1";
		const prior = existingByLang.get(r.lang);
		cell.src = mergeSrc(prior ? prior[srcIdx] : "", src);
		return cell;
	});
	const merged = mergeRows(
		tbl.rows,
		tbl.header,
		measured,
		"lang",
		["mode", "tier", "src"],
		{ updateOnly: true },
	);
	const out = replaceTable(text, marker, tbl.header, tbl.sep, merged);
	if (out && out !== text) {
		fs.writeFileSync(docPath, out);
		console.error(
			`Updated docs/lsp-capability-matrix.md mode column (${measured.length} servers measured, ${tbl.rows.length} rows preserved).`,
		);
	} else {
		console.error("matrix mode column: no changes.");
	}
}

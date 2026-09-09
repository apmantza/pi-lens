#!/usr/bin/env node
/**
 * LSP cold/warm latency benchmark across the tool-smoke fixtures (#239 Gate A).
 *
 * Reuses LSP_FIXTURES from smoke-tools.mjs so the fixture set stays single-
 * sourced. Reports, per server, the cold latency (spawn + initialize + first
 * scan) and the warm per-edit latency (re-touch after a content change) — the
 * number the agent actually waits on. The point: an auxiliary (ast-grep,
 * opengrep) is acceptable as long as its warm latency is in the range of the
 * PRIMARY language servers pi-lens already tolerates.
 *
 * Each fixture is measured in ISOLATION: the service + workspace config are
 * reset between fixtures (no lingering previous server), and an auxiliary
 * fixture disables the file's primary language servers so only the auxiliary
 * spawns — its number is the auxiliary alone, not a primary+aux touch.
 *
 *   node scripts/bench-lsp.mjs [lang ...] [--install]
 *
 * Requires `npm run build:dist`. Without --install, only already-installed
 * servers are measured (others report "unavailable").
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const distLsp = path.join(repoRoot, "dist", "clients", "lsp", "index.js");
if (!fs.existsSync(distLsp)) {
	console.error("dist missing — run `npm run build:dist` first.");
	process.exit(1);
}
const { getLSPService, resetLSPService } = await imp(
	"dist/clients/lsp/index.js",
);
const {
	initLSPConfig,
	getServersForFileWithConfig,
	resetLSPConfigStateForTests,
} = await imp("dist/clients/lsp/config.js");
let ensureTool;
if (install) {
	({ ensureTool } = await imp("dist/clients/installer/index.js"));
}

const fixtures = langs.length
	? LSP_FIXTURES.filter((f) => langs.includes(f.lang))
	: LSP_FIXTURES;

let lsp = getLSPService();
const results = [];

for (const fx of fixtures) {
	const role = fx.auxiliaryServerIds?.length
		? "auxiliary"
		: fx.disableServers
			? "alternate"
			: "primary";
	// Isolation: tear down the previous fixture's servers + workspace config so
	// neither a still-warm/dying server nor a stale disable bleeds into this
	// measurement. Each fixture measures ONE server cold from a clean service.
	await lsp.shutdown({ fast: true }).catch(() => {});
	resetLSPService({ fast: true });
	resetLSPConfigStateForTests?.();
	lsp = getLSPService();

	if (install && ensureTool) {
		for (const t of fx.tools ?? []) await ensureTool(t).catch(() => undefined);
	}

	const auxIds = fx.auxiliaryServerIds ?? [];
	// #2658: every fixture registers its OWN workspace unconditionally (via
	// bootstrapFixtureWorkspace's early initLSPConfig call), not only when
	// `disabledServers` below turns out non-empty — the exact #2369/#2655
	// ordering bug this script shared with its four siblings.
	const { absFile, cleanup } = await bootstrapFixtureWorkspace(fx, {
		initLSPConfig,
		repoRoot,
		tmpPrefix: "bench-lsp-",
		// Measure ONE server in isolation: disable every other server matching
		// this file so neither an auxiliary (opengrep/ast-grep) nor an alternate
		// primary can spawn alongside the server under test.
		//   - auxiliary fixture → target = the auxiliary(ies); all primaries disabled
		//   - alternate fixture → target = first primary NOT in fx.disableServers
		//   - primary fixture   → target = the default (first matching) primary
		// getServersForFileWithConfig is in registry order — the same order
		// getClientForFile tries — so primaries[0] is the default it would select.
		// Computed here (a function, not a static list) because it needs a real
		// file path inside the already-copied, already-registered workspace.
		disableServers: ({ absFile: file }) => {
			const matching = getServersForFileWithConfig(file);
			let targetIds;
			if (auxIds.length) {
				targetIds = new Set(auxIds);
			} else {
				const explicitlyDisabled = new Set(fx.disableServers ?? []);
				const primaries = matching.filter(
					(s) => s.role !== "auxiliary" && !explicitlyDisabled.has(s.id),
				);
				targetIds = new Set(primaries.length ? [primaries[0].id] : []);
			}
			return matching.map((s) => s.id).filter((id) => !targetIds.has(id));
		},
	});

	if (!lsp.supportsLSP(absFile)) {
		results.push({
			lang: fx.lang,
			server: fx.serverHint,
			role,
			status: "no-lsp",
		});
		cleanup();
		continue;
	}
	let content = fs.readFileSync(absFile, "utf8");
	const touch = (c) =>
		lsp.touchFile(absFile, c, {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: auxIds.length ? "with-auxiliary" : "primary",
			...(auxIds.length ? { auxiliaryServerIds: auxIds } : {}),
			maxClientWaitMs: 40000,
			// Production-realistic diagnostic cap. Each fixture spawns a SINGLE
			// server (primaries disabled for aux fixtures), so this is that one
			// server's per-server ceiling (#242): the wait early-returns the moment
			// it publishes and only caps the tail. 3000ms covers the slowest strategy
			// budget (rust-analyzer) and reflects the dispatch per-edit cap.
			maxDiagnosticsWaitMs: 3000,
			source: "bench",
		});

	try {
		const c0 = performance.now();
		const cold = await touch(content);
		const coldMs = performance.now() - c0;
		if (!Array.isArray(cold)) {
			results.push({
				lang: fx.lang,
				server: fx.serverHint,
				role,
				status: "unavailable",
			});
			continue;
		}
		const warm = [];
		for (let i = 1; i <= 3; i++) {
			content += `\n// bench edit ${i}\n`;
			fs.writeFileSync(absFile, content);
			const w0 = performance.now();
			await touch(content);
			warm.push(performance.now() - w0);
		}
		const warmAvg = warm.reduce((s, x) => s + x, 0) / warm.length;
		results.push({
			lang: fx.lang,
			server: fx.serverHint,
			role,
			coldMs,
			warmMs: warmAvg,
			diags: cold.length,
			status: "ok",
		});
		console.error(
			`[${fx.lang}] ${role} cold=${coldMs.toFixed(0)}ms warm=${warmAvg.toFixed(0)}ms diags=${cold.length}`,
		);
	} catch (e) {
		results.push({
			lang: fx.lang,
			server: fx.serverHint,
			role,
			status: `error: ${e?.message ?? e}`,
		});
	} finally {
		// Best-effort: on Windows the warm server still holds handles, so the dir
		// may not delete until the process exits. Leaking temp dirs is fine.
		cleanup();
	}
}

// --- report ---------------------------------------------------------------
const ok = results
	.filter((r) => r.status === "ok")
	.sort((a, b) => a.warmMs - b.warmMs);
const other = results.filter((r) => r.status !== "ok");

console.log("\nLSP latency benchmark (sorted by warm/edit)\n");
console.log(
	`  ${"LANG".padEnd(12)} ${"ROLE".padEnd(10)} ${"COLD".padStart(8)} ${"WARM/edit".padStart(10)}  SERVER`,
);
for (const r of ok) {
	console.log(
		`  ${r.lang.padEnd(12)} ${r.role.padEnd(10)} ${`${r.coldMs.toFixed(0)}ms`.padStart(8)} ${`${r.warmMs.toFixed(0)}ms`.padStart(10)}  ${r.server}`,
	);
}
if (ok.length) {
	const prim = ok.filter((r) => r.role !== "auxiliary");
	const aux = ok.filter((r) => r.role === "auxiliary");
	const warmAvg = (xs) => xs.reduce((s, x) => s + x.warmMs, 0) / xs.length;
	console.log("");
	if (prim.length)
		console.log(
			`  primary/alternate warm: min ${Math.min(...prim.map((r) => r.warmMs)).toFixed(0)}ms · avg ${warmAvg(prim).toFixed(0)}ms · max ${Math.max(...prim.map((r) => r.warmMs)).toFixed(0)}ms (n=${prim.length})`,
		);
	if (aux.length)
		console.log(
			`  auxiliary warm:         ${aux.map((r) => `${r.lang} ${r.warmMs.toFixed(0)}ms`).join(" · ")}`,
		);
}
if (other.length) {
	console.log("\n  not measured:");
	for (const r of other)
		console.log(`    ${r.lang.padEnd(12)} ${r.status}  (${r.server})`);
}

try {
	await resetLSPService?.({ fast: true });
} catch {}
process.exit(0);

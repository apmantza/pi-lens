#!/usr/bin/env node
/**
 * Capability inventory for every supported LSP server. Spawns each server via
 * the tool-smoke fixtures, reads its advertised capability surface from the
 * `initialize` handshake, and writes a Markdown matrix to
 * docs/servercapabilities.md.
 *
 * Per server it records: diagnostic mode (pull/push-only), the 12 navigation/
 * edit operations pi-lens parses (operationSupport), the executeCommand
 * allowlist, and the raw top-level ServerCapabilities keys (the FULL advertised
 * surface, including providers pi-lens does not yet consume).
 *
 *   node scripts/server-capabilities.mjs [lang ...] [--install]
 *
 * Requires `npm run build:dist`. Servers whose toolchain/binary is absent on the
 * generating host are listed as unavailable (a non-failure) — run in a
 * provisioned env (the nightly) to capture those rows.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	mergeServerCapabilitiesDoc,
	renderServerCapabilitiesDoc,
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
if (install) {
	({ ensureTool } = await imp("dist/clients/installer/index.js"));
}

const fixtures = langs.length
	? LSP_FIXTURES.filter((f) => langs.includes(f.lang))
	: LSP_FIXTURES;
const lsp = getLSPService();

// serverId -> capability snapshot (merged across fixtures; first spawn wins).
const caps = new Map();
const unavailable = new Set();

const OPS = [
	["definition", "def"],
	["typeDefinition", "tDef"],
	["declaration", "decl"],
	["references", "ref"],
	["hover", "hov"],
	["signatureHelp", "sig"],
	["documentSymbol", "dSym"],
	["workspaceSymbol", "wSym"],
	["codeAction", "cAct"],
	["rename", "rnm"],
	["implementation", "impl"],
	["callHierarchy", "cHir"],
];

for (const fx of fixtures) {
	const { absFile, cleanup } = await bootstrapFixtureWorkspace(fx, {
		initLSPConfig,
		repoRoot,
		tmpPrefix: "caps-lsp-",
	});
	try {
		if (install && ensureTool) {
			for (const t of fx.tools ?? [])
				await ensureTool(t).catch(() => undefined);
		}
		if (!lsp.supportsLSP(absFile)) {
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
			source: "server-capabilities",
		});
		// Availability of THIS fixture's server: the file-scoped snapshot lists the
		// primary server(s) registered for this file that are actually alive. Empty
		// ⇒ the server didn't spawn (toolchain/binary absent). (Correctly handles a
		// second fixture for an already-captured server, e.g. the clean-file ts
		// variant, which the cumulative count would mis-flag as unavailable.)
		const fileSnaps = await lsp.getCapabilitySnapshots(absFile);
		// All alive clients (primary + auxiliary + alternates), merged first-wins —
		// the warm service keeps every spawned client alive across fixtures.
		const allSnaps = await lsp.getCapabilitySnapshots();
		for (const s of allSnaps)
			if (!caps.has(s.serverId)) caps.set(s.serverId, s);
		console.error(
			`[${fx.lang}] file-servers=${fileSnaps.map((s) => s.serverId).join(",") || "(none)"} total=${caps.size}`,
		);
		if (fileSnaps.length === 0) unavailable.add(fx.serverHint ?? fx.lang);
	} catch (e) {
		unavailable.add(fx.serverHint ?? fx.lang);
		console.error(`[${fx.lang}] error: ${e?.message ?? e}`);
	} finally {
		cleanup();
	}
}

const docPath = path.join(repoRoot, "docs", "servercapabilities.md");
const rows = [...caps.values()];
const fresh = renderServerCapabilitiesDoc({
	rows,
	unavailable,
	date: new Date().toISOString().slice(0, 10),
	platform: process.platform,
	ops: OPS,
});

// #390/#469 partial-doc merge guard: this host (esp. the ubuntu nightly) lacks
// many toolchains, so servers it couldn't spawn are absent from `rows` and
// would DROP from the doc on a naive overwrite. mergeServerCapabilitiesDoc
// (pure, tested in tests/scripts/server-capabilities-merge.test.ts) merges the
// prior doc's rows/bullets for servers this run didn't capture into the fresh
// doc — schema-tolerant (a column added this run, like ws-pull, no longer
// silently disables the whole guard — #469) and also carries over the two
// bullet sections, which the original guard didn't touch at all.
let output = fresh;
try {
	if (fs.existsSync(docPath)) {
		const prior = fs.readFileSync(docPath, "utf8");
		const { text: merged, preservedCount } = mergeServerCapabilitiesDoc(
			prior,
			fresh,
		);
		output = merged;
		if (preservedCount > 0) {
			console.error(
				`merge guard: preserved ${preservedCount} prior server row(s)/bullet(s) not captured this run.`,
			);
		}
	}
} catch (e) {
	console.error(`servercapabilities merge guard skipped: ${e?.message ?? e}`);
}

fs.writeFileSync(docPath, output);
console.error(
	`\nWrote docs/servercapabilities.md (${rows.length} servers captured this run, ${unavailable.size} unavailable).`,
);

try {
	await resetLSPService?.({ fast: true });
} catch {}
process.exit(0);

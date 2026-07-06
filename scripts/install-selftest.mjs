#!/usr/bin/env node
/**
 * Install self-test — verifies pi-lens's runtime dependency graph actually
 * resolves *as installed*, independent of the host model or auth.
 *
 * WHY THIS EXISTS
 * Issues #285 (pnpm symlink store) and #335 (nested npm install) reported
 * `ResolveMessage: Cannot find package '<dep>' from ...` — pi-lens failing to
 * load because a third-party RUNTIME dep was unreachable under a non-default
 * package-manager layout. (The original report named `typescript`; it's since a
 * devDependency — #402 — so the probe now covers the remaining runtime deps.)
 * Those did not reproduce on current bun/pi, but the failure class is real and
 * silent in normal dev (a flat `node_modules` always resolves). This probe makes
 * it loud and CI-catchable.
 *
 * WHAT IT DOES
 * Force-imports the modules whose TOP-LEVEL bare imports are the documented
 * failure points, plus the bare specifiers directly, and checks the two
 * build-script-provided assets (ast-grep CLI binary + tree-sitter grammars)
 * that pnpm/bun skip by default. It runs no model and needs no credentials.
 *
 * USAGE
 *   bun  scripts/install-selftest.mjs     # faithful: pi's runtime is bun
 *   node scripts/install-selftest.mjs     # also works
 * Exit 0 = all critical checks passed; non-zero = at least one failed.
 * `--allow-soft` downgrades the build-script-asset checks (ast-grep/grammars)
 * to warnings, so a pure *resolution* regression is still a hard failure.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const allowSoft = process.argv.includes("--allow-soft");

const results = [];
const record = (name, kind, ok, detail = "") =>
	results.push({ name, kind, ok, detail });

/** Import a module by URL and record whether its (eager) dep graph resolved. */
async function probeImport(name, relPath) {
	const url = new URL(
		`file://${path.resolve(pkgRoot, relPath).replace(/\\/g, "/")}`,
	);
	try {
		await import(url.href);
		record(name, "resolve", true);
	} catch (err) {
		record(name, "resolve", false, `${err?.code || ""} ${err?.message || err}`.trim());
	}
}

/** Resolve a bare specifier the way the package itself would. */
function probeResolve(spec) {
	try {
		require.resolve(spec);
		record(spec, "resolve", true);
	} catch (err) {
		record(spec, "resolve", false, `${err?.code || ""} ${err?.message || err}`.trim());
	}
}

// --- 1. The documented failure-point modules (eager bare imports) ----------
await probeImport("dist/index.js (entry)", "dist/index.js");
await probeImport("clients/file-utils.js (→ minimatch)", "dist/clients/file-utils.js");
await probeImport("clients/complexity-client.js (→ tree-sitter)", "dist/clients/complexity-client.js");
await probeImport("clients/bootstrap.js (→ all analyzers)", "dist/clients/bootstrap.js");

// --- 2. Direct bare-specifier resolution -----------------------------------
for (const spec of [
	"minimatch",
	"typebox",
	"js-yaml",
	"vscode-jsonrpc",
	"web-tree-sitter",
	"@ast-grep/napi",
]) {
	probeResolve(spec);
}

// --- 3. Spawned-binary tools (the universal net) ----------------------------
// For every tool that ships its binary in a per-platform npm package
// (platformPackage: ast-grep, biome, …), if it's actually a dependency of this
// install, resolve the native binary and RUN it. Reuses the installer's own
// resolver + TOOLS registry, so any future platform-CLI tool is covered with no
// change here. This is the exact class that pnpm/bun break (skipped postinstall /
// symlink store) — the binary exists but the launcher can't reach it.
try {
	const installerUrl = `file://${path
		.resolve(pkgRoot, "dist/clients/installer/index.js")
		.replace(/\\/g, "/")}`;
	const { TOOLS, resolvePlatformPackageBinary } = await import(installerUrl);
	for (const tool of TOOLS.filter((t) => t.platformPackage)) {
		const label = `tool ${tool.id} binary`;
		// Only probe tools whose main package is installed in THIS layout.
		try {
			require.resolve(`${tool.packageName}/package.json`);
		} catch {
			record(label, "tool", true, "not a dep of this install — skipped");
			continue;
		}
		const bin = resolvePlatformPackageBinary(tool);
		if (!bin) {
			record(
				label,
				"tool",
				false,
				`platform binary not resolved (${process.platform}-${process.arch})`,
			);
			continue;
		}
		try {
			execFileSync(bin, tool.checkArgs ?? ["--version"], {
				stdio: "ignore",
				timeout: 15000,
			});
			record(label, "tool", true, bin);
		} catch (err) {
			record(label, "tool", false, `${bin} failed to run: ${err?.message || err}`);
		}
	}
} catch (err) {
	record("spawned-tool probe", "tool", false, `installer load failed: ${err?.message || err}`);
}

// tree-sitter grammars — download-grammars.js postinstall writes them into
// node_modules/web-tree-sitter/grammars/. Locate that dir via the resolved
// web-tree-sitter package (matches tree-sitter-client's runtime strategy).
let grammarDetail = "tree-sitter-*.wasm missing (postinstall skipped?)";
let hasCoreGrammar = false;
try {
	// web-tree-sitter restricts `exports`, so resolve its main entry and walk
	// up to the package root (the dir literally named web-tree-sitter), where
	// download-grammars.js writes grammars/.
	let dir = path.dirname(require.resolve("web-tree-sitter"));
	while (
		path.basename(dir) !== "web-tree-sitter" &&
		dir !== path.dirname(dir)
	) {
		dir = path.dirname(dir);
	}
	const grammarDir = path.join(dir, "grammars");
	hasCoreGrammar = fs.existsSync(
		path.join(grammarDir, "tree-sitter-typescript.wasm"),
	);
	if (hasCoreGrammar) grammarDetail = grammarDir;
} catch (err) {
	grammarDetail = `web-tree-sitter unresolved: ${err?.message || err}`;
}
record("tree-sitter grammars", "asset", hasCoreGrammar, grammarDetail);

// --- Report ----------------------------------------------------------------
const pad = Math.max(...results.map((r) => r.name.length));
let hardFail = 0;
let softFail = 0;
for (const r of results) {
	const soft = (r.kind === "asset" || r.kind === "tool") && allowSoft;
	const status = r.ok ? "PASS" : soft ? "WARN" : "FAIL";
	if (!r.ok) soft ? softFail++ : hardFail++;
	console.log(
		`  [${status}] ${r.name.padEnd(pad)} ${r.detail ? "— " + r.detail : ""}`,
	);
}
console.log(
	`\nselftest: ${results.length - hardFail - softFail} passed, ${hardFail} failed${
		softFail ? `, ${softFail} warned` : ""
	} (runtime: ${process.versions.bun ? "bun " + process.versions.bun : "node " + process.versions.node})`,
);
process.exit(hardFail > 0 ? 1 : 0);

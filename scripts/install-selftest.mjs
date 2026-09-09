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
 * that pnpm/bun skip by default. It also resolves the `pi.skills` manifest
 * entries the way pi does, from the installed package root (#2587). It runs no
 * model and needs no credentials.
 *
 * WHAT IT NO LONGER COVERS (#1926)
 * pi supplies `typebox` and `@earendil-works/pi-tui` from its own runtime, so
 * they are optional peers and no install vendors them. This probe is not pi, so
 * those specifiers cannot resolve here, and `dist/index.js` throws on the FIRST
 * one it imports. A host-provided miss is therefore recorded as EXPECTED rather
 * than failed. The cost is real and stated plainly: evaluation stops there, so
 * the entry probe no longer proves the whole bundled graph resolves, which is
 * what #285 and #335 asked it to prove. Any OTHER unresolved specifier still
 * fails hard, and the per-module probes below (file-utils, complexity-client,
 * bootstrap) still cover that graph directly. The surviving POSITIVE proof that
 * the entry loads in full is the install-smoke `pi-load` job: it installs pi,
 * installs pi-lens through pi, and confirms over RPC that pi-lens registered
 * its commands.
 *
 * USAGE
 *   bun  scripts/install-selftest.mjs     # faithful: pi's runtime is bun
 *   node scripts/install-selftest.mjs     # also works
 * Exit 0 = all critical checks passed; non-zero = at least one failed.
 * `--allow-soft` downgrades the build-script-asset checks (ast-grep/grammars)
 * to warnings, so a pure *resolution* regression is still a hard failure.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_PROVIDED_PACKAGES } from "./lib/host-provided-deps.mjs";
import { collectSkillEntryPaths } from "./lib/skills-predicate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const allowSoft = process.argv.includes("--allow-soft");

const results = [];
const record = (name, kind, ok, detail = "") =>
	results.push({ name, kind, ok, detail });

/**
 * Which host-provided package, if any, a resolution error is about. Returns
 * undefined for every other error, so an unrelated missing package still fails.
 */
function hostProvidedMiss(err) {
	const text = `${err?.code || ""} ${err?.message || err}`;
	if (
		!/ERR_MODULE_NOT_FOUND|Cannot find (package|module)|ResolveMessage/.test(
			text,
		)
	) {
		return undefined;
	}
	return HOST_PROVIDED_PACKAGES.find((name) =>
		new RegExp(
			`['"\`]${name.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}['"\`]`,
		).test(text),
	);
}

/** Import a module by URL and record whether its (eager) dep graph resolved. */
async function probeImport(name, relPath) {
	const url = new URL(
		`file://${path.resolve(pkgRoot, relPath).replace(/\\/g, "/")}`,
	);
	try {
		await import(url.href);
		record(name, "resolve", true);
	} catch (err) {
		// #1926: pi supplies these; outside pi they cannot resolve, and the entry
		// throws on the first one. Expected, not a regression. Anything else is.
		const host = hostProvidedMiss(err);
		if (host) {
			record(
				name,
				"expected",
				true,
				`stopped at host-provided '${host}' — pi supplies it; graph beyond this point unproven here (#1926)`,
			);
			return;
		}
		record(
			name,
			"resolve",
			false,
			`${err?.code || ""} ${err?.message || err}`.trim(),
		);
	}
}

/** Resolve a bare specifier the way the package itself would. */
function probeResolve(spec) {
	try {
		require.resolve(spec);
		record(spec, "resolve", true);
	} catch (err) {
		record(
			spec,
			"resolve",
			false,
			`${err?.code || ""} ${err?.message || err}`.trim(),
		);
	}
}

// --- 1. The documented failure-point modules (eager bare imports) ----------
await probeImport("dist/index.js (entry)", "dist/index.js");
await probeImport(
	"clients/file-utils.js (→ minimatch)",
	"dist/clients/file-utils.js",
);
await probeImport(
	"clients/complexity-client.js (→ tree-sitter)",
	"dist/clients/complexity-client.js",
);
await probeImport(
	"clients/bootstrap.js (→ all analyzers)",
	"dist/clients/bootstrap.js",
);

// --- 2. Direct bare-specifier resolution -----------------------------------
// Host-provided packages are subtracted, not listed as exceptions: pi resolves
// them from its own runtime, so nothing installs them and probing one here is
// guaranteed to fail (#1926). The subtraction reads the same list the bundler
// and the packaging tests use, so it cannot drift.
const BARE_SPECIFIERS = [
	"minimatch",
	"typebox",
	"js-yaml",
	"vscode-jsonrpc",
	"web-tree-sitter",
	"@ast-grep/napi",
].filter((spec) => !HOST_PROVIDED_PACKAGES.includes(spec));

for (const spec of BARE_SPECIFIERS) {
	probeResolve(spec);
}
record(
	"host-provided specifiers skipped",
	"expected",
	true,
	`${HOST_PROVIDED_PACKAGES.join(", ")} — pi supplies these (#1926)`,
);

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
			record(
				label,
				"tool",
				false,
				`${bin} failed to run: ${err?.message || err}`,
			);
		}
	}
} catch (err) {
	record(
		"spawned-tool probe",
		"tool",
		false,
		`installer load failed: ${err?.message || err}`,
	);
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

// --- 4. pi.skills manifest resolution, AS INSTALLED (#2587) ----------------
// Guards the recurrence of #2587: a `pi.skills` entry that resolves outside the
// installed package, so pi registers none of the shipped skills. This probe runs
// from the INSTALLED package (`require.resolve("pi-lens/scripts/…")`), so it sees
// the real layout — hoisted node_modules, pnpm's symlink store, bun, yarn — which
// is exactly where `../../skills` escaped and where a static check on the source
// tree cannot look. Replicates pi's own resolver, `PackageManager#collectFiles\
// FromManifestEntries` in `@earendil-works/pi-coding-agent`
// `dist/core/package-manager.js`: a non-glob entry is `resolve(packageRoot, entry)`
// (verified identical in 0.78.1 / 0.84.1 / 0.85.1).
//
// #2626 review round 2 (F2): the "does this dir have a skill" walk used to be
// a hand-rolled `countSkillFiles` here AND a second, differently-wrong one in
// `clients/skills-resolver.ts`. Both now derive from the ONE structural
// predicate in `./lib/skills-predicate.mjs`, which replicates pi's actual
// `loadSkillsFromDirInternal` walk (see that module's header for the exact
// discovery rules and the two documented scope gaps).
{
	const pkgJson = JSON.parse(
		fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"),
	);
	const entries = pkgJson.pi?.skills ?? [];
	if (entries.length === 0) {
		record("pi.skills declared", "manifest", false, "pi.skills is empty");
	}
	for (const entry of entries) {
		const label = `pi.skills "${entry}"`;
		// pi globs entries containing * or ? through a different branch; this
		// probe only replicates the non-glob one.
		if (/[*?]/.test(entry)) {
			record(label, "manifest", true, "glob entry — not probed");
			continue;
		}
		const resolved = path.resolve(pkgRoot, entry);
		if (resolved !== pkgRoot && !resolved.startsWith(pkgRoot + path.sep)) {
			record(label, "manifest", false, `escapes the package: ${resolved}`);
			continue;
		}
		const found = collectSkillEntryPaths(resolved).length;
		record(
			label,
			"manifest",
			found > 0,
			found > 0
				? `${found} SKILL.md under ${resolved}`
				: `no SKILL.md under ${resolved}`,
		);
	}
}

// --- Report ----------------------------------------------------------------
const pad = Math.max(...results.map((r) => r.name.length));
let hardFail = 0;
let softFail = 0;
for (const r of results) {
	const soft = (r.kind === "asset" || r.kind === "tool") && allowSoft;
	const status = r.ok ? "PASS" : soft ? "WARN" : "FAIL";
	if (!r.ok) {
		if (soft) softFail++;
		else hardFail++;
	}
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

#!/usr/bin/env node
/**
 * Bundle the compiled extension entry (`dist/index.js`) into a single
 * self-contained ESM file, inlining pure-JS runtime dependencies.
 *
 * WHY THIS EXISTS
 * pi ships as a `bun build --compile` single-file executable and loads
 * extensions inside that embedded runtime. That runtime's module resolver does
 * not traverse an extension's on-disk `node_modules` for a BARE specifier (e.g.
 * `import "minimatch"`), so analyzers that transitively import third-party deps
 * (minimatch via `file-utils.js` -> jscpd/todo/complexity) fail to load
 * ("Cannot find package 'minimatch' …") and drop to degraded mode. Bundling
 * inlines those deps so the extension imports nothing by bare specifier at load
 * time. Runs after `tsc` (build:dist) has produced `dist/`; bundles in place.
 *
 * KEPT EXTERNAL (not inlined)
 *   - Host-provided packages pi resolves from its own embedded runtime:
 *       typebox, @earendil-works/pi-coding-agent, @earendil-works/pi-tui
 *   - Native addon / wasm loaded lazily by absolute path at call time:
 *       @ast-grep/napi (native .node), web-tree-sitter (wasm)
 *   - node: builtins
 *
 * esbuild is run through `npm exec` (resolved from npm's own CLI so there is no
 * npx `.cmd` shim and no shell), the same resolve-your-own-toolchain approach
 * build:dist uses for tsc (#437): esbuild installs into npm's cache, never the
 * project tree, so this adds no dependency and works under a from-source
 * `--omit=dev` install where project devDeps are absent.
 *
 * USAGE
 *   node scripts/bundle-dist.mjs   # invoked by `npm run bundle:dist`
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ESBUILD_VERSION = "0.28.1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(root, "dist", "index.js");
const tmpOut = path.join(root, "dist", "index.bundled.mjs");

// Packages the bundle must NOT inline: host-provided ones resolve from pi's
// embedded runtime; native/wasm ones are dynamic-imported by absolute path.
const EXTERNAL = [
	"typebox",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@ast-grep/napi",
	"web-tree-sitter",
];

// esbuild's ESM output wraps bundled CommonJS modules (e.g. vscode-jsonrpc) in a
// shim that throws on any dynamic require(); a pure-ESM Node process has no
// ambient require. Prepend a real one so those bundled CJS deps resolve at load.
const REQUIRE_BANNER =
	'import { createRequire as __pilensCreateRequire } from "node:module"; const require = __pilensCreateRequire(import.meta.url);';

// npm's own CLI, set by npm when it runs this via `npm run bundle:dist`. Running
// esbuild through `node <npm-cli> exec` (rather than the `npx`/`npx.cmd` shim)
// keeps the spawn shell-free and cross-platform, so args are never re-parsed by
// a shell.
const npmCli = process.env.npm_execpath;

if (!existsSync(distEntry)) {
	console.error(
		`[bundle] ${distEntry} not found — run build:dist (tsc) first.`,
	);
	process.exit(1);
}
if (!npmCli) {
	console.error("[bundle] npm_execpath unset — run via `npm run bundle:dist`.");
	process.exit(1);
}

try {
	execFileSync(
		process.execPath,
		[
			npmCli,
			"exec",
			"--yes",
			"--package",
			`esbuild@${ESBUILD_VERSION}`,
			"--",
			"esbuild",
			distEntry,
			"--bundle",
			"--platform=node",
			"--format=esm",
			...EXTERNAL.map((name) => `--external:${name}`),
			`--outfile=${tmpOut}`,
		],
		{ cwd: root, stdio: "inherit" },
	);
} catch (err) {
	console.error(`[bundle] esbuild failed: ${err?.message ?? err}`);
	process.exit(1);
}

// Prepend the require banner, then replace the tsc-emitted entry in place.
writeFileSync(tmpOut, `${REQUIRE_BANNER}\n${readFileSync(tmpOut, "utf8")}`);
renameSync(tmpOut, distEntry);
console.error(
	`[bundle] wrote self-contained ${path.relative(root, distEntry)}`,
);

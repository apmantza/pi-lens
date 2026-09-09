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
 *   The list lives in ./lib/host-provided-deps.mjs, which is also what
 *   package.json's dependency shape and tests/packaging.test.ts are pinned to
 *   (#1926). Two reasons a package is external:
 *   - Host-provided: pi resolves it from its own embedded runtime, so the
 *     extension must NOT declare it as a runtime dependency.
 *   - Native addon / wasm loaded lazily by absolute path at call time.
 *   node: builtins are external by default.
 *
 * esbuild is run through `npm exec` (resolved from npm's own CLI so there is no
 * npx `.cmd` shim and no shell), the same resolve-your-own-toolchain approach
 * build:dist uses for tsc (#437): esbuild installs into npm's cache, never the
 * project tree, so this adds no dependency and works under a from-source
 * `--omit=dev` install where project devDeps are absent. This relies on npm's
 * `exec --package` syntax; pi always installs via npm so the shipping path is
 * npm. A non-npm `npm_execpath` (pnpm/yarn/bun) is rejected with a clear error.
 *
 * WHY `--prefix` AND NOT A DIFFERENT `cwd` (#2590, #2594 review F1)
 * The isolation mechanism (`npm exec --package` resolves against the WHOLE
 * project dependency tree unless steered elsewhere) is shared with
 * `scripts/build-dist-tsc.mjs`'s tsc spawn (#2593) — see
 * scripts/lib/exec-isolation.mjs for the full mechanism writeup and both
 * call sites' shared builder.
 *
 * A first attempt at this fix moved the spawn's `cwd` to a temp directory,
 * which also moves npm's `runPath` (it defaults to `process.cwd()`) — but
 * esbuild bakes its bundled-module-path banner COMMENTS relative to ITS OWN
 * cwd, so that shipped a `dist/index.js` with hundreds of machine- and
 * worktree-specific relative paths (`// ../../home/<user>/...`) baked into
 * it, a different artifact than master's (see tests/packaging.test.ts's
 * "bakes no user-profile absolute path into the bundle").
 *
 * The actual fix: keep the spawn's `cwd` (and therefore `runPath`) at
 * `root`, and pass `--prefix <freshly created empty temp dir>` on the npm
 * CLI invocation instead (see scripts/lib/exec-isolation.mjs). `distEntry`
 * and the esbuild `--outfile` are both already absolute paths, so nothing
 * about esbuild's OUTPUT changes; the fix touches only what npm's exec
 * resolution can see, never what esbuild itself runs from.
 *
 * USAGE
 *   node scripts/bundle-dist.mjs   # invoked by `npm run bundle:dist`
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	buildIsolatedExecInvocation,
	createIsolatedExecPrefix,
} from "./lib/exec-isolation.mjs";
import { BUNDLE_EXTERNALS } from "./lib/host-provided-deps.mjs";

const ESBUILD_VERSION = "0.28.1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(root, "dist", "index.js");
const tmpOut = path.join(root, "dist", "index.bundled.mjs");

// Packages the bundle must NOT inline: host-provided ones resolve from pi's
// embedded runtime; native/wasm ones are dynamic-imported by absolute path.
// Single source of truth — see ./lib/host-provided-deps.mjs (#1926).
const EXTERNAL = BUNDLE_EXTERNALS;

// esbuild's ESM output wraps bundled CommonJS modules (e.g. vscode-jsonrpc) in a
// shim that throws on any dynamic require(); a pure-ESM Node process has no
// ambient require. Prepend a real one so those bundled CJS deps resolve at load.
const REQUIRE_BANNER =
	'import { createRequire as __pilensCreateRequire } from "node:module"; const require = __pilensCreateRequire(import.meta.url);';

// npm's own CLI, set by npm when it runs this via `npm run bundle:dist`. Running
// esbuild through `node <npm-cli> exec` (rather than the `npx`/`npx.cmd` shim)
// keeps the spawn shell-free and cross-platform, so args are never re-parsed by
// a shell. This uses npm's `exec --package` syntax specifically; pnpm/yarn/bun
// expose a different exec/dlx surface, so the invocation is intentionally
// npm-only (pi always installs via npm, so the shipping path is npm) and we
// reject a non-npm `npm_execpath` with a clear message rather than passing
// npm flags to another package manager's CLI.
const npmCli = process.env.npm_execpath;
const isNpmCli = npmCli
	? /npm-cli\.js$|(^|[\\/])npm(\.js)?$/.test(npmCli)
	: false;

/**
 * Build the argv + spawn options for the esbuild `npm exec` invocation.
 * Pure and side-effect-free (takes the prefix directory as an input rather
 * than creating one) so a test can pin the exact production shape without
 * spawning anything — see tests/scripts/bundle-dist.test.ts (#2594 review
 * F2: a test that only checked the prefix resolver in isolation would stay
 * green even if the call site stopped using its result).
 *
 * `cwd: root` is load-bearing — see the header comment — and asserted
 * directly, not inferred from the absence of a `cwd` override. The actual
 * argv-building is the shared `buildIsolatedExecInvocation` (#2593; also
 * used by scripts/build-dist-tsc.mjs) — see scripts/lib/exec-isolation.mjs.
 *
 * @param {{ npmCli: string, execPrefix: string }} args
 * @returns {{ command: string, argv: string[], options: { cwd: string, stdio: "inherit" } }}
 */
export function buildEsbuildExecInvocation({ npmCli: npmCliPath, execPrefix }) {
	return buildIsolatedExecInvocation({
		npmCli: npmCliPath,
		execPrefix,
		cwd: root,
		packageSpec: `esbuild@${ESBUILD_VERSION}`,
		execArgv: [
			"esbuild",
			distEntry,
			"--bundle",
			"--platform=node",
			"--format=esm",
			...EXTERNAL.map((name) => `--external:${name}`),
			`--outfile=${tmpOut}`,
		],
	});
}

export function main() {
	if (!existsSync(distEntry)) {
		console.error(
			`[bundle] ${distEntry} not found — run build:dist (tsc) first.`,
		);
		process.exit(1);
	}
	// Idempotency guard: the bundle step rewrites dist/index.js IN PLACE, so a
	// second standalone `npm run bundle:dist` (without build:dist's fresh tsc
	// emit) would re-bundle the bundle and prepend the require banner a second
	// time — a duplicate `const require` declaration that fails to load
	// ("Identifier '__pilensCreateRequire' has already been declared"). Detect
	// the banner and no-op instead.
	if (readFileSync(distEntry, "utf8").startsWith(REQUIRE_BANNER)) {
		console.error(
			"[bundle] dist/index.js is already bundled — skipping (run build:dist for a fresh emit).",
		);
		process.exit(0);
	}
	if (!npmCli) {
		console.error(
			"[bundle] npm_execpath unset — run via `npm run bundle:dist`.",
		);
		process.exit(1);
	}
	if (!isNpmCli) {
		console.error(
			`[bundle] npm_execpath is not npm (${npmCli}) — this step uses npm's ` +
				"`exec --package` syntax. Run `npm run bundle:dist` with npm.",
		);
		process.exit(1);
	}

	// mkdtempSync runs inside the try so a TMPDIR failure surfaces through the
	// existing "[bundle] esbuild failed: …" message rather than an uncaught
	// stack trace (#2594 review F3). No retry/fallback: there is no recorded
	// recurrence of mkdtemp failing here, so none is built for it.
	let execPrefix;
	let bundleFailed = false;
	try {
		execPrefix = createIsolatedExecPrefix();
		const { command, argv, options } = buildEsbuildExecInvocation({
			npmCli,
			execPrefix,
		});
		execFileSync(command, argv, options);
	} catch (err) {
		console.error(`[bundle] esbuild failed: ${err?.message ?? err}`);
		bundleFailed = true;
	} finally {
		// Tidiness, not correctness: npm's own package cache lives under npm's
		// cache dir, not this directory, so nothing load-bearing is left behind
		// here either way — but don't leak temp directories on every build.
		if (execPrefix) {
			rmSync(execPrefix, { recursive: true, force: true });
		}
	}
	if (bundleFailed) {
		process.exit(1);
	}

	// Prepend the require banner, then replace the tsc-emitted entry in place.
	writeFileSync(tmpOut, `${REQUIRE_BANNER}\n${readFileSync(tmpOut, "utf8")}`);
	renameSync(tmpOut, distEntry);
	console.error(
		`[bundle] wrote self-contained ${path.relative(root, distEntry)}`,
	);
}

const invokedPath = process.argv[1];
const invokedDirectly =
	typeof invokedPath === "string" &&
	pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;
if (invokedDirectly) {
	main();
}

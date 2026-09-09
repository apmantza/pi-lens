/**
 * Shared isolation shape for `npm exec --package <spec>` spawns whose
 * dependency resolution must never see the project's own `node_modules`
 * tree (#2590, #2593).
 *
 * WHY THIS EXISTS
 * `npm exec --package <spec>` doesn't only check the npx cache: npm's own
 * `lib/commands/exec.js` calls libnpmexec with TWO separate directories —
 * `path: this.npm.localPrefix` (where it LOOKS for an already-satisfying
 * install) and `runPath: process.cwd()` (where it RUNS the resolved binary
 * from). `libnpmexec`'s `missingFromTree` builds an Arborist tree rooted at
 * `path` and queries that tree's FULL inventory (every nested
 * `node_modules`, not just top-level deps) for a version satisfying the
 * spec. If ANY nested copy matches — e.g. a transitive dependency that
 * happens to vendor a same-version copy — npm treats the package as already
 * present and skips the npx-cache install entirely; `binPaths` (what gets
 * prepended to the child's PATH) is populated only on a *different* code
 * path (`needPackageCommandSwap`, the bare `npx <bin>` form — not this
 * explicit `--package` form), so the matched-but-not-linked nested copy
 * leaves the child with no matching binary anywhere on PATH: `<bin>: not
 * found`.
 *
 * Reproduced verbatim for esbuild (#2590 —
 * `@earendil-works/pi-coding-agent` nested a transitive `esbuild@0.28.1`)
 * and shares the exact same `npm exec --package`/`cwd: root` mechanism as
 * `build:dist`'s `npx -p typescript@7.0.2 tsc` spawn (#2593) — currently
 * latent there (no dependency nests a matching `typescript@7.0.2` today,
 * confirmed by inspecting `package-lock.json`) but hardened the same way as
 * defense-in-depth against a future dependency bump nesting one.
 *
 * THE FIX: pass `--prefix <a freshly created, empty temp dir>` on the npm
 * CLI invocation. `--prefix` sets `localPrefix` to that literal value with
 * NO walk-up (verified via `@npmcli/config`'s `loadLocalPrefix()`), so it is
 * independent of `cwd`/`runPath` entirely: Arborist's tree at that empty
 * directory is always empty, so npm always installs into its own npx cache.
 * The spawn's `cwd` is left to the caller: esbuild's call site keeps it at
 * `root` because esbuild bakes bundled-module-path banner comments relative
 * to its own cwd (#2594 review F1) — see scripts/bundle-dist.mjs. `tsc` has
 * no such output hazard (`tsconfig.dist.json`'s `rootDir`/`outDir` resolve
 * relative to the tsconfig file's own location, not cwd, and it emits no
 * cwd-relative paths into `.js` output with sourceMap/declaration both off)
 * but its call site keeps `cwd: root` too, unchanged from before this fix —
 * see scripts/build-dist-tsc.mjs.
 */
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A freshly created, empty directory for the `npm exec --prefix` flag.
 * `mkdtempSync` guarantees the directory itself is newly created and empty
 * (the one thing this fix actually depends on: `--prefix` bypasses npm's
 * walk-up entirely, so Arborist reads exactly this directory and nothing
 * above it).
 *
 * @returns {string} a freshly created, empty temporary directory
 */
export function createIsolatedExecPrefix() {
	return mkdtempSync(path.join(os.tmpdir(), "pilens-exec-"));
}

/**
 * Build the argv + spawn options for an isolated `npm exec --package`
 * invocation. Pure and side-effect-free (takes the prefix directory as an
 * input rather than creating one) so a test can pin the exact production
 * shape without spawning anything.
 *
 * @param {{
 *   npmCli: string,
 *   execPrefix: string,
 *   cwd: string,
 *   packageSpec: string,
 *   execArgv: string[],
 * }} args
 * @returns {{ command: string, argv: string[], options: { cwd: string, stdio: "inherit" } }}
 */
export function buildIsolatedExecInvocation({
	npmCli,
	execPrefix,
	cwd,
	packageSpec,
	execArgv,
}) {
	return {
		command: process.execPath,
		argv: [
			npmCli,
			"exec",
			"--prefix",
			execPrefix,
			"--yes",
			"--package",
			packageSpec,
			"--",
			...execArgv,
		],
		options: { cwd, stdio: "inherit" },
	};
}

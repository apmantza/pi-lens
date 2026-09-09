import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEsbuildExecInvocation } from "../../scripts/bundle-dist.mjs";
import { createIsolatedExecPrefix } from "../../scripts/lib/exec-isolation.mjs";

// #2590: `npm exec --package esbuild@<ESBUILD_VERSION>` resolves against the
// FULL project dependency tree (libnpmexec's `missingFromTree` queries
// Arborist's whole inventory — every nested node_modules, not just top-level
// deps), not just the npx cache. When a dependency happens to nest an
// `esbuild` matching ESBUILD_VERSION (e.g. `@earendil-works/pi-coding-agent`
// -> `@earendil-works/chord` -> `esbuild@0.28.1`), npm finds that nested copy
// "already satisfying" the request, skips its npx-cache install entirely, and
// — because `binPaths` is only populated on the separate bare-`npx <bin>`
// swap path, never on this explicit `--package` path — hands the child a PATH
// with no esbuild binary at all: `sh: 1: esbuild: not found`, reproduced
// verbatim against the #2588 worktree (real dependency tree, real npm exec)
// and, independently, against a throwaway nested `esbuild@0.28.1` fixture in
// #2594's review:
//
//   $ npm exec --yes --package esbuild@0.28.1 -- esbuild --version   # cwd = project root
//   sh: 1: esbuild: not found
//   $ npm exec --prefix <fresh empty dir> --yes --package esbuild@0.28.1 -- esbuild --version   # cwd = project root, unchanged
//   0.28.1
//
// #2594 review F1: a first attempt at this fix moved the spawn's `cwd`
// itself to a fresh temp directory. That also works around the collision
// (npm's tree lookup follows cwd when no `--prefix` is given), but esbuild
// bakes its bundled-module-path banner COMMENTS relative to ITS OWN cwd, so
// moving cwd baked hundreds of machine-specific relative paths
// (`// ../../home/<user>/...`) into the shipped dist/index.js — see
// tests/packaging.test.ts's "bakes no user-profile absolute path into the
// bundle" for that guard. The fix instead keeps the spawn's `cwd` at `root`
// (so esbuild's own relative paths stay correct) and passes
// `--prefix <fresh empty dir>` on the npm CLI invocation: `--prefix`
// overrides npm's tree-lookup directory directly, with no walk-up and no
// effect on the spawned process's own cwd (verified against
// `@npmcli/config`'s `loadLocalPrefix()` — a `--prefix` CLI value short-
// circuits the walk-up entirely).
//
// #2594 review F2: a test that only calls the prefix resolver in isolation
// cannot catch a regression where the call site stops using its result (e.g.
// reverting the invocation to plain `cwd: execPrefix`, or dropping the
// `--prefix` flag entirely — both reintroduce a real defect while leaving an
// isolated cwd/prefix-decision test green). So this test exercises the
// actual argv+options the production code hands to `execFileSync`, via the
// same pure builder `main()` uses.
//
// #2593: the prefix resolver and the argv builder both moved to
// scripts/lib/exec-isolation.mjs (`createIsolatedExecPrefix` /
// `buildIsolatedExecInvocation`), shared with scripts/build-dist-tsc.mjs's
// tsc spawn — see tests/scripts/exec-isolation.test.ts for the generic
// builder's own tests and tests/scripts/build-dist-tsc.test.ts for the tsc
// call site's equivalent of this file's tests.
describe("buildEsbuildExecInvocation (#2594 review F2)", () => {
	const root = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
	);

	it("spawns with cwd: root and a --prefix pointing outside root", () => {
		const execPrefix = createIsolatedExecPrefix();
		try {
			const { options, argv } = buildEsbuildExecInvocation({
				npmCli: "/fake/npm-cli.js",
				execPrefix,
			});

			// Load-bearing: esbuild's own relative-path output depends on this
			// being root, not the prefix directory (#2594 review F1).
			expect(options.cwd).toBe(root);

			// Load-bearing: without --prefix pointed outside root, npm's tree
			// lookup falls back to walking up from cwd (root), reintroducing
			// #2590's collision.
			const prefixIndex = argv.indexOf("--prefix");
			expect(prefixIndex).toBeGreaterThanOrEqual(0);
			const prefixArg = argv[prefixIndex + 1];
			expect(prefixArg).not.toBe(root);
			expect(path.relative(root, prefixArg ?? "").startsWith("..")).toBe(true);
		} finally {
			fs.rmSync(execPrefix, { recursive: true, force: true });
		}
	});

	it("still passes --package esbuild@<version> and the esbuild binary name", () => {
		const execPrefix = createIsolatedExecPrefix();
		try {
			const { argv } = buildEsbuildExecInvocation({
				npmCli: "/fake/npm-cli.js",
				execPrefix,
			});
			const packageIndex = argv.indexOf("--package");
			expect(packageIndex).toBeGreaterThanOrEqual(0);
			expect(argv[packageIndex + 1]).toMatch(/^esbuild@\d+\.\d+\.\d+$/);
			expect(argv).toContain("esbuild");
		} finally {
			fs.rmSync(execPrefix, { recursive: true, force: true });
		}
	});
});

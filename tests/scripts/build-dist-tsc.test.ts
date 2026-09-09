import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	planTscInvocation,
	resolveLocalTsc,
} from "../../scripts/build-dist-tsc.mjs";
import { createIsolatedExecPrefix } from "../../scripts/lib/exec-isolation.mjs";

// #2593: build:dist's `npx --yes -p typescript@7.0.2 tsc --project
// tsconfig.dist.json --noCheck` shares the EXACT same npm-exec resolution
// mechanism as #2590's fixed esbuild spawn in scripts/bundle-dist.mjs — both
// are npm's `exec --package`/`-p` syntax, run with cwd at the project root.
// `npm exec --package` resolves against the WHOLE project dependency tree
// (every nested node_modules, not just top-level deps), not just the npx
// cache; if a dependency ever nests a matching `typescript@7.0.2` copy
// anywhere, npm would treat the package as already present, skip the
// npx-cache install, and hand the child a PATH with no `tsc` binary at all —
// see scripts/lib/exec-isolation.mjs's header comment for the full
// mechanism writeup (shared with #2590's original finding).
//
// #2593 review round 2, F1: round 1's fix ran the isolated `npm exec
// --package typescript@<version> --prefix <empty temp dir>` path
// UNCONDITIONALLY, even though `typescript` is a genuine top-level
// devDependency whose local `node_modules/typescript/bin/tsc` already
// exists at the exact pinned version under any normal install. `--prefix
// <empty dir>` forces npm to skip its local-tree lookup entirely, which
// means it ALSO forces a registry fetch on every single build — reproduced
// with a dead registry: `npm exec --yes --package typescript@7.0.2 -- tsc
// --version` (no --prefix) prints `Version 7.0.2` with zero network calls,
// while the same command WITH `--prefix <empty dir>` fails with
// ECONNREFUSED trying to reach the registry. `resolveLocalTsc` +
// `planTscInvocation` fix this: prefer the local pinned binary (no npm
// exec, no network at all) when present and version-matching, falling back
// to the isolated npm-exec path only when it's absent or mismatched (the
// actual `--omit=dev` from-source install case this was written for).
describe("resolveLocalTsc (#2593 review round 2, F1)", () => {
	function makeFixtureRoot(tscVersion: string | undefined) {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pilens-resolve-local-tsc-"),
		);
		if (tscVersion !== undefined) {
			const tsDir = path.join(root, "node_modules", "typescript");
			const binDir = path.join(tsDir, "bin");
			fs.mkdirSync(binDir, { recursive: true });
			fs.writeFileSync(
				path.join(tsDir, "package.json"),
				JSON.stringify({ name: "typescript", version: tscVersion }),
			);
			fs.writeFileSync(path.join(binDir, "tsc"), "#!/usr/bin/env node\n");
			fs.chmodSync(path.join(binDir, "tsc"), 0o755);
		}
		return root;
	}

	it("returns the local bin path when the installed version exactly matches the pin", () => {
		const root = makeFixtureRoot("7.0.2");
		try {
			const bin = resolveLocalTsc({ root, version: "7.0.2" });
			expect(bin).toBe(
				path.join(root, "node_modules", "typescript", "bin", "tsc"),
			);
			expect(fs.existsSync(bin ?? "")).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns null when the installed version does not match the pin", () => {
		const root = makeFixtureRoot("6.9.9");
		try {
			expect(resolveLocalTsc({ root, version: "7.0.2" })).toBeNull();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns null when typescript is not installed at all (--omit=dev shape)", () => {
		const root = makeFixtureRoot(undefined);
		try {
			expect(resolveLocalTsc({ root, version: "7.0.2" })).toBeNull();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("planTscInvocation local-vs-fallback branching (#2593 review round 2, F1)", () => {
	const root = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
	);

	it("runs node against the local bin's path (never executes it directly), building no npm-exec argv at all", () => {
		const localTscBin = "/fake/node_modules/typescript/bin/tsc";
		const { command, argv, options } = planTscInvocation({
			localTscBin,
			root,
			version: "7.0.2",
			npmCli: "/fake/npm-cli.js",
			execPrefix: undefined,
			tsconfigProject: "tsconfig.dist.json",
		});

		// #2593 review round 3: `localTscBin` is an extensionless
		// `#!/usr/bin/env node` shebang script, not a native executable.
		// Executing it AS the command (asserting `command === localTscBin`,
		// this test's round-2 shape) enshrined exactly the bug that failed
		// `Install test (windows-latest)` in CI (`spawnSync ...\bin\tsc
		// ENOENT` — Windows has no shebang-execution mechanism). The command
		// must be `process.execPath` (node itself), with the script's path as
		// an argv element — the same shape scripts/setup-git-hooks.mjs and
		// scripts/lib/exec-isolation.mjs's buildIsolatedExecInvocation use.
		expect(command).toBe(process.execPath);
		expect(argv[0]).toBe(localTscBin);
		expect(argv).not.toContain("exec");
		expect(argv).not.toContain("--package");
		expect(argv).not.toContain("--prefix");
		expect(argv).toEqual([
			localTscBin,
			"--project",
			"tsconfig.dist.json",
			"--noCheck",
		]);

		// cwd stays root even in this branch (#2593 review round 2, F2): tsc
		// resolves a relative --project argument against its OWN cwd, not the
		// tsconfig file's directory.
		expect(options.cwd).toBe(root);
	});

	it("falls back to the isolated npm-exec path, unchanged, when no local binary is given", () => {
		const execPrefix = createIsolatedExecPrefix();
		try {
			const { options, argv } = planTscInvocation({
				localTscBin: null,
				root,
				version: "7.0.2",
				npmCli: "/fake/npm-cli.js",
				execPrefix,
				tsconfigProject: "tsconfig.dist.json",
			});

			// Load-bearing: cwd stays root in the fallback branch too — only the
			// npm-exec resolution prefix ever moves, never tsc's own cwd (#2594
			// F1's lesson, reapplied here in #2593 review round 2, F2).
			expect(options.cwd).toBe(root);

			const prefixIndex = argv.indexOf("--prefix");
			expect(prefixIndex).toBeGreaterThanOrEqual(0);
			const prefixArg = argv[prefixIndex + 1];
			expect(prefixArg).not.toBe(root);
			expect(path.relative(root, prefixArg ?? "").startsWith("..")).toBe(true);

			const packageIndex = argv.indexOf("--package");
			expect(packageIndex).toBeGreaterThanOrEqual(0);
			expect(argv[packageIndex + 1]).toMatch(/^typescript@\d+\.\d+\.\d+$/);

			const tscIndex = argv.indexOf("tsc");
			expect(tscIndex).toBeGreaterThanOrEqual(0);
			expect(argv[tscIndex + 1]).toBe("--project");
			expect(argv[tscIndex + 2]).toBe("tsconfig.dist.json");
			expect(argv).toContain("--noCheck");
		} finally {
			fs.rmSync(execPrefix, { recursive: true, force: true });
		}
	});
});

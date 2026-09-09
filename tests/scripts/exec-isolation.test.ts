import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildIsolatedExecInvocation,
	createIsolatedExecPrefix,
} from "../../scripts/lib/exec-isolation.mjs";

// #2590, #2593: shared isolation for `npm exec --package <spec>` spawns
// whose dependency resolution must never see the project's own tree — see
// scripts/lib/exec-isolation.mjs's header comment for the full mechanism
// writeup. Originally landed as scripts/bundle-dist.mjs's
// `resolveBundleExecPrefix` (#2590) for the esbuild spawn only; generalized
// here (#2593) so scripts/build-dist-tsc.mjs's tsc spawn can reuse the exact
// same builder instead of a near-duplicate block.
describe("createIsolatedExecPrefix (#2590, #2593)", () => {
	const root = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
	);

	it("returns a fresh, empty directory that is neither the project root, an ancestor of it, nor a descendant of it", () => {
		const prefix = createIsolatedExecPrefix();
		try {
			expect(prefix).not.toBe(root);
			expect(fs.statSync(prefix).isDirectory()).toBe(true);
			expect(fs.readdirSync(prefix)).toEqual([]);

			// This implementation achieves an empty tree by using os.tmpdir(),
			// which also sits outside root's ancestry on every platform this runs
			// on today — not a property mkdtemp itself guarantees (see the header
			// comment on createIsolatedExecPrefix in scripts/lib/exec-isolation.mjs).
			const fromRoot = path.relative(root, prefix);
			expect(fromRoot.startsWith("..")).toBe(true);
			const toRoot = path.relative(prefix, root);
			expect(toRoot.startsWith("..")).toBe(true);
		} finally {
			fs.rmSync(prefix, { recursive: true, force: true });
		}
	});

	it("creates a fresh directory under the OS temp dir on every call", () => {
		const first = createIsolatedExecPrefix();
		const second = createIsolatedExecPrefix();
		try {
			expect(first).not.toBe(second);
			const tmp = fs.realpathSync(os.tmpdir());
			for (const dir of [first, second]) {
				const real = fs.realpathSync(dir);
				expect(real === tmp || !path.relative(tmp, real).startsWith("..")).toBe(
					true,
				);
			}
		} finally {
			fs.rmSync(first, { recursive: true, force: true });
			fs.rmSync(second, { recursive: true, force: true });
		}
	});
});

// The generic builder itself: pin the exact argv shape both call sites
// (scripts/bundle-dist.mjs's esbuild spawn, scripts/build-dist-tsc.mjs's tsc
// spawn) depend on. Each call site also has its own test
// (tests/scripts/bundle-dist.test.ts, tests/scripts/build-dist-tsc.test.ts)
// pinning ITS specific argv/cwd — this test only pins the shared shape so a
// regression in the shared builder cannot hide behind either call site
// passing unrelated assertions.
describe("buildIsolatedExecInvocation (#2593)", () => {
	it("builds an npm exec argv isolated via --prefix, running the given execArgv", () => {
		const { command, argv, options } = buildIsolatedExecInvocation({
			npmCli: "/fake/npm-cli.js",
			execPrefix: "/fake/prefix",
			cwd: "/fake/cwd",
			packageSpec: "some-pkg@1.2.3",
			execArgv: ["some-bin", "--flag"],
		});

		expect(command).toBe(process.execPath);
		expect(argv[0]).toBe("/fake/npm-cli.js");
		expect(argv).toEqual([
			"/fake/npm-cli.js",
			"exec",
			"--prefix",
			"/fake/prefix",
			"--yes",
			"--package",
			"some-pkg@1.2.3",
			"--",
			"some-bin",
			"--flag",
		]);
		expect(options).toEqual({ cwd: "/fake/cwd", stdio: "inherit" });
	});
});

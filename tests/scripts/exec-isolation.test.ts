import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildIsolatedExecInvocation,
	createIsolatedExecPrefix,
	readLockedToolVersion,
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
			"--allow-scripts=some-pkg@1.2.3",
			"--package",
			"some-pkg@1.2.3",
			"--",
			"some-bin",
			"--flag",
		]);
		expect(options).toEqual({ cwd: "/fake/cwd", stdio: "inherit" });
	});

	// Recurrence: master red at b9eda404c (#4028). The outer
	// `npm install --strict-allow-scripts` runs `prepare` -> bundle:dist, and npm
	// hands the strict policy to every lifecycle child through its environment.
	// The nested `npm exec --prefix <empty dir>` reads no package.json, so no
	// allowScripts policy: `esbuild@0.28.1 (postinstall: node install.js)` was
	// "not covered" and the whole install failed (ESTRICTALLOWSCRIPTS). The spawn
	// must approve exactly the one package spec it installs: not a wildcard, not
	// a bypass, and not a version other than the one --package names.
	it("approves exactly its own package spec for lifecycle scripts, never a wildcard or a bypass", () => {
		const { argv } = buildIsolatedExecInvocation({
			npmCli: "/fake/npm-cli.js",
			execPrefix: "/fake/prefix",
			cwd: "/fake/cwd",
			packageSpec: "esbuild@0.28.1",
			execArgv: ["esbuild"],
		});
		const approvals = argv.filter((a) => a.startsWith("--allow-scripts"));
		expect(approvals).toEqual(["--allow-scripts=esbuild@0.28.1"]);
		expect(argv).not.toContain("--dangerously-allow-all-scripts");
		// The approval precedes `--`: after it npm would hand it to the binary.
		expect(argv.indexOf(approvals[0] ?? "")).toBeLessThan(argv.indexOf("--"));
	});
});

// #4066: reject absent or nonexact tool pins instead of reverting to a stale
// source constant. Real lockfile fixtures keep the resolver independent of npm.
describe("readLockedToolVersion (#4066)", () => {
	function withLock(contents: string | undefined, run: (root: string) => void) {
		const root = createIsolatedExecPrefix();
		try {
			if (contents !== undefined)
				fs.writeFileSync(path.join(root, "package-lock.json"), contents);
			run(root);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}

	it("reads the root package version without an installed dependency tree", () => {
		withLock(
			JSON.stringify({
				packages: {
					"": { devDependencies: { esbuild: "^0.28.0" } },
					"node_modules/esbuild": { version: "0.28.2" },
					"node_modules/nested/node_modules/esbuild": { version: "0.28.1" },
				},
			}),
			(root) => {
				expect(readLockedToolVersion({ root, packageName: "esbuild" })).toBe(
					"0.28.2",
				);
			},
		);
	});

	it("accepts exact prerelease and build metadata versions", () => {
		withLock(
			JSON.stringify({
				packages: {
					"node_modules/typescript": { version: "7.1.0-beta.1+build.2" },
				},
			}),
			(root) => {
				expect(readLockedToolVersion({ root, packageName: "typescript" })).toBe(
					"7.1.0-beta.1+build.2",
				);
			},
		);
	});

	it.each([undefined, null, 7, "", "^7.0.2", "latest", "7.0"])(
		"rejects missing or nonexact package version %s",
		(version) => {
			withLock(
				JSON.stringify({
					packages: { "node_modules/typescript": { version } },
				}),
				(root) => {
					expect(() =>
						readLockedToolVersion({ root, packageName: "typescript" }),
					).toThrow("node_modules/typescript needs an exact locked version");
				},
			);
		},
	);

	it("rejects an array version even when string coercion looks exact", () => {
		withLock(
			JSON.stringify({
				packages: { "node_modules/typescript": { version: ["7.0.2"] } },
			}),
			(root) => {
				expect(() =>
					readLockedToolVersion({ root, packageName: "typescript" }),
				).toThrow("node_modules/typescript needs an exact locked version");
			},
		);
	});

	it.each([
		{},
		null,
		{ packages: {} },
		{
			packages: {
				"node_modules/other/node_modules/esbuild": { version: "0.28.1" },
			},
		},
	])("rejects a lockfile without the root tool entry %j", (lock) => {
		withLock(JSON.stringify(lock), (root) => {
			expect(() =>
				readLockedToolVersion({ root, packageName: "esbuild" }),
			).toThrow("node_modules/esbuild needs an exact locked version");
		});
	});

	it("reports a missing source lockfile instead of consulting installed modules", () => {
		withLock(undefined, (root) => {
			expect(() =>
				readLockedToolVersion({ root, packageName: "esbuild" }),
			).toThrow("package-lock.json");
		});
	});

	it("reports malformed source lockfile JSON", () => {
		withLock("{", (root) => {
			expect(() =>
				readLockedToolVersion({ root, packageName: "esbuild" }),
			).toThrow(SyntaxError);
		});
	});
});

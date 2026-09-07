// scripts/lib/knip-command.mjs (#2698 review round 2, F2).
//
// Resolves the real argv to invoke installed `knip` with `process.execPath`
// against its own `bin/knip.js` entry point directly -- never
// `node_modules/.bin/knip[.cmd]`, never a shell.
//
// Node >=20.12 rejects spawning a `.cmd` file with `shell` unset or false
// (the CVE-2024-27980 EINVAL fix), so `node_modules/.bin/knip.cmd` on
// Windows failed to start at all -- and by the time that spawn failed,
// scripts/lib/knip-sibling-purge.mjs had ALREADY deleted the compiled `.js`
// siblings, so the failure mode was not "no output": it silently left the
// tree half-purged with no rebuild prompted. AGENTS.md: this repo develops
// on Windows.
//
// Spawning knip's real `bin/knip.js` file (resolved via its own
// package.json#bin, same as `node_modules/.bin/knip`'s own shim does
// internally) with `process.execPath` needs no shim and no shell on ANY
// platform -- so there is no platform branch here to get wrong. The
// exported function still takes an injectable `resolve` so a test can force
// a broken/absent `bin` entry without needing a second fake npm package on
// disk.
//
// `require.resolve("knip/package.json")` does NOT work: knip's own
// package.json declares an `exports` map with no `"./package.json"` entry,
// so Node refuses the subpath (`ERR_PACKAGE_PATH_NOT_EXPORTED`) regardless
// of what's actually on disk. Resolving the `"."` export instead (knip's
// real, always-exported main entry) and walking up to the nearest
// `package.json` sidesteps the `exports` map entirely -- the same technique
// `clients/package-root.ts`'s `getPackageRoot` uses for this repo's own
// root, applied to an installed dependency instead of the running package.
//
// #2698 review round 3, R2-F4: that upward walk stops at the FIRST
// package.json it finds, which is knip@6.34.0's own root today (its `dist/`
// has no package.json of its own to stop at early) -- but nothing enforced
// that. A future knip layout (or any other package resolved the same way)
// with an intermediate package.json between the entry file and its real
// root would resolve THAT package's `bin` silently, with no error. Asserting
// `pkg.name === "knip"` turns a silent wrong-binary resolution into a loud
// one.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const requireFromHere = createRequire(import.meta.url);

function findPackageJsonUpward(fromFile) {
	let dir = path.dirname(fromFile);
	while (true) {
		const candidate = path.join(dir, "package.json");
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) {
			throw new Error(`no package.json found above ${fromFile}`);
		}
		dir = parent;
	}
}

/**
 * @typedef {{ resolve?: (specifier: string) => string }} CommandDeps `resolve`
 *   is an injectable module resolver for tests, given the SAME specifier
 *   `require.resolve` would receive (a package's main entry, e.g. `"knip"`).
 */

/**
 * @param {string[]} extraArgs
 * @param {CommandDeps} [deps]
 * @returns {{ command: string, args: string[] }}
 */
export function resolveKnipCommand(extraArgs, deps = {}) {
	const resolve =
		deps.resolve ?? ((specifier) => requireFromHere.resolve(specifier));
	const entryPath = resolve("knip");
	const pkgPath = findPackageJsonUpward(entryPath);
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	if (pkg.name !== "knip") {
		throw new Error(
			`resolved ${pkgPath} while looking for knip's package.json, but its "name" is ${JSON.stringify(pkg.name)}, not "knip"`,
		);
	}
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.knip;
	if (!bin) {
		throw new Error(`knip's package.json (${pkgPath}) has no "knip" bin entry`);
	}
	return {
		command: process.execPath,
		args: [path.join(path.dirname(pkgPath), bin), ...extraArgs],
	};
}

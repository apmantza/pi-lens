#!/usr/bin/env node
/**
 * Run `tsc --project <tsconfig> --noCheck` (the first step of `build:dist`),
 * preferring the LOCAL pinned `typescript` devDependency binary — no `npm
 * exec`, no network — and falling back to the same isolated `npm exec
 * --package` path scripts/bundle-dist.mjs uses for its esbuild spawn only
 * when that local binary is absent or a mismatched version.
 *
 * WHY LOCAL-FIRST (#2593 review round 2, F1)
 * `typescript` is a genuine top-level devDependency, so under a normal
 * install `node_modules/typescript/bin/tsc` already exists at the exact
 * pinned version and needs no `npm exec` at all. An earlier version of this
 * fix (#2593 round 1) ran `npm exec --package typescript@<version> --prefix
 * <empty temp dir>` UNCONDITIONALLY — which forces a registry fetch on
 * EVERY `build:dist` run, even when the correct local binary is sitting
 * right there, because `--prefix <empty dir>` guarantees Arborist's tree
 * lookup finds nothing and npm always installs fresh. Reproduced: with the
 * registry unreachable and a cold npm cache, `npm exec --yes --package
 * typescript@7.0.2 -- tsc --version` (no `--prefix`, matching the pre-#2590
 * pattern) prints `Version 7.0.2` with zero network calls (npm resolves the
 * top-level match), while the SAME command with `--prefix <empty dir>`
 * fails with `ECONNREFUSED`/`ETARGET` trying to reach the registry. Forcing
 * every build offline-hostile to hedge against a hazard that isn't even
 * reproducible today (see #2593's original PR) is a net regression, so
 * `resolveLocalTsc` below checks for the exact pinned local binary FIRST and
 * only falls back to the isolated npm-exec path — the actual vulnerable
 * case — when it's absent: a from-source `--omit=dev` install (a `git:`
 * install's `prepare` step, before dev tooling exists) or a version
 * mismatch.
 *
 * WHY `node <path>` AND NOT EXECUTING THE LOCAL BINARY DIRECTLY (#2593
 * review round 3)
 * `node_modules/typescript/bin/tsc` is a 44-byte extensionless
 * `#!/usr/bin/env node` shebang script (`import "../lib/tsc.js"`), not a
 * native executable. Spawning it AS the command (`execFileSync(localTscBin,
 * ...)`, round 2's shape) relies on the OS interpreting the shebang line —
 * which Windows' `CreateProcess` does not do, so that shape failed
 * `Install test (windows-latest)` in CI with `spawnSync
 * ...\node_modules\typescript\bin\tsc ENOENT`. The fix: spawn
 * `process.execPath` (node itself) with the script's path as an argv
 * element, exactly the shape scripts/setup-git-hooks.mjs and
 * scripts/lib/exec-isolation.mjs's `buildIsolatedExecInvocation` (which
 * spawns npm's own CLI the identical way) already use — reused, not
 * reinvented. `node <path>` ignores the shebang line and runs the file per
 * its own `package.json`'s `"type": "module"`, on every platform alike.
 *
 * WHY THE FALLBACK STILL NEEDS `--prefix` ISOLATION (#2593, refs #2590)
 * `npm exec --package` resolves against the WHOLE project dependency tree
 * (every nested `node_modules`), not just the npx cache — see
 * scripts/lib/exec-isolation.mjs. No dependency nests a matching
 * `typescript@7.0.2` anywhere in this repo's tree today (confirmed via
 * package-lock.json), so hitting the fallback path at all is rare (only the
 * `--omit=dev` install shape), and the isolation itself is still a latent-
 * class hardening rather than a currently-reproducible failure — applied
 * defense-in-depth for the same reason #2590 fixed the esbuild spawn: a
 * future dependency bump could nest a matching copy, exactly like
 * `@earendil-works/pi-coding-agent` did for esbuild.
 *
 * `cwd: root` is REQUIRED, not merely hazard-free, in BOTH branches (#2593
 * review round 2, F2): `build:dist` passes `tsconfigProject` as a path
 * RELATIVE to the project root (`tsconfig.dist.json`), and tsc resolves a
 * `--project` argument relative to the SPAWN's own cwd, not the tsconfig
 * file's location — pointing `cwd` anywhere else (e.g. the isolated
 * `execPrefix` temp dir) fails with `TS5058: The specified path does not
 * exist`, confirmed by mutation. This is unrelated to (and stricter than)
 * the fact that `tsconfig.dist.json`'s OWN `rootDir`/`outDir` resolve
 * relative to the tsconfig file's directory once tsc finds it — resolving
 * `--project` itself happens first, against `cwd`. Only the isolated
 * fallback's npm-exec `--prefix` (the resolution lookup directory) ever
 * moves; the tsc invocation's own `cwd` never does, in either branch — the
 * same lesson #2594's F1 finding established for the esbuild spawn.
 *
 * USAGE
 *   node scripts/build-dist-tsc.mjs <tsconfig-path>
 *   # invoked by `npm run build:dist`, before `npm run bundle:dist`
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	buildIsolatedExecInvocation,
	createIsolatedExecPrefix,
} from "./lib/exec-isolation.mjs";

const TSC_VERSION = "7.0.2";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// npm's own CLI, set by npm when it runs this via `npm run build:dist` — see
// scripts/bundle-dist.mjs's identical check for the full rationale. Only
// needed on the fallback (no-local-binary) path.
const npmCli = process.env.npm_execpath;
const isNpmCli = npmCli
	? /npm-cli\.js$|(^|[\\/])npm(\.js)?$/.test(npmCli)
	: false;

/**
 * Resolve the local pinned `typescript` devDependency's `tsc` binary, when
 * present with a version EXACTLY matching `version`. A read-only filesystem
 * probe only — no execution, no network. Returns `null` when `typescript`
 * is absent (a from-source `--omit=dev` install, before dev tooling exists)
 * or present at a different version; either case must fall back to the
 * isolated npm-exec path rather than silently running a mismatched `tsc`.
 *
 * @param {{ root: string, version: string }} args
 * @returns {string | null}
 */
export function resolveLocalTsc({ root: rootDir, version }) {
	const pkgPath = path.join(
		rootDir,
		"node_modules",
		"typescript",
		"package.json",
	);
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch {
		return null;
	}
	if (pkg?.version !== version) {
		return null;
	}
	const binPath = path.join(
		rootDir,
		"node_modules",
		"typescript",
		"bin",
		"tsc",
	);
	return existsSync(binPath) ? binPath : null;
}

/**
 * Decide and build the tsc invocation. Pure and side-effect-free:
 * `localTscBin` is the ALREADY-RESOLVED result of `resolveLocalTsc` (or
 * `null`), not recomputed here, so a test can pin either branch without
 * touching the filesystem — mirroring how buildEsbuildExecInvocation in
 * scripts/bundle-dist.mjs stays pure by taking its prefix as an input. When
 * `localTscBin` is set, this builds NO npm-exec argv at all (no `exec`, no
 * `--package`, no `--prefix`) — just a direct spawn of the local binary,
 * run via `process.execPath` with the script path as an argv element (#2593
 * review round 3), NEVER by executing `localTscBin` itself as the spawned
 * command: it is a 44-byte extensionless `#!/usr/bin/env node` shebang
 * script (`node_modules/typescript/bin/tsc` -> `import "../lib/tsc.js"`),
 * and Windows' `CreateProcess` has no shebang-execution mechanism, so
 * `execFileSync(localTscBin, ...)` fails there with `ENOENT` (reproduced
 * verbatim in CI: `Install test (windows-latest)` on this PR's round-2
 * head). This is the same shell-free "spawn node with the script path as an
 * argv element" shape already used by scripts/setup-git-hooks.mjs and
 * scripts/lib/exec-isolation.mjs's `buildIsolatedExecInvocation` (which
 * spawns npm's own CLI the identical way) — reused here, not reinvented.
 * `node <path>` ignores the shebang line and runs the file as the ES module
 * its own `package.json` declares (`typescript`'s `"type": "module"`),
 * identical to what the OS's shebang mechanism does on POSIX — verified:
 * `node node_modules/typescript/bin/tsc --version` prints the pinned
 * version on every platform this runs on today.
 *
 * @param {{ localTscBin: string | null, root: string, version: string, npmCli: string, execPrefix?: string, tsconfigProject: string }} args
 * @returns {{ command: string, argv: string[], options: { cwd: string, stdio: "inherit" } }}
 */
export function planTscInvocation({
	localTscBin,
	root: rootDir,
	version,
	npmCli: npmCliPath,
	execPrefix,
	tsconfigProject,
}) {
	if (localTscBin) {
		return {
			command: process.execPath,
			argv: [localTscBin, "--project", tsconfigProject, "--noCheck"],
			options: { cwd: rootDir, stdio: "inherit" },
		};
	}
	return buildIsolatedExecInvocation({
		npmCli: npmCliPath,
		execPrefix,
		cwd: rootDir,
		packageSpec: `typescript@${version}`,
		execArgv: ["tsc", "--project", tsconfigProject, "--noCheck"],
	});
}

export function main() {
	const tsconfigProject = process.argv[2];
	if (!tsconfigProject) {
		console.error(
			"[build-dist-tsc] usage: node scripts/build-dist-tsc.mjs <tsconfig-path>",
		);
		process.exit(1);
	}

	const localTscBin = resolveLocalTsc({ root, version: TSC_VERSION });

	// npm is only needed on the fallback (no matching local binary) path.
	if (!localTscBin) {
		if (!npmCli) {
			console.error(
				"[build-dist-tsc] npm_execpath unset — run via `npm run build:dist`.",
			);
			process.exit(1);
		}
		if (!isNpmCli) {
			console.error(
				`[build-dist-tsc] npm_execpath is not npm (${npmCli}) — this step ` +
					"uses npm's `exec --package` syntax. Run `npm run build:dist` with npm.",
			);
			process.exit(1);
		}
	}

	// mkdtempSync runs inside the try so a TMPDIR failure surfaces through the
	// existing "[build-dist-tsc] tsc failed: …" message rather than an
	// uncaught stack trace, mirroring scripts/bundle-dist.mjs (#2594 review
	// F3). No retry/fallback: there is no recorded recurrence of mkdtemp
	// failing here, so none is built for it. Only created when actually
	// needed — the local-binary path never touches npm at all.
	let execPrefix;
	let tscFailed = false;
	try {
		if (!localTscBin) {
			execPrefix = createIsolatedExecPrefix();
		}
		const { command, argv, options } = planTscInvocation({
			localTscBin,
			root,
			version: TSC_VERSION,
			npmCli,
			execPrefix,
			tsconfigProject,
		});
		execFileSync(command, argv, options);
	} catch (err) {
		console.error(`[build-dist-tsc] tsc failed: ${err?.message ?? err}`);
		tscFailed = true;
	} finally {
		if (execPrefix) {
			rmSync(execPrefix, { recursive: true, force: true });
		}
	}
	if (tscFailed) {
		process.exit(1);
	}
}

const invokedPath = process.argv[1];
const invokedDirectly =
	typeof invokedPath === "string" &&
	pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;
if (invokedDirectly) {
	main();
}

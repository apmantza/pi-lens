/**
 * Lint through markdownlint-cli2's exported `main` with `fix` forced off (#5119).
 *
 * markdownlint-cli2 has no CLI switch that turns a project's `"fix": true` (in
 * `.markdownlint-cli2.jsonc`) off, and a directory config beats `--config`, so
 * a diagnostics-only `<cli2> <file>` rewrote the user's file. The package's
 * entry module exports `main({ directory, argv, optionsOverride, logMessage,
 * logError })`; `optionsOverride` is merged over every directory's resolved
 * options, so `{ fix: false }` wins over any project setting while config
 * discovery, `extends`, `ignores` and `overrides` stay cli2's own.
 *
 * `main` runs in a package-owned child (`config/markdownlint/run-no-fix.mjs`)
 * through `safeSpawnAsync`: the 15 s budget kills a spinning rule or a huge
 * table, a late throw ends the child and not the host, and an edited
 * .cjs/.mjs config or custom rule is imported fresh on every lint.
 *
 * The module is located from the command the runner already resolved (project
 * `node_modules/.bin`, the managed tool dir, or a PATH install). When it cannot
 * be located the command is spawned as before and one
 * `markdownlint-api-unavailable` row is recorded; that path passes nothing that
 * enables fix, but a project `"fix": true` can still write there.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { findCommandOnPath } from "../../../command-path.js";
import { recordDegradationOnce } from "../../../degradation-ledger.js";
import { resolvePackagePath } from "../../../package-root.js";
import { realpathOrResolve } from "../../../path-utils.js";
import { type SpawnResult, safeSpawnAsync } from "../../../safe-spawn.js";

const PACKAGE_NAME = "markdownlint-cli2";

/**
 * The package entry beside `command`: `<…>/node_modules/.bin/<shim>` (npm,
 * managed tree), `<prefix>/node_modules/<pkg>` (a Windows global shim), or the
 * package the shim symlinks into (a POSIX global install). A directory only
 * counts when its package.json names markdownlint-cli2.
 */
export function locateCli2Entry(command: string): string | null {
	const shim = /[\\/]/.test(command)
		? command
		: findCommandOnPath(command, process.platform === "win32");
	if (!shim) return null;
	const shimDir = path.dirname(shim);
	const candidates = [
		path.join(shimDir, "..", PACKAGE_NAME),
		path.join(shimDir, "node_modules", PACKAGE_NAME),
	];
	candidates.push(path.dirname(realpathOrResolve(shim)));
	for (const dir of candidates) {
		try {
			const manifest = JSON.parse(
				fs.readFileSync(path.join(dir, "package.json"), "utf8"),
			) as { name?: unknown; exports?: unknown };
			if (manifest.name !== PACKAGE_NAME) continue;
			const root =
				manifest.exports && typeof manifest.exports === "object"
					? (manifest.exports as Record<string, unknown>)["."]
					: manifest.exports;
			if (typeof root !== "string") continue;
			const entry = path.resolve(dir, root);
			if (fs.statSync(entry).isFile()) return entry;
		} catch {
			// none: a directory with no readable manifest is not the package; the
			// caller records markdownlint-api-unavailable when no candidate is
		}
	}
	return null;
}

/**
 * Lint `args` in `cwd` with cli2's `fix` off, or spawn `command` as it was when
 * no cli2 package sits beside it. Same spawn seam, budget and kill either way.
 */
export async function runMarkdownlintApi(options: {
	command: string;
	cwd: string;
	args: string[];
	timeoutMs: number;
}): Promise<SpawnResult> {
	const entry = locateCli2Entry(options.command);
	if (!entry) {
		recordDegradationOnce({
			kind: "markdownlint-api-unavailable",
			subject: options.command,
			reason:
				'no markdownlint-cli2 package sits beside it; linting by spawn, where a project "fix": true can still rewrite the file',
		});
		return safeSpawnAsync(options.command, options.args, {
			timeout: options.timeoutMs,
			cwd: options.cwd,
		});
	}
	return safeSpawnAsync(
		process.execPath,
		[
			resolvePackagePath(import.meta.url, "config/markdownlint/run-no-fix.mjs"),
			entry,
			options.cwd,
			...options.args,
		],
		{ timeout: options.timeoutMs, cwd: options.cwd },
	);
}

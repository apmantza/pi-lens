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
 * The module is located from the command the runner already resolved (project
 * `node_modules/.bin`, the managed tool dir, or a PATH install). When it cannot
 * be located or loaded the caller keeps the spawn path and records one
 * `markdownlint-api-unavailable` row; that path passes nothing that enables
 * fix, but a project `"fix": true` can still write there.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { recordDegradationOnce } from "../../../degradation-ledger.js";
import { findCommandOnPath } from "../../../installer/index.js";
import type { SpawnResult } from "../../../safe-spawn.js";
import { createBoundedOutputSink } from "../../../spawn-output-cap.js";

const PACKAGE_NAME = "markdownlint-cli2";

/** The slice of cli2's `Parameters` this runner passes. */
interface Cli2Params {
	directory: string;
	argv: string[];
	optionsOverride: { fix: false };
	logMessage: (message: string) => void;
	logError: (message: string) => void;
}

type Cli2Main = (params: Cli2Params) => Promise<number>;

/**
 * The package entry beside `command`: `<…>/node_modules/.bin/<shim>` (npm,
 * managed tree), `<prefix>/node_modules/<pkg>` (a Windows global shim), or the
 * package the shim symlinks into (a POSIX global install). A directory only
 * counts when its package.json names markdownlint-cli2.
 */
export function locateCli2Entry(command: string): string | null {
	const shim = /[\\/]/.test(command) ? command : findCommandOnPath(command);
	if (!shim) return null;
	const shimDir = path.dirname(shim);
	const candidates = [
		path.join(shimDir, "..", PACKAGE_NAME),
		path.join(shimDir, "node_modules", PACKAGE_NAME),
	];
	try {
		candidates.push(path.dirname(fs.realpathSync(shim)));
	} catch {
		// a shim that cannot be resolved has no package behind it
	}
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
			// not a package directory; try the next candidate
		}
	}
	return null;
}

async function loadCli2Main(entry: string): Promise<Cli2Main | null> {
	try {
		const loaded = (await import(pathToFileURL(entry).href)) as {
			main?: unknown;
		};
		return typeof loaded.main === "function" ? (loaded.main as Cli2Main) : null;
	} catch {
		return null;
	}
}

/**
 * Run cli2 over `args` in `cwd` with fix off and return a spawn-shaped result,
 * or null when the module is unavailable (the caller spawns instead). Output
 * comes from the API's loggers, never stdout. A throw is cli2's exit 2 (what
 * its bin does with a rejected config); a run past `timeoutMs` is a timeout.
 * A timed-out run cannot be cancelled, so the caller's spawn-timeout cooldown
 * keeps it from stacking a second one.
 */
export async function runMarkdownlintApi(options: {
	command: string;
	cwd: string;
	args: string[];
	timeoutMs: number;
}): Promise<SpawnResult | null> {
	const entry = locateCli2Entry(options.command);
	const main = entry ? await loadCli2Main(entry) : null;
	if (!main) {
		recordDegradationOnce({
			kind: "markdownlint-api-unavailable",
			subject: options.command,
			reason: `markdownlint-cli2 module ${entry ? `at ${entry} did not load` : "not found beside the command"}; linting by spawn, where a project "fix": true can still rewrite the file`,
		});
		return null;
	}

	const out = createBoundedOutputSink();
	const err = createBoundedOutputSink();
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
		timer.unref();
	});
	try {
		const ran = main({
			directory: options.cwd,
			argv: options.args,
			optionsOverride: { fix: false },
			logMessage: (message) => out.append(`${message}\n`),
			logError: (message) => err.append(`${message}\n`),
		});
		// A rejection after the timeout has nobody to tell; do not let it escape.
		ran.catch(() => {});
		const verdict = await Promise.race([ran, timedOut]);
		const truncated = out.truncated || err.truncated;
		if (verdict === "timeout") {
			return {
				stdout: out.text,
				stderr: err.text,
				status: null,
				failure: "timeout",
				error: new Error(
					`markdownlint-cli2 timed out after ${options.timeoutMs}ms`,
				),
				outputTruncated: truncated,
			};
		}
		return {
			stdout: out.text,
			stderr: err.text,
			status: verdict,
			...(truncated && { outputTruncated: true }),
		};
	} catch (error) {
		err.append(
			`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		return { stdout: out.text, stderr: err.text, status: 2 };
	} finally {
		clearTimeout(timer);
	}
}

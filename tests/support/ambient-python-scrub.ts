/**
 * The PATH a test worker keeps once the shell's active Python environments are
 * scrubbed (#5712): every directory activating them put on PATH is removed,
 * and every other entry is kept in order, empty entries included.
 *
 * Entries are compared on the path-identity key (`normalizeFilePath`), so a
 * Windows entry that spells the environment with another case still matches:
 * `C:\Envs\dev` activates `c:\envs\dev\Scripts` (#5713 review r1). The key
 * owner reads no logger at load, so the worker setup can import this before
 * its home pins.
 */

import { posix, win32 } from "node:path";
import { normalizeFilePath } from "../../clients/path-utils.js";
import {
	AMBIENT_ENVIRONMENT_VARIABLES,
	type AmbientPythonSource,
	pythonEnvironmentActivationDirs,
} from "../../clients/python-ambient-environment.js";

/** The scrubbed PATH, or `undefined` when no ambient channel is set in `env`. */
export function pathWithoutActivePythonEnvironments(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const active = new Set<string>();
	for (const [source, variable] of Object.entries(
		AMBIENT_ENVIRONMENT_VARIABLES,
	)) {
		const root = env[variable];
		if (!root) continue;
		for (const dir of pythonEnvironmentActivationDirs(
			root,
			source as AmbientPythonSource,
			platform,
		))
			active.add(normalizeFilePath(dir));
	}
	if (active.size === 0) return undefined;
	const delimiter = platform === "win32" ? win32.delimiter : posix.delimiter;
	return (env.PATH ?? "")
		.split(delimiter)
		.filter((dir) => dir === "" || !active.has(normalizeFilePath(dir)))
		.join(delimiter);
}

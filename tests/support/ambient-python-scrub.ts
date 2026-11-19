/**
 * The PATH a test worker keeps once the shell's active Python environments are
 * scrubbed (#5712): every directory activating them put on PATH is removed,
 * and every other entry is kept in order, empty entries included.
 *
 * Entries compare on a platform key: on Windows the resolved path folded to
 * one case, so a PATH entry that spells the environment with another case
 * still matches (`C:\\Envs\\dev` activates `c:\\envs\\dev\\Scripts`, #5713
 * review r1); elsewhere the resolved path, case kept.
 *
 * Node built-ins only, on purpose. The worker setup loads this before any test
 * file, in the same module registry, so whatever it imports is cached before
 * a test's `vi.mock`s apply: importing `clients/path-utils.js` here pinned the
 * real `node:fs` into every later importer of it, and the suites that mock
 * `node:fs` to count path probes read zero (#5713 CI). That is why the key is
 * spelled here and not asked of `normalizeFilePath`, the identity owner: the
 * scrub needs only case and separator folding, not its realpath.
 */

import { posix, win32 } from "node:path";
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
	const keyOf = (dir: string): string =>
		platform === "win32"
			? win32.resolve(dir).toLowerCase()
			: posix.resolve(dir);
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
			active.add(keyOf(dir));
	}
	if (active.size === 0) return undefined;
	const delimiter = platform === "win32" ? win32.delimiter : posix.delimiter;
	return (env.PATH ?? "")
		.split(delimiter)
		.filter((dir) => dir === "" || !active.has(keyOf(dir)))
		.join(delimiter);
}

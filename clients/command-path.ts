/**
 * Walk PATH for a command and return the file the spawn would run (#5119).
 * No spawn: ~μs per candidate vs ~50ms for which/where.
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import {
	isUntrustedProjectPath,
	recordProjectCommandRefusal,
} from "./session-repository.js";

/**
 * The first PATH candidate that is a real file with non-zero size (a broken
 * symlink stats as missing or empty), or null. The installer's boolean
 * `isCommandAvailable` and the markdownlint API loader both answer from here.
 */
export function findCommandOnPath(
	command: string,
	isWindows: boolean,
): string | null {
	const pathEnv =
		process.env.PATH || process.env.Path || process.env.path || "";
	const dirs = pathEnv.split(path.delimiter);

	// On Windows, probe .exe, .cmd, and .bat extensions in addition to bare name.
	// On Unix, probe bare name and extensionless (scripts, symlinks).
	const names = isWindows
		? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
		: [command];

	for (const dir of dirs) {
		if (!dir) continue;
		for (const name of names) {
			// #4530: joined as text on POSIX, as the kernel joins it, so a
			// `link/..` entry is read where the spawn would find it; Win32
			// folds `..` lexically itself.
			const candidate = isWindows
				? path.join(dir, name)
				: `${dir}${path.sep}${name}`;
			try {
				const stat = statSync(candidate);
				// isFile() returns false for broken symlinks (target missing)
				if (!stat.isFile() || stat.size === 0) continue;
				// #4530: a candidate that is the session repository's bytes (a
				// project PATH entry, a relative one, or a global link into the
				// project) is no answer until pi trusts the project: the installer
				// would otherwise report a project binary as an installed tool.
				if (isUntrustedProjectPath(candidate)) {
					recordProjectCommandRefusal(candidate);
					continue;
				}
				return candidate;
			} catch {
				// none: ENOENT or permission denied means this candidate is not the
				// command's file; the walk goes on and ends in null when none is
			}
		}
	}

	return null;
}

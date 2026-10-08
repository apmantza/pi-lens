import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BoundedFifoMap } from "./bounded-cache.js";
import {
	isRealGitMarker,
	isUnderDir,
	normalizeEphemeralMapKey,
} from "./path-utils.js";

/**
 * Where a directory sits relative to the host temporary directory (#1129).
 * `checkout` and `stagingRoot` are only ever set for a directory below the
 * real tmpdir, and never both: a real git checkout always wins over staging.
 */
interface TmpDirClass {
	/** A real git marker sits at or above the directory, below the tmpdir. */
	checkout: boolean;
	/** No checkout, and a `pi-agent-*` segment below the tmpdir: its real path. */
	stagingRoot?: string;
}

const NOT_EPHEMERAL: TmpDirClass = { checkout: false };

// One entry per directory spelling a process classifies; FIFO-evicted, so a
// long session's LSP traffic cannot grow it. The answer is settled for the
// process like the data dir it selects (#1129 F6): a later `git init` in a
// classified directory does not move that directory's data mid-process.
const classified = new BoundedFifoMap<string, TmpDirClass>(1024);

/**
 * `realpathSync.native` of `target`, or of its nearest existing ancestor with
 * the missing tail re-appended (#1129 F11: a directory not created yet,
 * spelled through a symlinked tmpdir). The resolved spelling when nothing on
 * the way up resolves.
 */
function realPathOfNearestExisting(target: string): string {
	const resolved = path.resolve(target);
	const tail: string[] = [];
	for (let current = resolved; ; current = path.dirname(current)) {
		try {
			return path.join(fs.realpathSync.native(current), ...tail.reverse());
		} catch {
			if (path.dirname(current) === current) return resolved;
			tail.push(path.basename(current));
		}
	}
}

/**
 * One upward walk from `realpath(dir)` to just below `realpath(os.tmpdir())`,
 * both sides canonical through `realpathSync.native` (#1129 F4: macOS `/var`
 * links to `/private/var`, and Windows can report an 8.3 short tmpdir name).
 * The first real git marker (`isRealGitMarker`: a `.git` directory holding
 * HEAD, or a `gitdir:` file) makes the directory part of a temporary
 * checkout, whatever depth it sits at (F7). The tmpdir itself is never probed
 * (F12): a repository AT the tmpdir (TMPDIR=$HOME with a dotfiles repo) does
 * not own what is below it. Without a checkout, a `pi-agent-*` segment below
 * the tmpdir makes the directory host staging (F5).
 */
function classifyTmpDir(dir: string): TmpDirClass {
	const tmpSpelling = os.tmpdir();
	const key = `${normalizeEphemeralMapKey(tmpSpelling)}\0${normalizeEphemeralMapKey(path.resolve(dir))}`;
	const memo = classified.get(key);
	if (memo) return memo;
	const tmpRoot = realPathOfNearestExisting(tmpSpelling);
	const real = realPathOfNearestExisting(dir);
	let result = NOT_EPHEMERAL;
	if (isUnderDir(real, tmpRoot)) {
		for (
			let current = real;
			current !== tmpRoot && path.dirname(current) !== current;
			current = path.dirname(current)
		) {
			if (isRealGitMarker(path.join(current, ".git"))) {
				result = { checkout: true };
				break;
			}
		}
		if (!result.checkout) {
			const segments = path.relative(tmpRoot, real).split(path.sep);
			const index = segments.findIndex((segment) =>
				/^pi-agent(?:-|$)/i.test(segment),
			);
			if (index >= 0) {
				result = {
					checkout: false,
					stagingRoot: path.join(tmpRoot, ...segments.slice(0, index + 1)),
				};
			}
		}
	}
	classified.set(key, result);
	return result;
}

/**
 * The host-created `pi-agent-*` staging directory that holds `filePath`, as a
 * real path, or `undefined`. Staging dirs are tool-internal, never a user
 * project; a real checkout inside or around one is not staging.
 */
export function ephemeralStagingRoot(filePath: string): string | undefined {
	return classifyTmpDir(path.dirname(path.resolve(filePath))).stagingRoot;
}

/**
 * True for a directory inside a real git checkout below the host temporary
 * directory: the checkout root itself or any subdirectory of it. Such
 * checkouts are normal within one process and never persisted across
 * processes (#1129 decision B).
 */
export function isEphemeralCheckoutRoot(dir: string): boolean {
	return classifyTmpDir(dir).checkout;
}

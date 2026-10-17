import type { Dirent } from "node:fs";

/** Directory names {@link walkFiles} never descends into. */
export declare const RUNTIME_SCRATCH_DIRS: ReadonlySet<string>;
/** Sorted absolute paths of the non-directory entries `accept` keeps; a
 *  non-root directory that vanished mid-walk is reported, not fatal. */
export declare function walkFiles(
	root: string,
	accept: (entry: Dirent, absolute: string) => boolean,
	onVanishedDirectory: (directory: string) => void,
): string[];

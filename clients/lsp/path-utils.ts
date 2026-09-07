/**
 * Re-export from shared path-utils.
 * Kept as a local module for LSP imports that use relative paths.
 */
export {
	isUnderDir,
	normalizeEphemeralMapKey,
	normalizeMapKey,
	pathsEqual,
	uriToDiskPath,
	uriToPath,
} from "../path-utils.js";

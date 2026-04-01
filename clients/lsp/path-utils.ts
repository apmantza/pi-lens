/**
 * Re-export from shared path-utils.
 * Kept as a local module for LSP imports that use relative paths.
 */
export {
	isUnderDir,
	normalizeFilePath,
	normalizeMapKey,
	pathsEqual,
	pathToUri,
	uriToPath,
} from "../path-utils.js";

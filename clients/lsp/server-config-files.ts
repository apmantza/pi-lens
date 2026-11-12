/**
 * #4532 gap 12, #5501: the project config files a language server reads once
 * and keeps, and the servers that keep them.
 *
 * pyright reads `pyrightconfig.json` and `pyproject.toml` (`[tool.pyright]`)
 * when it starts and registers client watchers for them (a `pyrightconfig.json`
 * glob at any depth and a match-all glob, measured on pyright 1.1.414). A config file created, edited or
 * deleted afterwards changes nothing in the running server until a
 * `workspace/didChangeWatchedFiles` event names it: a `pyrightconfig.json`
 * with `extraPaths` created after the server answered left the importer's
 * "could not be resolved" finding in place through 20 polls over 11.9 s, while
 * the same file present at start cleared it on the first call. Created,
 * Changed and Deleted events each made the server re-read it (measured).
 *
 * A file extension cannot route the event: `pyrightconfig.json` matches the
 * JSON server and `pyproject.toml` a TOML one, never pyright. This table is
 * the routing, and it is a CLOSED list (fail closed): only a name measured to
 * be read-once by the listed server is here, and any other name is refused.
 * `typescript-language-server` is measured NOT to need it (a `tsconfig.json`
 * created after ready took effect on its own: tsserver watches it), so
 * `tsconfig*.json` is not listed. A name is added with its measurement.
 *
 * #5501: rust-analyzer and gopls hold the manifest the same way, and a manifest
 * fixed after the workspace failed to load stayed unread until the server
 * restarted. Measured with rust-analyzer 1.99.1: a broken `Cargo.toml` reports
 * `Failed to load workspaces.` and registers no watcher at all, so the event
 * cannot wait for a registration; once the event names `Cargo.toml` the status
 * goes error, loading, ok and the next touch finds the type error. Measured
 * with gopls 0.17.1: a `go.mod` raised from `go 1.17` to `go 1.21` left the
 * "requires go1.18" finding in place through six touches over 18 s, and
 * cleared on the first touch once the event named it. Only the manifest at the
 * root is looked for (`go.work`, `Cargo.lock` and a member crate's manifest
 * below the root are not on the list: unmeasured).
 *
 * Imports nothing: `clients/out-of-band-changes.ts` (the detector) and the LSP
 * service (the delivery) both read it.
 */
import { basename } from "node:path";

/** Config file basename -> ids of the servers that read it once. */
const CONFIG_FILE_SERVERS: ReadonlyMap<string, readonly string[]> = new Map([
	["pyrightconfig.json", ["python"]],
	["pyproject.toml", ["python"]],
	["Cargo.toml", ["rust"]],
	["go.mod", ["go"]],
]);

/** The config file names the detector looks for at a root. */
export const SERVER_CONFIG_FILE_NAMES: readonly string[] = [
	...CONFIG_FILE_SERVERS.keys(),
];

/**
 * The ids of the servers that read `filePath` as config, or `undefined` when
 * the name is not on the list (an ordinary file: the caller routes it by
 * extension). Matches the exact basename, case-sensitively, as the servers do.
 */
export function serverIdsForConfigFile(
	filePath: string,
): readonly string[] | undefined {
	return CONFIG_FILE_SERVERS.get(basename(filePath));
}

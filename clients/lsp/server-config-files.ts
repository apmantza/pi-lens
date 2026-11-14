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
 * cleared on the first touch once the event named it. A `go.work` that gained
 * a `use` member (`use ./a` to `use (./a ./b)`) left "no required module
 * provides package" in place through five touches without the entry, and
 * cleared on the first touch with it listed.
 *
 * `Cargo.lock` and `go.sum` are not listed: they are install stamps
 * (`INSTALL_LOCKFILES` in `clients/out-of-band-changes.ts`), and an edit to
 * either restarts the server as an install.
 *
 * #5501 r3: rust-analyzer reads every workspace member's `Cargo.toml` and gopls
 * every module it serves, so a member manifest fixed after the load failed
 * stayed unread too: rust-analyzer 1.100.0 stayed `server-load-failed` through
 * five touches after a member `Cargo.toml` was fixed, and gopls 0.17.1 kept
 * "requires go1.18" through five touches after a nested `go.mod` (under a
 * `go.work`, or alone in a monorepo subdirectory) was raised to go 1.21. Once
 * the event named the manifest, both cleared on the next touch (rust-analyzer
 * after one still-loading touch). `Cargo.toml` and `go.mod` are therefore also
 * forwarded below the root ({@link BELOW_ROOT_CONFIG_FILE_NAMES}); the
 * declaration walk finds them. A name is below-root only with its own
 * measurement: pyright reads its config at the project root only, and a
 * `go.work` below the root is unmeasured.
 *
 * Measured NOT to need the event (so not listed): clangd 22 re-reads a changed
 * `compile_commands.json` at the next parse with or without an event (cleared
 * on the third touch both ways), and lua-language-server watches `.luarc.json`
 * itself (cleared on the second touch both ways). Unmeasured, so not listed:
 * the manifests of servers with no binary on the measuring host (`pom.xml`,
 * `build.gradle`, `composer.json`, `mix.exs`, `pubspec.yaml`, `Package.swift`,
 * `build.zig`, `stack.yaml`, `dune-project`, `Gemfile`, `deno.json`).
 *
 * Not forwarded: the session root's and the MCP cwd's own first look, which
 * names no client epoch (a config fixed between a client's spawn and that first
 * look stays unread until the next edit; the first look at any other live
 * client root does publish it).
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
	["go.work", ["go"]],
]);

/** The config file names the detector looks for at a root. */
export const SERVER_CONFIG_FILE_NAMES: readonly string[] = [
	...CONFIG_FILE_SERVERS.keys(),
];

/**
 * The names also looked for below the root (#5501 r3): a name whose server
 * reads every workspace member's copy. A subset of the table above.
 */
export const BELOW_ROOT_CONFIG_FILE_NAMES: ReadonlySet<string> = new Set([
	"Cargo.toml",
	"go.mod",
]);

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

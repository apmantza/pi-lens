/**
 * buildCommand replacement for the compiled-source mutation lane (#3531).
 *
 * Stryker's DisableTypeChecksPreprocessor rewrites every project `.ts` file
 * in place (inserting `@ts-nocheck`) during sandbox init, before the dry
 * run -- which bumps their mtime above the already-built `.js` the driver
 * compiled before invoking Stryker at all. `tests/support/check-build-
 * freshness.ts`'s globalSetup then aborts the dry run as a "stale build"
 * (measured: 2026-09-26, `clients/config-core/deny.ts` 16ms newer than its
 * `.js` after a scripts-only `--mutate` run touched no compiled source).
 *
 * A real rebuild here (the scripts-only lane's plain `npm run build`) would
 * fix that, but it would also overwrite the instrumented (mutation-switch-
 * embedded) `.js` Stryker just wrote in place for a compiled mutate target,
 * silently discarding every mutant before a single test runs -- content
 * Stryker itself never wrote back (#3531 issue: "never let a post-instrument
 * build clobber the mutants"). This only bumps mtimes; it never reads or
 * rewrites file content, so it cannot touch the instrumented switches.
 */
import { existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./is-main-module.mjs";

// Mirrors tests/support/check-build-freshness.ts's COMPILED_DIRS/
// COMPILED_ROOT_FILES (that module lives under tests/, which tsconfig.build
// excludes, so it has no compiled sibling a plain `node` process can import
// here) plus `mcp/`, which the mutation lane also mutates.
const COMPILED_DIRS = ["clients", "tools", "mcp"];
const COMPILED_ROOT_FILES = ["index.js", "i18n.js"];

function touchJsTree(dir, now) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			touchJsTree(full, now);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".js")) {
			utimesSync(full, now, now);
		}
	}
}

export function refreshCompiledJsMtimes({
	dirs = COMPILED_DIRS,
	rootFiles = COMPILED_ROOT_FILES,
	now = new Date(),
} = {}) {
	for (const dir of dirs) touchJsTree(dir, now);
	for (const file of rootFiles) {
		if (existsSync(file)) utimesSync(file, now, now);
	}
}

if (isMainModule(import.meta.url)) {
	refreshCompiledJsMtimes();
}

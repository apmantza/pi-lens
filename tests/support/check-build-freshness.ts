/**
 * Vitest globalSetup: fail fast if the in-place compiled `.js` is stale (#198).
 *
 * `npm run build` (tsconfig.build) emits compiled `.js` in place next to each
 * `.ts`. Vitest resolves a test's `../clients/foo.js` import specifier to that
 * **literal compiled file**, not the `.ts` source — so if you edit a source
 * `.ts` and run the suite WITHOUT rebuilding, vitest exercises the *previous*
 * build and your change is silently untested (it can pass against code that no
 * longer exists). `npm run lint` type-checks the `.ts` and stays green, so the
 * change *looks* validated. CI is safe only because its `test` job runs
 * `npm run build` first; there is no `pretest` hook, and a direct `npx vitest
 * run` (what agents/devs use constantly) bypasses one anyway.
 *
 * This guard runs once per vitest process — before any test, for EVERY launch
 * (`npm test`, `npx vitest run`, watch start) — and throws with an actionable
 * message if any compiled-source `.ts` is newer than its `.js` (or has none).
 * Throwing here aborts the run, so stale output can never silently pass.
 */

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Directories compiled in place by `npm run build` that tests import as `.js`.
// (tests/ is excluded from the build and loaded as `.ts`, so it's not at risk.)
const COMPILED_DIRS = ["clients", "commands", "tools"];
const COMPILED_ROOT_FILES = ["index.ts", "i18n.ts"];

function* walkSourceTs(dir: string): Generator<string> {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			yield* walkSourceTs(full);
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".d.ts") &&
			!entry.name.endsWith(".test.ts")
		) {
			yield full;
		}
	}
}

function collectCompiledSources(
	root: string,
	dirs: string[],
	rootFiles: string[],
): string[] {
	const sources: string[] = [];
	for (const d of dirs) sources.push(...walkSourceTs(join(root, d)));
	for (const f of rootFiles) {
		const p = join(root, f);
		if (existsSync(p)) sources.push(p);
	}
	return sources;
}

/**
 * Pure(ish) staleness check, exported for unit testing. Returns the source
 * `.ts` files whose compiled `.js` sibling is missing or older than the source.
 */
export function findStaleCompiledSources(opts: {
	root: string;
	dirs?: string[];
	rootFiles?: string[];
}): string[] {
	const { root, dirs = COMPILED_DIRS, rootFiles = COMPILED_ROOT_FILES } = opts;
	const stale: string[] = [];
	for (const ts of collectCompiledSources(root, dirs, rootFiles)) {
		const js = `${ts.slice(0, -3)}.js`;
		if (!existsSync(js)) {
			stale.push(ts);
			continue;
		}
		// Strict `>`: a freshly built `.js` is written after the `.ts` it compiles,
		// so jsMtime >= tsMtime; equal counts as fresh.
		if (statSync(ts).mtimeMs > statSync(js).mtimeMs) stale.push(ts);
	}
	return stale;
}

export default function setup(): void {
	const stale = findStaleCompiledSources({ root: repoRoot });
	if (stale.length === 0) return;

	const rel = (p: string) => p.slice(repoRoot.length + 1).replace(/\\/g, "/");
	const shown = stale.slice(0, 10).map(rel);
	const more = stale.length > 10 ? `\n  …and ${stale.length - 10} more` : "";
	throw new Error(
		`\n⛔ Stale build: ${stale.length} source file(s) are newer than their compiled .js (or have none).\n` +
			`Vitest loads the compiled .js next to each .ts (\`npm run build\` emits in place),\n` +
			`so these edits are NOT under test. Run \`npm run build\` before testing.\n` +
			`Stale:\n  ${shown.join("\n  ")}${more}\n`,
	);
}

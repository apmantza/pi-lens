/**
 * Mechanical scan for the ".ts specifier reaches a duplicate module instance"
 * hazard (#1565).
 *
 * The repo's runtime IS the compiled output: `npm run build` emits a sibling
 * `.js` beside every source `.ts` outside `tests/`, and production code imports
 * those `.js` specifiers. Vite/Vitest resolve an import specifier LITERALLY —
 * `x.js` loads the compiled file whenever it is on disk, and only falls back to
 * `x.ts` when it is not. So a test that spells a module `x.ts` gets a SECOND
 * instance of that module: its own module-level state (generation counters,
 * latches, memo maps) is a copy, while everything it imports (`./dep.js`) is
 * still shared with the compiled graph.
 *
 * The consequence is a vacuous test (defect shape 7): a `beforeEach` that calls
 * a reset imported through `.ts` bumps the copy's counter and leaves the
 * compiled state the code under test actually reads untouched. The assertion
 * then passes without ever observing the behaviour it claims to guard.
 *
 * The check is deliberately STATIC — it flags the `.ts` specifier itself rather
 * than looking for a `.js` twin on disk. A freshness- or twin-based check goes
 * silent in an unbuilt tree (no `.js` files exist yet, so every specifier
 * collapses onto the source and nothing looks mixed), which is exactly the
 * state a contributor's first run is in.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { toPosix } from "../../clients/path-utils.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** A test-side import that reaches a build-compiled module through `.ts`. */
export interface DualInstanceImport {
	/** Repo-relative posix path of the importing test file. */
	file: string;
	/** The specifier as written. */
	specifier: string;
	/** Repo-relative posix path the specifier resolves to. */
	target: string;
}

/**
 * Roots the production build does NOT compile, read from `tsconfig.build.json`
 * rather than restated here: its `exclude` list is the single source of truth
 * for what has no compiled `.js` twin (and therefore no hazard).
 */
function uncompiledRoots(): string[] {
	const config = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "tsconfig.build.json"), "utf8"),
	) as { exclude?: unknown };
	const exclude = config.exclude;
	if (!Array.isArray(exclude) || exclude.length === 0) {
		throw new Error("tsconfig.build.json has no exclude list");
	}
	return exclude.map((entry) => toPosix(String(entry)));
}

/** True when the build emits a sibling `.js` for this repo-relative path. */
function isBuildCompiled(target: string, excluded: string[]): boolean {
	if (target.startsWith("../") || path.isAbsolute(target)) return false;
	if (!/\.(?:ts|mts|cts|tsx)$/.test(target)) return false;
	if (/\.d\.(?:ts|mts|cts)$/.test(target)) return false;
	return !excluded.some(
		(entry) => target === entry || target.startsWith(`${entry}/`),
	);
}

/**
 * Every relative specifier a file pulls in, across the forms that can bind a
 * module instance: static `import`/`export … from`, bare side-effect
 * `import "…"`, dynamic `import("…")`, and the `vi` mock registry
 * (`mock`/`doMock`, whose factory replaces the instance the graph resolves, and
 * `unmock`/`doUnmock`, which restore it). The unmock forms matter for the same
 * reason as the rest and for one of their own: vitest keys the registry by
 * resolved module, so an `unmock("x.ts")` against a `mock("x.js")` lifts
 * nothing at all and fails silently.
 *
 * Static forms are anchored to the start of a line so that a quoted import
 * statement inside a test FIXTURE string (test bodies build source snippets to
 * feed the parsers) is not mistaken for a real import of this file's.
 */
export function importSpecifiers(source: string): string[] {
	const patterns = [
		/^[ \t]*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/gm,
		/^[ \t]*import\s*["']([^"']+)["']/gm,
		/\bimport\(\s*["']([^"']+)["']/g,
		/\bvi\.(?:mock|doMock|unmock|doUnmock)\(\s*["']([^"']+)["']/g,
	];
	const found: string[] = [];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			if (match[1]) found.push(match[1]);
		}
	}
	return found;
}

/** Every `.ts` file under `tests/`, minus the fixture trees vitest excludes. */
export function testSourceFiles(dir = path.join(repoRoot, "tests")): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(dir, entry.name);
		const relative = toPosix(path.relative(repoRoot, entryPath));
		// Mirrors vitest.config.ts's sharedExclude: fixture projects and the
		// live suite's copied-out temp projects are inputs, not repo tests.
		if (
			relative === "tests/fixtures" ||
			relative.startsWith("tests/native-ts7-live-")
		) {
			return [];
		}
		if (entry.isDirectory()) return testSourceFiles(entryPath);
		return /\.(?:ts|mts)$/.test(entry.name) ? [entryPath] : [];
	});
}

/** Scan `tests/` for imports of build-compiled modules through `.ts`. */
export function scanDualInstanceImports(): DualInstanceImport[] {
	const excluded = uncompiledRoots();
	const found: DualInstanceImport[] = [];
	for (const absolute of testSourceFiles()) {
		const file = toPosix(path.relative(repoRoot, absolute));
		const source = fs.readFileSync(absolute, "utf8");
		for (const specifier of importSpecifiers(source)) {
			if (!specifier.startsWith(".")) continue;
			const target = toPosix(
				path.relative(
					repoRoot,
					path.resolve(path.dirname(absolute), specifier),
				),
			);
			if (!isBuildCompiled(target, excluded)) continue;
			found.push({ file, specifier, target });
		}
	}
	return found;
}

/** Stable identity for allowlisting one reviewed import. */
export function importKey(entry: { file: string; target: string }): string {
	return `${entry.file} -> ${entry.target}`;
}

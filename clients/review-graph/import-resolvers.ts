/**
 * Internal-import resolution-to-file for tree-sitter languages (#249 follow-up).
 *
 * The review graph extracts import SOURCES per language (IMPORT_QUERIES), but a
 * raw source string ("os.path", "./foo", "github.com/me/p/pkg") isn't a graph
 * edge until it's resolved to an in-project FILE. jsts (localImportToFile) and
 * cxx (#include) already do this; these resolvers extend it to the tree-sitter
 * languages where an import maps cleanly to a file:
 *
 *   - relative file paths   : ruby (require_relative), zig (@import), bash
 *                             (source/.), dart (relative `import`)
 *   - package/module roots  : python (dotted → package file), java (package →
 *                             source-root file), go (import path → package DIR's
 *                             .go files)
 *
 * Languages whose imports are NOT a 1:1 file concept (rust mod-system,
 * c#/swift namespaces, kotlin/elixir multi-symbol files) are intentionally not
 * resolved — they stay honest `external:` nodes rather than misleading edges.
 *
 * Every resolver is pure + existence-checked + confined to `cwd`: an
 * unresolvable source returns `[]` and the caller keeps the unresolved node, so
 * a wrong guess can never fabricate an edge to a file that isn't there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeMapKey } from "../path-utils.js";
import { buildModuleGraph, type WorkspaceModule } from "./workspace-modules.js";

/** True when `p` is inside (or equal to) `cwd` — blocks resolution escaping the workspace. */
function isWithin(cwd: string, p: string): boolean {
	const root = path.resolve(cwd);
	const rp = path.resolve(p);
	return rp === root || rp.startsWith(root + path.sep);
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** First candidate that exists as a file within cwd, normalized — or []. */
function firstExistingFile(cwd: string, candidates: string[]): string[] {
	for (const c of candidates) {
		if (isWithin(cwd, c) && isFile(c)) return [normalizeMapKey(c)];
	}
	return [];
}

/** All `ext` files directly in `dir` (non-recursive), normalized — or []. */
function sourceFilesIn(cwd: string, dir: string, ext: string): string[] {
	if (!isWithin(cwd, dir) || !isDir(dir)) return [];
	try {
		return fs
			.readdirSync(dir)
			.filter((n) => n.endsWith(ext))
			.map((n) => normalizeMapKey(path.join(dir, n)))
			.sort();
	} catch {
		return [];
	}
}

/** Resolve a path-ish source relative to the importing file's directory. */
function resolveRelative(
	cwd: string,
	filePath: string,
	source: string,
	exts: string[],
): string[] {
	const base = path.resolve(path.dirname(filePath), source);
	return firstExistingFile(cwd, [base, ...exts.map((e) => base + e)]);
}

function resolveDart(cwd: string, filePath: string, source: string): string[] {
	// package: / dart: imports are SDK/pub deps, not project files.
	if (source.startsWith("package:") || source.startsWith("dart:")) return [];
	return resolveRelative(cwd, filePath, source, [".dart"]);
}

// --- JS/TS -------------------------------------------------------------------

// TS-as-ESM sources commonly write `import { x } from "./service.js"` while
// the real file on disk is `service.ts` (Node's ESM resolver requires the
// RUNTIME extension in the specifier, which is `.js` even for a `.ts` source —
// this repo's own `clients/**/*.ts` does this throughout). Stripping a known
// JS/TS extension from the specifier before re-appending candidate extensions
// lets that universal pattern resolve to the real source file. Exported so
// builder.ts's warm `localImportToFile` shares the exact same regex (#694).
export const JS_TS_EXT_RE = /\.(mjs|cjs|jsx?|tsx?)$/i;

/**
 * Ordered candidate list for resolving a relative JS/TS import specifier
 * (already resolved to an absolute base path) to an on-disk file, with
 * SOURCE-TWIN PREFERENCE (#694): on a repo that compiles in place, `./foo.js`
 * commonly has BOTH the written `foo.js` (compiled artifact) and a `foo.ts`
 * source sitting next to it. Trying the `.ts`/`.tsx` (or `.mts`/`.cts` for an
 * `.mjs`/`.cjs` specifier) twin BEFORE the literal/compiled extension means
 * the edge lands on the file developers actually edit; the compiled artifact
 * is only used when no source twin exists on disk (pure-JS projects, vendored
 * `.js`, or a genuinely JS-only import). Every candidate is still
 * existence-checked by the caller — a wrong guess can never fabricate an edge
 * to a file that isn't there, it just tries the next candidate.
 *
 * Shared between the cold module_report path ({@link resolveJsTs} below) and
 * the warm review-graph builder's `localImportToFile` (builder.ts) so the two
 * resolution paths can never diverge on which twin wins (#694 — a divergent
 * second mapping was exactly the kind of thing to avoid).
 */
/**
 * Shared tail of {@link jsTsCandidatePaths} and the workspace-package subpath
 * resolver below (#775) — both need "given a base path (already stripped of
 * any known JS/TS extension) and the original extension (if any), produce the
 * source-twin-preferring candidate list." Only how `base`/`strippedBase` are
 * computed differs (relative-to-importing-file vs. relative-to-package-root).
 */
function jsTsExtensionCandidates(
	base: string,
	strippedBase: string,
	ext: string,
): string[] {
	const candidates: string[] = [];
	if (ext === ".mjs") candidates.push(`${strippedBase}.mts`);
	if (ext === ".cjs") candidates.push(`${strippedBase}.cts`);
	candidates.push(`${strippedBase}.ts`, `${strippedBase}.tsx`);
	// The literal specifier path (covers both "no extension in the specifier"
	// — base === strippedBase — and the compiled/as-written extension itself).
	candidates.push(base);
	candidates.push(`${strippedBase}.js`, `${strippedBase}.jsx`);
	candidates.push(
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
		path.join(base, "index.js"),
		path.join(base, "index.jsx"),
	);
	return candidates;
}

export function jsTsCandidatePaths(filePath: string, source: string): string[] {
	const base = path.resolve(path.dirname(filePath), source);
	const strippedSource = source.replace(JS_TS_EXT_RE, "");
	const strippedBase =
		strippedSource === source
			? base
			: path.resolve(path.dirname(filePath), strippedSource);
	const ext = path.extname(source).toLowerCase();
	return jsTsExtensionCandidates(base, strippedBase, ext);
}

/**
 * Longest-name match of a bare specifier against known workspace package
 * names, handling `@scope/pkg/subpath` imports (subpath is everything after
 * the matched name + "/"). "Longest" only matters for the theoretical case of
 * two workspace packages whose names are string-prefixes of one another
 * (`@scope/pkg` vs `@scope/pkg-two`) — the required "/" boundary already
 * makes that case unambiguous, but longest-match is kept as a defensive tie
 * breaker rather than relying on Map iteration order.
 */
function findWorkspaceModuleForSpecifier(
	modules: Iterable<WorkspaceModule>,
	source: string,
): { mod: WorkspaceModule; subpath: string } | undefined {
	let best: { mod: WorkspaceModule; subpath: string } | undefined;
	for (const mod of modules) {
		let subpath: string | undefined;
		if (source === mod.name) subpath = "";
		else if (source.startsWith(`${mod.name}/`))
			subpath = source.slice(mod.name.length + 1);
		if (subpath === undefined) continue;
		if (!best || mod.name.length > best.mod.name.length) best = { mod, subpath };
	}
	return best;
}

/** First string found among `exports`'s "." condition (or the field itself if
 * it's a bare string) — covers the common `"exports": "./index.js"` and
 * `"exports": {".": {"import": "./index.js", ...}}` shapes. Anything more
 * exotic (subpath patterns, condition arrays) falls through to the
 * index.ts/js fallback below rather than guessing. */
function pickExportsMain(exportsField: unknown): string | undefined {
	if (typeof exportsField === "string") return exportsField;
	if (!exportsField || typeof exportsField !== "object") return undefined;
	const obj = exportsField as Record<string, unknown>;
	const dot = obj["."] ?? obj;
	if (typeof dot === "string") return dot;
	if (dot && typeof dot === "object") {
		for (const key of ["import", "require", "default"]) {
			const v = (dot as Record<string, unknown>)[key];
			if (typeof v === "string") return v;
		}
	}
	return undefined;
}

/** Candidate entry-file paths for a workspace package root: package.json's
 * `main`/`module`/`exports`-main first, then the conventional index files. */
function workspaceEntryCandidates(pkgRoot: string): string[] {
	let main: string | undefined;
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8"),
		) as { main?: string; module?: string; exports?: unknown };
		main = pickExportsMain(pkg.exports) ?? pkg.module ?? pkg.main;
	} catch {
		// missing/unreadable package.json — fall through to index candidates
	}
	const candidates: string[] = [];
	if (main) candidates.push(path.resolve(pkgRoot, main));
	candidates.push(
		path.join(pkgRoot, "index.ts"),
		path.join(pkgRoot, "index.tsx"),
		path.join(pkgRoot, "index.js"),
		path.join(pkgRoot, "src", "index.ts"),
		path.join(pkgRoot, "src", "index.js"),
	);
	return candidates;
}

/** Candidate paths for a workspace-package SUBPATH import (`@scope/pkg/foo`)
 * — same source-twin-preferring extension probe as a relative import, rooted
 * at the package dir instead of the importing file's dir. */
function workspaceSubpathCandidates(pkgRoot: string, subpath: string): string[] {
	const base = path.join(pkgRoot, subpath);
	const strippedSubpath = subpath.replace(JS_TS_EXT_RE, "");
	const strippedBase =
		strippedSubpath === subpath ? base : path.join(pkgRoot, strippedSubpath);
	const ext = path.extname(subpath).toLowerCase();
	return jsTsExtensionCandidates(base, strippedBase, ext);
}

/**
 * Resolve a bare specifier that names a sibling workspace package (npm/pnpm
 * workspaces, cargo, go.work — detected by `workspace-modules.ts`) to that
 * package's entry file, or a file within it for a subpath import (#775). A
 * specifier that doesn't match any known workspace package name returns []
 * — an ordinary third-party dependency stays `external:`, unchanged.
 *
 * `buildModuleGraph` memoizes the workspace scan per cwd, so this costs a
 * real filesystem scan only once per graph build (first bare specifier hit),
 * not once per import edge.
 */
export function resolveWorkspacePackageImport(
	cwd: string,
	source: string,
): string[] {
	if (source.startsWith(".")) return [];
	const graph = buildModuleGraph(cwd);
	if (!graph) return [];
	const match = findWorkspaceModuleForSpecifier(graph.modules.values(), source);
	if (!match) return [];
	const candidates = match.subpath
		? workspaceSubpathCandidates(match.mod.root, match.subpath)
		: workspaceEntryCandidates(match.mod.root);
	return firstExistingFile(cwd, candidates);
}

/**
 * Resolve a relative ESM import (`./x`, `../y`) to an in-project file — see
 * {@link jsTsCandidatePaths} for the source-twin-preferring candidate order.
 * A bare specifier (`react`, `@scope/pkg`) is resolved against known
 * workspace package names (#775 — see {@link resolveWorkspacePackageImport});
 * anything that isn't a recognized workspace package stays an external dep,
 * returning []. Used only on the COLD module_report path: the warm jsts
 * builder resolves imports via `localImportToFile` (builder.ts), which shares
 * both candidate lists.
 */
function resolveJsTs(cwd: string, filePath: string, source: string): string[] {
	if (!source.startsWith(".")) return resolveWorkspacePackageImport(cwd, source);
	return firstExistingFile(cwd, jsTsCandidatePaths(filePath, source));
}

// --- C / C++ -----------------------------------------------------------------

/**
 * Resolve a C/C++ `#include` to an in-project header (#302). A system header
 * (`<stdio.h>`, captured with its angle brackets) is a toolchain/library dep →
 * external, so it returns []. A quoted local include (`#include "foo.h"` →
 * `foo.h` after quote-strip) resolves against the same candidate roots the warm
 * graph's `resolveCxxInclude` uses (the including file's dir, then cwd / include /
 * src), so cold and warm agree on which file a local include points to.
 */
function resolveCxx(cwd: string, filePath: string, source: string): string[] {
	if (source.startsWith("<")) return [];
	const dir = path.dirname(path.resolve(filePath));
	return firstExistingFile(cwd, [
		path.resolve(dir, source),
		path.resolve(cwd, source),
		path.resolve(cwd, "include", source),
		path.resolve(cwd, "src", source),
	]);
}

// --- Python -----------------------------------------------------------------

/** Candidate source roots for an absolute dotted import. */
function pythonRoots(cwd: string, fileDir: string): string[] {
	// The package root is the first ancestor of the importing file that is NOT
	// itself a package (no __init__.py) — that's where a top-level `import a.b`
	// is anchored. Add cwd and cwd/src as conventional fallbacks.
	let p = fileDir;
	const root = path.resolve(cwd);
	while (isWithin(cwd, p) && isFile(path.join(p, "__init__.py"))) {
		const parent = path.dirname(p);
		if (parent === p) break;
		p = parent;
	}
	const roots = new Set([p, root, path.join(root, "src")]);
	return [...roots].filter((r) => isDir(r));
}

function resolvePython(
	cwd: string,
	filePath: string,
	source: string,
): string[] {
	const fileDir = path.dirname(path.resolve(filePath));
	if (source.startsWith(".")) {
		// Relative import: leading dots = how far up, remainder = dotted subpath.
		const m = source.match(/^(\.+)(.*)$/);
		if (!m) return [];
		const dots = m[1].length;
		let baseDir = fileDir;
		for (let i = 1; i < dots; i++) baseDir = path.dirname(baseDir);
		const rest = m[2] ? m[2].split(".") : [];
		const target = path.join(baseDir, ...rest);
		return firstExistingFile(cwd, [
			`${target}.py`,
			path.join(target, "__init__.py"),
		]);
	}
	const parts = source.split(".");
	for (const root of pythonRoots(cwd, fileDir)) {
		const target = path.join(root, ...parts);
		const found = firstExistingFile(cwd, [
			`${target}.py`,
			path.join(target, "__init__.py"),
		]);
		if (found.length) return found;
	}
	return [];
}

// --- Go ---------------------------------------------------------------------

/** Walk up from the importing file to a go.mod and read its `module` path. */
function findGoModule(
	cwd: string,
	filePath: string,
): { moduleDir: string; modulePath: string } | null {
	let dir = path.dirname(path.resolve(filePath));
	const root = path.resolve(cwd);
	while (true) {
		try {
			const content = fs.readFileSync(path.join(dir, "go.mod"), "utf-8");
			const m = content.match(/^\s*module\s+(\S+)/m);
			if (m) return { moduleDir: dir, modulePath: m[1] };
		} catch {
			// no go.mod here — keep climbing
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir || !isWithin(cwd, parent)) break;
		dir = parent;
	}
	return null;
}

function resolveGo(cwd: string, filePath: string, source: string): string[] {
	const mod = findGoModule(cwd, filePath);
	if (!mod) return [];
	// Only same-module import paths map to a local package directory; stdlib and
	// third-party paths (no module prefix) stay external.
	if (source !== mod.modulePath && !source.startsWith(`${mod.modulePath}/`)) {
		return [];
	}
	const rel =
		source === mod.modulePath ? "" : source.slice(mod.modulePath.length + 1);
	// A Go package is a directory; edge to every .go file in it (who-imports
	// works at file granularity). Exclude nothing — _test.go files import too.
	return sourceFilesIn(cwd, path.join(mod.moduleDir, rel), ".go");
}

// --- Java -------------------------------------------------------------------

function javaSourceRoots(cwd: string, filePath: string): string[] {
	const root = path.resolve(cwd);
	const roots = new Set<string>();
	for (const c of ["src/main/java", "src/test/java", "src", ""]) {
		roots.add(path.join(root, c));
	}
	// The importing file's own source root is one of its ancestors, so a
	// same-project import resolves even on a non-conventional layout.
	let p = path.dirname(path.resolve(filePath));
	while (true) {
		roots.add(p);
		if (p === root) break;
		const parent = path.dirname(p);
		if (parent === p || !isWithin(cwd, parent)) break;
		p = parent;
	}
	return [...roots].filter((r) => isDir(r));
}

function resolveJava(cwd: string, filePath: string, source: string): string[] {
	const parts = source.split(".");
	for (const root of javaSourceRoots(cwd, filePath)) {
		// import a.b.Foo  → a/b/Foo.java
		const asFile = firstExistingFile(cwd, [
			`${path.join(root, ...parts)}.java`,
		]);
		if (asFile.length) return asFile;
		// import a.b.*  (captured as a.b) → every .java in the package dir
		const asPkg = sourceFilesIn(cwd, path.join(root, ...parts), ".java");
		if (asPkg.length) return asPkg;
		// static import a.b.Foo.bar → drop the member, resolve the class file
		if (parts.length > 1) {
			const dropLast = firstExistingFile(cwd, [
				`${path.join(root, ...parts.slice(0, -1))}.java`,
			]);
			if (dropLast.length) return dropLast;
		}
	}
	return [];
}

/**
 * Resolve a single tree-sitter import source to in-project file(s). Returns
 * normalized paths (possibly several — a Go/Java package is a directory) or `[]`
 * when the source isn't a resolvable in-project file (keep it as external).
 */
export function resolveImportToFiles(
	cwd: string,
	filePath: string,
	languageId: string,
	source: string,
): string[] {
	switch (languageId) {
		case "typescript":
		case "tsx":
		case "javascript":
		case "jsts":
			return resolveJsTs(cwd, filePath, source);
		case "c":
		case "cpp":
			return resolveCxx(cwd, filePath, source);
		case "ruby":
			return resolveRelative(cwd, filePath, source, [".rb"]);
		case "zig":
			return resolveRelative(cwd, filePath, source, [".zig"]);
		case "bash":
			return resolveRelative(cwd, filePath, source, [".sh", ".bash"]);
		case "dart":
			return resolveDart(cwd, filePath, source);
		case "python":
			return resolvePython(cwd, filePath, source);
		case "go":
			return resolveGo(cwd, filePath, source);
		case "java":
			return resolveJava(cwd, filePath, source);
		default:
			return [];
	}
}

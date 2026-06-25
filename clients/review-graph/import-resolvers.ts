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

/**
 * Resolve a relative ESM import (`./x`, `../y`) to an in-project file, trying the
 * ts/tsx/js/jsx extensions and the `index.*` directory form. Mirrors the warm
 * graph's `localImportToFile` (builder.ts) — duplicated rather than imported to
 * avoid a builder→resolvers cycle. Bare specifiers (`react`, `@scope/pkg`) are
 * package deps → external, so they return []. Used only on the COLD module_report
 * path: the warm jsts builder resolves imports via the TS compiler and never
 * reaches this resolver.
 */
function resolveJsTs(cwd: string, filePath: string, source: string): string[] {
	if (!source.startsWith(".")) return [];
	const base = path.resolve(path.dirname(filePath), source);
	return firstExistingFile(cwd, [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.jsx`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
		path.join(base, "index.js"),
		path.join(base, "index.jsx"),
	]);
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

/**
 * Track B (#775) — reusable npm-workspaces monorepo fixture builder.
 *
 * Builds a small, disposable temp directory shaped like a real npm-workspaces
 * monorepo: a root `package.json` with a `workspaces` glob, N packages each
 * with their own `package.json` (name/main/deps) and source files, and
 * optional nested `.gitignore`/`.pi-lens.json` layering. Kept deliberately
 * tiny — size-cliff tests hit exact budget boundaries via small option/env
 * overrides (see `size-cliff.test.ts`, `scale-knob.test.ts`) rather than by
 * padding this fixture with thousands of real files. `padFiles` exists for
 * the rare case a test needs to cross a *count* threshold with genuinely
 * distinct files (e.g. a directory-entry budget) — keep its `count` small.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { setupTestEnvironment } from "../clients/test-utils.js";

export interface MonorepoPackageSpec {
	/** Workspace package name, e.g. "@scope/a". */
	name: string;
	/** Directory relative to the monorepo root, e.g. "packages/a". */
	dir: string;
	/** package.json#main (defaults to no explicit main -> src/index.ts/js probing). */
	main?: string;
	/** Workspace or external dependency names to record in package.json#dependencies. */
	deps?: string[];
	/** relative-to-package-dir path -> file content. */
	files: Record<string, string>;
	/** Package-local .gitignore patterns (one per line). */
	gitignore?: string[];
	/** Package-local .pi-lens.json (raw object, serialized as JSON). */
	piLensConfig?: Record<string, unknown>;
}

export interface MonorepoPadFilesSpec {
	/** Directory (relative to root) to pad with tiny throwaway files. */
	dir: string;
	/** How many files to create. */
	count: number;
	/** File extension (with dot), default ".ts". */
	extension?: string;
	/** Basename prefix, default "pad". */
	prefix?: string;
	/** File content, default a trivial export statement. */
	content?: string;
}

export interface MonorepoSpec {
	/** Workspace glob patterns for the root package.json#workspaces (default ["packages/*"]). */
	workspaceGlobs?: string[];
	packages: MonorepoPackageSpec[];
	/** Root-level .gitignore patterns. */
	rootGitignore?: string[];
	/** Root-level .pi-lens.json (raw object). */
	rootPiLensConfig?: Record<string, unknown>;
	/** Extra root-relative files (path -> content), e.g. a root README. */
	extraRootFiles?: Record<string, string>;
	/** Optional file-count padding to hit exact budget boundaries deterministically. */
	padFiles?: MonorepoPadFilesSpec;
	/** Temp-dir prefix passed through to setupTestEnvironment. */
	tmpPrefix?: string;
}

export interface Monorepo {
	root: string;
	/** Absolute path of a package's directory by workspace name. */
	packageDir(name: string): string;
	/** Absolute path of a file within a package, given its relative-to-package path. */
	filePath(pkgName: string, relPath: string): string;
	/** Absolute path of a root-relative file. */
	rootFilePath(relPath: string): string;
	cleanup(): void;
}

function writeFile(root: string, relPath: string, content: string): string {
	const full = path.join(root, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
	return full;
}

/**
 * Build a temp npm-workspaces monorepo fixture on disk. Caller MUST call
 * `.cleanup()` (mirrors `setupTestEnvironment`'s contract).
 */
export function makeMonorepo(spec: MonorepoSpec): Monorepo {
	const env = setupTestEnvironment(spec.tmpPrefix ?? "pi-lens-monorepo-");
	const root = env.tmpDir;
	const workspaceGlobs = spec.workspaceGlobs ?? ["packages/*"];

	// Root package.json
	writeFile(
		root,
		"package.json",
		JSON.stringify(
			{ name: "monorepo-root", private: true, workspaces: workspaceGlobs },
			null,
			2,
		),
	);

	// A `.git` marker so root-resolution treats this as a real project root
	// (findNearestProjectRoot / PROJECT_ROOT_MARKERS), matching a real checkout.
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });

	if (spec.rootGitignore) {
		writeFile(root, ".gitignore", spec.rootGitignore.join("\n") + "\n");
	}
	if (spec.rootPiLensConfig) {
		writeFile(
			root,
			".pi-lens.json",
			JSON.stringify(spec.rootPiLensConfig, null, 2),
		);
	}
	for (const [relPath, content] of Object.entries(spec.extraRootFiles ?? {})) {
		writeFile(root, relPath, content);
	}

	const packageDirs = new Map<string, string>();
	for (const pkg of spec.packages) {
		const pkgRoot = path.join(root, pkg.dir);
		packageDirs.set(pkg.name, pkgRoot);

		const dependencies: Record<string, string> = {};
		for (const dep of pkg.deps ?? []) dependencies[dep] = "*";

		const pkgJson: Record<string, unknown> = {
			name: pkg.name,
			version: "0.0.0",
			...(pkg.main ? { main: pkg.main } : {}),
			...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
		};
		writeFile(
			root,
			path.join(pkg.dir, "package.json"),
			JSON.stringify(pkgJson, null, 2),
		);

		if (pkg.gitignore) {
			writeFile(
				root,
				path.join(pkg.dir, ".gitignore"),
				pkg.gitignore.join("\n") + "\n",
			);
		}
		if (pkg.piLensConfig) {
			writeFile(
				root,
				path.join(pkg.dir, ".pi-lens.json"),
				JSON.stringify(pkg.piLensConfig, null, 2),
			);
		}
		for (const [relPath, content] of Object.entries(pkg.files)) {
			writeFile(root, path.join(pkg.dir, relPath), content);
		}
	}

	if (spec.padFiles) {
		const { dir, count, extension = ".ts", prefix = "pad", content } =
			spec.padFiles;
		for (let i = 0; i < count; i++) {
			writeFile(
				root,
				path.join(dir, `${prefix}${i}${extension}`),
				content ?? `export const ${prefix}${i} = ${i};\n`,
			);
		}
	}

	return {
		root,
		packageDir(name: string): string {
			const dir = packageDirs.get(name);
			if (!dir) throw new Error(`makeMonorepo: unknown package "${name}"`);
			return dir;
		},
		filePath(pkgName: string, relPath: string): string {
			return path.join(this.packageDir(pkgName), relPath);
		},
		rootFilePath(relPath: string): string {
			return path.join(root, relPath);
		},
		cleanup: env.cleanup,
	};
}

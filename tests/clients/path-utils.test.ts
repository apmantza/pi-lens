import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	findLocalToolConfig,
	findNearestContaining,
	findNearestMarkerRoot,
	isAtOrAboveHomeDir,
	isExternalOrVendorFile,
	normalizeEphemeralMapKey,
	pathToUri,
	uriToPath,
	walkUpDirs,
} from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("path-utils", () => {
	it("uriToPath decodes URL-encoded file URIs", () => {
		const uri = "file:///C:/Users/Test%20User/project/file.ts";
		const resolved = uriToPath(uri);

		expect(resolved.includes("%20")).toBe(false);
		expect(resolved.toLowerCase()).toContain("test user");
	});

	it("pathToUri + uriToPath round-trips an existing file", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-path-");
		try {
			const filePath = path.join(tmpDir, "src", "main.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const uri = pathToUri(filePath);
			const back = uriToPath(uri);

			expect(back.endsWith("/src/main.ts")).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("normalizeEphemeralMapKey (refs #191)", () => {
	it("folds backslash and forward-slash forms to the same key", () => {
		const forward = "C:/Users/foo/src/plan.js";
		const back = "C:\\Users\\foo\\src\\plan.js";

		expect(normalizeEphemeralMapKey(forward)).toBe(
			normalizeEphemeralMapKey(back),
		);
	});

	it("does not touch the filesystem (never throws for a nonexistent path, no realpath resolution)", () => {
		const nonExistent = "C:\\definitely\\not\\a\\real\\path\\file.ts";
		expect(() => normalizeEphemeralMapKey(nonExistent)).not.toThrow();
		// Purely syntactic: slash-folded (+ lowercased on win32), not
		// realpath-resolved, so it must not depend on the path existing.
		expect(normalizeEphemeralMapKey(nonExistent)).toContain(
			"/definitely/not/a/real/path/file.ts",
		);
	});

	it("is case-insensitive on win32 semantics (matches this suite's Windows CI target)", () => {
		if (process.platform !== "win32") return;
		expect(normalizeEphemeralMapKey("C:\\Foo\\BAR.TS")).toBe(
			normalizeEphemeralMapKey("c:\\foo\\bar.ts"),
		);
	});
});

describe("walkUpDirs / findNearestContaining (#122)", () => {
	it("walkUpDirs yields every directory from startDir up to the filesystem root and stops", () => {
		const env = setupTestEnvironment("pi-lens-walkup-");
		try {
			const startDir = path.join(env.tmpDir, "a", "b", "c");
			fs.mkdirSync(startDir, { recursive: true });

			const visited = [...walkUpDirs(startDir)];
			expect(visited[0]).toBe(path.resolve(startDir));
			// Must include the chain a/b, a, and the tmp root.
			expect(visited).toContain(path.resolve(env.tmpDir, "a", "b"));
			expect(visited).toContain(path.resolve(env.tmpDir, "a"));
			expect(visited).toContain(path.resolve(env.tmpDir));
			// Last entry must be the filesystem root (no further dirname change).
			const last = visited[visited.length - 1];
			expect(path.dirname(last)).toBe(last);
		} finally {
			env.cleanup();
		}
	});

	it("findNearestContaining returns the nearest containing directory, not a higher one", () => {
		const env = setupTestEnvironment("pi-lens-find-nearest-");
		try {
			const inner = path.join(env.tmpDir, "outer", "inner");
			fs.mkdirSync(inner, { recursive: true });
			// Put a marker at BOTH levels. Nearest wins.
			fs.writeFileSync(path.join(env.tmpDir, "outer", "package.json"), "{}");
			fs.writeFileSync(path.join(env.tmpDir, "outer", "inner", "package.json"), "{}");

			const startDir = path.join(inner, "src");
			fs.mkdirSync(startDir, { recursive: true });
			const found = findNearestContaining(startDir, ["package.json"]);
			expect(found && path.resolve(found)).toBe(path.resolve(inner));
		} finally {
			env.cleanup();
		}
	});

	it("findNearestContaining matches the first candidate filename that exists", () => {
		const env = setupTestEnvironment("pi-lens-find-multi-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, "Cargo.toml"), "[package]");
			const startDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(startDir, { recursive: true });
			const found = findNearestContaining(startDir, [
				"package.json",
				"Cargo.toml",
				"go.mod",
			]);
			expect(found && path.resolve(found)).toBe(path.resolve(env.tmpDir));
		} finally {
			env.cleanup();
		}
	});

	it("findNearestContaining returns undefined when no candidate is found anywhere", () => {
		const env = setupTestEnvironment("pi-lens-find-none-");
		try {
			const startDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(startDir, { recursive: true });
			// No marker file anywhere under env.tmpDir, and the walk terminates
			// at the filesystem root where the candidate also doesn't exist.
			const found = findNearestContaining(startDir, [
				"this-marker-name-will-not-collide-with-anything-XYZZY-pi-lens",
			]);
			expect(found).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

describe("findLocalToolConfig (refs #680)", () => {
	it("returns the matched FILE path, not just the containing directory", () => {
		const env = setupTestEnvironment("pi-lens-find-tool-config-");
		try {
			const startDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(startDir, { recursive: true });
			fs.writeFileSync(path.join(env.tmpDir, "typos.toml"), "");

			const found = findLocalToolConfig(startDir, [
				"typos.toml",
				"_typos.toml",
				".typos.toml",
			]);
			expect(found && path.resolve(found)).toBe(
				path.resolve(env.tmpDir, "typos.toml"),
			);
		} finally {
			env.cleanup();
		}
	});

	it("prefers the nearest directory over a match higher up the tree", () => {
		const env = setupTestEnvironment("pi-lens-find-tool-config-nearest-");
		try {
			const inner = path.join(env.tmpDir, "outer", "inner");
			fs.mkdirSync(inner, { recursive: true });
			fs.writeFileSync(path.join(env.tmpDir, "outer", "sgconfig.yml"), "");
			fs.writeFileSync(path.join(inner, "sgconfig.yml"), "");

			const startDir = path.join(inner, "src");
			fs.mkdirSync(startDir, { recursive: true });
			const found = findLocalToolConfig(startDir, [
				"sgconfig.yml",
				"sgconfig.yaml",
			]);
			expect(found && path.resolve(found)).toBe(
				path.resolve(inner, "sgconfig.yml"),
			);
		} finally {
			env.cleanup();
		}
	});

	it("within a single directory, matches candidate names in list order", () => {
		const env = setupTestEnvironment("pi-lens-find-tool-config-order-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, "zizmor.yaml"), "");
			fs.writeFileSync(path.join(env.tmpDir, "zizmor.yml"), "");
			const startDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(startDir, { recursive: true });

			const found = findLocalToolConfig(startDir, [
				"zizmor.yml",
				"zizmor.yaml",
			]);
			expect(found && path.resolve(found)).toBe(
				path.resolve(env.tmpDir, "zizmor.yml"),
			);
		} finally {
			env.cleanup();
		}
	});

	it("returns undefined when no candidate name is found anywhere up the tree", () => {
		const env = setupTestEnvironment("pi-lens-find-tool-config-none-");
		try {
			const startDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(startDir, { recursive: true });
			const found = findLocalToolConfig(startDir, [
				"this-config-name-will-not-collide-XYZZY-pi-lens.toml",
			]);
			expect(found).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("falls back to process.cwd() when startDir is empty, matching prior per-tool behavior", () => {
		const found = findLocalToolConfig("", [
			"this-config-name-will-not-collide-XYZZY-pi-lens.toml",
		]);
		expect(found).toBeUndefined();
	});
});

describe("findNearestMarkerRoot (refs #625)", () => {
	it("resolves the nearest directory containing a marker", () => {
		const env = setupTestEnvironment("pi-lens-marker-root-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, "package.json"), "{}");
			const nested = path.join(env.tmpDir, "src", "pkg");
			fs.mkdirSync(nested, { recursive: true });

			expect(findNearestMarkerRoot(nested, ["package.json"])).toBe(
				path.resolve(env.tmpDir),
			);
		} finally {
			env.cleanup();
		}
	});

	it("never resolves at or above the given home dir", () => {
		const env = setupTestEnvironment("pi-lens-marker-root-home-");
		try {
			const ancestor = path.join(env.tmpDir, "ancestor");
			const home = path.join(ancestor, "home");
			const nested = path.join(home, "empty-folder");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(ancestor, "package.json"), "{}");

			expect(
				findNearestMarkerRoot(nested, ["package.json"], { homeDir: home }),
			).toBeNull();
			// The home dir itself is also at-or-above home.
			fs.writeFileSync(path.join(home, "package.json"), "{}");
			expect(
				findNearestMarkerRoot(home, ["package.json"], { homeDir: home }),
			).toBeNull();
		} finally {
			env.cleanup();
		}
	});

	it("stops at a boundary marker found before any project marker", () => {
		const env = setupTestEnvironment("pi-lens-marker-root-boundary-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, "package.json"), "{}");
			const repoRoot = path.join(env.tmpDir, "sub-repo");
			const nested = path.join(repoRoot, "src");
			fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
			fs.mkdirSync(nested, { recursive: true });

			expect(
				findNearestMarkerRoot(nested, ["package.json"], {
					boundaries: [".git", ".hg", ".svn"],
				}),
			).toBeNull();
		} finally {
			env.cleanup();
		}
	});

	it("does not stop at a boundary that coincides with the marker directory itself", () => {
		const env = setupTestEnvironment("pi-lens-marker-root-boundary-same-");
		try {
			const repoRoot = path.join(env.tmpDir, "repo");
			const nested = path.join(repoRoot, "src");
			fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
			fs.writeFileSync(path.join(repoRoot, "package.json"), "{}");
			fs.mkdirSync(nested, { recursive: true });

			// Marker check happens before the boundary check at each directory, so
			// a marker co-located with the boundary still resolves.
			expect(
				findNearestMarkerRoot(nested, ["package.json"], {
					boundaries: [".git"],
				}),
			).toBe(path.resolve(repoRoot));
		} finally {
			env.cleanup();
		}
	});

	it("returns null (never startDir) when nothing matches up to the filesystem root", () => {
		const env = setupTestEnvironment("pi-lens-marker-root-none-");
		try {
			const nested = path.join(env.tmpDir, "deep", "nowhere");
			fs.mkdirSync(nested, { recursive: true });

			const found = findNearestMarkerRoot(nested, [
				"this-marker-will-not-collide-XYZZY-pi-lens",
			]);
			expect(found).not.toBe(nested);
		} finally {
			env.cleanup();
		}
	});
});

describe("isAtOrAboveHomeDir (#253)", () => {
	// Use a synthetic home so the assertions are platform-stable.
	const home = path.resolve(path.join("tmp-home", "user"));

	it("treats the home directory itself as at-or-above home", () => {
		expect(isAtOrAboveHomeDir(home, home)).toBe(true);
	});

	it("treats an ancestor of home as at-or-above home (the #253 escape)", () => {
		const ancestor = path.dirname(home); // …/tmp-home
		const grandAncestor = path.dirname(ancestor);
		expect(isAtOrAboveHomeDir(ancestor, home)).toBe(true);
		expect(isAtOrAboveHomeDir(grandAncestor, home)).toBe(true);
	});

	it("treats the filesystem root as at-or-above home", () => {
		const { root } = path.parse(home);
		expect(isAtOrAboveHomeDir(root, home)).toBe(true);
	});

	it("treats a project UNDER home as not at-or-above home", () => {
		expect(isAtOrAboveHomeDir(path.join(home, "code", "app"), home)).toBe(
			false,
		);
		expect(isAtOrAboveHomeDir(path.join(home, "proj"), home)).toBe(false);
	});

	it("treats a sibling/unrelated tree as not at-or-above home", () => {
		const sibling = path.join(path.dirname(home), "someone-else", "proj");
		expect(isAtOrAboveHomeDir(sibling, home)).toBe(false);
	});

	it("normalizes unresolved paths before comparing", () => {
		expect(isAtOrAboveHomeDir(path.join(home, "x", ".."), home)).toBe(true);
		expect(isAtOrAboveHomeDir(path.join(home, "a", "..", "b"), home)).toBe(
			false,
		);
	});
});

describe("isExternalOrVendorFile", () => {
	const root = "/home/user/project";

	it("returns false for a normal source file", () => {
		expect(isExternalOrVendorFile(`${root}/src/main.ts`, root)).toBe(false);
	});

	it("returns true for a file outside the project root", () => {
		expect(isExternalOrVendorFile("/home/user/other-project/foo.ts", root)).toBe(true);
	});

	it("returns true for node_modules", () => {
		expect(isExternalOrVendorFile(`${root}/node_modules/lodash/index.js`, root)).toBe(true);
	});

	it("returns true for vendor/", () => {
		expect(isExternalOrVendorFile(`${root}/vendor/dep/file.go`, root)).toBe(true);
	});

	it("returns true for vendors/", () => {
		expect(isExternalOrVendorFile(`${root}/vendors/lib.py`, root)).toBe(true);
	});

	it("returns true for third_party/", () => {
		expect(isExternalOrVendorFile(`${root}/third_party/sherpa/api.h`, root)).toBe(true);
	});

	it("returns true for third-party/", () => {
		expect(isExternalOrVendorFile(`${root}/third-party/lib/src.cpp`, root)).toBe(true);
	});

	it("returns false for a dir that merely contains 'vendor' as a substring", () => {
		expect(isExternalOrVendorFile(`${root}/src/vendor_utils/helper.ts`, root)).toBe(false);
	});
});

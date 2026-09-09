import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Controllable `os.homedir()` override for the mutation-proof HOME-default
// test below — `vi.spyOn(os, "homedir")` fails under Vitest's ESM
// interop ("Cannot redefine property"), so the module itself is replaced
// with a thin wrapper that defers to the REAL os.homedir() unless a test
// has set an override (refs #2472 review round 3, F2). Never used to touch
// the real HOME directory — only to redirect os.homedir() to a temp dir.
const homedirOverride = vi.hoisted(() => ({
	value: undefined as string | undefined,
}));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const homedir = () => homedirOverride.value ?? actual.homedir();
	return { ...actual, default: { ...actual, homedir }, homedir };
});

import { minimatch } from "../../clients/deps/minimatch.js";
import {
	CARGO_WORKSPACE_MEMBER_DIALECT,
	findLocalToolConfig,
	findNearestContaining,
	findNearestMarkerRoot,
	homeRelativePath,
	matchesWorkspaceMemberPattern,
	UV_WORKSPACE_EXCLUDE_DIALECT,
	UV_WORKSPACE_MEMBERS_DIALECT,
	isFullyQualified,
	isFullyQualifiedPosix,
	isFullyQualifiedWin32,
	isAtOrAboveHomeDir,
	isExternalOrVendorFile,
	normalizeEphemeralMapKey,
	normalizeFilePath,
	normalizeLoggedPath,
	normalizeMapKey,
	pathToUri,
	splitPathSegments,
	toPosix,
	toProjectRelativePath,
	uriToPath,
	walkUpDirs,
} from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("isWindowsPath (#1213 review pins)", () => {
	it("matches drive-prefixed and UNC shapes only", async () => {
		const { isWindowsPath } = await import("../../clients/path-utils.js");
		expect(isWindowsPath("C:\foo")).toBe(true);
		expect(isWindowsPath("D:relative")).toBe(true);
		expect(isWindowsPath("\\server\share")).toBe(true);
		expect(isWindowsPath("/path/to/file")).toBe(false);
		// Backslashes are legal in POSIX filenames — embedded ones must not
		// classify a path as Windows-shaped (the Linux CI regression).
		expect(isWindowsPath("/ordinary\name")).toBe(false);
	});
});

describe("isFullyQualified matrix additions (#1213 review pins)", () => {
	it("classifies long-path and embedded-backslash forms", async () => {
		const { isFullyQualifiedWin32, isFullyQualifiedPosix } =
			await import("../../clients/path-utils.js");
		expect(isFullyQualifiedWin32("\\\\?\\C:\\very\\long\\path")).toBe(true);
		expect(isFullyQualifiedPosix("/ordinary\\name")).toBe(true);
	});
});

describe("path-utils", () => {
	const fullyQualifiedMatrix = [
		["Windows drive-relative", "C:foo", false, false],
		["Windows rooted-relative", "\\foo", false, false],
		["Windows drive-absolute", "C:\\foo", false, true],
		["Windows UNC", "\\\\server\\share", false, true],
		["POSIX root", "/", true, false],
		["POSIX absolute", "/abs/path", true, false],
		["relative", "rel/path", false, false],
		["dot-relative", "./rel", false, false],
	] as const;
	it.each(fullyQualifiedMatrix)(
		"isFullyQualifiedPosix: %s",
		(_label, value, expected) => {
			expect(isFullyQualifiedPosix(value)).toBe(expected);
		},
	);
	it.each(fullyQualifiedMatrix)(
		"isFullyQualifiedWin32: %s",
		(_label, value, _posix, expected) => {
			expect(isFullyQualifiedWin32(value)).toBe(expected);
		},
	);
	it("classifies /foo according to explicit platform semantics", () => {
		expect(isFullyQualifiedWin32(path.posix.join(path.posix.sep, "foo"))).toBe(
			false,
		);
		expect(isFullyQualifiedPosix(path.posix.join(path.posix.sep, "foo"))).toBe(
			true,
		);
	});
	it("classifies ordinary host-native paths through the ambient helper", () => {
		const hostNative = path.join(
			path.parse(process.cwd()).root,
			"ordinary",
			"host-native",
		);
		expect(isFullyQualified(hostNative)).toBe(true);
		if (process.platform === "win32") {
			expect(isFullyQualifiedWin32(hostNative)).toBe(true);
		} else {
			expect(isFullyQualifiedPosix(hostNative)).toBe(true);
		}
	});
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

describe("normalizeFilePath: Windows-shaped path is OS-coherent (refs #1150, class #1024)", () => {
	// A drive-letter/UNC-shaped path enters normalizeFilePath's win32 branch on
	// ANY OS (isWindowsPath classifies by shape, not platform). Before #1150 the
	// win32-committed resolveNonExisting fallback used the platform-default
	// `dirname`: POSIX on Linux, which finds no separator in a win32-resolved
	// "C:\..." path, collapses to ".", stops the upward walk at cwd, and mangles
	// the key to `<cwd>/file.ts`. On Windows the same input keyed correctly, so
	// a test hardcoding a drive-letter literal passed on Windows and failed on
	// Linux CI (#1139). This test is meaningful on BOTH OSes: native win32 path
	// on Windows, shape-committed win32 branch on Linux.
	//
	// Path is guaranteed non-existent so the fallback (not realpathSync.native)
	// runs on both OSes.
	const nonExistent = "C:/__pi_lens_1150_nonexistent__/sub/file.ts";
	const nonExistentBack = "C:\\__pi_lens_1150_nonexistent__\\sub\\file.ts";
	const structuralTail = "/__pi_lens_1150_nonexistent__/sub/file.ts";

	it("forward-slash and backslash forms normalize to the same key (coherence)", () => {
		expect(normalizeFilePath(nonExistent)).toBe(
			normalizeFilePath(nonExistentBack),
		);
	});

	it("preserves the path structure and drive-letter shape — never collapses to a cwd-relative key", () => {
		const key = normalizeFilePath(nonExistent);
		// Structure preserved: full literal tail survives (drive-letter case may
		// differ — uppercase on Windows, lowercased by the Linux fallback — so
		// compare case-insensitively). PRE-FIX on Linux this was `<cwd>/file.ts`,
		// dropping "__pi_lens_1150_nonexistent__/sub" entirely.
		expect(key.toLowerCase().endsWith(structuralTail.toLowerCase())).toBe(true);
		// Retains drive-letter shape, i.e. is NOT rooted at the POSIX cwd. PRE-FIX
		// on Linux the mangled key started with the process cwd ("/home/..."),
		// which has no drive letter.
		expect(/^[A-Za-z]:/.test(key)).toBe(true);
		// Explicitly cwd-independent: the process working directory must not
		// appear in the key.
		expect(key.toLowerCase()).not.toContain(
			process.cwd().replace(/\\/g, "/").toLowerCase(),
		);
	});

	it("normalizeMapKey (the map-key entry point) yields the same stable key", () => {
		expect(normalizeMapKey(nonExistent)).toBe(normalizeFilePath(nonExistent));
		expect(normalizeMapKey(nonExistentBack)).toBe(normalizeMapKey(nonExistent));
	});
});

describe("toProjectRelativePath: Windows-shaped path relativizes on ANY OS (refs #1163, class #1150/#1024)", () => {
	// A drive-letter-shaped filePath UNDER a drive-letter-shaped projectRoot must
	// relativize by win32 semantics on any OS — the shape decides the parser, not
	// `process.platform`. PRE-FIX on Linux, the host-default `path.isAbsolute`
	// returns false for a "C:\..." path (no POSIX leading slash), so the function
	// short-circuited and returned the whole absolute path instead of the
	// project-relative one. On Windows the same input relativized correctly, so a
	// Linux CI run diverged from a green Windows run (the #1024 class). Inputs are
	// fed as literals; the expectation is derived structurally, not hardcoded to a
	// normalized key (the #1139/#1150 vacuous-fixture trap).
	it("backslash form under a backslash root → forward-slashed project-relative path", () => {
		expect(toProjectRelativePath("C:\\repo\\src\\x.ts", "C:\\repo")).toBe(
			"src/x.ts",
		);
	});

	it("forward-slash win32 form under a win32 root → project-relative path", () => {
		expect(toProjectRelativePath("C:/repo/src/nested/y.ts", "C:/repo")).toBe(
			"src/nested/y.ts",
		);
	});

	it("UNC-shaped path under a UNC root relativizes rather than returning the whole path", () => {
		const rel = toProjectRelativePath(
			"\\\\host\\share\\proj\\src\\z.ts",
			"\\\\host\\share\\proj",
		);
		expect(rel).toBe("src/z.ts");
	});

	it("a win32 file OUTSIDE the win32 root keeps the (slash-folded) absolute path", () => {
		// Not under the root → not relativized; must stay the full path, never a
		// "../"-prefixed escape.
		expect(toProjectRelativePath("C:\\other\\a.ts", "C:\\repo")).toBe(
			"C:/other/a.ts",
		);
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

	// Case folding is a no-op off Windows, so this declares itself skipped there
	// rather than returning early from a body that would report as PASSED
	// without asserting anything (#2089).
	it.skipIf(process.platform !== "win32")(
		"is case-insensitive on win32 semantics (matches this suite's Windows CI target)",
		() => {
			expect(normalizeEphemeralMapKey("C:\\Foo\\BAR.TS")).toBe(
				normalizeEphemeralMapKey("c:\\foo\\bar.ts"),
			);
		},
	);
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
			fs.writeFileSync(
				path.join(env.tmpDir, "outer", "inner", "package.json"),
				"{}",
			);

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

	// #2472 review round 3, F1 (maintainer-decision reversal): the $HOME
	// ceiling is now OPT-IN via `options.homeDir`, not default-on — an
	// EXPLICIT `homeDir` still stops the climb even when a config sits one
	// level above it (the ceiling itself still works; only its default
	// posture changed).
	it("stops the ancestor climb at options.homeDir when a config sits one level above it, but only when homeDir is passed", () => {
		const env = setupTestEnvironment("pi-lens-find-tool-config-homeceiling-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, "typos.toml"), "");
			const homeDir = path.join(env.tmpDir, "home");
			const startDir = path.join(homeDir, "project", "src");
			fs.mkdirSync(startDir, { recursive: true });

			const found = findLocalToolConfig(startDir, ["typos.toml"], {
				homeDir,
			});
			expect(found).toBeUndefined();

			// Cross-form (forward-slash) startDir must be guarded identically.
			const crossFormStartDir = startDir.split(path.sep).join("/");
			expect(
				findLocalToolConfig(crossFormStartDir, ["typos.toml"], { homeDir }),
			).toBeUndefined();

			// Without an explicit homeDir the SAME search is unceilinged and
			// finds the ancestor config — proves the ceiling in the assertions
			// above comes from opting in, not from some other accident of this
			// fixture (e.g. depth or directory naming).
			expect(findLocalToolConfig(startDir, ["typos.toml"])).toBe(
				path.join(env.tmpDir, "typos.toml"),
			);
		} finally {
			env.cleanup();
		}
	});

	// #2472 review round 3, F2: the prior version of this test
	// ("is at-or-above os.homedir() by default when options is omitted") was
	// vacuous — it searched for a fabricated filename that exists nowhere on
	// disk, so `found` was `undefined` regardless of whether the ceiling ran
	// at all; a fold that deleted the ceiling check entirely left this test
	// green. Replaced with a non-vacuous, mutation-proof pair: a REAL config
	// file sitting exactly AT a mocked `os.homedir()` (never the real HOME —
	// writing fixture files into the operator's actual home directory is the
	// #2506 class) must resolve when `options` is omitted (default OFF, no
	// ceiling — refs #2472 review round 3 F1) and must NOT resolve once an
	// explicit `{ homeDir }` opts back into the ceiling (`isAtOrAboveHomeDir`'s
	// own `dir === homeDir` branch fires before any name in that directory is
	// even checked).
	it("resolves a config AT a mocked HOME by default, but not once { homeDir } opts into the ceiling", () => {
		const env = setupTestEnvironment("pi-lens-find-tool-config-mockedhome-");
		try {
			const mockedHome = path.join(env.tmpDir, "mocked-home");
			fs.mkdirSync(mockedHome, { recursive: true });
			homedirOverride.value = mockedHome;
			const configName = "this-config-lives-at-mocked-home-XYZZY.toml";
			fs.writeFileSync(path.join(mockedHome, configName), "");

			try {
				// Options omitted: no ceiling, so the walk finds the config
				// sitting exactly at the (mocked) home directory itself.
				expect(findLocalToolConfig(os.homedir(), [configName])).toBe(
					path.join(mockedHome, configName),
				);

				// Explicit opt-in with the SAME directory: the ceiling now blocks
				// it, proving the two calls differ ONLY by the opt-in.
				expect(
					findLocalToolConfig(os.homedir(), [configName], {
						homeDir: os.homedir(),
					}),
				).toBeUndefined();
			} finally {
				homedirOverride.value = undefined;
			}
		} finally {
			env.cleanup();
		}
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

/**
 * The ceiling's whole defect class is WIN32 path semantics — drive-letter
 * case-folding and cross-drive `path.relative` — and the authoritative Unit
 * tests lane is ubuntu. Asserting through the ambient `path` module meant CI's
 * diff for the #2544 F1 fix was structurally ZERO: the `isAbsolute` clause is
 * a tautology on POSIX, the re-spelling is a genuinely different directory
 * there, and every `process.platform === "win32"` expectation collapsed to the
 * POSIX branch. The helper takes an injectable `pathImpl` for exactly this
 * (#2544 review F2), so the SAME table below runs under `path.win32` and
 * `path.posix` on EVERY lane — the ubuntu lane now exercises the win32
 * case-folding semantics, and a Windows box exercises the POSIX ones.
 *
 * `path.win32`/`path.posix` are pure, host-independent implementations; nothing
 * in this block reads `process.platform`. The lane-level gap (no Windows Unit
 * tests lane at all) is tracked separately as #2536 — this makes the ubuntu
 * lane able to catch the bug, it does not replace running on Windows.
 */
interface CeilingCase {
	readonly what: string;
	readonly dir: string;
	readonly home: string;
	readonly expected: boolean;
}

interface CeilingTable {
	readonly label: string;
	readonly impl: typeof path;
	readonly cases: readonly CeilingCase[];
}

const POSIX_HOME = "/home/user";
const WIN32_HOME = "C:\\Users\\user";

const CEILING_TABLES: readonly CeilingTable[] = [
	{
		label: "posix",
		impl: path.posix,
		cases: [
			{
				what: "home itself",
				dir: POSIX_HOME,
				home: POSIX_HOME,
				expected: true,
			},
			{ what: "home's parent", dir: "/home", home: POSIX_HOME, expected: true },
			{
				what: "home's grandparent",
				dir: "/",
				home: POSIX_HOME,
				expected: true,
			},
			{
				what: "the filesystem root",
				dir: "/",
				home: "/home/user/nested",
				expected: true,
			},
			{
				what: "a project under home",
				dir: "/home/user/code/app",
				home: POSIX_HOME,
				expected: false,
			},
			{
				what: "a direct child of home",
				dir: "/home/user/proj",
				home: POSIX_HOME,
				expected: false,
			},
			{
				what: "a sibling tree",
				dir: "/home/someone-else/proj",
				home: POSIX_HOME,
				expected: false,
			},
			{
				what: "an unresolved path that normalizes TO home",
				dir: "/home/user/x/..",
				home: POSIX_HOME,
				expected: true,
			},
			{
				what: "an unresolved path that normalizes UNDER home",
				dir: "/home/user/a/../b",
				home: POSIX_HOME,
				expected: false,
			},
			{
				what: "a directory whose name merely PREFIXES home",
				dir: "/home/user2",
				home: POSIX_HOME,
				expected: false,
			},
			{
				what: "a project under a name that merely prefixes home",
				dir: "/home/user2/proj",
				home: POSIX_HOME,
				expected: false,
			},
			// The cross-drive row's POSIX counterpart: an unrelated absolute root.
			// `path.relative` answers with `..` segments here, so the
			// `!isAbsolute(rel)` clause is inert — which is precisely why the
			// win32 table below has to run on this lane too.
			{
				what: "an unrelated absolute tree",
				dir: "/mnt",
				home: POSIX_HOME,
				expected: false,
			},
			// Re-spelling: POSIX is case-SENSITIVE, so `/home/USER` is a genuinely
			// DIFFERENT directory and must NOT be ceilinged — over-folding here
			// would block a legitimate `~/Code` vs `~/code` project.
			{
				what: "a re-cased home (case-sensitive: a different directory)",
				dir: "/home/USER",
				home: POSIX_HOME,
				expected: false,
			},
			{
				what: "a re-cased home in the HOME argument",
				dir: POSIX_HOME,
				home: "/home/USER",
				expected: false,
			},
		],
	},
	{
		label: "win32",
		impl: path.win32,
		cases: [
			{
				what: "home itself",
				dir: WIN32_HOME,
				home: WIN32_HOME,
				expected: true,
			},
			{
				what: "home's parent",
				dir: "C:\\Users",
				home: WIN32_HOME,
				expected: true,
			},
			{
				what: "home's grandparent",
				dir: "C:\\",
				home: WIN32_HOME,
				expected: true,
			},
			{
				what: "the filesystem root",
				dir: "C:\\",
				home: "C:\\Users\\user\\nested",
				expected: true,
			},
			{
				what: "a project under home",
				dir: "C:\\Users\\user\\code\\app",
				home: WIN32_HOME,
				expected: false,
			},
			{
				what: "a direct child of home",
				dir: "C:\\Users\\user\\proj",
				home: WIN32_HOME,
				expected: false,
			},
			{
				what: "a sibling tree",
				dir: "C:\\Users\\someone-else\\proj",
				home: WIN32_HOME,
				expected: false,
			},
			{
				what: "an unresolved path that normalizes TO home",
				dir: "C:\\Users\\user\\x\\..",
				home: WIN32_HOME,
				expected: true,
			},
			{
				what: "an unresolved path that normalizes UNDER home",
				dir: "C:\\Users\\user\\a\\..\\b",
				home: WIN32_HOME,
				expected: false,
			},
			{
				what: "a directory whose name merely PREFIXES home",
				dir: "C:\\Users\\user2",
				home: WIN32_HOME,
				expected: false,
			},
			{
				what: "a project under a name that merely prefixes home",
				dir: "C:\\Users\\user2\\proj",
				home: WIN32_HOME,
				expected: false,
			},
			// Cross-drive: `path.relative` returns an ABSOLUTE path between drive
			// letters, and an absolute `rel` has no leading `..` — without the
			// `!isAbsolute(rel)` clause `C:\` reports itself at-or-above a `D:\`
			// home and ceilings every walker on the wrong drive.
			{
				what: "the root of another drive",
				dir: "C:\\",
				home: "D:\\Users\\jane",
				expected: false,
			},
			// The #2514/#2544 F1 defect itself: the lowercase-drive spelling VS
			// Code URIs produce (and 46 records of a real `latency.log` carry) IS
			// the home directory on win32, with the separator form flipped too per
			// the repo's cross-form path rule (record one form, check the other).
			{
				what: "a re-spelled home (lowercase drive + forward slashes)",
				dir: "c:/Users/user",
				home: WIN32_HOME,
				expected: true,
			},
			{
				what: "a re-spelled home in the HOME argument",
				dir: WIN32_HOME,
				home: "c:/Users/user",
				expected: true,
			},
		],
	},
];

describe.each(CEILING_TABLES)(
	"isAtOrAboveHomeDir (#253) — $label path semantics on every lane (#2544 F2)",
	({ impl, cases }) => {
		it.each(cases)("$what → $expected", ({ dir, home, expected }) => {
			expect(isAtOrAboveHomeDir(dir, home, impl)).toBe(expected);
		});
	},
);

describe("isExternalOrVendorFile", () => {
	const root = "/home/user/project";

	it("returns false for a normal source file", () => {
		expect(isExternalOrVendorFile(`${root}/src/main.ts`, root)).toBe(false);
	});

	it("returns true for a file outside the project root", () => {
		expect(
			isExternalOrVendorFile("/home/user/other-project/foo.ts", root),
		).toBe(true);
	});

	it("returns true for node_modules", () => {
		expect(
			isExternalOrVendorFile(`${root}/node_modules/lodash/index.js`, root),
		).toBe(true);
	});

	it("returns true for vendor/", () => {
		expect(isExternalOrVendorFile(`${root}/vendor/dep/file.go`, root)).toBe(
			true,
		);
	});

	it("returns true for vendors/", () => {
		expect(isExternalOrVendorFile(`${root}/vendors/lib.py`, root)).toBe(true);
	});

	it("returns true for third_party/", () => {
		expect(
			isExternalOrVendorFile(`${root}/third_party/sherpa/api.h`, root),
		).toBe(true);
	});

	it("returns true for third-party/", () => {
		expect(
			isExternalOrVendorFile(`${root}/third-party/lib/src.cpp`, root),
		).toBe(true);
	});

	it("returns false for a dir that merely contains 'vendor' as a substring", () => {
		expect(
			isExternalOrVendorFile(`${root}/src/vendor_utils/helper.ts`, root),
		).toBe(false);
	});
});

describe("toPosix (refs #1193)", () => {
	it("folds backslashes to forward slashes", () => {
		expect(toPosix("C:\\repo\\src\\x.ts")).toBe("C:/repo/src/x.ts");
		expect(toPosix("\\\\host\\share\\a.ts")).toBe("//host/share/a.ts");
	});

	it("is a no-op on an already-forward-slashed path", () => {
		expect(toPosix("/home/u/x.ts")).toBe("/home/u/x.ts");
		expect(toPosix("src/x.ts")).toBe("src/x.ts");
	});

	it("is exactly the inline idiom it replaces (does NOT collapse, resolve, or lowercase)", () => {
		const p = "C:\\Repo\\\\src\\.\\x.ts";
		// Pure separator fold — same as `p.replace(/\\/g, "/")`, no other change.
		expect(toPosix(p)).toBe(p.replace(/\\/g, "/"));
		expect(toPosix(p)).toBe("C:/Repo//src/./x.ts"); // doubled slash + `.` + case preserved
	});

	it("handles empty string", () => {
		expect(toPosix("")).toBe("");
	});
});

describe("splitPathSegments (refs #1193, #1161/#1163)", () => {
	it("splits on EITHER separator regardless of host, dropping empties", () => {
		expect(splitPathSegments("C:\\repo\\src\\x.ts")).toEqual([
			"C:",
			"repo",
			"src",
			"x.ts",
		]);
		expect(splitPathSegments("/home/u/x.ts")).toEqual(["home", "u", "x.ts"]);
		expect(splitPathSegments("a/b\\c")).toEqual(["a", "b", "c"]); // mixed separators
	});

	it("collapses doubled separators and drops leading/trailing empties", () => {
		expect(splitPathSegments("//host\\\\share//a")).toEqual([
			"host",
			"share",
			"a",
		]);
		expect(splitPathSegments("src/")).toEqual(["src"]);
	});

	it("returns [] for empty or separator-only input", () => {
		expect(splitPathSegments("")).toEqual([]);
		expect(splitPathSegments("///")).toEqual([]);
	});
});

/**
 * #2219/#2229 review round 1: `normalizeLoggedPath` guards `normalizeFilePath`
 * so a logger's `filePath`/`cwd` field can carry non-path sentinels
 * (cascade-logger.ts's "<quiet-window>", tree-sitter-logger.ts's
 * "<tree-sitter>", latency-logger.ts's shell commands and "<pi-lens>") without
 * having them resolved against the process cwd.
 */
describe("normalizeLoggedPath (#2219, #2229 review round 1)", () => {
	// F1 (blocker): the classifier must answer the same way for a given
	// STRING regardless of which OS is asking. `isFullyQualified` alone
	// dispatches on `process.platform`, so on Linux CI a Windows-shaped
	// absolute path (`C:\Users\...`) reads as NOT fully qualified
	// (isFullyQualifiedPosix rejects it) and passes through raw — silently
	// no-opping the #2141 fix for every Windows-authored path in CI. Checking
	// BOTH `isFullyQualifiedWin32` and `isFullyQualifiedPosix` fixes that.
	it("normalizes a Windows-shaped absolute path independent of the host platform", () => {
		const raw = String.raw`C:\Users\dev\pi-free\src\a.ts`;
		expect(normalizeLoggedPath(raw)).toBe(normalizeFilePath(raw));
		// Never the raw, un-normalized backslash form — this is the exact
		// shape CI caught: isFullyQualified(raw) is false on a POSIX host,
		// which made the pre-fix guard a no-op there.
		expect(normalizeLoggedPath(raw)).not.toBe(raw);
	});

	it("normalizes a POSIX-shaped absolute path independent of the host platform", () => {
		const raw = "/workspace/src/a.ts";
		expect(normalizeLoggedPath(raw)).toBe(normalizeFilePath(raw));
	});

	it.each([
		"<quiet-window>",
		"<tree-sitter>",
		"<pi-lens>",
		"",
		"git",
		"npm run build",
		"relative/a.ts",
	])("passes the non-path value %j through unchanged", (value) => {
		expect(normalizeLoggedPath(value)).toBe(value);
	});

	// F2 (documented, not fixed): a command string that HAPPENS to start with
	// a drive-letter root is indistinguishable from a genuine absolute path by
	// this classifier, so it IS normalized — including the trailing
	// arguments, which get their backslashes flipped as collateral. No live
	// caller passes a command with arguments through this field today
	// (verified by reading every `normalizeLoggedPath`/`logLatency`
	// `filePath` call site); this pins the current, accepted behavior so a
	// future caller doing so is a visible test change, not a silent
	// surprise.
	//
	// #2229 review round 3, R2-F1: the expected value must be DERIVED via
	// normalizeFilePath, not a hardcoded literal — normalizeFilePath's
	// last-resort branch (path-utils.ts's win32 no-existing-ancestor case)
	// lowercases the whole string when no `C:\` ancestor exists on the host
	// filesystem, which is true on Linux CI but not on a Windows dev box with
	// a real C: drive. A hardcoded "C:/tools/..." literal passes on Windows
	// and fails on Linux with "c:/tools/..." (AGENTS.md shape 7, the
	// #1139/#1150 drive-letter-case class).
	it("pins current behavior for a drive-rooted command WITH arguments (no live caller does this)", () => {
		const withArgs = String.raw`C:\tools\rg.exe --files`;
		expect(normalizeLoggedPath(withArgs)).toBe(normalizeFilePath(withArgs));
	});
});

describe("homeRelativePath (#2440 F5)", () => {
	const home = os.homedir();

	it("rewrites a $HOME-anchored path to its ~ form", () => {
		expect(homeRelativePath(path.join(home, ".pi-lens", "config.json"))).toBe(
			"~/.pi-lens/config.json",
		);
	});

	it("returns a bare ~ for the home directory itself", () => {
		expect(homeRelativePath(home)).toBe("~");
	});

	it("leaves a path outside home untouched, separators included", () => {
		const outside = path.join(path.sep, "etc", "pi-lens.json");
		expect(homeRelativePath(outside)).toBe(outside);
		expect(homeRelativePath("relative/a.ts")).toBe("relative/a.ts");
		expect(homeRelativePath("")).toBe("");
	});

	it("does not rewrite a SIBLING whose name merely starts with home's", () => {
		// `/home/jane-backup` is not under `/home/jane`. A prefix test without
		// the separator would have claimed it.
		expect(homeRelativePath(`${home}-backup/config.json`)).toBe(
			`${home}-backup/config.json`,
		);
	});

	it("takes the home directory as an argument, so no assertion depends on the box", () => {
		expect(
			homeRelativePath("/home/jane/.pi-lens/config.json", "/home/jane"),
		).toBe("~/.pi-lens/config.json");
		// A trailing separator on home must not produce `~//...`.
		expect(homeRelativePath("/home/jane/a.json", "/home/jane/")).toBe(
			"~/a.json",
		);
		expect(homeRelativePath("/home/janet/a.json", "/home/jane")).toBe(
			"/home/janet/a.json",
		);
	});
});

/**
 * The workspace-member glob dialect table (#2591). Three tools, one matcher:
 * every row names the axis it exercises and pins all three dialects' answers
 * side by side, so a change to the shared compiler that "fixes" one dialect by
 * moving another shows up as a table diff rather than as a silent change to
 * Rust-LSP root selection or uv `.venv` inheritance.
 *
 * Upstream pins: cargo's dialect is the behavior #1671 shipped and #2591
 * preserved byte-for-byte; uv's two are
 * astral-sh/uv@3c979abda4530fe9bf3d92e9bcf5c5575e3b3126,
 * `crates/uv-workspace/src/workspace.rs` (`is_included_in_workspace` for
 * `members`, `WorkspaceExclusions::matches` for `exclude`).
 */
const WORKSPACE_GLOB_VECTORS: ReadonlyArray<{
	axis: string;
	pattern: string;
	relativePath: string;
	cargo: boolean;
	uvMembers: boolean;
	uvExclude: boolean;
}> = [
	{
		axis: "literal path",
		pattern: "crates/foo",
		relativePath: "crates/foo",
		cargo: true,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "`*` inside one component",
		pattern: "crates/*",
		relativePath: "crates/foo",
		cargo: true,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "segment-count mismatch — `*` may not cross `/` except in uv exclude",
		pattern: "crates/*",
		relativePath: "crates/foo/bar",
		cargo: false,
		uvMembers: false,
		uvExclude: true,
	},
	{
		axis: "bare `*` claims one component only",
		pattern: "*",
		relativePath: "a/b",
		cargo: false,
		uvMembers: false,
		uvExclude: true,
	},
	{
		axis: "`**` crosses components (cargo: pattern never matches)",
		pattern: "crates/**",
		relativePath: "crates/a/b",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "a TRAILING `**` still requires at least one component",
		pattern: "crates/**",
		relativePath: "crates",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	{
		// The separator alone is not the component: `crates/**` compiled to
		// `^crates/.+$`, so the `.+` (one character, then any number) has to
		// survive the step split that put the `/` in its own step (#2603).
		axis: "a TRAILING `**` is not satisfied by the separator alone",
		pattern: "crates/**",
		relativePath: "crates/",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "an INTERIOR `**` may consume zero components",
		pattern: "a/**/b",
		relativePath: "a/b",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "a LEADING `**` may consume zero components",
		pattern: "**/tests",
		relativePath: "tests",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "`**` anywhere kills a cargo pattern, even mid-component",
		pattern: "crates/a**b",
		relativePath: "crates/aXb",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "case-sensitive on every platform (pattern cased up)",
		pattern: "Crates/*",
		relativePath: "crates/foo",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "case-sensitive on every platform (path cased up)",
		pattern: "crates/*",
		relativePath: "Crates/foo",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "a leading dot is an ordinary character to `*`",
		pattern: "crates/*",
		relativePath: "crates/.hidden",
		cargo: true,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "`?` matches exactly one character",
		pattern: "crates/a?c",
		relativePath: "crates/abc",
		cargo: true,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "`?` may not cross `/` except in uv exclude",
		pattern: "crates/a?c",
		relativePath: "crates/a/c",
		cargo: false,
		uvMembers: false,
		uvExclude: true,
	},
	{
		axis: "trailing slash — cargo strips it, uv normalize_path keeps it",
		pattern: "crates/foo/",
		relativePath: "crates/foo",
		cargo: true,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "trailing slash after a wildcard component",
		pattern: "crates/*/",
		relativePath: "crates/foo",
		cargo: true,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "leading ./ — uv normalize_path drops it, cargo counts a component",
		pattern: "./packages/a",
		relativePath: "packages/a",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "character class — a class in uv, a literal bracket run in cargo",
		pattern: "crates/[ab]",
		relativePath: "crates/a",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "character class — the same pattern names a literal directory to cargo",
		pattern: "crates/[ab]",
		relativePath: "crates/[ab]",
		cargo: true,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "negated character class",
		pattern: "crates/[!ab]",
		relativePath: "crates/c",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "the acceptance vector: a separator-crossing exclusion `*`",
		pattern: "packages/a*c",
		relativePath: "packages/a/b/c",
		cargo: false,
		uvMembers: false,
		uvExclude: true,
	},
	{
		axis: "a regex metacharacter is a literal, not a wildcard",
		pattern: "crates/a.c",
		relativePath: "crates/abc",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "a regex metacharacter matches itself",
		pattern: "crates/a+b",
		relativePath: "crates/a+b",
		cargo: true,
		uvMembers: true,
		uvExclude: true,
	},
	// Adjacent `**` components denote exactly what a single one does, so these
	// three rows must read exactly like the single-`**` rows above. #2591 review
	// round 2 leaned on that to COLLAPSE them before compiling, the way upstream
	// does (`rust-lang/glob@cfa2a58f2e44373573f657ec25b3621e44714dee`,
	// `src/lib.rs:672-684`); #2603 DELETED the collapse — it was a speed
	// normalization, and the step table the matcher now fills is linear with or
	// without it — so these rows are what keeps that deletion honest.
	{
		axis: "chained `**`: interior, consuming zero components",
		pattern: "a/**/**/**/b",
		relativePath: "a/b",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "chained `**`: interior, consuming several components",
		pattern: "a/**/**/**/b",
		relativePath: "a/x/y/b",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "chained `**`: a trailing chain still requires one component",
		pattern: "a/**/**/**",
		relativePath: "a",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	// #2603: INTERLEAVED `**` chains — a `**` per link, separated by a `*`
	// component, which is the shape no consecutive-`**` collapse can reach. The
	// answers are the ordinary globstar answers; the cost half is the budget in
	// `workspace-glob-nonbacktracking-budget.test.ts`.
	{
		axis: "interleaved `**/*` chain, every `**` consuming zero components",
		pattern: "**/*/**/*/zzz",
		relativePath: "a/b/zzz",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "interleaved `**/*` chain, the `**`s consuming components",
		pattern: "**/*/**/*/zzz",
		relativePath: "a/b/c/d/e/zzz",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "interleaved `**/*` chain against a path with no matching tail",
		pattern: "**/*/**/*/zzz",
		relativePath: "a/b/c/d/e",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "a `*` interleaved with `**` still crosses `/` only in uv exclude",
		pattern: "**/a*c/zzz",
		relativePath: "x/a/b/c/zzz",
		cargo: false,
		uvMembers: false,
		uvExclude: true,
	},
	// A separator-CROSSING wildcard is `.`, not "any character": the regex the
	// step table replaced spelled `**` as `.+`, and minimatch's globstar is
	// `.`-based too, so neither has ever matched across a line terminator inside
	// a directory name. The pair below is the positive control and the pin —
	// widening the crossing predicate to "any character" reds the second row.
	{
		axis: "`**` crosses an ordinary directory name",
		pattern: "**/c",
		relativePath: "ab/c",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
	{
		axis: "`**` does NOT cross a newline inside a directory name (`.`, not any char)",
		pattern: "**/c",
		relativePath: "a\nb/c",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	// #2591 review round 2, F2: a glob character class is not a JS character
	// class. `[z-a]` is a legal glob whose range is empty (it matches nothing)
	// and an illegal RegExp ("Range out of order"). Pre-fix these THREW a
	// SyntaxError out of the matcher; the deleted minimatch call answered
	// `false`, and so does the fold now — fail closed, declaring no member and
	// excluding nothing. `toBe(false)` is the assertion precisely because a
	// throw fails it too.
	{
		axis: "uncompilable class range fails closed, never throws",
		pattern: "crates/[z-a]",
		relativePath: "crates/a",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "uncompilable NEGATED class range fails closed, never throws",
		pattern: "crates/[!z-a]",
		relativePath: "crates/a",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "uncompilable class with a literal tail fails closed, never throws",
		pattern: "crates/[b-a]x",
		relativePath: "crates/ax",
		cargo: false,
		uvMembers: false,
		uvExclude: false,
	},
	{
		axis: "a WELL-FORMED class range still matches — fail-closed is not fail-always",
		pattern: "crates/[a-z]",
		relativePath: "crates/m",
		cargo: false,
		uvMembers: true,
		uvExclude: true,
	},
];

describe("matchesWorkspaceMemberPattern dialect table (#2591)", () => {
	it.each(WORKSPACE_GLOB_VECTORS)(
		"$axis: $pattern vs $relativePath",
		({ pattern, relativePath, cargo, uvMembers, uvExclude }) => {
			expect(
				matchesWorkspaceMemberPattern(
					pattern,
					relativePath,
					CARGO_WORKSPACE_MEMBER_DIALECT,
				),
			).toBe(cargo);
			expect(
				matchesWorkspaceMemberPattern(
					pattern,
					relativePath,
					UV_WORKSPACE_MEMBERS_DIALECT,
				),
			).toBe(uvMembers);
			expect(
				matchesWorkspaceMemberPattern(
					pattern,
					relativePath,
					UV_WORKSPACE_EXCLUDE_DIALECT,
				),
			).toBe(uvExclude);
		},
	);

	it("most rows separate at least two dialects", () => {
		// Shape 38 screen: a table whose every row read the same for every
		// dialect would pass with the dialect argument ignored entirely, so the
		// table is required to carry rows that actually discriminate.
		const separating = WORKSPACE_GLOB_VECTORS.filter(
			(vector) =>
				new Set([vector.cargo, vector.uvMembers, vector.uvExclude]).size > 1,
		);
		expect(separating.length).toBeGreaterThanOrEqual(12);
	});
});

/**
 * Byte-for-byte pin for the uv side of the fold: `UV_WORKSPACE_MEMBERS_DIALECT`
 * must answer exactly what the pre-fold
 * `minimatch(relative, path.posix.normalize(toPosix(pattern)), { dot: true })`
 * call answered, over a corpus deliberately NOT restricted to the shapes the
 * fold handles well (shape 38: the cheapest evasion of a differential test is a
 * corpus that omits the disagreements). Every cell that DOES differ is
 * enumerated below with its reason; a new divergence and a silently repaired
 * one both fail this test.
 */
const UV_DIFFERENTIAL_PATTERNS = [
	"packages/*",
	"packages/**",
	"packages",
	"packages/",
	"packages//a",
	"*",
	"**",
	"packages/**/tests",
	"**/x",
	"a/**",
	"a/**/b",
	"a**b",
	"packages/a?c",
	"packages/[ab]",
	"packages/[!ab]",
	"packages/[]ab]",
	"packages/[ab",
	"packages/a*c",
	"./packages/*",
	"packages/./a",
	"crates/*/*",
	"packages/*/",
	".hidden/*",
	"*/.hidden",
	"Packages/*",
	"a/*/c",
	"crates/foo/",
	"a/b/c",
	"a-b/c.d",
	"a+b",
	"a(b)",
	"a{b,c}",
	"a|b",
	"a^b",
	"a$b",
	"x\\y",
	"**/**",
	"packages/*/*/*",
	"a/**/**/b",
	"a/**/**/**/b",
	"a/**/**/**",
	"**/**/**",
	"?",
	"??",
	"*-*",
	// #2603: interleaved `**` chains — a `**` per link separated by a `*`
	// component, the shape the consecutive-`**` collapse could never reach and
	// the one the step table had to be built for.
	"**/*/**/*/zzz",
	"**/*/**",
	"*/**/*/**",
	"a/**/*/**/b",
] as const;

const UV_DIFFERENTIAL_PATHS = [
	"packages/a",
	"packages/a/b",
	"packages",
	"a",
	"a/b",
	"a/b/c",
	"x",
	"packages/abc",
	"packages/.hidden",
	".hidden/x",
	"x/.hidden",
	"packages/a/b/c",
	"crates/x/y",
	"packages/tests",
	"packages/a/tests",
	"a/ab",
	"a/aXc",
	"a/b/c/d",
	"aXb",
	"ab",
	"packages/[ab]",
	"packages/]",
	"packages/b",
	"packages/c",
	"crates/foo",
	"a-b/c.d",
	"a+b",
	"a(b)",
	"a{b,c}",
	"ab,c",
	"a|b",
	"a^b",
	"a$b",
	"x\\y",
	"xy",
	"packages//a",
	"a/x/y/b",
	"a/x/b",
	"packages/x/y/z",
	"a-c",
	"a/x/c",
	// #2603: tails the interleaved patterns above can and cannot reach, and a
	// directory name carrying a line terminator — the character a
	// separator-crossing wildcard has never been able to cross.
	"a/b/zzz",
	"a/b/c/d/zzz",
	"a\nb/c",
] as const;

/**
 * The complete set of cells where the folded uv-members dialect and the
 * pre-fold minimatch call disagree, each with the reason it is deliberate.
 * Keyed `pattern` + space + `path`.
 */
const UV_MINIMATCH_DIVERGENCES = new Map<string, string>([
	// minimatch collapses repeated separators in the PATH
	// (`preserveMultipleSlashes: false`); the folded compiler treats `//`
	// literally. Unreachable in production: the only path this matcher ever sees
	// is `toPosix(path.relative(...))`, which cannot produce `//`. The PATTERN
	// side is unaffected — `path.posix.normalize` collapses it first.
	["packages/* packages//a", "path-side //, unreachable via path.relative"],
	["packages//a packages//a", "path-side //, unreachable via path.relative"],
	["packages/[ab] packages//a", "path-side //, unreachable via path.relative"],
	["packages/[]ab] packages//a", "path-side //, unreachable via path.relative"],
	["./packages/* packages//a", "path-side //, unreachable via path.relative"],
	["packages/./a packages//a", "path-side //, unreachable via path.relative"],
	["*/**/*/** packages//a", "path-side //, unreachable via path.relative"],
	// Brace expansion is a minimatch extension the pre-fold uv path inherited by
	// accident. uv compiles members with rust `glob::Pattern` at the pinned SHA,
	// which has no brace syntax at all, so `a{b,c}` names a directory literally
	// called `a{b,c}` upstream. The fold moves uv TOWARD upstream here.
	["a{b,c} ab", "minimatch-only brace expansion; rust glob has none"],
	["a{b,c} a{b,c}", "minimatch-only brace expansion; rust glob has none"],
	// minimatch short-circuits a pattern that is NOTHING BUT `**` to
	// match-everything; every other spelling of it goes through a `.`-based
	// group, as did the regex this matcher replaced, and `.` excludes the four
	// line terminators. So a bare `**` matches a directory name containing a
	// `\n` in minimatch and not here. INHERITED, not introduced: the pre-fold
	// minimatch call and the #2591 regex disagreed the same way, and #2591's
	// corpus simply carried no such path. Upstream rust `glob` is char-based and
	// would match, so this is a recorded limitation rather than a choice; it
	// needs a real directory whose name contains a newline to observe.
	["** a\nb/c", "minimatch's bare-`**` match-everything short-circuit"],
	["**/** a\nb/c", "minimatch's bare-`**` match-everything short-circuit"],
	["**/**/** a\nb/c", "minimatch's bare-`**` match-everything short-circuit"],
]);

describe("the uv-members dialect reproduces the pre-fold minimatch answers (#2591)", () => {
	it("differs from minimatch(dot:true) on exactly the enumerated cells", () => {
		const unexpected: string[] = [];
		const repaired: string[] = [];
		let cells = 0;
		for (const pattern of UV_DIFFERENTIAL_PATTERNS) {
			const normalized = path.posix.normalize(toPosix(pattern));
			for (const relativePath of UV_DIFFERENTIAL_PATHS) {
				cells += 1;
				const key = `${pattern} ${relativePath}`;
				const folded = matchesWorkspaceMemberPattern(
					pattern,
					relativePath,
					UV_WORKSPACE_MEMBERS_DIALECT,
				);
				const preFold = minimatch(relativePath, normalized, { dot: true });
				if (folded !== preFold && !UV_MINIMATCH_DIVERGENCES.has(key)) {
					unexpected.push(`${key} folded=${folded} minimatch=${preFold}`);
				}
				if (folded === preFold && UV_MINIMATCH_DIVERGENCES.has(key)) {
					repaired.push(key);
				}
			}
		}
		expect(unexpected).toEqual([]);
		expect(repaired).toEqual([]);
		expect(cells).toBe(
			UV_DIFFERENTIAL_PATTERNS.length * UV_DIFFERENTIAL_PATHS.length,
		);
	});
});

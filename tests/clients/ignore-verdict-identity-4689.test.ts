/**
 * #4689 batch 5: the project ignore verdict is one answer per FILE, whichever
 * way the file or the root is spelled.
 *
 * Shape (AGENTS.md shape 1, divergent path keys), the ignore-verdict member:
 * `getProjectIgnoreMatcher` rooted a matcher at the spelling it was handed and
 * judged a file by `path.relative(root, spelling)`. A file reached through the
 * other spelling of the same project (`repo-alias/a.log` against the real
 * `repo`, or the reverse) read as "outside the root" and was never ignored, so
 * a gitignored file got dispatched, and the instant eviction a pi-authored
 * nested `.gitignore` write owes (`invalidateProjectIgnoreMatcherForPath`)
 * missed the cache entry it named by another spelling.
 *
 * The first cell drives the production `tool_result` handler (the gate at
 * `runtime-tool-result.ts` "skipping gitignored file"); the root is the
 * identity `RuntimeCoordinator.projectRoot` holds, the file path is the
 * spelling the model typed. The matcher cells use the call shape of the
 * spelled-root callers (`runtime-agent-end.ts` passes the host `ctx.cwd`).
 *
 * Every cell builds its tree from the #4689 symlinked-fixture family
 * (`createPathIdentityFixture`); a host that cannot create symlinks skips
 * visibly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getProjectIgnoreMatcher,
	invalidateProjectIgnoreMatcherForPath,
	isPathIgnoredByProject,
	isWithinPathForm,
} from "../../clients/file-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	createPathIdentityFixture,
	pinFixtureHome,
	setupTestEnvironment,
} from "./test-utils.js";

interface Tree {
	/** The real project. */
	repo: string;
	/** A directory link to `repo`: the other spelling of every file in it. */
	alias: string;
	/** `repo/sub`, which carries its own `.gitignore`. */
	sub: string;
	/** A directory link to `repo/sub`: a spelled root INSIDE the repository. */
	subLink: string;
	/** A project-looking sibling no `.gitignore` here governs. */
	outside: string;
	/** Set when this host cannot create symlinks; the cell must skip visibly. */
	skipReason?: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A git root (`.git`, `*.log`), one nested `.gitignore` (`*.tmp`) and links. */
function plantTree(slug: string): Tree {
	const env = setupTestEnvironment(`pi-lens-${slug}-`);
	const home = pinFixtureHome(slug);
	cleanups.push(() => {
		home.restore();
		env.cleanup();
	});
	const fixture = createPathIdentityFixture(env.tmpDir);
	if (fixture.skipReason !== undefined)
		return {
			repo: fixture.repo,
			alias: fixture.aliasRoot,
			sub: "",
			subLink: "",
			outside: "",
			skipReason: fixture.skipReason,
		};
	const sub = path.join(fixture.repo, "sub");
	fs.mkdirSync(path.join(fixture.repo, ".git"), { recursive: true });
	fs.mkdirSync(sub, { recursive: true });
	fs.writeFileSync(path.join(fixture.repo, ".gitignore"), "*.log\n");
	fs.writeFileSync(path.join(sub, ".gitignore"), "*.tmp\n");
	const subLink = path.join(env.tmpDir, "sub-link");
	fs.symlinkSync(path.join("repo", "sub"), subLink, "dir");
	return {
		repo: fixture.repo,
		alias: fixture.aliasRoot,
		sub,
		subLink,
		outside: path.dirname(fixture.outsideFile),
	};
}

/** The `tool_result` handler's deps for one mutation event, nothing mocked. */
function toolResultDeps(
	runtime: RuntimeCoordinator,
	dbg: (message: string) => void,
	input: Record<string, unknown>,
) {
	return {
		event: { toolName: "write", input, content: [] },
		getFlag: (name: string) => name === "no-lsp",
		dbg,
		runtime,
		cacheManager: new CacheManager(false),
		biomeClient: {},
		ruffClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as never;
}

describe("project ignore verdict by path identity (#4689)", () => {
	it("tool_result skips a gitignored file whichever way the path is spelled", async (ctx) => {
		const tree = plantTree("ignore-identity-tool-result");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tree.repo;
		fs.writeFileSync(path.join(tree.repo, "a.log"), "noise\n");
		for (const spelled of [
			path.join(tree.repo, "a.log"),
			path.join(tree.alias, "a.log"),
		]) {
			const dbg = vi.fn();
			await handleToolResult(
				toolResultDeps(runtime, dbg, { path: spelled, content: "noise\n" }),
			);
			expect(dbg).toHaveBeenCalledWith(
				`tool_result: skipping gitignored file ${spelled}`,
			);
		}
	});

	it("answers one verdict for the root and the file in any spelling pair", (ctx) => {
		const tree = plantTree("ignore-identity-pairs");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		for (const root of [tree.repo, tree.alias]) {
			for (const base of [tree.repo, tree.alias]) {
				const where = `root ${root} file under ${base}`;
				expect(
					isPathIgnoredByProject(path.join(base, "a.log"), root),
					`${where}: root rule`,
				).toBe(true);
				expect(
					isPathIgnoredByProject(path.join(base, "sub", "b.tmp"), root),
					`${where}: nested rule`,
				).toBe(true);
				expect(
					isPathIgnoredByProject(path.join(base, "sub", "keep.ts"), root),
					`${where}: kept file`,
				).toBe(false);
			}
		}
	});

	it("does not ignore a file that is in neither spelling of the root", (ctx) => {
		const tree = plantTree("ignore-identity-outside");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		for (const root of [tree.repo, tree.alias]) {
			expect(
				isPathIgnoredByProject(path.join(tree.outside, "a.log"), root),
			).toBe(false);
		}
	});

	it("applies the repository's rules to a root that is a link into a subdirectory", (ctx) => {
		const tree = plantTree("ignore-identity-sublink");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		const real = path.join(tree.sub, "a.log");
		expect(isPathIgnoredByProject(real, tree.repo)).toBe(true);
		expect(isPathIgnoredByProject(real, tree.subLink)).toBe(true);
		expect(
			isPathIgnoredByProject(path.join(tree.subLink, "a.log"), tree.repo),
		).toBe(true);
		expect(
			isPathIgnoredByProject(path.join(tree.subLink, "a.log"), tree.subLink),
		).toBe(true);
	});

	it("a pi-authored nested .gitignore write evicts the verdict through another spelling", async (ctx) => {
		const tree = plantTree("ignore-identity-invalidate");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tree.repo;
		const tmpFile = path.join(tree.sub, "x.tmp");
		// Prime: the verdict is memoized and the nested rules are frozen for the
		// cadence window, so only an eviction can change the answer inside it.
		expect(isPathIgnoredByProject(tmpFile, tree.repo)).toBe(true);
		fs.writeFileSync(path.join(tree.sub, ".gitignore"), "# cleared\n");
		await handleToolResult(
			toolResultDeps(runtime, () => {}, {
				path: path.join(tree.alias, "sub", ".gitignore"),
			}),
		);
		expect(isPathIgnoredByProject(tmpFile, tree.repo)).toBe(false);
	});

	it("evicts the verdicts of a spelled root the write named by the real path", (ctx) => {
		const tree = plantTree("ignore-identity-invalidate-reverse");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		const tmpViaAlias = path.join(tree.alias, "sub", "x.tmp");
		expect(isPathIgnoredByProject(tmpViaAlias, tree.alias)).toBe(true);
		fs.writeFileSync(path.join(tree.sub, ".gitignore"), "# cleared\n");
		invalidateProjectIgnoreMatcherForPath(path.join(tree.sub, ".gitignore"));
		expect(isPathIgnoredByProject(tmpViaAlias, tree.alias)).toBe(false);
	});

	it("evicts a nested verdict when the write names the directory through a link into it", (ctx) => {
		const tree = plantTree("ignore-identity-invalidate-sublink");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		const tmpFile = path.join(tree.sub, "x.tmp");
		expect(isPathIgnoredByProject(tmpFile, tree.repo)).toBe(true);
		fs.writeFileSync(path.join(tree.sub, ".gitignore"), "# cleared\n");
		invalidateProjectIgnoreMatcherForPath(
			path.join(tree.subLink, ".gitignore"),
		);
		expect(isPathIgnoredByProject(tmpFile, tree.repo)).toBe(false);
	});

	it("ignores a file in a directory whose name begins with two dots", (ctx) => {
		// RECURRENCE GUARDED (#4861 F2): the containment test was
		// `!relative || relative.startsWith("..") || isAbsolute(relative)`, and
		// `ancestorDirsBetween` repeated it, so the relative path of
		// `repo/..foo/x.log` ("..foo/x.log") read as OUTSIDE the root: the
		// repository's `*.log` rule never ran and a gitignored file dispatched.
		const tree = plantTree("ignore-identity-dotdot-name");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		const odd = path.join(tree.repo, "..foo");
		fs.mkdirSync(odd, { recursive: true });
		const log = path.join(odd, "x.log");
		fs.writeFileSync(log, "noise\n");
		expect(isPathIgnoredByProject(log, tree.repo)).toBe(true);
		// The directory is an ancestor of the file, not a sibling of the root, so
		// a file the rules keep stays kept.
		expect(isPathIgnoredByProject(path.join(odd, "keep.ts"), tree.repo)).toBe(
			false,
		);
	});

	// lane: the Linux and macOS unit shards. A backslash is a legal POSIX
	// filename character, and a sibling directory literally named `<root>\outside`
	// cannot exist on win32, where `\` separates.
	it.skipIf(process.platform === "win32")(
		"does not read the rules of a sibling directory named `<root>\\outside`",
		() => {
			// RECURRENCE GUARDED (#4876 review r2 F1, the CodeRabbit thread): the
			// containment form folded a literal `\` into a separator on every
			// platform, so `toPosix("<root>\\outside")` became the child
			// "<root>/outside" and the ancestor walk left the project root to read
			// the sibling's own `.gitignore`: an outside file read as an ignored
			// project file, where the predicate this batch replaced said `false`.
			const env = setupTestEnvironment("pi-lens-ignore-backslash-");
			const home = pinFixtureHome("ignore-backslash");
			cleanups.push(() => {
				home.restore();
				env.cleanup();
			});
			const repo = path.join(env.tmpDir, "repo");
			const sibling = path.join(env.tmpDir, `${path.basename(repo)}\\outside`);
			fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
			fs.mkdirSync(sibling, { recursive: true });
			fs.writeFileSync(path.join(repo, ".gitignore"), "root-rule.log\n");
			fs.writeFileSync(path.join(sibling, ".gitignore"), "*.log\n");
			const outside = path.join(sibling, "x.log");
			fs.writeFileSync(outside, "noise\n");
			// The sibling is OUTSIDE the root by text on this host.
			expect(path.relative(repo, outside)).toBe("../repo\\outside/x.log");
			expect(isPathIgnoredByProject(outside, repo)).toBe(false);
			// Control: the root's own rule still runs, so the `false` above is not
			// "no rule was read at all".
			expect(
				isPathIgnoredByProject(path.join(repo, "root-rule.log"), repo),
			).toBe(true);
		},
	);

	it("keys a `..` after a link through the kernel, not through a lexical fold", (ctx) => {
		// RECURRENCE GUARDED (#4876 review r2 F2): `isIgnored` ran `path.resolve`
		// before the directory identity could see the link, so the spelling the
		// changelog advertises was answered for a path that does not exist. The
		// kernel opens `<root>/shared/x.log`; `path.resolve` folded the spelling
		// into the never-existing `<root>/src/shared/x.log`.
		const tree = plantTree("ignore-identity-dotdot-link");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		fs.writeFileSync(path.join(tree.repo, ".gitignore"), "/shared/*.log\n");
		// Concatenated: `path.join` would collapse the `..` itself.
		const spelled = `${tree.repo}/src/linked/../shared/x.log`;
		expect(
			isPathIgnoredByProject(
				path.join(tree.repo, "shared", "x.log"),
				tree.repo,
			),
		).toBe(true);
		expect(isPathIgnoredByProject(spelled, tree.repo)).toBe(true);
	});

	it("does not skip a `..` after a link whose lexical fold lands in an ignored directory", (ctx) => {
		// Same defect, other direction: `path.resolve` folded the spelling into
		// `<root>/src/shared/x.log`, which `/src/` excludes, while the kernel opens
		// `<root>/shared/x.log`, which it does not.
		const tree = plantTree("ignore-identity-dotdot-lexical");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		fs.writeFileSync(path.join(tree.repo, ".gitignore"), "/src/\n");
		// Concatenated: `path.join` would collapse the `..` itself.
		const spelled = `${tree.repo}/src/linked/../shared/x.log`;
		expect(
			isPathIgnoredByProject(
				path.join(tree.repo, "shared", "x.log"),
				tree.repo,
			),
		).toBe(false);
		expect(isPathIgnoredByProject(spelled, tree.repo)).toBe(false);
		// A dot segment that ENDS the spelling names the directory itself: the
		// kernel answers `<root>` for `<root>/src/linked/..`, which `/src/` does
		// not exclude, while a lexical fold would name `<root>/src`.
		expect(
			isPathIgnoredByProject(`${tree.repo}/src/linked/..`, tree.repo, true),
		).toBe(false);
	});

	it("evicts a subtree named through a `..` after a link", (ctx) => {
		// RECURRENCE GUARDED (#4876 review r2 F2, the `invalidateSubtree` half;
		// review r3 F1, CodeRabbit inline 4372287149): the write hook folded the
		// spelling with `path.resolve` before the matcher saw it, so the eviction
		// named `<root>/src/shared` — a directory that never existed — and left the
		// memoized verdict the nested rules were rebuilt for. The cell enters
		// through `invalidateProjectIgnoreMatcherForPath`, which is what the write
		// hook calls, and spells the write the way a bash redirect reports it.
		const tree = plantTree("ignore-identity-dotdot-evict");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		fs.writeFileSync(path.join(tree.repo, ".gitignore"), "root-only-rule\n");
		const shared = path.join(tree.repo, "shared");
		fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
		const target = path.join(shared, "x.log");
		expect(isPathIgnoredByProject(target, tree.repo)).toBe(true);
		fs.writeFileSync(path.join(shared, ".gitignore"), "!*.log\n");
		// `src/linked` -> `../shared`, so the kernel reads this spelling as
		// `<root>/shared/.gitignore` while `path.resolve` reads
		// `<root>/src/shared/.gitignore`.
		invalidateProjectIgnoreMatcherForPath(
			`${tree.repo}/src/linked/../shared/.gitignore`,
		);
		expect(isPathIgnoredByProject(target, tree.repo)).toBe(false);
	});

	it("folds win32 case in the same form it folds win32 separators", () => {
		// RECURRENCE GUARDED (#4876 review r2 F4): the new containment form folded
		// separators but not case, while `path.relative` — the predicate this batch
		// replaced — folded both on win32, so a write hook that invalidated a
		// subtree spelled in another case left the memoized verdict standing.
		// Shape 35: the fold is chosen by the value's SHAPE (`isWindowsPath`), so
		// pure win32 semantics are exercised on every lane, not only on win32.
		expect(isWithinPathForm("C:\\Repo\\Sub\\x.log", "C:\\Repo")).toBe(true);
		expect(isWithinPathForm("C:\\Repo\\Sub\\x.log", "C:\\Repo\\sub")).toBe(
			true,
		);
		expect(isWithinPathForm("C:\\Repo\\Subx\\x.log", "C:\\Repo\\Sub")).toBe(
			false,
		);
		// POSIX keeps its literal backslashes (#4876 F1), so the same shape does
		// not open a containment the kernel does not have.
		expect(isWithinPathForm("/tmp/repo\\outside/x.log", "/tmp/repo")).toBe(
			false,
		);
	});

	it("pays one realpath per directory, not per file, to answer a link spelling", (ctx) => {
		const tree = plantTree("ignore-identity-cost");
		if (tree.skipReason !== undefined) return ctx.skip(tree.skipReason);
		const native = vi.spyOn(fs.realpathSync, "native");
		try {
			// Recurrence guarded: the verdict fix must not put a kernel round trip
			// on every file of a walk (#462: 75x slower on 9p/drvfs).
			const matcher = getProjectIgnoreMatcher(tree.alias);
			const dirs = [path.join(tree.alias, "sub"), path.join(tree.alias, "src")];
			native.mockClear();
			for (let pass = 0; pass < 2; pass += 1)
				for (const dir of dirs)
					for (let index = 0; index < 20; index += 1)
						matcher.isIgnored(path.join(dir, `f${index}.ts`));
			expect(native).toHaveBeenCalledTimes(dirs.length);
			// The root's own spelling is judged by text alone: no kernel round trip.
			native.mockClear();
			for (const dir of ["sub", "src"])
				for (let index = 0; index < 20; index += 1)
					matcher.isIgnored(path.join(tree.repo, dir, `f${index}.ts`));
			expect(native).not.toHaveBeenCalled();
		} finally {
			native.mockRestore();
		}
	});
});

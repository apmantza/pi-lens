/**
 * #4689 item 6, the LSP half: a language server's root walk starts at the
 * file's PATH IDENTITY, the directory the kernel opens, never at the spelling
 * that named it.
 *
 * Shape (AGENTS.md shape 1, divergent path keys): `pkg-a/src/blink.ts` is a
 * link to `pkg-b/b.ts`. `NearestRoot` climbed from the spelling's directory,
 * reached `pkg-a`'s `package.json` and hosted the file in package A's
 * TypeScript server, while the same file written as `pkg-b/b.ts` was hosted in
 * package B's. Its memo keyed that answer by the directory's identity, so a
 * file reached through a directory link wrote package A's root under package
 * B's directory and every later lookup of the real spelling read it back.
 *
 * Every walk that moves to the identity axis takes its other end with it: the
 * stop directory, the home and tmpdir the walk refuses, the extensions
 * boundary and the session ceiling a root is clamped to. Each of those cells
 * names the regression a walk-only change would ship.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NearestRoot,
	resolveLspServerCwd,
	TypeScriptServer,
	WorkspacePriorityRoot,
} from "../../../clients/lsp/server.js";
import { realpathOrResolve } from "../../../clients/path-utils.js";
import {
	createPathIdentityFixture,
	pinFixtureHome,
	plantPackageLink,
	setupTestEnvironment,
} from "../test-utils.js";

const cleanups: Array<() => void> = [];

// The environment and the mocks are restored before the fixture roots are
// removed, so nothing the case left behind still points into a deleted root.
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Layout {
	base: string;
	repo: string;
	aliasRoot: string;
	pkgA: string;
	pkgB: string;
	fileLink: string;
	realFile: string;
	dirLinkFile: string;
	libFile: string;
	skipReason?: string;
}

function layout(prefix: string): Layout {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	const fx = createPathIdentityFixture(env.tmpDir);
	const pkg = plantPackageLink(fx.repo);
	const skipReason = fx.skipReason ?? pkg.skipReason;
	ageDirs(env.tmpDir);
	return {
		base: env.tmpDir,
		repo: fx.repo,
		aliasRoot: fx.aliasRoot,
		pkgA: pkg.pkgA,
		pkgB: pkg.pkgB,
		fileLink: pkg.fileLink,
		realFile: pkg.realFile,
		dirLinkFile: path.join(pkg.dirLink, "lib.ts"),
		libFile: pkg.libFile,
		...(skipReason !== undefined && { skipReason }),
	};
}

/**
 * Stamp every real directory of a fresh fixture a minute into the past. The
 * memo refuses to store a walk over a directory stamped inside the tick before
 * it (#4756), which every just-created fixture is, so without this a cell
 * never reaches the memo it is about.
 */
function ageDirs(dir: string): void {
	const past = new Date(Date.now() - 60_000);
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) ageDirs(path.join(dir, entry.name));
	}
	fs.utimesSync(dir, past, past);
}

function link(target: string, at: string): void {
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.symlinkSync(target, at, "dir");
}

function write(file: string, content = "{}\n"): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("#4689 item 6: the LSP root walk starts at the file's identity", () => {
	// RECURRENCE GUARDED: the #4689 probe on master: a write through
	// `pkg-a/src/blink.ts` hosted the file in `pkg-a`'s TypeScript server, the
	// real spelling in `pkg-b`'s; one file, two projects.
	it("a file link and its target get one TypeScript root and one LSP cwd", async (ctx) => {
		const fx = layout("pi-lens-4689-lsp-file-link-");
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		vi.spyOn(process, "cwd").mockReturnValue(fx.repo);

		expect({
			fileIdentity: await TypeScriptServer.root(fx.realFile),
			fileLink: await TypeScriptServer.root(fx.fileLink),
			lspCwd: await resolveLspServerCwd(TypeScriptServer, fx.fileLink, fx.repo),
		}).toEqual({ fileIdentity: fx.pkgB, fileLink: fx.pkgB, lspCwd: fx.pkgB });
	});

	// RECURRENCE GUARDED: the memo half of the probe
	// (`identityGotLinkRoot: true`): the directory-link spelling's walk wrote
	// `pkg-a` under `pkg-b/lib`'s identity key, and the real spelling read it.
	it("a directory link does not hand its spelling's root to the target's memo entry", async (ctx) => {
		const fx = layout("pi-lens-4689-lsp-dir-link-");
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		vi.spyOn(process, "cwd").mockReturnValue(fx.repo);

		// The link spelling walks first, so its answer is what the memo holds
		// when the real spelling asks.
		const dirLink = await TypeScriptServer.root(fx.dirLinkFile);
		const dirIdentity = await TypeScriptServer.root(fx.libFile);
		expect({
			dirLink,
			dirIdentity,
			lspCwd: await resolveLspServerCwd(
				TypeScriptServer,
				fx.dirLinkFile,
				fx.repo,
			),
		}).toEqual({ dirLink: fx.pkgB, dirIdentity: fx.pkgB, lspCwd: fx.pkgB });
	});

	// RECURRENCE GUARDED: a file not written yet resolves its nearest existing
	// ancestor (`realpathOrResolve`), so a new file under a directory link
	// joins the target's project, as it will once it exists.
	it("a new file under a directory link roots at the target's project", async (ctx) => {
		const fx = layout("pi-lens-4689-lsp-new-file-");
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		vi.spyOn(process, "cwd").mockReturnValue(fx.repo);
		const newFile = path.join(path.dirname(fx.dirLinkFile), "new.ts");

		expect(await TypeScriptServer.root(newFile)).toBe(fx.pkgB);
	});

	// RECURRENCE GUARDED: a walk on the identity axis returns `repo/pkg-b`
	// for a file spelled `repo-alias/pkg-b/b.ts`; the session ceiling compared
	// it on the spelling axis and clamped it to the alias session root, so
	// every package of a link-spelled session shared one root. On master the
	// memo produced the same clamp once the real spelling had warmed it.
	it("a link-spelled session root keeps the file's package as its LSP cwd", async (ctx) => {
		const fx = layout("pi-lens-4689-lsp-alias-root-");
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		vi.spyOn(process, "cwd").mockReturnValue(fx.repo);
		const aliasFile = path.join(fx.aliasRoot, "pkg-b", "b.ts");

		const viaReal = await resolveLspServerCwd(
			TypeScriptServer,
			fx.realFile,
			fx.repo,
		);
		const viaAlias = await resolveLspServerCwd(
			TypeScriptServer,
			aliasFile,
			fx.aliasRoot,
		);
		expect({
			viaReal,
			viaAlias: viaAlias && realpathOrResolve(viaAlias),
		}).toEqual({ viaReal: fx.pkgB, viaAlias: fx.pkgB });
	});

	// RECURRENCE GUARDED: the memo key is the identity's directory, so the
	// value stored under it must not depend on the spelling. The walk's own
	// session ceiling read the FILE as spelled: a link inside the session to a
	// project outside it clamped the outside project's root to the session,
	// stored that clamp under the outside directory's key, and the outside
	// file's own spelling then read the session root back.
	it("a link out of the session does not write the session clamp under the target's key", async (ctx) => {
		const fx = layout("pi-lens-4689-lsp-out-link-");
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		vi.spyOn(process, "cwd").mockReturnValue(fx.repo);
		const outside = path.join(fx.base, "outside");
		write(path.join(outside, "package.json"));
		ageDirs(fx.base);
		const outLink = path.join(fx.repo, "src", "out-link.ts");

		await TypeScriptServer.root(outLink);
		expect(await TypeScriptServer.root(path.join(outside, "ext.ts"))).toBe(
			outside,
		);
	});

	// RECURRENCE GUARDED: the stop directory is the walk's other end. A stop
	// spelled through a link (a win32 junction or subst cwd; the alias here)
	// never contains a walk that climbs the identity, so the walk broke on
	// its first step and returned no root at all.
	it("a link-spelled stop directory still bounds a walk that climbs the identity", async (ctx) => {
		const fx = layout("pi-lens-4689-lsp-stop-");
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		vi.spyOn(process, "cwd").mockReturnValue(fx.aliasRoot);
		const root = WorkspacePriorityRoot([["package.json"]]);

		for (const file of [
			fx.realFile,
			path.join(fx.aliasRoot, "pkg-b", "b.ts"),
		]) {
			const found = await root(file);
			expect(found && realpathOrResolve(found), file).toBe(fx.pkgB);
		}
	});
});

describe("#4689 item 6: the refused directories are compared on the identity axis", () => {
	// RECURRENCE GUARDED: `IgnoreHomeRoot` compared the root against
	// `path.resolve(os.homedir())`. With `$HOME` a link (Fedora Silverblue's
	// `/home -> var/home`), a walk that climbs the identity reaches the real
	// home, which never equals the spelled one, and the home's tsconfig
	// became the root of every file below it.
	it("the home directory is refused under both spellings of a link-spelled home", async (ctx) => {
		// The fixture HOME lives outside the deletable test root (#4591): a
		// straggler that inherits HOME must never re-create a removed root.
		const { home: pinnedHome, restore } = pinFixtureHome(
			"pi-lens-4689-lsp-home",
		);
		try {
			const base = path.join(pinnedHome, "project");
			const home = path.join(base, "home-real");
			const homeLink = path.join(base, "home-link");
			write(path.join(base, "package.json"));
			write(path.join(home, "tsconfig.json"));
			write(path.join(home, "proj", "src", "x.ts"), "export {};\n");
			try {
				link("home-real", homeLink);
			} catch (err) {
				return ctx.skip(`cannot create symlinks here: ${String(err)}`);
			}
			vi.stubEnv("HOME", homeLink);
			vi.stubEnv("USERPROFILE", homeLink);
			vi.spyOn(process, "cwd").mockReturnValue(base);
			// The home is read when the server table is built.
			vi.resetModules();
			const server = await import("../../../clients/lsp/server.js");

			for (const file of [
				path.join(homeLink, "proj", "src", "x.ts"),
				path.join(home, "proj", "src", "x.ts"),
			]) {
				const found = await server.TypeScriptServer.root(file);
				expect(
					typeof found === "string" && realpathOrResolve(found),
					file,
				).toBe(realpathOrResolve(base));
			}
		} finally {
			// The stubs recorded the pinned home as their original, so they are
			// undone first and the pin's own undo then restores the real HOME.
			vi.unstubAllEnvs();
			restore();
		}
	});

	// RECURRENCE GUARDED: a `.git` directly at `os.tmpdir()` is never a root.
	// The comparison was against the tmpdir's spelling; on macOS that is
	// `/var/folders/...`, a link to `/private/var/folders/...`, so a walk on
	// the identity axis never matched it.
	it("a .git at a link-spelled tmpdir is refused under both spellings", async (ctx) => {
		const env = setupTestEnvironment("pi-lens-4689-lsp-tmpdir-", {
			// The cell plants its own `.git`, one level down, as the tmpdir's.
			rootMarker: false,
		});
		cleanups.push(env.cleanup);
		const base = env.tmpDir;
		const tmp = path.join(base, "tmp-real");
		const tmpLink = path.join(base, "tmp-link");
		fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
		write(path.join(tmp, "proj", "notes.md"), "# notes\n");
		try {
			link("tmp-real", tmpLink);
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		vi.stubEnv("TMPDIR", tmpLink);
		vi.stubEnv("TMP", tmpLink);
		vi.stubEnv("TEMP", tmpLink);
		vi.spyOn(process, "cwd").mockReturnValue(base);
		const root = NearestRoot([".git"], undefined, base);

		for (const file of [
			path.join(tmpLink, "proj", "notes.md"),
			path.join(tmp, "proj", "notes.md"),
		]) {
			expect(await root(file), file).toBeUndefined();
		}
	});
});

describe("#4689 item 6: the extensions-bounded walk", () => {
	function extensionsLayout(prefix: string) {
		const env = setupTestEnvironment(prefix);
		cleanups.push(env.cleanup);
		const base = env.tmpDir;
		const extensions = path.join(base, "home", ".pi", "agent", "extensions");
		fs.mkdirSync(extensions, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(base);
		return { base, extensions };
	}

	// RECURRENCE GUARDED: the bounded walk climbed the spelling too, so a
	// file link inside one extension rooted at the package the link sits in.
	it("a file link inside an extension roots at its target's package", async (ctx) => {
		const { extensions } = extensionsLayout("pi-lens-4689-lsp-ext-link-");
		const ext = path.join(extensions, "myext");
		const sub = path.join(ext, "sub");
		write(path.join(ext, "package.json"));
		write(path.join(sub, "package.json"));
		write(path.join(sub, "b.ts"), "export const b = 1;\n");
		const fileLink = path.join(ext, "src", "l.ts");
		fs.mkdirSync(path.dirname(fileLink), { recursive: true });
		try {
			fs.symlinkSync(path.join("..", "sub", "b.ts"), fileLink, "file");
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}

		expect(await TypeScriptServer.root(fileLink)).toBe(sub);
	});

	// RECURRENCE GUARDED: an extension under development is linked into the
	// extensions directory (`extensions/myext -> ~/code/myext`). Its identity
	// is outside the boundary, so a climb of the identity never meets the
	// boundary and would escape to any `package.json` above the checkout.
	it("a linked extension directory never escapes the extensions boundary", async (ctx) => {
		const { base, extensions } = extensionsLayout("pi-lens-4689-lsp-ext-dir-");
		const checkout = path.join(base, "code", "myext");
		write(path.join(base, "code", "package.json"));
		write(path.join(checkout, "src", "x.ts"), "export {};\n");
		try {
			link(checkout, path.join(extensions, "myext"));
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		const file = path.join(extensions, "myext", "src", "x.ts");

		const found = await TypeScriptServer.root(file);
		expect(typeof found === "string" && realpathOrResolve(found)).not.toBe(
			path.join(base, "code"),
		);
	});

	// RECURRENCE GUARDED: `~/.pi` kept in a dotfiles checkout and linked into
	// home. The boundary is spelled `~/.pi/agent/extensions`; the identity
	// climbs `~/dotfiles/pi/agent/...`, which the spelled key never matches, so
	// the walk would adopt pi's own `agent/package.json` (#123).
	it("a linked ~/.pi still stops the walk at the extensions boundary", async (ctx) => {
		const env = setupTestEnvironment("pi-lens-4689-lsp-ext-dotfiles-");
		cleanups.push(env.cleanup);
		const base = env.tmpDir;
		const agentReal = path.join(base, "dotfiles", "pi", "agent");
		write(path.join(agentReal, "package.json"));
		write(
			path.join(agentReal, "extensions", "myext", "src", "x.ts"),
			"export {};\n",
		);
		try {
			link(path.join(base, "dotfiles", "pi"), path.join(base, "home", ".pi"));
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		vi.spyOn(process, "cwd").mockReturnValue(base);
		const file = path.join(
			base,
			"home",
			".pi",
			"agent",
			"extensions",
			"myext",
			"src",
			"x.ts",
		);

		const found = await TypeScriptServer.root(file);
		expect(typeof found === "string" && realpathOrResolve(found)).not.toBe(
			agentReal,
		);
	});

	// RECURRENCE GUARDED: review r1 F1 on #4844. A checkout links an extension
	// in (`checkout/packages/myext -> ~/.pi/agent/extensions/myext`). The
	// spelling has no extensions segment, so the boundary was never chosen and
	// the identity climb adopted pi's own `~/.pi/agent/package.json` (#123),
	// which the session ceiling then widened to the whole session.
	it("an extension linked into a checkout never roots at ~/.pi/agent", async (ctx) => {
		const env = setupTestEnvironment("pi-lens-4689-lsp-ext-inward-");
		cleanups.push(env.cleanup);
		const base = env.tmpDir;
		const agent = path.join(base, "home", ".pi", "agent");
		write(path.join(agent, "package.json"));
		const ext = path.join(agent, "extensions", "myext");
		write(path.join(ext, "src", "x.ts"), "export {};\n");
		const work = path.join(base, "work");
		const checkout = path.join(work, "checkout");
		write(path.join(checkout, "package.json"));
		try {
			link(ext, path.join(checkout, "packages", "myext"));
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		vi.spyOn(process, "cwd").mockReturnValue(work);
		const file = path.join(checkout, "packages", "myext", "src", "x.ts");

		const found = await TypeScriptServer.root(file);
		expect(typeof found === "string" && realpathOrResolve(found)).toBe(
			realpathOrResolve(checkout),
		);
		const cwd = await resolveLspServerCwd(TypeScriptServer, file, work);
		expect(cwd && realpathOrResolve(cwd)).toBe(realpathOrResolve(checkout));
	});
});

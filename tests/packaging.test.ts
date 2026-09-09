import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { describe, expect, it } from "vitest";
import {
	HOST_PROVIDED_PACKAGES,
	HOST_PROVIDED_RUNTIME_PACKAGES,
	HOST_PROVIDED_TYPE_ONLY_PACKAGES,
	LAZY_NATIVE_PACKAGES,
} from "../scripts/lib/host-provided-deps.mjs";
import { USER_PROFILE_PATH_RE } from "./support/user-profile-path-pattern.js";

// These tests pin the published-package contract: pi-lens ships a precompiled
// dist/ and points its entry at compiled JS, so pi does NOT jiti-transpile ~200
// TypeScript files on every startup (issue #182). A regression here silently
// reintroduces the ~3.5s cold-start cost, so guard it statically.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
	main?: string;
	files?: string[];
	scripts?: Record<string, string>;
	pi?: { extensions?: string[]; skills?: string[] };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	allowScripts?: Record<string, boolean>;
};

const lock = JSON.parse(
	fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
) as {
	packages?: {
		"node_modules/@ast-grep/cli"?: {
			version?: string;
			hasInstallScript?: boolean;
		};
		"node_modules/@earendil-works/pi-tui"?: {
			version?: string;
		};
	};
};

describe("published package entry points (dist mode, #182)", () => {
	it("allows the exact ast-grep CLI version with an install script (#2401)", () => {
		const cli = lock.packages?.["node_modules/@ast-grep/cli"];
		const version = cli?.version;
		expect(version, "lockfile must pin @ast-grep/cli").toBeTruthy();
		expect(cli?.hasInstallScript).toBe(true);
		expect(pkg.allowScripts?.[`@ast-grep/cli@${version}`]).toBe(true);
	});

	it("main points at the compiled dist entry", () => {
		expect(pkg.main).toBe("./dist/index.js");
	});

	it("every pi.extensions entry is a compiled dist .js file", () => {
		const exts = pkg.pi?.extensions ?? [];
		expect(exts.length).toBeGreaterThan(0);
		for (const e of exts) {
			expect(e, e).toMatch(/^\.\/dist\/.+\.js$/);
		}
	});

	it("ships dist/ and never TypeScript source in the npm tarball", () => {
		const files = pkg.files ?? [];
		expect(files).toContain("dist/");
		for (const f of files) {
			// A .ts entry (or a clients/commands/tools source glob) would put pi
			// back on the jiti transpile-on-startup path.
			expect(f.endsWith(".ts"), `files must not ship TS source: ${f}`).toBe(
				false,
			);
		}
	});

	it("prepare builds dist on install (incl. git) and before publish", () => {
		// `prepare` (not `prepack`) is required so a `git:` install — which runs
		// `npm install`, not `npm pack` — also gets the compiled dist (#182).
		expect(pkg.scripts?.prepare ?? "").toContain("build:dist");
		expect(pkg.scripts?.["build:dist"] ?? "").toContain("tsconfig.dist.json");
	});

	it("pi.skills resolves PACKAGE-ROOT-relative and never escapes the package (#2587)", () => {
		// Guards the recurrence of #2587: a `pi.skills` entry that leaves the
		// package, so none of the shipped skills register on any install.
		//
		// pi's real resolver — `PackageManager#collectFilesFromManifestEntries` in
		// `@earendil-works/pi-coding-agent` `dist/core/package-manager.js`
		// (this non-glob branch is identical in 0.78.1, 0.84.1 and 0.85.1; the
		// glob branch was refactored into `expandPackageGlob` in 0.85.1):
		//
		//     if (!hasGlobPattern(entry)) return [resolve(root, entry)];
		//
		// where `root` is the PACKAGE ROOT (the dir holding package.json), passed
		// down from `addManifestEntries(entries, packageRoot, …)`. It is NOT the
		// extension entry file and NOT `dist/`. #199 assumed entry-file-relative
		// resolution and set `["../../skills"]`; from any real install root
		// (`…/node_modules/pi-lens`) that lands two levels OUTSIDE the package, so
		// pi loaded zero skills everywhere — and the #199 test replicated the
		// guessed resolver instead of pi's, so CI stayed green for four releases.
		const resolveLikePi = (packageRoot: string, entry: string) =>
			path.resolve(packageRoot, entry);
		const inside = (packageRoot: string, resolved: string) =>
			resolved === packageRoot || resolved.startsWith(packageRoot + path.sep);

		const skills = pkg.pi?.skills ?? [];
		expect(
			skills.length,
			"pi.skills must declare the shipped dir",
		).toBeGreaterThan(0);
		expect(pkg.files ?? [], "skills/ must ship in the tarball").toContain(
			"skills/",
		);
		// One skills tree only: a second copy under dist/ would ship dead weight.
		expect(pkg.scripts?.["build:dist"] ?? "").not.toContain("dist/skills");

		// The published package root is wherever the installer puts it, so assert
		// containment against a SYNTHETIC root too — the property belongs to the
		// entry string, not to this checkout's location on disk.
		const installRoot = path.resolve(
			path.sep,
			"pi",
			"agent",
			"npm",
			"node_modules",
			"pi-lens",
		);
		const rootSkills = path.resolve(root, "skills");
		for (const entry of skills) {
			// The replication above only covers pi's non-glob branch.
			expect(
				/[*?]/.test(entry),
				`pi.skills "${entry}" must not be a glob (pi takes a different branch)`,
			).toBe(false);
			expect(
				resolveLikePi(root, entry),
				`pi.skills "${entry}" must resolve (package-root-relative) to the root skills/ dir`,
			).toBe(rootSkills);
			expect(
				inside(installRoot, resolveLikePi(installRoot, entry)),
				`pi.skills "${entry}" escapes the installed package: ${resolveLikePi(installRoot, entry)}`,
			).toBe(true);
		}
		expect(
			fs.existsSync(path.join(rootSkills, "pi-lens-ast-grep", "SKILL.md")),
			"the resolved skills dir must actually hold SKILL.md files",
		).toBe(true);
	});

	it("bundles core grammars via prepare and ships them in the tarball", () => {
		// Core grammars are downloaded at `prepare` time into grammars/ (shipped in
		// files[]); the tail lazy-fetches at runtime. There is intentionally NO
		// postinstall (it was npm-only and pnpm/bun blocked it) — see the grammar
		// distribution note in AGENTS.md.
		expect(pkg.scripts?.prepare ?? "").toContain("download-grammars");
		expect(pkg.files ?? []).toContain("grammars/");
		expect(pkg.files ?? []).toContain("scripts/download-grammars.js");
		expect(
			pkg.scripts?.postinstall,
			"postinstall was removed — grammars ship bundled + lazy-fetch",
		).toBeUndefined();
	});

	it("wires the bundle step into build:dist after tsc (#335, #2593)", () => {
		const bd = pkg.scripts?.["build:dist"] ?? "";
		// tsc (isolated via scripts/build-dist-tsc.mjs, #2593) must run before
		// the bundle (bundle collapses the tsc emit).
		expect(bd).toContain("bundle:dist");
		expect(bd).toContain("build-dist-tsc.mjs");
		expect(bd.indexOf("tsconfig.dist.json")).toBeLessThan(
			bd.indexOf("bundle:dist"),
		);
		expect(bd.indexOf("build-dist-tsc.mjs")).toBeLessThan(
			bd.indexOf("bundle:dist"),
		);
		expect(pkg.scripts?.["bundle:dist"] ?? "").toContain("bundle-dist.mjs");
	});
});

// #1926: pi provides these packages from its own runtime. Declaring one in
// `dependencies` makes `npm install --omit=dev` — the command pi runs for a
// `git:` install — vendor a private second copy, which Node then evaluates at
// import. That cost the git install 720ms of an 838ms module import, while the
// npm path (where the copies are absent) stayed cheap. The declaration shape is
// the fix, so pin it: optional peer for the runtime contract, devDependency so
// local builds and CI still type-check, and never a runtime dependency.
describe("host-provided packages are not vendored (#1926)", () => {
	const deps = pkg.dependencies ?? {};
	const devDeps = pkg.devDependencies ?? {};
	const peers = pkg.peerDependencies ?? {};
	const peerMeta = pkg.peerDependenciesMeta ?? {};

	it("lists at least one host-provided package to guard", () => {
		// Guards the guard: an emptied HOST_PROVIDED_PACKAGES would make every
		// per-package assertion below vacuously pass.
		expect(HOST_PROVIDED_PACKAGES.length).toBeGreaterThan(0);
	});

	it("ships the shared list, because install-selftest.mjs imports it", () => {
		// scripts/install-selftest.mjs runs FROM THE INSTALLED PACKAGE in the
		// install-smoke job (`require.resolve("pi-lens/scripts/install-selftest.mjs")`)
		// and imports the list to subtract host-provided specifiers. If the module
		// is not in files[], that import throws in the tarball and the whole
		// selftest dies (#1926).
		const files = pkg.files ?? [];
		expect(files).toContain("scripts/lib/host-provided-deps.mjs");
		const selftest = fs.readFileSync(
			path.join(root, "scripts", "install-selftest.mjs"),
			"utf8",
		);
		expect(selftest).toContain("lib/host-provided-deps.mjs");
	});

	it("ships scripts/lib/skills-predicate.mjs, because install-selftest.mjs imports it too (#2626)", () => {
		// Same shape as host-provided-deps.mjs above, one module later: the
		// shared skill-discovery predicate (#2626 review round 2, F2) folds
		// `install-selftest.mjs`'s manifest-resolution probe AND
		// `clients/skills-resolver.ts`'s health check onto ONE walk. If this
		// file is missing from files[], the installed selftest's import throws
		// in the tarball, same failure mode #1926 guards for the sibling list.
		const files = pkg.files ?? [];
		expect(files).toContain("scripts/lib/skills-predicate.mjs");
		const selftest = fs.readFileSync(
			path.join(root, "scripts", "install-selftest.mjs"),
			"utf8",
		);
		expect(selftest).toContain("lib/skills-predicate.mjs");
	});

	it("splits host-provided packages into runtime and type-only, with no overlap", () => {
		// CI installs the RUNTIME half before a bare `node dist/index.js` smoke
		// check, because bare node is not pi. It must never install the type-only
		// half: that tree's nested paths exceed Windows MAX_PATH (#1334 S6). A
		// package landing in both halves, or in neither, breaks that split.
		expect(HOST_PROVIDED_RUNTIME_PACKAGES.length).toBeGreaterThan(0);
		expect(HOST_PROVIDED_TYPE_ONLY_PACKAGES.length).toBeGreaterThan(0);
		const overlap = HOST_PROVIDED_RUNTIME_PACKAGES.filter((name) =>
			HOST_PROVIDED_TYPE_ONLY_PACKAGES.includes(name),
		);
		expect(overlap, "a package cannot be both runtime and type-only").toEqual(
			[],
		);
		expect([...HOST_PROVIDED_PACKAGES].sort()).toEqual(
			[
				...HOST_PROVIDED_RUNTIME_PACKAGES,
				...HOST_PROVIDED_TYPE_ONLY_PACKAGES,
			].sort(),
		);
	});

	it("value-imported host packages are the runtime half, not the type-only half", () => {
		// Derived from source. A `clients/deps/*.ts` seam that value-imports a
		// host package proves that package must exist at runtime, so CI has to
		// supply it. Listing it as type-only instead would make the smoke check
		// allow a real load failure.
		const seamDir = path.join(root, "clients", "deps");
		for (const file of fs.readdirSync(seamDir)) {
			if (!file.endsWith(".ts")) continue;
			const text = fs.readFileSync(path.join(seamDir, file), "utf8");
			for (const line of text.split("\n")) {
				if (/^\s*(?:import|export)\s+type\b/.test(line)) continue;
				const m = line.match(
					/^\s*(?:import|export)\b[^;"']*\bfrom\s*["']([^"'.][^"']*)["']/,
				);
				const name = m?.[1];
				if (!name || !HOST_PROVIDED_PACKAGES.includes(name)) continue;
				expect(
					HOST_PROVIDED_TYPE_ONLY_PACKAGES.includes(name),
					`${name} is value-imported by ${file}, so it cannot be type-only`,
				).toBe(false);
				expect(
					HOST_PROVIDED_RUNTIME_PACKAGES.includes(name),
					`${name} is value-imported by ${file}, so it belongs in the runtime half`,
				).toBe(true);
			}
		}
	});

	it("lists every dep seam package that nothing installs", () => {
		// Derived from source, so dropping an entry from HOST_PROVIDED_PACKAGES
		// does not quietly drop its guard. Every package a `clients/deps/*.ts`
		// seam VALUE-imports must be installed by something — a runtime
		// dependency, an optional dependency — or else supplied by pi. If it is
		// in neither install list, it can only come from the host, so it belongs
		// on the host-provided list.
		const optionalDeps =
			(pkg as { optionalDependencies?: Record<string, string> })
				.optionalDependencies ?? {};
		const seamDir = path.join(root, "clients", "deps");
		const valueImported = new Set<string>();
		for (const file of fs.readdirSync(seamDir)) {
			if (!file.endsWith(".ts")) continue;
			const text = fs.readFileSync(path.join(seamDir, file), "utf8");
			for (const line of text.split("\n")) {
				// `import type` / `export type` are erased at compile time and never
				// need the package to exist at runtime.
				if (/^\s*(?:import|export)\s+type\b/.test(line)) continue;
				const m = line.match(
					/^\s*(?:import|export)\b[^;"']*\bfrom\s*["']([^"'.][^"']*)["']/,
				);
				if (m && !m[1].startsWith("node:")) valueImported.add(m[1]);
			}
		}
		expect(valueImported.size).toBeGreaterThan(0);

		const uninstalled = [...valueImported].filter(
			(name) =>
				!Object.hasOwn(deps, name) && !Object.hasOwn(optionalDeps, name),
		);
		expect(uninstalled.length).toBeGreaterThan(0);
		for (const name of uninstalled) {
			expect(
				HOST_PROVIDED_PACKAGES.includes(name),
				`${name} is value-imported by a clients/deps seam but no install ` +
					"list provides it — declare it host-provided or make it a dependency",
			).toBe(true);
		}
	});

	for (const name of HOST_PROVIDED_PACKAGES) {
		it(`${name} is never a runtime dependency`, () => {
			expect(
				Object.hasOwn(deps, name),
				`${name} is host-provided: a runtime dependency vendors a second ` +
					"copy into the git install and re-evaluates it at import (#1926)",
			).toBe(false);
		});

		it(`${name} is an optional peer dependency`, () => {
			expect(
				Object.hasOwn(peers, name),
				`${name} missing from peerDependencies`,
			).toBe(true);
			// Without `optional: true`, npm 7+ installs the peer anyway and the
			// second copy comes back.
			expect(
				peerMeta[name]?.optional,
				`${name} must be peerDependenciesMeta.optional`,
			).toBe(true);
		});

		it(`${name} is a devDependency so builds and tests resolve it`, () => {
			expect(
				Object.hasOwn(devDeps, name),
				`${name} must be a devDependency (types + local test resolution)`,
			).toBe(true);
		});
	}

	it("native/wasm packages keep shipping with the extension", () => {
		// The other half of the external list is NOT host-provided: pi does not
		// ship @ast-grep/napi or web-tree-sitter, so those must keep installing
		// with the extension, as a runtime or optional dependency. Demoting one to
		// a host-provided peer would break analysis at runtime.
		const optionalDeps =
			(pkg as { optionalDependencies?: Record<string, string> })
				.optionalDependencies ?? {};
		for (const name of LAZY_NATIVE_PACKAGES) {
			expect(
				Object.hasOwn(deps, name) || Object.hasOwn(optionalDeps, name),
				`${name} must stay a runtime or optional dependency`,
			).toBe(true);
			expect(
				HOST_PROVIDED_PACKAGES.includes(name),
				`${name} is not host-provided`,
			).toBe(false);
		}
	});
});

// #2586: `^0.84.1` on a 0.x host version pins the minor (npm's caret on a
// pre-1.0 version only floats the patch), so a real pi-coding-agent/pi-tui
// 0.85.x host was excluded by declaration even though the nightly real-pi
// compat smoke already runs green against it and pi-tui 0.85.1 still exports
// every symbol `clients/deps/pi-tui.ts` consumes. The declared peer range
// must accept every host version this repo has actually verified — no more,
// no less: broadening past what is tested (e.g. asserting 0.86.0 is accepted)
// would silently re-open the same gap the next incompatible minor creates.
describe("pi-tui peer range covers every tested host version (#2586)", () => {
	const peerRange = pkg.peerDependencies?.["@earendil-works/pi-tui"];

	// Derived from the lockfile so this list cannot silently drift from what
	// the unit suite actually installs and runs against; "0.85.1" is also
	// named literally per the issue's acceptance criterion, even though it
	// coincides with the lockfile-derived entry after the devDependency bump.
	// "0.84.1" pins the LOW end of the range explicitly (#2586 review F3):
	// the lockfile-derived entry alone dedupes to a single 0.85.1 value once
	// the devDependency is bumped, so a mutation that silently drops 0.84.x
	// support (e.g. narrowing the range to "^0.85.0") would stay green
	// without it. #257's install-selftest.mjs cites 0.84.1 as a version this
	// repo already verified pi's package-manager resolver against, so it's
	// not an arbitrary floor.
	const lockVersion =
		lock.packages?.["node_modules/@earendil-works/pi-tui"]?.version;
	const testedVersions = [
		...new Set([lockVersion, "0.85.1", "0.84.1"].filter(Boolean)),
	] as string[];

	it("lists at least one tested version to guard", () => {
		// Guards the guard: an emptied testedVersions would make the loop below
		// vacuously pass.
		expect(testedVersions.length).toBeGreaterThan(0);
	});

	it("declares a peer range", () => {
		expect(
			peerRange,
			"peerDependencies must declare @earendil-works/pi-tui",
		).toBeTruthy();
	});

	for (const version of testedVersions) {
		it(`accepts tested host version ${version}`, () => {
			expect(
				semver.satisfies(version, peerRange ?? ""),
				`peerDependencies["@earendil-works/pi-tui"] (${peerRange}) must accept ${version}`,
			).toBe(true);
		});
	}

	it("does not broaden acceptance past a tested minor (0.86.0 stays out)", () => {
		// #2586's fix widens the range to cover exactly the 0.84.x/0.85.x hosts
		// this repo has compat evidence for. Asserting a not-yet-released,
		// not-yet-tested 0.86.0 is accepted would mask the exact declaration
		// gap this suite exists to catch the next time pi ships a new minor.
		expect(semver.satisfies("0.86.0", peerRange ?? "")).toBe(false);
	});
});

// Guards the #335 bundle CONTRACT against the built entry: pi's Bun-compiled
// host cannot resolve a bare specifier from the extension's node_modules, so the
// bundle must inline the pure-JS deps and keep only host-provided + native/wasm
// packages external. dist/ is gitignored, so this only runs post-build (CI runs
// build:dist before the suite); a source-only checkout skips it.
describe("bundled dist entry shape (#335)", () => {
	const distEntry = path.join(root, "dist", "index.js");
	const built = fs.existsSync(distEntry);
	const src = built ? fs.readFileSync(distEntry, "utf8") : "";

	it.runIf(built)("inlines the pure-JS deps (no bare import at load)", () => {
		for (const dep of ["minimatch", "js-yaml", "vscode-jsonrpc"]) {
			const bareImport = src.includes(`from "${dep}"`);
			const bareRequire =
				src.includes(`require("${dep}")`) || src.includes(`require('${dep}')`);
			expect(
				bareImport || bareRequire,
				`${dep} must be inlined, not bare-imported`,
			).toBe(false);
		}
	});

	it.runIf(built)(
		"carries exactly ONE require banner (bundle is idempotent)",
		() => {
			// The banner line mentions __pilensCreateRequire twice (import alias +
			// call). A doubled banner — the pre-guard artifact of running
			// `bundle:dist` standalone on an already-bundled entry — would show 4 and
			// fail to load ("Identifier ... has already been declared").
			const count = src.match(/__pilensCreateRequire/g)?.length ?? 0;
			expect(count).toBe(2);
		},
	);

	it.runIf(built)("keeps host-provided packages external", () => {
		// Derived from the same list bundle-dist.mjs uses (#1926), so the bundle
		// contract and the dependency contract cannot drift apart. Only the ones
		// the entry actually imports are asserted; pi-coding-agent is types-only.
		const imported = HOST_PROVIDED_PACKAGES.filter((dep) =>
			src.includes(`"${dep}"`),
		);
		expect(imported.length).toBeGreaterThan(0);
		for (const dep of imported) {
			expect(
				src.includes(`from "${dep}"`),
				`${dep} must stay an external import`,
			).toBe(true);
		}
	});

	it.runIf(built)(
		"resolves native/wasm via file:// URL, not a bare specifier",
		() => {
			// A raw absolute path is not a valid Windows import specifier; both lazy
			// accessors must convert the createRequire-resolved path via
			// pathToFileURL before dynamic-importing. web-tree-sitter's exports map
			// has only the `.` entry, so the bare package name is resolved (never a
			// custom subpath). esbuild suffixes the require var (_require2 etc.), so
			// match the .resolve(<pkg>) call shape rather than the exact var name.
			expect(src).toMatch(/\.resolve\("@ast-grep\/napi"\)/);
			expect(src).toMatch(/\.resolve\("web-tree-sitter"\)/);
			expect(src).not.toContain('.resolve("web-tree-sitter/tree-sitter');
			expect(src).toContain("pathToFileURL");
		},
	);

	// #2594 review F1/F2: scripts/bundle-dist.mjs's `npm exec --package
	// esbuild@…` spawn originally ran with `cwd: root`, but esbuild bakes its
	// bundled-module-path banner COMMENTS relative to esbuild's own cwd. A
	// since-reverted fix moved that cwd to a temp directory to dodge a
	// project-tree dependency collision (#2590) and, as a side effect, baked
	// the temp path (and this machine's home directory, via the temp dir's
	// full path) into every one of those comments in the shipped
	// dist/index.js — the exact #1718/#1728 hardcoded-machine-path shape,
	// just introduced by the bundler instead of a hand-typed literal. The fix
	// keeps `cwd: root` (so esbuild's own relative paths stay correct) and
	// isolates npm's tree lookup via `--prefix` instead. Reuses the same
	// regex `tests/scripts/no-hardcoded-machine-paths.test.ts` scans source
	// with, so the two guards cannot drift onto different patterns.
	it.runIf(built)("bakes no user-profile absolute path into the bundle", () => {
		// Reviewed, named exception — never a blanket skip (same policy as
		// no-hardcoded-machine-paths.test.ts's own ALLOWLIST). This is a real,
		// pre-existing, unrelated match: clients/knip-client.ts's own doc
		// comment discusses a historical incident with the literal example path
		// "/home/v" (a one-letter example username), which the regex's
		// `[A-Za-z0-9_.-]+` (1-or-more) legitimately matches. It has nothing to
		// do with this bundle's build tooling and is present in every build,
		// buggy or not — excluding it by exact value leaves the check exactly as
		// strict against the actual defect shape (hundreds of distinct
		// `/home/<real-user>` occurrences from esbuild's own banner comments).
		const KNOWN_BENIGN_MATCHES = new Set(["/home/v"]);
		const matches = (src.match(USER_PROFILE_PATH_RE) ?? []).filter(
			(m) => !KNOWN_BENIGN_MATCHES.has(m),
		);
		expect(matches).toEqual([]);
	});
});

describe("tsconfig.dist.json", () => {
	const dist = JSON.parse(
		fs.readFileSync(path.join(root, "tsconfig.dist.json"), "utf8"),
	) as {
		compilerOptions?: { outDir?: string; types?: string[]; allowJs?: boolean };
		exclude?: string[];
		include?: string[];
	};

	it("emits to ./dist", () => {
		expect(dist.compilerOptions?.outDir).toBe("./dist");
	});

	it("excludes tests from the published build", () => {
		const ex = dist.exclude ?? [];
		expect(ex.some((e) => e.includes("test"))).toBe(true);
	});

	it("does not require @types/node during production install-time dist builds", () => {
		// pi installs git extensions with `npm install --omit=dev`, then npm runs
		// `prepare`. In that environment dev-only @types/node is absent, so the
		// dist config must not inherit the base config's `types: ["node"]` entry.
		expect(dist.compilerOptions?.types).toEqual([]);
	});

	it("compiles the shared process-table seam into dist so esbuild can inline it", () => {
		// #2443: `clients/process-snapshot.ts` imports
		// `../scripts/lib/process-scan.mjs` (the seam lives in scripts/ because
		// the worktree-hygiene hooks run before anything is built — see that
		// file's header). tsc resolves its TYPES from the sibling `.d.mts` and
		// would emit no JS at all, leaving `dist/clients/process-snapshot.js`
		// importing a file that is not there — and `bundle:dist` then dies with
		// "Could not resolve". Naming the .mjs in `include` (with `allowJs`)
		// puts it at `dist/scripts/lib/process-scan.mjs`, exactly where that
		// relative specifier lands.
		expect(dist.compilerOptions?.allowJs).toBe(true);
		expect(dist.include ?? []).toContain("scripts/lib/process-scan.mjs");
	});

	it("compiles the shared skills predicate into dist so esbuild can inline it (#2626)", () => {
		// Same failure mode as process-scan.mjs above: `clients/skills-resolver.ts`
		// imports `../scripts/lib/skills-predicate.mjs`, and without this entry
		// `bundle:dist` dies trying to resolve it from `dist/clients/`.
		expect(dist.include ?? []).toContain("scripts/lib/skills-predicate.mjs");
	});

	it("keeps tsconfig.dist.json parseable as strict JSON", () => {
		// This suite reads it with JSON.parse, and so does anything else that
		// treats a tsconfig as data rather than handing it to tsc: a `//`
		// comment here fails at read time, not at build time.
		expect(() =>
			JSON.parse(
				fs.readFileSync(path.join(root, "tsconfig.dist.json"), "utf8"),
			),
		).not.toThrow();
	});
});

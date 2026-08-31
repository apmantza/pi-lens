import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	HOST_PROVIDED_PACKAGES,
	HOST_PROVIDED_RUNTIME_PACKAGES,
	HOST_PROVIDED_TYPE_ONLY_PACKAGES,
	LAZY_NATIVE_PACKAGES,
} from "../scripts/lib/host-provided-deps.mjs";

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

	it("pi.skills resolves (from the dist entry FILE) back to the real root skills/", () => {
		// pi resolves each `pi.skills` entry relative to the extension entry's
		// **file path** (`dist/index.js`), via `path.resolve(entryFile, skill)` —
		// NOT relative to the entry's directory. So a leading `../` only cancels
		// `index.js` and stays inside `dist/`; reaching the real root `skills/`
		// from `dist/index.js` needs to climb TWO levels: `../../skills`. Getting
		// this wrong (`../skills` → `dist/skills`, missing) silently stops skills
		// from loading and emits pi's "skill path does not exist" warning — and the
		// tarball `skills/` check below does NOT catch it (the dir ships fine; pi
		// just resolves to the wrong place). Verified against pi's resolver. #199.
		expect(pkg.pi?.skills ?? []).toContain("../../skills");
		expect(pkg.scripts?.["build:dist"] ?? "").not.toContain("dist/skills");
		expect(pkg.files ?? []).toContain("skills/");

		// Static guard replicating pi's resolution: joining each pi.skills entry to
		// the extension entry FILE must land on the package's own root skills/ dir.
		const entry = pkg.pi?.extensions?.[0];
		expect(entry, "pi.extensions[0] must exist").toBeTruthy();
		const entryFile = path.resolve(root, entry as string);
		const rootSkills = path.resolve(root, "skills");
		for (const skill of pkg.pi?.skills ?? []) {
			expect(
				path.resolve(entryFile, skill),
				`pi.skills "${skill}" must resolve (entry-file-relative) to the root skills/ dir`,
			).toBe(rootSkills);
		}
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

	it("wires the bundle step into build:dist after tsc (#335)", () => {
		const bd = pkg.scripts?.["build:dist"] ?? "";
		// tsc must run before the bundle (bundle collapses the tsc emit).
		expect(bd).toContain("bundle:dist");
		expect(bd.indexOf("tsconfig.dist.json")).toBeLessThan(
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
});

describe("tsconfig.dist.json", () => {
	const dist = JSON.parse(
		fs.readFileSync(path.join(root, "tsconfig.dist.json"), "utf8"),
	) as {
		compilerOptions?: { outDir?: string; types?: string[] };
		exclude?: string[];
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
});

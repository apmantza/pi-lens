import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
};

describe("published package entry points (dist mode, #182)", () => {
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

	it("pi.skills resolves (from the dist entry) back to the real root skills/", () => {
		// pi resolves pi.skills relative to the extension entry's directory
		// (`dist/`). With `pi.extensions: ["./dist/index.js"]`, `pi.skills` must be
		// "../skills" so it points at the package's real root skills/ dir — not
		// "./skills" (→ dist/skills, which doesn't exist and collides) and not a
		// copy into dist/ (which created a duplicate source → skill collision).
		expect(pkg.pi?.skills ?? []).toContain("../skills");
		expect(pkg.scripts?.["build:dist"] ?? "").not.toContain("dist/skills");
		expect(pkg.files ?? []).toContain("skills/");
	});

	it("retains the postinstall grammar download (shipped as .js)", () => {
		expect(pkg.scripts?.postinstall ?? "").toContain("download-grammars");
		expect(pkg.files ?? []).toContain("scripts/download-grammars.js");
	});
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

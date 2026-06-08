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
	pi?: { extensions?: string[] };
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

	it("prepack builds dist so the tarball is always compiled", () => {
		expect(pkg.scripts?.prepack ?? "").toContain("build:dist");
		expect(pkg.scripts?.["build:dist"] ?? "").toContain("tsconfig.dist.json");
	});

	it("retains the postinstall grammar download (shipped as .js)", () => {
		expect(pkg.scripts?.postinstall ?? "").toContain("download-grammars");
		expect(pkg.files ?? []).toContain("scripts/download-grammars.js");
	});
});

describe("tsconfig.dist.json", () => {
	const dist = JSON.parse(
		fs.readFileSync(path.join(root, "tsconfig.dist.json"), "utf8"),
	) as { compilerOptions?: { outDir?: string }; exclude?: string[] };

	it("emits to ./dist", () => {
		expect(dist.compilerOptions?.outDir).toBe("./dist");
	});

	it("excludes tests from the published build", () => {
		const ex = dist.exclude ?? [];
		expect(ex.some((e) => e.includes("test"))).toBe(true);
	});
});

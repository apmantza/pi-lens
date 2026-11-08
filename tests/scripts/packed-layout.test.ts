/**
 * #3219: the published package loads only from the bundled tree. The live
 * tarball check is in tests/packaging-pack-manifest.test.ts (it needs the real
 * `npm pack`); this file pins the checker and the layout contract without one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPLIT_ENTRIES } from "../../scripts/bundle-dist.mjs";
import {
	packedImportResolutionViolations,
	packedLayoutViolations,
} from "../../scripts/lib/packed-layout.mjs";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

function check(files: Record<string, string>): string[] {
	return packedLayoutViolations(Object.keys(files), (p) => files[p] ?? "");
}

describe("packedLayoutViolations (#3219)", () => {
	it("accepts a bundled layout that references only bundled files", () => {
		expect(
			check({
				"dist/index.js":
					'const w = new URL("./workers/a-worker.js", import.meta.url);',
				"dist/mcp/cli.js": 'import { x } from "../chunk-ABC.js";',
				"dist/chunk-ABC.js": 'export const x = await import("./chunk-DEF.js");',
				"dist/chunk-DEF.js": "export {};",
				"rules/r.yml": 'from "../dist/clients/not-js.js"',
			}),
		).toEqual([]);
	});

	it("flags a shipped file under dist/clients or dist/tools", () => {
		expect(check({ "dist/clients/a.js": "", "dist/tools/b.js": "" })).toEqual([
			"ships unbundled dist/clients/a.js",
			"ships unbundled dist/tools/b.js",
		]);
	});

	it.each([
		[
			"a static import",
			'import { a } from "../clients/a.js";',
			"dist/mcp/cli.js",
		],
		["a side-effect import", 'import "../tools/b.js";', "dist/mcp/cli.js"],
		[
			"a dynamic import",
			'await import("../clients/installer/index.js");',
			"dist/mcp/cli.js",
		],
		[
			"a new URL reach-back",
			'new URL("./clients/w.js", import.meta.url);',
			"dist/index.js",
		],
	])("flags %s into the unbundled tree", (_name, text, file) => {
		expect(check({ [file]: text })).toHaveLength(1);
	});
});

describe("packedImportResolutionViolations (#5365)", () => {
	function checkImports(files: Record<string, string>): string[] {
		return packedImportResolutionViolations(
			Object.keys(files),
			(p) => files[p] ?? "",
		);
	}

	it("accepts a pack whose every relative specifier names a packed file", () => {
		expect(
			checkImports({
				"scripts/install-selftest.mjs":
					'import { p } from "./lib/pred.mjs";\nconst m = await import("./lib/mod.mjs");',
				"scripts/lib/pred.mjs": "export const p = 1;",
				"scripts/lib/mod.mjs": "export const m = 1;",
				"dist/index.js": 'export * from "./chunk-A.js";',
				"dist/chunk-A.js": 'import "./nested/index.js";',
				"dist/nested/index.js": "export {};",
			}),
		).toEqual([]);
	});

	it("flags a packed script that imports a file the pack does not carry (#5364 shape)", () => {
		// The regression the issue names: `scripts/analyze-pi-lens-logs.mjs`
		// imported `./lib/latency-stats.mjs`, which `files[]` did not list. The
		// file exists on disk, so a source-tree resolution check passes; only the
		// pack list makes the import a failure.
		expect(
			checkImports({
				"scripts/analyze-pi-lens-logs.mjs":
					'import { pct } from "./lib/latency-stats.mjs";',
				"scripts/lib/other.mjs": "export const o = 1;",
			}),
		).toEqual([
			'scripts/analyze-pi-lens-logs.mjs: import "./lib/latency-stats.mjs" is not in the package',
		]);
	});

	it.each([
		["an export-from", 'export * from "./missing.js";'],
		["a side-effect import", 'import "./missing.js";'],
		["a dynamic import", 'await import("./missing.js");'],
		["a require", 'const m = require("./missing.js");'],
		["a require.resolve", 'require.resolve("./missing.js");'],
	])("flags %s of an unpacked file", (_name, text) => {
		expect(
			checkImports({ "scripts/a.mjs": text, "package.json": "{}" }),
		).toEqual(['scripts/a.mjs: import "./missing.js" is not in the package']);
	});

	it("resolves an extensionless and a directory specifier inside the pack", () => {
		expect(
			checkImports({
				"scripts/a.mjs":
					'import { x } from "./lib/mod";\nimport { d } from "./lib/dir";',
				"scripts/lib/mod.mjs": "export const x = 1;",
				"scripts/lib/dir/index.js": "export const d = 1;",
			}),
		).toEqual([]);
		// A TS twin is not a published twin: the pack ships no .ts file, so an
		// import that only resolves to one is exactly the #5365 defect.
		expect(
			checkImports({
				"scripts/a.mjs": 'import { x } from "./lib/mod";',
				"scripts/lib/mod.ts": "export const x = 1;",
			}),
		).toEqual(['scripts/a.mjs: import "./lib/mod" is not in the package']);
	});

	it("ignores bare specifiers and specifiers inside comments", () => {
		expect(
			checkImports({
				"dist/index.js": [
					'import { readFileSync } from "node:fs";',
					'import { a } from "@modelcontextprotocol/sdk/client/index.js";',
					'// a doc comment: from "../providers/cline/cline-auth"',
					"/* block: import './missing.js' */",
				].join("\n"),
				"package.json": "{}",
			}),
		).toEqual([]);
	});

	it("flags a computed specifier as a failure instead of passing it", () => {
		// #4314: 4.4.2 shipped `import(["./lsp", "capabilities.js"].join("/"))`, a
		// file no build ever produced. An argument the check cannot read as a
		// literal is a finding, never a silent skip.
		expect(
			checkImports({
				"dist/index.js": 'import(["./lsp", "capabilities.js"].join("/"));',
				"package.json": "{}",
			}),
		).toEqual([
			'dist/index.js: computed dynamic import (["./lsp", "capabilities.js"].join("/"))',
		]);
		expect(
			checkImports({
				"dist/index.js": "const n = x; await import(`./lsp/${n}.js`);",
				"package.json": "{}",
			}),
		).toEqual(["dist/index.js: computed dynamic import (`./lsp/${n}.js`)"]);
	});

	it("admits the computed arguments that name no packed file, and no other", () => {
		// Every computed `import`/`require` argument in the 4.4.10 pack, as the
		// probe over `npm pack --dry-run` lists them. None names a `./`-shaped
		// path: `pathToFileURL(…).href` loads a package `createRequire` resolved,
		// `install-selftest.mjs` probes absolute `file://` URLs inside the install
		// and bare package specifiers, and `warm-loader-cache.mjs` resolves through
		// jiti. The admission is a SHAPE, not a file: a relative-shaped computed
		// specifier in the very same file is still a finding.
		expect(
			checkImports({
				"dist/index.js":
					"await import(pathToFileURL2(entry).href);\nawait import(pathToFileURL(mod).href);",
				"scripts/install-selftest.mjs":
					"await import(url.href);\nawait import(installerUrl);\nrequire.resolve(spec);\nrequire.resolve(`${tool.packageName}/package.json`);",
				"scripts/warm-loader-cache.mjs":
					"await import(url);\nawait jiti.import(entry, { default: true });\npathToFileURL(require.resolve(specifier)).href;",
				"package.json": "{}",
			}),
		).toEqual([]);
		expect(
			checkImports({
				"scripts/install-selftest.mjs":
					"await import(url.href);\nawait import(`./probes/${name}.js`);",
				"package.json": "{}",
			}),
		).toEqual([
			"scripts/install-selftest.mjs: computed dynamic import (`./probes/${name}.js`)",
		]);
	});

	it("fails a pack list that carries no JavaScript file", () => {
		// A pack that produced nothing (a bad list, a broken reader) must not
		// read as a clean run.
		expect(packedImportResolutionViolations([], () => "")).toEqual([
			"the pack list carries no JavaScript file",
		]);
		expect(
			packedImportResolutionViolations(["README.md", "rules/r.yml"], () => ""),
		).toEqual(["the pack list carries no JavaScript file"]);
	});
});

describe("bundled layout contract (#3219)", () => {
	const pkg = JSON.parse(
		fs.readFileSync(path.join(root, "package.json"), "utf8"),
	) as { files: string[]; bin: Record<string, string>; main: string };

	it("covers every bundled output, and nothing unbundled, in package.json files", () => {
		const covered = (output: string) =>
			pkg.files.some((entry) =>
				entry.endsWith("/") ? output.startsWith(entry) : entry === output,
			);
		for (const [out] of SPLIT_ENTRIES)
			expect(covered(`dist/${out}.js`), `dist/${out}.js`).toBe(true);
		expect(pkg.files).toContain("dist/index.js");
		expect(pkg.files).toContain("dist/chunk-*.js");
		expect(pkg.files).not.toContain("dist/");
		expect(
			pkg.files.filter((entry) => /^dist\/(?:clients|tools)\b/.test(entry)),
		).toEqual([]);
	});

	it("bundles every bin and the main entry", () => {
		const outputs = new Set(SPLIT_ENTRIES.map(([out]) => `dist/${out}.js`));
		for (const bin of Object.values(pkg.bin))
			expect(outputs.has(bin.replace(/^\.\//, "")), bin).toBe(true);
		expect(pkg.main).toBe("./dist/index.js");
	});

	it.each([
		["clients/project-snapshot.ts", "project-snapshot-persist-worker"],
		["clients/review-graph/builder.ts", "review-graph-persist-worker"],
	])("resolves %s's worker to its bundled output", (source, worker) => {
		const text = fs.readFileSync(path.join(root, source), "utf8");
		expect(
			SPLIT_ENTRIES.map(([out]) => out),
			`bundle-dist.mjs must emit workers/${worker}`,
		).toContain(`workers/${worker}`);
		// From dist/index.js or a dist/ chunk, and from a bin under dist/mcp/.
		expect(text).toContain(
			`new URL("./workers/${worker}.js", import.meta.url)`,
		);
		expect(text).toContain(
			`new URL("../workers/${worker}.js", import.meta.url)`,
		);
		expect(text).not.toMatch(/new URL\("\.\/clients\//);
	});
});

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
	COMPUTED_ADMISSIONS,
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
	const missing = (file: string, spec = "./missing.js") =>
		`${file}: import "${spec}" is not in the package`;

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
			missing("scripts/analyze-pi-lens-logs.mjs", "./lib/latency-stats.mjs"),
		]);
	});

	it.each([
		["an export-from", 'export * from "./missing.js";'],
		["an export-as-namespace", 'export * as ns from "./missing.js";'],
		["a named export-from", 'export { a } from "./missing.js";'],
		["a side-effect import", 'import "./missing.js";'],
		["a minified side-effect import", 'import"./missing.js";'],
		["a dynamic import", 'await import("./missing.js");'],
		["a template-literal dynamic import", "await import(`./missing.js`);"],
		["a require", 'const m = require("./missing.js");'],
		["a module.require", 'const m = module.require("./missing.js");'],
		["a require.resolve", 'require.resolve("./missing.js");'],
		["an import.meta.resolve", 'import.meta.resolve("./missing.js");'],
		["an escaped specifier", 'await import("\\u002e/missing.js");'],
	])("flags %s of an unpacked file", (_name, text) => {
		expect(
			checkImports({ "scripts/a.mjs": text, "package.json": "{}" }),
		).toEqual([missing("scripts/a.mjs")]);
	});

	// F2 (PR #5396 review): Node ESM resolves a specifier to exactly one file.
	// `import "./mod"` with only mod.mjs present throws ERR_MODULE_NOT_FOUND, so
	// a gate that guesses an extension, an index file or a `.json` passes an
	// import that fails in the installed package.
	it.each([
		["an extensionless file", "./lib/mod", { "scripts/lib/mod.mjs": "" }],
		["a directory", "./lib/dir", { "scripts/lib/dir/index.js": "" }],
		[
			"a trailing-slash directory",
			"./lib/dir/",
			{ "scripts/lib/dir/index.js": "" },
		],
		["a bare directory dot", ".", { "scripts/index.js": "" }],
		["an extensionless json", "./lib/data", { "scripts/lib/data.json": "" }],
		["a query suffix", "./lib/mod.mjs?v=1", { "scripts/lib/mod.mjs": "" }],
	])("does not guess: %s is not a packed file", (_name, spec, extra) => {
		expect(
			checkImports({
				"scripts/a.mjs": `import { x } from "${spec}";`,
				...extra,
			}),
		).toEqual([missing("scripts/a.mjs", spec)]);
	});

	it("resolves a specifier to its exact packed path, through . and ..", () => {
		expect(
			checkImports({
				"dist/mcp/cli.js": 'import "../chunk-A.js";\nimport "./../mcp/x.js";',
				"dist/chunk-A.js": "export {};",
				"dist/mcp/x.js": "export {};",
			}),
		).toEqual([]);
	});

	it("ignores bare and node: specifiers and specifiers inside comments", () => {
		expect(
			checkImports({
				"dist/index.js": [
					'import { readFileSync } from "node:fs";',
					'import { a } from "@modelcontextprotocol/sdk/client/index.js";',
					'import b from "minimatch";',
					'// a doc comment: from "../providers/cline/cline-auth"',
					"/* block: import './missing.js' */",
				].join("\n"),
				"package.json": "{}",
			}),
		).toEqual([]);
	});

	// F3 (PR #5396 review; Greptile zxj, CodeRabbit 0T0): a string must not
	// hide an import, and a comment-looking sequence inside a string or a regex
	// literal must not swallow one. These are the review's probes.
	it.each([
		[
			"a `//` inside a string literal",
			'const u = "https://x.y"; await import("./missing.js");',
		],
		[
			"a glob string whose `/*` and `*/` bracket the import",
			'const a = "dist/*"; await import("./missing.js"); const b = "**/*.js";',
		],
		[
			"a regex literal holding a quote",
			'const r = /"/; const a = "dist/*"; await import("./missing.js"); const b = "x*/";',
		],
		[
			"a template literal with a `//`",
			'const t = `//`; await import("./missing.js");',
		],
	])("sees an import after %s", (_name, text) => {
		expect(
			checkImports({ "scripts/a.mjs": text, "package.json": "{}" }),
		).toEqual([missing("scripts/a.mjs")]);
	});

	it("does not read import text that sits inside a string", () => {
		expect(
			checkImports({
				"scripts/a.mjs": "const s = 'import x from \"./missing.js\"';",
				"package.json": "{}",
			}),
		).toEqual([]);
	});

	// F1 (PR #5396 review): the deleted #4314 pin refused every `import(...)`
	// argument that was not a string literal or a `pathToFileURL(...)` call. These
	// are its cases; the first version of this gate passed all but one.
	it.each([
		['["lsp", "capabilities.js"].join("/")'],
		['["..", "lsp", "c.js"].join("/")'],
		['path.join(dir, "lsp", "capabilities.js")'],
		['dir + "/lsp/c.js"'],
		['"." + "/lsp/c.js"'],
		["someUnknown"],
		['["./lsp", "capabilities.js"].join("/")'],
		["`./lsp/${n}.js`"],
		['new URL("./x.js", import.meta.url)'],
	])("flags the computed dynamic import(%s)", (argument) => {
		expect(
			checkImports({
				"dist/index.js": `import(${argument});`,
				"package.json": "{}",
			}),
		).toEqual([`dist/index.js: computed import(${argument})`]);
	});

	it.each([
		["require", "require(name)"],
		["require.resolve", "require.resolve(name)"],
		["import.meta.resolve", "import.meta.resolve(name)"],
		// #5365 r3 V1: a non-literal key on a loader object is a load call of
		// its own, so its argument is judged like a bare `require(name)`.
		["require", "require[k](name)"],
		["module", "module[k](name)"],
		["import.meta", "import.meta[k](name)"],
		// A string-literal key (plain or template) reads as its dotted name, so
		// the message names the loader member, not the object.
		["module.require", 'module["require"](name)'],
		["module.require", "module[`require`](name)"],
		["require.resolve", 'require["resolve"](name)'],
		["import.meta.resolve", 'import.meta["resolve"](name)'],
	])("flags a computed %s argument", (kind, call) => {
		expect(
			checkImports({ "dist/index.js": `${call};`, "package.json": "{}" }),
		).toEqual([`dist/index.js: computed ${kind}(name)`]);
	});

	// #5365 r3 V1 (verify round r2, Greptile thread Drw): `referenceCall` read
	// dotted callees only, so a computed member call loaded a module the gate
	// never judged. A string-literal key is its dotted name. Each spelling below
	// passed the r2 head; `module.require` is the non-computed control that
	// already reds there.
	it.each([
		['module["require"]("./missing.cjs")', "scripts/a.cjs", "./missing.cjs"],
		['module[`require`]("./missing.cjs")', "scripts/a.cjs", "./missing.cjs"],
		[
			'const k = "require"; module[k]("./missing.cjs")',
			"scripts/a.cjs",
			"./missing.cjs",
		],
		['require["resolve"]("./missing.js")', "scripts/a.mjs", "./missing.js"],
		['import.meta["resolve"]("./missing.js")', "scripts/a.mjs", "./missing.js"],
		['require[k]("./m.js")', "scripts/a.cjs", "./m.js"],
		['module.require("./missing.js")', "scripts/a.mjs", "./missing.js"],
	])("flags the load call %s of an unpacked file", (text, file, spec) => {
		expect(checkImports({ [file]: text, "package.json": "{}" })).toEqual([
			missing(file, spec),
		]);
	});

	// #5365 r3 V1 negative: the shipped bundle carries esbuild's `__require`
	// shim, which calls `require.apply(this, arguments)` (dist/index.js). Only
	// the loader members the gate names are load calls; a member call on
	// `require` that loads nothing must not be read as one.
	it("does not read esbuild's require.apply shim as a load call", () => {
		expect(
			checkImports({
				"dist/index.js":
					"function f() { return require.apply(this, arguments); }",
				"package.json": "{}",
			}),
		).toEqual([]);
	});

	// #5365 r3 V1b: esbuild emits `__require` in the shipped bundle
	// (`dist/index.js`); the callee check read only the bare name `require`, so
	// a relative `__require("./x")` passed unjudged.
	it("reads esbuild's __require shim as a load call", () => {
		expect(
			checkImports({
				"dist/index.js": 'const m = __require("./missing.js");',
				"package.json": "{}",
			}),
		).toEqual([missing("dist/index.js")]);
	});

	it("admits only the pathToFileURL(<identifier>) form, anywhere", () => {
		// esbuild renames a colliding import `pathToFileURL2`, `pathToFileURL3`.
		expect(
			checkImports({
				"dist/index.js":
					"await import(pathToFileURL(entry).href);\nawait import(pathToFileURL2(entry).href);\nawait import(pathToFileURL3(entry));",
				"package.json": "{}",
			}),
		).toEqual([]);
		// Not the same shape: an argument that builds a path is the #4314 bug
		// wearing the admitted callee.
		expect(
			checkImports({
				"dist/index.js": [
					'await import(pathToFileURL(dir + "/lsp/c.js").href);',
					'await import(pathToFileURL(["lsp", "c.js"].join("/")).href);',
					"await import(pathToFileURL(entry).href + suffix);",
					"await import(other(entry).href);",
				].join("\n"),
				"package.json": "{}",
			}),
		).toEqual([
			"dist/index.js: computed import(other(entry).href)",
			'dist/index.js: computed import(pathToFileURL(["lsp", "c.js"].join("/")).href)',
			'dist/index.js: computed import(pathToFileURL(dir + "/lsp/c.js").href)',
			"dist/index.js: computed import(pathToFileURL(entry).href + suffix)",
		]);
	});

	it("admits the install scripts' computed arguments by exact file and text, and no other", () => {
		// Each is a bare package specifier or an absolute `file://` URL the
		// script resolves at run time inside the installed package. The
		// admission is the (file, call, argument text) triple.
		expect(
			checkImports({
				"scripts/install-selftest.mjs": [
					"await import(url.href);",
					"await import(installerUrl);",
					"require.resolve(spec);",
					"require.resolve(`${tool.packageName}/package.json`);",
					"require.resolve(specifier);",
				].join("\n"),
				"scripts/warm-loader-cache.mjs":
					"import.meta.resolve(specifier);\nrequire.resolve(specifier);\nawait import(url);",
				"package.json": "{}",
			}),
		).toEqual([]);
		// The same text in another file, a different argument in an admitted
		// file, and a different call over an admitted argument are all findings.
		expect(
			checkImports({
				"scripts/other.mjs": "await import(url.href);",
				"scripts/install-selftest.mjs":
					"await import(url.hrefs);\nrequire(spec);",
				"package.json": "{}",
			}),
		).toEqual([
			"scripts/install-selftest.mjs: computed import(url.hrefs)",
			"scripts/install-selftest.mjs: computed require(spec)",
			"scripts/other.mjs: computed import(url.href)",
		]);
	});

	// #5365 r3 V2 (Greptile thread Drx, shape 38): each admission's reason lived
	// in a trailing comment that nothing read. A row added without a reason, or
	// with a blank one, reds here.
	it("gives every computed admission row a non-empty reason", () => {
		expect(
			COMPUTED_ADMISSIONS.filter(
				(row) => typeof row.reason !== "string" || row.reason.trim() === "",
			),
		).toEqual([]);
	});

	it.each([
		["an absolute path", "/etc/x.js"],
		["a file: URL", "file:///x.js"],
		["an https: URL", "https://x.test/a.js"],
		["a data: URL", "data:text/javascript,0"],
	])("flags a literal %s: it names nothing in the package", (_name, spec) => {
		expect(
			checkImports({
				"scripts/a.mjs": `await import("${spec}");`,
				"package.json": "{}",
			}),
		).toEqual([missing("scripts/a.mjs", spec)]);
	});

	it("fails a packed JavaScript file it cannot parse", () => {
		expect(
			checkImports({
				"scripts/a.mjs": "import {{{ from",
				"package.json": "{}",
			}),
		).toEqual([expect.stringMatching(/^scripts\/a\.mjs: does not parse/)]);
	});

	it("reads .cjs as CommonJS and .js and .mjs as ESM, as a type:module package does", () => {
		// Top-level `return` is legal in CommonJS only; a module parse refuses it.
		expect(
			checkImports({
				"scripts/a.cjs": 'if (x) return;\nrequire("./b.cjs");',
				"scripts/b.cjs": "module.exports = 1;",
				"scripts/d.js": 'import "./b.cjs";',
			}),
		).toEqual([]);
		expect(
			checkImports({
				"scripts/c.js": "if (x) return;",
				"scripts/e.mjs": "return;",
			}),
		).toEqual([
			expect.stringMatching(/^scripts\/c\.js: does not parse/),
			expect.stringMatching(/^scripts\/e\.mjs: does not parse/),
		]);
	});

	it("tallies the relative specifiers it examined", () => {
		const tally = { relative: 0 };
		packedImportResolutionViolations(
			["scripts/a.mjs", "scripts/b.mjs"],
			(p) =>
				p === "scripts/a.mjs"
					? 'import "./b.mjs";\nimport "node:fs";\nawait import("./gone.js");'
					: "export {};",
			tally,
		);
		expect(tally).toEqual({ relative: 2 });
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

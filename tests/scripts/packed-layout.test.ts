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
import { packedLayoutViolations } from "../../scripts/lib/packed-layout.mjs";

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

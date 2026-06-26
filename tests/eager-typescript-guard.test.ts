import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Only RUNTIME-eager edges: clause-level `import type ... from` is erased by the
// compiler, so it doesn't pull a module into the eager graph.
const STATIC_VALUE_IMPORT =
	/^\s*import\s+(?!type\s)[^;]*?from\s+["'](\.[^"']+)["']/gm;

/** Every module reachable from `entry` via static value imports. */
function eagerGraph(entry: string): Set<string> {
	const seen = new Set<string>();
	function walk(file: string) {
		if (seen.has(file)) return;
		seen.add(file);
		let src: string;
		try {
			src = readFileSync(file, "utf8");
		} catch {
			return;
		}
		let m: RegExpExecArray | null;
		STATIC_VALUE_IMPORT.lastIndex = 0;
		while ((m = STATIC_VALUE_IMPORT.exec(src))) {
			const spec = m[1].replace(/\.js$/, "");
			const abs = `${path.resolve(path.dirname(file), spec)}.ts`.replace(
				/\\/g,
				"/",
			);
			walk(abs);
		}
	}
	walk(entry.replace(/\\/g, "/"));
	return seen;
}

// The 24 MB `typescript` dependency must stay OUT of pi-lens's eager entry graph:
// every typescript user (complexity, the dispatch facts/rules, the review-graph
// builder, the LSP type-check client) is loaded behind a dynamic import, so an
// unresolved-`typescript` failure (#285/#335) degrades to "no TS analysis"
// instead of throwing at `index.js` load and taking down the whole extension.
describe("typescript stays out of the eager entry graph (#285/#335)", () => {
	it("no statically-reachable module from index.ts imports the typescript accessor", () => {
		const graph = eagerGraph(path.join(root, "index.ts"));
		const offenders = [...graph]
			.filter((f) => !f.includes("deps/typescript"))
			.filter((f) => {
				let src: string;
				try {
					src = readFileSync(f, "utf8");
				} catch {
					return false;
				}
				return /from\s+["'][^"']*deps\/typescript/.test(src);
			})
			.map((f) => path.relative(root, f).replace(/\\/g, "/"));

		expect(offenders).toEqual([]);
	});
});

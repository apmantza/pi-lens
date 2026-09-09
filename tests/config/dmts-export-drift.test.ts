import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// #2725 review r1 F1 / r2: every `scripts/lib/*.mjs` (and `scripts/hooks`)
// carries a hand-written `.d.mts` sibling that IS the type contract every
// TypeScript importer sees. Nothing kept the two in step: a knip pass
// un-exported 40 bindings from the `.mjs` files while their `.d.mts` still
// declared them (typed as string/function, `undefined` at runtime), and in
// the other direction knip resolved `clients/skills-resolver.ts`'s import
// through the `.d.mts`, never saw the real consumer, and stripped
// `scanEntriesForSkills` from the `.mjs` — tsc green, runtime SyntaxError.
// This pin holds the VALUE export sets equal in both directions.

const repoRoot = path.resolve(__dirname, "..", "..");
const DIRS = ["scripts/lib", "scripts", "scripts/hooks"];

function mjsValueExports(src: string): Set<string> {
	const names = new Set<string>();
	for (const m of src.matchAll(
		/^export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
	)) {
		names.add(m[1]);
	}
	for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
		for (const part of m[1].split(",")) {
			const p = part.trim();
			if (!p || p.startsWith("type ")) continue;
			const as = p.match(/^[\w$]+\s+as\s+([\w$]+)$/);
			names.add(as ? as[1] : p);
		}
	}
	return names;
}

function dmtsValueExports(src: string): Set<string> {
	const names = new Set<string>();
	for (const m of src.matchAll(
		/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
	)) {
		names.add(m[1]);
	}
	return names;
}

describe("scripts .d.mts siblings declare exactly the .mjs value exports (#2725)", () => {
	const pairs: Array<[string, string]> = [];
	for (const dir of DIRS) {
		const abs = path.join(repoRoot, dir);
		if (!fs.existsSync(abs)) continue;
		for (const f of fs.readdirSync(abs)) {
			if (!f.endsWith(".d.mts")) continue;
			const mjs = path.join(abs, f.replace(/\.d\.mts$/, ".mjs"));
			if (fs.existsSync(mjs)) pairs.push([path.join(abs, f), mjs]);
		}
	}

	it("finds the sibling pairs at all (the sweep is not vacuous)", () => {
		expect(pairs.length).toBeGreaterThanOrEqual(20);
	});

	it("declares no value the .mjs does not export, and exports no value the .d.mts does not declare", () => {
		const problems: string[] = [];
		for (const [dmts, mjs] of pairs) {
			const declared = dmtsValueExports(fs.readFileSync(dmts, "utf8"));
			const exported = mjsValueExports(fs.readFileSync(mjs, "utf8"));
			for (const n of declared) {
				if (!exported.has(n)) {
					problems.push(
						`${path.relative(repoRoot, dmts)} declares ${n} but ${path.basename(mjs)} does not export it (undefined at runtime)`,
					);
				}
			}
			for (const n of exported) {
				if (!declared.has(n)) {
					problems.push(
						`${path.relative(repoRoot, mjs)} exports ${n} but ${path.basename(dmts)} does not declare it (invisible to TypeScript importers)`,
					);
				}
			}
		}
		expect(problems).toEqual([]);
	});
});

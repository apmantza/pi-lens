import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Third-party deps that must be imported ONLY through clients/deps/* accessors,
// never bare elsewhere — so each external dep has a single resolution/degrade/
// bundling seam (the #285/#335 work). Add new third-party deps here + an accessor.
const CENTRALIZED = [
	"minimatch",
	"typescript",
	"js-yaml",
	"typebox",
	"vscode-jsonrpc",
	"web-tree-sitter",
	"@ast-grep/napi",
	"@earendil-works/pi-tui",
];

function* walkTs(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const p = path.join(dir, entry);
		if (statSync(p).isDirectory()) {
			if (entry === "node_modules" || entry === "deps") continue; // accessors live in deps/
			yield* walkTs(p);
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			yield p;
		}
	}
}

function importRegex(dep: string): RegExp {
	const esc = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `from "<dep>"` / `from "<dep>/sub"` (static) or `import("<dep>")` (dynamic)
	return new RegExp(`(?:from|import\\()\\s*["']${esc}(?:/[^"']*)?["']`);
}

describe("dependency centralization", () => {
	const sources: string[] = [];
	for (const d of ["clients", "tools", "commands"]) {
		const dir = path.join(root, d);
		if (existsSync(dir)) sources.push(...walkTs(dir));
	}
	const indexTs = path.join(root, "index.ts");
	if (existsSync(indexTs)) sources.push(indexTs);

	it("imports every centralized dep ONLY via clients/deps/* (none bare elsewhere)", () => {
		const offenders: string[] = [];
		for (const file of sources) {
			const src = readFileSync(file, "utf8");
			for (const dep of CENTRALIZED) {
				if (importRegex(dep).test(src)) {
					offenders.push(`${path.relative(root, file)} → "${dep}"`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("every centralized dep is imported by a clients/deps/* accessor", () => {
		const depsDir = path.join(root, "clients", "deps");
		const depsSrc = readdirSync(depsDir)
			.filter((f) => f.endsWith(".ts"))
			.map((f) => readFileSync(path.join(depsDir, f), "utf8"))
			.join("\n");
		for (const dep of CENTRALIZED) {
			expect(
				importRegex(dep).test(depsSrc),
				`no clients/deps/* accessor imports "${dep}"`,
			).toBe(true);
		}
	});
});

import {
	mkdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DIST_IMPORTS,
	findStaleDistFiles,
} from "../../scripts/pre-push-targeted-tests.mjs";
import { listSourceFiles, stripSource } from "../support/sweep-kit.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = os.tmpdir();
	const unique = path.join(
		root,
		`pi-lens-dist-freshness-${Date.now()}-${Math.random()}`,
	);
	mkdirSync(path.join(unique, "clients/lsp"), { recursive: true });
	mkdirSync(path.join(unique, "dist/clients/lsp"), { recursive: true });
	writeFileSync(path.join(unique, "clients/lsp/server-traits.ts"), "source");
	roots.push(unique);
	return unique;
}

describe("dist freshness (#4239)", () => {
	// Recurrence #4239: a fresh worktree's missing dist/ made governance imports fail on first push.
	it("reports a missing bundled dependency", () => {
		const root = fixture();
		expect(findStaleDistFiles(root)).toEqual([
			{
				source: "clients/lsp/server-traits.ts",
				output: "dist/clients/lsp/server-traits.js",
				reason: "missing",
			},
		]);
	});

	// Recurrence #4239: a stale dist/ survived source edits and broke governance imports on first push.
	it("reports a bundled dependency older than its source", () => {
		const root = fixture();
		const output = path.join(root, "dist/clients/lsp/server-traits.js");
		writeFileSync(output, "built");
		const source = path.join(root, "clients/lsp/server-traits.ts");
		const now = Date.now() / 1000;
		utimesSync(output, now - 10, now - 10);
		utimesSync(source, now, now);
		expect(findStaleDistFiles(root)[0]?.reason).toBe("stale");
	});

	it("keeps DIST_IMPORTS complete for static scripts/lib dist imports (#4239)", () => {
		const outputs = new Set<string>(DIST_IMPORTS.map(({ output }) => output));
		const imports: string[] = [];
		for (const file of listSourceFiles(path.resolve("scripts/lib"), {
			extensions: [".mjs"],
			skipDeclarations: false,
		})) {
			const source = readFileSync(file, "utf8");
			const blanked = stripSource(source);
			for (const match of blanked.matchAll(/\bfrom\b/g)) {
				let index = match.index + match[0].length;
				while (/\s/.test(source[index] ?? "")) index++;
				if (source[index] !== '"' && source[index] !== "'") continue;
				const quote = source[index++];
				const end = source.indexOf(quote, index);
				const specifier = source.slice(index, end);
				if (specifier.includes("/dist/"))
					imports.push(
						path.posix.normalize(
							path.posix.join(
								path.posix.dirname(
									path.relative(process.cwd(), file).split(path.sep).join("/"),
								),
								specifier,
							),
						),
					);
			}
		}
		expect(imports).toEqual([
			"dist/clients/lsp/server-traits.js",
			"dist/clients/lsp/server-traits.js",
		]);
		for (const output of imports) expect(outputs.has(output)).toBe(true);
	});
});

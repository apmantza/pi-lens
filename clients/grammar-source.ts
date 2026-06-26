/**
 * Single source of truth for tree-sitter grammar assets: the language→wasm map,
 * the CDN the wasms come from, and the (single-file) download routine.
 *
 * Reused by:
 *  - the runtime client (`tree-sitter-client.ts`), which lazily fetches a
 *    missing grammar on first use (pnpm/bun skip the postinstall);
 *  - the postinstall pre-fetch (`scripts/download-grammars.js`), which can't
 *    import this compiled module (it runs before the TS build), so it keeps a
 *    mirror — guarded against drift by `tests/clients/grammar-source.test.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** tree-sitter-wasms release the grammars are pulled from. */
export const TREE_SITTER_WASMS_VERSION = "0.1.13";

/** unpkg mirror of the tree-sitter-wasms artifacts. */
export const GRAMMAR_CDN_BASE = `https://unpkg.com/tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}/out`;

/** Language id → grammar wasm filename. */
export const LANGUAGE_TO_GRAMMAR: Record<string, string> = {
	typescript: "tree-sitter-typescript.wasm",
	tsx: "tree-sitter-tsx.wasm",
	javascript: "tree-sitter-javascript.wasm",
	python: "tree-sitter-python.wasm",
	rust: "tree-sitter-rust.wasm",
	go: "tree-sitter-go.wasm",
	java: "tree-sitter-java.wasm",
	kotlin: "tree-sitter-kotlin.wasm",
	dart: "tree-sitter-dart.wasm",
	c: "tree-sitter-c.wasm",
	cpp: "tree-sitter-cpp.wasm",
	elixir: "tree-sitter-elixir.wasm",
	ruby: "tree-sitter-ruby.wasm",
	bash: "tree-sitter-bash.wasm",
	csharp: "tree-sitter-c_sharp.wasm",
	css: "tree-sitter-css.wasm",
	html: "tree-sitter-html.wasm",
	json: "tree-sitter-json.wasm",
	lua: "tree-sitter-lua.wasm",
	ocaml: "tree-sitter-ocaml.wasm",
	php: "tree-sitter-php.wasm",
	swift: "tree-sitter-swift.wasm",
	toml: "tree-sitter-toml.wasm",
	vue: "tree-sitter-vue.wasm",
	yaml: "tree-sitter-yaml.wasm",
	zig: "tree-sitter-zig.wasm",
};

/** The full set of grammar wasm filenames (deduped). */
export const GRAMMAR_FILES: string[] = [
	...new Set(Object.values(LANGUAGE_TO_GRAMMAR)),
];

/**
 * Fetch one grammar wasm into `destDir` (atomic via a temp file). Returns true
 * on success. Never throws — a failed fetch (offline, 4xx) degrades to "grammar
 * unavailable" so callers can decide how to handle it.
 */
export async function downloadGrammar(
	destDir: string,
	filename: string,
): Promise<boolean> {
	try {
		fs.mkdirSync(destDir, { recursive: true });
		const res = await fetch(`${GRAMMAR_CDN_BASE}/${filename}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = Buffer.from(await res.arrayBuffer());
		const tmp = path.join(destDir, `.${filename}.${process.pid}.tmp`);
		fs.writeFileSync(tmp, data);
		fs.renameSync(tmp, path.join(destDir, filename));
		return true;
	} catch {
		return false;
	}
}

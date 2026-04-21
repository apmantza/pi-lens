#!/usr/bin/env node
/**
 * Downloads tree-sitter WASM grammar files into node_modules/web-tree-sitter/grammars/.
 * Run automatically via postinstall. Skips gracefully if grammars already exist.
 *
 * Source: tree-sitter-wasms package on unpkg (mirrors npm registry artifacts).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TREE_SITTER_WASMS_VERSION = "0.1.13";
const BASE_URL = `https://unpkg.com/tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}/out`;

const GRAMMARS = [
	"tree-sitter-typescript.wasm",
	"tree-sitter-tsx.wasm",
	"tree-sitter-javascript.wasm",
	"tree-sitter-python.wasm",
	"tree-sitter-rust.wasm",
	"tree-sitter-go.wasm",
	"tree-sitter-java.wasm",
	"tree-sitter-kotlin.wasm",
	"tree-sitter-dart.wasm",
	"tree-sitter-c.wasm",
	"tree-sitter-cpp.wasm",
	"tree-sitter-elixir.wasm",
	"tree-sitter-ruby.wasm",
];

function findGrammarsDir(): string {
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const pkgRoot = dirname(scriptDir);
	// Prefer local node_modules next to this package
	return join(pkgRoot, "node_modules", "web-tree-sitter", "grammars");
}

async function downloadGrammar(destDir: string, filename: string): Promise<void> {
	const dest = join(destDir, filename);
	if (existsSync(dest)) {
		console.log(`  skip  ${filename} (already exists)`);
		return;
	}
	const url = `${BASE_URL}/${filename}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
	const buf = await res.arrayBuffer();
	writeFileSync(dest, Buffer.from(buf));
	console.log(`  ok    ${filename}`);
}

async function main(): Promise<void> {
	const grammarsDir = findGrammarsDir();

	if (!existsSync(grammarsDir)) {
		mkdirSync(grammarsDir, { recursive: true });
	}

	console.log(`Downloading tree-sitter grammars → ${grammarsDir}`);

	const results = await Promise.allSettled(
		GRAMMARS.map((g) => downloadGrammar(grammarsDir, g)),
	);

	const failed = results.filter((r) => r.status === "rejected");
	if (failed.length > 0) {
		for (const f of failed) {
			console.warn("  warn ", (f as PromiseRejectedResult).reason?.message);
		}
		console.warn(`${failed.length} grammar(s) failed — tree-sitter analysis may be unavailable.`);
	} else {
		console.log("All grammars downloaded successfully.");
	}
}

main().catch((err) => {
	// Never fail the install — tree-sitter is optional
	console.warn("Warning: grammar download failed:", err.message);
	process.exit(0);
});

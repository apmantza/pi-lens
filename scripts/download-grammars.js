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
    // Core typed languages
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
    // Additional languages with dispatch runners, formatters, or LSP support
    "tree-sitter-bash.wasm",
    "tree-sitter-c_sharp.wasm",
    "tree-sitter-css.wasm",
    "tree-sitter-html.wasm",
    "tree-sitter-json.wasm",
    "tree-sitter-lua.wasm",
    "tree-sitter-ocaml.wasm",
    "tree-sitter-php.wasm",
    "tree-sitter-swift.wasm",
    "tree-sitter-toml.wasm",
    "tree-sitter-vue.wasm",
    "tree-sitter-yaml.wasm",
    "tree-sitter-zig.wasm",
];
// The core set bundled into the tarball (via `prepare` → `grammars/`, shipped in
// `files[]`) so the common languages parse offline on every package manager. The
// long tail stays lazy-fetched at runtime. ~8.6MB uncompressed; ts/tsx dominate.
// Keep in sync with what the runtime treats as "core" only implicitly — the
// runtime just uses whatever files are present in the bundled dir.
const CORE = [
    "tree-sitter-typescript.wasm",
    "tree-sitter-tsx.wasm",
    "tree-sitter-javascript.wasm",
    "tree-sitter-python.wasm",
    "tree-sitter-go.wasm",
    "tree-sitter-rust.wasm",
    "tree-sitter-json.wasm",
    "tree-sitter-yaml.wasm",
    "tree-sitter-bash.wasm",
    "tree-sitter-html.wasm",
    "tree-sitter-css.wasm",
    "tree-sitter-java.wasm",
];
function findGrammarsDir() {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const pkgRoot = dirname(scriptDir);
    // Prefer local node_modules next to this package
    return join(pkgRoot, "node_modules", "web-tree-sitter", "grammars");
}
async function downloadGrammar(destDir, filename) {
    const dest = join(destDir, filename);
    if (existsSync(dest)) {
        console.log(`  skip  ${filename} (already exists)`);
        return;
    }
    const url = `${BASE_URL}/${filename}`;
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`HTTP ${res.status} fetching ${url}`);
    const buf = await res.arrayBuffer();
    writeFileSync(dest, Buffer.from(buf));
    console.log(`  ok    ${filename}`);
}
function parseArgs(argv) {
    const out = { core: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--core")
            out.core = true;
        else if (argv[i] === "--dest")
            out.dest = argv[++i];
    }
    return out;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    // `--dest` is relative to cwd (used by `prepare` to bundle into `./grammars/`);
    // default is the installed web-tree-sitter/grammars dir (postinstall).
    const grammarsDir = args.dest
        ? join(process.cwd(), args.dest)
        : findGrammarsDir();
    const list = args.core ? CORE : GRAMMARS;
    if (!existsSync(grammarsDir)) {
        mkdirSync(grammarsDir, { recursive: true });
    }
    console.log(`Downloading ${args.core ? "core" : "all"} tree-sitter grammars (${list.length}) → ${grammarsDir}`);
    const results = await Promise.allSettled(list.map((g) => downloadGrammar(grammarsDir, g)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
        for (const f of failed) {
            console.warn("  warn ", f.reason?.message);
        }
        console.warn(`${failed.length} grammar(s) failed — tree-sitter analysis may be unavailable.`);
    }
    else {
        console.log("All grammars downloaded successfully.");
    }
}
main().catch((err) => {
    // Never fail the install — tree-sitter is optional
    console.warn("Warning: grammar download failed:", err.message);
    process.exit(0);
});

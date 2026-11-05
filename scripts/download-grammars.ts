#!/usr/bin/env node
/**
 * Downloads tree-sitter WASM grammars, each verified against the committed
 * provenance manifest (`scripts/grammars.lock.json`: package, version, per-grammar
 * sha256) and stamped with a `<grammar>.wasm.json` sidecar. On a version bump or a
 * hash mismatch the stale file is re-downloaded instead of skipped — closing the
 * old skip-if-exists hole where an ABI-mismatched grammar could silently persist
 * against the pinned `web-tree-sitter` (#177).
 *
 * Modes:
 *   node download-grammars.js                          # all grammars → web-tree-sitter/grammars
 *   node download-grammars.js --core --dest grammars   # core set → ./grammars (used by `prepare`)
 *   node download-grammars.js --write-manifest         # regenerate grammars.lock.json from the CDN
 *
 * Source: tree-sitter-wasms on unpkg (mirrors the npm registry artifacts).
 *
 * Progress goes to stderr — stdout must stay clean so `npm pack --silent` (which
 * runs this via `prepare`) captures only the tarball name (#376/#380).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/is-main-module.mjs";

// The pinned tree-sitter-wasms release. Bump this, run `--write-manifest`, and
// commit the regenerated grammars.lock.json to move to a new grammar set.
const TREE_SITTER_WASMS_VERSION = "0.1.13";
const PACKAGE = "tree-sitter-wasms";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(SCRIPT_DIR, "grammars.lock.json");

/**
 * Per-grammar source override — a grammar pulled from a different package than the
 * `tree-sitter-wasms` aggregator because the aggregator's frozen build is broken for
 * it. Mirrors `GRAMMAR_SOURCE_OVERRIDES` in clients/grammar-source.ts. tree-sitter-lua
 * corrupts once a 2nd grammar loads the shared WASM Module (#255); pull the maintained
 * @tree-sitter-grammars build instead.
 */
export interface SourceOverride {
	package: string;
	version: string;
	url: string;
}

export const SOURCE_OVERRIDES: Record<string, SourceOverride> = {
	"tree-sitter-lua.wasm": {
		package: "@tree-sitter-grammars/tree-sitter-lua",
		version: "0.4.1",
		url: "https://unpkg.com/@tree-sitter-grammars/tree-sitter-lua@0.4.1/tree-sitter-lua.wasm",
	},
	"tree-sitter-yaml.wasm": {
		package: "@tree-sitter-grammars/tree-sitter-yaml",
		version: "0.7.1",
		url: "https://unpkg.com/@tree-sitter-grammars/tree-sitter-yaml@0.7.1/tree-sitter-yaml.wasm",
	},
	"tree-sitter-bash.wasm": {
		package: "tree-sitter-bash",
		version: "0.25.1",
		url: "https://unpkg.com/tree-sitter-bash@0.25.1/tree-sitter-bash.wasm",
	},
};

/**
 * Build provenance for a grammar this repo builds itself and commits to
 * `vendor/grammars/`, because no publisher ships a wasm for it. Mirrors
 * `VENDORED_GRAMMARS` in clients/grammar-source.ts. Nothing here is ever
 * downloaded — the entries exist so the provenance guard can re-hash the
 * committed bytes, and so the reproduction recipe sits next to the pin.
 */
export interface VendoredGrammar {
	repo: string;
	commit: string;
	license: string;
	buildCommand: string;
	/** "sha256:<hex>" of the committed wasm. */
	sha256: string;
}

/**
 * Grammars committed under `vendor/grammars/` rather than fetched.
 *
 * tree-sitter-cue: no published wasm exists — npm's `tree-sitter-cue` is a
 * native binding, the `tree-sitter-wasms` aggregator has no CUE, and upstream
 * cuts no releases — so we build it from a pinned commit (#1522).
 *
 * tree-sitter-groovy: no publisher ships a wasm, so dekobon v0.3.0 is built at
 * its tagged commit with the pinned CLI, unpatched (#5235).
 */
export const VENDORED_GRAMMARS: Record<string, VendoredGrammar> = {
	"tree-sitter-cue.wasm": {
		repo: "https://github.com/eonpatapon/tree-sitter-cue",
		commit: "dd7b90e0770ff18070c515937ba3c3d6d93db00e",
		license: "MIT",
		buildCommand: "npx tree-sitter-cli build --wasm",
		sha256:
			"sha256:751f8cc8ccf72da760133e3d365562ff7bbf5b951e0b73568576fd159db7d601",
	},
	"tree-sitter-groovy.wasm": {
		repo: "https://github.com/dekobon/tree-sitter-groovy",
		commit: "654e4c2d736571dbc512043a1dc26017c7aedc85",
		license: "MIT OR Apache-2.0",
		buildCommand: "npx tree-sitter-cli@0.25.10 build --wasm",
		sha256:
			"sha256:d03e2a88789bcf02a3f6976531eadbe3f8e0328935d1c353f8a98a0813e5e9d9",
	},
};

/** Directory the committed grammars live in, relative to the package root. */
export const VENDORED_DIR = "vendor/grammars";

export interface GrammarManifest {
	package: string;
	version: string;
	/** filename → "sha256:<hex>" */
	grammars: Record<string, string>;
	/** filename → override provenance, for grammars not from the aggregator. */
	overrides?: Record<string, SourceOverride>;
	/** filename → build provenance + pinned sha256, for committed grammars. */
	vendored?: Record<string, VendoredGrammar>;
}

export interface GrammarSidecar {
	npmPackage: string;
	version: string;
	sha256: string;
}

/** The package a grammar's sidecar records (override or the global aggregator). */
export function expectedPackage(
	filename: string,
	manifest: GrammarManifest,
): string {
	return (
		manifest.overrides?.[filename]?.package ??
		SOURCE_OVERRIDES[filename]?.package ??
		manifest.package
	);
}

/** The version a grammar's sidecar records (override or the global aggregator). */
export function expectedVersion(
	filename: string,
	manifest: GrammarManifest,
): string {
	return (
		manifest.overrides?.[filename]?.version ??
		SOURCE_OVERRIDES[filename]?.version ??
		manifest.version
	);
}

export const GRAMMARS: string[] = [
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
export const CORE: string[] = [
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

/** `sha256:<hex>` digest of a buffer, matching the manifest/sidecar format. */
export function sha256(buf: Buffer | Uint8Array): string {
	return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

/** Read the committed provenance manifest (`scripts/grammars.lock.json`). */
export function loadManifest(): GrammarManifest {
	// pi-lens-ignore: ast-grep:unchecked-throwing-call
	return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as GrammarManifest;
}

/** Sidecar path for a grammar wasm file: `<grammar>.wasm.json`. */
export function sidecarPathFor(wasmPath: string): string {
	return `${wasmPath}.json`;
}

/**
 * Whether `filename` must be (re)downloaded into `destDir`: true if the grammar
 * or its sidecar is missing, the sidecar's version differs from the manifest, or
 * the sidecar's recorded hash differs from the expected one. Pure and cheap (it
 * trusts the sidecar's recorded hash — the CI provenance guard re-hashes the
 * bytes for the full integrity check).
 */
export function needsDownload(
	destDir: string,
	filename: string,
	manifest: GrammarManifest,
): boolean {
	const wasm = join(destDir, filename);
	const sidecar = sidecarPathFor(wasm);
	if (!existsSync(wasm) || !existsSync(sidecar)) return true;
	let meta: GrammarSidecar;
	try {
		meta = JSON.parse(readFileSync(sidecar, "utf-8")) as GrammarSidecar;
	} catch {
		return true;
	}
	if (meta.version !== expectedVersion(filename, manifest)) return true;
	const expected = manifest.grammars[filename];
	if (expected && meta.sha256 !== expected) return true;
	return false;
}

function findGrammarsDir(): string {
	const pkgRoot = dirname(SCRIPT_DIR);
	// Prefer local node_modules next to this package.
	return join(pkgRoot, "node_modules", "web-tree-sitter", "grammars");
}

function baseUrl(version: string): string {
	return `https://unpkg.com/${PACKAGE}@${version}/out`;
}

/** Fetch URL for a grammar: its source override if any, else the aggregator. */
function grammarUrl(version: string, filename: string): string {
	return SOURCE_OVERRIDES[filename]?.url ?? `${baseUrl(version)}/${filename}`;
}

/**
 * Abort a fetch that receives no bytes for this long, headers included; each
 * chunk restarts the count, so a slow link that keeps delivering completes.
 * Mirrors `GRAMMAR_STALL_MS` in clients/grammar-source.ts, which this script
 * cannot import before the TS build; `tests/clients/grammar-source.test.ts`
 * pins the two together (#4425).
 */
export const GRAMMAR_STALL_MS = 15_000;

async function fetchGrammar(
	version: string,
	filename: string,
	stallMs = GRAMMAR_STALL_MS,
): Promise<Buffer> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), stallMs);
	try {
		const res = await fetch(grammarUrl(version, filename), {
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
		const reader = res.body?.getReader();
		if (!reader) return Buffer.from(await res.arrayBuffer());
		const chunks: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks);
			timer.refresh();
			chunks.push(value);
		}
	} catch (err) {
		if (controller.signal.aborted) {
			throw new Error(
				`no bytes arrived for ${stallMs} ms fetching ${filename}`,
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Download `filename` into `destDir` (if it isn't already verified), checking its
 * bytes against the manifest and writing a provenance sidecar. Throws on an
 * integrity mismatch — a grammar whose bytes don't match the pinned manifest is
 * never written (guards CDN corruption / tampering / ABI drift).
 */
export async function downloadGrammar(
	destDir: string,
	filename: string,
	manifest: GrammarManifest,
	stallMs = GRAMMAR_STALL_MS,
): Promise<void> {
	if (!needsDownload(destDir, filename, manifest)) {
		console.error(`  skip  ${filename} (verified)`);
		return;
	}
	const buf = await fetchGrammar(manifest.version, filename, stallMs);
	const actual = sha256(buf);
	const expected = manifest.grammars[filename];
	if (expected && actual !== expected) {
		throw new Error(
			`integrity mismatch for ${filename}: expected ${expected}, got ${actual}`,
		);
	}
	const wasm = join(destDir, filename);
	writeFileSync(wasm, buf);
	const sidecar: GrammarSidecar = {
		npmPackage: expectedPackage(filename, manifest),
		version: expectedVersion(filename, manifest),
		sha256: actual,
	};
	writeFileSync(sidecarPathFor(wasm), `${JSON.stringify(sidecar, null, 2)}\n`);
	console.error(`  ok    ${filename}`);
}

function parseArgs(argv: string[]): {
	core: boolean;
	dest?: string;
	writeManifest: boolean;
} {
	const out = {
		core: false,
		dest: undefined as string | undefined,
		writeManifest: false,
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--core") out.core = true;
		else if (argv[i] === "--write-manifest") out.writeManifest = true;
		else if (argv[i] === "--dest") out.dest = argv[++i];
	}
	return out;
}

/** Regenerate grammars.lock.json by fetching every grammar and hashing it. */
async function regenerateManifest(): Promise<void> {
	console.error(
		`Regenerating manifest from ${PACKAGE}@${TREE_SITTER_WASMS_VERSION} …`,
	);
	const grammars: Record<string, string> = {};
	for (const g of GRAMMARS) {
		grammars[g] = sha256(await fetchGrammar(TREE_SITTER_WASMS_VERSION, g));
		console.error(`  hashed ${g}`);
	}
	const sorted = Object.fromEntries(
		Object.keys(grammars)
			.sort()
			.map((k) => [k, grammars[k]]),
	);
	const manifest: GrammarManifest = {
		package: PACKAGE,
		version: TREE_SITTER_WASMS_VERSION,
		grammars: sorted,
		...(Object.keys(SOURCE_OVERRIDES).length
			? { overrides: SOURCE_OVERRIDES }
			: {}),
		// Re-emitted from the map above, not copied from the old manifest: a
		// `--write-manifest` run on a tree-sitter-wasms bump must not silently
		// drop the committed grammars' provenance, which would leave the guard
		// with nothing to check.
		...(Object.keys(VENDORED_GRAMMARS).length
			? { vendored: VENDORED_GRAMMARS }
			: {}),
	};
	writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
	console.error(`Wrote ${MANIFEST_PATH} (${GRAMMARS.length} grammars).`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.writeManifest) return regenerateManifest();

	const manifest = loadManifest();
	// `--dest` is relative to cwd (used by `prepare` to bundle into `./grammars/`);
	// default is the installed web-tree-sitter/grammars dir.
	const grammarsDir = args.dest
		? join(process.cwd(), args.dest)
		: findGrammarsDir();
	const list = args.core ? CORE : GRAMMARS;

	if (!existsSync(grammarsDir)) {
		mkdirSync(grammarsDir, { recursive: true });
	}

	console.error(
		`Downloading ${args.core ? "core" : "all"} tree-sitter grammars (${list.length}) → ${grammarsDir}`,
	);

	const results = await Promise.allSettled(
		list.map((g) => downloadGrammar(grammarsDir, g, manifest)),
	);

	const failed = results.filter((r) => r.status === "rejected");
	if (failed.length > 0) {
		for (const f of failed) {
			console.warn("  warn ", (f as PromiseRejectedResult).reason?.message);
		}
		console.warn(
			`${failed.length} grammar(s) failed — tree-sitter analysis may be unavailable.`,
		);
	} else {
		console.error("All grammars downloaded successfully.");
	}
}

// Only run when invoked directly (not when imported by the provenance check or
// tests) — the import guard keeps the exported helpers side-effect-free.
if (isMainModule(import.meta.url)) {
	main().catch((err) => {
		// Never fail the install — tree-sitter is optional.
		console.warn("Warning: grammar download failed:", err.message);
		process.exit(0);
	});
}

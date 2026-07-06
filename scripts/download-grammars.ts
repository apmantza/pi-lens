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
import { fileURLToPath, pathToFileURL } from "node:url";

// The pinned tree-sitter-wasms release. Bump this, run `--write-manifest`, and
// commit the regenerated grammars.lock.json to move to a new grammar set.
const TREE_SITTER_WASMS_VERSION = "0.1.13";
const PACKAGE = "tree-sitter-wasms";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(SCRIPT_DIR, "grammars.lock.json");

export interface VendoredSource {
	npmPackage: string;
	version: string;
	builtWith?: string;
	reason?: string;
}

export interface GrammarManifest {
	package: string;
	version: string;
	/** filename → "sha256:<hex>" */
	grammars: Record<string, string>;
	/** Per-grammar provenance override for VENDORED grammars (built from source,
	 *  committed — not from `package@version`). filename → source metadata. */
	vendored?: Record<string, VendoredSource>;
}

export interface GrammarSidecar {
	npmPackage: string;
	version: string;
	sha256: string;
	builtWith?: string;
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

// Grammars we build from source and commit (shipped as bytes via files[], NOT
// downloaded) because the prebuilt CDN wasm crashes/is-incompatible with the pinned
// web-tree-sitter. tree-sitter-swift @ tree-sitter-wasms 0.1.13 fatally crashes
// Node 24 (#423); the from-source build survives (verified by the grammar-load
// guard). Their provenance lives under `vendored` in grammars.lock.json.
export const VENDORED: Record<string, VendoredSource> = {
	"tree-sitter-swift.wasm": {
		npmPackage: "tree-sitter-swift",
		version: "0.7.1",
		builtWith: "tree-sitter-cli@0.25.6",
		reason:
			"prebuilt tree-sitter-wasms@0.1.13 swift.wasm fatally crashes Node 24 (#423)",
	},
};

export function isVendored(filename: string): boolean {
	return filename in VENDORED;
}

/** The provenance version a grammar's sidecar must record — the per-grammar
 *  vendored version if vendored, else the global tree-sitter-wasms version. */
export function expectedVersion(
	filename: string,
	manifest: GrammarManifest,
): string {
	return manifest.vendored?.[filename]?.version ?? manifest.version;
}

/** The npmPackage a grammar's sidecar must record (vendored override or global). */
export function expectedPackage(
	filename: string,
	manifest: GrammarManifest,
): string {
	return manifest.vendored?.[filename]?.npmPackage ?? manifest.package;
}

/** `sha256:<hex>` digest of a buffer, matching the manifest/sidecar format. */
export function sha256(buf: Buffer | Uint8Array): string {
	return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

/** Read the committed provenance manifest (`scripts/grammars.lock.json`). */
export function loadManifest(): GrammarManifest {
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

async function fetchGrammar(version: string, filename: string): Promise<Buffer> {
	const res = await fetch(`${baseUrl(version)}/${filename}`);
	if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
	return Buffer.from(await res.arrayBuffer());
}

/**
 * Download `filename` into `destDir` (if it isn't already verified), checking its
 * bytes against the manifest and writing a provenance sidecar. Throws on an
 * integrity mismatch — a grammar whose bytes don't match the pinned manifest is
 * never written (guards CDN corruption / tampering / ABI drift).
 */
async function downloadGrammar(
	destDir: string,
	filename: string,
	manifest: GrammarManifest,
): Promise<void> {
	if (!needsDownload(destDir, filename, manifest)) {
		console.error(`  skip  ${filename} (verified)`);
		return;
	}
	const buf = await fetchGrammar(manifest.version, filename);
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
		npmPackage: manifest.package,
		version: manifest.version,
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

/** Regenerate grammars.lock.json by fetching every grammar and hashing it.
 *  VENDORED grammars aren't on the CDN — hash their committed bytes instead, and
 *  re-emit the `vendored` provenance section from VENDORED. */
async function regenerateManifest(): Promise<void> {
	console.error(`Regenerating manifest from ${PACKAGE}@${TREE_SITTER_WASMS_VERSION} …`);
	const committedGrammarsDir = join(dirname(SCRIPT_DIR), "grammars");
	const grammars: Record<string, string> = {};
	for (const g of GRAMMARS) {
		if (isVendored(g)) {
			const committed = join(committedGrammarsDir, g);
			if (!existsSync(committed)) {
				throw new Error(
					`vendored grammar ${g} not found at ${committed} — build + commit it before regenerating the manifest`,
				);
			}
			grammars[g] = sha256(readFileSync(committed));
			console.error(`  vendored ${g} (hashed committed bytes)`);
			continue;
		}
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
		vendored: VENDORED,
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
	// VENDORED grammars are committed bytes, not on the CDN — never download them
	// (a fetch would pull the crashing prebuilt wasm over the good vendored one).
	const list = (args.core ? CORE : GRAMMARS).filter((g) => !isVendored(g));

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
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((err) => {
		// Never fail the install — tree-sitter is optional.
		console.warn("Warning: grammar download failed:", err.message);
		process.exit(0);
	});
}

#!/usr/bin/env node
/**
 * Fail if an installed tree-sitter grammar drifts from the committed provenance
 * manifest (`scripts/grammars.lock.json`). Mirrors the `check:lockfile` guard.
 *
 * For each grammar in the checked dir this re-hashes the actual bytes (the full
 * integrity check that the download path's sidecar-trusting `needsDownload`
 * skips) and asserts:
 *   • the wasm's sha256 matches the manifest,
 *   • a `<grammar>.wasm.json` sidecar exists, parses, and records the manifest's
 *     version and the same hash,
 *   • no unknown grammar (present but absent from the manifest) has crept in.
 * It also asserts the bundled CORE set is present, so a `prepare` that silently
 * shipped nothing can't pass vacuously.
 *
 * Usage: node scripts/check-grammar-provenance.mjs [grammarsDir]   (default: grammars)
 *
 * Fix a failure by re-running the downloader (which re-fetches + re-stamps stale
 * grammars) or, on a deliberate tree-sitter-wasms bump, `download-grammars.js
 * --write-manifest` and commit the new grammars.lock.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CORE,
	expectedVersion,
	loadManifest,
	sha256,
	sidecarPathFor,
} from "./download-grammars.js";

const grammarsDir = process.argv[2] ?? "grammars";
const manifest = loadManifest();
const problems = [];

if (!fs.existsSync(grammarsDir)) {
	console.error(`Grammars dir not found: ${grammarsDir}`);
	process.exit(1);
}

const wasmFiles = fs
	.readdirSync(grammarsDir)
	.filter((f) => f.endsWith(".wasm"));

for (const filename of wasmFiles) {
	const expected = manifest.grammars[filename];
	if (!expected) {
		problems.push(`${filename}: present but not in the manifest (unknown grammar)`);
		continue;
	}
	const wasmPath = path.join(grammarsDir, filename);
	const actual = sha256(fs.readFileSync(wasmPath));
	if (actual !== expected) {
		problems.push(`${filename}: bytes hash ${actual}, manifest expects ${expected}`);
	}

	const sidecarPath = sidecarPathFor(wasmPath);
	if (!fs.existsSync(sidecarPath)) {
		problems.push(`${filename}: missing provenance sidecar (${path.basename(sidecarPath)})`);
		continue;
	}
	let meta;
	try {
		meta = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
	} catch (err) {
		problems.push(`${filename}: unreadable sidecar — ${err.message}`);
		continue;
	}
	const wantVersion = expectedVersion(filename, manifest);
	if (meta.version !== wantVersion) {
		problems.push(
			`${filename}: sidecar version "${meta.version}" != expected "${wantVersion}" (stale grammar)`,
		);
	}
	if (meta.sha256 !== expected) {
		problems.push(`${filename}: sidecar hash ${meta.sha256} != manifest ${expected}`);
	}
}

// The bundled core must actually be present — guards a prepare that shipped nothing.
for (const filename of CORE) {
	if (!wasmFiles.includes(filename)) {
		problems.push(`${filename}: bundled core grammar missing from ${grammarsDir}/`);
	}
}

if (problems.length > 0) {
	console.error(
		`Grammar provenance check FAILED against ${manifest.package}@${manifest.version}:\n`,
	);
	for (const p of problems) console.error(`  • ${p}`);
	console.error(
		"\nRe-run the downloader to re-fetch/re-stamp stale grammars, or on a" +
			" deliberate bump run `node scripts/download-grammars.js --write-manifest`" +
			" and commit scripts/grammars.lock.json.",
	);
	process.exit(1);
}

console.log(
	`Grammar provenance OK — ${wasmFiles.length} grammar(s) verified against ${manifest.package}@${manifest.version} ✓`,
);

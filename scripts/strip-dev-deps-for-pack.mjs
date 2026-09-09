#!/usr/bin/env node
// prepack/postpack: the published manifest must not carry `devDependencies`.
//
// Why: after `pi install npm:pi-lens`, pi supplies the host-provided packages
// with a plain `npm install --no-save` INTO the installed extension directory
// (#1926). npm's resolver (arborist) then builds the ideal tree from the
// installed package.json — devDependencies included — and walks their peer
// graph. On 2026-09-03 `@vitejs/devtools@0.7.1` / `vitest@5.0.0` published a
// peer graph that crashes npm 10.9.8 (`Cannot read properties of null
// (reading 'edgesOut')` in #loadPeerSet); every install-test lane went red and
// an npm-10 user would hit the same crash at pi's supply step. The published
// package never needs devDependencies (pi installs with --omit=dev), so they
// are stripped at pack time and restored after. Proven: same tarball, same
// npm 10.9.8 — with the block present the supply step crashes; without it,
// "added 4 packages in 3s".
//
//   node scripts/strip-dev-deps-for-pack.mjs --strip     (prepack)
//   node scripts/strip-dev-deps-for-pack.mjs --restore   (postpack)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "package.json");
const backupDir = path.join(root, ".pack-backup");
// npm re-syncs package-lock.json's root entry from the (stripped) manifest
// during `npm pack` and rewrites the whole file in its own formatting, so the
// lock is backed up and restored alongside the manifest (#2573 round 2).
const FILES = ["package.json", "package-lock.json"];

/** Pure: the manifest as it must be published. Exported for the packaging test. */
export function stripForPack(pkg) {
	const { devDependencies: _dropped, ...rest } = pkg;
	return rest;
}

function strip() {
	const raw = fs.readFileSync(manifest, "utf8");
	const pkg = JSON.parse(raw);
	if (!pkg.devDependencies) {
		console.error(
			"[strip-dev-deps] no devDependencies in package.json; nothing to do",
		);
		return;
	}
	fs.mkdirSync(backupDir, { recursive: true });
	for (const f of FILES) {
		const src = path.join(root, f);
		if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, f));
	}
	const indent = /^	/m.test(raw) ? "	" : 2;
	fs.writeFileSync(
		manifest,
		`${JSON.stringify(stripForPack(pkg), null, indent)}
`,
	);
	console.error(
		`[strip-dev-deps] removed ${Object.keys(pkg.devDependencies).length} devDependencies from package.json for packing (backup: .pack-backup/)`,
	);
}

function restore() {
	if (!fs.existsSync(backupDir)) {
		console.error("[strip-dev-deps] no backup to restore");
		return;
	}
	for (const f of FILES) {
		const b = path.join(backupDir, f);
		if (fs.existsSync(b)) fs.copyFileSync(b, path.join(root, f));
	}
	fs.rmSync(backupDir, { recursive: true, force: true });
	console.error("[strip-dev-deps] restored package.json and package-lock.json");
}

const mode = process.argv[2];
if (mode === "--strip") strip();
else if (mode === "--restore") restore();
else if (
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href ||
	process.argv[1]?.endsWith("strip-dev-deps-for-pack.mjs")
) {
	console.error("usage: strip-dev-deps-for-pack.mjs --strip | --restore");
	process.exitCode = 64;
}

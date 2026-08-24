#!/usr/bin/env node
// Bump-time changelog rollup entry point. It validates and consumes every
// `.changelog/*.md` entry, merges those entries with any legacy content still
// under `## [Unreleased]`, writes the dated package-version section, and opens
// a fresh empty `## [Unreleased]`. The tag-time release workflow only reads
// and verifies the already-rolled CHANGELOG; it never mutates it.
//
//   node scripts/changelog-release.mjs            # package version, today
//   node scripts/changelog-release.mjs 3.8.61     # explicit version
//   node scripts/changelog-release.mjs 3.8.61 --date 2026-06-25
//   node scripts/changelog-release.mjs --root-dir <checkout>

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	formatPackageLockSyncFailure,
	validatePackageLockSync,
} from "./lib/package-lock-sync.mjs";
import { rollupChangelog } from "./rollup-changelog.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
	const args = { version: undefined, date: undefined, rootDir: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--date") args.date = argv[++i];
		else if (arg === "--root-dir") args.rootDir = resolve(argv[++i]);
		else if (!args.version) args.version = arg;
	}
	return args;
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(
			`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function validateReleaseInputs(rootDir) {
	const pkg = readJson(join(rootDir, "package.json"));
	const lock = readJson(join(rootDir, "package-lock.json"));
	const problems = validatePackageLockSync(pkg, lock);
	if (problems.length > 0) {
		throw new Error(formatPackageLockSyncFailure(problems));
	}
	return pkg;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const rootDir = args.rootDir ?? PACKAGE_ROOT;

	try {
		// This preflight must remain before rollupChangelog: that function deletes
		// consumed fragments and rewrites CHANGELOG.md.
		const pkg = validateReleaseInputs(rootDir);
		const version = args.version ?? pkg.version;
		const date = args.date ?? new Date().toISOString().slice(0, 10);
		const result = rollupChangelog(version, {
			rootDir,
			date,
		});
		console.log(
			`Rolled [Unreleased] and ${result.files.length} per-entry changelog file${result.files.length === 1 ? "" : "s"} into [${version}] - ${date}.`,
		);
	} catch (error) {
		console.error(String(error.message || error));
		process.exit(1);
	}
}

main();

#!/usr/bin/env node
/**
 * Fail if package-lock.json drifts from package.json's identity or declared
 * dependency specs. A committed lock that disagrees with package.json makes
 * `npm ci` delete node_modules then hard-fail.
 *
 * Deterministic on purpose. It compares dependency SPEC STRINGS, not resolved
 * transitive versions, so it never flags spurious upstream republishes. Fix
 * any failure with `npm install` (which rewrites the lock) and commit the
 * result.
 */
import * as fs from "node:fs";
import {
	formatPackageLockSyncFailure,
	validatePackageLockSync,
} from "./lib/package-lock-sync.mjs";

function read(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		console.error(`Cannot read ${file}: ${err.message}`);
		process.exit(1);
	}
}

const pkg = read("package.json");
const lock = read("package-lock.json");
const problems = validatePackageLockSync(pkg, lock);

if (problems.length > 0) {
	console.error(formatPackageLockSyncFailure(problems));
	process.exit(1);
}

console.log("package-lock.json is in sync with package.json ✓");

#!/usr/bin/env node
/**
 * Run the advisory oxlint tier only when its optional type-aware peer is
 * available and compatible. Oxlint otherwise accepts --type-aware and can
 * silently run zero type-aware rules.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";

const require = createRequire(import.meta.url);
const TSGOLINT = "oxlint-tsgolint";

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function resolvePackageJson(packageName, resolve = require.resolve) {
	return resolve(`${packageName}/package.json`);
}

export function validateTypeAwareDependency({
	resolve = require.resolve,
	readPackage = readJson,
	fileExists = existsSync,
} = {}) {
	let oxlintPackagePath;
	let oxlintVersion = "unknown";
	try {
		oxlintPackagePath = resolvePackageJson("oxlint", resolve);
	} catch {
		return {
			ok: false,
			message:
				"oxlint advisory: oxlint is not installed; the type-aware tier would silently run untyped",
		};
	}
	try {
		oxlintVersion = readPackage(oxlintPackagePath).version ?? "unknown";
		const tsgolintPackagePath = resolvePackageJson(TSGOLINT, resolve);
		return validateResolvedDependency({
			oxlintPackagePath,
			tsgolintPackagePath,
			oxlintVersion,
			readPackage,
			fileExists,
		});
	} catch {
		return {
			ok: false,
			message: `oxlint advisory: oxlint-tsgolint is not installed (peer of oxlint ${oxlintVersion}); the type-aware tier would silently run untyped`,
		};
	}
}

function validateResolvedDependency({
	oxlintPackagePath,
	tsgolintPackagePath,
	oxlintVersion,
	readPackage,
	fileExists,
}) {
	const oxlint = readPackage(oxlintPackagePath);
	const tsgolint = readPackage(tsgolintPackagePath);
	const peerRange = oxlint.peerDependencies?.[TSGOLINT];
	if (
		tsgolint.name !== TSGOLINT ||
		tsgolint.version === undefined ||
		tsgolint.version === "" ||
		typeof peerRange !== "string" ||
		!semver.satisfies(tsgolint.version, peerRange)
	) {
		return {
			ok: false,
			message: `oxlint advisory: oxlint-tsgolint ${tsgolint.version ?? "unknown"} does not satisfy oxlint ${oxlint.version ?? "unknown"}'s peer range ${peerRange ?? "unknown"}; the type-aware tier would silently run untyped`,
		};
	}

	const bin = tsgolint.bin?.tsgolint;
	const binaryPath =
		typeof bin === "string" ? join(dirname(tsgolintPackagePath), bin) : "";
	if (!binaryPath || !fileExists(binaryPath)) {
		return {
			ok: false,
			message: `oxlint advisory: oxlint-tsgolint is not installed (peer of oxlint ${oxlintVersion}); the type-aware tier would silently run untyped`,
		};
	}

	return { ok: true, binaryPath, oxlintVersion: oxlint.version };
}

export function runAdvisory({
	args = process.argv.slice(2),
	spawn = spawnSync,
	...options
} = {}) {
	const dependency = validateTypeAwareDependency(options);
	if (!dependency.ok) {
		console.error(dependency.message);
		return 2;
	}

	const result = spawn("oxlint", args, {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = runAdvisory();
}

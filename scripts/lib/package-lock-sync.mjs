const LOCK_ROOT = 'package-lock.json.packages[""]';

function display(value) {
	return value === undefined ? "(missing)" : JSON.stringify(value);
}

/**
 * Return every package.json/package-lock.json mirror mismatch.
 *
 * This function compares parsed values only. Callers own file I/O so the same
 * validator can guard the CLI, CI, and release-time mutation path.
 */
export function validatePackageLockSync(pkg, lock) {
	const root = lock?.packages?.[""] ?? {};
	const problems = [];

	const identities = [
		["package.json.name", pkg.name, "package-lock.json.name", lock.name],
		["package.json.name", pkg.name, `${LOCK_ROOT}.name`, root.name],
		[
			"package.json.version",
			pkg.version,
			"package-lock.json.version",
			lock.version,
		],
		["package.json.version", pkg.version, `${LOCK_ROOT}.version`, root.version],
	];
	for (const [packageField, packageValue, lockField, lockValue] of identities) {
		if (packageValue !== lockValue) {
			problems.push(
				`${packageField}=${display(packageValue)} does not match ${lockField}=${display(lockValue)}`,
			);
		}
	}

	const sections = [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	];
	for (const section of sections) {
		const pkgDeps = pkg[section] ?? {};
		const lockDeps = root[section] ?? {};
		for (const [name, spec] of Object.entries(pkgDeps)) {
			if (lockDeps[name] !== spec) {
				problems.push(
					`package.json.${section}.${name}=${JSON.stringify(spec)} does not match ${LOCK_ROOT}.${section}.${name}=${display(lockDeps[name])}`,
				);
			}
		}
		for (const name of Object.keys(lockDeps)) {
			if (!(name in pkgDeps)) {
				problems.push(
					`${LOCK_ROOT}.${section}.${name}=${JSON.stringify(lockDeps[name])} has no package.json.${section}.${name}`,
				);
			}
		}
	}

	return problems;
}

export function formatPackageLockSyncFailure(problems) {
	return [
		"package-lock.json is out of sync with package.json:",
		"",
		...problems.map(
			(problem) =>
				`  - ${problem}; remediation: run \`npm install\` and commit the updated package-lock.json.`,
		),
		"",
		"Run `npm install` and commit the updated package-lock.json.",
	].join("\n");
}

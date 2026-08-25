import { isDeepStrictEqual } from "node:util";

const LOCK_ROOT = 'package-lock.json.packages[""]';

function display(value) {
	return value === undefined ? "(missing)" : JSON.stringify(value);
}

function isJsonObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectSection(value, field, problems) {
	if (value === undefined) return {};
	if (!isJsonObject(value)) {
		problems.push(`${field} must be a JSON object`);
		return undefined;
	}
	return value;
}

/** Fields npm mirrors into the lock root (verified against npm 11.17). */
const ROOT_METADATA_FIELDS = [
	"license",
	"bin",
	"engines",
	"os",
	"cpu",
	"libc",
	"funding",
	"bundleDependencies",
];

function isEmptyContainer(value) {
	if (typeof value === "string") return value.trim() === "";
	if (Array.isArray(value)) return value.length === 0;
	return isJsonObject(value) && Object.keys(value).length === 0;
}

function packageMetadataValue(pkg, field) {
	if (field !== "bundleDependencies") return pkg[field];
	return pkg.bundleDependencies ?? pkg.bundledDependencies;
}

function normalizeRootMetadata(field, value, packageName) {
	// npm omits empty/blank metadata when writing the lock root (verified
	// against npm 11.17 fresh installs): empty bin/engines/funding/os/cpu/
	// bundleDependencies containers and blank strings never appear there.
	if (isEmptyContainer(value)) {
		return undefined;
	}
	if (field === "bin" && typeof value === "string") {
		const command =
			typeof packageName === "string"
				? packageName.split("/").filter(Boolean).at(-1)
				: undefined;
		return command ? { [command]: value } : value;
	}
	return value;
}

/**
 * Return every package.json/package-lock.json mirror mismatch.
 *
 * This function compares parsed values only. Callers own file I/O so the same
 * validator can guard the CLI, CI, and release-time mutation path.
 */
export function validatePackageLockSync(pkg, lock) {
	const problems = [];
	if (!isJsonObject(pkg)) {
		problems.push("package.json root must be a JSON object");
	}
	if (!isJsonObject(lock)) {
		problems.push("package-lock.json root must be a JSON object");
	}
	if (problems.length > 0) return problems;

	const root = lock.packages?.[""];
	if (!isJsonObject(root)) {
		return [`${LOCK_ROOT} must be a JSON object`];
	}

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

	for (const field of ROOT_METADATA_FIELDS) {
		const packageRawValue = packageMetadataValue(pkg, field);
		const packageValue = normalizeRootMetadata(
			field,
			packageRawValue,
			pkg.name,
		);
		const lockValue = normalizeRootMetadata(field, root[field], root.name);
		if (!isDeepStrictEqual(packageValue, lockValue)) {
			problems.push(
				`package.json.${field}=${display(packageRawValue)} does not match ${LOCK_ROOT}.${field}=${display(root[field])}`,
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
		const pkgDeps = objectSection(
			pkg[section],
			`package.json.${section}`,
			problems,
		);
		const lockDeps = objectSection(
			root[section],
			`${LOCK_ROOT}.${section}`,
			problems,
		);
		if (pkgDeps === undefined || lockDeps === undefined) continue;
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

	const pkgPeerMeta = objectSection(
		pkg.peerDependenciesMeta,
		"package.json.peerDependenciesMeta",
		problems,
	);
	const lockPeerMeta = objectSection(
		root.peerDependenciesMeta,
		`${LOCK_ROOT}.peerDependenciesMeta`,
		problems,
	);
	if (
		pkgPeerMeta !== undefined &&
		lockPeerMeta !== undefined &&
		!isDeepStrictEqual(pkgPeerMeta, lockPeerMeta)
	) {
		problems.push(
			`package.json.peerDependenciesMeta=${display(pkgPeerMeta)} does not match ${LOCK_ROOT}.peerDependenciesMeta=${display(lockPeerMeta)}`,
		);
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

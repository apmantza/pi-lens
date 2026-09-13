import * as fs from "node:fs";
import * as path from "node:path";
import { BoundedFifoMap } from "./bounded-cache.js";
import { findNearestMarkerRoot } from "./path-utils.js";
import { getDegradationLedgerGeneration } from "./degradation-ledger.js";
import { hasGradleKtlintPlugin, hasKtlintConfig } from "./tool-policy.js";

export type ToolAgreementDeclineReason =
	| "evidence-unreadable"
	| "evidence-unparseable"
	| "evidence-unsupported";

export type ToolAgreement =
	| { decision: "established" }
	| {
			decision: "decline";
			subject: string;
			reason: string;
			reasonCode: ToolAgreementDeclineReason;
	  };

const NODE_PACKAGES: Record<string, string> = {
	biome: "@biomejs/biome",
	eslint: "eslint",
	oxlint: "oxlint",
	stylelint: "stylelint",
};

type JsonRead =
	| { kind: "missing" }
	| { kind: "unreadable" }
	| { kind: "unparseable" }
	| { kind: "value"; value: Record<string, unknown> };

function readJson(filePath: string): JsonRead {
	if (!fs.existsSync(filePath)) return { kind: "missing" };
	try {
		const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return value && typeof value === "object"
			? { kind: "value", value: value as Record<string, unknown> }
			: { kind: "unparseable" };
	} catch (error) {
		return {
			kind: error instanceof SyntaxError ? "unparseable" : "unreadable",
		};
	}
}

function declaredRange(
	pkg: Record<string, unknown>,
	name: string,
): string | undefined {
	for (const field of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
	] as const) {
		const deps = pkg[field];
		if (deps && typeof deps === "object") {
			const range = (deps as Record<string, unknown>)[name];
			if (typeof range === "string") return range;
		}
	}
	return undefined;
}

function parseCoreVersion(
	version: string,
): [number, number, number] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) return undefined;
	const parts = match.slice(1).map(Number);
	if (parts.some((part) => !Number.isSafeInteger(part))) return undefined;
	return parts as [number, number, number];
}

function exactOrSimpleRangeMatches(
	range: string,
	version: string,
): { matches: boolean; unsupported: boolean } {
	const clean = range.trim().replace(/^v/, "");
	const actual = parseCoreVersion(version);
	if (!actual) return { matches: false, unsupported: version.includes("+") };
	if (/^\d+\.\d+\.\d+$/.test(clean))
		return { matches: clean === version, unsupported: false };
	const caret = clean.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
	if (caret) {
		const [major, minor, patch] = caret.slice(1).map(Number);
		return {
			matches:
				actual[0] === major &&
				(major !== 0 || actual[1] === minor) &&
				(major !== 0 || minor !== 0 || actual[2] === patch) &&
				(actual[1] > minor || (actual[1] === minor && actual[2] >= patch)),
			unsupported: false,
		};
	}
	const tilde = clean.match(/^~(\d+)\.(\d+)\.(\d+)$/);
	if (tilde) {
		const [major, minor, patch] = tilde.slice(1).map(Number);
		return {
			matches: actual[0] === major && actual[1] === minor && actual[2] >= patch,
			unsupported: false,
		};
	}
	return { matches: false, unsupported: true };
}

function nodeAgreement(tool: string, root: string): ToolAgreement | undefined {
	const packageName = NODE_PACKAGES[tool];
	if (!packageName) return undefined;
	const pkg = readJson(path.join(root, "package.json"));
	if (pkg.kind === "unreadable" || pkg.kind === "unparseable") {
		return {
			decision: "decline",
			subject: `node:${tool}`,
			reason: `the project package.json is ${pkg.kind}; tool agreement cannot be established`,
			reasonCode: `evidence-${pkg.kind}`,
		};
	}
	const range =
		pkg.kind === "value" ? declaredRange(pkg.value, packageName) : undefined;
	if (!range) return undefined;
	const lock = readJson(path.join(root, "package-lock.json"));
	if (lock.kind === "unreadable" || lock.kind === "unparseable") {
		return {
			decision: "decline",
			subject: `node:${tool}`,
			reason: `the project package-lock.json is ${lock.kind}; tool agreement cannot be established`,
			reasonCode: `evidence-${lock.kind}`,
		};
	}
	const packages = lock.kind === "value" ? lock.value.packages : undefined;
	const entry =
		packages && typeof packages === "object"
			? (packages as Record<string, unknown>)[`node_modules/${packageName}`]
			: undefined;
	const version =
		entry && typeof entry === "object"
			? (entry as Record<string, unknown>).version
			: undefined;
	const comparison =
		typeof version === "string"
			? exactOrSimpleRangeMatches(range, version)
			: { matches: false, unsupported: false };
	if (typeof version !== "string" || !comparison.matches) {
		const reasonCode =
			typeof version === "string" && comparison.unsupported
				? "evidence-unsupported"
				: typeof version === "string" && version.includes("+")
					? "evidence-unsupported"
					: "evidence-unparseable";
		const reason =
			typeof version === "string" && comparison.unsupported
				? `the project declares ${packageName}@${range}, but the lockfile shape ${packageName}@${version} or its range is unsupported; tool agreement cannot be established`
				: typeof version === "string" && parseCoreVersion(version)
					? `the project declares ${packageName}@${range} in package.json, but the lockfile resolves ${packageName}@${version} in package-lock.json; agreement disagrees`
					: `the project declares ${packageName}@${range} in package.json, but package-lock.json does not establish its resolved version; tool agreement cannot be established`;
		return {
			decision: "decline",
			subject: `node:${tool}`,
			reason,
			reasonCode,
		};
	}
	return { decision: "established" };
}

/** Decide whether autofix has project evidence to act on. Never infers a CLI
 * version from build-plugin metadata (#3000). */
export function establishToolAgreement(
	tool: string,
	cwd: string,
): ToolAgreement {
	const key = `${getDegradationLedgerGeneration()}\0${path.resolve(cwd)}\0${tool}`;
	const cached = agreementCache.get(key);
	if (cached) return cached;
	agreementResolutionCount += 1;
	let agreement: ToolAgreement = { decision: "established" };
	if (tool === "ktlint") {
		const ownership = hasGradleKtlintPlugin(cwd);
		if (ownership.kind === "owned" || hasKtlintConfig(cwd)) {
			agreement = {
				decision: "decline",
				subject: "kotlin:gradle-ktlint",
				reason:
					"the project resolves ktlint through Gradle, so CLI agreement cannot be established from project data",
				reasonCode: "evidence-unsupported",
			};
		} else if (ownership.kind === "indeterminate") {
			agreement = {
				decision: "decline",
				subject: "kotlin:gradle-ktlint",
				reason:
					"Gradle ownership evidence is unreadable or exceeded its scan budget; tool agreement cannot be established",
				reasonCode: "evidence-unreadable",
			};
		}
	}
	const root =
		agreement.decision === "established"
			? findNearestMarkerRoot(cwd, ["package.json"], {
					boundaries: [".git", ".hg", ".svn"],
				})
			: null;
	if (agreement.decision === "established" && root) {
		const node = nodeAgreement(tool, root);
		if (node) agreement = node;
	}
	agreementCache.set(key, agreement);
	return agreement;
}

const agreementCache = new BoundedFifoMap<string, ToolAgreement>(512);
let agreementResolutionCount = 0;

/** Test-only counter for the bounded hot-path resolution. */
export function _getAgreementResolutionCountForTests(): number {
	return agreementResolutionCount;
}

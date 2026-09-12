import * as fs from "node:fs";
import * as path from "node:path";
import { hasGradleKtlintPlugin } from "./tool-policy.js";

export type ToolAgreement =
	| { decision: "established" }
	| { decision: "decline"; subject: string; reason: string };

const NODE_PACKAGES: Record<string, string> = {
	biome: "@biomejs/biome",
	eslint: "eslint",
	oxlint: "oxlint",
	stylelint: "stylelint",
};

function projectRoot(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
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

function exactOrSimpleRangeMatches(range: string, version: string): boolean {
	const clean = range.trim().replace(/^v/, "");
	if (/^\d+\.\d+\.\d+$/.test(clean)) return clean === version;
	const caret = clean.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
	if (caret) {
		const [major, minor, patch] = caret.slice(1).map(Number);
		const actual = version.split(".").map(Number);
		return (
			actual[0] === major &&
			(major !== 0 || actual[1] === minor) &&
			(major !== 0 || minor !== 0 || actual[2] === patch) &&
			(actual[1] > minor || (actual[1] === minor && actual[2] >= patch))
		);
	}
	const tilde = clean.match(/^~(\d+)\.(\d+)\.(\d+)$/);
	if (tilde) {
		const [major, minor, patch] = tilde.slice(1).map(Number);
		const actual = version.split(".").map(Number);
		return actual[0] === major && actual[1] === minor && actual[2] >= patch;
	}
	return false;
}

function nodeAgreement(tool: string, root: string): ToolAgreement | undefined {
	const packageName = NODE_PACKAGES[tool];
	if (!packageName) return undefined;
	const pkg = readJson(path.join(root, "package.json"));
	const range = pkg && declaredRange(pkg, packageName);
	if (!range) return undefined;
	const lock = readJson(path.join(root, "package-lock.json"));
	const packages = lock?.packages;
	const entry =
		packages && typeof packages === "object"
			? (packages as Record<string, unknown>)[`node_modules/${packageName}`]
			: undefined;
	const version =
		entry && typeof entry === "object"
			? (entry as Record<string, unknown>).version
			: undefined;
	if (
		typeof version !== "string" ||
		!exactOrSimpleRangeMatches(range, version)
	) {
		const reason =
			typeof version === "string"
				? `the project declares ${packageName}@${range} in package.json, but the lockfile resolves ${packageName}@${version} in package-lock.json; agreement disagrees`
				: `the project declares ${packageName}@${range} in package.json, but package-lock.json does not establish its resolved version`;
		return {
			decision: "decline",
			subject: `node:${tool}`,
			reason,
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
	if (tool === "ktlint" && hasGradleKtlintPlugin(cwd)) {
		return {
			decision: "decline",
			subject: "kotlin:gradle-ktlint",
			reason:
				"the project resolves ktlint through Gradle, so CLI agreement cannot be established from project data",
		};
	}
	const root = projectRoot(cwd);
	if (root) {
		const node = nodeAgreement(tool, root);
		if (node) return node;
	}
	return { decision: "established" };
}

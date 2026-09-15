import * as fs from "node:fs";
import * as path from "node:path";
import { BoundedFifoMap } from "./bounded-cache.js";
import { findNearestMarkerRoot } from "./path-utils.js";
import { getDegradationLedgerGeneration } from "./degradation-ledger.js";
import {
	hasBlackConfig,
	hasClangFormatConfig,
	hasCljfmtConfig,
	hasCmakeFormatConfig,
	hasCsharpierConfig,
	hasDetektConfig,
	hasFantomasConfig,
	hasGoogleJavaFormatConfig,
	hasGradleKtlintPlugin,
	hasGolangciConfig,
	hasKtfmtConfig,
	hasKtlintConfig,
	hasMarkdownlintConfig,
	hasMixFormatConfig,
	hasOcamlformatConfig,
	hasOrmoluConfig,
	hasPhpCsFixerConfig,
	hasRubocopConfig,
	hasRuffConfig,
	hasSqlfluffConfig,
	hasStandardrbConfig,
	hasStyluaConfig,
	hasSwiftformatConfig,
	hasTaploConfig,
	hasTerraformConfig,
} from "./tool-policy.js";

export type ToolAgreementDeclineReason =
	| "evidence-absent"
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
	markdownlint: "markdownlint-cli2",
	oxfmt: "oxfmt",
	oxlint: "oxlint",
	prettier: "prettier",
	stylelint: "stylelint",
};

export type ToolAgreementEvidenceBucket =
	| "node-lockfile"
	| "project-config"
	| "standalone-cli";
type EvidenceCheck = (cwd: string) => boolean;

/**
 * The complete autonomous writer population. Keep this table declarative: a
 * caller may ask about an LSP warning tool that is not in the autofix or
 * formatter tables, and that must take the unknown-tool default below rather
 * than accidentally becoming established (#3005).
 *
 * Config evidence is deliberately presence-based. The existing policy
 * detectors own each format's syntax and scope; agreement only answers the
 * narrower question of whether this project elected the tool. Node tools use
 * the stronger lockfile identity check in `nodeAgreement`.
 */
export const TOOL_AGREEMENT_POLICIES: Readonly<
	Record<
		string,
		{
			bucket: ToolAgreementEvidenceBucket;
			withoutEvidence: "decline";
			check?: EvidenceCheck;
		}
	>
> = {
	biome: { bucket: "node-lockfile", withoutEvidence: "decline" },
	eslint: { bucket: "node-lockfile", withoutEvidence: "decline" },
	markdownlint: {
		bucket: "node-lockfile",
		withoutEvidence: "decline",
		check: hasMarkdownlintConfig,
	},
	oxfmt: { bucket: "node-lockfile", withoutEvidence: "decline" },
	oxlint: { bucket: "node-lockfile", withoutEvidence: "decline" },
	prettier: { bucket: "node-lockfile", withoutEvidence: "decline" },
	stylelint: { bucket: "node-lockfile", withoutEvidence: "decline" },
	ruff: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasRuffConfig,
	},
	black: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasBlackConfig,
	},
	sqlfluff: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasSqlfluffConfig,
	},
	rubocop: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasRubocopConfig,
	},
	standardrb: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasStandardrbConfig,
	},
	ktlint: { bucket: "standalone-cli", withoutEvidence: "decline" },
	ktfmt: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasKtfmtConfig,
	},
	"rust-clippy": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["Cargo.toml"]),
	},
	"dart-analyze": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["pubspec.yaml"]),
	},
	"golangci-lint": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasGolangciConfig,
	},
	detekt: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasDetektConfig,
	},
	gofmt: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["go.mod"]),
	},
	rustfmt: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["Cargo.toml"]),
	},
	zig: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["build.zig"]),
	},
	dart: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["pubspec.yaml"]),
	},
	shfmt: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, [".editorconfig"]),
	},
	// nixfmt has no honest project marker. It remains in the population and is
	// declined by the conservative absent-evidence path below.
	nixfmt: { bucket: "project-config", withoutEvidence: "decline" },
	mix: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasMixFormatConfig,
	},
	ocamlformat: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasOcamlformatConfig,
	},
	"clang-format": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasClangFormatConfig,
	},
	gleam: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["gleam.toml"]),
	},
	terraform: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasTerraformConfig,
	},
	"terragrunt-hcl": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["terragrunt.hcl", "terragrunt.hcl.json"]),
	},
	"php-cs-fixer": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasPhpCsFixerConfig,
	},
	csharpier: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasCsharpierConfig,
	},
	fantomas: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasFantomasConfig,
	},
	swiftformat: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasSwiftformatConfig,
	},
	stylua: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasStyluaConfig,
	},
	ormolu: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasOrmoluConfig,
	},
	taplo: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasTaploConfig,
	},
	"google-java-format": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasGoogleJavaFormatConfig,
	},
	cljfmt: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasCljfmtConfig,
	},
	"cmake-format": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: hasCmakeFormatConfig,
	},
	"psscriptanalyzer-format": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) =>
			hasMarker(cwd, [
				"PSScriptAnalyzerSettings.psd1",
				"ScriptAnalyzerSettings.psd1",
			]),
	},
	cue: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["cue.mod"]),
	},
};

function hasMarker(cwd: string, markers: readonly string[]): boolean {
	return (
		findNearestMarkerRoot(cwd, markers, {
			boundaries: [".git", ".hg", ".svn"],
		}) !== null
	);
}

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
	const policy = TOOL_AGREEMENT_POLICIES[tool];
	if (!policy) {
		const agreement: ToolAgreement = {
			decision: "decline",
			subject: `tool:${tool}`,
			reason:
				"the autonomous writer is not registered with a project-evidence policy; tool agreement cannot be established",
			reasonCode: "evidence-unsupported",
		};
		agreementCache.set(key, agreement);
		return agreement;
	}
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
	if (
		agreement.decision === "established" &&
		policy.bucket === "node-lockfile"
	) {
		const root = findNearestMarkerRoot(cwd, ["package.json"], {
			boundaries: [".git", ".hg", ".svn"],
		});
		const node = root ? nodeAgreement(tool, root) : undefined;
		agreement = node ?? {
			decision: "decline",
			subject: `node:${tool}`,
			reason:
				"the project has no package declaration and lockfile evidence for this tool",
			reasonCode: "evidence-absent",
		};
	} else if (
		agreement.decision === "established" &&
		policy.bucket === "project-config" &&
		(!policy.check || !policy.check(cwd))
	) {
		agreement = {
			decision: "decline",
			subject: `project:${tool}`,
			reason:
				"the project has no readable configuration or manifest evidence selecting this tool",
			reasonCode: "evidence-absent",
		};
	}
	/* Keep the branch below as a final assertion that no policy can bypass the
	 * registry. It also makes future bucket additions fail closed at runtime. */
	if (agreement.decision === "established" && !policy.bucket) {
		agreement = {
			decision: "decline",
			subject: `tool:${tool}`,
			reason: "the tool evidence bucket is unsupported",
			reasonCode: "evidence-unsupported",
		};
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

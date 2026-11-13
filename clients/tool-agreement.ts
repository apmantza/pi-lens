import * as fs from "node:fs";
import * as path from "node:path";
import { BoundedFifoMap } from "./bounded-cache.js";
import { load as loadYaml } from "./deps/js-yaml.js";
import { findNearestMarkerRoot, toPosix } from "./path-utils.js";
import { getDegradationLedgerGeneration } from "./degradation-ledger.js";
import { hasToolConfig } from "./tool-config-presence.js";
import {
	hasGradleKtlintPlugin,
	hasKtfmtConfig,
	hasKtlintConfig,
} from "./tool-policy.js";

export type ToolAgreementDeclineReason =
	| "evidence-absent"
	| "evidence-unreadable"
	| "evidence-unparseable"
	| "evidence-unsupported"
	| "evidence-too-large";

export type ToolAgreement =
	| { decision: "established"; lockfile?: string }
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

// Deterministic Node lockfile precedence within one candidate directory:
// package-lock.json wins over pnpm-lock.yaml, which wins over yarn.lock.
// Every agreement decision names its supplying lockfile.
const NODE_LOCKFILE_PRECEDENCE = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
] as const;

/**
 * Read bound for `pnpm-lock.yaml` and `yarn.lock` (#3656 review). The parse is
 * synchronous on the autofix path: js-yaml measured ~0.5 s at 16 MiB and ~1 s
 * at 32 MiB, and the decision is cached per session generation. A file over
 * the bound is declined with `evidence-too-large`, never read in full.
 */
export const NODE_LOCKFILE_MAX_BYTES = 16 * 1024 * 1024;

type NodeLockfileName = (typeof NODE_LOCKFILE_PRECEDENCE)[number];

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
		check: (cwd) => hasToolConfig("markdownlint", cwd),
	},
	oxfmt: { bucket: "node-lockfile", withoutEvidence: "decline" },
	oxlint: { bucket: "node-lockfile", withoutEvidence: "decline" },
	prettier: { bucket: "node-lockfile", withoutEvidence: "decline" },
	stylelint: { bucket: "node-lockfile", withoutEvidence: "decline" },
	ruff: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("ruff", cwd),
	},
	black: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("black", cwd),
	},
	sqlfluff: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("sqlfluff", cwd),
	},
	rubocop: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("rubocop", cwd),
	},
	standardrb: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("standardrb", cwd),
	},
	ktlint: { bucket: "standalone-cli", withoutEvidence: "decline" },
	// typstyle is a standalone formatter binary. Its smart-default policy is
	// autonomous, so PATH or managed-install availability is sufficient
	// agreement; it is not owned by a project manifest (#3037).
	typstyle: { bucket: "standalone-cli", withoutEvidence: "decline" },
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
		check: (cwd) => hasToolConfig("golangci-lint", cwd),
	},
	detekt: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("detekt", cwd),
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
		check: (cwd) => hasToolConfig("mixFormat", cwd),
	},
	ocamlformat: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("ocamlformat", cwd),
	},
	"clang-format": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("clang-format", cwd),
	},
	gleam: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["gleam.toml"]),
	},
	terraform: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("terraform", cwd),
	},
	"terragrunt-hcl": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasMarker(cwd, ["terragrunt.hcl", "terragrunt.hcl.json"]),
	},
	"php-cs-fixer": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("php-cs-fixer", cwd),
	},
	csharpier: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("csharpier", cwd),
	},
	fantomas: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("fantomas", cwd),
	},
	swiftformat: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("swiftformat", cwd),
	},
	stylua: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("stylua", cwd),
	},
	ormolu: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("ormolu", cwd),
	},
	taplo: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("taplo", cwd),
	},
	"google-java-format": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("google-java-format", cwd),
	},
	cljfmt: {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("cljfmt", cwd),
	},
	"cmake-format": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("cmake-format", cwd),
	},
	"psscriptanalyzer-format": {
		bucket: "project-config",
		withoutEvidence: "decline",
		check: (cwd) => hasToolConfig("psscriptanalyzer", cwd),
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

function pnpmEvidence(
	doc: unknown,
	packageName: string,
	importerKey: string,
): { kind: "resolved"; version: unknown } | { kind: "unsupported-shape" } {
	if (doc && typeof doc === "object" && !Array.isArray(doc)) {
		const docRecord = doc as Record<string, unknown>;
		const importers = docRecord.importers;
		if (
			importers &&
			typeof importers === "object" &&
			!Array.isArray(importers)
		) {
			// pnpm v9: per-importer dependency maps. The importer key is "."
			// when the lockfile sits beside package.json, else the POSIX
			// relative path from the lockfile directory (workspace members).
			const importer = (importers as Record<string, unknown>)[importerKey];
			if (importer && typeof importer === "object") {
				for (const field of ["dependencies", "devDependencies"] as const) {
					const deps = (importer as Record<string, unknown>)[field];
					if (deps && typeof deps === "object") {
						const entry = (deps as Record<string, unknown>)[packageName];
						if (entry && typeof entry === "object") {
							return {
								kind: "resolved",
								version: (entry as Record<string, unknown>).version,
							};
						}
					}
				}
			}
			return { kind: "resolved", version: undefined };
		}
		// pnpm v6: top-level dependency maps with no importers. The entry
		// shape matches v9, so it is read the same way rather than declined.
		let sawTopLevelMaps = false;
		let v6version: unknown;
		let v6found = false;
		for (const field of ["dependencies", "devDependencies"] as const) {
			const deps = docRecord[field];
			if (deps && typeof deps === "object" && !Array.isArray(deps)) {
				sawTopLevelMaps = true;
				const entry = (deps as Record<string, unknown>)[packageName];
				if (entry && typeof entry === "object") {
					v6version = (entry as Record<string, unknown>).version;
					v6found = true;
					break;
				}
			}
		}
		if (v6found || sawTopLevelMaps) {
			return { kind: "resolved", version: v6found ? v6version : undefined };
		}
	}
	return { kind: "unsupported-shape" };
}

function decideNodeVersionAgreement(
	tool: string,
	packageName: string,
	range: string,
	version: unknown,
	supplier: Exclude<NodeLockfileName, "package-lock.json">,
): ToolAgreement {
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
				? `the project declares ${packageName}@${range} in package.json, but the lockfile shape ${packageName}@${version} in ${supplier} or its range is unsupported; tool agreement cannot be established`
				: typeof version === "string" && parseCoreVersion(version)
					? `the project declares ${packageName}@${range} in package.json, but the lockfile resolves ${packageName}@${version} in ${supplier}; agreement disagrees`
					: `the project declares ${packageName}@${range} in package.json, but ${supplier} does not establish its resolved version; tool agreement cannot be established`;
		return {
			decision: "decline",
			subject: `node:${tool}`,
			reason,
			reasonCode,
		};
	}
	return { decision: "established", lockfile: supplier };
}

type LockfileRead =
	| { kind: "text"; text: string }
	| { kind: "too-large" }
	| { kind: "unreadable" };

/** Read a lockfile without ever holding more than the bound plus one byte. */
function readLockfileBounded(filePath: string): LockfileRead {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.allocUnsafe(
			Math.min(fs.fstatSync(fd).size, NODE_LOCKFILE_MAX_BYTES) + 1,
		);
		let total = 0;
		while (total < buffer.length) {
			const read = fs.readSync(fd, buffer, total, buffer.length - total, null);
			if (read === 0) break;
			total += read;
		}
		return total > NODE_LOCKFILE_MAX_BYTES
			? { kind: "too-large" }
			: { kind: "text", text: buffer.toString("utf8", 0, total) };
	} catch {
		return { kind: "unreadable" };
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// A failed close cannot change what was already read.
			}
		}
	}
}

function lockfileReadDecline(
	tool: string,
	lockfile: "pnpm-lock.yaml" | "yarn.lock",
	read: Exclude<LockfileRead, { kind: "text" }>,
): ToolAgreement {
	return read.kind === "too-large"
		? {
				decision: "decline",
				subject: `node:${tool}`,
				reason: `the project ${lockfile} exceeds the ${NODE_LOCKFILE_MAX_BYTES}-byte lockfile read bound; tool agreement cannot be established`,
				reasonCode: "evidence-too-large",
			}
		: {
				decision: "decline",
				subject: `node:${tool}`,
				reason: `the project ${lockfile} is unreadable; tool agreement cannot be established`,
				reasonCode: "evidence-unreadable",
			};
}

/**
 * pnpm writes a resolved dependency as the version followed by balanced
 * `(...)` peer-context groups, e.g. `16.4.0(less@4.2.0)(postcss@8.4.0(x@1.0.0))`
 * (`indexOfDepPathSuffix` in @pnpm/dependency-path@1001.1.10). Return the core
 * version when the whole suffix fits that grammar; any other shape is returned
 * unchanged so it still declines as unparseable.
 */
function stripPnpmPeerSuffix(version: string): string {
	const core = /^\d+\.\d+\.\d+/.exec(version)?.[0];
	if (!core || core.length === version.length) return version;
	let depth = 0;
	for (let i = core.length; i < version.length; i += 1) {
		const char = version[i];
		if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			if (depth === 0 || version[i - 1] === "(") return version;
			depth -= 1;
		} else if (depth === 0) {
			return version;
		}
	}
	return depth === 0 ? core : version;
}

function pnpmAgreement(
	tool: string,
	packageName: string,
	range: string,
	root: string,
	lockDir: string,
): ToolAgreement {
	const filePath = path.join(lockDir, "pnpm-lock.yaml");
	const read = readLockfileBounded(filePath);
	if (read.kind !== "text") {
		return lockfileReadDecline(tool, "pnpm-lock.yaml", read);
	}
	let doc: unknown;
	try {
		doc = loadYaml(read.text);
	} catch {
		return {
			decision: "decline",
			subject: `node:${tool}`,
			reason:
				"the project pnpm-lock.yaml is unparseable; tool agreement cannot be established",
			reasonCode: "evidence-unparseable",
		};
	}
	const importerKey =
		lockDir === path.resolve(root)
			? "."
			: toPosix(path.relative(lockDir, root));
	const evidence = pnpmEvidence(doc, packageName, importerKey);
	if (evidence.kind === "unsupported-shape") {
		return {
			decision: "decline",
			subject: `node:${tool}`,
			reason:
				"the project pnpm-lock.yaml has an unsupported lockfile shape; tool agreement cannot be established",
			reasonCode: "evidence-unsupported",
		};
	}
	return decideNodeVersionAgreement(
		tool,
		packageName,
		range,
		typeof evidence.version === "string"
			? stripPnpmPeerSuffix(evidence.version)
			: evidence.version,
		"pnpm-lock.yaml",
	);
}

function yarnV1Blocks(
	text: string,
	packageName: string,
): { descriptors: string[]; version: unknown }[] {
	const found: { descriptors: string[]; version: unknown }[] = [];
	for (const block of text.split(/\n[ \t]*\n/)) {
		const lines = block.split("\n");
		const header = (lines[0] ?? "").trim();
		if (!header.endsWith(":")) continue;
		const prefix = `${packageName}@`;
		const descriptors: string[] = [];
		for (const rawPart of header.slice(0, -1).split(",")) {
			const part = rawPart.trim().replace(/^"|"$/g, "").trim();
			if (part.startsWith(prefix) && !part.slice(prefix.length).includes(":")) {
				descriptors.push(part);
			}
		}
		if (descriptors.length === 0) continue;
		let version: unknown;
		for (const line of lines.slice(1)) {
			const match = /^\s*version\s+"([^"]*)"/.exec(line);
			if (match) {
				version = match[1];
				break;
			}
		}
		found.push({ descriptors, version });
	}
	return found;
}

function yarnBerryEntries(
	doc: unknown,
	packageName: string,
): { descriptors: string[]; version: unknown }[] | undefined {
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
	const docRecord = doc as Record<string, unknown>;
	if (!docRecord.__metadata || typeof docRecord.__metadata !== "object")
		return undefined;
	const found: { descriptors: string[]; version: unknown }[] = [];
	const marker = "@npm:";
	for (const [key, entry] of Object.entries(docRecord)) {
		const unquoted = key.replace(/^"|"$/g, "");
		const at = unquoted.lastIndexOf(marker);
		if (at < 0) continue;
		if (unquoted.slice(0, at) !== packageName) continue;
		const version =
			entry && typeof entry === "object"
				? (entry as Record<string, unknown>).version
				: undefined;
		found.push({ descriptors: [unquoted.slice(at + marker.length)], version });
	}
	return found;
}

type YarnCandidateVersion = string | undefined;

function selectNodeCandidate(
	candidates: { descriptors: string[]; version: unknown }[],
	range: string,
): YarnCandidateVersion {
	// A block whose descriptor range equals the declared range wins; otherwise
	// the first block for the package supplies the version under test.
	// Non-string versions coerce to undefined at this boundary: the version
	// decision treats both as "does not establish its resolved version".
	for (const candidate of candidates) {
		if (candidate.descriptors.some((descriptor) => descriptor === range)) {
			return typeof candidate.version === "string"
				? candidate.version
				: undefined;
		}
	}
	const first = candidates.length > 0 ? candidates[0]?.version : undefined;
	return typeof first === "string" ? first : undefined;
}

function yarnAgreement(
	tool: string,
	packageName: string,
	range: string,
	filePath: string,
): ToolAgreement {
	const read = readLockfileBounded(filePath);
	if (read.kind !== "text") return lockfileReadDecline(tool, "yarn.lock", read);
	// Yarn writes CRLF or lone CR on some platforms; Classic block splitting is
	// LF-only, so fold line endings once before either parse.
	const raw = read.text.replace(/\r\n?/g, "\n");
	let doc: unknown;
	let yamlOk = true;
	try {
		doc = loadYaml(raw);
	} catch {
		yamlOk = false;
	}
	if (yamlOk) {
		const berry = yarnBerryEntries(doc, packageName);
		if (berry) {
			return decideNodeVersionAgreement(
				tool,
				packageName,
				range,
				selectNodeCandidate(berry, range),
				"yarn.lock",
			);
		}
	}
	// Classic v1 is a text format, not YAML: match its descriptor blocks.
	const v1 = yarnV1Blocks(raw, packageName);
	if (v1.length > 0) {
		return decideNodeVersionAgreement(
			tool,
			packageName,
			range,
			selectNodeCandidate(v1, range),
			"yarn.lock",
		);
	}
	if (!yamlOk) {
		return {
			decision: "decline",
			subject: `node:${tool}`,
			reason:
				"the project yarn.lock is unparseable; tool agreement cannot be established",
			reasonCode: "evidence-unparseable",
		};
	}
	return {
		decision: "decline",
		subject: `node:${tool}`,
		reason:
			"the project yarn.lock has an unsupported lockfile shape; tool agreement cannot be established",
		reasonCode: "evidence-unsupported",
	};
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
	const lockDir = findNearestMarkerRoot(root, [...NODE_LOCKFILE_PRECEDENCE], {
		boundaries: [".git", ".hg", ".svn"],
	});
	if (!lockDir) {
		return {
			decision: "decline",
			subject: `node:${tool}`,
			reason: `the project declares ${packageName}@${range} in package.json, but no lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock) establishes its resolved version; tool agreement cannot be established`,
			reasonCode: "evidence-absent",
		};
	}
	const supplier: NodeLockfileName = fs.existsSync(
		path.join(lockDir, "package-lock.json"),
	)
		? "package-lock.json"
		: fs.existsSync(path.join(lockDir, "pnpm-lock.yaml"))
			? "pnpm-lock.yaml"
			: "yarn.lock";
	if (supplier === "package-lock.json") {
		const lock = readJson(path.join(lockDir, "package-lock.json"));
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
		return { decision: "established", lockfile: supplier };
	}
	if (supplier === "pnpm-lock.yaml") {
		return pnpmAgreement(tool, packageName, range, root, lockDir);
	}
	return yarnAgreement(
		tool,
		packageName,
		range,
		path.join(lockDir, "yarn.lock"),
	);
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

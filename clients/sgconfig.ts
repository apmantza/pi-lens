import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { load as loadYaml } from "./deps/js-yaml.js";
import { resolvePackagePath } from "./package-root.js";
import { walkUpDirs } from "./path-utils.js";

// ast-grep's root config marker. The `ast-grep lsp` server is workspace-gated:
// it only operates in a project that has an `sgconfig.y[a]ml` at (or above) the
// file. These are the names ast-grep itself looks for as root markers.
export const SGCONFIG_NAMES = ["sgconfig.yml", "sgconfig.yaml"] as const;

export interface AstGrepRuleSource {
	dir: string;
	origin: "project" | "bundled";
	tier: "primary" | "secondary";
}

interface RuleDocument {
	raw: string;
	id?: string;
}

interface RuleFileSnapshot {
	file: string;
	relativePath: string;
	documents: RuleDocument[];
}

interface RuleSourceSnapshot extends AstGrepRuleSource {
	files: RuleFileSnapshot[];
	digest: string;
}

interface CachedBaseline {
	fingerprint: string;
	path: string;
	mergedDir: string;
}

/** Nearest `sgconfig.y[a]ml` walking up from `startDir`, or undefined if none. */
export function findLocalSgconfig(startDir: string): string | undefined {
	for (const dir of walkUpDirs(startDir || process.cwd())) {
		for (const name of SGCONFIG_NAMES) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

function canonicalDir(dir: string): string {
	try {
		return fs.realpathSync.native(dir);
	} catch {
		return path.resolve(dir);
	}
}

/**
 * Rule sources in the precedence order shared by raw ast-grep/LSP and NAPI:
 * project primary, project secondary, bundled primary, bundled secondary.
 */
export function getAstGrepRuleSources(
	projectRoot = process.cwd(),
): AstGrepRuleSource[] {
	const root = path.resolve(projectRoot || process.cwd());
	const packageRoot = resolvePackagePath(import.meta.url);
	const candidates: AstGrepRuleSource[] = [];

	if (canonicalDir(root) !== canonicalDir(packageRoot)) {
		candidates.push(
			{
				dir: path.join(root, "rules", "ast-grep-rules", "rules"),
				origin: "project",
				tier: "primary",
			},
			{
				dir: path.join(
					root,
					"rules",
					"ast-grep-rules",
					"coderabbit",
					"rules",
				),
				origin: "project",
				tier: "secondary",
			},
		);
	}

	candidates.push(
		{
			dir: path.join(packageRoot, "rules", "ast-grep-rules", "rules"),
			origin: "bundled",
			tier: "primary",
		},
		{
			dir: path.join(
				packageRoot,
				"rules",
				"ast-grep-rules",
				"coderabbit",
				"rules",
			),
			origin: "bundled",
			tier: "secondary",
		},
	);

	const seen = new Set<string>();
	return candidates.filter((source) => {
		if (!fs.existsSync(source.dir)) return false;
		const key = canonicalDir(source.dir);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Compatibility export retained for callers that only need ordered dirs. */
export function shippedRuleDirsInPrecedenceOrder(
	projectRoot = process.cwd(),
): string[] {
	return getAstGrepRuleSources(projectRoot).map((source) => source.dir);
}

function findYamlFiles(dir: string): string[] {
	const files: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs
			.readdirSync(dir, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return files;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...findYamlFiles(full));
		} else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
			files.push(full);
		}
	}
	return files;
}

function parseRuleId(raw: string): string | undefined {
	const scalar = raw.match(/^id:\s*(.*?)\s*$/m)?.[1];
	if (!scalar) return undefined;
	const withoutComment = scalar.replace(/\s+#.*$/, "").trim();
	const unquoted =
		(withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
		(withoutComment.startsWith("'") && withoutComment.endsWith("'"))
			? withoutComment.slice(1, -1)
			: withoutComment;
	if (/^[A-Za-z0-9_.:-]+$/.test(unquoted)) return unquoted;

	try {
		const parsed = loadYaml(raw);
		if (!parsed || typeof parsed !== "object" || !("id" in parsed)) {
			return undefined;
		}
		const id = (parsed as { id?: unknown }).id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

function parseRuleDocuments(content: string): RuleDocument[] {
	return content
		.split(/^---\s*$/m)
		.filter((document) => document.trim())
		.map((raw) => ({ raw, id: parseRuleId(raw) }));
}

const bundledSnapshots = new Map<string, RuleSourceSnapshot>();

function snapshotRuleSource(source: AstGrepRuleSource): RuleSourceSnapshot {
	const cacheKey = canonicalDir(source.dir);
	if (source.origin === "bundled") {
		const cached = bundledSnapshots.get(cacheKey);
		if (cached) return cached;
	}

	const hash = createHash("sha256");
	const files: RuleSourceSnapshot["files"] = [];
	for (const file of findYamlFiles(source.dir)) {
		const relativePath = path.relative(source.dir, file);
		hash.update(relativePath);
		hash.update("\0");
		// Guarded read (mirrors loadYamlRuleFiles in yaml-rule-parser.ts): a rule
		// file deleted/renamed between the directory walk and this read (editor
		// churn mid-session) must degrade to "skip this file", not throw —
		// resolveBaselineSgconfig sits on the ast-grep LSP spawn path. The
		// "missing" sentinel still perturbs the digest so the cache re-resolves
		// once the file is readable again.
		let content: string;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch {
			hash.update("missing");
			hash.update("\0");
			continue;
		}
		hash.update(content);
		hash.update("\0");
		files.push({ file, relativePath, documents: parseRuleDocuments(content) });
	}
	const snapshot = { ...source, files, digest: hash.digest("hex") };
	if (source.origin === "bundled") bundledSnapshots.set(cacheKey, snapshot);
	return snapshot;
}

function sourceFingerprint(sources: RuleSourceSnapshot[]): string {
	const hash = createHash("sha256");
	for (const source of sources) {
		hash.update(source.origin);
		hash.update("\0");
		hash.update(source.tier);
		hash.update("\0");
		hash.update(canonicalDir(source.dir));
		hash.update("\0");
		hash.update(source.digest);
		hash.update("\0");
	}
	return hash.digest("hex");
}

function materializeMergedRuleDir(
	sources: RuleSourceSnapshot[],
	mergedDir: string,
): void {
	fs.rmSync(mergedDir, { recursive: true, force: true });
	fs.mkdirSync(mergedDir, { recursive: true });
	const claimedByEarlierSource = new Set<string>();

	for (const [sourceIndex, source] of sources.entries()) {
		const claimedThisSource = new Set<string>();
		for (const [fileIndex, file] of source.files.entries()) {
			const survivingDocuments = file.documents.filter((document) => {
				if (!document.id) return true;
				if (claimedByEarlierSource.has(document.id)) return false;
				claimedThisSource.add(document.id);
				return true;
			});
			if (survivingDocuments.length === 0) continue;

			// Keep files flat for ast-grep's ruleDirs loader while retaining stable,
			// collision-free names for nested catalogs and duplicate basenames.
			const destination = path.join(
				mergedDir,
				`source${sourceIndex}-${String(fileIndex).padStart(5, "0")}.yml`,
			);
			if (survivingDocuments.length === file.documents.length) {
				fs.copyFileSync(file.file, destination);
			} else {
				fs.writeFileSync(
					destination,
					`${survivingDocuments
						.map((document) => document.raw.trim())
						.join("\n---\n")}\n`,
				);
			}
		}
		for (const id of claimedThisSource) claimedByEarlierSource.add(id);
	}
}

const cachedBaselines = new Map<string, CachedBaseline>();

function rootArtifactKey(root: string): string {
	return createHash("sha256").update(root).digest("hex").slice(0, 12);
}

/**
 * Synthesize a per-workspace config whose merged rule directory applies the
 * same project-first, source-layer precedence as the NAPI fallback.
 */
export function resolveBaselineSgconfig(
	projectRoot = process.cwd(),
): string | undefined {
	const root = canonicalDir(path.resolve(projectRoot || process.cwd()));
	const sources = getAstGrepRuleSources(root).map(snapshotRuleSource);
	if (sources.length === 0) return undefined;
	const fingerprint = sourceFingerprint(sources);
	const cached = cachedBaselines.get(root);
	if (
		cached?.fingerprint === fingerprint &&
		fs.existsSync(cached.path) &&
		fs.existsSync(cached.mergedDir)
	) {
		return cached.path;
	}

	const dir = path.join(os.tmpdir(), "pi-lens-ast-grep");
	fs.mkdirSync(dir, { recursive: true });
	const artifactKey = rootArtifactKey(root);
	const file = path.join(
		dir,
		`baseline-${process.pid}-${artifactKey}.sgconfig.yml`,
	);
	const mergedDir = path.join(
		dir,
		`baseline-${process.pid}-${artifactKey}.rules`,
	);
	const protectedArtifacts = new Set<string>([file, mergedDir]);
	for (const baseline of cachedBaselines.values()) {
		protectedArtifacts.add(baseline.path);
		protectedArtifacts.add(baseline.mergedDir);
	}
	cleanupStaleBaselines(dir, protectedArtifacts);
	materializeMergedRuleDir(sources, mergedDir);

	const ruleDirForYaml = mergedDir.split(path.sep).join("/");
	fs.writeFileSync(file, `ruleDirs:\n  - ${JSON.stringify(ruleDirForYaml)}\n`);
	cachedBaselines.set(root, { fingerprint, path: file, mergedDir });
	return file;
}

function cleanupStaleBaselines(dir: string, keep: Set<string>): void {
	try {
		const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for (const name of fs.readdirSync(dir)) {
			const isConfig =
				/^baseline(?:-\d+(?:-[a-f0-9]+)?)?\.sgconfig\.yml$/.test(name);
			const isMergedDir = /^baseline-\d+(?:-[a-f0-9]+)?\.rules$/.test(name);
			if (!isConfig && !isMergedDir) continue;
			const full = path.join(dir, name);
			if (keep.has(full)) continue;
			try {
				if (fs.statSync(full).mtimeMs < cutoff) {
					fs.rmSync(full, { recursive: isMergedDir, force: true });
				}
			} catch {
				// Racing another session; leave its artifact alone.
			}
		}
	} catch {
		// Missing/unreadable temp directory; nothing to clean.
	}
}

/** Test-only: reset memoized generated configs and mutable snapshots. */
export function _resetBaselineSgconfigForTests(): void {
	cachedBaselines.clear();
	bundledSnapshots.clear();
}

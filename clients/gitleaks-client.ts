/**
 * gitleaks client for pi-lens
 *
 * Surfaces committed secrets (API keys, tokens, passwords, certificates)
 * detected by Aaron Vargas's `gitleaks` scanner. Cross-language by design
 * — gitleaks operates on bytes via regex + entropy, not AST.
 *
 * Lifecycle:
 *   - session_start scan (via the existing `runTask(setImmediate)` wrapper)
 *   - turn_end advisory reads the cached result and surfaces top N findings
 *   - per-edit scope: skipped — secrets either are or aren't in a file;
 *     re-scanning every keystroke is wasteful when the cache is hot
 *
 * Detection gate (config-first per #130 default):
 *   - `.gitleaks.toml` / `.gitleaks.yaml` / `.gitleaksignore` at the
 *     project root, OR
 *   - `gitleaks` reference in `package.json` deps, OR
 *   - a git pre-commit hook (.husky/, .git/hooks/) referencing gitleaks
 *
 * `lens_diagnostics mode=full`'s fresh-fetch path (`clients/project-diagnostics/
 * fresh-fetch.ts`) uses a looser "smart-default" gate instead — any tracked
 * git repo, via `hasGitRepo` — since that's an explicitly-requested
 * comprehensive review where gitleaks's low cost and advisory-only findings
 * make the stricter default needlessly conservative. session_start and
 * per-edit dispatch keep the strict gate above unchanged.
 *
 * If the gate trips, the runner auto-installs gitleaks from GitHub releases
 * (installer entry registered in clients/installer/index.ts) and runs
 * `gitleaks detect --no-git --report-format json` against the analysis root.
 *
 * Scope policy (#1562): gitleaks is handed a `--config` generated per scan
 * (`writeScopedGitleaksConfig`) that EXTENDS the project's own `.gitleaks.toml`
 * (or gitleaks's built-in defaults, if none) with two additions — an
 * `[allowlist] paths` entry per NARROW secrets-lane scratch tree
 * (`scratch-tree-policy.ts`'s `SECRETS_LANE_SCRATCH_DIR_NAMES` — pi-ecosystem/
 * agent data dirs, `node_modules`, `.git`, generic build caches; deliberately
 * NOT the broader walker-parity `EXCLUDED_DIRS` list knip/jscpd use, which
 * also drops real leak surfaces like `dist/`, `vendor/`, `.vscode/` — see that
 * module's doc for the review-round probe that caught the too-broad first
 * cut) and an `[allowlist] regexes` entry per known placeholder-secret shape
 * (`YOUR_API_KEY`, `<your-key>`, `xxxxxxxx`, …). An allowlist entry is a
 * POST-DETECTION filter, not a walk exclusion — gitleaks still visits every
 * file; the allowlist only decides which raw hits get suppressed from the
 * report. Deliberately NOT `.gitignore`-based — see `scratch-tree-policy.ts`'s
 * module doc for why blanket gitignore-respect is wrong for a secrets scanner
 * (an untracked `.env` with a real credential is exactly the case gitleaks
 * exists to catch, and `.env` is commonly gitignored). `classifyAndFilterFindings`
 * backstops the config with a TS-side re-classification. Findings under the
 * secrets-lane scratch tier, in gitignored files, or inside nested repositories
 * are DEMOTED (not deleted) to `severity: "info"` / `semantic: "none"` by the
 * project-diagnostics adapter. They remain visible for an explicit audit but
 * can never surface as blocking "leaked secret" alarms or automatic turn
 * context. Tracked and ordinary untracked files remain blocking.
 *
 * Refs: #130, #1562
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import {
	collectTrackedFiles,
	collectUntrackedIgnoredIds,
} from "./git-tracked-ignore.js";
import { normalizeEphemeralMapKey, normalizeMapKey } from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { SecurityScanClient } from "./security-scan-client.js";
import {
	getSecretsLaneAllowlistPaths,
	isUnderSecretsLaneScratchTree,
} from "./scratch-tree-policy.js";

// --- Types ---

/**
 * Subset of fields gitleaks emits per finding in its JSON report.
 * Schema reference: https://github.com/gitleaks/gitleaks/wiki/Reports
 */
export interface GitleaksFinding {
	ruleId: string;
	description?: string;
	file: string;
	startLine: number;
	endLine?: number;
	match?: string;
	secret?: string;
	tags?: string[];
	commit?: string;
	author?: string;
	date?: string;
	/**
	 * Git status of `file`, best-effort (#1562 observability criterion) — lets
	 * a future triage read "this is scratch/ignored" from the finding record
	 * instead of re-debunking it by hand. `undefined` when git itself
	 * degraded (no repo, spawn failure, timeout) — fail-open, matching
	 * `git-tracked-ignore.ts`'s own degrade contract.
	 *   - "scratch": under the narrow SECRETS-LANE scratch tier
	 *     (`SECRETS_LANE_SCRATCH_DIR_NAMES` — pi-ecosystem/agent data dirs,
	 *     `node_modules`, `.git`, build caches; NOT the broader walker-parity
	 *     `EXCLUDED_DIRS` list, which also covers real leak surfaces like
	 *     `dist/`/`vendor/`/`.vscode/` — #1562 review-round F1). DEMOTED, not
	 *     dropped (#1562 review-round F2 — the observability criterion
	 *     requires this value to actually be reachable): the adapter
	 *     (`gitleaksFindingToProjectDiagnostic`) reports a `pathStatus:
	 *     "scratch"` finding as `severity: "info"`/`semantic: "none"` so it
	 *     can never surface as a blocking "leaked secret" alarm, while still
	 *     being present for an audit read.
	 *   - "tracked": committed to git.
	 *   - "ignored": untracked AND matched by `.gitignore`; retained for
	 *     explicit audit only, never delivered as blocking turn context.
	 *   - "nested-repository": belongs to a separate git repository below the
	 *     analysis root (for example a submodule); that repository must assess
	 *     the finding in its own git context.
	 *   - "untracked": untracked and NOT gitignored — the operational case
	 *     (e.g. a fresh `.env`) gitleaks exists to catch.
	 */
	pathStatus?:
		| "scratch"
		| "tracked"
		| "ignored"
		| "nested-repository"
		| "untracked";
}

export interface GitleaksResult {
	success: boolean;
	findings: GitleaksFinding[];
	scannedAt: string;
	summary?: string;
}

const EMPTY_RESULT: Omit<GitleaksResult, "scannedAt"> = {
	success: false,
	findings: [],
};

const SCAN_TIMEOUT_MS = 120_000;

// gitleaks discovers its own config at `<source>/.gitleaks.toml` (or `.yaml`/
// `.yml`) when no `--config` is passed. Kept as a named constant so the
// generated scoped config (below) can EXTEND whichever of these the project
// already has, instead of silently replacing the project's own rules.
const LOCAL_GITLEAKS_CONFIG_NAMES = [
	".gitleaks.toml",
	".gitleaks.yaml",
	".gitleaks.yml",
] as const;

function findLocalGitleaksConfig(cwd: string): string | undefined {
	for (const name of LOCAL_GITLEAKS_CONFIG_NAMES) {
		const candidate = path.join(cwd, name);
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			// non-fatal
		}
	}
	return undefined;
}

// The #1562 incident: a curl doc example's `-H "Authorization: Bearer
// YOUR_API_KEY"` (cached under gitignored scratch, see the secrets-lane
// exclusion below) read as a leaked secret. These match gitleaks's own
// `Secret`/`Match` value case-insensitively, catching the canonical
// placeholder shapes: `YOUR_API_KEY`-style tokens, `<your-key>`-style angle
// brackets, run-of-`x` filler, and the common changeme/example/dummy family.
// Scoped to the whole matched value (`^...$`) so a REAL secret that merely
// contains the substring "key" is never caught by accident.
//
// #1562 review-round F3: regex 2's alternation required "key" to be prefixed
// (`api[-_ ]?key`) — the issue's own literal acceptance example, `<your-key>`
// (bare "key", no "api" prefix), didn't match. Added a bare `key` alternative;
// still safe because the match is scoped to the WHOLE bracketed value
// (`^<...>$`), so a real secret that happens to be wrapped in angle brackets
// AND merely contain the substring "key" still wouldn't collide with this —
// only a value that is ENTIRELY `<...key...>`-shaped does.
export const PLACEHOLDER_SECRET_REGEXES = [
	String.raw`(?i)^(your|my|insert|replace|enter|add)[-_ ]?(the[-_ ]?)?(api[-_ ]?)?(key|token|secret|password|credential)s?$`,
	String.raw`(?i)^<[^<>]*(api[-_ ]?key|token|secret|password|credential|key)[^<>]*>$`,
	String.raw`(?i)^x{3,}$`,
	String.raw`(?i)^(changeme|change[-_]me|example|placeholder|dummy|fake|redacted|xxxxxxxx)$`,
];

/**
 * Build a temp gitleaks config that EXTENDS the project's own config (if any,
 * else gitleaks's built-in defaults) with two additions:
 *   1. `[allowlist] paths` — the NARROW secrets-lane scratch exclusion
 *      (`scratch-tree-policy.ts`'s `getSecretsLaneAllowlistPaths`, NOT the
 *      broader walker-parity `EXCLUDED_DIRS` list — #1562 review-round F1).
 *   2. `[allowlist] regexes` — the placeholder-secret class above.
 *
 * An `[allowlist]` entry is a POST-DETECTION filter (#1562 review-round F4):
 * gitleaks still visits every file under `--source`; the allowlist decides
 * which of the raw hits it reports, it does not shrink the walk itself.
 *
 * gitleaks's `[extend]` allowlist merge is additive (append, not replace —
 * see gitleaks/config/config.go), so a project's own curated allowlist keeps
 * working unchanged; this only ever ADDS exclusions, never removes one the
 * project opted into.
 *
 * Returns the generated file's path; caller owns cleanup (same temp dir as
 * the report, removed together in `runScan`'s `finally`).
 */
export function writeScopedGitleaksConfig(outDir: string, cwd: string): string {
	const localConfig = findLocalGitleaksConfig(cwd);
	const extendLine = localConfig
		? `path = ${JSON.stringify(localConfig)}`
		: "useDefault = true";
	const pathPatterns = getSecretsLaneAllowlistPaths()
		.map((p) => `    ${JSON.stringify(p)},`)
		.join("\n");
	const regexPatterns = PLACEHOLDER_SECRET_REGEXES.map(
		(r) => `    ${JSON.stringify(r)},`,
	).join("\n");
	const toml = `[extend]
${extendLine}

[allowlist]
paths = [
${pathPatterns}
]
regexes = [
${regexPatterns}
]
`;
	const configPath = path.join(outDir, "gitleaks-scoped-config.toml");
	fs.writeFileSync(configPath, toml, "utf-8");
	return configPath;
}

// --- Detection ---

/**
 * Detect whether the project root has opted in to gitleaks via any of the
 * standard signals. Config-first gating per the #130 default — gitleaks
 * runs when the user has given us any indication they want it.
 *
 * Exported for tests and for callers that want the gate without instantiating
 * the client.
 */
export function hasGitleaksSignal(cwd: string): boolean {
	const candidates = [...LOCAL_GITLEAKS_CONFIG_NAMES, ".gitleaksignore"];
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(path.join(cwd, candidate))) return true;
		} catch {
			// non-fatal
		}
	}
	// Check package.json devDependencies / dependencies for any `gitleaks*`
	// reference. Catches `gitleaks`, `lint-staged-gitleaks`, etc.
	const pkgJsonPath = path.join(cwd, "package.json");
	try {
		if (fs.existsSync(pkgJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
				dependencies?: Record<string, unknown>;
				devDependencies?: Record<string, unknown>;
			};
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			for (const name of Object.keys(deps)) {
				if (name.toLowerCase().includes("gitleaks")) return true;
			}
		}
	} catch {
		// malformed package.json — don't treat as signal
	}
	// husky / git hooks referencing gitleaks
	const hookCandidates = [
		path.join(cwd, ".husky", "pre-commit"),
		path.join(cwd, ".husky", "_", "pre-commit"),
		path.join(cwd, ".git", "hooks", "pre-commit"),
	];
	for (const hook of hookCandidates) {
		try {
			if (!fs.existsSync(hook)) continue;
			const content = fs.readFileSync(hook, "utf-8");
			if (content.includes("gitleaks")) return true;
		} catch {
			// non-fatal
		}
	}
	return false;
}

/**
 * "Smart-default" tier from #130's own considered-but-unshipped options:
 * fire whenever the project is a tracked git repo, not only when an explicit
 * gitleaks signal is present. gitleaks's own scan target is "a git repo's
 * history/tree" — nearly every project qualifies, so this is meaningfully
 * looser than {@link hasGitleaksSignal}. Used ONLY by `mode=full`'s
 * fresh-fetch path (an explicitly-requested comprehensive review, where
 * gitleaks's low cost — ~10MB binary, no external DB pull — and advisory-only
 * findings make the stricter opt-in gate needlessly conservative); session_start
 * and per-edit dispatch keep the strict {@link hasGitleaksSignal} gate
 * unchanged, so day-to-day noise/cost stays exactly as conservative as before.
 */
export function hasGitRepo(cwd: string): boolean {
	try {
		return fs.existsSync(path.join(cwd, ".git"));
	} catch {
		return false;
	}
}

// --- Client ---

export class GitleaksClient extends SecurityScanClient<GitleaksResult> {
	constructor(verbose = false) {
		super("gitleaks", verbose);
	}

	/**
	 * Static detection helper so callers can gate before constructing
	 * (matches `GovulncheckClient.hasGoModule` shape).
	 */
	static hasGitleaksSignal(cwd: string): boolean {
		return hasGitleaksSignal(cwd);
	}

	/** Smart-default tier (#130) — see {@link hasGitRepo}'s doc comment. */
	static hasGitRepo(cwd: string): boolean {
		return hasGitRepo(cwd);
	}

	/**
	 * Auto-install via the GitHub-release path (registered in
	 * `clients/installer/index.ts`) when gitleaks isn't already on PATH.
	 * gitleaks uses `version` (no leading dashes) as its CLI verb.
	 */
	protected doEnsureAvailable(): Promise<boolean> {
		return this.ensureViaInstaller(["version"]);
	}

	/**
	 * Scan a directory tree for secrets.
	 *
	 * Skips early when the directory shows no gitleaks opt-in signal — unless
	 * `requireSignal: false` (the `mode=full` fresh-fetch path uses this to
	 * apply the looser #130 "smart-default" gate, {@link hasGitRepo}, instead;
	 * session_start and per-edit dispatch never pass this, so their behavior
	 * is unchanged). When gitleaks is unavailable, returns an empty result
	 * with an explanatory summary rather than failing the session_start task.
	 *
	 * Re-entrancy safe: concurrent calls against the same root share a
	 * single gitleaks process (mirrors `KnipClient` / `JscpdClient` /
	 * `GovulncheckClient`).
	 */
	async scan(
		cwd: string,
		options?: { requireSignal?: boolean },
	): Promise<GitleaksResult> {
		const targetDir = path.resolve(cwd);
		const scannedAt = new Date().toISOString();
		const requireSignal = options?.requireSignal ?? true;

		if (requireSignal && !GitleaksClient.hasGitleaksSignal(targetDir)) {
			return {
				...EMPTY_RESULT,
				success: true,
				scannedAt,
				summary: "no gitleaks opt-in signal at project root",
			};
		}

		if (!(await this.ensureAvailable())) {
			return {
				...EMPTY_RESULT,
				scannedAt,
				summary: "gitleaks not installed",
			};
		}

		return this.dedupeScan(targetDir, () => this.runScan(targetDir));
	}

	private async runScan(cwd: string): Promise<GitleaksResult> {
		const scannedAt = new Date().toISOString();
		const bin = this.binaryPath ?? "gitleaks";
		const outDir = mkdtempSync(path.join(os.tmpdir(), "pi-lens-gitleaks-"));
		const reportPath = path.join(outDir, "gitleaks-report.json");
		try {
			const configPath = writeScopedGitleaksConfig(outDir, cwd);
			const result = await safeSpawnAsync(
				bin,
				[
					"detect",
					"--no-git",
					"--source",
					cwd,
					"--config",
					configPath,
					"--report-format",
					"json",
					"--report-path",
					reportPath,
					"--exit-code",
					"0",
					"--no-banner",
				],
				{ cwd, timeout: SCAN_TIMEOUT_MS },
			);

			if (result.error) {
				this.log(`Scan error: ${result.error.message}`);
				return {
					...EMPTY_RESULT,
					scannedAt,
					summary: result.error.message.slice(0, 200),
				};
			}

			if (!fs.existsSync(reportPath)) {
				// gitleaks writes the report file even when nothing is found.
				// If the file is missing the scan likely errored before
				// writing it — surface a summary line from stderr.
				return {
					...EMPTY_RESULT,
					success: true,
					scannedAt,
					summary:
						(result.stderr ?? "").trim().split("\n")[0] || "no report produced",
				};
			}

			const rawFindings = parseGitleaksReport(
				fs.readFileSync(reportPath, "utf-8"),
			);
			const findings = await classifyAndFilterFindings(rawFindings, cwd);
			return {
				success: true,
				findings,
				scannedAt,
			};
		} catch (err) {
			return {
				...EMPTY_RESULT,
				scannedAt,
				summary: err instanceof Error ? err.message.slice(0, 200) : String(err),
			};
		} finally {
			try {
				fs.rmSync(outDir, { recursive: true, force: true });
			} catch {
				// non-fatal
			}
		}
	}
}

// --- Post-scan classification / filter ---

/**
 * Backstop for the scoped-config secrets-lane exclusion above, plus the
 * `pathStatus` observability field (#1562).
 *
 * Two things happen here, both defense-in-depth relative to the generated
 * gitleaks config:
 *   1. Any finding still under the NARROW secrets-lane scratch tier
 *      (`isUnderSecretsLaneScratchTree` — NOT the broader walker-parity
 *      `EXCLUDED_DIRS` list) is DEMOTED, never DROPPED (#1562 review-round
 *      F2: the observability criterion requires this value to actually be
 *      reachable, so a scratch finding survives with `pathStatus: "scratch"`
 *      and the adapter (`gitleaksFindingToProjectDiagnostic`) reports it as
 *      `severity: "info"`/`semantic: "none"` — visible for an audit read,
 *      but it can never surface as a blocking "leaked secret" alarm). We
 *      can't exercise gitleaks's own TOML-regex engine in unit tests, only
 *      assert the config we hand it, so this backstop guarantees the demotion
 *      even if the generated regex ever mismatches gitleaks's own path
 *      normalization.
 *   2. A finding below a nested git boundary is labelled
 *      `nested-repository`. Parent scans must not claim ownership of a
 *      submodule's or nested repository's files.
 *   3. Every OTHER finding gets `pathStatus` set from git's tracked/ignored
 *      view, so a future false-positive triage is a log read.
 *
 * `collectTrackedFiles`/`collectUntrackedIgnoredIds` degrade to `undefined`
 * when git itself is unavailable (no repo, spawn failure) — findings just
 * keep `pathStatus: undefined` rather than a guessed value (fail-open,
 * matching `git-tracked-ignore.ts`'s own contract). Exported for unit tests.
 */
function isInsideNestedGitRepository(file: string, cwd: string): boolean {
	const root = path.resolve(cwd);
	const absoluteFile = path.isAbsolute(file)
		? path.resolve(file)
		: path.resolve(root, file);
	const relative = path.relative(root, absoluteFile);
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		return false;

	let directory = path.dirname(absoluteFile);
	while (directory !== root) {
		try {
			if (fs.existsSync(path.join(directory, ".git"))) return true;
		} catch {
			return false;
		}
		const parent = path.dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
	return false;
}

export async function classifyAndFilterFindings(
	findings: GitleaksFinding[],
	cwd: string,
): Promise<GitleaksFinding[]> {
	if (findings.length === 0) return findings;

	const [trackedIds, untrackedIgnoredIds] = await Promise.all([
		collectTrackedFiles(cwd),
		collectUntrackedIgnoredIds(cwd),
	]);

	const classified: GitleaksFinding[] = [];
	for (const finding of findings) {
		if (isUnderSecretsLaneScratchTree(finding.file)) {
			classified.push({ ...finding, pathStatus: "scratch" });
			continue;
		}
		const absPath = path.isAbsolute(finding.file)
			? finding.file
			: path.resolve(cwd, finding.file);
		if (isInsideNestedGitRepository(absPath, cwd)) {
			classified.push({ ...finding, pathStatus: "nested-repository" });
			continue;
		}

		let pathStatus: GitleaksFinding["pathStatus"];
		if (trackedIds?.has(normalizeEphemeralMapKey(absPath))) {
			pathStatus = "tracked";
		} else if (untrackedIgnoredIds?.has(normalizeMapKey(absPath))) {
			pathStatus = "ignored";
		} else if (trackedIds !== undefined || untrackedIgnoredIds !== undefined) {
			// At least one of the two git-backed sets resolved, so the absence
			// from both is a real answer ("untracked, not gitignored") rather
			// than an unresolved probe.
			pathStatus = "untracked";
		}

		classified.push(pathStatus ? { ...finding, pathStatus } : finding);
	}
	return classified;
}

// --- Parser ---

/**
 * Map gitleaks's JSON report (a flat array of finding objects) to our
 * structured `GitleaksFinding[]` shape. Exported for unit tests.
 *
 * Gitleaks emits `null` (or `[]`) when no findings are present. Malformed
 * input returns `[]` rather than throwing — gitleaks itself is occasionally
 * truncated by upstream pipe failures.
 */
export function parseGitleaksReport(raw: string): GitleaksFinding[] {
	if (!raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const findings: GitleaksFinding[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const ruleId = typeof e.RuleID === "string" ? e.RuleID : undefined;
		const file = typeof e.File === "string" ? e.File : undefined;
		const startLine =
			typeof e.StartLine === "number"
				? e.StartLine
				: Number.parseInt(String(e.StartLine ?? ""), 10);
		if (!ruleId || !file || !Number.isFinite(startLine)) continue;
		findings.push({
			ruleId,
			description:
				typeof e.Description === "string" ? e.Description : undefined,
			file,
			startLine,
			endLine:
				typeof e.EndLine === "number"
					? e.EndLine
					: Number.isFinite(Number(e.EndLine))
						? Number(e.EndLine)
						: undefined,
			match: typeof e.Match === "string" ? e.Match : undefined,
			secret: typeof e.Secret === "string" ? e.Secret : undefined,
			tags: Array.isArray(e.Tags)
				? e.Tags.filter((t): t is string => typeof t === "string")
				: undefined,
			commit: typeof e.Commit === "string" ? e.Commit : undefined,
			author: typeof e.Author === "string" ? e.Author : undefined,
			date: typeof e.Date === "string" ? e.Date : undefined,
		});
	}
	return findings;
}

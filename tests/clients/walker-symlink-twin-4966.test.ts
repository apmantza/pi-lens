/**
 * #4966: every upward walker answers the same root from a symlink twin of its
 * fixture as from the real path.
 *
 * Shape (AGENTS.md shapes 1 and 32): a walk that starts from the caller's
 * SPELLING of a path climbs the link's parents, not the parents the kernel
 * opens, so a symlinked checkout resolved a different root than the real
 * path. Seven bug-fix PRs in one week fixed one walker each (#4844, #4847,
 * #4858, #4870, #4876, #4919, #4957), and three of them wrote that no scanner
 * can see where a walk starts. This suite is the enforcer that can: it RUNS
 * each walker.
 *
 * One fixture shape for all of them. `real/` is the owner (every marker the
 * walker reads), `real/pkg/src/` the target directory with no marker of its
 * own, and `decoy/` a second owner with the same markers (different content
 * where the answer is a value). Two twins reach the target:
 *
 * - the directory twin, `decoy/dirlink -> ../real/pkg`, so `decoy/dirlink/src`
 *   spells the target's directory under the decoy;
 * - the file twin, `decoy/src/flink -> ../../real/pkg/src/<file>`, a FILE link
 *   whose own directory is the decoy's (a walk that starts from the link's
 *   directory instead of the file's identity climbs into the decoy).
 *
 * A directory walker runs from the real directory and the directory twin; a
 * file walker also from the file twin. All spellings must answer the owner.
 * A walker that climbs the spelling answers the decoy and reds here.
 *
 * Census: every file in `clients/`, `tools/`, `mcp/` and `index.ts` that names
 * a seam climber in code (comment-and-string-blanked; an alias or a binding
 * counts) is covered by a registered walker or exempt with the reason and the
 * test that pins it. A new walker file reds until it is registered. The
 * registry is file-granular: a file with many climbs (`clients/lsp/server.ts`
 * 7, `clients/tool-policy.ts` 44 seam calls) runs one representative, which
 * is why #4966 stays open (Refs). The census misses a seam climber named
 * through a computed member (`pu["walkUpDirs"]`) or consumed through an
 * in-file re-export; live population 0 (#5037 r3 F9), and the redesign stays
 * on #4966. The hand-rolled loops that bypass
 * the seam are the other half: `tests/config/path-identity-sweep.test.ts`
 * (`hand-rolled-upward-walk`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAnalysisRootPath } from "../../clients/analysis-root.js";
import { resolveCargoPackageEdition } from "../../clients/cargo-manifest.js";
import { configSearchDirs } from "../../clients/config-locations.js";
import { resolveRunnerPath } from "../../clients/dispatch/runner-context.js";
import { isEphemeralCheckoutRoot } from "../../clients/ephemeral-root.js";
import { resolveKtfmtGradleStyle } from "../../clients/gradle-ktfmt-style.js";
import {
	demoteEnvironmentGapDiagnostics,
	hasResolvableNodeModules,
} from "../../clients/lsp/environment-gap.js";
import { NearestRoot } from "../../clients/lsp/server.js";
import { findLocalOpengrepConfig } from "../../clients/opengrep-config.js";
import { getPackageRoot } from "../../clients/package-root.js";
import {
	findLocalToolConfig,
	findNearestContaining,
	findNearestMarkerRoot,
	findNearestMarkerRootDetailed,
	walkUpDirs,
} from "../../clients/path-utils.js";
import {
	loadPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import { detectPythonTargetVersion } from "../../clients/python-environment.js";
import { findLocalSgconfig } from "../../clients/sgconfig.js";
import { findToolConfig } from "../../clients/tool-config-presence.js";
import { resolveToolCwd } from "../../clients/tool-cwd.js";
import { hasNearestPackageJsonDependency } from "../../clients/tool-policy.js";
import { findLocalTyposConfig } from "../../clients/typos-config.js";
import { findGoverningTsconfigDir } from "../../clients/workspace-topology.js";
import { findLocalZizmorConfig } from "../../clients/zizmor-config.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";
import { setupTestEnvironment } from "./test-utils.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

interface Layout {
	base: string;
	/** The owner: carries the markers; the answer every spelling must give. */
	real: string;
	decoy: string;
	/** The target directory: `real/pkg/src`, no marker of its own. */
	realDir: string;
	/** `decoy/dirlink/src`: the target directory spelled through the decoy. */
	twinDir: string;
	/** The target file in `realDir`. */
	realFile: string;
	/** The same file through the directory link. */
	twinFile: string;
	/** A FILE link in `decoy/src` to the target file. */
	linkFile: string;
}

interface Walker {
	id: string;
	/** The runtime files whose climb this entry runs (the census reads them). */
	files: readonly string[];
	input: "dir" | "file";
	fileName?: string;
	/** Relative path -> content, written at the owner and (unless `decoy`) the decoy. */
	markers: Readonly<Record<string, string>>;
	/** The decoy's markers when they differ; `"none"` writes nothing there. */
	decoy?: Readonly<Record<string, string>> | "none";
	run: (start: string, t: Layout) => unknown;
	/** Reduce the walker's output to the compared answer. */
	answer?: (raw: unknown, t: Layout) => unknown;
	/** The owner's answer; defaults to the owner root itself. */
	expected?: (t: Layout) => unknown;
	/** Extra `process.cwd()` the walker should see; defaults to the fixture base. */
	cwd?: (t: Layout) => string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	resetProjectLensConfigCache();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/** Stamp every directory a minute into the past: a memo refuses a racy walk (#4756). */
function ageDirs(dir: string): void {
	const past = new Date(Date.now() - 60_000);
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) ageDirs(path.join(dir, entry.name));
	}
	fs.utimesSync(dir, past, past);
}

function build(walker: Walker): { layout: Layout; skipReason?: string } {
	// Not a `pi-` prefix: a `pi-*` directory below the tmp root is a pi-owned
	// temp path, which the analysis-root rules refuse by design.
	const env = setupTestEnvironment(`twin-4966-${walker.id}-`, {
		rootMarker: false,
	});
	cleanups.push(env.cleanup);
	const base = fs.realpathSync.native(env.tmpDir);
	const fileName = walker.fileName ?? "x.ts";
	const real = path.join(base, "real");
	const decoy = path.join(base, "decoy");
	const realDir = path.join(real, "pkg", "src");
	const realFile = path.join(realDir, fileName);
	write(realFile, "export const x = 1;\n");
	for (const [rel, content] of Object.entries(walker.markers))
		write(path.join(real, rel), content);
	fs.mkdirSync(decoy, { recursive: true });
	const decoyMarkers =
		walker.decoy === "none" ? {} : (walker.decoy ?? walker.markers);
	for (const [rel, content] of Object.entries(decoyMarkers))
		write(path.join(decoy, rel), content);
	const layout: Layout = {
		base,
		real,
		decoy,
		realDir,
		twinDir: path.join(decoy, "dirlink", "src"),
		realFile,
		twinFile: path.join(decoy, "dirlink", "src", fileName),
		linkFile: path.join(decoy, "src", fileName),
	};
	try {
		fs.symlinkSync(
			path.join("..", "real", "pkg"),
			path.join(decoy, "dirlink"),
			"dir",
		);
		fs.mkdirSync(path.dirname(layout.linkFile), { recursive: true });
		fs.symlinkSync(
			path.join("..", "..", "real", "pkg", "src", fileName),
			layout.linkFile,
			"file",
		);
	} catch (err) {
		return {
			layout,
			skipReason: `cannot create symlinks here: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
	ageDirs(base);
	return { layout };
}

/** A path answer compares by identity; a value answer compares as is. */
function canon(value: unknown): unknown {
	if (typeof value === "string" && path.isAbsolute(value)) {
		try {
			return fs.realpathSync.native(value);
		} catch {
			return value;
		}
	}
	if (Array.isArray(value)) return value.map(canon);
	return value;
}

const PKG = "{}\n";
const OWNER_DEP = '{ "dependencies": { "twin-owner-dep": "1.0.0" } }\n';
const GIT_HEAD = "ref: refs/heads/main\n";

const WALKERS: readonly Walker[] = [
	// --- the seam's own climbers (clients/path-utils.ts) ---
	{
		id: "findNearestContaining",
		files: ["clients/path-utils.ts"],
		input: "dir",
		markers: { "package.json": PKG },
		run: (start) => findNearestContaining(start, ["package.json"]),
	},
	{
		id: "findLocalToolConfig",
		files: ["clients/path-utils.ts"],
		input: "dir",
		markers: { "tool.toml": "# t\n" },
		run: (start) => {
			const found = findLocalToolConfig(start, ["tool.toml"]);
			return found && path.dirname(found);
		},
	},
	{
		id: "findNearestMarkerRoot",
		files: ["clients/path-utils.ts"],
		input: "dir",
		markers: { "package.json": PKG },
		run: (start) => findNearestMarkerRoot(start, ["package.json"]),
	},
	{
		id: "findNearestMarkerRootDetailed",
		files: ["clients/path-utils.ts"],
		input: "dir",
		markers: { "package.json": PKG },
		run: (start) => {
			const found = findNearestMarkerRootDetailed(start, ["package.json"], {
				markerPredicate: (marker) => ({
					kind: fs.existsSync(marker) ? "valid" : "absent",
				}),
			});
			return found.kind === "found" ? found.root : found.kind;
		},
	},
	{
		id: "walkUpDirs",
		files: ["clients/path-utils.ts"],
		input: "dir",
		markers: { "package.json": PKG },
		run: (start) => {
			for (const dir of walkUpDirs(start))
				if (fs.existsSync(path.join(dir, "package.json"))) return dir;
			return undefined;
		},
	},
	// --- config finders ---
	{
		id: "configSearchDirs",
		files: ["clients/config-locations.ts"],
		input: "dir",
		markers: { "package.json": PKG },
		run: (start) =>
			configSearchDirs(start).filter((dir) =>
				fs.existsSync(path.join(dir, "package.json")),
			),
		expected: (t) => [t.real],
	},
	{
		id: "findLocalTyposConfig",
		files: ["clients/typos-config.ts"],
		input: "dir",
		markers: { "typos.toml": "# t\n" },
		run: (start) => {
			const found = findLocalTyposConfig(start);
			return found && path.dirname(found);
		},
	},
	{
		id: "findToolConfig",
		files: ["clients/tool-config-presence.ts"],
		input: "dir",
		markers: { ".tflint.hcl": "# t\n" },
		run: (start) => {
			const found = findToolConfig("tflint", start);
			return found && path.dirname(found.file);
		},
	},
	{
		id: "findLocalOpengrepConfig",
		files: ["clients/opengrep-config.ts"],
		input: "dir",
		markers: { ".opengrep.yml": "rules: []\n" },
		run: (start) => {
			const found = findLocalOpengrepConfig(start);
			return found && path.dirname(found);
		},
	},
	{
		id: "findLocalSgconfig",
		files: ["clients/sgconfig.ts"],
		input: "dir",
		markers: { "sgconfig.yml": "ruleDirs: []\n" },
		run: (start) => {
			const found = findLocalSgconfig(start);
			return found && path.dirname(found);
		},
	},
	{
		id: "findLocalZizmorConfig",
		files: ["clients/zizmor-config.ts"],
		input: "dir",
		markers: { "zizmor.yml": "rules: {}\n" },
		run: (start) => {
			const found = findLocalZizmorConfig(start);
			return found && path.dirname(found);
		},
	},
	{
		id: "loadPiLensProjectConfig",
		files: ["clients/project-lens-config.ts"],
		input: "dir",
		markers: {
			".pi-lens.json": JSON.stringify({
				rules: { "high-complexity": { threshold: 3 } },
			}),
		},
		decoy: {
			".pi-lens.json": JSON.stringify({
				rules: { "high-complexity": { threshold: 9 } },
			}),
		},
		run: (start) => {
			resetProjectLensConfigCache();
			return loadPiLensProjectConfig(start).rules["high-complexity"]?.threshold;
		},
		expected: () => 3,
	},
	// --- roots ---
	{
		id: "getPackageRoot",
		files: ["clients/package-root.ts"],
		input: "file",
		fileName: "x.js",
		markers: { "package.json": PKG },
		run: (start) => getPackageRoot(pathToFileURL(start).href),
	},
	{
		id: "resolveRunnerPath",
		files: ["clients/dispatch/runner-context.ts"],
		input: "dir",
		markers: { "marker.txt": "m\n" },
		run: (start) => path.dirname(resolveRunnerPath(start, "marker.txt")),
	},
	{
		id: "findGoverningTsconfigDir",
		files: ["clients/workspace-topology.ts"],
		input: "dir",
		markers: { "tsconfig.json": "{}\n" },
		run: (start) => findGoverningTsconfigDir(start),
	},
	{
		id: "resolveToolCwd",
		files: ["clients/tool-cwd.ts"],
		input: "file",
		markers: { "package.json": PKG },
		run: (start, t) =>
			resolveToolCwd("runner", "twin-tool", start, {
				cwd: t.base,
				rootMarkers: ["package.json"],
				suppressTelemetry: true,
			}).cwd,
	},
	{
		id: "resolveAnalysisRootPath",
		files: ["clients/analysis-root.ts"],
		input: "file",
		markers: { "package.json": PKG },
		run: (start, t) =>
			resolveAnalysisRootPath(start, path.join(t.base, "session")),
	},
	{
		id: "isEphemeralCheckoutRoot",
		files: ["clients/ephemeral-root.ts"],
		input: "dir",
		markers: { ".git/HEAD": GIT_HEAD },
		decoy: "none",
		run: (start) => isEphemeralCheckoutRoot(start),
		expected: () => true,
	},
	{
		id: "hasNearestPackageJsonDependency",
		files: ["clients/tool-policy.ts"],
		input: "dir",
		markers: { "package.json": OWNER_DEP },
		decoy: { "package.json": PKG },
		run: (start) => hasNearestPackageJsonDependency(start, "twin-owner-dep"),
		expected: () => true,
	},
	// --- language manifests ---
	{
		id: "detectPythonTargetVersion",
		files: ["clients/python-environment.ts"],
		input: "file",
		fileName: "x.py",
		markers: {
			"pyproject.toml": '[project]\nname = "x"\nrequires-python = ">=3.12"\n',
		},
		decoy: {
			"pyproject.toml": '[project]\nname = "x"\nrequires-python = ">=3.9"\n',
		},
		run: async (start) => {
			const found = await detectPythonTargetVersion(start);
			return found && `${found.major}.${found.minor}`;
		},
		expected: () => "3.12",
	},
	{
		id: "resolveCargoPackageEdition",
		files: ["clients/cargo-manifest.ts"],
		input: "file",
		fileName: "lib.rs",
		markers: {
			"Cargo.toml":
				'[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n',
		},
		decoy: {
			"Cargo.toml":
				'[package]\nname = "x"\nversion = "0.1.0"\nedition = "2018"\n',
		},
		run: (start) => resolveCargoPackageEdition(start),
		expected: () => "2021",
	},
	{
		id: "resolveKtfmtGradleStyle",
		files: ["clients/gradle-ktfmt-style.ts"],
		input: "file",
		fileName: "Main.kt",
		markers: { "build.gradle.kts": "ktfmt {\n  googleStyle()\n}\n" },
		decoy: { "build.gradle.kts": "ktfmt {\n  kotlinLangStyle()\n}\n" },
		run: (start) => resolveKtfmtGradleStyle(start),
		expected: () => "--google-style",
	},
	// --- the language server ---
	{
		id: "NearestRoot",
		files: ["clients/lsp/server.ts"],
		input: "file",
		markers: { "package.json": PKG },
		run: (start) => NearestRoot(["package.json"])(start),
	},
	{
		id: "hasResolvableNodeModules",
		files: ["clients/lsp/environment-gap.ts"],
		input: "dir",
		markers: { "node_modules/.keep": "" },
		decoy: "none",
		run: (start) => hasResolvableNodeModules(start),
		expected: () => true,
	},
	{
		// The file-start half of the same walk: the default start is the FILE's
		// real directory, so a file link looks where its target lives.
		id: "demoteEnvironmentGapDiagnostics",
		files: ["clients/lsp/environment-gap.ts"],
		input: "file",
		markers: { "package.json": PKG },
		decoy: { "package.json": PKG, "node_modules/.keep": "" },
		run: (start) =>
			demoteEnvironmentGapDiagnostics(
				[
					{
						severity: 1,
						source: "typescript",
						code: 2503,
						message: "Cannot find namespace 'NodeJS'.",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 1 },
						},
					},
				],
				{ filePath: start },
			)[0]?.severity,
		expected: () => 2,
	},
];

/**
 * Files that call a seam climber and are not registered above, with why a twin
 * run of them says nothing the registered walkers do not, and the suite that
 * pins what they do. A reason without a pinning suite is not accepted.
 */
const EXEMPT: Readonly<Record<string, { reason: string; pinnedBy: string }>> = {
	"clients/startup-scan.ts": {
		reason:
			"climbs the SPELLING by design (`spelling: true`): its verdicts compare the root with the spelled home and cwd",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/package-manager.ts": {
		reason:
			"the project-local bin resolver and its trust classifier stay on the spelling by design: an identity bin dir holds neither the alias spelling of a shim nor its target",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/session-repository.ts": {
		reason:
			"`projectLocalBinDirs` is the classifier half of the package-manager pair and spells by design; `ownerCommonDirForm` climbs the identity it was handed",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/review-graph/git-identity.ts": {
		reason:
			"the git checkout's `spelledRoot` stays on the spelling: the graph reports roots beside the spelled cwd",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/gitleaks-client.ts": {
		reason:
			"nested-checkout test between a finding's spelled file and the caller's spelled cwd; both ends are spellings by design (`spelling: true`)",
		pinnedBy: "tests/clients/gitleaks-client.test.ts",
	},
	"clients/review-graph/import-resolvers.ts": {
		reason:
			"import resolution is bounded by the scan root on the graph's spelling (`spelling: true`, `isWithin(cwd, dir)`); keys are taken from the spelled file",
		pinnedBy: "tests/clients/review-graph/import-resolvers.test.ts",
	},
	"clients/lsp/edits.ts": {
		reason:
			"the parent check of a workspace edit climbs the confined identity the overlay is keyed by (`spelling: true`)",
		pinnedBy: "tests/clients/lsp/edits.test.ts",
	},
	"clients/lsp/workspace-diagnostics-cache.ts": {
		reason:
			"clears the caches registered under the caller's spelling of each root (`spelling: true`), up to the spelled workspace root",
		pinnedBy: "tests/clients/lsp/workspace-diagnostics-cache.test.ts",
	},
	"clients/file-utils.ts": {
		reason:
			"`resolveGitIgnoreRoot` is private to the project ignore matcher; its verdicts are pinned through the matcher on a link-spelled root",
		pinnedBy: "tests/clients/ignore-verdict-identity-4689.test.ts",
	},
	"clients/formatters.ts": {
		reason:
			"`findUp` (formatter config discovery) and `hasEditorConfig` are private; pinned through the formatter config finders on a link",
		pinnedBy: "tests/clients/formatters-link-config-4689.test.ts",
	},
	"clients/metrics-history.ts": {
		reason:
			"`getCurrentCommit` looks up a git repo for a spawn cwd and is private; its file-link start is pinned through `captureSnapshots` with a real repository beside the link",
		pinnedBy: "tests/clients/metrics-history-stderr.test.ts",
	},
	"clients/metrics/complexity-baseline.ts": {
		reason:
			"`existingDir` finds the nearest existing directory of a file's real path as the cwd of its default-branch git read (#5087); it answers a spawn cwd, not a root, and its file-link start is pinned with a link outside the repository",
		pinnedBy: "tests/clients/metrics/complexity-baseline.test.ts",
	},
	"clients/tree-sitter-client.ts": {
		reason:
			"`grammarWriteBlockedReason` probes the nearest existing ancestor of a data dir for writability; it answers an errno, not a root",
		pinnedBy: "tests/clients/tree-sitter-grammar-compiled-host.test.ts",
	},
	"clients/sg-runner.ts": {
		reason:
			"the ast-grep binary search climbs `process.cwd()`, which is the kernel's own path",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"mcp/server.ts": {
		reason:
			"`findRepoRoot` runs once at module load for the server's own directory; it is private to the entry point",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/dead-code-client.ts": {
		reason:
			"a Python project root through `findNearestMarkerRoot` (registered); the start is the scan's cwd",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/knip-client.ts": {
		reason:
			"a Node project root through `findNearestMarkerRoot` (registered); the start is the scan's cwd",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/tool-agreement.ts": {
		reason:
			"project-level agreement probes through `findNearestMarkerRoot` (registered) from the dispatch cwd",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/pipeline.ts": {
		reason:
			"the Cargo and Dart package roots start at `dirname(realpathOrResolve(file))` (#4876) through `findNearestContaining` (registered)",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/test-runner-client.ts": {
		reason:
			"the checkout-ownership walks start at the file's `realTarget` and the `realCwd` through `findNearestMarkerRootDetailed` (registered)",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/dispatch/runners/shellcheck.ts": {
		reason:
			"`findLocalToolConfig` (registered) from the dispatch context's cwd, an identity",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
	"clients/dispatch/runners/vale.ts": {
		reason:
			"`findLocalToolConfig` (registered) from the dispatch context's cwd, an identity",
		pinnedBy: "tests/clients/walk-identity-4689.test.ts",
	},
};

/**
 * Admit a file that NAMES a seam climber in code (comments and strings
 * blanked): a call, an import alias (`findNearestContaining as nearest`), a
 * `const` binding of one, a member call through a namespace import, a passed
 * reference. The form is "any code mention", so a spelling nobody planned for
 * is a walker file that needs a registration, not a skipped file (AGENTS.md
 * shape 69). On the authoring head every file that calls one also names one
 * and no file names one without calling it, so the wider rule adds no row.
 */
const SEAM_CLIMBER_NAME =
	/\b(?:walkUpDirs|findNearestContaining|findLocalToolConfig|findNearestMarkerRoot|findNearestMarkerRootDetailed)\b/;

function namesSeamClimber(source: string): boolean {
	return SEAM_CLIMBER_NAME.test(stripSource(source));
}

/** Files under the runtime trees that name a seam climber. */
function walkerFiles(): string[] {
	const files = [
		...["clients", "tools", "mcp"].flatMap((tree) =>
			listSourceFiles(path.join(REPO_ROOT, tree), { skipTests: true }),
		),
		path.join(REPO_ROOT, "index.ts"),
	];
	const found: string[] = [];
	for (const file of files) {
		const source = readWalkedFile(file);
		if (source === undefined) continue;
		if (namesSeamClimber(source)) found.push(relativePosix(REPO_ROOT, file));
	}
	return found.sort();
}

async function answers(walker: Walker, layout: Layout) {
	// The pi-lens data dir sits beside the fixture, never above it: the suite's
	// own data dir is under the tmp root every fixture lives in.
	vi.stubEnv("PI_LENS_HOME", path.join(layout.base, "pi-lens-home"));
	vi.spyOn(process, "cwd").mockReturnValue(walker.cwd?.(layout) ?? layout.base);
	const reduce = walker.answer ?? ((raw: unknown) => raw);
	const starts =
		walker.input === "dir"
			? { real: layout.realDir, dirTwin: layout.twinDir }
			: {
					real: layout.realFile,
					dirTwin: layout.twinFile,
					fileTwin: layout.linkFile,
				};
	const out: Record<string, unknown> = {};
	for (const [spelling, start] of Object.entries(starts))
		out[spelling] = canon(reduce(await walker.run(start, layout), layout));
	const owner = canon(walker.expected ? walker.expected(layout) : layout.real);
	return {
		out,
		expected: Object.fromEntries(Object.keys(starts).map((k) => [k, owner])),
	};
}

describe("#4966: every upward walker answers the same from a symlink twin", () => {
	for (const walker of WALKERS)
		it(
			`${walker.id}: the real path and its symlink twin answer the owner`,
			async (ctx) => {
				// RECURRENCE GUARDED: seven bug-fix PRs (#4844 #4847 #4858 #4870 #4876
				// #4919 #4957) each found one walker that started from the spelling and
				// answered the decoy owner for a symlinked checkout.
				const { layout, skipReason } = build(walker);
				if (skipReason) return ctx.skip(skipReason);
				const { out, expected } = await answers(walker, layout);
				expect(out).toEqual(expected);
			},
			TREE_WALK_TIMEOUT_MS,
		);
});

describe("#4966: the walker registry covers every file that climbs", () => {
	// Lazy: the walk runs inside a budgeted case, never at suite declaration.
	let cached: string[] | undefined;
	const live = (): string[] => (cached ??= walkerFiles());
	const registered = new Set(WALKERS.flatMap((walker) => walker.files));

	it(
		"finds the climbing files (a scan that reads nothing is dead, not clean)",
		() => {
			// Calibration on the authoring head: 41 files name a seam climber.
			assertNonEmptyScan("walker twin census", live().length, 25);
			expect(live()).toContain("clients/tool-policy.ts");
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"registers or exempts every file that names a seam climber",
		() => {
			// RECURRENCE GUARDED: a new walker file that nothing runs from a twin is
			// how #4847, #4858 and #4876 shipped: no scanner sees a walk start.
			const unaccounted = live().filter(
				(file) => !registered.has(file) && !(file in EXEMPT),
			);
			expect(
				unaccounted,
				"Register the walker in WALKERS (it runs from a symlink twin), or exempt the file in EXEMPT with the reason and the suite that pins it. Refs #4966.",
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"keeps no stale entry and gives every exemption a reason and a real suite",
		() => {
			const liveSet = new Set(live());
			const stale = [...registered, ...Object.keys(EXEMPT)].filter(
				(file) => !liveSet.has(file),
			);
			const doubled = Object.keys(EXEMPT).filter((file) =>
				registered.has(file),
			);
			const weak = Object.entries(EXEMPT)
				.filter(
					([, entry]) =>
						entry.reason.trim().length < 40 ||
						!fs.existsSync(path.join(REPO_ROOT, entry.pinnedBy)),
				)
				.map(([file]) => file);
			expect({ stale, doubled, weak }).toEqual({
				stale: [],
				doubled: [],
				weak: [],
			});
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("admits a climber named by an alias, a binding or a namespace, not by prose", () => {
		// RECURRENCE GUARDED (PR #5037 review, Greptile): the census matched the
		// callee's text, so `findNearestContaining as nearest` then `nearest(...)`
		// was a walker file nothing registered. Each spelling below is planted.
		const planted: Array<[string, string, boolean]> = [
			[
				"import alias then call",
				"import { findNearestContaining as nearest } from './path-utils.js';\nnearest(dir, ['a']);",
				true,
			],
			[
				"const binding of the climber",
				"import { walkUpDirs } from './path-utils.js';\nconst climb = walkUpDirs;\nclimb(dir);",
				true,
			],
			[
				"namespace member call",
				"import * as pu from './path-utils.js';\npu.findNearestMarkerRoot(dir, ['a']);",
				true,
			],
			["direct call", "findLocalToolConfig(dir, ['a.toml']);", true],
			[
				"a comment and a string only",
				"// walkUpDirs is the seam\nconst note = 'findNearestContaining';",
				false,
			],
		];
		expect(
			planted.map(([label, source]) => [label, namesSeamClimber(source)]),
		).toEqual(planted.map(([label, , expected]) => [label, expected]));
	});
});

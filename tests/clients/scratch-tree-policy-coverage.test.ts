/**
 * #1562 class-fix coverage: every runner that hands a DIRECTORY to an
 * external binary and lets THAT binary do its own tree walk (as opposed to
 * pi-lens's own `EXCLUDED_DIRS`-aware in-process walker feeding it a
 * pre-filtered file list) must thread the shared scratch-tree exclusion
 * policy (`scratch-tree-policy.ts`) through that tool's native exclude
 * mechanism.
 *
 * Sweep (grepped every `clients/*-client.ts` for a `safeSpawnAsync` call
 * whose args include `cwd`/`targetDir` as a bare positional — i.e. "the
 * binary walks the tree itself", #1562 root-cause shape):
 *   - gitleaks (`clients/gitleaks-client.ts`)  — covered: generated
 *     `--config` scoped allowlist + TS-side backstop
 *     (`gitleaks-scratch-exclusion.test.ts`).
 *   - trivy `fs` (`clients/trivy-client.ts`)    — covered below: `--skip-dirs`.
 *   - opengrep (`clients/opengrep-client.ts`)   — covered below: `--exclude`.
 *   - jscpd (`clients/jscpd-client.ts`)         — ALREADY wired (pre-#1562):
 *     `--ignore` built from `getExcludedDirGlobs()` + `getProjectIgnoreGlobs()`
 *     — not part of this defect.
 *   - vulture (`clients/dead-code-client.ts`)   — different shape (per-edit
 *     `--exclude`, not a session-scan secrets/CVE surface), but its
 *     `VULTURE_EXCLUDES` had independently DRIFTED from `EXCLUDED_DIRS` (a
 *     sibling single-source-of-truth defect found during this sweep) —
 *     covered below.
 *   - knip (`clients/knip-client.ts`)   — config/gitignore-driven, not a raw
 *     directory positional; knip respects `.gitignore` itself, which is
 *     ACCEPTABLE for a dead-code tool (unlike a secrets scanner, missing an
 *     ignored file's dead code is not a security gap) — deliberately left.
 *   - govulncheck (`clients/govulncheck-client.ts`) — Go-package-based
 *     (`-mode=source ./...`, via `go list`), not an arbitrary-byte tree walk;
 *     non-Go scratch content is invisible to it by construction — deliberately
 *     left.
 *   - trivy `config` (IaC misconfig, `clients/dispatch/runners/trivy-config.ts`)
 *     — per-EDIT dispatch runner over a single file already selected by the
 *     dispatch pipeline, not a directory scan — deliberately left.
 *
 * #1562 review-round F1 note: trivy/opengrep still consume the WALKER-PARITY
 * `EXCLUDED_DIRS`-derived list (`getScratchTreeGlobPatterns`/
 * `getScratchTreeDirNames`) tested below — that's correct for trivy's
 * vuln/license scanners and for opengrep's general SAST findings (skipping
 * `dist`/`build`/`vendor` there is the RIGHT call, unlike gitleaks's
 * secrets-only lane). Whether trivy's bundled `secret` scanner needs its own
 * narrower list, the way gitleaks now does (`SECRETS_LANE_SCRATCH_DIR_NAMES`),
 * is deliberately deferred — see the F5 follow-up issue referenced in the
 * PR body; a single `--skip-dirs` invocation can't vary by sub-scanner
 * without a structural change this round didn't attempt.
 */
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getScratchTreeDirNames,
	getScratchTreeFnmatchPatterns,
	getScratchTreeGlobPatterns,
	getSecretsLaneAllowlistPaths,
	isUnderSecretsLaneScratchTree,
	SECRETS_LANE_SCRATCH_DIR_NAMES,
} from "../../clients/scratch-tree-policy.js";
import { EXCLUDED_DIRS } from "../../clients/file-utils.js";
import { escapeRegExp } from "../../clients/string-utils.js";

const { safeSpawnAsync, safeSpawn } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	safeSpawn: vi.fn(),
}));
vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));

describe("scratch-tree-policy — single source of truth (#1562)", () => {
	it("walker-parity tool-format lists are derived from (never a copy that can drift from) EXCLUDED_DIRS", () => {
		const literalNames = EXCLUDED_DIRS.filter(
			(n) => !n.includes("*") && !n.includes("?"),
		);
		expect(getScratchTreeDirNames()).toEqual(literalNames);
		expect(getScratchTreeGlobPatterns().length).toBe(EXCLUDED_DIRS.length);
		// Each name is a direct child and a deeper descendant of the root (#5500).
		expect(getScratchTreeFnmatchPatterns("/repo").length).toBe(
			literalNames.length * 2,
		);
	});
});

// #1562 review-round F1: the first cut of this fix used the FULL
// EXCLUDED_DIRS list as gitleaks's secrets-lane exclusion too. A reviewer
// probe seeded a real-AWS-shaped secret in 9 "walker-only" dirs (build
// OUTPUT / vendored SOURCE / editor config — never pi-ecosystem scratch) and
// found every one of them silently dropped. This pins the fix: those 9 stay
// OUT of the secrets-lane exclusion, while the genuine pi-ecosystem/agent/
// cache dirs stay IN it.
describe("scratch-tree-policy — secrets-lane tier is narrower than walker-parity (#1562 review-round F1)", () => {
	const walkerOnlyProbePaths = [
		"dist/config.js",
		"vendor/lib/keys.go",
		".vscode/launch.json",
		"build/bundle.js",
		"out/main.js",
		"target/release/config.rs",
		"third_party/lib/secrets.py",
		"third-party/lib/secrets.py",
		"coverage/lcov-report/index.html",
	];

	it("the 9-path probe: none of the walker-only dirs are in the secrets-lane dir list", () => {
		const secretsLane = new Set(
			SECRETS_LANE_SCRATCH_DIR_NAMES.map((n) => n.toLowerCase()),
		);
		for (const probePath of walkerOnlyProbePaths) {
			const topDir = probePath.split("/")[0].toLowerCase();
			expect(secretsLane.has(topDir)).toBe(false);
		}
	});

	it("the 9-path probe: isUnderSecretsLaneScratchTree keeps (does not flag) every walker-only path", () => {
		for (const probePath of walkerOnlyProbePaths) {
			expect(isUnderSecretsLaneScratchTree(probePath, "/repo")).toBe(false);
		}
	});

	it("still excludes genuine pi-ecosystem/agent/cache dirs, including the #1562 fixture", () => {
		expect(
			isUnderSecretsLaneScratchTree(
				".pi/greedysearch-sources/cline-docs.md",
				"/repo",
			),
		).toBe(true);
		for (const scratchDir of [
			".claude",
			".codex",
			// #3112: the rebranded pi config dir, same `<configDir>/agent/sessions`
			// history as `.pi` — a session transcript is not a first-party leak
			// surface, and scanning one reads user session content.
			".omp",
			".agents",
			"node_modules",
			".git",
			".next",
			"venv",
		]) {
			expect(
				isUnderSecretsLaneScratchTree(`${scratchDir}/some/file.txt`, "/repo"),
			).toBe(true);
		}
	});

	it("rejects an ordinary source path and doesn't false-positive on a substring match", () => {
		expect(isUnderSecretsLaneScratchTree("src/config.ts", "/repo")).toBe(false);
		// Must not false-positive on a filename that merely CONTAINS an
		// excluded name as a substring (e.g. "api.pipeline.ts" vs ".pi").
		expect(isUnderSecretsLaneScratchTree("src/api.pipeline.ts", "/repo")).toBe(
			false,
		);
	});

	it("getSecretsLaneAllowlistPaths matches both forward- and back-slash separators (#1562 review-round F4)", () => {
		const root = path.resolve("repo-root");
		const patterns = getSecretsLaneAllowlistPaths(root).map(
			(p) => new RegExp(p),
		);
		const forwardSlash = `${root.replace(/\\/g, "/")}/.pi/greedysearch-sources/cline-docs.md`;
		const backSlash = `${root.replace(/\//g, "\\")}\\.pi\\greedysearch-sources\\cline-docs.md`;
		expect(patterns.some((r) => r.test(forwardSlash))).toBe(true);
		expect(patterns.some((r) => r.test(backSlash))).toBe(true);
	});
});

// #5500: every name-based exclusion here was written for paths relative to the
// scan root, then matched against an ABSOLUTE path (gitleaks's `File`, vulture's
// resolved module path). A scratch-named directory ABOVE the project -- Claude
// Code's own `.claude/worktrees/<lane>` layout, a `.pi-lens/prepush-tmp` temp
// root -- then excluded the whole project: gitleaks findings were dropped or
// demoted so the turn-end secrets blocker never fired, vulture printed nothing
// and exited 0. Recurrence prevented: a policy function that judges a segment
// name without the scan root.
describe("scratch-tree-policy — the scan root bounds every name match (#5500)", () => {
	const ancestors = [
		".claude/worktrees/lane",
		".pi-lens/prepush-tmp",
		".worktrees/lane",
		".codex/x",
		".agents/x",
		".pi/x",
	];

	// vulture matches an fnmatch pattern against the whole resolved path: `*`
	// crosses `/`, `?` is one character, `[c]` a class (only the single-character
	// form the policy emits). Vulture is not a CI dependency, so its rule is
	// restated here; the real-binary transcript is in the PR body.
	function fnmatch(pattern: string, name: string): boolean {
		// Windows folds `\` to `/` before matching (`ntpath.normcase`).
		const source = pattern
			.replace(/\\/g, "/")
			.replace(/\[(.)\]|\*|\?|./g, (token, ch?: string) =>
				ch !== undefined
					? escapeRegExp(ch)
					: token === "*"
						? ".*"
						: token === "?"
							? "."
							: escapeRegExp(token),
			);
		return new RegExp(`^${source}$`, "i").test(name.replace(/\\/g, "/"));
	}

	it.each(ancestors)(
		"isUnderSecretsLaneScratchTree ignores a scratch-named ancestor (%s) and still sees one inside the root",
		(ancestor) => {
			const root = path.resolve("scan-base", ancestor, "project");
			expect(
				isUnderSecretsLaneScratchTree(path.join(root, "src/a.ts"), root),
			).toBe(false);
			expect(isUnderSecretsLaneScratchTree("src/a.ts", root)).toBe(false);
			expect(
				isUnderSecretsLaneScratchTree(path.join(root, ".pi/notes.md"), root),
			).toBe(true);
			expect(
				isUnderSecretsLaneScratchTree(
					path.join(root, "pkg/.claude/x.md"),
					root,
				),
			).toBe(true);
			// A file outside the root is not under it, so no scratch judgement.
			expect(
				isUnderSecretsLaneScratchTree(path.resolve("elsewhere/.pi/x.md"), root),
			).toBe(false);
		},
	);

	it.each(ancestors)(
		"getSecretsLaneAllowlistPaths anchors at the root: an ancestor (%s) matches nothing, a scratch dir inside does",
		(ancestor) => {
			const root = path.resolve("scan-base", ancestor, "project");
			const patterns = getSecretsLaneAllowlistPaths(root).map(
				(p) => new RegExp(p),
			);
			const matches = (file: string) => patterns.some((r) => r.test(file));
			expect(matches(path.join(root, "src/a.ts"))).toBe(false);
			expect(matches(path.join(root, ".pi/notes.md"))).toBe(true);
			expect(matches(path.join(root, "pkg/.claude/x.md"))).toBe(true);
			expect(matches(path.join(root, ".pi"))).toBe(true);
			// A sibling that merely shares the root's spelling as a prefix.
			expect(matches(`${root}-other/.pi/x.md`)).toBe(false);
		},
	);

	it.each(ancestors)(
		"getScratchTreeFnmatchPatterns anchors at the root: an ancestor (%s) excludes nothing, a scratch dir inside does",
		(ancestor) => {
			const root = path.resolve("scan-base", ancestor, "project");
			const patterns = getScratchTreeFnmatchPatterns(root, ["site-packages"]);
			const excluded = (file: string) => patterns.some((p) => fnmatch(p, file));
			expect(excluded(`${root}/pkg/a.py`)).toBe(false);
			expect(excluded(`${root}/a.py`)).toBe(false);
			expect(excluded(`${root}/.pi/a.py`)).toBe(true);
			expect(excluded(`${root}/pkg/.claude/a.py`)).toBe(true);
			expect(excluded(`${root}/pkg/site-packages/a.py`)).toBe(true);
		},
	);

	// Review of #5548 (F3): a filesystem or drive root splits into a trailing
	// empty segment, and joining it unstripped demanded a doubled separator.
	// Recurrence prevented: the anchor silently matching nothing for such a root.
	it("getSecretsLaneAllowlistPaths anchors a filesystem root with one separator", () => {
		const root = path.parse(path.resolve("x")).root;
		const patterns = getSecretsLaneAllowlistPaths(root).map(
			(p) => new RegExp(p),
		);
		const matches = (file: string) => patterns.some((r) => r.test(file));
		expect(matches(`${root}.pi${path.sep}x.md`)).toBe(true);
		expect(matches(`${root}src${path.sep}x.md`)).toBe(false);
	});

	it("getScratchTreeFnmatchPatterns keeps a root holding glob characters or a comma literal and comma-free", () => {
		const root = path.resolve("scan-base", "we[ird]*?,dir");
		const patterns = getScratchTreeFnmatchPatterns(root);
		expect(patterns.some((p) => p.includes(","))).toBe(false);
		const excluded = (file: string) => patterns.some((p) => fnmatch(p, file));
		expect(excluded(`${root}/.pi/a.py`)).toBe(true);
		expect(excluded(`${root}/src/a.py`)).toBe(false);
		// The globs in the root's own name did not widen the match.
		expect(excluded(`${path.resolve("scan-base", "weird")}/.pi/a.py`)).toBe(
			false,
		);
	});
});

describe("TrivyClient.scan — --skip-dirs threads the shared policy (#1562)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("passes a --skip-dirs flag for every scratch-tree glob", async () => {
		const { TrivyClient } = await import("../../clients/trivy-client.js");
		const client = new TrivyClient(false) as unknown as {
			ensureAvailable: () => Promise<boolean>;
			runScan: (cwd: string) => Promise<unknown>;
		};
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});

		await client.runScan("/repo");

		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const args = safeSpawnAsync.mock.calls[0][1] as string[];
		for (const glob of getScratchTreeGlobPatterns()) {
			const idx = args.indexOf(glob);
			expect(idx).toBeGreaterThan(0);
			expect(args[idx - 1]).toBe("--skip-dirs");
		}
	});
});

describe("OpengrepClient.scan — --exclude threads the shared policy (#1562)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("passes an --exclude flag for every scratch-tree directory name", async () => {
		const { OpengrepClient } = await import("../../clients/opengrep-client.js");
		const client = new OpengrepClient(false) as unknown as {
			ensureAvailable: () => Promise<boolean>;
			runScan: (cwd: string) => Promise<unknown>;
		};
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});

		await client.runScan("/repo");

		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const args = safeSpawnAsync.mock.calls[0][1] as string[];
		for (const name of getScratchTreeDirNames()) {
			const idx = args.indexOf(name);
			expect(idx).toBeGreaterThan(0);
			expect(args[idx - 1]).toBe("--exclude");
		}
	});
});

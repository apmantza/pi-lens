/**
 * Four production sites took a path identity with a raw `realpath` of their
 * own (the `PRE_4689` `raw-realpath` rows of `tests/config/path-identity-sweep.test.ts`
 * until this fold): `probe-home-state.ts` `isUnderRealDir` (two uses),
 * `project-diagnostics/fresh-fetch.ts` (the explicit analysis root) and
 * `review-graph/git-identity.ts` `canonicalDirectory` (checkout `root` and
 * `commonDir`). Each now answers through the path-identity seam
 * (`realpathOrResolve`, `isWithinIdentity`), so one wrong seam answer moves all
 * of them, and these cells are the callers' witnesses of that dependence.
 *
 * Recurrence guarded: AGENTS.md shape 1 (divergent path keys) and shape 83 (a
 * rule re-derived beside its owner). A raw `fs.realpathSync(x)` that falls back
 * to the input spelling answers a different string than the seam for a path
 * that does not exist yet, and a hand-copied fallback is what #4689 retired in
 * thirteen other modules.
 *
 * Each cell drives the production entry, never the seam: the logger's
 * real-home guard, `fetchFreshProjectDiagnostics`, `resolveGitCheckout`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTestProcessTargetingRealHome } from "../../clients/probe-home-state.js";
import { fetchFreshProjectDiagnostics } from "../../clients/project-diagnostics/fresh-fetch.js";
import { resolveGitCheckout } from "../../clients/review-graph/git-identity.js";
import { pinFixtureHome, setupTestEnvironment } from "./test-utils.js";

let base: string;
let cleanup: () => void;

beforeEach(() => {
	const env = setupTestEnvironment("pi-lens-raw-realpath-fold-");
	base = env.tmpDir;
	cleanup = env.cleanup;
});

afterEach(() => {
	cleanup();
});

function link(target: string, at: string): string {
	fs.symlinkSync(target, at, "junction");
	return at;
}

describe("isTestProcessTargetingRealHome compares by path identity", () => {
	it("refuses a file under the real home reached through a link spelling of it", () => {
		const { home } = pinFixtureHome("raw-realpath-fold-home");
		fs.mkdirSync(path.join(home, ".pi-lens"), { recursive: true });
		const homeLink = link(home, path.join(base, "home-link"));
		expect(os.homedir()).toBe(home);

		// The home is the real path, the file is spelled through a link to it.
		expect(
			isTestProcessTargetingRealHome(
				path.join(homeLink, ".pi-lens", "latency.log"),
			),
		).toBe(true);
		// And for a log directory that is not created yet.
		expect(
			isTestProcessTargetingRealHome(
				path.join(homeLink, ".pi-lens", "later", "latency.log"),
			),
		).toBe(true);
	});

	it("allows a file spelled under the real home whose directory is a link out of it", () => {
		const { home } = pinFixtureHome("raw-realpath-fold-linkout");
		const outside = path.join(base, "outside");
		fs.mkdirSync(outside, { recursive: true });
		fs.mkdirSync(path.join(home, ".pi-lens"), { recursive: true });
		link(outside, path.join(home, ".pi-lens", "out"));

		// Spelled inside, kernel-real outside: the log is not under the home, so
		// a test may truncate it. `isUnderDir` (spelling OR identity) would
		// refuse it; the identity-only predicate is the one that answers true here.
		expect(
			isTestProcessTargetingRealHome(
				path.join(home, ".pi-lens", "out", "x.log"),
			),
		).toBe(false);
	});
});

describe("fetchFreshProjectDiagnostics names an explicit analysis root by identity", () => {
	it("reports the real directory behind a link spelling, not the link", async () => {
		const home = path.join(base, "home");
		const outside = path.join(base, "outside", "proj");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		const rootLink = link(outside, path.join(home, "proj-link"));

		// Outside home, so the run refuses before any analyzer starts and the
		// double clients are never touched; the refusal names the root it judged.
		const result = await fetchFreshProjectDiagnostics(
			{} as never,
			home,
			{} as never,
			undefined,
			{ homeDir: home, analysisRoot: rootLink },
		);

		expect(result.analysisRootValidation).toEqual({
			state: "unsafe",
			root: outside,
			reason:
				"explicit analysis root must be strictly contained by the canonical home directory",
		});
	});
});

describe("resolveGitCheckout answers root and commonDir by identity", () => {
	function makeRepo(root: string, commondirFile?: string): string {
		const gitDir = path.join(root, ".git");
		fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
		fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		if (commondirFile !== undefined)
			fs.writeFileSync(path.join(gitDir, "commondir"), `${commondirFile}\n`);
		return gitDir;
	}

	it("resolves a repository reached through a link to its real root and git dir", () => {
		const repo = path.join(base, "repo");
		const gitDir = makeRepo(repo);
		const repoLink = link(repo, path.join(base, "repo-link"));

		const checkout = resolveGitCheckout(path.join(repoLink, "src"));

		expect(checkout?.root).toBe(repo);
		expect(checkout?.spelledRoot).toBe(repoLink);
		expect(checkout?.commonDir).toBe(gitDir);
	});

	it("resolves a commondir that names a missing directory through a link to the same identity", () => {
		const real = path.join(base, "real");
		fs.mkdirSync(real, { recursive: true });
		const realLink = link(real, path.join(base, "real-link"));
		const repo = path.join(base, "repo");
		// The shared git dir is spelled through the link and does not exist: the
		// seam answers its nearest existing ancestor's real path plus the tail,
		// where a raw realpath that throws kept the link spelling.
		makeRepo(repo, path.join(realLink, "gone", ".git"));

		const checkout = resolveGitCheckout(repo);

		expect(checkout?.commonDir).toBe(path.join(real, "gone", ".git"));
	});
});

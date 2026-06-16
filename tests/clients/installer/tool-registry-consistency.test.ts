import { describe, expect, it, vi } from "vitest";
import { GITHUB_TOOLS, TOOLS } from "../../../clients/installer/index.ts";

// Use the real installer module, not any mock another test file registered.
vi.unmock("../../../clients/installer/index.ts");

/**
 * Deterministic, network-free guard on the auto-install registry wiring.
 *
 * #209 layer 1: the live install→run net (scripts/, opt-in) is expensive and
 * environment-dependent; this catches the cheap class of mistake per-PR — a
 * half-wired `TOOLS` entry that *looks* registered but can never install
 * because it omits the field its strategy needs (`installTool` silently returns
 * false), or a `github` tool whose asset selection is dead/throws. It mirrors
 * the LSP_SERVERS registry guard but locks the **install contract** that
 * `installTool` depends on, plus keeps `GITHUB_TOOLS` (the curated full-matrix
 * list the asset-matrix test iterates) in lockstep with the registry.
 */

const STRATEGIES = new Set(["npm", "pip", "gem", "github", "maven", "archive"]);
const PLATFORMS = ["linux", "darwin", "win32"] as const;
const ARCHES = ["x64", "arm64"] as const;
// Platforms pi-lens never builds binaries for — assetMatch must reject these.
const UNSUPPORTED_PLATFORMS = ["freebsd", "sunos", "aix"];

const isCleanToken = (s: string): boolean => !/[\s\\/]/.test(s);

/** A github tool that yields a non-empty asset for all 6 platform/arch combos. */
function resolvesFullMatrix(tool: (typeof TOOLS)[number]): boolean {
	if (!tool.github) return false;
	for (const platform of PLATFORMS) {
		for (const arch of ARCHES) {
			const asset = tool.github.assetMatch(platform, arch);
			if (!asset) return false;
		}
	}
	return true;
}

describe("TOOLS registry consistency", () => {
	it("is non-empty", () => {
		expect(TOOLS.length).toBeGreaterThan(0);
	});

	it("every tool has the required base wiring (id, name, checkCommand, checkArgs, strategy)", () => {
		for (const t of TOOLS) {
			expect(typeof t.id, `id on ${JSON.stringify(t.name)}`).toBe("string");
			expect(t.id.length, "non-empty id").toBeGreaterThan(0);
			expect(typeof t.name, `name on ${t.id}`).toBe("string");
			expect(t.name.length, `non-empty name on ${t.id}`).toBeGreaterThan(0);
			expect(typeof t.checkCommand, `checkCommand on ${t.id}`).toBe("string");
			expect(t.checkCommand.length, `non-empty checkCommand on ${t.id}`).toBeGreaterThan(0);
			expect(Array.isArray(t.checkArgs), `checkArgs array on ${t.id}`).toBe(true);
			for (const arg of t.checkArgs) {
				expect(typeof arg, `checkArgs entry on ${t.id}`).toBe("string");
			}
			expect(STRATEGIES.has(t.installStrategy), `valid strategy on ${t.id}: ${t.installStrategy}`).toBe(true);
		}
	});

	it("tool ids are globally unique", () => {
		const seen = new Map<string, number>();
		for (const t of TOOLS) seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
		const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
		expect(dupes, `duplicate tool ids: ${dupes.join(", ")}`).toEqual([]);
	});

	it("checkCommand and binaryName are clean executable tokens (no path separators/whitespace)", () => {
		for (const t of TOOLS) {
			expect(isCleanToken(t.checkCommand), `${t.id} checkCommand "${t.checkCommand}"`).toBe(true);
			if (t.binaryName !== undefined) {
				expect(isCleanToken(t.binaryName), `${t.id} binaryName "${t.binaryName}"`).toBe(true);
			}
		}
	});

	// These mirror installTool()'s per-strategy preconditions. An entry that
	// fails one of these compiles fine but silently never installs at runtime.
	describe("install contract per strategy", () => {
		it("npm tools declare packageName + binaryName and no github spec", () => {
			for (const t of TOOLS.filter((x) => x.installStrategy === "npm")) {
				expect(t.packageName, `${t.id} packageName`).toBeTruthy();
				expect(t.binaryName, `${t.id} binaryName`).toBeTruthy();
				expect(t.github, `${t.id} should not carry a github spec`).toBeUndefined();
			}
		});

		it("pip/gem tools declare packageName and no github spec", () => {
			for (const t of TOOLS.filter(
				(x) => x.installStrategy === "pip" || x.installStrategy === "gem",
			)) {
				expect(t.packageName, `${t.id} packageName`).toBeTruthy();
				expect(t.github, `${t.id} should not carry a github spec`).toBeUndefined();
			}
		});

		it("github tools declare a github spec (owner/repo + assetMatch), binaryName, and no packageName", () => {
			for (const t of TOOLS.filter((x) => x.installStrategy === "github")) {
				expect(t.github, `${t.id} github spec`).toBeDefined();
				expect(typeof t.github?.assetMatch, `${t.id} assetMatch fn`).toBe("function");
				expect(t.github?.repo, `${t.id} repo "owner/repo"`).toMatch(/^[\w.-]+\/[\w.-]+$/);
				expect(t.binaryName, `${t.id} binaryName`).toBeTruthy();
				expect(t.packageName, `${t.id} github tool should not carry packageName`).toBeUndefined();
			}
		});

		it("maven tools declare a maven spec (groupId/artifactId/version) + binaryName, no packageName/github", () => {
			for (const t of TOOLS.filter((x) => x.installStrategy === "maven")) {
				expect(t.maven, `${t.id} maven spec`).toBeDefined();
				expect(t.maven?.groupId, `${t.id} groupId`).toMatch(/^[\w.-]+$/);
				expect(t.maven?.artifactId, `${t.id} artifactId`).toMatch(/^[\w.-]+$/);
				expect(t.maven?.version, `${t.id} pinned version`).toMatch(/^[\w.+-]+$/);
				expect(t.binaryName, `${t.id} binaryName`).toBeTruthy();
				expect(t.packageName, `${t.id} maven tool should not carry packageName`).toBeUndefined();
				expect(t.github, `${t.id} maven tool should not carry a github spec`).toBeUndefined();
			}
		});

		it("archive tools declare an archive spec (https url + kind + launcher) + binaryName, no packageName/github/maven", () => {
			for (const t of TOOLS.filter((x) => x.installStrategy === "archive")) {
				expect(t.archive, `${t.id} archive spec`).toBeDefined();
				expect(t.archive?.url, `${t.id} archive url`).toMatch(/^https:\/\//);
				expect(["tgz", "zip"], `${t.id} archive kind`).toContain(t.archive?.kind);
				// launcher is a relative path inside the archive — no leading slash / drive.
				expect(t.archive?.launcher, `${t.id} launcher`).toMatch(/^[\w.-]+(\/[\w.-]+)*$/);
				expect(t.binaryName, `${t.id} binaryName`).toBeTruthy();
				expect(t.packageName, `${t.id} archive tool should not carry packageName`).toBeUndefined();
				expect(t.github, `${t.id} archive tool should not carry a github spec`).toBeUndefined();
				expect(t.maven, `${t.id} archive tool should not carry a maven spec`).toBeUndefined();
			}
		});
	});

	describe("github asset selection is total and safe", () => {
		const githubTools = TOOLS.filter((x) => x.installStrategy === "github");

		it("assetMatch never throws and returns string|undefined for any platform/arch", () => {
			for (const t of githubTools) {
				for (const platform of [...PLATFORMS, ...UNSUPPORTED_PLATFORMS]) {
					for (const arch of [...ARCHES, "ia32"]) {
						const value = t.github?.assetMatch(platform, arch);
						expect(
							value === undefined || typeof value === "string",
							`${t.id} ${platform}/${arch} returned ${typeof value}`,
						).toBe(true);
					}
				}
			}
		});

		it("every github tool supports at least one platform/arch combo (no dead entry)", () => {
			for (const t of githubTools) {
				const supported = PLATFORMS.flatMap((p) =>
					ARCHES.map((a) => t.github?.assetMatch(p, a)),
				).some((asset) => typeof asset === "string" && asset.length > 0);
				expect(supported, `${t.id} resolves no asset on any supported platform`).toBe(true);
			}
		});

		it("rejects unsupported platforms", () => {
			for (const t of githubTools) {
				for (const platform of UNSUPPORTED_PLATFORMS) {
					expect(t.github?.assetMatch(platform, "x64"), `${t.id} ${platform}`).toBeUndefined();
				}
			}
		});

		// #218: a .bat/.cmd wrapper asset runs a sibling file (e.g. ktlint.bat →
		// `java -jar %~dp0ktlint`), so the wrapper alone is useless — the tool MUST
		// declare extraAssets to fetch the dependency alongside it.
		it("github tools whose win32 asset is a .bat/.cmd wrapper declare extraAssets", () => {
			for (const t of githubTools) {
				const winAsset = ARCHES.map((a) => t.github?.assetMatch("win32", a)).find(
					(x): x is string => typeof x === "string",
				);
				if (winAsset && /\.(bat|cmd)$/i.test(winAsset)) {
					const extras = t.github?.extraAssets?.("win32", "x64") ?? [];
					expect(
						extras.length,
						`${t.id}: win32 asset "${winAsset}" is a wrapper but declares no extraAssets (the wrapped file won't be installed — #218)`,
					).toBeGreaterThan(0);
				}
			}
		});

		it("ktlint ships its jar alongside ktlint.bat on win32 (#218)", () => {
			const ktlint = TOOLS.find((t) => t.id === "ktlint");
			expect(ktlint?.github?.extraAssets?.("win32", "x64")).toContain("ktlint");
			// …and not on Unix, where the single `ktlint` asset is self-executable.
			expect(ktlint?.github?.extraAssets?.("linux", "x64") ?? []).toEqual([]);
		});
	});

	// GITHUB_TOOLS is the curated list the asset-matrix value-test iterates. It
	// must mean exactly "github tools with full cross-platform coverage" — drift
	// in either direction leaves a tool's asset selection untested (the bug this
	// guard was written to catch: hadolint/gitleaks/taplo/vale were missing).
	describe("GITHUB_TOOLS ↔ registry sync", () => {
		const githubStrategyIds = new Set(
			TOOLS.filter((t) => t.installStrategy === "github").map((t) => t.id),
		);

		it("every GITHUB_TOOLS id is a real github-strategy tool", () => {
			const bogus = GITHUB_TOOLS.filter((id) => !githubStrategyIds.has(id));
			expect(bogus, `not github-strategy tools: ${bogus.join(", ")}`).toEqual([]);
		});

		it("GITHUB_TOOLS has no duplicates", () => {
			expect(new Set(GITHUB_TOOLS).size).toBe(GITHUB_TOOLS.length);
		});

		it("contains exactly the github tools with full platform/arch coverage", () => {
			const fullMatrix = new Set(
				TOOLS.filter((t) => t.installStrategy === "github" && resolvesFullMatrix(t)).map(
					(t) => t.id,
				),
			);
			const curated = new Set<string>(GITHUB_TOOLS);
			const missing = [...fullMatrix].filter((id) => !curated.has(id));
			const extra = [...curated].filter((id) => !fullMatrix.has(id));
			expect(missing, `full-matrix tools absent from GITHUB_TOOLS: ${missing.join(", ")}`).toEqual([]);
			expect(extra, `GITHUB_TOOLS entries lacking full matrix: ${extra.join(", ")}`).toEqual([]);
		});
	});
});

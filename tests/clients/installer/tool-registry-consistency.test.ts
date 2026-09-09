import { describe, expect, it, vi } from "vitest";
import {
	GITHUB_TOOLS,
	TOOLS,
	getRefreshableManagedTools,
	getToolVerificationTimeout,
} from "../../../clients/installer/index.js";

// Use the real installer module, not any mock another test file registered.
vi.unmock("../../../clients/installer/index.js");

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

	it("uses the Vue-specific cold-start budget without changing the default", () => {
		const vue = TOOLS.find((tool) => tool.id === "@vue/language-server");
		expect(vue).toBeDefined();
		expect(getToolVerificationTimeout(vue!)).toBe(30_000);
		expect(
			getToolVerificationTimeout(TOOLS.find((tool) => tool.id === "pyright")!),
		).toBe(10_000);
	});

	it("carries the Vue timeout into refresh candidates", () => {
		const vue = getRefreshableManagedTools().find(
			(tool) => tool.toolId === "@vue/language-server",
		);
		expect(vue?.verificationTimeoutMs).toBe(30_000);
	});

	it("uses the bash/JSON language-server cold-start budgets (#2194)", () => {
		const bash = TOOLS.find((tool) => tool.id === "bash-language-server");
		const json = TOOLS.find(
			(tool) => tool.id === "vscode-json-language-server",
		);
		expect(bash).toBeDefined();
		expect(json).toBeDefined();
		expect(getToolVerificationTimeout(bash!)).toBe(20_000);
		expect(getToolVerificationTimeout(json!)).toBe(20_000);
	});

	it("uses the Svelte/Prisma language-server cold-start budgets (#2169)", () => {
		const svelte = TOOLS.find((tool) => tool.id === "svelte-language-server");
		const prisma = TOOLS.find((tool) => tool.id === "@prisma/language-server");
		expect(svelte).toBeDefined();
		expect(prisma).toBeDefined();
		expect(getToolVerificationTimeout(svelte!)).toBe(20_000);
		expect(getToolVerificationTimeout(prisma!)).toBe(40_000);
	});

	it("carries the Svelte/Prisma timeouts into refresh candidates (#2169)", () => {
		const refreshable = getRefreshableManagedTools();
		const svelte = refreshable.find(
			(tool) => tool.toolId === "svelte-language-server",
		);
		const prisma = refreshable.find(
			(tool) => tool.toolId === "@prisma/language-server",
		);
		expect(svelte?.verificationTimeoutMs).toBe(20_000);
		expect(prisma?.verificationTimeoutMs).toBe(40_000);
	});

	it("every tool has the required base wiring (id, name, checkCommand, checkArgs, strategy)", () => {
		for (const t of TOOLS) {
			expect(typeof t.id, `id on ${JSON.stringify(t.name)}`).toBe("string");
			expect(t.id.length, "non-empty id").toBeGreaterThan(0);
			expect(typeof t.name, `name on ${t.id}`).toBe("string");
			expect(t.name.length, `non-empty name on ${t.id}`).toBeGreaterThan(0);
			expect(typeof t.checkCommand, `checkCommand on ${t.id}`).toBe("string");
			expect(
				t.checkCommand.length,
				`non-empty checkCommand on ${t.id}`,
			).toBeGreaterThan(0);
			expect(Array.isArray(t.checkArgs), `checkArgs array on ${t.id}`).toBe(
				true,
			);
			for (const arg of t.checkArgs) {
				expect(typeof arg, `checkArgs entry on ${t.id}`).toBe("string");
			}
			expect(
				STRATEGIES.has(t.installStrategy),
				`valid strategy on ${t.id}: ${t.installStrategy}`,
			).toBe(true);
		}
	});

	it("tool ids are globally unique", () => {
		const seen = new Map<string, number>();
		for (const t of TOOLS) seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
		const dupes = [...seen.entries()]
			.filter(([, n]) => n > 1)
			.map(([id]) => id);
		expect(dupes, `duplicate tool ids: ${dupes.join(", ")}`).toEqual([]);
	});

	it("checkCommand and binaryName are clean executable tokens (no path separators/whitespace)", () => {
		for (const t of TOOLS) {
			expect(
				isCleanToken(t.checkCommand),
				`${t.id} checkCommand "${t.checkCommand}"`,
			).toBe(true);
			if (t.binaryName !== undefined) {
				expect(
					isCleanToken(t.binaryName),
					`${t.id} binaryName "${t.binaryName}"`,
				).toBe(true);
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
				expect(
					t.github,
					`${t.id} should not carry a github spec`,
				).toBeUndefined();
			}
		});

		it("pip/gem tools declare packageName and no github spec", () => {
			for (const t of TOOLS.filter(
				(x) => x.installStrategy === "pip" || x.installStrategy === "gem",
			)) {
				expect(t.packageName, `${t.id} packageName`).toBeTruthy();
				expect(
					t.github,
					`${t.id} should not carry a github spec`,
				).toBeUndefined();
			}
		});

		it("github tools declare a github spec (owner/repo + assetMatch), binaryName, and no packageName", () => {
			for (const t of TOOLS.filter((x) => x.installStrategy === "github")) {
				expect(t.github, `${t.id} github spec`).toBeDefined();
				expect(typeof t.github?.assetMatch, `${t.id} assetMatch fn`).toBe(
					"function",
				);
				expect(t.github?.repo, `${t.id} repo "owner/repo"`).toMatch(
					/^[\w.-]+\/[\w.-]+$/,
				);
				expect(t.binaryName, `${t.id} binaryName`).toBeTruthy();
				expect(
					t.packageName,
					`${t.id} github tool should not carry packageName`,
				).toBeUndefined();
			}
		});

		it("maven tools declare a maven spec (groupId/artifactId/version) + binaryName, no packageName/github", () => {
			for (const t of TOOLS.filter((x) => x.installStrategy === "maven")) {
				expect(t.maven, `${t.id} maven spec`).toBeDefined();
				expect(t.maven?.groupId, `${t.id} groupId`).toMatch(/^[\w.-]+$/);
				expect(t.maven?.artifactId, `${t.id} artifactId`).toMatch(/^[\w.-]+$/);
				expect(t.maven?.version, `${t.id} pinned version`).toMatch(
					/^[\w.+-]+$/,
				);
				expect(t.binaryName, `${t.id} binaryName`).toBeTruthy();
				expect(
					t.packageName,
					`${t.id} maven tool should not carry packageName`,
				).toBeUndefined();
				expect(
					t.github,
					`${t.id} maven tool should not carry a github spec`,
				).toBeUndefined();
			}
		});

		it("archive tools declare an archive spec (https url|resolver + kind + launcher OR tree-bundle marker) + binaryName, no packageName/github/maven", () => {
			// relative path inside the archive — no leading slash / drive letter.
			const relPath = /^[\w.-]+(\/[\w.-]+)*$/;
			// Probe a representative platform/arch matrix; a resolver must yield an
			// https URL for at least one (else the tool is uninstallable everywhere),
			// and every URL it DOES yield must be https.
			const PROBE: Array<[string, string]> = [
				["linux", "x64"],
				["darwin", "arm64"],
				["win32", "x64"],
			];
			for (const t of TOOLS.filter((x) => x.installStrategy === "archive")) {
				expect(t.archive, `${t.id} archive spec`).toBeDefined();
				const spec = t.archive!;
				if (typeof spec.url === "function") {
					const resolve = spec.url;
					const resolved = PROBE.map(([p, a]) => resolve(p, a)).filter(
						(u): u is string => Boolean(u),
					);
					expect(
						resolved.length,
						`${t.id} archive url resolver yields nothing on any probed platform`,
					).toBeGreaterThan(0);
					for (const u of resolved)
						expect(u, `${t.id} archive url`).toMatch(/^https:\/\//);
				} else {
					expect(spec.url, `${t.id} archive url`).toMatch(/^https:\/\//);
				}
				expect(["tgz", "zip"], `${t.id} archive kind`).toContain(spec.kind);
				if (spec.launcher !== undefined) {
					// Launcher-style archive (a single binary/shim inside the tree).
					expect(spec.launcher, `${t.id} launcher`).toMatch(relPath);
				} else {
					// Tree bundle: no launcher → must declare a treeMarker (existence
					// check). stripComponents must be explicit: 0 for a no-wrapping-dir
					// bundle (PSES), ≥1 to drop a version dir (clangd's clangd_<ver>/).
					expect(spec.treeMarker, `${t.id} treeMarker (tree bundle)`).toMatch(
						relPath,
					);
					expect(
						typeof spec.stripComponents,
						`${t.id} tree bundle must set stripComponents explicitly`,
					).toBe("number");
				}
				expect(t.binaryName, `${t.id} binaryName`).toBeTruthy();
				expect(
					t.packageName,
					`${t.id} archive tool should not carry packageName`,
				).toBeUndefined();
				expect(
					t.github,
					`${t.id} archive tool should not carry a github spec`,
				).toBeUndefined();
				expect(
					t.maven,
					`${t.id} archive tool should not carry a maven spec`,
				).toBeUndefined();
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
				expect(
					supported,
					`${t.id} resolves no asset on any supported platform`,
				).toBe(true);
			}
		});

		it("rejects unsupported platforms", () => {
			for (const t of githubTools) {
				for (const platform of UNSUPPORTED_PLATFORMS) {
					expect(
						t.github?.assetMatch(platform, "x64"),
						`${t.id} ${platform}`,
					).toBeUndefined();
				}
			}
		});

		// #218: a .bat/.cmd wrapper asset runs a sibling file (e.g. ktlint.bat →
		// `java -jar %~dp0ktlint`), so the wrapper alone is useless — the tool MUST
		// declare extraAssets to fetch the dependency alongside it.
		it("github tools whose win32 asset is a .bat/.cmd wrapper declare extraAssets", () => {
			for (const t of githubTools) {
				const winAsset = ARCHES.map((a) =>
					t.github?.assetMatch("win32", a),
				).find((x): x is string => typeof x === "string");
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
			expect(bogus, `not github-strategy tools: ${bogus.join(", ")}`).toEqual(
				[],
			);
		});

		it("GITHUB_TOOLS has no duplicates", () => {
			expect(new Set(GITHUB_TOOLS).size).toBe(GITHUB_TOOLS.length);
		});

		it("contains exactly the github tools with full platform/arch coverage", () => {
			const fullMatrix = new Set(
				TOOLS.filter(
					(t) => t.installStrategy === "github" && resolvesFullMatrix(t),
				).map((t) => t.id),
			);
			const curated = new Set<string>(GITHUB_TOOLS);
			const missing = [...fullMatrix].filter((id) => !curated.has(id));
			const extra = [...curated].filter((id) => !fullMatrix.has(id));
			expect(
				missing,
				`full-matrix tools absent from GITHUB_TOOLS: ${missing.join(", ")}`,
			).toEqual([]);
			expect(
				extra,
				`GITHUB_TOOLS entries lacking full matrix: ${extra.join(", ")}`,
			).toEqual([]);
		});
	});

	// #2661 review round 2 (R2-F4): a literal-equality assertion on
	// `pipCommandCandidates()`'s return value is a source-text mirror — it
	// reds only if someone edits the array, proving nothing about whether the
	// ladder actually WORKS on a runner missing a candidate. Deleted in favor
	// of the behavioral coverage in `tests/scripts/smoke-tools-genuine-
	// install-failure.test.ts` (the R2-F2 python-without-pip case), which
	// exercises what this list is FOR — telling a real absent-toolchain
	// runner from a present one — rather than restating its contents.
});

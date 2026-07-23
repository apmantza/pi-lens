/**
 * Track B (#775) item 5 — nested ignore/config.
 *
 * Two halves:
 *
 *  1. Root `.gitignore` excluding `**\/generated` PLUS a package-local
 *     `.gitignore` excluding a package-local pattern are BOTH honored by the
 *     project ignore matcher (pins the audit's "already monorepo-correct"
 *     finding 12 — `file-utils.ts`'s nested-.gitignore layering).
 *
 *  2. A nested `.pi-lens.json` INSIDE a package, with the repo root ALSO
 *     having one — audit open question 13, empirically resolved here:
 *     pi-lens has TWO independent `.pi-lens.json` discovery paths that do not
 *     agree:
 *       - `getProjectScaleBase(cwd)` / `getProjectIgnoreMatcher`'s companion
 *         `loadPiLensProjectConfig` call for `maxProjectFiles` walks up from
 *         whatever `cwd` a subsystem is given (`project-lens-config.ts`'s
 *         `walkUpDirs`) — so when a subsystem is invoked with a
 *         PACKAGE-scoped cwd (e.g. a session started in `packages/a`, #775
 *         item 4), the PACKAGE-LOCAL `.pi-lens.json` wins, because discovery
 *         starts there and stops at the first match.
 *       - `getProjectIgnoreMatcher(rootDir)` (the walk-wide ignore matcher
 *         used by every scanner) ALWAYS re-anchors its root to the nearest
 *         `.git` via `resolveGitIgnoreRoot` BEFORE loading `.pi-lens.json` —
 *         so its `ignore`/`rules` fields are read starting from the GIT ROOT,
 *         regardless of which `cwd` a subsystem was given. A package-local
 *         `.pi-lens.json`'s `ignore` field is therefore NEVER consulted by
 *         the ignore matcher — only the repo-root one is, even for files
 *         deep inside that same package.
 *     Net effect: "which `.pi-lens.json` wins" depends on WHICH FIELD and
 *     WHICH SUBSYSTEM — `maxProjectFiles` can be package-scoped,
 *     `ignore`/`rules` cannot. This is subtle and almost certainly NOT what a
 *     user authoring a package-local `.pi-lens.json` for its `ignore` field
 *     would expect (they'd expect it to affect files in that package) — so
 *     the `ignore`/`rules` half is marked KNOWN GAP below, not a "matches
 *     expectation" pin.
 */

import { describe, expect, it } from "vitest";
import { getProjectIgnoreMatcher } from "../../clients/file-utils.js";
import {
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import { getProjectScaleBase } from "../../clients/project-scale.js";
import { makeMonorepo, type MonorepoPackageSpec } from "./fixture.js";

describe("nested .gitignore + .pi-lens.json layering in a monorepo (#775 item 5)", () => {
	it("root .gitignore (**/generated) AND a package-local .gitignore pattern are both honored", () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: {
				"generated/root-excluded.ts": "export const x = 1;\n",
				"src/keep.ts": "export const keep = 1;\n",
				"local-secret.ts": "export const secret = 1;\n",
			},
			gitignore: ["local-secret.ts"],
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootGitignore: ["**/generated"],
		});
		try {
			const matcher = getProjectIgnoreMatcher(repo.root);
			// Directory-level check: real walkers (shouldRecurseIntoDir) test the
			// DIRECTORY itself with isDirectory=true before ever recursing into
			// it — that's how a non-"/**"-suffixed pattern like "**/generated"
			// excludes an entire subtree without matching every file inside it.
			expect(
				matcher.isIgnored(
					repo.filePath("@scope/a", "generated"),
					true,
				),
			).toBe(true);
			expect(
				matcher.isIgnored(repo.filePath("@scope/a", "local-secret.ts"), false),
			).toBe(true);
			// A file that matches neither pattern stays un-ignored.
			expect(
				matcher.isIgnored(repo.filePath("@scope/a", "src/keep.ts"), false),
			).toBe(false);
		} finally {
			repo.cleanup();
		}
	});

	describe("nested .pi-lens.json vs. root .pi-lens.json (audit open question 13)", () => {
		it("maxProjectFiles: a PACKAGE-scoped cwd sees the package-local override, not the root's", () => {
			const pkg: MonorepoPackageSpec = {
				name: "@scope/a",
				dir: "packages/a",
				files: { "src/index.ts": "export const a = 1;\n" },
				piLensConfig: { maxProjectFiles: 111 },
			};
			const repo = makeMonorepo({
				packages: [pkg],
				rootPiLensConfig: { maxProjectFiles: 999 },
			});
			try {
				resetProjectLensConfigCache();
				const packageDir = repo.packageDir("@scope/a");
				expect(getProjectScaleBase(packageDir)).toBe(111);
				expect(getProjectScaleBase(repo.root)).toBe(999);
			} finally {
				resetProjectLensConfigCache();
				repo.cleanup();
			}
		});

		it(
			"KNOWN GAP (#775): a package-local .pi-lens.json's `ignore` field is NEVER consulted — the ignore matcher always re-anchors to the git root first, so only the ROOT .pi-lens.json's ignore patterns ever apply, even to files inside the package that defines its own",
			() => {
				const pkg: MonorepoPackageSpec = {
					name: "@scope/a",
					dir: "packages/a",
					files: {
						"src/package-local-ignored.ts": "export const x = 1;\n",
						"src/root-ignored.ts": "export const y = 1;\n",
					},
					// This package asks pi-lens to ignore its own generated-ish file...
					piLensConfig: { ignore: ["src/package-local-ignored.ts"] },
				};
				const repo = makeMonorepo({
					packages: [pkg],
					// ...and the root asks for a DIFFERENT file to be ignored.
					rootPiLensConfig: { ignore: ["packages/a/src/root-ignored.ts"] },
				});
				try {
					resetProjectLensConfigCache();
					const matcher = getProjectIgnoreMatcher(repo.root);
					// The root's ignore rule reaches into the package fine...
					expect(
						matcher.isIgnored(
							repo.filePath("@scope/a", "src/root-ignored.ts"),
							false,
						),
					).toBe(true);
					// ...but the package's OWN .pi-lens.json ignore rule for a file
					// inside itself is silently never applied — not what a user
					// authoring a package-local ignore rule would expect.
					expect(
						matcher.isIgnored(
							repo.filePath("@scope/a", "src/package-local-ignored.ts"),
							false,
						),
					).toBe(false);
				} finally {
					resetProjectLensConfigCache();
					repo.cleanup();
				}
			},
		);
	});
});

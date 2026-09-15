/**
 * Monorepo flat-config discovery (#3017, defect shape 39).
 *
 * A walk-up result was answering package ownership instead of configuration
 * eligibility: `hasEslintConfig`/`hasOxlintConfig` stopped at the nearest
 * `package.json`, so a repo-root `eslint.config.mjs` was invisible from
 * inside a nested workspace package and the whole jsts lint lane fell
 * through to biome's smart default. Flat configs now mirror ESLint's own
 * ancestor discovery while legacy `.eslintrc.*` / `package.json#eslintConfig`
 * keep per-package semantics.
 *
 * Every case enters through production seams on a real filesystem fixture:
 * the detectors, `getJstsLintPolicyForCwd`, and the real `biome-check`
 * runner (its defer branch returns before any spawn, so no binary is
 * needed). The `.mjs` row covers the non-TypeScript (`javascript` in
 * `clients/language-registry.ts`) side of this language-neutral seam.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import biomeRunner from "../../../../clients/dispatch/runners/biome-check.js";
import {
	getJstsLintPolicyForCwd,
	getPreferredJstsLintRunners,
	hasEslintConfig,
	hasOxlintConfig,
} from "../../../../clients/tool-policy.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { createTempFile, setupTestEnvironment } from "../../test-utils.js";

const FLAT_CONFIG_NAMES = [
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
	"eslint.config.mts",
	"eslint.config.cts",
];

function makeMonorepo(fileName: string): {
	env: { tmpDir: string; cleanup: () => void };
	filePath: string;
	pkgDir: string;
} {
	const env = setupTestEnvironment("pi-lens-3017-monorepo-");
	createTempFile(env.tmpDir, "package.json", JSON.stringify({ name: "root" }));
	createTempFile(
		env.tmpDir,
		"packages/pkg/package.json",
		JSON.stringify({ name: "pkg" }),
	);
	const filePath = createTempFile(
		env.tmpDir,
		path.join("packages/pkg/scripts", fileName),
		"const x = 1;\nconsole.log(x);\n",
	);
	return { env, filePath, pkgDir: path.dirname(filePath) };
}

describe("monorepo flat-config discovery (#3017)", () => {
	it.each(FLAT_CONFIG_NAMES)(
		"root %s is visible from inside a nested package",
		(configName) => {
			const { env, pkgDir } = makeMonorepo("file.ts");
			try {
				createTempFile(env.tmpDir, configName, "export default [];\n");
				expect(hasEslintConfig(pkgDir)).toBe(true);
			} finally {
				env.cleanup();
			}
		},
	);

	// `file.ts` is the `typescript` registry row, `file.mjs` the
	// non-TypeScript `javascript` row (clients/language-registry.ts).
	it.each(["file.ts", "file.mjs"])(
		"root eslint.config.mjs defers biome with a machine-readable reason (%s)",
		async (fileName) => {
			const { env, filePath, pkgDir } = makeMonorepo(fileName);
			try {
				createTempFile(env.tmpDir, "eslint.config.mjs", "export default [];\n");
				// The eslint runner gate: a config is detected, so eslint runs.
				expect(hasEslintConfig(pkgDir)).toBe(true);
				const policy = getJstsLintPolicyForCwd(pkgDir);
				expect(policy.hasExplicitNonBiomeLinter).toBe(true);
				expect(
					getPreferredJstsLintRunners({
						hasEslintConfig: policy.hasEslintConfig,
						hasOxlintConfig: policy.hasOxlintConfig,
						hasBiomeConfig: policy.hasBiomeConfig,
					}),
				).toEqual(["eslint"]);
				// The real biome runner defers before any spawn.
				const result = await biomeRunner.run(
					makeRunnerCtx(filePath, pkgDir) as never,
				);
				expect(result.status).toBe("skipped");
				expect(result.skipReason).toBe("configured-non-biome-linter");
			} finally {
				env.cleanup();
			}
		},
	);

	it("root .oxlintrc.json is visible from inside a nested package", async () => {
		const { env, filePath, pkgDir } = makeMonorepo("file.ts");
		try {
			createTempFile(env.tmpDir, ".oxlintrc.json", "{}\n");
			expect(hasOxlintConfig(pkgDir)).toBe(true);
			const policy = getJstsLintPolicyForCwd(pkgDir);
			expect(policy.hasExplicitNonBiomeLinter).toBe(true);
			expect(policy.preferredRunners).toEqual(["oxlint"]);
			const result = await biomeRunner.run(
				makeRunnerCtx(filePath, pkgDir) as never,
			);
			expect(result.status).toBe("skipped");
			expect(result.skipReason).toBe("configured-non-biome-linter");
		} finally {
			env.cleanup();
		}
	});

	it("legacy root .eslintrc stays per-package behind a nested package.json", () => {
		const { env, pkgDir } = makeMonorepo("file.ts");
		try {
			createTempFile(env.tmpDir, ".eslintrc.json", "{}\n");
			expect(hasEslintConfig(pkgDir)).toBe(false);
			expect(getJstsLintPolicyForCwd(pkgDir).hasExplicitNonBiomeLinter).toBe(
				false,
			);
		} finally {
			env.cleanup();
		}
	});

	it("legacy root package.json eslintConfig stays per-package behind a nested package.json", () => {
		const { env, pkgDir } = makeMonorepo("file.ts");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ name: "root", eslintConfig: { rules: {} } }),
			);
			expect(hasEslintConfig(pkgDir)).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

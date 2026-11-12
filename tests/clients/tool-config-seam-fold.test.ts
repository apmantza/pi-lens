/**
 * #5408 slice 2: the twelve policy-owned config finders now ask
 * `clients/tool-config-presence.ts`. Each cell below drives the PRODUCTION
 * caller (the policy, the args builder, the runner), never a hand-shaped input.
 *
 * Recurrence these cells name: `tool-policy.ts` climbed to the filesystem root
 * for eslint, biome, stylelint, golangci-lint, phpstan, markdownlint, Vite+ and
 * the Java build descriptor, while the seam stops at `$HOME` (#5408 divergence
 * 3, the tflint shape). A config file ABOVE `$HOME` is never project config; the
 * seam's answer is the right one (acceptance: "never `$HOME` by accident").
 * A second cell family names the substring shape: a `vite.config.*` that only
 * MENTIONED `vite-plus` in a comment selected the Vite+ binaries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchLintDetailed } from "../../clients/dispatch/integration.js";
import {
	biomeConfigArgs,
	getJstsLintPolicyForCwd,
	getLinterPolicyForCwd,
	markdownlintConfigArgs,
} from "../../clients/tool-policy.js";
import { makeRunnerCtx } from "../support/runner-ctx.js";
import { pinFixtureHome } from "./test-utils.js";

const { safeSpawn, safeSpawnAsync } = vi.hoisted(() => ({
	safeSpawn: vi.fn(),
	safeSpawnAsync: vi.fn(),
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawn,
	safeSpawnAsync,
}));

function write(file: string, content = ""): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/**
 * Whether the oxlint runner probed the Vite+ `vp` binary: it does so exactly
 * when `hasToolConfig("vitePlus", cwd)` holds (`oxlint.ts`). The policy's own
 * `getJstsLintPolicyForCwd` cannot be the witness: its oxlint answer also
 * covers `.oxlintrc.json`, so it does not isolate the Vite+ branch.
 */
async function probesVp(proj: string): Promise<boolean> {
	safeSpawnAsync.mockResolvedValue({
		error: new Error("not found"),
		status: 1,
		stdout: "",
		stderr: "",
	});
	const file = write(path.join(proj, "src", "a.ts"), "export {};\n");
	const mod = await import("../../clients/dispatch/runners/oxlint.js");
	await mod.default.run(makeRunnerCtx(file, proj, { kind: "jsts" }) as never);
	return safeSpawnAsync.mock.calls.some(
		([cmd, args]) => cmd === "vp" && (args as string[])[0] === "--version",
	);
}

/** `$HOME` pinned; the project lives under it; `above` is the directory over `$HOME`. */
function layout(slug: string) {
	const { home } = pinFixtureHome(slug);
	const proj = path.join(home, "proj");
	fs.mkdirSync(proj, { recursive: true });
	return { home, proj, above: path.dirname(home) };
}

const planted: string[] = [];
function plant(file: string, content = ""): string {
	planted.push(file);
	return write(file, content);
}
afterEach(() => {
	for (const file of planted.splice(0)) fs.rmSync(file, { force: true });
	safeSpawn.mockReset();
	safeSpawnAsync.mockReset();
});

describe("a config file above $HOME is not project config (#5408 divergence 3 shape)", () => {
	it.each([
		["eslint flat config", "eslint.config.js", "export default [];\n"],
		["eslint legacy config", ".eslintrc.json", "{}\n"],
		[
			"eslint package.json#eslintConfig",
			"package.json",
			JSON.stringify({ eslintConfig: { rules: {} } }),
		],
	])(
		"%s: the JS/TS lint policy reports eslint unconfigured",
		(_n, file, text) => {
			const { proj, above } = layout("5408-s2-eslint");
			plant(path.join(above, file), text);
			expect(getJstsLintPolicyForCwd(proj).hasEslintConfig).toBe(false);
		},
	);

	it("biome.json: the policy reports biome unconfigured and the args builder hands biome the package config", () => {
		const { proj, above } = layout("5408-s2-biome");
		plant(path.join(above, "biome.json"), "{}\n");
		expect(getJstsLintPolicyForCwd(proj).hasBiomeConfig).toBe(false);
		expect(biomeConfigArgs(proj)).toEqual([
			expect.stringMatching(/^--config-path=.*core\.jsonc$/),
		]);
	});

	it("vite-plus.json: oxlint does not switch to vp for a Vite+ file over $HOME", async () => {
		const { proj, above } = layout("5408-s2-viteplus");
		plant(path.join(above, "vite-plus.json"), "{}\n");
		expect(await probesVp(proj)).toBe(false);
	});

	it.each([
		["golangci-lint", ".golangci.yml", "a.go"],
		["phpstan", "phpstan.neon", "a.php"],
	])("%s: the linter policy does not prefer it", (runner, config, file) => {
		const { proj, above } = layout(`5408-s2-${runner}`);
		plant(path.join(above, config));
		expect(
			getLinterPolicyForCwd(path.join(proj, file), proj)?.preferredRunners,
		).toEqual([]);
		expect(runner).toMatch(/golangci-lint|phpstan/);
	});

	it("markdownlint: the args builder hands markdownlint the package config", () => {
		const { proj, above } = layout("5408-s2-markdownlint");
		plant(path.join(above, ".markdownlint.json"), "{}\n");
		expect(markdownlintConfigArgs(proj)).toEqual([
			"--config",
			expect.stringMatching(/core\.json$/),
		]);
	});

	it("stylelint: the runner says no config was detected", async () => {
		const { proj, above } = layout("5408-s2-stylelint");
		plant(path.join(above, ".stylelintrc.json"), "{}\n");
		const file = write(path.join(proj, "a.css"), "a { color: red; }\n");
		safeSpawn.mockReturnValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "[]",
			stderr: "",
		});
		const logs: string[] = [];
		const mod = await import("../../clients/dispatch/runners/stylelint.js");
		await mod.default.run(
			makeRunnerCtx(file, proj, {
				kind: "css",
				log: (m: string) => logs.push(String(m)),
			}) as never,
		);
		expect(logs.join("\n")).toContain("stylelint: no config detected");
	});

	it("Java build descriptor: SpotBugs is not scheduled for a pom.xml over $HOME", async () => {
		const { proj, above } = layout("5408-s2-java");
		plant(path.join(above, "pom.xml"), "<project/>\n");
		write(path.join(proj, "target", "classes", "Foo.class"), "x");
		const file = write(path.join(proj, "src", "Foo.java"), "class Foo {}\n");
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});
		const { runners } = await dispatchLintDetailed(
			file,
			proj,
			{
				getFlag: (name: string) =>
					name === "lens-spotbugs" || name === "no-lsp",
			},
			{ blockingOnly: false },
		);
		expect(runners.map((r) => r.runnerId)).not.toContain("spotbugs");
	}, 30_000);
});

describe("Vite+ is a declared import or dependency, never a mention (#5408 acceptance 4)", () => {
	const viteConfig = (text: string) => {
		const { proj } = layout("5408-s2-vite-config");
		write(path.join(proj, "vite.config.ts"), text);
		return proj;
	};

	it.each([
		[
			"a line comment",
			'// import { defineConfig } from "vite-plus";\nexport default {};\n',
		],
		[
			"a block comment",
			'/*\nimport { defineConfig } from "vite-plus";\n*/\nexport default {};\n',
		],
		["a prose mention", "// TODO: migrate to vite-plus\nexport default {};\n"],
		[
			"a look-alike package",
			'import { x } from "vite-plus-extras";\nexport default {};\n',
		],
	])("%s does not select it", async (_n, text) => {
		expect(await probesVp(viteConfig(text))).toBe(false);
	});

	it.each([
		[
			"an import",
			'import { defineConfig } from "vite-plus";\nexport default defineConfig({});\n',
		],
		[
			"a subpath import",
			"import { defineConfig } from 'vite-plus/config';\nexport default defineConfig({});\n",
		],
		["a side-effect import", 'import "vite-plus";\nexport default {};\n'],
		[
			"an import of the core package (#5408 F1: master selected it)",
			'import { defineConfig } from "@voidzero-dev/vite-plus-core";\nexport default defineConfig({});\n',
		],
		[
			"require",
			'const { defineConfig } = require("vite-plus");\nmodule.exports = defineConfig({});\n',
		],
		[
			"a dynamic import",
			'const m = await import("vite-plus");\nexport default m;\n',
		],
	])("%s selects it", async (_n, text) => {
		expect(await probesVp(viteConfig(text))).toBe(true);
	});
});

describe("forms the old finders admitted keep their answer (pins)", () => {
	it("package.json#stylelint is stylelint config", async () => {
		const { proj } = layout("5408-s2-stylelint-field");
		write(path.join(proj, "package.json"), JSON.stringify({ stylelint: {} }));
		const file = write(path.join(proj, "a.css"), "a { color: red; }\n");
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "[]",
			stderr: "",
		});
		const logs: string[] = [];
		const mod = await import("../../clients/dispatch/runners/stylelint.js");
		await mod.default.run(
			makeRunnerCtx(file, proj, {
				kind: "css",
				log: (m: string) => logs.push(String(m)),
			}) as never,
		);
		expect(logs.join("\n")).not.toContain("no config detected");
	});

	it("a Vite+ devDependency selects oxlint", async () => {
		const { proj } = layout("5408-s2-vite-dep");
		write(
			path.join(proj, "package.json"),
			JSON.stringify({ devDependencies: { "vite-plus": "^0.1.0" } }),
		);
		expect(await probesVp(proj)).toBe(true);
	});
});

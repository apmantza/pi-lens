/**
 * #5408: the config-presence seam (`clients/tool-config-presence.ts`).
 *
 * Recurrence these cells name: `tool-policy.ts` matched `black` anywhere in a
 * requirements file and `[tool.ruff]` anywhere in a pyproject (a comment
 * counted). The divergence cells that drive the real callers are in
 * `dispatch/runners/config-presence-divergence.test.ts`; this file pins what
 * the seam reads and its one stop rule.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	findToolConfig,
	hasToolConfig,
	type ToolConfigId,
} from "../../clients/tool-config-presence.js";
import { pinFixtureHome, setupTestEnvironment } from "./test-utils.js";

function write(file: string, content = ""): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/** One fixture dir per cell; the callback gets its path. */
function withDir<T>(fn: (dir: string) => T): T {
	const env = setupTestEnvironment("pi-lens-5408-presence-");
	try {
		return fn(env.tmpDir);
	} finally {
		env.cleanup();
	}
}

function configured(
	tool: ToolConfigId,
	files: Record<string, string>,
): boolean {
	return withDir((dir) => {
		for (const [name, content] of Object.entries(files)) {
			write(path.join(dir, name), content);
		}
		return hasToolConfig(tool, dir, { homeDir: path.join(dir, "no-home") });
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("tool-config-presence: what counts as config", () => {
	it("reads a requirements entry by name, not by substring", () => {
		expect(configured("black", { "requirements.txt": "black==24.2.0\n" })).toBe(
			true,
		);
		expect(
			configured("black", {
				"requirements.txt": "Black[jupyter]>=23 ; python_version>'3.8'\n",
			}),
		).toBe(true);
		expect(
			configured("black", {
				"requirements.txt": "flake8-black\npytest-black\n",
			}),
		).toBe(false);
		expect(
			configured("black", { "requirements.txt": "# black\n  # black==1\n" }),
		).toBe(false);
		expect(
			configured("black", {
				"requirements.txt": "-r base.txt\n--index-url https://black.example/\n",
			}),
		).toBe(false);
		expect(
			configured("black", {
				"requirements.txt": "mypkg @ https://example.com/black.tar.gz\n",
			}),
		).toBe(false);
	});

	it("reads Pipfile package tables by key", () => {
		expect(
			configured("black", {
				Pipfile: '[packages]\nrequests = "*"\n[dev-packages]\nblack = "*"\n',
			}),
		).toBe(true);
		expect(
			configured("black", { Pipfile: '[dev-packages]\nflake8-black = "*"\n' }),
		).toBe(false);
		expect(
			configured("black", { Pipfile: '[dev-packages]\n# black = "*"\n' }),
		).toBe(false);
		expect(
			configured("black", { Pipfile: '[scripts]\nblack = "black ."\n' }),
		).toBe(false);
	});

	it("reads pyproject dependency tables for sqlfluff and yamllint", () => {
		expect(
			configured("sqlfluff", {
				"pyproject.toml":
					'[project]\nname = "app"\ndependencies = [\n  "requests",\n  "sqlfluff>=3.0",\n]\n',
			}),
		).toBe(true);
		expect(
			configured("sqlfluff", {
				"pyproject.toml": '[dependency-groups]\ndev = ["sqlfluff"]\n',
			}),
		).toBe(true);
		expect(
			configured("sqlfluff", {
				"pyproject.toml":
					'[tool.poetry.group.dev.dependencies]\nsqlfluff = "^3"\n',
			}),
		).toBe(true);
		expect(
			configured("yamllint", {
				"pyproject.toml":
					'[project.optional-dependencies]\nlint = ["yamllint==1.35"]\n',
			}),
		).toBe(true);
		// A project named like the tool, a commented entry, a look-alike, an
		// unrelated table.
		expect(
			configured("sqlfluff", {
				"pyproject.toml":
					'[project]\nname = "sqlfluff"\ndependencies = ["requests"]\n',
			}),
		).toBe(false);
		expect(
			configured("sqlfluff", {
				"pyproject.toml":
					'[project]\ndependencies = [\n  # "sqlfluff",\n  "requests",\n]\n',
			}),
		).toBe(false);
		expect(
			configured("sqlfluff", {
				"pyproject.toml":
					'[project]\ndependencies = ["sqlfluff-templater-dbt"]\n',
			}),
		).toBe(false);
		expect(
			configured("sqlfluff", {
				"pyproject.toml": '[tool.other]\nexclude = ["sqlfluff"]\n',
			}),
		).toBe(false);
		expect(
			configured("sqlfluff", {
				"requirements.txt": "sqlfluff-templater-dbt==1.0\n",
			}),
		).toBe(false);
		expect(
			configured("sqlfluff", { "requirements.txt": "sqlfluff==3.1\n" }),
		).toBe(true);
	});

	it("reads ini sections at line starts only", () => {
		expect(
			configured("sqlfluff", { "setup.cfg": "[sqlfluff]\ndialect = ansi\n" }),
		).toBe(true);
		expect(configured("sqlfluff", { "tox.ini": "[sqlfluff]\n" })).toBe(true);
		expect(
			configured("sqlfluff", {
				"setup.cfg": "; [sqlfluff]\n# [sqlfluff]\n[flake8]\n",
			}),
		).toBe(false);
		expect(configured("mypy", { "setup.cfg": "[mypy]\nstrict = True\n" })).toBe(
			true,
		);
		expect(configured("mypy", { "setup.cfg": "# [mypy]\n" })).toBe(false);
		expect(configured("yamllint", { "tox.ini": "[yamllint]\n" })).toBe(true);
	});

	it("reads toml tables, commented headings excluded", () => {
		expect(
			configured("mypy", { "pyproject.toml": "[tool.mypy]\nstrict = true\n" }),
		).toBe(true);
		expect(configured("mypy", { "pyproject.toml": "# [tool.mypy]\n" })).toBe(
			false,
		);
		expect(
			configured("sqlfluff", {
				"pyproject.toml": "[tool.sqlfluff]\ndialect='ansi'\n",
			}),
		).toBe(true);
		expect(
			configured("yamllint", { "pyproject.toml": "[tool.yamllint]\n" }),
		).toBe(true);
		expect(configured("ruff", { "ruff.toml": "" })).toBe(true);
		expect(configured("ruff", { ".ruff.toml": "" })).toBe(true);
	});

	it("takes file-presence tools by every spelling the tool reads", () => {
		for (const name of [
			"detekt.yml",
			".detekt.yml",
			"config/detekt/detekt.yml",
			"detekt/detekt.yml",
		]) {
			expect(configured("detekt", { [name]: "" }), name).toBe(true);
		}
		expect(configured("detekt", { "config/detekt.yml": "" })).toBe(false);
		expect(configured("tflint", { ".tflint.hcl": "" })).toBe(true);
		expect(configured("tflint", { "tflint.hcl": "" })).toBe(false);
		expect(configured("mix", { "mix.exs": "" })).toBe(true);
		expect(configured("editorconfig", { ".editorconfig": "" })).toBe(true);
	});
});

describe("tool-config-presence: package.json, imports, the package boundary (#5408 slice 2)", () => {
	// Recurrence: `tool-policy.ts` read `package.json#eslintConfig`,
	// `package.json#stylelint`, a `vite-plus` dependency and any
	// `vite.config.*` that contained the text `vite-plus` (a comment counted),
	// each in its own finder.
	it("reads a package.json field only when it holds a value", () => {
		expect(
			configured("stylelint", {
				"package.json": JSON.stringify({ stylelint: { rules: {} } }),
			}),
		).toBe(true);
		expect(
			configured("stylelint", {
				"package.json": JSON.stringify({ name: "x" }),
			}),
		).toBe(false);
		expect(
			configured("stylelint", {
				"package.json": JSON.stringify({ stylelint: null }),
			}),
		).toBe(false);
		// An unparseable or non-object package.json is no evidence, never a throw.
		expect(configured("stylelint", { "package.json": "{ stylelint" })).toBe(
			false,
		);
		expect(configured("stylelint", { "package.json": "null" })).toBe(false);
	});

	it("reads a package.json dependency by exact name, in either group", () => {
		const pkg = (deps: Record<string, string>, group = "devDependencies") =>
			JSON.stringify({ [group]: deps });
		expect(
			configured("vitePlus", {
				"package.json": pkg({ "vite-plus": "^0.1.0" }),
			}),
		).toBe(true);
		expect(
			configured("vitePlus", {
				"package.json": pkg(
					{ "@voidzero-dev/vite-plus-core": "1" },
					"dependencies",
				),
			}),
		).toBe(true);
		for (const lookalike of ["vite-plus-extras", "vite_plus", "Vite-Plus"]) {
			expect(
				configured("vitePlus", { "package.json": pkg({ [lookalike]: "1" }) }),
				lookalike,
			).toBe(false);
		}
		expect(
			configured("vitePlus", { "package.json": pkg({ "vite-plus": "" }) }),
		).toBe(false);
	});

	it("reads an import of the tool's package from a Vite config, never a mention", () => {
		const viteConfig = (text: string, name = "vite.config.ts") =>
			configured("vitePlus", { [name]: text });
		expect(viteConfig('import { defineConfig } from "vite-plus";\n')).toBe(
			true,
		);
		expect(
			viteConfig("import x from 'vite-plus/config';\n", "vite.config.mjs"),
		).toBe(true);
		expect(viteConfig('import "vite-plus";\n')).toBe(true);
		expect(
			viteConfig('const v = require("vite-plus");\n', "vite.config.cjs"),
		).toBe(true);
		expect(viteConfig('const v = await import("vite-plus");\n')).toBe(true);
		expect(viteConfig('// import x from "vite-plus";\n')).toBe(false);
		expect(viteConfig('/* import x from "vite-plus"; */\n')).toBe(false);
		expect(
			viteConfig('/*\n * require("vite-plus")\n */\nexport default {};\n'),
		).toBe(false);
		expect(viteConfig('import x from "vite-plus-extras";\n')).toBe(false);
		expect(viteConfig('import x from "my-vite-plus";\n')).toBe(false);
		expect(viteConfig('export default { name: "vite-plus" };\n')).toBe(false);
		// A comment marker inside a string does not hide the import after it.
		expect(
			viteConfig('const u = "http://x"; import y from "vite-plus";\n'),
		).toBe(true);
	});

	it("honours legacy ESLint config only up to the nearest package.json", () => {
		withDir((root) => {
			const home = path.join(root, "no-home");
			const pkgDir = path.join(root, "packages", "app");
			const start = path.join(pkgDir, "src");
			fs.mkdirSync(start, { recursive: true });
			write(path.join(root, ".eslintrc.json"), "{}");
			write(path.join(pkgDir, "package.json"), "{}");
			// Above the package boundary: a legacy file is not this package's.
			expect(hasToolConfig("eslint", start, { homeDir: home })).toBe(false);
			// A flat config is found past the boundary (ESLint's own discovery).
			write(path.join(root, "eslint.config.mjs"), "export default [];");
			expect(findToolConfig("eslint", start, { homeDir: home })?.source).toBe(
				"file",
			);
			fs.rmSync(path.join(root, "eslint.config.mjs"));
			// At the boundary itself the legacy file and the package field count.
			write(path.join(pkgDir, ".eslintrc.json"), "{}");
			expect(hasToolConfig("eslint", start, { homeDir: home })).toBe(true);
			fs.rmSync(path.join(pkgDir, ".eslintrc.json"));
			write(
				path.join(pkgDir, "package.json"),
				JSON.stringify({ eslintConfig: {} }),
			);
			expect(findToolConfig("eslint", start, { homeDir: home })?.source).toBe(
				"json-field",
			);
		});
	});

	it("stops at a caller's ceiling, visiting it", () => {
		withDir((root) => {
			const home = path.join(root, "no-home");
			const project = path.join(root, "proj");
			const start = path.join(project, "src", "main");
			fs.mkdirSync(start, { recursive: true });
			write(path.join(root, "pom.xml"), "<project/>");
			expect(hasToolConfig("javaBuild", start, { homeDir: home })).toBe(true);
			expect(
				hasToolConfig("javaBuild", start, { homeDir: home, ceiling: project }),
			).toBe(false);
			write(path.join(project, "build.gradle"), "");
			expect(
				hasToolConfig("javaBuild", start, { homeDir: home, ceiling: project }),
			).toBe(true);
		});
	});
});

describe("tool-config-presence: one stop rule", () => {
	it("returns where the config was found and why", () => {
		withDir((dir) => {
			const toml = write(path.join(dir, "pyproject.toml"), "[tool.ruff]\n");
			const nested = path.join(dir, "pkg", "src");
			fs.mkdirSync(nested, { recursive: true });
			const hit = findToolConfig("ruff", nested, {
				homeDir: path.join(dir, "no-home"),
			});
			expect(hit).toMatchObject({ source: "toml-table" });
			expect(fs.realpathSync(hit?.file ?? "")).toBe(fs.realpathSync(toml));
			expect(fs.realpathSync(hit?.dir ?? "")).toBe(fs.realpathSync(dir));
		});
	});

	it("visits $HOME itself and nothing above it", () => {
		withDir((root) => {
			const home = path.join(root, "home");
			const start = path.join(home, "proj", "src");
			fs.mkdirSync(start, { recursive: true });
			write(path.join(root, ".tflint.hcl"));
			expect(hasToolConfig("tflint", start, { homeDir: home })).toBe(false);
			write(path.join(home, ".tflint.hcl"));
			expect(hasToolConfig("tflint", start, { homeDir: home })).toBe(true);
		});
	});

	it("a start outside $HOME climbs to the filesystem root, nearest first", () => {
		withDir((root) => {
			const start = path.join(root, "a", "b");
			fs.mkdirSync(start, { recursive: true });
			write(path.join(root, ".tflint.hcl"));
			const near = write(path.join(root, "a", ".tflint.hcl"));
			const hit = findToolConfig("tflint", start, {
				homeDir: path.join(root, "elsewhere"),
			});
			expect(fs.realpathSync(hit?.file ?? "")).toBe(fs.realpathSync(near));
		});
	});

	it("reads $HOME from the environment when no homeDir is given", () => {
		const { home } = pinFixtureHome("5408-seam-env-home");
		const start = path.join(home, "proj");
		fs.mkdirSync(start, { recursive: true });
		// The directory above the pinned home is this worker's own scratch.
		const above = write(path.join(path.dirname(home), ".tflint.hcl"));
		try {
			expect(hasToolConfig("tflint", start)).toBe(false);
		} finally {
			fs.rmSync(above, { force: true });
		}
	});
});

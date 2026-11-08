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
import {
	hasMypyConfig,
	hasSqlfluffConfig,
	hasYamllintConfig,
} from "../../clients/tool-policy.js";
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

	it("keeps the policy helpers on the seam's answer", () => {
		withDir((dir) => {
			write(path.join(dir, "setup.cfg"), "[sqlfluff]\n[mypy]\n[yamllint]\n");
			expect(hasSqlfluffConfig(dir)).toBe(true);
			expect(hasMypyConfig(dir)).toBe(true);
			expect(hasYamllintConfig(dir)).toBe(true);
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

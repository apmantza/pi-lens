/**
 * No test worker inherits the developer shell's active Python environment.
 *
 * `detectPythonEnvironment` resolves the interpreter and tool directory from
 * an exported VIRTUAL_ENV, CONDA_PREFIX or UV_PROJECT_ENVIRONMENT. A shell with
 * a global venv active (VIRTUAL_ENV=~/.venv) handed every worker that venv's
 * pyright, and `adopted-root-runners.test.ts` read a pyright finding on a file
 * whose premise is that nothing checks it. `tests/support/vitest-setup.ts`
 * scrubs the owner's own list (`AMBIENT_PYTHON_ENVIRONMENT_VARIABLES`) once per
 * worker.
 *
 * On a host whose shell exports none of them (CI) the worker witness holds
 * either way; it reds on a developer box with a venv active when the scrub is
 * removed. The owner case below keeps the scrubbed list tied to the channels
 * the owner actually reads.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { detectPythonEnvironment } from "../../clients/python-environment.js";
import {
	AMBIENT_PYTHON_ENVIRONMENT_VARIABLES,
	hasAmbientPythonEnvironment,
} from "../../clients/python-ambient-environment.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { pathWithoutActivePythonEnvironments } from "../support/ambient-python-scrub.js";
import { importSpecifiers } from "../support/module-instance-scan.js";
import { stripSource } from "../support/sweep-kit.js";

describe("ambient Python environment scrub", () => {
	it("leaves no ambient Python environment channel in the worker", () => {
		const leaked = AMBIENT_PYTHON_ENVIRONMENT_VARIABLES.filter(
			(name) => process.env[name] !== undefined,
		);
		expect(leaked).toEqual([]);
		expect(hasAmbientPythonEnvironment()).toBe(false);
	});
});

// Recurrence: the case that stood here looped over the scrubbed list and asked
// `hasAmbientPythonEnvironment` about each name, which is true by construction.
// Dropping CONDA_PREFIX, or UV_PROJECT_ENVIRONMENT, from the list left it green
// (measured on master dfdd854ed: the uv drop reddened no case in this file), so
// a channel the owner reads could reach every worker. The channel names below
// are spelled here, apart from the scrubbed list, and each one is first shown to
// be read by the real owner, `detectPythonEnvironment`.
describe("the scrub covers every channel detectPythonEnvironment reads", () => {
	const OWNER_CHANNELS = [
		{ variable: "UV_PROJECT_ENVIRONMENT", source: "uv-project-environment" },
		{ variable: "VIRTUAL_ENV", source: "virtual-env" },
		{ variable: "CONDA_PREFIX", source: "conda" },
	] as const;

	it("adopts, names and drops the PATH entry of each channel the owner reads", async () => {
		for (const { variable, source } of OWNER_CHANNELS) {
			const env = setupTestEnvironment("pi-lens-ambient-scrub-");
			try {
				const project = path.join(env.tmpDir, "project");
				const home = path.join(env.tmpDir, "home");
				const venv = path.join(env.tmpDir, "venv");
				const binDir = path.join(
					venv,
					process.platform === "win32" ? "Scripts" : "bin",
				);
				mkdirSync(project, { recursive: true });
				mkdirSync(home, { recursive: true });
				mkdirSync(binDir, { recursive: true });
				// uv applies UV_PROJECT_ENVIRONMENT only where the directory is a project.
				writeFileSync(
					path.join(project, "pyproject.toml"),
					'[project]\nname = "scrub-probe"\nversion = "0"\n',
				);
				writeFileSync(
					path.join(
						binDir,
						process.platform === "win32" ? "python.exe" : "python",
					),
					"",
				);
				vi.stubEnv(variable, venv);

				const adopted = await detectPythonEnvironment(project, home);

				expect(adopted?.source, `${variable}: owner source`).toBe(source);
				expect(
					hasAmbientPythonEnvironment({ [variable]: venv }),
					`${variable}: named by the scrubbed list`,
				).toBe(true);
				expect(
					pathWithoutActivePythonEnvironments(
						{
							[variable]: venv,
							PATH: [binDir, "/usr/bin"].join(path.delimiter),
						},
						process.platform,
					),
					`${variable}: PATH entry dropped`,
				).toBe("/usr/bin");
			} finally {
				vi.unstubAllEnvs();
				env.cleanup();
			}
		}
	});
});

describe("PATH without the active Python environments (#5713 review r1)", () => {
	it("drops a POSIX venv's bin and keeps every other entry in order", () => {
		expect(
			pathWithoutActivePythonEnvironments(
				{
					VIRTUAL_ENV: "/home/u/.venv",
					PATH: "/home/u/.venv/bin::/usr/bin:/bin",
				},
				"linux",
			),
		).toBe(":/usr/bin:/bin");
	});

	it("leaves PATH alone when no channel is set", () => {
		expect(
			pathWithoutActivePythonEnvironments({ PATH: "/usr/bin" }, "linux"),
		).toBeUndefined();
	});

	it("matches a Windows venv's Scripts whatever its case", () => {
		expect(
			pathWithoutActivePythonEnvironments(
				{
					VIRTUAL_ENV: "C:\\Envs\\dev",
					PATH: "c:\\envs\\dev\\Scripts;C:\\Windows\\system32",
				},
				"win32",
			),
		).toBe("C:\\Windows\\system32");
	});

	it("drops every directory Windows conda activation adds", () => {
		// conda/activate.py `_Activator._get_path_dirs` (conda 25.7.0) on Windows:
		// the prefix, one Library\\<msys2 variant>\\bin, Library\\mingw-w64\\bin,
		// Library\\usr\\bin, Library\\bin, Scripts and bin.
		const prefix = "C:\\envs\\dev";
		const activated = [
			prefix,
			`${prefix}\\Library\\ucrt64\\bin`,
			`${prefix}\\Library\\mingw-w64\\bin`,
			`${prefix}\\Library\\usr\\bin`,
			`${prefix}\\Library\\bin`,
			`${prefix}\\Scripts`,
			`${prefix}\\bin`,
		];
		const kept = ["C:\\Windows\\system32", "C:\\envs\\other\\Scripts"];
		expect(
			pathWithoutActivePythonEnvironments(
				{ CONDA_PREFIX: prefix, PATH: [...activated, ...kept].join(";") },
				"win32",
			),
		).toBe(kept.join(";"));
	});
});

describe("what the worker setup loads for the scrub (#5713 CI)", () => {
	// The worker setup runs in each test file's module registry before that
	// file's vi.mock calls apply, so any module it loads is cached with the REAL
	// dependencies: loading clients/path-utils.js through the scrub pinned the
	// real node:fs, and the suites that mock node:fs to count path probes read
	// zero. A test in the same worker cannot observe its own setup's load order,
	// so this pins the two modules' import specifiers instead.
	// Recurrence: the scan here read raw text for double-quoted `import ... from`
	// at line start, so `export * from`, a single-quoted import and a top-level
	// `await import()` of path-utils in the scrub left it green, while a block
	// comment line that began with `import` counted as an import. It now reads
	// comment-blanked text (string literals kept: the specifier is the evidence)
	// through the shared `importSpecifiers`, which knows every binding form.
	it("imports only Node built-ins and the leaf channel module", () => {
		const specifiers = (file: string): string[] =>
			importSpecifiers(
				stripSource(readFileSync(file, "utf8"), { strings: "keep" }),
			).sort();
		expect(specifiers("tests/support/ambient-python-scrub.ts")).toEqual([
			"../../clients/python-ambient-environment.js",
			"node:path",
		]);
		expect(specifiers("clients/python-ambient-environment.ts")).toEqual([
			"node:path",
		]);
	});
});

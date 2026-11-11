/**
 * #5408 divergences 1, 3 and 4, through the real callers: the policy layer
 * (`getLinterPolicyForCwd` / `hasXConfig`) and the runner's own `run()`.
 *
 * Recurrence these cells name: the policy and a runner each decided "is this
 * tool configured" on their own, so they disagreed and the runner skipped (or
 * dropped `--config`) with no reason. The process boundary is the only double:
 * `safeSpawn` / `safeSpawnAsync` answer every child (the `--version`
 * availability probe included), everything that decides configured-or-not is
 * the production code.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { pinFixtureHome, setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn();
const safeSpawnAsync = vi.fn((...args: Parameters<typeof safeSpawn>) =>
	Promise.resolve(safeSpawn(...args)),
);

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawn,
	safeSpawnAsync,
}));

function write(file: string, content = ""): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

async function load<T>(spec: string): Promise<T> {
	return (await import(spec)) as T;
}

type Runner = {
	run: (ctx: never) => Promise<{ status?: string; skipReason?: string }>;
};

async function runRunner(
	name: string,
	filePath: string,
	cwd: string,
	kind: string,
) {
	const mod = await load<{ default: Runner }>(
		`../../../../clients/dispatch/runners/${name}.js`,
	);
	return mod.default.run(
		makeRunnerCtx(filePath, cwd, { kind } as never) as never,
	);
}

async function withDirP<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
	const env = setupTestEnvironment("pi-lens-5408-py-");
	try {
		return await fn(env.tmpDir);
	} finally {
		env.cleanup();
	}
}

/** Argv of every real tool run; the `--version` availability probes are not runs. */
function spawnedArgs(): string[][] {
	return safeSpawn.mock.calls
		.map((call) => call[1] as string[])
		.filter((argv) => !(argv.length === 1 && argv[0] === "--version"));
}

describe("#5408 config presence: policy and runner agree", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockImplementation((...args: Parameters<typeof safeSpawn>) =>
			Promise.resolve(safeSpawn(...args)),
		);
		safeSpawn.mockReturnValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe("mix never walks up, so neither does the gate (#5408 r2 F1)", () => {
		// Recurrence: the seam climbs to $HOME, and credo/elixir-check asked it
		// for mix.exs, so a file whose workspace dir has no mix.exs under an
		// ancestor that has one ran `mix compile` where mix cannot find a
		// project (master: the elixirc fallback; r1: `failed parser_error`).
		const mixCommands = () =>
			safeSpawn.mock.calls
				.map((c) => String(c[0]))
				.filter((c) => /(^|[\\/])mix(\.\w+)?$/.test(c));

		it("elixir-check and credo do not run mix from a directory below the one holding mix.exs", async () => {
			const env = setupTestEnvironment("pi-lens-5408-mix-up-");
			try {
				write(path.join(env.tmpDir, "umbrella", "mix.exs"), "");
				const file = write(
					path.join(env.tmpDir, "umbrella", "tools", "lib", "a.ex"),
					"x\n",
				);
				const { dispatchLintDetailed } = await load<
					typeof import("../../../../clients/dispatch/integration.js")
				>("../../../../clients/dispatch/integration.js");
				const { runners } = await dispatchLintDetailed(
					file,
					path.join(env.tmpDir, "umbrella", "tools"),
					{
						getFlag: (flag: string) =>
							flag === "no-lsp" || flag === "no-ast-grep",
					} as never,
				);
				expect(runners.map((r) => r.runnerId)).toContain("elixir-check");
				expect(mixCommands()).toEqual([]);
			} finally {
				env.cleanup();
			}
		});

		it("the seam answers mix at the exact directory only", async () => {
			const { hasToolConfig } = await load<
				typeof import("../../../../clients/tool-config-presence.js")
			>("../../../../clients/tool-config-presence.js");
			const env = setupTestEnvironment("pi-lens-5408-mix-exact-");
			try {
				write(path.join(env.tmpDir, "umbrella", "mix.exs"), "");
				const below = path.join(env.tmpDir, "umbrella", "apps", "web");
				fs.mkdirSync(below, { recursive: true });
				expect(hasToolConfig("mix", below)).toBe(false);
				expect(hasToolConfig("mix", path.join(env.tmpDir, "umbrella"))).toBe(
					true,
				);
			} finally {
				env.cleanup();
			}
		});
	});

	describe("credo and vale report what dispatch will do (#5408 r2 F2)", () => {
		// Recurrence: effective_config said `selected` for credo and vale while
		// their run() skipped for want of mix.exs / .vale.ini.
		it.each([
			["credo", "a.ex", "elixir"],
			["vale", "a.md", "markdown"],
		])(
			"%s declares requiresConfig and skips without it",
			async (name, file, kind) => {
				const env = setupTestEnvironment(`pi-lens-5408-r2gate-${name}-`);
				try {
					const filePath = write(path.join(env.tmpDir, file), "x\n");
					const mod = await load<{
						default: Runner & { requiresConfig?: (cwd: string) => boolean };
					}>(`../../../../clients/dispatch/runners/${name}.js`);
					expect(mod.default.requiresConfig?.(env.tmpDir)).toBe(false);
					const result = await mod.default.run(
						makeRunnerCtx(filePath, env.tmpDir, { kind } as never) as never,
					);
					expect(result.status).toBe("skipped");
					expect(safeSpawn).not.toHaveBeenCalled();
				} finally {
					env.cleanup();
				}
			},
		);
	});

	describe("a runner's declared requiresConfig is the gate its run() applies (#5408)", () => {
		// Recurrence: `effective_config` read the dispatch plan alone and reported
		// eslint selected while `run()` skipped. It now asks the runner's own
		// `requiresConfig`; this proves the declaration and the gate are one.
		it.each([
			["eslint", "a.ts", "jsts"],
			["mypy", "a.py", "python"],
			["detekt", "A.kt", "kotlin"],
			["golangci-lint", "a.go", "go"],
			["phpstan", "a.php", "php"],
		])(
			"%s declares it and skips an unconfigured project without a spawn",
			async (name, file, kind) => {
				const env = setupTestEnvironment(`pi-lens-5408-gate-${name}-`);
				try {
					const filePath = write(path.join(env.tmpDir, file), "x\n");
					const mod = await load<{
						default: Runner & { requiresConfig?: (cwd: string) => boolean };
					}>(`../../../../clients/dispatch/runners/${name}.js`);
					expect(mod.default.requiresConfig?.(env.tmpDir)).toBe(false);

					const result = await mod.default.run(
						makeRunnerCtx(filePath, env.tmpDir, { kind } as never) as never,
					);

					expect(result.status).toBe("skipped");
					expect(safeSpawn).not.toHaveBeenCalled();
				} finally {
					env.cleanup();
				}
			},
		);
	});

	describe("mix.exs, one answer for credo and elixir-check (#5408 hand-rolled gates)", () => {
		// Recurrence: credo.ts and elixir-check.ts each carried their own
		// `hasMixExs` (the same one-line `existsSync`), so a fix to one left the
		// other. Both now ask the seam.
		const calledCommands = () => safeSpawn.mock.calls.map((c) => String(c[0]));

		it("credo skips a project with no mix.exs and probes one that has it", async () => {
			const bare = setupTestEnvironment("pi-lens-5408-credo-bare-");
			try {
				const file = write(path.join(bare.tmpDir, "a.ex"), "x\n");
				const result = await runRunner("credo", file, bare.tmpDir, "elixir");
				expect(result.status).toBe("skipped");
				expect(safeSpawn).not.toHaveBeenCalled();
			} finally {
				bare.cleanup();
			}
			const project = setupTestEnvironment("pi-lens-5408-credo-mix-");
			try {
				write(path.join(project.tmpDir, "mix.exs"), "");
				const file = write(path.join(project.tmpDir, "a.ex"), "x\n");
				await runRunner("credo", file, project.tmpDir, "elixir");
				expect(calledCommands().length).toBeGreaterThan(0);
			} finally {
				project.cleanup();
			}
		});

		it("elixir-check compiles with mix only where mix.exs exists", async () => {
			const bare = setupTestEnvironment("pi-lens-5408-ex-bare-");
			try {
				const file = write(path.join(bare.tmpDir, "a.ex"), "x\n");
				await runRunner("elixir-check", file, bare.tmpDir, "elixir");
				expect(
					calledCommands().some((c) => /(^|[\\/])mix(\.\w+)?$/.test(c)),
				).toBe(false);
			} finally {
				bare.cleanup();
			}
			safeSpawn.mockClear();
			const project = setupTestEnvironment("pi-lens-5408-ex-mix-");
			try {
				write(path.join(project.tmpDir, "mix.exs"), "");
				const file = write(path.join(project.tmpDir, "a.ex"), "x\n");
				await runRunner("elixir-check", file, project.tmpDir, "elixir");
				expect(
					calledCommands().some((c) => /(^|[\\/])mix(\.\w+)?$/.test(c)),
				).toBe(true);
			} finally {
				project.cleanup();
			}
		});
	});

	describe("divergence 1: detekt walks up in the policy, the runner checked only the cwd", () => {
		it("runs detekt with the repo-root config when the nearest build file is a module", async () => {
			const env = setupTestEnvironment("pi-lens-5408-detekt-");
			try {
				write(path.join(env.tmpDir, "settings.gradle.kts"), "");
				write(path.join(env.tmpDir, "app", "build.gradle.kts"), "");
				write(
					path.join(env.tmpDir, "config", "detekt", "detekt.yml"),
					"build:\n  maxIssues: 0\n",
				);
				const kt = write(
					path.join(env.tmpDir, "app", "src", "main", "kotlin", "A.kt"),
					"class A\n",
				);

				const { resolveRunnerCwd } = await load<
					typeof import("../../../../clients/tool-cwd.js")
				>("../../../../clients/tool-cwd.js");
				const { getLinterPolicyForCwd } = await load<
					typeof import("../../../../clients/tool-policy.js")
				>("../../../../clients/tool-policy.js");
				const runnerCwd = resolveRunnerCwd(
					{ cwd: env.tmpDir, filePath: kt } as never,
					"detekt",
				);
				// The policy half already agreed on master: it walks up.
				expect(
					getLinterPolicyForCwd(kt, runnerCwd)?.preferredRunners,
				).toContain("detekt");

				const result = await runRunner("detekt", kt, env.tmpDir, "kotlin");

				// Red on master: status "skipped", no spawn at all.
				expect(result.status).not.toBe("skipped");
				const argv = spawnedArgs()[0] ?? [];
				const configAt = argv.indexOf("--config");
				expect(configAt).toBeGreaterThan(-1);
				expect(fs.realpathSync(argv[configAt + 1] ?? "")).toBe(
					fs.realpathSync(
						path.join(env.tmpDir, "config", "detekt", "detekt.yml"),
					),
				);
			} finally {
				env.cleanup();
			}
		});
	});

	describe("divergence 3: tflint stop rule", () => {
		// HOME is pinned by `pinFixtureHome` (AGENTS.md: a test that pins HOME
		// uses it); the project lives under that home.
		function layout(slug: string) {
			const { home } = pinFixtureHome(slug);
			const tf = write(path.join(home, "proj", "main.tf"), "");
			return { home, tf };
		}

		it("passes --config for a .tflint.hcl in $HOME, the same config the policy reports", async () => {
			{
				const { home, tf } = layout("5408-tflint-home");
				write(path.join(home, ".tflint.hcl"), "");
				vi.stubEnv("TFLINT_CONFIG_FILE", "");

				const { hasTflintConfig } = await load<
					typeof import("../../../../clients/tool-policy.js")
				>("../../../../clients/tool-policy.js");
				expect(hasTflintConfig(path.dirname(tf))).toBe(true);

				await runRunner("tflint", tf, path.dirname(tf), "terraform");

				// Red on master: the runner's finder stops BEFORE $HOME.
				const argv = spawnedArgs()[0] ?? [];
				expect(argv.some((a) => a.startsWith("--config="))).toBe(true);
			}
		});

		it("ignores a .tflint.hcl ABOVE $HOME in both the policy and the runner", async () => {
			const { home, tf } = layout("5408-tflint-above");
			// The directory above the pinned home is this worker's own scratch.
			const above = write(path.join(path.dirname(home), ".tflint.hcl"), "");
			try {
				vi.stubEnv("TFLINT_CONFIG_FILE", "");

				const { hasTflintConfig } = await load<
					typeof import("../../../../clients/tool-policy.js")
				>("../../../../clients/tool-policy.js");
				// Red on master: the policy walk is unbounded.
				expect(hasTflintConfig(path.dirname(tf))).toBe(false);

				await runRunner("tflint", tf, path.dirname(tf), "terraform");
				const argv = spawnedArgs()[0] ?? [];
				expect(argv.some((a) => a.startsWith("--config="))).toBe(false);
			} finally {
				fs.rmSync(above, { force: true });
			}
		});
	});

	describe("divergence 4: sqlfluff label, runner and formatter", () => {
		it("the policy says an unconfigured .sql file runs exactly when the runner runs it", async () => {
			const env = setupTestEnvironment("pi-lens-5408-sqlfluff-");
			try {
				const sql = write(path.join(env.tmpDir, "q.sql"), "select 1\n");
				const { getLinterPolicyForCwd } = await load<
					typeof import("../../../../clients/tool-policy.js")
				>("../../../../clients/tool-policy.js");

				const policy = getLinterPolicyForCwd(sql, env.tmpDir);
				const result = await runRunner("sqlfluff", sql, env.tmpDir, "sql");
				const ran = spawnedArgs().length > 0;

				// The runner lints unconfigured on the ANSI dialect (#1937).
				expect(ran).toBe(true);
				expect(result.status).not.toBe("skipped");
				expect(spawnedArgs()[0]).toEqual(
					expect.arrayContaining(["--dialect", "ansi"]),
				);
				// Red on master: the policy claimed `config-first` / false.
				expect(policy?.defaultWhenUnconfigured).toBe(ran);
				expect(policy?.gate).toBe("smart-default");
			} finally {
				env.cleanup();
			}
		});

		it("the formatter still refuses an unconfigured .sql file (it writes)", async () => {
			const env = setupTestEnvironment("pi-lens-5408-sqlfluff-fmt-");
			try {
				const sql = write(path.join(env.tmpDir, "q.sql"), "select 1\n");
				const { getFormattersForFile } = await load<
					typeof import("../../../../clients/formatters.js")
				>("../../../../clients/formatters.js");
				expect(await getFormattersForFile(sql, env.tmpDir)).toEqual([]);

				// A second directory: the selection cache is keyed by cwd.
				const configuredDir = path.join(env.tmpDir, "configured");
				const configuredSql = write(
					path.join(configuredDir, "q.sql"),
					"select 1\n",
				);
				write(
					path.join(configuredDir, ".sqlfluff"),
					"[sqlfluff]\ndialect = ansi\n",
				);
				const configured = await getFormattersForFile(
					configuredSql,
					configuredDir,
				);
				expect(configured.map((f) => f.name)).toEqual(["sqlfluff"]);
			} finally {
				env.cleanup();
			}
		});
	});

	describe("divergence 2: Python gates read structure, not substrings", () => {
		it("a pyproject with [tool.ruff] only in a comment is not ruff config", async () => {
			const policy = await load<
				typeof import("../../../../clients/tool-policy.js")
			>("../../../../clients/tool-policy.js");
			await withDirP((dir) => {
				write(
					path.join(dir, "pyproject.toml"),
					"# [tool.ruff]\n# line-length = 100\n[tool.black]\nline-length = 88\n",
				);
				// Red on master: `content.includes("[tool.ruff]")` matched the comment.
				expect(policy.hasRuffConfig(dir)).toBe(false);
				expect(policy.hasBlackConfig(dir)).toBe(true);
			});
		});

		it("selects black over ruff when only black has real config and ruff is a comment", async () => {
			const names = await withDirP(async (dir) => {
				write(
					path.join(dir, "pyproject.toml"),
					"# [tool.ruff]\n[tool.black]\nline-length = 88\n",
				);
				const file = write(path.join(dir, "a.py"), "x=1\n");
				const { getFormattersForFile } = await load<
					typeof import("../../../../clients/formatters.js")
				>("../../../../clients/formatters.js");
				return (await getFormattersForFile(file, dir)).map((f) => f.name);
			});
			// Red on master: ruff (the policy default) won as "explicit config".
			expect(names).toEqual(["black"]);
		});

		it("does not treat flake8-black in requirements.txt as black config", async () => {
			const names = await withDirP(async (dir) => {
				write(
					path.join(dir, "requirements.txt"),
					"flake8-black==0.3.6\nblack-hole\n",
				);
				const file = write(path.join(dir, "a.py"), "x=1\n");
				const { getFormattersForFile } = await load<
					typeof import("../../../../clients/formatters.js")
				>("../../../../clients/formatters.js");
				return (await getFormattersForFile(file, dir)).map((f) => f.name);
			});
			// Red on master: `.includes("black")` made black the explicit formatter.
			expect(names).toEqual(["ruff"]);
		});
	});
	describe("vale and shellcheck ask the seam for their config (#5408 slice 2)", () => {
		// Recurrence: both runners wrapped `findLocalToolConfig`, an UNBOUNDED climb,
		// so a `.vale.ini` / `.shellcheckrc` above $HOME counted as project config
		// (the tflint shape, divergence 3); shellcheck also started the climb at
		// `ctx.cwd`, so a `.shellcheckrc` beside the script (below the cwd) was
		// never seen and the runner forced `--severity info` over the project's own.
		function homeLayout(slug: string) {
			const { home } = pinFixtureHome(slug);
			return { home, proj: path.join(home, "proj"), above: path.dirname(home) };
		}
		const valeRan = () => spawnedArgs().some((argv) => argv.includes("JSON"));

		it("vale: a .vale.ini above $HOME does not run vale", async () => {
			const { proj, above } = homeLayout("5408-vale-above");
			const stray = write(path.join(above, ".vale.ini"), "");
			try {
				const md = write(path.join(proj, "a.md"), "# t\n");
				const mod = await load<{
					default: Runner & { requiresConfig?: (cwd: string) => boolean };
				}>("../../../../clients/dispatch/runners/vale.js");
				expect(mod.default.requiresConfig?.(proj)).toBe(false);
				const { dispatchLintDetailed } = await load<
					typeof import("../../../../clients/dispatch/integration.js")
				>("../../../../clients/dispatch/integration.js");
				await dispatchLintDetailed(
					md,
					proj,
					{
						getFlag: (flag: string) =>
							flag === "no-lsp" || flag === "no-ast-grep",
					} as never,
					{ blockingOnly: false },
				);
				expect(valeRan()).toBe(false);
			} finally {
				fs.rmSync(stray, { force: true });
			}
		});

		it("vale: a .vale.ini in $HOME itself runs vale", async () => {
			const { home, proj } = homeLayout("5408-vale-home");
			write(path.join(home, ".vale.ini"), "");
			const md = write(path.join(proj, "a.md"), "# t\n");
			await runRunner("vale", md, proj, "markdown");
			expect(valeRan()).toBe(true);
		});

		const severityFlag = () =>
			spawnedArgs()
				.find((argv) => argv.includes("--format"))
				?.includes("--severity");
		// The bash LSP is absent, so the CLI lane is not covered-by-primary.
		async function runShellcheck(file: string, cwd: string) {
			const mod = await load<{ default: Runner }>(
				"../../../../clients/dispatch/runners/shellcheck.js",
			);
			return mod.default.run(
				makeRunnerCtx(file, cwd, {
					kind: "shell",
					hasTool: async (t: string) => t !== "bash-language-server",
				} as never) as never,
			);
		}

		it("shellcheck: a .shellcheckrc beside the script, below the cwd, is the project's config", async () => {
			const { proj } = homeLayout("5408-shellcheck-below");
			write(path.join(proj, "scripts", ".shellcheckrc"), "severity=style\n");
			const sh = write(
				path.join(proj, "scripts", "a.sh"),
				"#!/bin/sh\necho $x\n",
			);
			await runShellcheck(sh, proj);
			// Red on master: the climb started at ctx.cwd and missed the file's directory.
			expect(severityFlag()).toBe(false);
		});

		it("shellcheck: a .shellcheckrc above $HOME is not project config", async () => {
			const { proj, above } = homeLayout("5408-shellcheck-above");
			const stray = write(
				path.join(above, ".shellcheckrc"),
				"severity=style\n",
			);
			try {
				const sh = write(path.join(proj, "a.sh"), "#!/bin/sh\necho $x\n");
				await runShellcheck(sh, proj);
				// Red on master: the unbounded climb found the stray file.
				expect(severityFlag()).toBe(true);
			} finally {
				fs.rmSync(stray, { force: true });
			}
		});

		it("shellcheck: a .shellcheckrc in the project root still suppresses the info floor", async () => {
			const { proj } = homeLayout("5408-shellcheck-root");
			write(path.join(proj, ".shellcheckrc"), "severity=style\n");
			const sh = write(path.join(proj, "a.sh"), "#!/bin/sh\necho $x\n");
			await runShellcheck(sh, proj);
			expect(severityFlag()).toBe(false);
		});
	});
});

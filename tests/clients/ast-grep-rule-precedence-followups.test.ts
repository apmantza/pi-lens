import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { js as sgJs, ts as sgTs } from "@ast-grep/napi";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
	evaluateAstGrepRules,
	type AstGrepEvaluateOptions,
} from "../../clients/dispatch/runners/ast-grep-napi.js";
import { clearRulesCache } from "../../clients/dispatch/runners/yaml-rule-parser.js";
import { createLSPClient } from "../../clients/lsp/client.js";
import { getServerById } from "../../clients/lsp/server.js";
import {
	_resetBaselineSgconfigForTests,
	findLocalSgconfig,
	getAstGrepRuleSources,
	resolveBaselineSgconfig,
} from "../../clients/sgconfig.js";

const PRIMARY_RULES = path.join("rules", "ast-grep-rules", "rules");
const SECONDARY_RULES = path.join(
	"rules",
	"ast-grep-rules",
	"coderabbit",
	"rules",
);
const tempRoots: string[] = [];

interface RuleDocument {
	id: string;
	message?: string;
}

function makeProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-precedence-"));
	tempRoots.push(root);
	fs.mkdirSync(path.join(root, PRIMARY_RULES), { recursive: true });
	return root;
}

function writeRule(
	root: string,
	relativeDir: string,
	relativeFile: string,
	options: {
		id: string;
		language?: "TypeScript" | "JavaScript";
		message: string;
		pattern: string;
	},
): string {
	const file = path.join(root, relativeDir, relativeFile);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		[
			`id: ${options.id}`,
			`language: ${options.language ?? "TypeScript"}`,
			"severity: warning",
			`message: ${options.message}`,
			"rule:",
			`  pattern: ${options.pattern}`,
			"",
		].join("\n"),
	);
	return file;
}

function requireConfig(root: string): string {
	const config = resolveBaselineSgconfig(root);
	if (!config) throw new Error("expected synthesized ast-grep config");
	return config;
}

function ruleDirs(configPath: string): string[] {
	const parsed = yaml.load(fs.readFileSync(configPath, "utf8"));
	if (!parsed || typeof parsed !== "object" || !("ruleDirs" in parsed)) {
		throw new Error("generated config has no ruleDirs");
	}
	const dirs = (parsed as { ruleDirs?: unknown }).ruleDirs;
	if (!Array.isArray(dirs) || !dirs.every((dir) => typeof dir === "string")) {
		throw new Error("generated config has invalid ruleDirs");
	}
	return dirs;
}

function yamlFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of fs
		.readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...yamlFiles(full));
		else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(full);
	}
	return files;
}

function documents(configPath: string): RuleDocument[] {
	const result: RuleDocument[] = [];
	for (const dir of ruleDirs(configPath)) {
		for (const file of yamlFiles(dir)) {
			yaml.loadAll(fs.readFileSync(file, "utf8"), (value: unknown) => {
				if (!value || typeof value !== "object" || !("id" in value)) return;
				const rule = value as { id?: unknown; message?: unknown };
				if (typeof rule.id !== "string") return;
				result.push({
					id: rule.id,
					message: typeof rule.message === "string" ? rule.message : undefined,
				});
			});
		}
	}
	return result;
}

function byId(configPath: string, id: string): RuleDocument[] {
	return documents(configPath).filter((document) => document.id === id);
}

function napiDiagnostics(
	projectRoot: string,
	filePath: string,
	content: string,
	language: "typescript" | "javascript",
	evaluationRoot = projectRoot,
) {
	const parsed =
		language === "typescript" ? sgTs.parse(content) : sgJs.parse(content);
	const options: AstGrepEvaluateOptions = { projectRoot };
	return evaluateAstGrepRules(
		filePath,
		parsed.root(),
		evaluationRoot,
		"jsts",
		options,
	);
}

function findCli(): string | undefined {
	for (const command of ["ast-grep", "sg"]) {
		const result = spawnSync(command, ["--version"], {
			encoding: "utf8",
			shell: process.platform === "win32",
		});
		if (result.status === 0) return command;
	}
	return undefined;
}

const astGrepCli = findCli();
const cliIt = astGrepCli ? it : it.skip;

function runCli(configPath: string, filePath: string) {
	if (!astGrepCli) throw new Error("ast-grep CLI unavailable");
	return spawnSync(
		astGrepCli,
		["scan", "--config", configPath, "--json=compact", filePath],
		{
			encoding: "utf8",
			shell: process.platform === "win32",
		},
	);
}

afterEach(() => {
	_resetBaselineSgconfigForTests();
	clearRulesCache();
	for (const root of tempRoots.splice(0)) {
		// Windows: the raw ast-grep LSP child spawned by the cliIt case can still
		// hold a handle on the temp dir when teardown runs, making rmSync throw
		// EPERM (teardown-only — the test's assertions have already passed).
		// Retry briefly, then swallow: a leaked tmp dir is harmless, a red run
		// from teardown is not.
		try {
			fs.rmSync(root, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		} catch {
			// leave the tmp dir for the OS temp cleaner
		}
	}
});

describe("project rule precedence follow-ups", () => {
	it("discovers nested primary and secondary rules in deterministic precedence order", () => {
		const root = makeProject();
		writeRule(root, PRIMARY_RULES, "nested/typescript/primary.yml", {
			id: "layered-rule",
			message: "primary winner",
			pattern: "layered($A)",
		});
		writeRule(root, SECONDARY_RULES, "typescript/shadowed.yml", {
			id: "layered-rule",
			message: "secondary loser",
			pattern: "layered($A)",
		});
		writeRule(root, SECONDARY_RULES, "typescript/unique.yaml", {
			id: "secondary-unique",
			message: "secondary unique",
			pattern: "secondaryUnique($A)",
		});

		const sources = getAstGrepRuleSources(root);
		expect(sources.map(({ origin, tier }) => `${origin}:${tier}`)).toEqual([
			"project:primary",
			"project:secondary",
			"bundled:primary",
			"bundled:secondary",
		]);
		const config = requireConfig(root);
		expect(byId(config, "layered-rule")).toEqual([
			expect.objectContaining({ message: "primary winner" }),
		]);
		expect(byId(config, "secondary-unique")).toHaveLength(1);
		expect(
			documents(config).some(
				(document) =>
					document.id === "detect-angular-sce-disabled-javascript",
			),
		).toBe(true);

		_resetBaselineSgconfigForTests();
		expect(fs.readFileSync(requireConfig(root), "utf8")).toBe(
			fs.readFileSync(config, "utf8"),
		);
	});

	it("invalidates for preserved-mtime content edits, path changes, additions, and removals", () => {
		const root = makeProject();
		const override = writeRule(root, PRIMARY_RULES, "override.yml", {
			id: "no-typeof-undefined",
			message: "project winner",
			pattern: "projectOnly($A)",
		});
		const initialConfig = requireConfig(root);
		expect(byId(initialConfig, "no-typeof-undefined")).toEqual([
			expect.objectContaining({ message: "project winner" }),
		]);

		const stat = fs.statSync(override);
		const original = fs.readFileSync(override, "utf8");
		const retired = original.replace(
			"no-typeof-undefined",
			"retired-override-id",
		);
		expect(retired).toHaveLength(original.length);
		fs.writeFileSync(override, retired);
		fs.utimesSync(override, stat.atime, stat.mtime);
		const contentChanged = requireConfig(root);
		expect(byId(contentChanged, "retired-override-id")).toHaveLength(1);
		expect(byId(contentChanged, "no-typeof-undefined")).toHaveLength(1);

		const primaryDir = path.join(root, PRIMARY_RULES);
		const nestedDir = path.join(primaryDir, "nested");
		const moved = path.join(nestedDir, "renamed.yml");
		fs.mkdirSync(nestedDir, { recursive: true });
		const primaryStat = fs.statSync(primaryDir);
		const nestedStat = fs.statSync(nestedDir);
		const sentinel = new Date("2000-01-01T00:00:00.000Z");
		fs.utimesSync(contentChanged, sentinel, sentinel);
		fs.renameSync(override, moved);
		fs.utimesSync(primaryDir, primaryStat.atime, primaryStat.mtime);
		fs.utimesSync(nestedDir, nestedStat.atime, nestedStat.mtime);
		const pathChanged = requireConfig(root);
		expect(pathChanged).toBe(contentChanged);
		expect(fs.statSync(pathChanged).mtimeMs).toBeGreaterThan(sentinel.getTime());
		expect(byId(pathChanged, "retired-override-id")).toHaveLength(1);

		writeRule(root, PRIMARY_RULES, "added.yml", {
			id: "added-rule",
			message: "added",
			pattern: "added($A)",
		});
		expect(byId(requireConfig(root), "added-rule")).toHaveLength(1);
		fs.rmSync(path.join(root, PRIMARY_RULES, "added.yml"));
		expect(byId(requireConfig(root), "added-rule")).toHaveLength(0);
	});

	it("refreshes NAPI project-rule caches after a preserved-mtime, equal-size ID edit", () => {
		const root = makeProject();
		const override = writeRule(root, PRIMARY_RULES, "override.yml", {
			id: "no-typeof-undefined",
			message: "project winner",
			pattern: "projectOnly($A)",
		});
		const projectInput = path.join(root, "project.ts");
		expect(
			napiDiagnostics(
				root,
				projectInput,
				"projectOnly(value);\n",
				"typescript",
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					rule: "no-typeof-undefined",
					message: "[slop] project winner",
				}),
			]),
		);

		const stat = fs.statSync(override);
		const original = fs.readFileSync(override, "utf8");
		const retired = original.replace(
			"no-typeof-undefined",
			"retired-override-id",
		);
		expect(retired).toHaveLength(original.length);
		fs.writeFileSync(override, retired);
		fs.utimesSync(override, stat.atime, stat.mtime);

		const bundledInput = path.join(root, "bundled.ts");
		const diagnostics = napiDiagnostics(
			root,
			bundledInput,
			'typeof value === "undefined";\n',
			"typescript",
		);
		expect(diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rule: "no-typeof-undefined" }),
			]),
		);
		expect(diagnostics).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ message: "[slop] project winner" }),
			]),
		);
	});

	it("isolates two workspace roots and keeps nested language-root evaluation on the workspace rules", () => {
		const rootA = makeProject();
		const rootB = makeProject();
		writeRule(rootA, PRIMARY_RULES, "winner.yml", {
			id: "workspace-winner",
			message: "workspace A",
			pattern: "workspaceRule($A)",
		});
		writeRule(rootB, PRIMARY_RULES, "winner.yml", {
			id: "workspace-winner",
			message: "workspace B",
			pattern: "workspaceRule($A)",
		});

		const configA = requireConfig(rootA);
		const textA = fs.readFileSync(configA, "utf8");
		const configB = requireConfig(rootB);
		expect(configB).not.toBe(configA);
		expect(fs.readFileSync(configA, "utf8")).toBe(textA);
		expect(byId(configA, "workspace-winner")).toEqual([
			expect.objectContaining({ message: "workspace A" }),
		]);
		expect(byId(configB, "workspace-winner")).toEqual([
			expect.objectContaining({ message: "workspace B" }),
		]);

		const nestedRoot = path.join(rootA, "packages", "app");
		fs.mkdirSync(nestedRoot, { recursive: true });
		const diagnostics = napiDiagnostics(
			rootA,
			path.join(nestedRoot, "input.ts"),
			"workspaceRule(value);\n",
			"typescript",
			nestedRoot,
		);
		expect(diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					rule: "workspace-winner",
					message: "[slop] workspace A",
				}),
			]),
		);
	});

	cliIt(
		"launches raw ast-grep LSP with the workspace-rooted project winner",
		async () => {
			const root = makeProject();
			writeRule(root, PRIMARY_RULES, "winner.yml", {
				id: "lsp-workspace-winner",
				message: "workspace LSP winner",
				pattern: "lspWorkspaceRule($A)",
			});
			const filePath = path.join(root, "input.ts");
			fs.writeFileSync(filePath, "lspWorkspaceRule(value);\n");
			const server = getServerById("ast-grep");
			if (!server) throw new Error("ast-grep server is not registered");
			const spawned = await server.spawn(root, { allowInstall: false });
			if (!spawned) throw new Error("ast-grep LSP did not spawn");
			expect(spawned.process.args).toContain("--config");

			const client = await createLSPClient({
				serverId: "ast-grep",
				process: spawned.process,
				root,
				initializeTimeoutMs: 5_000,
			});
			try {
				const minVersion = client.diagnosticsVersion;
				await client.notify.open(
					filePath,
					fs.readFileSync(filePath, "utf8"),
					"typescript",
				);
				await client.waitForDiagnostics(filePath, 5_000, { minVersion });
				expect(
					client
						.getDiagnostics(filePath)
						.find((diagnostic) =>
							String(diagnostic.code ?? "").includes(
								"lsp-workspace-winner",
							),
						),
				).toMatchObject({ message: "workspace LSP winner", source: "ast-grep" });
			} finally {
				await client.shutdown({ fast: true });
			}
		},
		15_000,
	);

	it("keeps TypeScript and JavaScript project winners aligned in NAPI", () => {
		const root = makeProject();
		writeRule(root, PRIMARY_RULES, "typescript.yml", {
			id: "no-typeof-undefined",
			language: "TypeScript",
			message: "project TypeScript winner",
			pattern: "projectTsOnly($A)",
		});
		writeRule(root, PRIMARY_RULES, "javascript.yml", {
			id: "no-typeof-undefined-js",
			language: "JavaScript",
			message: "project JavaScript winner",
			pattern: "projectJsOnly($A)",
		});

		const tsDiagnostics = napiDiagnostics(
			root,
			path.join(root, "input.ts"),
			"projectTsOnly(value);\n",
			"typescript",
		);
		const jsDiagnostics = napiDiagnostics(
			root,
			path.join(root, "input.js"),
			"projectJsOnly(value);\n",
			"javascript",
		);
		expect(tsDiagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					rule: "no-typeof-undefined",
					message: "[slop] project TypeScript winner",
				}),
			]),
		);
		expect(jsDiagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					rule: "no-typeof-undefined-js",
					message: "[slop] project JavaScript winner",
				}),
			]),
		);
	});

	it("loads the bundled CodeRabbit catalog recursively — a nested CWE rule fires via NAPI", () => {
		// Pins the recursive-discovery behavior this PR introduces: all bundled
		// CodeRabbit rules live under language subdirectories, so on master's
		// top-level-only discovery the ENTIRE vendored CWE catalog silently
		// loaded zero rules in both the NAPI and raw-LSP paths. Nothing else in
		// the suite asserts a CodeRabbit rule actually fires, so without this
		// test a regression back to non-recursive discovery would be invisible.
		const root = makeProject();
		const diagnostics = napiDiagnostics(
			root,
			path.join(root, "app.config.ts"),
			"$sceProvider.enabled(false);\n",
			"typescript",
		);
		expect(diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					rule: "detect-angular-sce-disabled-typescript",
				}),
			]),
		);
	});

	cliIt("keeps raw sg and NAPI blocking semantics aligned for same-layer duplicates", () => {
		const root = makeProject();
		writeRule(root, PRIMARY_RULES, "nested/a.yml", {
			id: "same-layer-duplicate",
			message: "first",
			pattern: "duplicateRule($A)",
		});
		writeRule(root, PRIMARY_RULES, "nested/b.yml", {
			id: "same-layer-duplicate",
			message: "second",
			pattern: "duplicateRule($A)",
		});
		const input = path.join(root, "input.ts");
		fs.writeFileSync(input, "duplicateRule(value);\n");

		const raw = runCli(requireConfig(root), input);
		expect(raw.status).not.toBe(0);
		expect(raw.stderr).toContain("Duplicate rule id `same-layer-duplicate`");

		const napi = napiDiagnostics(
			root,
			input,
			"duplicateRule(value);\n",
			"typescript",
		);
		expect(napi).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					rule: "same-layer-duplicate",
					semantic: "blocking",
					message: expect.stringContaining(
						'Duplicate ast-grep rule id "same-layer-duplicate" in project primary rules',
					),
				}),
			]),
		);
		expect(napi.map((diagnostic) => diagnostic.message).join("\n")).not.toContain(
			root,
		);
	});

	it("keeps an explicit nearest project sgconfig as the replacement surface", () => {
		const root = makeProject();
		const nested = path.join(root, "packages", "app", "src");
		fs.mkdirSync(nested, { recursive: true });
		const config = path.join(root, "packages", "app", "sgconfig.yml");
		fs.writeFileSync(config, "ruleDirs: []\n");
		expect(findLocalSgconfig(nested)).toBe(config);
	});
});

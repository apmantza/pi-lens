/**
 * The documented gate table is derived from `clients/tool-policy.ts` (#5408
 * added acceptance; the #5513 README lane found eight comment and doc rows that
 * disagreed with the policy).
 *
 * Recurrence this guard names: `docs/language-coverage.md` "What runs by
 * default" and `docs/dependencies.md` were written by hand against the policy,
 * and drifted: stylelint, markdownlint, prettier, yamllint, sqlfluff and Biome
 * were called "Config-gated" while their policy row is `smart-default`, the
 * Biome extension list lost `.sass`, and four default formatters (gleam, dart,
 * zig, cue) were missing. Nothing compared the prose to the code.
 *
 * Every tier below is DERIVED, never copied:
 * - a linter's tier is whether `getLinterPolicyForFile(file, {})` prefers it
 *   with no project config ("No project config"), or only once the matching
 *   context flag is set ("Project config"); a tool with no per-file sample
 *   falls back to its `TOOL_EXECUTION_POLICY.configEligibility`;
 * - a formatter's tier is whether any extension in
 *   `FORMATTER_POLICY_BY_EXTENSION` names it the default formatter with
 *   `defaultWhenUnconfigured: true`, and the extension list in the doc row is
 *   compared to those extensions.
 * The hand-written content is the sample table (which file exercises which
 * runner) and the exemption tables, each with a reason; a stale exemption is a
 * failure. A doc token that is neither derived nor exempt is a violation: the
 * known-good set is admitted and everything else is refused.
 *
 * Label-only fields (finding, not fixed here): `LinterPolicy.gate` and
 * `defaultWhenUnconfigured` have no production reader; the runners ask
 * `preferredRunners`, which is what the derivation uses.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import credoRunner from "../../clients/dispatch/runners/credo.js";
import {
	FORMATTER_POLICY_BY_EXTENSION,
	getLinterPolicyForFile,
	TOOL_EXECUTION_POLICY,
} from "../../clients/tool-policy.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { makeRunnerCtx } from "../support/runner-ctx.js";
import { setupTestEnvironment } from "../clients/test-utils.js";

type Tier = "No project config" | "Project config" | "Opt-in";
type LinterContext = NonNullable<Parameters<typeof getLinterPolicyForFile>[1]>;

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

interface DocRow {
	tier: Tier;
	/** Formatter cells open with `Formatters:`; everything else is a linter or runner. */
	scope: "format" | "lint";
	tokens: { name: string; exts: string[] }[];
	cell: string;
}

/** The table rows under `## heading`, or of the whole file when no heading is given. */
function tableRows(markdown: string, heading?: string): string[][] {
	let section = markdown;
	if (heading !== undefined) {
		const start = markdown.indexOf(`\n## ${heading}\n`);
		expect(start, `heading ${heading}`).toBeGreaterThan(-1);
		const rest = markdown.slice(start + 1);
		const end = rest.indexOf("\n## ", 4);
		section = end === -1 ? rest : rest.slice(0, end);
	}
	return section
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.map((line) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim()),
		)
		.filter((cells) => cells.length >= 3 && !/^-+$/.test(cells[0] ?? ""));
}

function parseGateTable(): DocRow[] {
	const rows = tableRows(
		read("docs/language-coverage.md"),
		"What runs by default",
	);
	return rows
		.filter((cells) => cells[0] !== "Tier")
		.map((cells) => {
			const toolCell = cells[1] ?? "";
			const scope = toolCell.startsWith("Formatters:") ? "format" : "lint";
			const body =
				scope === "format" ? toolCell.slice("Formatters:".length) : toolCell;
			const tokens = body
				.split(/[,;]/)
				.map((raw) => raw.trim())
				.filter((raw) => raw !== "" && !raw.startsWith("and other"))
				.map((raw) => ({
					name: raw
						.replace(/\([^)]*\)/g, "")
						.replace(/`/g, "")
						.trim()
						.toLowerCase(),
					exts: [
						...(raw.match(/\(([^)]*)\)/)?.[1] ?? "").matchAll(/\.[a-z0-9]+/g),
					].map((m) => m[0]),
				}));
			return { tier: cells[0] as Tier, scope, tokens, cell: toolCell };
		});
}

/** The file and runner id that exercise a tool in `getLinterPolicyForFile`. */
const LINT_SAMPLES: Record<
	string,
	{ file: string; runner: string; configured?: LinterContext }
> = {
	ruff: { file: "a.py", runner: "ruff-lint" },
	shellcheck: { file: "a.sh", runner: "shellcheck" },
	hadolint: { file: "Dockerfile", runner: "hadolint" },
	markdownlint: { file: "a.md", runner: "markdownlint" },
	rubocop: { file: "a.rb", runner: "rubocop" },
	ktlint: { file: "a.kt", runner: "ktlint" },
	taplo: { file: "a.toml", runner: "taplo" },
	stylelint: { file: "a.css", runner: "stylelint" },
	oxlint: { file: "a.ts", runner: "oxlint" },
	biome: { file: "a.ts", runner: "biome-check-json" },
	eslint: {
		file: "a.ts",
		runner: "eslint",
		configured: { hasEslintConfig: true },
	},
	"golangci-lint": {
		file: "a.go",
		runner: "golangci-lint",
		configured: { hasGolangciConfig: true },
	},
	mypy: { file: "a.py", runner: "mypy", configured: { hasMypyConfig: true } },
	phpstan: {
		file: "a.php",
		runner: "phpstan",
		configured: { hasPhpstanConfig: true },
	},
	detekt: {
		file: "a.kt",
		runner: "detekt",
		configured: { hasDetektConfig: true },
	},
	credo: { file: "a.ex", runner: "credo" },
};

/**
 * Doc tokens whose tier the policy cannot derive, each with its reason. A
 * token here that the doc no longer names is a stale exemption and fails.
 */
const UNDERIVED_LINT_TOKENS: Record<string, string> = {
	"language servers":
		"no policy row; the gate is the --no-lsp flag in the flag registry",
	".py format":
		"the formatter half of the ruff cell; the Formatters row derives ruff below",
	"go vet": "no policy row; the runner has no config skip",
	"ast-grep rules": "no policy row; ast-grep-napi runs without config",
	"tree-sitter rules":
		"no policy row; the tree-sitter runner runs without config",
	javac:
		"no policy row; the runner skips files inside a Maven or Gradle project",
	"helm render validation":
		"opt-in through helm.renderValidation.enabled, not a policy row",
	"commit guard": "opt-in through --lens-guard, not a policy row",
};

/**
 * Tokens whose derived tier differs from the doc tier on purpose. The doc's
 * notes must say why; the credo runner cell below proves the stricter skip.
 */
const TIER_EXCEPTIONS: Record<string, { docTier: Tier; note: RegExp }> = {
	credo: { docTier: "Project config", note: /credo's file policy is/ },
	spotbugs: { docTier: "Opt-in", note: /--lens-spotbugs/ },
	trivy: { docTier: "Opt-in", note: /trivy\.enabled/ },
};

function lintTier(name: string): Tier | undefined {
	const sample = LINT_SAMPLES[name];
	if (sample) {
		const prefersUnconfigured = getLinterPolicyForFile(
			sample.file,
			{},
		)?.preferredRunners.some((runner) => runner === sample.runner);
		if (prefersUnconfigured) return "No project config";
		const prefersConfigured =
			sample.configured &&
			getLinterPolicyForFile(
				sample.file,
				sample.configured,
			)?.preferredRunners.some((runner) => runner === sample.runner);
		return prefersConfigured ? "Project config" : undefined;
	}
	const row = TOOL_EXECUTION_POLICY.get(name);
	if (row?.configEligibility === "smart-default") return "No project config";
	if (row?.configEligibility === "config-first") return "Project config";
	return undefined;
}

function smartDefaultExtensions(formatter: string): string[] {
	return [...FORMATTER_POLICY_BY_EXTENSION]
		.filter(
			([, policy]) =>
				policy.defaultFormatter === formatter && policy.defaultWhenUnconfigured,
		)
		.map(([ext]) => ext);
}

function formatTier(name: string): Tier | undefined {
	if (smartDefaultExtensions(name).length > 0) return "No project config";
	const known = [...FORMATTER_POLICY_BY_EXTENSION.values()].some((policy) =>
		policy.formatterNames.includes(name),
	);
	return known ? "Project config" : undefined;
}

const rows = parseGateTable();

describe("docs/language-coverage.md 'What runs by default' agrees with tool-policy.ts", () => {
	it("every linter or runner token sits in the tier the policy derives", () => {
		const violations: string[] = [];
		let compared = 0;
		const seenUnderived = new Set<string>();
		for (const row of rows.filter((r) => r.scope === "lint")) {
			for (const { name } of row.tokens) {
				if (name in UNDERIVED_LINT_TOKENS) {
					seenUnderived.add(name);
					continue;
				}
				const exception = TIER_EXCEPTIONS[name];
				const derived = lintTier(name);
				if (exception) {
					compared += 1;
					if (row.tier !== exception.docTier) {
						violations.push(
							`${name}: exempt as ${exception.docTier}, doc has ${row.tier}`,
						);
					}
					if (!exception.note.test(read("docs/language-coverage.md"))) {
						violations.push(
							`${name}: the doc no longer carries its exception note`,
						);
					}
					continue;
				}
				if (derived === undefined) {
					violations.push(
						`${name}: not derivable from tool-policy.ts and not in UNDERIVED_LINT_TOKENS`,
					);
					continue;
				}
				compared += 1;
				if (derived !== row.tier) {
					violations.push(
						`${name}: policy derives "${derived}", doc row says "${row.tier}"`,
					);
				}
			}
		}
		for (const name of Object.keys(UNDERIVED_LINT_TOKENS)) {
			if (!seenUnderived.has(name)) violations.push(`stale exemption: ${name}`);
		}
		assertNonEmptyScan("linter tokens compared with the policy", compared, 20);
		expect(violations).toEqual([]);
	});

	it("every formatter token sits in the tier the policy derives, with the extension list the policy has", () => {
		const violations: string[] = [];
		let compared = 0;
		for (const row of rows.filter((r) => r.scope === "format")) {
			for (const { name, exts } of row.tokens) {
				const derived = formatTier(name);
				if (derived === undefined) {
					violations.push(
						`${name}: not a formatter named in FORMATTER_POLICY_BY_EXTENSION`,
					);
					continue;
				}
				compared += 1;
				if (derived !== row.tier) {
					violations.push(
						`${name}: policy derives "${derived}", doc row says "${row.tier}"`,
					);
				}
				if (exts.length > 0) {
					const policyExts = smartDefaultExtensions(name).sort();
					if (JSON.stringify([...exts].sort()) !== JSON.stringify(policyExts)) {
						violations.push(
							`${name}: doc lists ${exts.join(" ")}, policy default extensions are ${policyExts.join(" ")}`,
						);
					}
				}
			}
		}
		assertNonEmptyScan(
			"formatter tokens compared with the policy",
			compared,
			8,
		);
		expect(violations).toEqual([]);
	});

	it("every default formatter the policy has is named in the 'No project config' formatter row", () => {
		const documented = new Set(
			rows
				.filter((r) => r.scope === "format" && r.tier === "No project config")
				.flatMap((r) => r.tokens.map((t) => t.name)),
		);
		const missing = [...FORMATTER_POLICY_BY_EXTENSION.values()]
			.filter(
				(policy) => policy.defaultWhenUnconfigured && policy.defaultFormatter,
			)
			.map((policy) => policy.defaultFormatter as string)
			.filter((name) => !documented.has(name));
		expect([...new Set(missing)]).toEqual([]);
	});

	// Recurrence: credo's policy row selects it with no config while the runner
	// skips a directory with no mix.exs; the doc follows the runner and says so.
	it("the credo exception holds in the runner: no mix.exs is a not-configured skip", async () => {
		const env = setupTestEnvironment("pi-lens-gate-table-credo-");
		try {
			const file = path.join(env.tmpDir, "lib", "a.ex");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "defmodule A do\nend\n");
			const result = await credoRunner.run(
				makeRunnerCtx(file, env.tmpDir, { kind: "elixir" }) as never,
			);
			expect(result).toMatchObject({
				status: "skipped",
				skipReason: "not-configured",
			});
		} finally {
			env.cleanup();
		}
	});
});

describe("docs/dependencies.md does not call a smart-default tool config-gated", () => {
	// Recurrence: the Gate column called stylelint, markdownlint, prettier,
	// yamllint, sqlfluff and Biome "Config-gated" while their policy rows are
	// `smart-default`.
	const ALIASES: Record<string, string> = {
		"@biomejs/biome": "biome",
		"markdownlint-cli2": "markdownlint",
	};

	it("a Config-gated row names a config-first policy row", () => {
		const table = tableRows(read("docs/dependencies.md"));
		const violations: string[] = [];
		let mapped = 0;
		for (const cells of table) {
			const tool = (cells[0] ?? "").replace(/`/g, "");
			const id = ALIASES[tool] ?? tool;
			const policy = TOOL_EXECUTION_POLICY.get(id);
			if (policy) mapped += 1;
			if (
				/config-gated/i.test(cells[3] ?? "") &&
				policy?.configEligibility !== "config-first"
			) {
				violations.push(
					`${tool}: the Gate column says "${cells[3]}", policy is ${policy?.configEligibility ?? "absent"}`,
				);
			}
		}
		assertNonEmptyScan(
			"dependencies.md rows mapped to a policy row",
			mapped,
			10,
		);
		expect(violations).toEqual([]);
	});
});

/**
 * Adversarial-shapes battery driven through every CLI dispatch runner
 * (#1839). The synthetic complement to captured-real-output.test.ts: instead
 * of REAL binary bytes, every parser meets a standard garbage battery —
 * truncated JSON, usage prose on the findings stream, unknown severities,
 * absent optional fields, hostile numbers — and must hold three
 * classification invariants:
 *
 *   I1. Never crash: run() always resolves to a RunnerResult.
 *   I2. Well-formed findings: every emitted diagnostic carries a non-empty
 *       message, an integer line/column >= 1 when present, and a declared
 *       severity tier (never undefined, never an unknown passthrough).
 *   I3. Never clean-on-failure: a nonzero exit WITH emitted bytes must never
 *       produce `succeeded` with zero diagnostics — that reads as "we checked,
 *       it's clean", which is the #1781 usage-text-as-clean-scan bug shape.
 *
 * Where a runner legitimately reports clean on a battery case, the case name
 * must appear in JUSTIFIED_CLEAN_WITH_BYTES below with a reason; the suite
 * fails on unlisted violations so new ones surface instead of silently
 * joining a baseline.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, getLinterPolicyForCwd } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	getLinterPolicyForCwd: vi.fn(),
}));

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

vi.mock("../../../../clients/tool-policy.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getLinterPolicyForCwd,
	markdownlintConfigArgs: () => [],
	hasEslintConfig: () => true,
	hasMypyConfig: () => true,
	hasPhpstanConfig: () => true,
	// Deliberately false on EVERY platform (not a /dev/null accident): the
	// no-config branch is what the battery must exercise, stated as intent.
	hasSqlfluffConfig: () => false,
	hasStylelintConfig: () => true,
	hasYamllintConfig: () => true,
	getAutofixCapability: () => ({
		toolSupportsFix: false,
		safePipelineAutofix: false,
		fixKind: "none",
	}),
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => true,
			isAvailableAsync: async () => true,
			getCommand: () => command,
		}),
		resolveToolCommandWithInstallFallback: async (
			_cwd: string,
			toolId: string,
		) => toolId,
		resolveAvailableOrInstall: async (_cwd: string, toolId: string) => toolId,
		lspPrimaryCoversFile: () => false,
	}),
);

/** Same descriptor set as the captured-real-output replay: every CLI parser. */
const RUNNER_DESCRIPTORS: Record<string, { module: string; kind: string }> = {
	actionlint: { module: "actionlint", kind: "yaml" },
	eslint: { module: "eslint", kind: "jsts" },
	htmlhint: { module: "htmlhint", kind: "html" },
	"biome-check-json": { module: "biome-check", kind: "jsts" },
	hadolint: { module: "hadolint", kind: "docker" },
	markdownlint: { module: "markdownlint", kind: "markdown" },
	mypy: { module: "mypy", kind: "python" },
	oxlint: { module: "oxlint", kind: "jsts" },
	"php-lint": { module: "php-lint", kind: "php" },
	phpstan: { module: "phpstan", kind: "php" },
	pyright: { module: "pyright", kind: "python" },
	"ruff-lint": { module: "ruff", kind: "python" },
	shellcheck: { module: "shellcheck", kind: "shell" },
	shfmt: { module: "shfmt", kind: "shell" },
	spellcheck: { module: "spellcheck", kind: "markdown" },
	sqlfluff: { module: "sqlfluff", kind: "sql" },
	stylelint: { module: "stylelint", kind: "css" },
	taplo: { module: "taplo", kind: "toml" },
	terragrunt: { module: "terragrunt", kind: "terragrunt" },
	tflint: { module: "tflint", kind: "terraform" },
	vale: { module: "vale", kind: "markdown" },
	yamllint: { module: "yamllint", kind: "yaml" },
};

/**
 * The standard battery. Each case feeds EVERY runner through its normal spawn
 * seam regardless of its native format — a TOML parser meeting HTML is the
 * point: the classification invariants are format-blind.
 */
const BATTERY: Array<{
	name: string;
	stdout: string;
	stderr: string;
	exitCode: number;
}> = [
	{ name: "empty-stdout-exit-0", stdout: "", stderr: "", exitCode: 0 },
	{
		name: "whitespace-stdout-exit-0",
		stdout: "   \n\t\n  ",
		stderr: "",
		exitCode: 0,
	},
	{
		// #1781 shape: CLI usage text lands on the FINDINGS stream, exit 0.
		name: "usage-prose-stdout-exit-0",
		stdout:
			"Usage: tool [OPTIONS] <FILE>\nRun 'tool --help' for more information.\n",
		stderr: "",
		exitCode: 0,
	},
	{
		name: "error-prose-stderr-exit-0",
		stdout: "",
		stderr: "Error: something failed unexpectedly\n",
		exitCode: 0,
	},
	{
		name: "error-prose-stderr-exit-1",
		stdout: "",
		stderr: "Error: something failed unexpectedly\n",
		exitCode: 1,
	},
	{
		name: "truncated-json-exit-1",
		stdout: '[{"filePath":"a.ts","messages":[{"ruleId":"no-x"',
		stderr: "",
		exitCode: 1,
	},
	{
		name: "wrong-shape-json-exit-0",
		stdout: '{"total":3,"findings":[],"ok":true}',
		stderr: "",
		exitCode: 0,
	},
	{
		// #1795 family: unknown enum values inside otherwise-valid structure.
		name: "unknown-severity-values",
		stdout:
			'[{"filePath":"a.ts","messages":[{"ruleId":"r","severity":"FATAL","message":"m","line":2,"column":1}]}]',
		stderr: "",
		exitCode: 1,
	},
	{
		// #1810 lesson: optional fields the parser likes to read are ABSENT.
		name: "missing-optional-fields",
		stdout: '[{"filePath":"a.ts","messages":[{"message":"barely anything"}]}]',
		stderr: "",
		exitCode: 1,
	},
	{
		name: "hostile-numbers",
		stdout:
			'[{"filePath":"a.ts","messages":[{"ruleId":"r","severity":2,"message":"m","line":-5,"column":0},{"ruleId":"r","severity":1,"message":"m2","line":99999999999999999,"column":1}]}]',
		stderr: "",
		exitCode: 1,
	},
	{
		name: "html-error-page-exit-1",
		stdout: "<html><head><title>502 Bad Gateway</title></head></html>",
		stderr: "",
		exitCode: 1,
	},
	{
		name: "ansi-prose-exit-1",
		stdout: "\u001b[31mERROR\u001b[0m cannot read config \u001b[0m\n",
		stderr: "",
		exitCode: 1,
	},
];

/**
 * Cases where a runner reporting `succeeded` with zero diagnostics despite
 * nonzero-exit-plus-bytes is DEFENSIBLE, with the reason. Every entry here is
 * a reviewed decision, not a baseline to grow into.
 */
const JUSTIFIED_CLEAN_WITH_BYTES = new Set<string>([
	// Empty by design after the #1839 fix wave: every first-pass violation was
	// FIXED rather than justified, so any future entry here must carry its own
	// reviewed reason and a tracking reference.
]);

/**
 * Spawning runners the battery does NOT fuzz yet, with reasons (#1839).
 *
 * The ratchet below makes this population explicit: a NEW spawning runner
 * fails until it gets a descriptor or an entry here. Burn-down (converting
 * these into descriptors, which means verifying each tool's real exit/output
 * contract first — AGENTS.md shape 16) is #1839's follow-up work.
 */
const BATTERY_EXEMPT: Record<string, string> = {
	"cpp-check.ts": "not yet fuzzed; #1839 burn-down",
	"credo.ts": "not yet fuzzed; #1839 burn-down",
	"cue-vet.ts": "not yet fuzzed; #1839 burn-down",
	"dart-analyze.ts": "not yet fuzzed; #1839 burn-down",
	"detekt.ts": "not yet fuzzed; #1839 burn-down",
	"dotnet-build.ts": "not yet fuzzed; #1839 burn-down",
	"elixir-check.ts": "not yet fuzzed; #1839 burn-down",
	"fish-indent.ts": "not yet fuzzed; #1839 burn-down",
	"gleam-check.ts": "not yet fuzzed; #1839 burn-down",
	"go-vet.ts": "not yet fuzzed; #1839 burn-down",
	"golangci-lint.ts": "not yet fuzzed; #1839 burn-down",
	"helm-lint.ts": "not yet fuzzed; #1839 burn-down",
	"helm-render.ts":
		"renders chart templates - side-effecting argv; needs its own safety review before battery admission",
	"javac.ts": "not yet fuzzed; #1839 burn-down",
	"ktlint.ts": "not yet fuzzed; #1839 burn-down",
	"php-lint.ts": "not yet fuzzed; #1839 burn-down",
	"prisma-validate.ts": "not yet fuzzed; #1839 burn-down",
	"psscriptanalyzer.ts": "not yet fuzzed; #1839 burn-down",
	"rubocop.ts": "not yet fuzzed; #1839 burn-down",
	"ruff.ts": "not yet fuzzed; #1839 burn-down",
	"rust-clippy.ts": "not yet fuzzed; #1839 burn-down",
	"spotbugs.ts":
		"flag-gated via withSpotbugsGroup; needs a gate-open mock before admission",
	"swiftlint.ts": "not yet fuzzed; #1839 burn-down",
	"trivy-config.ts":
		"opt-in via trivy.enabled plus project trust; needs both gates mocked open before admission",
	"zig-check.ts": "not yet fuzzed; #1839 burn-down",
};

const NON_RUNNER_FILES = new Set(["index.ts", "utils.ts"]);

function createCtx(kind: string, filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

const SEVERITY_TIERS = ["error", "warning", "info", "hint"] as const;
const STATUSES = ["succeeded", "failed", "skipped"] as const;
const SEMANTICS = ["blocking", "warning", "fixed", "silent", "none"] as const;

describe("runner-parser garbage battery (#1839)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue(null);
	});

	it("battery is non-trivial", () => {
		expect(BATTERY.length).toBeGreaterThanOrEqual(10);
		expect(Object.keys(RUNNER_DESCRIPTORS).length).toBeGreaterThanOrEqual(15);
	});

	// The self-extending guard (#1839): every runner that spawns a child
	// process must be either FUZZED by this battery or explicitly exempted
	// with a reason. A new spawning runner file fails here until someone makes
	// a deliberate admission decision — the battery cannot silently stop at
	// today's population the way the captured-replay suite once did.
	it("every spawning runner is fuzzed or explicitly exempted", () => {
		const runnersDir = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../../../clients/dispatch/runners",
		);
		const spawning = fs
			.readdirSync(runnersDir)
			.filter((name) => name.endsWith(".ts") && !NON_RUNNER_FILES.has(name))
			.filter((name) => {
				// Same detection idiom as run-outcome-ratchet: any safeSpawn
				// reference means a child process is in play.
				return /safeSpawn/.test(
					fs.readFileSync(path.join(runnersDir, name), "utf8"),
				);
			})
			.map((name) => name.replace(/\.ts$/, ""));

		const unhandled = spawning.filter((id) => {
			if (BATTERY_EXEMPT[`${id}.ts`]) return false;
			// Covered when the id OR the descriptor's module basename matches:
			// some runners are fuzzed under their registered id, which differs
			// from the file name (biome-check.ts → "biome-check-json").
			if (id in RUNNER_DESCRIPTORS) return false;
			return !Object.values(RUNNER_DESCRIPTORS).some((d) => d.module === id);
		});
		expect(
			unhandled,
			`spawning runner(s) missing from the garbage battery — add a RUNNER_DESCRIPTORS entry (and verify its classification invariants hold) or a BATTERY_EXEMPT entry with a reason`,
		).toEqual([]);

		// Reverse check: an exemption or descriptor for a deleted file must be
		// removed, so neither list can accumulate dead entries.
		const onDisk = new Set(spawning);
		const staleExemptions = Object.keys(BATTERY_EXEMPT)
			.map((name) => name.replace(/\.ts$/, ""))
			.filter((id) => !onDisk.has(id));
		expect(
			staleExemptions,
			"BATTERY_EXEMPT entries must exist on disk",
		).toEqual([]);
	});

	for (const [runnerId, descriptor] of Object.entries(RUNNER_DESCRIPTORS)) {
		for (const garbageCase of BATTERY) {
			it(
				`${runnerId} holds classification invariants on ${garbageCase.name}`,
				{ timeout: 30_000 },
				async () => {
					const env = setupTestEnvironment(
						`pi-lens-garbage-${runnerId}-`.replace(/[^a-z0-9-]/gi, ""),
					);
					try {
						const filePath = path.join(env.tmpDir, "victim.txt");
						fs.writeFileSync(filePath, "whatever the tool was pointed at\n");

						safeSpawnAsync.mockResolvedValue({
							error: null,
							status: garbageCase.exitCode,
							stdout: garbageCase.stdout,
							stderr: garbageCase.stderr,
						});

						const runner = (
							await import(
								`../../../../clients/dispatch/runners/${descriptor.module}.js`
							)
						).default;

						// I1: never crash.
						const result = await runner.run(
							createCtx(descriptor.kind, filePath, env.tmpDir) as never,
						);

						// I2a: result shape.
						expect(STATUSES).toContain(result.status);
						expect(SEMANTICS).toContain(result.semantic);
						expect(Array.isArray(result.diagnostics)).toBe(true);

						// I2b: well-formed findings.
						for (const d of result.diagnostics) {
							expect(
								typeof d.message === "string" && d.message.trim().length > 0,
								`${runnerId}/${garbageCase.name}: blank diagnostic message`,
							).toBe(true);
							if (d.line !== undefined) {
								expect(
									Number.isInteger(d.line) && d.line >= 1,
									`${runnerId}/${garbageCase.name}: non-positive line ${d.line}`,
								).toBe(true);
							}
							if (d.column !== undefined) {
								expect(
									Number.isInteger(d.column) && d.column >= 1,
									`${runnerId}/${garbageCase.name}: non-positive column ${d.column}`,
								).toBe(true);
							}
							expect(
								SEVERITY_TIERS,
								`${runnerId}/${garbageCase.name}: undeclared severity "${d.severity}"`,
							).toContain(d.severity);
							expect(
								SEMANTICS.includes(d.semantic as never),
								`${runnerId}/${garbageCase.name}: undeclared diagnostic semantic`,
							).toBe(true);
						}

						// I3: never clean-on-failure (nonzero exit + bytes).
						if (
							garbageCase.exitCode !== 0 &&
							(garbageCase.stdout.length > 0 || garbageCase.stderr.length > 0)
						) {
							const cleanLie =
								result.status === "succeeded" &&
								result.diagnostics.length === 0;
							if (cleanLie) {
								expect(
									JUSTIFIED_CLEAN_WITH_BYTES.has(
										`${runnerId}:${garbageCase.name}`,
									),
									`${runnerId} reported CLEAN (succeeded, 0 findings) on ${garbageCase.name} with exit ${garbageCase.exitCode} and non-empty output — the #1781 shape. Fix the parser or justify it in JUSTIFIED_CLEAN_WITH_BYTES.`,
								).toBe(true);
							}
						}
					} finally {
						env.cleanup();
					}
				},
			);
		}
	}
});

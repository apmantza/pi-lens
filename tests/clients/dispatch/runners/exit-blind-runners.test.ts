import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, getLinterPolicyForCwd } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	getLinterPolicyForCwd: vi.fn(),
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

vi.mock("../../../../clients/tool-policy.js", () => ({
	getLinterPolicyForCwd,
	markdownlintConfigArgs: () => [],
	hasMypyConfig: () => true,
	hasSqlfluffConfig: () => true,
	hasStylelintConfig: () => true,
	hasYamllintConfig: () => true,
	getAutofixCapability: () => ({
		toolSupportsFix: false,
		safePipelineAutofix: false,
		fixKind: "none",
	}),
}));

// #2455 fix round 4, F2: the runner imports the process's ONE `goClient`
// instance from go-client.ts, so the double is the instance, not the class.
vi.mock("../../../../clients/go-client.js", () => ({
	goClient: {
		async findGoPathAsync() {
			return "go";
		},
	},
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => true,
			isAvailableAsync: async () => true,
			getCommand: () => command,
		}),
		resolveToolCommandWithInstallFallback: async (
			_cwd: string,
			toolId: string,
		) => toolId,
	}),
);

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

/**
 * #1816: seven runners read `result.status` ZERO times. Each one turned an
 * empty parse into `succeeded` with no diagnostics, so a tool that rejected its
 * invocation, crashed, or was killed reported the file as CLEAN. Pre-fix every
 * case below returns `succeeded`; post-fix it returns `skipped` and leaves a
 * bounded `runner-empty-result` row naming the tool.
 */
interface Case {
	tool: string;
	module: string;
	kind: string;
	fileName: string;
	content: string;
	/** Extra files the runner's config gate needs. */
	extraFiles?: Record<string, string>;
	/** A nonzero exit that means "this tool never analysed the file". */
	failure: { status: number | null; stdout?: string; stderr?: string };
	/** A nonzero exit that DOES carry findings and must still be parsed. */
	findings: { status: number; stdout?: string; stderr?: string };
}

const CASES: Case[] = [
	{
		tool: "markdownlint",
		module: "markdownlint",
		kind: "markdown",
		fileName: "README.md",
		content: "# Title\n",
		failure: { status: 2, stderr: "Unable to read config file" },
		findings: {
			status: 1,
			stdout: "README.md:1:1 error MD041/first-line-heading Bad heading",
		},
	},
	{
		tool: "mypy",
		module: "mypy",
		kind: "python",
		fileName: "app.py",
		content: "x = 1\n",
		failure: { status: 2, stderr: "mypy: error: Unrecognized option" },
		findings: {
			status: 1,
			stdout: "app.py:1:1: error: Incompatible types [assignment]",
		},
	},
	{
		tool: "sqlfluff",
		module: "sqlfluff",
		kind: "sql",
		fileName: "query.sql",
		content: "select 1;\n",
		failure: { status: 2, stderr: "Error: unknown dialect 'nope'" },
		findings: {
			status: 1,
			stdout: JSON.stringify([
				{
					filepath: "query.sql",
					violations: [
						{ code: "LT01", description: "spacing", line_no: 1, line_pos: 1 },
					],
				},
			]),
		},
	},
	{
		tool: "stylelint",
		module: "stylelint",
		kind: "css",
		fileName: "site.css",
		content: "a { color: red; }\n",
		failure: { status: 78, stderr: "Could not find a config" },
		findings: {
			status: 2,
			stdout: JSON.stringify([
				{
					source: "site.css",
					warnings: [
						{
							line: 1,
							column: 1,
							severity: "warning",
							rule: "color-hex-length",
							text: "shorten hex",
						},
					],
				},
			]),
		},
	},
	{
		tool: "swiftlint",
		module: "swiftlint",
		kind: "swift",
		fileName: "Main.swift",
		content: "let x = 1\n",
		failure: { status: 1, stderr: "Error: No lintable files found" },
		findings: {
			status: 2,
			stdout: JSON.stringify([
				{
					rule_id: "colon",
					reason: "Colons should be next to the identifier",
					line: 1,
					character: 1,
					severity: "Warning",
				},
			]),
		},
	},
	{
		tool: "vale",
		module: "vale",
		kind: "markdown",
		fileName: "doc.md",
		content: "Some prose.\n",
		extraFiles: { ".vale.ini": "StylesPath = styles\n" },
		failure: { status: 1, stderr: "E100 [vale] runtime error" },
		// #1933 review F1: real `vale --output JSON` is a flat map keyed by the
		// linted path, not `{ Data: { Files: [...] } }` -- the shape this fixture
		// used to hand-write, which happened to match the also-wrong parser and
		// so never caught the bug (AGENTS.md defect shape 16 and shape 7:
		// unverified tool-output claim baked into a fixture nobody checked
		// against a real binary). `Span` replaces the nonexistent "Column"
		// field, matching a captured real run (see tests/clients/dispatch/
		// runners/vale.test.ts for the full fixture provenance).
		findings: {
			status: 1,
			stdout: JSON.stringify({
				"doc.md": [
					{
						Line: 1,
						Span: [1, 6],
						Severity: "warning",
						Message: "Wordy",
						Check: "Vale.Terms",
					},
				],
			}),
		},
	},
	{
		tool: "yamllint",
		module: "yamllint",
		kind: "yaml",
		fileName: "config.yaml",
		content: "a: 1\n",
		failure: { status: 2, stderr: "yamllint: error: unrecognized arguments" },
		findings: {
			status: 1,
			stdout: "config.yaml:1:1: [error] too many spaces (colons)",
		},
	},
];

describe("exit-blind runners no longer report a clean file after a failed run", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue(null);
	});

	// `vi.resetModules()` gives each test a FRESH module graph, so the ledger
	// the runner writes to is only the same instance when it is imported from
	// inside the same test. A top-level import would observe a different one.
	async function ledger() {
		const mod = await import("../../../../clients/degradation-ledger.js");
		mod.resetDegradationLedger();
		return mod;
	}

	for (const testCase of CASES) {
		it(`${testCase.tool} skips and records a ledger row when the tool never ran`, async () => {
			const env = setupTestEnvironment(`pi-lens-${testCase.tool}-`);
			try {
				const summary = await ledger();
				for (const [name, body] of Object.entries(testCase.extraFiles ?? {})) {
					fs.writeFileSync(path.join(env.tmpDir, name), body);
				}
				const filePath = path.join(env.tmpDir, testCase.fileName);
				fs.writeFileSync(filePath, testCase.content);
				safeSpawnAsync.mockResolvedValue({
					stdout: testCase.failure.stdout ?? "",
					stderr: testCase.failure.stderr ?? "",
					status: testCase.failure.status,
				});

				const runner = (
					await import(
						`../../../../clients/dispatch/runners/${testCase.module}.js`
					)
				).default;
				const result = await runner.run(
					createCtx(testCase.kind, filePath, env.tmpDir) as never,
				);

				expect(result.status).toBe("skipped");
				expect(result.diagnostics).toEqual([]);

				const group = summary
					.getDegradationSummary()
					.find((entry) => entry.kind === "runner-empty-result");
				expect(
					group,
					"expected a runner-empty-result ledger row",
				).toBeDefined();
				const row = group?.latestReasons.find(
					(e) => e.subject === testCase.tool,
				);
				expect(row, `expected a ledger row for ${testCase.tool}`).toBeDefined();
				expect(row?.reason).toContain(testCase.tool);
				expect(row?.reason).toContain(String(testCase.failure.status));
			} finally {
				env.cleanup();
			}
		});

		it(`${testCase.tool} still parses findings that arrive with a nonzero exit`, async () => {
			const env = setupTestEnvironment(`pi-lens-${testCase.tool}-`);
			try {
				await ledger();
				for (const [name, body] of Object.entries(testCase.extraFiles ?? {})) {
					fs.writeFileSync(path.join(env.tmpDir, name), body);
				}
				const filePath = path.join(env.tmpDir, testCase.fileName);
				fs.writeFileSync(filePath, testCase.content);
				safeSpawnAsync.mockResolvedValue({
					stdout: testCase.findings.stdout ?? "",
					stderr: testCase.findings.stderr ?? "",
					status: testCase.findings.status,
				});

				const runner = (
					await import(
						`../../../../clients/dispatch/runners/${testCase.module}.js`
					)
				).default;
				const result = await runner.run(
					createCtx(testCase.kind, filePath, env.tmpDir) as never,
				);

				expect(result.status).not.toBe("skipped");
				expect(result.diagnostics.length).toBeGreaterThan(0);
			} finally {
				env.cleanup();
			}
		});

		it(`${testCase.tool} names the signal when the tool is killed`, async () => {
			const env = setupTestEnvironment(`pi-lens-${testCase.tool}-`);
			try {
				const summary = await ledger();
				for (const [name, body] of Object.entries(testCase.extraFiles ?? {})) {
					fs.writeFileSync(path.join(env.tmpDir, name), body);
				}
				const filePath = path.join(env.tmpDir, testCase.fileName);
				fs.writeFileSync(filePath, testCase.content);
				safeSpawnAsync.mockResolvedValue({
					stdout: "",
					stderr: "",
					status: null,
					signal: "SIGKILL",
					failure: "signal",
					error: new Error("Process killed by signal: SIGKILL"),
				});

				const runner = (
					await import(
						`../../../../clients/dispatch/runners/${testCase.module}.js`
					)
				).default;
				const result = await runner.run(
					createCtx(testCase.kind, filePath, env.tmpDir) as never,
				);

				expect(result.status).toBe("skipped");
				const group = summary
					.getDegradationSummary()
					.find((entry) => entry.kind === "runner-empty-result");
				const row = group?.latestReasons.find(
					(e) => e.subject === testCase.tool,
				);
				expect(row?.reason).toContain("SIGKILL");
			} finally {
				env.cleanup();
			}
		});
	}

	// Blast radius: a permanently broken tool must cost ONE ledger row, not one
	// per dispatched file.
	it("keeps one bounded row per tool across repeated failures", async () => {
		const env = setupTestEnvironment("pi-lens-yamllint-bound-");
		try {
			const summary = await ledger();
			const filePath = path.join(env.tmpDir, "config.yaml");
			fs.writeFileSync(filePath, "a: 1\n");
			safeSpawnAsync.mockResolvedValue({
				stdout: "",
				stderr: "yamllint: error: unrecognized arguments",
				status: 2,
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/yamllint.js")
			).default;
			for (let i = 0; i < 25; i += 1) {
				await runner.run(createCtx("yaml", filePath, env.tmpDir) as never);
			}
			const group = summary
				.getDegradationSummary()
				.find((entry) => entry.kind === "runner-empty-result");
			expect(
				group?.latestReasons.filter((e) => e.subject === "yamllint"),
			).toHaveLength(1);
			expect(group?.count).toBe(25);
			expect(
				group?.latestReasons.find((e) => e.subject === "yamllint")?.reason,
			).toContain("(count: 25)");
		} finally {
			env.cleanup();
		}
	});
	// #1822 review F1 (live-verified, mypy 2.3.1): mypy reports a SOURCE SYNTAX
	// error under exit 2 and still writes a normal parsable diagnostic to
	// stdout. A table that called 2 a rejected invocation dropped that
	// diagnostic and mislabeled a genuine finding in the ledger. The exit code
	// cannot separate a bad flag from a syntax error; the stream can.
	it("mypy keeps an exit-2 SYNTAX diagnostic that lands on stdout", async () => {
		const env = setupTestEnvironment("pi-lens-mypy-syntax-");
		try {
			await ledger();
			const filePath = path.join(env.tmpDir, "syn.py");
			fs.writeFileSync(filePath, "def (:\n");
			safeSpawnAsync.mockResolvedValue({
				// Verbatim live mypy 2.3.1 output for a source syntax error.
				stdout: "syn.py:1: error: Invalid syntax  [syntax]\n",
				stderr: "",
				status: 2,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/mypy.js")
			).default;
			const result = await runner.run(
				createCtx("python", filePath, env.tmpDir) as never,
			);

			expect(result.status).not.toBe("skipped");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].rule).toBe("syntax");
		} finally {
			env.cleanup();
		}
	});

	// #1822 review F2: two runners the first round classified as "correct
	// today" were the same defect spelled differently.
	it("spellcheck skips when typos-cli errors with an empty stdout", async () => {
		const env = setupTestEnvironment("pi-lens-spellcheck-");
		try {
			const summary = await ledger();
			const filePath = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(filePath, "Teh quick brown fox.\n");
			safeSpawnAsync.mockResolvedValue({
				stdout: "",
				stderr: "error: failed to read config: unexpected key `nope`",
				status: 1,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/spellcheck.js")
			).default;
			const result = await runner.run(
				createCtx("markdown", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			const row = summary
				.getDegradationSummary()
				.find((entry) => entry.kind === "runner-empty-result")
				?.latestReasons.find((e) => e.subject === "spellcheck");
			expect(row?.reason).toContain("spellcheck");
			expect(row?.reason).toContain("1");
		} finally {
			env.cleanup();
		}
	});

	it("spellcheck still parses typos found under exit 2", async () => {
		const env = setupTestEnvironment("pi-lens-spellcheck-");
		try {
			await ledger();
			const filePath = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(filePath, "Teh quick brown fox.\n");
			safeSpawnAsync.mockResolvedValue({
				stdout: JSON.stringify({
					type: "typo",
					path: "notes.md",
					line_num: 1,
					byte_offset: 0,
					typo: "Teh",
					corrections: ["The"],
				}),
				stderr: "",
				status: 2,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/spellcheck.js")
			).default;
			const result = await runner.run(
				createCtx("markdown", filePath, env.tmpDir) as never,
			);

			expect(result.status).not.toBe("skipped");
			expect(result.diagnostics.length).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	it("go-vet skips when the go toolchain never vetted anything", async () => {
		const env = setupTestEnvironment("pi-lens-go-vet-");
		try {
			const summary = await ledger();
			const filePath = path.join(env.tmpDir, "main.go");
			fs.writeFileSync(filePath, "package main\n");
			safeSpawnAsync.mockResolvedValue({
				stdout: "",
				stderr:
					"go: go.mod file not found in current directory or any parent directory; see 'go help modules'\n",
				status: 1,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/go-vet.js")
			).default;
			const result = await runner.run(
				createCtx("go", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			const row = summary
				.getDegradationSummary()
				.find((entry) => entry.kind === "runner-empty-result")
				?.latestReasons.find((e) => e.subject === "go-vet");
			expect(row?.reason).toContain("go.mod file not found");
		} finally {
			env.cleanup();
		}
	});

	it("go-vet still parses real vet findings under a nonzero exit", async () => {
		const env = setupTestEnvironment("pi-lens-go-vet-");
		try {
			await ledger();
			const filePath = path.join(env.tmpDir, "main.go");
			fs.writeFileSync(filePath, "package main\n");
			safeSpawnAsync.mockResolvedValue({
				stdout: "",
				stderr: `${filePath}:1:1: Printf format %d has arg s of wrong type string\n`,
				status: 1,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/go-vet.js")
			).default;
			const result = await runner.run(
				createCtx("go", filePath, env.tmpDir) as never,
			);

			expect(result.status).not.toBe("skipped");
			expect(result.diagnostics.length).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { capKilledSpawnResult } from "../support/spawn-shapes.js";
import { removeTempDirSync } from "./test-utils.js";

// All hoisted: importing `spawn-shapes.js` below reaches the mocked safe-spawn
// module, so every mock factory here runs during the import phase — a plain
// `const` would still be in its temporal dead zone when it does.
const { safeSpawnAsync, safeSpawn, getSgCommand, ensureTool } = vi.hoisted(
	() => ({
		safeSpawnAsync: vi.fn(),
		safeSpawn: vi.fn(),
		getSgCommand: vi.fn(),
		ensureTool: vi.fn(),
	}),
);

// `importOriginal`, not a bare stub: the cap-kill tests build the REAL
// truncation result, and that needs safe-spawn's own `SpawnFailureError`.
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
	safeSpawn,
}));
vi.mock("../../clients/installer/index.js", () => ({
	ensureTool,
	// #1500: the durable-absence arm reads the installer's own attempt record to
	// tell an attempt that failed from one that never ran.
	getInstallAttempt: vi.fn(() => undefined),
}));
vi.mock("../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	getSgCommand,
	resolveManagedToolClient: vi.fn(async ({ acceptInstalled }) => {
		const installed = await ensureTool("ast-grep");
		if (!installed) return { outcome: "missing" };
		const value = await acceptInstalled(installed);
		return value === null
			? { outcome: "non-installable" }
			: { outcome: "success", value };
	}),
}));

describe("SgRunner", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			error: new Error("not found"),
			stdout: "",
			stderr: "",
		});
		safeSpawn.mockReturnValue({
			status: 0,
			stdout: "",
			stderr: "",
			error: undefined,
		});
		getSgCommand.mockReturnValue({ cmd: "ast-grep", args: [] });
		ensureTool.mockResolvedValue(null);
	});

	describe("spawn-failure taxonomy consumption (#1214/#1199)", () => {
		it("cwd-unresolvable with an ENOENT cause is NOT unavailable and does NOT reinstall", async () => {
			const enoent = Object.assign(new Error("spawn ast-grep ENOENT"), {
				code: "ENOENT",
			});
			safeSpawnAsync.mockResolvedValue({
				status: null,
				error: enoent,
				failure: "spawn",
				spawnFailure: { kind: "cwd-unresolvable", cause: enoent },
				stdout: "",
				stderr: "",
			});
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const result = await runner.execRaw(["run", "--pattern", "x"]);
			// A raw `error.code === "ENOENT"` consumer regression maps this to
			// unavailable and drives the #1199 reinstall loop — both must stay off.
			expect(result.failure).not.toBe("unavailable");
			expect(ensureTool).not.toHaveBeenCalled();
		});
	});

	describe("ensureAvailable()", () => {
		it("returns true when ast-grep is in PATH", async () => {
			safeSpawnAsync.mockResolvedValueOnce({
				status: 0,
				error: null,
				stdout: "ast-grep 0.42.1",
				stderr: "",
			});
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const result = await runner.ensureAvailable();
			expect(result).toBe(true);
		});

		it("rejects Linux group-switch sg and returns false when fallbacks fail", async () => {
			safeSpawnAsync
				.mockResolvedValueOnce({
					status: 1,
					error: new Error("not found"),
					stdout: "",
					stderr: "",
				})
				.mockResolvedValueOnce({
					status: 0,
					error: null,
					stdout: "sg from util-linux 2.39",
					stderr: "",
				})
				.mockResolvedValueOnce({
					status: 1,
					error: new Error("not found"),
					stdout: "",
					stderr: "",
				});
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const result = await runner.ensureAvailable();
			expect(result).toBe(false);
			expect(ensureTool).toHaveBeenCalledWith("ast-grep");
		});

		it("returns false when ast-grep not found and installer fails", async () => {
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const result = await runner.ensureAvailable();
			expect(result).toBe(false);
		});

		it("caches true result on second call", async () => {
			safeSpawnAsync.mockResolvedValue({
				status: 0,
				error: null,
				stdout: "ast-grep 0.42.1",
				stderr: "",
			});
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			await runner.ensureAvailable();
			await runner.ensureAvailable();
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		});

		it("dedupes concurrent first-time callers to a single probe (#113)", async () => {
			let resolveProbe: ((value: unknown) => void) | undefined;
			safeSpawnAsync.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveProbe = resolve;
					}),
			);
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const a = runner.ensureAvailable();
			const b = runner.ensureAvailable();
			const c = runner.ensureAvailable();
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
			resolveProbe?.({
				status: 0,
				error: null,
				stdout: "ast-grep 0.42.1",
				stderr: "",
			});
			const results = await Promise.all([a, b, c]);
			expect(results).toEqual([true, true, true]);
			// Cache is now hot — additional calls don't even reach safeSpawnAsync.
			await runner.ensureAvailable();
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		});

		it("does not re-serve a retained ast-grep winner this sweep just proved durably missing (#1593)", async () => {
			try {
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(new Date(1_700_000_000_000));

				const { SgRunner } = await import("../../clients/sg-runner.js");
				const runner = new SgRunner();

				// Sweep 1: the direct candidates (ast-grep, sg) stall (transient);
				// the npx fallback answers, so the win is provisional and memoized
				// as the npx command.
				safeSpawnAsync.mockImplementation(async (cmd: string) => {
					if (cmd === "npx") {
						return {
							status: 0,
							error: null,
							stdout: "ast-grep 0.42.1",
							stderr: "",
						};
					}
					return {
						status: null,
						error: undefined,
						stdout: "",
						stderr: "",
						failure: "timeout" as const,
						spawnFailure: { kind: "timeout" as const },
					};
				});
				expect(await runner.ensureAvailable()).toBe(true);

				// Let the provisional cooldown expire so the next call re-sweeps
				// instead of serving the memoized verdict straight from the latch.
				vi.setSystemTime(new Date(Date.now() + 301_000));

				// Sweep 2: the memoized winner (npx) now ENOENTs — durably missing —
				// while ast-grep/sg merely stall again. The retained arm must NOT
				// re-serve the dead `npx` command just because a sibling stalled in
				// the same sweep.
				safeSpawnAsync.mockImplementation(async (cmd: string) => {
					if (cmd === "npx") {
						return {
							status: null,
							error: Object.assign(new Error("npx ENOENT"), { code: "ENOENT" }),
							stdout: "",
							stderr: "",
							failure: "spawn" as const,
							spawnFailure: { kind: "tool-not-found" as const },
						};
					}
					return {
						status: null,
						error: undefined,
						stdout: "",
						stderr: "",
						failure: "timeout" as const,
						spawnFailure: { kind: "timeout" as const },
					};
				});
				expect(await runner.ensureAvailable()).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("tempScanAsync()", () => {
		it("passes centralized gitignore globs to ast-grep scan", async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sg-ignore-"));
			try {
				fs.writeFileSync(path.join(root, ".gitignore"), "/profiles/\n*.snap\n");
				safeSpawnAsync.mockResolvedValueOnce({
					status: 0,
					error: null,
					stdout: "[]",
					stderr: "",
				});

				const { SgRunner } = await import("../../clients/sg-runner.js");
				const runner = new SgRunner();
				await runner.tempScanAsync(
					root,
					"find",
					"id: find\nrule: { kind: function_declaration }\n",
				);

				const args = safeSpawnAsync.mock.calls[0][1] as string[];
				expect(args).toContain("--globs");
				expect(args).toContain("!profiles/**");
				expect(args).toContain("!**/*.snap");
			} finally {
				removeTempDirSync(root);
			}
		});

		it("reports invalid generated-rule CLI output instead of an empty success", async () => {
			const root = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-sg-invalid-"),
			);
			try {
				safeSpawnAsync.mockResolvedValueOnce({
					status: 8,
					error: undefined,
					stdout: "",
					stderr: "invalid node kind: definitely_not_a_kind",
				});
				const { SgRunner } = await import("../../clients/sg-runner.js");
				const result = await new SgRunner().tempScanDetailedAsync(
					root,
					"bad",
					"id: bad\nlanguage: TypeScript\nrule: { kind: definitely_not_a_kind }\n",
				);

				expect(result.matches).toEqual([]);
				expect(result.failure).toBe("cli-failure");
				expect(result.error).toContain("invalid node kind");
			} finally {
				removeTempDirSync(root);
			}
		});

		it("treats status-1 with valid JSON matches as success (severity:error linter contract)", async () => {
			// #1087 P1 regression: ast-grep's linter-style contract — a rule with
			// `severity: error` that MATCHES exits 1 with valid JSON matches on
			// stdout and stderr "Scan succeeded and found error level diagnostics".
			// The old code only exempted status-1 with NO output, so real matches
			// were dropped as a cli-failure. Verified first-hand against the bundled
			// ast-grep 0.45.0 binary during the fix.
			const root = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-sg-err-sev-"),
			);
			try {
				const matchJson = JSON.stringify([
					{
						file: path.join(root, "target.js"),
						range: {
							start: { line: 0, column: 0 },
							end: { line: 0, column: 7 },
						},
						text: "eval(x)",
						ruleId: "no-eval-test",
						severity: "error",
					},
				]);
				safeSpawnAsync.mockResolvedValueOnce({
					status: 1,
					error: undefined,
					stdout: matchJson,
					stderr:
						"Error: 1 error(s) found in code.\nHelp: Scan succeeded and found error level diagnostics in the codebase.",
				});
				const { SgRunner } = await import("../../clients/sg-runner.js");
				const result = await new SgRunner().tempScanDetailedAsync(
					root,
					"no-eval-test",
					"id: no-eval-test\nlanguage: JavaScript\nseverity: error\nrule: { pattern: eval($ARG) }\n",
				);

				expect(result.matches).toHaveLength(1);
				expect(result.matches[0].ruleId).toBe("no-eval-test");
				expect(result.failure).toBeUndefined();
				expect(result.error).toBeUndefined();
			} finally {
				removeTempDirSync(root);
			}
		});

		it("rejects a status-1 JSON scalar/null stdout as a failure (no phantom match)", async () => {
			// tryParseSgMatches only accepts an array or object — a JSON scalar
			// (e.g. an error report serialized as `null`) must not become a match.
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sg-scalar-"));
			try {
				safeSpawnAsync.mockResolvedValueOnce({
					status: 1,
					error: undefined,
					stdout: "null",
					stderr: "Error: scan aborted",
				});
				const { SgRunner } = await import("../../clients/sg-runner.js");
				const result = await new SgRunner().tempScanDetailedAsync(
					root,
					"scalar",
					"id: scalar\nlanguage: TypeScript\nrule: { kind: function_declaration }\n",
				);

				expect(result.matches).toEqual([]);
				expect(result.failure).toBe("cli-failure");
			} finally {
				removeTempDirSync(root);
			}
		});

		it("keeps status-1 with stderr but unparseable stdout as a failure", async () => {
			// The complement of the case above: a nonzero status whose stdout is
			// NOT valid JSON is a real CLI diagnostic, not a match set.
			const root = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-sg-err-bad-"),
			);
			try {
				safeSpawnAsync.mockResolvedValueOnce({
					status: 1,
					error: undefined,
					stdout: "not json at all",
					stderr: "Error: something went wrong",
				});
				const { SgRunner } = await import("../../clients/sg-runner.js");
				const result = await new SgRunner().tempScanDetailedAsync(
					root,
					"bad",
					"id: bad\nlanguage: TypeScript\nrule: { kind: function_declaration }\n",
				);

				expect(result.matches).toEqual([]);
				expect(result.failure).toBe("cli-failure");
				expect(result.error).toContain("something went wrong");
			} finally {
				removeTempDirSync(root);
			}
		});

		it("preserves status-one empty output as a genuine no-match", async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sg-empty-"));
			try {
				safeSpawnAsync.mockResolvedValueOnce({
					status: 1,
					error: undefined,
					stdout: "",
					stderr: "",
				});
				const { SgRunner } = await import("../../clients/sg-runner.js");
				const result = await new SgRunner().tempScanDetailedAsync(
					root,
					"empty",
					"id: empty\nrule: { kind: function_declaration }\n",
				);

				expect(result.matches).toEqual([]);
				expect(result.failure).toBeUndefined();
				expect(result.error).toBeUndefined();
			} finally {
				removeTempDirSync(root);
			}
		});
	});

	describe("formatMatches()", () => {
		it("includes [Language] suffix in formatMatches when language field is present", async () => {
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const matches = [
				{
					file: "src/foo.ts",
					range: {
						start: { line: 0, column: 0 },
						end: { line: 0, column: 10 },
					},
					text: "console.log(x)",
					language: "TypeScript",
				},
			];
			const output = runner.formatMatches(matches as any);
			expect(output).toContain("[TypeScript]");
			expect(output).toContain("src/foo.ts:1:1");
		});

		it("omits language suffix when language field is absent", async () => {
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const matches = [
				{
					file: "src/foo.ts",
					range: {
						start: { line: 0, column: 0 },
						end: { line: 0, column: 10 },
					},
					text: "console.log(x)",
				},
			];
			const output = runner.formatMatches(matches as any);
			expect(output).not.toContain("[");
		});

		it("shows metavar captures below match line", async () => {
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const matches = [
				{
					file: "src/foo.ts",
					range: {
						start: { line: 0, column: 0 },
						end: { line: 0, column: 20 },
					},
					text: "console.log(msg)",
					language: "TypeScript",
					metaVariables: {
						single: {
							MSG: {
								text: "msg",
								range: {
									start: { line: 0, column: 12 },
									end: { line: 0, column: 15 },
								},
							},
						},
						multi: {},
						transformed: {},
					},
				},
			];
			const output = runner.formatMatches(matches as any);
			expect(output).toContain("[TypeScript]");
			expect(output).toContain("$MSG=msg");
		});
	});

	describe("tempScanWithFixAsync() — apply reports the pre-apply match count", () => {
		it("counts what was changed even though the rule no longer matches post-apply", async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sg-apply-"));
			try {
				const oneMatch = JSON.stringify([
					{
						file: path.join(root, "a.ts"),
						range: {
							start: { line: 0, column: 0 },
							end: { line: 0, column: 5 },
						},
						text: "var x",
					},
				]);
				// Real-world semantics: once --update-all rewrites the file the rule
				// stops matching, so a json pass AFTER apply returns zero. The mock
				// encodes that ordering dependency — the count pass must run first.
				let applied = false;
				const jsonAppliedState: boolean[] = [];
				safeSpawnAsync.mockImplementation(
					async (_cmd: string, args: string[]) => {
						if (args.includes("--update-all")) {
							applied = true;
							return { status: 0, error: null, stdout: "", stderr: "" };
						}
						if (args.includes("--json")) {
							jsonAppliedState.push(applied);
							return {
								status: 0,
								error: null,
								stdout: applied ? "[]" : oneMatch,
								stderr: "",
							};
						}
						return { status: 0, error: null, stdout: "", stderr: "" };
					},
				);

				const { SgRunner } = await import("../../clients/sg-runner.js");
				const runner = new SgRunner();
				const result = await runner.tempScanWithFixAsync(
					root,
					"agent-rule",
					"id: agent-rule\nrule: { pattern: var $X }\nfix: let $X\n",
					true,
				);

				// The count (json) pass must run BEFORE --update-all so it still
				// sees the match. The old code ran it after and reported zero.
				expect(jsonAppliedState).toEqual([false]);
				expect(result.error).toBeUndefined();
				expect(result.matches).toHaveLength(1);
			} finally {
				removeTempDirSync(root);
			}
		});

		it("dry-run (applyFixes=false) never writes — no --update-all", async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sg-dry-"));
			try {
				safeSpawnAsync.mockResolvedValue({
					status: 0,
					error: null,
					stdout: "[]",
					stderr: "",
				});
				const { SgRunner } = await import("../../clients/sg-runner.js");
				const runner = new SgRunner();
				await runner.tempScanWithFixAsync(
					root,
					"agent-rule",
					"id: agent-rule\nrule: { pattern: var $X }\nfix: let $X\n",
					false,
				);
				const allArgs = safeSpawnAsync.mock.calls.flatMap(
					(c) => c[1] as string[],
				);
				expect(allArgs).not.toContain("--update-all");
			} finally {
				removeTempDirSync(root);
			}
		});
	});

	describe("exec() honors the status-1-with-matches linter contract (#1087)", () => {
		it("parses matches when a severity:error rule exits 1 with JSON stdout", async () => {
			const matchJson = JSON.stringify([
				{
					file: "src/a.js",
					range: {
						start: { line: 0, column: 0 },
						end: { line: 0, column: 7 },
					},
					text: "eval(x)",
				},
			]);
			safeSpawnAsync.mockResolvedValueOnce({
				status: 1,
				error: undefined,
				stdout: matchJson,
				stderr: "Scan succeeded and found error level diagnostics",
			});
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const result = await new SgRunner().exec(["scan", "--json", "."]);
			expect(result.matches).toHaveLength(1);
			expect(result.totalMatches).toBe(1);
			expect(result.error).toBeUndefined();
		});

		it("still reports a failure when status-1 stdout is not JSON", async () => {
			safeSpawnAsync.mockResolvedValueOnce({
				status: 1,
				error: undefined,
				stdout: "garbage",
				stderr: "Error: bad rule",
			});
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const result = await new SgRunner().exec(["scan", "--json", "."]);
			expect(result.matches).toEqual([]);
			expect(result.error).toContain("bad rule");
		});

		it("reports a failure for exit 2 even when stdout parses as match JSON", async () => {
			// Only exit 1 carries the "scan succeeded with findings" linter
			// contract — any other nonzero exit is a real CLI failure and must
			// NOT be laundered into matches, however plausible stdout looks.
			safeSpawnAsync.mockResolvedValueOnce({
				status: 2,
				error: undefined,
				stdout: JSON.stringify([
					{
						file: "src/a.js",
						range: {
							start: { line: 0, column: 0 },
							end: { line: 0, column: 7 },
						},
						text: "eval(x)",
					},
				]),
				stderr: "Error: invalid scan configuration",
			});
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const result = await new SgRunner().exec(["scan", "--json", "."]);
			expect(result.matches).toEqual([]);
			expect(result.error).toContain("invalid scan configuration");
		});

		it("treats truncated status-1 stdout as a failure, not as matches", async () => {
			// A truncated JSON payload may still happen to parse (e.g. cut
			// exactly at a match boundary) — the truncation flag must veto it.
			safeSpawnAsync.mockResolvedValueOnce({
				status: 1,
				error: undefined,
				stdout: JSON.stringify([
					{
						file: "src/a.js",
						range: {
							start: { line: 0, column: 0 },
							end: { line: 0, column: 7 },
						},
						text: "eval(x)",
					},
				]),
				stderr: "Scan succeeded and found error level diagnostics",
				outputTruncated: true,
			});
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const result = await new SgRunner().exec(["scan", "--json", "."]);
			expect(result.matches).toEqual([]);
			expect(result.error).toBeDefined();
		});

		// #2100: the cap kill is OUR SIGTERM, so a truncated run also looks like
		// a killed spawn. Read after the failure gate, these guards could only
		// ever describe a tool that exited before the signal reached it.
		it("names the truncation, not a CLI failure, when the output cap killed the exec", async () => {
			safeSpawnAsync.mockResolvedValueOnce(
				capKilledSpawnResult({ stdout: '[{"file":"src/a.js"' }),
			);
			const { SgRunner } = await import("../../clients/sg-runner.js");

			const result = await new SgRunner().exec(["scan", "--json", "."]);

			expect(result.matches).toEqual([]);
			expect(result.error).toContain("truncated");
		});

		// #2100 review F5: the invariant this PR writes into AGENTS.md says every
		// maxOutputBytes is pinned by a test. These four are the rest of the tree.
		it.each([
			[
				"execRaw",
				(runner: { execRaw: (args: string[]) => Promise<unknown> }) =>
					runner.execRaw(["run", "-p", "x", "--lang", "ts", "."]),
			],
			[
				"exec",
				(runner: { exec: (args: string[]) => Promise<unknown> }) =>
					runner.exec(["scan", "--json", "."]),
			],
			[
				"tempScanDetailedAsync",
				(runner: {
					tempScanDetailedAsync: (
						dir: string,
						id: string,
						yaml: string,
					) => Promise<unknown>;
				}) => runner.tempScanDetailedAsync(os.tmpdir(), "r", "id: r\n"),
			],
			[
				"tempScanWithFixAsync",
				(runner: {
					tempScanWithFixAsync: (
						dir: string,
						id: string,
						yaml: string,
						apply: boolean,
					) => Promise<unknown>;
				}) => runner.tempScanWithFixAsync(os.tmpdir(), "r", "id: r\n", false),
			],
		])(
			"caps %s output so its truncation guard can fire",
			async (_name, call) => {
				safeSpawnAsync.mockResolvedValue({
					status: 0,
					stdout: "[]",
					stderr: "",
					error: undefined,
				});
				const { SgRunner } = await import("../../clients/sg-runner.js");

				// biome-ignore lint/suspicious/noExplicitAny: one shared arrow per row
				await call(new SgRunner() as any);

				expect(safeSpawnAsync).toHaveBeenCalledWith(
					expect.any(String),
					expect.any(Array),
					expect.objectContaining({ maxOutputBytes: 8 * 1024 * 1024 }),
				);
			},
		);

		it("names the truncation, not a CLI failure, when the output cap killed a scan", async () => {
			safeSpawnAsync.mockResolvedValueOnce(
				capKilledSpawnResult({ stdout: '[{"file":"src/a.js"' }),
			);
			const { SgRunner } = await import("../../clients/sg-runner.js");

			const result = await new SgRunner().tempScanDetailedAsync(
				os.tmpdir(),
				"agent-rule",
				"id: x\nlanguage: TypeScript\nrule: { kind: call_expression }",
			);

			expect(result.matches).toEqual([]);
			expect(result.failure).toBe("parse-failure");
			expect(result.error).toContain("truncated");
		});
	});

	describe("buildBashRunArgs (Git Bash exec path — injection safety, code-scanning #12)", () => {
		it("passes cmd + args as positional params with a constant -c script", async () => {
			const { buildBashRunArgs } = await import("../../clients/sg-runner.js");
			expect(
				buildBashRunArgs("ast-grep", ["run", "-p", "console.log($MSG)"]),
			).toEqual([
				"-c",
				'"$0" "$@"',
				"ast-grep",
				"run",
				"-p",
				"console.log($MSG)",
			]);
		});

		it("never interpolates the command path into the script (no env-path injection)", async () => {
			const { buildBashRunArgs } = await import("../../clients/sg-runner.js");
			// A hostile env-derived path stays argv[0] verbatim — not part of the
			// `-c` string — so the shell cannot evaluate it.
			const evil = "/tmp/$(touch pwned)/ast-grep";
			const argv = buildBashRunArgs(evil, ["-p", "x"]);
			expect(argv[1]).toBe('"$0" "$@"'); // script is a constant
			expect(argv[2]).toBe(evil); // path is a discrete positional arg
			expect(argv[1]).not.toContain("$("); // never concatenated into the script
		});

		it("keeps $-metavariable patterns as a single literal arg (not shell-expanded)", async () => {
			const { buildBashRunArgs } = await import("../../clients/sg-runner.js");
			const argv = buildBashRunArgs("sg", ["-p", "$A && $B || $$$REST"]);
			expect(argv).toContain("$A && $B || $$$REST");
		});
	});

	// #533 — the pidusage bug class: a SYNCHRONOUS `spawn()` throw inside
	// `exec()`'s Promise executor (Windows `spawn UNKNOWN`/EINVAL) must not
	// reject/crash the host — `exec` is contracted to always resolve with an
	// `error`, exactly like an asynchronously-emitted spawn `'error'` event.
	describe("exec() contains a synchronous spawn throw (#533)", () => {
		it("resolves gracefully instead of rejecting when spawn throws sync", async () => {
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			// A NUL byte in an argv element makes Node's real `spawn()` throw
			// SYNCHRONOUSLY (ERR_INVALID_ARG_VALUE) from inside the executor — the
			// same detached-throw shape as the Windows `spawn UNKNOWN` failure.
			(runner as unknown as { sgCommand: string }).sgCommand = process.execPath;
			(runner as unknown as { sgArgsPrefix: string[] }).sgArgsPrefix = [
				String.fromCharCode(0), // NUL byte -> spawn() throws synchronously
			];

			// Must RESOLVE (never reject); the failure surfaces in `error`.
			const result = await runner.exec(["-p", "x"]);
			expect(result.matches).toEqual([]);
			expect(result.error).toBeTruthy();
		});
	});
});

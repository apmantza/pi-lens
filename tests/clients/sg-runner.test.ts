import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const getSgCommand = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/installer/index.js", () => ({ ensureTool }));
vi.mock("../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	getSgCommand,
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
				fs.rmSync(root, { recursive: true, force: true });
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
					range: { start: { line: 0, column: 0 }, end: { line: 0, column: 10 } },
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
					range: { start: { line: 0, column: 0 }, end: { line: 0, column: 10 } },
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
					range: { start: { line: 0, column: 0 }, end: { line: 0, column: 20 } },
					text: "console.log(msg)",
					language: "TypeScript",
					metaVariables: {
						single: { MSG: { text: "msg", range: { start: { line: 0, column: 12 }, end: { line: 0, column: 15 } } } },
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
				fs.rmSync(root, { recursive: true, force: true });
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
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	});

	describe("buildBashRunArgs (Git Bash exec path — injection safety, code-scanning #12)", () => {
		it("passes cmd + args as positional params with a constant -c script", async () => {
			const { buildBashRunArgs } = await import("../../clients/sg-runner.js");
			expect(
				buildBashRunArgs("ast-grep", ["run", "-p", "console.log($MSG)"]),
			).toEqual(["-c", '"$0" "$@"', "ast-grep", "run", "-p", "console.log($MSG)"]);
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
});

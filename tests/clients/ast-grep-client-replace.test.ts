import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AstGrepClient } from "../../clients/ast-grep-client.js";

/** Build a client whose private SgRunner is replaced with a stubbed exec. */
function clientWithExec(
	exec: (args: string[], options?: { signal?: AbortSignal }) => unknown,
): AstGrepClient {
	const client = new AstGrepClient();
	(client as unknown as { runner: { exec: typeof exec } }).runner = { exec };
	return client;
}

function clientWithValidationRunner(runner: {
	execRaw?: (args: string[]) => unknown;
	tempScanAsync?: (...args: unknown[]) => unknown;
	tempScanDetailedAsync?: (...args: unknown[]) => unknown;
	tempScanWithFixAsync?: (...args: unknown[]) => unknown;
}): AstGrepClient {
	const client = new AstGrepClient();
	(client as unknown as { runner: typeof runner }).runner = runner;
	return client;
}

const SAMPLE_MATCH = {
	file: "a.ts",
	range: { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
	text: "var x",
};

describe("AstGrepClient.replace() — apply reports the pre-apply match count", () => {
	it("returns the matches captured before --update-all (not a post-apply rewrite search)", async () => {
		// Real-world semantics: the original pattern matches once on the dry-run
		// pre-check; after --update-all rewrites the file, searching for the
		// REWRITE as a pattern (the old codepath) would return 0 — a false
		// "no matches found" on a successful apply.
		const exec = vi.fn(async (args: string[]) => {
			if (args.includes("--update-all")) {
				return { matches: [], totalMatches: 0, truncated: false };
			}
			const i = args.indexOf("-p");
			const matchedOriginal = i >= 0 && args[i + 1] === "var $X";
			return {
				matches: matchedOriginal ? [SAMPLE_MATCH] : [],
				totalMatches: matchedOriginal ? 1 : 0,
				truncated: false,
			};
		});

		const client = clientWithExec(exec);
		const result = await client.replace(
			"var $X",
			"let $X",
			"typescript",
			["a.ts"],
			true,
			{ sessionRoot: process.cwd() },
		);

		expect(result.applied).toBe(true);
		expect(result.matches).toHaveLength(1);

		// The fix never searches for the rewrite as a pattern (-p let $X); the
		// pre-check (-p var $X) is authoritative for the applied count.
		const rewriteUsedAsPattern = exec.mock.calls.some((c) => {
			const a = c[0] as string[];
			const i = a.indexOf("-p");
			return i >= 0 && a[i + 1] === "let $X";
		});
		expect(rewriteUsedAsPattern).toBe(false);

		// Exactly two passes: dry-run pre-check, then --update-all.
		expect(exec).toHaveBeenCalledTimes(2);
	});

	it("surfaces a stale preview (no apply) when the pattern no longer matches", async () => {
		const exec = vi.fn(async (args: string[]) => {
			void args;
			return { matches: [], totalMatches: 0, truncated: false };
		});
		const client = clientWithExec(exec);
		const result = await client.replace(
			"var $X",
			"let $X",
			"typescript",
			["a.ts"],
			true,
			{ sessionRoot: process.cwd() },
		);
		expect(result.stalePreview).toBe(true);
		expect(result.applied).toBe(false);
		// Never reached --update-all.
		const wrote = exec.mock.calls.some((c) =>
			(c[0] as string[]).includes("--update-all"),
		);
		expect(wrote).toBe(false);
	});

	it("an abort during the raw apply's precheck cancels that child and starts no write", async () => {
		// Recurrence: the precheck child outliving Esc (#5097). The stub stops the
		// way a real child does, only when the signal it was handed fires.
		const controller = new AbortController();
		let markPrecheckBegun!: () => void;
		const precheckBegun = new Promise<void>((resolve) => {
			markPrecheckBegun = resolve;
		});
		let releasePrecheck!: () => void;
		const precheckParked = new Promise<void>((resolve) => {
			releasePrecheck = resolve;
		});
		const exec = vi.fn(
			async (args: string[], options?: { signal?: AbortSignal }) => {
				if (args.includes("--update-all")) {
					return { matches: [], totalMatches: 0, truncated: false };
				}
				markPrecheckBegun();
				await precheckParked;
				return options?.signal?.aborted
					? {
							matches: [],
							totalMatches: 0,
							truncated: false,
							error: "operation aborted",
							failure: "aborted" as const,
						}
					: { matches: [SAMPLE_MATCH], totalMatches: 1, truncated: false };
			},
		);
		const pending = clientWithExec(exec).replace(
			"var $X",
			"let $X",
			"typescript",
			["a.ts"],
			true,
			{ sessionRoot: process.cwd(), signal: controller.signal },
		);

		await precheckBegun;
		controller.abort();
		releasePrecheck();
		const result = await pending;

		// The re-check before the write refuses either way; only the signal on the
		// precheck child itself stops that child in a host with no tool scope.
		expect(exec.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
		expect(result.aborted).toBe(true);
		expect(result.error).toBe("operation aborted");
		expect(result.writeStarted).toBeUndefined();
		expect(
			exec.mock.calls.some((c) => (c[0] as string[]).includes("--update-all")),
		).toBe(false);
	});

	it("an abort during the structural apply's precheck cancels that child and starts no write", async () => {
		// Recurrence: #5097. The structural precheck ran without the call signal
		// (it relied on the pi tool scope), so a host with no scope left it
		// running through Esc.
		const controller = new AbortController();
		let markPrecheckBegun!: () => void;
		const precheckBegun = new Promise<void>((resolve) => {
			markPrecheckBegun = resolve;
		});
		let releasePrecheck!: () => void;
		const precheckParked = new Promise<void>((resolve) => {
			releasePrecheck = resolve;
		});
		const tempScanDetailedAsync = vi.fn(async (...args: unknown[]) => {
			const options = args[4] as { signal?: AbortSignal } | undefined;
			markPrecheckBegun();
			await precheckParked;
			return options?.signal?.aborted
				? {
						matches: [],
						status: null,
						error: "operation aborted",
						failure: "aborted" as const,
					}
				: { matches: [SAMPLE_MATCH], status: 0 };
		});
		const tempScanWithFixAsync = vi.fn(async () => ({
			matches: [SAMPLE_MATCH],
		}));
		const client = clientWithValidationRunner({
			tempScanDetailedAsync,
			tempScanWithFixAsync,
		});
		const pending = client.replaceWithRule(
			"id: rule\nlanguage: TypeScript\nrule: { kind: variable_declarator }",
			["a.ts"],
			true,
			{ sessionRoot: process.cwd(), signal: controller.signal },
		);

		await precheckBegun;
		controller.abort();
		releasePrecheck();
		const result = await pending;

		expect(result.aborted).toBe(true);
		expect(result.error).toBe("operation aborted");
		expect(tempScanWithFixAsync).not.toHaveBeenCalled();
	});

	it("does not classify an invalid raw-rule preview as stale", async () => {
		const tempScanDetailedAsync = vi.fn().mockResolvedValue({
			matches: [],
			status: 8,
			error: "invalid node kind",
			failure: "cli-failure",
		});
		const tempScanWithFixAsync = vi.fn();
		const client = clientWithValidationRunner({
			tempScanDetailedAsync,
			tempScanWithFixAsync,
		});

		const result = await client.replaceWithRule(
			"id: bad\nlanguage: TypeScript\nrule: { kind: definitely_not_a_kind }",
			["a.ts"],
			true,
			{ sessionRoot: process.cwd() },
		);

		expect(result.applied).toBe(false);
		expect(result.stalePreview).toBeUndefined();
		expect(result.error).toContain("invalid node kind");
		expect(tempScanDetailedAsync).toHaveBeenCalledOnce();
		expect(tempScanWithFixAsync).not.toHaveBeenCalled();
	});
});

describe("AstGrepClient validatePattern/validateRule", () => {
	it("validates patterns using a language-appropriate temp file", async () => {
		const execRaw = vi.fn(async (args: string[]) => {
			return { stdout: "[]", stderr: "", status: 1, args };
		});
		const client = clientWithValidationRunner({ execRaw });

		const result = await client.validatePattern("print($X)", "python");

		expect(result.valid).toBe(true);
		const args = execRaw.mock.calls[0][0] as string[];
		expect(args).toContain("--lang");
		expect(args).toContain("python");
		expect(args.at(-1)).toMatch(/snippet\.py$/);
	});

	// #2100: `execRaw` caps its output, and hitting that cap SIGTERMs ast-grep —
	// so the raw result carries the kill's error message alongside the
	// truncation flag. Read after the error check, the truncation guard could
	// only ever describe a run that beat the signal out the door.
	it("names the truncation, not the kill, when the output cap stopped ast-grep", async () => {
		const execRaw = vi.fn(async () => ({
			stdout: "[",
			stderr: "",
			status: null,
			error: "Process killed by signal: SIGTERM",
			failure: "cli-failure",
			outputTruncated: true,
		}));
		const client = clientWithValidationRunner({ execRaw });

		const result = await client.validatePattern("print($X)", "python");

		expect(result.valid).toBe(false);
		expect(result.error).toContain("truncated");
	});

	it("rejects validation inputs with NUL bytes before spawning", async () => {
		const execRaw = vi.fn();
		const client = clientWithValidationRunner({ execRaw });

		const result = await client.validatePattern("foo\0($X)", "typescript");

		expect(result.valid).toBe(false);
		expect(result.error).toContain("NUL");
		expect(execRaw).not.toHaveBeenCalled();
	});

	it("treats explicit stderr errors as invalid but warnings as valid", async () => {
		const execRaw = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "", stderr: "Error: bad", status: 2 })
			.mockResolvedValueOnce({
				stdout: "[]",
				stderr: "Warning: contains ERROR node",
				status: 0,
			});
		const client = clientWithValidationRunner({ execRaw });

		expect((await client.validatePattern("bad($X)", "typescript")).valid).toBe(
			false,
		);
		expect(
			(await client.validatePattern("console.log(", "typescript")).valid,
		).toBe(true);
	});

	it("fails closed when detailed rule scanning reports an invalid CLI rule", async () => {
		const tempScanDetailedAsync = vi.fn().mockResolvedValue({
			matches: [],
			status: 2,
			error: "invalid AST kind: definitely_not_a_kind",
			failure: "cli-failure",
		});
		const tempScanAsync = vi.fn();
		const client = clientWithValidationRunner({
			tempScanDetailedAsync,
			tempScanAsync,
		});

		const result = await client.validateRule(
			"id: bad\nlanguage: TypeScript\nrule:\n  kind: definitely_not_a_kind",
		);

		expect(result.valid).toBe(false);
		expect(result.error).toContain("invalid AST kind");
		expect(tempScanDetailedAsync).toHaveBeenCalledOnce();
		expect(tempScanAsync).not.toHaveBeenCalled();
	});

	it("validates raw rules using the language-appropriate temp file", async () => {
		const seenFiles: string[][] = [];
		const tempScanAsync = vi.fn(async (...args: unknown[]) => {
			const dir = args[0] as string;
			seenFiles.push(fs.readdirSync(dir));
			return [];
		});
		const client = clientWithValidationRunner({ tempScanAsync });
		const rule = "id: py-call\nlanguage: Python\nrule:\n  kind: call";

		const result = await client.validateRule(rule);

		expect(result.valid).toBe(true);
		expect(tempScanAsync).toHaveBeenCalledOnce();
		const dir = tempScanAsync.mock.calls[0][0] as string;
		expect(dir).toContain("pi-lens-sg-rule-");
		expect(seenFiles[0]).toContain("snippet.py");
		expect(path.basename(dir)).toContain("pi-lens-sg-rule-");
	});
});

// Recurrence: #4133 gave every scanner whose report directory is created with
// `mkdtempSync` one temp-root seam (`scannerReportParentDir`), so a harness
// that SIGKILLs the child before its `finally` strands the directory inside a
// root the harness removes. These three snippet directories stayed on a raw
// `os.tmpdir()` and would still land in the shared tmpdir.
describe("AstGrepClient snippet directories use the scanner temp-root seam", () => {
	const roots: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0))
			fs.rmSync(root, { recursive: true, force: true });
	});

	/** A harness-owned scanner root, resolved so the comparison is host-neutral. */
	function ownedScannerRoot(): string {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scanner-root-")),
		);
		roots.push(root);
		vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", root);
		return root;
	}

	it("dumpAst creates its snippet directory under the owned scanner root", async () => {
		const root = ownedScannerRoot();
		const execRaw = vi.fn(async (args: string[]) => ({
			stdout: "",
			stderr: "no tree",
			status: 2,
			args,
		}));
		const client = clientWithValidationRunner({ execRaw });

		await client.dumpAst("const a = 1;", "typescript");

		const snippet = execRaw.mock.calls[0][0].at(-1) as string;
		expect(fs.realpathSync(path.dirname(path.dirname(snippet)))).toBe(root);
		expect(path.basename(path.dirname(snippet))).toContain("pi-lens-ast-dump-");
	});

	it("validatePattern creates its snippet directory under the owned scanner root", async () => {
		const root = ownedScannerRoot();
		const execRaw = vi.fn(async (_args: string[]) => ({
			stdout: "[]",
			stderr: "",
			status: 0,
		}));
		const client = clientWithValidationRunner({ execRaw });

		await client.validatePattern("print($X)", "python");

		const snippet = execRaw.mock.calls[0][0].at(-1) as string;
		expect(fs.realpathSync(path.dirname(path.dirname(snippet)))).toBe(root);
		expect(path.basename(path.dirname(snippet))).toContain(
			"pi-lens-sg-validate-",
		);
	});

	it("validateRule creates its snippet directory under the owned scanner root", async () => {
		const root = ownedScannerRoot();
		const tempScanAsync = vi.fn(async (..._args: unknown[]) => []);
		const client = clientWithValidationRunner({ tempScanAsync });

		await client.validateRule(
			"id: py-call\nlanguage: Python\nrule:\n  kind: call",
		);

		const dir = tempScanAsync.mock.calls[0][0] as string;
		expect(fs.realpathSync(path.dirname(dir))).toBe(root);
		expect(path.basename(dir)).toContain("pi-lens-sg-rule-");
	});
});

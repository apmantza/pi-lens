import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AstGrepClient } from "../../clients/ast-grep-client.js";

/** Build a client whose private SgRunner is replaced with a stubbed exec. */
function clientWithExec(exec: (args: string[]) => unknown): AstGrepClient {
	const client = new AstGrepClient();
	(client as unknown as { runner: { exec: typeof exec } }).runner = { exec };
	return client;
}

function clientWithValidationRunner(runner: {
	execRaw?: (args: string[]) => unknown;
	tempScanAsync?: (...args: unknown[]) => unknown;
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
		);
		expect(result.stalePreview).toBe(true);
		expect(result.applied).toBe(false);
		// Never reached --update-all.
		const wrote = exec.mock.calls.some((c) =>
			(c[0] as string[]).includes("--update-all"),
		);
		expect(wrote).toBe(false);
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

	it("validates raw rules using the rule language", async () => {
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

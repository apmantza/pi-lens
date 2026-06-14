/**
 * review helpers: rebuild-script selection (pure) and the fresh-worker fork
 * plumbing. The fork tests point at tiny stub workers so they exercise the
 * spawn/parse/error paths deterministically without the heavy real pipeline.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	analyzeFileFresh,
	resolveRebuildScript,
	summarizeScan,
} from "../../../clients/mcp/review.js";

describe("resolveRebuildScript", () => {
	it("selects build:dist for a server running from a dist layout", () => {
		expect(resolveRebuildScript("/repo/dist/mcp/server.js")).toBe("build:dist");
		expect(resolveRebuildScript("C:\\repo\\dist\\mcp\\server.js")).toBe(
			"build:dist",
		);
	});

	it("selects build for an in-place dev layout", () => {
		expect(resolveRebuildScript("/repo/mcp/server.js")).toBe("build");
		expect(resolveRebuildScript("C:\\repo\\mcp\\server.js")).toBe("build");
	});
});

describe("summarizeScan", () => {
	it("dedupes by file:line:column:rule and aggregates by rule and file", () => {
		const dupe = {
			filePath: "/x/a.ts",
			line: 1,
			column: 2,
			rule: "ts-path-traversal",
			runner: "tree-sitter",
		};
		const { deduped, byRule, byFile } = summarizeScan([
			dupe,
			{ ...dupe }, // exact duplicate → dropped
			{ filePath: "/x/a.ts", line: 5, rule: "deep-nesting" },
			{ filePath: "/x/b.ts", line: 1, rule: "ts-path-traversal" },
		]);

		expect(deduped).toHaveLength(3);
		expect(byRule).toEqual({ "ts-path-traversal": 2, "deep-nesting": 1 });
		expect(byFile).toEqual({ "/x/a.ts": 2, "/x/b.ts": 1 });
	});

	it("falls back to runner/tool/unknown when no rule is present", () => {
		const { byRule } = summarizeScan([
			{ filePath: "/x/a.ts", line: 1, runner: "fact-rules" },
			{ filePath: "/x/a.ts", line: 2, tool: "tree-sitter" },
			{ filePath: "/x/a.ts", line: 3 },
		]);
		expect(byRule).toEqual({
			"fact-rules": 1,
			"tree-sitter": 1,
			unknown: 1,
		});
	});
});

describe("analyzeFileFresh", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-fresh-"));
	});
	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeWorker(name: string, body: string): string {
		const file = path.join(tmpDir, name);
		fs.writeFileSync(file, body);
		return file;
	}

	it("parses the worker's JSON stdout into a result", async () => {
		const fakeResult = {
			filePath: "/x/app.ts",
			cwd: "/x",
			fileKind: "jsts",
			durationMs: 12,
			hasBlockers: false,
			counts: { diagnostics: 0, blockers: 0, warnings: 0, fixed: 0 },
			diagnostics: [],
		};
		const worker = writeWorker(
			"ok.mjs",
			`process.stdout.write(${JSON.stringify(JSON.stringify(fakeResult))});`,
		);

		const outcome = await analyzeFileFresh(worker, "/x/app.ts", "/x");
		expect(outcome.error).toBeUndefined();
		expect(outcome.result).toEqual(fakeResult);
	});

	it("surfaces a non-zero exit with the worker's stderr", async () => {
		const worker = writeWorker(
			"boom.mjs",
			`process.stderr.write("kaboom"); process.exit(2);`,
		);
		const outcome = await analyzeFileFresh(worker, "/x/app.ts", "/x");
		expect(outcome.result).toBeUndefined();
		expect(outcome.error).toContain("worker exited 2");
		expect(outcome.error).toContain("kaboom");
	});

	it("reports invalid JSON output", async () => {
		const worker = writeWorker("garbage.mjs", `process.stdout.write("not json");`);
		const outcome = await analyzeFileFresh(worker, "/x/app.ts", "/x");
		expect(outcome.result).toBeUndefined();
		expect(outcome.error).toContain("invalid JSON");
	});

	it("passes flags through as a JSON --flags argument", async () => {
		// Echo the parsed --flags back inside a result-shaped object so we can
		// assert the worker received them verbatim.
		const worker = writeWorker(
			"echo-flags.mjs",
			[
				`const raw = process.argv.find((a) => a.startsWith("--flags="));`,
				`const flags = raw ? JSON.parse(raw.slice("--flags=".length)) : null;`,
				`process.stdout.write(JSON.stringify({ flags }));`,
			].join("\n"),
		);
		const outcome = await analyzeFileFresh(worker, "/x/app.ts", "/x", {
			flags: { "no-lsp": true },
		});
		expect((outcome.result as unknown as { flags: unknown }).flags).toEqual({
			"no-lsp": true,
		});
	});
});

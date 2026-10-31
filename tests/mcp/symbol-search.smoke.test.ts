// mutation-lane: exclude
/**
 * pilens_symbol_search MCP smoke (#348).
 *
 * Drives the real stdio JSON-RPC transport against a tiny synthetic project with
 * a pre-seeded word-index snapshot (avoids depending on session-start's
 * background build finishing inside the test window) to assert the #517-slimmed
 * payload: startLine/endLine, no per-hit `read` block, path relative to cwd.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildWordIndex,
	serializeWordIndex,
} from "../../clients/word-index.js";
import {
	flushProjectSnapshotPersistsForTests,
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

let snapshotDataRoot: string;

function textOf(res: Record<string, unknown>): string {
	return (res.result as { content: { text: string }[] }).content[0].text;
}

/** Ranked rows of the one table #5104 renders. The line number sits before
 * the detail parenthetical once the row shape moved, so the reader accepts
 * either position. */
function rankedFiles(text: string): string[] {
	return text.split("\n").flatMap((line) => {
		const match = /^ {2}\d+\. (.*) \((score .*)\)$/.exec(line);
		if (match === null) return [];
		const pre = match[1];
		const cut = pre.lastIndexOf(" ");
		const tail = cut === -1 ? "" : pre.slice(cut + 1);
		const file = /^\d+$/.test(tail) ? pre.slice(0, cut) : pre;
		return [file.replace(/\\/g, "/")];
	});
}

function makeTinyProject(
	prefix: string,
	generatedAt = new Date().toISOString(),
): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	snapshotDataRoot = mkdtempSync(path.join(tmpdir(), `${prefix}data-`));
	writeFileSync(
		path.join(dir, "auth.ts"),
		"export function authenticateUser(id) {\n  return id;\n}\n",
	);
	const index = buildWordIndex([
		{
			path: path.join(dir, "auth.ts"),
			content: "export function authenticateUser(id) {\n  return id;\n}\n",
		},
	]);
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = snapshotDataRoot;
	try {
		saveProjectSnapshot(dir, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: dir,
			generatedAt,
			seq: 0,
			files: {},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
			wordIndex: serializeWordIndex(index),
		});
		// The production snapshot body is worker-persisted. Flush the test seed
		// before spawning a separate MCP process; otherwise a loaded CI worker can
		// race the child and make a valid pre-seeded index look unavailable.
		flushProjectSnapshotPersistsForTests();
	} finally {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
	}
	return dir;
}

describe("pilens_symbol_search over MCP (tiny project, pre-seeded index)", () => {
	let projectDir: string;
	let harness: McpHarness;

	beforeAll(async () => {
		projectDir = makeTinyProject("pi-lens-symbolsearch-mcp-");
		harness = new McpHarness({
			cwd: projectDir,
			env: { PILENS_DATA_DIR: snapshotDataRoot },
		});
		const init = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "symbolsearch-smoke", version: "0" },
		});
		expect((init.result as { protocolVersion: string }).protocolVersion).toBe(
			"2025-06-18",
		);
		harness.notify("notifications/initialized");
	});

	afterAll(() => {
		harness.dispose();
		try {
			rmSync(projectDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
			rmSync(snapshotDataRoot, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		} catch {
			// OS reclaims the temp dir eventually.
		}
	});

	it("returns one ranked table for a warm index (#5104)", async () => {
		const res = await harness.request(10, "tools/call", {
			name: "pilens_symbol_search",
			arguments: { query: "authenticate user", cwd: projectDir },
		});
		expect((res.result as { isError?: boolean }).isError).toBeFalsy();
		const text = textOf(res);
		expect(text).not.toContain("```");
		expect(text).toContain("Index covers 1 files.");
		expect(rankedFiles(text)).toEqual(["auth.ts"]);
		expect(text).toMatch(/^ {2}\d+\. auth\.ts \d+ \(score /m);
		// The footer names the top-ranked hit through the MCP tool spelling.
		expect(text).toContain("Next: pilens_module_report auth.ts");
		expect(text).not.toMatch(/^Next: module_report /m);
	}, 30_000);

	it("returns available:false with an actionable hint when no index exists for cwd", async () => {
		const coldDir = mkdtempSync(
			path.join(tmpdir(), "pi-lens-symbolsearch-cold-mcp-"),
		);
		try {
			const res = await harness.request(11, "tools/call", {
				name: "pilens_symbol_search",
				arguments: { query: "anything", cwd: coldDir },
			});
			const text = textOf(res);
			expect(text).toMatch(/background|retry|session_start/i);
			expect(text.trimEnd().endsWith("}")).toBe(false);
			expect(text).not.toContain("```");
		} finally {
			rmSync(coldDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		}
	}, 30_000);
});

// #5104 F3: on MCP, a snapshot older than the staleness threshold adds one note
// to the footer, between the coverage line and the next-step line. The renderer
// tests pass `stalenessNote` in directly, so only this case reaches the spread
// in `mcp/server.ts`. It guards a note that silently vanishes from the answer
// and a footer whose order drifts.
describe("pilens_symbol_search footer on a stale snapshot (#5104)", () => {
	let projectDir: string;
	let dataRoot: string;
	let harness: McpHarness;

	beforeAll(async () => {
		// Two hours old: past the ten-minute threshold `graphStalenessNote` uses.
		projectDir = makeTinyProject(
			"pi-lens-symbolsearch-stale-",
			new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
		);
		dataRoot = snapshotDataRoot;
		harness = new McpHarness({
			cwd: projectDir,
			env: { PILENS_DATA_DIR: dataRoot },
		});
		await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "symbolsearch-stale", version: "0" },
		});
		harness.notify("notifications/initialized");
	});

	afterAll(() => {
		harness.dispose();
		for (const dir of [projectDir, dataRoot]) {
			try {
				rmSync(dir, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 200,
				});
			} catch {
				// OS reclaims the temp dir eventually.
			}
		}
	});

	it("prints coverage, then the staleness note, then the next step (#5104)", async () => {
		const res = await harness.request(12, "tools/call", {
			name: "pilens_symbol_search",
			arguments: { query: "authenticate user", cwd: projectDir },
		});
		const text = textOf(res);
		// Blocks: the table, the footer, then renderToolText's `result ok` and
		// `usage` trailer. A table row never holds a blank line.
		const footer = text.split("\n\n")[1]?.split("\n");
		expect(footer).toEqual([
			"Index covers 1 files.",
			"Project snapshot last updated 2h ago; run pilens_analyze on recently-changed files, pilens_session_start, or pilens_rebuild to refresh it.",
			"Next: pilens_module_report auth.ts",
		]);
	}, 30_000);
});

// #5038 + #5041: `pilens_symbol_search` documented its `paths` as having "the
// same shape/semantics as pilens_ast_grep_search's `paths`", but only the
// root-relative spelling ever matched (`./src` and an absolute directory
// returned no hits, and `limit: 0` answered "no files matched"), while a
// non-string entry was dropped silently. Both surfaces now go through the
// shared reader in tools/shared.ts and the engine's own host-path resolution.
describe("pilens_symbol_search paths and limit shapes (#5038)", () => {
	let projectDir: string;
	let snapshotDataDir: string;
	let harness: McpHarness;
	let nextId = 503_800;

	const scopedProject = (prefix: string): { dir: string; dataRoot: string } => {
		// The shared setup plants the fixture's own `.git` marker, so the project
		// root the server resolves is `dir` and never a root above the tmp dir
		// (shape 73, #5047 r1 F8).
		const dir = setupTestEnvironment(prefix).tmpDir;
		const dataRoot = mkdtempSync(path.join(tmpdir(), `${prefix}data-`));
		const source = "export function authenticateUser(id) {\n  return id;\n}\n";
		writeFileSync(path.join(dir, "auth.ts"), "export const other = 1;\n");
		const nested = path.join(dir, "src");
		mkdirSync(nested, { recursive: true });
		writeFileSync(path.join(nested, "login.ts"), source);
		const index = buildWordIndex([
			{ path: path.join(nested, "login.ts"), content: source },
		]);
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = dataRoot;
		try {
			saveProjectSnapshot(dir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: dir,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
				wordIndex: serializeWordIndex(index),
			});
			flushProjectSnapshotPersistsForTests();
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
		}
		return { dir, dataRoot };
	};

	beforeAll(async () => {
		const project = scopedProject("pi-lens-symbolsearch-5038-");
		projectDir = project.dir;
		snapshotDataDir = project.dataRoot;
		harness = new McpHarness({
			cwd: projectDir,
			env: { PILENS_DATA_DIR: project.dataRoot },
		});
		await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "symbolsearch-paths", version: "0" },
		});
		harness.notify("notifications/initialized");
	});

	afterAll(() => {
		harness.dispose();
		for (const dir of [projectDir, snapshotDataDir]) {
			try {
				rmSync(dir, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 200,
				});
			} catch {
				// OS reclaims the temp dir eventually.
			}
		}
	});

	const hitsFor = async (
		args: Record<string, unknown>,
	): Promise<{ isError?: boolean; files: string[]; text: string }> => {
		const res = await harness.request(nextId++, "tools/call", {
			name: "pilens_symbol_search",
			arguments: { query: "authenticate user", cwd: projectDir, ...args },
		});
		const result = res.result as {
			isError?: boolean;
			content: { text: string }[];
		};
		const body = result.content.map((part) => part.text).join("\n");
		// #5104: the ranked table IS the answer; no fenced JSON duplicate.
		expect(body).not.toContain("```");
		return {
			...(result.isError === undefined ? {} : { isError: result.isError }),
			files: rankedFiles(body),
			text: body,
		};
	};

	it("scopes `src`, `./src` and the absolute directory to the same hit", async () => {
		const expected = ["src/login.ts"];
		expect((await hitsFor({ paths: ["src"] })).files, "src").toEqual(expected);
		expect((await hitsFor({ paths: ["./src"] })).files, "./src").toEqual(
			expected,
		);
		expect(
			(await hitsFor({ paths: [path.join(projectDir, "src")] })).files,
			"absolute",
		).toEqual(expected);
		// #771 asked for globs, so a resolved spelling still matches as one.
		expect((await hitsFor({ paths: ["src/**/*.ts"] })).files, "glob").toEqual(
			expected,
		);
	}, 30_000);

	it("clamps `limit` to max(1, floor) like project_report", async () => {
		expect((await hitsFor({ limit: 0 })).files.length, "limit 0").toBe(1);
		expect((await hitsFor({ limit: -2 })).files.length, "limit -2").toBe(1);
	}, 30_000);

	it("refuses every entry the shared reader does not recognise", async () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ paths: [42] }, "paths entry 1 must be a string"],
			[{ paths: ["  "] }, "paths entry 1 is blank"],
			[{ paths: [] }, "paths is empty"],
			[{ paths: "src" }, "paths must be an array of strings"],
			[
				{ paths: Array.from({ length: 101 }, (_, index) => `f${index}.ts`) },
				"paths must contain at most 100 string entries",
			],
		];
		for (const [args, expected] of cases) {
			const result = await hitsFor(args);
			expect(result.isError, JSON.stringify(args)).toBe(true);
			expect(result.text, JSON.stringify(args)).toContain(expected);
		}
	}, 30_000);
});

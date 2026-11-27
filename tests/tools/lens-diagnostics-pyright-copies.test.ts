/**
 * #4629: `lens_diagnostics mode=full` lists one Pyright finding once when the
 * CLI runner's stored row meets the language server's sweep copy of it.
 *
 * The CLI keeps the bare code (`reportAssignmentType`), the server publishes
 * `<source>:<code>` (`Pyright:reportAssignmentType`). `diagnosticDedupKey`
 * normalizes both, so the merge sees one finding.
 *
 * Driven through the real tool and the real widget store, with the sweep's
 * write rejected by the store's own ordering guard: the stored row carries a
 * newer `writeIndex` than the sweep's result, so the real
 * `reconcileScanDiagnostics` returns false and the row stays to meet the sweep
 * copy in the merge. (A write the store accepts retires the row instead, #1993,
 * and would hide the defect.) Only the language-server process is doubled
 * (`makeLspServiceDouble`); the call runs in quick mode.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearWidgetState,
	recordDiagnostics,
} from "../../clients/widget-state.js";
import {
	removeTempDirSync,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";

const MESSAGE =
	'Type "Literal[\'s\']" is not assignable to declared type "int"';
const CODE = "reportAssignmentType";

describe("lens_diagnostics mode=full lists a Pyright finding once (#4629)", () => {
	let tmp: string;
	let file: string;
	let previousDataDir: string | undefined;

	async function run(params: Record<string, unknown>, sweepSource: string) {
		const service = makeLspServiceDouble({
			runWorkspaceDiagnostics: vi.fn(async () => [
				{
					filePath: file,
					// Older than the stored row's write below, so the store rejects it.
					writeIndex: 3,
					count: 1,
					diagnostics: [
						{
							severity: 1,
							message: MESSAGE,
							source: sweepSource,
							code: CODE,
							range: {
								start: { line: 0, character: 13 },
								end: { line: 0, character: 16 },
							},
						},
					],
				},
			]),
		});
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => tmp,
			() => service as never,
		);
		const result = (await tool.execute(
			"1",
			params,
			new AbortController().signal,
			null as never,
			{ cwd: tmp } as never,
		)) as { content: Array<{ text: string }> };
		return result.content.map((c) => c.text).join("\n");
	}

	/**
	 * The rows a report lists for the finding, rule tags kept. A row the store
	 * kept after a rejected sweep renders with the stale marker in place of
	 * `L<n>:`, so the finding is found by its message.
	 */
	function rows(report: string): string[] {
		return report
			.split("\n")
			.filter((line) => line.includes(MESSAGE))
			.map((line) => line.trim());
	}

	beforeEach(() => {
		clearWidgetState();
		tmp = fs.realpathSync(setupTestEnvironment("pi-lens-4629-").tmpDir);
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, ".data");
		file = path.join(tmp, "app.py");
		fs.writeFileSync(file, 'value: int = "s"\n');
		const past = (Date.now() - 60_000) / 1000;
		fs.utimesSync(file, past, past);
	});

	afterEach(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		clearWidgetState();
		removeTempDirSync(tmp);
	});

	it.each([
		["pyright-langserver", "Pyright"],
		["basedpyright-langserver", "basedpyright"],
	])(
		"lists a finding once when the CLI's stored row meets the %s sweep copy (#4629)",
		async (_server, source) => {
			// A write whose language-server lane stayed silent leaves only the CLI's
			// row in the store, spelled with the bare code.
			expect(
				recordDiagnostics(
					file,
					[
						{
							tool: "pyright",
							rule: CODE,
							message: MESSAGE,
							line: 1,
							column: 14,
							severity: "error",
							semantic: "blocking",
						},
					],
					9,
				),
			).toBe(true);

			const full = await run({ mode: "full", paths: [file] }, source);

			// The guard rejected the sweep's write and the CLI's row stayed, so the
			// report merges the two by the rule they share: one row, not two.
			expect(rows(full), full).toHaveLength(1);
		},
	);
	it("keeps two findings with the same rule and line at different columns (#5412)", async () => {
		file = path.join(tmp, "app.ts");
		fs.writeFileSync(file, "const a = 1; const b = 2; export {};\n");
		const service = makeLspServiceDouble({
			runWorkspaceDiagnostics: vi.fn(async () => [
				{
					filePath: file,
					count: 2,
					diagnostics: [
						{ name: "a", character: 6 },
						{ name: "b", character: 19 },
					].map(({ name, character }) => ({
						severity: 1,
						message: `'${name}' is declared but its value is never read.`,
						source: "typescript",
						code: 6133,
						range: {
							start: { line: 0, character },
							end: { line: 0, character: character + 1 },
						},
					})),
				},
			]),
		});
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => tmp,
			() => service as never,
		);
		const result = await tool.execute(
			"1",
			{ mode: "full", paths: [file] },
			new AbortController().signal,
			null as never,
			{ cwd: tmp } as never,
		);
		const text = result.content
			.map((part) => ("text" in part ? part.text : ""))
			.join("\n");
		expect(text).toContain("'a' is declared but its value is never read.");
		expect(text).toContain("'b' is declared but its value is never read.");
		expect(result.details).toMatchObject({ totalBlocking: 2, totalErrors: 2 });
	});
});

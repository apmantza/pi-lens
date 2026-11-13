/**
 * #5258: `lens_diagnostics` says clean, in its text or its one-line summary,
 * only with positive proof that a check completed on every file it speaks for
 * (`cleanVerdict`, `clients/dispatch/types.ts`).
 *
 * Recurrence prevented: the 2026-11-13 clean-emitter matrix (probe P1, P2).
 * A mode=full sweep that did not answer for a file the session cache held as
 * checked printed `No issues across 1 file diagnosed this session. ✓` above
 * `⚠ LSP sweep: 0 file(s) confirmed via LSP, 1 unconfirmed`, and its summary
 * read `lens_diagnostics full — clean (1 files)`; a sweep that proved nothing
 * read `clean (0 files)`; the delta summary read `clean` with no file checked
 * and beside findings carried over from earlier in the session.
 *
 * Driven through the real tool and the real widget store; only the language
 * server process is doubled (`makeLspServiceDouble`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
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

type SweepRow = Record<string, unknown>;

describe("lens_diagnostics claims clean only with proof (#5258)", () => {
	let tmp: string;
	let file: string;

	beforeEach(() => {
		clearWidgetState();
		tmp = fs.realpathSync(setupTestEnvironment("pi-lens-5258-proof-").tmpDir);
		file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "export const value = 1;\n");
	});

	afterEach(() => {
		clearWidgetState();
		removeTempDirSync(tmp);
	});

	function tool(service: unknown) {
		return createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => tmp,
			() => service as never,
		);
	}

	async function run(
		args: Record<string, unknown>,
		service: unknown,
		signal = new AbortController().signal,
	) {
		const lens = tool(service);
		const result = await lens.execute(
			"1",
			args,
			signal,
			null as never,
			{
				cwd: tmp,
			} as never,
		);
		const text = (result as { content: Array<{ text: string }> }).content
			.map((c) => c.text)
			.join("\n");
		const summary = lens
			.renderResult(result as never, { expanded: false }, {} as Theme, {
				args,
			})
			.render(400)
			.join("\n");
		return { text, summary };
	}

	const sweepOf = (rows: SweepRow[]) =>
		makeLspServiceDouble({
			runWorkspaceDiagnostics: vi.fn(async () =>
				rows.map((row) => ({
					filePath: file,
					diagnostics: [],
					count: 0,
					...row,
				})),
			),
		});

	it.each([
		["did not answer in time", { timedOut: true }],
		["errored", { error: "server crashed" }],
		["answered for the primary only", { unconfirmedServerIds: ["typos"] }],
	])(
		"a sweep that %s withholds the ✓ and the summary's clean for a checked file",
		async (_label, row) => {
			recordDiagnostics(file, []);
			const { text, summary } = await run(
				{ mode: "full", paths: [file] },
				sweepOf([row]),
			);
			expect(text).not.toContain("✓");
			expect(text).not.toContain("No issues across");
			expect(summary).toContain("lens_diagnostics full — unconfirmed");
			expect(summary).not.toContain("clean");
		},
	);

	it("a sweep cut short by its abort never reads clean", async () => {
		recordDiagnostics(file, []);
		const controller = new AbortController();
		const service = makeLspServiceDouble({
			runWorkspaceDiagnostics: vi.fn(async () => {
				controller.abort();
				return [{ filePath: file, diagnostics: [], count: 0 }];
			}),
		});
		const { text, summary } = await run(
			{ mode: "full", paths: [file] },
			service,
			controller.signal,
		);
		expect(text).toContain("Scan cancelled before completion");
		expect(text).not.toContain("✓");
		expect(summary).not.toContain("clean");
	});

	it("a sweep that proved nothing is not clean (0 files)", async () => {
		const { summary } = await run(
			{ mode: "full", paths: [file] },
			sweepOf([{ timedOut: true }]),
		);
		expect(summary).not.toContain("clean");
		expect(summary).toContain("unconfirmed");
	});

	it("a service with no workspace sweep is not clean", async () => {
		const { text, summary } = await run(
			{ mode: "full", paths: [file] },
			makeLspServiceDouble({}, { omit: ["runWorkspaceDiagnostics"] }),
		);
		expect(text).toContain("does not support project-wide");
		expect(summary).not.toContain("clean");
	});

	// The positive control for every case above: the same sweep, answered.
	it("a sweep that confirmed the file reads clean and counts it", async () => {
		const { summary } = await run(
			{ mode: "full", paths: [file] },
			sweepOf([{}]),
		);
		expect(summary).toContain("lens_diagnostics full — clean (1 files)");
	});

	it("a checked file no sweep row speaks for keeps its ✓", async () => {
		recordDiagnostics(file, []);
		const { text, summary } = await run(
			{ mode: "full", paths: [file] },
			sweepOf([]),
		);
		expect(text).toContain("No issues across 1 file diagnosed this session. ✓");
		expect(summary).toContain("lens_diagnostics full — clean (1 files)");
	});

	it("the delta summary never says clean: a delta checks nothing", async () => {
		const { text, summary } = await run({ mode: "delta" }, sweepOf([]));
		expect(text).toContain("No issues in the current turn delta.");
		expect(summary).toContain("lens_diagnostics delta — no new findings");
		expect(summary).not.toContain("clean");
	});

	it("the delta summary does not read clean beside findings carried over", async () => {
		recordDiagnostics(file, [
			{
				tool: "typescript",
				rule: "ts:2322",
				message: "Type 'string' is not assignable to type 'number'.",
				line: 1,
				column: 1,
				severity: "error",
				semantic: "blocking",
			},
		]);
		const { text, summary } = await run({ mode: "delta" }, sweepOf([]));
		expect(text).toContain("carried over from earlier this session");
		expect(summary).not.toContain("clean");
	});
});

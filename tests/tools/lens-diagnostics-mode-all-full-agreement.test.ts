/**
 * #1634 criterion 4 (#1631 criterion 3): `lens_diagnostics mode=all` never
 * contradicts a same-minute `mode=full` on the same paths without a label
 * saying why.
 *
 * Driven through the real tool for both calls, the real widget store mode=full
 * writes and mode=all reads, and real dispositions made by the real mark tool.
 * Only the language-server process is doubled (`makeLspServiceDouble`); the
 * calls run in quick mode, so no analyzer or project scan is involved.
 *
 * Recurrence: the earlier pin (`lens-diagnostics-mode-all-freshness.test.ts`)
 * seeded the widget by hand, so it could not see mode=full and mode=all
 * disagree about the rows mode=full itself wrote; and a mark made after the
 * sweep left mode=all reading "No issues ✓" with no reason given.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IN_FLIGHT_REASON } from "../../clients/dispatch/types.js";
import {
	clearWidgetState,
	exportWidgetState,
	recordDiagnostics,
} from "../../clients/widget-state.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import {
	removeTempDirSync,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";

const PREFIX = "pi-lens-1634-all-full-";
const KEPT = "Cannot find name 'missing'.";
const MARKED = "Type 'string' is not assignable to type 'number'.";

const OTHER = "'unused' is declared but its value is never read.";

/** A warning in a second file, outside a `paths: [a.ts]` call's scope. */
function otherWarning() {
	return {
		severity: 2,
		message: OTHER,
		source: "typescript",
		code: 6133,
		range: {
			start: { line: 0, character: 6 },
			end: { line: 0, character: 12 },
		},
	};
}

function serverDiagnostics() {
	return [
		{
			severity: 1,
			message: KEPT,
			source: "typescript",
			code: 2304,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		},
		{
			severity: 1,
			message: MARKED,
			source: "typescript",
			code: 2322,
			range: {
				start: { line: 1, character: 6 },
				end: { line: 1, character: 11 },
			},
		},
	];
}

describe("lens_diagnostics mode=all agrees with a same-minute mode=full (#1634 criterion 4)", () => {
	let tmp: string;
	let file: string;
	let dep: string;
	let other: string;
	let previousDataDir: string | undefined;

	async function run(params: Record<string, unknown>): Promise<string> {
		const service = makeLspServiceDouble({
			runWorkspaceDiagnostics: vi.fn(async () => [
				{ filePath: file, diagnostics: serverDiagnostics(), count: 2 },
				{ filePath: other, diagnostics: [otherWarning()], count: 1 },
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

	async function mark(
		message: string,
		line: number,
		code: number,
		filePath = file,
	) {
		const result = await createLensDiagnosticMarkTool(() => tmp).execute(
			"mark-1634",
			{
				filePath,
				line,
				message,
				rule: `typescript:${code}`,
				tool: "lsp",
				disposition: "false-positive",
			},
			undefined,
			() => {},
			{ cwd: tmp },
		);
		expect(result.isError).toBeFalsy();
	}

	beforeEach(() => {
		clearWidgetState();
		tmp = fs.realpathSync(setupTestEnvironment(PREFIX).tmpDir);
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, ".data");
		_resetDeferredForTests();
		_resetStateCacheForTests();
		file = path.join(tmp, "a.ts");
		dep = path.join(tmp, "dep.ts");
		other = path.join(tmp, "b.ts");
		fs.writeFileSync(other, "const unused = 1;\nexport {};\n");
		fs.writeFileSync(dep, "export const y = 1;\n");
		fs.writeFileSync(
			file,
			'import { y } from "./dep.js";\nconst value: number = y;\nexport { value };\n',
		);
		const past = (Date.now() - 60_000) / 1000;
		for (const p of [file, dep, other]) fs.utimesSync(p, past, past);
	});

	afterEach(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		_resetDeferredForTests();
		_resetStateCacheForTests();
		clearWidgetState();
		removeTempDirSync(tmp);
	});

	/** The finding rows a report lists for `a.ts`, markers and tags kept. */
	function rows(report: string): string[] {
		return report
			.split("\n")
			.filter((line) => /^\s+(?:🔴 )?L\d+: /.test(line))
			.map((line) => line.trim());
	}

	it("lists the same rows as the sweep that wrote them, a stored disposition included", async () => {
		await mark(MARKED, 2, 2322);
		const full = await run({ mode: "full", paths: [file] });
		const all = await run({ mode: "all", paths: [file] });

		expect(rows(full)).toEqual([`🔴 L1: ${KEPT} [typescript:2304]`]);
		expect(rows(all)).toEqual(rows(full));
	});

	it("labels a row whose import changed after the sweep instead of re-asserting it", async () => {
		const full = await run({ mode: "full", paths: [file] });
		const future = (Date.now() + 60_000) / 1000;
		fs.utimesSync(dep, future, future);
		const all = await run({ mode: "all", paths: [file] });

		expect(rows(full)).toContain(`🔴 L1: ${KEPT} [typescript:2304]`);
		expect(rows(all)).toContain(
			`L1: ${KEPT} [typescript:2304] [stale — re-run to confirm]`,
		);
		expect(all).not.toContain("🔴");
	});

	it("says what a mark made after the sweep hides instead of reading clean", async () => {
		const full = await run({ mode: "full", paths: [file] });
		await mark(KEPT, 1, 2304);
		await mark(MARKED, 2, 2322);
		const all = await run({ mode: "all", paths: [file] });

		expect(rows(full)).toHaveLength(2);
		expect(rows(all)).toEqual([]);
		expect(all).toContain("suppressed by disposition: 2 finding(s)");
		expect(all).toContain("Not a clean verdict");
	});

	it("counts only what is hidden inside the call's paths and severity", async () => {
		await run({ mode: "full", paths: [file, other] });
		await mark(KEPT, 1, 2304);
		await mark(MARKED, 2, 2322);
		await mark(OTHER, 1, 6133, other);

		const everything = await run({ mode: "all" });
		const onePath = await run({ mode: "all", paths: [file] });
		const errorsOnly = await run({ mode: "all", severity: "error" });

		expect(everything).toContain("suppressed by disposition: 3 finding(s)");
		expect(onePath).toContain("suppressed by disposition: 2 finding(s)");
		expect(errorsOnly).toContain("suppressed by disposition: 2 finding(s)");
	});

	// A `.pi-lens.json` rule is not a mark: the count said "suppressed by
	// disposition" for a finding the project's rule policy disabled.
	it("does not count a rule-policy drop as a disposition", async () => {
		await run({ mode: "full", paths: [file, other] });
		fs.writeFileSync(
			path.join(tmp, ".pi-lens.json"),
			JSON.stringify({
				rules: { "typescript:6133": { disable: ["typescript:6133"] } },
			}),
		);
		const all = await run({ mode: "all", paths: [other] });

		expect(rows(all)).toEqual([]);
		expect(all).not.toContain("suppressed by disposition");
	});

	// #4459 review F2 (probe S3): mode=full's first widget write handed the
	// pre-policy sweep to the store, so the re-reported marked rows replaced
	// their disposition-tagged rows and the post-policy write then dropped them.
	// The next mode=all read "No issues ✓" with no count, and mode=full itself
	// never said what it dropped.
	it("keeps saying what a mark hides across a second mode=full", async () => {
		await run({ mode: "full", paths: [file] });
		await mark(KEPT, 1, 2304);
		await mark(MARKED, 2, 2322);
		const allBefore = await run({ mode: "all", paths: [file] });
		const fullAgain = await run({ mode: "full", paths: [file] });
		const allAfter = await run({ mode: "all", paths: [file] });

		expect(allBefore).toContain("suppressed by disposition: 2 finding(s)");
		expect(rows(fullAgain)).toEqual([]);
		expect(fullAgain).toContain("suppressed by disposition: 2 finding(s)");
		expect(rows(allAfter)).toEqual([]);
		expect(allAfter).toContain("suppressed by disposition: 2 finding(s)");
	});

	// Recurrence prevented: #5285 r3 (CodeRabbit and Greptile on 548fc8d4c). The
	// scan's correlated commit retired the in-flight reason of every file it was
	// handed, so a file whose language server timed out in the scan read
	// `✓ clean` in the footer while its slow primary was still running. Only a
	// file the scan confirmed loses its reason; the sidecar is what a resume
	// restores, so it is the record read here.
	it("a full scan retires the unchecked reason of the file it confirmed and keeps the other's", async () => {
		for (const p of [file, other])
			recordDiagnostics(p, [], undefined, undefined, {
				reason: IN_FLIGHT_REASON,
			});
		const service = makeLspServiceDouble({
			runWorkspaceDiagnostics: vi.fn(async () => [
				{ filePath: file, diagnostics: [], count: 0 },
				{ filePath: other, diagnostics: [], count: 0, timedOut: true },
			]),
		});
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => tmp,
			() => service as never,
		);
		await tool.execute(
			"1",
			{ mode: "full", paths: [file, other] },
			new AbortController().signal,
			null as never,
			{ cwd: tmp } as never,
		);

		const reasons = Object.fromEntries(
			exportWidgetState().files.map((f) => [
				path.basename(f.filePath),
				f.uncheckedReason ?? "none",
			]),
		);
		expect(reasons).toEqual({ "a.ts": "none", "b.ts": IN_FLIGHT_REASON });
	});

	// Same review: mode=full dropped marked findings without a count, so its
	// "No issues ✓" was the unlabeled side of the contradiction.
	it("mode=full counts what a mark hides inside the call's paths and severity", async () => {
		await mark(MARKED, 2, 2322);
		await mark(OTHER, 1, 6133, other);

		const everything = await run({ mode: "full" });
		const onePath = await run({ mode: "full", paths: [file] });
		const errorsOnly = await run({ mode: "full", severity: "error" });

		expect(rows(onePath)).toEqual([`🔴 L1: ${KEPT} [typescript:2304]`]);
		expect(everything).toContain("suppressed by disposition: 2 finding(s)");
		expect(onePath).toContain("suppressed by disposition: 1 finding(s)");
		expect(errorsOnly).toContain("suppressed by disposition: 1 finding(s)");
	});
});

/**
 * #5020 remainder — the widget store keeps a cross-file row until the written
 * file is dispatched again, after the commit gate has retired its twin.
 *
 * Recurrence: helm-lint reports `templates/other-b.yaml` while the agent wrote
 * `templates/deploy-a.yaml`. PR #5033 retired the gate's row once `other-b`
 * was fixed or deleted, but `WidgetDiagnostic` carried no cited file, so the
 * store's writers replaced a whole file's rows and nothing could retire one:
 * `lens_diagnostics source=session` and the footer listed a fixed file's
 * blocker. The row now carries `citedFile`, and `RuntimeCoordinator.
 * retireForeignRows` (the one #5033 seam) retires the widget's copy with the
 * gate's. These cells drive that seam over the real coordinator and the real
 * widget store; the tool_result witness in
 * `tests/index-3190-inline-blocker-deleted-path-witness.test.ts` drives the
 * same retire through `index.ts` and the footer renderer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnosticSummaries,
	getFileDiagnostics,
	importWidgetState,
	recordDiagnostics,
	retireWidgetCitedRows,
	type PersistedWidgetState,
	type WidgetDiagnostic,
} from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

const FIXTURES = path.join(__dirname, "..", "fixtures", "session-state");

function readWidgetFixture(name: string): PersistedWidgetState {
	const parsed = JSON.parse(
		fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"),
	) as {
		widget?: PersistedWidgetState;
		stores?: { widget: PersistedWidgetState };
	};
	return (parsed.stores?.widget ?? parsed.widget) as PersistedWidgetState;
}

function row(
	filePath: string,
	line: number,
	message = "nil pointer evaluating interface {}.image",
	tool = "helm-lint",
): Diagnostic {
	return {
		id: `${tool}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool,
		runnerId: tool,
		rule: "error",
	};
}

/** What `clients/pipeline.ts` does for one write: the same rows to both stores. */
function recordBoth(
	runtime: RuntimeCoordinator,
	written: string,
	rows: Diagnostic[],
): void {
	runtime.recordInlineBlockers(
		written,
		formatDiagnostics(rows, "blocking").trim(),
		runtime.nextWriteIndex(),
		[...new Set(rows.map((d) => d.tool))],
		rows.filter((d) => d.filePath === written).map((d) => d.line as number),
		undefined,
		rows,
	);
	recordDiagnostics(written, rows);
}

const cites = (file: string): Array<string | undefined> =>
	(getFileDiagnostics(file) ?? []).map((d) => d.citedFile);

beforeEach(() => clearWidgetState());
afterEach(() => clearWidgetState());

describe("#5020 the widget row carries its cited file", () => {
	// Recurrence it prevents: the row's cite being dropped at the one place the
	// store builds rows, so nothing downstream can tell another file's claim
	// from the record's own.
	it("stamps citedFile on a row that cites another file and on no other", () => {
		const a = "/proj/a.yaml";
		const b = "/proj/b.yaml";
		recordDiagnostics(a, [
			row(a, 1),
			row(b, 2),
			// A row that cites no file (outside the type system) is the record's own.
			{ ...row(a, 3), filePath: undefined } as unknown as Diagnostic,
		]);
		expect(cites(a)).toEqual([undefined, b, undefined]);
		// A different spelling of the SAME file is not another file's claim: the
		// gate's own test (`isCrossFileBlocker`) answers, not a second spelling.
		clearWidgetState();
		recordDiagnostics(a, [row("\\proj\\a.yaml", 1)]);
		expect(cites(a)).toEqual([undefined]);
	});
});

describe("#5020 the widget row leaves with the gate's", () => {
	function setup(prefix: string) {
		const env = setupTestEnvironment(prefix);
		const a = path.join(env.tmpDir, "a.yaml");
		const b = path.join(env.tmpDir, "b.yaml");
		fs.writeFileSync(a, "a: 1\n");
		fs.writeFileSync(b, "b: 1\n");
		return { env, a, b, runtime: new RuntimeCoordinator() };
	}

	it("clean verdict on the cited file: the row leaves both stores, the record's own stays, counts are re-derived", () => {
		const { env, a, b, runtime } = setup("pi-lens-5020-widget-clean-");
		try {
			recordBoth(runtime, a, [row(a, 1, "own finding"), row(b, 2)]);
			expect(getFileDiagnosticSummaries()[0]).toMatchObject({ blocking: 2 });

			runtime.retireForeignRows(
				"cited-file-clean",
				(r) => r.filePath === b,
				runtime.nextWriteIndex(),
			);

			// The stored tally the footer header reads, taken before any read that
			// re-derives it (`getFileDiagnostics` and `getFileDiagnosticSummaries` run
			// the past-EOF gate).
			expect(exportWidgetState().files[0]?.diagnosticCounts).toEqual({
				blocking: 1,
				errors: 1,
				warnings: 0,
			});
			expect(runtime.getInlineBlockersSnapshot()[0]?.diagnostics).toHaveLength(
				1,
			);
			expect((getFileDiagnostics(a) ?? []).map((d) => d.message)).toEqual([
				"own finding",
			]);
			expect(getFileDiagnosticSummaries()[0]).toMatchObject({
				blocking: 1,
				errors: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents: a retire matched on message and line alone would
	// take the record's own row when it reads exactly like the foreign one (the
	// same runner words the same finding in both files).
	it("takes the cited row, not an own row that reads the same", () => {
		const { env, a, b, runtime } = setup("pi-lens-5020-widget-twin-");
		try {
			recordBoth(runtime, a, [row(a, 2), row(b, 2)]);
			runtime.retireForeignRows(
				"cited-file-clean",
				(r) => r.filePath === b,
				runtime.nextWriteIndex(),
			);
			expect(cites(a)).toEqual([undefined]);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a row that cites a different file, and one on a different line of the same file", () => {
		const { env, a, b, runtime } = setup("pi-lens-5020-widget-others-");
		try {
			const c = path.join(env.tmpDir, "c.yaml");
			recordBoth(runtime, a, [row(b, 2), row(c, 2), row(b, 9)]);
			runtime.retireForeignRows(
				"cited-file-clean",
				(r) => r.filePath === b && r.line === 2,
				runtime.nextWriteIndex(),
			);
			expect(
				(getFileDiagnostics(a) ?? []).map((d) => [d.citedFile, d.line]),
			).toEqual([
				[c, 2],
				[b, 9],
			]);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents: retiring the widget's copy on a verdict the gate
	// refused would be a second retirement rule with its own evidence.
	it("keeps the widget row when the gate keeps its row", () => {
		const { env, a, b, runtime } = setup("pi-lens-5020-widget-refused-");
		try {
			recordBoth(runtime, a, [row(b, 2)]);
			const before = runtime.nextWriteIndex();
			// Not strictly newer than the record: the gate keeps it.
			runtime.retireForeignRows("cited-file-clean", () => true, before - 1);
			// The predicate refuses it.
			runtime.retireForeignRows(
				"cited-file-clean",
				() => false,
				runtime.nextWriteIndex(),
			);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			expect(cites(a)).toEqual([b]);
		} finally {
			env.cleanup();
		}
	});

	it("cited file deleted: the sweep that retires the gate row retires the widget row", () => {
		const { env, a, b, runtime } = setup("pi-lens-5020-widget-gone-");
		try {
			recordBoth(runtime, a, [row(a, 1, "own finding"), row(b, 2)]);
			expect(
				runtime.retireForeignRowsOfMissingFiles({ sessionId: undefined }),
			).toEqual([]);
			expect(cites(a)).toEqual([undefined, b]);

			fs.rmSync(b);
			expect(
				runtime.retireForeignRowsOfMissingFiles({ sessionId: undefined }),
			).toHaveLength(1);
			expect(cites(a)).toEqual([undefined]);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents: a retire that rewrote the record as a final
	// snapshot would turn "still waiting for this file's run" into "clean".
	it("does not make an unfinished record final or move its clock", () => {
		const state = readWidgetFixture("v2-widget-cited-row");
		const record = state.files[0] as PersistedWidgetState["files"][number];
		importWidgetState({
			...state,
			files: [{ ...record, hasFinalDiagnosticsSnapshot: false }],
		});
		const before = exportWidgetState().files[0];

		expect(
			retireWidgetCitedRows(record.filePath, [
				row("/proj/chart/templates/other-b.yaml", 2),
			]),
		).toBe(1);

		const after = exportWidgetState().files[0];
		expect(after?.hasFinalDiagnosticsSnapshot).toBe(false);
		expect(after?.touchedAt).toBe(before?.touchedAt);
		expect(after?.allDiagnostics.map((d) => d.line)).toEqual([1]);
	});

	// Recurrence it prevents: the seam handed a row that is not another file's
	// claim (the caller's `isCrossFileBlocker` filter failed) would otherwise
	// match, by finding identity, the record's own row that reads the same.
	it("never takes the record's own row, even when handed one that reads the same", () => {
		const a = "/proj/a.yaml";
		recordDiagnostics(a, [row(a, 2)]);
		expect(retireWidgetCitedRows(a, [row(a, 2)])).toBe(0);
		expect(cites(a)).toEqual([undefined]);
	});

	it("is a no-op for a file the store never recorded", () => {
		expect(retireWidgetCitedRows("/proj/never.yaml", [row("/proj/b", 2)])).toBe(
			0,
		);
	});
});

describe("#5020 old and new persisted rows", () => {
	// Recurrence it prevents: a row shape change that stops parsing the records
	// the previous build wrote (the v1 fixture is today's shape, written before
	// `citedFile` existed), or that lets such a row match a retire it never
	// cited. The fixture's single row reads exactly like the retired one below.
	it("parses a row persisted without citedFile and never retires it", () => {
		expect(importWidgetState(readWidgetFixture("v1-widget"))).toBe(true);
		const file = "/proj/example/a.ts";
		const [kept] = getFileDiagnostics(file) ?? [];
		expect(kept).toMatchObject({ message: "boom", line: 5, tool: "tsc" });
		expect(kept?.citedFile).toBeUndefined();

		// The retired row names the stored one's own tool, rule (none), message
		// and line, and differs from it only in what it cites.
		expect(
			retireWidgetCitedRows(file, [
				{
					tool: "tsc",
					message: "boom",
					line: 5,
					filePath: "/proj/example/other.ts",
				},
			]),
		).toBe(0);
		expect(getFileDiagnostics(file)).toHaveLength(1);
	});

	it("keeps a persisted citedFile across a restore, so a resumed row still retires", () => {
		expect(importWidgetState(readWidgetFixture("v2-widget-cited-row"))).toBe(
			true,
		);
		const file = "/proj/chart/templates/deploy-a.yaml";
		expect(
			(getFileDiagnostics(file) as WidgetDiagnostic[]).map((d) => d.citedFile),
		).toEqual([undefined, "/proj/chart/templates/other-b.yaml"]);

		// And the round trip through the store's own export is the fixture's shape.
		const roundTripped = JSON.parse(JSON.stringify(exportWidgetState()));
		clearWidgetState();
		expect(importWidgetState(roundTripped)).toBe(true);
		expect(
			retireWidgetCitedRows(file, [
				row("/proj/chart/templates/other-b.yaml", 2),
			]),
		).toBe(1);
		expect((getFileDiagnostics(file) ?? []).map((d) => d.message)).toEqual([
			"bad indent",
		]);
	});
});

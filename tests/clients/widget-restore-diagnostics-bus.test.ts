import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetStateCacheForTests,
	markDisposition,
} from "../../clients/diagnostic-dispositions.js";
import {
	_resetDiagnosticsPublishForTests,
	BUS_DIAGNOSTICS_EVENT,
	type PilensDiagnosticsPayload,
	publishDiagnostics,
	wireDiagnosticsBusEmitter,
} from "../../clients/diagnostics-publish.js";
import { beginScope, retireScope } from "../../clients/session-scope.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnosticSummaries,
	getSuppressedDiagnostics,
	recordDiagnostics,
	recordRunner,
	renderWidget,
	widgetStore,
} from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

const content = "export const value = 1;\n";
let env: ReturnType<typeof setupTestEnvironment>;
let scope: ReturnType<typeof beginScope>;
let received: PilensDiagnosticsPayload[];

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-restore-bus-");
	scope = beginScope({ role: "primary" });
	received = [];
	wireDiagnosticsBusEmitter((name, payload) => {
		if (name === BUS_DIAGNOSTICS_EVENT)
			received.push(payload as PilensDiagnosticsPayload);
	});
});

afterEach(() => {
	retireScope(scope, "shutdown");
	// These cases exercise the widget store's own restore and publisher state.
	clearWidgetState();
	_resetDiagnosticsPublishForTests();
	_resetStateCacheForTests();
	env.cleanup();
});

function freshFile(name: string): string {
	const file = join(env.tmpDir, name);
	writeFileSync(file, content);
	utimesSync(file, new Date(1_000_000), new Date(1_000_000));
	return file;
}

async function restore(saved = exportWidgetState()) {
	clearWidgetState();
	return widgetStore.restore(scope, saved, {
		reason: "resume",
		source: "own-sidecar",
		savedAt: 2_000_000,
		sessionManager: undefined,
		cwd: env.tmpDir,
	});
}

describe("widget sidecar restore and diagnostics bus", () => {
	it("replays the restored fresh diagnostics to an already subscribed consumer", async () => {
		const kept = freshFile("kept.ts");
		const stale = freshFile("stale.ts");
		for (const file of [kept, stale]) {
			recordDiagnostics(file, [
				{
					tool: "tsc",
					severity: "error",
					message: "boom",
					line: 1,
					column: 7,
					rule: "TS2322",
				},
			]);
		}
		const saved = exportWidgetState();
		utimesSync(stale, new Date(9_000_000), new Date(9_000_000));
		await restore(saved);
		expect(getFileDiagnosticSummaries().map((f) => f.filePath)).toEqual([kept]);
		expect(received).toHaveLength(1);
		expect(received[0].files).toEqual([
			{
				path: kept,
				diagnostics: [
					{
						severity: "error",
						message: "boom",
						tool: "tsc",
						line: 1,
						col: 7,
						ruleId: "TS2322",
					},
				],
			},
		]);
	});

	it.each(["false-positive", "suppress"] as const)(
		"keeps %s rows suppressed while replaying the live findings",
		async (disposition) => {
			// #5302: the persisted suppressed bucket must not become live bus errors.
			const mixed = freshFile("mixed.ts");
			const markedOnly = freshFile("marked-only.ts");
			const marked = {
				tool: "eslint",
				severity: "error",
				message: "marked",
				line: 1,
				rule: "no-constant-condition",
			};
			const live = { tool: "tsc", severity: "warning", message: "live" };
			for (const file of [mixed, markedOnly]) {
				recordDiagnostics(file, file === mixed ? [marked, live] : [marked]);
				markDisposition(
					env.tmpDir,
					{ ...marked, cwd: env.tmpDir, filePath: file, content },
					disposition,
				);
			}

			await restore();

			for (const file of [mixed, markedOnly]) {
				expect(getSuppressedDiagnostics(file)).toEqual([
					expect.objectContaining({ disposition }),
				]);
			}
			expect(
				renderWidget(120, { fg: (_color, text) => text }).join("\n"),
			).toContain("suppressed: 2");
			expect(received).toHaveLength(1);
			expect(received[0].files).toEqual([{ path: mixed, diagnostics: [live] }]);
		},
	);

	it.each(["clean", "unchecked", "pending"] as const)(
		"does not announce %s files as explicitly clean",
		async (state) => {
			// #5302: an empty snapshot is not a dirty-to-clean bus transition.
			const file = freshFile(`${state}.ts`);
			if (state === "pending") recordRunner(file, "tsc", "running", 0);
			else
				recordDiagnostics(
					file,
					[],
					undefined,
					undefined,
					state === "unchecked" ? { reason: "checker unavailable" } : undefined,
				);

			await restore();

			expect(exportWidgetState().files).toMatchObject([
				{
					filePath: file,
					hasFinalDiagnosticsSnapshot: state !== "pending",
					...(state === "unchecked" && {
						uncheckedReason: "checker unavailable",
					}),
				},
			]);
			expect(received).toEqual([]);
		},
	);

	it("announces a previously reported dirty file becoming clean only once", async () => {
		// #5302: preserve the live publisher's dirty-to-clean side of the gate.
		const file = freshFile("cleaned.ts");
		publishDiagnostics({
			cwd: env.tmpDir,
			files: [
				{
					path: file,
					diagnostics: [{ tool: "tsc", severity: "error", message: "old" }],
				},
			],
		});
		received.length = 0;
		recordDiagnostics(file, []);

		await restore();

		expect(received).toHaveLength(1);
		expect(received[0].files).toEqual([{ path: file, diagnostics: [] }]);
		received.length = 0;
		await restore();
		expect(received).toEqual([]);
	});

	it("emits nothing when every saved file is stale", async () => {
		const file = freshFile("stale.ts");
		recordDiagnostics(file, [{ severity: "error", message: "old" }]);
		const saved = exportWidgetState();
		utimesSync(file, new Date(9_000_000), new Date(9_000_000));

		expect(await restore(saved)).toEqual({ itemsIn: 1, itemsKept: 0 });
		expect(getFileDiagnosticSummaries()).toEqual([]);
		expect(received).toEqual([]);
	});

	it("uses the unknown tool fallback for a restored row without a tool", async () => {
		const file = freshFile("legacy.ts");
		recordDiagnostics(file, [{ severity: "warning", message: "legacy" }]);

		await restore();

		expect(received).toHaveLength(1);
		expect(received[0].files).toEqual([
			{
				path: file,
				diagnostics: [
					{ severity: "warning", message: "legacy", tool: "unknown" },
				],
			},
		]);
	});
	it("does not publish a saved row whose line is now past the end of the file", async () => {
		// #5302: the widget demotes a past-EOF row (stale: true); the v1 bus
		// payload has no stale field, so the restore must not send it as an error.
		const shrunk = freshFile("shrunk.ts");
		const onlyStale = freshFile("only-stale.ts");
		const long = `${"export const v = 1;\n".repeat(10)}`;
		for (const file of [shrunk, onlyStale]) {
			writeFileSync(file, long);
			utimesSync(file, new Date(1_000_000), new Date(1_000_000));
		}
		const pastEof = {
			tool: "tsc",
			severity: "error",
			message: "gone",
			line: 9,
		};
		const live = { tool: "tsc", severity: "warning", message: "live", line: 1 };
		recordDiagnostics(shrunk, [pastEof, live]);
		recordDiagnostics(onlyStale, [pastEof]);
		const saved = exportWidgetState();
		for (const file of [shrunk, onlyStale]) {
			writeFileSync(file, content);
			utimesSync(file, new Date(1_000_000), new Date(1_000_000));
		}

		await restore(saved);

		const rows = getFileDiagnosticSummaries().flatMap((f) => f.diagnostics);
		expect(rows.find((d) => d.message === "gone")).toMatchObject({
			stale: true,
			staleReason: "past-eof",
		});
		expect(received).toHaveLength(1);
		expect(received[0].files).toEqual([
			{
				path: shrunk,
				diagnostics: [
					{ severity: "warning", message: "live", tool: "tsc", line: 1 },
				],
			},
		]);
	});

	it("skips a saved row whose severity the widget does not recognize", async () => {
		// #5302: a hand-edited or foreign sidecar can carry severity "fatal"; the
		// widget ignores it (classifyDiagnosticTier is undefined) and the bus must not see it.
		const mixed = freshFile("mixed-severity.ts");
		const onlyBad = freshFile("only-bad-severity.ts");
		recordDiagnostics(mixed, [
			{ tool: "tsc", severity: "error", message: "bad" },
			{ tool: "tsc", severity: "warning", message: "good" },
		]);
		recordDiagnostics(onlyBad, [
			{ tool: "tsc", severity: "error", message: "bad" },
		]);
		const saved = JSON.parse(JSON.stringify(exportWidgetState()));
		for (const file of saved.files)
			for (const d of [...file.diagnostics, ...file.allDiagnostics])
				if (d.message === "bad") d.severity = "fatal";

		await restore(saved);

		expect(received).toHaveLength(1);
		expect(received[0].files).toEqual([
			{
				path: mixed,
				diagnostics: [{ severity: "warning", message: "good", tool: "tsc" }],
			},
		]);
	});

	it("imports and publishes nothing when the scope is retired during the freshness check", async () => {
		// #5302 (CodeRabbit): a restore that outlives its activation must not
		// replay the old session's findings through the successor's emitter.
		const file = freshFile("superseded.ts");
		recordDiagnostics(file, [
			{ severity: "error", message: "old", tool: "tsc" },
		]);
		const saved = exportWidgetState();
		clearWidgetState();

		const pending = widgetStore.restore(scope, saved, {
			reason: "resume",
			source: "own-sidecar",
			savedAt: 2_000_000,
			sessionManager: undefined,
			cwd: env.tmpDir,
		});
		retireScope(scope, "superseded");
		await pending;

		expect(getFileDiagnosticSummaries()).toEqual([]);
		expect(received).toEqual([]);
	});
	it("passes every recognized severity tier through unchanged", async () => {
		// #5302: the severity mapping replaced a type cast; info and hint must
		// not collapse into each other.
		const file = freshFile("tiers.ts");
		const tiers = ["error", "warning", "info", "hint"] as const;
		recordDiagnostics(
			file,
			tiers.map((severity) => ({ tool: "t", severity, message: severity })),
		);

		await restore();

		expect(
			received[0].files[0].diagnostics.map((d) => [d.message, d.severity]),
		).toEqual(tiers.map((t) => [t, t]));
	});
});

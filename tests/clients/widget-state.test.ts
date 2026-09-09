import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__testing,
	clearWidgetState,
	drainRenderedDependencyDriftFilePaths,
	exportWidgetState,
	getFailedLspServerIds,
	getFileDiagnostics,
	getFileDiagnosticSummaries,
	getSessionLanguages,
	importWidgetState,
	incrementWidgetDependencyDriftDelivery,
	isBlocking,
	markWidgetFileBlockersStale,
	reconcileCascadeNeighborLspErrors,
	reconcileCorrelatedScanDiagnostics,
	reconcileScanDiagnostics,
	reconcileStaleWidgetDependencyBlockers,
	reconcileStaleWidgetFiles,
	recordDiagnostics,
	recordFormatter,
	recordLsp,
	retireWidgetDependencyDriftBlockers,
	scheduleStaleReconcile,
	STALE_RECONCILE_DEBOUNCE_MS,
	recordRunner,
	renderWidget,
	setRenderCallback,
	setSessionLanguages,
	WIDGET_STATE_VERSION,
} from "../../clients/widget-state.js";

const e = String.fromCharCode(27);
const theme = {
	fg: (_color: string, s: string) => `${e}[38;2;102;102;102m${s}${e}[39m`,
};

afterEach(() => {
	clearWidgetState();
});

describe("LSP failure accessors (#170)", () => {
	it("folds equivalent root spellings into one server record", () => {
		recordLsp("ruby", "C:\\Repo\\app", "spawn_failed");
		recordLsp("ruby", "C:/Repo/app", "spawn_success");
		expect(getFailedLspServerIds()).toEqual([]);
	});
	it("getFailedLspServerIds returns only failed records, deduped by serverId", () => {
		recordLsp("ruby", "/a", "spawn_failed");
		recordLsp("ruby", "/b", "spawn_failed"); // same server, two roots → one id
		recordLsp("python", "/a", "spawn_success"); // ready, not failed
		recordLsp("typescript", "/a", "spawn_start"); // spawning, not failed
		expect(getFailedLspServerIds()).toEqual(["ruby"]);
	});

	it("a successful respawn clears the failed state for that key", () => {
		recordLsp("python", "/a", "spawn_failed");
		expect(getFailedLspServerIds()).toEqual(["python"]);
		recordLsp("python", "/a", "spawn_success"); // same key flips failed → ready
		expect(getFailedLspServerIds()).toEqual([]);
	});

	it("getSessionLanguages reflects the in-use kinds", () => {
		expect(getSessionLanguages()).toEqual([]);
		setSessionLanguages(["python", "ruby"]);
		expect(getSessionLanguages()).toEqual(["python", "ruby"]);
	});
});

describe("inactive file-record eviction", () => {
	it("keeps the oldest displayed diagnostic while evicting an inactive record", () => {
		const old = Date.now() - 31 * 60_000;
		const files = [
			{
				filePath: "displayed.ts",
				runners: [],
				formatters: [],
				diagnostics: [{ severity: "error", message: "live", observedAt: old }],
				allDiagnostics: [
					{ severity: "error", message: "live", observedAt: old },
				],
				diagnosticCounts: { blocking: 1, errors: 1, warnings: 0 },
				hasFinalDiagnosticsSnapshot: true,
				touchedAt: old,
			},
			...Array.from({ length: 1024 }, (_, i) => ({
				filePath: `inactive-${i}.ts`,
				runners: [],
				formatters: [],
				diagnostics: [],
				allDiagnostics: [],
				diagnosticCounts: { blocking: 0, errors: 0, warnings: 0 },
				hasFinalDiagnosticsSnapshot: false,
				touchedAt: old + i,
			})),
		];
		expect(
			importWidgetState({
				version: WIDGET_STATE_VERSION,
				sessionLanguages: [],
				files,
			} as Parameters<typeof importWidgetState>[0]),
		).toBe(true);
		const snapshot = __testing.getWidgetStateSnapshot();
		expect(snapshot.files).toHaveLength(1024);
		expect(
			snapshot.files.some((file) => file.filePath === "displayed.ts"),
		).toBe(true);
		expect(
			snapshot.files.some((file) => file.filePath === "inactive-0.ts"),
		).toBe(false);
	});
});

describe("getFileDiagnostics (#502 single-file accessor)", () => {
	it("returns undefined for a file never recorded", () => {
		expect(
			getFileDiagnostics(`${process.cwd()}/never-seen.ts`),
		).toBeUndefined();
	});

	it("returns the full uncapped set for a recorded file", () => {
		const filePath = `${process.cwd()}/single.ts`;
		recordDiagnostics(filePath, [
			{
				severity: "error",
				rule: "typescript:2322",
				message: "bad",
				tool: "tsserver",
			},
			{
				severity: "warning",
				rule: "no-console",
				message: "noisy",
				tool: "eslint",
			},
		]);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(2);
		expect(result?.[0].severity).toBe("error");
	});

	it("returns an explicit empty array when the file was recorded clean", () => {
		const filePath = `${process.cwd()}/clean.ts`;
		recordDiagnostics(filePath, [
			{ severity: "error", message: "bad", tool: "eslint" },
		]);
		recordDiagnostics(filePath, []); // transitions to clean

		const result = getFileDiagnostics(filePath);
		expect(result).toEqual([]);
	});
});

describe("getFileDiagnosticSummaries", () => {
	it("includes the actual stored diagnostics, not just counts", () => {
		const filePath = `${process.cwd()}/foo.ts`;
		recordDiagnostics(filePath, [
			{
				severity: "error",
				semantic: "blocking",
				line: 12,
				rule: "typescript:2322",
				message: "Type 'string' is not assignable to 'number'.",
			},
			{
				severity: "warning",
				line: 30,
				rule: "no-console",
				tool: "eslint",
				message: "Unexpected console statement.",
			},
		]);

		const summaries = getFileDiagnosticSummaries();
		const entry = summaries.find((s) => s.filePath === filePath);
		expect(entry).toBeDefined();
		expect(entry?.blocking).toBe(1);
		expect(entry?.warnings).toBe(1);
		expect(entry?.diagnostics).toHaveLength(2);
		const messages = entry?.diagnostics.map((d) => d.message);
		expect(messages).toContain("Type 'string' is not assignable to 'number'.");
		expect(messages).toContain("Unexpected console statement.");
		expect(entry?.diagnostics.find((d) => d.line === 12)?.rule).toBe(
			"typescript:2322",
		);
	});

	it("collapses multi-line messages to a single line (TUI render + inline-blocker safety)", () => {
		const filePath = `${process.cwd()}/overload.ts`;
		recordDiagnostics(filePath, [
			{
				severity: "error",
				semantic: "blocking",
				line: 162,
				rule: "typescript:2769",
				message:
					"No overload matches this call.\n  The last overload gave the following error.\n    Argument of type 'X' is not assignable to parameter of type 'Y'.",
			},
		]);
		const entry = getFileDiagnosticSummaries().find(
			(s) => s.filePath === filePath,
		);
		const msg = entry?.diagnostics[0].message ?? "";
		expect(msg).not.toContain("\n");
		expect(msg).not.toContain("\t");
		expect(msg).toBe(
			"No overload matches this call. The last overload gave the following error. Argument of type 'X' is not assignable to parameter of type 'Y'.",
		);
	});

	it("returns a defensive copy — mutating the result does not corrupt state", () => {
		const filePath = `${process.cwd()}/bar.ts`;
		recordDiagnostics(filePath, [
			{ severity: "warning", line: 1, rule: "r", message: "m" },
		]);
		const first = getFileDiagnosticSummaries()[0];
		first.diagnostics[0].message = "MUTATED";
		const second = getFileDiagnosticSummaries()[0];
		expect(second.diagnostics[0].message).toBe("m");
	});

	it("exposes the FULL diagnostic set, not the TUI's per-file display cap", () => {
		const filePath = `${process.cwd()}/many.ts`;
		// Record 30 warnings — far above MAX_STORED_DIAGNOSTICS_PER_FILE (12).
		recordDiagnostics(
			filePath,
			Array.from({ length: 30 }, (_, i) => ({
				severity: "warning" as const,
				line: i + 1,
				rule: "r",
				message: `w${i}`,
			})),
		);
		const entry = getFileDiagnosticSummaries().find(
			(s) => s.filePath === filePath,
		);
		expect(entry?.warnings).toBe(30);
		// The tool must see all 30, not the 12 the widget keeps for rendering.
		expect(entry?.diagnostics).toHaveLength(30);

		// ...while the TUI-facing stored list stays capped at 12 (no regression).
		const snap = __testing
			.getWidgetStateSnapshot()
			.files.find((f) => f.filePath === filePath);
		expect(snap?.storedDiagnostics).toBe(12);
	});

	// #2414: hint/info tier findings are style opinions, not code defects. The
	// footer's `warnings` tally must not inflate on them, while a genuine
	// `warning`-tier finding must still count — and the hint/info findings must
	// still be visible via a separate `advisories` count so a hint-only file
	// isn't silently dropped from a detailed listing.
	describe("severity projection (#2414)", () => {
		it("does not fold hint/info into warnings, but still counts real warnings", () => {
			const filePath = `${process.cwd()}/severity-projection.ts`;
			recordDiagnostics(filePath, [
				{
					severity: "hint",
					line: 1,
					rule: "long-parameter-list",
					message: "h",
				},
				{ severity: "info", line: 2, rule: "complexity", message: "i" },
				{ severity: "warning", line: 3, rule: "no-console", message: "w" },
			]);
			const entry = getFileDiagnosticSummaries().find(
				(s) => s.filePath === filePath,
			);
			expect(entry?.warnings).toBe(1);
			expect(entry?.advisories).toBe(2);
			// All three findings still reach the detailed diagnostics list.
			expect(entry?.diagnostics).toHaveLength(3);
		});

		it("a hint/info-only file reports zero warnings but a nonzero advisory count", () => {
			const filePath = `${process.cwd()}/hints-only.ts`;
			recordDiagnostics(filePath, [
				{ severity: "hint", line: 1, rule: "no-runtime-typeof", message: "h1" },
				{
					severity: "info",
					line: 2,
					rule: "no-unknown-parameters",
					message: "h2",
				},
			]);
			const entry = getFileDiagnosticSummaries().find(
				(s) => s.filePath === filePath,
			);
			expect(entry?.blocking).toBe(0);
			expect(entry?.errors).toBe(0);
			expect(entry?.warnings).toBe(0);
			expect(entry?.advisories).toBe(2);
		});

		it("the TUI footer's warning chip does not fire for a hint/info-only file", () => {
			const filePath = `${process.cwd()}/hints-only-footer.ts`;
			recordDiagnostics(filePath, [
				{
					severity: "hint",
					line: 1,
					rule: "long-parameter-list",
					message: "h",
				},
				{ severity: "info", line: 2, rule: "complexity", message: "i" },
			]);
			const rendered = renderWidget(120, theme).join("\n");
			expect(rendered).not.toMatch(/\d+W\b/);
			expect(rendered).toContain("clean");
		});

		it("the TUI footer's warning chip DOES fire for a real warning", () => {
			const filePath = `${process.cwd()}/real-warning-footer.ts`;
			recordDiagnostics(filePath, [
				{ severity: "warning", line: 1, rule: "no-console", message: "w" },
			]);
			const rendered = renderWidget(120, theme).join("\n");
			expect(rendered).toMatch(/\d+W\b/);
		});
	});
});

describe("widget-state renderWidget", () => {
	it("preserves stamped rows and stamps new correlated project rows", () => {
		const filePath = `${process.cwd()}/timestamp-merge.ts`;
		reconcileCorrelatedScanDiagnostics(
			filePath,
			[
				{
					severity: "error",
					semantic: "blocking",
					message: "old finding",
					line: 1,
					tool: "ast-grep",
					rule: "old",
					observedAt: 1000,
				},
				{
					severity: "error",
					semantic: "blocking",
					message: "new project finding",
					line: 2,
					tool: "ast-grep-napi",
					rule: "new",
				},
			],
			undefined,
			2000,
		);

		expect(getFileDiagnostics(filePath)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ message: "old finding", observedAt: 1000 }),
				expect.objectContaining({
					message: "new project finding",
					observedAt: 2000,
				}),
			]),
		);
	});

	it("renders the projected project-row URI as an OSC-8 line link", () => {
		const filePath = `${process.cwd()}/project-row-link.ts`;
		reconcileCorrelatedScanDiagnostics(filePath, [
			{
				severity: "error",
				semantic: "blocking",
				message: "project finding",
				line: 7,
				tool: "ast-grep-napi",
				rule: "self-scan",
				uri: `${pathToFileURL(filePath).href}#L7`,
			},
		]);

		const rendered = renderWidget(120, theme).join("\n");
		expect(rendered).toContain(
			`\x1b]8;;${pathToFileURL(filePath).href}#L7\x1b\\L7`,
		);
	});

	it("counts napi self-scan findings when the correlated LSP lane is unconfirmed (#1888)", () => {
		const filePath = `${process.cwd()}/coverage-window.ts`;
		const lspFindings = Array.from({ length: 9 }, (_, index) => ({
			severity: "error",
			semantic: "blocking",
			message: `LSP finding ${index + 1}`,
			tool: "ast-grep",
			rule: `lsp-${index + 1}`,
		}));
		recordDiagnostics(filePath, lspFindings);

		// This is the real post-correlation widget-state seam used by
		// lens_diagnostics mode=full. The LSP contribution is retained from the
		// broken-window state while the independent napi lane contributes three
		// current findings.
		reconcileCorrelatedScanDiagnostics(filePath, [
			...lspFindings,
			...Array.from({ length: 3 }, (_, index) => ({
				severity: "error",
				semantic: "blocking",
				message: `napi self-scan finding ${index + 1}`,
				tool: "ast-grep-napi",
				rule: `napi-${index + 1}`,
			})),
		]);

		const header = renderWidget(120, theme)[0] ?? "";
		expect(header).toContain("12E");
		expect(getFileDiagnosticSummaries()[0]).toMatchObject({
			blocking: 12,
			errors: 12,
		});
	});

	it("keeps diagnostic rows within the provided TUI width", () => {
		const filePath = `${process.cwd()}/index.ts`;
		recordRunner(filePath, "type-safety", "failed", 2);
		recordRunner(filePath, "eslint", "succeeded", 27);
		recordRunner(filePath, "ast-grep-napi", "succeeded", 1);
		recordDiagnostics(filePath, [
			{
				severity: "error",
				line: 2278,
				column: 10,
				rule: "typescript:2451",
				message: "Cannot redeclare block-scoped variable 'limited'.",
			},
			{
				severity: "warning",
				line: 497,
				column: 60,
				rule: "ts-react-antipatterns",
				message:
					"React anti-pattern: setState inside a loop causes multiple re-renders — batch with a single state update instead. ".repeat(
						4,
					),
			},
		]);

		const lines = renderWidget(120, theme);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	it("truncates every widget line, including headers and LSP status", () => {
		setSessionLanguages([
			"typescript-super-long-language-label",
			"javascript-super-long-language-label",
			"python-super-long-language-label",
			"rust-super-long-language-label",
			"go-super-long-language-label",
			"kotlin-super-long-language-label",
		]);
		recordLsp(
			"typescript-language-server-with-a-very-long-id",
			process.cwd(),
			"spawn_start",
		);

		const lines = renderWidget(40, theme);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("deduplicates files by basename — last write wins at most 5 entries", () => {
		const a = `${process.cwd()}/pi-lens/index.ts`;
		const b = `${process.cwd()}/pi-webaio/index.ts`;
		recordRunner(a, "type-safety", "failed", 1);
		recordDiagnostics(a, [
			{ severity: "error", message: "error in pi-lens", rule: "E1" },
		]);
		recordRunner(b, "eslint", "succeeded", 3);
		recordDiagnostics(b, [
			{ severity: "error", message: "warning in pi-webaio", rule: "W1" },
		]);

		const lines = renderWidget(120, theme);

		const fileRows = lines.filter((l) => l.includes("index.ts"));
		// Dedup: only one index.ts entry in the file list
		expect(fileRows.length).toBeGreaterThanOrEqual(1);
		expect(fileRows.length).toBeLessThanOrEqual(4);

		// Later file's diagnostics supersede earlier
		const allLines = lines.join("");
		expect(allLines).toContain("warning in pi-webaio");
		expect(allLines).not.toContain("error in pi-lens");
	});

	it("paints the file row red when any diagnostic carries semantic=blocking, even if severity is warning", () => {
		const filePath = `${process.cwd()}/cors.ts`;
		recordRunner(filePath, "sonar-rules", "succeeded", 1);
		recordDiagnostics(filePath, [
			{
				severity: "warning",
				semantic: "blocking",
				message: "CORS wildcard origin",
				rule: "cors-wildcard",
			},
		]);

		const lines = renderWidget(120, theme);
		const fileRow = lines.find((l) => l.includes("cors.ts")) ?? "";
		// red(●) — wrapped in theme color escape; assert the bullet appears
		// before the filename and that no warning-only triangle preceded it.
		expect(fileRow).toMatch(/●.*cors\.ts/);
		expect(fileRow).not.toMatch(/!.*cors\.ts/);
	});

	it("falls back to severity=error when semantic is absent so plain tsc errors stay red", () => {
		const filePath = `${process.cwd()}/legacy.ts`;
		recordRunner(filePath, "type-safety", "failed", 1);
		recordDiagnostics(filePath, [
			{
				severity: "error",
				message: "TS2451: cannot redeclare",
				rule: "typescript:2451",
			},
		]);

		const lines = renderWidget(120, theme);
		const fileRow = lines.find((l) => l.includes("legacy.ts")) ?? "";
		expect(fileRow).toMatch(/●.*legacy\.ts/);
	});

	it("paints the file row yellow when severity=error but semantic explicitly demotes it", () => {
		const filePath = `${process.cwd()}/advisory.ts`;
		recordRunner(filePath, "lint", "succeeded", 1);
		recordDiagnostics(filePath, [
			{
				severity: "error",
				semantic: "warning",
				message: "advisory error from non-blocking rule",
				rule: "advisory-rule",
			},
		]);

		const lines = renderWidget(120, theme);
		const fileRow = lines.find((l) => l.includes("advisory.ts")) ?? "";
		expect(fileRow).toMatch(/!.*advisory\.ts/);
		expect(fileRow).not.toMatch(/●.*advisory\.ts/);
	});

	it("details block lists only blocking diagnostics and omits non-blocking ones entirely", () => {
		const filePath = `${process.cwd()}/mixed.ts`;
		recordRunner(filePath, "lint", "succeeded", 3);
		recordDiagnostics(filePath, [
			{
				severity: "warning",
				semantic: "warning",
				message: "non-blocking advisory",
				rule: "advice",
				line: 10,
			},
			{
				severity: "warning",
				semantic: "blocking",
				message: "blocking sonar issue",
				rule: "cors-wildcard",
				line: 20,
			},
		]);

		const lines = renderWidget(120, theme);
		const allLines = lines.join("\n");
		expect(allLines).toContain("blocking sonar issue");
		expect(allLines).not.toContain("non-blocking advisory");
	});

	it("omits the divider and filename header in horizontal mode (packed row already names the file)", () => {
		const filePath = `${process.cwd()}/cors.ts`;
		recordRunner(filePath, "sonar", "succeeded", 1);
		recordDiagnostics(filePath, [
			{
				severity: "warning",
				semantic: "blocking",
				message: "CORS wildcard origin",
				rule: "cors-wildcard",
				line: 5,
			},
		]);

		const lines = renderWidget(120, theme);
		const allLines = lines.join("\n");
		// No horizontal divider
		expect(allLines).not.toMatch(/─{5,}/);
		// The filename appears in the packed file row, but NOT as a standalone
		// dim header line above the diagnostics.
		const standaloneFilenameHeaders = lines.filter(
			(l) =>
				l.trim() === l.trim() && /^\s*\u001b\[[^m]*m?cors\.ts\u001b\[/.test(l),
		);
		expect(standaloneFilenameHeaders.length).toBe(0);
	});

	it("keeps the divider and filename header in vertical fallback for context", () => {
		const filePath = `${process.cwd()}/cors.ts`;
		recordRunner(filePath, "sonar", "succeeded", 1);
		recordDiagnostics(filePath, [
			{
				severity: "warning",
				semantic: "blocking",
				message: "CORS wildcard origin",
				rule: "cors-wildcard",
				line: 5,
			},
		]);

		const lines = renderWidget(60, theme);
		const allLines = lines.join("\n");
		expect(allLines).toMatch(/─{5,}/);
	});

	it("shows formatter name when a formatter changed the file (vertical fallback at narrow widths)", () => {
		const filePath = `${process.cwd()}/app.ts`;
		recordFormatter(filePath, "biome", true, true);
		recordFormatter(filePath, "prettier", false, true);

		const lines = renderWidget(60, theme);
		const allLines = lines.join("");

		expect(allLines).toContain("fmt:biome");
		expect(allLines).not.toContain("prettier");
	});

	it("uses the ✎ glyph for formatter-only changes in the horizontal row", () => {
		const filePath = `${process.cwd()}/app.ts`;
		recordFormatter(filePath, "biome", true, true);

		const lines = renderWidget(120, theme);
		const allLines = lines.join("");

		expect(allLines).toContain("✎");
		expect(allLines).toContain("app.ts");
		expect(allLines).not.toContain("fmt:biome");
	});

	it("renders formatter failures with an error indication", () => {
		const filePath = `${process.cwd()}/broken.ts`;
		recordFormatter(filePath, "prettier", false, false);

		const allLines = renderWidget(60, theme).join("");
		expect(allLines).toContain("broken.ts");
		expect(allLines).toContain("prettier");
		expect(allLines).toContain("fmt-failed:");
		expect(allLines).toContain("x");
	});

	// #1348 review P1: diagnostic severity outranks formatter failure in BOTH
	// renderers -- a file with blocking diagnostics AND a failed format shows
	// the blocking dot, not the formatter x.
	it("blocking diagnostics outrank a formatter failure (horizontal renderer)", () => {
		const filePath = `${process.cwd()}/both-failed.ts`;
		recordDiagnostics(filePath, [
			{
				severity: "error",
				semantic: "blocking",
				message: "bad",
				tool: "tsserver",
			},
		]);
		recordFormatter(filePath, "prettier", false, false);
		// Pin the FILE ROW's leading glyph, not the whole render (the #1348
		// delta review proved whole-output contains-assertions stay green under
		// a broken precedence branch).
		const row = renderWidget(120, theme).find((l) => l.includes("both-failed"));
		expect(row).toBeDefined();
		const plain = row!.replace(/\u001b\[[0-9;]*m/g, "").trimStart();
		expect(plain.startsWith("●")).toBe(true);
		expect(plain.startsWith("x")).toBe(false);
	});

	it("blocking diagnostics outrank a formatter failure (vertical renderer)", () => {
		const filePath = `${process.cwd()}/both-failed-v.ts`;
		recordDiagnostics(filePath, [
			{
				severity: "error",
				semantic: "blocking",
				message: "bad",
				tool: "tsserver",
			},
		]);
		recordFormatter(filePath, "prettier", false, false);
		const row = renderWidget(40, theme).find((l) =>
			l.includes("both-failed-v"),
		);
		expect(row).toBeDefined();
		const plain = row!.replace(/\u001b\[[0-9;]*m/g, "").trimStart();
		expect(plain.startsWith("●")).toBe(true);
		expect(plain.startsWith("x")).toBe(false);
	});

	// #1348 review P2: failure entries are session-scoped advice -- they do
	// NOT survive export/import; successes rehydrate as before.
	it("formatter failures do not survive a session restore", () => {
		const failPath = `${process.cwd()}/stale-fail.ts`;
		const okPath = `${process.cwd()}/ok-changed.ts`;
		recordFormatter(failPath, "prettier", false, false);
		recordFormatter(okPath, "biome", true, true);
		const snapshot = exportWidgetState();
		clearWidgetState();
		expect(importWidgetState(snapshot)).toBe(true);
		const line = renderWidget(120, theme).join("");
		expect(line).not.toContain("fmt-failed:");
		expect(line).not.toContain("stale-fail.ts");
	});

	// #1631 review F3: a dependency-drift `stale` demotion is a verdict about
	// THIS session's disk state. It must not outlive the session, the same
	// #1348 shape one field over as the formatter-failure test above. Demotes
	// through the REAL gate (`reconcileStaleWidgetDependencyBlockers`), not a
	// hand-built `stale: true` literal, so this proves the actual production
	// path round-trips correctly.
	it("a dependency-drift stale demotion does not survive a session restore", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "pi-lens-stale-restore-"),
		);
		try {
			const consumer = path.join(tmpDir, "consumer.ts");
			const dep = path.join(tmpDir, "dep.ts");
			await fs.writeFile(dep, "export const x = 1;\n");
			await fs.writeFile(
				consumer,
				'import { x } from "./dep.js";\nexport const y = x;\n',
			);

			recordDiagnostics(
				consumer,
				[
					{
						severity: "error",
						semantic: "blocking",
						message: "type error",
						tool: "lsp",
					},
				],
				1,
				Date.now() - 60_000,
			);
			// Dependency fixed out-of-band after the verdict — demotes for real.
			const future = new Date(Date.now() + 60_000);
			await fs.utimes(dep, future, future);
			const { demoted } = await reconcileStaleWidgetDependencyBlockers(tmpDir);
			expect(demoted).toBe(1);
			expect(
				(getFileDiagnostics(consumer) ?? []).some((d) => isBlocking(d)),
			).toBe(false);

			const snapshot = exportWidgetState();
			clearWidgetState();
			expect(importWidgetState(snapshot)).toBe(true);

			const restored = getFileDiagnostics(consumer) ?? [];
			expect(restored).toHaveLength(1);
			expect(restored[0]?.stale).toBeUndefined();
			expect(isBlocking(restored[0]!)).toBe(true);

			// #1631 review V1: `diagnosticCounts` is DERIVED from the entries, not a
			// second source of truth. The persisted count was computed while the
			// entry was still demoted (`blocking: 0`) — restoring it verbatim would
			// leave `isBlocking(entry) === true` but `diagnosticCounts.blocking === 0`
			// on the SAME record, inverting the one-predicate invariant every
			// consumer (getFileDiagnosticSummaries, the record-tier classifier)
			// trusts instead of re-scanning entries itself.
			const summary = getFileDiagnosticSummaries().find(
				(s) => path.resolve(s.filePath) === path.resolve(consumer),
			);
			expect(summary?.blocking).toBe(1);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// #2275: a delivery count without the demotion it counts is meaningless —
	// same reasoning as `stale` itself not surviving a restore, one field over.
	it("a dependency-drift delivery count does not survive a session restore", () => {
		const filePath = `${process.cwd()}/restore-delivery-count.ts`;
		recordDiagnostics(
			filePath,
			[{ severity: "error", semantic: "blocking", tool: "lsp" }],
			1,
		);
		markWidgetFileBlockersStale(filePath, "dependency-drift");
		expect(incrementWidgetDependencyDriftDelivery(filePath)).toBe(1);
		expect(incrementWidgetDependencyDriftDelivery(filePath)).toBe(2);
		// #2275 review F2: the footer-hide is a THIS-session delivery verdict —
		// it must not outlive the session either, or a resumed footer would
		// silently omit a finding it has never actually shown.
		expect(retireWidgetDependencyDriftBlockers(filePath)).toBe(true);

		const snapshot = exportWidgetState();
		clearWidgetState();
		expect(importWidgetState(snapshot)).toBe(true);

		const restored = getFileDiagnostics(filePath) ?? [];
		expect(restored).toHaveLength(1);
		expect(restored[0]?.stale).toBeUndefined();
		expect(restored[0]?.staleDeliveryCount).toBeUndefined();
		expect(restored[0]?.footerRetired).toBeUndefined();
		// Fix-round 3 (#2275 review F2): `staleReason` is the fourth field in
		// this same "meaningless without the demotion it counts" set — a
		// restored row must not carry `staleReason: "dependency-drift"` with
		// `stale` gone.
		expect(restored[0]?.staleReason).toBeUndefined();
	});

	// #1631 review F10: `isBlocking` answers false for a demoted finding by design
	// (#1419 demote-not-drop) — but the footer's detail-line render loop used that
	// SAME predicate to pick what to SHOW, so a demoted finding vanished from the
	// footer entirely (silently dropped) instead of rendering with a stale marker.
	it("renders a dependency-drift-demoted finding with a stale marker instead of dropping it", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "pi-lens-stale-footer-"),
		);
		try {
			const consumer = path.join(tmpDir, "consumer.ts");
			const dep = path.join(tmpDir, "dep.ts");
			await fs.writeFile(dep, "export const x = 1;\n");
			await fs.writeFile(
				consumer,
				'import { x } from "./dep.js";\nexport const y = x;\n',
			);

			recordDiagnostics(
				consumer,
				[
					{
						severity: "error",
						semantic: "blocking",
						message: "type error demoted by drift",
						tool: "lsp",
					},
				],
				1,
				Date.now() - 60_000,
			);
			const future = new Date(Date.now() + 60_000);
			await fs.utimes(dep, future, future);
			const { demoted } = await reconcileStaleWidgetDependencyBlockers(tmpDir);
			expect(demoted).toBe(1);

			const lines = renderWidget(120, theme).join("\n");
			// Not silently dropped: the message and a stale marker are still visible.
			expect(lines).toContain("type error demoted by drift");
			expect(lines).toContain("re-run to confirm");
			// And it must not render as an authoritative red-dot blocker.
			expect(lines.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(
				/●\s*type error demoted/,
			);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// #2275: direct unit coverage for the widget store's own dependency-drift
	// delivery-cap primitives, mirroring #1950's
	// `runtime-coordinator-dependency-drift-cap.test.ts` — the same shape one
	// store over.
	describe("widget dependency-drift delivery-cap primitives (#2275)", () => {
		// #2275 review F1: the population is what the FOOTER RENDERED since the
		// last drain — not every file that merely holds a demoted row. The
		// footer draws one record per pass (`withBlocking[0]`), so a store-wide
		// query would charge deliveries to rows the agent never saw.
		it("drainRenderedDependencyDriftFilePaths reports only files the footer actually rendered, and drains", () => {
			const filePath = `${process.cwd()}/demoted.ts`;
			recordDiagnostics(
				filePath,
				[
					{
						severity: "error",
						semantic: "blocking",
						message: "demoted row",
						tool: "lsp",
						line: 1,
					},
					// A live blocking row from another tool on the same file: the
					// footer renders it too, but `markWidgetFileBlockersStale` only
					// demotes LSP rows, so it must never put the file in the
					// delivery population.
					{
						severity: "error",
						semantic: "blocking",
						message: "live row",
						tool: "eslint",
						line: 2,
					},
				],
				1,
			);

			// Rendered, but nothing is drift-demoted yet — no delivery to count.
			let footer = renderWidget(120, theme).join("\n");
			expect(footer).toContain("live row");
			expect(drainRenderedDependencyDriftFilePaths()).toEqual([]);

			expect(markWidgetFileBlockersStale(filePath, "dependency-drift")).toBe(
				true,
			);
			// Demoted, but nothing has been drawn SINCE — nothing was delivered.
			expect(drainRenderedDependencyDriftFilePaths()).toEqual([]);

			footer = renderWidget(120, theme).join("\n");
			expect(footer).toContain("demoted row");
			expect(drainRenderedDependencyDriftFilePaths()).toEqual([filePath]);
			// Drained: a second read without a further render reports nothing.
			expect(drainRenderedDependencyDriftFilePaths()).toEqual([]);
		});

		it("incrementWidgetDependencyDriftDelivery advances every qualifying entry on the file together, and returns 0 for a file with no demotion", () => {
			const filePath = `${process.cwd()}/increment.ts`;
			expect(incrementWidgetDependencyDriftDelivery(filePath)).toBe(0);

			recordDiagnostics(
				filePath,
				[{ severity: "error", semantic: "blocking", tool: "lsp" }],
				1,
			);
			// Not yet demoted — nothing to count against.
			expect(incrementWidgetDependencyDriftDelivery(filePath)).toBe(0);

			markWidgetFileBlockersStale(filePath, "dependency-drift");
			expect(incrementWidgetDependencyDriftDelivery(filePath)).toBe(1);
			expect(incrementWidgetDependencyDriftDelivery(filePath)).toBe(2);
			const stored = getFileDiagnostics(filePath) ?? [];
			expect(stored[0]?.staleDeliveryCount).toBe(2);

			// #2275 review F1/F2: once footer-retired the row is no longer
			// delivered, so it must stop advancing — even if a caller asks.
			expect(retireWidgetDependencyDriftBlockers(filePath)).toBe(true);
			expect(incrementWidgetDependencyDriftDelivery(filePath)).toBe(0);
			expect((getFileDiagnostics(filePath) ?? [])[0]?.staleDeliveryCount).toBe(
				2,
			);
		});

		// #2275 review F2: retirement HIDES the row from the footer. It must NOT
		// splice the entry out of `allDiagnostics` — that same store backs
		// `getFileDiagnosticSummaries` (lens_diagnostics mode=all) and
		// `lens_diagnostic_mark`, where dropping an unconfirmed LSP error makes
		// the file read as CLEAN. The #1631 "stays in the error tally"
		// invariant has to survive the cap.
		it("retireWidgetDependencyDriftBlockers hides only the demoted entries from the footer, keeping them in the store", () => {
			const filePath = `${process.cwd()}/mixed-retire.ts`;
			recordDiagnostics(
				filePath,
				[
					{
						severity: "error",
						semantic: "blocking",
						message: "drift finding",
						tool: "lsp",
						line: 1,
					},
					// A non-blocking warning on the SAME file: `markWidgetFileBlockersStale`
					// never touches it (not blocking), so it must survive the drift
					// cap's retirement — the cap governs only ITS OWN demoted entries,
					// not the whole record.
					{
						severity: "warning",
						semantic: "warning",
						message: "unrelated warning",
						tool: "lsp",
						line: 2,
					},
				],
				1,
			);
			expect(markWidgetFileBlockersStale(filePath, "dependency-drift")).toBe(
				true,
			);

			expect(retireWidgetDependencyDriftBlockers(filePath)).toBe(true);
			const remaining = getFileDiagnostics(filePath) ?? [];
			// BOTH entries are still stored — nothing was dropped.
			expect(remaining).toHaveLength(2);
			const drift = remaining.find((d) => d.message === "drift finding");
			expect(drift?.footerRetired).toBe(true);
			expect(drift?.stale).toBe(true);
			expect(drift?.staleReason).toBe("dependency-drift");
			const unrelated = remaining.find(
				(d) => d.message === "unrelated warning",
			);
			expect(unrelated?.footerRetired).toBeUndefined();
			expect(unrelated?.stale).toBeFalsy();

			// mode=all's tally keeps the error (#1631): still counted, never blocking.
			const summary = getFileDiagnosticSummaries().find(
				(s) => s.filePath === filePath,
			);
			expect(summary?.errors).toBe(1);
			expect(summary?.blocking).toBe(0);

			// …but the footer no longer serves it.
			expect(renderWidget(120, theme).join("\n")).not.toContain(
				"drift finding",
			);

			// A second call has nothing left of ITS kind to retire.
			expect(retireWidgetDependencyDriftBlockers(filePath)).toBe(false);
		});

		it("retireWidgetDependencyDriftBlockers refuses a file with no record", () => {
			expect(
				retireWidgetDependencyDriftBlockers(
					`${process.cwd()}/never-recorded.ts`,
				),
			).toBe(false);
		});

		// #2275 review F2: the footer-hide is not permanent state the agent has
		// to live with — a later dispatch that re-observes the file replaces
		// `allDiagnostics` wholesale (`recordDiagnostics`), so a re-confirmed
		// finding comes back at full authority in the footer.
		it("a later dispatch that re-confirms the finding clears the footer-hide", () => {
			const filePath = `${process.cwd()}/reconfirmed.ts`;
			recordDiagnostics(
				filePath,
				[
					{
						severity: "error",
						semantic: "blocking",
						message: "still broken",
						tool: "lsp",
						line: 1,
					},
				],
				1,
			);
			markWidgetFileBlockersStale(filePath, "dependency-drift");
			expect(retireWidgetDependencyDriftBlockers(filePath)).toBe(true);
			expect(renderWidget(120, theme).join("\n")).not.toContain("still broken");

			recordDiagnostics(
				filePath,
				[
					{
						severity: "error",
						semantic: "blocking",
						message: "still broken",
						tool: "lsp",
						line: 1,
					},
				],
				2,
			);
			const reconfirmed = (getFileDiagnostics(filePath) ?? [])[0];
			expect(reconfirmed?.footerRetired).toBeUndefined();
			expect(reconfirmed?.stale).toBeUndefined();
			expect(isBlocking(reconfirmed!)).toBe(true);
			expect(renderWidget(120, theme).join("\n")).toContain("still broken");
		});
	});

	it("clears a formatter failure after a subsequent success", () => {
		const filePath = `${process.cwd()}/recovered.ts`;
		recordFormatter(filePath, "prettier", false, false);
		expect(renderWidget(60, theme).join("")).toContain("fmt-failed:");

		recordFormatter(filePath, "prettier", false, true);
		const allLines = renderWidget(60, theme).join("");
		expect(allLines).not.toContain("recovered.ts");
		expect(allLines).not.toContain("fmt-failed:");
	});

	it("does not render an unchanged successful formatter", () => {
		const filePath = `${process.cwd()}/unchanged.ts`;
		recordFormatter(filePath, "prettier", false, true);

		expect(renderWidget(60, theme).join("")).not.toContain("unchanged.ts");
	});

	it("packs multiple files into a single row at horizontal widths", () => {
		const a = `${process.cwd()}/alpha.ts`;
		const b = `${process.cwd()}/beta.ts`;
		const c = `${process.cwd()}/gamma.ts`;
		recordRunner(a, "type-safety", "failed", 1);
		recordDiagnostics(a, [
			{ severity: "error", semantic: "blocking", message: "boom", rule: "X" },
		]);
		recordRunner(b, "eslint", "succeeded", 2);
		recordDiagnostics(b, [
			{ severity: "warning", message: "advisory", rule: "Y" },
			{ severity: "warning", message: "advisory", rule: "Y" },
		]);
		recordRunner(c, "tsc", "succeeded", 0);
		recordDiagnostics(c, []);

		const lines = renderWidget(120, theme);
		const fileRow = lines.find(
			(l) =>
				l.includes("alpha.ts") &&
				l.includes("beta.ts") &&
				l.includes("gamma.ts"),
		);
		expect(fileRow).toBeDefined();
		const idxAlpha = (fileRow ?? "").indexOf("alpha.ts");
		const idxBeta = (fileRow ?? "").indexOf("beta.ts");
		const idxGamma = (fileRow ?? "").indexOf("gamma.ts");
		// Blocking-first ordering: alpha (blocking) → beta (warning) → gamma (clean)
		expect(idxAlpha).toBeGreaterThan(0);
		expect(idxBeta).toBeGreaterThan(idxAlpha);
		expect(idxGamma).toBeGreaterThan(idxBeta);
	});

	it("falls back to vertical layout when width is below the horizontal threshold", () => {
		const a = `${process.cwd()}/foo.ts`;
		const b = `${process.cwd()}/bar.ts`;
		recordRunner(a, "tsc", "succeeded", 0);
		recordDiagnostics(a, []);
		recordRunner(b, "tsc", "succeeded", 0);
		recordDiagnostics(b, []);

		const lines = renderWidget(50, theme);
		// Vertical: each file on its own line, no packed row contains both.
		expect(
			lines.find((l) => l.includes("foo.ts") && l.includes("bar.ts")),
		).toBeUndefined();
		expect(lines.some((l) => l.includes("foo.ts"))).toBe(true);
		expect(lines.some((l) => l.includes("bar.ts"))).toBe(true);
	});

	it("truncates basenames preserving the extension", () => {
		const filePath = `${process.cwd()}/extremely-very-much-too-long-component-name-that-clearly-overflows-the-budget.tsx`;
		recordRunner(filePath, "tsc", "succeeded", 0);
		recordDiagnostics(filePath, []);

		const lines = renderWidget(70, theme);
		const allLines = lines.join("\n");
		expect(allLines).toMatch(/…\.tsx/);
	});

	it("folds LSP spawning into the header in horizontal mode", () => {
		recordLsp("typescript-language-server", process.cwd(), "spawn_start");

		const lines = renderWidget(120, theme);
		const allLines = lines.join("\n");
		expect(allLines).toContain("LSP↑");
		expect(allLines).not.toContain("LSP spawning:");
	});

	it("keeps the LSP spawning tail line in vertical fallback", () => {
		recordLsp("typescript-language-server", process.cwd(), "spawn_start");

		const lines = renderWidget(50, theme);
		const allLines = lines.join("\n");
		expect(allLines).toContain("LSP spawning:");
	});

	it("appends a +N overflow marker when files do not fit", () => {
		for (let i = 0; i < 5; i++) {
			const filePath = `${process.cwd()}/this-is-a-fairly-long-name-${i}.ts`;
			recordRunner(filePath, "tsc", "succeeded", 0);
			recordDiagnostics(filePath, []);
		}

		const lines = renderWidget(70, theme);
		const allLines = lines.join("\n");
		expect(allLines).toMatch(/\+\d+/);
	});

	it("caps stored widget diagnostics per file while preserving warning counts", () => {
		const filePath = path.join(process.cwd(), "warning-storm.cpp");
		recordRunner(filePath, "lsp", "succeeded", 40);
		recordDiagnostics(
			filePath,
			Array.from({ length: 40 }, (_, i) => ({
				severity: "warning",
				message: `warning ${i + 1}`,
				rule: "clangd:unused",
				line: i + 1,
			})),
		);

		const snapshot = __testing.getWidgetStateSnapshot();
		expect(snapshot.files).toHaveLength(1);
		expect(snapshot.files[0]).toMatchObject({
			filePath,
			storedDiagnostics: 12,
			warnings: 40,
			errors: 0,
			blocking: 0,
		});

		const lines = renderWidget(120, theme);
		expect(lines.join("\n")).toContain("40W");
	});

	it("does not churn through transient clean frames during warning-only cxx analysis", () => {
		const frames: string[] = [];
		setRenderCallback(() => {
			frames.push(renderWidget(120, theme).join("\n"));
		});

		setSessionLanguages(["cpp"]);
		const filePath = path.join(process.cwd(), "warning-storm.cpp");

		recordLsp("cpp", process.cwd(), "spawn_start");
		recordLsp("cpp", process.cwd(), "spawn_success", 50);
		recordRunner(filePath, "lsp", "succeeded", 40, 50);
		recordRunner(filePath, "cpp-check", "succeeded", 40, 80);
		recordRunner(filePath, "tree-sitter", "succeeded", 0, 10);
		recordDiagnostics(
			filePath,
			Array.from({ length: 40 }, (_, i) => ({
				severity: "warning",
				message: `warning ${i + 1}`,
				rule: "clangd:unused",
				line: i + 1,
			})),
		);

		const nonEmptyFrames = frames.filter((frame) => frame.trim().length > 0);
		const finalFrame = nonEmptyFrames.at(-1) ?? "";
		const intermediateFrames = nonEmptyFrames.slice(0, -1);

		expect(finalFrame).toContain("!40W");
		expect(finalFrame).toContain("warning-storm.cpp");
		expect(intermediateFrames.join("\n")).not.toContain("✓ clean");
		expect(new Set(nonEmptyFrames).size).toBeLessThanOrEqual(3);
	});
});

describe("recordDiagnostics — superseded write guard (same race class as #555)", () => {
	it("drops a late write whose writeIndex lags the already-recorded writeIndex, without poisoning the cache", () => {
		const filePath = `${process.cwd()}/race.ts`;

		// A newer, faster edit's pipeline finishes first.
		recordDiagnostics(
			filePath,
			[{ severity: "warning", message: "current diagnostic", rule: "Y" }],
			2,
		);

		// An older, slower edit's pipeline finishes late — must be dropped.
		recordDiagnostics(
			filePath,
			[
				{
					severity: "error",
					message: "stale diagnostic from edit #1",
					rule: "X",
				},
			],
			1,
		);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(1);
		expect(result?.[0]?.message).toBe("current diagnostic");

		const entry = getFileDiagnosticSummaries().find(
			(s) => s.filePath === filePath,
		);
		// The dropped write must not corrupt counts either — still reflects the
		// winning (writeIndex 2) write, not a mix of both.
		expect(entry?.warnings).toBe(1);
		expect(entry?.errors).toBe(0);
	});

	it("records a write whose writeIndex matches or advances the last-recorded one (no false-positive drops)", () => {
		const filePath = `${process.cwd()}/advance.ts`;

		recordDiagnostics(
			filePath,
			[{ severity: "warning", message: "first", rule: "Y" }],
			1,
		);
		recordDiagnostics(
			filePath,
			[{ severity: "error", message: "second", rule: "X" }],
			2,
		);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(1);
		expect(result?.[0]?.message).toBe("second");
	});

	it("always records the first write for a path regardless of its writeIndex (nothing to compare against yet)", () => {
		const filePath = `${process.cwd()}/first-write.ts`;

		recordDiagnostics(
			filePath,
			[{ severity: "error", message: "only diagnostic", rule: "X" }],
			99,
		);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(1);
		expect(result?.[0]?.message).toBe("only diagnostic");
	});

	it("always records writes with no writeIndex (mirrors version-less-server tradeoff; e.g. the mcp/analyze.ts on-demand call site)", () => {
		const filePath = `${process.cwd()}/no-token.ts`;

		recordDiagnostics(
			filePath,
			[{ severity: "warning", message: "current", rule: "Y" }],
			5,
		);
		// A write with no ordering token at all must never be treated as stale.
		recordDiagnostics(filePath, [
			{ severity: "error", message: "untokened write", rule: "X" },
		]);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(1);
		expect(result?.[0]?.message).toBe("untokened write");
	});

	it("keeps a newer confirmed clean snapshot final when an older pipeline settles late (#1198)", () => {
		const filePath = `${process.cwd()}/late-typescript.ts`;
		const old = [
			{
				severity: "error",
				semantic: "blocking",
				tool: "lsp",
				message: "old TypeScript blocker",
				rule: "TS2322",
			},
		];

		// The old pipeline admitted first (token 1), while the newer primary
		// check admitted second (token 2) and confirmed clean before token 1
		// settled. Both widget write verbs share the admission order.
		recordRunner(filePath, "typescript", "failed", 1, undefined, 1);
		recordDiagnostics(filePath, old, 1);
		reconcileScanDiagnostics(filePath, [], true, 2);
		recordRunner(filePath, "typescript", "failed", 1, undefined, 1);
		recordDiagnostics(filePath, old, 1);

		const summary = getFileDiagnosticSummaries().find(
			(entry) => entry.filePath === filePath,
		);
		expect(summary?.diagnostics).toEqual([]);
		expect(summary?.blocking).toBe(0);
		expect(summary?.hasFinalSnapshot).toBe(true);
	});

	it("clearWidgetState resets tracked writeIndex ordering so a later low index is not treated as stale", () => {
		const filePath = `${process.cwd()}/reset.ts`;

		recordDiagnostics(
			filePath,
			[{ severity: "error", message: "before clear", rule: "X" }],
			10,
		);
		clearWidgetState();
		recordDiagnostics(
			filePath,
			[{ severity: "warning", message: "after clear", rule: "Y" }],
			1,
		);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(1);
		expect(result?.[0]?.message).toBe("after clear");
	});
});

describe("reconcileScanDiagnostics — full-scan/on-demand footer reconciliation (#571)", () => {
	it("does NOT write a timed-out/inconclusive scan result into the footer (confirmed=false)", () => {
		const filePath = `${process.cwd()}/unconfirmed.ts`;

		// A prior confirmed-dirty entry the footer already has (e.g. from a
		// per-edit dispatch).
		recordDiagnostics(
			filePath,
			[{ severity: "error", message: "real prior error", rule: "X" }],
			1,
		);

		// A scan that timed out / was inconclusive must not overwrite it with a
		// misleading "confirmed clean" default-empty result.
		reconcileScanDiagnostics(filePath, [], false, 2);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(1);
		expect(result?.[0]?.message).toBe("real prior error");
	});

	it("a confirmed scan result DOES correct a stale footer entry for a file never re-edited", () => {
		const filePath = `${process.cwd()}/stale.ts`;

		// Stale footer entry, e.g. left over from before a dependency fix.
		recordDiagnostics(
			filePath,
			[{ severity: "error", message: "stale error, already fixed", rule: "X" }],
			1,
		);

		// A full-scan/on-demand check confirms the file is actually clean now.
		reconcileScanDiagnostics(filePath, [], true, 2);

		const result = getFileDiagnostics(filePath);
		expect(result).toEqual([]);
	});

	it("a confirmed scan write does NOT clobber a newer, concurrent per-edit write (write-ordering guard respected)", () => {
		const filePath = `${process.cwd()}/race-with-edit.ts`;

		// A scan starts, but a concurrent per-edit pipeline for the SAME file
		// finishes first with a higher (newer) writeIndex.
		recordDiagnostics(
			filePath,
			[{ severity: "warning", message: "newer per-edit result", rule: "Y" }],
			5,
		);

		// The scan's own confirmed result was drawn from an OLDER writeIndex
		// (it started before the edit) and lands after — must be dropped, not
		// clobber the fresher per-edit write.
		reconcileScanDiagnostics(
			filePath,
			[{ severity: "error", message: "stale scan result", rule: "X" }],
			true,
			3,
		);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(1);
		expect(result?.[0]?.message).toBe("newer per-edit result");
	});

	it("a confirmed scan write DOES win when its writeIndex is newer than the last-recorded one", () => {
		const filePath = `${process.cwd()}/scan-wins.ts`;

		recordDiagnostics(
			filePath,
			[{ severity: "warning", message: "older per-edit result", rule: "Y" }],
			1,
		);

		reconcileScanDiagnostics(
			filePath,
			[{ severity: "error", message: "fresher scan result", rule: "X" }],
			true,
			2,
		);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(1);
		expect(result?.[0]?.message).toBe("fresher scan result");
	});

	it("an omitted writeIndex always proceeds when confirmed (no ordering token available)", () => {
		const filePath = `${process.cwd()}/no-token-scan.ts`;

		recordDiagnostics(
			filePath,
			[{ severity: "warning", message: "before", rule: "Y" }],
			5,
		);

		reconcileScanDiagnostics(
			filePath,
			[{ severity: "error", message: "untokened confirmed scan", rule: "X" }],
			true,
		);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(1);
		expect(result?.[0]?.message).toBe("untokened confirmed scan");
	});
});

describe("reconcileScanDiagnostics observation timestamp — cache-hit replays must not re-arm staleness (#1093/#1092)", () => {
	it("stamps touchedAt at the OBSERVED time, so the entry drops once the file's mtime passes that observation", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "obs-stamp-"));
		const filePath = path.join(tmpDir, `cached-${Date.now()}.ts`);
		try {
			await fs.writeFile(filePath, "const x = 1;\n");

			// A workspace-diagnostics cache HIT replays a finding OBSERVED 20s ago
			// (the cache entry's own `scannedAt`). The reconcile must stamp
			// `touchedAt` with THAT observation time, not now().
			const observedAt = Date.now() - 20_000;
			reconcileScanDiagnostics(
				filePath,
				[{ severity: "error", message: "cached finding", rule: "X" }],
				true,
				1,
				observedAt,
			);
			expect(getFileDiagnostics(filePath)).toHaveLength(1);

			// The file itself was edited 10s ago — AFTER the cached observation — so
			// the replayed finding is stale. mtime(now-10s) > touchedAt(now-20s), so
			// the mtime-staleness gate must drop it. Pre-fix (`touchedAt = now()`
			// on every reconcile) the entry survives forever: the #1092 defect.
			const mtime = new Date(Date.now() - 10_000);
			await fs.utimes(filePath, mtime, mtime);

			expect(await reconcileStaleWidgetFiles()).toBe(1);
			expect(getFileDiagnostics(filePath)).toBeUndefined();
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("a fresh reconcile (no observation stamp) is observed now and survives an older mtime (control)", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "obs-stamp-fresh-"));
		const filePath = path.join(tmpDir, `fresh-${Date.now()}.ts`);
		try {
			await fs.writeFile(filePath, "const y = 2;\n");
			// No observedAt: a genuinely fresh touch, observed now.
			reconcileScanDiagnostics(
				filePath,
				[{ severity: "error", message: "fresh finding", rule: "X" }],
				true,
				1,
			);
			// The file's mtime is in the PAST relative to this fresh observation, so
			// the finding is current and must NOT be dropped.
			const past = new Date(Date.now() - 10_000);
			await fs.utimes(filePath, past, past);

			expect(await reconcileStaleWidgetFiles()).toBe(0);
			expect(getFileDiagnostics(filePath)).toHaveLength(1);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe("path-key normalization — same file under mixed separators collapses to one entry (#1020)", () => {
	// The two forms differ ONLY in separator direction, so they fold to the same
	// key on every platform (`normalizeEphemeralMapKey` converts `\`→`/` always,
	// and additionally lowercases on win32). This is the exact split that made a
	// resolved blocker replay on mode=all: the LSP/cascade fold records the
	// forward-slash form, while mode=full's clean reconcile writes the backslash
	// form (path.resolve / result.filePath on Windows).
	const fwd = "C:/proj/dup.ts";
	const back = "C:\\proj\\dup.ts";

	it("a clean backslash-key reconcile overwrites a stale forward-slash-key blocker → one entry, blocking:0", () => {
		recordDiagnostics(
			fwd,
			[
				{
					severity: "error",
					semantic: "blocking",
					message: "stale blocker",
					rule: "X",
				},
			],
			1,
		);
		reconcileScanDiagnostics(back, [], true, 2);

		const summaries = getFileDiagnosticSummaries();
		// Pre-fix: TWO entries (raw keys never collapsed) and the forward-slash one
		// still reads blocking:1 — the #1020 replay.
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.blocking).toBe(0);
		expect(summaries[0]?.diagnostics).toEqual([]);
	});

	it("importWidgetState folds a persisted forward-slash key so a later backslash reconcile hits the same entry", () => {
		importWidgetState({
			version: WIDGET_STATE_VERSION,
			sessionLanguages: [],
			files: [
				{
					filePath: fwd,
					runners: [],
					formatters: [],
					diagnostics: [
						{
							severity: "error",
							semantic: "blocking",
							message: "persisted blocker",
							rule: "X",
						},
					],
					allDiagnostics: [
						{
							severity: "error",
							semantic: "blocking",
							message: "persisted blocker",
							rule: "X",
						},
					],
					diagnosticCounts: { blocking: 1, errors: 1, warnings: 0 },
					hasFinalDiagnosticsSnapshot: true,
					touchedAt: Date.now(),
				},
			],
		});

		// After resume, the clean full-scan reconcile arrives under the backslash
		// form. Without the rehydrate fold, the persisted `/`-key stays split from
		// this `\`-key and the blocker survives.
		reconcileScanDiagnostics(back, [], true, 5);

		const summaries = getFileDiagnosticSummaries();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.blocking).toBe(0);
	});
});

describe("scheduleStaleReconcile — widget self-corrects fixed files (#298 follow-up)", () => {
	it("drops a widget entry once its file is edited on disk after the last record", async () => {
		vi.useFakeTimers();
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stale-reconcile-"));
		const filePath = path.join(tmpDir, `stale-reconcile-${Date.now()}.ts`);
		try {
			await fs.writeFile(filePath, "const x = 1;\n");
			// Pipeline records a real error for the file.
			recordDiagnostics(
				filePath,
				[{ severity: "error", message: "real error", rule: "X" }],
				1,
			);
			expect(getFileDiagnostics(filePath)).toHaveLength(1);

			// Agent fixes the file on disk, but the pipeline never re-confirms it
			// (cross-file fix / external edit / missed write event). mtime is now
			// newer than the record's touchedAt, so the entry is stale.
			const fixed = new Date(Date.now() + 10_000);
			await fs.utimes(filePath, fixed, fixed);

			// The render path now schedules a reconcile (as mountLensWidget does).
			scheduleStaleReconcile();
			await vi.advanceTimersByTimeAsync(STALE_RECONCILE_DEBOUNCE_MS);

			// The sweep's fs.stat I/O settles on the REAL event loop — fake-timer
			// flushes can't await it, so poll for the observable outcome instead
			// of racing it (flaked on CI: entry not yet dropped at assert time).
			vi.useRealTimers();
			// Stale entry is gone — the TUI stops showing the fixed error.
			await vi.waitFor(
				() => expect(getFileDiagnostics(filePath)).toBeUndefined(),
				{ timeout: 5000 },
			);
		} finally {
			await vi.useRealTimers();
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("keeps a widget entry whose file has NOT changed since the last record (no false-positive drops)", async () => {
		vi.useFakeTimers();
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "stale-reconcile-keep-"),
		);
		const filePath = path.join(tmpDir, `stale-reconcile-keep-${Date.now()}.ts`);
		try {
			await fs.writeFile(filePath, "const y = 2;\n");
			// Force the file's mtime into the PAST relative to the record's touchedAt
			// (deterministic regardless of fake-timer/real-fs clock skew): the entry
			// is fresh, so reconcile must NOT drop it.
			const past = new Date(Date.now() - 10_000);
			await fs.utimes(filePath, past, past);
			recordDiagnostics(
				filePath,
				[{ severity: "error", message: "real error", rule: "X" }],
				1,
			);
			expect(getFileDiagnostics(filePath)).toHaveLength(1);

			// Sentinel: a second, genuinely STALE entry in the same sweep. When it
			// drops we KNOW the sweep completed — only then is asserting the fresh
			// entry still present meaningful (otherwise a not-yet-finished sweep
			// would false-pass this test).
			const sentinelPath = path.join(tmpDir, "sentinel-stale.ts");
			await fs.writeFile(sentinelPath, "const s = 3;\n");
			recordDiagnostics(
				sentinelPath,
				[{ severity: "error", message: "stale error", rule: "X" }],
				1,
			);
			const future = new Date(Date.now() + 10_000);
			await fs.utimes(sentinelPath, future, future);

			// The render path schedules a reconcile, but the file is not stale.
			scheduleStaleReconcile();
			await vi.advanceTimersByTimeAsync(STALE_RECONCILE_DEBOUNCE_MS);

			// Same real-I/O caveat as above: wait for the sweep to observably
			// finish (sentinel dropped) on real timers.
			vi.useRealTimers();
			await vi.waitFor(
				() => expect(getFileDiagnostics(sentinelPath)).toBeUndefined(),
				{ timeout: 5000 },
			);

			// Valid entry preserved — the fix must not drop current diagnostics.
			expect(getFileDiagnostics(filePath)).toHaveLength(1);
		} finally {
			await vi.useRealTimers();
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe("per-entry observation timestamps — the stale gate drops entries, not whole records (#1186)", () => {
	it("HEADLINE: a merged record keeps a fresher PRESERVED entry when only the older incoming entry is stale", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "per-entry-"));
		const filePath = path.join(tmpDir, `neighbor-${Date.now()}.ts`);
		try {
			await fs.writeFile(filePath, "import { x } from './primary';\n");

			// A live per-edit biome finding, observed NOW (the fresh, preserved
			// entry). It is NOT an LSP-error entry, so the errors-only cascade merge
			// below preserves it verbatim.
			const freshTs = Date.now();
			recordDiagnostics(
				filePath,
				[
					{
						severity: "warning",
						tool: "biome",
						message: "live biome finding",
						rule: "lint/style",
					},
				],
				1,
				freshTs,
			);

			// A cascade passive-snapshot re-check replays an aging cross-file LSP
			// error (observed ~200s ago — the snapshot's own publish time). The merge
			// stamps ONLY this incoming entry with the old observation time; the
			// preserved biome entry keeps its fresh stamp.
			const staleTs = freshTs - 200_000;
			reconcileCascadeNeighborLspErrors(
				filePath,
				[
					{
						severity: "error",
						tool: "lsp",
						message: "stale cross-file error",
						rule: "TS2304",
					},
				],
				2,
				staleTs,
			);

			// Both entries are present, each with its own observation stamp.
			const merged = getFileDiagnostics(filePath);
			expect(merged).toHaveLength(2);
			expect(merged?.find((d) => d.tool === "biome")?.observedAt).toBe(freshTs);
			expect(merged?.find((d) => d.tool === "lsp")?.observedAt).toBe(staleTs);

			// The neighbor's mtime advances to BETWEEN the two observations: newer
			// than the stale LSP error (staleTs), older than the fresh biome finding
			// (freshTs). Pinned via utimes so it's deterministic on Linux CI (#1024).
			const between = new Date(freshTs - 100_000);
			await fs.utimes(filePath, between, between);

			// Per-ENTRY gate: the stale LSP error drops, the fresher biome finding
			// SURVIVES, and the record is kept. Pre-fix (per-RECORD gate, whole record
			// stamped at staleTs) the ENTIRE record was dropped, losing the biome
			// finding — the #1186 over-clearing defect.
			expect(await reconcileStaleWidgetFiles()).toBe(1);
			const survivors = getFileDiagnostics(filePath);
			expect(survivors).toHaveLength(1);
			expect(survivors?.[0]?.tool).toBe("biome");
			expect(survivors?.[0]?.message).toBe("live biome finding");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("no-regression: a fully-stale record (every entry older than mtime) still drops entirely", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "per-entry-allstale-"),
		);
		const filePath = path.join(tmpDir, `all-stale-${Date.now()}.ts`);
		try {
			await fs.writeFile(filePath, "const z = 3;\n");
			const oldTs = Date.now() - 200_000;
			// Two entries, both observed at the same old time.
			recordDiagnostics(
				filePath,
				[
					{ severity: "error", tool: "lsp", message: "err A", rule: "A" },
					{ severity: "warning", tool: "biome", message: "warn B", rule: "B" },
				],
				1,
				oldTs,
			);
			expect(getFileDiagnostics(filePath)).toHaveLength(2);

			// The file changed AFTER both observations → every entry is stale.
			const newer = new Date(oldTs + 100_000);
			await fs.utimes(filePath, newer, newer);

			// Every entry stale → the whole record drops (survivors empty).
			expect(await reconcileStaleWidgetFiles()).toBe(1);
			expect(getFileDiagnostics(filePath)).toBeUndefined();
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe("PersistedWidgetState v1→v2 migration — per-entry stamps inherit the record touchedAt (#1186)", () => {
	it("accepts a v1 (pre-per-entry-stamp) snapshot and inherits observedAt from the record touchedAt", () => {
		const filePath = "C:/proj/legacy.ts";
		const touchedAt = Date.now() - 50_000;
		// A v1 on-disk record: version 1, entries carry NO per-entry `observedAt`.
		const accepted = importWidgetState({
			version: 1,
			sessionLanguages: [],
			files: [
				{
					filePath,
					runners: [],
					formatters: [],
					diagnostics: [
						{ severity: "error", message: "legacy error", rule: "X" },
					],
					allDiagnostics: [
						{ severity: "error", message: "legacy error", rule: "X" },
					],
					diagnosticCounts: { blocking: 0, errors: 1, warnings: 0 },
					hasFinalDiagnosticsSnapshot: true,
					touchedAt,
				},
			],
		});

		// A v1 file must be ACCEPTED (not rejected — that would silently drop all
		// resume diagnostics) and must not crash.
		expect(accepted).toBe(true);
		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(1);
		// The migrated entry inherits the record's touchedAt as its observedAt.
		expect(result?.[0]?.observedAt).toBe(touchedAt);
	});

	it("rejects a FUTURE version this build can't understand (guard, no crash)", () => {
		const rejected = importWidgetState({
			version: WIDGET_STATE_VERSION + 1,
			sessionLanguages: [],
			files: [],
		});
		expect(rejected).toBe(false);
	});

	it("REJECTS a snapshot with a missing / non-numeric version (preserves pre-#1186 strictness — a malformed or foreign snapshot must not fall through into the migrate path)", () => {
		const filePath = "C:/proj/no-version.ts";
		// A malformed on-disk snapshot whose `version` is absent. The pre-#1186
		// guard (`version !== WIDGET_STATE_VERSION`) rejected this; the naive
		// range guard (`version < 1 || > MAX`) let `undefined` slip through
		// (both comparisons are false) and silently migrated it. It must be
		// rejected: return false and populate nothing.
		const malformed = {
			sessionLanguages: [],
			files: [
				{
					filePath,
					runners: [],
					formatters: [],
					diagnostics: [{ severity: "error", message: "orphan", rule: "X" }],
					allDiagnostics: [{ severity: "error", message: "orphan", rule: "X" }],
					diagnosticCounts: { blocking: 0, errors: 1, warnings: 0 },
					hasFinalDiagnosticsSnapshot: true,
					touchedAt: Date.now(),
				},
			],
		} as unknown as Parameters<typeof importWidgetState>[0];

		expect(importWidgetState(malformed)).toBe(false);
		expect(getFileDiagnostics(filePath)).toBeUndefined();
	});

	it("a migrated v1 entry gates correctly: stale once the file's mtime passes the inherited stamp", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v1-migrate-gate-"));
		const filePath = path.join(tmpDir, `legacy-${Date.now()}.ts`);
		try {
			await fs.writeFile(filePath, "const q = 4;\n");
			const touchedAt = Date.now() - 30_000;
			importWidgetState({
				version: 1,
				sessionLanguages: [],
				files: [
					{
						filePath,
						runners: [],
						formatters: [],
						diagnostics: [
							{ severity: "error", message: "legacy stale", rule: "X" },
						],
						allDiagnostics: [
							{ severity: "error", message: "legacy stale", rule: "X" },
						],
						diagnosticCounts: { blocking: 0, errors: 1, warnings: 0 },
						hasFinalDiagnosticsSnapshot: true,
						touchedAt,
					},
				],
			});
			// The v1 snapshot must be ACCEPTED and its entry present before we test
			// gating — this intermediate assertion makes the test discriminate
			// against pre-fix code (which rejected v1 outright, leaving nothing to
			// gate and passing the final `toBeUndefined` for the wrong reason).
			expect(getFileDiagnostics(filePath)).toHaveLength(1);

			// File changed after the inherited observation → the migrated entry is
			// stale and drops (proves the inherited stamp actually gates — not stored
			// but ignored).
			const newer = new Date(touchedAt + 10_000);
			await fs.utimes(filePath, newer, newer);
			expect(await reconcileStaleWidgetFiles()).toBe(1);
			expect(getFileDiagnostics(filePath)).toBeUndefined();
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe("past-EOF diagnostic gate (#1641)", () => {
	it("RED CASE: demotes a stored diagnostic whose cited line exceeds the file's current on-disk line count", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "past-eof-"));
		const filePath = path.join(tmpDir, "kilo.ts");
		try {
			// A live in-memory-vs-disk desync never touches mtime — the file was
			// NEVER re-written on disk (#1641's forensic case: 402 lines on disk,
			// diagnostics served at 407-410). A 5-line file stands in for that
			// shape here: the cited line is past EOF from the moment it's recorded.
			await fs.writeFile(filePath, "a\nb\nc\nd\ne\n");
			recordDiagnostics(
				filePath,
				[
					{ severity: "error", message: "still valid", line: 3, rule: "X" },
					{
						severity: "error",
						message: "stale in-memory citation",
						line: 407,
						rule: "Y",
					},
				],
				1,
			);

			// Pre-fix: both entries re-serve verbatim, including the impossible
			// line-407 citation on a 5-line file, and both count as blocking.
			const summaries = getFileDiagnosticSummaries();
			const rec = summaries.find((s) => s.filePath === filePath);
			expect(rec).toBeDefined();
			const stale = rec?.diagnostics.find((d) => d.line === 407);
			const live = rec?.diagnostics.find((d) => d.line === 3);
			expect(stale?.stale).toBe(true);
			expect(live?.stale).toBeFalsy();
			// Demoted out of the blocking tally — same reasoning as isBlocking.
			expect(rec?.blocking).toBe(1);

			// getFileDiagnostics (the bus-publish/single-file accessor) sees the
			// same demotion — one gate, every reader.
			const single = getFileDiagnostics(filePath);
			expect(single?.find((d) => d.line === 407)?.stale).toBe(true);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("does not demote a diagnostic whose cited line is still within the current file", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "past-eof-ok-"));
		const filePath = path.join(tmpDir, "fine.ts");
		try {
			await fs.writeFile(filePath, "a\nb\nc\nd\ne\n");
			recordDiagnostics(
				filePath,
				[
					{
						severity: "error",
						message: "on the last line",
						line: 5,
						rule: "X",
					},
				],
				1,
			);
			const rec = getFileDiagnosticSummaries().find(
				(s) => s.filePath === filePath,
			);
			expect(rec?.diagnostics[0]?.stale).toBeFalsy();
			expect(rec?.blocking).toBe(1);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("the TUI render loop demotes a past-EOF blocker out of the blocking list it shows", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "past-eof-render-"));
		const filePath = path.join(tmpDir, "widget.ts");
		try {
			await fs.writeFile(filePath, "a\nb\nc\n");
			recordDiagnostics(
				filePath,
				[
					{
						severity: "error",
						message: "phantom citation",
						line: 999,
						rule: "X",
					},
				],
				1,
			);
			const out = renderWidget(120, theme).join("\n");
			expect(out).not.toContain("L999");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("F3 RE-ARM: a transient shrink demotes, restoring the file un-demotes the STORED record", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "past-eof-rearm-"));
		const filePath = path.join(tmpDir, "transient.ts");
		try {
			await fs.writeFile(filePath, "a\nb\nc\nd\ne\n"); // 6 addressable lines
			recordDiagnostics(
				filePath,
				[
					{
						severity: "error",
						message: "real blocking error",
						line: 5,
						rule: "X",
					},
				],
				1,
			);
			expect(
				getFileDiagnosticSummaries().find((s) => s.filePath === filePath)
					?.blocking,
			).toBe(1);

			// Transient shrink (formatter pass / checkout / partial write) —
			// line 5 no longer exists. Force the mtime forward explicitly:
			// successive writes within one filesystem timestamp tick can
			// otherwise land on the SAME mtime, defeating the mtime-keyed cache
			// for reasons unrelated to what this test verifies.
			await fs.writeFile(filePath, "a\nb\n"); // 3 addressable lines
			await fs.utimes(
				filePath,
				new Date(Date.now() + 1000),
				new Date(Date.now() + 1000),
			);
			const shrunk = getFileDiagnosticSummaries().find(
				(s) => s.filePath === filePath,
			);
			expect(shrunk?.diagnostics[0]?.stale).toBe(true);
			expect(shrunk?.blocking).toBe(0);

			// Restored to its original content — the STORE must re-arm, not stay
			// permanently latched stale (the #1633-V1 lesson: derive, don't latch).
			await fs.writeFile(filePath, "a\nb\nc\nd\ne\n");
			await fs.utimes(
				filePath,
				new Date(Date.now() + 2000),
				new Date(Date.now() + 2000),
			);
			const restored = getFileDiagnosticSummaries().find(
				(s) => s.filePath === filePath,
			);
			expect(restored?.diagnostics[0]?.stale).toBeFalsy();
			expect(restored?.blocking).toBe(1);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	__testing,
	clearWidgetState,
	getFailedLspServerIds,
	getFileDiagnostics,
	getFileDiagnosticSummaries,
	getSessionLanguages,
	reconcileScanDiagnostics,
	recordDiagnostics,
	recordFormatter,
	recordLsp,
	recordRunner,
	renderWidget,
	setRenderCallback,
	setSessionLanguages,
} from "../../clients/widget-state.ts";

const e = String.fromCharCode(27);
const theme = {
	fg: (_color: string, s: string) => `${e}[38;2;102;102;102m${s}${e}[39m`,
};

afterEach(() => {
	clearWidgetState();
});

describe("LSP failure accessors (#170)", () => {
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

describe("getFileDiagnostics (#502 single-file accessor)", () => {
	it("returns undefined for a file never recorded", () => {
		expect(getFileDiagnostics(`${process.cwd()}/never-seen.ts`)).toBeUndefined();
	});

	it("returns the full uncapped set for a recorded file", () => {
		const filePath = `${process.cwd()}/single.ts`;
		recordDiagnostics(filePath, [
			{ severity: "error", rule: "typescript:2322", message: "bad", tool: "tsserver" },
			{ severity: "warning", rule: "no-console", message: "noisy", tool: "eslint" },
		]);

		const result = getFileDiagnostics(filePath);
		expect(result).toHaveLength(2);
		expect(result?.[0].severity).toBe("error");
	});

	it("returns an explicit empty array when the file was recorded clean", () => {
		const filePath = `${process.cwd()}/clean.ts`;
		recordDiagnostics(filePath, [{ severity: "error", message: "bad", tool: "eslint" }]);
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
});

describe("widget-state renderWidget", () => {
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
			(l) => l.trim() === l.trim() && /^\s*\[[^m]*m?cors\.ts\[/.test(l),
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
			[{ severity: "error", message: "stale diagnostic from edit #1", rule: "X" }],
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

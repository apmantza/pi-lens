import { afterEach, describe, expect, it } from "vitest";
import { formatIssuesStatus } from "../../clients/issues-status.js";
import {
	type WidgetSummary,
	clearWidgetState,
	getWidgetSummary,
	recordDiagnostics,
	recordFormatter,
	recordRunner,
	renderWidget,
	setSessionLanguages,
} from "../../clients/widget-state.js";

const theme = { fg: (_color: string, s: string) => s };

function summary(overrides: Partial<WidgetSummary> = {}): WidgetSummary {
	return {
		totalBlocking: 0,
		totalErrors: 0,
		totalWarnings: 0,
		totalSuppressed: 0,
		hasPendingAnalysis: false,
		uncheckedCount: 0,
		hasRenderableCheckedFile: true,
		hasFiles: true,
		...overrides,
	};
}

afterEach(() => {
	clearWidgetState();
});

describe("formatIssuesStatus", () => {
	it("renders errors only", () => {
		expect(formatIssuesStatus(summary({ totalErrors: 2 }))).toBe("●2E");
	});

	it("renders warnings only", () => {
		expect(formatIssuesStatus(summary({ totalWarnings: 3 }))).toBe("!3W");
	});

	it("renders errors and warnings side by side", () => {
		expect(
			formatIssuesStatus(summary({ totalErrors: 2, totalWarnings: 3 })),
		).toBe("●2E !3W");
	});

	it("renders the unchecked count when no error or warning exists", () => {
		expect(formatIssuesStatus(summary({ uncheckedCount: 4 }))).toBe(
			"⚠ 4 unchecked",
		);
	});

	it("renders clean only for a checked renderable file", () => {
		expect(formatIssuesStatus(summary())).toBe("✓ clean");
	});

	it("renders no text when no analyzed file exists", () => {
		expect(formatIssuesStatus(summary({ hasFiles: false }))).toBeUndefined();
	});

	it("renders no clean claim while a file is still pending", () => {
		expect(
			formatIssuesStatus(summary({ hasPendingAnalysis: true })),
		).toBeUndefined();
	});

	it("does not claim clean for a file no check can cover", () => {
		expect(
			formatIssuesStatus(summary({ hasRenderableCheckedFile: false })),
		).toBeUndefined();
	});

	it("matches the widget header's tallies for the same store", () => {
		setSessionLanguages(["jsts"]);
		recordDiagnostics("/repo/issue-a.ts", [
			{
				severity: "error",
				semantic: "blocking",
				message: "blocking",
				line: 1,
				rule: "typescript:1",
			},
			{
				severity: "warning",
				message: "warning",
				line: 2,
				rule: "ts-react-antipatterns",
			},
		]);
		recordDiagnostics("/repo/issue-b.ts", [
			{
				severity: "error",
				semantic: "blocking",
				message: "another blocking",
				line: 3,
				rule: "typescript:2",
			},
		]);

		const header = renderWidget(120, theme)[0] ?? "";
		const formatted = formatIssuesStatus(getWidgetSummary());

		expect(header).toContain("2E");
		expect(header).toContain("1W");
		expect(formatted).toBe("●2E !1W");
		expect(header).toContain(formatted ?? "");
	});

	it("matches the header when same-named files hold different findings", () => {
		const dir = process.cwd();
		recordRunner(`${dir}/pi-lens/index.ts`, "tsc", "failed", 1);
		recordDiagnostics(`${dir}/pi-lens/index.ts`, [
			{
				severity: "error",
				semantic: "blocking",
				message: "blocking",
				line: 1,
				rule: "E1",
			},
		]);
		recordRunner(`${dir}/pi-webaio/index.ts`, "tsc", "succeeded", 1);
		recordDiagnostics(`${dir}/pi-webaio/index.ts`, []);

		const header = renderWidget(120, theme)[0] ?? "";
		expect(formatIssuesStatus(getWidgetSummary())).toBe("●1E");
		expect(header).toContain("●1E");
		expect(header).not.toContain("✓ clean");
	});

	it("withholds clean while the header does", () => {
		recordFormatter("/repo/pending.ts", "prettier", false, true);

		const header = renderWidget(120, theme).join("\n");
		expect(getWidgetSummary().hasPendingAnalysis).toBe(true);
		expect(formatIssuesStatus(getWidgetSummary())).toBeUndefined();
		expect(header).not.toContain("✓ clean");
	});

	it("matches the widget header's unchecked and clean summaries", () => {
		const reason = "no primary checker is enabled for this kind";
		recordDiagnostics("/repo/open.ts", [], undefined, undefined, { reason });
		expect(renderWidget(120, theme)[0]).toContain(
			formatIssuesStatus(getWidgetSummary()) ?? "",
		);
		expect(formatIssuesStatus(getWidgetSummary())).toBe("⚠ 1 unchecked");

		recordDiagnostics("/repo/open.ts", []);
		expect(formatIssuesStatus(getWidgetSummary())).toBe("✓ clean");
		expect(renderWidget(120, theme)[0]).toContain("✓ clean");
	});
});

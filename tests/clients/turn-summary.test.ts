import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatTurnSummaryLine,
	TurnSummaryCollector,
} from "../../clients/turn-summary.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";

describe("TurnSummaryCollector (#484)", () => {
	it("is empty when nothing has been recorded", () => {
		const collector = new TurnSummaryCollector();
		expect(collector.isEmpty()).toBe(true);
		expect(collector.peek()).toEqual([]);
	});

	it("accumulates diagnostics, autofixes, and formats per file", () => {
		const collector = new TurnSummaryCollector();
		collector.recordDiagnostic("/repo/src/a.ts", {
			tool: "eslint",
			ruleId: "no-unused-vars",
			severity: "warning",
			line: 4,
			description: "'x' is declared but never used",
		});
		collector.recordDiagnostic("/repo/src/a.ts", {
			tool: "tsserver",
			severity: "error",
			line: 10,
		});
		collector.recordAutofix("/repo/src/a.ts", {
			tool: "ruff",
			description: "2 issue(s) fixed",
		});
		collector.recordFormat("/repo/src/a.ts", { tool: "prettier" });

		expect(collector.isEmpty()).toBe(false);
		const details = collector.consume(3);
		expect(details.turnIndex).toBe(3);
		expect(details.files).toHaveLength(1);
		expect(details.files[0].events).toHaveLength(4);
		expect(details.counts).toEqual({
			diagnostics: 2,
			autofixes: 1,
			formats: 1,
			byTool: {
				diagnostic: { eslint: 1, tsserver: 1 },
				autofix: { ruff: 1 },
				format: { prettier: 1 },
			},
		});

		// consume() clears the collector
		expect(collector.isEmpty()).toBe(true);
	});

	it("clear() empties the collector without building details", () => {
		const collector = new TurnSummaryCollector();
		collector.recordFormat("/repo/src/a.ts", { tool: "prettier" });
		expect(collector.isEmpty()).toBe(false);
		collector.clear();
		expect(collector.isEmpty()).toBe(true);
	});

	it("resolves displayPath via the optional consume() resolver", () => {
		const collector = new TurnSummaryCollector();
		collector.recordFormat("/repo/src/a.ts", { tool: "prettier" });
		const details = collector.consume(1, (fp) => path.basename(fp));
		expect(details.files[0].displayPath).toBe("a.ts");
		expect(details.files[0].filePath).toBe("/repo/src/a.ts");
	});

	describe("cross-form path keys", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-turn-summary-"),
			);
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("merges events for the same file recorded with forward vs backslash separators", () => {
			const filePath = path.join(tmpDir, "file.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n", "utf-8");
			const forwardForm = filePath.replace(/\\/g, "/");
			const backslashForm = filePath.replace(/\//g, "\\");

			const collector = new TurnSummaryCollector();
			collector.recordFormat(forwardForm, { tool: "prettier" });
			collector.recordDiagnostic(backslashForm, {
				tool: "eslint",
				ruleId: "no-unused-vars",
			});

			// Same underlying file, two separator styles — must collapse to ONE
			// file entry (real normalizeMapKey, not a hand-rolled replace — the
			// trap that cost two red CI rounds on PR #491).
			const details = collector.consume(1);
			expect(details.files).toHaveLength(1);
			expect(details.files[0].events).toHaveLength(2);
		});
	});
});

describe("formatTurnSummaryLine (#484)", () => {
	it("builds a tool-grouped collapsed line", () => {
		const collector = new TurnSummaryCollector();
		collector.recordDiagnostic("/repo/a.ts", { tool: "eslint" });
		collector.recordDiagnostic("/repo/a.ts", { tool: "eslint" });
		collector.recordDiagnostic("/repo/b.ts", { tool: "tsserver" });
		collector.recordAutofix("/repo/a.ts", { tool: "ruff" });
		collector.recordAutofix("/repo/a.ts", { tool: "ruff" });
		collector.recordFormat("/repo/a.ts", { tool: "prettier" });

		const details = collector.consume(1);
		const line = formatTurnSummaryLine(details);
		expect(line).toBe(
			"pi-lens: 3 diagnostics (eslint 2, tsserver 1) · 2 autofixed (ruff 2) · 1 reformatted (prettier 1)",
		);
	});

	it("collapses multiple fact-rules findings (distinct rule ids, shared tool) into one bucket (#578)", () => {
		// fact-rules diagnostics all share tool: "fact-rules" per the
		// Diagnostic contract (tool = producing runner, rule = specific
		// check) — like ast-grep, they must collapse into ONE bucket
		// regardless of which individual rule fired, not scatter into
		// N per-rule-id buckets.
		const collector = new TurnSummaryCollector();
		collector.recordDiagnostic("/repo/a.ts", {
			tool: "fact-rules",
			ruleId: "high-fan-out",
		});
		collector.recordDiagnostic("/repo/a.ts", {
			tool: "fact-rules",
			ruleId: "missing-error-propagation",
		});
		collector.recordDiagnostic("/repo/b.ts", {
			tool: "fact-rules",
			ruleId: "high-complexity",
		});

		const details = collector.consume(1);
		expect(details.counts.byTool.diagnostic).toEqual({ "fact-rules": 3 });

		const line = formatTurnSummaryLine(details);
		expect(line).toBe("pi-lens: 3 diagnostics (fact-rules 3)");
	});

	it("omits sections with zero counts", () => {
		const collector = new TurnSummaryCollector();
		collector.recordFormat("/repo/a.ts", { tool: "prettier" });
		const details = collector.consume(1);
		expect(formatTurnSummaryLine(details)).toBe(
			"pi-lens: 1 reformatted (prettier 1)",
		);
	});

	it("falls back to an empty-turn label for an empty details payload", () => {
		const collector = new TurnSummaryCollector();
		const details = collector.consume(1);
		expect(formatTurnSummaryLine(details)).toBe("pi-lens: turn summary (empty)");
	});
});

describe("RuntimeCoordinator turn-summary lifecycle (#484)", () => {
	it("is NOT cleared at beginTurn — accumulates across the run's turns", () => {
		const runtime = new RuntimeCoordinator();
		runtime.turnSummary.recordFormat("/repo/src/a.ts", { tool: "prettier" });
		expect(runtime.turnSummary.isEmpty()).toBe(false);

		// A new turn beginning mid-run must NOT drop the pending summary — the
		// entry is emitted once per RUN at the agent_settled quiet window
		// (sendMessage during a live stream would steer the agent), so the
		// collector survives turn boundaries.
		runtime.beginTurn();
		expect(runtime.turnSummary.isEmpty()).toBe(false);

		runtime.turnSummary.recordDiagnostic("/repo/src/b.ts", {
			tool: "eslint",
		});
		const details = runtime.turnSummary.consume(runtime.turnIndex);
		expect(details.files).toHaveLength(2);
		expect(runtime.turnSummary.isEmpty()).toBe(true);
	});

	it("IS cleared by resetForSession", () => {
		const runtime = new RuntimeCoordinator();
		runtime.turnSummary.recordFormat("/repo/src/a.ts", { tool: "prettier" });
		runtime.resetForSession();
		expect(runtime.turnSummary.isEmpty()).toBe(true);
	});
});

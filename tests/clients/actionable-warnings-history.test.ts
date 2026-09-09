import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendActionableWarningsHistory,
	getActionableWarningsHistoryPath,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { removeTempDirSync } from "./test-utils.js";

vi.mock("../../clients/lsp/index.js", () => ({
	// `supportsLSP: false` is the only method this suite's path reads; the rest
	// of the surface comes from the factory (#2592).
	getLSPService: () => makeLspServiceDouble({ supportsLSP: () => false }),
}));

let env: { tmpDir: string; cleanup: () => void } | undefined;
let previousDataDir: string | undefined;

beforeEach(() => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-hist-"));
	env = {
		tmpDir,
		cleanup: () => removeTempDirSync(tmpDir),
	};
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	env?.cleanup();
	env = undefined;
});

function cwd(): string {
	if (!env) throw new Error("env not initialised");
	return path.join(env.tmpDir, "project");
}

function makeReport(args: {
	warnings: Array<{
		id?: string;
		filePath?: string;
		displayPath?: string;
		line?: number;
		tool?: string;
		rule?: string;
		message?: string;
		fixSuggestion?: string;
		actions?: Array<{ autoFixEligible: boolean }>;
		suppressed?: boolean;
		origin?: "dispatch" | "lsp" | "merged";
	}>;
}): ActionableWarningsReport {
	const proj = cwd();
	const warningFiles = new Map<string, ActionableWarningsReport["files"][0]>();
	for (const w of args.warnings) {
		const filePath = w.filePath ?? path.join(proj, "src", "a.ts");
		const displayPath = w.displayPath ?? "src/a.ts";
		const file = warningFiles.get(filePath) ?? {
			filePath,
			displayPath,
			fileSeq: 7,
			warnings: [],
		};
		file.warnings.push({
			id: w.id ?? "aw:abc123",
			filePath,
			displayPath,
			line: w.line ?? 10,
			column: 1,
			severity: "warning",
			tool: w.tool ?? "tree-sitter",
			rule: w.rule ?? "no-console",
			message: w.message ?? "remove console.log",
			fixSuggestion: w.fixSuggestion ?? "delete this line",
			actions: (w.actions ?? []).map((a) => ({
				title: "quickfix",
				kind: "quickfix",
				autoFixEligible: a.autoFixEligible,
				preferred: false,
			})) as unknown as ActionableWarningsReport["files"][0]["warnings"][0]["actions"],
			suppressed: w.suppressed ?? false,
			suppressionReason: w.suppressed ? "user-acknowledged" : undefined,
			origin: w.origin ?? "dispatch",
		} as ActionableWarningsReport["files"][0]["warnings"][0]);
		warningFiles.set(filePath, file);
	}
	return {
		generatedAt: "2026-06-02T00:00:00.000Z",
		scope: "turn_delta",
		sessionId: "lens-test",
		turnIndex: 12,
		projectSeqStart: 100,
		projectSeqEnd: 103,
		deltaOnly: true,
		includeLspCodeActions: true,
		files: [...warningFiles.values()],
		summary: {
			warnings: args.warnings.length,
			unsuppressed: args.warnings.filter((w) => !w.suppressed).length,
			suppressed: args.warnings.filter((w) => w.suppressed).length,
			files: warningFiles.size,
			actions: args.warnings.reduce((n, w) => n + (w.actions?.length ?? 0), 0),
			autoFixEligible: args.warnings.reduce(
				(n, w) => n + (w.actions ?? []).filter((a) => a.autoFixEligible).length,
				0,
			),
		},
	};
}

describe("appendActionableWarningsHistory (#1 — actionable warnings rolling jsonl)", () => {
	it("writes one NDJSON line per warning at the project data dir", () => {
		appendActionableWarningsHistory(
			cwd(),
			makeReport({
				warnings: [
					{ id: "aw:111", line: 4, message: "first" },
					{ id: "aw:222", line: 12, message: "second" },
				],
			}),
		);
		const historyPath = getActionableWarningsHistoryPath(cwd());
		const lines = fs
			.readFileSync(historyPath, "utf8")
			.split("\n")
			.filter(Boolean);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).warningId).toBe("aw:111");
		expect(JSON.parse(lines[1]).warningId).toBe("aw:222");
	});

	it("captures stable warning ids, suppression state, and action counts (the fields worklog.jsonl drops)", () => {
		appendActionableWarningsHistory(
			cwd(),
			makeReport({
				warnings: [
					{
						id: "aw:abc999",
						suppressed: true,
						actions: [{ autoFixEligible: true }, { autoFixEligible: false }],
					},
				],
			}),
		);
		const historyPath = getActionableWarningsHistoryPath(cwd());
		const entry = JSON.parse(
			fs.readFileSync(historyPath, "utf8").split("\n").filter(Boolean)[0],
		);
		expect(entry.warningId).toBe("aw:abc999");
		expect(entry.suppressed).toBe(true);
		expect(entry.suppressionReason).toBe("user-acknowledged");
		expect(entry.actionCount).toBe(2);
		expect(entry.autoFixEligibleActionCount).toBe(1);
		expect(entry.projectSeq).toBe(103);
		expect(entry.fileSeq).toBe(7);
	});

	it("skips the file write entirely when the report has no warnings (no noise)", () => {
		appendActionableWarningsHistory(cwd(), makeReport({ warnings: [] }));
		expect(fs.existsSync(getActionableWarningsHistoryPath(cwd()))).toBe(false);
	});

	it("appends across multiple calls, preserving prior entries", () => {
		appendActionableWarningsHistory(
			cwd(),
			makeReport({ warnings: [{ id: "aw:first", line: 1 }] }),
		);
		appendActionableWarningsHistory(
			cwd(),
			makeReport({ warnings: [{ id: "aw:second", line: 2 }] }),
		);
		const lines = fs
			.readFileSync(getActionableWarningsHistoryPath(cwd()), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).warningId).toBe("aw:first");
		expect(JSON.parse(lines[1]).warningId).toBe("aw:second");
	});

	it("history file path lives next to code-quality-warnings.jsonl (symmetric placement)", () => {
		const aw = getActionableWarningsHistoryPath(cwd());
		expect(aw.endsWith("actionable-warnings.jsonl")).toBe(true);
		expect(path.dirname(aw).endsWith(".pi-lens")).toBe(false);
		// Both jsonls share the project data dir.
		expect(path.dirname(aw)).toBe(
			path.dirname(path.join(path.dirname(aw), "code-quality-warnings.jsonl")),
		);
	});
});

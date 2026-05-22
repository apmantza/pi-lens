import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";

// vi.hoisted ensures this is available when the mock factory below runs.
const safeSpawnAsync = vi.hoisted(() => vi.fn());

vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: (command: string) => ({
		isAvailable: () => true,
		isAvailableAsync: async () => true,
		getCommand: () => command,
	}),
	resolveToolCommandWithInstallFallback: vi.fn(
		async (_cwd: string, toolId: string) => toolId,
	),
}));

function makeCtx(filePath: string, cwd = process.cwd()) {
	return {
		filePath,
		cwd,
		kind: "yaml" as const,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

// ── isGitHubWorkflowFile ─────────────────────────────────────────────────────

describe("isGitHubWorkflowFile", () => {
	it("matches standard workflow files", async () => {
		const { isGitHubWorkflowFile } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		expect(isGitHubWorkflowFile(".github/workflows/ci.yml")).toBe(true);
		expect(isGitHubWorkflowFile(".github/workflows/ci.yaml")).toBe(true);
	});

	it("matches with an absolute or project-root prefix", async () => {
		const { isGitHubWorkflowFile } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		expect(
			isGitHubWorkflowFile("/home/user/project/.github/workflows/ci.yml"),
		).toBe(true);
		expect(
			isGitHubWorkflowFile("C:/Users/dev/repo/.github/workflows/deploy.yml"),
		).toBe(true);
	});

	it("normalises Windows backslashes", async () => {
		const { isGitHubWorkflowFile } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		expect(isGitHubWorkflowFile(".github\\workflows\\ci.yml")).toBe(true);
		expect(
			isGitHubWorkflowFile("C:\\repo\\.github\\workflows\\ci.yml"),
		).toBe(true);
	});

	it("rejects files outside .github/workflows", async () => {
		const { isGitHubWorkflowFile } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		expect(isGitHubWorkflowFile("src/config.yml")).toBe(false);
		expect(isGitHubWorkflowFile(".github/other/ci.yml")).toBe(false);
		expect(isGitHubWorkflowFile(".github/ci.yml")).toBe(false);
	});

	it("rejects YAML files nested deeper than workflows/", async () => {
		const { isGitHubWorkflowFile } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		expect(
			isGitHubWorkflowFile(".github/workflows/subdir/ci.yml"),
		).toBe(false);
	});

	it("rejects non-YAML extensions", async () => {
		const { isGitHubWorkflowFile } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		expect(isGitHubWorkflowFile(".github/workflows/ci.json")).toBe(false);
		expect(isGitHubWorkflowFile(".github/workflows/ci.txt")).toBe(false);
	});
});

// ── parseActionlintJson ──────────────────────────────────────────────────────

describe("parseActionlintJson", () => {
	const filePath = "/repo/.github/workflows/ci.yml";

	it("returns empty array for empty input", async () => {
		const { parseActionlintJson } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		expect(parseActionlintJson("", filePath)).toEqual([]);
		expect(parseActionlintJson("   ", filePath)).toEqual([]);
	});

	it("parses a JSON array of issues", async () => {
		const { parseActionlintJson } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		const raw = JSON.stringify([
			{ message: "unknown workflow key", line: 5, column: 3, kind: "syntax" },
			{ message: "invalid expression", line: 12, column: 7, kind: "expression" },
		]);
		const result = parseActionlintJson(raw, filePath);
		expect(result).toHaveLength(2);
		expect(result[0].message).toBe("unknown workflow key");
		expect(result[0].line).toBe(5);
		expect(result[0].column).toBe(3);
		expect(result[0].rule).toBe("syntax");
		expect(result[0].tool).toBe("actionlint");
		expect(result[0].severity).toBe("error");
		expect(result[0].semantic).toBe("blocking");
		expect(result[1].message).toBe("invalid expression");
	});

	it("parses a single JSON object (non-array)", async () => {
		const { parseActionlintJson } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		const raw = JSON.stringify({
			message: "bad step id",
			line: 10,
			column: 1,
			kind: "id",
		});
		const result = parseActionlintJson(raw, filePath);
		expect(result).toHaveLength(1);
		expect(result[0].message).toBe("bad step id");
	});

	it("falls back to NDJSON (one object per line)", async () => {
		const { parseActionlintJson } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		const line1 = JSON.stringify({
			message: "err one",
			line: 1,
			column: 1,
			kind: "syntax",
		});
		const line2 = JSON.stringify({
			message: "err two",
			line: 2,
			column: 1,
			kind: "syntax",
		});
		const result = parseActionlintJson(`${line1}\n${line2}`, filePath);
		expect(result).toHaveLength(2);
		expect(result[0].message).toBe("err one");
		expect(result[1].message).toBe("err two");
	});

	it("skips non-JSON lines in NDJSON fallback", async () => {
		const { parseActionlintJson } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		const validLine = JSON.stringify({
			message: "real error",
			line: 3,
			column: 1,
			kind: "syntax",
		});
		const raw = `actionlint: some preamble text\n${validLine}\nanother stray line`;
		const result = parseActionlintJson(raw, filePath);
		expect(result).toHaveLength(1);
		expect(result[0].message).toBe("real error");
	});

	it("uses fallback values for missing fields", async () => {
		const { parseActionlintJson } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		const raw = JSON.stringify([{ message: "" }]);
		const result = parseActionlintJson(raw, filePath);
		expect(result[0].line).toBe(1);
		expect(result[0].column).toBe(1);
		expect(result[0].rule).toBe("actionlint");
		expect(result[0].message).toBe("GitHub Actions workflow issue");
	});

	it("attaches snippet as matchedText", async () => {
		const { parseActionlintJson } = await import(
			"../../../../clients/dispatch/runners/actionlint.js"
		);
		const raw = JSON.stringify([
			{ message: "bad key", line: 1, column: 1, snippet: "on: push" },
		]);
		const result = parseActionlintJson(raw, filePath);
		expect(result[0].matchedText).toBe("on: push");
	});
});

// ── runner.when ──────────────────────────────────────────────────────────────

describe("actionlintRunner.when", () => {
	it("returns true for a GitHub workflow file", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/actionlint.js")
		).default;
		const ctx = makeCtx("/repo/.github/workflows/ci.yml");
		expect(runner.when?.(ctx as never)).toBe(true);
	});

	it("returns false for a plain YAML file", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/actionlint.js")
		).default;
		const ctx = makeCtx("/repo/src/config.yml");
		expect(runner.when?.(ctx as never)).toBe(false);
	});
});

// ── runner.run ───────────────────────────────────────────────────────────────

describe("actionlintRunner.run", () => {
	beforeEach(() => {
		safeSpawnAsync.mockReset();
	});

	it("returns succeeded with no diagnostics on clean output", async () => {
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "[]", stderr: "" });
		const runner = (
			await import("../../../../clients/dispatch/runners/actionlint.js")
		).default;
		const ctx = makeCtx("/repo/.github/workflows/ci.yml");
		const result = await runner.run(ctx as never);
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toHaveLength(0);
		expect(result.semantic).toBe("none");
	});

	it("returns failed with blocking diagnostics on JSON output", async () => {
		const issues = JSON.stringify([
			{ message: 'unknown key "foo"', line: 3, column: 5, kind: "syntax" },
		]);
		safeSpawnAsync.mockResolvedValue({ status: 1, stdout: issues, stderr: "" });
		const runner = (
			await import("../../../../clients/dispatch/runners/actionlint.js")
		).default;
		const ctx = makeCtx("/repo/.github/workflows/ci.yml");
		const result = await runner.run(ctx as never);
		expect(result.status).toBe("failed");
		expect(result.semantic).toBe("blocking");
		expect(result.diagnostics[0].message).toBe('unknown key "foo"');
		expect(result.diagnostics[0].tool).toBe("actionlint");
	});

	it("synthesises a fallback diagnostic on non-zero exit with no JSON", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout: "",
			stderr: "actionlint: no such file or directory",
		});
		const runner = (
			await import("../../../../clients/dispatch/runners/actionlint.js")
		).default;
		const ctx = makeCtx(
			path.join(process.cwd(), ".github/workflows/ci.yml"),
		);
		const result = await runner.run(ctx as never);
		expect(result.status).toBe("failed");
		expect(result.diagnostics[0].message).toBe(
			"actionlint: no such file or directory",
		);
		expect(result.diagnostics[0].line).toBe(1);
	});

	it("returns succeeded on empty output with zero exit", async () => {
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
		const runner = (
			await import("../../../../clients/dispatch/runners/actionlint.js")
		).default;
		const ctx = makeCtx("/repo/.github/workflows/ci.yml");
		const result = await runner.run(ctx as never);
		expect(result.status).toBe("succeeded");
	});
});

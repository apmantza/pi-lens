/**
 * Tests for the cross-file dead-code harness (#127), Phase 1 (Python/vulture).
 *
 * Parser tests run against CAPTURED real vulture 2.16 output (no spawn). A
 * guarded integration test exercises the real binary end-to-end when vulture is
 * on PATH, and skips cleanly otherwise (mirrors the LSP smoke-skip pattern).
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	PythonDeadCodeClient,
	parseVultureOutput,
	formatDeadCodeAdvisory,
	deadCodeIssueCount,
	getDeadCodeClients,
	type DeadCodeResult,
} from "../../clients/dead-code-client.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const PY_FIXTURE = path.join(REPO_ROOT, "tests/fixtures/dead-code/python-project");

// Real vulture 2.16 output (Windows + POSIX path forms both covered).
const VULTURE_OUTPUT = [
	"src/mod.py:1: unused import 'os' (90% confidence)",
	"src/mod.py:9: unused function 'unused_func' (60% confidence)",
	"src/mod.py:13: unused class 'UnusedClass' (60% confidence)",
	"src/mod.py:14: unused method 'unused_method' (60% confidence)",
	"vulture banner line that should be ignored",
	"",
].join("\n");

function vultureAvailable(): boolean {
	for (const cmd of [
		["vulture", ["--version"]],
		["python", ["-m", "vulture", "--version"]],
	] as const) {
		try {
			execFileSync(cmd[0], cmd[1], { stdio: "pipe" });
			return true;
		} catch {
			/* try next */
		}
	}
	return false;
}

describe("parseVultureOutput", () => {
	it("parses each kind with name/line/confidence and ignores noise", () => {
		const issues = parseVultureOutput(VULTURE_OUTPUT, "/proj");
		expect(issues).toHaveLength(4);
		expect(issues.map((i) => i.kind)).toEqual([
			"import",
			"function",
			"class",
			"method",
		]);
		expect(issues[1]).toMatchObject({
			category: "export",
			kind: "function",
			name: "unused_func",
			line: 9,
			confidence: 60,
		});
		expect(issues.every((i) => i.category === "export")).toBe(true);
	});

	it("returns [] for clean output", () => {
		expect(parseVultureOutput("", "/proj")).toEqual([]);
		expect(parseVultureOutput("no findings here\n", "/proj")).toEqual([]);
	});
});

describe("PythonDeadCodeClient.detect", () => {
	const client = new PythonDeadCodeClient();

	it("detects a Python project by its marker", () => {
		expect(client.detect(PY_FIXTURE)).toBe(true);
	});

	it("does not detect a non-Python directory", () => {
		// A temp dir with no marker and a VCS-less parent — walks to root, null.
		expect(client.detect(path.join(REPO_ROOT, "tests/fixtures"))).toBe(false);
	});
});

describe("getDeadCodeClients", () => {
	it("returns the Python client in Phase 1", () => {
		const clients = getDeadCodeClients();
		expect(clients.map((c) => c.id)).toContain("python");
	});
});

describe("formatDeadCodeAdvisory", () => {
	const result = (over: Partial<DeadCodeResult>): DeadCodeResult => ({
		success: true,
		language: "Python",
		unusedExports: [],
		unusedFiles: [],
		unusedDeps: [],
		unlistedDeps: [],
		summary: "",
		...over,
	});

	it("returns empty string when there are no findings", () => {
		expect(formatDeadCodeAdvisory([result({})])).toBe("");
		expect(formatDeadCodeAdvisory([result({ success: false })])).toBe("");
	});

	it("lists symbols under a single heading and caps with a +more line", () => {
		const exports = Array.from({ length: 12 }, (_, i) => ({
			category: "export" as const,
			kind: "function",
			name: `f${i}`,
			file: "mod.py",
			line: i + 1,
			confidence: 60,
		}));
		const out = formatDeadCodeAdvisory([result({ unusedExports: exports })], 10);
		expect(out).toContain("[Dead code]");
		expect(out).toContain("Python: 12 unused symbol(s)");
		expect(out).toContain("unused function 'f0' (mod.py:1)");
		expect(out).toContain("… and 2 more");
	});

	it("merges multiple languages under one heading", () => {
		const py = result({
			language: "Python",
			unusedExports: [
				{ category: "export", kind: "function", name: "a", file: "x.py" },
			],
		});
		const go = result({
			language: "Go",
			unusedExports: [
				{ category: "export", kind: "func", name: "B", file: "y.go" },
			],
		});
		const out = formatDeadCodeAdvisory([py, go]);
		expect(out).toContain("Python: 1 unused symbol(s)");
		expect(out).toContain("Go: 1 unused symbol(s)");
		expect(deadCodeIssueCount(py)).toBe(1);
	});
});

describe("PythonDeadCodeClient.analyze (integration, real vulture)", () => {
	it.skipIf(!vultureAvailable())(
		"finds the unused symbols in the fixture project",
		async () => {
			const client = new PythonDeadCodeClient();
			const result = await client.analyze(PY_FIXTURE);
			expect(result.success).toBe(true);
			const names = result.unusedExports.map((i) => i.name);
			expect(names).toContain("unused_func");
			expect(names).toContain("UnusedClass");
			// file paths are project-relative
			expect(result.unusedExports[0]?.file).not.toContain(PY_FIXTURE);
		},
		20_000,
	);
});

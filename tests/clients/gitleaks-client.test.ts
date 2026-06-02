import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	hasGitleaksSignal,
	parseGitleaksReport,
} from "../../clients/gitleaks-client.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("hasGitleaksSignal (#130 gate)", () => {
	it("returns false for an empty project", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-empty-");
		try {
			expect(hasGitleaksSignal(env.tmpDir)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	for (const candidate of [
		".gitleaks.toml",
		".gitleaks.yaml",
		".gitleaks.yml",
		".gitleaksignore",
	]) {
		it(`returns true when ${candidate} exists at the root`, () => {
			const env = setupTestEnvironment("pi-lens-gitleaks-config-");
			try {
				fs.writeFileSync(path.join(env.tmpDir, candidate), "");
				expect(hasGitleaksSignal(env.tmpDir)).toBe(true);
			} finally {
				env.cleanup();
			}
		});
	}

	it("returns true when package.json has a gitleaks dep", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-pkg-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ devDependencies: { gitleaks: "^8.18.0" } }),
			);
			expect(hasGitleaksSignal(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("returns true when package.json has any gitleaks-substring dep", () => {
		// e.g. lint-staged wrapper, husky plugin, etc.
		const env = setupTestEnvironment("pi-lens-gitleaks-pkg-wrap-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({
					dependencies: { "lint-staged-gitleaks": "^0.1.0" },
				}),
			);
			expect(hasGitleaksSignal(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("returns true when a husky pre-commit hook references gitleaks", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-husky-");
		try {
			const hookDir = path.join(env.tmpDir, ".husky");
			fs.mkdirSync(hookDir, { recursive: true });
			fs.writeFileSync(
				path.join(hookDir, "pre-commit"),
				"#!/usr/bin/env sh\ngitleaks detect --no-git\n",
			);
			expect(hasGitleaksSignal(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("returns true when a git pre-commit hook references gitleaks", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-git-hook-");
		try {
			const hookDir = path.join(env.tmpDir, ".git", "hooks");
			fs.mkdirSync(hookDir, { recursive: true });
			fs.writeFileSync(
				path.join(hookDir, "pre-commit"),
				"#!/bin/sh\nexec gitleaks protect --staged\n",
			);
			expect(hasGitleaksSignal(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("returns false when a hook exists but doesn't reference gitleaks", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-other-hook-");
		try {
			const hookDir = path.join(env.tmpDir, ".husky");
			fs.mkdirSync(hookDir, { recursive: true });
			fs.writeFileSync(
				path.join(hookDir, "pre-commit"),
				"#!/usr/bin/env sh\nnpm test\n",
			);
			expect(hasGitleaksSignal(env.tmpDir)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("returns false when package.json is malformed (treats as no signal)", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-bad-pkg-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, "package.json"), "{not valid");
			expect(hasGitleaksSignal(env.tmpDir)).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

describe("parseGitleaksReport (#130)", () => {
	it("returns an empty list for empty / whitespace input", () => {
		expect(parseGitleaksReport("")).toEqual([]);
		expect(parseGitleaksReport("   \n\n")).toEqual([]);
	});

	it("returns an empty list for null / object / non-array input (gitleaks-clean report)", () => {
		expect(parseGitleaksReport("null")).toEqual([]);
		expect(parseGitleaksReport("[]")).toEqual([]);
		expect(parseGitleaksReport('{"summary":"clean"}')).toEqual([]);
	});

	it("maps gitleaks's full finding shape into the structured Diagnostic-like form", () => {
		const raw = JSON.stringify([
			{
				Description: "AWS Access Key",
				StartLine: 42,
				EndLine: 42,
				StartColumn: 18,
				EndColumn: 38,
				Match: "AKIAIOSFODNN7EXAMPLE",
				Secret: "AKIAIOSFODNN7EXAMPLE",
				File: "src/config.ts",
				SymlinkFile: "",
				Commit: "abc123",
				Entropy: 3.2,
				Author: "Dev",
				Email: "dev@example.com",
				Date: "2026-06-01T00:00:00Z",
				Message: "wip",
				Tags: ["key", "AWS"],
				RuleID: "aws-access-token",
				Fingerprint: "abc123:src/config.ts:aws-access-token:42",
			},
		]);
		const findings = parseGitleaksReport(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			ruleId: "aws-access-token",
			description: "AWS Access Key",
			file: "src/config.ts",
			startLine: 42,
			endLine: 42,
			match: "AKIAIOSFODNN7EXAMPLE",
			secret: "AKIAIOSFODNN7EXAMPLE",
			tags: ["key", "AWS"],
			commit: "abc123",
			author: "Dev",
			date: "2026-06-01T00:00:00Z",
		});
	});

	it("skips entries missing the required fields (ruleId / file / startLine) rather than failing", () => {
		const raw = JSON.stringify([
			{ RuleID: "valid-rule", File: "a.ts", StartLine: 1 },
			{ RuleID: "missing-file", StartLine: 2 },
			{ File: "missing-rule.ts", StartLine: 3 },
			{ RuleID: "no-startline", File: "b.ts" },
			{ RuleID: "non-numeric-startline", File: "c.ts", StartLine: "oops" },
		]);
		const findings = parseGitleaksReport(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0].ruleId).toBe("valid-rule");
	});

	it("returns [] for malformed JSON rather than throwing", () => {
		expect(parseGitleaksReport("{not valid")).toEqual([]);
	});

	it("preserves multiple findings in order", () => {
		const raw = JSON.stringify([
			{ RuleID: "rule-a", File: "x.ts", StartLine: 1 },
			{ RuleID: "rule-b", File: "y.ts", StartLine: 2 },
			{ RuleID: "rule-c", File: "z.ts", StartLine: 3 },
		]);
		const findings = parseGitleaksReport(raw);
		expect(findings.map((f) => f.ruleId)).toEqual([
			"rule-a",
			"rule-b",
			"rule-c",
		]);
	});

	it("handles missing optional fields (description, secret, tags, commit metadata)", () => {
		const raw = JSON.stringify([
			{ RuleID: "minimal", File: "x.ts", StartLine: 1 },
		]);
		const findings = parseGitleaksReport(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			ruleId: "minimal",
			file: "x.ts",
			startLine: 1,
		});
		expect(findings[0].description).toBeUndefined();
		expect(findings[0].secret).toBeUndefined();
		expect(findings[0].tags).toBeUndefined();
		expect(findings[0].commit).toBeUndefined();
	});

	it("accepts a string StartLine and coerces it to a number", () => {
		// gitleaks emits numeric StartLine in practice, but some downstream
		// pipelines stringify JSON values. Be lenient.
		const raw = JSON.stringify([
			{ RuleID: "stringy", File: "x.ts", StartLine: "42" },
		]);
		const findings = parseGitleaksReport(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0].startLine).toBe(42);
	});
});

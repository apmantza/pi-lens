import { describe, expect, it } from "vitest";
import type { ActionableWarningRecord } from "../../clients/actionable-warnings.js";
import type { GitleaksFinding } from "../../clients/gitleaks-client.js";
import {
	dedupeSecretFindings,
	fromAstGrepWarnings,
	fromGitleaks,
	fromTrivySecrets,
	isSecretWarning,
	type SecretFinding,
	type TrivySecretFinding,
} from "../../clients/secret-findings.js";

function gitleaks(
	file: string,
	startLine: number,
	ruleId: string,
): GitleaksFinding {
	return { ruleId, file, startLine, description: `${ruleId} found` };
}

function trivySecret(
	file: string,
	line: number,
	ruleId: string,
): TrivySecretFinding {
	return { ruleId, file, line, title: `${ruleId} secret` };
}

function astGrepWarning(
	filePath: string,
	line: number,
	rule: string,
): ActionableWarningRecord {
	return {
		id: `${rule}:${line}`,
		filePath,
		displayPath: filePath,
		line,
		severity: "warning",
		tool: "ast-grep",
		rule,
		message: `${rule} match`,
		actions: [],
		suppressed: false,
		origin: "dispatch",
	};
}

// ── THE acceptance gate (#131 Mode 3) ────────────────────────────────────────

describe("dedupeSecretFindings — cross-source collapse (#131 acceptance gate)", () => {
	it("collapses the SAME secret from gitleaks + trivy + ast-grep into ONE finding", () => {
		const all: SecretFinding[] = [
			...fromGitleaks([gitleaks("src/config.ts", 42, "aws-access-token")]),
			...fromTrivySecrets([
				trivySecret("src/config.ts", 42, "aws-access-key-id"),
			]),
			...fromAstGrepWarnings([
				astGrepWarning("src/config.ts", 42, "no-hardcoded-secret-js"),
			]),
		];

		const deduped = dedupeSecretFindings(all);

		// One surfaced finding, not three.
		expect(deduped).toHaveLength(1);
		// Provenance from all three scanners is preserved.
		expect(deduped[0].sources).toEqual(["gitleaks", "trivy", "ast-grep"]);
		// Highest-priority source (gitleaks) owns the displayed rule.
		expect(deduped[0].rule).toBe("aws-access-token");
		expect(deduped[0].line).toBe(42);
	});

	it("collapses across path separators (\\ vs /) at the same line", () => {
		const deduped = dedupeSecretFindings([
			...fromGitleaks([gitleaks("src\\config.ts", 42, "aws-access-token")]),
			...fromTrivySecrets([trivySecret("src/config.ts", 42, "aws-key")]),
		]);
		expect(deduped).toHaveLength(1);
		expect(deduped[0].sources).toEqual(["gitleaks", "trivy"]);
	});

	it("keeps DISTINCT secrets at different lines / files separate", () => {
		const deduped = dedupeSecretFindings([
			...fromGitleaks([
				gitleaks("a.ts", 10, "rule-a"),
				gitleaks("a.ts", 20, "rule-b"),
			]),
			...fromTrivySecrets([trivySecret("b.ts", 10, "rule-c")]),
		]);
		expect(deduped).toHaveLength(3);
	});

	it("preserves first-appearance order", () => {
		const deduped = dedupeSecretFindings([
			...fromGitleaks([gitleaks("z.ts", 1, "r1")]),
			...fromTrivySecrets([trivySecret("a.ts", 1, "r2")]),
		]);
		expect(deduped.map((f) => f.file)).toEqual(["z.ts", "a.ts"]);
	});

	it("a trivy-only secret keeps the trivy rule when gitleaks is absent", () => {
		const deduped = dedupeSecretFindings([
			...fromTrivySecrets([trivySecret("x.ts", 5, "generic-api-key")]),
			...fromAstGrepWarnings([astGrepWarning("x.ts", 5, "hardcoded-key")]),
		]);
		expect(deduped).toHaveLength(1);
		expect(deduped[0].sources).toEqual(["trivy", "ast-grep"]);
		expect(deduped[0].rule).toBe("generic-api-key");
	});
});

// ── isSecretWarning gate ─────────────────────────────────────────────────────

describe("isSecretWarning", () => {
	it("matches the bundled hardcoded-secret rule families", () => {
		for (const rule of [
			"jwt-hardcoded-secret-csharp",
			"hardcoded-connection-password-java",
			"gorilla-cookie-store-hardcoded-session-key-go",
			"no-hardcoded-credential",
		]) {
			expect(isSecretWarning(astGrepWarning("a.ts", 1, rule))).toBe(true);
		}
	});

	it("does NOT sweep unrelated rules into the secrets channel", () => {
		for (const rule of [
			"no-cond-assign",
			"prefer-const",
			"array-callback-return",
			"refresh-token-rotation", // 'token' alone must not match
		]) {
			expect(isSecretWarning(astGrepWarning("a.ts", 1, rule))).toBe(false);
		}
	});

	it("reads the rule from `code` when `rule` is absent", () => {
		const w: ActionableWarningRecord = {
			...astGrepWarning("a.ts", 1, ""),
			rule: undefined,
			code: "express-session-hardcoded-secret-javascript",
		};
		expect(isSecretWarning(w)).toBe(true);
	});
});

// ── adapters ─────────────────────────────────────────────────────────────────

describe("fromAstGrepWarnings", () => {
	it("filters to secret warnings with a numeric line", () => {
		const out = fromAstGrepWarnings([
			astGrepWarning("a.ts", 3, "hardcoded-secret"),
			astGrepWarning("a.ts", 4, "no-cond-assign"), // not a secret
			{ ...astGrepWarning("a.ts", 0, "hardcoded-secret"), line: undefined }, // no line
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ line: 3, sources: ["ast-grep"] });
	});
});

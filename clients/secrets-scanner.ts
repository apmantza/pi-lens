/**
 * Content-level secrets scanner
 *
 * Scans file content for potential secret patterns before write.
 * Works on all file types via regex matching.
 *
 * Detected patterns:
 * - Stripe/OpenAI keys (sk-*)
 * - GitHub tokens (ghp_*, gho_*, github_pat_*)
 * - AWS keys (AKIA*)
 * - Slack tokens (xoxp-*, xoxb-*)
 * - Private keys (BEGIN PRIVATE KEY)
 * - Generic API key/password patterns
 */

import { isTestFile } from "./file-utils.js";

interface SecretPattern {
	pattern: RegExp;
	name: string;
	message: string;
}

// Patterns ordered by specificity - first match wins per line
const SECRET_PATTERNS: SecretPattern[] = [
	// High-confidence: specific key prefixes
	{
		pattern: /sk-[a-zA-Z0-9-]{20,}/g,
		name: "stripe-openai-key",
		message: "Possible Stripe or OpenAI API key (sk-*)",
	},
	{
		pattern: /ghp_[a-zA-Z0-9]{36}/g,
		name: "github-personal-token",
		message: "GitHub personal access token (ghp_*)",
	},
	{
		pattern: /gho_[a-zA-Z0-9]{36}/g,
		name: "github-oauth-token",
		message: "GitHub OAuth token (gho_*)",
	},
	{
		pattern: /github_pat_[a-zA-Z_]{82}/g,
		name: "github-fine-grained-pat",
		message: "GitHub fine-grained PAT (github_pat_*)",
	},
	{
		pattern: /AKIA[0-9A-Z]{16}/g,
		name: "aws-access-key",
		message: "AWS access key ID (AKIA*)",
	},
	{
		pattern: /xox[bp]-[a-zA-Z0-9]{10,}/g,
		name: "slack-token",
		message: "Slack token (xoxb-*/xoxp-*)",
	},
	{
		pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----/g,
		name: "private-key",
		message: "Private key material detected",
	},
	// Medium-confidence: quoted credentials
	{
		pattern: /password\s*[:=]\s*["'][^"']{4,}["']/gi,
		name: "hardcoded-password",
		message: "Possible hardcoded password",
	},
	{
		pattern:
			/(?:secret|api_?key|token|access_?key)\s*[:=]\s*["'][a-zA-Z0-9_\-/.]{8,}["']/gi,
		name: "hardcoded-secret",
		message: "Possible hardcoded secret or API key",
	},
	// .env format: KEY=VALUE (no quotes)
	{
		pattern:
			/^(?:API_?KEY|SECRET|TOKEN|PASSWORD|AWS_?ACCESS_?KEY)\s*=\s*\S{8,}/gim,
		name: "env-file-secret",
		message: "Possible secret in .env format",
	},
];

export interface SecretFinding {
	line: number;
	message: string;
}

/**
 * Scan content for potential secrets
 * Returns findings with line numbers.
 * Skips test files to avoid false positives.
 */
export function scanForSecrets(
	content: string,
	filePath?: string,
): SecretFinding[] {
	// Skip test files — secrets in tests are usually fake/test values
	if (filePath && isTestFile(filePath)) {
		return [];
	}

	const findings: SecretFinding[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let _matched = false;
		for (const pattern of SECRET_PATTERNS) {
			// Reset lastIndex before each test (important for global regex)
			const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
			if (regex.test(line)) {
				findings.push({
					line: i + 1,
					message: pattern.message,
				});
				_matched = true;
				break; // One finding per line
			}
		}
	}

	return findings;
}

/**
 * Format secrets findings for terminal output
 */
export function formatSecrets(
	findings: SecretFinding[],
	filePath: string,
): string {
	if (findings.length === 0) return "";

	const lines = [
		`🔴 STOP — ${findings.length} potential secret(s) in ${filePath}:`,
	];
	for (const f of findings.slice(0, 5)) {
		lines.push(`  L${f.line}: ${f.message}`);
	}
	if (findings.length > 5) {
		lines.push(`  ... and ${findings.length - 5} more`);
	}
	lines.push("  → Remove before continuing. Use env vars instead.");
	return lines.join("\n");
}

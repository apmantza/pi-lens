import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";

/**
 * no-commented-credentials — password/token/secret in comments (TS/JS/Python/Go/
 * Ruby/YAML/JSON/env). Regex/line-based (no compiler); formerly SN-007 (#402).
 */

const CREDENTIAL_PATTERNS = [
	/password\s*[:=]\s*["'][^"']{3,}/i,
	/(?:api[_-]?key|secret|token)\s*[:=]\s*["'][^"']{6,}/i,
	/(?:aws|gcp|azure)[_-]?(?:key|secret|token)\s*[:=]\s*["'][^"']{6,}/i,
];

// Files that define credential patterns as code (scanners, test fixtures, etc.) —
// their own regex literals would otherwise self-trigger this rule.
const CREDENTIALS_EXEMPT =
	/[/\\](secrets?[-_]?(scanner|detect|check)|scanner|fixture|mock)[^/\\]*\.(tsx?|ya?ml|json|env)$/i;

function isCommentLine(line: string): boolean {
	return line.startsWith("//") || line.startsWith("#") || line.startsWith("*");
}

export const commentedCredentialsRule: FactRule = {
	id: "no-commented-credentials",
	requires: ["file.content"],
	appliesTo(ctx) {
		return (
			/\.(tsx?|py|go|rb|ya?ml|json|env)$/.test(ctx.filePath) &&
			!CREDENTIALS_EXEMPT.test(ctx.filePath)
		);
	},
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const diagnostics: Diagnostic[] = [];

		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trimStart();
			if (!isCommentLine(line)) continue;
			for (const p of CREDENTIAL_PATTERNS) {
				if (p.test(line)) {
					diagnostics.push({
						id: `no-commented-credentials:${ctx.filePath}:${i + 1}`,
						tool: "fact-rules",
						rule: "no-commented-credentials",
						filePath: ctx.filePath,
						line: i + 1,
						column: 1,
						severity: "error",
						semantic: "blocking",
						message:
							"Possible credential in commented-out code — remove it and rotate the secret",
					});
					break;
				}
			}
		}
		return diagnostics;
	},
};

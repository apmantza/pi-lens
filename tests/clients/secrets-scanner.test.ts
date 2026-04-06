import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../../clients/secrets-scanner.js";

describe("secrets-scanner", () => {
	it("flags obvious hardcoded secret assignment", () => {
		const content = 'const api_key = "sk-live-abc123xyz789def456ghi000";';
		const findings = scanForSecrets(content, "src/client.ts");
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does not flag User-Agent header literals", () => {
		const content =
			'const headers = { "User-Agent": "Mozilla/5.0 (compatible; pi-lens/1.0; +https://example.com)" };';
		const findings = scanForSecrets(content, "src/http.ts");
		expect(findings).toEqual([]);
	});
});

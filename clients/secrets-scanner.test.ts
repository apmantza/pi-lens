import { describe, expect, it } from "vitest";
import { formatSecrets, scanForSecrets } from "./secrets-scanner.js";

describe("scanForSecrets", () => {
	it("should detect Stripe/OpenAI keys (sk-*)", () => {
		const content = `const apiKey = "sk-live-1234567890abcdefghij";`;
		const findings = scanForSecrets(content);
		expect(findings.length).toBe(1);
		expect(findings[0].message).toContain("Stripe or OpenAI");
	});

	it("should detect GitHub personal tokens (ghp_*)", () => {
		const content = `token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";`;
		const findings = scanForSecrets(content);
		expect(findings.length).toBe(1);
		expect(findings[0].message).toContain("GitHub personal");
	});

	it("should detect AWS access keys (AKIA*)", () => {
		const content = `const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";`;
		const findings = scanForSecrets(content);
		expect(findings.length).toBe(1);
		expect(findings[0].message).toContain("AWS access key");
	});

	it("should detect private key material", () => {
		const content = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...`;
		const findings = scanForSecrets(content);
		expect(findings.length).toBe(1);
		expect(findings[0].message).toContain("Private key");
	});

	it("should detect hardcoded passwords", () => {
		const content = `const config = { password: "hunter2" };`;
		const findings = scanForSecrets(content);
		expect(findings.length).toBe(1);
		expect(findings[0].message).toContain("password");
	});

	it("should detect secrets in .env format", () => {
		const content = `API_KEY=sk-live-1234567890abcdefghij
DATABASE_URL=postgres://localhost`;
		const findings = scanForSecrets(content);
		expect(findings.length).toBe(1);
		// sk-* pattern catches this first (more specific)
		expect(findings[0].message).toContain("Stripe or OpenAI");
	});

	it("should NOT flag safe content", () => {
		const content = `
const name = "test";
const url = "https://example.com";
const port = 3000;
const message = "Hello world";
`;
		const findings = scanForSecrets(content);
		expect(findings.length).toBe(0);
	});

	it("should NOT flag env var references", () => {
		const content = `const key = process.env.API_KEY;`;
		const findings = scanForSecrets(content);
		expect(findings.length).toBe(0);
	});

	it("should detect multiple secrets", () => {
		const content = `
const sk = "sk-live-1234567890abcdefghij";
const gh = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
`;
		const findings = scanForSecrets(content);
		expect(findings.length).toBe(2);
	});

	it("should report correct line numbers", () => {
		const content = `line 1
line 2
const secret = "sk-live-1234567890abcdefghij";
line 4`;
		const findings = scanForSecrets(content);
		expect(findings.length).toBe(1);
		expect(findings[0].line).toBe(3);
	});
});

describe("formatSecrets", () => {
	it("should format findings for terminal output", () => {
		const findings = [
			{ line: 5, message: "Possible Stripe or OpenAI API key (sk-*)" },
		];
		const output = formatSecrets(findings, "src/config.ts");
		expect(output).toContain("STOP");
		expect(output).toContain("1 potential secret(s)");
		expect(output).toContain("L5");
		expect(output).toContain("src/config.ts");
	});

	it("should return empty string for no findings", () => {
		const output = formatSecrets([], "src/config.ts");
		expect(output).toBe("");
	});

	it("should truncate at 5 findings", () => {
		const findings = Array.from({ length: 10 }, (_, i) => ({
			line: i + 1,
			message: "Test secret",
		}));
		const output = formatSecrets(findings, "src/config.ts");
		expect(output).toContain("10 potential secret(s)");
		expect(output).toContain("... and 5 more");
	});
});

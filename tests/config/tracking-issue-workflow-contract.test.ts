import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

describe("tracking issue workflow contract (#2683)", () => {
	it("routes compat-smoke issue mutations through the shared CLI", () => {
		const source = readFileSync(
			resolve(ROOT, ".github/workflows/compat-smoke.yml"),
			"utf8",
		);
		expect(source).toContain("node scripts/upsert-tracking-issue.mjs");
		expect(source).toMatch(
			/name: Alert on contract drift[\s\S]*?continue-on-error: true/,
		);
		expect(source).not.toMatch(/gh issue (create|edit|comment|close)/);
	});

	it("routes install-smoke's latest lane through its shared issue seam", () => {
		const source = readFileSync(
			resolve(ROOT, ".github/workflows/install-smoke.yml"),
			"utf8",
		);
		expect(source).toContain("node scripts/notify-install-smoke-drift.mjs");
		expect(source).toMatch(
			/name: Notify install drift[\s\S]*?continue-on-error: true/,
		);
		expect(source).not.toMatch(/gh issue (create|edit|comment|close)/);
	});
});

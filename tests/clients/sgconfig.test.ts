import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetBaselineSgconfigForTests,
	resolveBaselineSgconfig,
} from "../../clients/sgconfig.js";

describe("ast-grep baseline sgconfig", () => {
	afterEach(() => {
		_resetBaselineSgconfigForTests();
	});

	it("includes pi-lens rules plus vendored CodeRabbit rules", () => {
		_resetBaselineSgconfigForTests();
		const configPath = resolveBaselineSgconfig();
		expect(configPath).toBeDefined();
		if (!configPath) throw new Error("expected baseline sgconfig");
		const text = fs.readFileSync(configPath, "utf8");
		const normalized = text.replace(/\\/g, "/");
		expect(normalized).toContain("/rules/ast-grep-rules/rules");
		expect(normalized).toContain("/rules/ast-grep-rules/coderabbit/rules");
	});

	it("writes absolute ruleDirs so the temp config works outside the package root", () => {
		_resetBaselineSgconfigForTests();
		const configPath = resolveBaselineSgconfig();
		expect(configPath).toBeDefined();
		if (!configPath) throw new Error("expected baseline sgconfig");
		const text = fs.readFileSync(configPath, "utf8");
		const ruleDirLines = text
			.split(/\r?\n/)
			.filter((line) => line.trim().startsWith("- "));
		expect(ruleDirLines.length).toBeGreaterThanOrEqual(2);
		for (const line of ruleDirLines) {
			const value = line.replace(/^\s*-\s*/, "").replace(/^"|"$/g, "");
			expect(path.isAbsolute(value)).toBe(true);
		}
	});
});

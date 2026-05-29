import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuleCache } from "../../../clients/cache/rule-cache.js";

const cleanup: string[] = [];

afterEach(() => {
	while (cleanup.length > 0) {
		const dir = cleanup.pop();
		if (dir && fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

function setupProject(): { cwd: string; ruleFile: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-cache-"));
	cleanup.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi-lens"));
	const ruleFile = path.join(cwd, "fake-rule.yml");
	fs.writeFileSync(ruleFile, "id: fake\n", "utf-8");
	return { cwd, ruleFile };
}

describe("RuleCache", () => {
	it("preserves has_fix across a save+load roundtrip", () => {
		const { cwd, ruleFile } = setupProject();
		const cache = new RuleCache("typescript", cwd);

		cache.set([ruleFile], [
			{
				id: "console-statement",
				name: "Console Statement",
				severity: "warning",
				language: "typescript",
				message: "remove debug statements",
				query: "(call_expression) @x",
				metavars: ["x"],
				has_fix: true,
				defect_class: "safety",
				inline_tier: "warning",
				filePath: ruleFile,
			},
			{
				id: "deep-nesting",
				name: "Deep Nesting",
				severity: "warning",
				language: "typescript",
				message: "too deep",
				query: "(block) @b",
				metavars: ["b"],
				has_fix: false,
				filePath: ruleFile,
			},
		]);

		const loaded = cache.get([ruleFile]);
		expect(loaded).not.toBeNull();
		expect(loaded?.queries).toHaveLength(2);

		const consoleRule = loaded?.queries.find(
			(q) => q.id === "console-statement",
		);
		const nestingRule = loaded?.queries.find((q) => q.id === "deep-nesting");
		expect(consoleRule?.has_fix).toBe(true);
		expect(nestingRule?.has_fix).toBe(false);
		expect(consoleRule?.defect_class).toBe("safety");
		expect(consoleRule?.inline_tier).toBe("warning");
	});

	it("invalidates the cache when the schema version changes", () => {
		const { cwd, ruleFile } = setupProject();
		const cache = new RuleCache("typescript", cwd);

		cache.set([ruleFile], [
			{
				id: "fake",
				name: "Fake",
				severity: "warning",
				language: "typescript",
				message: "",
				query: "(x) @x",
				metavars: [],
				has_fix: true,
				filePath: ruleFile,
			},
		]);

		const cacheFile = path.join(
			cwd,
			".pi-lens",
			"cache",
			"typescript-rules-v3.json",
		);
		expect(fs.existsSync(cacheFile)).toBe(true);

		const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
		raw.version = "v2";
		fs.writeFileSync(cacheFile, JSON.stringify(raw), "utf-8");

		expect(cache.get([ruleFile])).toBeNull();
	});
});

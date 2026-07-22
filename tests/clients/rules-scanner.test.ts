import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatRulesForPrompt,
	scanProjectRules,
	type RuleScanResult,
} from "../../clients/rules-scanner.js";

function makeResult(count: number): RuleScanResult {
	return {
		hasCustomRules: count > 0,
		rules: Array.from({ length: count }, (_, i) => ({
			source: i % 2 === 0 ? ".claude/rules" : ".agents/rules",
			name: `rule-${i}.md`,
			filePath: `/tmp/rule-${i}.md`,
			relativePath: `${i % 2 === 0 ? ".claude/rules" : ".agents/rules"}/rule-${i}.md`,
		})),
	};
}

describe("rules-scanner prompt formatting", () => {
	it("caps listed rules and includes omitted count", () => {
		const result = makeResult(30);
		const text = formatRulesForPrompt(result);

		expect(text).toContain("additional rule file(s) not listed");
		expect((text.match(/^- `.*`/gm) ?? []).length).toBeLessThanOrEqual(12);
	});

	it("caps total prompt size", () => {
		const result = makeResult(50);
		const text = formatRulesForPrompt(result);

		expect(text.length).toBeLessThanOrEqual(920);
	});
});

describe("rules-scanner depth cap (#250/#747 class)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rules-"));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("stops recursing past the depth cap while keeping shallow rules", () => {
		const rulesDir = path.join(tmp, ".claude", "rules");
		fs.mkdirSync(rulesDir, { recursive: true });
		fs.writeFileSync(path.join(rulesDir, "shallow.md"), "# shallow\n");

		// 9 nested directories → the file inside sits one level below the depth-8
		// cap and must be excluded; a symlink loop or pathological tree can't run
		// this away.
		let deep = rulesDir;
		for (let i = 1; i <= 9; i++) {
			deep = path.join(deep, `d${i}`);
		}
		fs.mkdirSync(deep, { recursive: true });
		fs.writeFileSync(path.join(deep, "deep.md"), "# deep\n");

		const result = scanProjectRules(tmp);
		const names = result.rules.map((r) => r.name);

		expect(names).toContain("shallow.md");
		expect(names).not.toContain("deep.md");
	});
});

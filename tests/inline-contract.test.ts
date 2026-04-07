import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("inline contract doc", () => {
	it("documents current inline behavior invariants and linked tests", () => {
		const file = path.join(process.cwd(), "INLINE-CONTRACT.txt");
		const content = fs.readFileSync(file, "utf-8");

		expect(content).toContain("Inline Contract");
		expect(content).toContain("Blockers First");
		expect(content).toContain("Behavior Warnings Are Secondary");
		expect(content).toContain("Session Start Is Compact");
		expect(content).toContain("Turn-End Findings Are Deferred and One-Shot");

		expect(content).toContain("tests/clients/runtime-tool-result.test.ts");
		expect(content).toContain("tests/clients/runtime-session.test.ts");
		expect(content).toContain("tests/clients/runtime-event-flow.test.ts");
	});
});

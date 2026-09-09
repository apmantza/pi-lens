import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import {
	realHarnessFixtureRoot,
	validateScript,
} from "../support/real-pi-harness.js";

describe("real harness fixture shape", () => {
	it("requires every scenario to provide a project directory and valid script fields", () => {
		for (const scenario of readdirSync(realHarnessFixtureRoot)) {
			const dir = path.join(realHarnessFixtureRoot, scenario);
			if (!statSync(dir).isDirectory() || scenario.startsWith(".")) continue;
			expect(statSync(path.join(dir, "project")).isDirectory()).toBe(true);
			const script = JSON.parse(
				readFileSync(path.join(dir, "script.json"), "utf8"),
			) as unknown;
			expect(() =>
				validateScript(script, `${scenario}/script.json`),
			).not.toThrow();
		}
	});
	it("names the malformed field", () => {
		expect(() =>
			validateScript([[{ type: "text" }]], "broken/script.json"),
		).toThrow(/text must be a string/);
	});
});

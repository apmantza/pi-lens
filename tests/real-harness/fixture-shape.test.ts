import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import {
	realHarnessFixtureRoot,
	validateScript,
	withRepoBinOnPath,
} from "../support/real-pi-harness.js";

describe("real harness fixture shape", () => {
	it("requires every scenario to provide a project directory and valid script fields", () => {
		for (const scenario of readdirSync(realHarnessFixtureRoot)) {
			const dir = path.join(realHarnessFixtureRoot, scenario);
			if (!statSync(dir).isDirectory() || scenario.startsWith(".")) continue;
			expect(statSync(path.join(dir, "project")).isDirectory()).toBe(true);
			// Every script in the scenario, not only `script.json` (#2154): a
			// scenario whose sessions need different turn sequences — two live
			// children each replay from their OWN turn 0, so one script cannot
			// drive both — ships one file per role, and an unvalidated sibling
			// script is exactly the malformed fixture this gate exists to catch.
			const scripts = readdirSync(dir).filter((entry) =>
				entry.endsWith(".json"),
			);
			expect(scripts).toContain("script.json");
			for (const name of scripts) {
				const script = JSON.parse(
					readFileSync(path.join(dir, name), "utf8"),
				) as unknown;
				expect(() =>
					validateScript(script, `${scenario}/${name}`),
				).not.toThrow();
			}
		}
	});
	it("names the malformed field", () => {
		expect(() =>
			validateScript([[{ type: "text" }]], "broken/script.json"),
		).toThrow(/text must be a string/);
	});
	it("puts the repo bin dir first on the child PATH under any key casing (#3742)", () => {
		const head = [
			path.resolve("node_modules", ".bin"),
			path.dirname(process.execPath),
		];
		const joined = (...parts: string[]) => parts.join(path.delimiter);
		expect(withRepoBinOnPath({ PATH: "/usr/bin" })).toEqual({
			PATH: joined(...head, "/usr/bin"),
		});
		expect(withRepoBinOnPath({ Path: "C:\\Windows" })).toEqual({
			Path: joined(...head, "C:\\Windows"),
		});
		expect(withRepoBinOnPath({ PATH: "" })).toEqual({ PATH: joined(...head) });
		expect(withRepoBinOnPath({})).toEqual({ PATH: joined(...head) });
	});
});

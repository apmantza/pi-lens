import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const TESTS_ROOT = resolve(ROOT, "tests");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/ci.yml");
const LANE_HEADER = "// lane: windows-vitest";

type Step = { name?: string; run?: string; shell?: string };

function windowsJobSteps(): Step[] {
	const workflow = yaml.load(readFileSync(WORKFLOW_PATH, "utf8")) as {
		jobs?: Record<string, { steps?: Step[] }>;
	};
	return workflow.jobs?.["unit-tests-windows"]?.steps ?? [];
}

function windowsGatePattern(): RegExp {
	// String contents are blanked by stripSource, so match the quote pair and
	// validate the raw span separately. This keeps comments and strings inert.
	return new RegExp(
		`(?:it|describe)\\.(?:skipIf|runIf)\\(\\s*process\\.platform\\s*(?:!==|===)\\s*["']\\s*["']\\s*\\)`,
		"g",
	);
}

function isWindowsOnlyGate(match: string, rawSpan: string): boolean {
	if (!/["']win32["']/.test(rawSpan)) return false;
	return (
		(match.includes("skipIf") && match.includes("!==")) ||
		(match.includes("runIf") && match.includes("==="))
	);
}

describe("win32 gate lane governance (#2536)", () => {
	it("names the lane for every Windows-only declarative gate", () => {
		const files = listSourceFiles(TESTS_ROOT, {
			extensions: [".ts"],
			exclude: (file) => file.includes("/fixtures/"),
		});
		const missing: string[] = [];
		let gates = 0;

		for (const absolute of files) {
			const raw = readFileSync(absolute, "utf8");
			const stripped = stripSource(raw);
			for (const match of stripped.matchAll(windowsGatePattern())) {
				const offset = match.index ?? 0;
				if (
					!isWindowsOnlyGate(
						match[0],
						raw.slice(offset, offset + match[0].length),
					)
				)
					continue;
				gates++;
				const line = raw.slice(0, offset).split("\n").length;
				const previousLine = raw.split("\n")[line - 2] ?? "";
				if (!previousLine.trim().startsWith(LANE_HEADER)) {
					missing.push(`${relativePosix(ROOT, absolute)}:${line}`);
				}
			}
		}

		assertNonEmptyScan("win32 gate detection", gates, 1);
		expect(missing, "every Windows-only gate must name windows-vitest").toEqual(
			[],
		);
	});

	it("keeps the workflow population and execution filter wired", () => {
		const steps = windowsJobSteps();
		const enumeration = steps.find(
			(step) => step.name === "Enumerate Windows Vitest subset",
		);
		const runner = steps.find(
			(step) => step.name === "Run Windows Vitest subset",
		);
		const enumerationRun = enumeration?.run ?? "";
		const runnerRun = runner?.run ?? "";

		// Recurrence: #2536's gates can be documented yet omitted from the only
		// Windows job, leaving the platform-specific assertions unexecuted.
		expect(enumerationRun).toContain("git grep -l -E");
		expect(enumerationRun).toContain("skipIf");
		expect(enumerationRun).toContain("runIf");
		expect(enumerationRun).toContain("git grep -qi 'win32'");
		expect(enumerationRun).toContain("find tests/config -type f");
		expect(runnerRun).toContain('vitest run "${FILES[@]}"');
		expect(runner?.shell).toBe("bash");
	});
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/ci.yml");

type Step = {
	name?: string;
	uses?: string;
	run?: string;
	shell?: string;
	id?: string;
	if?: string;
	"continue-on-error"?: boolean;
};
type Job = {
	name?: string;
	"runs-on"?: string;
	"continue-on-error"?: boolean;
	"timeout-minutes"?: number;
	outputs?: Record<string, string>;
	permissions?: Record<string, string>;
	steps?: Step[];
};

function readWorkflow(): { jobs: Record<string, Job> } {
	return yaml.load(readFileSync(WORKFLOW_PATH, "utf8")) as {
		jobs: Record<string, Job>;
	};
}

describe("Windows Vitest workflow contract (#2536)", () => {
	it("keeps the Windows subset lane present, bounded, and advisory", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		expect(job?.name).toBe("Unit tests Windows (advisory)");
		expect(job?.["runs-on"]).toBe("windows-latest");
		expect(job?.["continue-on-error"]).toBeUndefined();
		expect(job?.["timeout-minutes"]).toBe(25);
		expect(job?.outputs?.windows_vitest).toBe(
			"${{ steps.windows-vitest.outcome }}",
		);
		expect(job?.permissions).toEqual({ contents: "read" });
	});

	it("keeps dynamic Windows enumeration and the runner command wired", () => {
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		const enumeration = steps.find(
			(step) => step.name === "Enumerate Windows Vitest subset",
		);
		const runner = steps.find(
			(step) => step.name === "Run Windows Vitest subset",
		);
		const outcome = steps.find(
			(step) => step.name === "Record Windows Vitest outcome",
		);

		// Recurrence: #2536's Windows-only tests were present but had no CI
		// consumer; deleting either population source would silently recreate it.
		expect(enumeration?.shell).toBe("bash");
		expect(enumeration?.run).toContain("git grep -l");
		expect(enumeration?.run).toContain(":(glob)tests/**/*.test.ts");
		expect(enumeration?.run).toContain("${#FILES[@]} -eq 0");
		expect(enumeration?.run).toContain("path\\.win32");
		expect(enumeration?.run).toContain("skipIf");
		expect(enumeration?.run).toContain("runIf");
		expect(enumeration?.run).toContain("tests/config");
		expect(enumeration?.run).toContain("tool-cwd.test.ts");
		expect(runner?.run).toContain("--configLoader runner");
		expect(runner?.id).toBe("windows-vitest");
		expect(runner?.["continue-on-error"]).toBe(true);
		expect(outcome?.if).toBe("always()");
		expect(raw).toContain("on 7 consecutive master/PR runs");
		expect(raw).toContain("Windows Vitest subset step outcome:");
		expect(raw).toContain("windows_vitest=$outcome");
		expect(raw).toContain("PI_LENS_TEST_TIMEOUT_SCALE: '3'");
		expect(raw).toContain("Validate merge-train dispatch payload");
	});

	it("pins the sibling action revisions and the isolated home", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		expect(steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
			"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
			"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
		]);
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		expect(raw).toContain(
			'PI_LENS_HOME=$RUNNER_TEMP/pi-lens-home" >> "$GITHUB_ENV"',
		);
		expect(raw).toContain("npm ci --no-audit --no-fund");
		expect(raw).toContain("npm run build");
	});
});

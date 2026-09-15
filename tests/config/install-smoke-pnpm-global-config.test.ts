// Prevents the install-smoke regression from run 34880209347: pnpm 11.15.1
// reads the checkout's `packageManager: npm@...` when global-bin setup is
// project-scoped, so the pnpm global install coverage fails before pi starts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = ".github/workflows/install-smoke.yml";

type Step = { name?: unknown; run?: unknown; uses?: unknown; if?: unknown };
type NamedStep = Step & { name: string };
type Job = {
	steps?: unknown;
	strategy?: { matrix?: Record<string, unknown> };
};
type Workflow = { jobs?: Record<string, Job> };

function loadWorkflow(source?: string): Workflow {
	const text =
		source ?? readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
	return yaml.load(text) as Workflow;
}

function stepsFor(workflow: Workflow, jobName: string): Step[] {
	const steps = workflow.jobs?.[jobName]?.steps;
	return Array.isArray(steps) ? (steps as Step[]) : [];
}

function namedSteps(workflow: Workflow, jobName: string): NamedStep[] {
	return stepsFor(workflow, jobName).filter(
		(step): step is NamedStep => typeof step.name === "string",
	);
}

function stepIndex(workflow: Workflow, jobName: string, name: string): number {
	const index = namedSteps(workflow, jobName).findIndex((step) =>
		step.name.includes(name),
	);
	if (index < 0) throw new Error(`${jobName} has no step named like ${name}`);
	return index;
}

function stepRun(workflow: Workflow, jobName: string, name: string): string {
	const step = namedSteps(workflow, jobName).find((candidate) =>
		candidate.name.includes(name),
	);
	if (typeof step?.run !== "string") {
		throw new Error(`${jobName} step ${name} has no run script`);
	}
	return step.run;
}

function executableLines(script: string): string[] {
	return script
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function caseArm(script: string, label: string): string {
	const lines = script.split("\n");
	const start = lines.findIndex((line) => line.trim() === `${label})`);
	if (start < 0) throw new Error(`script has no ${label} case arm`);
	const end = lines.findIndex(
		(line, index) => index > start && /^\s*[a-z][a-z-]*\)\s*$/.test(line),
	);
	return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

function assertPnpmInstallPath(workflow: Workflow, jobName: string): void {
	const job = workflow.jobs?.[jobName];
	const matrix = job?.strategy?.matrix;
	if (jobName === "pi-load") {
		expect(matrix?.pi_install).toEqual([
			"npm-global",
			"pnpm-global",
			"bun-global",
			"curl",
		]);
		const setup = stepIndex(workflow, jobName, "Setup pnpm");
		const install = stepIndex(workflow, jobName, "Install pi");
		expect(stepIndex(workflow, jobName, "Setup Node")).toBeLessThan(setup);
		expect(setup).toBeLessThan(install);
		const installScript = stepRun(workflow, jobName, "Install pi");
		const pnpmInstallLines = executableLines(
			caseArm(installScript, "pnpm-global"),
		).join("\n");
		expect(pnpmInstallLines).toContain("pnpm-global)");
		expect(pnpmInstallLines).toContain(
			'pnpm config set --global global-bin-dir "$PNPM_HOME"',
		);
		expect(pnpmInstallLines).toContain('pnpm add -g --ignore-scripts "$PKG"');
		expect(pnpmInstallLines).toContain('echo "NPMCMD=pnpm" >> "$GITHUB_ENV"');
	} else {
		expect(matrix?.os).toEqual(["ubuntu-latest", "macos-latest"]);
		expect(matrix?.pi_via).toEqual(["mise-node", "mise-npm-backend"]);
		const installPnpm = stepIndex(workflow, jobName, "Install pnpm");
		const configure = stepIndex(workflow, jobName, "Configure pnpm global");
		expect(installPnpm).toBeLessThan(configure);
		const installPnpmLines = executableLines(
			stepRun(workflow, jobName, "Install pnpm"),
		).join("\n");
		expect(installPnpmLines).toContain(
			"npm install -g --ignore-scripts pnpm@11.15.1",
		);
		expect(installPnpmLines).toContain('cd "$RUNNER_TEMP"');
		expect(installPnpmLines).toContain("pnpm --version");
		expect(installPnpmLines.indexOf('cd "$RUNNER_TEMP"')).toBeLessThan(
			installPnpmLines.indexOf("pnpm --version"),
		);
		const configureLines = executableLines(
			stepRun(workflow, jobName, "Configure pnpm global"),
		).join("\n");
		expect(configureLines).toContain(
			'pnpm config set --global global-bin-dir "$PNPM_HOME"',
		);
	}

	const piConfigure = stepIndex(workflow, jobName, "Configure pi");
	const rpc = stepIndex(workflow, jobName, "Verify pi-lens loads via RPC");
	expect(piConfigure).toBeGreaterThan(
		stepIndex(workflow, jobName, "Install pi"),
	);
	expect(rpc).toBeGreaterThan(piConfigure);
	const piLines = executableLines(
		stepRun(workflow, jobName, "Configure pi"),
	).join("\n");
	expect(piLines).toContain(
		jobName === "pi-load"
			? "npmCommand:[process.env.NPMCMD]"
			: 'npmCommand:["pnpm"]',
	);
	expect(piLines).toContain("pi install npm:pi-lens");
	expect(piLines).toContain("pi list | grep -i 'pi-lens'");
	const rpcLines = executableLines(
		stepRun(workflow, jobName, "Verify pi-lens loads via RPC"),
	).join("\n");
	expect(rpcLines).toContain(
		'node "$GITHUB_WORKSPACE/scripts/rpc-load-check.mjs" "$(command -v pi)"',
	);
}

describe("install-smoke pnpm global-bin configuration", () => {
	const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
	const workflow = loadWorkflow(source);

	for (const jobName of ["pi-load", "mise-repro"] as const) {
		it(`covers the complete ${jobName} pnpm matrix path`, () => {
			assertPnpmInstallPath(workflow, jobName);
		});
	}
});

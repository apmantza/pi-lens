export const BASH4_NEEDLES = [
	{ name: "mapfile", bashVersion: "4.0" },
	{ name: "readarray", bashVersion: "4.0" },
	{ name: "${var,,}", bashVersion: "4.0" },
	{ name: "${var^^}", bashVersion: "4.0" },
	{ name: "declare -A", bashVersion: "4.0" },
	{ name: "|&", bashVersion: "4.0" },
	{ name: ";;&", bashVersion: "4.0" },
] as const;

export type Workflow = {
	on?: {
		workflow_call?: {
			inputs?: Record<string, { default?: unknown; options?: unknown }>;
		};
	};
	jobs?: Record<
		string,
		{
			"runs-on"?: unknown;
			strategy?: { matrix?: Record<string, unknown> };
			steps?: Array<{ name?: unknown; run?: unknown; shell?: unknown }>;
		}
	>;
};

export type WorkflowFinding = {
	workflow: string;
	job: string;
	step: string;
	needle: string;
};

export function findBash4PortabilityFindings(
	workflow: Workflow,
	workflowName: string,
): WorkflowFinding[] {
	const findings: WorkflowFinding[] = [];
	for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
		if (!canRunOnMacOS(workflow, job)) continue;
		for (const step of job.steps ?? []) {
			if (typeof step.run !== "string" || !isBashStep(step)) continue;
			const code = blankShellProse(step.run);
			for (const needle of BASH4_NEEDLES) {
				if (needlePattern(needle.name).test(code)) {
					findings.push({
						workflow: workflowName,
						job: jobName,
						step: typeof step.name === "string" ? step.name : "(unnamed)",
						needle: needle.name,
					});
				}
			}
		}
	}
	return findings;
}

function isMacOS(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("macos-");
}

function containsMacOS(value: unknown): boolean {
	if (isMacOS(value)) return true;
	if (Array.isArray(value)) return value.some(containsMacOS);
	if (value && typeof value === "object") {
		return Object.values(value).some(containsMacOS);
	}
	return false;
}

function canRunOnMacOS(
	workflow: Workflow,
	job: NonNullable<Workflow["jobs"]>[string],
): boolean {
	const runsOn = job["runs-on"];
	if (isMacOS(runsOn)) return true;
	if (typeof runsOn !== "string") return false;
	const matrixName = runsOn.match(/\bmatrix\.([A-Za-z_][\w-]*)\b/)?.[1];
	if (matrixName && containsMacOS(job.strategy?.matrix?.[matrixName])) {
		return true;
	}
	const inputNames = [...runsOn.matchAll(/\binputs\.([A-Za-z_][\w-]*)\b/g)].map(
		(match) => match[1],
	);
	const inputs = workflow.on?.workflow_call?.inputs ?? {};
	return inputNames.some((name) => {
		const input = inputs[name];
		return (
			containsMacOS(input) ||
			(input !== undefined &&
				input.default === undefined &&
				input.options === undefined)
		);
	});
}

function isBashStep(step: { shell?: unknown }): boolean {
	if (step.shell === undefined) return true;
	return typeof step.shell === "string" && /^bash(?:\s|$)/.test(step.shell);
}

function needlePattern(needle: string): RegExp {
	if (needle === "${var,,}") return /\$\{[A-Za-z_][\w]*,,[^}]*\}/;
	if (needle === "${var^^}") return /\$\{[A-Za-z_][\w]*\^\^[^}]*\}/;
	if (needle === "declare -A") return /\bdeclare\s+-A\b/;
	if (needle === "|&") return /\|&/;
	if (needle === ";;&") return /;;&/;
	return new RegExp(`\\b${needle}\\b`);
}

/** Blanks shell comments and quoted prose while preserving line positions. */
function blankShellProse(source: string): string {
	const chars = source.split("");
	let quote: "'" | '"' | undefined;
	let comment = false;
	for (let index = 0; index < chars.length; index++) {
		const char = chars[index];
		if (comment) {
			if (char === "\n") comment = false;
			else chars[index] = " ";
			continue;
		}
		if (quote) {
			if (char === "\\" && quote === '"') {
				if (index + 1 < chars.length && chars[index + 1] !== "\n")
					chars[++index] = " ";
				chars[index - 1] = " ";
			} else if (char === quote) {
				quote = undefined;
				chars[index] = " ";
			} else if (char !== "\n") chars[index] = " ";
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			chars[index] = " ";
			continue;
		}
		if (char === "#" && (index === 0 || /[\s;]/.test(chars[index - 1]))) {
			comment = true;
			chars[index] = " ";
		}
	}
	return stripSource(chars.join(""));
}
import { stripSource } from "./sweep-kit.js";

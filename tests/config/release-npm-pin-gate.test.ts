// Recurrence: #2940. 9183f39c6 changed release.yml's "Pin npm" step from
// `npm install -g npm@<pin>` to `npx -y npm@<pin> --version` and routed the
// INSTALL step through `npx`, but left `npm publish` bare — so the publish job
// ran Node 22's bundled npm, which has no OIDC trusted-publishing support.
// Nothing failed until the v4.1.6 release run (34530690014, 2026-09-10):
// tag and GitHub release created, then
// `npm error 404 Not Found - PUT https://registry.npmjs.org/pi-lens`.
// Recovered by #2938. The exact pre-fix file is checked in at
// tests/fixtures/workflows/release-9183f39c6.yml (byte-identical to
// `git show 9183f39c6:.github/workflows/release.yml`) and is the red vector
// below — CI checks out at depth 1, so the historical object is NOT reachable
// from a test and the vector has to be a committed fixture.
//
// Two scans, two string policies, deliberately (the sweep-kit
// `strings: "preserve" | "blank"` distinction, applied to shell):
//   - the SATISFY direction (which step carries the pinned invocation, which
//     step asserts the version) reads comment-blanked text with strings
//     INTACT, because the pinned invocation's own `"npm@${npm_pin}"` is a
//     quoted token, not prose;
//   - the TRIP direction (is there a bare `npm <verb>`) reads `lexShell`'s
//     fully lexed text, where a comment or an `echo "... npm run ..."` string
//     cannot masquerade as a command.
// A comment quoting `npm publish` therefore neither trips the rule nor
// satisfies it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { lexShell } from "../support/workflow-shell-portability.js";

const ROOT = resolve(import.meta.dirname, "../..");
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const HISTORICAL_FIXTURE = "tests/fixtures/workflows/release-9183f39c6.yml";

/** The jobs whose shell runs npm against the registry or the tarball. */
const GUARDED_JOBS = ["prepare", "publish-npm"] as const;

type Step = { name?: unknown; run?: unknown };
type Job = { steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

function loadWorkflow(source: string): Workflow {
	return yaml.load(source) as Workflow;
}

function readWorkflow(relativePath: string): Workflow {
	return loadWorkflow(readFileSync(resolve(ROOT, relativePath), "utf8"));
}

/**
 * Blank shell comments, keep strings. Quote tracking is what stops a `#`
 * inside a string being read as a comment start; blanking a line too eagerly
 * can only make the SATISFY direction stricter, never let a comment pass for
 * code.
 */
function blankShellComments(run: string): string {
	return run
		.split("\n")
		.map((line) => {
			let quote: string | undefined;
			for (let index = 0; index < line.length; index++) {
				const char = line[index];
				if (quote !== undefined) {
					if (char === quote) quote = undefined;
					continue;
				}
				if (char === "'" || char === '"') {
					quote = char;
					continue;
				}
				if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
					return line.slice(0, index) + " ".repeat(line.length - index);
				}
			}
			return line;
		})
		.join("\n");
}

type WorkflowStep = { job: string; name: string; run: string; index: number };

/** Every `run:` step of the guarded jobs, in file order. */
function guardedSteps(workflow: Workflow): WorkflowStep[] {
	const steps: WorkflowStep[] = [];
	for (const job of GUARDED_JOBS) {
		const list = workflow.jobs?.[job]?.steps ?? [];
		list.forEach((step, index) => {
			if (typeof step.run !== "string") return;
			steps.push({
				job,
				name: typeof step.name === "string" ? step.name : "(unnamed)",
				run: step.run,
				index,
			});
		});
	}
	return steps;
}

/**
 * The pinned invocation, derived from the workflow's OWN pin step — never a
 * hard-coded version. The variable name is whatever the file uses; the form is
 * `npx -y "npm@${<that variable>}"`.
 */
const PINNED_FORM_RE = /npx\s+-y\s+"npm@\$\{(\w+)\}"/;

function pinnedInvocation(
	workflow: Workflow,
): { variable: string; form: string } | undefined {
	for (const step of guardedSteps(workflow)) {
		const variable = blankShellComments(step.run).match(PINNED_FORM_RE)?.[1];
		if (variable) return { variable, form: `npx -y "npm@\${${variable}}"` };
	}
	return undefined;
}

/** The pinned invocation, or a named failure — never a silent fallback. */
function requirePinned(workflow: Workflow): { variable: string; form: string } {
	const pinned = pinnedInvocation(workflow);
	if (!pinned) {
		throw new Error(
			'no `npx -y "npm@${<pin>}"` invocation in the guarded jobs',
		);
	}
	return pinned;
}

type BareNpmFinding = { job: string; step: string; verb: string };

/**
 * Every `npm <verb>` the guarded jobs run OUTSIDE the pinned invocation.
 *
 * Shape 34: the needle is npm at a COMMAND position followed by any verb, not
 * a list of the verbs we happen to know about — `npm publish`, `npm install`,
 * and the next one someone adds all read the same.
 */
function findBareNpmInvocations(workflow: Workflow): BareNpmFinding[] {
	const findings: BareNpmFinding[] = [];
	for (const step of guardedSteps(workflow)) {
		// `lexShell` blanks comments AND string bodies, and inside the pinned
		// form's `"npm@${npm_pin}"` only the `${...}` expansion survives — so a
		// pinned invocation cannot read as a bare one, and neither can prose.
		const code = lexShell(step.run);
		for (const match of code.matchAll(
			/(?:^|[;\n(]|&&|\|\|?|\$\()\s*npm(?![\w@.-])\s+([a-z][\w-]*)/g,
		)) {
			findings.push({ job: step.job, step: step.name, verb: match[1] });
		}
	}
	return findings;
}

/**
 * The publish-npm step that asserts, at run time, that the pinned npm is what
 * `publish` will run: it invokes the pinned form with `--version` and FAILS the
 * step when the answer differs from the pin. Read off comment-blanked text, so
 * a step that merely QUOTES the assertion does not carry it — 9183f39c6's pin
 * step ran the same `--version` and did nothing with the answer, which is the
 * exact state this must not accept.
 *
 * Two failure spellings are accepted, both of them real in this tree: an
 * explicit non-zero `exit` (release.yml, which also echoes the observed
 * version so a failed release is diagnosable from the log) and a bare
 * `test <pinned --version> = <pin>` (ci.yml's prod-install-build job).
 */
function findPinAssertionStep(
	workflow: Workflow,
	pinned: { variable: string; form: string },
): WorkflowStep | undefined {
	return guardedSteps(workflow).find((step) => {
		if (step.job !== "publish-npm") return false;
		const code = blankShellComments(step.run);
		const comparesToPin = new RegExp(
			`(?:test|\\[\\[?)\\s+[^\\n]*\\$\\{?${pinned.variable}\\}?`,
		).test(code);
		return (
			code.includes(`${pinned.form} --version`) &&
			new RegExp(`\\$\\{?${pinned.variable}\\}?`).test(code) &&
			(/\bexit\s+[1-9]/.test(code) || comparesToPin)
		);
	});
}

/**
 * The publish-npm step that actually publishes (never `--dry-run`). Matched on
 * the pinned invocation itself, so neither a comment nor an `echo` mentioning
 * the word "publish" can stand in for the step the assertion must precede.
 */
function findPublishStep(
	workflow: Workflow,
	pinned: { form: string },
): WorkflowStep | undefined {
	return guardedSteps(workflow).find((step) => {
		if (step.job !== "publish-npm") return false;
		const code = blankShellComments(step.run);
		return (
			code.includes(`${pinned.form} publish`) && !code.includes("--dry-run")
		);
	});
}

describe("release.yml npm pin gate (#2940)", () => {
	const workflow = readWorkflow(RELEASE_WORKFLOW);

	it("keeps both guarded jobs in the scan", () => {
		// Shape 10 / #1718: a renamed job would empty this scan and every
		// assertion below would pass over nothing.
		expect(Object.keys(workflow.jobs ?? {})).toEqual(
			expect.arrayContaining([...GUARDED_JOBS]),
		);
		assertNonEmptyScan(
			"release.yml pinned-npm scan",
			guardedSteps(workflow).length,
			5,
		);
	});

	it("runs every npm verb in prepare and publish-npm through the pinned npx", () => {
		expect(findBareNpmInvocations(workflow)).toEqual([]);
	});

	it("derives the pin from package.json in every step that uses it", () => {
		const pinned = requirePinned(workflow);
		const users = guardedSteps(workflow).filter((step) =>
			blankShellComments(step.run).includes(pinned.form),
		);
		expect(users.length).toBeGreaterThanOrEqual(3);
		for (const step of users) {
			// An unassigned variable expands to empty and `npm@` resolves to
			// LATEST — the pinned form would still match textually. Each step is
			// its own shell, so each one must derive the pin itself.
			expect(
				new RegExp(`${pinned.variable}=.*packageManager`).test(
					blankShellComments(step.run),
				),
				`${step.job}/${step.name} uses the pinned form without deriving ${pinned.variable} from package.json`,
			).toBe(true);
		}
	});

	it("asserts the pinned npm version immediately before publishing", () => {
		const pinned = requirePinned(workflow);
		const assertion = findPinAssertionStep(workflow, pinned);
		const publish = findPublishStep(workflow, pinned);
		expect(assertion, "no runtime pin assertion in publish-npm").toBeDefined();
		expect(publish, "no publish step in publish-npm").toBeDefined();
		expect(assertion?.index).toBe((publish?.index ?? 0) - 1);
	});

	it("reds on the 9183f39c6 workflow, naming the bare publish", () => {
		const findings = findBareNpmInvocations(readWorkflow(HISTORICAL_FIXTURE));
		expect(findings).toContainEqual({
			job: "publish-npm",
			step: "Publish to npm",
			verb: "publish",
		});
		// The same commit left prepare's install and dry-run publish bare too.
		expect(findings).toEqual([
			{ job: "prepare", step: "Install dependencies", verb: "install" },
			{
				job: "prepare",
				step: "Dry-run publish (validates tarball)",
				verb: "publish",
			},
			{ job: "publish-npm", step: "Publish to npm", verb: "publish" },
		]);
	});

	// Each line here is a command-position `npm <verb>` that a RAW scan reads as
	// an invocation: `|| npm publish` in a comment, `; npm run` inside a
	// double-quoted echo, `; npm install` inside a single-quoted one. Blanking
	// is what makes them prose, and this case is the blanking's signature.
	it("does not read a commented or quoted npm command as an invocation", () => {
		const fixture = loadWorkflow(`
jobs:
  prepare:
    steps:
      - name: Prose only
        run: |
          # recovery, by hand: npx -y "npm@\${npm_pin}" publish || npm publish
          echo "Unrolled entries remain; npm run changelog:release in the bump PR"
  publish-npm:
    steps:
      - name: Prose only
        run: echo 'never do this; npm install -g npm@latest'
`);
		expect(findBareNpmInvocations(fixture)).toEqual([]);
	});

	it("does not let a commented assertion satisfy the runtime check", () => {
		const fixture = loadWorkflow(`
jobs:
  prepare:
    steps: []
  publish-npm:
    steps:
      - name: Talks about asserting
        run: |
          npm_pin="$(node -p "require('./package.json').packageManager.replace(/^npm@/, '')")"
          # npx -y "npm@\${npm_pin}" --version must equal $npm_pin or exit 1
          echo pinned
      - name: Publish to npm
        run: |
          npm_pin="$(node -p "require('./package.json').packageManager.replace(/^npm@/, '')")"
          npx -y "npm@\${npm_pin}" publish
`);
		const pinned = requirePinned(fixture);
		expect(pinned.variable).toBe("npm_pin");
		expect(findPinAssertionStep(fixture, pinned)).toBeUndefined();
	});

	it("derives the pin variable from the file rather than a fixed name", () => {
		const fixture = loadWorkflow(`
jobs:
  prepare:
    steps: []
  publish-npm:
    steps:
      - name: Assert the pinned npm
        run: |
          release_npm="$(node -p "require('./package.json').packageManager.replace(/^npm@/, '')")"
          test "$(npx -y "npm@\${release_npm}" --version)" = "$release_npm" || exit 1
      - name: Publish to npm
        run: |
          release_npm="$(node -p "require('./package.json').packageManager.replace(/^npm@/, '')")"
          npx -y "npm@\${release_npm}" publish
`);
		const pinned = requirePinned(fixture);
		expect(pinned.variable).toBe("release_npm");
		expect(findBareNpmInvocations(fixture)).toEqual([]);
		expect(findPinAssertionStep(fixture, pinned)?.name).toBe(
			"Assert the pinned npm",
		);
	});
});

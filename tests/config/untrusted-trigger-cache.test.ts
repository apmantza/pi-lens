// Cache poisoning (#4358): a workflow that `pull_request_target` or
// `workflow_run` starts runs in the BASE repository's context with its cache
// scope, and what it saves is restorable by every later run of that scope. A
// pull request can steer the content (a poisoned `node_modules/.bin`, a
// replaced release binary) into a cache that a privileged job later restores
// and executes. Neither trigger restores or saves a cache today; #4358 adds
// caches to the nightly smoke workflows, so the first copied `cache:` line is
// the recurrence this guard catches: an `actions/cache` step, or a `setup-*`
// step's `cache:` input (which restores and saves through the same cache
// service), in a workflow those triggers start.
//
// The scan reads the PARSED workflow, never the YAML text, so a comment or a
// string that names `actions/cache` can neither satisfy nor dodge it (a
// commented-out step is not a step, a `run:` echoing the name is not a use).
// A local composite action or reusable workflow is followed, because
// `uses: ./.github/actions/x` hides its steps from the caller's own file.
import { decodeShellWords } from "../../clients/bash-file-access.js";
import yaml from "../../clients/deps/js-yaml.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	workflowDocument,
	workflowTriggers,
} from "../../scripts/dispatch-safety.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

const UNTRUSTED_TRIGGERS = ["pull_request_target", "workflow_run"] as const;

type Step = { uses?: unknown; with?: unknown };
type Job = { uses?: unknown; steps?: Step[] };
type Document = {
	on?: unknown;
	jobs?: Record<string, Job>;
	runs?: { steps?: Step[] };
};

/** Source text of a repo-relative local reference, or undefined. */
type ReadLocal = (reference: string) => string | undefined;

function parse(source: string): Document {
	return workflowDocument(source) as Document;
}

// `actions/setup-*` and the third-party `owner/setup-*` family restore and save
// a cache when `cache:` is set. Four cache without it, each by its own default:
// setup-node 6.x and 7.x (v7.1.0 keeps `package-manager-cache` default true,
// #4418) auto-cache npm when package.json names it in `packageManager`
// (opt out with `package-manager-cache: false`), setup-go caches unless
// `cache: false`, setup-uv's `enable-cache` defaults to auto (on for
// GitHub-hosted runners), and setup-ruby caches with `bundler-cache`.
const SETUP_ACTION = /^[^/]+\/setup-[\w-]+$/;

function truthyInput(value: unknown): boolean {
	return (
		value !== undefined &&
		value !== null &&
		value !== false &&
		String(value).trim() !== "" &&
		String(value).trim().toLowerCase() !== "false"
	);
}

/** An input that is on unless the workflow sets it to a false value. */
function onByDefault(inputs: Record<string, unknown>, name: string): boolean {
	return inputs[name] === undefined || truthyInput(inputs[name]);
}

function stepCacheUse(step: Step): string | undefined {
	if (typeof step.uses !== "string") return undefined;
	const action = step.uses.split("@")[0].toLowerCase();
	if (action === "actions/cache" || action.startsWith("actions/cache/"))
		return action;
	const inputs =
		step.with && typeof step.with === "object"
			? (step.with as Record<string, unknown>)
			: {};
	if (!SETUP_ACTION.test(action)) return undefined;
	if (truthyInput(inputs.cache))
		return `${action} with cache: ${String(inputs.cache)}`;
	if (
		action === "actions/setup-node" &&
		onByDefault(inputs, "package-manager-cache")
	)
		return `${action} (auto-caches npm unless package-manager-cache: false)`;
	if (action === "actions/setup-go" && inputs.cache === undefined)
		return `${action} (caches by default)`;
	if (action === "astral-sh/setup-uv" && onByDefault(inputs, "enable-cache"))
		return `${action} (enable-cache defaults to auto)`;
	if (action === "ruby/setup-ruby" && truthyInput(inputs["bundler-cache"]))
		return `${action} with bundler-cache: ${String(inputs["bundler-cache"])}`;
	return undefined;
}

/** A local `./path` reference, normalised to a repo-relative directory/file. */
function localReference(uses: unknown): string | undefined {
	return typeof uses === "string" && uses.startsWith("./")
		? uses.slice(2).replace(/\/$/, "")
		: undefined;
}

function cacheFindings(
	document: Document,
	label: string,
	readLocal: ReadLocal,
	seen: Set<string> = new Set(),
): string[] {
	const findings: string[] = [];
	const scanSteps = (steps: Step[] | undefined, where: string) => {
		for (const [index, step] of (steps ?? []).entries()) {
			const cached = stepCacheUse(step);
			if (cached !== undefined)
				findings.push(`${where} step ${index}: ${cached}`);
			const local = localReference(step.uses);
			if (local === undefined || seen.has(local)) continue;
			seen.add(local);
			const source =
				readLocal(`${local}/action.yml`) ?? readLocal(`${local}/action.yaml`);
			if (source === undefined) continue;
			findings.push(
				...cacheFindings(
					parse(source),
					`${where} -> ${local}`,
					readLocal,
					seen,
				),
			);
		}
	};
	for (const [name, job] of Object.entries(document.jobs ?? {})) {
		scanSteps(job?.steps, `${label}:${name}`);
		const reusable = localReference(job?.uses);
		if (reusable === undefined || seen.has(reusable)) continue;
		seen.add(reusable);
		const source = readLocal(reusable);
		if (source !== undefined)
			findings.push(
				...cacheFindings(
					parse(source),
					`${label}:${name} -> ${reusable}`,
					readLocal,
					seen,
				),
			);
	}
	scanSteps(document.runs?.steps, label);
	return findings;
}

function isUntrusted(document: Document): boolean {
	const triggers = workflowTriggers(document.on);
	return UNTRUSTED_TRIGGERS.some((trigger) => triggers.includes(trigger));
}

/** Findings for one workflow source; empty when no untrusted trigger starts it. */
function untrustedCacheFindings(
	source: string,
	label: string,
	readLocal: ReadLocal = () => undefined,
): string[] {
	const document = parse(source);
	return isUntrusted(document) ? cacheFindings(document, label, readLocal) : [];
}

const readFromRoot: ReadLocal = (reference) => {
	const file = resolve(ROOT, reference);
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

function workflowFiles(): string[] {
	return readdirSync(WORKFLOWS)
		.filter((file) => /\.ya?ml$/.test(file))
		.sort();
}

const PLANTED = [
	"jobs:",
	"  job:",
	"    runs-on: ubuntu-latest",
	"    steps:",
	"      - uses: actions/checkout@v7",
	"      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830",
	"        with:",
	"          path: ~/.npm",
	"          key: k",
].join("\n");

describe("untrusted triggers never restore or save a cache (#4358)", () => {
	it("scans the real pull_request_target and workflow_run workflows and finds no cache", () => {
		const scanned = workflowFiles().filter((file) =>
			isUntrusted(parse(readFileSync(resolve(WORKFLOWS, file), "utf8"))),
		);
		// Recurrence of a vacuous sweep (#1718): a parser that read no trigger
		// would scan nothing and read as clean. Two pull_request_target workflows
		// (close-keyword-verification, greetings) and one workflow_run workflow
		// (ci-infra-kill-rerun) exist today.
		assertNonEmptyScan(
			"untrusted-trigger workflows scanned",
			scanned.length,
			3,
		);
		const findings = scanned.flatMap((file) =>
			untrustedCacheFindings(
				readFileSync(resolve(WORKFLOWS, file), "utf8"),
				file,
				readFromRoot,
			),
		);
		expect(findings).toEqual([]);
	});

	describe("planted cache steps", () => {
		it.each([
			["on: pull_request_target"],
			["on: [pull_request_target]"],
			["on:\n  pull_request_target:\n    types: [opened]"],
			["on:\n  pull_request:\n  workflow_run:\n    workflows: [CI]"],
		])("flags a planted actions/cache step under %s", (on) => {
			expect(
				untrustedCacheFindings(`${on}\n${PLANTED}`, "planted.yml"),
			).toEqual(["planted.yml:job step 1: actions/cache"]);
		});

		it.each([
			["actions/cache/restore", "actions/cache/restore@abc"],
			["actions/cache/save", "actions/cache/save@abc"],
			["upper-case spelling", "Actions/Cache@abc"],
		])("flags %s", (_name, uses) => {
			const planted = PLANTED.replace(
				"actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830",
				uses,
			);
			expect(
				untrustedCacheFindings(`on: workflow_run\n${planted}`, "p.yml"),
			).toHaveLength(1);
		});

		it("flags a setup-* step with a cache: input, which restores and saves too", () => {
			const workflow = [
				"on: pull_request_target",
				"jobs:",
				"  job:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - uses: actions/setup-node@5555555555555555555555555555555555555555",
				"        with:",
				"          node-version: '22'",
				"          cache: npm",
			].join("\n");
			expect(untrustedCacheFindings(workflow, "p.yml")).toEqual([
				"p.yml:job step 0: actions/setup-node with cache: npm",
			]);
		});

		it("flags the flow-mapping and quoted-key spellings", () => {
			const workflow = [
				"on: pull_request_target",
				"jobs:",
				"  job:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				'      - {"uses": "actions/cache@abc", with: {path: x, key: y}}',
			].join("\n");
			expect(untrustedCacheFindings(workflow, "p.yml")).toHaveLength(1);
		});

		it("follows a local composite action into its steps", () => {
			const caller = [
				"on: pull_request_target",
				"jobs:",
				"  job:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - uses: ./.github/actions/tools",
			].join("\n");
			const composite = [
				"runs:",
				"  using: composite",
				"  steps:",
				"    - uses: actions/cache@abc",
				"      with: { path: x, key: y }",
			].join("\n");
			const findings = untrustedCacheFindings(caller, "p.yml", (reference) =>
				reference === ".github/actions/tools/action.yml"
					? composite
					: undefined,
			);
			expect(findings).toEqual([
				"p.yml:job -> .github/actions/tools step 0: actions/cache",
			]);
		});

		it("follows a local reusable workflow into its jobs", () => {
			const caller = [
				"on: workflow_run",
				"jobs:",
				"  call:",
				"    uses: ./.github/workflows/shared.yml",
			].join("\n");
			const findings = untrustedCacheFindings(caller, "p.yml", (reference) =>
				reference === ".github/workflows/shared.yml"
					? `on: workflow_call\n${PLANTED}`
					: undefined,
			);
			expect(findings).toEqual([
				"p.yml:call -> .github/workflows/shared.yml:job step 1: actions/cache",
			]);
		});
	});

	describe("prose and trusted triggers do not move the verdict", () => {
		it("ignores a cache named only in a comment, a run string, or a name", () => {
			const workflow = [
				"on: pull_request_target",
				"jobs:",
				"  job:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      # - uses: actions/cache@abc",
				"      - name: actions/cache is banned here",
				"        run: |",
				'          echo "uses: actions/cache@abc"',
				"      - uses: actions/checkout@abc # actions/cache",
			].join("\n");
			expect(untrustedCacheFindings(workflow, "p.yml")).toEqual([]);
		});

		it("does not read a comment as the dodge either: a real step stays flagged beside prose", () => {
			const workflow = `on: pull_request_target # cache-safe: no actions/cache here\n${PLANTED}`;
			expect(untrustedCacheFindings(workflow, "p.yml")).toHaveLength(1);
		});

		it("leaves trusted triggers alone: a schedule workflow may cache", () => {
			expect(
				untrustedCacheFindings(
					`on:\n  schedule:\n    - cron: '0 6 * * *'\n${PLANTED}`,
					"p.yml",
				),
			).toEqual([]);
			expect(
				untrustedCacheFindings(`on: pull_request\n${PLANTED}`, "p.yml"),
			).toEqual([]);
		});

		it("does not flag a setup-* step that does not cache", () => {
			const workflow = [
				"on: pull_request_target",
				"jobs:",
				"  job:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - uses: actions/setup-node@abc",
				"        with: { node-version: '22', package-manager-cache: false }",
				"      - uses: actions/setup-python@abc",
				"        with: { python-version: '3.12' }",
				"      - uses: actions/setup-go@abc",
				"        with: { cache: false }",
				"      - uses: astral-sh/setup-uv@abc",
				"        with: { enable-cache: false }",
				"      - uses: ruby/setup-ruby@abc",
				"        with: { ruby-version: '3.3' }",
			].join("\n");
			expect(untrustedCacheFindings(workflow, "p.yml")).toEqual([]);
		});

		// Recurrence: review r1 F4. These setup actions cache without a `cache:`
		// input: setup-go by default, setup-uv on GitHub-hosted runners by default
		// (`enable-cache: auto`), setup-ruby through `bundler-cache`, and setup-node
		// 6.x auto-caches npm when package.json names it in `packageManager`: the
		// tool-smoke log of 2026-10-14 shows "Auto caching has been enabled for npm"
		// and a cache hit with no `cache:` input at all.
		it.each([
			[
				"setup-go with no cache input",
				"actions/setup-go@abc",
				"{ go-version: '1.23' }",
			],
			[
				"setup-uv with no enable-cache",
				"astral-sh/setup-uv@abc",
				"{ version: '0.5' }",
			],
			[
				"setup-uv enable-cache: true",
				"astral-sh/setup-uv@abc",
				"{ enable-cache: true }",
			],
			[
				"setup-ruby bundler-cache: true",
				"ruby/setup-ruby@abc",
				"{ bundler-cache: true }",
			],
			[
				"setup-node with no cache input",
				"actions/setup-node@abc",
				"{ node-version: '22' }",
			],
			[
				"setup-node cache: npm with package-manager-cache: false",
				"actions/setup-node@abc",
				"{ cache: npm, package-manager-cache: false }",
			],
		])("flags %s", (_name, uses, withInput) => {
			const workflow = [
				"on: workflow_run",
				"jobs:",
				"  job:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				`      - uses: ${uses}`,
				`        with: ${withInput}`,
			].join("\n");
			expect(untrustedCacheFindings(workflow, "p.yml")).toHaveLength(1);
		});
	});
});

function jobsOf(
	file: string,
): Record<
	string,
	{ steps?: { uses?: string; run?: string; with?: Record<string, unknown> }[] }
> {
	return (
		yaml.load(readFileSync(resolve(ROOT, file), "utf8")) as {
			jobs: Record<
				string,
				{
					steps?: {
						uses?: string;
						run?: string;
						with?: Record<string, unknown>;
					}[];
				}
			>;
		}
	).jobs;
}
// #5082 / #5182 recurrence: no-install jobs won the shared Linux npm cache
// key with an empty ~/.npm. Unknown install wrappers must opt out too.
describe("npm auto-cache writers across workflows", () => {
	const installs = (run: string) =>
		decodeShellWords(run).some(
			({ words }) =>
				words[0]?.text === "npm" &&
				!words[0].hidden &&
				["ci", "install", "i"].includes(words[1]?.text) &&
				!words[1]?.hidden,
		);

	it("requires every no-install setup-node job to opt out", () => {
		// #5182 remainder: opt-outs land after merge, checked on first scheduled master run
		const deferredOptOutBaseline = new Set([
			"release.yml:prepare",
			"release.yml:publish-npm",
			"stale-open-issues.yml:detect",
			"tool-smoke.yml:test-history-rollup",
			"tool-smoke.yml:test-history-publish",
			"tool-smoke.yml:test-history-notify",
			"tool-smoke.yml:tool-smoke-prs",
			"tool-smoke.yml:snapshot-persist-notify",
			"stryker-nightly.yml:publish-issue",
		]);
		const offenders: string[] = [];
		let scanned = 0;
		for (const file of readdirSync(resolve(ROOT, ".github/workflows"))) {
			if (!/\.ya?ml$/.test(file)) continue;
			for (const [id, job] of Object.entries(
				jobsOf(`.github/workflows/${file}`),
			)) {
				scanned +=
					job.steps?.filter((entry) =>
						String((entry as { uses?: string }).uses).startsWith(
							"actions/setup-node@",
						),
					).length ?? 0;
				if (job.steps?.some((entry) => installs(entry.run ?? ""))) continue;
				for (const entry of job.steps ?? []) {
					const setup = entry as {
						uses?: string;
						with?: Record<string, unknown>;
					};
					if (
						setup.uses?.startsWith("actions/setup-node@") &&
						setup.with?.["package-manager-cache"] !== false
					)
						offenders.push(`${file}:${id}`);
				}
			}
		}
		assertNonEmptyScan("setup-node cache writers", scanned);
		expect(offenders.filter((key) => !deferredOptOutBaseline.has(key))).toEqual(
			[],
		);
		expect(
			[...deferredOptOutBaseline].filter((key) => !offenders.includes(key)),
		).toEqual([]);
	});

	it.each(["npm ci", "npm install --ignore-scripts", "npm i -g tool"])(
		"recognizes literal installer %s",
		(run) => expect(installs(run)).toBe(true),
	);
	it.each([
		"# npm ci",
		"echo 'npm ci'",
		"installer=npm; $installer ci",
		"alias installer='npm ci'; installer",
		"./install-dependencies.sh",
		"cat <<'EOF'\nnpm ci\nEOF",
		"command npm ci",
		"npx npm@latest ci",
	])("requires an opt-out for unknown installer %s", (run) => {
		expect(installs(run)).toBe(false);
	});
});

// #5182: retain each writer's scopes while removing workflow-wide writes.
it("scopes bot write permissions to their sole job", () => {
	for (const [file, id, permissions] of [
		[
			"close-keyword-verification",
			"verify",
			{ contents: "read", issues: "read", "pull-requests": "write" },
		],
		["greetings", "greeting", { issues: "write", "pull-requests": "write" }],
	] as const) {
		const workflow = yaml.load(
			readFileSync(resolve(ROOT, `.github/workflows/${file}.yml`), "utf8"),
		) as {
			permissions: unknown;
			jobs: Record<string, { permissions?: Record<string, string> }>;
		};
		expect(workflow.permissions).toEqual({});
		expect(workflow.jobs[id].permissions).toEqual(permissions);
	}
});

// #5182: a newer PR must never cancel a scheduled dependency scan.
it("cancels only PR runs within an event and ref concurrency group", () => {
	for (const file of ["action-pins", "osv-scan"]) {
		const workflow = yaml.load(
			readFileSync(resolve(ROOT, `.github/workflows/${file}.yml`), "utf8"),
		) as { concurrency: unknown };
		expect(workflow.concurrency).toEqual({
			group:
				"${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}",
			"cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
		});
	}
});

// Pins the CI half of the lifecycle-script policy (#1185): the pinned-npm
// `--strict-allow-scripts` installs, the `check:allow-scripts` step, and the
// release-blocking `npm-strict` packed-tarball job in install-smoke.yml.
// The checker itself is tests/scripts/check-allow-scripts.test.ts.
//
// Shell is scanned comment-blanked (a full-line `#` comment is dropped), so a
// comment that quotes `--strict-allow-scripts` or `--allow-soft` can neither
// satisfy a requirement nor trip a prohibition.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

type Step = {
	name?: string;
	run?: string;
	uses?: string;
	with?: Record<string, string>;
};
type Job = {
	if?: unknown;
	env?: Record<string, string>;
	"continue-on-error"?: unknown;
	steps?: Step[];
};
type Workflow = { jobs?: Record<string, Job> };

function load(file: string): Workflow {
	return yaml.load(
		readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8"),
	) as Workflow;
}

function code(run: string | undefined): string {
	return (run ?? "")
		.split("\n")
		.filter((line) => !line.trim().startsWith("#"))
		.join("\n");
}

function steps(workflow: Workflow, job: string): Step[] {
	const found = workflow.jobs?.[job]?.steps;
	if (!found) throw new Error(`no job ${job}`);
	return found;
}

function step(workflow: Workflow, job: string, nameFragment: string): Step {
	const found = steps(workflow, job).find((s) =>
		s.name?.includes(nameFragment),
	);
	if (!found) throw new Error(`${job}: no step named like "${nameFragment}"`);
	return found;
}

/** Every pinned-npm invocation that installs a dependency tree. */
const PINNED_INSTALL = /npx -y "npm@\$\{npm_pin\}" (?:ci|install)\b[^\n]*/g;

function pinnedInstalls(workflow: Workflow, job: string): string[] {
	return steps(workflow, job).flatMap(
		(s) => code(s.run).match(PINNED_INSTALL) ?? [],
	);
}

describe("strict lifecycle-script policy in CI installs (#1185)", () => {
	// Recurrence: #4064/#4028. A warm npm/npx cache let a nested exec skip the
	// install whose lifecycle script the strict policy was meant to inspect.
	//
	// #5112: the job left the pull_request trigger (1,410 runner minutes, 0 real
	// catches in 30 days, #3995 slice A). It keeps every other event: a master
	// push, a dispatch and the merge_group trigger, so the cold cache install
	// still runs on every commit that reaches master (after the merge; no
	// nightly schedule exists for it). A PR that
	// changes the manifests keeps a strict install through `npm-strict`, pinned
	// by the next test; this one reds if that substitute ever drops out.
	it("ci.yml has a cold-cache strict-install fast-fail on every event but a pull request", () => {
		const workflow = load("ci.yml");
		const job = workflow.jobs?.["strict-install-cold-cache"];
		expect(job, "strict-install-cold-cache").toBeDefined();
		expect(job?.if).toBe("github.event_name != 'pull_request'");
		expect(job?.["continue-on-error"]).toBeUndefined();
		// Recurrence (2026-10-07, #4067 r2): `${{ runner.temp }}` in job-level
		// `env:` made GitHub reject the whole ci.yml, so no pull_request run
		// started. The runner context exists only inside steps.
		for (const [id, j] of Object.entries(workflow.jobs ?? {}))
			expect(
				JSON.stringify((j as { env?: unknown }).env ?? {}),
				`${id} job env`,
			).not.toMatch(/\$\{\{\s*runner\./);
		const prep = steps(workflow, "strict-install-cold-cache").find((s) =>
			s.name?.includes("empty job-local npm cache"),
		);
		expect(String(prep?.run)).toMatch(/\$RUNNER_TEMP\/pi-lens-empty-npm-cache/);
		expect(String(prep?.run)).toMatch(
			/npm_config_cache=\$cache" >> "\$GITHUB_ENV"/,
		);
		const checkout = steps(workflow, "strict-install-cold-cache").find((s) =>
			s.uses?.startsWith("actions/checkout@"),
		);
		// No pull request reaches this job, so the pull-request merge ref and its
		// head sha are gone from the checkout: the event's own commit.
		expect(checkout?.with?.ref).toBe("${{ github.sha }}");
		const install = steps(workflow, "strict-install-cold-cache").find((s) =>
			s.name?.includes("cold cache"),
		);
		expect(code(install?.run)).toMatch(
			/npx -y "npm@\$\{npm_pin\}" install --strict-allow-scripts\b/,
		);
		for (const s of steps(workflow, "strict-install-cold-cache")) {
			expect(s.with?.cache, s.name).toBeUndefined();
		}
	});

	// Recurrence (#5112): the strict install left ci.yml's pull_request trigger,
	// so a PR that adds a dependency with an unreviewed lifecycle script is
	// refused only by `npm-strict`. That job is the substitute, and it is
	// reachable on a pull request only through install-smoke.yml's `paths`.
	it("a pull request that changes the manifests still reaches npm-strict (#5112)", () => {
		const on = (
			yaml.load(
				readFileSync(
					resolve(REPO_ROOT, ".github/workflows/install-smoke.yml"),
					"utf8",
				),
			) as { on: { pull_request: { paths: string[] } } }
		).on;
		expect(on.pull_request.paths).toEqual(
			expect.arrayContaining(["package.json", "package-lock.json"]),
		);
		expect(load("install-smoke.yml").jobs?.["npm-strict"]?.if).toBeUndefined();
	});

	// Recurrence: #1176. The tree installed with the runner's bundled npm, which
	// does not enforce allowScripts, so an undecided script was never refused.
	it("ci.yml installs the lint job's dependency tree through the pinned npm, strictly", () => {
		const install = step(
			load("ci.yml"),
			"lint-and-typecheck",
			"Install dependencies",
		);
		expect(code(install.run)).toMatch(
			/npx -y "npm@\$\{npm_pin\}" install --strict-allow-scripts\b/,
		);
	});

	it("ci.yml runs the policy check after the install, so the report can name the phase", () => {
		const names = steps(load("ci.yml"), "lint-and-typecheck").map(
			(s) => s.name,
		);
		const install = names.findIndex((n) =>
			n?.startsWith("Install dependencies"),
		);
		const policy = steps(load("ci.yml"), "lint-and-typecheck").findIndex(
			(s) => code(s.run).trim() === "npm run check:allow-scripts",
		);
		expect(install).toBeGreaterThanOrEqual(0);
		expect(policy).toBeGreaterThan(install);
	});

	// Recurrence: the from-source `--omit=dev` installs (the git: path) are the
	// production tree; a script landing there must be a reviewed one.
	it("ci.yml prod-install-build: every pinned-npm install is --strict-allow-scripts", () => {
		const installs = pinnedInstalls(
			load("ci.yml"),
			"prod-install-build",
		).filter((l) => / install\b/.test(l));
		expect(installs).toHaveLength(2);
		for (const line of installs) {
			expect(line, line).toContain("--strict-allow-scripts");
		}
	});
});

describe("npm-strict packed-tarball job (#1185)", () => {
	const workflow = load("install-smoke.yml");
	// Lazy, so a missing job reds each test legibly instead of aborting collection.
	const job = () => workflow.jobs?.["npm-strict"];
	const all = () =>
		steps(workflow, "npm-strict")
			.map((s) => code(s.run))
			.join("\n");

	// Recurrence: #3043's shape. A job gated off pull_request or allowed to fail
	// is not a release-blocking gate.
	it("is neither event-gated nor allowed to fail", () => {
		expect(job()?.if).toBeUndefined();
		expect(job()?.["continue-on-error"]).toBeUndefined();
		for (const s of steps(workflow, "npm-strict")) {
			expect(
				(s as { "continue-on-error"?: unknown })["continue-on-error"],
				s.name,
			).toBeUndefined();
		}
	});

	// Recurrence: the smoke npm cell installs under the runner npm with
	// `--allow-soft`, which is what let a missing required asset pass as a WARN.
	it("allows no soft path: no --allow-soft, --ignore-scripts or blanket script approval", () => {
		expect(all()).not.toMatch(/--allow-soft\b/);
		expect(all()).not.toMatch(/--ignore-scripts\b/);
		expect(all()).not.toMatch(/--dangerously-allow-all-scripts\b/);
		expect(all()).not.toMatch(/\|\|\s*(true|echo)/);
	});

	it("builds, packs and installs only through the pinned npm under strict policy", () => {
		const installs = pinnedInstalls(workflow, "npm-strict");
		// ci + pack-less: ci, the unapproved-root install, the approved-root install.
		expect(installs.filter((l) => / (ci|install)\b/.test(l))).toHaveLength(3);
		for (const line of installs.filter((l) => / (ci|install)\b/.test(l))) {
			expect(line, line).toContain("--strict-allow-scripts");
		}
		expect(all()).not.toMatch(/(^|[\s;(])npm (ci|install|pack)\b/m);
	});

	// Recurrence: a fixture that stops modelling pi's installer proves nothing
	// about `pi install npm:pi-lens`. The args mirror
	// PackageManager#getNpmInstallArgs / #ensureNpmProject in pi-coding-agent.
	it("models pi's generated install root and install arguments", () => {
		expect(all()).toContain('{"name":"pi-extensions","private":true}');
		const tarballInstalls = all()
			.split("\n")
			.filter((line) => /npm@.* install "\$TARBALL"/.test(line));
		expect(tarballInstalls).toHaveLength(2);
		for (const line of tarballInstalls) {
			expect(line, line).toContain('--prefix "$ROOT" --legacy-peer-deps');
		}
	});

	// Recurrence (#1185 review): scripts/lib/web-tree-sitter-dir.mjs became
	// load-bearing for the selftest this job runs; a PR touching only it ran no
	// npm-strict. Every path the job's selftest imports must be in the filter.
	it("runs on a change to the selftest's own helper modules", () => {
		const on = (
			workflow as unknown as { on: Record<string, { paths?: string[] }> }
		).on;
		for (const event of ["push", "pull_request"]) {
			expect(on[event]?.paths, event).toEqual(
				expect.arrayContaining([
					"scripts/install-selftest.mjs",
					"scripts/lib/web-tree-sitter-dir.mjs",
				]),
			);
		}
	});

	it("pins that pi's installer still shapes the root and args this way", () => {
		const pi = readFileSync(
			resolve(
				REPO_ROOT,
				"node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js",
			),
			"utf8",
		);
		expect(pi).toMatch(/name: "pi-extensions", private: true/);
		expect(pi).toMatch(
			/\["install", \.\.\.specs, "--prefix", installRoot, "--legacy-peer-deps"\]/,
		);
		expect(pi).not.toMatch(/allowScripts|allow-scripts/);
	});

	// Recurrence: the upstream gap. If this step were dropped nothing would
	// record that an unmodified pi root refuses @ast-grep/cli under strict npm.
	it("asserts a strict install into the unmodified root fails closed on @ast-grep/cli", () => {
		const failing = code(step(workflow, "npm-strict", "fails closed").run);
		// The grep commands themselves, not the error text that quotes them.
		expect(failing).toContain('grep -q "ESTRICTALLOWSCRIPTS" <<<"$OUT"');
		expect(failing).toContain('grep -q "@ast-grep/cli@" <<<"$OUT"');
		expect(failing).toMatch(/test "\$STATUS" -ne 0/);
		// Recurrence (#1185 review F3): `shell: bash` runs with -e, so a bare
		// `OUT="$(npm ...)"` dies on the expected failure before the greps run.
		// The capture must be `|| STATUS=$?` after an explicit `STATUS=0`.
		expect(failing).toMatch(/^STATUS=0$/m);
		expect(failing).toMatch(/OUT="\$\(.*\)" \|\| STATUS=\$\?$/m);
	});

	it("materializes the shipped approvals in the consumer root for the passing install", () => {
		const passing = code(
			step(workflow, "npm-strict", "declared approvals").run,
		);
		expect(passing).toContain("package/package.json");
		expect(passing).toContain("...shipped.allowScripts");
	});

	it("runs the selftest without soft allowances and runs the ast-grep executable", () => {
		const selftest = code(step(workflow, "npm-strict", "Selftest").run);
		expect(selftest).toContain("scripts/install-selftest.mjs");
		const exec = code(step(workflow, "npm-strict", "ast-grep executable").run);
		expect(exec).toContain('ast-grep" --version)" = "ast-grep ${pinned}"');
	});
});

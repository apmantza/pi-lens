import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { run as runChangedFiles } from "../../scripts/ci-changed-files.mjs";

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// #3801: a docs-only pull request does not start the HEAVY ADVISORY jobs
// (mutation, the Windows run) but runs every test job, a single non-docs file
// runs everything, and no REQUIRED check can be absent or skipped. This
// evaluates the real ci.yml: each job's `needs` and `if`, each gated step's
// `if`, under the outputs the real classifier script produced for a diff.
// Every case names the recurrence it keeps out.

const ROOT = path.resolve(import.meta.dirname, "../..");

type Step = { name?: string; uses?: string; if?: string; run?: string };
type Job = {
	name?: string;
	needs?: string | string[];
	if?: string;
	env?: Record<string, string>;
	strategy?: { matrix?: { os?: string[] } };
	steps?: Step[];
};
const CI = (
	yaml.load(
		fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
	) as {
		jobs: Record<string, Job>;
	}
).jobs;
const asList = (needs: Job["needs"]) =>
	Array.isArray(needs) ? needs : needs ? [needs] : [];

// ── a GitHub Actions `if:` evaluator for exactly the grammar ci.yml uses ─────
// Unknown syntax THROWS, so a new construct cannot be silently read as true.

type Ctx = {
	event: string;
	changes: { code: string; formal: string };
	results: Record<string, string>;
	outputs: Record<string, Record<string, string>>;
	matrixOs?: string;
};

function evaluate(rawExpression: string, ctx: Ctx): boolean {
	// `${{ ... }}` is optional around a job `if:` and REQUIRED when it starts with `!`.
	const expression = rawExpression
		.trim()
		.replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
	const tokens = expression.match(
		/'[^']*'|&&|\|\||==|!=|!|\(|\)|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*/g,
	);
	if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) {
		throw new Error(`unsupported if: expression: ${expression}`);
	}
	let pos = 0;
	const peek = () => tokens[pos];
	const take = () => tokens[pos++];
	const value = (token: string): string | boolean => {
		if (token.startsWith("'")) return token.slice(1, -1);
		if (token === "always()") return true;
		if (token === "cancelled()") return false;
		if (token === "github.event_name") return ctx.event;
		if (token === "matrix.os") return ctx.matrixOs ?? "";
		let match = /^needs\.([\w-]+)\.result$/.exec(token);
		if (match) return ctx.results[match[1]] ?? "skipped";
		match = /^needs\.([\w-]+)\.outputs\.(\w+)$/.exec(token);
		if (match) return ctx.outputs[match[1]]?.[match[2]] ?? "";
		if (token === "github.event.pull_request.head.repo.full_name")
			return "apmantza/pi-lens";
		if (token === "github.repository") return "apmantza/pi-lens";
		throw new Error(`unsupported context in if: ${token}`);
	};
	function primary(): string | boolean {
		const token = take();
		if (token === "(") {
			const inner = or();
			if (take() !== ")") throw new Error("unbalanced parentheses");
			return inner;
		}
		if (token === "!") return !primary();
		return value(token);
	}
	function comparison(): string | boolean {
		const left = primary();
		if (peek() === "==" || peek() === "!=") {
			const op = take();
			const right = primary();
			return op === "==" ? left === right : left !== right;
		}
		return left;
	}
	function and(): string | boolean {
		let left = comparison();
		while (peek() === "&&") {
			take();
			const right = comparison();
			left = left ? right : left;
		}
		return left;
	}
	function or(): string | boolean {
		let left = and();
		while (peek() === "||") {
			take();
			const right = and();
			left = left ? left : right;
		}
		return left;
	}
	const result = or();
	if (pos !== tokens.length)
		throw new Error(`trailing tokens in: ${expression}`);
	return Boolean(result);
}

const hasStatusFunction = (expression: string) =>
	/\b(always|cancelled|failure|success)\(\)/.test(expression);

/** Run the job graph for one event and diff; every job that runs succeeds. */
function simulate(
	event: string,
	files: string[],
	gateReady = "true",
	changesFails = false,
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-docs-skip-"));
	const output = path.join(dir, "output");
	try {
		runChangedFiles(
			["--event", event, "--repo", "apmantza/pi-lens", "--pr", "1"],
			{
				env: { GITHUB_OUTPUT: output },
				fetchFiles: () => files,
				log: () => {},
			},
		);
		const changes = (
			changesFails
				? {}
				: Object.fromEntries(
						fs
							.readFileSync(output, "utf8")
							.trim()
							.split("\n")
							.map((l) => l.split("=")),
					)
		) as { code: string; formal: string };
		const results: Record<string, string> = {
			...(changesFails ? { changes: "failure" } : {}),
		};
		const outputs: Record<string, Record<string, string>> = {
			changes,
			"heavy-gate": { ready: gateReady },
		};
		const remaining = Object.keys(CI).filter((id) => !(id in results));
		while (remaining.length) {
			const id = remaining.find((candidate) =>
				asList(CI[candidate].needs).every((need) => need in results),
			);
			if (!id) throw new Error("needs cycle");
			remaining.splice(remaining.indexOf(id), 1);
			const job = CI[id];
			const ctx: Ctx = { event, changes, results, outputs };
			let runs: boolean;
			if (job.if === undefined) {
				runs = asList(job.needs).every((need) => results[need] === "success");
			} else {
				runs =
					(hasStatusFunction(job.if)
						? true
						: asList(job.needs).every((need) => results[need] === "success")) &&
					evaluate(job.if, ctx);
			}
			results[id] = runs ? "success" : "skipped";
		}
		return { changes, results };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Which steps of a job run, per matrix leg (one leg for a plain job). */
function stepsRun(
	id: string,
	event: string,
	changes: Ctx["changes"],
	results: Ctx["results"],
) {
	const job = CI[id];
	const legs = job.strategy?.matrix?.os ?? [undefined];
	return Object.fromEntries(
		legs.map((matrixOs) => [
			matrixOs ?? "-",
			(job.steps ?? [])
				.filter(
					(step) =>
						step.if === undefined ||
						evaluate(step.if, {
							event,
							changes,
							results,
							outputs: { changes },
							matrixOs,
						}),
				)
				.map((step) => step.name ?? step.uses ?? "?"),
		]),
	);
}

// The branch-protection contexts (probed 2026-09-30) and the ci.yml job that
// produces each; knip and `oxfmt format check` come from lint.yml, which this
// change does not touch.
const REQUIRED_FROM_CI: Record<string, string> = {
	"Lint & type-check": "lint-and-typecheck",
	"Unit tests": "unit-tests",
	"Install test (ubuntu-latest)": "install-test",
	"Install test (windows-latest)": "install-test",
	"Install test (macos-latest)": "install-test",
	"TLA+ models": "tla-models",
};

const DOCS_ONLY = [
	"docs/pi-lens-fixer.md",
	"README.md",
	".changelog/3801-x.md",
];
// The jobs behind `heavy-gate`: advisory, and the only jobs a docs-only diff skips.
const HEAVY_ADVISORY = [
	"heavy-gate",
	"unit-tests-windows",
	"mutation",
	"codeql",
];
// Every test-running job: a docs edit can red these (review r1 F2), so a
// docs-only diff runs ALL of them.
const TEST_JOBS = [
	"test",
	"unit-tests",
	"install-test",
	"prod-install-build",
	"targeted-tests-advisory",
	"lint-and-typecheck",
	"tla-shards",
	"tla-models",
];

describe("#3801 docs-only pull requests skip only the heavy advisory jobs", () => {
	it("skips the heavy advisory jobs for a docs-only diff and runs every test job", () => {
		const { changes, results } = simulate("pull_request", DOCS_ONLY);
		expect(changes).toEqual({ code: "false", formal: "false" });
		for (const id of HEAVY_ADVISORY) expect(results[id], id).toBe("skipped");
		expect(results["mutation-comment"]).toBe("skipped");
		for (const id of [
			"changes",
			"dependency-boundaries",
			"changelog-fragment-fastfail",
			...TEST_JOBS,
		]) {
			expect(results[id], id).toBe("success");
		}
	});

	// Recurrence (review r1 F2): the docs-only lane skipped the Unit shards and
	// replaced them with tests/config + tests/docs, so a docs edit that reds a
	// test OUTSIDE those directories merged green. Proven red by
	// `docs/public-api-stability.md` (tests/clients/config-diagnostic-codes.test.ts)
	// and `docs/*_rules_catalog.md` (tests/scripts/rule-catalogs.test.ts).
	// The shards carry no `if:`, no `changes` need and no replacement lane exists.
	it("keeps the Unit shards on a docs-only diff: no `if`, no `changes` need, no replacement lane", () => {
		const { results } = simulate("pull_request", DOCS_ONLY);
		expect(results.test).toBe("success");
		expect(results["unit-tests"]).toBe("success");
		expect(CI.test.if).toBeUndefined();
		expect(asList(CI.test.needs)).not.toContain("changes");
		expect(asList(CI["unit-tests"].needs)).toEqual(["test"]);
		expect(
			Object.values(CI).filter((job) => job.name === "Docs governance tests"),
		).toEqual([]);
		// the aggregate is the sharded contract unchanged: only a green shard set passes
		const run = String(CI["unit-tests"].steps?.[0].run);
		expect(run).not.toContain("CODE_CHANGED");
		expect(Object.keys(CI["unit-tests"].env ?? {})).toEqual(["SHARDS_RESULT"]);
		expect(run.match(/exit 0/g)).toBeNull();
	});

	// Recurrence: the Install legs skipping their steps on docs-only. `docs/` is
	// in the published `files`, so a docs edit changes the packed tarball the
	// legs verify.
	it("runs every step of every Install test leg on a docs-only diff, as on a code diff", () => {
		const docs = simulate("pull_request", DOCS_ONLY);
		const code = simulate("pull_request", ["clients/index.ts"]);
		expect(
			stepsRun("install-test", "pull_request", docs.changes, docs.results),
		).toEqual(
			stepsRun("install-test", "pull_request", code.changes, code.results),
		);
		const total = (CI["install-test"].steps ?? []).length;
		const docsSteps = stepsRun(
			"install-test",
			"pull_request",
			docs.changes,
			docs.results,
		);
		expect(docsSteps["ubuntu-latest"]).toHaveLength(total - 1); // the macOS-only APFS step
		expect(docsSteps["macos-latest"]).toHaveLength(total);
	});

	// Recurrence: one non-docs file in an otherwise docs diff (the allowlist is
	// strict: agent contracts, workflows, formal/, scripts and tests are code).
	it.each([
		[".claude/agents/pi-lens-fixer.md"],
		[".github/workflows/ci.yml"],
		["formal/file-locks/FileLock.tla"],
		["scripts/ci-verdict.mjs"],
		["tests/config/a.test.ts"],
		["skills/pi-lens/SKILL.md"],
	])("runs everything when %s joins a docs diff", (file) => {
		const { changes, results } = simulate("pull_request", [...DOCS_ONLY, file]);
		expect(changes.code).toBe("true");
		for (const id of [...HEAVY_ADVISORY, ...TEST_JOBS])
			expect(results[id], id).toBe("success");
		expect(results["mutation-comment"]).toBe("success");
	});

	// Recurrence: master and (later) merge_group losing the full suite to the
	// classifier.
	it.each(["push", "merge_group"])(
		"runs the full suite for a %s event even for a docs-only file list",
		(event) => {
			const { changes, results } = simulate(event, DOCS_ONLY);
			expect(changes).toEqual({ code: "true", formal: "true" });
			for (const id of [
				...TEST_JOBS.filter((id) => id !== "targeted-tests-advisory"),
				"heavy-gate",
				"unit-tests-windows",
			]) {
				expect(results[id], id).toBe("success");
			}
			// mutation, targeted tests and the changelog fast-fail are pull_request jobs
			for (const id of [
				"mutation",
				"codeql",
				"targeted-tests-advisory",
				"changelog-fragment-fastfail",
			]) {
				expect(results[id], id).toBe("skipped");
			}
		},
	);

	// Recurrence (AGENTS.md shape 11, and #3756's aggregate lesson): a required
	// context that does not run. GitHub reads a skipped job as passing, but
	// ci-verdict and the merge train demand a literal success, and a skipped
	// MATRIX job reports under its raw name, leaving the required names absent.
	it.each([
		["docs-only", "pull_request", DOCS_ONLY],
		["code", "pull_request", ["clients/index.ts"]],
		["formal", "pull_request", ["formal/file-locks/FileLock.tla"]],
		["push", "push", ["clients/index.ts"]],
	])(
		"runs every required ci.yml job on a %s run, so no required check is absent or skipped",
		(_label, event, files) => {
			const { results } = simulate(event, files);
			for (const [context, id] of Object.entries(REQUIRED_FROM_CI)) {
				expect(results[id], `${context} <- ${id}`).toBe("success");
			}
			expect(CI["install-test"].strategy?.matrix?.os).toEqual([
				"ubuntu-latest",
				"windows-latest",
				"macos-latest",
			]);
		},
	);

	// Recurrence: TLA+ running on every diff (8 minutes of the heaviest required
	// job), or skipping when formal/ or its checker changed.
	it("model-checks only when formal/ or what runs it changed, and always on master", () => {
		const names = (event: string, files: string[]) => {
			const sim = simulate(event, files);
			return stepsRun("tla-shards", event, sim.changes, sim.results)["-"];
		};
		expect(names("pull_request", ["clients/index.ts"])).toEqual([
			"Skip the model check (formal/ unchanged)",
		]);
		expect(names("pull_request", DOCS_ONLY)).toEqual([
			"Skip the model check (formal/ unchanged)",
		]);
		for (const files of [
			["formal/file-locks/FileLock.tla"],
			["scripts/check-tla-models.mjs"],
			[".github/workflows/ci.yml"],
		]) {
			const ran = names("pull_request", files);
			expect(ran).toContain(
				"Model-check formal/ against each config's expected verdict",
			);
			expect(ran).not.toContain("Skip the model check (formal/ unchanged)");
		}
		expect(names("push", ["clients/index.ts"])).toContain(
			"Model-check formal/ against each config's expected verdict",
		);
	});

	// Recurrence: a FAILED classification reading as docs-only or as code. The
	// heavy jobs depend on `changes`, so a failed one skips them (a visible red
	// `Changed files` row; they are advisory); the test jobs never depended on
	// it and still run. `TLA+ models` is REQUIRED and is the exception that must
	// not skip (verify r2 V1): GitHub reads a needs-skipped required check as
	// passing, so it starts anyway, and with no `formal` output its steps run the
	// FULL model check (an empty output is not 'false').
	it("never reads a failed classification as docs-only: heavy jobs skip, test jobs still run, TLA+ runs in full", () => {
		const { changes, results } = simulate(
			"pull_request",
			DOCS_ONLY,
			"true",
			true,
		);
		expect(results.changes).toBe("failure");
		for (const id of HEAVY_ADVISORY) expect(results[id], id).toBe("skipped");
		for (const id of [
			"test",
			"unit-tests",
			"install-test",
			"tla-shards",
			"tla-models",
		])
			expect(results[id], id).toBe("success");
		const steps = stepsRun("tla-shards", "pull_request", changes, results)["-"];
		expect(steps).toContain(
			"Model-check formal/ against each config's expected verdict",
		);
		expect(steps).not.toContain("Skip the model check (formal/ unchanged)");
	});

	// Recurrence: a new job gated on `changes` without being a heavy advisory or
	// TLA+ shard job would reintroduce a docs-only skip of tests. The aggregate
	// depends on the shards, not on classification; it always judges their result.
	it("lets only tla-shards and heavy-gate depend on `changes`", () => {
		const dependents = Object.entries(CI)
			.filter(
				([id, job]) =>
					id !== "changes" && asList(job.needs).includes("changes"),
			)
			.map(([id]) => id)
			.sort(byCodeUnit);
		expect(dependents).toEqual(["heavy-gate", "tla-shards"]);
		expect(CI["heavy-gate"].if).toBe("needs.changes.outputs.code == 'true'");
	});
});

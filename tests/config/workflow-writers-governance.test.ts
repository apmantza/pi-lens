// #4053: a branch workflow_dispatch run must not write shared issues, branches,
// releases, registries, labels or other GitHub state. This census prevents the
// compat/install tracking-issue recurrence, the stale/labels/stale-open-issues
// near misses the round-1 review found, and the #4038 literal-path bug.
//
// Writers are found three ways, all from the PARSED workflow (never a regex
// over the YAML text): a mutating command spelling in a step's `run:` (comments
// blanked), a writer action in a step's `uses:`, and a registered writer
// SCRIPT named in a `run:`. The script registry is itself checked against a
// grep of `scripts/`, and the set of actions a dispatchable workflow uses is
// closed by a registered-or-fail classification, so a new writer cannot hide
// behind a name this file's author did not think of.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	dispatchableJobs,
	guardOf,
	hasWriteToken,
	WRITE_SCOPES,
	workflowDocument,
	workflowTriggers,
} from "../../scripts/dispatch-safety.mjs";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

type Step = {
	name?: unknown;
	if?: unknown;
	run?: unknown;
	uses?: unknown;
	with?: unknown;
};
type Job = {
	if?: unknown;
	uses?: unknown;
	with?: unknown;
	permissions?: unknown;
	steps?: Step[];
};
type Workflow = {
	on?: unknown;
	permissions?: unknown;
	jobs?: Record<string, Job>;
};

function load(source: string): Workflow {
	return workflowDocument(source) as Workflow;
}

// <impl>
// ── `run:` text ─────────────────────────────────────────────────────────────

// Shell comments are not executable evidence. Keep quoted # characters so a
// command such as `echo "#"` remains code, and open a comment only at a word
// start so `$#` and `${#x}` cannot hide the rest of the line. A prose mention
// can neither admit a writer nor hide one from this census.
function withoutShellComments(source: string): string {
	return source
		.split("\n")
		.map((line) => {
			let quote: "'" | '"' | undefined;
			for (let i = 0; i < line.length; i += 1) {
				const char = line[i];
				if (char === "\\") {
					i += 1;
					continue;
				}
				if ((char === "'" || char === '"') && (!quote || quote === char)) {
					quote = quote ? undefined : char;
					continue;
				}
				if (char === "#" && !quote && (i === 0 || /\s/.test(line[i - 1])))
					return line.slice(0, i);
			}
			return line;
		})
		.join("\n");
}

const PACKAGE_SCRIPTS = (
	JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	}
).scripts;

// `npm run <name>` hides a script behind package.json: append the script body
// so the writer scan sees the command it runs (one level; no workflow nests).
function expandNpmRuns(run: string): string {
	const bodies = [...run.matchAll(/\b(?:npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g)]
		.map((m) => PACKAGE_SCRIPTS[m[1]])
		.filter((body): body is string => typeof body === "string");
	return [run, ...bodies].join("\n");
}

function runText(run: string): string {
	return expandNpmRuns(withoutShellComments(run)).replace(/\\\n\s*/g, " ");
}

// One shell command: stops at a newline, `;`, `|` or `&`.
const CMD = String.raw`[^\n;|&]*?`;
const GH_NOUNS =
	"issue|pr|label|release|workflow|run|cache|repo|secret|variable|gist|project|ruleset";
const GH_VERBS =
	"create|edit|comment|close|reopen|lock|unlock|merge|delete|upload|run|rerun|cancel|enable|disable|set|ready|review|update-branch|transfer|pin|unpin|archive|rename|fork|sync|delete-asset|add|remove";
const GH_WRITE = new RegExp(
	String.raw`\bgh\b${CMD}\s(${GH_NOUNS})\s+(${GH_VERBS})(?![\w-])`,
	"g",
);
export const GIT_PUSH =
	/\bgit(?:\s+(?:-[cC]\s+(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\])+|--[\w-]+(?:=(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\])+)?))*\s+push\b/;
const PKG_PUBLISH = new RegExp(
	String.raw`\b(?:npm|pnpm|yarn|bun|npx)\b(${CMD})\bpublish(?![\w:-])([^\n;|&]*)`,
	"g",
);
const METHOD = /(?:^|\s)(?:-X|--method|--request)(?:\s+|=)?['"]?([A-Za-z]+)/;
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// `gh api` and `curl` default to GET and become a POST implicitly when a body
// flag is present, so the method alone is not enough.
function mutatingHttp(run: string, command: "gh api" | "curl"): boolean {
	const head = command === "gh api" ? String.raw`gh\s+api` : "curl";
	const bodyFlag =
		command === "gh api"
			? /(?:^|\s)(?:-[fF]|--field|--raw-field|--input)\b/
			: /(?:^|\s)(?:-d|--data(?:-[a-z]+)?|-F|--form(?:-string)?|-T|--upload-file|--json)\b/;
	for (const m of run.matchAll(
		new RegExp(String.raw`\b${head}\b([^\n;|&]*)`, "g"),
	)) {
		const method = METHOD.exec(m[1])?.[1]?.toUpperCase();
		if (method !== undefined) {
			if (!READ_ONLY_METHODS.has(method)) return true;
		} else if (bodyFlag.test(m[1])) return true;
	}
	return false;
}

// Each entry reports the writer kinds it finds in one step's `run:` text.
const RUN_WRITERS: Array<(run: string) => string[]> = [
	(run) => [...run.matchAll(GH_WRITE)].map((m) => `gh ${m[1]} ${m[2]}`),
	(run) => (mutatingHttp(run, "gh api") ? ["mutating gh api"] : []),
	(run) => (mutatingHttp(run, "curl") ? ["mutating curl"] : []),
	(run) => (GIT_PUSH.test(run) ? ["git push"] : []),
	(run) =>
		[...run.matchAll(PKG_PUBLISH)].some(
			(m) => !/--dry-run(?!=(?:false|0)\b)/.test(`${m[1]}${m[2]}`),
		)
			? ["package publish"]
			: [],
];

// ── registered writer scripts ───────────────────────────────────────────────

// Every file under scripts/ that writes GitHub state itself or imports a file
// that does. The registry is audited against a grep of scripts/ below, so a
// new writer script (or an old one that stops writing) fails there instead of
// silently falling out of the workflow census.
const SCRIPT_WRITERS: Record<string, string> = {
	"scripts/backfill-github-releases.mjs": "gh release edit",
	"scripts/backfill-release-thanks.mjs": "gh release edit",
	"scripts/check-close-keywords.mjs": "gh pr comment (close verification)",
	"scripts/ci-verdict.mjs": "gh api -X POST (run approval)",
	"scripts/classify-ci-failure.mjs": "PR label/comment/run writes (library)",
	"scripts/detect-stale-open-issues.mjs": "issue comment POST/PATCH",
	"scripts/lib/ci-failure-classifier.mjs": "PR label/comment/run writes",
	"scripts/lib/drift-issue.mjs": "gh issue create/edit/comment/close",
	"scripts/notify-clean-signal-drift.mjs": "tracking issue",
	"scripts/notify-install-smoke-drift.mjs": "tracking issue",
	"scripts/notify-tool-smoke-red.mjs": "gh issue create/edit/close",
	"scripts/upsert-tracking-issue.mjs": "tracking issue",
};

// Files the script grep flags that do not write GitHub state.
const SCRIPT_NON_WRITERS: Record<string, string> = {
	"scripts/capture-runner-fixtures.mjs":
		"the `-f` is yamllint's format flag in a captured-fixture argv",
	"scripts/hooks/guard-bash.mjs":
		"the hook parses git subcommands (`push`) to deny them; it runs none",
	"scripts/lib/workflow-run-evidence.mjs":
		"`gh workflow run` appears only in a remediation message it prints",
	"scripts/npm-retry.mjs":
		"imports only NET_PATTERN (a regex) from the classifier; it runs npm",
	"scripts/release-qa.mjs": "its only `publish` is `npm publish --dry-run`",
};

const SCRIPT_WRITER_BASENAMES = new Set(
	Object.keys(SCRIPT_WRITERS).map((file) => basename(file)),
);

function scriptWriters(run: string): string[] {
	return [...run.matchAll(/[\w.-]+\.(?:mjs|cjs|js|ts)\b/g)]
		.map((m) => m[0])
		.filter((file) => SCRIPT_WRITER_BASENAMES.has(file))
		.map((file) => `script ${file}`);
}

// ── writer actions ──────────────────────────────────────────────────────────

// A trailing slash is a prefix (every action under that owner/repo).
const WRITER_ACTIONS = [
	"actions/create-release",
	"actions/deploy-pages",
	"actions/first-interaction",
	"actions/github-script",
	"actions/labeler",
	"actions/stale",
	"actions/upload-release-asset",
	"crazy-max/ghaction-github-labeler",
	"endbug/add-and-commit",
	"endbug/label-sync",
	"github/codeql-action/upload-sarif",
	"jamesives/github-pages-deploy-action",
	"js-devtools/npm-publish",
	"micnncim/action-label-syncer",
	"ncipollo/release-action",
	"peter-evans/",
	"pypa/gh-action-pypi-publish",
	"slackapi/slack-github-action",
	"softprops/action-gh-release",
	"stefanzweifel/git-auto-commit-action",
];

// Actions with no shared-state write: toolchain setup, caches and artifacts
// (scoped to the run or the ref, not shared across refs), CodeQL's analysis
// upload (a per-ref result), and linters. A new action not in either list
// reds `classifies every action` so its author decides.
const READER_ACTIONS = [
	"actions/cache",
	"actions/checkout",
	"actions/download-artifact",
	"actions/setup-java",
	"actions/setup-node",
	"actions/setup-python",
	"actions/upload-artifact",
	"crate-ci/typos",
	"dart-lang/setup-dart",
	"erlef/setup-beam",
	"github/codeql-action/analyze",
	"github/codeql-action/init",
	"mlugg/setup-zig",
	"oven-sh/setup-bun",
	"pnpm/action-setup",
	"ruby/setup-ruby",
	"shivammathur/setup-php",
];

function actionName(uses: unknown): string | undefined {
	return typeof uses === "string"
		? uses.split("@")[0].toLowerCase()
		: undefined;
}

function matchesAction(name: string, list: readonly string[]): boolean {
	return list.some((entry) =>
		entry.endsWith("/") ? name.startsWith(entry) : name === entry,
	);
}

// A job-level `uses:` is a reusable workflow: its steps are invisible here.
function isReusableWorkflow(uses: unknown): boolean {
	return typeof uses === "string" && /(^|\/)\.github\/workflows\//.test(uses);
}

// ── census ──────────────────────────────────────────────────────────────────

interface WriterRecord {
	id: string;
	kinds: string[];
	guard: ReturnType<typeof guardOf>;
}

function stepKinds(step: Step): string[] {
	const kinds: string[] = [];
	if (typeof step.run === "string") {
		const run = runText(step.run);
		for (const detect of RUN_WRITERS) kinds.push(...detect(run));
		kinds.push(...scriptWriters(run));
	}
	const action = actionName(step.uses);
	if (action !== undefined && matchesAction(action, WRITER_ACTIONS))
		kinds.push(`action ${action}`);
	return [...new Set(kinds)];
}

function stepLabel(step: Step, index: number): string {
	return typeof step.name === "string" ? step.name : `step ${index}`;
}

/** Every writer step (and writer job) of a dispatchable workflow. */
function workflowWriters(source: string, workflowPath: string): WriterRecord[] {
	const workflow = load(source);
	if (!workflowTriggers(workflow.on).includes("workflow_dispatch")) return [];
	const records: WriterRecord[] = [];
	for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
		if (isReusableWorkflow(job.uses))
			records.push({
				id: `${workflowPath}:${jobName}`,
				kinds: ["reusable workflow"],
				guard: guardOf(job.if),
			});
		for (const [index, step] of (job.steps ?? []).entries()) {
			const kinds = stepKinds(step);
			if (kinds.length === 0) continue;
			records.push({
				id: `${workflowPath}:${jobName}/${stepLabel(step, index)}`,
				kinds,
				guard: guardOf(job.if, step.if),
			});
		}
	}
	return records;
}

function writerFindings(source: string, workflowPath: string): string[] {
	return workflowWriters(source, workflowPath).flatMap(
		({ id, kinds, guard }) =>
			guard.guarded
				? []
				: kinds.map((kind) => `${id}: ${kind} ${guard.reason}`),
	);
}

function writeScopedJobFindings(
	source: string,
	workflowPath: string,
): string[] {
	return dispatchableJobs(source, workflowPath)
		.filter((job) => hasWriteToken(job))
		.filter((job) => !guardOf(job.job.if).guarded)
		.map((job) => `${job.id}: write scopes ${job.writeScopes.join(", ")}`);
}

/** Actions a dispatchable workflow uses that no list classifies. */
function unclassifiedActions(source: string, workflowPath: string): string[] {
	const workflow = load(source);
	if (!workflowTriggers(workflow.on).includes("workflow_dispatch")) return [];
	return Object.entries(workflow.jobs ?? {}).flatMap(([jobName, job]) =>
		(job.steps ?? []).flatMap((step) => {
			const action = actionName(step.uses);
			if (
				action === undefined ||
				action.startsWith("./") ||
				matchesAction(action, WRITER_ACTIONS) ||
				matchesAction(action, READER_ACTIONS)
			)
				return [];
			return [`${workflowPath}:${jobName}: unclassified action ${action}`];
		}),
	);
}

// ── `with:` shell variables ─────────────────────────────────────────────────

// Action inputs are never shell-expanded (#4038 round 4). `${{ … }}` is blanked
// first so `format('$X')` is not a hit, `\$` is an escaped literal, and a
// braced variable may carry an expansion operator (`${VAR:-d}`).
const SHELL_VARIABLE =
	/(?<!\\)\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[!#]?[A-Za-z_][A-Za-z0-9_]*[}:#%/^,@+=?-]|\([^)]*\))/;

function* inputStrings(
	value: unknown,
	key: string,
): Generator<[string, string]> {
	if (typeof value === "string") yield [key, value];
	else if (Array.isArray(value))
		for (const item of value) yield* inputStrings(item, key);
	else if (value && typeof value === "object")
		for (const [k, v] of Object.entries(value))
			yield* inputStrings(v, `${key}.${k}`);
}

function withVariableFindings(source: string, workflowPath: string): string[] {
	const workflow = load(source);
	const findings: string[] = [];
	const scan = (label: string, input: unknown, skipScript: boolean) => {
		for (const [key, value] of Object.entries(
			input && typeof input === "object" ? input : {},
		)) {
			// `actions/github-script`'s `script` is JavaScript, where `${name}` is a
			// template literal, not a shell variable.
			if (skipScript && key === "script") continue;
			for (const [path, text] of inputStrings(value, key)) {
				if (SHELL_VARIABLE.test(text.replace(/\$\{\{[\s\S]*?\}\}/g, "")))
					findings.push(
						`${workflowPath}:${label}: with.${path} uses shell variable`,
					);
			}
		}
	};
	for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
		scan(jobName, job.with, false);
		for (const [index, step] of (job.steps ?? []).entries())
			scan(
				`${jobName}/${stepLabel(step, index)}`,
				step.with,
				actionName(step.uses) === "actions/github-script",
			);
	}
	return findings;
}
// </impl>

// ── registered exceptions ───────────────────────────────────────────────────

// A dispatchable writer that is deliberately NOT guarded. Each entry must still
// be flagged (a stale entry reds) and carries its reason.
// Empty since the merge-train warden's retirement (#4105): its entry was the
// only one.
const REGISTERED_EXCEPTIONS: Record<string, string> = {};

// The census as counts: dispatchable workflows, and writer steps per workflow.
// A new writer (even a guarded one) or a new dispatchable workflow reds here so
// its author reviews the guard; the failure prints the re-pin.
const DISPATCHABLE_WORKFLOWS = 14;
// #4077: the split moved every writer step into its own job without adding one,
// except codeql.yml, whose SARIF upload moved into the `upload` job as the
// `github/codeql-action/upload-sarif` writer action (+1).
const WRITER_STEPS: Record<string, number> = {
	".github/workflows/codeql.yml": 1,
	".github/workflows/compat-smoke.yml": 1,
	".github/workflows/install-smoke.yml": 1,
	".github/workflows/labels.yml": 1,
	".github/workflows/release.yml": 3,
	".github/workflows/stale-open-issues.yml": 1,
	".github/workflows/stale.yml": 1,
	".github/workflows/stryker-nightly.yml": 1,
	".github/workflows/tool-smoke.yml": 9,
};

// Every dispatchable job that holds a write scope, with the scopes it holds.
// #4077: each is a small guarded writer (or a registered exception) that takes
// its producer's result through an artifact or job output, so the job that runs
// branch code holds none. A new write scope, a widened scope, or a write scope
// back on a producer reds here with the re-pin printed; the unguarded direction
// also reds `guards every dispatchable job with an effective write token`.
const WRITE_SCOPED_JOBS: Record<string, string> = {
	".github/workflows/codeql.yml:upload": "security-events",
	".github/workflows/compat-smoke.yml:compat-smoke-alert": "issues",
	".github/workflows/install-smoke.yml:host-latest-notify": "issues",
	".github/workflows/labels.yml:sync": "issues",
	".github/workflows/release.yml:publish-npm": "id-token",
	".github/workflows/release.yml:release": "contents",
	".github/workflows/stale-open-issues.yml:detect": "issues",
	".github/workflows/stale.yml:stale": "issues, pull-requests",
	".github/workflows/stryker-nightly.yml:publish-issue": "issues",
	".github/workflows/tool-smoke.yml:snapshot-persist-notify": "issues",
	".github/workflows/tool-smoke.yml:test-history-notify": "issues",
	".github/workflows/tool-smoke.yml:test-history-publish": "contents",
	".github/workflows/tool-smoke.yml:tool-smoke-notify": "issues",
	".github/workflows/tool-smoke.yml:tool-smoke-prs": "contents, pull-requests",
};

function workflowFiles(): string[] {
	const files = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));
	assertNonEmptyScan(
		"workflow files walked for writer governance",
		files.length,
		10,
	);
	return files.sort();
}

function readWorkflow(file: string): { source: string; path: string } {
	return {
		source: readFileSync(resolve(WORKFLOWS, file), "utf8"),
		path: `.github/workflows/${file}`,
	};
}

// ── fixtures ────────────────────────────────────────────────────────────────

const GUARD_SRC =
	"github.event_name == 'schedule' || github.ref == 'refs/heads/master'";

function workflowWith(options: {
	on?: string;
	jobIf?: string;
	stepIf?: string;
	run?: string;
	uses?: string;
	jobUses?: string;
	permissions?: string;
	jobPermissions?: string;
}): string {
	const indent = (text: string, n: number) =>
		text
			.split("\n")
			.map((line) => " ".repeat(n) + line)
			.join("\n");
	const step = [
		options.run === undefined ? "" : `run: |\n${indent(options.run, 2)}`,
		options.uses === undefined ? "" : `uses: ${options.uses}`,
		options.stepIf === undefined ? "" : `if: ${JSON.stringify(options.stepIf)}`,
	]
		.filter(Boolean)
		.join("\n");
	return [
		options.on ?? "on: workflow_dispatch",
		options.permissions === undefined
			? ""
			: `permissions: ${options.permissions}`,
		"jobs:",
		"  fixture:",
		options.jobIf === undefined
			? ""
			: `    if: ${JSON.stringify(options.jobIf)}`,
		options.jobPermissions === undefined
			? ""
			: `    permissions: ${options.jobPermissions}`,
		options.jobUses === undefined ? "" : `    uses: ${options.jobUses}`,
		options.jobUses === undefined
			? `    steps:\n      - name: Writer\n${indent(step, 8)}`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

const flag = (options: Parameters<typeof workflowWith>[0]) =>
	writerFindings(workflowWith(options), "fixture.yml");

// #4053 r1 probe set: every spelling the round-1 review found SILENT, plus the
// spellings the first census already caught. Each is a mutating command that a
// branch dispatch must not run unguarded.
const WRITER_RUNS: Array<[string, string]> = [
	["gh issue create", 'gh issue create --title "x"'],
	["gh issue comment", "gh issue comment 1 --body x"],
	["gh issue reopen", "gh issue reopen 1"],
	["gh issue lock", "gh issue lock 1"],
	["gh pr comment", "gh pr comment 1 --body x"],
	["gh pr create", "gh pr create --fill"],
	["gh pr merge", "gh pr merge 1 --squash"],
	["gh pr edit", "gh pr edit 1 --add-label x"],
	["gh pr close", "gh pr close 1"],
	["gh with global flags", "gh -R owner/repo pr comment 1 --body x"],
	["gh across a continuation", "gh \\\n  pr merge 1"],
	["gh label create", "gh label create x"],
	["gh label edit", "gh label edit x --color fff"],
	["gh release create", "gh release create v1"],
	["gh release upload", "gh release upload v1 a.zip"],
	["gh repo edit", "gh repo edit --description x"],
	["gh workflow run", "gh workflow run ci.yml --ref master"],
	["gh cache delete", "gh cache delete --all"],
	["gh run rerun", "gh run rerun 1"],
	["gh api -X POST", "gh api -X POST repos/o/r/issues -f title=x"],
	["gh api --method POST", "gh api --method POST repos/o/r/issues"],
	["gh api --method=PATCH", "gh api --method=PATCH repos/o/r/issues/1"],
	["gh api -XDELETE", "gh api -XDELETE repos/o/r/issues/1/labels/x"],
	["gh api --method after the path", "gh api repos/o/r/issues --method POST"],
	["gh api implicit POST via -f", "gh api repos/o/r/issues -f title=x"],
	["gh api implicit POST via -F", "gh api repos/o/r/issues -F n=1"],
	["gh api implicit POST via --field", "gh api repos/o/r/issues --field a=b"],
	["git push", "git push origin HEAD:data"],
	["git -c ... push", "git -c credential.helper= push origin x"],
	[
		"git -c quoted helper push",
		"git -c credential.helper='!gh auth git-credential' push origin x",
	],
	["git -C push", 'git -C "$DIR" push'],
	["git across a continuation", "git \\\n  push origin x"],
	["npm publish", "npm publish --provenance"],
	["pnpm publish", "pnpm publish"],
	["npx npm publish", "npx -y npm@11 publish --access public"],
	["npm publish --dry-run=false", "npm publish --dry-run=false"],
	["curl -X POST", "curl -X POST https://api.github.com/repos/o/r/issues"],
	["curl --request DELETE", "curl --request DELETE https://x.test/a"],
	["curl implicit POST via -d", "curl -d @body.json https://x.test/a"],
	[
		"curl implicit POST via --data-binary",
		"curl --data-binary @a https://x.test/a",
	],
	["writer after $#", "echo $# ; gh issue create --title x"],
	["writer after a quoted #", 'echo "a # b" ; gh issue create --title x'],
	["writer after a mid-word #", "echo a#b ; gh pr merge 1"],
	["script via node scripts/", "node scripts/notify-install-smoke-drift.mjs"],
	[
		"script via node ./scripts/",
		"node ./scripts/upsert-tracking-issue.mjs --x",
	],
	["script via cd scripts", "cd scripts && node upsert-tracking-issue.mjs"],
	[
		"script via a variable path",
		'cli="$RUNNER_TEMP/history-scripts/upsert-tracking-issue.mjs"\nnode "$cli"',
	],
	["script via lib path", "node scripts/lib/drift-issue.mjs"],
	[
		"script detect-stale-open-issues",
		"node scripts/detect-stale-open-issues.mjs",
	],
	["script via npm run", "npm run release:backfill-thanks -- --apply"],
];

const NON_WRITER_RUNS: Array<[string, string]> = [
	["gh pr view", "gh pr view 1 --json state"],
	["gh issue list", "gh issue list --label x"],
	["gh label list", "gh label list --limit 100"],
	["gh run view", "gh run view 1"],
	["gh api GET", "gh api repos/o/r/issues"],
	["gh api -X GET with -f", "gh api -X GET repos/o/r/issues -f state=open"],
	["gh api --jq only", "gh api repos/o/r --jq .name"],
	["git status", "git status"],
	["git fetch", "git fetch --tags origin"],
	["git config push.default", "git config push.default simple"],
	["npm publish --dry-run", "npm publish --dry-run --provenance"],
	["npm run publish-docs", "npm run publish-docs"],
	["npm test", "npm test"],
	["curl GET", "curl -fsSL https://example.test/a"],
	["curl -X GET", "curl -X GET https://example.test/a"],
	["comment only", "# gh issue create is documented here\necho ok"],
	["trailing comment", "echo ok # gh pr merge 1"],
	["unrelated script", "node scripts/smoke-tools.mjs"],
];

const WRITER_ACTION_FIXTURES = [
	"actions/stale@4391f3da665fdf50b6810c1a66712fb9ba21aa93",
	"micnncim/action-label-syncer@3abd5ab72fda571e69fffd97bd4e0033dd5f495c",
	"peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1",
	"peter-evans/create-or-update-comment@v4",
	"actions/github-script@v7",
	"softprops/action-gh-release@v2",
	"ncipollo/release-action@v1",
	"actions/labeler@v5",
	"slackapi/slack-github-action@v2",
];

describe("workflow writer governance (#4053)", () => {
	describe("effective permission resolution (#4065)", () => {
		// Recurrence: #4076 review r2, L3. These are spellings the text census
		// cannot see (a variable git, a variable method, wget, python, a node
		// fetch, npm dist-tag, a shell script, a script it does not register).
		// Each row runs the SAME text three ways: the text census stays silent, the
		// permission census reds the unguarded write-scoped job, and the same text
		// is clean as a read-only job or behind the guard. The finding keys on the
		// token, never on the spelling, so a spelling nobody listed cannot hide.
		it.each([
			["variable git push", "$GIT push origin HEAD"],
			["variable gh method", 'gh api -X "$M" repos/o/r/issues'],
			["wget post", "wget --post-data=x https://example.test"],
			["python requests", "python -c 'requests.post(url)'"],
			["node fetch", "node -e 'fetch(url, { method: \"POST\" })'"],
			["npm dist-tag", "npm dist-tag add pkg latest"],
			["shell writer", "scripts/publish.sh"],
			["two-hop re-export", "node scripts/zz-a.mjs"],
		])("catches silent spelling by permission: %s", (_name, run) => {
			const unguarded = workflowWith({
				run,
				jobPermissions: "{ contents: write }",
			});
			expect(flag({ run }), "the text census is silent on this run").toEqual(
				[],
			);
			expect(writeScopedJobFindings(unguarded, "fixture.yml")).toEqual([
				"fixture.yml:fixture: write scopes contents",
			]);
			expect(
				writeScopedJobFindings(
					workflowWith({ run, jobPermissions: "{ contents: read }" }),
					"fixture.yml",
				),
			).toEqual([]);
			expect(
				writeScopedJobFindings(
					workflowWith({
						run,
						jobPermissions: "{ contents: write }",
						jobIf: GUARD_SRC,
					}),
					"fixture.yml",
				),
			).toEqual([]);
		});

		const ALL_SCOPES = [...WRITE_SCOPES].sort();
		it.each([
			[
				"job overrides workflow",
				"{ issues: read }",
				"{ issues: write }",
				["issues"],
			],
			[
				"workflow overrides repository default",
				"{ issues: read }",
				undefined,
				[],
			],
			// Recurrence: #4076 review r2, L2. The repository's Actions setting is
			// `default_workflow_permissions: read` (`gh api
			// repos/apmantza/pi-lens/actions/permissions/workflow`), so a workflow
			// with no `permissions:` holds no write scope; the old row pinned a
			// write-all assumption the repository does not have.
			["repository default holds no write scope", undefined, undefined, []],
			["empty job permissions deny inherited writes", "write-all", "{}", []],
			// Recurrence: #4076 review r2, L1. These three GitHub permission names
			// were missing from WRITE_SCOPES, so a workflow-level grant resolved to
			// no write scope and the census stayed silent.
			["attestations", "{ attestations: write }", undefined, ["attestations"]],
			["models", "{ models: write }", undefined, ["models"]],
			[
				"artifact-metadata",
				"{ artifact-metadata: write }",
				undefined,
				["artifact-metadata"],
			],
			// L1: an empty `permissions:` parses to null and is "not set", so it
			// falls to the next level instead of resolving to a token-less job.
			[
				"null job permissions fall to the workflow",
				"write-all",
				"null",
				ALL_SCOPES,
			],
			[
				"null workflow permissions fall to the repository default",
				"null",
				undefined,
				[],
			],
			// L1: a shape GitHub rejects resolves to the worst case, never to none.
			["a list as job permissions", undefined, "[contents]", ALL_SCOPES],
			[
				"an unknown word as workflow permissions",
				"everything",
				undefined,
				ALL_SCOPES,
			],
		])("resolves %s", (_name, permissions, jobPermissions, expected) => {
			const jobs = dispatchableJobs(
				workflowWith({ run: "echo ok", permissions, jobPermissions }),
				"fixture.yml",
			);
			expect(jobs[0]?.writeScopes).toEqual(expected);
		});

		it("requires the job guard even when the writer spelling is unknown", () => {
			const source = workflowWith({
				run: "python -c 'requests.post(url)'",
				jobPermissions: "{ issues: write }",
			});
			const jobs = dispatchableJobs(source, "fixture.yml");
			expect(hasWriteToken(jobs[0])).toBe(true);
			expect(writeScopedJobFindings(source, "fixture.yml")).toEqual([
				"fixture.yml:fixture: write scopes issues",
			]);
		});
	});

	// #4077: GitHub permissions are job-scoped, so the way to let a branch
	// dispatch run a smoke is a read-only job plus a small guarded writer that
	// `needs:` it. These fixtures are that shape, and each rejection is the
	// regression that undoes it.
	describe("read-only producer plus guarded writer (#4077)", () => {
		const split = (options: {
			smokePermissions?: string;
			writerIf?: string;
			writerStepIf?: string;
		}) =>
			[
				"on: workflow_dispatch",
				"jobs:",
				"  smoke:",
				`    permissions: ${options.smokePermissions ?? "{ contents: read }"}`,
				"    steps:",
				"      - run: node scripts/smoke.mjs",
				"  writer:",
				"    needs: smoke",
				options.writerIf === undefined
					? ""
					: `    if: ${JSON.stringify(options.writerIf)}`,
				"    permissions: { issues: write }",
				"    steps:",
				options.writerStepIf === undefined
					? "      - run: node scripts/upsert-tracking-issue.mjs"
					: `      - if: ${JSON.stringify(options.writerStepIf)}\n        run: node scripts/upsert-tracking-issue.mjs`,
			]
				.filter(Boolean)
				.join("\n");

		it("accepts a read-only smoke and a job-guarded writer", () => {
			expect(
				writeScopedJobFindings(split({ writerIf: GUARD_SRC }), "fixture.yml"),
			).toEqual([]);
			expect(
				writeScopedJobFindings(
					split({ writerIf: `always() && (${GUARD_SRC})` }),
					"fixture.yml",
				),
			).toEqual([]);
		});

		// Recurrence: the pre-split compat-smoke shape, one job holding the write
		// token with only the writer STEP guarded.
		it("rejects a writer whose guard is only on its step", () => {
			expect(
				writeScopedJobFindings(
					split({ writerStepIf: GUARD_SRC }),
					"fixture.yml",
				),
			).toEqual(["fixture.yml:writer: write scopes issues"]);
		});

		it("rejects a writer with no guard or a spoofed one", () => {
			for (const writerIf of [undefined, `always() || (${GUARD_SRC})`])
				expect(
					writeScopedJobFindings(split({ writerIf }), "fixture.yml"),
				).toEqual(["fixture.yml:writer: write scopes issues"]);
		});

		// Recurrence: a write scope creeping back onto the job that runs branch
		// code, even with the writer correctly guarded beside it.
		it("rejects a write scope on the producer", () => {
			expect(
				writeScopedJobFindings(
					split({
						writerIf: GUARD_SRC,
						smokePermissions: "{ contents: read, issues: write }",
					}),
					"fixture.yml",
				),
			).toEqual(["fixture.yml:smoke: write scopes issues"]);
		});
	});

	describe("`on:` forms", () => {
		// Recurrence: round 1 read `on` with hasOwnProperty, so the string and
		// array forms made a dispatchable workflow look non-dispatchable and
		// exempt.
		it.each([
			["string", "on: workflow_dispatch"],
			["flow array", "on: [push, workflow_dispatch]"],
			["block array", "on:\n  - push\n  - workflow_dispatch"],
			["map", "on:\n  push:\n  workflow_dispatch:"],
			[
				"map with inputs",
				"on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: string",
			],
			["empty-map value", "on:\n  workflow_dispatch: {}"],
		])("treats the %s form as dispatchable", (_name, on) => {
			expect(flag({ on, run: "gh issue create --title x" })).toHaveLength(1);
		});

		it.each([
			["string", "on: push"],
			["array", "on: [push, pull_request]"],
			["map", "on:\n  schedule:\n    - cron: '0 0 * * *'"],
		])("does not census a non-dispatchable %s workflow", (_name, on) => {
			expect(flag({ on, run: "gh issue create --title x" })).toEqual([]);
		});
	});

	describe("writer commands in run:", () => {
		// flake-shape: elapsed-time-assertion — CodeQL alerts 60 and 61 found exponential
		// backtracking when the quoted -c alternatives overlap with `\S`; only a
		// real clock can distinguish the fixed regex from the vulnerable one.
		it("rejects the adversarial git-push input without backtracking", () => {
			const adversarial = `git -c ${'""'.repeat(24)}x`;
			const startedAt = performance.now();
			expect(GIT_PUSH.test(adversarial)).toBe(false);
			expect(performance.now() - startedAt).toBeLessThan(50);
		});

		it("detects escaped quotes in git option values", () => {
			expect(GIT_PUSH.test('git -c a=\\"b push')).toBe(true);
			expect(GIT_PUSH.test('git -c "a\\" b" push')).toBe(true);
		});

		it("rejects escaped-quote repeats without backtracking", () => {
			const adversarial = `git -c ${'\\"'.repeat(24)}x`;
			const startedAt = performance.now();
			expect(GIT_PUSH.test(adversarial)).toBe(false);
			expect(performance.now() - startedAt).toBeLessThan(50);
		});

		it("keeps quoted git options in the writer census", () => {
			expect(GIT_PUSH.test('git -c "a b" push')).toBe(true);
			expect(GIT_PUSH.test("git -c 'x=y' push")).toBe(true);
			expect(GIT_PUSH.test("git --git-dir=/x push")).toBe(true);
		});

		// Recurrence: round 1 probed all of these SILENT against the shipped
		// census, which matched only seven spellings.
		it.each(WRITER_RUNS)("flags %s", (_name, run) => {
			expect(flag({ run })).not.toEqual([]);
		});

		it.each(NON_WRITER_RUNS)("does not flag %s", (_name, run) => {
			expect(flag({ run })).toEqual([]);
		});

		it("names the kind of every writer in one step", () => {
			expect(
				flag({ run: "gh pr comment 1 --body x\ngit push origin x" }),
			).toEqual([
				"fixture.yml:fixture/Writer: gh pr comment lacks ref guard",
				"fixture.yml:fixture/Writer: git push lacks ref guard",
			]);
		});
	});

	describe("writer actions in uses:", () => {
		// Recurrence: round 1, stale.yml / labels.yml were invisible because the
		// census read only `run:`.
		it.each(WRITER_ACTION_FIXTURES)("flags %s", (uses) => {
			expect(flag({ uses })).toHaveLength(1);
		});

		it("flags a reusable workflow job it cannot see inside", () => {
			expect(flag({ jobUses: "./.github/workflows/publish.yml" })).toHaveLength(
				1,
			);
			expect(
				flag({
					jobUses: "o/r/.github/workflows/p.yml@main",
					jobIf: GUARD_SRC,
				}),
			).toEqual([]);
		});

		it("does not flag a reader action", () => {
			expect(
				flag({
					uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
				}),
			).toEqual([]);
		});

		it("rejects an action no list classifies", () => {
			// Recurrence: a census keyed on names only holds the names its author
			// remembered; an unlisted action must force a writer/reader decision.
			expect(
				unclassifiedActions(
					workflowWith({ uses: "acme/mystery-deploy@v1" }),
					"fixture.yml",
				),
			).toEqual([
				"fixture.yml:fixture: unclassified action acme/mystery-deploy",
			]);
			expect(
				unclassifiedActions(
					workflowWith({ uses: "actions/stale@v9" }),
					"fixture.yml",
				),
			).toEqual([]);
			expect(
				unclassifiedActions(
					workflowWith({ on: "on: push", uses: "acme/mystery-deploy@v1" }),
					"fixture.yml",
				),
			).toEqual([]);
		});
	});

	describe("the ref guard", () => {
		// Recurrence: round 1 accepted `always() || (guard)` (the guard text was a
		// substring), so a branch dispatch still reached the writer.
		const run = "gh issue create --title x";
		it.each([
			["the exact guard", GUARD_SRC],
			["a parenthesised conjunct", `always() && (${GUARD_SRC}) && x == 'y'`],
			["a trailing conjunct", `x == 'y' && (${GUARD_SRC})`],
			["a wrapped expression", `\${{ !cancelled() && (${GUARD_SRC}) }}`],
			["schedule alone", "github.event_name == 'schedule'"],
			["master alone", "github.ref == 'refs/heads/master'"],
			[
				"reversed operands",
				"'schedule' == github.event_name || 'refs/heads/master' == github.ref",
			],
			[
				"reversed disjuncts",
				"github.ref == 'refs/heads/master' || github.event_name == 'schedule'",
			],
			["nested conjunction", `(a == 'b' && (${GUARD_SRC})) && c == 'd'`],
		])("accepts %s as a step guard", (_name, stepIf) => {
			expect(flag({ run, stepIf })).toEqual([]);
		});

		it.each([
			["always() || guard", `always() || (${GUARD_SRC})`],
			["input || guard", `inputs.force || (${GUARD_SRC})`],
			["!(guard)", `!(${GUARD_SRC})`],
			["guard || always()", `(${GUARD_SRC}) || always()`],
			["guard || other", `${GUARD_SRC} || inputs.x`],
			["precedence: a && b || guard", `a && b || ${GUARD_SRC}`],
			["a negated schedule", "github.event_name != 'schedule'"],
			["workflow_dispatch", "github.event_name == 'workflow_dispatch'"],
			["a different branch", "github.ref == 'refs/heads/main'"],
			["ref_name", "github.ref_name == 'master'"],
			["double quotes", `github.ref == "refs/heads/master"`],
			["always() alone", "always()"],
			["a constant", "true"],
		])("rejects %s", (_name, stepIf) => {
			expect(flag({ run, stepIf })).toHaveLength(1);
		});

		it("flags an unparseable if instead of trusting it", () => {
			expect(flag({ run, stepIf: "github.ref == 'unterminated" })).toEqual([
				expect.stringContaining("unparseable if"),
			]);
		});

		it("takes the guard from the job or the step", () => {
			expect(flag({ run, jobIf: GUARD_SRC })).toEqual([]);
			expect(flag({ run, jobIf: "always() || x", stepIf: GUARD_SRC })).toEqual(
				[],
			);
			expect(flag({ run, jobIf: GUARD_SRC, stepIf: "always()" })).toEqual([]);
			expect(flag({ run, jobIf: "always()", stepIf: "always()" })).toHaveLength(
				1,
			);
		});
	});

	describe("with: shell variables", () => {
		const wrap = (withBlock: string, uses = "actions/upload-artifact@v1") =>
			`jobs:\n  fixture:\n    steps:\n      - name: Input\n        uses: ${uses}\n        with:\n${withBlock}`;
		const hits = (withBlock: string, uses?: string) =>
			withVariableFindings(wrap(withBlock, uses), "fixture.yml");

		// Recurrence: #4038 round 4 shipped a literal "$RUNNER_TEMP/..." path
		// that no action expands.
		it.each([
			["a bare variable", '          path: "$RUNNER_TEMP/r.json"'],
			["a braced variable", '          path: "${RUNNER_TEMP}/r.json"'],
			["an expansion operator", '          path: "${DIR:-fallback}/r.json"'],
			[
				"a variable next to an expression",
				'          path: "${{ runner.temp }}/$HOME"',
			],
			[
				"a block scalar",
				"          path: |\n            a\n            $HOME/b",
			],
			["a list value", "          path: ['a', '$HOME']"],
			["a nested map", "          path:\n            dir: $HOME/x"],
		])("flags %s", (_name, block) => {
			expect(hits(block)).toHaveLength(1);
		});

		it.each([
			["an expression", '          path: "${{ runner.temp }}/r.json"'],
			[
				"a dollar-quoted expression argument",
				`          path: "\${{ format('$X') }}"`,
			],
			["an escaped dollar", "          path: '\\$HOME'"],
			[
				"a trailing comment",
				"          path: r.json # $RUNNER_TEMP is a comment",
			],
			["a regex anchor", '          path: "^foo$"'],
			["a price", '          path: "cost $5"'],
		])("accepts %s", (_name, block) => {
			expect(hits(block)).toEqual([]);
		});

		it.each([
			["length expansion", '          path: "${#PATH}"'],
			["indirect expansion", '          path: "${!PATH}"'],
			["command substitution", '          path: "$(pwd)/x"'],
		])("flags shell expansion: %s", (_name, block) => {
			expect(hits(block)).toHaveLength(1);
		});

		it("does not read github-script's JavaScript template literals as shell", () => {
			const script = "          script: |\n            core.info(`${name}`)";
			expect(hits(script, "actions/github-script@v7")).toEqual([]);
			expect(hits(script)).toHaveLength(1);
		});

		it("scans a job-level with:", () => {
			expect(
				withVariableFindings(
					"jobs:\n  fixture:\n    uses: ./.github/workflows/x.yml\n    with:\n      dir: $HOME/x\n",
					"fixture.yml",
				),
			).toEqual(["fixture.yml:fixture: with.dir uses shell variable"]);
		});

		it("names the offending input", () => {
			expect(hits('          path: "$RUNNER_TEMP/report.json"')).toEqual([
				"fixture.yml:fixture/Input: with.path uses shell variable",
			]);
		});
	});

	describe("the real workflows", () => {
		const real = () => workflowFiles().map(readWorkflow);

		it("guards every dispatchable writer, bar the registered exceptions", () => {
			const writers = real().flatMap(({ source, path }) =>
				workflowWriters(source, path),
			);
			const unguarded = writers
				.filter((record) => !record.guard.guarded)
				.map((record) => record.id);
			// No exception is registered since #4105, so a clean tree flags 0: the
			// floor moves from "matched something" to "walked the writers" (the
			// detector itself is pinned by the fixture rows above).
			const audit = auditRegistry({
				sweepName: "unguarded dispatchable writers",
				flagged: unguarded,
				registered: [],
				exemptions: REGISTERED_EXCEPTIONS,
				minReasonLength: 30,
				minFlagged: 0,
				scannedCount: writers.length,
				minScanned: 10,
			});
			expect(audit.problems).toEqual([]);
		});

		it("guards every dispatchable job with an effective write token", () => {
			const unguarded = real().flatMap(({ source, path }) =>
				writeScopedJobFindings(source, path),
			);
			const writeScoped = real().flatMap(({ source, path }) =>
				dispatchableJobs(source, path).filter(hasWriteToken),
			);
			const audit = auditRegistry({
				sweepName: "unguarded write-scoped dispatchable jobs",
				flagged: unguarded,
				registered: [],
				exemptions: REGISTERED_EXCEPTIONS,
				minReasonLength: 30,
				minFlagged: 0,
				scannedCount: writeScoped.length,
				minScanned: 10,
			});
			expect(audit.problems).toEqual([]);
		});

		// Recurrence: #4077, a write scope back on a job that runs branch code (the
		// guard census above catches it only when the job is also unguarded), or a
		// writer quietly widened (`contents: write` beside `issues: write`).
		it("pins every write-scoped dispatchable job and the scopes it holds", () => {
			const actual: Record<string, string> = {};
			for (const { source, path } of real())
				for (const job of dispatchableJobs(source, path))
					if (hasWriteToken(job)) actual[job.id] = job.writeScopes.join(", ");
			expect(
				actual,
				`re-pin to:\nconst WRITE_SCOPED_JOBS = ${JSON.stringify(actual, null, "\t")};`,
			).toEqual(WRITE_SCOPED_JOBS);
		});

		it("pins the census", () => {
			const writers: Record<string, number> = {};
			let dispatchable = 0;
			for (const { source, path } of real()) {
				if (workflowTriggers(load(source).on).includes("workflow_dispatch"))
					dispatchable += 1;
				const count = workflowWriters(source, path).length;
				if (count > 0) writers[path] = count;
			}
			expect(
				{ dispatchable, writers },
				`re-pin to:\nconst DISPATCHABLE_WORKFLOWS = ${dispatchable};\nconst WRITER_STEPS = ${JSON.stringify(writers, null, "\t")};`,
			).toEqual({
				dispatchable: DISPATCHABLE_WORKFLOWS,
				writers: WRITER_STEPS,
			});
		});

		it("classifies every action a dispatchable workflow uses", () => {
			expect(
				real().flatMap(({ source, path }) => unclassifiedActions(source, path)),
			).toEqual([]);
		});

		it("rejects a shell variable in a real action input", () => {
			expect(
				real().flatMap(({ source, path }) =>
					withVariableFindings(source, path),
				),
			).toEqual([]);
		});
	});

	describe("the writer-script registry", () => {
		const scriptsRoot = resolve(ROOT, "scripts");
		const files = listSourceFiles(scriptsRoot, {
			extensions: [".mjs", ".cjs", ".js", ".ts"],
		});
		const rel = (file: string) => `scripts/${relativePosix(scriptsRoot, file)}`;

		// String literals are the evidence here (`"POST"`, `["issue", "edit"]`),
		// so comments are blanked and string contents kept.
		const MARKERS: RegExp[] = [
			/\bupsertTrackingIssue\b/,
			/["'`](?:POST|PATCH|PUT|DELETE)["'`]/,
			/["'](?:issue|pr|label|release|workflow|run|cache|repo|secret|variable)["']\s*,\s*["'](?:create|edit|comment|close|reopen|lock|merge|upload|delete|rerun|cancel|enable|disable|set|ready|review|update-branch)["']/,
			/["'](?:-X|--method|--field|--raw-field|-f|-F|push|publish)["']/,
			/\bgh\s+(?:issue|pr|label|release|workflow|cache|repo)\s+(?:create|edit|comment|close|reopen|lock|merge|upload|delete|run|rerun|cancel)\b/,
			/\bgh\s+api\s+-X\s+(?:POST|PATCH|PUT|DELETE)\b/,
		];

		function importsOf(file: string, source: string): string[] {
			return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) =>
				rel(resolve(dirname(file), m[1])),
			);
		}

		// A script a workflow runs that directly imports a registered writer writes
		// through it, whether or not its own text carries a marker (a thin
		// workflow entry over a registered lib is the case this catches).
		function detectedWriters(): string[] {
			const sources = new Map(
				files.map((file) => [
					rel(file),
					{
						file,
						source: stripSource(readFileSync(file, "utf8"), {
							strings: "keep",
						}),
					},
				]),
			);
			const direct = [...sources]
				.filter(([, { source }]) =>
					MARKERS.some((marker) => marker.test(source)),
				)
				.map(([path]) => path);
			const invokedText = workflowFiles()
				.map((file) => {
					const workflow = load(readWorkflow(file).source);
					return Object.values(workflow.jobs ?? {})
						.flatMap((job) => job.steps ?? [])
						.map((step) => (typeof step.run === "string" ? step.run : ""))
						.join("\n");
				})
				.join("\n");
			const invoked = [...sources.keys()].filter((path) =>
				new RegExp(`(?<![\\w.-])${basename(path).replaceAll(".", "\\.")}`).test(
					invokedText,
				),
			);
			const importsWriter = (path: string): boolean => {
				const entry = sources.get(path);
				return (
					entry !== undefined &&
					importsOf(entry.file, entry.source).some(
						(dep) => dep in SCRIPT_WRITERS,
					)
				);
			};
			return [...new Set([...direct, ...invoked.filter(importsWriter)])];
		}

		it("registers every script that writes GitHub state", () => {
			const flagged = detectedWriters();
			const audit = auditRegistry({
				sweepName: "writer scripts",
				flagged,
				registered: Object.keys(SCRIPT_WRITERS),
				exemptions: SCRIPT_NON_WRITERS,
				minScanned: 50,
				scannedCount: files.length,
				minFlagged: 10,
				remediation:
					"add the file to SCRIPT_WRITERS (it writes) or SCRIPT_NON_WRITERS with a reason",
			});
			expect(audit.problems).toEqual([]);
			// Registered-but-undetected is a stale claim the kit tolerates for other
			// registries; here the registry IS the detector's output.
			expect(
				Object.keys(SCRIPT_WRITERS).filter((path) => !flagged.includes(path)),
			).toEqual([]);
		});
	});
});

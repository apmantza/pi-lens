// Recurrence #5409 (2026-11-08): GitHub's release-download endpoint returned an
// intermittent `504 Gateway Time-out` for about an hour. Four CI steps fetched a
// pinned release on every run with `curl -sLO` and no `--fail` and no cache, so
// the 504 page was saved as the archive and failed its sha256 check. The lint
// jobs on #5396, #5398, #5406 and #5407 and master's TLA+ shards 3 and 4 (run
// 42465697187) went red with "checksum did NOT match", not "HTTP 504". Every
// release download now goes through one helper, `.github/actions/fetch-verified`.
//
// The gate reads the PARSED workflows, so a comment that quotes a download can
// neither satisfy nor trip it. It fails closed (review r1 F2, #5415): a
// `releases/download` string it cannot place under a helper call with a literal
// url and sha256 is a violation, and so is ANY network fetch in a `run:` block
// or an `env:` value (a fetcher command word or a `://` literal) that is not a
// named admission with a reason. The first cut matched one URL spelling and
// passed 6 of 7 planted downloads.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workflowDocument } from "../../scripts/dispatch-safety.mjs";
import { TLA_TOOLS } from "../../scripts/check-tla-models.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const GITHUB = resolve(ROOT, ".github");
const WORKFLOWS = resolve(GITHUB, "workflows");
const ACTIONS = resolve(GITHUB, "actions");
const HELPER_USES = "./.github/actions/fetch-verified";
const HELPER_FILE = join(ACTIONS, "fetch-verified/action.yml");
const HELPER_INPUTS = ["path", "sha256", "tool", "url", "version"];
const RELEASE_NEEDLE = /releases\/|githubusercontent\.com/i;
const RELEASE_URL =
	/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.+-]+\/[\w.+-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_PARTS = ["inputs.tool", "inputs.version", "inputs.sha256"];
const ACTION_SHA_PIN = /^actions\/cache\/(restore|save)@[0-9a-f]{40}\b/;

type Step = {
	name?: unknown;
	env?: Record<string, unknown>;
	uses?: unknown;
	run?: unknown;
	if?: unknown;
	with?: Record<string, unknown>;
};
type Document = {
	env?: Record<string, unknown>;
	jobs?: Record<string, { env?: Record<string, unknown>; steps?: Step[] }>;
	runs?: { using?: unknown; steps?: Step[] };
};
type Leaf = { path: Array<string | number>; value: string };

/** Every string leaf of a parsed YAML tree, with the path that reaches it. */
function stringLeaves(
	node: unknown,
	path: Array<string | number> = [],
): Leaf[] {
	if (typeof node === "string") return [{ path, value: node }];
	if (Array.isArray(node))
		return node.flatMap((item, index) => stringLeaves(item, [...path, index]));
	if (node && typeof node === "object")
		return Object.entries(node).flatMap(([key, value]) =>
			stringLeaves(value, [...path, key]),
		);
	return [];
}

/**
 * A release-asset string (`releases/`, `githubusercontent.com`) that is not
 * the `url` of a helper call's `with` block is a violation: a bare `curl`, a computed URL in a `run:`
 * block, or any other spelling the gate cannot place.
 */
export function releaseDownloadViolations(
	file: string,
	source: string,
): string[] {
	const doc = workflowDocument(source) as Document;
	const violations: string[] = [];
	for (const { path, value } of stringLeaves(doc)) {
		if (!RELEASE_NEEDLE.test(value)) continue;
		const where = `${file}: ${path.join(".")}`;
		const [root, job, steps, index, block, field] = path;
		const isHelperUrl =
			root === "jobs" &&
			steps === "steps" &&
			block === "with" &&
			field === "url" &&
			path.length === 6 &&
			doc.jobs?.[String(job)]?.steps?.[Number(index)]?.uses === HELPER_USES;
		if (!isHelperUrl)
			violations.push(
				`${where}: release asset string outside a ${HELPER_USES} call`,
			);
		else if (!RELEASE_URL.test(value))
			violations.push(
				`${where}: url is not a literal github.com release asset`,
			);
	}
	return violations;
}

/**
 * Every helper call must pass exactly its five inputs, the url and sha256 as
 * literals (an expression the gate cannot read counts as a hit), and a
 * non-empty tool, version and path.
 */
export function helperCallViolations(file: string, source: string): string[] {
	const doc = workflowDocument(source) as Document;
	const violations: string[] = [];
	for (const [job, body] of Object.entries(doc.jobs ?? {})) {
		for (const [index, step] of (body.steps ?? []).entries()) {
			if (step.uses !== HELPER_USES) continue;
			const where = `${file}: jobs.${job}.steps[${index}]`;
			const w = step.with ?? {};
			if (
				JSON.stringify(Object.keys(w).sort()) !== JSON.stringify(HELPER_INPUTS)
			)
				violations.push(
					`${where}: with must be exactly ${HELPER_INPUTS.join(", ")}`,
				);
			if (typeof w.url !== "string" || !RELEASE_URL.test(w.url))
				violations.push(
					`${where}: url must be a literal github.com release URL`,
				);
			if (typeof w.sha256 !== "string" || !SHA256.test(w.sha256))
				violations.push(`${where}: sha256 must be a literal 64-hex digest`);
			for (const name of ["tool", "version"])
				if (typeof w[name] !== "string" || !/^[\w.+-]+$/.test(w[name]))
					violations.push(`${where}: ${name} must be a literal token`);
			if (typeof w.path !== "string" || w.path.trim() === "")
				violations.push(`${where}: path must name the output file`);
		}
	}
	return violations;
}

/**
 * The named admissions: a network fetch in a `run:` block or an `env:` value
 * that is allowed to stay. The key is `file::job::step` (`job` is `action` for
 * a composite action, `workflow` for workflow-level `env`), the value is why.
 * Each is a registration, not a silencing: a new fetch fails until someone
 * writes its reason here, and a key no step hits any more fails as stale.
 */
const ADMITTED_FETCHES: Record<string, string> = {
	".github/actions/fetch-verified/action.yml::action::Verify the file, downloading it on a cache miss":
		"the helper's own download: helperShapeViolations pins --fail, retries, the sha256 check before mv, and the rm of a rejected file",
	".github/workflows/install-smoke.yml::pi-load::Install pi (${{ matrix.pi_install }})":
		"the curl matrix cell tests pi's own unpinned install.sh from pi.dev; there is no digest to pin, and it is not a GitHub release asset",
	".github/workflows/install-smoke.yml::host-range-smoke::Classify newest-in-range failure (PR regression vs upstream drift)":
		"gh api reads this run's job conclusions for a verdict; no file is downloaded or executed",
	".github/workflows/compat-smoke.yml::compat-smoke-alert::Alert on contract drift or infra failure (create-or-update tracking issue)":
		"https://github.com/... appears only as markdown link text in an issue body; nothing is fetched",
	".github/workflows/tool-smoke.yml::tool-smoke::Install jdtls 1.63.0 for the cascade layer":
		"digest-pinned best-effort download from download.eclipse.org; the helper takes github.com release assets only, and this step must stay continue-on-error with its own digest error",
	".github/workflows/ci-infra-kill-rerun.yml::classify::env.PR_NUMBER":
		"a ${{ }} expression that compares a github.com API url with startsWith; nothing is fetched",
	".github/workflows/ci-infra-kill-rerun.yml::finalize-rerun::env.PR_NUMBER":
		"a ${{ }} expression that compares a github.com API url with startsWith; nothing is fetched",
};

// A fetcher command word, or `gh` with a download or api subcommand. Matched
// case-insensitively (PowerShell) after quotes, backslashes, backticks and
// carets are dropped, so `cu""rl` and `Invoke-Web`Request` read as the command.
const FETCHER =
	/(?<![\w.-])(?:curl|wget|aria2c|invoke-webrequest|invoke-restmethod|iwr|irm)(?![\w-])|\bgh\b[^;|&\n]*\b(?:download|api)\b/i;
// Any URL scheme separator. A URL that reaches a fetcher this list does not
// name (node -e fetch, python urlopen, a future CLI) still carries it, and a
// scheme built from a variable (`${s}://`) does too.
const URL_LITERAL = /:\/\//;

function shellCode(script: string): string {
	return script
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n")
		.replace(/['"\\`^]/g, "");
}

function whyFetch(text: string): string | null {
	const code = shellCode(text);
	if (FETCHER.test(code)) return "fetcher command";
	if (URL_LITERAL.test(code)) return "URL literal";
	return null;
}

/** Every run block and env value in a workflow or composite action. */
export function fetchSites(
	file: string,
	source: string,
): Array<{ key: string; why: string }> {
	const doc = workflowDocument(source) as Document;
	const sites: Array<{ key: string; why: string }> = [];
	const addEnv = (scope: string, env: Record<string, unknown> | undefined) => {
		for (const [name, value] of Object.entries(env ?? {}))
			// Unlike a run block, an env value is not shell: a `$` or `${{ }}`
			// is data until a run block uses it, so only a literal or an
			// expression carrying `://` is a hit here.
			if (typeof value === "string" && URL_LITERAL.test(value))
				sites.push({
					key: `${file}::${scope}::env.${name}`,
					why: "URL literal",
				});
	};
	const addStep = (job: string, step: Step, index: number) => {
		const name = typeof step.name === "string" ? step.name : `steps[${index}]`;
		addEnv(`${job}::${name}`, step.env);
		const why = typeof step.run === "string" ? whyFetch(step.run) : null;
		if (why) sites.push({ key: `${file}::${job}::${name}`, why });
	};
	addEnv("workflow", doc.env);
	for (const [job, body] of Object.entries(doc.jobs ?? {})) {
		addEnv(job, body.env);
		for (const [index, step] of (body.steps ?? []).entries())
			addStep(job, step, index);
	}
	for (const [index, step] of (doc.runs?.steps ?? []).entries())
		addStep("action", step, index);
	return sites;
}

/** A fetch site with no admission, or two steps sharing one admitted key. */
export function fetchViolations(
	file: string,
	source: string,
	admitted: Record<string, string> = ADMITTED_FETCHES,
): string[] {
	const seen = new Map<string, number>();
	const violations: string[] = [];
	for (const { key, why } of fetchSites(file, source)) {
		seen.set(key, (seen.get(key) ?? 0) + 1);
		if (!(key in admitted))
			violations.push(
				`${key}: ${why} is not a helper call or a named admission`,
			);
	}
	for (const [key, count] of seen)
		if (count > 1 && key in admitted)
			violations.push(`${key}: ${count} steps share one admitted key`);
	return violations;
}

/** Shell text without its `#` comment lines, so prose cannot satisfy a check. */
function codeLines(script: string): string {
	return script
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

/**
 * The helper's own shape: a composite action that restores a cache keyed on
 * its tool, version and sha256, downloads with `--fail` and retries, verifies
 * the sha256 before the file moves into place, and saves only after a download.
 */
export function helperShapeViolations(source: string): string[] {
	const doc = workflowDocument(source) as Document;
	const violations: string[] = [];
	const steps = doc.runs?.steps ?? [];
	if (doc.runs?.using !== "composite")
		violations.push("runs.using must be composite");
	const keyOf = (step: Step) =>
		String(step.with?.key ?? "").replace(/\s+/g, "");
	const cacheStep = (name: "restore" | "save") =>
		steps.find(
			(step) =>
				typeof step.uses === "string" &&
				ACTION_SHA_PIN.test(step.uses) &&
				step.uses.startsWith(`actions/cache/${name}@`),
		);
	const restore = cacheStep("restore");
	const save = cacheStep("save");
	// Review r1 F4: each component is asserted, in both keys, so dropping the
	// tool or the version (two pins sharing a digest) reds, not only the digest.
	const keyViolations = (name: string, step: Step) =>
		KEY_PARTS.filter((part) => !keyOf(step).includes(part)).map(
			(part) => `${name} key is not keyed on ${part}`,
		);
	if (!restore)
		violations.push("no actions/cache/restore step pinned by full sha");
	else violations.push(...keyViolations("restore", restore));
	if (!save) violations.push("no actions/cache/save step pinned by full sha");
	else {
		violations.push(...keyViolations("save", save));
		if (!String(save.if ?? "").includes("downloaded"))
			violations.push("save must run only after a verified download");
	}
	const fetch = steps.find(
		(step) => typeof step.run === "string" && step.run.includes("curl"),
	);
	if (typeof fetch?.run !== "string") {
		violations.push("no curl download step");
		return violations;
	}
	const script = codeLines(fetch.run);
	if (!/curl --fail\b/.test(script))
		violations.push("curl must run with --fail");
	if (!/--retry 5 --retry-all-errors\b/.test(script))
		violations.push("curl must retry (--retry 5 --retry-all-errors)");
	if (!/sha256sum -c -/.test(script) || !/shasum -a 256 -c -/.test(script))
		violations.push("the sha256 check must cover sha256sum and shasum");
	if (!/rm -f "\$DEST"/.test(script))
		violations.push(
			"a rejected cache file must be deleted before the download",
		);
	if (/\|\|\s*true\b/.test(script) || /--status/.test(script))
		violations.push("the sha256 check must not be able to pass on a mismatch");
	const verify = script.indexOf('verify "$tmp"');
	const move = script.indexOf('mv "$tmp" "$DEST"');
	if (verify < 0 || move < 0 || verify > move)
		violations.push("the download must be verified before it moves into place");
	return violations;
}

/** Every `*.yml` and `*.yaml` under `root`, at any depth, as a repo path. */
function yamlSources(
	root: string,
	label: string,
): Array<{ file: string; source: string }> {
	return (readdirSync(root, { recursive: true }) as string[])
		.map((rel) => rel.split("\\").join("/"))
		.filter((rel) => /\.ya?ml$/.test(rel) && statSync(join(root, rel)).isFile())
		.sort()
		.map((rel) => ({
			file: `${label}/${rel}`,
			source: readFileSync(join(root, rel), "utf8"),
		}));
}

const workflowSources = () => yamlSources(WORKFLOWS, ".github/workflows");
const githubSources = () => yamlSources(GITHUB, ".github");

function helperCalls(): Array<{ file: string; job: string; step: Step }> {
	const calls: Array<{ file: string; job: string; step: Step }> = [];
	for (const { file, source } of workflowSources()) {
		const doc = workflowDocument(source) as Document;
		for (const [job, body] of Object.entries(doc.jobs ?? {}))
			for (const step of body.steps ?? [])
				if (step.uses === HELPER_USES) calls.push({ file, job, step });
	}
	return calls;
}

// ---------------------------------------------------------------------------
// #5420 (2026-11-08, same outage): the two fetch paths the helper does not
// cover. `oven-sh/setup-bun` downloaded bun from a GitHub release (and listed
// the tags through the GitHub API to resolve `latest`) with no retry we
// control; `pi-load bun-global` went red at "Setup bun". And no workflow set
// an npm fetch-retry, so a registry 5xx redded `npm ci` the same way. Two more
// reads of the parsed workflows, in this file so the CI-fetch gates stay one:
//   1. every workflow that reaches the npm registry sets the retry env once,
//      at its top level (population derived from the run blocks and actions);
//   2. every `uses:` is a local action that exists or has a recorded verdict.
// ---------------------------------------------------------------------------

/** Floors for the workflow-level npm retry env (npm's defaults are 2 and 60000). */
const NPM_RETRY_FLOORS: Record<string, number> = {
	npm_config_fetch_retries: 3,
	npm_config_fetch_retry_maxtimeout: 60000,
};
// A package-manager command word anywhere in the shell text (a path prefix, a
// quoted spelling or an `echo` mention over-reports, which only adds the env).
const REGISTRY_CLIENT =
	/(?<![\w.-])(?:npm|npx|pnpm|pnpx|yarn|bun|bunx|corepack)(?![\w-])/i;
const KNOWN_SHELLS = new Set(["bash", "sh", "pwsh", "powershell"]);
const LOCAL_ACTION = /^\.\/\.github\/actions\/[\w.-]+(?:\/[\w.-]+)*$/;

/**
 * The recorded verdict per `uses:` action, key `owner/repo[/path]` without its
 * ref. Every verdict is a registration: a new action fails until its line says
 * whether it downloads from GitHub releases, and a key nothing uses any more
 * fails as stale. `registry` marks an action that itself installs from the npm
 * registry, so a workflow using it owes the retry env. The setup-python,
 * setup-java and setup-ruby verdicts are #5420's third acceptance box; the log
 * lines are run 42481123229 (tool-smoke, ubuntu-latest, 2026-11-08).
 */
const ACTION_VERDICTS: Record<string, { registry?: true; why: string }> = {
	"actions/checkout": {
		why: "git over https from github.com; no release asset is downloaded",
	},
	"actions/cache": {
		why: "reads and writes the Actions cache service; no release asset is downloaded",
	},
	"actions/cache/restore": {
		why: "reads the Actions cache service; no release asset is downloaded",
	},
	"actions/cache/save": {
		why: "writes the Actions cache service; no release asset is downloaded",
	},
	"actions/upload-artifact": {
		why: "writes the Actions artifact service; no release asset is downloaded",
	},
	"actions/download-artifact": {
		why: "reads the Actions artifact service; no release asset is downloaded",
	},
	"actions/create-github-app-token": {
		why: "calls the GitHub API for a token; no release asset is downloaded",
	},
	"actions/first-interaction": {
		why: "calls the GitHub API to post a comment; no release asset is downloaded",
	},
	"actions/stale": {
		why: "calls the GitHub API to label and close; no release asset is downloaded",
	},
	"peter-evans/create-pull-request": {
		why: "runs git and the GitHub API; no release asset is downloaded",
	},
	"micnncim/action-label-syncer": {
		why: "calls the GitHub API to sync labels; no release asset is downloaded",
	},
	"github/codeql-action/upload-sarif": {
		why: "uploads to the code-scanning API; no release asset is downloaded",
	},
	"github/codeql-action/init": {
		why: "selects and downloads its own CodeQL bundle (hosted toolcache first); we do not control its fetch, so it is a p3 residual of #5420",
	},
	"github/codeql-action/analyze": {
		why: "runs the bundle init selected and uploads results; downloads no release asset itself",
	},
	"actions/setup-node": {
		why: "hosted toolcache covers node 22 (run 42532399145: 'Found in cache @ /opt/hostedtoolcache/node/22.23.4'); a miss reads actions/node-versions on github.com, a p3 residual of #5420",
	},
	"actions/setup-python": {
		why: "toolcache covers it: all four sites ask for 3.12 on ubuntu-latest and run 42481123229 logged 'Successfully set up CPython (3.12.16)' in 0.1 s with no download; a miss reads the actions/python-versions mirror",
	},
	"actions/setup-java": {
		why: "toolcache covers it: run 42481123229 logged 'Resolved Java 25.0.5+8 from tool-cache' and JAVA_HOME_21_X64 under hostedtoolcache; both tool-smoke sites are continue-on-error",
	},
	"ruby/setup-ruby": {
		why: "toolcache covers it: run 42481123229 put ruby 3.3.13 on PATH from /opt/hostedtoolcache in 0.2 s; its one site (tool-smoke) is continue-on-error",
	},
	"erlef/setup-beam": {
		why: "downloads OTP and Elixir from builds.hex.pm and gleam from github.com releases, unretried by us; both sites (tool-smoke, install-smoke) are continue-on-error, so an outage degrades the lane and does not red it",
	},
	"shivammathur/setup-php": {
		why: "installs php from the runner's apt or the ondrej PPA, not a GitHub release asset; its one site is continue-on-error",
	},
	"mlugg/setup-zig": {
		why: "downloads zig from the ziglang.org mirror list, not a GitHub release asset; its one site is continue-on-error",
	},
	"dart-lang/setup-dart": {
		why: "downloads the Dart SDK from storage.googleapis.com, not a GitHub release asset; its one site is continue-on-error",
	},
	"crate-ci/typos": {
		why: "its entrypoint downloads the typos binary from a GitHub release with no retry we control; the only site is the lint-advisory job, which is continue-on-error and not a required check (p3 residual of #5420)",
	},
	"pnpm/action-setup": {
		registry: true,
		why: "bootstraps pnpm from the npm registry, so the using workflow owes the npm retry env",
	},
};

type UsesSite = { where: string; uses: string; job: boolean };

/** Every `uses:` in a workflow (job-level reusable workflows too) or composite action. */
function usesSites(file: string, source: string): UsesSite[] {
	const doc = workflowDocument(source) as Document;
	const sites: UsesSite[] = [];
	const addSteps = (scope: string, steps: Step[] | undefined) => {
		for (const [index, step] of (steps ?? []).entries())
			if (step.uses !== undefined)
				sites.push({
					where: `${file}: ${scope}.steps[${index}]`,
					uses: String(step.uses),
					job: false,
				});
	};
	for (const [job, body] of Object.entries(doc.jobs ?? {})) {
		const reusable = (body as { uses?: unknown }).uses;
		if (reusable !== undefined)
			sites.push({
				where: `${file}: jobs.${job}`,
				uses: String(reusable),
				job: true,
			});
		addSteps(`jobs.${job}`, body.steps);
	}
	addSteps("runs", doc.runs?.steps);
	return sites;
}

const actionKey = (uses: string) => uses.split("@")[0];

/**
 * A `uses:` with no recorded verdict is a violation. Fail closed: a reusable
 * workflow, a docker:// reference, a local path that does not resolve to an
 * action file, and a remote action missing from `verdicts` all count.
 */
export function actionVerdictViolations(
	file: string,
	source: string,
	localExists: (usesPath: string) => boolean,
	verdicts: Record<string, { registry?: true; why: string }> = ACTION_VERDICTS,
): string[] {
	const violations: string[] = [];
	for (const { where, uses, job } of usesSites(file, source)) {
		if (job)
			violations.push(
				`${where}: reusable workflow ${uses} cannot be classified`,
			);
		else if (uses.startsWith("docker://"))
			violations.push(`${where}: docker action ${uses} cannot be classified`);
		else if (uses.startsWith("./")) {
			if (!LOCAL_ACTION.test(uses) || !localExists(uses))
				violations.push(
					`${where}: local action ${uses} does not resolve to an action file`,
				);
		} else if (!(actionKey(uses) in verdicts))
			violations.push(
				`${where}: ${actionKey(uses)} has no recorded verdict in ACTION_VERDICTS`,
			);
	}
	return violations;
}

/**
 * A variable or a spliced word where the package manager's name would be,
 * followed by an install verb (`"$PM" install`, `"${c}m" ci`): the command
 * word is not in the text, so the scan cannot rule it out.
 */
const COMPUTED_INSTALL =
	/(?<![\w.-])\$\{?\w+\}?[^\s/]*\s+(?:ci|install|i|add|update|upgrade|dlx|exec|publish)(?![\w-])/;

/**
 * Why a workflow reaches the npm registry, one string per site: a
 * package-manager command word, a command word the text does not spell, an
 * action marked `registry`, and everything the scan cannot read (a shell it
 * does not know, a reusable workflow, a docker or unresolvable local action,
 * an action with no recorded verdict). An unreadable site is a hit.
 */
export function registryUseSites(
	source: string,
	readLocal: (usesPath: string) => string | undefined,
	seen: Set<string> = new Set(),
): string[] {
	const doc = workflowDocument(source) as Document & {
		defaults?: { run?: { shell?: unknown } };
	};
	const sites: string[] = [];
	const scanSteps = (
		scope: string,
		steps: Step[] | undefined,
		defaultShell: unknown,
	) => {
		for (const [index, step] of (steps ?? []).entries()) {
			const at = `${scope}.steps[${index}]`;
			if (typeof step.run === "string") {
				const shell = (step as { shell?: unknown }).shell ?? defaultShell;
				const code = shellCode(step.run.replace(/\\\n/g, " "));
				const word =
					shell === undefined ? "bash" : String(shell).split(/\s/)[0];
				if (!KNOWN_SHELLS.has(word))
					sites.push(`${at}: shell ${String(shell)} cannot be read`);
				else if (REGISTRY_CLIENT.test(code))
					sites.push(`${at}: package-manager command`);
				else if (COMPUTED_INSTALL.test(code))
					sites.push(`${at}: computed command word`);
			}
			if (step.uses === undefined) continue;
			const uses = String(step.uses);
			if (uses.startsWith("./")) {
				const local = LOCAL_ACTION.test(uses) ? readLocal(uses) : undefined;
				if (local === undefined || seen.has(uses))
					sites.push(`${at}: local action ${uses} cannot be read`);
				else
					sites.push(
						...registryUseSites(local, readLocal, new Set(seen).add(uses)).map(
							(site) => `${at} -> ${site}`,
						),
					);
			} else if (ACTION_VERDICTS[actionKey(uses)]?.registry)
				sites.push(`${at}: ${actionKey(uses)} installs from the npm registry`);
			else if (!(actionKey(uses) in ACTION_VERDICTS))
				sites.push(`${at}: ${actionKey(uses)} cannot be classified`);
		}
	};
	for (const [job, body] of Object.entries(doc.jobs ?? {})) {
		if ((body as { uses?: unknown }).uses !== undefined)
			sites.push(`jobs.${job}: reusable workflow cannot be read`);
		const jobShell = (body as { defaults?: { run?: { shell?: unknown } } })
			.defaults?.run?.shell;
		scanSteps(`jobs.${job}`, body.steps, jobShell ?? doc.defaults?.run?.shell);
	}
	scanSteps("runs", doc.runs?.steps, undefined);
	return sites;
}

/**
 * A workflow that reaches the npm registry sets both retry keys once, in its
 * top-level `env:`, as literals at or above the floors. A job or step `env:`
 * that sets either key is refused whether or not the workflow installs: the
 * contract is one value per workflow.
 */
export function registryEnvViolations(
	file: string,
	source: string,
	readLocal: (usesPath: string) => string | undefined,
): string[] {
	const doc = workflowDocument(source) as Document;
	const violations: string[] = [];
	const overrides = (
		scope: string,
		env: Record<string, unknown> | undefined,
	) => {
		for (const key of Object.keys(NPM_RETRY_FLOORS))
			if (env && key in env)
				violations.push(
					`${file}: ${scope} sets ${key}; set it once at the workflow level`,
				);
	};
	for (const [job, body] of Object.entries(doc.jobs ?? {})) {
		overrides(`jobs.${job}.env`, body.env);
		for (const [index, step] of (body.steps ?? []).entries())
			overrides(`jobs.${job}.steps[${index}].env`, step.env);
	}
	const sites = registryUseSites(source, readLocal);
	if (sites.length === 0) return violations;
	for (const [key, floor] of Object.entries(NPM_RETRY_FLOORS)) {
		const value = doc.env?.[key];
		const literal = typeof value === "number" ? String(value) : value;
		if (typeof literal !== "string" || !/^\d+$/.test(literal))
			violations.push(
				`${file}: reaches the npm registry (${sites[0]}) but workflow env.${key} is not a literal number`,
			);
		else if (Number(literal) < floor)
			violations.push(
				`${file}: workflow env.${key} is ${literal}, below the floor ${floor}`,
			);
	}
	return violations;
}

const readLocalAction = (usesPath: string): string | undefined => {
	for (const name of ["action.yml", "action.yaml"]) {
		const path = join(ROOT, usesPath, name);
		if (existsSync(path)) return readFileSync(path, "utf8");
	}
	return undefined;
};

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("release downloads go through the fetch-verified helper", () => {
	it("every release asset string under .github is a helper call's url", () => {
		const violations = githubSources().flatMap(({ file, source }) =>
			releaseDownloadViolations(file, source),
		);
		expect(violations).toEqual([]);
	});

	it("every network fetch in a run block or env value under .github is a named admission", () => {
		const violations = githubSources().flatMap(({ file, source }) =>
			fetchViolations(file, source),
		);
		expect(violations).toEqual([]);
	});

	it("every admission is live: it names exactly one fetch site that still exists", () => {
		// Recurrence: a dead admission is a standing licence for a future fetch
		// that reuses the step name. Each key must be hit by the scan.
		const live = new Set(
			githubSources().flatMap(({ file, source }) =>
				fetchSites(file, source).map((site) => site.key),
			),
		);
		const stale = Object.keys(ADMITTED_FETCHES).filter((key) => !live.has(key));
		expect(stale).toEqual([]);
		for (const reason of Object.values(ADMITTED_FETCHES))
			expect(reason.length).toBeGreaterThanOrEqual(24);
	});

	it("every helper call passes the five inputs with a literal url and sha256", () => {
		const violations = workflowSources().flatMap(({ file, source }) =>
			helperCallViolations(file, source),
		);
		expect(violations).toEqual([]);
	});

	it("the population is not empty: eight helper calls across the workflows", () => {
		// Floor: the seven workflow download sites plus the TLA+ jar. An empty
		// scan would pass both tests above, so the floor is the real population.
		assertNonEmptyScan(
			"helper call sites under .github/workflows",
			helperCalls().length,
			8,
		);
	});

	it("the helper keys its cache on tool, version and sha256, fetches with --fail and retries, and verifies first", () => {
		const violations = existsSync(HELPER_FILE)
			? helperShapeViolations(readFileSync(HELPER_FILE, "utf8"))
			: [`${HELPER_USES}/action.yml is missing`];
		expect(violations).toEqual([]);
	});

	it("the TLA+ jar call pins the release the checker pins, and runs before the model check", () => {
		const tla = helperCalls().find(
			(call) =>
				call.file === ".github/workflows/ci.yml" && call.job === "tla-shards",
		);
		expect(tla?.step.with).toMatchObject({
			path: ".cache/tla2tools.jar",
			tool: "tla2tools",
			version: TLA_TOOLS.release,
			url: TLA_TOOLS.url,
			sha256: TLA_TOOLS.sha256,
		});
		const ci = workflowDocument(
			readFileSync(join(WORKFLOWS, "ci.yml"), "utf8"),
		) as Document;
		const steps = ci.jobs?.["tla-shards"]?.steps ?? [];
		const fetchAt = steps.findIndex((step) => step.uses === HELPER_USES);
		const checkAt = steps.findIndex(
			(step) =>
				typeof step.run === "string" &&
				step.run.includes("scripts/check-tla-models.mjs"),
		);
		expect(fetchAt).toBeGreaterThanOrEqual(0);
		expect(fetchAt).toBeLessThan(checkAt);
	});

	it("a planted bare curl -sLO against a release asset reds the gate", () => {
		// Recurrence #5409: the four original sites were `curl -sLO` with no
		// --fail, so a 504 page passed as the archive. A bare run-block download
		// must be a hit whatever flags it carries.
		const planted = [
			"name: planted",
			"on: push",
			"jobs:",
			"  lint:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - name: bare download",
			"        run: |",
			"          curl -sLO https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
			"",
		].join("\n");
		expect(releaseDownloadViolations("planted.yml", planted)).toHaveLength(1);
	});

	it("a planted helper call with a computed url or sha256 reds the gate", () => {
		// Fail closed: an expression the gate cannot resolve to a literal is a hit.
		const planted = [
			"name: planted",
			"on: push",
			"jobs:",
			"  lint:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - uses: ./.github/actions/fetch-verified",
			"        with:",
			"          tool: actionlint",
			"          version: v1.7.12",
			"          url: https://github.com/rhysd/actionlint/releases/download/${{ env.V }}/a.tgz",
			"          sha256: ${{ env.SHA }}",
			"          path: a.tgz",
			"",
		].join("\n");
		expect(helperCallViolations("planted.yml", planted).length).toBeGreaterThan(
			0,
		);
	});

	// Recurrence #5409 r1 F2: the first gate matched one needle and passed 6 of
	// these 7 planted downloads. Each plant must red the fail-closed gate; the
	// last six rows are spellings the review did not plant (an unlisted fetcher,
	// quoting, a computed scheme, an alias, an env-bound URL behind an indirect
	// command name, a PowerShell fetcher).
	const PLANTS: Array<[string, string, Record<string, string>?]> = [
		[
			"bare curl of a release asset",
			"curl -sLO https://github.com/o/r/releases/download/v1/a.tgz",
		],
		[
			"releases/latest/download",
			"curl -fsSLO https://github.com/o/r/releases/latest/download/a.tgz",
		],
		["gh release download", "gh release download v1 -R o/r -p a.tgz"],
		[
			"split URL",
			'host=github.com; p=o/r/releases/download/v1/a.tgz; curl -LO "https://$host/$p"',
		],
		[
			"concatenated URL",
			'u="https://github.com/o/r/rel""eases/download/v1/a"; wget "$u"',
		],
		[
			"objects host",
			"curl -L https://objects.githubusercontent.com/github-production-release-asset/x",
		],
		["other host", "curl -fsSL https://example.com/x.tgz -o x.tgz"],
		["PowerShell fetcher", "Invoke-WebRequest -Uri $env:U -OutFile a.zip"],
		["quoted command word", 'cu""rl -O "$U"'],
		["unlisted fetcher with a URL", `node -e 'fetch("https://example.com/x")'`],
		["computed scheme", 'a=https; curl2() { :; }; echo "${a}://example.com/x"'],
		["alias", 'alias dl=curl; dl -O "$U"'],
		[
			"env-bound URL behind an indirect command name",
			'c=cu; "${c}rl" -O "$U"',
			{ U: "https://example.com/x.tgz" },
		],
	];
	it.each(PLANTS)(
		"a planted %s in a run block reds the gate",
		(_name, run, env) => {
			const planted = [
				"name: planted",
				"on: push",
				"jobs:",
				"  lint:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - name: download",
				...(env
					? [
							"        env:",
							...Object.entries(env).map(([k, v]) => `          ${k}: ${v}`),
						]
					: []),
				"        run: |",
				`          ${run}`,
				"",
			].join("\n");
			expect(fetchViolations("planted.yml", planted)).toHaveLength(1);
		},
	);

	it("a fetch in a nested composite action or a *.yaml workflow is scanned", () => {
		// Recurrence #5409 r1 F5 (Greptile xjG): the scan read `*.yml` workflows
		// and one level of `action.yml`, so a planted curl in `zz.yaml`,
		// `action.yaml` or a nested action was never read.
		const root = mkdtempSync(join(tmpdir(), "pi-lens-fetch-gate-"));
		scratch.push(root);
		const curl = [
			"runs:",
			"  using: composite",
			"  steps:",
			"    - shell: bash",
			"      run: curl -O https://example.com/x",
			"",
		].join("\n");
		const workflow = [
			"on: push",
			"jobs:",
			"  j:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: wget https://example.com/x",
			"",
		].join("\n");
		const planted: Record<string, string> = {
			"workflows/zz.yaml": workflow,
			"actions/zz/action.yaml": curl,
			"actions/zz/nested/action.yml": curl,
		};
		for (const [rel, text] of Object.entries(planted)) {
			mkdirSync(dirname(join(root, rel)), { recursive: true });
			writeFileSync(join(root, rel), text);
		}
		const found = yamlSources(root, ".github");
		expect(found.map((entry) => entry.file)).toEqual(
			Object.keys(planted)
				.map((rel) => `.github/${rel}`)
				.sort(),
		);
		for (const { file, source } of found)
			expect(fetchViolations(file, source)).toHaveLength(1);
	});

	it("an admission is bound to one step: a second step with the same name reds", () => {
		const doubled = [
			"on: push",
			"jobs:",
			"  j:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - name: s",
			"        run: curl https://example.com/a",
			"      - name: s",
			"        run: curl https://example.com/b",
			"",
		].join("\n");
		const key = "x.yml::j::s";
		const violations = fetchViolations("x.yml", doubled, { [key]: "admitted" });
		expect(violations).toEqual([`${key}: 2 steps share one admitted key`]);
	});
});

// Recurrence #5420 (2026-11-08): no workflow set an npm fetch-retry, so one
// registry 5xx turned `npm ci` red; `oven-sh/setup-bun` (four sites in
// install-smoke.yml) fetched bun from a GitHub release with no retry we control.
describe("CI registry and setup-action fetches (#5420)", () => {
	const RETRY_ENV = [
		"env:",
		"  npm_config_fetch_retries: 5",
		"  npm_config_fetch_retry_maxtimeout: 120000",
	];
	const workflow = (opts: {
		env?: string[];
		jobEnv?: string[];
		steps: string[];
		jobUses?: string;
	}) =>
		[
			"name: planted",
			"on: push",
			...(opts.env ?? []),
			"jobs:",
			"  j:",
			...(opts.jobUses
				? [`    uses: ${opts.jobUses}`]
				: ["    runs-on: ubuntu-latest"]),
			...(opts.jobEnv
				? ["    env:", ...opts.jobEnv.map((l) => `      ${l}`)]
				: []),
			...(opts.jobUses ? [] : ["    steps:", ...opts.steps]),
			"",
		].join("\n");
	const runStep = (run: string, extra: string[] = []) => [
		"      - name: s",
		...extra.map((l) => `        ${l}`),
		"        run: |",
		`          ${run}`,
	];
	const stubLocal = () => undefined;

	it("every workflow that reaches the npm registry sets the retry env once at its top level", () => {
		const sources = workflowSources();
		const violations = sources.flatMap(({ file, source }) =>
			registryEnvViolations(file, source, readLocalAction),
		);
		expect(violations).toEqual([]);
		// Floor: an empty or collapsed derivation passes the line above. The
		// population is derived from the parsed run blocks and actions, so the
		// floor is the real count, not a hand list of workflow names.
		assertNonEmptyScan(
			"workflows that reach the npm registry",
			sources.filter(
				({ source }) => registryUseSites(source, readLocalAction).length > 0,
			).length,
			15,
		);
	});

	it("every uses: is a resolvable local action or has a recorded verdict", () => {
		const violations = githubSources().flatMap(({ file, source }) =>
			actionVerdictViolations(
				file,
				source,
				(path) => readLocalAction(path) !== undefined,
			),
		);
		expect(violations).toEqual([]);
	});

	it("every recorded action verdict is live and carries a reason", () => {
		// Recurrence: a dead verdict is a standing licence for a future action
		// of the same name; the setup-bun entry must go with its last site.
		const used = new Set(
			githubSources().flatMap(({ file, source }) =>
				usesSites(file, source).map((site) => actionKey(site.uses)),
			),
		);
		expect(
			Object.keys(ACTION_VERDICTS).filter((key) => !used.has(key)),
		).toEqual([]);
		for (const { why } of Object.values(ACTION_VERDICTS))
			expect(why.length).toBeGreaterThanOrEqual(24);
	});

	it("the four bun installs come from the npm registry, after setup-node, at latest", () => {
		// Recurrence #5420: `oven-sh/setup-bun` with `bun-version: latest` listed
		// tags through the GitHub API and downloaded from a release, uncached
		// and unretried. `npm install --global bun@latest` keeps `latest` and
		// takes the platform binary from the registry, where the workflow's
		// npm_config_fetch_retries applies and a 404 is not retried.
		const doc = workflowDocument(
			readFileSync(join(WORKFLOWS, "install-smoke.yml"), "utf8"),
		) as Document;
		const installs: string[] = [];
		for (const [job, body] of Object.entries(doc.jobs ?? {})) {
			const steps = body.steps ?? [];
			for (const [index, step] of steps.entries()) {
				if (typeof step.run !== "string" || !/\bbun@/.test(step.run)) continue;
				installs.push(`${job}.steps[${index}]`);
				expect(codeLines(step.run).trim()).toBe(
					"npm install --global bun@latest",
				);
				const node = steps.findIndex(
					(other) =>
						typeof other.uses === "string" &&
						other.uses.startsWith("actions/setup-node@"),
				);
				expect(node).toBeGreaterThanOrEqual(0);
				expect(node).toBeLessThan(index);
			}
		}
		assertNonEmptyScan(
			"bun install steps in install-smoke.yml",
			installs.length,
			4,
		);
	});

	it("a workflow that installs from npm with no retry env reds the gate", () => {
		// Recurrence #5420: 17 workflows ran npm with npm's default 2 retries.
		const planted = workflow({ steps: runStep("npm ci") });
		expect(
			registryEnvViolations("planted.yml", planted, stubLocal),
		).toHaveLength(2);
		const withEnv = workflow({ env: RETRY_ENV, steps: runStep("npm ci") });
		expect(registryEnvViolations("planted.yml", withEnv, stubLocal)).toEqual(
			[],
		);
	});

	it("a workflow that never reaches the registry needs no retry env", () => {
		const planted = workflow({ steps: runStep("echo hello") });
		expect(registryEnvViolations("planted.yml", planted, stubLocal)).toEqual(
			[],
		);
	});

	// Fail closed (principles section 1): the first cut of every detector in
	// this file missed a spelling its author did not plant. Each row installs
	// from npm in a way the scan must read as a hit; the last rows are sites it
	// cannot read at all (computed command word, unknown shell, reusable
	// workflow, docker action, unresolvable local action, unlisted action).
	const REGISTRY_PLANTS: Array<[string, string[], string?]> = [
		["pinned npx", runStep('npx -y "npm@${npm_pin}" ci')],
		["pnpm", runStep("pnpm install")],
		["yarn", runStep("yarn install")],
		["bun add", runStep("bun add left-pad")],
		["corepack", runStep("corepack enable")],
		["quoted command word", runStep('"np""m" ci')],
		["computed command word", runStep('c=np; "${c}m" ci')],
		["variable package manager", runStep('"$PM" install')],
		["unknown shell", runStep("x", ["shell: python {0}"])],
		[
			"unlisted remote action",
			[
				"      - uses: some/new-action@0000000000000000000000000000000000000000",
			],
		],
		[
			"registry action",
			[
				"      - uses: pnpm/action-setup@0000000000000000000000000000000000000000",
			],
		],
		["docker action", ["      - uses: docker://alpine:3"]],
		["missing local action", ["      - uses: ./.github/actions/nope"]],
		["local action with a ref", ["      - uses: ./.github/actions/nope@v1"]],
	];
	it.each(REGISTRY_PLANTS)(
		"a planted %s reds the retry-env gate",
		(_name, steps) => {
			const planted = workflow({ steps });
			expect(
				registryEnvViolations("planted.yml", planted, stubLocal).length,
			).toBeGreaterThan(0);
		},
	);

	it("a reusable workflow job reds the retry-env gate", () => {
		const planted = workflow({
			steps: [],
			jobUses: "./.github/workflows/other.yml",
		});
		expect(
			registryEnvViolations("planted.yml", planted, stubLocal).length,
		).toBeGreaterThan(0);
	});

	it("an npm install inside a local composite action is a hit for the calling workflow", () => {
		const action = [
			"runs:",
			"  using: composite",
			"  steps:",
			"    - shell: bash",
			"      run: npm ci",
			"",
		].join("\n");
		const planted = workflow({ steps: ["      - uses: ./.github/actions/x"] });
		const read = (path: string) =>
			path === "./.github/actions/x" ? action : undefined;
		expect(
			registryEnvViolations("planted.yml", planted, read).length,
		).toBeGreaterThan(0);
		const withEnv = workflow({
			env: RETRY_ENV,
			steps: ["      - uses: ./.github/actions/x"],
		});
		expect(registryEnvViolations("planted.yml", withEnv, read)).toEqual([]);
	});

	it("a readable local composite action with no registry command needs no retry env", () => {
		// Recurrence #5420: an unreadable local action counts as a hit, so the
		// readable-and-clean case is what proves the scan really reads it.
		const action = [
			"runs:",
			"  using: composite",
			"  steps:",
			"    - shell: bash",
			"      run: echo hello",
			"",
		].join("\n");
		const planted = workflow({ steps: ["      - uses: ./.github/actions/x"] });
		const read = (path: string) =>
			path === "./.github/actions/x" ? action : undefined;
		expect(registryEnvViolations("planted.yml", planted, read)).toEqual([]);
	});

	it.each([
		[
			"an expression",
			[
				"env:",
				"  npm_config_fetch_retries: ${{ vars.R }}",
				"  npm_config_fetch_retry_maxtimeout: 120000",
			],
		],
		[
			"a value below the retry floor",
			[
				"env:",
				"  npm_config_fetch_retries: 1",
				"  npm_config_fetch_retry_maxtimeout: 120000",
			],
		],
		[
			"a value below the timeout floor",
			[
				"env:",
				"  npm_config_fetch_retries: 5",
				"  npm_config_fetch_retry_maxtimeout: 1000",
			],
		],
		["only one key", ["env:", "  npm_config_fetch_retries: 5"]],
	])("a retry env of %s reds the gate", (_name, env) => {
		const planted = workflow({ env, steps: runStep("npm ci") });
		expect(
			registryEnvViolations("planted.yml", planted, stubLocal).length,
		).toBeGreaterThan(0);
	});

	it("a job or step env that overrides a retry key reds the gate", () => {
		const job = workflow({
			env: RETRY_ENV,
			jobEnv: ["npm_config_fetch_retries: 0"],
			steps: runStep("npm ci"),
		});
		expect(registryEnvViolations("planted.yml", job, stubLocal)).toHaveLength(
			1,
		);
		const step = workflow({
			env: RETRY_ENV,
			steps: runStep("npm ci", [
				"env:",
				"  npm_config_fetch_retry_maxtimeout: 1",
			]),
		});
		expect(registryEnvViolations("planted.yml", step, stubLocal)).toHaveLength(
			1,
		);
	});

	it.each([
		[
			"reusable workflow job",
			{ steps: [], jobUses: "./.github/workflows/o.yml" },
		],
		["docker action", { steps: ["      - uses: docker://alpine:3"] }],
		[
			"missing local action",
			{ steps: ["      - uses: ./.github/actions/nope"] },
		],
		[
			"local action with a ref",
			{ steps: ["      - uses: ./.github/actions/x@v1"] },
		],
		["unlisted remote action", { steps: ["      - uses: some/new-action@v1"] }],
	])("a planted %s has no verdict and reds the verdict gate", (_name, opts) => {
		// Fail closed: every `uses:` the table cannot place is a violation, and
		// a local path counts only when it resolves to an action file.
		const planted = workflow(opts);
		expect(
			actionVerdictViolations(
				"planted.yml",
				planted,
				(path) => path === "./.github/actions/x@v1",
			),
		).toHaveLength(1);
	});

	it("a planted setup-bun action reds the verdict gate until it is admitted", () => {
		// Recurrence #5420: the four oven-sh/setup-bun sites had no recorded
		// verdict, so nothing asked whether they could reach a GitHub release.
		const planted = workflow({
			env: RETRY_ENV,
			steps: [
				"      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
				"        with:",
				"          bun-version: latest",
			],
		});
		const exists = () => true;
		expect(actionVerdictViolations("planted.yml", planted, exists)).toEqual([
			"planted.yml: jobs.j.steps[0]: oven-sh/setup-bun has no recorded verdict in ACTION_VERDICTS",
		]);
		const admitted = {
			"oven-sh/setup-bun": { why: "a recorded verdict that is long enough" },
		};
		expect(
			actionVerdictViolations("planted.yml", planted, exists, admitted),
		).toEqual([]);
	});
});

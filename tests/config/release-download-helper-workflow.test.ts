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

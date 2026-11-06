import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { workflowDocument } from "../../scripts/dispatch-safety.mjs";
import { STALE_CELLS_ISSUE_TITLE } from "../../scripts/lib/clean-signal.mjs";
import { extractVitestFailureBlock } from "../../scripts/extract-vitest-failures.mjs";
import {
	commandBasename,
	scannableRegions,
	splitSegments,
	splitWords,
	stripCommandGroupAndRunnerPrefixes,
	stripEnvAssignments,
} from "../../scripts/hooks/guard-bash.mjs";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW = resolve(ROOT, ".github/workflows/tool-smoke.yml");

function loadWorkflow(): any {
	return yaml.load(readFileSync(WORKFLOW, "utf8"));
}

function importsDistFromEntry(
	entry: string,
	seen = new Set<string>(),
): boolean {
	const absolute = entry.startsWith(ROOT) ? entry : resolve(ROOT, entry);
	if (seen.has(absolute)) return false;
	seen.add(absolute);
	const source = readFileSync(absolute, "utf8");
	if (/\b(?:import|from)\s+["'][^"']*dist\//.test(source)) return true;
	for (const match of source.matchAll(
		/\bfrom\s+["'](\.[^"']+)["']|\bimport\s+["'](\.[^"']+)["']/g,
	)) {
		const relative = match[1] ?? match[2];
		const child = resolve(absolute, "..", relative);
		try {
			if (importsDistFromEntry(child, seen)) return true;
		} catch {
			// A non-file or unsupported dynamic import is not proven safe.
			return true;
		}
	}
	return false;
}

describe("nightly LSP capability refresh contract (#4277)", () => {
	it("builds dist before every notify-job script that reaches it (#5323)", () => {
		const workflow = loadWorkflow();
		const notify = workflow.jobs["tool-smoke-notify"];
		const steps = notify.steps as any[];
		const buildIndex = steps.findIndex(
			(step) => String(step.run).trim() === "npm run build:dist",
		);
		expect(buildIndex).toBeGreaterThanOrEqual(0);
		const scriptSteps = steps
			.map((step, index) => ({ step, index }))
			.filter(({ step }) => /\bnode scripts\//.test(String(step.run)));
		const firstScript = Math.min(...scriptSteps.map(({ index }) => index));
		expect(buildIndex).toBeLessThan(firstScript);
		for (const { step } of scriptSteps) {
			const run = String(step.run);
			for (const match of run.matchAll(/node scripts\/([\w-]+\.mjs)/g)) {
				if (importsDistFromEntry(`scripts/${match[1]}`))
					expect(buildIndex).toBeLessThan(
						steps.findIndex((candidate) => candidate === step),
					);
			}
		}
	});

	it("builds the in-place compiled twins before the census, after the promotion edit (#4302)", () => {
		const workflow = loadWorkflow();
		const smoke = workflow.jobs["tool-smoke"];
		const indexOf = (id: string) =>
			smoke.steps.findIndex((step: any) => step.id === id);
		// Only the in-place `npm run build`; `npm run build:dist` also matches a
		// substring check but emits dist/, which is not what vitest loads.
		const buildIndex = smoke.steps.findIndex(
			(step: any) => String(step.run).trim() === "npm run build",
		);

		expect(buildIndex).toBeGreaterThan(indexOf("idle_promote"));
		expect(buildIndex).toBeLessThan(indexOf("lsp_census"));
		expect(smoke.steps[buildIndex]["continue-on-error"]).toBeUndefined();
	});

	it("runs every matrix census before the refresh PR step", () => {
		const workflow = loadWorkflow();
		const smoke = workflow.jobs["tool-smoke"];
		const censusIndex = smoke.steps.findIndex(
			(step: any) => step.id === "lsp_census",
		);
		const diffIndex = smoke.steps.findIndex(
			(step: any) => step.id === "docs_diff",
		);
		const census = smoke.steps[censusIndex];
		const refresh = workflow.jobs["tool-smoke-prs"].steps.find(
			(step: any) => step.with?.branch === "bot/lsp-docs-refresh",
		);

		expect(censusIndex).toBeGreaterThan(diffIndex);
		expect(census["continue-on-error"]).toBe(true);
		for (const file of [
			"tests/config/lsp-first-publish-census.test.ts",
			"tests/config/lsp-clean-behavior-census.test.ts",
			"tests/config/lsp-idle-eviction-measurement.test.ts",
			"tests/scripts/lsp-matrix-refresh-expiry.test.ts",
		])
			expect(census.run).toContain(file);
		expect(census.run).toContain(
			'tee "$RUNNER_TEMP/lsp-capability-census.log"',
		);
		expect(refresh.if).toContain(
			"needs.tool-smoke.outputs.census == 'success'",
		);
	});

	it("routes every non-success outcome to the separately titled tracker", () => {
		const workflow = loadWorkflow();
		const smoke = workflow.jobs["tool-smoke"];
		const notify = workflow.jobs["tool-smoke-notify"];
		const tracker = notify.steps.find((step: any) =>
			step.name?.includes("LSP capability census"),
		);
		const run = String(tracker.run);

		expect(tracker.if).toBe("always()");
		expect(run).toContain("TITLE='nightly: LSP capability census drift'");
		expect(run).toContain("scripts/upsert-tracking-issue.mjs");
		expect(run).toContain('--body-file "$body"');
		expect(run).toContain("--clean --close-when-clean");
		expect(run).toContain(
			'node scripts/extract-vitest-failures.mjs "$CENSUS_LOG"',
		);
		expect(notify.needs).toBe("tool-smoke");

		for (const [output, variable] of [
			["census", "CENSUS_OUTCOME"],
			["seed_matrix", "SEED_OUTCOME"],
			["lsp_matrix", "MATRIX_OUTCOME"],
			["clean_signal", "CLEAN_OUTCOME"],
			["server_capabilities", "CAPABILITIES_OUTCOME"],
			["idle_measurement", "IDLE_OUTCOME"],
			["idle_promote", "PROMOTE_OUTCOME"],
			["docs_diff", "DIFF_OUTCOME"],
		]) {
			expect(smoke.outputs[output]).toBeDefined();
			expect(run).toContain(`$${variable}`);
		}
		expect(run).toContain("$JOB_STATUS");
	});

	it("keeps coloured census diagnostics in the tracking issue body", () => {
		const coloured = [
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m \u001b[30m\u001b[42m default \u001b[49m\u001b[39m tests/config/lsp-first-publish-census.test.ts\u001b[2m > \u001b[22m#3310 first-publish census",
			"\u001b[31m\u001b[1mAssertionError\u001b[22m: expected [ Array(1) ] to deeply equal []\u001b[39m",
			'\u001b[31m+   "typescript (typescript-language-server): measured empty-first but wait-policy/strategies.ts has no emptyFirstPublish marker for \\"typescript\\""\u001b[39m',
			" Test Files  1 failed | 3 passed (4)",
		].join("\n");
		const body = extractVitestFailureBlock(coloured);
		expect(body).toContain("tests/config/lsp-first-publish-census.test.ts");
		expect(body).toContain("typescript-language-server");
		expect(body).toContain("emptyFirstPublish marker");
	});

	it("keeps every coloured failure block, including non-census failures", () => {
		const coloured = [
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default tests/config/lsp-first-publish-census.test.ts > first",
			"first census detail",
			" Test Files  1 failed (1)",
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default tests/config/lsp-clean-behavior-census.test.ts > second",
			"second census detail",
			" Test Files  2 failed (2)",
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default tests/clients/unrelated.test.ts > third",
			"third unrelated detail",
			" Test Files  3 failed (3)",
		].join("\n");
		const body = extractVitestFailureBlock(coloured);
		expect(body).toContain("tests/config/lsp-first-publish-census.test.ts");
		expect(body).toContain("tests/config/lsp-clean-behavior-census.test.ts");
		expect(body).toContain("tests/clients/unrelated.test.ts");
	});

	it("bounds failure details with an explicit omitted-block count", () => {
		const output = Array.from({ length: 20 }, (_, index) =>
			[
				` FAIL default tests/config/failure-${index}.test.ts > case`,
				"x".repeat(1_000),
			].join("\n"),
		).join("\n");
		const body = extractVitestFailureBlock(output);
		expect(body.length).toBeLessThanOrEqual(12_000);
		expect(body).toMatch(/\(\d+ more failures truncated\)$/);
	});

	it("gates only the refresh PR, while preserving the independent promotion PR", () => {
		const workflow = loadWorkflow();
		const prs = workflow.jobs["tool-smoke-prs"].steps.filter((step: any) =>
			step.uses?.startsWith("peter-evans/create-pull-request"),
		);
		const refresh = prs.find(
			(step: any) => step.with?.branch === "bot/lsp-docs-refresh",
		);
		const promotion = prs.find(
			(step: any) => step.with?.branch === "bot/lsp-idle-evict-promote",
		);

		expect(refresh.if).toContain(
			"needs.tool-smoke.outputs.docs_changed == 'true'",
		);
		expect(refresh.if).toContain(
			"needs.tool-smoke.outputs.census == 'success'",
		);
		expect(promotion.if).toBe("needs.tool-smoke.outputs.promoted == 'true'");
	});
});

// ── #4512: the refresh PR starts CI, lands when flip-free, and raises misses ──
//
// Recurrence these keep out: PR #4338 sat open from 2026-10-13 because the
// refresh PR was opened with the repository GITHUB_TOKEN, whose pushes trigger
// no workflow, so every refresh waited for a maintainer's close and reopen; and
// a missed-probe verdict that never reached the notifier job (a stale cell
// stood unread, as the five `direct` cells did before they were rewritten).
describe("nightly LSP refresh landing and stale-cell notifier (#4512)", () => {
	const prSteps = () => loadWorkflow().jobs["tool-smoke-prs"].steps as any[];
	const stepByName = (steps: any[], fragment: string) =>
		steps.find((step: any) => String(step.name ?? "").includes(fragment));

	it("opens the docs-refresh PR with the App token when it exists and GITHUB_TOKEN otherwise", () => {
		const steps = prSteps();
		const refresh = steps.find(
			(step: any) => step.with?.branch === "bot/lsp-docs-refresh",
		);
		expect(refresh.id).toBe("refresh_pr");
		expect(refresh.with.token).toBe(
			"${{ steps.app_token.outputs.token || secrets.GITHUB_TOKEN }}",
		);
		const mint = stepByName(steps, "Mint the refresh App token");
		expect(mint.uses).toMatch(
			/^actions\/create-github-app-token@[0-9a-f]{40}$/,
		);
		expect(mint.if).toBe("vars.LSP_REFRESH_APP_ID != ''");
		expect(mint["continue-on-error"]).toBe(true);
		expect(steps.indexOf(mint)).toBeLessThan(steps.indexOf(refresh));
		// The token is scoped to the two writes the PR step makes, nothing else.
		const scopes = Object.keys(mint.with)
			.filter((key) => key.startsWith("permission-"))
			.sort();
		expect(scopes).toEqual(["permission-contents", "permission-pull-requests"]);
	});

	it("keeps the promotion PR on the repository token (the App token is the docs refresh only)", () => {
		const promotion = prSteps().find(
			(step: any) => step.with?.branch === "bot/lsp-idle-evict-promote",
		);
		expect(promotion.with.token).toBe("${{ secrets.GITHUB_TOKEN }}");
	});

	it("writes the PR body from the flip check before the PR step reads it", () => {
		const steps = prSteps();
		const landing = stepByName(steps, "Compose the refresh PR body");
		const refresh = steps.find((step: any) => step.id === "refresh_pr");
		expect(landing.id).toBe("landing");
		expect(landing.if).toBe(refresh.if);
		expect(String(landing.run)).toContain("scripts/lsp-refresh-landing.mjs");
		expect(String(landing.run)).toContain(
			'--body "$RUNNER_TEMP/lsp-refresh-pr-body.md"',
		);
		expect(refresh.with["body-path"]).toBe(
			"${{ runner.temp }}/lsp-refresh-pr-body.md",
		);
		expect(refresh.with.body).toBeUndefined();
		expect(steps.indexOf(landing)).toBeLessThan(steps.indexOf(refresh));
	});

	it("arms auto-merge only for a flip-free refresh with the App token and the repository opt-in", () => {
		const arm = stepByName(prSteps(), "Arm auto-merge");
		for (const condition of [
			"steps.refresh_pr.outputs.pull-request-number != ''",
			"steps.landing.outputs.flip_free == 'true'",
			"steps.app_token.outputs.token != ''",
			"vars.LSP_REFRESH_AUTOMERGE == 'true'",
		])
			expect(arm.if, condition).toContain(condition);
		expect(arm.run).toBe('gh pr merge "$PR_NUMBER" --auto --merge');
		expect(arm.env.GH_TOKEN).toBe("${{ steps.app_token.outputs.token }}");
		expect(arm["continue-on-error"]).toBe(true);
	});

	it("disarms auto-merge on a refresh that has flips, so last night's arming cannot carry them", () => {
		// Recurrence shape: the branch is force-rebuilt every night, and an armed
		// auto-merge survives the push.
		const steps = prSteps();
		const disarm = stepByName(steps, "Disarm auto-merge");
		expect(disarm.if).toContain("steps.landing.outputs.flip_free != 'true'");
		expect(disarm.if).toContain(
			"steps.refresh_pr.outputs.pull-request-number != ''",
		);
		expect(disarm.run).toContain("--disable-auto");
		expect(String(disarm.run)).toContain("set -euo pipefail");
	});

	it("disarms with the token that updated the PR, and a disarm that cannot run reds the job", () => {
		// Recurrence (PR #4980 thread): the App token failed to mint on a night
		// with flips, `refresh_pr` still updated the PR with GITHUB_TOKEN, and the
		// disarm was gated on the App token, so it was skipped and last night's
		// auto-merge stayed armed over tonight's flips.
		const steps = prSteps();
		const refresh = steps.find((step: any) => step.id === "refresh_pr");
		const disarm = stepByName(steps, "Disarm auto-merge");
		expect(disarm.env.GH_TOKEN).toBe(refresh.with.token);
		expect(disarm.if).not.toContain("steps.app_token");
		expect(disarm["continue-on-error"]).toBeUndefined();
	});

	it("files the stale-cell issue under the title the body builder and the issue text agree on", () => {
		const notify = loadWorkflow().jobs["tool-smoke-notify"].steps as any[];
		const step = stepByName(notify, "Notify on stale matrix cells");
		const run = String(step.run);
		expect(run).toContain(`TITLE='${STALE_CELLS_ISSUE_TITLE}'`);
		expect(run).toContain("scripts/upsert-tracking-issue.mjs");
		expect(run).toContain(
			'--body-file "$RUNNER_TEMP/pilens-stale-cells-body.md"',
		);
		expect(run).toContain("--clean --close-when-clean");
		// Only the two verdicts act; a missing verdict leaves the issue alone.
		expect(run).toContain(
			'STATE=$(cat "$RUNNER_TEMP/pilens-stale-cells-state" 2>/dev/null || echo missing)',
		);
		expect(step["continue-on-error"]).toBe(true);
	});

	it("stages the probe's verdict files under the names the notifier reads", () => {
		const stage = stepByName(
			loadWorkflow().jobs["tool-smoke"].steps,
			"Stage the notifier inputs",
		);
		const run = String(stage.run);
		expect(run).toContain("STALE_CELLS_BODY_PATH");
		expect(run).toContain("STALE_CELLS_STATE_PATH");
		expect(run).toContain('"$stage/pilens-stale-cells-body.md"');
		expect(run).toContain('"$stage/pilens-stale-cells-state"');
	});
});

// ── #3952: a staged dot path must survive the artifact hand-off ─────────────
//
// `actions/upload-artifact` v4.4+ omits every file or folder whose name starts
// with `.` unless the step sets `include-hidden-files: true`. The nightly staged
// its promotion fragment as `.changelog/3989-lsp-idle-eviction-promote.md`, the
// `tool-smoke-pr-inputs` artifact arrived without it, and the promotion PR's
// `git add` died on `fatal: pathspec '.changelog/…' did not match any files`
// (run 40185196001). Two qualified promotions were lost, 2026-10-24 and 2026-10-25.
//
// Recurrence this keeps out: any staging step that copies a dot path into an
// uploaded directory and then uploads it without the key. The scan reads the
// parsed YAML and the real shell text of each job, never a hand list of file
// names, so a new artifact or a new staged literal is read on the next run.
//
// Read grammar (the whole of it): a job's shell stages a path through `cp`,
// `mv`, `install`, `rsync` and `tee` operands and through `>`/`>>` redirects;
// variables resolve through in-job assignments, `env:` blocks, and the symbolic
// names below; an inner shell invoked as `bash -c`/`sh -c` is rescanned once.
// A staged path or an uploaded path the grammar cannot place (an unset
// variable, a command substitution, an option word the grammar does not
// admit) makes the step red instead of passing. A root whose CONTENT no step
// explains reads clean: most live upload steps stage through a child process
// this shell grammar cannot see, and the PR body carries them as an accepted
// residual.
// An upload inside a composite action is refused unless it sets the key,
// because its staging belongs to the caller's job, a file this one cannot read.
const UPLOAD_ARTIFACT = "actions/upload-artifact";

/** The verbs whose operands the scan follows as staged paths. */
const ADMITTED_WRITES = new Set(["cp", "mv", "install", "rsync", "tee"]);

/** Shells whose `-c` script is the same job's shell text, one level down. */
const ADMITTED_SHELLS = new Set(["bash", "sh", "zsh"]);

/**
 * Variables whose value is the runner's own location rather than the
 * workflow's: they are read as symbolic path segments, not as unknowns.
 */
const SYMBOLIC_VARIABLES = new Set([
	"GITHUB_ENV",
	"GITHUB_JOB",
	"GITHUB_OUTPUT",
	"GITHUB_PATH",
	"GITHUB_STEP_SUMMARY",
	"GITHUB_WORKSPACE",
	"RUNNER_TEMP",
]);

const ALIAS_CANDIDATES = 8;
const BARE_REDIRECT = /^(?:[0-9]|&)?>>?$/;
const INLINE_REDIRECT = /^(?:[0-9]|&)?>>?(.+)$/;

type ArtifactStep = {
	name?: unknown;
	uses?: unknown;
	run?: unknown;
	with?: Record<string, unknown>;
	env?: Record<string, unknown>;
};
type ArtifactJob = { env?: Record<string, unknown>; steps?: ArtifactStep[] };
type ArtifactWorkflow = {
	jobs?: Record<string, ArtifactJob>;
	/** A composite action's steps, which run inside the caller's job. */
	runs?: { steps?: ArtifactStep[] };
};

/** A path one of the job's shell commands writes. */
type Slot = { file: string };
type Aliases = Map<string, string[]>;

/** `${{ runner.temp }}` and the other workflow spellings, as a shell holds them. */
function symbolic(value: string): string {
	return value
		.replace(/\$\{\{\s*runner\.temp\s*\}\}/g, "$RUNNER_TEMP")
		.replace(/\$\{\{\s*github\.workspace\s*\}\}/g, "$GITHUB_WORKSPACE")
		.replace(/\/{2,}/g, "/")
		.trim();
}

/**
 * `scripts/hooks/guard-bash.mjs`'s placeholder for the output of a live
 * substitution: the scan keeps the position and not the text, because the
 * text is whatever the command prints at run time.
 */
const SUBSTITUTION_MARK = "\uE000";

/** Why a spelling's value cannot be read, or `undefined` when it can. */
function unreadablePart(spelling: string): string | undefined {
	if (spelling.includes("`") || spelling.includes("$("))
		return "a command substitution";
	if (spelling.includes(SUBSTITUTION_MARK))
		return "a substitution the scan cannot read";
	if (/\$[0-9@*#?!$-]/.test(spelling)) return "a shell parameter";
	for (const match of spelling.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g))
		if (!SYMBOLIC_VARIABLES.has(match[1])) return `$${match[1]}`;
	return undefined;
}

/**
 * Is a landed component's NAME led by a value the scan cannot read? Only the
 * leading character decides whether it starts with `.`, so a component that
 * begins with a literal character is decided whatever follows it.
 */
function unreadableLead(part: string): boolean {
	if (part.startsWith(SUBSTITUTION_MARK) || part.startsWith("`")) return true;
	return part.startsWith("$") && unreadablePart(part) !== undefined;
}

/**
 * Whether a landed path survives the upload. `hidden` is a component whose
 * name starts with `.`; `unknown` is one whose FIRST character comes from a
 * value the scan cannot read, so whether the upload drops it cannot be
 * decided either way. A component that starts with a literal character cannot
 * become hidden from anything the scan cannot read further along it, and
 * pathname expansion never matches a leading dot, so a glob cannot produce
 * one. `.` and `..` are navigation, not names.
 */
function landingVerdict(spelling: string): "hidden" | "unknown" | "clean" {
	for (const part of spelling.split("/")) {
		if (part === "" || part === "." || part === "..") continue;
		if (part.startsWith(".")) return "hidden";
		if (unreadableLead(part)) return "unknown";
	}
	return "clean";
}

/** The components of a spelling the scan cannot read the value of. */
function unresolvedComponents(spelling: string): string[] {
	return spelling
		.split("/")
		.filter((part) => part !== "" && unreadableLead(part));
}

function expandWord(word: string, aliases: Aliases): string[] {
	let values = [symbolic(word)];
	for (let round = 0; round < ALIAS_CANDIDATES; round++) {
		const next = new Set<string>();
		let replaced = false;
		for (const value of values) {
			const match = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(value);
			const candidates = match ? aliases.get(match[1]) : undefined;
			if (!match || !candidates) {
				next.add(value);
				continue;
			}
			replaced = true;
			for (const candidate of candidates)
				next.add(value.replace(match[0], candidate));
		}
		values = [...next].slice(0, ALIAS_CANDIDATES);
		if (!replaced) break;
	}
	return values;
}

function recordAlias(aliases: Aliases, name: string, value: string): void {
	const known = aliases.get(name) ?? [];
	const candidates = new Set([...known, ...expandWord(value, aliases)]);
	aliases.set(name, [...candidates].slice(0, ALIAS_CANDIDATES));
}

function filesOf(value: string, aliases: Aliases): Slot[] {
	return expandWord(value, aliases).map((file) => ({ file }));
}

/** The words a segment writes to, split from the words it operates on. */
function splitRedirects(words: string[]): {
	operands: string[];
	targets: string[];
} {
	const operands: string[] = [];
	const targets: string[] = [];
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (BARE_REDIRECT.test(word)) {
			const target = words[index + 1];
			if (target !== undefined && !target.startsWith("&")) targets.push(target);
			index++;
			continue;
		}
		const inline = INLINE_REDIRECT.exec(word);
		if (inline) {
			if (!inline[1].startsWith("&")) targets.push(inline[1]);
			continue;
		}
		operands.push(word);
	}
	return { operands, targets };
}

/**
 * The option words an admitted write verb may carry: one standalone word each,
 * with no value and no effect on where the copy lands. Every other option word
 * leaves the write unplaceable, so the step reds instead of reading the last
 * operand as the destination while the real one drops.
 *
 * Round 2 enumerated the destination spellings (`-t DIR`, `-tDIR`,
 * `--target-directory=DIR`) and each review found the next one — a bundle
 * whose first letter takes a value (`-Stmp`), a GNU abbreviation
 * (`--target-dir=`), `rsync -R` — so the gate admits a short list and refuses
 * everything else (#4869 rounds 1-3; principles, "Gates fail closed").
 * `rsync -R` is `--relative` and DOES preserve the source path, so `rsync`
 * admits only the forms its census rows spell. Each set holds only words the
 * verb really has that leave the destination alone (`mv -f`, `install -p`,
 * `tee -a`); any other option word, `install -t`/`-D` included, refuses
 * (verify r4 R4-2).
 */
const ADMITTED_OPTIONS: Record<string, ReadonlySet<string>> = {
	cp: new Set(["-a", "-f", "-p", "-r", "-R", "--parents"]),
	install: new Set(["-p"]),
	mv: new Set(["-f"]),
	rsync: new Set(["-a", "-r"]),
	tee: new Set(["-a"]),
};

/**
 * The operands `command` was given and whether `--parents` is set; or the
 * option word that leaves the write unplaceable.
 */
function parseWriteOperands(
	command: string,
	words: string[],
): { operands: string[]; parents: boolean } | { unplaced: string } {
	const admitted = ADMITTED_OPTIONS[command];
	const operands: string[] = [];
	let parents = false;
	for (const word of words) {
		if (!word.startsWith("-") || word === "-") {
			operands.push(word);
			continue;
		}
		if (admitted?.has(word) !== true)
			return {
				unplaced: `${word} (an option the write grammar does not admit)`,
			};
		if (word === "--parents") parents = true;
	}
	return { operands, parents };
}

/**
 * The paths `command` writes, and the destinations it writes them under. A
 * copy into a directory lands the source's own path with `--parents` and only
 * its basename without; a copy onto a name lands that name; `tee` writes every
 * operand.
 */
function writeSlots(
	command: string,
	operands: string[],
	aliases: Aliases,
): { destinations: string[]; slots: Slot[]; unplaced?: string } {
	const parsed = parseWriteOperands(command, operands);
	if ("unplaced" in parsed)
		return {
			destinations: [],
			slots: [],
			unplaced: parsed.unplaced,
		};
	if (command === "tee")
		return {
			destinations: parsed.operands.flatMap((target) =>
				expandWord(target, aliases),
			),
			slots: parsed.operands.flatMap((target) => filesOf(target, aliases)),
		};
	const sources = parsed.operands.slice(0, -1);
	const destinations = parsed.operands.slice(-1);
	if (sources.length === 0 || destinations.length === 0)
		return { destinations: [], slots: [] };
	// `.`, `..`, `./` and `dir/.` copy a directory's whole contents, hidden
	// entries included, and the YAML cannot list them: `cp -a . "$stage/files"`
	// lands `files/.changelog/x.md`. The scan cannot place that write, so it
	// refuses it (verify r5 R5-1, CodeRabbit inline).
	for (const source of sources)
		for (const from of expandWord(source, aliases)) {
			const base = from.replace(/\/+$/, "").split("/").pop() ?? "";
			if (base === "." || base === "..")
				return {
					destinations: [],
					slots: [],
					unplaced: `${from} (a source whose contents the scan cannot list)`,
				};
		}
	const slots: Slot[] = [];
	const placed: string[] = [];
	// `cp --parents` refuses a destination that is not a directory ("with
	// --parents, the destination must be a directory"), so a slashless one names
	// a directory too: `cp --parents .changelog/x.md "$stage/files"` lands
	// `files/.changelog/x.md`, and reading it as a file slot drops the dot path
	// (CodeRabbit inline, round 3).
	// Without `--parents` a slashless destination is a file OR an existing
	// directory, and the scan cannot tell which: `mkdir -p "$stage/files"` then
	// `cp -a .changelog "$stage/files"` lands `files/.changelog/x.md`, and two
	// sources force a directory. So it is read both ways, and a hidden source
	// basename reds either reading (verify r4 R4-1, CodeRabbit inline).
	const directoryOnly = parsed.parents;
	for (const word of destinations)
		for (const expanded of expandWord(word, aliases)) {
			const target =
				directoryOnly && !expanded.endsWith("/") ? `${expanded}/` : expanded;
			placed.push(target);
			if (!target.endsWith("/")) {
				slots.push({ file: target });
				// The directory reading only adds a slot the file reading lacks:
				// a hidden source basename landing inside the destination.
				for (const source of sources)
					for (const from of expandWord(source, aliases)) {
						const base = from.replace(/\/+$/, "").split("/").pop() ?? "";
						if (base.startsWith(".")) slots.push({ file: `${target}/${base}` });
					}
				continue;
			}
			for (const source of sources)
				for (const from of expandWord(source, aliases))
					slots.push({
						file: parsed.parents
							? `${target}${from.replace(/^\/+/, "")}`
							: `${target}${from.replace(/\/+$/, "").split("/").pop() ?? ""}`,
					});
		}
	return { destinations: placed, slots };
}

/** Every path one job's shell writes, and the destinations it cannot place. */
type Staging = { slots: Slot[]; unplaceable: string[] };

function jobStaging(job: ArtifactJob): Staging {
	const aliases: Aliases = new Map();
	const slots: Slot[] = [];
	const unplaceable: string[] = [];
	const recordWrite = (file: string) => {
		const unresolved = unresolvedComponents(file);
		if (unresolved.length > 0)
			unplaceable.push(`${file} (${unresolved.join(", ")})`);
		else slots.push({ file });
	};
	const recordEnv = (env: Record<string, unknown> | undefined) => {
		for (const [name, value] of Object.entries(env ?? {}))
			recordAlias(aliases, name, String(value));
	};
	// `FOO=1`, then a keyword or runner prefix (`do`, `then`, `env`, `sudo`,
	// `time`), then possibly another assignment: the command is what remains,
	// so a `for ...; do cp ...; done` body is read as the `cp` it runs.
	const commandWords = (segment: string) => {
		let current = splitWords(segment);
		for (let round = 0; round < 3; round++) {
			const { env, rest } = stripEnvAssignments(current);
			for (const [name, value] of Object.entries(env))
				recordAlias(aliases, name, value);
			const stripped = stripCommandGroupAndRunnerPrefixes(rest);
			if (stripped.length === current.length) return stripped;
			current = stripped;
		}
		return current;
	};
	const scan = (text: string, depth: number) => {
		for (const region of scannableRegions(text))
			for (const segment of splitSegments(region)) {
				const words = commandWords(segment);
				const command = words.length > 0 ? commandBasename(words[0]) : "";
				const { operands, targets } = splitRedirects(words.slice(1));
				for (const target of targets)
					for (const expanded of expandWord(target, aliases))
						recordWrite(expanded);
				if (ADMITTED_WRITES.has(command)) {
					const written = writeSlots(command, operands, aliases);
					if (written.unplaced !== undefined)
						unplaceable.push(written.unplaced);
					for (const destination of written.destinations)
						if (unresolvedComponents(destination).length > 0)
							unplaceable.push(destination);
					for (const slot of written.slots) slots.push(slot);
				}
				if (
					depth > 0 &&
					ADMITTED_SHELLS.has(command) &&
					operands[0] === "-c" &&
					operands[1] !== undefined
				)
					scan(operands[1], depth - 1);
			}
	};
	recordEnv(job.env);
	for (const step of job.steps ?? []) {
		recordEnv(step.env);
		if (typeof step.run === "string") scan(step.run, 1);
	}
	return { slots, unplaceable };
}

/** An uploaded path entry's readable prefix, and whether it was cut short. */
type Root = { prefix: string; partial: boolean };

function uploadRoot(entry: string): Root {
	const kept: string[] = [];
	for (const part of entry.split("/")) {
		const unreadable =
			unreadablePart(part) ??
			(part.includes("${{")
				? "a workflow expression"
				: /[*?]/.test(part)
					? "a glob"
					: undefined);
		if (unreadable === undefined) {
			kept.push(part);
			continue;
		}
		const literal = part.split(/[$*?]/)[0];
		return literal.length > 0
			? { prefix: [...kept, literal].join("/"), partial: true }
			: { prefix: kept.join("/"), partial: false };
	}
	return { prefix: kept.join("/"), partial: false };
}

/** What `path` holds below `root`, or `undefined` when it is outside. */
function underRoot(root: Root, path: string): string | undefined {
	if (root.partial)
		return path.startsWith(root.prefix)
			? path.slice(root.prefix.length)
			: undefined;
	if (path === root.prefix) return "";
	return path.startsWith(`${root.prefix}/`)
		? path.slice(root.prefix.length + 1)
		: undefined;
}

function uploadPaths(step: ArtifactStep): string[] {
	const path = step.with?.path;
	const text = Array.isArray(path) ? path.join("\n") : String(path ?? "");
	return text
		.split("\n")
		.map((line) => symbolic(line).replace(/\/+$/, ""))
		.filter((line) => line.length > 0);
}

const isUpload = (step: ArtifactStep) =>
	typeof step.uses === "string" && step.uses.startsWith(UPLOAD_ARTIFACT);

/** Every `actions/upload-artifact` step a job of this file holds. */
function uploadSteps(workflow: ArtifactWorkflow): ArtifactStep[] {
	return Object.values(workflow.jobs ?? {}).flatMap((job) =>
		(job.steps ?? []).filter(isUpload),
	);
}

const hiddenKept = (step: ArtifactStep) =>
	String(step.with?.["include-hidden-files"]) === "true";

const uploadLabel = (step: ArtifactStep) =>
	typeof step.name === "string"
		? step.name
		: String(step.with?.name ?? "upload-artifact");

/**
 * One finding per upload step that drops a staged dot path, or whose staged
 * set the read grammar cannot place. Empty means every upload keeps what its
 * job stages.
 */
function hiddenUploadFindings(
	fileName: string,
	workflow: ArtifactWorkflow,
): string[] {
	const findings: string[] = [];
	// A composite action's steps run inside the CALLER's job, so its staged set
	// belongs to a file this one cannot read: an upload here is refused unless
	// it keeps hidden files (review round 1 F1 — `runs.steps` sat outside the
	// population while the scan claimed every `.github/actions/*/action.yml`).
	for (const upload of (workflow.runs?.steps ?? []).filter(isUpload))
		if (!hiddenKept(upload))
			findings.push(
				`${fileName}: runs.steps: ${uploadLabel(upload)}: an upload step inside a composite action is staged by its calling job, so whether it drops a dot path cannot be derived here; set include-hidden-files: true`,
			);
	for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
		const uploads = (job.steps ?? []).filter(isUpload);
		if (uploads.length === 0) continue;
		const { slots, unplaceable } = jobStaging(job);
		for (const upload of uploads) {
			const label = `${fileName}: ${jobName}: ${uploadLabel(upload)}`;
			const keySet = hiddenKept(upload);
			for (const entry of uploadPaths(upload)) {
				const root = uploadRoot(entry);
				if (root.prefix.length === 0) {
					findings.push(`${label}: cannot read the uploaded path ${entry}`);
					continue;
				}
				if (!keySet && landingVerdict(root.prefix) === "hidden")
					findings.push(
						`${label}: uploads ${root.prefix}, a dot path, without include-hidden-files: true`,
					);
				for (const slot of slots) {
					const relative = underRoot(root, slot.file);
					if (relative === undefined) continue;
					const verdict = landingVerdict(relative);
					if (verdict === "hidden" && !keySet)
						findings.push(
							`${label}: stages ${slot.file}, a dot path, without include-hidden-files: true`,
						);
					else if (verdict === "unknown" && !keySet)
						findings.push(
							`${label}: stages ${slot.file} from a value the scan cannot read, so whether the upload drops it cannot be derived; set include-hidden-files: true`,
						);
				}
				for (const write of unplaceable)
					findings.push(
						`${label}: cannot place the write ${write} against ${root.prefix}, so what the artifact holds cannot be derived`,
					);
			}
		}
	}
	return [...new Set(findings)];
}

describe("staged dot paths survive the artifact hand-off (#3952)", () => {
	it(
		"carries include-hidden-files on every upload step that stages a dot path",
		() => {
			const files = listSourceFiles(resolve(ROOT, ".github"), {
				extensions: [".yml", ".yaml"],
				exclude: (relative) =>
					!/^(workflows\/[^/]+|actions\/[^/]+\/action)\.ya?ml$/.test(relative),
			});
			assertNonEmptyScan("workflow files under .github", files.length, 10);
			const workflows = files.map((file) => ({
				name: relativePosix(ROOT, file),
				workflow: workflowDocument(
					readFileSync(file, "utf8"),
				) as ArtifactWorkflow,
			}));
			const uploads = workflows.flatMap(({ workflow }) =>
				uploadSteps(workflow),
			);
			assertNonEmptyScan("actions/upload-artifact steps", uploads.length, 10);

			const findings = workflows.flatMap(({ name, workflow }) =>
				hiddenUploadFindings(name, workflow),
			);

			expect(findings).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// The witness that the scan reads the real staging: the nightly's fragment
	// is a landed path of the `tool-smoke` job, so a scan that sees nothing
	// cannot pass the case above by accident.
	it("derives the promotion fragment the nightly stages", () => {
		const workflow = loadWorkflow() as ArtifactWorkflow;
		const staged = jobStaging(workflow.jobs?.["tool-smoke"] ?? {}).slots.map(
			(slot) => slot.file,
		);

		expect(staged).toContain(
			"$RUNNER_TEMP/pr-inputs/files/.changelog/3989-lsp-idle-eviction-promote.md",
		);
		expect(staged).toContain("$RUNNER_TEMP/pr-inputs/idle-eviction-promote.md");
	});

	const plant = (
		staging: string[],
		uploadPath: string | string[],
		extra: string[] = [],
	) =>
		[
			"jobs:",
			"  smoke:",
			"    steps:",
			"      - name: Stage the inputs",
			"        run: |",
			...staging.map((line) => `          ${line}`),
			"      - uses: actions/upload-artifact@v7",
			"        with:",
			"          name: pr-inputs",
			...(Array.isArray(uploadPath)
				? [
						"          path:",
						...uploadPath.map((line) => `            - ${line}`),
					]
				: [`          path: ${uploadPath}`]),
			...extra.map((line) => `          ${line}`),
		].join("\n");
	const findingsFor = (source: string) =>
		hiddenUploadFindings(
			"fixture.yml",
			workflowDocument(source) as ArtifactWorkflow,
		);
	const staged = (extra: string) =>
		`stage="$RUNNER_TEMP/pr-inputs"\nmkdir -p "$stage/files"\n${extra}`.split(
			"\n",
		);
	const ROOT_PATH = "${{ runner.temp }}/pr-inputs";

	it.each([
		{
			title: "a dot path copied with --parents",
			staging: staged('cp --parents .changelog/x.md "$stage/files/"'),
			expected: 1,
		},
		{
			title:
				"a dot path copied with --parents onto a directory named without a slash",
			staging: staged('cp --parents .changelog/x.md "$stage/files"'),
			expected: 1,
		},
		{
			title: "a dot path reached through another binding",
			staging: staged(
				'file=.changelog/x.md\ncp --parents "$file" "$stage/files/"',
			),
			expected: 1,
		},
		{
			title: "a dot path reached through an alias of the staging directory",
			staging: staged(
				'stage_alias="$stage"\ncp --parents .changelog/x.md "$stage_alias/files/"',
			),
			expected: 1,
		},
		{
			title: "a dot path inside a bash -c script",
			staging: staged(
				'bash -c \'cp --parents .changelog/x.md "$0/files/"\' "$stage"',
			),
			expected: 1,
		},
		{
			title: "a source the scan cannot read, landing under a staged directory",
			staging: staged('cp "$FROM_A_STEP_OUTPUT" "$stage/files/"'),
			expected: 1,
		},
		{
			title: "a destination the scan cannot place",
			staging: staged(
				'DEST="$(mktemp -d)"\ncp --parents .changelog/x.md "$DEST/files/"',
			),
			expected: 1,
		},
		{
			title: "an upload whose own path is hidden",
			staging: [
				'stage="$RUNNER_TEMP/.state"',
				'mkdir -p "$stage"',
				'printf "%s\\n" x > "$stage/a.txt"',
			],
			uploadPath: "${{ runner.temp }}/.state",
			expected: 1,
		},
		{
			// `rsync -a .changelog/ DEST/` copies the DIRECTORY'S CONTENTS and
			// really lands `DEST/x.md`; the no-trailing-slash spelling below is
			// the one that lands `.changelog/` (review round 1 F2).
			title: "a dot path staged by rsync, whose source is a directory",
			staging: staged('rsync -a .changelog "$stage/files/"'),
			expected: 1,
		},
		{
			// A slashless destination is read both as a file and as an existing
			// directory: the live step's own `mkdir -p "$stage/files"` makes it
			// one, and real cp lands `files/.changelog/x.md` (verify r4 R4-1).
			title: "a hidden directory copied onto a slashless destination",
			staging: staged('cp -a .changelog "$stage/files"'),
			expected: 1,
		},
		{
			title: "a hidden file copied onto a slashless destination",
			staging: staged('cp .gitkeep "$stage/files"'),
			expected: 1,
		},
		{
			title: "a hidden directory staged by rsync onto a slashless destination",
			staging: staged('rsync -a .changelog "$stage/files"'),
			expected: 1,
		},
		{
			// Two sources force a directory destination (CodeRabbit inline,
			// round 3 head).
			title: "two hidden sources copied onto a slashless destination",
			staging: staged('cp .a .b "$stage/files"'),
			expected: 2,
		},
		{
			title: "a plain file copied onto a slashless destination reads clean",
			staging: staged('cp README.md "$stage/files"'),
			expected: 0,
		},
		{
			title: "a dot path staged by install onto a hidden name",
			staging: staged('install .changelog/x.md "$stage/files/.changelog/x.md"'),
			expected: 1,
		},
		{
			title: "a dot path spelled with a leading ./",
			staging: staged('cp --parents ./.changelog/x.md "$stage/files/"'),
			expected: 1,
		},
		{
			title: "a dot path reached through a for-loop variable",
			staging: staged(
				'for f in .changelog/x.md; do cp --parents "$f" "$stage/files/"; done',
			),
			expected: 1,
		},
		{
			title: "a dot path under an upload path that holds a workflow expression",
			staging: [
				'stage="$RUNNER_TEMP/out-7"',
				'mkdir -p "$stage"',
				'cp --parents .changelog/y.md "$stage/"',
			],
			uploadPath: "${{ runner.temp }}/out-${{ matrix.part }}",
			expected: 1,
		},
		{
			title: "a dot path under one entry of a list-form upload path",
			staging: staged('cp --parents .changelog/x.md "$stage/files/"'),
			uploadPath: ["${{ runner.temp }}/elsewhere", ROOT_PATH],
			expected: 1,
		},
		{
			title: "the key set on the same staging",
			staging: staged('cp --parents .changelog/x.md "$stage/files/"'),
			expected: 0,
			extra: ["include-hidden-files: true"],
		},
		{
			title:
				"a dot path copied WITHOUT --parents, which lands only its basename",
			staging: staged('cp .changelog/x.md "$stage/files/"'),
			expected: 0,
		},
		{
			title: "a commented-out copy, which is prose and not a command",
			staging: staged('# cp --parents .changelog/x.md "$stage/files/"'),
			expected: 0,
		},
		{
			title: "a glob source, which pathname expansion never matches a dot name",
			staging: staged('cp --parents "$stage"/../*.md "$stage/files/"'),
			expected: 0,
		},
	])("classifies $title", ({ staging, expected, uploadPath, extra }) => {
		const findings = findingsFor(
			plant(staging, uploadPath ?? ROOT_PATH, extra ?? []),
		);

		expect(findings).toHaveLength(expected);
		if (expected > 0) expect(findings[0]).toContain("pr-inputs");
	});

	it("names the dropped path it found", () => {
		const findings = findingsFor(
			plant(staged('cp --parents .changelog/x.md "$stage/files/"'), ROOT_PATH),
		);

		expect(findings).toEqual([
			"fixture.yml: smoke: pr-inputs: stages $RUNNER_TEMP/pr-inputs/files/.changelog/x.md, a dot path, without include-hidden-files: true",
		]);
	});

	// Round 3: the gate admits a short list of standalone no-value option words
	// and refuses every other option word, so a spelling nobody planned reds
	// instead of being read as a flag while the real destination drops. Round 2
	// enumerated the destination spellings and each review found the next one:
	// `-Stmp` (round 3 N1), `--target-dir=` (N3), `rsync -R` (N5).
	it.each([
		[
			'cp --parents .changelog/x.md "$stage/files/" -t',
			"-t (an option the write grammar does not admit)",
		],
		[
			'cp --parents .changelog/x.md "$stage/files/" -S .bak',
			"-S (an option the write grammar does not admit)",
		],
	])("names the option it cannot place: %s", (staging, reason) => {
		const findings = findingsFor(plant(staged(staging), ROOT_PATH));

		expect(findings).toEqual([
			`fixture.yml: smoke: pr-inputs: cannot place the write ${reason} against $RUNNER_TEMP/pr-inputs, so what the artifact holds cannot be derived`,
		]);
	});

	// Every form below is one a real GNU tool accepts and this scan cannot
	// place; each must red rather than be skipped as an unknown flag.
	it.each([
		[
			"a -t destination before the sources",
			'cp --parents -t "$stage/files/" .changelog/x.md',
		],
		[
			"a -t destination named without a trailing slash",
			'cp --parents -t "$stage/files" .changelog/x.md',
		],
		[
			"a glued -t destination",
			'cp --parents -t"$stage/files/" .changelog/x.md',
		],
		[
			"a destination inside a short bundle",
			'cp --parents -rt "$stage/files/" .changelog/x.md',
		],
		[
			"a separated --target-directory value",
			'cp --parents --target-directory "$stage/files/" .changelog/x.md',
		],
		[
			"an attached --target-directory value",
			'cp --parents .changelog/x.md --target-directory="$stage/files/"',
		],
		[
			"a GNU long-option abbreviation",
			'cp --parents --target-dir="$stage/files/" .changelog/x.md',
		],
		[
			"a short bundle whose first letter takes the value",
			'cp -Stmp --parents .changelog/x.md "$stage/files/"',
		],
		[
			"a bundle install option",
			'install -Dm644 .changelog/x.md "$stage/files/.changelog/x.md"',
		],
		[
			"the end-of-options marker",
			'cp --parents -- .changelog/x.md "$stage/files/"',
		],
		[
			"rsync's path-preserving -R, spelled on its own",
			'rsync -a -R .changelog/x.md "$stage/files/"',
		],
		[
			"rsync's path-preserving -R inside a bundle",
			'rsync -aR .changelog/x.md "$stage/files/"',
		],
		[
			"a tee option outside its set",
			'printf x | tee --bogus-flag "$stage/files/.changelog/x.md"',
		],
		[
			"an option mv does not have",
			'mv -a .changelog/x.md "$stage/files/.changelog/x.md"',
		],
		[
			"install's destination-moving -t",
			'install -t "$stage/files/" .changelog/x.md',
		],
	])("refuses the option word it does not admit: %s", (_title, command) => {
		const findings = findingsFor(plant(staged(command), ROOT_PATH));

		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain("cannot place the write");
		expect(findings[0]).toContain("an option the write grammar does not admit");
	});

	// The state table for a copy source's basename (verify r5): a hidden name
	// lands a hidden slot, a plain file a plain one, and a plain directory's
	// unlisted children are the accepted residual. `.` and `..` copy a whole
	// directory, hidden entries included, so the write is refused.
	it.each([
		["the checkout root copied as a source", 'cp -a . "$stage/files"'],
		[
			"the checkout root spelled ./ onto a slashed destination",
			'cp -r ./ "$stage/files/"',
		],
		["a directory's contents spelled dir/.", 'cp -a src/. "$stage/files/"'],
		["a parent directory copied as a source", 'rsync -a .. "$stage/files/"'],
	])(
		"refuses a source whose contents it cannot list: %s",
		(_title, command) => {
			const findings = findingsFor(plant(staged(command), ROOT_PATH));

			expect(findings).toHaveLength(1);
			expect(findings[0]).toContain(
				"a source whose contents the scan cannot list",
			);
		},
	);

	// The admitted words, each pinned through a spelling whose placement is
	// visible: `--parents` keeps the dot path, so a flag that silently stopped
	// placement would read clean here.
	it.each(["-a", "-f", "-p", "-r", "-R"])(
		"admits the standalone no-value flag %s",
		(flag) => {
			const findings = findingsFor(
				plant(
					staged(`cp ${flag} --parents .changelog/x.md "$stage/files/"`),
					ROOT_PATH,
				),
			);

			expect(findings).toEqual([
				"fixture.yml: smoke: pr-inputs: stages $RUNNER_TEMP/pr-inputs/files/.changelog/x.md, a dot path, without include-hidden-files: true",
			]);
		},
	);

	// `rsync -R` is `--relative` and moves the landed path, so rsync admits only
	// the forms the census rows spell.
	it("admits the rsync form the census rows spell", () => {
		const findings = findingsFor(
			plant(staged('rsync -a .changelog "$stage/files/"'), ROOT_PATH),
		);

		expect(findings).toEqual([
			"fixture.yml: smoke: pr-inputs: stages $RUNNER_TEMP/pr-inputs/files/.changelog, a dot path, without include-hidden-files: true",
		]);
	});

	// Review round 1 F1: an upload inside a composite action is staged by its
	// CALLER's job, a file this scan cannot read, so the guard refuses it
	// instead of reading the uploaded root as clean. `.github/actions/*` is in
	// the walk, and a `runs.steps` upload was invisible to it.
	const compositePlant = (extra: string[] = []) =>
		[
			"name: Fixture action",
			"description: fixture",
			"runs:",
			"  using: composite",
			"  steps:",
			"    - name: Stage the inputs",
			"      shell: bash",
			'      run: cp --parents .changelog/x.md "$RUNNER_TEMP/pr-inputs/files/"',
			"    - uses: actions/upload-artifact@v7",
			"      with:",
			"        name: pr-inputs",
			`        path: ${ROOT_PATH}`,
			...extra.map((line) => `        ${line}`),
		].join("\n");

	it("refuses an upload a composite action hides from its caller", () => {
		const findings = findingsFor(compositePlant());

		expect(findings).toEqual([
			"fixture.yml: runs.steps: pr-inputs: an upload step inside a composite action is staged by its calling job, so whether it drops a dot path cannot be derived here; set include-hidden-files: true",
		]);
	});

	it("admits a composite action upload that sets the key", () => {
		expect(findingsFor(compositePlant(["include-hidden-files: true"]))).toEqual(
			[],
		);
	});
});

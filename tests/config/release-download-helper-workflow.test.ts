// Recurrence #5409 (2026-11-08): GitHub's release-download endpoint returned an
// intermittent `504 Gateway Time-out` for about an hour. Four CI steps fetched a
// pinned release on every run with `curl -sLO` and no `--fail` and no cache, so
// the 504 page was saved as the archive and failed its sha256 check. The lint
// jobs on #5396, #5398, #5406 and #5407 and master's TLA+ shards 3 and 4 (run
// 42465697187) went red with "checksum did NOT match", not "HTTP 504". Every
// release download now goes through one helper, `.github/actions/fetch-verified`.
//
// The gate reads the PARSED workflows, so a comment that quotes a download can
// neither satisfy nor trip it. It fails closed: a `releases/download` string it
// cannot place under a helper call with a literal url and sha256 is a violation.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowDocument } from "../../scripts/dispatch-safety.mjs";
import { TLA_TOOLS } from "../../scripts/check-tla-models.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");
const ACTIONS = resolve(ROOT, ".github/actions");
const HELPER_USES = "./.github/actions/fetch-verified";
const HELPER_FILE = join(ACTIONS, "fetch-verified/action.yml");
const HELPER_INPUTS = ["path", "sha256", "tool", "url", "version"];
const RELEASE_NEEDLE = "releases/download";
const RELEASE_URL =
	/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.+-]+\/[\w.+-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACTION_SHA_PIN = /^actions\/cache\/(restore|save)@[0-9a-f]{40}\b/;

type Step = {
	uses?: unknown;
	run?: unknown;
	if?: unknown;
	with?: Record<string, unknown>;
};
type Document = {
	jobs?: Record<string, { steps?: Step[] }>;
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
 * A `releases/download` string that is not the `url` of a helper call's
 * `with` block is a violation: a bare `curl`, a computed URL in a `run:`
 * block, or any other spelling the gate cannot place.
 */
export function releaseDownloadViolations(
	file: string,
	source: string,
): string[] {
	const doc = workflowDocument(source) as Document;
	const violations: string[] = [];
	for (const { path, value } of stringLeaves(doc)) {
		if (!value.includes(RELEASE_NEEDLE)) continue;
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
				`${where}: releases/download outside a ${HELPER_USES} call`,
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
	if (!restore)
		violations.push("no actions/cache/restore step pinned by full sha");
	else if (!keyOf(restore).includes("inputs.sha256"))
		violations.push("restore key is not keyed on inputs.sha256");
	if (!save) violations.push("no actions/cache/save step pinned by full sha");
	else {
		if (!keyOf(save).includes("inputs.sha256"))
			violations.push("save key is not keyed on inputs.sha256");
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
	if (/\|\|\s*true\b/.test(script) || /--status/.test(script))
		violations.push("the sha256 check must not be able to pass on a mismatch");
	const verify = script.indexOf('verify "$tmp"');
	const move = script.indexOf('mv "$tmp" "$DEST"');
	if (verify < 0 || move < 0 || verify > move)
		violations.push("the download must be verified before it moves into place");
	return violations;
}

function workflowSources(): Array<{ file: string; source: string }> {
	return readdirSync(WORKFLOWS)
		.filter((name) => name.endsWith(".yml"))
		.sort()
		.map((name) => ({
			file: `.github/workflows/${name}`,
			source: readFileSync(join(WORKFLOWS, name), "utf8"),
		}));
}

function actionSources(): Array<{ file: string; source: string }> {
	return readdirSync(ACTIONS)
		.sort()
		.map((name) => join(ACTIONS, name, "action.yml"))
		.filter((path) => existsSync(path))
		.map((path) => ({
			file: `.github/actions/${path.split(/[\\/]/).at(-2)}/action.yml`,
			source: readFileSync(path, "utf8"),
		}));
}

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

describe("release downloads go through the fetch-verified helper", () => {
	it("every releases/download URL under .github/workflows and .github/actions is a helper call's url", () => {
		const violations = [...workflowSources(), ...actionSources()].flatMap(
			({ file, source }) => releaseDownloadViolations(file, source),
		);
		expect(violations).toEqual([]);
	});

	it("every helper call passes the five inputs with a literal url and sha256", () => {
		const violations = [...workflowSources()].flatMap(({ file, source }) =>
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
});

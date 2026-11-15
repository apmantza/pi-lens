import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	readGateView,
	run,
} from "../../scripts/ci-verdict.mjs";

/**
 * #5629: PR #5623 (the nightly docs refresh, opened with the workflow token)
 * printed `every gating check concluded success` / `exit 0 (green)` on
 * 2026-11-15 while its merge stayed BLOCKED. The head's check-runs held every
 * required name, all green, posted by the `workflow_dispatch` runs of ci.yml,
 * lint.yml and hot-path-latency.yml; the PR's own statusCheckRollup (the view
 * GitHub's merge gate reads) listed only CodeRabbit and SonarCloud. Success now
 * also needs a concluded-success rollup entry for every required name.
 *
 * Every case drives the real CLI entry, `run()`, with a `gh` double that
 * replays RECORDED payloads (tests/fixtures/ci-verdict/pr-5623-*.json and
 * master-protection-2026-11-15.json, fetched from apmantza/pi-lens on
 * 2026-11-15). The rollup fixture is the two entries the issue reports; the
 * verdict-time rollup itself is not recoverable (the PR merged and was
 * reopened since).
 */

const FIXTURES = join(process.cwd(), "tests/fixtures/ci-verdict");
const read = (name: string) =>
	JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const CHECK_RUNS = read("pr-5623-dispatch-only-check-runs.json");
const ROLLUP = read("pr-5623-status-check-rollup.json").statusCheckRollup;
const PROTECTION = read("master-protection-2026-11-15.json");
const REQUIRED: string[] = PROTECTION.required_status_checks.contexts;
const SHA = "a8b53c80ffabac6703ad53d170080d5510fd8283";

const gateRow = (
	name: string,
	status = "COMPLETED",
	conclusion: string | null = "SUCCESS",
) => ({ __typename: "CheckRun", name, status, conclusion });
const allRequiredGreen = () => REQUIRED.map((name) => gateRow(name));

interface Probe {
	rollup: unknown[] | "throws";
	checkRuns?: unknown;
}

async function verdictFor(target: string, probe: Probe) {
	const lines: string[] = [];
	const ghExec = (args: string[]) => {
		if (args[0] === "repo") return "apmantza/pi-lens";
		if (args[0] === "pr" && args[1] === "view") {
			if (args[4] === "statusCheckRollup") {
				if (probe.rollup === "throws") throw new Error("HTTP 502");
				return JSON.stringify({ statusCheckRollup: probe.rollup });
			}
			if (args[4] === "headRefOid,labels,comments")
				return JSON.stringify({ headRefOid: SHA, labels: [], comments: [] });
			if (args[4] === "autoMergeRequest")
				return JSON.stringify({ autoMergeRequest: null });
			return JSON.stringify({
				headRefOid: SHA,
				mergeable: "MERGEABLE",
				author: { login: "app/github-actions", is_bot: true },
			});
		}
		if (args[0] === "api" && args[1] === "graphql")
			return JSON.stringify({
				data: {
					repository: {
						mergeQueue: null,
						pullRequest: { isInMergeQueue: false, mergeQueueEntry: null },
					},
				},
			});
		const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
		if (endpoint.endsWith("/branches/master/protection"))
			return JSON.stringify(PROTECTION);
		if (/\/check-runs/.test(endpoint))
			return JSON.stringify(probe.checkRuns ?? CHECK_RUNS);
		if (/\/actions\/runs/.test(endpoint))
			return JSON.stringify({ workflow_runs: [] });
		if (/\/check-suites/.test(endpoint))
			return JSON.stringify({ total_count: 0, check_suites: [] });
		throw new Error(`unmocked gh call: ${args.join(" ")}`);
	};
	const { code, kind } = await run({
		argv: [target],
		ghExec,
		stdout: (line: string) => lines.push(line),
		stderr: (line: string) => lines.push(`stderr: ${line}`),
		now: () => Date.parse("2026-11-15T14:30:00Z"),
		sleepImpl: async () => {},
	});
	return { code, kind, out: lines.join("\n") };
}

describe("ci-verdict gate view (#5629)", () => {
	it("is not green when the PR rollup lists none of the required names", async () => {
		const result = await verdictFor("5623", { rollup: ROLLUP });
		expect(result.code).toBe(EXIT_PENDING);
		expect(result.kind).toBe("pending");
		// Names every missing required check, and keeps the re-arm advice.
		for (const name of REQUIRED) expect(result.out).toContain(name);
		expect(result.out).toContain("absent from the PR's statusCheckRollup");
		expect(result.out).toContain("close and reopen the PR");
		expect(result.out).not.toContain("every gating check concluded success");
	});

	// Control (green on the base too): the issue's own acceptance fixture, a
	// head whose check-runs are the two non-required rows. The absent-required
	// branches already answered it; this pins them and the re-arm advice a
	// bot-authored PR with no ci.yml run gets.
	it("stays pending, naming every required check and the close/reopen advice, when the head holds only CodeRabbit and SonarCloud", async () => {
		const nonRequired = CHECK_RUNS.check_runs.filter(
			(row: { name: string }) => row.name === "CodeRabbit",
		);
		const result = await verdictFor("5623", {
			rollup: ROLLUP,
			checkRuns: { total_count: nonRequired.length, check_runs: nonRequired },
		});
		expect(result.code).toBe(EXIT_PENDING);
		for (const name of REQUIRED) expect(result.out).toContain(name);
		expect(result.out).toContain("required checks are absent");
		expect(result.out).toContain("close/reopen to re-arm ci.yml");
	});

	it("stays green when the PR rollup carries a concluded success for every required name", async () => {
		const result = await verdictFor("5623", { rollup: allRequiredGreen() });
		expect(result.code).toBe(EXIT_SUCCESS);
		expect(result.out).toContain("every gating check concluded success");
	});

	it("is pending, naming the check, when one required name is still running in the rollup", async () => {
		const rollup = allRequiredGreen().map((entry) =>
			entry.name === "knip" ? gateRow("knip", "IN_PROGRESS", null) : entry,
		);
		const result = await verdictFor("5623", { rollup });
		expect(result.code).toBe(EXIT_PENDING);
		expect(result.out).toContain(
			"not finished in the PR's statusCheckRollup: knip",
		);
	});

	it("fails when the rollup shows a required name red", async () => {
		const rollup = allRequiredGreen().map((entry) =>
			entry.name === "Unit tests"
				? gateRow("Unit tests", "COMPLETED", "FAILURE")
				: entry,
		);
		const result = await verdictFor("5623", { rollup });
		expect(result.code).toBe(EXIT_FAILURE);
		expect(result.out).toContain("Unit tests (failure)");
	});

	it("fails when a required name has one success entry and one red entry in the rollup", async () => {
		const result = await verdictFor("5623", {
			rollup: [
				...allRequiredGreen(),
				gateRow("Lint & type-check", "COMPLETED", "CANCELLED"),
			],
		});
		expect(result.code).toBe(EXIT_FAILURE);
		expect(result.out).toContain("Lint & type-check (cancelled)");
	});

	it("is pending, never green, when the rollup cannot be read", async () => {
		const result = await verdictFor("5623", { rollup: "throws" });
		expect(result.code).toBe(EXIT_PENDING);
		expect(result.out).toContain("could not read the PR's statusCheckRollup");
	});

	it("reads a required commit-status context by its state", async () => {
		const asStatus = (state: string) =>
			allRequiredGreen().map((entry) =>
				entry.name === "knip"
					? { __typename: "StatusContext", context: "knip", state }
					: entry,
			);
		expect(
			(await verdictFor("5623", { rollup: asStatus("SUCCESS") })).code,
		).toBe(EXIT_SUCCESS);
		expect(
			(await verdictFor("5623", { rollup: asStatus("PENDING") })).code,
		).toBe(EXIT_PENDING);
		expect(
			(await verdictFor("5623", { rollup: asStatus("FAILURE") })).code,
		).toBe(EXIT_FAILURE);
	});

	it("does not consult a PR rollup for a bare SHA, which has no PR gate to read", async () => {
		const result = await verdictFor(SHA, { rollup: "throws" });
		expect(result.code).toBe(EXIT_SUCCESS);
	});

	it("gives a failing check-run its own verdict before the rollup is read", () => {
		let reads = 0;
		const payload = {
			check_runs: CHECK_RUNS.check_runs.map((row: { name: string }) =>
				row.name === "knip" ? { ...row, conclusion: "failure" } : row,
			),
		};
		const verdict = computeVerdict(
			payload,
			REQUIRED,
			null,
			null,
			null,
			null,
			null,
			null,
			() => {
				reads += 1;
				return new Map();
			},
		);
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
		expect(reads).toBe(0);
	});

	it("parses the recorded rollup into per-name entries", () => {
		const view = readGateView("5623", () =>
			JSON.stringify({ statusCheckRollup: ROLLUP }),
		);
		expect(view?.get("CodeRabbit")).toEqual([
			{ status: "COMPLETED", conclusion: "SKIPPED" },
		]);
		expect(view?.get("knip")).toBeUndefined();
	});
});

/**
 * #3645 governance: the nightly idle-eviction measurement must cover the whole
 * server registry, and its artifact must be regenerated, compared and
 * reviewed like the other generated LSP docs.
 *
 * Recurrences this prevents:
 *  - #3622 widened a hand-written key-prefix regex from one server to four
 *    with no per-server evidence, so the eviction population was whatever a
 *    human remembered. The probe population is derived from `LSP_SERVERS`;
 *    this file is red if a registry server can go unmeasured without an
 *    admitted reason, or if a server the registry declares `transparent` sits
 *    vetoed in the committed measurement.
 *  - a nightly step added after the docs diff (or omitted from the refresh
 *    PR's `add-paths`) regenerates a document that nothing compares, the
 *    "lane edits lines its own run never exercised" class #3043 recorded.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import * as serverModule from "../../clients/lsp/server.js";
import { LSP_SERVERS } from "../../clients/lsp/server.js";
import {
	IDLE_EVICTION_DRIFT_TITLE,
	idleEvictionDrift,
	parseIdleEvictionDoc,
	RESULT_STATES,
} from "../../scripts/lib/lsp-idle-eviction-doc.mjs";
import {
	measureRegistry,
	probePopulation,
} from "../../scripts/lib/lsp-idle-eviction-probe.mjs";
import { GENERATED_LSP_DOCS } from "../../scripts/lib/md-matrix.mjs";
import { LSP_FIXTURES } from "../../scripts/smoke-tools.mjs";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const DOC = "docs/lsp-idle-eviction.md";

// Registry servers no smoke fixture routes to. An admission, not a silent gap:
// `omnisharp` is the `csharp` fallback, reachable only when csharp declines, and
// lsp-gate-population.test.ts already admits it until lane C (#3311) adds its
// fixture. The row reads `unavailable (no-fixture)` until then. Shrink-only: a
// fixture that starts routing to a server makes its admission stale and red.
const NO_FIXTURE_ADMISSIONS: Record<string, string> = {
	omnisharp:
		"csharp fallback with no smoke fixture yet; lane C (#3311) adds it and removes this row",
};

const stubProbe = async ({
	server,
}: {
	server: { id: string; idleEviction: string };
}) => ({
	serverId: server.id,
	declared: server.idleEviction,
	result: "unavailable" as const,
	reason: "tool-unavailable",
});

describe("idle-eviction probe population (#3645)", () => {
	it("yields a row for every exported LSPServerInfo, in registry order", async () => {
		const rows = await measureRegistry({
			registry: serverModule,
			fixtures: LSP_FIXTURES,
			budgetMs: Number.POSITIVE_INFINITY,
			now: () => 0,
			probe: stubProbe,
		});
		assertNonEmptyScan("idle-eviction probe population", rows.length, 40);
		expect(rows.map((r) => r.serverId)).toEqual(LSP_SERVERS.map((s) => s.id));
	});

	it("probes the registry's own objects, so arming one flips what the service reads", () => {
		const population = probePopulation(LSP_SERVERS, LSP_FIXTURES);
		expect(population).toHaveLength(LSP_SERVERS.length);
		population.forEach((entry, i) => {
			expect(entry.server).toBe(LSP_SERVERS[i]);
		});
	});

	it("gives a server added to the registry a row with no edit here", async () => {
		const added = {
			id: "brand-new-server",
			idleEviction: "unmeasured",
			extensions: [".brandnew"],
		};
		const rows = await measureRegistry({
			registry: { LSP_SERVERS: [...LSP_SERVERS, added] },
			fixtures: LSP_FIXTURES,
			budgetMs: Number.POSITIVE_INFINITY,
			now: () => 0,
			probe: stubProbe,
		});
		expect(rows.at(-1)?.serverId).toBe("brand-new-server");
		expect(rows).toHaveLength(LSP_SERVERS.length + 1);
	});

	it("discloses a server reached after the budget as a row, never omits it", async () => {
		let clock = 0;
		const rows = await measureRegistry({
			registry: serverModule,
			fixtures: LSP_FIXTURES,
			budgetMs: 10,
			now: () => clock,
			probe: async (entry) => {
				clock += 6;
				return stubProbe(entry);
			},
		});
		expect(rows).toHaveLength(LSP_SERVERS.length);
		expect(rows.slice(0, 2).map((r) => r.reason)).toEqual([
			"tool-unavailable",
			"tool-unavailable",
		]);
		expect(rows.slice(2).every((r) => r.reason === "budget-exhausted")).toBe(
			true,
		);
	});

	it("limits a filtered run to the named servers", async () => {
		const rows = await measureRegistry({
			registry: serverModule,
			fixtures: LSP_FIXTURES,
			filter: ["typescript", "python"],
			budgetMs: Number.POSITIVE_INFINITY,
			now: () => 0,
			probe: stubProbe,
		});
		expect(rows.map((r) => r.serverId)).toEqual(["typescript", "python"]);
	});

	// Review round 1 F2: every test above hands `measureRegistry` the registry, so
	// a script that sliced its own argument (`LSP_SERVERS.slice(0, 4)`) stayed
	// green while measuring four servers. The script cannot be imported (it runs
	// on load and spawns), so its population expression is pinned on
	// comment-and-string-blanked source: the walk is handed the registry module,
	// and the registry array is read in exactly two places, neither a slice.
	it("hands the nightly script's measurement the whole registry module, with no narrowed copy", () => {
		const blanked = stripSource(
			readFileSync(
				resolve(REPO_ROOT, "scripts/measure-lsp-idle-eviction.mjs"),
				"utf8",
			),
		);
		expect(blanked).toMatch(
			/measureRegistry\(\{\s*registry:\s*serverModule,\s*fixtures:\s*LSP_FIXTURES,\s*filter:\s*serverFilter,/,
		);
		const uses = (blanked.match(/[^\n]*\bLSP_SERVERS\b[^\n]*/g) ?? []).map(
			(line) => line.trim(),
		);
		expect(uses).toEqual([
			"const { LSP_SERVERS } = serverModule;",
			"const declared = new Map(LSP_SERVERS.map((s) => [s.id, s.idleEviction]));",
		]);
	});

	it("admits exactly the servers no fixture reaches, each with a reason", () => {
		const unreached = probePopulation(LSP_SERVERS, LSP_FIXTURES)
			.filter((entry) => entry.fixture === null)
			.map((entry) => entry.server.id)
			.sort();
		expect(unreached).toEqual(Object.keys(NO_FIXTURE_ADMISSIONS).sort());
		for (const [id, reason] of Object.entries(NO_FIXTURE_ADMISSIONS)) {
			expect(
				reason.trim().length,
				`${id} admission reason`,
			).toBeGreaterThanOrEqual(20);
		}
	});
});

describe("committed idle-eviction measurement (#3645)", () => {
	const text = readFileSync(resolve(REPO_ROOT, DOC), "utf8");
	const rows = parseIdleEvictionDoc(text);

	it("parses into per-server rows with a known result each", () => {
		expect(rows, `${DOC} has no per-server table`).not.toBeNull();
		assertNonEmptyScan("idle-eviction document rows", rows?.length ?? 0, 40);
		for (const row of rows ?? []) {
			expect(RESULT_STATES, `${row.serverId} result`).toContain(row.result);
		}
	});

	it("shows no server declared transparent that the measurement vetoes", () => {
		const declared = new Map(LSP_SERVERS.map((s) => [s.id, s.idleEviction]));
		const drift = idleEvictionDrift(
			(rows ?? []).map((r) => ({
				serverId: r.serverId,
				result: r.result as "eligible",
				reason: r.reason,
			})),
			declared,
		).filter((f) => f.severity === "drift");
		expect(drift).toEqual([]);
	});
});

describe("nightly wiring of the idle-eviction document (#3645)", () => {
	const workflow = yaml.load(
		readFileSync(
			resolve(REPO_ROOT, ".github/workflows/tool-smoke.yml"),
			"utf8",
		),
	) as {
		jobs: Record<
			string,
			{
				if?: string;
				"timeout-minutes"?: number;
				steps: Array<{
					id?: string;
					name?: string;
					if?: string;
					uses?: string;
					run?: string;
					"continue-on-error"?: boolean;
					"timeout-minutes"?: number;
					with?: Record<string, string>;
				}>;
			}
		>;
	};
	const job = workflow.jobs["tool-smoke"];
	const steps = job.steps;
	// #4077: the read-only smoke job regenerates and stages; the refresh PRs and
	// the tracking issue are written by their own guarded jobs.
	const prSteps = workflow.jobs["tool-smoke-prs"].steps;
	const notifySteps = workflow.jobs["tool-smoke-notify"].steps;
	const GUARD =
		"always() && (github.event_name == 'schedule' || github.ref == 'refs/heads/master')";
	const stageRun = (name: string) =>
		steps.find((s) => s.name === name)?.run ?? "";
	const measureAt = steps.findIndex((s) =>
		s.run?.includes("scripts/measure-lsp-idle-eviction.mjs"),
	);
	const diffAt = steps.findIndex((s) => s.id === "docs_diff");

	it("compares the document in the same diff step that compares the other generated docs", () => {
		expect(GENERATED_LSP_DOCS).toContain(DOC);
	});

	it("puts the document in the refresh PR's add-paths, matching the compared list exactly", () => {
		const step = prSteps.find((s) =>
			s.uses?.startsWith("peter-evans/create-pull-request"),
		);
		const addPaths = (step?.with?.["add-paths"] ?? "")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		expect([...addPaths].sort()).toEqual([...GENERATED_LSP_DOCS].sort());
	});

	// Recurrence: #4077, the PR job commits what the smoke job staged. A doc in
	// `add-paths` that the staging step does not copy is never in the PR's tree.
	it("stages every compared doc and every promotion path for the PR job", () => {
		const stage = stageRun("Stage the refresh-PR inputs");
		for (const doc of GENERATED_LSP_DOCS) expect(stage).toContain(doc);
		for (const path of [
			"clients/lsp/server.ts",
			"tests/config/lsp-idle-eviction-reasons.json",
			"tests/config/lsp-idle-eviction-registry.test.ts",
			".changelog/3989-lsp-idle-eviction-promote.md",
			"$RUNNER_TEMP/lsp-idle-eviction-promote.md",
		])
			expect(stage).toContain(path);
	});

	// Review round 1: the script defaulted to 780 s while the workflow passed 600.
	it("keeps the script's default budget equal to the one the nightly passes", () => {
		const scriptDefault = /flagValue\("--budget-seconds", "(\d+)"\)/.exec(
			readFileSync(
				resolve(REPO_ROOT, "scripts/measure-lsp-idle-eviction.mjs"),
				"utf8",
			),
		)?.[1];
		const passed = /--budget-seconds (\d+)/.exec(
			steps[measureAt].run ?? "",
		)?.[1];
		expect(scriptDefault).toBeDefined();
		expect(scriptDefault).toBe(passed);
	});

	it("regenerates the document before the diff step reads it", () => {
		expect(measureAt).toBeGreaterThanOrEqual(0);
		expect(diffAt).toBeGreaterThan(measureAt);
	});

	it("files the drift issue from the files the measurement step writes, and only on schedule or master", () => {
		const measure = steps[measureAt];
		const notify = notifySteps.find((s) =>
			s.name?.startsWith("Notify on idle-eviction drift"),
		) as (typeof steps)[number];
		expect(notify["continue-on-error"]).toBe(true);
		// A branch dispatch must not file or close issues: the writer job (shared
		// with the other tracking-issue writers) carries the scope.
		expect(workflow.jobs["tool-smoke-notify"].if).toBe(GUARD);
		for (const path of [
			"$RUNNER_TEMP/lsp-idle-eviction-drift.md",
			"$RUNNER_TEMP/lsp-idle-eviction-drift-state",
		]) {
			expect(measure.run, `measurement writes ${path}`).toContain(path);
			expect(notify.run, `notifier reads ${path}`).toContain(path);
		}
		// Recurrence: #4077, the staging glob must cover both files, or the writer
		// reads `missing` and leaves a drift issue untouched.
		const stage = stageRun("Stage the notifier inputs");
		expect(stage).toContain('"$RUNNER_TEMP"/lsp-idle-eviction-drift*');
		// The body handed to the issue CLI is the file the measurement wrote, not
		// merely a path the script happens to mention.
		expect(notify.run).toContain(
			'--body-file "$RUNNER_TEMP/lsp-idle-eviction-drift.md"',
		);
		expect(notify.run).toContain("scripts/upsert-tracking-issue.mjs");
		// Review round 1 F3: the issue closes on `clean` only (every transparent
		// server eligible), never on the mere absence of drift.
		expect((notify.run ?? "").match(/--clean\b/g)).toHaveLength(1);
		expect(notify.run).toMatch(
			/elif \[ "\$STATE" = clean \]; then\n\s*node scripts\/upsert-tracking-issue\.mjs[^\n]*--clean --close-when-clean/,
		);
		expect(notify.run).toContain(IDLE_EVICTION_DRIFT_TITLE);
	});

	// #3989 recurrences: (a) the promotion step placed after the docs diff would
	// advance the night memory in a doc nothing compares or commits, so the count
	// never survives a night; (b) a promotion edit added to the docs-refresh PR's
	// add-paths would break that PR's "changes no policy" promise; (c) a PR step
	// that is not draft, or not scoped to schedule/master, could open or arm a
	// policy change from a branch dispatch.
	it("advances the night memory before the docs diff, and opens a separate draft PR that commits only the declaration edit", () => {
		const promoteAt = steps.findIndex((s) => s.id === "idle_promote");
		expect(promoteAt).toBeGreaterThan(measureAt);
		expect(promoteAt).toBeLessThan(diffAt);
		const promote = steps[promoteAt];
		const docsPr = prSteps.find((s) =>
			s.uses?.startsWith("peter-evans/create-pull-request"),
		);
		expect(promote["continue-on-error"]).toBe(true);
		expect(promote.if).toBe(GUARD);
		for (const path of [
			"$RUNNER_TEMP/lsp-idle-eviction-summary.json",
			"$RUNNER_TEMP/lsp-idle-eviction-promote.md",
			"$RUNNER_TEMP/lsp-idle-eviction-rejected.txt",
		]) {
			expect(promote.run, `promotion reads/writes ${path}`).toContain(path);
		}
		// F4: the closed-PR listing is read-only and scoped to the promotion branch.
		// r3: `gh pr list --head` cannot take `<owner>:<branch>`, so a fork PR with the
		// same branch name would match; `--app github-actions` keeps the lookup to
		// the PRs the workflow's own token opened.
		expect(promote.run).toContain(
			"gh pr list --app github-actions --head bot/lsp-idle-evict-promote --state closed",
		);
		expect(promote.run).toContain(
			'--rejected "$RUNNER_TEMP/lsp-idle-eviction-rejected.txt"',
		);
		// r4: `--state closed` also returns MERGED PRs, so a merged promotion PR
		// would mark its servers rejected; only closed-unmerged counts.
		expect(promote.run).toContain("--json body,mergedAt");
		expect(promote.run).toContain("select(.mergedAt == null)");
		expect(steps[measureAt].run).toContain(
			"$RUNNER_TEMP/lsp-idle-eviction-summary.json",
		);

		const prs = prSteps.filter((s) =>
			s.uses?.startsWith("peter-evans/create-pull-request"),
		);
		const promotionPr = prs.find(
			(s) => s.with?.branch === "bot/lsp-idle-evict-promote",
		);
		expect(promotionPr, "promotion PR step").toBeDefined();
		expect(
			prSteps.indexOf(promotionPr as (typeof steps)[number]),
		).toBeGreaterThan(prSteps.indexOf(docsPr as (typeof steps)[number]));
		expect(promotionPr?.with?.branch).not.toBe(docsPr?.with?.branch);
		expect(String(promotionPr?.with?.draft)).toBe("true");
		expect(promotionPr?.if).toBe("needs.tool-smoke.outputs.promoted == 'true'");
		// Scoped to schedule or master by the job, so a branch dispatch cannot
		// open or arm a policy change.
		expect(workflow.jobs["tool-smoke-prs"].if).toContain(GUARD);
		expect(promotionPr?.["continue-on-error"]).toBe(true);
		expect(
			(promotionPr?.with?.["add-paths"] ?? "")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.sort(),
		).toEqual([
			".changelog/3989-lsp-idle-eviction-promote.md",
			"clients/lsp/server.ts",
			"tests/config/lsp-idle-eviction-reasons.json",
			"tests/config/lsp-idle-eviction-registry.test.ts",
		]);
		expect(promotionPr?.with?.["body-path"]).toContain(
			"idle-eviction-promote.md",
		);
		expect(promotionPr?.with?.token).toBe(docsPr?.with?.token);
	});

	it("keeps the measurement non-gating and bounded well under the job cap", () => {
		const step = steps[measureAt];
		expect(step["continue-on-error"]).toBe(true);
		const stepBound = step["timeout-minutes"];
		expect(stepBound).toBeDefined();
		// Earlier steps measured a 14m15s maximum (see the job's comment). The
		// step bound plus that maximum must leave at least five minutes.
		expect(14.25 + (stepBound as number)).toBeLessThanOrEqual(
			(job["timeout-minutes"] as number) - 5,
		);
	});
});

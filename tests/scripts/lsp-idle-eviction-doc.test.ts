/**
 * #3645: the durable artifact and the declared-versus-measured drift check.
 *
 * Recurrences these tests prevent:
 *  - a nightly artifact that changes on every run (raw or bucketed RSS and
 *    milliseconds) opens a refresh PR most nights and stops being reviewed;
 *    the document carries only stable columns, so two runs that differ only in
 *    timings and memory must render the same text (review round 1 F1);
 *  - a tracking issue that auto-closes because the measurement could not see
 *    (review round 1 F3): it closes only when every evicted server (any policy
 *    but resident, #5737) is eligible this run;
 *  - a coverage gap read as a clean zero: an unmeasured figure renders `n/a`,
 *    never `0`, and the header counts what was not measured;
 *  - a registry that evicts a server the measurement vetoes (the only `drift`),
 *    and its three inverse directions, which must NOT be drift.
 */
import { describe, expect, it } from "vitest";
import {
	buildIdleEvictionDriftBody,
	driftIssueState,
	IDLE_EVICTION_DRIFT_TITLE,
	idleEvictionDrift,
	parseIdleEvictionDoc,
	renderIdleEvictionDoc,
	renderRawTable,
	summarizeRows,
	type IdleEvictionRow,
} from "../../scripts/lib/lsp-idle-eviction-doc.mjs";
import { compareGeneratedDocs } from "../../scripts/lib/md-matrix.mjs";

const MB = 1024 * 1024;
const declared = new Map([
	["alpha", "transparent"],
	["bravo", "unmeasured"],
	["charlie", "resident"],
	["delta", "unmeasured"],
	["echo", "unmeasured"],
]);

const eligible = (serverId: string, extra: Partial<IdleEvictionRow> = {}) =>
	({
		serverId,
		role: "primary",
		result: "eligible",
		initMs: 2_000,
		rssBytes: 150 * MB,
		respawn: "ok",
		coldStartMs: 4_000,
		coverage: "preserved",
		...extra,
	}) as IdleEvictionRow;

describe("renderIdleEvictionDoc", () => {
	const rows: IdleEvictionRow[] = [
		eligible("bravo"),
		eligible("alpha"),
		{
			serverId: "delta",
			role: "primary",
			result: "unavailable",
			reason: "tool-unavailable",
		},
		{
			serverId: "echo",
			role: "primary",
			result: "unavailable",
			reason: "budget-exhausted",
		},
		{
			serverId: "charlie",
			role: "auxiliary",
			result: "vetoed",
			reason: "findings-narrowed",
			initMs: 1_500,
			rssBytes: null,
			respawn: "ok",
			coverage: "narrowed",
		},
	];
	const render = (r: IdleEvictionRow[], date = "2026-09-30") =>
		renderIdleEvictionDoc({ rows: r, declared, date, platform: "linux" });

	it("renders the same text for any row order", () => {
		expect(render([...rows].reverse())).toBe(render(rows));
	});

	it("renders identical text for two runs that differ only in timings and memory", () => {
		// Review round 1 F1: two back-to-back local runs flipped 7 of 30 bucket
		// cells (prisma init 5417 vs 592 ms), so no timing or memory figure may
		// reach the committed document, bucketed or not.
		const noisy = rows.map((r) =>
			r.result === "eligible" || r.result === "vetoed"
				? {
						...r,
						initMs: (r.initMs ?? 0) * 9 + 4_321,
						rssBytes: r.rssBytes === null ? null : (r.rssBytes ?? 0) * 7,
						coldStartMs: (r.coldStartMs ?? 0) * 13 + 77,
					}
				: r,
		);
		expect(render(noisy)).toBe(render(rows));
		expect(
			compareGeneratedDocs(render(noisy, "2026-10-01"), render(rows)),
		).toBe(false);
	});

	it("changes the text when a stable column changes", () => {
		const moved = rows.map((r) =>
			r.serverId === "alpha" ? { ...r, coverage: "narrowed" as const } : r,
		);
		expect(compareGeneratedDocs(render(moved), render(rows))).toBe(true);
	});

	it("discloses measured, vetoed, inconclusive, unavailable and budget-unreached counts", () => {
		expect(render(rows)).toContain(
			"5 registry servers: 2 eligible, 1 vetoed, 0 inconclusive, 2 unavailable (1 not reached: budget)",
		);
		expect(summarizeRows(rows)).toEqual({
			total: 5,
			eligible: 2,
			vetoed: 1,
			inconclusive: 0,
			unavailable: 2,
			budget: 1,
		});
	});

	it("renders unmeasured cells as n/a and never as zero", () => {
		const doc = render(rows);
		const delta = doc.split("\n").find((l) => l.startsWith("| delta |"));
		expect(delta).toBe(
			"| delta | primary | unmeasured | unavailable | tool-unavailable | n/a | n/a |",
		);
		const charlie = doc.split("\n").find((l) => l.startsWith("| charlie |"));
		expect(charlie).toBe(
			"| charlie | auxiliary | resident | vetoed | findings-narrowed | ok | narrowed |",
		);
	});

	it("round-trips the per-server rows through the parser", () => {
		expect(parseIdleEvictionDoc(render(rows))).toEqual([
			{
				serverId: "alpha",
				role: "primary",
				declared: "transparent",
				result: "eligible",
				reason: undefined,
				respawn: "ok",
				coverage: "preserved",
			},
			{
				serverId: "bravo",
				role: "primary",
				declared: "unmeasured",
				result: "eligible",
				reason: undefined,
				respawn: "ok",
				coverage: "preserved",
			},
			{
				serverId: "charlie",
				role: "auxiliary",
				declared: "resident",
				result: "vetoed",
				reason: "findings-narrowed",
				respawn: "ok",
				coverage: "narrowed",
			},
			{
				serverId: "delta",
				role: "primary",
				declared: "unmeasured",
				result: "unavailable",
				reason: "tool-unavailable",
				respawn: "n/a",
				coverage: "n/a",
			},
			{
				serverId: "echo",
				role: "primary",
				declared: "unmeasured",
				result: "unavailable",
				reason: "budget-exhausted",
				respawn: "n/a",
				coverage: "n/a",
			},
		]);
		expect(parseIdleEvictionDoc("# nothing here\n")).toBeNull();
	});

	it("keeps the raw figures out of the document and in the raw table", () => {
		expect(render(rows)).not.toContain("2000");
		expect(renderRawTable(rows)).toContain(
			"| alpha | eligible | · | 2000 | 150 | 4000 |",
		);
		expect(renderRawTable(rows)).toContain(
			"| charlie | vetoed | findings-narrowed | 1500 | n/a | n/a |",
		);
	});
});

describe("idleEvictionDrift", () => {
	const row = (
		serverId: string,
		result: IdleEvictionRow["result"],
		reason?: string,
	) => ({ serverId, result, reason }) as IdleEvictionRow;
	const kinds = (rows: IdleEvictionRow[]) =>
		idleEvictionDrift(rows, declared).map(
			(f) => `${f.serverId}:${f.kind}:${f.severity}`,
		);

	it("flags a transparent server the measurement vetoes as drift, for either veto reason", () => {
		expect(kinds([row("alpha", "vetoed", "respawn-failed")])).toEqual([
			"alpha:transparent-vetoed:drift",
		]);
		expect(kinds([row("alpha", "vetoed", "findings-narrowed")])).toEqual([
			"alpha:transparent-vetoed:drift",
		]);
	});

	it("does not call a transparent server drift when it is eligible", () => {
		expect(kinds([row("alpha", "eligible")])).toEqual([]);
	});

	it("reports a transparent server with no evidence this run as info, not drift", () => {
		expect(kinds([row("alpha", "unavailable", "tool-unavailable")])).toEqual([
			"alpha:transparent-unverified:info",
		]);
		expect(kinds([row("alpha", "inconclusive", "no-baseline")])).toEqual([
			"alpha:transparent-unverified:info",
		]);
	});

	// #5700: the registry evicts an `unmeasured` server too, so a measured veto
	// of one is shipped behaviour breaking on respawn: drift, not a proposal.
	it("proposes an unmeasured server that is eligible, and calls one that is vetoed drift (#5700)", () => {
		expect(kinds([row("bravo", "eligible")])).toEqual([
			"bravo:unmeasured-eligible:proposal",
		]);
		expect(kinds([row("bravo", "vetoed", "respawn-failed")])).toEqual([
			"bravo:unmeasured-vetoed:drift",
		]);
	});

	it("says nothing about an unmeasured server with no evidence", () => {
		expect(
			kinds([
				row("bravo", "unavailable", "no-fixture"),
				row("delta", "inconclusive", "not-evicted"),
			]),
		).toEqual([]);
	});

	it("notes a resident server that measures eligible but never calls resident-vetoed drift", () => {
		expect(kinds([row("charlie", "eligible")])).toEqual([
			"charlie:resident-eligible:info",
		]);
		expect(kinds([row("charlie", "vetoed", "respawn-failed")])).toEqual([]);
	});

	it("ignores a server the registry no longer declares", () => {
		expect(kinds([row("ghost", "vetoed", "respawn-failed")])).toEqual([]);
	});

	it("puts the findings, or an explicit none, in the rendered document", () => {
		const clean = renderIdleEvictionDoc({
			rows: [],
			declared,
			date: "2026-09-30",
			platform: "linux",
		});
		expect(clean).toContain(
			"No divergence between declared policy and this run's measurement.",
		);
		const drifted = renderIdleEvictionDoc({
			rows: [row("alpha", "vetoed", "respawn-failed")],
			declared,
			date: "2026-09-30",
			platform: "linux",
		});
		expect(drifted).toContain(
			"- **alpha** [drift] declared transparent but the measurement vetoes it (respawn-failed)",
		);
	});
});

describe("buildIdleEvictionDriftBody", () => {
	const finding = (
		serverId: string,
		severity: "drift" | "proposal" | "info",
	) => ({
		serverId,
		kind: "k",
		severity,
		detail: `${serverId} detail`,
	});

	it("is null unless a server is in hard drift, so proposals and notes never file an issue", () => {
		expect(buildIdleEvictionDriftBody([])).toBeNull();
		expect(
			buildIdleEvictionDriftBody([
				finding("a", "proposal"),
				finding("b", "info"),
			]),
		).toBeNull();
	});

	it("names each drifting server and only those, with the run link", () => {
		const body = buildIdleEvictionDriftBody(
			[finding("a", "drift"), finding("b", "proposal"), finding("c", "drift")],
			{ runUrl: "https://example.test/run/1" },
		);
		expect(body).toContain("- **a**: a detail");
		expect(body).toContain("- **c**: c detail");
		expect(body).not.toContain("**b**");
		expect(body).toContain("Workflow run: https://example.test/run/1");
		expect(body).toContain("closed automatically");
	});

	// #5667 review Q4: the drift issue reads the MEASURED rows, while the doc
	// shows the prior row until two nights agree, so a first-night veto must not
	// send the reader to a doc row that contradicts the issue.
	it("says the doc shows the prior row while a change is pending and points at the raw measurement", () => {
		const body = buildIdleEvictionDriftBody([finding("a", "drift")]) ?? "";
		expect(body).toContain("two nights agree");
		expect(body).toContain("step log");
		expect(body).not.toContain("The per-server rows are in");
	});

	it("keeps a stable title, because the tracking issue is found by exact title", () => {
		expect(IDLE_EVICTION_DRIFT_TITLE).toBe(
			"nightly: LSP idle-eviction drift (declared transparent, measured vetoed)",
		);
	});
});

describe("driftIssueState", () => {
	const row = (
		serverId: string,
		result: IdleEvictionRow["result"],
		reason?: string,
	) => ({ serverId, result, reason }) as IdleEvictionRow;
	const transparent = new Map([
		["alpha", "transparent"],
		["bravo", "transparent"],
		["charlie", "unmeasured"],
	]);
	const state = (rows: IdleEvictionRow[]) => driftIssueState(rows, transparent);

	it("is clean only when every evicted server (transparent or unmeasured) is eligible", () => {
		expect(
			state([
				row("alpha", "eligible"),
				row("bravo", "eligible"),
				row("charlie", "eligible"),
			]),
		).toBe("clean");
	});

	// #5737 (thread X): an unmeasured server is evicted too, so unavailable
	// evidence for it is no evidence either way, and the issue is left alone.
	// Recurrence: the rule read only `transparent`, so an unmeasured server that
	// the nightly could not start (`server-not-started`) let the issue close.
	it("is unknown, never clean, when an unmeasured server is unavailable (#5737)", () => {
		expect(
			state([
				row("alpha", "eligible"),
				row("bravo", "eligible"),
				row("charlie", "unavailable", "server-not-started"),
			]),
		).toBe("unknown");
	});

	// #5737 (thread X): the nightly writes no row for a server it did not reach.
	// Recurrence: an unmeasured server absent from the run closed the issue as
	// `clean`, the same closing on absence of evidence that F3 forbids.
	it("is unknown, never clean, when an unmeasured server has no row this run (#5737)", () => {
		expect(state([row("alpha", "eligible"), row("bravo", "eligible")])).toBe(
			"unknown",
		);
	});

	// #5700: an `unmeasured` server is evicted too, so its veto is drift.
	it("is drift when an unmeasured server is vetoed (#5700)", () => {
		expect(
			state([
				row("alpha", "eligible"),
				row("bravo", "eligible"),
				row("charlie", "vetoed", "respawn-failed"),
			]),
		).toBe("drift");
	});

	it("is drift when any transparent server is vetoed, even if the others are eligible", () => {
		expect(
			state([
				row("alpha", "eligible"),
				row("bravo", "vetoed", "respawn-failed"),
			]),
		).toBe("drift");
	});

	it.each([
		["unavailable", "tool-unavailable"],
		["unavailable", "budget-exhausted"],
		["inconclusive", "client-died"],
		["inconclusive", "not-evicted"],
		["inconclusive", "no-baseline"],
	] as const)(
		"is unknown, never clean, when a transparent server is %s (%s)",
		(result, reason) => {
			expect(
				state([row("alpha", "eligible"), row("bravo", result, reason)]),
			).toBe("unknown");
		},
	);

	it("is unknown when a transparent server has no row at all, as in a filtered run", () => {
		expect(state([row("alpha", "eligible")])).toBe("unknown");
	});
});

describe("widened disclosure", () => {
	const eligibleRow = (widened?: number) =>
		({
			serverId: "alpha",
			result: "eligible",
			coverage: "preserved",
			...(widened ? { widened } : {}),
		}) as IdleEvictionRow;

	it("is an info finding for an eligible server that reported extra findings after the respawn", () => {
		const findings = idleEvictionDrift([eligibleRow(2)], declared).filter(
			(f) => f.kind === "widened",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ serverId: "alpha", severity: "info" });
		expect(findings[0].detail).toContain("2 more finding(s)");
	});

	it("is absent when nothing widened, and never a drift", () => {
		expect(
			idleEvictionDrift([eligibleRow()], declared).filter(
				(f) => f.kind === "widened",
			),
		).toEqual([]);
		expect(
			idleEvictionDrift([eligibleRow(3)], declared).some(
				(f) => f.severity === "drift",
			),
		).toBe(false);
	});

	it("stays out of the committed document, because it flaps between runs", () => {
		const doc = renderIdleEvictionDoc({
			rows: [eligibleRow(2)],
			declared,
			date: "2026-09-30",
			platform: "linux",
		});
		expect(doc).not.toContain("widened) ");
		expect(doc).not.toContain("more finding(s)");
		expect(doc).toContain("`preserved` on\nseveral nights");
	});
});

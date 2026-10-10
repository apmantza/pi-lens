// #3217 recurrence guard: 43 LSP fixtures were added to
// `scripts/smoke-tools.mjs` between #2780 (which built the nightly clean gate)
// and 2026-09-18 WITHOUT gate coverage — nightly run 35334544752 drove the real
// `lsp_diagnostics` handler for 7 servers out of ~50 while the other ~43 only
// had to complete an `initialize` handshake. That is the exact hole #2776
// (provenance) walked through: it passed the handshake layer and shipped.
// Nothing in the repo noticed, because opting in was a per-fixture flag with no
// counterpart asserting the flag was considered.
//
// This file makes the decision explicit and mandatory: every fixture the gate
// COULD drive carries either `lspGate: true` or an `lspGateExempt: "<reason>"`,
// so a new fixture cannot silently join the handshake-only population.
//
// It reads the fixture table as DATA (`import { LSP_FIXTURES }`) rather than
// scanning `smoke-tools.mjs` as text, so no comment, string literal or
// commented-out block can satisfy any assertion here (#3217 F5 — the
// "detectors match code, not prose" screen, satisfied structurally instead of
// by comment-and-string blanking).
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import {
	formatGateCensus,
	LSP_DIAGNOSTICS_WAIT_MS,
	LSP_FIXTURES,
	lensFullPopulation,
	lspGatePopulation,
} from "../../scripts/smoke-tools.mjs";
import { LSP_SERVERS } from "../../clients/lsp/server.js";
import { SERVER_DIAGNOSTIC_STRATEGIES } from "../../clients/lsp/wait-policy/strategies.js";

type Fixture = (typeof LSP_FIXTURES)[number] & {
	lspGate?: boolean;
	lspGateMarker?: string;
	lspGateExempt?: string;
	lensFull?: boolean;
	setup?: string | string[];
	serverId?: string;
	expectServerId?: string;
	disableServers?: string[];
	clean?: boolean;
	auxiliaryServerIds?: string[];
};

type FallbackAdmission = {
	serverId: string;
	reason: string;
	until: string;
};

// #3391 review r1: OmniSharp is registered as a fallback but has no committed
// smoke fixture yet. This is an admission, not a silent gap: lane C (#3311)
// owns adding the fixture and must remove this row in the same change.
const FALLBACK_ADMISSIONS: readonly FallbackAdmission[] = [
	{
		serverId: "omnisharp",
		reason: "no smoke fixture yet; lane C (#3311) adds it",
		until: "#3311 lane C",
	},
];

function fallbackPopulationIssues(
	fixtures: readonly Fixture[],
	servers: readonly Pick<(typeof LSP_SERVERS)[number], "id" | "fallbackFor">[],
	admissions: readonly FallbackAdmission[],
): string[] {
	const pairs = servers
		.filter((server) => server.fallbackFor)
		.map((server) => [server.fallbackFor!, server.id] as const);
	const familyIds = new Set(pairs.flat());
	const labeled = fixtures.filter((fixture) =>
		familyIds.has(fixture.serverId ?? ""),
	);
	const labeledIds = new Set(labeled.map((fixture) => fixture.serverId));
	const admissionIds = new Set(
		admissions.map((admission) => admission.serverId),
	);
	const issues: string[] = [];

	for (const fixture of fixtures) {
		if (!fixture.serverId && familyIds.has(fixture.expectServerId ?? "")) {
			issues.push(`${fixture.lang} is an unlabelled fallback-family row`);
		}
	}
	for (const admission of admissions) {
		if (!familyIds.has(admission.serverId)) {
			issues.push(`${admission.serverId} admission is not a fallback member`);
		} else if (labeledIds.has(admission.serverId)) {
			issues.push(
				`${admission.serverId} admission is stale; fixture is present`,
			);
		}
		if (admission.reason.trim().length < 20 || !admission.until.trim()) {
			issues.push(`${admission.serverId} admission lacks reason or expiry`);
		}
	}
	for (const id of familyIds) {
		if (!labeledIds.has(id) && !admissionIds.has(id)) {
			issues.push(`${id} is neither pinned by a fixture nor admitted`);
		}
	}
	const expectedLabeledCount = familyIds.size - admissionIds.size;
	if (labeled.length !== expectedLabeledCount) {
		issues.push(
			`fallback fixture count ${labeled.length} !== registry members minus admissions ${expectedLabeledCount}`,
		);
	}
	return issues;
}

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const fixtures = LSP_FIXTURES as Fixture[];

describe("LSP clean-gate population (#3217)", () => {
	it("gives every gate-eligible fixture exactly one of lspGate / lspGateExempt", () => {
		const { eligible } = lspGatePopulation() as { eligible: Fixture[] };
		// A floor, not a pin: if the fixture table or the eligibility filter ever
		// yields (almost) nothing, every assertion below passes on an empty set
		// and the guard reads clean while covering nothing. 45 eligible fixtures
		// on 2026-09-24 (28 gated, 17 exempt); the floor is deliberately well under
		// that so ordinary fixture churn never touches it.
		assertNonEmptyScan("LSP gate-eligible fixtures", eligible.length, 30);
		const undecided = eligible
			.filter(
				(fixture) =>
					fixture.lspGate !== true && typeof fixture.lspGateExempt !== "string",
			)
			.map((fixture) => fixture.lang);
		expect(
			undecided,
			"fixtures with neither lspGate nor lspGateExempt",
		).toEqual([]);

		const both = eligible
			.filter(
				(fixture) =>
					fixture.lspGate === true && typeof fixture.lspGateExempt === "string",
			)
			.map((fixture) => fixture.lang);
		expect(both, "fixtures claiming both opt-in and exemption").toEqual([]);
	});

	// #2780: the nightly `lens_diagnostics mode=full` row drives exactly one
	// cheap fixture. It is a verdict-shaping probe, not a per-server matrix, so
	// a second opt-in would silently turn it into one; and it must stay
	// gate-eligible because the row requires a primary finding on a seeded
	// defect, which is what the gated marker assertion above already proves.
	it("pins the single lens_diagnostics mode=full fixture", () => {
		const lensFull = lensFullPopulation() as Fixture[];
		expect(lensFull.map((fixture) => fixture.lang)).toEqual(["typescript"]);
		expect(lensFull[0].lspGate).toBe(true);
	});

	// #2780's own guard, carried over from the deleted
	// tests/scripts/smoke-tools-lsp-gate-fixtures.test.ts: a fixture with no
	// seeded defect (`clean: true`) or one whose contract is an AUXILIARY
	// server's finding must never be asked for a PRIMARY finding.
	it("keeps clean and auxiliary fixtures out of the gate entirely", () => {
		const wronglyGated = fixtures
			.filter(
				(fixture) =>
					fixture.lspGate === true &&
					(fixture.clean === true ||
						(fixture.auxiliaryServerIds?.length ?? 0) > 0),
			)
			.map((fixture) => fixture.lang);
		expect(wronglyGated).toEqual([]);
	});

	// #3217 F2 (the #3278 / ADR 0009 attribution class in miniature): a marker
	// that is not literally in the file it names cannot be removed to prove the
	// red direction, so the gate row would be unfalsifiable.
	it("requires every opted-in fixture's marker to be present in its own source", () => {
		const { gated } = lspGatePopulation() as { gated: Fixture[] };
		expect(gated.length).toBeGreaterThan(0);
		for (const fixture of gated) {
			expect(fixture.lspGateMarker, fixture.lang).toBeTruthy();
			const source = readFileSync(
				path.join(repoRoot, fixture.dir, fixture.file),
				"utf8",
			);
			expect(source, fixture.lang).toContain(fixture.lspGateMarker);
		}
	});

	it("requires every exemption to state a reason, not just carry the key", () => {
		const { exempt } = lspGatePopulation() as { exempt: Fixture[] };
		for (const fixture of exempt) {
			expect(
				(fixture.lspGateExempt ?? "").trim().length,
				`${fixture.lang} exemption reason`,
			).toBeGreaterThanOrEqual(20);
		}
	});

	// #3311 lane B recurrence: a fixture-local dependency must be prepared in
	// the copied scratch workspace before the server is touched. Pin the five
	// intended lane-B consumers so a future row cannot silently regain a
	// server-property exemption or add an ad-hoc script. The pre-existing TS7
	// setup rows are a separate native-server fixture contract.
	it("keeps lane B setup on exactly the five scaffolded servers", () => {
		const laneB = ["csharp", "elixir", "expert", "fsharp", "vue"];
		for (const lang of laneB) {
			const fixture = fixtures.find((candidate) => candidate.lang === lang)!;
			expect(
				fixture.setup,
				`${lang} must use the shared setup hook`,
			).toBeTruthy();
			expect(
				fixture.lspGate === true || typeof fixture.lspGateExempt === "string",
				`${lang} must be gated or carry a measured exemption`,
			).toBe(true);
			expect(
				fixture.lspGateMarker,
				`${lang} must retain a removable seed`,
			).toBeTruthy();
		}
	});

	// #3402 r2 recurrence: four servers were given `aggregateWaitMs: 8000`
	// because that is the number this gate passes as `waitMs` — but `waitMs` is a
	// CEILING over each server's own budget (`clients/lsp/index.ts`
	// `perServerTimeout`), never a floor, and `lsp_diagnostics` leaves it
	// undefined by default, so the strategy value is what an ordinary production
	// call pays in full on a file the server never publishes for. A budget above
	// this ceiling is therefore unwitnessable here AND unbounded there: the gate
	// would clip it while every uncapped production call paid it. Keeping the
	// declared budgets at or under the number this harness actually grants is what
	// makes "the nightly proved this budget" a true sentence.
	it("declares no diagnostic budget the gate itself cannot grant (#3402)", () => {
		const entries = Object.entries(SERVER_DIAGNOSTIC_STRATEGIES);
		expect(entries.length).toBeGreaterThan(0);
		for (const [serverId, strategy] of entries) {
			expect(
				strategy.aggregateWaitMs,
				`${serverId}: aggregateWaitMs (${strategy.aggregateWaitMs}) exceeds the ` +
					`gate's own waitMs ceiling (${LSP_DIAGNOSTICS_WAIT_MS}), so this gate ` +
					`can never observe that budget while production pays it in full`,
			).toBeLessThanOrEqual(LSP_DIAGNOSTICS_WAIT_MS);
		}
	});

	it("keeps the Vue gate fixture project-shaped for Volar", () => {
		// M-3402-1 recurrence: a ready Volar server with no publish was first
		// classified as a server property, but the fixture had no tsconfig project.
		const vue = fixtures.find((fixture) => fixture.lang === "vue")!;
		const config = JSON.parse(
			readFileSync(path.join(repoRoot, vue.dir, "tsconfig.json"), "utf8"),
		) as {
			include?: string[];
			compilerOptions?: { plugins?: Array<{ name?: string }> };
			vueCompilerOptions?: Record<string, unknown>;
		};
		expect(config.include).toContain("App.vue");
		expect(config.compilerOptions?.plugins).toContainEqual({
			name: "@vue/typescript-plugin",
		});
		expect(config.vueCompilerOptions).toBeDefined();
	});

	// #3217 F7: `java` and `java-lombok` are two fixtures over one server
	// (jdtls). A duplicated `lang` would let one server be counted twice in the
	// census line below, or let a fixture be edited while its twin silently
	// kept the old flag.
	it("keys every fixture by a unique lang", () => {
		const langs = fixtures.map((fixture) => fixture.lang);
		expect(langs).toEqual([...new Set(langs)]);
	});

	// #3217 F6: the nightly's `gated N / handshake-only M / unavailable K` line
	// is derived from the same population helper the runner selects with, so the
	// three counts must partition the eligible population exactly. A count
	// computed independently of the table is how a summary line drifts from the
	// matrix rows it claims to summarize.
	it("prints a census whose counts partition the eligible population", () => {
		const population = lspGatePopulation() as {
			eligible: Fixture[];
			gated: Fixture[];
			exempt: Fixture[];
		};
		const rows = population.gated.map((fixture, index) => ({
			lang: fixture.lang,
			state: index === 0 ? "skip" : "pass",
		}));
		const line = formatGateCensus(population, rows);
		const match =
			/gated (\d+) \/ handshake-only (\d+) \/ unavailable (\d+)/.exec(line);
		expect(match, line).not.toBeNull();
		const [gated, handshakeOnly, unavailable] = match!
			.slice(1)
			.map((value) => Number(value));
		expect(unavailable).toBe(1);
		expect(gated).toBe(population.gated.length - 1);
		expect(handshakeOnly).toBe(population.exempt.length);
		expect(gated + handshakeOnly + unavailable).toBe(
			population.eligible.length,
		);
	});

	// #3391 recurrence guard: when a primary server is unavailable, its
	// fallback can answer the handshake and produce a false green unless every
	// fixture in a fallback family pins the server identity it intends to test.
	it("pins the identity of every fixture in a fallback-server family", () => {
		const fallbackPairs = LSP_SERVERS.filter(
			(server) => server.fallbackFor,
		).map((server) => [server.fallbackFor!, server.id] as const);
		const fallbackIds = new Set(fallbackPairs.flat());
		const familyFixtures = fixtures.filter((fixture) =>
			fallbackIds.has(fixture.serverId ?? ""),
		);
		expect(
			fallbackPopulationIssues(fixtures, LSP_SERVERS, FALLBACK_ADMISSIONS),
		).toEqual([]);
		expect(familyFixtures).toHaveLength(
			fallbackIds.size - FALLBACK_ADMISSIONS.length,
		);
		for (const fixture of familyFixtures) {
			expect(fixture.expectServerId, `${fixture.lang} expected server`).toBe(
				fixture.serverId,
			);
			// The preferred Docker fixture deliberately leaves its fallback
			// enabled now that fallback-family grouping is measured separately;
			// acquisition still launches only the preferred member when it works.
			if (fixture.lang === "dockerfile") continue;
			expect(
				fixture.disableServers,
				`${fixture.lang} must disable fallback siblings`,
			).toEqual(
				fallbackPairs
					.filter(([primary, fallback]) =>
						[primary, fallback].includes(fixture.serverId!),
					)
					.map(([primary, fallback]) =>
						fixture.serverId === primary ? fallback : primary,
					),
			);
		}
	});

	it("rejects an unlabelled fallback-family row", () => {
		const unlabelled = fixtures.map((fixture) =>
			fixture.lang === "elixir" ? { ...fixture, serverId: undefined } : fixture,
		);
		expect(
			fallbackPopulationIssues(unlabelled, LSP_SERVERS, FALLBACK_ADMISSIONS),
		).toEqual([
			"elixir is an unlabelled fallback-family row",
			"elixir is neither pinned by a fixture nor admitted",
			"fallback fixture count 8 !== registry members minus admissions 9",
		]);
	});

	it("rejects an admission after its fixture arrives", () => {
		const withOmnisharp = [
			...fixtures,
			{
				lang: "omnisharp",
				serverId: "omnisharp",
				expectServerId: "omnisharp",
			},
		] as Fixture[];
		const stale = [
			...FALLBACK_ADMISSIONS,
			{
				serverId: "omnisharp",
				reason: "lane C fixture landed",
				until: "#3311 lane C",
			},
		];
		expect(
			fallbackPopulationIssues(withOmnisharp, LSP_SERVERS, stale),
		).toContain("omnisharp admission is stale; fixture is present");
	});
});

/**
 * #1756 stage 1 — the declared per-server trait table, registered-or-fail.
 *
 * Stage 1's acceptance is "the trait table populated for every current server,
 * the #1488 predicates converted, and the sweep red-first on an undeclared
 * trait". This is that sweep. It derives every population from the registry at
 * runtime rather than hand-listing it, which is also #1488's acceptance
 * criterion for the auxiliary list: a test that names the four scanners in a
 * literal keeps passing after a fifth one is registered with no trait row.
 *
 * What it holds:
 *   1. every registry row DECLARES a role (the field is non-optional, so this
 *      is the runtime half of the compile gate — a row reaching the registry
 *      through a factory or a cast still has to answer);
 *   2. the trait projection is total: no field comes back `undefined`, so no
 *      consumer can re-derive a default inline;
 *   3. the auxiliary population and the diagnostic-profile population are the
 *      SAME set — an auxiliary with no profile produces untagged findings, and
 *      a profile with no auxiliary row is dead policy;
 *   4. the server-definition traits and the measured wait-policy strategy
 *      traits stay DISJOINT, so no trait has two declared homes and therefore
 *      two sources of truth;
 *   5. the stated defaults are the fail-safe ones and are unchanged by the
 *      fold.
 */

import { describe, expect, it } from "vitest";
import { LSP_SERVERS } from "../../clients/lsp/server.js";
import {
	DEFAULT_LSP_SERVER_ROLE,
	DEFAULT_NOTIFY_INFLIGHT_LIMIT,
	DEFAULT_REPLY_ORDERING,
	isAuxiliary,
	serverTraits,
	STRATEGY_TABLE_TRAITS,
	type LspServerTraits,
} from "../../clients/lsp/server-traits.js";
import { SERVER_DIAGNOSTIC_STRATEGIES } from "../../clients/lsp/wait-policy/strategies.js";
import { AUXILIARY_LSP_PROFILES } from "../../clients/dispatch/auxiliary-lsp.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

/** The traits whose declared home IS the server definition (#1756 stage 1). */
const SERVER_DEFINITION_TRAITS = [
	"role",
	"notifyInflightLimit",
	"replyOrdering",
] as const;

/**
 * #1714's shared ceiling and #1488's stated default, pinned to the values the
 * fold moved rather than to fresh measurements: this slice is
 * behaviour-preserving, so a default that changed here changed behaviour.
 */
const PRE_FOLD_NOTIFY_INFLIGHT_DEFAULT = 8;

describe("#1756 stage 1 — declared server trait table", () => {
	it("registers a population large enough for the assertions to mean something", () => {
		// Floor: an emptied registry would satisfy every `toEqual([])` below and
		// read as clean (#1718).
		assertNonEmptyScan("LSP_SERVERS registry rows", LSP_SERVERS.length, 30);
		assertNonEmptyScan(
			"auxiliary diagnostic profiles",
			AUXILIARY_LSP_PROFILES.length,
			1,
		);
		assertNonEmptyScan(
			"wait-policy strategy rows",
			Object.keys(SERVER_DIAGNOSTIC_STRATEGIES).length,
			5,
		);
	});

	it("requires every registry row to declare its role", () => {
		const undeclared = LSP_SERVERS.filter(
			(server) =>
				!Object.hasOwn(server, "role") ||
				typeof server.role !== "string" ||
				server.role.length === 0,
		).map((server) => server.id);
		assertNonEmptyScan(
			"registry rows scanned for a declared role",
			LSP_SERVERS.length,
			30,
		);
		expect(
			undeclared,
			"A registry row carries no declared role, so every consumer would read " +
				"it by negation — the #1488 defect. Declare `role` on the row, or " +
				"apply DEFAULT_LSP_SERVER_ROLE in the factory that builds it.",
		).toEqual([]);
	});

	it("projects a total trait record for every registry row", () => {
		const partial = LSP_SERVERS.flatMap((server) => {
			const traits: LspServerTraits = serverTraits(server);
			return (Object.keys(traits) as Array<keyof LspServerTraits>)
				.filter((trait) => traits[trait] === undefined)
				.map((trait) => `${server.id}.${String(trait)}`);
		});
		assertNonEmptyScan(
			"trait records projected",
			LSP_SERVERS.length * SERVER_DEFINITION_TRAITS.length,
			90,
		);
		expect(
			partial,
			"A trait came back undefined, which sends its consumer back to " +
				"re-deriving a default inline.",
		).toEqual([]);
		// The projection covers exactly the server-definition traits: a new one
		// joins the record and this list in the same change.
		expect(Object.keys(serverTraits(LSP_SERVERS[0])).sort()).toEqual(
			[...SERVER_DEFINITION_TRAITS].sort(),
		);
	});

	it("derives the auxiliary population from the registry and matches it to the diagnostic profiles", () => {
		// Derived, never hand-listed (#1488 acceptance criterion 4).
		const auxiliaryIds = LSP_SERVERS.filter((server) => isAuxiliary(server))
			.map((server) => server.id)
			.sort();
		const profileIds = AUXILIARY_LSP_PROFILES.map(
			(profile) => profile.serverId,
		).sort();

		expect(auxiliaryIds.length).toBeGreaterThan(0);
		assertNonEmptyScan(
			"registry rows classified by the predicate",
			LSP_SERVERS.length,
			30,
		);
		expect(
			auxiliaryIds,
			"An auxiliary row has no diagnostic profile (its findings would keep " +
				"tool: lsp and lose their semantic policy), or a profile names a " +
				"server the registry does not declare auxiliary (dead policy).",
		).toEqual(profileIds);

		// And the predicate agrees with the declaration on every row, in both
		// directions — the registry is the source, not a hand-kept list.
		expect(LSP_SERVERS.filter((server) => !isAuxiliary(server)).length).toBe(
			LSP_SERVERS.length - auxiliaryIds.length,
		);
	});

	it("keeps the server-definition traits and the measured strategy traits disjoint", () => {
		const strategyKeys = new Set(
			Object.values(SERVER_DIAGNOSTIC_STRATEGIES).flatMap((strategy) =>
				Object.keys(strategy),
			),
		);
		const bothTables = SERVER_DEFINITION_TRAITS.filter((trait) =>
			strategyKeys.has(trait),
		);
		expect(
			bothTables,
			"A trait is declared on both the server definition and the wait-policy " +
				"strategy table, so it has two sources of truth and only one " +
				"measurement behind it.",
		).toEqual([]);

		// The declared-home list is load-bearing: every trait it names is really
		// a strategy key, and no server row carries one as its own field.
		assertNonEmptyScan("strategy-table trait keys", strategyKeys.size, 5);
		for (const trait of STRATEGY_TABLE_TRAITS) {
			expect(
				strategyKeys.has(trait),
				`${trait} is listed as a strategy-table trait but no strategy declares it`,
			).toBe(true);
			expect(
				LSP_SERVERS.filter((server) => Object.hasOwn(server, trait)).map(
					(server) => server.id,
				),
				`${trait} moved onto the server definition; update STRATEGY_TABLE_TRAITS`,
			).toEqual([]);
		}
	});

	it("states fail-safe defaults and keeps the pre-fold values", () => {
		// A row that does not declare a role is a language server: the
		// pre-#1488 behaviour, now stated instead of implied by a negation.
		expect(DEFAULT_LSP_SERVER_ROLE).toBe("language");
		expect(isAuxiliary(undefined)).toBe(false);
		expect(isAuxiliary({})).toBe(false);
		expect(isAuxiliary({ role: "language" })).toBe(false);
		expect(isAuxiliary({ role: "auxiliary" })).toBe(true);
		// An unmeasured server keeps the barrier armed, exactly as before the
		// trait existed — never a pacing change granted by omission.
		expect(DEFAULT_REPLY_ORDERING).toBe("unmeasured");
		expect(serverTraits({ role: "auxiliary" }).replyOrdering).toBe(
			"unmeasured",
		);
		expect(DEFAULT_NOTIFY_INFLIGHT_LIMIT).toBe(
			PRE_FOLD_NOTIFY_INFLIGHT_DEFAULT,
		);
		expect(serverTraits({ role: "auxiliary" }).notifyInflightLimit).toBe(
			PRE_FOLD_NOTIFY_INFLIGHT_DEFAULT,
		);
	});

	it("orders the notify-inflight trait declaration, then environment, then default", () => {
		const previous = process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT;
		try {
			delete process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT;
			expect(
				serverTraits({ role: "auxiliary", notifyInflightLimit: 4 })
					.notifyInflightLimit,
			).toBe(4);
			// A declaration the projection cannot use falls through to the
			// environment, then to the default — the order the inlined helper had.
			process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "3";
			expect(
				serverTraits({ role: "auxiliary", notifyInflightLimit: 4 })
					.notifyInflightLimit,
			).toBe(4);
			expect(serverTraits({ role: "auxiliary" }).notifyInflightLimit).toBe(3);
			process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "not-a-number";
			expect(serverTraits({ role: "auxiliary" }).notifyInflightLimit).toBe(
				PRE_FOLD_NOTIFY_INFLIGHT_DEFAULT,
			);
			process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "0";
			expect(serverTraits({ role: "auxiliary" }).notifyInflightLimit).toBe(
				PRE_FOLD_NOTIFY_INFLIGHT_DEFAULT,
			);
			delete process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT;
			// A fractional declaration is floored, as the inlined helper floored it.
			expect(
				serverTraits({ role: "auxiliary", notifyInflightLimit: 4.9 })
					.notifyInflightLimit,
			).toBe(4);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT;
			} else {
				process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = previous;
			}
		}
	});

	it("reads an undeclared or misspelled role as the stated default", () => {
		// The untyped path: a config record's `role` reaches the predicate as an
		// arbitrary value, and only a member of the union classifies as
		// auxiliary. A misspelling must not silently become one.
		expect(isAuxiliary({ role: "Auxiliary" })).toBe(false);
		expect(isAuxiliary({ role: "primary" })).toBe(false);
		expect(isAuxiliary({ role: "" })).toBe(false);
		expect(isAuxiliary({ role: null })).toBe(false);
		expect(isAuxiliary({ role: 1 })).toBe(false);
	});
});

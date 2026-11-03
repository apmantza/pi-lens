#!/usr/bin/env node
/**
 * Cascade neighbour-budget sizing bench (#1462).
 *
 * Replays the 2026-08-15 dogfood cascade timings through the real derivation in
 * `clients/cascade-budget.js` and reports, per scenario, what the walk costs
 * under the flat 40-neighbour cap versus the derived budget.
 *
 * TWO DIFFERENT COSTS, deliberately independent:
 *
 *   --divisor-ms      what PRODUCTION divides by (`PI_LENS_CASCADE_NEIGHBOUR_
 *                     COST_MS`, default 100). An estimate.
 *   --true-cost-ms    what a neighbour ACTUALLY costs in this run of the model.
 *
 * Feeding one number into both makes "the derived walk fits" an arithmetic
 * identity that holds at any value and proves nothing. Holding the divisor at
 * the production estimate and sweeping the true cost is the falsifiable form:
 * it shows the band where the rescue works and the point where the estimate is
 * wrong enough that the walk overruns anyway. `--sweep` runs that sweep.
 *
 * The walk cost is a MODEL, not a fresh measurement: touches fan out in
 * parallel, so the number that matters is the marginal wall-clock cost of one
 * more neighbour under LSP contention. 97 ms is the issue's own measurement
 * (3.88 s at nbr=40, 3.71 s at nbr=38). Preludes include work before turn_end
 * and are the measured graph-build / reverse-deps times from the same window.
 * `--turn-end-gap-ms` controls the pre-turn gap that is outside the settle
 * deadline and therefore is not charged against the on-time window.
 *
 * "Dropped" is the column that matters against a narrowed budget: a neighbour
 * cut by the budget is gone for good, while a neighbour on a LATE run is not —
 * `settleCascadeRuns` re-parks the promise, `cascade_carry_over_settle` drains
 * it at agent_settled, and `beginTurn` keeps it pending until it resolves.
 *
 * Usage: npm run bench:cascade-budget [-- --sweep --divisor-ms=100 --true-cost-ms=97]
 */

import { deriveCascadeNeighbourBudget } from "../clients/cascade-budget.js";

const numArg = (name, fallback) => {
	const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
	return hit === undefined ? fallback : Number(hit.split("=")[1]);
};

const DIVISOR_MS = numArg("divisor-ms", 100);
const SETTLE_MS = numArg("settle-ms", 5000);
const parsedTurnEndGapMs = numArg("turn-end-gap-ms", 0);
const TURN_END_GAP_MS = Math.max(
	0,
	Number.isFinite(parsedTurnEndGapMs) && parsedTurnEndGapMs >= 0
		? parsedTurnEndGapMs
		: 0,
);
const QUIET_DRAIN_MS = numArg("quiet-drain-ms", 15000);
const CEILING = 40;
const FLOOR = 5;

// [label, prelude ms including work before turn_end, eligible neighbours]
const SCENARIOS = [
	["median cascade (30 ms, nbr=1)", 30, 1],
	["cline-headers.ts (1.33 s prelude, nbr=3)", 1330, 3],
	["warm hub (500 ms prelude, nbr=40)", 500, 40],
	["constants.ts (nbr=40, no cache refresh)", 30, 40],
	["logger.ts + reverse_deps refresh (2046 ms, nbr=38)", 2046, 38],
	["cold hub + slow graph build (3500 ms, nbr=40)", 3500, 40],
	["cold session, ~19 s graph build (nbr=40)", 19000, 40],
];

function evaluate(trueCostMs) {
	const rows = [];
	const totals = {
		flatOverruns: 0,
		derivedOverruns: 0,
		dropped: 0,
		rescued: 0,
		narrowedButStillMissed: 0,
		narrowedWhileFlatFitted: 0,
	};

	for (const [label, preludeMs, eligible] of SCENARIOS) {
		const settleElapsedMs = Math.max(0, preludeMs - TURN_END_GAP_MS);
		const { budget, zone } = deriveCascadeNeighbourBudget({
			elapsedMs: settleElapsedMs,
			settleWaitMs: SETTLE_MS,
			quietDrainMs: QUIET_DRAIN_MS,
			ceiling: CEILING,
			floor: FLOOR,
			perNeighbourMs: DIVISOR_MS,
		});

		const flatWalked = Math.min(eligible, CEILING);
		const derivedWalked = Math.min(eligible, budget);
		const flatTotal = settleElapsedMs + Math.round(flatWalked * trueCostMs);
		const derivedTotal =
			settleElapsedMs + Math.round(derivedWalked * trueCostMs);
		const flatFits = flatTotal <= SETTLE_MS;
		const derivedFits = derivedTotal <= SETTLE_MS;
		const dropped = flatWalked - derivedWalked;

		if (!flatFits) totals.flatOverruns++;
		if (!derivedFits) totals.derivedOverruns++;
		totals.dropped += dropped;
		if (!flatFits && derivedFits) totals.rescued++;
		if (!derivedFits && dropped > 0) totals.narrowedButStillMissed++;
		if (flatFits && dropped > 0) totals.narrowedWhileFlatFitted++;

		rows.push({
			label,
			eligible,
			zone,
			flatWalked,
			flatTotal,
			flatFits,
			derivedWalked,
			derivedTotal,
			derivedFits,
			dropped,
		});
	}
	return { rows, totals };
}

const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

function printTable(trueCostMs) {
	const { rows, totals } = evaluate(trueCostMs);
	console.log(
		`\ntrue marginal cost ${trueCostMs} ms/neighbour | production divisor ${DIVISOR_MS} ms | prelude includes work before turn_end | uncharged turn_end gap ${TURN_END_GAP_MS} ms | settle window ${SETTLE_MS} ms | pipeline drain ${SETTLE_MS + QUIET_DRAIN_MS} ms\n`,
	);
	console.log(
		`${pad("scenario", 52)}${padL("nbr", 4)}${padL("zone", 18)}${padL("flat", 6)}${padL("total", 8)}${padL("fits", 6)}${padL("drv", 5)}${padL("total", 8)}${padL("fits", 6)}${padL("dropped", 9)}`,
	);
	console.log("-".repeat(122));
	for (const r of rows) {
		console.log(
			pad(r.label, 52) +
				padL(r.eligible, 4) +
				padL(r.zone, 18) +
				padL(r.flatWalked, 6) +
				padL(`${r.flatTotal}ms`, 8) +
				padL(r.flatFits ? "yes" : "NO", 6) +
				padL(r.derivedWalked, 5) +
				padL(`${r.derivedTotal}ms`, 8) +
				padL(r.derivedFits ? "yes" : "NO", 6) +
				padL(r.dropped, 9),
		);
	}
	console.log(
		`\nmissed the on-time window: flat ${totals.flatOverruns}/${SCENARIOS.length}, derived ${totals.derivedOverruns}/${SCENARIOS.length}` +
			`   rescued: ${totals.rescued}   neighbours dropped for good: ${totals.dropped}`,
	);
	console.log(
		`narrowed and STILL missed (pure loss): ${totals.narrowedButStillMissed}   narrowed while the flat walk already fitted: ${totals.narrowedWhileFlatFitted}`,
	);
	return totals;
}

if (process.argv.includes("--sweep")) {
	console.log(
		"Sensitivity of the fix to the divisor being wrong. The divisor is held at\n" +
			`the production estimate (${DIVISOR_MS} ms) while the TRUE marginal cost varies, so\n` +
			"each row is a falsifiable claim rather than the same arithmetic twice.\n",
	);
	console.log(
		`${pad("true cost", 12)}${padL("flat missed", 13)}${padL("derived missed", 16)}${padL("rescued", 9)}${padL("dropped", 9)}${padL("pure loss", 11)}`,
	);
	console.log("-".repeat(70));
	for (const trueCostMs of [60, 80, 97, 100, 120, 150, 200]) {
		const { totals } = evaluate(trueCostMs);
		console.log(
			pad(`${trueCostMs}ms`, 12) +
				padL(`${totals.flatOverruns}/${SCENARIOS.length}`, 13) +
				padL(`${totals.derivedOverruns}/${SCENARIOS.length}`, 16) +
				padL(totals.rescued, 9) +
				padL(totals.dropped, 9) +
				padL(totals.narrowedButStillMissed, 11),
		);
	}
	console.log(
		"\n`pure loss` = runs the derivation narrowed that missed the window anyway:\n" +
			"neighbours dropped for good in exchange for nothing. It is the number that\n" +
			"decides whether the divisor is good enough.\n\n" +
			"Read the rows honestly. The band test uses the DIVISOR, so a divisor that\n" +
			"underestimates the true cost lets a run narrow and still miss. Above roughly\n" +
			"+20% (true cost 120 ms against a 100 ms divisor) the rescue stops converting\n" +
			"anything and pure loss appears. The rescue band bounds the damage — it never\n" +
			"narrows a run that is already past a floor-sized walk, which is what keeps\n" +
			"the cold-session case identical to pre-#1462 — but it cannot rescue a run\n" +
			"whose cost it mis-measured.\n\n" +
			"So raising PI_LENS_CASCADE_NEIGHBOUR_COST_MS is the lever, WITHIN A RANGE.\n" +
			`With the ${SETTLE_MS} ms window and a ceiling of ${CEILING}, measured by --divisor-ms:\n` +
			"  <=112 ms  healthy — only runs that would have missed are narrowed\n" +
			"  113-129   the fits zone has shrunk below the real preludes, so runs that\n" +
			"            would have landed anyway start getting narrowed (--divisor-ms=113\n" +
			"            narrows 1 such run; =125 narrows every row and drops 48)\n" +
			"  >=130     ceiling * divisor exceeds the window, so no-rescue-window fires\n" +
			"            on everything and the feature disarms\n\n" +
			"The top of that is a SAFE failure mode — disarmed means the flat cap, which\n" +
			"is pre-#1462 behaviour, 0 dropped. The middle is the one to avoid. If a\n" +
			"dogfood window puts the true marginal cost above ~112 ms, raise the settle\n" +
			"wait or lower the ceiling with the divisor rather than the divisor alone.",
	);
} else {
	printTable(numArg("true-cost-ms", 97));
}

const ITERATIONS = 1_000_000;
const start = process.hrtime.bigint();
let sink = 0;
for (let i = 0; i < ITERATIONS; i++) {
	sink += deriveCascadeNeighbourBudget({ elapsedMs: i % 6000 }).budget;
}
const nsPerCall = Number(process.hrtime.bigint() - start) / ITERATIONS;
console.log(
	`\nderivation cost: ${nsPerCall.toFixed(0)} ns/call over ${ITERATIONS.toLocaleString("en-US")} calls (checksum ${sink})`,
);

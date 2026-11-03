#!/usr/bin/env node
/**
 * Mechanically re-keys `EXEMPT_SITES` in
 * `tests/config/hook-await-bounds.test.ts` after a merge shifts lines near a
 * flagged hook-await or hand-rolled-race site (#2530 round 3 F6).
 *
 * Every key in that table is content-derived (`stableOccurrenceKey` plus a
 * two-line neighbourhood, see `tests/support/hook-await-scan.ts`), which
 * means a line inserted immediately above or below a flagged occurrence
 * re-keys it even though the occurrence itself did not move or change. That
 * is by design (#2475 — content keys, never line numbers), but it means an
 * unrelated PR's merge can turn a handful of the 187+ entries stale without
 * touching this file at all: the guard test then fails, printing the NEW key
 * for each now-unaccounted occurrence, and someone has to paste 1-3 keys in
 * by hand per touched site. This script does that mechanically instead,
 * for the WHOLE table at once, and REFUSES to touch anything it cannot
 * match with certainty.
 *
 * ## How matching works, and why it does not need git history
 *
 * Every key already carries its own file, enclosing-symbol identity (where
 * the detector found one) and OWN-LINE content hash in plain text, all
 * together ahead of the final `~context` suffix: `rel#symbol:hash~context`
 * or `rel#hash~context` (`race:` on hand-rolled-race keys). Call everything
 * before the last `~` a key's HEAD. A line-shifting edit near a flagged site
 * changes only the two neighbour lines the `~context` suffix hashes — the
 * head is untouched, because the flagged line itself did not change. So this
 * script:
 *
 * 1. Parses every key straight out of `EXEMPT_SITES`'s source text, in
 *    declaration order.
 * 2. Runs the SAME detector `tests/config/hook-await-bounds.test.ts` uses
 *    (imported from `tests/support/hook-await-scan.mjs` — the shared module
 *    that exists specifically so this script and the guard test can never
 *    drift apart) against the CURRENT tree, producing the live occurrence
 *    list.
 * 3. Groups both the table's old keys and the live occurrences by HEAD —
 *    everything before the final `~context` (not by file/symbol identity
 *    alone — #2530 round 4 F1). Within one head's bucket every candidate is
 *    the SAME flagged line: same file, same symbol, same content hash.
 *    An old key already present verbatim among the live occurrences needs
 *    no rewrite. Whatever is left in the bucket is paired by position only
 *    when the leftover counts match — safe here because position can only
 *    decide which physically identical duplicate a reason/owner attaches
 *    to, never whether two DIFFERENT lines are treated as the same site.
 * 4. Refuses to touch any old key whose bucket does not resolve that way:
 *    zero live occurrences share its head (the line was fixed, deleted, or
 *    its content genuinely changed), or a leftover surplus/shortfall (an
 *    ambiguous count). Each such key is printed with whatever live
 *    occurrences DO share its head, if any, so a human can decide by hand.
 *
 * This is deliberately NOT a count-matched, order-zipped pairing within a
 * file/symbol group (the round-3 design). That grouping could not tell a
 * genuine line shift apart from one flagged line being swapped for an
 * unrelated new one in the same function while the OLD line was fixed —
 * both leave the group's old-count equal to its new-count, so an
 * order-based zip silently carries the OLD key's exemption reason onto the
 * NEW, unrelated await (reviewer probe, #2530 round 4 F1: replacing one
 * flagged await with a brand-new unbounded await in the same `rel#symbol`
 * kept the group's count equal and the old rewrite laundered the old
 * exemption onto the new site). Matching on the full head — hash included —
 * cannot do that: the replaced line's hash and the new line's hash differ,
 * so neither has a clean 1:1 partner and both are refused.
 *
 * A vitest test file cannot be `import()`ed by a bare `node` process (its
 * top-level `describe()`/`it()` calls need a running vitest worker), which
 * is exactly why the detector lives in `tests/support/hook-await-scan.ts`
 * and not in the test file itself.
 *
 * Usage:
 *   node scripts/rekey-hook-await-exemptions.mjs            # report only
 *   node scripts/rekey-hook-await-exemptions.mjs --write    # rewrite the file
 */

import * as path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { isMainModule } from "./lib/is-main-module.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const TEST_FILE = path.join(
	REPO_ROOT,
	"tests/config/hook-await-bounds.test.ts",
);

/** Extract every `EXEMPT_SITES` key, in declaration order, from the raw test source. */
export function parseOldKeys(source) {
	const startMarker =
		"const EXEMPT_SITES: Readonly<Record<string, SweepExemption>> = {";
	const start = source.indexOf(startMarker);
	if (start < 0) {
		throw new Error(
			`${TEST_FILE}: could not find the EXEMPT_SITES declaration`,
		);
	}
	const bodyStart = start + startMarker.length;
	// Depth-count braces from the object's own opening `{` to find its match,
	// so this does not depend on the table's total length staying the same.
	let depth = 1;
	let i = bodyStart;
	for (; i < source.length && depth > 0; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") depth--;
	}
	const body = source.slice(bodyStart, i - 1);
	const keys = [];
	// A top-level key is a quoted string immediately followed (across
	// whitespace/newlines, prettier wraps long keys onto their own line)
	// by `{` — the start of that entry's `SweepExemption` object.
	const KEY_PATTERN = /"((?:race:)?[^"\\]+)":\s*\{/g;
	for (const match of body.matchAll(KEY_PATTERN)) keys.push(match[1]);
	return keys;
}

/**
 * A key minus its trailing `~context` suffix: `rel[#symbol]:hash` (or
 * `rel#hash` with no enclosing symbol), `race:`-prefixed where applicable.
 * Two keys sharing a head differ ONLY in their neighbourhood context, never
 * in file, symbol, or the flagged line's own content — see the module doc.
 */
export function headOf(key) {
	const idx = key.lastIndexOf("~");
	return idx < 0 ? key : key.slice(0, idx);
}

function groupByHead(entries, keyOf) {
	const groups = new Map();
	for (const entry of entries) {
		const head = headOf(keyOf(entry));
		const list = groups.get(head) ?? [];
		list.push(entry);
		groups.set(head, list);
	}
	return groups;
}

/**
 * Pure matching between the table's OLD keys (declaration order) and the
 * live scan's NEW occurrences (`{ key, detail }`, as `scanFiles` produces).
 * No file IO, no process state — exported so tests can drive it with
 * synthetic key lists instead of the real tree.
 *
 * Within one head's bucket (same file, same symbol, same flagged-line
 * content hash — everything a laundered replacement would NOT share, see
 * the module doc), matching happens in two passes:
 *
 * 1. An old key whose full text (head AND context) still appears verbatim
 *    among the live occurrences needs no rewrite at all — paired off first
 *    and dropped from further consideration. This is what keeps a
 *    legitimate duplicate (the same statement flagged several times in one
 *    function, distinguished only by which neighbour lines its context
 *    hashes) from being reported as ambiguous when nothing about it moved.
 * 2. Whatever is left in the bucket is paired by position only when the
 *    counts still match — safe here specifically because every candidate in
 *    a head bucket is provably the SAME flagged line (file, symbol, and
 *    content hash all equal); the only thing position decides is which
 *    physically identical occurrence a cosmetic `reason`/`owner` attaches
 *    to, never whether two DIFFERENT lines get treated as the same site.
 *
 * A head where the leftover counts do not match is `unresolved`, carrying
 * whatever live occurrences (zero, some, or a surplus) remain in its
 * bucket, so a human sees the actual current source line(s) rather than a
 * bare key.
 */
export function buildRekeyPlan(oldKeys, newOccurrences) {
	const oldByHead = groupByHead(oldKeys, (k) => k);
	const newByHead = groupByHead(newOccurrences, (o) => o.key);

	const mapping = new Map();
	const unresolved = [];

	for (const [head, oldList] of oldByHead) {
		const newList = newByHead.get(head) ?? [];

		// Pass 1: exact (head + context) matches are already correct.
		const newRemaining = [...newList];
		const oldRemaining = [];
		for (const oldKey of oldList) {
			const exactIndex = newRemaining.findIndex((o) => o.key === oldKey);
			if (exactIndex >= 0) {
				mapping.set(oldKey, oldKey);
				newRemaining.splice(exactIndex, 1);
			} else {
				oldRemaining.push(oldKey);
			}
		}

		// Pass 2: positional pairing over what's left, only when the counts
		// match — safe because every remaining candidate shares this exact
		// head (file, symbol, and flagged-line content hash).
		if (
			oldRemaining.length > 0 &&
			oldRemaining.length === newRemaining.length
		) {
			for (let i = 0; i < oldRemaining.length; i++)
				mapping.set(oldRemaining[i], newRemaining[i].key);
			continue;
		}

		for (const oldKey of oldRemaining) {
			unresolved.push({
				oldKey,
				candidates: newRemaining.map((o) => o.detail),
				reason:
					newRemaining.length === 0
						? "no current occurrence shares this rel[#symbol]:hash"
						: `${newRemaining.length} current occurrence(s) share this rel[#symbol]:hash after removing exact matches — ambiguous`,
			});
		}
	}

	const newKeys = newOccurrences.map((o) => o.key);
	const mappedNewKeys = new Set(mapping.values());
	const scanKeysAbsentFromTable = newKeys.filter(
		(k) => !mappedNewKeys.has(k),
	).length;
	const changed = [...mapping.entries()].filter(
		([oldKey, newKey]) => oldKey !== newKey,
	);

	return {
		oldKeyCount: oldKeys.length,
		newKeyCount: newKeys.length,
		mapping,
		unresolved,
		changed,
		scanKeysAbsentFromTable,
	};
}

function report(plan) {
	console.log(`exemption keys in table: ${plan.oldKeyCount}`);
	console.log(`scan produced occurrences: ${plan.newKeyCount}`);
	console.log(`keys safely matched (hash unchanged): ${plan.mapping.size}`);
	console.log(`table keys needing a human decision: ${plan.unresolved.length}`);
	console.log(
		`scan occurrences absent from table: ${plan.scanKeysAbsentFromTable}`,
	);
}

/** Applies `plan` to `source`; writes `TEST_FILE` only when `write` and the plan is clean. */
export function applyPlan(source, plan, write) {
	if (plan.unresolved.length > 0) {
		console.error(
			"\nRefusing to rewrite — these table keys' own rel[#symbol]:hash no " +
				"longer matches exactly one current occurrence, so a mechanical " +
				"rename could silently reassign the exemption to a DIFFERENT line " +
				"(#2530 round 4 F1). Each needs a human decision:",
		);
		for (const { oldKey, candidates, reason } of plan.unresolved) {
			console.error(`  ${oldKey}\n    ${reason}`);
			for (const detail of candidates) console.error(`      ${detail}`);
		}
		console.error(
			"\nEach one is either a NEW occurrence (add an EXEMPT_SITES entry), " +
				"one that was fixed or removed (delete its entry), or one whose " +
				"line genuinely changed (paste in the new key by hand) — not a " +
				"mechanical rename.",
		);
		process.exitCode = 1;
		return;
	}

	if (plan.changed.length === 0) {
		console.log("\n0 keys need rewriting.");
		return;
	}

	console.log(`\n${plan.changed.length} key(s) would be rewritten:`);
	for (const [oldKey, newKey] of plan.changed)
		console.log(`  ${oldKey}\n    -> ${newKey}`);

	if (!write) {
		console.log("\nRe-run with --write to apply.");
		return;
	}

	let rewritten = source;
	for (const [oldKey, newKey] of plan.changed) {
		const needle = `"${oldKey}":`;
		if (!rewritten.includes(needle)) {
			throw new Error(
				`could not find the exact key text to replace: ${needle}`,
			);
		}
		rewritten = rewritten.replace(needle, `"${newKey}":`);
	}
	writeFileSync(TEST_FILE, rewritten);
	console.log(`\nrewrote ${plan.changed.length} exemption key(s)`);
}

async function main() {
	const jiti = createJiti(import.meta.url);
	const {
		DEFINITION_FILE,
		findHandRolledRaceLines,
		findUnboundedAwaitLines,
		hookPathFiles,
		scanFiles,
		shippedSourceFiles,
	} = await jiti.import(
		pathToFileURL(path.join(REPO_ROOT, "tests/support/hook-await-scan.mjs"))
			.href,
		{ defaultExport: false },
	);

	const WRITE = process.argv.includes("--write");
	const source = readFileSync(TEST_FILE, "utf8");
	const oldKeys = parseOldKeys(source);

	const awaits = scanFiles(
		REPO_ROOT,
		hookPathFiles(REPO_ROOT),
		findUnboundedAwaitLines,
		"",
	);
	const races = scanFiles(
		REPO_ROOT,
		shippedSourceFiles(REPO_ROOT),
		findHandRolledRaceLines,
		"race:",
		(rel) => rel === DEFINITION_FILE,
	);
	const newOccurrences = [...awaits.occurrences, ...races.occurrences];

	const plan = buildRekeyPlan(oldKeys, newOccurrences);
	report(plan);
	applyPlan(source, plan, WRITE);
}

const isEntryPoint = isMainModule(import.meta.url);
if (isEntryPoint) {
	await main();
}

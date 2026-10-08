// The nightly's idle-eviction PROMOTION rule (#3989): which servers the
// measurement has shown safe and worth evicting, and the minimal source edit
// that declares them `transparent`. Pure: summary rows, the refresh-state map
// and source text in, text and decisions out, so every guard is testable
// without a language server or a git checkout. The driver is
// scripts/promote-lsp-idle-eviction.mjs; the measurement is
// scripts/measure-lsp-idle-eviction.mjs, whose `proposal` findings this acts on.
//
// Nothing here demotes: a `transparent` server the measurement vetoes is the
// drift issue's job (#3645), never this PR's.

const MB = 1024 * 1024;

/** Consecutive qualifying nightly runs before a server is promoted. */
export const PROMOTE_NIGHTS = 2;

/**
 * Idle resident memory (of the server's process tree) below which a server is
 * never promoted: eviction frees little and every eviction still costs a cold
 * start on the next request. User-confirmed default (#3989).
 */
export const IDLE_EVICTION_MIN_RSS_BYTES = 50 * MB;

/**
 * Cold start (first request after the idle window, ms) above which a server is
 * never promoted. The cost of eviction is a one-off delay on that request,
 * acceptable up to about 3 s. User-confirmed (#3989). The worse of the two
 * qualifying nights is judged, because CI-runner timing is noisy.
 */
export const COLD_START_MAX_MS = 3000;

const INDEXER_HOLD =
	"held: #3952 HOLD_INDEXER class (re-index cost after eviction is unmeasured; user decision 2026-10-06)";

/**
 * @typedef {{ day: string, rssMb: number | null, coldMs: number }} Night
 * @typedef {Record<string, { nights: Night[] }>} NightState
 */

/** A row that counts as one qualifying night for a still-`unmeasured` server. */
function qualifies(row) {
	return (
		row.declared === "unmeasured" &&
		row.result === "eligible" &&
		row.respawn === "ok" &&
		row.coverage === "preserved" &&
		// A night with cold start `n/a` does not count, and one over the cap breaks
		// the run of nights: the pair must both be acceptable.
		// Idle RSS below the floor (or unmeasured) does not count either: a server
		// that is small tonight keeps no memory, so the entry cannot freeze on two
		// small nights and then ignore a later large one.
		typeof row.rssBytes === "number" &&
		row.rssBytes >= IDLE_EVICTION_MIN_RSS_BYTES &&
		typeof row.coldStartMs === "number" &&
		Number.isFinite(row.coldStartMs) &&
		row.coldStartMs <= COLD_START_MAX_MS
	);
}

/** The UTC day before `day` (`YYYY-MM-DD`). */
function previousDay(day) {
	return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
		.toISOString()
		.slice(0, 10);
}

/**
 * Advance the per-server night memory by one run. A server keeps (or gains) a
 * night only when this run's row qualifies; every other outcome (vetoed,
 * inconclusive, unavailable, budget-exhausted, no row, over the cold-start cap,
 * under the RSS floor, no longer `unmeasured`) drops its entry, so the nights held are consecutive.
 * A held night counts only when it is the previous UTC day; any other (a skipped
 * night, or today's own earlier run) restarts the count at one, so two runs on
 * one UTC day count once and a manual dispatch cannot satisfy the rule. An entry that already holds `PROMOTE_NIGHTS` nights is left
 * untouched, so a settled server writes a byte-identical block and the refresh
 * PR does not open on timing noise.
 *
 * @param {NightState | undefined} prior
 * @param {readonly object[]} rows  this run's summary rows
 * @param {string} today  UTC `YYYY-MM-DD`
 * @returns {NightState}
 */
export function advanceNights(prior, rows, today) {
	/** @type {NightState} */
	const next = {};
	for (const row of rows) {
		if (!qualifies(row)) continue;
		const held = prior?.[row.serverId]?.nights ?? [];
		if (held.length >= PROMOTE_NIGHTS) {
			next[row.serverId] = { nights: held.slice(-PROMOTE_NIGHTS) };
			continue;
		}
		/** @type {Night} */
		const night = {
			day: today,
			rssMb:
				typeof row.rssBytes === "number" ? Math.round(row.rssBytes / MB) : null,
			coldMs: Math.round(row.coldStartMs),
		};
		const kept = held.at(-1)?.day === previousDay(today) ? held : [];
		next[row.serverId] = { nights: [...kept, night] };
	}
	return next;
}

/**
 * Decide which servers to promote from the night memory.
 *
 * @param {NightState} state  after `advanceNights`
 * @param {ReadonlyMap<string, string>} hold  server id -> why it is held
 * @returns {{ promote: { serverId: string, nights: Night[], minRssMb: number, worstColdMs: number }[], skipped: { serverId: string, reason: string }[] }}
 */
export function selectPromotions(state, hold) {
	const promote = [];
	const skipped = [];
	for (const serverId of Object.keys(state).sort()) {
		const nights = state[serverId].nights;
		if (nights.length < PROMOTE_NIGHTS) {
			skipped.push({
				serverId,
				reason: `pending: ${nights.length}/${PROMOTE_NIGHTS} consecutive eligible nights`,
			});
			continue;
		}
		const held = hold.get(serverId);
		if (held) {
			skipped.push({ serverId, reason: held });
			continue;
		}
		if (nights.some((n) => n.rssMb === null)) {
			skipped.push({ serverId, reason: "idle RSS not measured on a night" });
			continue;
		}
		const minRssMb = Math.min(...nights.map((n) => n.rssMb));
		if (minRssMb * MB < IDLE_EVICTION_MIN_RSS_BYTES) {
			skipped.push({
				serverId,
				reason: `idle RSS ${minRssMb} MB is below the ${IDLE_EVICTION_MIN_RSS_BYTES / MB} MB floor`,
			});
			continue;
		}
		const worstColdMs = Math.max(...nights.map((n) => n.coldMs));
		if (worstColdMs > COLD_START_MAX_MS) {
			skipped.push({
				serverId,
				reason: `cold start ${worstColdMs} ms exceeds the ${COLD_START_MAX_MS} ms cap`,
			});
			continue;
		}
		promote.push({ serverId, nights, minRssMb, worstColdMs });
	}
	return { promote, skipped };
}

/**
 * Read one `const NAME = [ "id", ... ] as const;` class array out of
 * tests/config/lsp-idle-eviction-registry.test.ts (#3952), independent of
 * layout: oxfmt collapses a short array onto one line, so the reader takes
 * everything between `[` and `] as const;`. Fail closed: the declaration must be
 * unique and the body must be nothing but comma-separated string literals (a
 * comment, spread, identifier or missing comma returns null), so a reshaped
 * file turns into "unknown", never a partial list.
 *
 * @returns {{ start: number, end: number, ids: string[] } | null}  `start` and
 *   `end` are the offsets of the whole `const ... as const;` statement
 */
function classArray(source, name) {
	const open = `const ${name} = [`;
	const start = source.indexOf(open);
	if (start < 0 || source.indexOf(open, start + 1) >= 0) return null;
	const close = "] as const;";
	const bodyEnd = source.indexOf(close, start);
	if (bodyEnd < 0) return null;
	const body = source.slice(start + open.length, bodyEnd);
	if (!/^\s*(?:"[^"\\\n]+"\s*,\s*)*(?:"[^"\\\n]+"\s*)?$/.test(body))
		return null;
	const ids = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	return { start, end: bodyEnd + close.length, ids };
}

/**
 * Render a class array in the layout oxfmt (printWidth 80, tabs) accepts: one
 * line while the statement fits in 80 columns, else one id per line with a
 * trailing comma.
 */
function renderClassArray(name, ids) {
	const quoted = ids.map((id) => `"${id}"`);
	const oneLine = `const ${name} = [${quoted.join(", ")}] as const;`;
	if (oneLine.length <= 80) return oneLine;
	return `const ${name} = [\n${quoted.map((q) => `\t${q},\n`).join("")}] as const;`;
}

/**
 * The hold list: #3952's HOLD_INDEXER class (read from the registry test, so
 * there is one source of truth). Null when
 * the class cannot be read or is empty, in which case nothing is promoted.
 *
 * @returns {Map<string, string> | null}
 */
export function holdList(registrySource) {
	const indexers = classArray(registrySource, "HOLD_INDEXER_IDS");
	if (!indexers || indexers.ids.length === 0) return null;
	const hold = new Map();
	for (const id of indexers.ids) hold.set(id, INDEXER_HOLD);
	return hold;
}

/**
 * Move `serverId` from NEXT_PHASE_ELIGIBLE_IDS to TRANSPARENT_IDS in the
 * registry test (#3952 pins every id to one class and requires the
 * non-transparent classes to stay `unmeasured`, so a declaration flip without
 * this move reds CI). Fail closed unless the id is in NEXT_PHASE_ELIGIBLE_IDS
 * exactly once and in no other class. Only those two statements are rewritten,
 * in oxfmt's layout.
 *
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function moveClassId(registrySource, serverId) {
	const from = classArray(registrySource, "NEXT_PHASE_ELIGIBLE_IDS");
	const to = classArray(registrySource, "TRANSPARENT_IDS");
	if (!from || !to)
		return { ok: false, reason: "registry test class arrays not found" };
	if (!from.ids.includes(serverId))
		return {
			ok: false,
			reason: "not in the registry test's NEXT_PHASE_ELIGIBLE_IDS class",
		};
	if (from.ids.filter((id) => id === serverId).length !== 1)
		return { ok: false, reason: "listed twice in NEXT_PHASE_ELIGIBLE_IDS" };
	for (const name of ["TRANSPARENT_IDS", "HOLD_INDEXER_IDS", "UNPROVEN_IDS"]) {
		const other = classArray(registrySource, name);
		if (!other)
			return { ok: false, reason: `registry test ${name} array not found` };
		if (other.ids.includes(serverId))
			return { ok: false, reason: `also listed in ${name}` };
	}
	const edits = [
		{
			...from,
			text: renderClassArray(
				"NEXT_PHASE_ELIGIBLE_IDS",
				from.ids.filter((id) => id !== serverId),
			),
		},
		{
			...to,
			text: renderClassArray("TRANSPARENT_IDS", [...to.ids, serverId]),
		},
	].sort((x, y) => y.start - x.start);
	let out = registrySource;
	for (const e of edits)
		out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return { ok: true, text: out };
}

/**
 * The servers of every closed-unmerged promotion PR, read from their bodies'
 * `<!-- idle-evict-set: a,b -->` markers: closing a PR rejects each server in
 * its marker, whatever set tonight's plan has. To allow one again, delete the
 * marker from the closed PR's body.
 *
 * @returns {Set<string>}
 */
export function parseRejectedServers(text) {
	const servers = new Set();
	for (const m of String(text ?? "").matchAll(
		/<!-- idle-evict-set: ([^>\s]+) -->/g,
	))
		for (const id of m[1].split(",")) if (id) servers.add(id);
	return servers;
}

/**
 * Flip ONE server's `idleEviction: "unmeasured"` line to `"transparent"` in
 * `clients/lsp/server.ts`, fail closed. The line is located structurally: the
 * server's `id: "<id>",` property (one tab deep, exactly one in the file) must
 * be IMMEDIATELY followed by an `idleEviction:` property at the same depth, so
 * the line edited is provably that server's own. A server built by a shared
 * factory (`createInteractiveServer({ id: "java", ... })`) has no such line of
 * its own; the factory's single line serves many servers and is never edited.
 *
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function promoteDeclaration(source, serverId) {
	const lines = source.split("\n");
	const idLine = `\tid: "${serverId}",`;
	const at = lines.flatMap((l, i) => (l === idLine ? [i] : []));
	if (at.length === 0)
		return { ok: false, reason: `no \`id: "${serverId}",\` definition found` };
	if (at.length > 1)
		return {
			ok: false,
			reason: `\`id: "${serverId}",\` is ambiguous (${at.length} definitions)`,
		};
	const next = lines[at[0] + 1] ?? "";
	const decl = /^\tidleEviction: "(transparent|resident|unmeasured)",$/.exec(
		next,
	);
	if (!decl)
		return {
			ok: false,
			reason: `no \`idleEviction:\` line directly after its \`id:\` (shared factory or reordered definition)`,
		};
	if (decl[1] !== "unmeasured")
		return { ok: false, reason: `already declared ${decl[1]}` };
	const out = [...lines];
	out[at[0] + 1] = '\tidleEviction: "transparent",';
	return { ok: true, text: out.join("\n") };
}

/**
 * Add the reason row `tests/config/lsp-idle-eviction-registry.test.ts` demands
 * for every non-`unmeasured` policy. Fail closed on a file that is not the
 * canonical tab-indented JSON the writer would produce, so an edit never
 * reformats a hand-maintained file.
 *
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function addReasons(text, reasons) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, reason: "reasons file is not valid JSON" };
	}
	const render = (value) => `${JSON.stringify(value, null, "\t")}\n`;
	if (render(parsed) !== text)
		return { ok: false, reason: "reasons file is not canonically formatted" };
	return { ok: true, text: render({ ...parsed, ...reasons }) };
}

/**
 * Apply one run: advance the night memory, select, and edit. Everything a
 * caller must write comes back; nothing is written here.
 *
 * `rejected` holds the server sets of promotion PRs closed unmerged; promoting
 * the same set again is skipped, so a maintainer's close is not undone nightly.
 *
 * @param {{ rows: readonly object[], prior: NightState | undefined, today: string, serverSource: string, reasonsText: string, registrySource: string, rejected?: ReadonlySet<string> | null, runUrl?: string | null }} input
 */
export function planPromotions({
	rows,
	prior,
	today,
	serverSource,
	reasonsText,
	registrySource,
	rejected,
	runUrl,
}) {
	const state = advanceNights(prior, rows, today);
	const none = (skipped) => ({
		state,
		promoted: [],
		skipped,
		serverSource,
		reasonsText,
		registrySource,
		body: null,
	});
	const hold = holdList(registrySource);
	if (!hold) {
		return none(
			Object.keys(state)
				.sort()
				.map((serverId) => ({
					serverId,
					reason:
						"hold list unreadable (registry test HOLD_INDEXER_IDS not found); promoting nothing",
				})),
		);
	}
	const { promote, skipped } = selectPromotions(state, hold);
	if (rejected === null && promote.length > 0) {
		// The closed-PR list could not be read: reopening a closed PR is the failure
		// to avoid, so promote nothing tonight.
		return none([
			...skipped,
			...promote.map((p) => ({
				serverId: p.serverId,
				reason: "closed-PR list unreadable; promoting nothing tonight",
			})),
		]);
	}
	let source = serverSource;
	let registry = registrySource;
	const promoted = [];
	const reasons = {};
	for (const p of promote) {
		if (rejected?.has(p.serverId)) {
			skipped.push({
				serverId: p.serverId,
				reason:
					"a promotion PR containing this server was closed unmerged (delete its idle-evict-set marker to allow it again)",
			});
			continue;
		}
		const decl = promoteDeclaration(source, p.serverId);
		if (!decl.ok) {
			skipped.push({ serverId: p.serverId, reason: decl.reason });
			continue;
		}
		const moved = moveClassId(registry, p.serverId);
		if (!moved.ok) {
			skipped.push({ serverId: p.serverId, reason: moved.reason });
			continue;
		}
		source = decl.text;
		registry = moved.text;
		promoted.push(p);
		reasons[p.serverId] =
			`Nightly measurement (#3989): eligible, respawn ok and findings preserved on ${PROMOTE_NIGHTS} consecutive runs, idle RSS ${p.minRssMb} MB, cold start ${p.worstColdMs} ms.`;
	}
	if (promoted.length === 0) return none(skipped);
	const added = addReasons(reasonsText, reasons);
	if (!added.ok) {
		// Without the reason rows the registry test would red: promote nothing.
		return none([
			...skipped,
			...promoted.map((p) => ({ serverId: p.serverId, reason: added.reason })),
		]);
	}
	return {
		state,
		promoted,
		skipped,
		serverSource: source,
		reasonsText: added.text,
		registrySource: registry,
		body: renderPromotionBody(promoted, skipped, runUrl),
	};
}

/** The bot PR's body: the measured table per promoted server, and how to re-run. */
export function renderPromotionBody(promoted, skipped, runUrl) {
	const lines = [
		"Automated promotion from the nightly `tool-smoke` idle-eviction measurement (#3989). This PR is a draft and is never auto-merged.",
		"No new failure path; no record added.",
		"TLA+ unaffected: session-lifecycle — the flip changes idleEviction policy data in the registry table, not lifecycle.",
		"TLA+ unaffected: format-drain — the flip changes idleEviction policy data in the registry table, not lifecycle.",
		"TLA+ unaffected: lsp-idle-reset — the flip changes idleEviction policy data in the registry table, not lifecycle.",
		"",
		`Each server below was measured \`eligible\` (eviction and respawn preserved every finding) on ${PROMOTE_NIGHTS} consecutive nightly runs, held idle RSS of at least ${IDLE_EVICTION_MIN_RSS_BYTES / MB} MB, and cold-started in at most ${COLD_START_MAX_MS} ms on both nights (the worse night is judged). It flips that server's \`idleEviction: "unmeasured"\` to \`"transparent"\` in \`clients/lsp/server.ts\`, adds its reason row to \`tests/config/lsp-idle-eviction-reasons.json\`, and moves its id from NEXT_PHASE_ELIGIBLE_IDS to TRANSPARENT_IDS in \`tests/config/lsp-idle-eviction-registry.test.ts\` (#3952's class pin). Nothing is ever demoted here: a declared-transparent server the measurement vetoes is the drift issue's job (#3645).`,
		"",
		"| server | night 1 (day, rss MB, cold start ms) | night 2 (day, rss MB, cold start ms) | nights eligible |",
		"|---|---|---|---|",
		...promoted.map((p) => {
			const cell = (n) => `${n.day}, ${n.rssMb}, ${n.coldMs}`;
			return `| ${p.serverId} | ${cell(p.nights[0])} | ${cell(p.nights[1])} | ${p.nights.length} |`;
		}),
	];
	if (skipped.length) {
		lines.push("", "Not promoted this run:", "");
		for (const s of skipped) lines.push(`- ${s.serverId}: ${s.reason}`);
	}
	if (runUrl) lines.push("", `Measured by workflow run: ${runUrl}`);
	lines.push(
		"",
		`<!-- idle-evict-set: ${promoted
			.map((p) => p.serverId)
			.sort()
			.join(",")} -->`,
	);
	lines.push(
		"",
		"To trigger it: the nightly `tool-smoke` run on master, or `workflow_dispatch` of `tool-smoke` on master. Two runs on one UTC day count as one night.",
		"",
		"This PR is created with the repository `GITHUB_TOKEN`, which cannot trigger workflow runs. A maintainer must close and reopen it to arm CI.",
		"",
		"Refs #3989, #3645, #3622, #1332.",
	);
	return `${lines.join("\n")}\n`;
}

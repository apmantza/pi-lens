/**
 * #3989: the nightly's idle-eviction promotion rule, the source edit it makes,
 * and the bookkeeping it keeps in the capability matrix's refresh state.
 *
 * Recurrences this prevents:
 *  - #3645 left `proposal` findings only in a step log: 18 servers measured
 *    eligible on 2026-10-06 and nothing acted on them. The rule is now code, so
 *    it is tested here, not remembered.
 *  - the #3622 shape: a policy flip with no per-server evidence. Every guard
 *    below (consecutive nights, RSS floor, cold-start cap, hold list) is the
 *    evidence the flip must carry; each has a case that goes red when it is
 *    neutered.
 *  - the #3401 shape: bookkeeping dropped by a sibling writer. The matrix
 *    refresh rewrites the whole refresh-state block, so a case here proves it
 *    carries the `idle-eviction` key through.
 *  - a factory-built server shares one `idleEviction` line; editing "its" line
 *    would flip every sibling. The edit fails closed on any line that is not
 *    provably the server's own.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	COLD_START_MAX_MS,
	IDLE_EVICTION_MIN_RSS_BYTES,
	PROMOTE_NIGHTS,
	addReasons,
	advanceNights,
	holdList,
	moveClassId,
	parseRejectedServers,
	planPromotions,
	promoteDeclaration,
	selectPromotions,
	type NightState,
} from "../../scripts/lib/lsp-idle-eviction-promote.mjs";
import type { IdleEvictionRow } from "../../scripts/lib/lsp-idle-eviction-doc.mjs";
import {
	IDLE_EVICTION_KEY,
	type IdleEvictionNight,
	parseRefreshState,
	refreshCapabilityMatrix,
	setIdleEvictionState,
} from "../../scripts/lib/md-matrix.mjs";
import { promoteFromSummary } from "../../scripts/promote-lsp-idle-eviction.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const REAL_REGISTRY_TS = fs.readFileSync(
	path.join(repoRoot, "tests/config/lsp-idle-eviction-registry.test.ts"),
	"utf8",
);

/** The ids of one class array in the REAL registry test (#3952), at run time. */
function realClass(name: string): string[] {
	const body = new RegExp(`const ${name} = \\[([^\\]]*)\\] as const;`).exec(
		REAL_REGISTRY_TS,
	)?.[1];
	return [...(body ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const MB = 1024 * 1024;
const D1 = "2026-10-06";
const D2 = "2026-10-07";
const D3 = "2026-10-08";

function row(
	serverId: string,
	over: Partial<IdleEvictionRow> = {},
): IdleEvictionRow {
	return {
		serverId,
		declared: "unmeasured",
		result: "eligible",
		respawn: "ok",
		coverage: "preserved",
		rssBytes: 120 * MB,
		coldStartMs: 1500,
		...over,
	};
}

/** Run `advanceNights` over consecutive days, returning the last state. */
function nights(
	days: readonly string[],
	rowsFor: (day: string) => IdleEvictionRow[],
): NightState {
	let state: NightState | undefined;
	for (const day of days) state = advanceNights(state, rowsFor(day), day);
	return state as NightState;
}

/** The registry test's class arrays in their real shape (#3952), minimal. */
const FIXTURE_REGISTRY_TS = `const TRANSPARENT_IDS = [
\t"marksman",
] as const;
const NEXT_PHASE_ELIGIBLE_IDS = [
\t"java",
\t"json",
\t"toml",
\t"zizmor",
] as const;
const HOLD_INDEXER_IDS = [
\t"indexer",
] as const;
const UNPROVEN_IDS = [
\t"dup",
\t"reordered",
] as const;
`;
const FIXTURE_HOLD = holdList(FIXTURE_REGISTRY_TS) as Map<string, string>;
const FIXTURE_PREFIX_SERVER_TS = `export const DockerServer: LSPServerInfo = {
\tid: "docker",
\tidleEviction: "unmeasured",
};

export const DockerOfficialServer: LSPServerInfo = {
\tid: "docker-official",
\tidleEviction: "unmeasured",
};
`;
const FIXTURE_PREFIX_REGISTRY_TS = FIXTURE_REGISTRY_TS.replace(
	'\t"json",',
	'\t"docker",\n\t"docker-official",',
);

describe("consecutive-night hysteresis (#3989)", () => {
	it("counts one qualifying night as pending, two as promotable", () => {
		const one = nights([D1], () => [row("json")]);
		expect(one.json.nights).toHaveLength(1);
		expect(selectPromotions(one, FIXTURE_HOLD).promote).toEqual([]);
		expect(selectPromotions(one, FIXTURE_HOLD).skipped[0].reason).toContain(
			"1/2",
		);
		const two = nights([D1, D2], () => [row("json")]);
		expect(
			selectPromotions(two, FIXTURE_HOLD).promote.map((p) => p.serverId),
		).toEqual(["json"]);
	});

	it("counts a night at exactly the RSS floor and at exactly the cold-start cap", () => {
		const state = nights([D1], () => [
			row("json", {
				rssBytes: IDLE_EVICTION_MIN_RSS_BYTES,
				coldStartMs: COLD_START_MAX_MS,
			}),
		]);
		expect(state.json.nights).toHaveLength(1);
	});

	it("counts two runs on one UTC day once (a manual dispatch is not a second night)", () => {
		const state = nights([D1, D1], () => [row("json")]);
		expect(state.json.nights).toHaveLength(1);
		expect(selectPromotions(state, FIXTURE_HOLD).promote).toEqual([]);
	});

	// An unavailable, inconclusive, vetoed, narrowed, or absent night is not a
	// consecutive eligible night: the count restarts, so a flapping server needs
	// two fresh good nights.
	it.each<[string, Partial<IdleEvictionRow> | null]>([
		["unavailable", { result: "unavailable", reason: "tool-unavailable" }],
		["inconclusive", { result: "inconclusive", reason: "no-baseline" }],
		["vetoed", { result: "vetoed", reason: "respawn-failed" }],
		["respawn failed", { respawn: "failed" }],
		["coverage narrowed", { coverage: "narrowed" }],
		["idle RSS below the floor", { rssBytes: IDLE_EVICTION_MIN_RSS_BYTES - 1 }],
		["idle RSS not measured", { rssBytes: null }],
		["cold start n/a", { coldStartMs: undefined }],
		["cold start over the cap", { coldStartMs: COLD_START_MAX_MS + 1 }],
		["no row at all", null],
	])("resets the count on a %s night", (_name, bad) => {
		const state = nights([D1, D2, D3], (day) =>
			day === D2 ? (bad ? [row("json", bad)] : []) : [row("json")],
		);
		expect(state.json.nights).toHaveLength(1);
		expect(state.json.nights[0].day).toBe(D3);
		expect(selectPromotions(state, FIXTURE_HOLD).promote).toEqual([]);
	});

	// A settled (two-night) entry is the one a bad night must still drop: a
	// vetoed night after two good ones means the server is no longer proven.
	it("drops a settled entry on a later bad night, and restarts from one", () => {
		const D4 = "2026-10-09";
		const state = nights([D1, D2, D3, D4], (day) =>
			day === D3
				? [row("json", { result: "vetoed", respawn: "failed" })]
				: [row("json")],
		);
		expect(state.json.nights.map((n) => n.day)).toEqual([D4]);
		expect(
			nights([D1, D2, D3], (day) =>
				day === D3
					? [row("json", { result: "vetoed", respawn: "failed" })]
					: [row("json")],
			).json,
		).toBeUndefined();
	});

	it("leaves a settled entry byte-identical on later nights, so the refresh PR does not churn", () => {
		const settled = nights([D1, D2], () => [row("json")]);
		const later = advanceNights(
			settled,
			[row("json", { rssBytes: 300 * MB, coldStartMs: 900 })],
			D3,
		);
		expect(later).toEqual(settled);
	});

	it("tracks and promotes only servers still declared unmeasured", () => {
		for (const declared of ["transparent", "resident"]) {
			expect(advanceNights(undefined, [row("x", { declared })], D1)).toEqual(
				{},
			);
		}
	});
});

describe("RSS floor, cold-start cap and hold list (#3989)", () => {
	const pair = (
		a: Partial<IdleEvictionNight>,
		b: Partial<IdleEvictionNight>,
	): NightState => ({
		json: {
			nights: [
				{ day: D1, rssMb: 120, coldMs: 1500, ...a },
				{ day: D2, rssMb: 120, coldMs: 1500, ...b },
			],
		},
	});

	it("promotes at the floor and skips below it, judging the lower of the two nights", () => {
		const floorMb = IDLE_EVICTION_MIN_RSS_BYTES / MB;
		expect(
			selectPromotions(pair({ rssMb: floorMb }, {}), FIXTURE_HOLD).promote,
		).toHaveLength(1);
		const below = selectPromotions(
			pair({}, { rssMb: floorMb - 1 }),
			FIXTURE_HOLD,
		);
		expect(below.promote).toEqual([]);
		expect(below.skipped[0].reason).toContain("below the 50 MB floor");
	});

	it("skips a server whose idle RSS was not measured on a night", () => {
		const out = selectPromotions(pair({ rssMb: null }, {}), FIXTURE_HOLD);
		expect(out.promote).toEqual([]);
		expect(out.skipped[0].reason).toContain("not measured");
	});

	it("promotes at the cold-start cap and skips above it, judging the worse of the two nights", () => {
		expect(
			selectPromotions(pair({ coldMs: COLD_START_MAX_MS }, {}), FIXTURE_HOLD)
				.promote,
		).toHaveLength(1);
		const over = selectPromotions(
			pair({ coldMs: 1000 }, { coldMs: COLD_START_MAX_MS + 1 }),
			FIXTURE_HOLD,
		);
		expect(over.promote).toEqual([]);
		expect(over.skipped[0].reason).toContain("exceeds the 3000 ms cap");
		const first = selectPromotions(
			pair({ coldMs: COLD_START_MAX_MS + 1 }, { coldMs: 1000 }),
			FIXTURE_HOLD,
		);
		expect(first.promote).toEqual([]);
	});

	it("never promotes a held server, and names why", () => {
		const state = nights([D1, D2], () => [row("indexer")]);
		const out = selectPromotions(state, FIXTURE_HOLD);
		expect(out.promote).toEqual([]);
		expect(out.skipped[0].reason).toContain("HOLD_INDEXER");
	});

	// #3989 F3, after #3966 merged: the hold list IS #3952's class array, so the
	// two cannot drift. Recurrence: a second hand list (docker, python-jedi held
	// "until #3966") outliving the PR it names.
	it("holds exactly the real registry test's HOLD_INDEXER class, nothing else", () => {
		const hold = holdList(REAL_REGISTRY_TS) as Map<string, string>;
		expect([...hold.keys()].sort()).toEqual([
			"expert",
			"kotlin",
			"powershell",
			"rust",
			"svelte",
		]);
		for (const id of ["docker", "docker-official", "python-jedi"])
			expect(hold.has(id), id).toBe(false);
	});

	it("reads no hold list from a file whose class array is missing, empty or reshaped", () => {
		expect(holdList("")).toBeNull();
		expect(holdList("const HOLD_INDEXER_IDS = [\n] as const;\n")).toBeNull();
		expect(
			holdList('const HOLD_INDEXER_IDS = [\n\t"a", // why\n] as const;\n'),
		).toBeNull();
	});
});

const FIXTURE_SERVER_TS = `export const RustServer: LSPServerInfo = {
\tid: "json",
\tidleEviction: "unmeasured",
\tname: "vscode-json-ls",
};

export const MarksmanServer: LSPServerInfo = {
\tid: "marksman",
\tidleEviction: "transparent",
\tname: "Marksman",
};

export const JavaServer = createInteractiveServer({
\tid: "java",
\tname: "JDT Language Server",
});

export const DupA: LSPServerInfo = {
\tid: "dup",
\tidleEviction: "unmeasured",
};

export const DupB: LSPServerInfo = {
\tid: "dup",
\tidleEviction: "unmeasured",
};

export const Reordered: LSPServerInfo = {
\tid: "reordered",
\tname: "Reordered",
\tidleEviction: "unmeasured",
};

export const Toml: LSPServerInfo = {
\tid: "toml",
\tidleEviction: "unmeasured",
};

export const Zizmor: LSPServerInfo = {
\tid: "zizmor",
\tidleEviction: "unmeasured",
};

function createInteractiveServer(spec: { id: string }): LSPServerInfo {
\treturn {
\t\tid: spec.id,
\t\tidleEviction: "unmeasured",
\t};
}
`;

describe("the structured declaration edit (#3989)", () => {
	it("flips exactly the server's own idleEviction line and nothing else", () => {
		const out = promoteDeclaration(FIXTURE_SERVER_TS, "json");
		expect(out.ok).toBe(true);
		const before = FIXTURE_SERVER_TS.split("\n");
		const after = (out as { text: string }).text.split("\n");
		const changed = after.flatMap((l, i) => (l !== before[i] ? [i] : []));
		expect(changed).toEqual([2]);
		expect(after[2]).toBe('\tidleEviction: "transparent",');
		expect(after).toHaveLength(before.length);
	});

	it.each([
		[
			"a shared-factory server with no idleEviction line of its own",
			"java",
			"no `idleEviction:` line directly after",
		],
		["an ambiguous id (two definitions)", "dup", "ambiguous"],
		[
			"an idleEviction line that is not directly after the id",
			"reordered",
			"no `idleEviction:` line directly after",
		],
		["an id that is not defined", "ghost", 'no `id: "ghost",` definition'],
		[
			"a server already declared transparent",
			"marksman",
			"already declared transparent",
		],
	])("fails closed on %s", (_name, id, reason) => {
		const out = promoteDeclaration(FIXTURE_SERVER_TS, id);
		expect(out).toEqual({ ok: false, reason: expect.stringContaining(reason) });
	});

	it("never edits the factory's shared line", () => {
		const out = promoteDeclaration(FIXTURE_SERVER_TS, "spec.id");
		expect(out.ok).toBe(false);
	});

	// Real-shape witness: the edit is exercised on the shipped registry source,
	// not only the fixture, so a reshaped definition cannot silently turn every
	// promotion into a skip.
	it("locates a real direct definition, and refuses a real factory-built one", () => {
		const real = fs.readFileSync(
			path.join(repoRoot, "clients/lsp/server.ts"),
			"utf8",
		);
		// An id the nightly never promotes (HOLD_INDEXER class), so the witness
		// cannot go stale when the promotion PR flips NEXT_PHASE servers (#3994 r3:
		// a hard-coded json here went red after a real plan).
		const witnessId = realClass("HOLD_INDEXER_IDS")[0];
		expect(witnessId, "a HOLD_INDEXER id").toBeDefined();
		const witness = promoteDeclaration(real, witnessId);
		expect(witness.ok, witnessId).toBe(true);
		const diff = real
			.split("\n")
			.flatMap((l, i) =>
				l !== (witness as { text: string }).text.split("\n")[i] ? [l] : [],
			);
		expect(diff).toEqual(['\tidleEviction: "unmeasured",']);
		expect(promoteDeclaration(real, "java")).toMatchObject({ ok: false });
		expect(promoteDeclaration(real, "typescript")).toEqual({
			ok: false,
			reason: "already declared transparent",
		});
	});
});

describe("the reasons-file edit (#3989)", () => {
	const real = fs.readFileSync(
		path.join(repoRoot, "tests/config/lsp-idle-eviction-reasons.json"),
		"utf8",
	);

	it("appends a reason in the file's own canonical format", () => {
		const out = addReasons(real, { "zz-no-such-server": "because" });
		expect(out.ok).toBe(true);
		const text = (out as { text: string }).text;
		expect(JSON.parse(text)).toEqual({
			...JSON.parse(real),
			"zz-no-such-server": "because",
		});
		expect(text.endsWith('"because"\n}\n')).toBe(true);
	});

	it("fails closed on a file it would reformat or cannot parse", () => {
		expect(addReasons(real.replaceAll("\t", "  "), { a: "b" })).toEqual({
			ok: false,
			reason: "reasons file is not canonically formatted",
		});
		expect(addReasons("{", { a: "b" })).toEqual({
			ok: false,
			reason: "reasons file is not valid JSON",
		});
	});
});

describe("planPromotions (#3989)", () => {
	const reasonsText = `{\n\t"typescript": "x"\n}\n`;
	const two = (rows: IdleEvictionRow[]) =>
		planPromotions({
			rows,
			prior: nights([D1], () => rows),
			today: D2,
			serverSource: FIXTURE_SERVER_TS,
			reasonsText,
			registrySource: FIXTURE_REGISTRY_TS,
			runUrl: "https://example.test/run/1",
		});

	it("edits the source, adds the reason and renders both nights for a promoted server", () => {
		const plan = two([row("json"), row("java")]);
		expect(plan.promoted.map((p) => p.serverId)).toEqual(["json"]);
		expect(plan.skipped).toEqual([
			{
				serverId: "java",
				reason: expect.stringContaining("no `idleEviction:`"),
			},
		]);
		expect(plan.serverSource).toContain(
			'\tid: "json",\n\tidleEviction: "transparent",',
		);
		expect(JSON.parse(plan.reasonsText).json).toContain("#3989");
		expect(plan.body).toContain(
			"| json | 2026-10-06, 120, 1500 | 2026-10-07, 120, 1500 | 2 |",
		);
		expect(plan.body).toContain("https://example.test/run/1");
		expect(plan.body).toContain("workflow_dispatch");
	});

	it("promotes nothing when the reasons file cannot be edited (the registry test would red)", () => {
		const plan = planPromotions({
			rows: [row("json")],
			prior: nights([D1], () => [row("json")]),
			today: D2,
			serverSource: FIXTURE_SERVER_TS,
			reasonsText: "{}",
			registrySource: FIXTURE_REGISTRY_TS,
		});
		expect(plan.promoted).toEqual([]);
		expect(plan.serverSource).toBe(FIXTURE_SERVER_TS);
		expect(plan.body).toBeNull();
	});

	it("is a no-op for a server already transparent and never demotes a vetoed one", () => {
		const plan = planPromotions({
			rows: [
				row("marksman", { declared: "transparent" }),
				row("typescript", {
					declared: "transparent",
					result: "vetoed",
					respawn: "failed",
				}),
			],
			prior: undefined,
			today: D2,
			serverSource: FIXTURE_SERVER_TS,
			reasonsText,
			registrySource: FIXTURE_REGISTRY_TS,
		});
		expect(plan.promoted).toEqual([]);
		expect(plan.serverSource).toBe(FIXTURE_SERVER_TS);
		expect(plan.state).toEqual({});
	});

	it("requires PROMOTE_NIGHTS to be the two the issue states", () => {
		expect(PROMOTE_NIGHTS).toBe(2);
	});
});

describe("the refresh-state seam (#3989)", () => {
	const MATRIX = [
		"# LSP capability matrix",
		"",
		"| lang | server | mode | clean-behavior | first-publish | tier | src |",
		"|---|---|---|---|---|---|---|",
		"| vue | @vue/language-server | push-only | unknown | direct | 2/3? | dev+ci |",
		"",
	].join("\n");
	const state: NightState = {
		json: { nights: [{ day: D1, rssMb: 120, coldMs: 1500 }] },
	};

	it("round-trips through the shared block", () => {
		const text = setIdleEvictionState(MATRIX, state);
		expect(parseRefreshState(text)[IDLE_EVICTION_KEY]).toEqual(state);
		expect(setIdleEvictionState(text, {})).toBe(`${MATRIX.trimEnd()}\n`);
	});

	// #3401 shape: the matrix refresh rewrites the whole block every night, before
	// the promotion step reads it. Without the carry-through it would erase the
	// night memory each night and no server could ever reach two nights.
	it("survives the nightly matrix refresh that rewrites the block", () => {
		const text = setIdleEvictionState(MATRIX, state);
		const refreshed = refreshCapabilityMatrix(
			text,
			[{ lang: "vue", firstPublish: "direct" }],
			{ now: D2 },
		).text;
		expect(parseRefreshState(refreshed)[IDLE_EVICTION_KEY]).toEqual(state);
	});

	it("keeps the other keys when it writes, and drops malformed nights", () => {
		const withFp = refreshCapabilityMatrix(MATRIX, [], { now: D1 }).text;
		expect(parseRefreshState(withFp)["first-publish"]).toBeDefined();
		const text = setIdleEvictionState(withFp, {
			...state,
			junk: { nights: [{ day: "nope", rssMb: 1, coldMs: 1 }] },
			// biome-ignore lint: deliberately malformed
		} as never);
		const parsed = parseRefreshState(text);
		expect(parsed["first-publish"]).toBeDefined();
		expect(parsed[IDLE_EVICTION_KEY]).toEqual(state);
	});
});

describe("the nightly driver, end to end on files (#3989)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0))
			fs.rmSync(d, { recursive: true, force: true });
	});

	function workspace() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-idle-promote-"));
		dirs.push(dir);
		const file = (name: string, text: string) => {
			fs.writeFileSync(path.join(dir, name), text);
			return path.join(dir, name);
		};
		return {
			dir,
			matrixPath: file(
				"matrix.md",
				"# m\n\n| lang | server |\n|---|---|\n| vue | v |\n",
			),
			serverPath: file("server.ts", FIXTURE_SERVER_TS),
			reasonsPath: file("reasons.json", `{\n\t"typescript": "x"\n}\n`),
			registryPath: file("registry.test.ts", FIXTURE_REGISTRY_TS),
			bodyPath: path.join(dir, "body.md"),
			changelogPath: path.join(dir, "3989-lsp-idle-eviction-promote.md"),
			summary: (rows: object[]) =>
				file("summary.json", JSON.stringify({ rows })),
		};
	}

	it("holds night one, promotes on night two, and leaves a vetoed night alone", () => {
		const ws = workspace();
		const rows = [row("json"), row("marksman", { declared: "transparent" })];
		const run = (summaryPath: string | undefined, today: string) =>
			promoteFromSummary({
				summaryPath,
				bodyPath: ws.bodyPath,
				matrixPath: ws.matrixPath,
				serverPath: ws.serverPath,
				reasonsPath: ws.reasonsPath,
				registryPath: ws.registryPath,
				changelogPath: ws.changelogPath,
				today,
				log: () => {},
			});
		expect(run(ws.summary(rows), D1)).toEqual([]);
		expect(fs.readFileSync(ws.serverPath, "utf8")).toBe(FIXTURE_SERVER_TS);
		expect(
			parseRefreshState(fs.readFileSync(ws.matrixPath, "utf8"))[
				IDLE_EVICTION_KEY
			]?.json.nights,
		).toHaveLength(1);

		expect(run(ws.summary(rows), D2)).toEqual(["json"]);
		expect(fs.readFileSync(ws.serverPath, "utf8")).toContain(
			'\tid: "json",\n\tidleEviction: "transparent",',
		);
		expect(
			JSON.parse(fs.readFileSync(ws.reasonsPath, "utf8")).json,
		).toBeTruthy();
		expect(fs.readFileSync(ws.bodyPath, "utf8")).toContain("| json |");
		const changelog = fs.readFileSync(ws.changelogPath, "utf8");
		expect(changelog).toContain("section: Changed");
		expect(changelog).toContain("audience: user");
		expect(changelog).toContain("`json`");
		expect(changelog).toContain("refs #3989");
	});

	it("retains earlier promoted servers until the release consumes the fragment", () => {
		const ws = workspace();
		const next = workspace();
		const run = (target: typeof ws, serverId: string, today: string) =>
			promoteFromSummary({
				summaryPath: target.summary([row(serverId)]),
				bodyPath: target.bodyPath,
				matrixPath: target.matrixPath,
				serverPath: target.serverPath,
				reasonsPath: target.reasonsPath,
				registryPath: target.registryPath,
				changelogPath: ws.changelogPath,
				today,
				log: () => {},
			});

		expect(run(ws, "json", D1)).toEqual([]);
		expect(run(ws, "json", D2)).toEqual(["json"]);
		expect(run(next, "zizmor", D1)).toEqual([]);
		expect(run(next, "zizmor", D2)).toEqual(["zizmor"]);
		const changelog = fs.readFileSync(ws.changelogPath, "utf8");
		expect(changelog).toContain("`json`");
		expect(changelog).toContain("`zizmor`");
	});

	it("clears the night memory when the measurement left no summary", () => {
		const ws = workspace();
		const base = {
			bodyPath: ws.bodyPath,
			matrixPath: ws.matrixPath,
			serverPath: ws.serverPath,
			reasonsPath: ws.reasonsPath,
			registryPath: ws.registryPath,
			log: () => {},
		};
		promoteFromSummary({
			...base,
			summaryPath: ws.summary([row("json")]),
			today: D1,
		});
		promoteFromSummary({
			...base,
			summaryPath: path.join(ws.dir, "absent.json"),
			today: D2,
		});
		expect(
			parseRefreshState(fs.readFileSync(ws.matrixPath, "utf8"))[
				IDLE_EVICTION_KEY
			],
		).toBeUndefined();
		// night three is therefore night one again, not a second consecutive night.
		expect(
			promoteFromSummary({
				...base,
				summaryPath: ws.summary([row("json")]),
				today: D3,
			}),
		).toEqual([]);
		expect(fs.readFileSync(ws.serverPath, "utf8")).toBe(FIXTURE_SERVER_TS);
	});

	it("never throws on an unreadable doc", () => {
		const logged: string[] = [];
		expect(
			promoteFromSummary({
				matrixPath: "/nonexistent/m.md",
				serverPath: "/nonexistent/s.ts",
				reasonsPath: "/nonexistent/r.json",
				registryPath: "/nonexistent/t.ts",
				today: D1,
				log: (l) => logged.push(l),
			}),
		).toEqual([]);
		expect(logged[0]).toContain("idle-eviction promotion:");
	});
});

describe("calendar adjacency of nights (#3989 F2)", () => {
	// Recurrence: a single night held from 2026-09-01 plus a run on 2026-10-06
	// promoted json, because only "not today" was checked. A skipped night is
	// not a consecutive one.
	it("restarts the count when the held night is not yesterday", () => {
		const prior = {
			json: { nights: [{ day: "2026-09-01", rssMb: 120, coldMs: 1500 }] },
		};
		const next = advanceNights(prior, [row("json")], D1);
		expect(next.json.nights).toEqual([{ day: D1, rssMb: 120, coldMs: 1500 }]);
		expect(selectPromotions(next, FIXTURE_HOLD).promote).toEqual([]);
	});

	it("keeps a night held from the previous UTC day, across a month boundary", () => {
		const prior = {
			json: { nights: [{ day: "2026-09-30", rssMb: 120, coldMs: 1500 }] },
		};
		const next = advanceNights(prior, [row("json")], "2026-10-01");
		expect(next.json.nights.map((n) => n.day)).toEqual([
			"2026-09-30",
			"2026-10-01",
		]);
	});

	it("restarts on a future-dated held night", () => {
		const prior = {
			json: { nights: [{ day: "2026-10-09", rssMb: 120, coldMs: 1500 }] },
		};
		expect(advanceNights(prior, [row("json")], D1).json.nights).toHaveLength(1);
	});
});

describe("the registry test's class pin (#3989 F1)", () => {
	// Recurrence (review of #3994): every promotion reds CI because
	// lsp-idle-eviction-registry.test.ts pins each id to one class and requires
	// the non-transparent classes to stay unmeasured.
	const ids = (src: string, name: string) =>
		[
			...(
				new RegExp(`const ${name} = \\[([^\\]]*)\\] as const;`).exec(
					src,
				)?.[1] ?? ""
			).matchAll(/"([^"]+)"/g),
		].map((m) => m[1]);

	it("moves the id from NEXT_PHASE_ELIGIBLE_IDS to TRANSPARENT_IDS and touches nothing else", () => {
		const out = moveClassId(FIXTURE_REGISTRY_TS, "json");
		expect(out.ok).toBe(true);
		const text = (out as { text: string }).text;
		expect(ids(text, "TRANSPARENT_IDS")).toEqual(["marksman", "json"]);
		expect(ids(text, "NEXT_PHASE_ELIGIBLE_IDS")).toEqual([
			"java",
			"toml",
			"zizmor",
		]);
		expect(ids(text, "HOLD_INDEXER_IDS")).toEqual(["indexer"]);
		expect(ids(text, "UNPROVEN_IDS")).toEqual(["dup", "reordered"]);
	});

	it("also moves correctly when the target array follows the source array", () => {
		const swapped = FIXTURE_REGISTRY_TS.split("const ").filter(Boolean);
		const reordered = `const ${[swapped[1], swapped[0], swapped[2], swapped[3]].join("const ")}`;
		const out = moveClassId(reordered, "zizmor");
		expect(out.ok).toBe(true);
		const text = (out as { text: string }).text;
		expect(ids(text, "TRANSPARENT_IDS")).toEqual(["marksman", "zizmor"]);
		expect(ids(text, "NEXT_PHASE_ELIGIBLE_IDS")).toEqual([
			"java",
			"json",
			"toml",
		]);
	});

	it.each([
		[
			"an id in the HOLD_INDEXER class",
			"indexer",
			"NEXT_PHASE_ELIGIBLE_IDS class",
		],
		["an id in the UNPROVEN class", "dup", "NEXT_PHASE_ELIGIBLE_IDS class"],
		[
			"an id already in TRANSPARENT_IDS",
			"marksman",
			"NEXT_PHASE_ELIGIBLE_IDS class",
		],
		["an unclassified id", "ghost", "NEXT_PHASE_ELIGIBLE_IDS class"],
	])("fails closed on %s", (_n, id, why) => {
		expect(moveClassId(FIXTURE_REGISTRY_TS, id)).toEqual({
			ok: false,
			reason: expect.stringContaining(why),
		});
	});

	it("fails closed on an id listed in two classes, and on a missing array", () => {
		const dupe = FIXTURE_REGISTRY_TS.replace(
			"const UNPROVEN_IDS = [\n",
			'const UNPROVEN_IDS = [\n\t"json",\n',
		);
		expect(moveClassId(dupe, "json")).toEqual({
			ok: false,
			reason: "also listed in UNPROVEN_IDS",
		});
		expect(moveClassId("", "json")).toEqual({
			ok: false,
			reason: "registry test class arrays not found",
		});
	});

	// Real-source witness, ALL-eligible (#3994 F1/r3): apply a plan in which every
	// NEXT_PHASE_ELIGIBLE id and every HOLD_INDEXER id qualifies on two adjacent
	// nights to the REAL server.ts, reasons file and registry test, then check what
	// the consumers pin: #3952's class pin (here, on the edited text) and the
	// declaration of every server the plan did not touch. The consumer SUITES were
	// additionally run over the same plan applied to the tree (PR body, sweep).
	it("keeps the real registry consistent after an all-eligible plan", () => {
		const read = (rel: string) =>
			fs.readFileSync(path.join(repoRoot, rel), "utf8");
		const realServer = read("clients/lsp/server.ts");
		const nextPhase = realClass("NEXT_PHASE_ELIGIBLE_IDS");
		const holds = realClass("HOLD_INDEXER_IDS");
		const qualifying = [...nextPhase, ...holds];
		expect(holds.length, "indexer holds exist").toBeGreaterThan(0);
		const plan = planPromotions({
			rows: qualifying.map((id) => row(id)),
			prior: nights([D1], () => qualifying.map((id) => row(id))),
			today: D2,
			serverSource: realServer,
			reasonsText: read("tests/config/lsp-idle-eviction-reasons.json"),
			registrySource: REAL_REGISTRY_TS,
		});
		// Promotable = an eligible id whose own declaration line is locatable;
		// factory-built ones are skipped with a reason, indexers are held.
		const locatable = nextPhase.filter(
			(id) => promoteDeclaration(realServer, id).ok,
		);
		expect(plan.promoted.map((p) => p.serverId).sort()).toEqual(
			[...locatable].sort(),
		);
		expect(plan.skipped.map((x) => x.serverId).sort()).toEqual(
			[...nextPhase.filter((id) => !locatable.includes(id)), ...holds].sort(),
		);
		// Exactly the promoted servers' own idleEviction lines changed, nothing else
		// (`id: "docker"` must not match `id: "docker-official"`).
		const before = realServer.split("\n");
		const after = plan.serverSource.split("\n");
		expect(after).toHaveLength(before.length);
		expect(after.filter((l, i) => l !== before[i])).toEqual(
			Array(locatable.length).fill('\tidleEviction: "transparent",'),
		);
		const declared = (id: string) =>
			new RegExp(`\\tid: "${id}",\\n\\tidleEviction: "(\\w+)"`).exec(
				plan.serverSource,
			)?.[1];
		const classes = [
			"TRANSPARENT_IDS",
			"NEXT_PHASE_ELIGIBLE_IDS",
			"HOLD_INDEXER_IDS",
			"UNPROVEN_IDS",
		];
		for (const id of ids(plan.registrySource, "TRANSPARENT_IDS"))
			expect(declared(id) ?? "transparent", `${id} is transparent`).toBe(
				"transparent",
			);
		for (const name of classes.slice(1))
			for (const id of ids(plan.registrySource, name))
				expect(declared(id) ?? "unmeasured", `${id} stays unmeasured`).toBe(
					"unmeasured",
				);
		const all = classes.flatMap((n) => ids(plan.registrySource, n));
		expect(new Set(all).size).toBe(all.length);
		expect(all.length).toBe(
			classes.flatMap((n) => ids(REAL_REGISTRY_TS, n)).length,
		);
		for (const id of locatable) {
			expect(declared(id), id).toBe("transparent");
			expect(JSON.parse(plan.reasonsText)[id], id).toContain("#3989");
		}
		// The promoted copy of the registry test stays in oxfmt's layout, so the
		// `oxfmt --check` gate that runs on the bot PR passes (probe in the PR body).
		expect(plan.registrySource).toContain("const TRANSPARENT_IDS = [\n");
	});

	// #3994 r4: `id: "docker"` is a prefix of `id: "docker-official"`. A prefix
	// matcher sees two definitions and refuses the docker promotion; an exact one
	// edits docker's own line and leaves docker-official's byte-identical. Keep
	// this pair in a fixture because the real registry is now allowed to promote
	// docker; a self-modifying bot test must not name a mutable real-state value.
	it("promotes docker alone on a prefix-pair fixture and leaves docker-official's line untouched", () => {
		const realServer = FIXTURE_PREFIX_SERVER_TS;
		const plan = planPromotions({
			rows: [row("docker")],
			prior: nights([D1], () => [row("docker")]),
			today: D2,
			serverSource: realServer,
			reasonsText: fs.readFileSync(
				path.join(repoRoot, "tests/config/lsp-idle-eviction-reasons.json"),
				"utf8",
			),
			registrySource: FIXTURE_PREFIX_REGISTRY_TS,
		});
		expect(plan.promoted.map((p) => p.serverId)).toEqual(["docker"]);
		const lineAfter = (text: string, id: string) => {
			const lines = text.split("\n");
			return lines[lines.indexOf(`\tid: "${id}",`) + 1];
		};
		expect(lineAfter(plan.serverSource, "docker")).toBe(
			'\tidleEviction: "transparent",',
		);
		expect(lineAfter(plan.serverSource, "docker-official")).toBe(
			lineAfter(realServer, "docker-official"),
		);
		const before = realServer.split("\n");
		const changed = plan.serverSource
			.split("\n")
			.filter((l, i) => l !== before[i]);
		expect(changed).toEqual(['\tidleEviction: "transparent",']);
	});

	it("promotes nothing when the registry test cannot take the move", () => {
		const plan = planPromotions({
			rows: [row("json")],
			prior: nights([D1], () => [row("json")]),
			today: D2,
			serverSource: FIXTURE_SERVER_TS,
			reasonsText: `{\n\t"typescript": "x"\n}\n`,
			registrySource: FIXTURE_REGISTRY_TS.replace('\t"json",\n', ""),
		});
		expect(plan.promoted).toEqual([]);
		expect(plan.serverSource).toBe(FIXTURE_SERVER_TS);
		expect(plan.skipped[0].reason).toContain("NEXT_PHASE_ELIGIBLE_IDS");
	});

	it("promotes nothing at all when the hold list is unreadable", () => {
		const plan = planPromotions({
			rows: [row("json")],
			prior: nights([D1], () => [row("json")]),
			today: D2,
			serverSource: FIXTURE_SERVER_TS,
			reasonsText: `{\n\t"typescript": "x"\n}\n`,
			registrySource: "",
		});
		expect(plan.promoted).toEqual([]);
		expect(plan.skipped[0].reason).toContain("hold list unreadable");
	});
});

describe("a promotion PR closed unmerged is not re-created (#3989 F4)", () => {
	// Recurrence: create-pull-request force-rebuilds its branch nightly, so a PR a
	// maintainer closed would reopen the next night for the same servers.
	const base = {
		prior: nights([D1], () => [row("json"), row("toml"), row("zizmor")]),
		rows: [row("json"), row("toml"), row("zizmor")],
		today: D2,
		serverSource: FIXTURE_SERVER_TS,
		reasonsText: `{\n\t"typescript": "x"\n}\n`,
		registrySource: FIXTURE_REGISTRY_TS,
	};

	it("writes the server set into the body as a marker the next night can read", () => {
		const plan = planPromotions(base);
		expect(plan.body).toContain("<!-- idle-evict-set: json,toml,zizmor -->");
		expect(
			parseRejectedServers(`noise\n${plan.body}\n<!-- idle-evict-set: a,b -->`),
		).toEqual(new Set(["json", "toml", "zizmor", "a", "b"]));
	});

	// #3989 r3 (orchestrator decision): closing a promotion PR rejects each server
	// in its marker. Recurrence: matching only the exact set let `json,zizmor`
	// come back the night `toml` qualified, as `json,toml,zizmor`.
	it("skips every server of a closed set even when tonight's set differs", () => {
		const plan = planPromotions({
			...base,
			rejected: new Set(["json", "zizmor"]),
		});
		expect(plan.promoted.map((p) => p.serverId)).toEqual(["toml"]);
		expect(plan.skipped).toEqual(
			expect.arrayContaining([
				{
					serverId: "json",
					reason: expect.stringContaining("closed unmerged"),
				},
				{
					serverId: "zizmor",
					reason: expect.stringContaining("closed unmerged"),
				},
			]),
		);
		expect(plan.serverSource).toContain(
			'\tid: "toml",\n\tidleEviction: "transparent",',
		);
		expect(plan.serverSource).toContain(
			'\tid: "json",\n\tidleEviction: "unmeasured",',
		);
		expect(plan.body).toContain("<!-- idle-evict-set: toml -->");
	});

	it("promotes nothing when every qualifying server was rejected", () => {
		const plan = planPromotions({
			...base,
			rejected: new Set(["json", "toml", "zizmor"]),
		});
		expect(plan.promoted).toEqual([]);
		expect(plan.serverSource).toBe(FIXTURE_SERVER_TS);
		expect(plan.body).toBeNull();
	});

	it("promotes nothing when the closed-PR list could not be read", () => {
		const plan = planPromotions({ ...base, rejected: null });
		expect(plan.promoted).toEqual([]);
		expect(plan.skipped[0].reason).toContain("closed-PR list unreadable");
	});
});

describe("class arrays parse and write independent of layout (#3989 r3)", () => {
	// Recurrence: oxfmt collapses a short array onto one line, and the line-based
	// reader returned null for it, so a formatted registry test would silently
	// stop every promotion (or worse, a hold list read as absent).
	const arr = (name: string, ids: string[], oneLine: boolean) =>
		oneLine
			? `const ${name} = [${ids.map((i) => `"${i}"`).join(", ")}] as const;\n`
			: `const ${name} = [\n${ids.map((i) => `\t"${i}",\n`).join("")}] as const;\n`;

	it("reads the hold list from a one-line, multi-line and reformatted real array alike", () => {
		const one = holdList(arr("HOLD_INDEXER_IDS", ["a", "b"], true));
		const multi = holdList(arr("HOLD_INDEXER_IDS", ["a", "b"], false));
		expect([...(one as Map<string, string>).keys()].sort()).toEqual(["a", "b"]);
		expect([...(multi as Map<string, string>).keys()]).toEqual([
			...(one as Map<string, string>).keys(),
		]);
		const real = REAL_REGISTRY_TS.replace(
			/const HOLD_INDEXER_IDS = \[[^\]]*\] as const;/,
			(m) =>
				`const HOLD_INDEXER_IDS = [${[...m.matchAll(/"([^"]+)"/g)].map((x) => `"${x[1]}"`).join(", ")}] as const;`,
		);
		expect(real).not.toBe(REAL_REGISTRY_TS);
		expect([...(holdList(real) as Map<string, string>).keys()].sort()).toEqual(
			[...(holdList(REAL_REGISTRY_TS) as Map<string, string>).keys()].sort(),
		);
	});

	it.each([
		[
			"a trailing comment",
			'const HOLD_INDEXER_IDS = [\n\t"a", // why\n] as const;\n',
		],
		["a missing comma", 'const HOLD_INDEXER_IDS = ["a" "b"] as const;\n'],
		["a non-string element", 'const HOLD_INDEXER_IDS = ["a", b] as const;\n'],
		["a spread", "const HOLD_INDEXER_IDS = [...X] as const;\n"],
		[
			"a duplicated declaration",
			`${arr("HOLD_INDEXER_IDS", ["a"], true)}${arr("HOLD_INDEXER_IDS", ["b"], true)}`,
		],
		["an unterminated array", 'const HOLD_INDEXER_IDS = ["a",\n'],
	])("stays fail-closed on %s", (_n, src) => {
		expect(holdList(src)).toBeNull();
	});

	it("moves an id between arrays in any input layout and writes oxfmt's layout", () => {
		for (const oneLine of [true, false]) {
			const src = [
				arr("TRANSPARENT_IDS", ["marksman"], oneLine),
				arr("NEXT_PHASE_ELIGIBLE_IDS", ["json", "zizmor"], oneLine),
				arr("HOLD_INDEXER_IDS", ["indexer"], oneLine),
				arr("UNPROVEN_IDS", ["dup"], oneLine),
			].join("");
			const out = moveClassId(src, "json");
			expect(out).toEqual({
				ok: true,
				text: [
					'const TRANSPARENT_IDS = ["marksman", "json"] as const;\n',
					'const NEXT_PHASE_ELIGIBLE_IDS = ["zizmor"] as const;\n',
					arr("HOLD_INDEXER_IDS", ["indexer"], oneLine),
					arr("UNPROVEN_IDS", ["dup"], oneLine),
				].join(""),
			});
		}
	});

	// oxfmt (printWidth 80, tabs) keeps a top-level array on one line exactly while
	// the line fits in 80 columns; checked against the real binary in the PR
	// probe, pinned here at the boundary.
	it("breaks an array over 80 columns into one id per line, and keeps 80 on one line", () => {
		const stmt = (ids: string[]) =>
			`const TRANSPARENT_IDS = [${ids.map((i) => `"${i}"`).join(", ")}] as const;`;
		// The statement after the move is `["<pad>", "x"]`; size the pad so it is
		// exactly 80, then 81, columns.
		const pad = (cols: number) => "b".repeat(cols - stmt(["", "x"]).length);
		const src = (padId: string) =>
			[
				arr("TRANSPARENT_IDS", [padId], true),
				arr("NEXT_PHASE_ELIGIBLE_IDS", ["x"], true),
				arr("HOLD_INDEXER_IDS", ["h"], true),
				arr("UNPROVEN_IDS", [], true),
			].join("");
		const at80 = (moveClassId(src(pad(80)), "x") as { text: string }).text;
		expect(stmt([pad(80), "x"]).length).toBe(80);
		expect(at80).toContain(`${stmt([pad(80), "x"])}\n`);
		const at81 = (moveClassId(src(pad(81)), "x") as { text: string }).text;
		expect(at81).toContain(
			`const TRANSPARENT_IDS = [\n\t"${pad(81)}",\n\t"x",\n] as const;`,
		);
		// The emptied source array renders as `[]`, not a blank multi-line body.
		expect(at80).toContain("const NEXT_PHASE_ELIGIBLE_IDS = [] as const;");
	});
});

/**
 * #5667: the census of every generated measured column in the LSP docs.
 *
 * ## The recurrence this guards
 *
 * Three generated columns reached the committed docs from one night's
 * measurement with no agreement hold, each found only after a refresh PR had
 * carried a wrong cell: the capability matrix's `save` column (#3405, the
 * powershell flip of 2026-11-15) and the idle-eviction doc's `result`,
 * `respawn` and `coverage` columns (49ed14a6a flipped opengrep to
 * `unavailable`; a751c7a65 flipped csharp, dart and elixir). Each was caught in
 * review, one column at a time. This census names every column of every
 * generated table and, for each, either the hold that protects it or the
 * reason it has none, so the next generated column, or the next column that
 * loses its hold, fails here instead of in a review.
 *
 * The population is derived from the committed docs (every table in the three
 * generated docs), never from a list this file keeps of the tables it already
 * knows: a table nobody classified is a failure.
 *
 * `mode`, `save as declared` and the capability inventory's columns are
 * handshake facts: what the server advertises on `initialize`, a function of
 * the server build rather than a behavioural measurement a flaky night can
 * flip. They stay unheld, and the census records that they do.
 */
import * as fs from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	GENERATED_LSP_DOCS,
	IDLE_EVICTION_DOC_KEY,
	SAVE_VERDICT_KEY,
} from "../../scripts/lib/md-matrix.mjs";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(resolve(ROOT, rel), "utf8");

type Held = {
	/** The refresh-state key that carries the pending night. */
	state: string;
	/** The module that holds the column, and the seam call it must make. */
	via: string;
	seam: "holdSettledCell" | "advancePendingClass";
};
type Unheld = {
	kind: "handshake" | "registry" | "provenance" | "key" | "derived";
	why: string;
};
type Column = Held | Unheld;

const MATRIX = "docs/lsp-capability-matrix.md";
const CAPS = "docs/servercapabilities.md";
const IDLE = "docs/lsp-idle-eviction.md";

const heldByMatrix = (state: string): Held => ({
	state,
	via: "scripts/lib/md-matrix.mjs",
	seam: "advancePendingClass",
});
const saveHeld: Held = {
	state: SAVE_VERDICT_KEY,
	via: "scripts/lib/save-verdict.mjs",
	seam: "holdSettledCell",
};
const idleHeld: Held = {
	state: IDLE_EVICTION_DOC_KEY,
	via: "scripts/lib/lsp-idle-eviction-doc.mjs",
	seam: "holdSettledCell",
};
const key: Unheld = {
	kind: "key",
	why: "the row's identity, not a measurement",
};
const handshake = (why: string): Unheld => ({ kind: "handshake", why });
const provenance: Unheld = {
	kind: "provenance",
	why: "what the nightly ran (source, tool version, install route), recorded not measured",
};

/** Every generated table, by its exact header cells. */
const TABLES: Array<{
	doc: string;
	header: string[];
	columns: Record<string, Column>;
}> = [
	{
		doc: MATRIX,
		header: [
			"lang",
			"server",
			"mode",
			"clean-behavior",
			"first-publish",
			"tier",
			"src",
			"version",
			"install",
			"stale",
		],
		columns: {
			lang: key,
			server: key,
			mode: handshake(
				"the advertised diagnostic mode (pull or push) read from the initialize reply",
			),
			"clean-behavior": heldByMatrix("clean-behavior"),
			"first-publish": heldByMatrix("first-publish"),
			tier: heldByMatrix("clean-behavior"),
			src: provenance,
			version: provenance,
			install: provenance,
			stale: {
				kind: "derived",
				why: "the consecutive-night miss streak itself (`missed-probe`), a counter not a cell",
			},
		},
	},
	{
		doc: MATRIX,
		header: ["lang", "mode", "server", "src", "version", "install", "stale"],
		columns: {
			lang: key,
			mode: handshake(
				"the advertised diagnostic mode read from the initialize reply",
			),
			server: key,
			src: provenance,
			version: provenance,
			install: provenance,
			stale: {
				kind: "derived",
				why: "the first night characterize-lsp did not measure the server, a stamp not a cell",
			},
		},
	},
	{
		doc: MATRIX,
		header: [
			"server",
			"save as declared",
			"publishes after save only",
			"verdict",
			"evidence",
		],
		columns: {
			server: key,
			"save as declared": handshake(
				"textDocumentSync.save as the server declares it on initialize",
			),
			"publishes after save only": saveHeld,
			verdict: saveHeld,
			evidence: saveHeld,
		},
	},
	{
		doc: CAPS,
		header: [
			"server",
			"mode",
			"ws-pull",
			"save",
			"def",
			"tDef",
			"decl",
			"ref",
			"hov",
			"sig",
			"dSym",
			"wSym",
			"cAct",
			"rnm",
			"impl",
			"cHir",
			"dCre",
			"cmds",
		],
		columns: Object.fromEntries(
			[
				"server",
				"mode",
				"ws-pull",
				"save",
				"def",
				"tDef",
				"decl",
				"ref",
				"hov",
				"sig",
				"dSym",
				"wSym",
				"cAct",
				"rnm",
				"impl",
				"cHir",
				"dCre",
				"cmds",
			].map((c) => [
				c,
				c === "server"
					? key
					: handshake("a capability the server advertises on initialize"),
			]),
		),
	},
	{
		doc: IDLE,
		header: [
			"server",
			"role",
			"declared",
			"result",
			"reason",
			"respawn",
			"coverage",
		],
		columns: {
			server: key,
			role: {
				kind: "registry",
				why: "the registry's primary or auxiliary role, read from clients/lsp/server.ts",
			},
			declared: {
				kind: "registry",
				why: "the registry's idleEviction declaration, read from clients/lsp/server.ts",
			},
			result: idleHeld,
			reason: idleHeld,
			respawn: idleHeld,
			coverage: idleHeld,
		},
	},
];

/**
 * The hand-written vocabulary tables of the generated docs: prose a person
 * edits, never written by a nightly step.
 */
const PROSE_TABLES = [
	["value", "meaning", "wait policy"],
	["Tier", "Signal", "Affirmative clean?", "Example"],
	["value", "meaning"],
];

/** Header cells of every table in `text` (a pipe line not preceded by one). */
function tableHeaders(text: string): string[][] {
	const lines = text.split("\n");
	const out: string[][] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith("|") || (i > 0 && lines[i - 1].startsWith("|")))
			continue;
		out.push(
			lines[i]
				.replace(/^\|/, "")
				.replace(/\|$/, "")
				.split("|")
				.map((c) => c.trim()),
		);
	}
	return out;
}

const same = (a: string[], b: string[]) =>
	a.length === b.length && a.every((c, i) => c === b[i]);

describe("every generated measured column is held or says why not (#5667)", () => {
	it("derives the table population from the generated docs and classifies each one", () => {
		expect([...GENERATED_LSP_DOCS].sort()).toEqual([CAPS, IDLE, MATRIX].sort());
		const unclassified: string[] = [];
		let seen = 0;
		for (const doc of GENERATED_LSP_DOCS) {
			for (const header of tableHeaders(read(doc))) {
				seen += 1;
				const registered = TABLES.some(
					(t) => t.doc === doc && same(t.header, header),
				);
				const prose = PROSE_TABLES.some((p) => same(p, header));
				if (!registered && !prose)
					unclassified.push(`${doc}: | ${header.join(" | ")} |`);
			}
		}
		expect(seen).toBeGreaterThanOrEqual(TABLES.length);
		expect(unclassified).toEqual([]);
		// The other direction: a registered table the docs no longer carry is a
		// stale census row, not a pass.
		for (const t of TABLES)
			expect(
				tableHeaders(read(t.doc)).some((h) => same(h, t.header)),
				`${t.doc} no longer has | ${t.header.join(" | ")} |`,
			).toBe(true);
	});

	it("names a hold or a reason for every column of every generated table", () => {
		for (const t of TABLES) {
			expect(Object.keys(t.columns).sort(), t.header.join("|")).toEqual(
				[...t.header].sort(),
			);
			for (const [name, column] of Object.entries(t.columns)) {
				if ("state" in column) continue;
				expect(column.why.length, `${t.doc} ${name}`).toBeGreaterThan(20);
			}
		}
	});

	it("keeps the handshake facts unheld: mode and save as declared", () => {
		const kindOf = (doc: string, name: string) =>
			TABLES.filter((t) => t.doc === doc).flatMap((t) =>
				name in t.columns ? [(t.columns[name] as Unheld).kind] : [],
			);
		expect(kindOf(MATRIX, "mode")).toEqual(["handshake", "handshake"]);
		expect(kindOf(MATRIX, "save as declared")).toEqual(["handshake"]);
	});

	it("proves every hold by the seam its module calls", () => {
		const held = TABLES.flatMap((t) =>
			Object.entries(t.columns).flatMap(([name, c]) =>
				"state" in c ? [{ doc: t.doc, name, ...c }] : [],
			),
		);
		// result, reason, respawn, coverage; the save column, verdict and
		// evidence; clean-behavior, first-publish and tier.
		expect(held.map((h) => `${h.doc}:${h.name}`).sort()).toEqual(
			[
				`${IDLE}:result`,
				`${IDLE}:reason`,
				`${IDLE}:respawn`,
				`${IDLE}:coverage`,
				`${MATRIX}:publishes after save only`,
				`${MATRIX}:verdict`,
				`${MATRIX}:evidence`,
				`${MATRIX}:clean-behavior`,
				`${MATRIX}:first-publish`,
				`${MATRIX}:tier`,
			].sort(),
		);
		for (const h of held) {
			const source = stripCommentsAndStrings(read(h.via));
			expect(source, `${h.name} is held through ${h.seam} in ${h.via}`).toMatch(
				// A call, not the definition (`function advancePendingClass(`) md-matrix owns.
				new RegExp(`(?<!function\\s)\\b${h.seam}\\(`),
			);
		}
	});
});

/**
 * #4833 — the command-override copy decides EVERY `LSPServerInfo` trait.
 *
 * Recurrence this prevents: #4829 found `resendRecheck` riding the
 * `{...server}` copy onto a binary nobody measured, and #4833 found five more
 * (`idleEviction`, `replyOrdering`, `autoPropagateDiagnostics`, the
 * server-id-keyed wait strategy, ...). Each was added to the interface with no
 * statement about what a `serverOverrides.<id>.command` copy does with it. The
 * next measured trait added to `LSPServerInfo` without a decision in
 * `OVERRIDE_COPY_TRAITS` (clients/lsp/config.ts) reds this file.
 *
 * The population is read from the REAL declaration (the members of
 * `interface LSPServerInfo` in clients/lsp/server.ts, parsed through the
 * shared AST seam), never from a list this file keeps. Detector contract
 * (STATE_TABLE): the detector admits exactly two member forms of that one
 * interface — a `property_signature` or `method_signature` whose name is a
 * plain identifier or a string literal — and REFUSES every other shape: an
 * `extends` clause (members would arrive from a declaration it did not read),
 * a computed or numeric member name, an index/call/construct signature, a
 * missing interface, a duplicate interface declaration.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { OVERRIDE_COPY_TRAITS } from "../../clients/lsp/config.js";
import {
	getStrategy,
	OVERRIDE_STRATEGY_FIELDS,
	SERVER_DIAGNOSTIC_STRATEGIES,
} from "../../clients/lsp/wait-policy/strategies.js";
import { parseRoot, walkAst } from "../support/ast-census.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const SERVER_TS = path.resolve(
	import.meta.dirname,
	"../../clients/lsp/server.ts",
);
const STRATEGIES_TS = path.resolve(
	import.meta.dirname,
	"../../clients/lsp/wait-policy/strategies.ts",
);

/** One field of a strategy object, by name. */
function valueOf(
	strategy: Readonly<Record<string, unknown>>,
	field: string,
): unknown {
	return Object.entries(strategy).find(([key]) => key === field)?.[1];
}

/** Member names of `interface <name>`, or a thrown refusal for any unread form. */
function declaredMembers(source: string, name: string): string[] {
	const root = parseRoot(source);
	let interfaces = 0;
	const members: string[] = [];
	const refusals: string[] = [];
	walkAst(root, (node) => {
		const kind = node.kind();
		if (
			kind === "interface_declaration" &&
			node.field("name")?.text() === name
		) {
			interfaces += 1;
			return;
		}
		if (
			kind === "extends_type_clause" &&
			node.parent()?.kind() === "interface_declaration" &&
			node.parent()?.field("name")?.text() === name
		) {
			refusals.push(`${name} extends another declaration`);
			return;
		}
		const body = node.parent();
		const owner = body?.parent();
		if (
			body?.kind() !== "interface_body" ||
			owner?.kind() !== "interface_declaration" ||
			owner.field("name")?.text() !== name
		) {
			return;
		}
		if (kind === "property_signature" || kind === "method_signature") {
			const nameNode = node.field("name");
			if (nameNode?.kind() === "property_identifier") {
				members.push(nameNode.text());
			} else if (nameNode?.kind() === "string") {
				members.push(nameNode.text().slice(1, -1));
			} else {
				refusals.push(`unread member name: ${node.text().slice(0, 40)}`);
			}
		} else if (
			kind !== "{" &&
			kind !== "}" &&
			kind !== "comment" &&
			kind !== ";" &&
			kind !== ","
		) {
			refusals.push(`unread member form ${kind}: ${node.text().slice(0, 40)}`);
		}
	});
	if (interfaces !== 1) {
		throw new Error(
			`expected exactly one interface ${name}, found ${interfaces}`,
		);
	}
	if (refusals.length > 0) throw new Error(refusals.join("; "));
	return members;
}

describe("#4833 — every LSPServerInfo trait has an override-copy decision", () => {
	it("decides exactly the members the interface declares, in both directions", () => {
		const declared = declaredMembers(
			fs.readFileSync(SERVER_TS, "utf8"),
			"LSPServerInfo",
		);
		assertNonEmptyScan("LSPServerInfo members", declared.length, 25);
		const decided = Object.keys(OVERRIDE_COPY_TRAITS).sort();
		expect(
			declared.filter((m) => !decided.includes(m)),
			"declared on LSPServerInfo with no decision in OVERRIDE_COPY_TRAITS",
		).toEqual([]);
		expect(
			decided.filter((m) => !declared.includes(m)),
			"decided in OVERRIDE_COPY_TRAITS but no longer declared",
		).toEqual([]);
	});

	it("gives every decision a stated reason", () => {
		for (const [trait, decision] of Object.entries(OVERRIDE_COPY_TRAITS)) {
			expect(typeof decision.keep, trait).toBe("boolean");
			expect(decision.why.length, `${trait} reason`).toBeGreaterThanOrEqual(20);
		}
	});

	it("decides exactly the DiagnosticStrategy fields the interface declares, with a reason", () => {
		const declared = declaredMembers(
			fs.readFileSync(STRATEGIES_TS, "utf8"),
			"DiagnosticStrategy",
		);
		assertNonEmptyScan("DiagnosticStrategy fields", declared.length, 10);
		const decided = Object.keys(OVERRIDE_STRATEGY_FIELDS);
		expect(
			declared.filter((m) => !decided.includes(m)),
			"declared on DiagnosticStrategy with no decision in OVERRIDE_STRATEGY_FIELDS",
		).toEqual([]);
		expect(
			decided.filter((m) => !declared.includes(m)),
			"decided in OVERRIDE_STRATEGY_FIELDS but no longer declared",
		).toEqual([]);
		for (const [field, decision] of Object.entries(OVERRIDE_STRATEGY_FIELDS)) {
			expect(["inherit", "reset", "longer"], `${field} decision`).toContain(
				decision.keep,
			);
			expect(decision.why.length, `${field} reason`).toBeGreaterThanOrEqual(20);
		}
	});

	// #4833 review F1/F2: the first cut reset the whole row, which turned
	// opengrep's reopenOnResync and emptyUntilRulesRefreshed workarounds into a
	// false "confirmed clean" and pinned that regression with a whole-row
	// equality. Each field now has a direction; this applies it to every row.
	it("applies each field's decision to every catalog row, field by field", () => {
		const ids = Object.keys(SERVER_DIAGNOSTIC_STRATEGIES);
		assertNonEmptyScan("wait strategy rows", ids.length, 10);
		const fallback = getStrategy("an-id-with-no-strategy-row");
		const seen = { inherit: 0, reset: 0, longer: 0 };
		for (const id of ids) {
			const row = SERVER_DIAGNOSTIC_STRATEGIES[id]!;
			const effective = getStrategy(id, "override");
			for (const [field, decision] of Object.entries(
				OVERRIDE_STRATEGY_FIELDS,
			)) {
				const catalogValue = valueOf({ ...row }, field);
				const defaultValue = valueOf({ ...fallback }, field);
				const got = valueOf({ ...effective }, field);
				if (catalogValue !== undefined) seen[decision.keep] += 1;
				if (decision.keep === "inherit") {
					expect(got, `${id}.${field}`).toEqual(catalogValue ?? defaultValue);
				} else if (decision.keep === "reset") {
					expect(got, `${id}.${field}`).toEqual(defaultValue);
				} else {
					expect(got, `${id}.${field}`).toBe(
						Math.max(Number(catalogValue ?? 0), Number(defaultValue)),
					);
				}
			}
		}
		// Non-vacuous: every decision kind met real catalog values.
		assertNonEmptyScan("inherit field values", seen.inherit, 5);
		assertNonEmptyScan("reset field values", seen.reset, 5);
		assertNonEmptyScan("longer field values", seen.longer, 5);
	});

	// The direction, named: the catalog rows below carry the workaround or the
	// optimistic claim the fields above are decided by. Flipping a row's value
	// (a marker lost from the catalog) reds here though the table still agrees
	// with the row.
	it("keeps the restrictive workarounds and resets the optimistic claims", () => {
		const kept = (id: string) => getStrategy(id, "override");
		expect(kept("opengrep").reopenOnResync).toBe(true);
		expect(kept("opengrep").rescansOnSave).toBe(true);
		expect(kept("opengrep").emptyUntilRulesRefreshed).toBe(true);
		expect(kept("opengrep").aggregateWaitMs).toBeGreaterThanOrEqual(3500);
		expect(kept("typos").publishesOnClose).toBe(true);
		expect(kept("php").emptyFirstPublish).toBe("indexing");
		expect(kept("php").diagnosticsFence).toBe("reply-first");
		expect(kept("csharp").aggregateWaitMs).toBeGreaterThanOrEqual(6000);
		expect(kept("typescript").silentOnClean).toBeUndefined();
		expect(kept("marksman").silentOnClean).toBeUndefined();
		expect(kept("marksman").workspaceIndexing).toBeUndefined();
		expect(kept("marksman").workspaceIndexingWarmWaitMs).toBeUndefined();
		expect(kept("python").seedFirstPush).toBe(false);
		// An id with no row is the default object; the catalog launch is untouched.
		expect(getStrategy("an-id-with-no-strategy-row", "override")).toBe(
			getStrategy("an-id-with-no-strategy-row"),
		);
		expect(getStrategy("typescript", "classic").silentOnClean).toBe(true);
	});

	// The detector's own refusals: three spellings its author did not design
	// the census around. Each must throw, not pass.
	describe("the member reader refuses forms it cannot read", () => {
		it("an `extends` clause (members from another declaration)", () => {
			expect(() =>
				declaredMembers(
					"interface Base { a: 1 }\ninterface X extends Base { b: 2 }",
					"X",
				),
			).toThrow(/extends/);
		});
		it("a computed member name (an alias reached through another binding)", () => {
			expect(() =>
				declaredMembers("const K = 'a';\ninterface X { [K]: 1 }", "X"),
			).toThrow(/unread member/);
		});
		it("an index signature (an indirect member population)", () => {
			expect(() =>
				declaredMembers("interface X { [k: string]: unknown }", "X"),
			).toThrow(/unread member/);
		});
		it("a second declaration of the same interface (merged members)", () => {
			expect(() =>
				declaredMembers("interface X { a: 1 }\ninterface X { b: 2 }", "X"),
			).toThrow(/exactly one/);
		});
		it("reads a plain and a quoted member", () => {
			expect(
				declaredMembers("interface X { a: 1; 'b-c'?: 2; m(): void }", "X"),
			).toEqual(["a", "b-c", "m"]);
		});
	});
});

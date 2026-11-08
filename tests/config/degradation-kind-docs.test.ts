import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { compareOrdinal } from "../../clients/string-utils.js";
import { stripSource } from "../support/sweep-kit.js";

const LEDGER = path.join(process.cwd(), "clients/degradation-ledger.ts");

/**
 * The kinds that have no doc block, by name. The pin compares this list exactly
 * with the members whose doc block is empty, so a kind that gains a doc, loses
 * one, or leaves the union must move its own entry here: the list shrinks on
 * purpose, and the exact count in the assertion below moves with it in the same
 * change. `mode-suppression` and `grammar-blocked` are undocumented by design
 * (#5400); the other 34 predate #5401 and have no doc yet.
 */
const UNDOCUMENTED_KINDS: readonly string[] = [
	"ast-grep-napi-unavailable",
	"ast-grep-rule-invalid",
	"autofix-agreement-unavailable",
	"aux_wait_demoted",
	"aux_wait_repromoted",
	"bash-view-clipped",
	"bus-stale",
	"cascade-budget-override-disarmed",
	"diagnostic-retained-unreconciled",
	"formatter-failure",
	"formatter-skip",
	"grammar-blocked",
	"install-retry-exhausted",
	"instance-registry-corrupt",
	"lens-diagnostics-analysis-root-rejected",
	"lsp-adopted-root-evicted",
	"lsp-breaker",
	"lsp-capability-skip",
	"lsp-diagnostics-file-too-large",
	"lsp-diagnostics-timeout",
	"lsp-diagnostics-unsupported",
	"lsp-notify-inflight-stall",
	"lsp-pull-unconfirmed",
	"lsp-scanner-coverage-gap",
	"mode-suppression",
	"native-read-clipped",
	"pip-install-strategy-succeeded",
	"pip-pep668-strategy-refused",
	"query-predicates-invalid",
	"self-drift-hash-budget-exhausted",
	"spawn-failure",
	"tool-result-adopted-project",
	"trust-refusal",
	"wasm-abort",
	"widget-disposition-reconcile-fallback",
	"workspace-glob-cap",
];

/**
 * True when a doc block opens with its own backticked name. Comment markers and
 * leading whitespace are skipped; any other opening (another kind's name, prose,
 * or the name further down the block) is false.
 */
function docLeadsWith(doc: string, kind: string): boolean {
	return doc.replace(/^[\s/*]+/, "").startsWith(`\`${kind}\``);
}

interface UnionMember {
	readonly kind: string;
	readonly line: number;
	/** The raw comment text above the kind line, back to the previous kind. */
	readonly doc: string;
}

/**
 * The `DegradationKind` members with the doc comment block above each one.
 *
 * The scan runs over comment-blanked source (`stripSource`, strings kept), so a
 * `| "kind"` line that lives inside a comment is not a member, and the kind
 * names still read as string literals. Each region between two members must be
 * comment or whitespace only once blanked: any code in it fails closed.
 */
function readUnionMembers(source: string): UnionMember[] {
	const code = stripSource(source, { strings: "keep" }).split("\n");
	const raw = source.split("\n");
	const start = code.findIndex((line) =>
		/^export type DegradationKind =/.test(line),
	);
	if (start < 0) throw new Error("DegradationKind union not found");
	const members: UnionMember[] = [];
	let regionStart = start + 1;
	for (let i = start + 1; i < code.length; i++) {
		const line = code[i] ?? "";
		const match = /^\s*\|\s*"([^"]+)"\s*(;?)\s*$/.exec(line);
		if (!match) {
			if (line.trim() !== "") {
				throw new Error(
					`unexpected code inside the DegradationKind union at line ${i + 1}: ${line.trim()}`,
				);
			}
			continue;
		}
		members.push({
			kind: match[1] ?? "",
			line: i + 1,
			doc: raw.slice(regionStart, i).join("\n"),
		});
		regionStart = i + 1;
		if (match[2] === ";") break;
	}
	return members;
}

describe("DegradationKind doc blocks name their own kind (#5401)", () => {
	// Recurrence: #2671 sorted the union by moving only the `| "kind"` lines, so
	// the doc blocks stayed where they were and described the kind that used to
	// sit at their position. About 86 docs were misplaced on master (for example
	// `mode-suppression` carried the `runner-empty-result` doc, #5401 item 1).
	// A documented kind's block must lead with its own backticked name, so a
	// re-sort or an insertion that detaches a doc from its kind reds this pin.
	// A kind with an empty block must be listed in UNDOCUMENTED_KINDS, so a doc
	// stacked onto a neighbour or deleted (which leaves its own kind empty) reds it.
	it("requires each kind's doc block to lead with that kind", () => {
		// Count: exact, so the list and this number move together. A kind that gains
		// its doc leaves UNDOCUMENTED_KINDS and lowers this number in the same change;
		// a kind that loses its doc joins the list and raises it. Recurrence: the
		// #5407 verify r2 probe moved a bin doc below the writer-skipped doc and added
		// one name here, and the exact match went green, so a new kind's doc could be
		// silenced by a list line. Verify r3 (F10): under `<= 36` a doc gain freed a
		// slot that a later silent name filled, so the count is `toBe` now.
		expect(
			UNDOCUMENTED_KINDS.length,
			"lower the count when a kind gains docs: remove its entry from UNDOCUMENTED_KINDS and set this number to the new length",
		).toBe(36);
		const members = readUnionMembers(fs.readFileSync(LEDGER, "utf8"));
		// Floor: the union had 311 members when this pin landed. A parse that finds
		// far fewer must fail rather than pass over an empty population.
		expect(members.length).toBeGreaterThanOrEqual(250);
		const undocumented = members
			.filter((m) => m.doc.trim() === "")
			.map((m) => m.kind)
			.sort(compareOrdinal);
		expect(undocumented).toEqual([...UNDOCUMENTED_KINDS].sort(compareOrdinal));
		const misnamed = members
			.filter((m) => m.doc.trim() !== "" && !docLeadsWith(m.doc, m.kind))
			.map((m) => `${m.kind} (line ${m.line})`);
		expect(misnamed).toEqual([]);
	});
});

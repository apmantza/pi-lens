import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stripSource } from "../support/sweep-kit.js";

const LEDGER = path.join(process.cwd(), "clients/degradation-ledger.ts");

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
	// Every kind doc now starts with its own backticked name, so a re-sort or an
	// insertion that detaches a doc from its kind reds this pin.
	it("requires each kind's doc block to name that kind", () => {
		const members = readUnionMembers(fs.readFileSync(LEDGER, "utf8"));
		// Floor: the union had 311 members when this pin landed. A parse that finds
		// far fewer must fail rather than pass over an empty population.
		expect(members.length).toBeGreaterThanOrEqual(250);
		const misnamed = members
			.filter((m) => m.doc.trim() !== "" && !m.doc.includes(`\`${m.kind}\``))
			.map((m) => `${m.kind} (line ${m.line})`);
		expect(misnamed).toEqual([]);
	});
});

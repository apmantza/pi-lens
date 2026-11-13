/**
 * #4483: the pre-edit seed's bound and filter (clients/dispatch/pre-edit-seed.ts).
 *
 * Recurrence it prevents: a file with thousands of old linter errors growing
 * one session fact without limit (the seed sits in the bounded session facts,
 * whose cap counts records, not their size), and a language-server finding
 * being seeded against the maintainer's linters-only scope. The behaviour
 * through the real host chain is tests/index-4483-first-write-seed-witness.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_PRE_EDIT_SEED_FINDINGS,
	classifyPreExisting,
	seedFromCapture,
} from "../../../clients/dispatch/pre-edit-seed.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";

function finding(line: number, runnerId: string): Diagnostic {
	return {
		id: `${runnerId}:SC1072:${line}`,
		message: "Unexpected BAD_SH token",
		filePath: "/p/a.sh",
		line,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: runnerId,
		runnerId,
		rule: "SC1072",
	};
}

describe("seedFromCapture", () => {
	it("keeps at most MAX_PRE_EDIT_SEED_FINDINGS entries", () => {
		const lines = MAX_PRE_EDIT_SEED_FINDINGS + 5;
		const content = Array.from({ length: lines }, () => "BAD_SH").join("\n");
		const findings = Array.from({ length: lines }, (_, i) =>
			finding(i + 1, "shellcheck"),
		);
		const seed = seedFromCapture(findings, content);
		expect(seed).toHaveLength(MAX_PRE_EDIT_SEED_FINDINGS);
		expect(seed.every((d) => d.lineHash !== undefined)).toBe(true);
	});

	it("seeds only linter findings", () => {
		const seed = seedFromCapture(
			[
				finding(1, "shellcheck"),
				finding(1, "lsp"),
				finding(1, "ast-grep-napi"),
			],
			"BAD_SH\n",
		);
		expect(seed.map((d) => d.runnerId)).toEqual(["shellcheck"]);
	});

	// Recurrence prevented (#5553): a writer that names no edit span leaves the
	// edit-gated lanes reading the whole file, so their findings join the seed;
	// language servers still do not.
	it("seeds the edit-gated lanes too for a writer with no edit span", () => {
		const seed = seedFromCapture(
			[
				finding(1, "shellcheck"),
				finding(1, "lsp"),
				finding(1, "ast-grep-napi"),
				finding(1, "tree-sitter"),
			],
			"BAD_SH\n",
			true,
		);
		expect(seed.map((d) => d.runnerId)).toEqual([
			"shellcheck",
			"ast-grep-napi",
			"tree-sitter",
		]);
	});

	// Recurrence prevented (#5583 review F1): a whole-file seed entry of an
	// edit-gated lane excused an identical blocker a host `edit` added 30 lines
	// away, because that edit's dispatch reports only its touched lines. Real
	// `classifyPreExisting`, no double.
	describe("classifyPreExisting for an edit-gated lane's whole-file entry", () => {
		const content = "BAD_SH\nok\nBAD_SH\n";
		const seeded = (runnerIds: string[]) =>
			seedFromCapture(
				runnerIds.map((id) => finding(1, id)),
				content,
				true,
			);
		const answered = new Set(["shellcheck", "tree-sitter"]);

		it("classifies a dispatch that read the whole file", () => {
			const { preExisting, nextSeed } = classifyPreExisting(
				seeded(["tree-sitter"]),
				[finding(1, "tree-sitter")],
				content,
				answered,
			);
			expect(preExisting.map((d) => d.runnerId)).toEqual(["tree-sitter"]);
			expect(nextSeed).toHaveLength(1);
		});

		// A write's span is the whole file: the lane reports every finding.
		it("classifies a dispatch whose span covers every line", () => {
			const { preExisting } = classifyPreExisting(
				seeded(["tree-sitter"]),
				[finding(1, "tree-sitter")],
				content,
				answered,
				[{ start: 1, end: 4 }],
			);
			expect(preExisting.map((d) => d.runnerId)).toEqual(["tree-sitter"]);
		});

		it("classifies nothing and keeps nothing of the lane for a dispatch with an edit span", () => {
			const { preExisting, nextSeed } = classifyPreExisting(
				seeded(["tree-sitter", "shellcheck"]),
				[finding(3, "tree-sitter"), finding(1, "shellcheck")],
				content,
				answered,
				[{ start: 3, end: 3 }],
			);
			expect(preExisting.map((d) => d.runnerId)).toEqual(["shellcheck"]);
			expect(nextSeed.map((d) => d.runnerId)).toEqual(["shellcheck"]);
		});
	});
});

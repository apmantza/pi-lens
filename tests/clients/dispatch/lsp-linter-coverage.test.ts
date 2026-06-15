/**
 * LSP↔linter dispatch-coverage guard (#209).
 *
 * Catches a subtler sibling of the dead-runner class: a `smart-default` linter
 * (one tool-policy.ts says runs with built-in defaults, no config needed) that
 * shares a `mode:"fallback"` primary dispatch group with the `lsp` runner. In a
 * fallback group the first success wins, so once the language server installs
 * and handshakes, the LSP succeeds and the dedicated linter is **silently
 * suppressed** — dropping rules the generic LSP never emits (yamllint style,
 * stylelint, hadolint best-practices, htmlhint, …). `shell`/`fish`/`powershell`/
 * `prisma` already pair the LSP with their linter via `mode:"all"`; this test
 * enforces that consistency for every smart-default linter.
 *
 * Type-checker/compiler pairs (jsts lsp+ts-lsp, python lsp+pyright, etc.) are
 * intentionally fallback — running two type-checkers is redundant — and contain
 * no smart-default linter, so they are not flagged.
 */

import { describe, expect, it } from "vitest";
import {
	LANGUAGE_POLICY,
	getPrimaryDispatchGroup,
} from "../../../clients/language-policy.js";

// Runner ids whose tool is classified `smart-default` in tool-policy.ts's
// TOOL_EXECUTION_POLICY and which appear in LSP-paired primary groups.
const SMART_DEFAULT_LINTERS = new Set([
	"stylelint",
	"sqlfluff",
	"rubocop",
	"yamllint",
	"actionlint",
	"markdownlint",
	"taplo",
	"hadolint",
	"htmlhint",
	"ktlint",
	"swiftlint",
]);

describe("LSP↔linter dispatch coverage", () => {
	it("no smart-default linter is suppressed behind the LSP in a fallback primary group", () => {
		const violations: string[] = [];
		for (const kind of Object.keys(LANGUAGE_POLICY)) {
			const group = getPrimaryDispatchGroup(kind as never, true);
			if (!group || group.mode !== "fallback") continue;
			if (!group.runnerIds.includes("lsp")) continue;
			for (const id of group.runnerIds) {
				if (SMART_DEFAULT_LINTERS.has(id)) violations.push(`${kind}:${id}`);
			}
		}
		expect(
			violations,
			`smart-default linter(s) suppressed by LSP fallback — flip the primary group to mode:"all": ${violations.join(", ")}`,
		).toEqual([]);
	});
});

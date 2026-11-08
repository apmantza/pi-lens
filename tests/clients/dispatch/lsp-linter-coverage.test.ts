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
 * Type-checker/compiler pairs (php lsp+phpstan, java lsp+javac, etc.) are
 * intentionally fallback — running two type-checkers is redundant. Each one is
 * a row in LSP_FALLBACK_PEERS with its reason; every other non-lsp id in an
 * LSP fallback group reds (fail closed). The derived smart-default set alone
 * cannot carry this: a runner whose id differs from its policy row's tool id
 * (ruff-lint for ruff, biome-check-json for biome, helm-lint for helm,
 * ast-grep-napi for ast-grep) is invisible to it, and no registry joins the
 * two (#5418 review r1 F3).
 */

import { describe, expect, it } from "vitest";
import { RunnerRegistry } from "../../../clients/dispatch/dispatcher.js";
import { registerDefaultRunners } from "../../../clients/dispatch/runners/index.js";
import {
	LANGUAGE_POLICY,
	getPrimaryDispatchGroup,
} from "../../../clients/language-policy.js";
import { TOOL_EXECUTION_POLICY } from "../../../clients/tool-policy.js";
import { assertNonEmptyScan, auditRegistry } from "../../support/sweep-kit.js";

// Derived, never hand-kept (#5418): the ids the policy table classifies
// `smart-default` AND the runner registry actually has, so a tool-policy.ts
// rename or a new smart-default runner lands here the moment it lands there.
// The hand list this replaces named 11 of the 17, so a fallback group that
// gained shellcheck (or shfmt, tflint, terragrunt, oxlint, pyright) stayed
// green while silently losing its linter to the language server.
const registry = new RunnerRegistry();
registerDefaultRunners(registry);
const SMART_DEFAULT_LINTERS = new Set(
	[...TOOL_EXECUTION_POLICY.entries()]
		.filter(
			([toolId, policy]) =>
				policy.configEligibility === "smart-default" &&
				registry.get(toolId) !== undefined,
		)
		.map(([toolId]) => toolId),
);

/**
 * The non-lsp runners admitted in an LSP fallback primary group, keyed
 * `<kind>:<runnerId>`. Each is a compiler or type checker the language server
 * already stands in for. `auditRegistry` reds a row that no group carries any
 * more, and the smart-default check below reds a row the policy table calls
 * smart-default, so this table cannot excuse a suppressed linter.
 */
const LSP_FALLBACK_PEERS: Record<string, string> = {
	"php:php-lint":
		"`php -l` syntax check; the PHP language server reports the same parse errors, so it runs only without the server.",
	"php:phpstan":
		"Config-first type checker; with the server up its type diagnostics stand in, so a second type pass is redundant.",
	"csharp:dotnet-build":
		"Compiler build; the C# language server reports the same compiler diagnostics, so it runs only without the server.",
	"java:javac":
		"Compiler; the Java language server reports the same compiler diagnostics, so it runs only without the server.",
};

describe("LSP↔linter dispatch coverage", () => {
	it("no smart-default linter is suppressed behind the LSP in a fallback primary group", () => {
		// The floor is the derivation's own liveness check: an empty or thin
		// SMART_DEFAULT_LINTERS would make the loop below pass on nothing.
		assertNonEmptyScan(
			"smart-default runner ids",
			SMART_DEFAULT_LINTERS.size,
			15,
		);
		const violations: string[] = [];
		const peers: { key: string; detail: string }[] = [];
		for (const kind of Object.keys(LANGUAGE_POLICY)) {
			const group = getPrimaryDispatchGroup(kind as never, true);
			if (!group || group.mode !== "fallback") continue;
			if (!group.runnerIds.includes("lsp")) continue;
			for (const id of group.runnerIds) {
				if (id === "lsp") continue;
				peers.push({
					key: `${kind}:${id}`,
					detail: `${id} sits behind lsp in the ${kind} fallback group`,
				});
				if (SMART_DEFAULT_LINTERS.has(id)) violations.push(`${kind}:${id}`);
			}
		}
		expect(
			violations,
			`smart-default linter(s) suppressed by LSP fallback — flip the primary group to mode:"all": ${violations.join(", ")}`,
		).toEqual([]);
		const audit = auditRegistry({
			sweepName: "lsp-linter-coverage:fallback-peers",
			flagged: peers,
			registered: [],
			exemptions: LSP_FALLBACK_PEERS,
			remediation:
				'Flip the primary group to mode:"all" if the runner is a linter the server does not replace, or record why the server stands in for it in LSP_FALLBACK_PEERS.',
		});
		expect(audit.problems).toEqual([]);
	});
});

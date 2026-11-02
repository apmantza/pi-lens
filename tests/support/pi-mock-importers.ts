/**
 * The ONE list of test files allowed to load the hand-built pi double
 * `tests/support/pi-mock.ts` (#4632, recurrence #4631: host semantics passed CI
 * on the double). Two readers, never two copies:
 *
 * - `pi-mock.ts` calls {@link piMockAdmission} at module load and throws for a
 *   test file that is not on the list. That is the gate: it sees the module
 *   that actually loads, so no import spelling (escape, fragment, alias,
 *   re-export through a support file) can route around it.
 * - `tests/config/pi-mock-importer-sweep.test.ts` scans source text only for
 *   the other direction: a row whose file stopped using the double is stale
 *   and must be deleted, so the list only shrinks.
 *
 * Keys are `tests/`-relative posix paths. A row's class is acceptance 7 of
 * #4632: `process-boundary`, `internal-seam` (the case interposes on a pi-lens
 * `clients/` module: a `vi.mock`, which cannot reach the copy pi's loader
 * builds, or the test-side copy of a process-global service the loaded copy
 * does not share, such as `clients/lsp`'s service), `unproducible-payload`, or
 * `double-subject`; `real-ui-harness` names a case whose claim is what the TUI
 * shows or mounts, which no in-process tier can produce until one binds a real
 * UI context.
 * `real-ui-harness` is NOT a slice dependency: no roadmap slice builds a UI
 * harness (review F4 on #4702). Classes are the author's reading at
 * 2026-10-21 and are checked for vocabulary only; the SET of files is what the
 * gate pins.
 *
 * THE VOCABULARY IS CLOSED. `pending slice N` was the last class the roadmap
 * needed, and it is gone: every slice is closed and `pi-mock-importer-sweep`
 * refuses the label, so a reopened placeholder reds instead of naming work no
 * slice carries. A class an author believes is missing is a deliberate edit to
 * that test's vocabulary, never a free-form string here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_MOCK_IMPORTERS: Readonly<Record<string, string>> = {
	// double-subject
	"support/pi-mock.test.ts": "double-subject",
	// internal-seam
	"index-1892-govulncheck-lane-witness.test.ts": "internal-seam",
	"index-1892-scanner-freshness-witness.test.ts": "internal-seam",
	"index-1892-secrets-lane-witness.test.ts": "internal-seam",
	"index-2939-read-path-witness.test.ts": "internal-seam",
	"index-2939-tool-result-budget-witness.test.ts": "internal-seam",
	"index-3190-inline-blocker-deleted-path-witness.test.ts": "internal-seam",
	"index-3246-turn-end-delivery.test.ts": "internal-seam",
	"index-3290-actionable-warnings-witness.test.ts": "internal-seam",
	"index-3506-file-mutation-queue-wiring.test.ts": "internal-seam",
	"index-3620-sweep-scope-fence.test.ts": "internal-seam",
	"index-3748-advisory-scope-witness.test.ts": "internal-seam",
	"index-3814-deferred-blocker-gate.test.ts": "internal-seam",
	"index-3917-orphan-sweep-scope.test.ts": "internal-seam",
	"index-4483-first-write-seed-witness.test.ts": "internal-seam",
	"index-4484-unfixed-blocker-witness.test.ts": "internal-seam",
	"index-4504-opaque-prescan-root-witness.test.ts": "internal-seam",
	"index-drain-refresh-straddle.test.ts": "internal-seam",
	"index-integration.test.ts": "internal-seam",
	"index-loop-block-wiring.test.ts": "internal-seam",
	"index-lsp-idle-reset.test.ts": "internal-seam",
	"index-lsp-config-root-eviction.test.ts": "internal-seam",
	"index-mode-awareness.test.ts": "internal-seam",
	"index-mutation-bridge-recordability.test.ts": "internal-seam",
	"index-project-trust-wiring.test.ts": "internal-seam",
	"index-read-bridge-zero-line.test.ts": "internal-seam",
	"index-vanished-instance-wiring.test.ts": "internal-seam",
	"index-wiring.test.ts": "internal-seam",
	"index-word-index-memo-settle.test.ts": "internal-seam",
	"index-write-order-token.test.ts": "internal-seam",
	// internal-seam (slice 7 classified these four)
	// The cascade's five cause-matrix cells and two of its three scripts moved
	// to `tests/index-4632-s7-turn-end-ordering.test.ts` (7 of its 10 cases).
	// The three that stay keep the double: the two cap cases script
	// `RUNTIME_CONFIG.turnEnd.maxChars`, an `as const` copy the loaded copy
	// owns, and the third script is red on `origin/master` in the plegma sandbox
	// (the line rides turn 1, not turn 2).
	"clients/cascade-unanswered-primary-4403.test.ts": "internal-seam",
	// pi-lens's OWN result rendering on two surfaces (the pi tool result and the
	// MCP child's), read through the double's registered-tool handle; no host
	// semantic reaches the assertion.
	"config/result-contract-governance.test.ts": "internal-seam",
	// Drives hand-built `session_start`/`session_shutdown` events across a
	// factory reload and reads the test-side `getIOBridge` copy (#4258).
	"index-process-bridge-rebind-real-factory.test.ts": "internal-seam",
	"tools/diagnostics-route-switch-matrix.test.ts": "internal-seam",
	"tools/diagnostics-route-switch-matrix-cols-1.test.ts": "internal-seam",
	"tools/diagnostics-route-switch-matrix-cols-2.test.ts": "internal-seam",
	"tools/diagnostics-route-switch-matrix-cols-3.test.ts": "internal-seam",
	"tools/diagnostics-route-switch-matrix-cols-4.test.ts": "internal-seam",
	"tools/diagnostics-route-switch-matrix-cols-5.test.ts": "internal-seam",
	"clients/handler-verdict-helper.test.ts": "internal-seam",
	// unproducible-payload
	"clients/context-append-to-last-user.test.ts": "unproducible-payload",
	"index-4631-pre-087-context-shape.test.ts": "unproducible-payload",
	"index-session-start-classification-wiring.test.ts": "unproducible-payload",
	// real-ui-harness
	"lens-toggle-command.test.ts": "real-ui-harness",
	// slice-5 stays (see #4632)
	"index-4554-last-member-teardown.test.ts": "internal-seam",
	"index-multi-root-session-start.test.ts": "unproducible-payload",
	// process-boundary
	"clients/pi-host-callable-schema-contract.test.ts": "process-boundary",
	"clients/pi-lens-home-hermeticity.test.ts": "process-boundary",
};

const TESTS_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/**
 * `undefined` when the test file at `testPath` may load the double, else the
 * refusal text. Fails closed: an unreadable path (vitest reports none), a path
 * outside `tests/` (no key spells `..`, so the list lookup refuses it), a symlink that cannot be resolved, and a file not on the
 * list are all refused.
 */
export function piMockAdmission(testPath: unknown): string | undefined {
	const refuse = (why: string): string =>
		`tests/support/pi-mock.ts refuses to load: ${why}. A case whose verdict ` +
		"depends on what pi does with a handler's return value, what the model " +
		"receives, or how pi orders a session goes through tier 1 " +
		"(tests/support/pi-runner.ts, a real ExtensionRunner) or tier 2 " +
		"(tests/support/pi-session.ts, a real AgentSession); AGENTS.md " +
		"'Test requirements' says which. A genuine process-boundary subject, internal " +
		"seam or unproducible payload (#4632 acceptance 7) is added to " +
		"PI_MOCK_IMPORTERS in tests/support/pi-mock-importers.ts, with its class.";
	if (typeof testPath !== "string" || testPath === "") {
		return refuse(
			"vitest reported no test file path, so the importer cannot be checked",
		);
	}
	let relative: string;
	try {
		relative = path
			.relative(
				fs.realpathSync.native(TESTS_ROOT),
				fs.realpathSync.native(testPath),
			)
			.split(path.sep)
			.join("/");
	} catch {
		return refuse(`the test file path ${testPath} cannot be resolved`);
	}
	if (!Object.hasOwn(PI_MOCK_IMPORTERS, relative)) {
		return refuse(`${relative} is not on the importer list`);
	}
	return undefined;
}

/**
 * A shared builder for the dispatch-runner `DispatchContext` (#187 — Tier 2
 * follow-up to #171).
 *
 * #171 consolidated the three parallel `ExtensionAPI` mocks onto
 * `createPiMock`/`makeCtx` (`./pi-mock.ts`). Dispatch-runner tests are a
 * separate, unrelated context shape (`clients/dispatch/types.ts`'s
 * `DispatchContext`) that ~26 files under `tests/clients/dispatch/runners/*`
 * each hand-rolled locally as `function createCtx(filePath, cwd) { ... }`.
 * `makeRunnerCtx()` is the single source of truth for that shape so runner
 * tests stop drifting from the real interface and from each other.
 *
 * Typed against the real `DispatchContext` (`clients/dispatch/types.ts`), not
 * a guessed shape — any field the interface adds/removes shows up here as a
 * type error instead of silently going stale in 26 copies.
 */

import type { DispatchContext } from "../../clients/dispatch/types.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";

/**
 * Fields callers may override. Everything is optional — `makeRunnerCtx` fills
 * in a sane default for every field the runners under test actually read
 * (`kind: "jsts"`, `fileRole: "source"`, `autofix: false`, `deltaMode: true`,
 * a fresh `FactStore`, `hasTool` resolving `true`, and a no-op `log`).
 */
export type RunnerCtxOverrides = Partial<DispatchContext>;

/**
 * Build a `DispatchContext` for a runner test, with per-test overrides.
 *
 * Mirrors the old per-file `createCtx(filePath, cwd)` signature so migrating
 * a test is a near mechanical rename; pass any remaining `DispatchContext`
 * field (e.g. `kind: "python"`, `autofix: true`, a custom `hasTool`) as the
 * third `overrides` argument.
 *
 * @example
 * const ctx = makeRunnerCtx(filePath, cwd, { kind: "python" });
 * await runner.run(ctx as never);
 */
export function makeRunnerCtx(
	filePath: string,
	cwd: string,
	overrides: RunnerCtxOverrides = {},
): DispatchContext {
	return {
		filePath,
		cwd,
		kind: "jsts",
		fileRole: "source",
		pi: {
			getFlag: () => undefined,
		},
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
		...overrides,
	};
}

/**
 * Real-runner test env builder (#448 — generalizes the ad-hoc ctx factory from
 * the #440 skip-test-files suite).
 *
 * Principle: mock the environment (tool presence, network, abort injection),
 * never the behavior under test (parsing, matching, dispatch). These helpers
 * build a REAL runner invocation — temp cwd, real fixture file on disk, typed
 * `DispatchContext` via `makeRunnerCtx` (#187) — so rule behavior and dispatch
 * filtering (skip_test_files, tiers, delta, cache round-trips) are exercised
 * through the real engine instead of being mocked away.
 *
 * The temp-dir prefix deliberately contains no `isTestFile` marker
 * (`clients/file-utils.ts` matches `.test.`, `/tests/`, `test-` prefixes, …) —
 * a marker in the prefix would silently flip every fixture into a "test file"
 * and invert skip_test_files assertions.
 */

import type {
	Diagnostic,
	DispatchContext,
	RunnerResult,
} from "../../clients/dispatch/types.js";
import { detectFileKind } from "../../clients/file-kinds.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";
import { makeRunnerCtx, type RunnerCtxOverrides } from "./runner-ctx.js";

export interface RealRunnerEnv {
	/** The temp project root — always passed as `ctx.cwd`. */
	cwd: string;
	/** Write a fixture under the env's cwd and get a typed ctx for it. */
	addFile(
		relPath: string,
		content: string,
		overrides?: RunnerCtxOverrides,
	): { filePath: string; ctx: DispatchContext };
	cleanup(): void;
}

/**
 * A temp project root that can hold several fixtures sharing one cwd (and
 * therefore one rule-cache/data dir) — required for warm-cache round-trip
 * tests, where run 2 must be a cache HIT for run 1's cwd.
 *
 * `defaults` apply to every ctx; `kind` uses production detection and fails
 * loudly for unknown fixture types unless the caller supplies an override.
 *
 * Tree-sitter suites built on this helper either pass a `modifiedRanges` under
 * 5 lines (the runner then skips entity extraction; findings are only
 * range-filtered under `blockingOnly`) or `vi.mock`
 * `clients/review-graph/service.js` so `recordEntitySnapshotDiff` returns an
 * empty diff. A non-empty diff triggers the tree-sitter runner's
 * fire-and-forget `runBlastRadiusInBackground`, gated by a module-global 5s
 * `blastCooldownByFile` (`clients/dispatch/runners/tree-sitter.ts:40-41`) —
 * left unmocked, that background work makes the suite order- and
 * wall-clock-dependent and can race this helper's `cleanup()`. This helper
 * can't register the mock itself: `vi.mock` is file-hoisted, so it must live
 * in each suite file.
 */
export function makeRealRunnerEnv(
	defaults: RunnerCtxOverrides = {},
): RealRunnerEnv {
	const env = setupTestEnvironment("pi-lens-real-");
	return {
		cwd: env.tmpDir,
		addFile(relPath, content, overrides = {}) {
			const contextOverrides = { ...defaults, ...overrides };
			const kind = contextOverrides.kind ?? detectFileKind(relPath);
			if (!kind) {
				throw new Error(
					`Cannot derive a FileKind for real-runner fixture "${relPath}"; pass a kind override`,
				);
			}
			const filePath = createTempFile(env.tmpDir, relPath, content);
			return {
				filePath,
				ctx: makeRunnerCtx(filePath, env.tmpDir, {
					...contextOverrides,
					kind,
				}),
			};
		},
		cleanup() {
			env.cleanup();
		},
	};
}

export interface RealRunnerCtx {
	ctx: DispatchContext;
	filePath: string;
	cwd: string;
	cleanup: () => void;
}

/** One-fixture convenience over `makeRealRunnerEnv().addFile(...)`. */
export function makeRealRunnerCtx(
	relPath: string,
	content: string,
	overrides: RunnerCtxOverrides = {},
): RealRunnerCtx {
	const env = makeRealRunnerEnv();
	const { filePath, ctx } = env.addFile(relPath, content, overrides);
	return { ctx, filePath, cwd: env.cwd, cleanup: env.cleanup };
}

/**
 * Fail LOUDLY when a grammar is missing. A missing grammar degrades silently
 * to zero matches, which turns every "rule does NOT fire" assertion vacuous —
 * exactly the false-green failure mode #448 exists to kill. Call from
 * `beforeAll` in every tree-sitter real-runner suite.
 */
export async function assertGrammarAvailable(
	languageId: string,
): Promise<void> {
	const client = getSharedTreeSitterClient();
	if (!client) {
		throw new Error(
			"tree-sitter unavailable (wasm runtime aborted) — real-runner assertions would be vacuous",
		);
	}
	if (!(await client.isLanguageSupported(languageId))) {
		throw new Error(
			`tree-sitter grammar for "${languageId}" is unavailable — queries would ` +
				"silently return zero matches. Run `node scripts/download-grammars.js " +
				"--core --dest grammars` (or `npm install`) and check network access.",
		);
	}
}

/** The `d.rule` ids a runner result fired — the projection real-runner suites assert on. */
export function firedRuleIds(result: RunnerResult): Set<string> {
	const ids = new Set<string>();
	for (const d of result.diagnostics) {
		if (d.rule) ids.add(d.rule);
	}
	return ids;
}

/** LSP supersedes the napi matcher when the ast-grep binary is present; simulate it absent so the napi path actually executes. */
export const napiFallbackHasTool = async (cmd: string): Promise<boolean> =>
	cmd !== "ast-grep";

/** Sorted, deduped line numbers where `rule` fired — shared across the ast-grep real-runner suites. */
export function linesFor(diagnostics: Diagnostic[], rule: string): number[] {
	return [
		...new Set(
			diagnostics
				.filter((diagnostic) => diagnostic.rule === rule)
				.map((diagnostic) => diagnostic.line ?? 0),
		),
	].sort((a, b) => a - b);
}

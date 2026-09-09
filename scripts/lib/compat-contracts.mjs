// Pure pattern-matching helpers for scripts/compat-contracts.mjs (#476).
//
// Each contract is verified with a RESILIENT regex against the third-party
// source/dist we depend on — never a line number (those drift on every
// release) — so a wording/formatting change that preserves the same semantic
// shape still passes, and a real behavioral drift still fails. Kept pure and
// side-effect-free (no fs/child_process) so the matching logic itself is
// unit-testable without installing any package; the orchestration script
// (compat-contracts.mjs) owns the npm install + file reads and just calls
// these functions with file contents.

/**
 * Contract 1 (nicobailon/pi-subagents): `PI_SUBAGENT_CHILD` is set to the
 * literal string `"1"` on every process that hosts a child session
 * (`subagent-mode.ts`'s `isSubagentSession()` is the only part of this
 * pi-lens depends on for BEHAVIOR — light mode gating). Verified against
 * `src/runs/shared/pi-args.ts` pre-0.65.0, `src/runs/shared/
 * child-runtime-config.ts` (the const) + `src/runs/background/
 * subagent-runner.ts` (the assignment) at 0.66.0 — the caller concatenates
 * both files' sources (`compat-contract-locator.mjs`'s `locateContractSources`,
 * #2581) since they split apart in pi-subagents@0.65.0's native-AgentSession
 * rewrite.
 *
 * `PI_SUBAGENT_RUN_ID` / `PI_SUBAGENT_CHILD_AGENT` — the best-effort identity
 * vars this contract used to also require — were REMOVED from pi-subagents
 * entirely in that same 0.65.0 rewrite (grep-verified absent from the whole
 * 0.66.0 source tree, #2581): child identity is now passed through an
 * in-process `ChildRuntimeConfig` object, not env vars, because foreground
 * children no longer spawn a separate `pi` process at all. This is real
 * upstream drift, but NOT one pi-lens needs a code fix for:
 * `getSubagentIdentity()` was already documented and tested as best-effort,
 * degrading to `runId`/`agentName: undefined` when the vars are absent
 * (`tests/clients/subagent-mode.test.ts`) — that degraded state is now the
 * PERMANENT one for this vocabulary, not a transient gap, so this check no
 * longer requires them.
 *
 * @param {string} source concatenated contents of every file backing the
 *   child-flag const + assignment (see locateContractSources)
 * @returns {{ pass: boolean, detail: string }}
 */
export function checkNicobailonChildEnv(source) {
	const setsChildFlag =
		/env(?:\[[^\]]+\]|\.\w+)\s*=\s*["']1["']/.test(source) &&
		/SUBAGENT_CHILD_ENV\s*=\s*["']PI_SUBAGENT_CHILD["']/.test(source);
	const pass = setsChildFlag;
	return {
		pass,
		detail: pass
			? "PI_SUBAGENT_CHILD='1' set unconditionally (RUN_ID/CHILD_AGENT identity vars no longer required — removed upstream at pi-subagents@0.65.0, #2581; getSubagentIdentity() already degrades to unknown)"
			: "missing: PI_SUBAGENT_CHILD='1' assignment",
	};
}

/**
 * Contract 1b (avtc-pi-subagent): the spawn-env pair set on every real
 * child-process `pi` spawn — `PI_SUBAGENT_CHILD_AGENT` (the agent's name,
 * assigned to the spawn env when the agent has one) and
 * `PI_SUBAGENT_PARENT_PID` (unconditionally `String(process.pid)`).
 * `subagent-mode.ts`'s `classifySubagentSession()` requires the PAIR (both
 * non-empty) to detect this vocabulary — a lone var must not trip light
 * mode — so this check asserts BOTH assignments exist, not either alone.
 * Verified against `avtc-pi-subagent@1.0.3` — `src/process-runner.ts`.
 *
 * @param {string} source contents of process-runner.ts (or wherever the
 *   per-spawn subagent env is built)
 * @returns {{ pass: boolean, detail: string }}
 */
export function checkAvtcChildEnv(source) {
	const setsChildAgent = /\w+\.PI_SUBAGENT_CHILD_AGENT\s*=/.test(source);
	const setsParentPid =
		/\w+\.PI_SUBAGENT_PARENT_PID\s*=\s*String\(\s*process\.pid\s*\)/.test(
			source,
		);
	const pass = setsChildAgent && setsParentPid;
	return {
		pass,
		detail: pass
			? "PI_SUBAGENT_CHILD_AGENT + PI_SUBAGENT_PARENT_PID both assigned on the per-spawn subagent env"
			: `missing: ${[
					!setsChildAgent && "PI_SUBAGENT_CHILD_AGENT assignment",
					!setsParentPid &&
						"PI_SUBAGENT_PARENT_PID = String(process.pid) assignment",
				]
					.filter(Boolean)
					.join(", ")}`,
	};
}

/**
 * Contract 2a (pi SDK): the extension loader keeps a process-global cache
 * named `extensionCache`. This is what makes an in-process
 * `bindExtensions()` (tintinweb-style) reuse pi-lens's own module-scope
 * singletons instead of a fresh isolated instance — the root cause #473
 * guards against. Verified against `core/extensions/loader.js`.
 *
 * @param {string} source contents of the extension loader dist file
 */
export function checkSdkExtensionCache(source) {
	const pass = /\bextensionCache\s*=\s*new Map\(\)/.test(source);
	return {
		pass,
		detail: pass
			? "process-global `extensionCache = new Map()` present"
			: "no process-global `extensionCache` Map found in the extension loader",
	};
}

/**
 * Contract 2b (pi SDK): `bindExtensions()` unconditionally emits a
 * `session_start`-typed event. Verified against `core/agent-session.js` —
 * looks for the emit call reaching a `session_start`-typed event object
 * (either inline `{ type: "session_start", ... }` or a field built from one
 * at construction, e.g. `_sessionStartEvent`) inside `bindExtensions`.
 *
 * @param {string} source contents of agent-session.js
 */
export function checkSdkBindExtensionsEmitsSessionStart(source) {
	const bindMatch = source.match(
		/async bindExtensions\([^)]*\)\s*\{([\s\S]*?)\n\s{4}\}/,
	);
	if (!bindMatch) {
		return { pass: false, detail: "bindExtensions() method not found" };
	}
	const body = bindMatch[1];
	const emitsSomething = /_extensionRunner\.emit\(/.test(body);
	// The emitted value must resolve to a session_start-typed event — either
	// inline or via a field that was constructed with `type: "session_start"`
	// somewhere in the file (covers the `_sessionStartEvent` indirection).
	const fieldName = body.match(/_extensionRunner\.emit\((this\.\w+)\)/)?.[1];
	const inlineSessionStart =
		/_extensionRunner\.emit\(\s*\{\s*type:\s*["']session_start["']/.test(body);
	const fieldIsSessionStart =
		fieldName !== undefined &&
		new RegExp(
			`${fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("this.", "")}\\s*=\\s*config\\.\\w+\\s*\\?\\?\\s*\\{\\s*type:\\s*["']session_start["']`,
		).test(source);
	const pass = emitsSomething && (inlineSessionStart || fieldIsSessionStart);
	return {
		pass,
		detail: pass
			? "bindExtensions() unconditionally emits a session_start-typed event"
			: emitsSomething
				? "bindExtensions() emits, but the emitted event could not be confirmed as session_start-typed"
				: "bindExtensions() does not call _extensionRunner.emit(...)",
	};
}

/**
 * Contract 2c (pi SDK): `invalidate(` is called on the extension runner from
 * the sequential session-replacement path (newSession/fork/switchSession/
 * reload's dispose route) — the mechanism `probeCtxActive()` in
 * session-lifecycle.ts relies on to distinguish a stale (replaced) ctx from
 * a live concurrent one. Verified against `core/agent-session.js`.
 *
 * @param {string} source contents of agent-session.js
 */
export function checkSdkInvalidateCalled(source) {
	const pass = /_extensionRunner\.invalidate\(/.test(source);
	return {
		pass,
		detail: pass
			? "_extensionRunner.invalidate(...) call site found"
			: "no _extensionRunner.invalidate(...) call site found",
	};
}

/**
 * Contract 2d (pi SDK): the stale-ctx error message contains the exact
 * fragment `session-lifecycle.ts`'s `probeCtxActive()` matches on. If this
 * wording changes upstream, the probe silently degrades to "inconclusive"
 * (fail-safe = sequential-replacement, never a false concurrent-secondary),
 * but that's exactly the drift we want the nightly to flag loudly.
 *
 * @param {string} source contents of agent-session.js
 */
export function checkSdkStaleCtxMessage(source) {
	const pass = source.includes("stale after session replacement");
	return {
		pass,
		detail: pass
			? 'stale-ctx message contains "stale after session replacement"'
			: 'stale-ctx message fragment "stale after session replacement" NOT found — probeCtxActive() in clients/session-lifecycle.ts will silently degrade to inconclusive',
	};
}

/**
 * Contract 3 (tintinweb/pi-subagents): constructs a `DefaultResourceLoader`
 * and calls `session.bindExtensions(...)` on a freshly created
 * `AgentSession` — the in-process model #473's concurrent-session guard
 * exists to protect against. Verified against `src/agent-runner.ts`.
 *
 * @param {string} source contents of agent-runner.ts
 */
export function checkTintinwebInProcessBind(source) {
	const usesResourceLoader = /new DefaultResourceLoader\(/.test(source);
	const callsBindExtensions =
		/\bbindExtensions\(\{/.test(source) || /\.bindExtensions\(/.test(source);
	const pass = usesResourceLoader && callsBindExtensions;
	return {
		pass,
		detail: pass
			? "constructs DefaultResourceLoader + calls session.bindExtensions() in-process"
			: `missing: ${[
					!usesResourceLoader && "`new DefaultResourceLoader(...)`",
					!callsBindExtensions && "`.bindExtensions(...)` call",
				]
					.filter(Boolean)
					.join(", ")}`,
	};
}

/**
 * Single source of truth for "which contract, which npm package, which
 * on-disk file(s), which check function" (#2680 F2). `package` IS the exact
 * npm package name (not a lookup key into a second table) — the orchestrator
 * derives its install list from `[...new Set(CONTRACTS.map(c => c.package))]`
 * rather than maintaining a separate name registry that could drift out of
 * sync with this one. `parts` names the candidate-path list(s)
 * `compat-contract-resolution.mjs`'s `resolveAndCheckContracts` resolves
 * (via `compat-contract-locator.mjs`) before calling `check` with the
 * concatenated source — a contract needing more than one file (nicobailon's
 * const + assignment split, #2581) lists more than one part. There used to
 * be a second table (`CONTRACT_SOURCE_LOCATIONS`) keyed by this same `id`
 * string with no parity guard between the two; folding `parts` in here
 * makes that join structurally impossible to desync.
 */
export const CONTRACTS = [
	{
		id: "nicobailon.child-env",
		package: "pi-subagents",
		description: "PI_SUBAGENT_CHILD env var set on every child-hosting process",
		check: checkNicobailonChildEnv,
		parts: [
			{
				name: "constants",
				candidates: [
					{ path: "src/runs/shared/pi-args.ts", observedAt: "0.34.0" },
					{
						path: "src/runs/shared/child-runtime-config.ts",
						observedAt: "0.65.0",
					},
				],
			},
			{
				name: "assignment",
				candidates: [
					{ path: "src/runs/shared/pi-args.ts", observedAt: "0.34.0" },
					{
						path: "src/runs/background/subagent-runner.ts",
						observedAt: "0.65.0",
					},
				],
			},
		],
	},
	{
		id: "avtc.child-env",
		package: "avtc-pi-subagent",
		description:
			"PI_SUBAGENT_CHILD_AGENT + PI_SUBAGENT_PARENT_PID pair set on every spawned child",
		check: checkAvtcChildEnv,
		parts: [
			{
				name: "source",
				candidates: [{ path: "src/process-runner.ts", observedAt: "1.0.3" }],
			},
		],
	},
	{
		id: "sdk.extension-cache",
		package: "@earendil-works/pi-coding-agent",
		description: "process-global extensionCache Map in the extension loader",
		check: checkSdkExtensionCache,
		parts: [
			{
				name: "source",
				candidates: [
					{ path: "dist/core/extensions/loader.js", observedAt: "0.80.6" },
				],
			},
		],
	},
	{
		id: "sdk.bind-extensions-session-start",
		package: "@earendil-works/pi-coding-agent",
		description:
			"bindExtensions() unconditionally emits a session_start-typed event",
		check: checkSdkBindExtensionsEmitsSessionStart,
		parts: [
			{
				name: "source",
				candidates: [
					{ path: "dist/core/agent-session.js", observedAt: "0.80.6" },
				],
			},
		],
	},
	{
		id: "sdk.invalidate-called",
		package: "@earendil-works/pi-coding-agent",
		description:
			"invalidate() called from the sequential session-replacement path",
		check: checkSdkInvalidateCalled,
		parts: [
			{
				name: "source",
				candidates: [
					{ path: "dist/core/agent-session.js", observedAt: "0.80.6" },
				],
			},
		],
	},
	{
		id: "sdk.stale-ctx-message",
		package: "@earendil-works/pi-coding-agent",
		description:
			'stale-ctx error message contains "stale after session replacement"',
		check: checkSdkStaleCtxMessage,
		parts: [
			{
				name: "source",
				candidates: [
					{ path: "dist/core/agent-session.js", observedAt: "0.80.6" },
				],
			},
		],
	},
	{
		id: "tintinweb.in-process-bind",
		package: "@tintinweb/pi-subagents",
		description:
			"constructs DefaultResourceLoader + calls bindExtensions() in-process",
		check: checkTintinwebInProcessBind,
		parts: [
			{
				name: "source",
				candidates: [{ path: "src/agent-runner.ts", observedAt: "0.13.0" }],
			},
		],
	},
];

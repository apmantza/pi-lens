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
 * Contract 1 (nicobailon/pi-subagents): the child-process env var names the
 * extension sets on every spawned subagent. We depend on `PI_SUBAGENT_CHILD`
 * being set to the literal string `"1"` (subagent-mode.ts reads it that way),
 * plus the run-id/child-agent-name identity vars existing in the same file
 * (best-effort identity surfaced in the latency log — absence degrades to
 * "unknown", never breaks). Verified against `src/runs/shared/pi-args.ts`.
 *
 * @param {string} source contents of pi-args.ts (or wherever the child env is built)
 * @returns {{ pass: boolean, detail: string }}
 */
export function checkNicobailonChildEnv(source) {
  const setsChildFlag =
    /env(?:\[[^\]]+\]|\.\w+)\s*=\s*["']1["']/.test(source) &&
    /SUBAGENT_CHILD_ENV\s*=\s*["']PI_SUBAGENT_CHILD["']/.test(source);
  const hasRunId = /SUBAGENT_RUN_ID_ENV\s*=\s*["']PI_SUBAGENT_RUN_ID["']/.test(source);
  const hasChildAgent = /SUBAGENT_CHILD_AGENT_ENV\s*=\s*["']PI_SUBAGENT_CHILD_AGENT["']/.test(
    source,
  );
  const pass = setsChildFlag && hasRunId && hasChildAgent;
  return {
    pass,
    detail: pass
      ? "PI_SUBAGENT_CHILD='1' set unconditionally; PI_SUBAGENT_RUN_ID + PI_SUBAGENT_CHILD_AGENT present"
      : `missing: ${[
          !setsChildFlag && "PI_SUBAGENT_CHILD='1' assignment",
          !hasRunId && "PI_SUBAGENT_RUN_ID const",
          !hasChildAgent && "PI_SUBAGENT_CHILD_AGENT const",
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
  const inlineSessionStart = /_extensionRunner\.emit\(\s*\{\s*type:\s*["']session_start["']/.test(
    body,
  );
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
  const callsBindExtensions = /\bbindExtensions\(\{/.test(source) || /\.bindExtensions\(/.test(source);
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
 * Run every contract check and return a combined report. Each entry name
 * matches what the workflow step / alert-issue body prints, so a failure is
 * traceable straight back to a specific dependency + source file.
 *
 * @param {{
 *   nicobailonPiArgsSource: string,
 *   sdkLoaderSource: string,
 *   sdkAgentSessionSource: string,
 *   tintinwebAgentRunnerSource: string,
 * }} inputs
 */
export function runAllContractChecks(inputs) {
  const results = [
    {
      id: "nicobailon.child-env",
      package: "pi-subagents",
      description: "PI_SUBAGENT_CHILD/RUN_ID/CHILD_AGENT env vars set on every spawned child",
      ...checkNicobailonChildEnv(inputs.nicobailonPiArgsSource),
    },
    {
      id: "sdk.extension-cache",
      package: "@earendil-works/pi-coding-agent",
      description: "process-global extensionCache Map in the extension loader",
      ...checkSdkExtensionCache(inputs.sdkLoaderSource),
    },
    {
      id: "sdk.bind-extensions-session-start",
      package: "@earendil-works/pi-coding-agent",
      description: "bindExtensions() unconditionally emits a session_start-typed event",
      ...checkSdkBindExtensionsEmitsSessionStart(inputs.sdkAgentSessionSource),
    },
    {
      id: "sdk.invalidate-called",
      package: "@earendil-works/pi-coding-agent",
      description: "invalidate() called from the sequential session-replacement path",
      ...checkSdkInvalidateCalled(inputs.sdkAgentSessionSource),
    },
    {
      id: "sdk.stale-ctx-message",
      package: "@earendil-works/pi-coding-agent",
      description: 'stale-ctx error message contains "stale after session replacement"',
      ...checkSdkStaleCtxMessage(inputs.sdkAgentSessionSource),
    },
    {
      id: "tintinweb.in-process-bind",
      package: "@tintinweb/pi-subagents",
      description: "constructs DefaultResourceLoader + calls bindExtensions() in-process",
      ...checkTintinwebInProcessBind(inputs.tintinwebAgentRunnerSource),
    },
  ];
  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

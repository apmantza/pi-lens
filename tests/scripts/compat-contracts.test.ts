/**
 * Tests for scripts/lib/compat-contracts.mjs — the pinned third-party
 * contract matchers backing the nightly compat-smoke (#476, Layer A).
 *
 * Each matcher is exercised against a MINIMAL synthetic snippet that carries
 * just the semantic shape it looks for (never real vendor source — that's
 * what scripts/compat-contracts.mjs verifies live against an npm install),
 * plus a mutated/absent variant to confirm the matcher actually fails closed.
 */

import { describe, expect, it } from "vitest";
import {
  checkNicobailonChildEnv,
  checkSdkBindExtensionsEmitsSessionStart,
  checkSdkExtensionCache,
  checkSdkInvalidateCalled,
  checkSdkStaleCtxMessage,
  checkTintinwebInProcessBind,
  runAllContractChecks,
} from "../../scripts/lib/compat-contracts.mjs";

describe("checkNicobailonChildEnv", () => {
  const GOOD = `
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
env[SUBAGENT_CHILD_ENV] = "1";
`;

  it("passes when the child flag is set and both identity consts exist", () => {
    const result = checkNicobailonChildEnv(GOOD);
    expect(result.pass).toBe(true);
  });

  it("fails when the child-flag assignment is missing", () => {
    const noAssignment = GOOD.replace('env[SUBAGENT_CHILD_ENV] = "1";', "");
    const result = checkNicobailonChildEnv(noAssignment);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("PI_SUBAGENT_CHILD");
  });

  it("fails when the run-id const is missing", () => {
    const noRunId = GOOD.replace(
      'export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";',
      "",
    );
    const result = checkNicobailonChildEnv(noRunId);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("PI_SUBAGENT_RUN_ID");
  });

  it("fails on an unrelated source", () => {
    const result = checkNicobailonChildEnv("export const X = 1;");
    expect(result.pass).toBe(false);
  });
});

describe("checkSdkExtensionCache", () => {
  it("passes when the process-global cache Map exists", () => {
    const result = checkSdkExtensionCache("const extensionCache = new Map();");
    expect(result.pass).toBe(true);
  });

  it("fails when the cache is a plain object, not a Map", () => {
    const result = checkSdkExtensionCache("const extensionCache = {};");
    expect(result.pass).toBe(false);
  });

  it("fails when there is no extensionCache at all", () => {
    const result = checkSdkExtensionCache("const somethingElse = new Map();");
    expect(result.pass).toBe(false);
  });
});

describe("checkSdkBindExtensionsEmitsSessionStart", () => {
  it("passes with an inline session_start emit inside bindExtensions", () => {
    const source = `
    async bindExtensions(bindings) {
        this._applyExtensionBindings(this._extensionRunner);
        await this._extensionRunner.emit({ type: "session_start", reason: "startup" });
    }
`;
    const result = checkSdkBindExtensionsEmitsSessionStart(source);
    expect(result.pass).toBe(true);
  });

  it("passes with the field-indirection form (_sessionStartEvent)", () => {
    const source = `
class AgentSession {
    constructor(config) {
        this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
    }
    async bindExtensions(bindings) {
        this._applyExtensionBindings(this._extensionRunner);
        await this._extensionRunner.emit(this._sessionStartEvent);
    }
}
`;
    const result = checkSdkBindExtensionsEmitsSessionStart(source);
    expect(result.pass).toBe(true);
  });

  it("fails when bindExtensions exists but never emits", () => {
    const source = `
    async bindExtensions(bindings) {
        this._applyExtensionBindings(this._extensionRunner);
    }
`;
    const result = checkSdkBindExtensionsEmitsSessionStart(source);
    expect(result.pass).toBe(false);
  });

  it("fails when bindExtensions method is absent entirely", () => {
    const result = checkSdkBindExtensionsEmitsSessionStart("class Foo {}");
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("not found");
  });

  it("fails when the emitted event is not session_start-typed", () => {
    const source = `
    async bindExtensions(bindings) {
        await this._extensionRunner.emit({ type: "other_event" });
    }
`;
    const result = checkSdkBindExtensionsEmitsSessionStart(source);
    expect(result.pass).toBe(false);
  });
});

describe("checkSdkInvalidateCalled", () => {
  it("passes when invalidate() is called on the extension runner", () => {
    const result = checkSdkInvalidateCalled(
      'this._extensionRunner.invalidate("stale after session replacement");',
    );
    expect(result.pass).toBe(true);
  });

  it("fails when invalidate is never called", () => {
    const result = checkSdkInvalidateCalled("this._extensionRunner.emit(event);");
    expect(result.pass).toBe(false);
  });
});

describe("checkSdkStaleCtxMessage", () => {
  it("passes when the exact fragment is present", () => {
    const result = checkSdkStaleCtxMessage(
      'invalidate("This extension ctx is stale after session replacement or reload.");',
    );
    expect(result.pass).toBe(true);
  });

  it("fails when the wording has drifted", () => {
    const result = checkSdkStaleCtxMessage(
      'invalidate("This context is no longer valid.");',
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("session-lifecycle.ts");
  });
});

describe("checkTintinwebInProcessBind", () => {
  it("passes when both the resource loader and bindExtensions call exist", () => {
    const source = `
const loader = new DefaultResourceLoader({ cwd });
await session.bindExtensions({ onError });
`;
    const result = checkTintinwebInProcessBind(source);
    expect(result.pass).toBe(true);
  });

  it("fails when DefaultResourceLoader is not constructed", () => {
    const result = checkTintinwebInProcessBind("await session.bindExtensions({});");
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("DefaultResourceLoader");
  });

  it("fails when bindExtensions is never called", () => {
    const result = checkTintinwebInProcessBind(
      "const loader = new DefaultResourceLoader({ cwd });",
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("bindExtensions");
  });
});

describe("runAllContractChecks", () => {
  it("aggregates all six checks and reports allPass=false on any single failure", () => {
    const inputs = {
      nicobailonPiArgsSource: "export const X = 1;", // fails
      sdkLoaderSource: "const extensionCache = new Map();",
      sdkAgentSessionSource: `
    async bindExtensions(bindings) {
        await this._extensionRunner.emit({ type: "session_start" });
    }
    invalidate() { this._extensionRunner.invalidate("stale after session replacement"); }
`,
      tintinwebAgentRunnerSource: `
const loader = new DefaultResourceLoader({ cwd });
await session.bindExtensions({});
`,
    };
    const { results, allPass } = runAllContractChecks(inputs);
    expect(results).toHaveLength(6);
    expect(allPass).toBe(false);
    const failed = results.filter((r) => !r.pass);
    expect(failed.map((r) => r.id)).toEqual(["nicobailon.child-env"]);
  });

  it("reports allPass=true when every check passes", () => {
    const inputs = {
      nicobailonPiArgsSource: `
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
env[SUBAGENT_CHILD_ENV] = "1";
`,
      sdkLoaderSource: "const extensionCache = new Map();",
      sdkAgentSessionSource: `
    async bindExtensions(bindings) {
        await this._extensionRunner.emit({ type: "session_start" });
    }
    invalidate() { this._extensionRunner.invalidate("stale after session replacement"); }
`,
      tintinwebAgentRunnerSource: `
const loader = new DefaultResourceLoader({ cwd });
await session.bindExtensions({});
`,
    };
    const { allPass } = runAllContractChecks(inputs);
    expect(allPass).toBe(true);
  });
});

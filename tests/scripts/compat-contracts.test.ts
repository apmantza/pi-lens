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
	checkAvtcChildEnv,
	checkNicobailonChildEnv,
	checkSdkBindExtensionsEmitsSessionStart,
	checkSdkExtensionCache,
	checkSdkInvalidateCalled,
	checkSdkStaleCtxMessage,
	checkTintinwebInProcessBind,
} from "../../scripts/lib/compat-contracts.mjs";

describe("checkNicobailonChildEnv", () => {
	const GOOD = `
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
env[SUBAGENT_CHILD_ENV] = "1";
`;

	it("passes when the child flag is set", () => {
		const result = checkNicobailonChildEnv(GOOD);
		expect(result.pass).toBe(true);
	});

	it("fails when the child-flag assignment is missing", () => {
		const noAssignment = GOOD.replace('env[SUBAGENT_CHILD_ENV] = "1";', "");
		const result = checkNicobailonChildEnv(noAssignment);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("PI_SUBAGENT_CHILD");
	});

	it("fails when the const definition is missing (assignment alone isn't enough)", () => {
		const noConst = GOOD.replace(
			'export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";',
			"",
		);
		const result = checkNicobailonChildEnv(noConst);
		expect(result.pass).toBe(false);
	});

	// #2581/#2680 F4: pi-subagents@0.65.0's native-AgentSession rewrite
	// removed PI_SUBAGENT_RUN_ID / PI_SUBAGENT_CHILD_AGENT from the whole
	// package AND split the const definition and the assignment across two
	// files (child-runtime-config.ts + subagent-runner.ts) that used to be
	// co-located in one pi-args.ts. This fixture reproduces that REAL
	// 0.66.0-shaped concatenation (what the orchestrator's
	// locateContractSources actually hands the check, not the single-file
	// GOOD snippet above) so this case has its own signature — re-adding
	// the run-id requirement would red this AND the plain GOOD case above;
	// a regression that only broke cross-file concatenation would red only
	// this one.
	it("passes against a real 0.66.0-shaped concatenation (const + assignment in different files, no identity consts)", () => {
		const constantsFile = `
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
`;
		const assignmentFile = `
import { SUBAGENT_CHILD_ENV } from "../shared/child-runtime-config.ts";
process.env[SUBAGENT_CHILD_ENV] = "1";
`;
		const concatenated = `${constantsFile}\n${assignmentFile}`;
		expect(concatenated).not.toContain("PI_SUBAGENT_RUN_ID");
		expect(concatenated).not.toContain("PI_SUBAGENT_CHILD_AGENT");
		const result = checkNicobailonChildEnv(concatenated);
		expect(result.pass).toBe(true);
	});

	it("fails on an unrelated source", () => {
		const result = checkNicobailonChildEnv("export const X = 1;");
		expect(result.pass).toBe(false);
	});
});

describe("checkAvtcChildEnv", () => {
	const GOOD = `
if (agent.name) subagentEnv.PI_SUBAGENT_CHILD_AGENT = agent.name;
subagentEnv.PI_SUBAGENT_PARENT_PID = String(process.pid);
`;

	it("passes when both the child-agent and parent-pid assignments exist", () => {
		const result = checkAvtcChildEnv(GOOD);
		expect(result.pass).toBe(true);
	});

	it("fails when the child-agent assignment is missing", () => {
		const noChildAgent = GOOD.replace(
			"if (agent.name) subagentEnv.PI_SUBAGENT_CHILD_AGENT = agent.name;",
			"",
		);
		const result = checkAvtcChildEnv(noChildAgent);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("PI_SUBAGENT_CHILD_AGENT");
	});

	it("fails when the parent-pid assignment is missing", () => {
		const noParentPid = GOOD.replace(
			"subagentEnv.PI_SUBAGENT_PARENT_PID = String(process.pid);",
			"",
		);
		const result = checkAvtcChildEnv(noParentPid);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("PI_SUBAGENT_PARENT_PID");
	});

	it("fails when the parent-pid assignment doesn't use String(process.pid)", () => {
		const wrongShape = GOOD.replace(
			"subagentEnv.PI_SUBAGENT_PARENT_PID = String(process.pid);",
			"subagentEnv.PI_SUBAGENT_PARENT_PID = process.pid;",
		);
		const result = checkAvtcChildEnv(wrongShape);
		expect(result.pass).toBe(false);
	});

	it("fails on an unrelated source", () => {
		const result = checkAvtcChildEnv("export const X = 1;");
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("PI_SUBAGENT_CHILD_AGENT");
		expect(result.detail).toContain("PI_SUBAGENT_PARENT_PID");
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
		const result = checkSdkInvalidateCalled(
			"this._extensionRunner.emit(event);",
		);
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
		const result = checkTintinwebInProcessBind(
			"await session.bindExtensions({});",
		);
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

// Aggregation across all seven contracts (formerly `runAllContractChecks`,
// which only ever fed a resolved-source map nothing in production actually
// built — #2680 F3) now lives at the seam that ships:
// `resolveAndCheckContracts` in scripts/lib/compat-contract-resolution.mjs,
// covered by tests/scripts/compat-contract-resolution.test.ts against a
// real on-disk fixture (verified/drift/infra together).

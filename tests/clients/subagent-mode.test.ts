/**
 * Subagent light mode (#449 slice 0; broadened #507).
 *
 * Covers: env detection of `PI_SUBAGENT_CHILD=1` (nicobailon/pi-subagents)
 * and the `PI_SUBAGENT_CHILD_AGENT` + `PI_SUBAGENT_PARENT_PID` pair
 * (avtc-pi-subagent, #507), the `PI_LENS_SUBAGENT_FULL=1` override hatch for
 * both vocabularies, identity parsing (including the `marker` field), and
 * `_resetSubagentModeForTests`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetSubagentModeForTests,
	getSubagentIdentity,
	isSubagentSession,
	subagentLightModeNotice,
} from "../../clients/subagent-mode.js";

const envKeys = [
	"PI_SUBAGENT_CHILD",
	"PI_LENS_SUBAGENT_FULL",
	"PI_SUBAGENT_RUN_ID",
	"PI_SUBAGENT_CHILD_AGENT",
	"PI_SUBAGENT_PARENT_PID",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = {};
	for (const key of envKeys) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	_resetSubagentModeForTests();
});

afterEach(() => {
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	_resetSubagentModeForTests();
});

describe("isSubagentSession", () => {
	it("is false when PI_SUBAGENT_CHILD is unset", () => {
		expect(isSubagentSession()).toBe(false);
	});

	it("is false when PI_SUBAGENT_CHILD is set to something other than '1'", () => {
		process.env.PI_SUBAGENT_CHILD = "0";
		expect(isSubagentSession()).toBe(false);
		process.env.PI_SUBAGENT_CHILD = "true";
		expect(isSubagentSession()).toBe(false);
	});

	it("is true when PI_SUBAGENT_CHILD=1", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		expect(isSubagentSession()).toBe(true);
	});

	it("PI_LENS_SUBAGENT_FULL=1 overrides PI_SUBAGENT_CHILD=1 back to full behavior", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_LENS_SUBAGENT_FULL = "1";
		expect(isSubagentSession()).toBe(false);
	});

	it("PI_LENS_SUBAGENT_FULL=1 alone (no subagent) stays false", () => {
		process.env.PI_LENS_SUBAGENT_FULL = "1";
		expect(isSubagentSession()).toBe(false);
	});

	it("PI_LENS_SUBAGENT_FULL set to a non-'1' value does not suppress detection", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_LENS_SUBAGENT_FULL = "0";
		expect(isSubagentSession()).toBe(true);
	});

	it("is true when both PI_SUBAGENT_CHILD_AGENT and PI_SUBAGENT_PARENT_PID are set (avtc-pi-subagent pair)", () => {
		process.env.PI_SUBAGENT_CHILD_AGENT = "reviewer-1";
		process.env.PI_SUBAGENT_PARENT_PID = "12345";
		expect(isSubagentSession()).toBe(true);
	});

	it("is false when only PI_SUBAGENT_CHILD_AGENT is set (no parent pid) — false-positive guard", () => {
		process.env.PI_SUBAGENT_CHILD_AGENT = "reviewer-1";
		expect(isSubagentSession()).toBe(false);
	});

	it("is false when only PI_SUBAGENT_PARENT_PID is set (no child agent) — false-positive guard", () => {
		process.env.PI_SUBAGENT_PARENT_PID = "12345";
		expect(isSubagentSession()).toBe(false);
	});

	it("PI_LENS_SUBAGENT_FULL=1 overrides the avtc pair back to full behavior", () => {
		process.env.PI_SUBAGENT_CHILD_AGENT = "reviewer-1";
		process.env.PI_SUBAGENT_PARENT_PID = "12345";
		process.env.PI_LENS_SUBAGENT_FULL = "1";
		expect(isSubagentSession()).toBe(false);
	});
});

describe("getSubagentIdentity", () => {
	it("returns undefined when neither identity env var is set", () => {
		expect(getSubagentIdentity()).toBeUndefined();
	});

	it("parses runId and agentName when both are set (nicobailon, no avtc pair)", () => {
		process.env.PI_SUBAGENT_RUN_ID = "run-123";
		process.env.PI_SUBAGENT_CHILD_AGENT = "code-reviewer";
		expect(getSubagentIdentity()).toEqual({
			runId: "run-123",
			agentName: "code-reviewer",
			marker: undefined,
			parentPid: undefined,
		});
	});

	it("parses a partial identity (runId only)", () => {
		process.env.PI_SUBAGENT_RUN_ID = "run-456";
		expect(getSubagentIdentity()).toEqual({
			runId: "run-456",
			agentName: undefined,
			marker: undefined,
			parentPid: undefined,
		});
	});

	it("parses a partial identity (agentName only)", () => {
		process.env.PI_SUBAGENT_CHILD_AGENT = "explore";
		expect(getSubagentIdentity()).toEqual({
			runId: undefined,
			agentName: "explore",
			marker: undefined,
			parentPid: undefined,
		});
	});

	it("treats empty-string env values as absent", () => {
		process.env.PI_SUBAGENT_RUN_ID = "";
		process.env.PI_SUBAGENT_CHILD_AGENT = "";
		expect(getSubagentIdentity()).toBeUndefined();
	});

	it("carries marker 'pi-subagents' and agentName when PI_SUBAGENT_CHILD=1", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_CHILD_AGENT = "code-reviewer";
		expect(isSubagentSession()).toBe(true);
		expect(getSubagentIdentity()).toEqual({
			runId: undefined,
			agentName: "code-reviewer",
			marker: "pi-subagents",
			parentPid: undefined,
		});
	});

	it("carries marker 'avtc-pi-subagent' and agentName when the avtc pair is set", () => {
		process.env.PI_SUBAGENT_CHILD_AGENT = "reviewer-1";
		process.env.PI_SUBAGENT_PARENT_PID = "12345";
		expect(isSubagentSession()).toBe(true);
		expect(getSubagentIdentity()).toEqual({
			runId: undefined,
			agentName: "reviewer-1",
			marker: "avtc-pi-subagent",
			parentPid: 12345,
		});
	});

	// #2581: pi-subagents@0.65.0's native-AgentSession rewrite removed
	// PI_SUBAGENT_RUN_ID/PI_SUBAGENT_CHILD_AGENT from the whole package
	// (grep-verified absent from the 0.66.0 source tree) — this is now the
	// PERMANENT env shape for the nicobailon vocabulary, not a transient gap.
	// Light mode itself must keep engaging on the child flag alone, and
	// identity must degrade to "known subagent, unknown identity" rather than
	// treating the missing vars as "not a subagent at all".
	it("still classifies as a subagent with marker set when PI_SUBAGENT_CHILD=1 is the ONLY var present (pi-subagents@0.65.0+ reality)", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		expect(isSubagentSession()).toBe(true);
		expect(getSubagentIdentity()).toEqual({
			runId: undefined,
			agentName: undefined,
			marker: "pi-subagents",
			parentPid: undefined,
		});
	});
});

describe("subagentLightModeNotice", () => {
	it("mentions the override escape hatch", () => {
		expect(subagentLightModeNotice()).toContain("PI_LENS_SUBAGENT_FULL=1");
	});
});

describe("_resetSubagentModeForTests", () => {
	it("is safe to call with no prior state (no-op today, but must not throw)", () => {
		expect(() => _resetSubagentModeForTests()).not.toThrow();
	});
});

/**
 * Subagent light mode (#449 slice 0).
 *
 * Covers: env detection of `PI_SUBAGENT_CHILD=1`, the `PI_LENS_SUBAGENT_FULL=1`
 * override hatch, identity parsing from `PI_SUBAGENT_RUN_ID` /
 * `PI_SUBAGENT_CHILD_AGENT`, and `_resetSubagentModeForTests`.
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
});

describe("getSubagentIdentity", () => {
	it("returns undefined when neither identity env var is set", () => {
		expect(getSubagentIdentity()).toBeUndefined();
	});

	it("parses runId and agentName when both are set", () => {
		process.env.PI_SUBAGENT_RUN_ID = "run-123";
		process.env.PI_SUBAGENT_CHILD_AGENT = "code-reviewer";
		expect(getSubagentIdentity()).toEqual({
			runId: "run-123",
			agentName: "code-reviewer",
		});
	});

	it("parses a partial identity (runId only)", () => {
		process.env.PI_SUBAGENT_RUN_ID = "run-456";
		expect(getSubagentIdentity()).toEqual({
			runId: "run-456",
			agentName: undefined,
		});
	});

	it("parses a partial identity (agentName only)", () => {
		process.env.PI_SUBAGENT_CHILD_AGENT = "explore";
		expect(getSubagentIdentity()).toEqual({
			runId: undefined,
			agentName: "explore",
		});
	});

	it("treats empty-string env values as absent", () => {
		process.env.PI_SUBAGENT_RUN_ID = "";
		process.env.PI_SUBAGENT_CHILD_AGENT = "";
		expect(getSubagentIdentity()).toBeUndefined();
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

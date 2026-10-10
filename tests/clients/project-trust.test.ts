import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const { logExtension } = vi.hoisted(() => ({ logExtension: vi.fn() }));
import {
	adoptProjectTrustFromContext,
	assertInstallAllowed,
	getProjectTrustState,
	isLspSpawnAllowedByTrust,
	isToolInstallAllowedByTrust,
	projectTrustDenialReason,
	readProjectTrustFromContext,
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";

vi.mock("../../clients/extension-log.js", () => ({ logExtension }));

afterEach(() => {
	resetProjectTrust();
	resetDegradationLedger();
	logExtension.mockClear();
});

describe("readProjectTrustFromContext (#1334 S5)", () => {
	it("maps the host boolean onto the three-valued state", () => {
		expect(readProjectTrustFromContext({ isProjectTrusted: () => true })).toBe(
			"trusted",
		);
		expect(readProjectTrustFromContext({ isProjectTrusted: () => false })).toBe(
			"untrusted",
		);
	});

	it("reports 'unknown' when the host has no trust surface at all", () => {
		expect(readProjectTrustFromContext({})).toBe("unknown");
		expect(readProjectTrustFromContext(undefined)).toBe("unknown");
		expect(readProjectTrustFromContext(null)).toBe("unknown");
		// Present but not callable — an older/foreign host shape.
		expect(readProjectTrustFromContext({ isProjectTrusted: true })).toBe(
			"unknown",
		);
	});

	it("fails closed on a throwing accessor but keeps non-boolean unknown", () => {
		expect(
			readProjectTrustFromContext({
				isProjectTrusted: () => {
					throw new Error("host blew up");
				},
			}),
		).toBe("untrusted");
		expect(
			readProjectTrustFromContext({ isProjectTrusted: () => undefined }),
		).toBe("unknown");
	});
});

describe("project-trust policy gates", () => {
	it("warns once per refusal context and resets the warning set on trust changes", () => {
		setProjectTrustState("untrusted");
		expect(assertInstallAllowed("test install")).toBe(false);
		expect(assertInstallAllowed("test install")).toBe(false);
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({ kind: "trust-refusal", count: 2 }),
		]);
		expect(
			logExtension.mock.calls.filter(([entry]) => entry.level === "warn"),
		).toHaveLength(1);

		setProjectTrustState("trusted");
		setProjectTrustState("untrusted");
		expect(assertInstallAllowed("test install")).toBe(false);
		expect(
			logExtension.mock.calls.filter(([entry]) => entry.level === "warn"),
		).toHaveLength(2);
	});

	it("keeps installs and legacy raw LSP spawns fail-open when nothing has been adopted", () => {
		expect(getProjectTrustState()).toBe("unknown");
		expect(isToolInstallAllowedByTrust()).toBe(true);
		expect(isLspSpawnAllowedByTrust()).toBe(true);
		expect(projectTrustDenialReason()).toBeUndefined();
	});

	it("blocks installs and LSP spawns only on an explicit host denial", () => {
		setProjectTrustState("trusted");
		expect(isToolInstallAllowedByTrust()).toBe(true);
		expect(isLspSpawnAllowedByTrust()).toBe(true);
		expect(projectTrustDenialReason()).toBeUndefined();

		setProjectTrustState("untrusted");
		expect(isToolInstallAllowedByTrust()).toBe(false);
		expect(isLspSpawnAllowedByTrust()).toBe(false);
		expect(projectTrustDenialReason()).toContain("not trusted");
	});

	it("adopts from a ctx and latches the result", () => {
		expect(
			adoptProjectTrustFromContext({ isProjectTrusted: () => false }),
		).toBe("untrusted");
		expect(getProjectTrustState()).toBe("untrusted");

		// A later session_start on a trusted cwd must lift the gate again.
		expect(adoptProjectTrustFromContext({ isProjectTrusted: () => true })).toBe(
			"trusted",
		);
		expect(isLspSpawnAllowedByTrust()).toBe(true);

		// …and an older host re-reads as "unknown", not as a sticky denial.
		expect(adoptProjectTrustFromContext({})).toBe("unknown");
		expect(isToolInstallAllowedByTrust()).toBe(true);
		expect(isLspSpawnAllowedByTrust()).toBe(true);
	});
});

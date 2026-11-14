/**
 * #4929: the opt-in gate of an auxiliary profile (`enabledByDefault: false`),
 * and the fallow profile that is its first member.
 *
 * Recurrences named per case:
 *  - fail-open gate: `isEnabledByConfiguration` once read only the kill switch,
 *    so a profile could not ship off; the first "opt-in" spelling of it
 *    (`enabledByDefault && ...`) was off for everyone, including the operator
 *    who had turned it on. The gate admits exactly `true` from the profile's
 *    own flag and refuses every other value.
 *  - value shape: a config value of `"yes"`, `1` or an object is a malformed
 *    gate, not a request. Each goes through the REAL config parser and flag
 *    resolution, not a hand-shaped getFlag.
 *  - shape 87 (#4913): the flag is read per call, never captured, so a value
 *    the host applies after the factory runs still decides.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUXILIARY_LSP_PROFILES,
	configDisabledAuxiliaryLspServerIds,
	enabledOptInAuxiliaryLspServerIds,
	enabledAuxiliaryLspServerIds,
	findAuxiliaryProfileForSource,
	isOptInAuxiliaryServerId,
	retagAuxiliaryDiagnostics,
} from "../../../clients/dispatch/auxiliary-lsp.js";
import { convertLspDiagnostics } from "../../../clients/dispatch/utils/lsp-diagnostics.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import {
	getPiLensGlobalConfigPath,
	loadPiLensGlobalConfig,
	resetGlobalConfigLocationCache,
	resetGlobalConfigWarnCache,
	resolvePiLensFlag,
} from "../../../clients/lens-config.js";
import { getLensFlagSpec } from "../../../clients/lens-flag-registry.js";
import { _resetSubagentModeForTests } from "../../../clients/subagent-mode.js";
import { pinFixtureHome } from "../test-utils.js";

const diag = (over: Partial<LSPDiagnostic>): LSPDiagnostic =>
	({
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		message: "Export 'unusedExport' is unused",
		severity: 4,
		source: "fallow",
		code: "unused-export",
		...over,
	}) as LSPDiagnostic;

beforeEach(() => {
	_resetSubagentModeForTests();
	// The ambient config location (set by the test setup or a pi host) must not
	// decide which file the gate cases read.
	vi.stubEnv("PI_LENS_CONFIG_PATH", undefined);
	vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
});
afterEach(() => {
	_resetSubagentModeForTests();
	vi.unstubAllEnvs();
	resetGlobalConfigLocationCache();
	resetGlobalConfigWarnCache();
});

describe("the opt-in gate admits exactly `true` from the profile's own flag", () => {
	it("is off when nothing is set", () => {
		expect(enabledAuxiliaryLspServerIds(() => undefined)).not.toContain(
			"fallow",
		);
	});

	it("is on only when lens-fallow is exactly true", () => {
		expect(
			enabledAuxiliaryLspServerIds((flag) =>
				flag === "lens-fallow" ? true : undefined,
			),
		).toContain("fallow");
	});

	it.each([
		["false", false],
		["the string 'true'", "true"],
		["the string '1'", "1"],
		["the string 'yes'", "yes"],
		["an empty string", ""],
		["undefined", undefined],
	] as const)("stays off for %s", (_label, value) => {
		const ids = enabledAuxiliaryLspServerIds((flag) =>
			flag === "lens-fallow" ? value : undefined,
		);
		expect(ids).not.toContain("fallow");
	});

	it.each([
		"no-fallow",
		"fallow",
		"fallow.enabled",
		"lens-fallow-lsp",
		"lens-turn-end-madge",
	])("stays off when only the unrelated flag %s is true", (name) => {
		expect(
			enabledAuxiliaryLspServerIds((flag) =>
				flag === name ? true : undefined,
			),
		).not.toContain("fallow");
	});

	it("does not capture the flag: a later answer decides (shape 87)", () => {
		let answer: boolean | undefined = false;
		const getFlag = (flag: string) =>
			flag === "lens-fallow" ? answer : undefined;
		expect(enabledAuxiliaryLspServerIds(getFlag)).not.toContain("fallow");
		answer = true;
		expect(enabledAuxiliaryLspServerIds(getFlag)).toContain("fallow");
		answer = undefined;
		expect(enabledAuxiliaryLspServerIds(getFlag)).not.toContain("fallow");
	});

	it("never reports an unenabled opt-in profile as switched off", () => {
		// Recurrence: listing fallow here made every diagnostics report end with
		// "Switched off, not run: fallow" for an operator who never asked for it
		// (caught by tests/tools/diagnostics-route-switch-matrix.test.ts).
		expect([...configDisabledAuxiliaryLspServerIds(() => undefined)]).toEqual(
			[],
		);
		expect([
			...configDisabledAuxiliaryLspServerIds((flag) =>
				flag === "lens-fallow" ? "yes" : undefined,
			),
		]).toEqual([]);
	});

	it("names the enabled opt-in profiles only, for the diagnostics report (#4956 F2)", () => {
		// Recurrence: an enabled opt-in server the all-server door never starts was
		// claimed as covered; the report names it from this set.
		expect([...enabledOptInAuxiliaryLspServerIds(() => undefined)]).toEqual([]);
		expect([
			...enabledOptInAuxiliaryLspServerIds((flag) =>
				flag === "lens-fallow" ? true : undefined,
			),
		]).toEqual(["fallow"]);
		// Every flag true: the kill switches are on, and still only the opt-in lists.
		expect([...enabledOptInAuxiliaryLspServerIds(() => true)]).toEqual([
			"fallow",
		]);
	});

	it("leaves every default-on profile untouched by the new gate", () => {
		expect(enabledAuxiliaryLspServerIds(() => undefined).sort()).toEqual([
			"ast-grep",
			"opengrep",
			"typos",
			"zizmor",
		]);
	});
});

describe("the gate through the real global config and flag resolution", () => {
	function resolveFromConfig(contents: string | undefined): boolean {
		const { home } = pinFixtureHome("fallow-gate-4929");
		resetGlobalConfigLocationCache();
		resetGlobalConfigWarnCache();
		const configPath = getPiLensGlobalConfigPath(home);
		if (contents !== undefined) {
			fs.mkdirSync(path.dirname(configPath), { recursive: true });
			fs.writeFileSync(configPath, contents, "utf-8");
		}
		const config = loadPiLensGlobalConfig(configPath);
		const value = resolvePiLensFlag("lens-fallow", undefined, config);
		return enabledAuxiliaryLspServerIds((flag) =>
			flag === "lens-fallow" ? value : undefined,
		).includes("fallow");
	}

	it("turns on for fallow.enabled: true", () => {
		expect(resolveFromConfig('{ "fallow": { "enabled": true } }')).toBe(true);
	});

	it.each([
		["no config file", undefined],
		["an empty document", "{}"],
		["enabled: false", '{ "fallow": { "enabled": false } }'],
		["a string value", '{ "fallow": { "enabled": "yes" } }'],
		["a numeric value", '{ "fallow": { "enabled": 1 } }'],
		["a null value", '{ "fallow": { "enabled": null } }'],
		["an array value", '{ "fallow": { "enabled": [true] } }'],
		["a boolean where the section object belongs", '{ "fallow": true }'],
		["a string where the section object belongs", '{ "fallow": "on" }'],
		["an unknown sub-key", '{ "fallow": { "enable": true } }'],
		["a misspelled section", '{ "fallows": { "enabled": true } }'],
		["the negated spelling", '{ "fallow": { "disabled": false } }'],
		["an unparseable document", '{ "fallow": { "enabled": true '],
	] as const)("stays off for %s", (_label, contents) => {
		expect(resolveFromConfig(contents)).toBe(false);
	});

	it("a CLI value that is not the boolean true does not turn it on", () => {
		const value = resolvePiLensFlag("lens-fallow", "false", undefined);
		expect(
			enabledAuxiliaryLspServerIds((flag) =>
				flag === "lens-fallow" ? value : undefined,
			),
		).not.toContain("fallow");
	});
});

describe("the fallow profile", () => {
	const fallow = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "fallow");

	it("is the one opt-in profile and names a registered, default-off, global flag", () => {
		expect(fallow?.enabledByDefault).toBe(false);
		expect(isOptInAuxiliaryServerId("fallow")).toBe(true);
		expect(isOptInAuxiliaryServerId("typos")).toBe(false);
		expect(isOptInAuxiliaryServerId("not-a-server")).toBe(false);
		const spec = getLensFlagSpec(fallow?.optInFlag ?? "");
		expect(spec, "optInFlag is a registry flag").toBeDefined();
		expect(spec?.default).toBe(false);
		expect(spec?.negated).toBe(false);
		expect(spec?.scope).toBe("global");
		expect(spec?.configKey).toBe("fallow.enabled");
		// Every opt-in profile in the tree meets the same bar.
		for (const profile of AUXILIARY_LSP_PROFILES.filter(
			(p) => !p.enabledByDefault,
		)) {
			expect(getLensFlagSpec(profile.optInFlag ?? "")?.default).toBe(false);
		}
	});

	it("routes fallow's source to the profile", () => {
		expect(findAuxiliaryProfileForSource("fallow")?.tool).toBe("fallow");
	});

	it("never blocks: an ERROR-severity finding stays a warning with blocking allowed", () => {
		expect(fallow?.allowBlocking).toBeUndefined();
		for (const severity of [1, 2, 3, 4] as const) {
			expect(
				fallow?.semantic(diag({ severity }), { blockingAllowed: true }),
			).toBe("warning");
		}
		const raw = [diag({ severity: 1 })];
		const converted = convertLspDiagnostics(raw, "/proj/src/a.ts");
		const retagged = retagAuxiliaryDiagnostics(converted, raw, "x", {
			cwd: "/proj",
			fileRole: "source",
		});
		expect(retagged).toHaveLength(1);
		expect(retagged[0].tool).toBe("fallow");
		expect(retagged[0].semantic).toBe("warning");
		expect(retagged[0].severity).toBe("warning");
	});

	it("keeps fallow's HINT-severity unused-code finding visible as an advisory warning", () => {
		// fallow publishes unused-export as LSP HINT (4). The generic conversion
		// keeps it advisory; the profile must preserve that warning tier.
		const raw = [diag({ severity: 4 })];
		const converted = convertLspDiagnostics(raw, "/proj/src/a.ts");
		expect(converted[0].semantic).toBe("warning");
		const retagged = retagAuxiliaryDiagnostics(converted, raw, "x", {
			cwd: "/proj",
			fileRole: "source",
		});
		expect(retagged[0].semantic).toBe("warning");
		expect(retagged[0].rule).toBe("fallow:unused-export");
	});

	it("classifies unused-code and security-sink findings, and leaves the rest unclassified", () => {
		expect(fallow?.defectClass?.(diag({ code: "unused-export" }))).toBe(
			"unused-value",
		);
		expect(fallow?.defectClass?.(diag({ code: "unused-file" }))).toBe(
			"unused-value",
		);
		expect(fallow?.defectClass?.(diag({ code: "tainted-sink" }))).toBe(
			"safety",
		);
		expect(fallow?.defectClass?.(diag({ code: "circular-dependency" }))).toBe(
			undefined,
		);
		expect(fallow?.defectClass?.(diag({ code: undefined }))).toBe(undefined);
	});
});

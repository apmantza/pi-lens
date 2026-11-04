/**
 * `rules.<id>.disable` is a denial: the union of every tier (#5232).
 *
 * Recurrence this guards: tiers REPLACED the `disable` list, so a project (or
 * a nested `pkg/.pi-lens.json`) that listed one rule brought back every rule
 * the global or root config had disabled, against `docs/configuration.md`
 * ("the workspace root's policy still reaches them") and #2415 AC3 (a nearer
 * config never weakens a deny). `ignorePaths`, `lsp.disabledServers` and
 * `dispatch.disabledRunners` already union through the schema's `x-deny`.
 *
 * Everything below drives real config files on disk, the real resolver and
 * the real policy builder; nothing is stubbed.
 *
 * What stays here is what a property over verdicts cannot pin: the resolved
 * list's exact members and order (de-duplication, lowest tier first) and the
 * raw spellings single-tier configs already carry. The union, per-key
 * `select`, disable-over-select and non-string-member claims are properties
 * over generated tier stacks in `rule-policy-merge-properties.test.ts` (#5250);
 * the notice text a bad member or value draws is pinned here, because a verdict
 * property cannot see it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadPiLensGlobalConfig,
	resetGlobalConfigWarnCache,
} from "../../../clients/lens-config.js";
import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import { wireUserNotifier } from "../../../clients/user-notify.js";
import { resolvePiLensConfig } from "../../../clients/config-resolve.js";
import {
	evaluateRulePolicy,
	rulePolicyMapFromResolution,
} from "../../../clients/dispatch/rule-policy.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { useConfigPath } from "../../support/global-config.js";
import { removeTempDirSync } from "../test-utils.js";

const setConfigPath = useConfigPath();

let tmpDir: string;
let globalDir: string;
let repo: string;

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

const writeGlobal = (config: unknown) =>
	writeJson(path.join(globalDir, "config.json"), config);
const writeAt = (dir: string, config: unknown) =>
	writeJson(path.join(dir, ".pi-lens.json"), config);

/** The policy map a file under `dir` reads, via the production resolver. */
function policyAt(dir: string) {
	return rulePolicyMapFromResolution(
		resolvePiLensConfig({
			cwd: dir,
			globalDir,
			globalConfigPath: path.join(globalDir, "config.json"),
			homeDir: tmpDir,
		}),
		repo,
	);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-disable-union-"));
	globalDir = path.join(tmpDir, ".pi-lens");
	repo = path.join(tmpDir, "repo");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	setConfigPath(path.join(globalDir, "config.json"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	resetProjectLensConfigCache();
	removeTempDirSync(tmpDir);
});

describe("rules.<id>.disable — union across tiers (#5232)", () => {
	it("members are de-duplicated and keep lowest-tier-first order", () => {
		writeGlobal({ rules: { k: { disable: ["rule-a", "rule-b"] } } });
		writeAt(repo, { rules: { k: { disable: ["rule-b", "rule-c"] } } });

		expect(policyAt(repo)?.k?.disable).toEqual(["rule-a", "rule-b", "rule-c"]);
	});

	it.each([
		["a single-tier list", ["rule-c"], ["rule-c"]],
		["an empty list", [], []],
		["blank entries", ["  ", ""], ["  ", ""]],
		["a padded entry", [" rule-c "], [" rule-c "]],
	])(
		"old single-tier configs resolve as before: %s",
		(_name, disable, expected) => {
			// Old-record parse proof (#5232): the shapes configs already carry keep
			// the exact merged list they produced when the field was opaque.
			writeAt(repo, { rules: { k: { disable } } });

			const resolved = resolvePiLensConfig({
				cwd: repo,
				globalDir,
				globalConfigPath: path.join(globalDir, "config.json"),
				homeDir: tmpDir,
			}).value.rules as { k: { disable: string[] } };

			expect(resolved.k.disable).toEqual(expected);
		},
	);

	// Recurrence (#5250): `select` stayed an opaque leaf after #5237 typed
	// `disable`, so `select: ["ra", 5]` threw in the rule filter and drew no
	// notice. Both fields now draw the same one, in the same place.
	it.each(["disable", "select"] as const)(
		"%s: a non-string member and a non-array value draw PILENS_CFG_0005, siblings survive",
		(field) => {
			const notices: string[] = [];
			resetGlobalConfigWarnCache();
			resetDegradationLedger();
			wireUserNotifier(() => (message) => {
				notices.push(message);
			});
			writeGlobal({
				rules: { k: { [field]: ["ra", 5] }, j: { [field]: "rb" } },
			});

			const loaded = loadPiLensGlobalConfig(
				path.join(globalDir, "config.json"),
			);
			const resolution = resolvePiLensConfig({
				cwd: repo,
				globalDir,
				globalConfigPath: path.join(globalDir, "config.json"),
				homeDir: tmpDir,
			});

			expect(loaded).toBeDefined();
			expect(resolution.value.rules).toEqual({ k: { [field]: ["ra"] }, j: {} });
			expect(
				resolution.records
					.filter((record) => record.code === "PILENS_CFG_0005")
					.map((record) => record.key),
			).toEqual([`/rules/k/${field}/1`, `/rules/j/${field}`]);
			expect(
				notices.filter((m) => m.includes("[PILENS_CFG_0005]")).length,
			).toBeGreaterThan(0);
		},
	);

	// Recurrence (#5250, round 3): the resolver's policy map read `select` and
	// `disable` members as written. A blank `select` hid every rule, a padded
	// `select` hid the rule it named, and a padded `disable` disabled nothing.
	// Both tiers now read members the way the project parser does.
	const memberCases = [
		[
			"a blank select list hides nothing",
			{ k: { select: ["  "] } },
			{ ra: false, rb: false },
		],
		[
			"a padded select member keeps the rule it names",
			{ k: { select: [" ra "] } },
			{ ra: false, rb: true },
		],
		[
			"a padded disable member disables the rule it names",
			{ k: { disable: [" ra "] } },
			{ ra: true, rb: false },
		],
	] as const;
	it.each(
		(["global", "project"] as const).flatMap((tier) =>
			memberCases.map(
				([name, rules, verdicts]) => [tier, name, rules, verdicts] as const,
			),
		),
	)("%s tier: %s (#5250)", (tier, _name, rules, verdicts) => {
		if (tier === "global") writeGlobal({ rules });
		else writeAt(repo, { rules });
		const policy = policyAt(repo);
		expect({
			ra: evaluateRulePolicy("ra", policy).dropped,
			rb: evaluateRulePolicy("rb", policy).dropped,
		}).toEqual(verdicts);
	});

	it("a blank select list in a nearer file lifts the farther file's allowlist for its key", () => {
		writeGlobal({ rules: { k: { select: ["ra"] } } });
		writeAt(repo, { rules: { k: { select: ["  "] } } });
		const policy = policyAt(repo);
		expect(evaluateRulePolicy("ra", policy)).toEqual({ dropped: false });
		expect(evaluateRulePolicy("rb", policy)).toEqual({ dropped: false });
	});
});

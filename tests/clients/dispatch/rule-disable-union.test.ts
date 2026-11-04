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
 * over generated tier stacks in `rule-policy-merge-properties.test.ts` (#5250).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePiLensConfig } from "../../../clients/config-resolve.js";
import { rulePolicyMapFromResolution } from "../../../clients/dispatch/rule-policy.js";
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
});

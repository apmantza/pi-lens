import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toPosix } from "../../clients/path-utils.js";
import yaml from "../../clients/deps/js-yaml.js";
import { workflowFiles } from "../../scripts/check-action-pins.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

// #5275: Dependabot opened about 12 PRs every Monday because only the stryker
// pair shared a group. Each case names the regression it keeps out. The real
// file is parsed, never regexed.

type Group = {
	patterns?: string[];
	"exclude-patterns"?: string[];
	"dependency-type"?: string;
	"update-types"?: string[];
	"applies-to"?: string;
};
type Update = {
	"package-ecosystem": string;
	directory?: string;
	directories?: string[];
	ignore?: Array<{ "dependency-name": string; "update-types"?: string[] }>;
	groups?: Record<string, Group>;
};

const ROOT = resolve(import.meta.dirname, "../..");
const updates = (
	yaml.load(readFileSync(resolve(ROOT, ".github/dependabot.yml"), "utf8")) as {
		updates: Update[];
	}
).updates;
const ecosystem = (name: string) => {
	const entries = updates.filter((u) => u["package-ecosystem"] === name);
	expect(entries, `one ${name} entry`).toHaveLength(1);
	return entries[0];
};

// Dependabot directory of every composite action under .github/actions whose
// steps use a remote action. A `./` step is local and a `docker://` image has
// no tag for Dependabot to move, so neither counts. Any other `uses:` is a
// remote pin: the gate fails closed on a spelling it does not recognize.
async function pinningComposites(): Promise<string[]> {
	const dirs: string[] = [];
	for (const file of await workflowFiles(ROOT)) {
		const rel = toPosix(relative(ROOT, file));
		if (!rel.startsWith(".github/actions/") || !/\/action\.ya?ml$/.test(rel)) {
			continue;
		}
		const doc = yaml.load(readFileSync(file, "utf8")) as {
			runs?: { steps?: Array<{ uses?: unknown }> };
		};
		const remote = (doc.runs?.steps ?? []).some(
			(step) =>
				typeof step.uses === "string" &&
				!step.uses.startsWith("./") &&
				!step.uses.startsWith("docker://"),
		);
		if (remote) dirs.push(`/${toPosix(relative(ROOT, dirname(file)))}`);
	}
	return dirs.sort();
}

describe("#5275 dependabot grouping", () => {
	// Recurrence: #5183 and #5191 each bumped one of the two stryker packages to
	// 10.1.1 alone; the exact peer pin then failed `npm ci` with ERESOLVE. The
	// pair moves in one PR, majors included, and no later group may take it.
	it("keeps the stryker pair in one group that comes first and that no minor group can claim", () => {
		const groups = ecosystem("npm").groups ?? {};
		expect(Object.keys(groups)[0]).toBe("stryker");
		expect(groups.stryker.patterns).toEqual(["@stryker-mutator/*"]);
		expect(groups.stryker["update-types"]).toBeUndefined();
		expect(groups["dev-minor"]["exclude-patterns"]).toEqual([
			"@stryker-mutator/*",
		]);
	});

	// Recurrence: a group without `update-types` pulls majors into the weekly
	// batch, and a major bump needs its own review (#2714 kept one out by hand).
	it("groups only minor and patch bumps per dependency type", () => {
		const groups = ecosystem("npm").groups ?? {};
		expect(groups["dev-minor"]["dependency-type"]).toBe("development");
		expect(groups["prod-minor"]["dependency-type"]).toBe("production");
		for (const name of ["dev-minor", "prod-minor"]) {
			expect(groups[name]["update-types"], name).toEqual(["minor", "patch"]);
		}
	});

	it("groups every security update into one PR and leaves version updates alone", () => {
		const group = ecosystem("npm").groups?.security;
		expect(group?.["applies-to"]).toBe("security-updates");
		expect(group?.patterns).toEqual(["*"]);
	});

	// Recurrence: #2714, typescript-language-server 6 needs a newer Node than the
	// pi host guarantees; grouping must not drop the major ignore.
	it("keeps the typescript-language-server major ignore", () => {
		expect(ecosystem("npm").ignore).toEqual([
			{
				"dependency-name": "typescript-language-server",
				"update-types": ["version-update:semver-major"],
			},
		]);
	});

	// Recurrence: #4358, a bump that reached only ci.yml or only the composite
	// action's actions/cache pin split the SHA (tests/config/action-pin-split).
	// One entry with every pin directory and one `*` group bumps them together.
	// Recurrence: #5409 (Qodo r1), the fetch-verified composite pinned
	// actions/cache but was missing from `directories`, so a bump left it behind.
	// The expected list is derived from the tree, so a new composite cannot skip
	// it. `/` stays hard-coded: it is the directory of .github/workflows.
	it("bumps every action in one group across every composite that pins one", async () => {
		const entry = ecosystem("github-actions");
		const pinning = await pinningComposites();
		assertNonEmptyScan(
			"composite actions that pin a remote action",
			pinning.length,
		);
		const directories = entry.directories ?? [];
		expect(
			pinning.filter((dir) => !directories.includes(dir)),
			"composite actions that pin an action but are missing from the github-actions directories",
		).toEqual([]);
		expect([...directories].sort()).toEqual(["/", ...pinning].sort());
		expect(Object.keys(entry.groups ?? {})).toEqual(["actions"]);
		expect(entry.groups?.actions.patterns).toEqual(["*"]);
	});
});

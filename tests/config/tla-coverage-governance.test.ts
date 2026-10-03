import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	evaluateTlaCoverage,
	loadCoverageMap,
	matchGlob,
	parseChangedFiles,
	validateCoverageMap,
} from "../../scripts/lib/tla-coverage.mjs";
import {
	lintLocalPrBody,
	lintTlaCoverage,
} from "../../scripts/check-pr-body.mjs";

// #3802 rule 2: a PR that changes a mapped runtime file must move its model
// (a .tla/.cfg under the family) or say "TLA+ unaffected: <family> — <reason>".
// The recurrence this prevents is #3524/#3525's class: a lifecycle seam changed
// while its TLA+ model kept describing the old behaviour, so TLC stayed green
// and proved nothing about the new code. A row is ANY-OF (one listed family's
// model move or declaration satisfies it): PR #3864 r1 demanded every family,
// which reddened 81 of the last 200 merged PRs (40.5%), 17 of the 22 that did
// move a model. The map-drift half (#3864 F4) is the same #3279/#3283 class as
// an exact-count pin: a tree that grows a family the map never learns.
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const map = loadCoverageMap(REPO_ROOT);

const READ_GUARD_MAP = {
	families: ["read-guard"],
	map: { "clients/read-guard.ts": ["read-guard"] },
};

const TWO_FAMILY_MAP = {
	families: ["read-guard", "session-lifecycle", "file-locks"],
	map: { "clients/read-guard.ts": ["read-guard", "session-lifecycle"] },
};

const hubMap = (count: number) => {
	const families = ["alpha", "beta", "gamma", "delta", "epsilon"].slice(
		0,
		count,
	);
	return { families, map: { "clients/hub.ts": families } };
};

// A structurally valid PR body with no code citations and no test references,
// so the only error under test is the coverage rule.
const BASE_BODY = [
	"## Why",
	"The coverage rule keeps a model tied to the code it models.",
	"",
	"## Notes for the reviewer",
	"None.",
	"",
	"## Change outline",
	"- clients/read-guard.ts",
	"",
	"## Summary",
	"Extend the read guard.",
	"",
	"## Tests",
	"Targeted tests pass.",
	"",
	"## Blast radius",
	"clients/read-guard.ts.",
	"",
	"## Class sweep",
	"Swept the read-guard seam.",
	"",
	"## Observability",
	"No new failure path; no record added.",
].join("\n");

const READ_GUARD_DIFF = [
	"diff --git a/clients/read-guard.ts b/clients/read-guard.ts",
	"@@ -1,0 +1,1 @@",
	"+// touched",
].join("\n");

// The runtime post-image must match the diff's added lines (#3906 r3), so a
// synthetic diff supplies its own post-image instead of the real file.
const READ_GUARD_HEAD_FILES = new Map([
	["clients/read-guard.ts", "// touched"],
]);

function compareStrings(a: string, b: string) {
	return a < b ? -1 : a > b ? 1 : 0;
}

describe("TLA+ coverage map (#3802)", () => {
	it("names every listed family in at least one map row", () => {
		// Derived from the map, never pinned: a count pin reds every legitimate
		// map edit. The tree-to-map half (every formal/<dir> is listed) is the
		// validateCoverageMap case below, run against the real tree.
		const named = new Set(
			Object.values(map.map ?? {}).flatMap((value) =>
				Array.isArray(value) ? value : [],
			),
		);
		// A TLA lane that adds a family adds its map row in the same PR.
		expect((map.families ?? []).filter((family) => !named.has(family))).toEqual(
			[],
		);
	});

	it("matches every glob to a file and every family to a model", () => {
		expect(validateCoverageMap(map, REPO_ROOT)).toEqual([]);
	});

	describe("tree-to-map validation", () => {
		let root: string | undefined;
		afterEach(() => {
			if (root) fs.rmSync(root, { recursive: true, force: true });
			root = undefined;
		});

		function fixtureTree() {
			root = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-tla-coverage-tree-"),
			);
			fs.mkdirSync(path.join(root, "clients"));
			fs.writeFileSync(path.join(root, "clients", "a.ts"), "");
			fs.mkdirSync(path.join(root, "formal"));
			// A non-directory entry under formal/ is never a family.
			fs.writeFileSync(path.join(root, "formal", "coverage-map.json"), "{}");
			return root;
		}

		it("errors on a formal/<dir> the map does not list", () => {
			const tree = fixtureTree();
			for (const dir of ["fam-a", "fam-b"]) {
				fs.mkdirSync(path.join(tree, "formal", dir), { recursive: true });
				fs.writeFileSync(path.join(tree, "formal", dir, "Model.cfg"), "");
			}
			const errors = validateCoverageMap(
				{ families: ["fam-a"], map: { "clients/a.ts": ["fam-a"] } },
				tree,
			);
			expect(errors).toEqual([expect.stringContaining("formal/fam-b/")]);
		});

		it("accepts a tree whose every formal/<dir> is listed", () => {
			const tree = fixtureTree();
			fs.mkdirSync(path.join(tree, "formal", "fam-a"), { recursive: true });
			fs.writeFileSync(path.join(tree, "formal", "fam-a", "Model.cfg"), "");
			expect(
				validateCoverageMap(
					{ families: ["fam-a"], map: { "clients/a.ts": ["fam-a"] } },
					tree,
				),
			).toEqual([]);
		});
	});

	it("matches a nested ** glob to files under its directory", () => {
		expect(
			matchGlob(
				"clients/dispatch/runners/**",
				"clients/dispatch/runners/biome-check.ts",
			),
		).toBe(true);
		expect(
			matchGlob("clients/dispatch/runners/**", "clients/dispatch/runners"),
		).toBe(false);
	});

	it("keeps both sides of a rename as changed paths", () => {
		const diff =
			"diff --git a/clients/read-guard.ts b/clients/read-guard-branch.ts";
		expect(parseChangedFiles(diff).sort(compareStrings)).toEqual([
			"clients/read-guard-branch.ts",
			"clients/read-guard.ts",
		]);
	});
});

describe("TLA+ coverage rule", () => {
	it("errors on a mapped change with no model change and no body line", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("formal/read-guard/");
		expect(result.errors[0]).toContain("TLA+ unaffected: read-guard");
	});

	it("passes when a .cfg under the family changes", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/read-guard/Guarded.cfg"],
			body: "",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("passes when the PR body carries the unaffected line", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "TLA+ unaffected: read-guard — only a local helper moved.",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("does not accept an unaffected line with no reason", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "TLA+ unaffected: read-guard — ",
		});
		expect(result.errors).toHaveLength(1);
	});

	it("passes a multi-family row when any one family's model moved", () => {
		const result = evaluateTlaCoverage({
			map: TWO_FAMILY_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/read-guard/Guarded.cfg"],
			body: "",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("passes a multi-family row when any one family is declared unaffected", () => {
		const result = evaluateTlaCoverage({
			map: TWO_FAMILY_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "TLA+ unaffected: session-lifecycle — only a local helper moved.",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("names every family on an unmet multi-family row in one error", () => {
		const result = evaluateTlaCoverage({
			map: TWO_FAMILY_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("formal/read-guard/");
		expect(result.errors[0]).toContain("formal/session-lifecycle/");
	});

	it("does not let a model move or declaration for a family off the row satisfy it", () => {
		const result = evaluateTlaCoverage({
			map: TWO_FAMILY_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/file-locks/Locks.cfg"],
			body: "TLA+ unaffected: file-locks — unrelated.",
		});
		expect(result.errors).toHaveLength(1);
	});

	it("turns an unmet hub row (4+ families) into a note, not an error", () => {
		const result = evaluateTlaCoverage({
			map: hubMap(4),
			changedFiles: ["clients/hub.ts"],
			body: "",
		});
		expect(result.errors).toEqual([]);
		expect(result.advisories).toHaveLength(1);
		expect(result.advisories[0]).toContain("TLA+ note: clients/hub.ts");
	});

	it("keeps an unmet 3-family row an error (hub threshold boundary)", () => {
		const result = evaluateTlaCoverage({
			map: hubMap(3),
			changedFiles: ["clients/hub.ts"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
		expect(result.advisories).toEqual([]);
	});

	it("prints no note for a hub row whose model moved or is declared", () => {
		const moved = evaluateTlaCoverage({
			map: hubMap(5),
			changedFiles: ["clients/hub.ts", "formal/gamma/Model.tla"],
			body: "",
		});
		const declared = evaluateTlaCoverage({
			map: hubMap(5),
			changedFiles: ["clients/hub.ts"],
			body: "TLA+ unaffected: delta — a comment moved.",
		});
		expect(moved).toEqual({ errors: [], advisories: [] });
		expect(declared).toEqual({ errors: [], advisories: [] });
	});

	it("reports only the unknown family, not an unmet-row error, for a corrupt row", () => {
		const hub = evaluateTlaCoverage({
			map: {
				families: ["alpha"],
				map: { "clients/hub.ts": hubMap(4).families },
			},
			changedFiles: ["clients/hub.ts"],
			body: "",
		});
		expect(hub.errors).toHaveLength(3);
		expect(hub.errors.join(" ")).toContain("unknown family beta");
		expect(hub.advisories).toEqual([]);
		const pair = evaluateTlaCoverage({
			map: {
				families: ["alpha"],
				map: { "clients/hub.ts": ["alpha", "ghost"] },
			},
			changedFiles: ["clients/hub.ts"],
			body: "",
		});
		expect(pair.errors).toEqual([
			"coverage map row clients/hub.ts names unknown family ghost",
		]);
	});

	it("does not count a non-model file under the family directory", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/read-guard/README.md"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
	});

	it("does not let a family name match another family it prefixes", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "TLA+ unaffected: read-guard-foo — not this family.",
		});
		expect(result.errors).toHaveLength(1);
	});

	it.each([
		["a backtick fence", "```\nTLA+ unaffected: read-guard — hidden.\n```"],
		["a tilde fence", "~~~\nTLA+ unaffected: read-guard — hidden.\n~~~"],
		[
			"a fence the inner shorter marker does not close",
			"````\n```\nTLA+ unaffected: read-guard — hidden.\n```\n````",
		],
		["an HTML comment", "<!-- TLA+ unaffected: read-guard — hidden. -->"],
		[
			"a multi-line HTML comment",
			"<!--\nTLA+ unaffected: read-guard — hidden.\n-->",
		],
		["an unterminated HTML comment", "<!--\nTLA+ unaffected: read-guard — x"],
	])("does not accept a declaration inside %s", (_label, hidden) => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: hidden,
		});
		expect(result.errors).toHaveLength(1);
	});

	it("accepts a declaration that follows a closed fence and comment", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "```\ncode\n```\n<!-- note -->\n- TLA+ unaffected: read-guard — real reason.",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("reports unmodelled seams as advisories, never errors", () => {
		const result = evaluateTlaCoverage({
			map: { families: [], map: { "clients/lsp-mutation.ts": "unmodelled" } },
			changedFiles: ["clients/lsp-mutation.ts"],
			body: "",
		});
		expect(result.errors).toEqual([]);
		expect(result.advisories).toHaveLength(1);
		expect(result.advisories[0]).toContain("lsp-mutation.ts");
	});

	it("ignores an unmapped changed file", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/other.ts"],
			body: "",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});
});

describe("TLA+ coverage in the PR-body lint (#3802)", () => {
	it("fails a mapped runtime change with no model change and no body line", () => {
		const git = (args: string[]) =>
			args.includes("--name-only")
				? "clients/read-guard.ts\n"
				: READ_GUARD_DIFF;
		const result = lintLocalPrBody(BASE_BODY, REPO_ROOT, git as never, {
			headFiles: READ_GUARD_HEAD_FILES,
		});
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("formal/read-guard/");
	});

	it("passes the same diff when the body carries the unaffected line", () => {
		const git = (args: string[]) =>
			args.includes("--name-only")
				? "clients/read-guard.ts\n"
				: READ_GUARD_DIFF;
		const body = `${BASE_BODY}\n\nTLA+ unaffected: read-guard — only a local helper moved.\nTLA+ unaffected: session-lifecycle — the change does not touch session state.`;
		const result = lintLocalPrBody(body, REPO_ROOT, git as never, {
			headFiles: READ_GUARD_HEAD_FILES,
		});
		expect(result.valid).toBe(true);
	});
});

describe("lintTlaCoverage seam (#3802)", () => {
	// Recurrence: the Mutation diff of #3864 showed the empty-diff guard, the
	// map-unavailable error and the local advisory print survived neutering --
	// no test reached them, so a missing map or a dropped note passed silently.
	const missingRoot = path.join(os.tmpdir(), "pi-lens-tla-no-map-root");

	it("returns nothing for an empty diff, even with an unreadable map", () => {
		expect(lintTlaCoverage("", { diff: "", cwd: missingRoot })).toEqual({
			errors: [],
			advisories: [],
		});
		expect(lintTlaCoverage()).toEqual({ errors: [], advisories: [] });
	});

	it("reports an unreadable map as one lint error, never a pass", () => {
		expect(
			lintTlaCoverage("", { diff: READ_GUARD_DIFF, cwd: missingRoot }),
		).toEqual({
			errors: [
				expect.stringMatching(
					/^TLA\+ coverage map unavailable: cannot read formal\/coverage-map\.json: /,
				),
			],
			advisories: [],
		});
	});

	it("prints a hub-row note through the local lint without failing it", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const git = (args: string[]) =>
				args.includes("--name-only")
					? "index.ts\n"
					: [
							"diff --git a/index.ts b/index.ts",
							"@@ -1,0 +1,1 @@",
							"+// touched",
						].join("\n");
			lintLocalPrBody(BASE_BODY, REPO_ROOT, git as never);
			expect(warn.mock.calls.flat().join("\n")).toContain(
				"TLA+ note: index.ts",
			);
		} finally {
			warn.mockRestore();
		}
	});
});

// #3906 AC2: the #3799 delivery decision in clients/dispatch/dispatcher.ts is a
// lifecycle/delivery seam with no formal family, so the row is `unmodelled`
// with a real reason. The row gates the seam record rule; the TLA axis stays an
// advisory. The #3799 corpus that exercises the refusal is in
// tests/scripts/check-pr-body.test.ts.
describe("dispatcher seam row (#3906 AC2)", () => {
	it("maps clients/dispatch/dispatcher.ts as unmodelled with a real reason", () => {
		expect(map.map?.["clients/dispatch/dispatcher.ts"]).toBe("unmodelled");
		const reason = map.notes?.["clients/dispatch/dispatcher.ts"];
		expect(typeof reason).toBe("string");
		expect(reason?.length ?? 0).toBeGreaterThan(40);
		expect(reason).toContain("buildCoverageNotice");
		expect(reason).toMatch(/no formal family|unmodelled/i);
	});

	it("removes dispatch/dispatcher from the unlisted note but keeps its siblings", () => {
		const unlisted = String(map.notes?.unlisted ?? "");
		expect(unlisted).not.toContain("dispatch/dispatcher");
		expect(unlisted).toContain("dispatch/types");
		expect(unlisted).toContain("dispatch/utils/format-utils");
	});

	it("keeps the dispatcher advisory on the TLA axis", () => {
		const result = evaluateTlaCoverage({
			map,
			changedFiles: ["clients/dispatch/dispatcher.ts"],
			body: "",
		});
		expect(result.errors).toEqual([]);
		expect(result.advisories.join(" ")).toContain(
			"clients/dispatch/dispatcher.ts",
		);
	});
});

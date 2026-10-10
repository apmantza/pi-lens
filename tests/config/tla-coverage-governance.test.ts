import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	changedHookAnchors,
	evaluateTlaCoverage,
	findHookRanges,
	hookAnchorsFromRanges,
	loadCoverageMap,
	matchGlob,
	parseChangedFiles,
	validateCoverageMap,
} from "../../scripts/lib/tla-coverage.mjs";
import {
	lintLocalPrBody,
	lintTlaCoverage,
	parseRuntimeHunks,
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
	"Defect shape: a mapped runtime file changed without its model. Search: `rg -n read-guard formal`. Verdict: none outside this fixture.",
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
				Array.isArray(value)
					? value
					: typeof value === "object"
						? value.families
						: [],
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
					? "clients/lsp/client.ts\n"
					: [
							"diff --git a/clients/lsp/client.ts b/clients/lsp/client.ts",
							"@@ -1,0 +1,1 @@",
							"+// touched",
						].join("\n");
			lintLocalPrBody(BASE_BODY, REPO_ROOT, git as never);
			expect(warn.mock.calls.flat().join("\n")).toContain(
				"TLA+ note: clients/lsp/client.ts",
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

// #3803 F4 / #3878: index.ts holds every lifecycle hook handler, so its map row
// is judged per hook, from the handler a changed hunk lands in. `git diff
// --unified=0` (the lint's diff) carries no hook name for a hunk inside a
// handler, so the first version of this row matched the hook word in the
// changed line itself and fired for 0 of the last 25 index.ts commits while 19
// of them edited a handler; the hub note it replaced was silent for all 19.
const INDEX_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "index.ts"), "utf8");
const INDEX_ROW = map.map?.["index.ts"] as {
	families: string[];
	anchors: Record<string, string[]>;
};
const HOOKS = Object.keys(INDEX_ROW.anchors);

// A U0 diff that rewrites post-image line `line` of index.ts, as git prints it.
function indexLineDiff(source: string, line: number) {
	const text = source.split("\n")[line - 1];
	return [
		"diff --git a/index.ts b/index.ts",
		`@@ -${line} +${line} @@`,
		"-// old",
		`+${text}`,
	].join("\n");
}

function indexErrors(diff: string, source: string, body = "") {
	return lintTlaCoverage(body, {
		diff,
		headFiles: new Map([["index.ts", source]]),
	});
}

describe("index.ts hook anchors (#3878)", () => {
	// Recurrence: a hook list kept both in the map keys and in a regex drifted
	// (agent_end was in neither), and an anchor key the file never registers
	// would never fire. The registered hooks are read from the file.
	it("finds a handler range for every anchored hook and no other lifecycle hook", () => {
		const ranges = findHookRanges(INDEX_SOURCE);
		const lines = INDEX_SOURCE.split("\n");
		for (const hook of HOOKS) expect(ranges.has(hook), hook).toBe(true);
		expect([...ranges.keys()].sort()).toEqual(
			[...HOOKS, "resources_discover"].sort(),
		);
		// A range starts at the registration or at a named handler the
		// registration passes by identifier (`wrapSessionEventHandler("turn_end",
		// onTurnEnd, ...)`), never at anything else: an inline handler's body
		// arguments are not handlers.
		const starts = (hook: string) =>
			(ranges.get(hook) ?? []).map(([start]) =>
				lines[start - 1]
					.trim()
					.replace(/^(\(pi as any\)|pi)\.on\(.*/, "on")
					.replace(/^const (\w+) =.*/, "$1"),
			);
		expect(
			Object.fromEntries(HOOKS.map((hook) => [hook, starts(hook)])),
		).toEqual({
			session_start: ["on"],
			session_shutdown: ["on"],
			session_tree: ["on"],
			turn_start: ["on", "onTurnStart"],
			turn_end: ["on", "onTurnEnd"],
			agent_end: ["on", "onAgentEnd"],
			agent_settled: ["on", "onAgentSettled"],
			tool_call: ["on"],
			tool_result: ["on", "onToolResult"],
			tool_execution_end: ["on"],
			context: ["on"],
		});
	});

	it.each(HOOKS)(
		"fires %s for an edit to the first body line of its handler",
		(hook) => {
			const ranges = findHookRanges(INDEX_SOURCE).get(hook) ?? [];
			// The widest range is the handler body (or the inline handler).
			const [start, end] = [...ranges].sort(
				(a, b) => b[1] - b[0] - (a[1] - a[0]),
			)[0];
			const result = indexErrors(
				indexLineDiff(INDEX_SOURCE, Math.min(start + 2, end)),
				INDEX_SOURCE,
			);
			expect(result.errors).toHaveLength(1);
			for (const family of INDEX_ROW.anchors[hook])
				expect(result.errors[0], family).toContain(`formal/${family}/`);
			expect(result.advisories).toEqual([]);
		},
	);

	it("restores format-drain on index.ts through the agent_end anchor", () => {
		// Recurrence: the first anchor table dropped format-drain's index.ts link
		// (the old 7-family row named it) and had no agent_end anchor.
		expect(INDEX_ROW.anchors.agent_end).toContain("format-drain");
		const ranges = findHookRanges(INDEX_SOURCE).get("agent_end") ?? [];
		const body = ranges.find(([start, end]) => end - start > 5);
		expect(body).toBeDefined();
		const result = indexErrors(
			indexLineDiff(INDEX_SOURCE, (body as [number, number])[0] + 1),
			INDEX_SOURCE,
			"TLA+ unaffected: format-drain — the drain order is unchanged.",
		);
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("prints a note, not an error, for an edit outside every handler", () => {
		const lines = INDEX_SOURCE.split("\n");
		const importLine =
			lines.findIndex((line) => line.startsWith("import ")) + 1;
		const result = indexErrors(
			indexLineDiff(INDEX_SOURCE, importLine),
			INDEX_SOURCE,
		);
		expect(result.errors).toEqual([]);
		expect(result.advisories).toEqual([
			expect.stringContaining("index.ts changed outside its lifecycle hook"),
		]);
	});

	it("counts every hook as changed when the post-image cannot place the hunk", () => {
		// Direction chosen from the user-facing harm: a lint that cannot read the
		// image asks for one any-of declaration; silence would pass a handler edit.
		const drifted = INDEX_SOURCE.replace("import ", "import  ");
		const diff = indexLineDiff(INDEX_SOURCE, 1);
		const result = lintTlaCoverage("", {
			diff,
			headFiles: new Map([["index.ts", drifted]]),
		});
		expect(result.errors).toHaveLength(1);
		expect(result.advisories).toEqual([
			expect.stringContaining("could not be read against the diff"),
		]);
		const unreadable = lintTlaCoverage("", { diff, sourceCwd: "/nonexistent" });
		expect(unreadable.errors).toHaveLength(1);
		expect(
			changedHookAnchors(INDEX_SOURCE, parseRuntimeHunks(diff)[0], HOOKS),
		).not.toBeNull();
	});

	it("places a pure deletion by the post-image line it follows", () => {
		// Recurrence: under --unified=0 a deletion has no added line, so a matcher
		// that reads only added lines never sees a block removed from a handler.
		const turnEndRange = findHookRanges(INDEX_SOURCE)
			.get("turn_end")
			?.find(([from, to]) => to - from > 5);
		expect(turnEndRange).toBeDefined();
		const [start, end] = turnEndRange ?? [0, 0];
		const deletion = (after: number) =>
			[
				"diff --git a/index.ts b/index.ts",
				`@@ -${after + 1} +${after},0 @@`,
				"-// removed",
			].join("\n");
		const inside = indexErrors(deletion(start + 3), INDEX_SOURCE);
		expect(inside.errors).toEqual([
			expect.stringContaining("formal/late-aux-drain/"),
		]);
		const importLine = INDEX_SOURCE.split("\n").findIndex((line) =>
			line.startsWith("import "),
		);
		expect(indexErrors(deletion(importLine + 1), INDEX_SOURCE).errors).toEqual(
			[],
		);
		expect(end).toBeGreaterThan(start);
	});

	it("gates a diff that fires two hooks on the union of their families", () => {
		// Recurrence: a fired anchored row must never fall into the 4+ family hub
		// note; session_start + turn_end reach 5 families and still gate.
		const ranges = findHookRanges(INDEX_SOURCE);
		const bodyLine = (hook: string) => {
			const [start] = (ranges.get(hook) ?? []).find(
				([from, to]) => to - from > 5,
			) as [number, number];
			return start + 2;
		};
		const diff = [
			indexLineDiff(INDEX_SOURCE, bodyLine("session_start")),
			...indexLineDiff(INDEX_SOURCE, bodyLine("turn_end")).split("\n").slice(1),
		].join("\n");
		const result = indexErrors(diff, INDEX_SOURCE);
		expect(result.advisories).toEqual([]);
		expect(result.errors).toHaveLength(1);
		for (const family of [
			"session-registry",
			"late-aux-drain",
			"dispatch-pipeline",
		])
			expect(result.errors[0]).toContain(`formal/${family}/`);
	});

	describe("hunk placement", () => {
		const ranges = new Map([["turn_end", [[10, 20]]]]) as never;
		const hunk = (
			added: number[],
			deletedAfter: number[],
			removed: string[] = [],
		) => ({
			added: new Map(added.map((line) => [line, "x"])),
			deletedAfter: new Set(deletedAfter),
			removed,
		});
		const fires = (...args: Parameters<typeof hunk>) =>
			hookAnchorsFromRanges(ranges, hunk(...args), ["turn_end"]).length === 1;

		it("fires on an added line at either end and not one past it", () => {
			expect([9, 10, 20, 21].map((line) => fires([line], []))).toEqual([
				false,
				true,
				true,
				false,
			]);
		});

		it("fires on a deletion strictly inside the range only", () => {
			// A deletion after post line N sits between N and N+1.
			expect([9, 10, 19, 20].map((line) => fires([], [line]))).toEqual([
				false,
				true,
				true,
				false,
			]);
		});

		it("fires on a removed or added registration line", () => {
			expect(fires([], [3], ['\tpi.on("turn_end", wrap(onTurnEnd));'])).toBe(
				true,
			);
			expect(fires([], [3], ['\t\t"turn_end",'])).toBe(true);
			expect(
				fires([], [3], ['\tpi.on("turn_start", wrap(onTurnStart));']),
			).toBe(false);
		});
	});

	describe("replay of the last 25 index.ts commits", () => {
		const replay = JSON.parse(
			fs.readFileSync(
				path.join(
					REPO_ROOT,
					"tests/fixtures/tla-hook-anchors/index-ts-replay.json",
				),
				"utf8",
			),
		) as {
			commits: {
				sha: string;
				diff: string;
				ranges: Record<string, [number, number][]>;
				expected: string[];
			}[];
		};

		it("fires on the lifecycle-handler commits and notes the rest", () => {
			const hits = replay.commits.map((commit) =>
				hookAnchorsFromRanges(
					new Map(Object.entries(commit.ranges)),
					parseRuntimeHunks(commit.diff)[0],
					HOOKS,
				).sort(),
			);
			expect(replay.commits).toHaveLength(25);
			expect(hits).toEqual(replay.commits.map((commit) => commit.expected));
			// 0 of 25 on ff1b0ce1f (the word match), 19 here.
			expect(hits.filter((hook) => hook.length).length).toBe(19);
		});

		it("gates a real turn_end handler diff end to end, and a declaration clears it", () => {
			const commit = replay.commits.find((entry) =>
				entry.sha.startsWith("2e4848dd5"),
			);
			const source = fs.readFileSync(
				path.join(
					REPO_ROOT,
					"tests/fixtures/tla-hook-anchors/index-ts-2e4848dd5.txt",
				),
				"utf8",
			);
			const result = indexErrors(commit?.diff ?? "", source);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toContain("formal/late-aux-drain/");
			expect(result.errors[0]).not.toContain("formal/session-registry/");
			expect(
				indexErrors(
					commit?.diff ?? "",
					source,
					"TLA+ unaffected: late-aux-drain — the cadence is paced per session turn.",
				).errors,
			).toEqual([]);
			const git = (args: string[]) =>
				args.includes("--name-only") ? "index.ts\n" : (commit?.diff ?? "");
			const local = lintLocalPrBody(BASE_BODY, REPO_ROOT, git as never, {
				headFiles: new Map([["index.ts", source]]),
			});
			expect(local.errors.join(" ")).toContain("formal/late-aux-drain/");
		});
	});
});

describe("hub rows without anchors stay advisory (#3802 hub threshold)", () => {
	// Recurrence: dropping the 4-family threshold turned the hub rows of
	// runtime-tool-result (6 families), runtime-coordinator (4), lsp/index (6) and
	// lsp/client (5) from a note into a gate for every PR that touches them.
	const hubs = Object.entries(map.map ?? {}).filter(
		([, value]) => Array.isArray(value) && value.length >= 4,
	);

	it.each(hubs.map(([glob]) => [glob]))(
		"%s prints the hub note and never fails an empty body",
		(glob) => {
			const result = evaluateTlaCoverage({
				map,
				changedFiles: [glob],
				body: "",
			});
			expect(result.errors).toEqual([]);
			expect(result.advisories).toEqual([
				expect.stringContaining(`TLA+ note: ${glob} maps to`),
			]);
		},
	);
});

describe("validateCoverageMap anchors (#3878 F11)", () => {
	let root: string | undefined;
	afterEach(() => {
		if (root) fs.rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function anchoredTree() {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-tla-anchors-"));
		fs.writeFileSync(
			path.join(root, "host.ts"),
			'pi.on("turn_end", wrap(handler));\n',
		);
		for (const dir of ["fam-a", "fam-b"]) {
			fs.mkdirSync(path.join(root, "formal", dir), { recursive: true });
			fs.writeFileSync(path.join(root, "formal", dir, "M.cfg"), "");
		}
		return root;
	}

	const row = (anchors: Record<string, string[]>) => ({
		families: ["fam-a", "fam-b"],
		map: { "host.ts": { families: ["fam-a"], anchors } },
	});

	it("accepts anchors that name a registered hook and a subset of the row's families", () => {
		expect(
			validateCoverageMap(row({ turn_end: ["fam-a"] }), anchoredTree()),
		).toEqual([]);
	});

	it.each([
		[
			"a hook the file never registers",
			{ session_start: ["fam-a"] },
			"is not registered",
		],
		[
			"a family outside the row",
			{ turn_end: ["fam-b"] },
			"not in the row's families",
		],
		[
			"an empty family list",
			{ turn_end: [] },
			"needs a non-empty family array",
		],
		[
			"a key that is not a hook name",
			{ "turn-end": ["fam-a"] },
			"is not a hook name",
		],
	])("rejects %s", (_label, anchors, message) => {
		const errors = validateCoverageMap(
			{ ...row(anchors), families: ["fam-a", "fam-b"] },
			anchoredTree(),
		);
		expect(errors).toEqual([expect.stringContaining(message)]);
	});
});

describe("map file hygiene (#3803 F4 F7)", () => {
	// Recurrence: JSON.parse keeps the last of two equal keys, so `notes."index.ts"`
	// was written twice and the first note was dead text no test could see.
	it("has no duplicate key in the map or notes objects", () => {
		const raw = fs.readFileSync(
			path.join(REPO_ROOT, "formal/coverage-map.json"),
			"utf8",
		);
		const [head, notes] = raw.split(/^ {2}"notes": \{/m);
		const keys = (text: string) =>
			[...text.matchAll(/^ {4},?"([^"]+)": /gm)].map((match) => match[1]);
		for (const section of [head, notes]) {
			const found = keys(section);
			expect(found.length).toBeGreaterThan(10);
			expect(found.filter((key, at) => found.indexOf(key) !== at)).toEqual([]);
		}
	});
});

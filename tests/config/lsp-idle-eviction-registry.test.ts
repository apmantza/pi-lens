/**
 * #3622 recurrence guard: idle eviction used a hand-maintained key-prefix
 * spelling list, so a newly registered server could silently stay resident.
 * The registry now declares the policy and this checked table explains every
 * measured opt-in; unmeasured remains resident until evidence exists.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LSP_SERVERS } from "../../clients/lsp/server.js";

type IdleEviction = "transparent" | "resident" | "unmeasured";
type RegistryEntry = { id: string; idleEviction?: IdleEviction };

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const reasons = JSON.parse(
	readFileSync(
		path.join(repoRoot, "tests/config/lsp-idle-eviction-reasons.json"),
		"utf8",
	),
) as Record<string, string>;

/**
 * #3952 decision classes over the whole registry. A change to any row's
 * `idleEviction` has to move an id between these lists in the same PR, so the
 * excluded default (`unmeasured`, resident) and the held/unsupported population
 * cannot drift silently.
 */
const TRANSPARENT_IDS = [
	"typescript",
	"python",
	"marksman",
	"opengrep",
	"bash",
	"clojure",
	"cpp",
	"css",
	"deno",
	"fish",
	"html",
	"php",
	"prisma",
	"yaml",
] as const;
const NEXT_PHASE_ELIGIBLE_IDS = [
	"ast-grep",
	"cue",
	"docker",
	"docker-official",
	"gleam",
	"json",
	"lua",
	"python-jedi",
	"terraform",
	"tinymist",
	"toml",
	"typos",
	"zig",
	"zizmor",
] as const;
const HOLD_INDEXER_IDS = [
	"expert",
	"kotlin",
	"powershell",
	"rust",
	"svelte",
] as const;
const UNPROVEN_IDS = [
	"cmake",
	"lean",
	"shuck",
	"vue",
	"csharp",
	"dart",
	"elixir",
	"fsharp",
	"go",
	"haskell",
	"java",
	"nix",
	"ocaml",
	"ruby",
	"swift",
	"omnisharp",
] as const;

export function idleEvictionRegistryIssues(
	servers: readonly RegistryEntry[],
	reasonTable: Record<string, string>,
): string[] {
	const issues: string[] = [];
	const ids = new Set<string>();
	for (const server of servers) {
		ids.add(server.id);
		if (!server.idleEviction) {
			issues.push(`${server.id}: missing idleEviction declaration`);
			continue;
		}
		if (
			server.idleEviction !== "transparent" &&
			server.idleEviction !== "resident" &&
			server.idleEviction !== "unmeasured"
		) {
			issues.push(`${server.id}: invalid idleEviction value`);
		}
		if (
			server.idleEviction !== "unmeasured" &&
			(!reasonTable[server.id] || reasonTable[server.id].trim() === "")
		) {
			issues.push(`${server.id}: non-unmeasured policy lacks a reason`);
		}
	}
	for (const [id, reason] of Object.entries(reasonTable)) {
		if (!ids.has(id)) issues.push(`${id}: reason names an absent server`);
		if (reason.trim() === "") issues.push(`${id}: reason is empty`);
	}
	return issues;
}

describe("LSP idle-eviction registry (#3622)", () => {
	it("declares and explains every policy without orphan reasons", () => {
		expect(idleEvictionRegistryIssues(LSP_SERVERS, reasons)).toEqual([]);
		expect(LSP_SERVERS.length).toBeGreaterThan(40);
	});

	it("pins the 49-server registry by idle-eviction decision class (#3952, #3939)", () => {
		const declared = new Map(LSP_SERVERS.map((s) => [s.id, s.idleEviction]));
		const classified = [
			...TRANSPARENT_IDS,
			...NEXT_PHASE_ELIGIBLE_IDS,
			...HOLD_INDEXER_IDS,
			...UNPROVEN_IDS,
		];
		// No unclassified and no duplicate id: the classes partition the registry.
		expect([...classified].sort()).toEqual(LSP_SERVERS.map((s) => s.id).sort());
		expect(new Set(classified).size).toBe(classified.length);
		for (const id of TRANSPARENT_IDS) {
			expect(declared.get(id), `${id} is transparent`).toBe("transparent");
		}
		for (const id of [
			...NEXT_PHASE_ELIGIBLE_IDS,
			...HOLD_INDEXER_IDS,
			...UNPROVEN_IDS,
		]) {
			expect(declared.get(id), `${id} stays unmeasured`).toBe("unmeasured");
		}
	});

	it("keeps both missing-declaration and missing-reason boundaries red", () => {
		expect(
			idleEvictionRegistryIssues(
				[
					{ id: "new-server" },
					{ id: "measured-server", idleEviction: "transparent" },
				],
				{},
			),
		).toEqual([
			"new-server: missing idleEviction declaration",
			"measured-server: non-unmeasured policy lacks a reason",
		]);
	});

	it("keeps reason rows tied to registered ids", () => {
		expect(
			idleEvictionRegistryIssues(
				[{ id: "registered", idleEviction: "unmeasured" }],
				{ orphan: "stale reason" },
			),
		).toContain("orphan: reason names an absent server");
	});
});

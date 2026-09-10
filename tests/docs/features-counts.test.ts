/**
 * docs feature lists mirror live registries. A count alone cannot see a
 * same-count substitution (#2919): reinstating the removed `fish_indent` in
 * the docs formatter list, or swapping one member for a stale name, leaves a
 * count guard green. The guards below assert MEMBERSHIP against the source of
 * truth and report missing and extra members by name.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_FORMATTERS } from "../../clients/formatters.js";
import { LSP_SERVERS } from "../../clients/lsp/server.js";
import { TOOL_REGISTRY } from "../../clients/tool-config.js";
import { docsSectionLines } from "../support/docs-section.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const featuresMd = readFileSync(
	path.join(repoRoot, "docs/features.md"),
	"utf8",
);
const mcpMd = readFileSync(path.join(repoRoot, "docs/mcp.md"), "utf8");

/** The single number in a `**<n> ...**` claim, or undefined if the claim moved. */
function claimedCount(pattern: RegExp): number | undefined {
	const match = pattern.exec(featuresMd);
	return match ? Number(match[1]) : undefined;
}

/** First comma-separated prose line of a section: the member list. */
function commaListLine(lines: string[]): string {
	const line = lines.find(
		(l) =>
			l.includes(",") && !l.trimStart().startsWith("-") && !l.includes("**"),
	);
	if (line === undefined)
		throw new Error("docs member list line not found in section");
	return line;
}

/** Docs spell tool commands (`zig fmt`); the registry names tools (`zig`). */
function normalizeFormatterToken(token: string): string {
	return token.replace(/ (fmt|format)$/, "");
}

function diffByName(
	docs: readonly string[],
	registry: readonly string[],
): { missing: string[]; extra: string[] } {
	const docsSet = new Set(docs);
	const registrySet = new Set(registry);
	return {
		missing: [...registrySet].filter((n) => !docsSet.has(n)).sort(),
		extra: [...docsSet].filter((n) => !registrySet.has(n)).sort(),
	};
}

describe("docs/features.md counts match the registries", () => {
	it("quotes the real language-server count", () => {
		expect(claimedCount(/\*\*(\d+) language server definitions\*\*/)).toBe(
			LSP_SERVERS.length,
		);
	});

	it("quotes the real formatter count", () => {
		expect(claimedCount(/\*\*(\d+) formatters\*\*/)).toBe(
			ALL_FORMATTERS.length,
		);
	});
});

describe("docs/features.md formatter list matches ALL_FORMATTERS", () => {
	it("names every registry formatter and no stale member", () => {
		const raw = commaListLine(docsSectionLines(featuresMd, "### Formatters"));
		const docs = raw.split(",").map((t) => normalizeFormatterToken(t.trim()));
		const registry = ALL_FORMATTERS.map((f) => f.name);
		const { missing, extra } = diffByName(docs, registry);
		expect({ missing, extra }).toEqual({ missing: [], extra: [] });
	});
});

/**
 * Auxiliary scanners attach alongside the file's language server and are
 * listed separately in docs, so only primary ids are claimed here. Derived
 * from each entry's `role`, never a hand list (#2924 F5): renaming an
 * auxiliary id or flipping a role moves the expectation with the registry.
 */
const AUXILIARY_SERVER_IDS = new Set(
	LSP_SERVERS.filter((s) => s.role === "auxiliary").map((s) => s.id),
);

/**
 * Docs spelling overrides for the servers whose `docs/features.md` label is
 * not their registry id (#2924 F2). Every other non-auxiliary server is
 * claimed by its id, case-insensitively, so a new server whose docs label
 * equals its id needs no edit here; one whose label differs adds one
 * override entry. The necessity check in the test reds on a stale key, so a
 * removed or renamed server cannot leave a silent override behind.
 */
const DOCS_LABEL_OVERRIDES: Record<string, string> = {
	"python-jedi": "Python",
	csharp: "C#",
	omnisharp: "C#",
	fsharp: "F#",
	cpp: "C/C++",
	expert: "Elixir",
	marksman: "Markdown",
};

/** Docs label a registry id is claimed under: the override, else the id. */
function docsLabelForServerId(id: string): string {
	return DOCS_LABEL_OVERRIDES[id] ?? id;
}

describe("docs/features.md LSP list matches LSP_SERVERS", () => {
	it("covers every non-auxiliary server id", () => {
		const line = docsSectionLines(featuresMd, "### LSP Support").find((l) =>
			l.startsWith("LSP servers for:"),
		);
		if (line === undefined)
			throw new Error("docs LSP server list line not found");
		const labels = line
			.slice("LSP servers for:".length)
			.replace(/\.$/, "")
			.replace(/ \([^)]*\)/g, "")
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
		const serverIds = new Set(LSP_SERVERS.map((s) => s.id));
		for (const id of Object.keys(DOCS_LABEL_OVERRIDES)) {
			expect(serverIds.has(id), `stale docs-label override: ${id}`).toBe(true);
		}
		const labelToIds = new Map<string, string[]>();
		for (const s of LSP_SERVERS) {
			if (AUXILIARY_SERVER_IDS.has(s.id)) continue;
			const label = docsLabelForServerId(s.id).toLowerCase();
			labelToIds.set(label, [...(labelToIds.get(label) ?? []), s.id]);
		}
		const unknownLabels = labels
			.filter((l) => !labelToIds.has(l.toLowerCase()))
			.sort();
		const claimedIds = new Set(
			labels.flatMap((l) => labelToIds.get(l.toLowerCase()) ?? []),
		);
		const missingIds = LSP_SERVERS.map((s) => s.id)
			.filter((id) => !AUXILIARY_SERVER_IDS.has(id) && !claimedIds.has(id))
			.sort();
		const expectedLabels = new Set(labelToIds.keys());
		const docsLabels = new Set(labels.map((l) => l.toLowerCase()));
		const extraLabels = [...docsLabels]
			.filter((l) => !expectedLabels.has(l))
			.sort();
		expect({ unknownLabels, missingIds, extraLabels }).toEqual({
			unknownLabels: [],
			missingIds: [],
			extraLabels: [],
		});
	});
});

describe("docs/mcp.md tool table matches TOOL_REGISTRY", () => {
	it("tables every registered MCP tool", () => {
		const rows = docsSectionLines(mcpMd, "## MCP tool surface");
		const docs = rows.flatMap((l) => {
			const match = /^\|\s*`(pilens_[a-z_]+)`\s*\|/.exec(l);
			return match ? [match[1]] : [];
		});
		if (docs.length === 0)
			throw new Error("docs MCP tool table has no parseable rows");
		const registry = TOOL_REGISTRY.flatMap((e) =>
			e.mcpName === undefined ? [] : [e.mcpName],
		);
		const { missing, extra } = diffByName(docs, registry);
		expect({ missing, extra }).toEqual({ missing: [], extra: [] });
	});
});

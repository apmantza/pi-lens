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

/** Lines of one `### `/`## ` section, exclusive of the next heading. */
function sectionLines(md: string, heading: string): string[] {
	const start = md.indexOf(heading);
	if (start === -1) throw new Error(`docs heading not found: ${heading}`);
	const rest = md.slice(start + heading.length);
	const end = rest.search(/^#{1,6} /m);
	return (end === -1 ? rest : rest.slice(0, end)).split("\n");
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
		const raw = commaListLine(sectionLines(featuresMd, "### Formatters"));
		const docs = raw.split(",").map((t) => normalizeFormatterToken(t.trim()));
		const registry = ALL_FORMATTERS.map((f) => f.name);
		const { missing, extra } = diffByName(docs, registry);
		// Stale on master: #2917 round 2 corrects the docs list (drops
		// fish_indent, adds ktfmt and terragrunt-hcl). Remove this exemption
		// when #2917 merges; the necessity checks below fail once it is stale.
		const EXEMPT_MISSING = new Set(["ktfmt", "terragrunt-hcl"]);
		const EXEMPT_EXTRA = new Set(["fish_indent"]);
		const liveMissing = missing.filter((n) => !EXEMPT_MISSING.has(n));
		const liveExtra = extra.filter((n) => !EXEMPT_EXTRA.has(n));
		expect({ missing: liveMissing, extra: liveExtra }).toEqual({
			missing: [],
			extra: [],
		});
		for (const n of EXEMPT_MISSING) expect(missing).toContain(n);
		for (const n of EXEMPT_EXTRA) expect(extra).toContain(n);
	});
});

/** Auxiliary scanners are listed separately in docs; only primary ids here. */
const AUXILIARY_SERVER_IDS = new Set([
	"opengrep",
	"ast-grep",
	"zizmor",
	"typos",
]);

/** Docs language label (parenthetical stripped) to the server ids it claims. */
const DOCS_LANGUAGE_TO_SERVER_IDS: Record<string, readonly string[]> = {
	TypeScript: ["typescript"],
	Deno: ["deno"],
	Python: ["python", "python-jedi"],
	Go: ["go"],
	Rust: ["rust"],
	Ruby: ["ruby"],
	PHP: ["php"],
	"C#": ["csharp", "omnisharp"],
	"F#": ["fsharp"],
	Java: ["java"],
	Kotlin: ["kotlin"],
	Swift: ["swift"],
	Dart: ["dart"],
	Lua: ["lua"],
	"C/C++": ["cpp"],
	Zig: ["zig"],
	Haskell: ["haskell"],
	Elixir: ["elixir", "expert"],
	Gleam: ["gleam"],
	OCaml: ["ocaml"],
	Clojure: ["clojure"],
	CUE: ["cue"],
	Terraform: ["terraform"],
	Nix: ["nix"],
	Bash: ["bash"],
	Docker: ["docker"],
	YAML: ["yaml"],
	JSON: ["json"],
	HTML: ["html"],
	TOML: ["toml"],
	Prisma: ["prisma"],
	Vue: ["vue"],
	Svelte: ["svelte"],
	CSS: ["css"],
};

describe("docs/features.md LSP list matches LSP_SERVERS", () => {
	it.skip("covers every non-auxiliary server id (skipped: docs stale on master, #2917)", () => {
		const line = sectionLines(featuresMd, "### LSP Support").find((l) =>
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
		const unknownLabels = labels.filter(
			(l) => DOCS_LANGUAGE_TO_SERVER_IDS[l] === undefined,
		);
		const claimedIds = new Set(
			labels.flatMap((l) => DOCS_LANGUAGE_TO_SERVER_IDS[l] ?? []),
		);
		const danglingIds = [...claimedIds]
			.filter((id) => !serverIds.has(id))
			.sort();
		const missing = [...serverIds]
			.filter((id) => !AUXILIARY_SERVER_IDS.has(id) && !claimedIds.has(id))
			.sort();
		expect({ unknownLabels, danglingIds, missing }).toEqual({
			unknownLabels: [],
			danglingIds: [],
			missing: [],
		});
	});
});

describe("docs/mcp.md tool table matches TOOL_REGISTRY", () => {
	it.skip("tables every registered MCP tool (skipped: docs stale on master, #2917)", () => {
		const rows = sectionLines(mcpMd, "## MCP tool surface");
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

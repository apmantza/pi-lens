/**
 * Doc-drift regression suite for the skills directory (#1424).
 *
 * Each skill's SKILL.md and reference.md are prose read by an agent, not
 * type-checked source — they can drift from the real tool schemas, rule
 * catalogs, and repo layout silently (e.g. #1423's `filePath` vs `path`
 * param-name drift, #1422's missing `php` tree-sitter dir). This suite pins
 * four independent drift classes:
 *
 *   1. param-name check   — tool-call params/tables in skill docs vs the
 *                            real TypeBox schemas.
 *   2. path check          — path-shaped tokens in skill docs vs the repo
 *                            filesystem, with a "source checkout only"
 *                            annotation required for paths outside
 *                            package.json's published "files".
 *   3. list-vs-schema      — the two rule-writing skills' language lists
 *                            vs the corresponding rule-schema.json enums.
 *   4. claim tripwire       — `<!-- verified: ... -->` comments parse.
 *
 * Adapted to what's cleanly testable per-check; see individual comments.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createAstGrepOutlineTool } from "../../tools/ast-grep-outline.js";
import { createAstGrepReplaceTool } from "../../tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "../../tools/ast-grep-search.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");

function readSkillFiles(): Array<{ file: string; text: string }> {
	const out: Array<{ file: string; text: string }> = [];
	for (const dir of fs.readdirSync(SKILLS_DIR)) {
		const dirPath = path.join(SKILLS_DIR, dir);
		if (!fs.statSync(dirPath).isDirectory()) continue;
		for (const name of fs.readdirSync(dirPath)) {
			if (!name.endsWith(".md")) continue;
			const file = path.join(dirPath, name);
			out.push({ file, text: fs.readFileSync(file, "utf8") });
		}
	}
	return out;
}

function relPath(file: string): string {
	return path.relative(REPO_ROOT, file).replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Check 1: param-name / enum-value drift
// ---------------------------------------------------------------------------

/** Stub deps mirror the construction pattern used by tests/tools/*.test.ts. */
function schemaProps(tool: { parameters: unknown }): Set<string> {
	const properties = (
		tool.parameters as { properties: Record<string, unknown> }
	).properties;
	return new Set(Object.keys(properties));
}

const astGrepClientStub = {
	ensureAvailable: async () => true,
	search: async () => ({ matches: [] }),
	searchWithRule: async () => ({ matches: [], totalMatches: 0 }),
	validatePattern: async () => ({ valid: true }),
	validateRule: async () => ({ valid: true }),
	formatMatches: () => "",
	replace: async () => ({ matches: [] }),
	replaceWithRule: async () => ({
		matches: [],
		totalMatches: 0,
		applied: false,
	}),
	outline: async () => ({ output: [] }),
	dumpAst: async () => ({ output: 'program [1,1] - [1,2] "x"' }),
	// biome-ignore lint/suspicious/noExplicitAny: minimal cross-tool stub
} as any;

const REAL_TOOL_SCHEMAS: Record<string, Set<string>> = {
	ast_grep_search: schemaProps(createAstGrepSearchTool(astGrepClientStub)),
	ast_grep_replace: schemaProps(createAstGrepReplaceTool(astGrepClientStub)),
	ast_grep_outline: schemaProps(createAstGrepOutlineTool(astGrepClientStub)),
	lsp_navigation: schemaProps(createLspNavigationTool(() => true)),
	lens_diagnostics: schemaProps(
		createLensDiagnosticsTool(
			{ readCache: () => undefined } as any,
			() => "/proj",
		),
	),
};

/** Which real tool(s) each skill file documents params for. */
const FILE_TOOL_SCOPE: Record<string, string[]> = {
	"skills/pi-lens-ast-grep/SKILL.md": [
		"ast_grep_search",
		"ast_grep_replace",
		"ast_grep_outline",
	],
	"skills/pi-lens-lsp-navigation/SKILL.md": [
		"lsp_navigation",
		"lens_diagnostics",
	],
};

/** camelCase identifier, e.g. `insideKind`, `endCharacter`. */
const IDENT_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;

/**
 * ast-grep/tree-sitter RULE-DSL keys (YAML shape, not TOOL parameters) —
 * these legitimately appear in skill docs but aren't part of any tool's
 * `parameters` schema, so they're excluded from the param-name check.
 */
const RULE_DSL_ALLOWLIST = new Set([
	"pattern",
	"rule",
	"language",
	"severity",
	"message",
	"note",
	"kind",
	"has",
	"inside",
	"not",
	"any",
	"all",
	"follows",
	"precedes",
	"constraints",
	"regex",
	"id",
	"fix",
	"metadata",
	"stopBy",
	"field",
	"nthChild",
]);

/** Extracts candidate parameter-name tokens from Markdown tables whose header row mentions "parameter". */
function extractTableParamCandidates(text: string): string[] {
	const out: string[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const header = lines[i];
		if (!/^\s*\|/.test(header)) continue;
		if (!/parameter/i.test(header)) continue;
		// next non-separator row(s) until a non-table line
		const cols = header.split("|").map((c) => c.trim());
		const paramColIdx = cols.findIndex((c) => /parameter/i.test(c));
		if (paramColIdx === -1) continue;
		for (let j = i + 2; j < lines.length; j++) {
			const row = lines[j];
			if (!/^\s*\|/.test(row)) break;
			const cells = row.split("|").map((c) => c.trim());
			const cell = cells[paramColIdx];
			if (!cell) continue;
			// cell may list several comma-separated params, e.g. "path, line, character"
			for (const raw of cell.split(",")) {
				const token = raw
					.replace(/[`*]/g, "")
					.trim()
					.split(/[#\s(]/)[0];
				if (token && IDENT_RE.test(token)) out.push(token);
			}
		}
	}
	return out;
}

/**
 * Extracts `word=` tokens from fenced code blocks (tool-call examples).
 * Excludes `$VAR=`/`$$$ARGS=` metavariable-capture ECHOES shown in output
 * examples (e.g. "$VAR=x  $$$ARGS=a,b") — those are captured-value display,
 * not tool-call parameters.
 */
function extractCodeBlockParamCandidates(text: string): string[] {
	const out: string[] = [];
	const fenceRe = /```[\s\S]*?```/g;
	for (const m of text.matchAll(fenceRe)) {
		const block = m[0];
		for (const km of block.matchAll(/(?<!\$)\b([a-zA-Z][a-zA-Z0-9]*)=/g)) {
			out.push(km[1]);
		}
	}
	return out;
}

describe("skill doc param-name drift (#1423/#1424)", () => {
	const files = readSkillFiles().filter(
		(f) => relPath(f.file) in FILE_TOOL_SCOPE,
	);

	it("found the expected scoped skill files", () => {
		expect(files.map((f) => relPath(f.file)).sort()).toEqual(
			Object.keys(FILE_TOOL_SCOPE).sort(),
		);
	});

	for (const { file, text } of files) {
		const rel = relPath(file);
		const tools = FILE_TOOL_SCOPE[rel];
		const known = new Set<string>();
		for (const t of tools) {
			for (const p of REAL_TOOL_SCHEMAS[t]) known.add(p);
		}

		it(`${rel}: table param references exist on a documented tool's real schema`, () => {
			const candidates = extractTableParamCandidates(text);
			// Zero-extraction guard: a regex regression that extracts NOTHING
			// must fail loudly, not pass on an empty candidate list. Floors are
			// the current per-file counts minus headroom for legitimate doc
			// shrinkage; raise them if the docs grow.
			expect(candidates.length).toBeGreaterThanOrEqual(4);
			const unknown = candidates.filter(
				(c) => !known.has(c) && !RULE_DSL_ALLOWLIST.has(c),
			);
			expect(
				unknown,
				`stale/unknown param name(s) in ${rel}: ${unknown.join(", ")}. ` +
					`Known params for ${tools.join(", ")}: ${[...known].sort().join(", ")}`,
			).toEqual([]);
		});

		it(`${rel}: fenced-example param= references exist on a documented tool's real schema`, () => {
			const candidates = extractCodeBlockParamCandidates(text);
			// Same zero-extraction guard as the table check above.
			expect(candidates.length).toBeGreaterThanOrEqual(3);
			const unknown = candidates.filter(
				(c) => !known.has(c) && !RULE_DSL_ALLOWLIST.has(c),
			);
			expect(
				unknown,
				`stale/unknown param name(s) in ${rel}: ${unknown.join(", ")}. ` +
					`Known params for ${tools.join(", ")}: ${[...known].sort().join(", ")}`,
			).toEqual([]);
		});
	}

	// Red-first proof (manual, not a live test — kept as documentation of the
	// verification performed for this PR): planting `filePath="x"` inside a
	// fenced example in skills/pi-lens-ast-grep/SKILL.md and re-running this
	// suite produced a failure listing "filePath" as unknown, because neither
	// ast_grep_search nor ast_grep_replace's real schema has a `filePath`
	// param (they use `paths`). The plant was reverted before commit.
});

// ---------------------------------------------------------------------------
// Check 2: path-shaped token drift
// ---------------------------------------------------------------------------

const PACKAGE_JSON = JSON.parse(
	fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
) as { files: string[] };

/** Top-level dirs actually published to npm (per package.json "files"). */
const PUBLISHED_DIRS = new Set(
	PACKAGE_JSON.files
		.filter((f) => f.endsWith("/"))
		.map((f) => f.replace(/\/$/, "")),
);

const SOURCE_CHECKOUT_DIRS = new Set(["clients", "tests", "tools", "scripts"]);

const SOURCE_CHECKOUT_PHRASE_RE = /source checkout/i;

const PATH_TOKEN_RE =
	/\b(rules|docs|tests|clients|scripts|tools|config|grammars|dist)\/[A-Za-z0-9_./<>$-]+/g;

function stripTrailingPunctuation(token: string): string {
	return token.replace(/[.,)]+$/, "");
}

/** Truncates a path at the first placeholder-shaped segment (e.g. `<id>.yml`, `<lang>`). */
function truncateAtPlaceholder(token: string): string {
	const segments = token.split("/");
	const idx = segments.findIndex((s) => /[<>$]/.test(s));
	if (idx === -1) return token;
	return segments.slice(0, idx).join("/");
}

describe("skill doc path drift (#1424)", () => {
	const files = readSkillFiles();

	for (const { file, text } of files) {
		const rel = relPath(file);
		const matches = [...text.matchAll(PATH_TOKEN_RE)].map((m) => ({
			token: stripTrailingPunctuation(m[0]),
			index: m.index ?? 0,
		}));

		if (matches.length === 0) continue;

		it(`${rel}: referenced paths exist, and non-published dirs carry a source-checkout annotation`, () => {
			const problems: string[] = [];
			for (const { token, index } of matches) {
				const truncated = truncateAtPlaceholder(token);
				if (!truncated) continue;
				const topDir = truncated.split("/")[0];
				const abs = path.join(REPO_ROOT, truncated);
				if (!fs.existsSync(abs)) {
					problems.push(`${truncated} does not exist on disk`);
					continue;
				}
				if (SOURCE_CHECKOUT_DIRS.has(topDir) && !PUBLISHED_DIRS.has(topDir)) {
					// require the annotation within a generous window around the mention
					const windowStart = Math.max(0, index - 600);
					const windowEnd = Math.min(text.length, index + 600);
					const window = text.slice(windowStart, windowEnd);
					if (!SOURCE_CHECKOUT_PHRASE_RE.test(window)) {
						problems.push(
							`${truncated} references unpublished dir "${topDir}/" without a nearby "source checkout" qualifier`,
						);
					}
				}
			}
			expect(problems).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// Check 3: language list vs rule-schema.json enum
// ---------------------------------------------------------------------------

describe("rule-writing skill language lists vs rule-schema.json (#1424, pins the php-omission class)", () => {
	it("pi-lens-write-ast-grep-rule/SKILL.md language list matches ast-grep rule-schema.json exactly", () => {
		const skillText = fs.readFileSync(
			path.join(SKILLS_DIR, "pi-lens-write-ast-grep-rule/SKILL.md"),
			"utf8",
		);
		const listLine = skillText
			.split("\n")
			.find((l) => l.startsWith("`TypeScript`"));
		expect(
			listLine,
			"expected a backtick-delimited language list line",
		).toBeTruthy();
		const documented = new Set(
			[...(listLine ?? "").matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]),
		);

		const schema = JSON.parse(
			fs.readFileSync(
				path.join(REPO_ROOT, "rules/ast-grep-rules/rule-schema.json"),
				"utf8",
			),
		);
		const schemaLanguages: string[] = schema.properties?.language?.enum;
		expect(
			schemaLanguages,
			"could not locate the language enum in rule-schema.json — schema shape changed",
		).toBeTruthy();

		expect([...documented].sort()).toEqual([...schemaLanguages].sort());
	});

	it("pi-lens-write-tree-sitter-rule/SKILL.md language dir list matches active rules/tree-sitter-queries/ dirs, minus -disabled/nonexistent schema entries", () => {
		const skillText = fs.readFileSync(
			path.join(SKILLS_DIR, "pi-lens-write-tree-sitter-rule/SKILL.md"),
			"utf8",
		);
		const listLine = skillText
			.split("\n")
			.find((l) => l.includes("Language dir is"));
		expect(listLine, "expected the 'Language dir is' line").toBeTruthy();
		const documented = new Set(
			[...(listLine ?? "").matchAll(/`([a-z]+)`/g)].map((m) => m[1]),
		);

		const schema = JSON.parse(
			fs.readFileSync(
				path.join(REPO_ROOT, "rules/tree-sitter-queries/rule-schema.json"),
				"utf8",
			),
		);
		const schemaLanguages: string[] = schema.properties?.language?.enum;
		expect(
			schemaLanguages,
			"could not locate the language enum in rule-schema.json — schema shape changed",
		).toBeTruthy();

		const tsQueriesDir = path.join(REPO_ROOT, "rules/tree-sitter-queries");
		const activeDirs = new Set(
			fs
				.readdirSync(tsQueriesDir)
				.filter((d) => fs.statSync(path.join(tsQueriesDir, d)).isDirectory())
				.filter((d) => !d.endsWith("-disabled")),
		);

		// A schema language whose dir doesn't exist at all (active or
		// -disabled) is a schema-declared-but-unshipped language — not
		// something the SKILL.md dir list should claim either.
		const expected = schemaLanguages.filter((lang) => activeDirs.has(lang));

		expect([...documented].sort()).toEqual([...expected].sort());
	});
});

// ---------------------------------------------------------------------------
// Check 4: `<!-- verified: ... -->` claim-tripwire format
// ---------------------------------------------------------------------------

describe("verified-claim comment format (#1424)", () => {
	// The ref portion (file:line-range) may itself contain commas (multiple
	// ranges), so match greedily up to the LAST comma-separated field, which
	// must be a short SHA.
	const VERIFIED_RE = /<!--\s*verified:\s*(.+),\s*([0-9a-f]{7,40})\s*-->/;

	it("every `<!-- verified: ... -->` comment in skills/**/*.md parses as `<ref>, <shortSHA>`", () => {
		const files = readSkillFiles();
		const found: Array<{ file: string; raw: string }> = [];
		for (const { file, text } of files) {
			for (const m of text.matchAll(/<!--\s*verified:[^>]*-->/g)) {
				found.push({ file: relPath(file), raw: m[0] });
			}
		}

		// This PR's #657 rewrite must carry at least one such comment (item D4).
		expect(
			found.length,
			"expected at least one `<!-- verified: ... -->` comment (the #657 rewrite)",
		).toBeGreaterThan(0);

		const malformed = found.filter((f) => !VERIFIED_RE.test(f.raw));
		expect(
			malformed,
			`malformed verified-claim comment(s): ${JSON.stringify(malformed)}`,
		).toEqual([]);
	});

	// TODO(#1424 follow-up): age-based staleness flagging (e.g. warn when a
	// verified-claim SHA predates the current file's last N commits) is out
	// of scope here — this check only pins the comment FORMAT, not freshness.
});

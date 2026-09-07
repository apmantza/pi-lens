/**
 * Canonical language registry (#2424, Phase 0a of #2415).
 *
 * ONE host-neutral answer to "what language is this file", from which every
 * language-keyed subsystem projects its own vocabulary:
 *
 *   - `clients/lsp/language.ts`      LSP `languageId` (protocol spelling)
 *   - `clients/tree-sitter-shared.ts`  extension -> tree-sitter grammar
 *   - `clients/project-diagnostics/scanner.ts`  the same grammar map
 *   - `clients/read-expansion.ts`    the same grammar map
 *   - `clients/review-graph/builder.ts` + `clients/module-report.ts`
 *                                    FileKind -> grammar for symbol extraction
 *   - `clients/grammar-source.ts`    grammar -> wasm filename
 *
 * Before this file those were seven independently maintained tables, four of
 * them hand-copied from each other, disagreeing on `.tsx`, `.sh`, `.h`,
 * `.jsonc`, `.vue` and `.svelte` with nothing in CI able to see it.
 *
 * The rule for adding a column here: a per-consumer token belongs in an entry
 * only when the consumer's PROTOCOL demands a different spelling than the
 * canonical id — the LSP spec's `typescriptreact` / `shellscript` / `jsonc`,
 * or the tree-sitter grammar's own name (`tsx`, `bash`). Anything else is one
 * value on one entry.
 *
 * `FileKind` (file-kinds.ts) stays deliberately COARSE: `jsts` spans
 * typescript/tsx/javascript/jsx/vue/svelte and `cxx` spans c/cpp. Several
 * languages therefore map onto one kind, and `kind` here is the mapping, not a
 * synonym for the language id.
 */

import { type FileKind, SPECIAL_FILENAMES } from "./file-kinds.js";

/**
 * Every language pi-lens can name. PUBLIC API from #2424: adding an id without
 * a registry entry (or an extension owned by two entries) fails
 * `tests/clients/language-registry-drift.test.ts`.
 */
export type LanguageId =
	| "ada"
	| "astro"
	| "c"
	| "clojure"
	| "cmake"
	| "cobol"
	| "cpp"
	| "csharp"
	| "css"
	| "cue"
	| "dart"
	| "dockerfile"
	| "elixir"
	| "erlang"
	| "fish"
	| "fortran"
	| "fsharp"
	| "gleam"
	| "go"
	| "go-mod"
	| "graphql"
	| "haskell"
	| "helm"
	| "html"
	| "java"
	| "javascript"
	| "javascriptreact"
	| "json"
	| "jsonc"
	| "julia"
	| "kotlin"
	| "less"
	| "lua"
	| "markdown"
	| "nix"
	| "ocaml"
	| "pascal"
	| "perl"
	| "php"
	| "powershell"
	| "prisma"
	| "proto"
	| "python"
	| "r"
	| "ron"
	| "ruby"
	| "rust"
	| "sass"
	| "scala"
	| "scss"
	| "shell"
	| "sql"
	| "svelte"
	| "swift"
	| "systemverilog"
	| "terraform"
	| "terragrunt"
	| "toml"
	| "typescript"
	| "typescriptreact"
	| "typst"
	| "verilog"
	| "vhdl"
	| "vue"
	| "yaml"
	| "zig";

/**
 * The `LanguageId` inventory pinned as VALUES, and type-linked to the union in
 * BOTH directions so neither half can move alone (#2424 review, F1):
 *
 *  - `satisfies readonly LanguageId[]` rejects a pinned id that is not a
 *    union member;
 *  - {@link LANGUAGE_ID_PIN_IS_EXHAUSTIVE} rejects a union member that is not
 *    pinned;
 *  - `tests/clients/language-registry-drift.test.ts` asserts this list equals
 *    `LANGUAGES.map(e => e.id)`, so a pinned id with no registry ENTRY fails
 *    too.
 *
 * Together those make "add `| "brainfuck"` to the union and ship" impossible:
 * the union edit alone fails `npm run build`, and satisfying the compiler
 * forces the pin edit, which fails the drift test until an entry exists. Before
 * this, the pin lived only in the test file as an unlinked string array, so a
 * union member with no entry compiled clean and left all 22 drift tests green.
 */
export const PINNED_LANGUAGE_IDS = [
	"ada",
	"astro",
	"c",
	"clojure",
	"cmake",
	"cobol",
	"cpp",
	"csharp",
	"css",
	"cue",
	"dart",
	"dockerfile",
	"elixir",
	"erlang",
	"fish",
	"fortran",
	"fsharp",
	"gleam",
	"go",
	"go-mod",
	"graphql",
	"haskell",
	"helm",
	"html",
	"java",
	"javascript",
	"javascriptreact",
	"json",
	"jsonc",
	"julia",
	"kotlin",
	"less",
	"lua",
	"markdown",
	"nix",
	"ocaml",
	"pascal",
	"perl",
	"php",
	"powershell",
	"prisma",
	"proto",
	"python",
	"r",
	"ron",
	"ruby",
	"rust",
	"sass",
	"scala",
	"scss",
	"shell",
	"sql",
	"svelte",
	"swift",
	"systemverilog",
	"terraform",
	"terragrunt",
	"toml",
	"typescript",
	"typescriptreact",
	"typst",
	"verilog",
	"vhdl",
	"vue",
	"yaml",
	"zig",
] as const satisfies readonly LanguageId[];

/**
 * Compile-time exhaustiveness for the pin above. When every `LanguageId` is
 * pinned this type is `true` and the initializer type-checks; the moment a
 * union member is added without being pinned, the type collapses to the
 * literal message below and `true` stops being assignable to it, so
 * `npm run build` fails at THIS line with the reason spelled out.
 */
const LANGUAGE_ID_PIN_IS_EXHAUSTIVE: Exclude<
	LanguageId,
	(typeof PINNED_LANGUAGE_IDS)[number]
> extends never
	? true
	: "a LanguageId is missing from PINNED_LANGUAGE_IDS in clients/language-registry.ts" =
	true;
// Not exported: its only job is to fail `npm run build`. The `void` reference
// is what keeps oxlint's no-unused-vars (CI-gating via lint:js) and knip
// quiet without giving it a consumer; tsc's noUnusedLocals does not flag it.
void LANGUAGE_ID_PIN_IS_EXHAUSTIVE;

export interface LanguageEntry {
	/** Canonical, host-neutral language id. */
	readonly id: LanguageId;
	/** Coarse FileKind this language maps onto, when file-kinds.ts has one. */
	readonly kind?: FileKind;
	/** Lowercase, dot-prefixed extensions this language owns. */
	readonly extensions: readonly string[];
	/** Exact basenames (case-insensitive) this language owns. */
	readonly filenames?: readonly string[];
	/**
	 * LSP `languageId` when the protocol spells it differently from {@link id}
	 * (`shellscript`), or when the language has no LSP spelling at all (then
	 * omitted, and the extension gets no LSP id). Defaults to {@link id}.
	 */
	readonly lspId?: string;
	/** tree-sitter grammar name (the key `LANGUAGE_TO_GRAMMAR` uses). */
	readonly grammar?: string;
	/**
	 * Extensions whose files RESOLVE to {@link grammar} in the extension ->
	 * grammar maps. Defaults to {@link extensions}. A narrower list records
	 * extensions classified as this language whose grammar wiring does not
	 * exist today (the C++ module-interface / Objective-C tail, `.zsh`,
	 * `.zon`); an empty list, a grammar that ships as wasm but that no
	 * extension resolver routes to (json/yaml/html/toml/vue/cue).
	 */
	readonly grammarExtensions?: readonly string[];
	/**
	 * For a coarse kind owned by several languages, the entry whose grammar a
	 * KIND-keyed consumer falls back to when the extension itself has no
	 * grammar wiring (`cxx` -> cpp). Exactly one entry per kind may set it.
	 */
	readonly kindFallback?: boolean;
}

/** The registry. Sorted by id; one entry per language, one owner per extension. */
export const LANGUAGES: readonly LanguageEntry[] = [
	{ id: "ada", extensions: [".adb", ".ads"] },
	{ id: "astro", extensions: [".astro"] },
	{ id: "c", kind: "cxx", extensions: [".c", ".h"], grammar: "c" },
	{
		id: "clojure",
		kind: "clojure",
		extensions: [".clj", ".cljc", ".cljs", ".edn"],
	},
	{
		id: "cmake",
		kind: "cmake",
		extensions: [".cmake"],
		filenames: ["CMakeLists.txt"],
	},
	{ id: "cobol", extensions: [".cob", ".cbl"] },
	{
		id: "cpp",
		kind: "cxx",
		// The clang extension table (file-kinds.ts KIND_EXTENSIONS.cxx) minus the
		// C header/source pair, which the `c` entry owns.
		extensions: [
			".c++",
			".c++m",
			".cc",
			".cl",
			".clcpp",
			".cp",
			".cpp",
			".cppm",
			".cu",
			".cxx",
			".cxxm",
			".hh",
			".hip",
			".hpp",
			".hxx",
			".inl",
			".ipp",
			".ixx",
			".m",
			".mm",
			".tpp",
			".txx",
		],
		grammar: "cpp",
		// The module-interface (.c++m/.cppm/.cxxm/.ixx), Objective-C (.m/.mm),
		// OpenCL (.cl/.clcpp) and .cp tail is classified cxx but has never been
		// routed to the cpp grammar by extension; kind-keyed consumers still
		// reach cpp through `kindFallback`.
		grammarExtensions: [
			".c++",
			".cc",
			".cpp",
			".cu",
			".cxx",
			".hh",
			".hip",
			".hpp",
			".hxx",
			".inl",
			".ipp",
			".tpp",
			".txx",
		],
		kindFallback: true,
	},
	{ id: "csharp", kind: "csharp", extensions: [".cs"], grammar: "csharp" },
	{ id: "css", kind: "css", extensions: [".css"], grammar: "css" },
	{
		id: "cue",
		kind: "cue",
		extensions: [".cue"],
		grammar: "cue",
		// The cue grammar and its symbol queries ship, but no extension resolver
		// has ever routed `.cue` to them; kind-keyed consumers reach it anyway.
		grammarExtensions: [],
	},
	{ id: "dart", kind: "dart", extensions: [".dart"], grammar: "dart" },
	{
		id: "dockerfile",
		kind: "docker",
		extensions: [".dockerfile"],
		filenames: ["Dockerfile"],
	},
	{
		id: "elixir",
		kind: "elixir",
		extensions: [".ex", ".exs"],
		grammar: "elixir",
	},
	{ id: "erlang", extensions: [".erl", ".hrl"] },
	{ id: "fish", kind: "fish", extensions: [".fish"] },
	{ id: "fortran", extensions: [".f", ".f90", ".f95"] },
	{ id: "fsharp", kind: "fsharp", extensions: [".fs", ".fsi", ".fsx"] },
	{ id: "gleam", kind: "gleam", extensions: [".gleam"] },
	{ id: "go", kind: "go", extensions: [".go"], grammar: "go" },
	// go.mod / go.sum: the LSP id is plain `go`, but they are not Go source and
	// file-kinds.ts deliberately does not classify them.
	{ id: "go-mod", extensions: [".mod", ".sum"], lspId: "go" },
	{ id: "graphql", extensions: [".graphql", ".gql"] },
	{ id: "haskell", kind: "haskell", extensions: [".hs", ".lhs"] },
	{ id: "helm", kind: "helm-template", extensions: [".tpl"] },
	{
		id: "html",
		kind: "html",
		extensions: [".htm", ".html"],
		grammar: "html",
		grammarExtensions: [],
	},
	{ id: "java", kind: "java", extensions: [".java"], grammar: "java" },
	{
		id: "javascript",
		kind: "jsts",
		extensions: [".js", ".mjs", ".cjs"],
		grammar: "javascript",
	},
	// `.jsx` is JSX-flavoured JavaScript: its own LSP id, but the plain
	// javascript grammar (which parses JSX) rather than the tsx one.
	{
		id: "javascriptreact",
		kind: "jsts",
		extensions: [".jsx"],
		grammar: "javascript",
	},
	{
		id: "json",
		kind: "json",
		extensions: [".json", ".json5"],
		grammar: "json",
		grammarExtensions: [],
	},
	{ id: "jsonc", kind: "json", extensions: [".jsonc"] },
	{ id: "julia", extensions: [".jl"] },
	{
		id: "kotlin",
		kind: "kotlin",
		extensions: [".kt", ".kts"],
		grammar: "kotlin",
	},
	{ id: "less", kind: "css", extensions: [".less"] },
	{ id: "lua", kind: "lua", extensions: [".lua"], grammar: "lua" },
	{ id: "markdown", kind: "markdown", extensions: [".md", ".mdx"] },
	{ id: "nix", kind: "nix", extensions: [".nix"] },
	{
		id: "ocaml",
		kind: "ocaml",
		extensions: [".ml", ".mli"],
		grammar: "ocaml",
	},
	{ id: "pascal", extensions: [".pas", ".pp"] },
	{ id: "perl", extensions: [".pl", ".pm"] },
	{
		id: "php",
		kind: "php",
		extensions: [".php", ".phtml", ".php3", ".php4", ".php5"],
		grammar: "php",
	},
	{
		id: "powershell",
		kind: "powershell",
		extensions: [".ps1", ".psm1", ".psd1"],
	},
	{ id: "prisma", kind: "prisma", extensions: [".prisma"] },
	{ id: "proto", extensions: [".proto"] },
	{
		id: "python",
		kind: "python",
		extensions: [".py", ".pyi"],
		grammar: "python",
		// `.pyi` stubs are not routed to the grammar by extension today.
		grammarExtensions: [".py"],
	},
	{ id: "r", extensions: [".r"] },
	// Rusty Object Notation: served as `rust` by the LSP seam, not Rust source.
	{ id: "ron", extensions: [".ron"], lspId: "rust" },
	{
		id: "ruby",
		kind: "ruby",
		extensions: [".rb", ".rake", ".gemspec", ".ru"],
		grammar: "ruby",
		grammarExtensions: [".rb"],
	},
	{ id: "rust", kind: "rust", extensions: [".rs"], grammar: "rust" },
	{ id: "sass", kind: "css", extensions: [".sass"] },
	{ id: "scala", extensions: [".scala", ".sc"] },
	{ id: "scss", kind: "css", extensions: [".scss"] },
	{
		id: "shell",
		kind: "shell",
		extensions: [".sh", ".bash", ".zsh"],
		filenames: ["Makefile"],
		// The LSP spec spells it `shellscript`; the tree-sitter grammar is `bash`.
		lspId: "shellscript",
		grammar: "bash",
		grammarExtensions: [".sh", ".bash"],
	},
	{ id: "sql", kind: "sql", extensions: [".sql"] },
	{ id: "svelte", kind: "jsts", extensions: [".svelte"] },
	{ id: "swift", kind: "swift", extensions: [".swift"], grammar: "swift" },
	{ id: "systemverilog", extensions: [".sv"] },
	{ id: "terraform", kind: "terraform", extensions: [".tf", ".tfvars"] },
	{
		id: "terragrunt",
		kind: "terragrunt",
		extensions: [],
		filenames: ["terragrunt.hcl", "root.hcl"],
	},
	{
		id: "toml",
		kind: "toml",
		extensions: [".toml"],
		grammar: "toml",
		grammarExtensions: [],
	},
	{
		id: "typescript",
		kind: "jsts",
		extensions: [".ts", ".mts", ".cts"],
		grammar: "typescript",
	},
	// `.tsx` needs the tsx grammar (the typescript grammar ERRORs on JSX) and
	// the LSP spec's `typescriptreact` id.
	{
		id: "typescriptreact",
		kind: "jsts",
		extensions: [".tsx"],
		grammar: "tsx",
	},
	{ id: "typst", extensions: [".typ", ".typc"] },
	{ id: "verilog", extensions: [".v"] },
	{ id: "vhdl", extensions: [".vhd", ".vhdl"] },
	{
		id: "vue",
		kind: "jsts",
		extensions: [".vue"],
		grammar: "vue",
		// The vue grammar ships as wasm but no extension resolver routes to it;
		// the jsts fact providers deliberately skip .vue/.svelte (file-kinds.ts).
		grammarExtensions: [],
	},
	{
		id: "yaml",
		kind: "yaml",
		extensions: [".yaml", ".yml"],
		grammar: "yaml",
		grammarExtensions: [],
	},
	{
		id: "zig",
		kind: "zig",
		extensions: [".zig", ".zon"],
		grammar: "zig",
		grammarExtensions: [".zig"],
	},
];

/** The LSP `languageId` for an entry (the id itself unless the protocol differs). */
export function lspLanguageId(entry: LanguageEntry): string {
	return entry.lspId ?? entry.id;
}

/** Extensions of `entry` that resolve to its grammar. */
export function grammarExtensionsOf(entry: LanguageEntry): readonly string[] {
	if (!entry.grammar) return [];
	return entry.grammarExtensions ?? entry.extensions;
}

const BY_EXTENSION = new Map<string, LanguageEntry>();
const BY_FILENAME = new Map<string, LanguageEntry>();
for (const entry of LANGUAGES) {
	for (const extension of entry.extensions) {
		BY_EXTENSION.set(extension.toLowerCase(), entry);
	}
	for (const filename of entry.filenames ?? []) {
		BY_FILENAME.set(filename.toLowerCase(), entry);
	}
}

const BY_ID = new Map<string, LanguageEntry>(
	LANGUAGES.map((entry) => [entry.id, entry]),
);

/**
 * Every extension the registry gives the language with this canonical id, or
 * `[]` for an id it does not know. The id-keyed half of the vocabulary a
 * `lang:` filter accepts — see {@link GRAMMAR_TO_EXTENSIONS} for the other.
 */
export function extensionsForLanguage(id: string): readonly string[] {
	return BY_ID.get(id)?.extensions ?? [];
}

/**
 * tree-sitter / ast-grep GRAMMAR name -> every extension owned by a language
 * that uses that grammar (`javascript` collects both the `javascript` and
 * `javascriptreact` entries; `bash` collects `shell`'s).
 *
 * This is the inverse of {@link EXTENSION_TO_GRAMMAR} widened back to the
 * entry's full extension list rather than its `grammarExtensions` narrowing,
 * because the consumer is a FILTER ("is this file a `java` file?"), not a
 * parser routing decision: over-including an extension whose files carry no
 * symbols is invisible, while under-including one hides real hits.
 * `clients/lens-engine.ts`'s symbol_search `lang` filter projects this (#2424
 * review, S2).
 *
 * Order is the registry's own declaration order, deduped — the same order
 * {@link extensionsForLanguage} returns, so the two halves of
 * {@link extensionsForLanguageToken} answer alike. Deliberately NOT `.sort()`:
 * a locale-sensitive comparator over strings carrying `+` and `.` (`.c++` vs
 * `.cc`) would make a frozen table's contents depend on the host's ICU data.
 */
export const GRAMMAR_TO_EXTENSIONS: Readonly<
	Record<string, readonly string[]>
> = Object.freeze(
	(() => {
		const byGrammar = new Map<string, string[]>();
		for (const entry of LANGUAGES) {
			if (!entry.grammar) continue;
			const list = byGrammar.get(entry.grammar) ?? [];
			list.push(...entry.extensions);
			byGrammar.set(entry.grammar, list);
		}
		return Object.fromEntries(
			[...byGrammar].map(([grammar, extensions]) => [
				grammar,
				Object.freeze([...new Set(extensions)]),
			]),
		);
	})(),
);

/**
 * Extensions a caller-supplied language TOKEN selects, for consumers that take
 * a language name from an agent/tool argument rather than from a file path —
 * `symbol_search`'s `lang` filter today (#2424 review, S2).
 *
 * A token may be spelled either way round, because both vocabularies are in
 * live use: `ast_grep_search`'s `lang` enum uses the tree-sitter GRAMMAR names
 * (`bash`, `tsx`, `cpp`), while languages with no grammar are only nameable by
 * their canonical id (`haskell`, `nix`, `scala`). Grammar wins on a collision,
 * which is a no-op — `cpp`/`java`/`lua` name the same entry either way. An
 * unrecognized token selects nothing, so a filter on it returns no hits.
 */
export function extensionsForLanguageToken(token: string): readonly string[] {
	return GRAMMAR_TO_EXTENSIONS[token] ?? extensionsForLanguage(token);
}

function basenameOf(filePath: string): string {
	const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	return cut === -1 ? filePath : filePath.slice(cut + 1);
}

function extensionOf(filePath: string): string {
	const base = basenameOf(filePath);
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** The sole registry entry for a kind, or the kind's declared fallback entry. */
const BY_KIND = new Map<FileKind, LanguageEntry>();
{
	const owners = new Map<FileKind, LanguageEntry[]>();
	for (const entry of LANGUAGES) {
		if (!entry.kind) continue;
		const list = owners.get(entry.kind) ?? [];
		list.push(entry);
		owners.set(entry.kind, list);
	}
	for (const [kind, list] of owners) {
		const resolved =
			list.length === 1 ? list[0] : list.find((entry) => entry.kindFallback);
		if (resolved) BY_KIND.set(kind, resolved);
	}
}

/**
 * Resolve a file to its language entry, with the SAME precedence
 * `detectFileKind` uses: exact filename first, then extension, then
 * file-kinds.ts's basename PATTERNS (`Dockerfile.<suffix>`) mapped through the
 * kind they classify into. Returns undefined for a coarse kind owned by
 * several languages with no fallback (a `jsts` basename pattern), because there
 * is no single right answer to give.
 */
export function resolveLanguage(filePath: string): LanguageEntry | undefined {
	if (!filePath) return undefined;
	const base = basenameOf(filePath);
	const byName = BY_FILENAME.get(base.toLowerCase());
	if (byName) return byName;
	const byExtension = BY_EXTENSION.get(extensionOf(filePath));
	if (byExtension) return byExtension;
	for (const { pattern, kind } of SPECIAL_FILENAMES) {
		if (pattern.test(base)) return BY_KIND.get(kind);
	}
	return undefined;
}

/**
 * Extension -> LSP `languageId`, for every extension whose language has one.
 * `clients/lsp/language.ts` projects this.
 */
export const EXTENSION_TO_LSP_ID: Readonly<Record<string, string>> =
	Object.freeze(
		Object.fromEntries(
			LANGUAGES.flatMap((entry) =>
				entry.extensions.map(
					(extension) => [extension, lspLanguageId(entry)] as const,
				),
			),
		),
	);

/**
 * Extension -> tree-sitter grammar. The single ext->grammar authority:
 * `tree-sitter-shared.ts`, `project-diagnostics/scanner.ts` and
 * `read-expansion.ts` all project this one map.
 */
export const EXTENSION_TO_GRAMMAR: Readonly<Record<string, string>> =
	Object.freeze(
		Object.fromEntries(
			LANGUAGES.flatMap((entry) =>
				grammarExtensionsOf(entry).map(
					(extension) => [extension, entry.grammar as string] as const,
				),
			),
		),
	);

/**
 * FileKind -> tree-sitter grammar, for KIND-keyed consumers (review-graph,
 * module-report). A kind appears only when one language owns it, or when one
 * of its languages is the declared {@link LanguageEntry.kindFallback} — so the
 * extension-split `jsts` is deliberately absent and callers keep resolving it
 * by path.
 */
export const KIND_TO_GRAMMAR: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(
		[...BY_KIND.entries()]
			.filter(([, entry]) => Boolean(entry.grammar))
			.map(([kind, entry]) => [kind, entry.grammar as string] as const),
	),
);

/**
 * Directory-scan priority (#2434), folding `tools/lsp-diagnostics.ts`'s former
 * ad hoc `LANG_EXTENSIONS` table — the last one #2424 deliberately left out,
 * because its iteration ORDER decides which language a MIXED directory scans
 * as: `runDirectoryDiagnostics` walks this list of FAMILIES and, for each one,
 * unions every member id's {@link extensionsForLanguage} into ONE
 * `collectFiles` call — the first family with any matching file wins the
 * whole directory for that pass. Family order mirrors the old table's key
 * order exactly (`typescript`/`typescriptreact` before `javascript`/
 * `javascriptreact`, ..., `json`/`jsonc` before `yaml`, down to `prisma`
 * last).
 *
 * The old table sometimes bundled two now-distinct registry entries under one
 * key (`.ts` also matched `.tsx`; `.css` also matched `.scss`/`.less`)
 * because it predated the grammar split #2424 made explicit (`.tsx` needs the
 * `tsx` grammar, not `typescript`; `scss`/`less` are their own entries with
 * no grammar). Grouping each split into one FAMILY here — rather than listing
 * the ids flat and scanning them one at a time — is what keeps a directory
 * that mixes BOTH extensions of a split pair (e.g. `.ts` AND `.tsx` side by
 * side) behavior-preserving: every member's extensions feed the SAME
 * `collectFiles` call, so both sides are found in the one pass the old
 * bundled key made, not whichever id happens to be tried first (a flat
 * per-id loop broke this — #2458 fix-round F1). Every extension individually
 * stays reachable — no id here was dropped — and
 * `tests/clients/language-registry-drift.test.ts` pins each family against
 * the golden `tests/fixtures/lsp-diagnostics-lang-extensions.json` capture,
 * with every intentional widening (an id's registry extension set is a
 * strict superset of the old table's) enumerated there and in the
 * `.changelog/` entry, not left as a silent side effect.
 *
 * Reserved for #2416 (lsp namespace): this priority may become a config key
 * there. Not implemented as one here — no loader, no env var, no
 * `.pi-lens.json` field reads this array today.
 */
export const SCAN_LANGUAGE_PRIORITY: readonly (readonly LanguageId[])[] = [
	["typescript", "typescriptreact"],
	["javascript", "javascriptreact"],
	["python"],
	["rust"],
	["go"],
	["ruby"],
	["java"],
	["kotlin"],
	["swift"],
	["csharp"],
	["cpp"],
	["c"],
	["zig"],
	["haskell"],
	["elixir"],
	["gleam"],
	["terraform"],
	["nix"],
	["shell"],
	["php"],
	["lua"],
	["dart"],
	["vue"],
	["svelte"],
	["css", "scss", "less"],
	["html"],
	["json", "jsonc"],
	["yaml"],
	["toml"],
	["prisma"],
];

/**
 * Cross-subsystem drift guards for the canonical language registry (#2424).
 *
 * Seven extension-keyed tables used to answer "what language is this file",
 * four of them hand-copied from each other, and the only guard relating any two
 * was lsp-capable-seam-coverage's A<->B check. These are the guards for the
 * consolidated shape: every consumer is a projection of
 * clients/language-registry.ts, and a hand-edit at a consumer (or a registry
 * entry no consumer can reach) fails here.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildSnapshot,
	SNAPSHOT_PATH,
} from "../../scripts/gen-language-snapshot.mjs";
import {
	detectFileKind,
	getFileKindsForExtension,
	type FileKind,
	KIND_EXTENSIONS,
	SPECIAL_FILENAMES,
} from "../../clients/file-kinds.js";
import { LANGUAGE_TO_GRAMMAR } from "../../clients/grammar-source.js";
import {
	EXTENSION_TO_GRAMMAR,
	EXTENSION_TO_LSP_ID,
	extensionsForLanguage,
	extensionsForLanguageToken,
	GRAMMAR_TO_EXTENSIONS,
	grammarExtensionsOf,
	KIND_TO_GRAMMAR,
	type LanguageEntry,
	type LanguageId,
	LANGUAGES,
	lspLanguageId,
	PINNED_LANGUAGE_IDS,
	resolveLanguage,
	SCAN_LANGUAGE_PRIORITY,
} from "../../clients/language-registry.js";
import { symbolSearchFileMatchesLang } from "../../clients/lens-engine.js";
import { LANGUAGE_EXTENSIONS } from "../../clients/lsp/language.js";
import { getServersForFile } from "../../clients/lsp/server.js";
import { tsLangForFile } from "../../clients/module-report.js";
import { TREE_SITTER_EXT_TO_LANG } from "../../clients/project-diagnostics/scanner.js";
import { readExpansionLanguage } from "../../clients/read-expansion.js";
import { mapKindToTreeSitterLanguage } from "../../clients/review-graph/builder.js";
import { FORMATTER_POLICY_BY_EXTENSION } from "../../clients/tool-policy.js";
import { EXT_TO_LANG } from "../../clients/tree-sitter-shared.js";
import { getSymbolQueryLanguages } from "../../clients/tree-sitter-symbol-extractor.js";

/**
 * Extensions the registry owns that file-kinds.ts does NOT classify into a
 * FileKind. Every one is a recorded gap in A, not a registry invention: the
 * PHP alias extensions and the config/notation formats below reach the LSP and
 * tree-sitter seams but never became KIND_EXTENSIONS members. Pinned so a new
 * gap has to be argued for.
 */
const KIND_GAPS = [
	".adb",
	".ads",
	".astro",
	".cbl",
	".cob",
	".erl",
	".f",
	".f90",
	".f95",
	".gql",
	".graphql",
	".hrl",
	".jl",
	".mod",
	".pas",
	".php3",
	".php4",
	".php5",
	".phtml",
	".pl",
	".pm",
	".pp",
	".proto",
	".r",
	".ron",
	".sc",
	".scala",
	".sum",
	".sv",
	".typ",
	".typc",
	".v",
	".vhd",
	".vhdl",
];

/**
 * Extensions the formatter policy keys on that no language table has ever
 * classified: the Elixir template family and Arduino sketches. #2424 binds the
 * formatter table's VOCABULARY to the registry but reconciling the policy
 * itself is an explicit non-goal, so these are pinned rather than invented into
 * registry entries — a NEW unowned formatter extension still fails the guard.
 */
const FORMATTER_ONLY_EXTENSIONS = [".eex", ".heex", ".ino", ".leex"];

const sample = (extension: string) => `sample${extension}`;

const registryExtensions = LANGUAGES.flatMap((entry) => entry.extensions);

describe("language registry invariants", () => {
	it("pins the LanguageId inventory", () => {
		expect(LANGUAGES.map((entry) => entry.id).sort()).toEqual(
			[...PINNED_LANGUAGE_IDS].sort(),
		);
	});

	it("gives every extension exactly one owner", () => {
		const owners = new Map<string, string[]>();
		for (const entry of LANGUAGES) {
			for (const extension of entry.extensions) {
				owners.set(extension, [...(owners.get(extension) ?? []), entry.id]);
			}
		}
		const duplicated = [...owners.entries()].filter(
			([, ids]) => ids.length > 1,
		);
		expect(
			duplicated.map(([extension, ids]) => `${extension}: ${ids.join(", ")}`),
			"extension(s) claimed by more than one registry entry",
		).toEqual([]);
	});

	// #2424 review, S5: the sibling of the per-extension guard above. Exact
	// filenames resolve BEFORE extensions in `resolveLanguage`, so two entries
	// claiming one basename is the same silent-shadowing defect with a higher
	// blast radius — `BY_FILENAME` keeps whichever entry the LANGUAGES array
	// happens to visit last, and every consumer of that filename flips language
	// on an unrelated re-sort.
	it("gives every exact filename exactly one owner", () => {
		const owners = new Map<string, string[]>();
		for (const entry of LANGUAGES) {
			for (const filename of entry.filenames ?? []) {
				const key = filename.toLowerCase();
				owners.set(key, [...(owners.get(key) ?? []), entry.id]);
			}
		}
		const duplicated = [...owners.entries()].filter(
			([, ids]) => ids.length > 1,
		);
		expect(
			duplicated.map(([filename, ids]) => `${filename}: ${ids.join(", ")}`),
			"filename(s) claimed by more than one registry entry",
		).toEqual([]);
	});

	it("keeps every extension lowercase and dot-prefixed", () => {
		const malformed = registryExtensions.filter(
			(extension) =>
				!extension.startsWith(".") || extension !== extension.toLowerCase(),
		);
		expect(malformed).toEqual([]);
	});

	it("has no unreachable entry", () => {
		const unreachable = LANGUAGES.filter(
			(entry) =>
				entry.extensions.length === 0 && (entry.filenames ?? []).length === 0,
		);
		expect(
			unreachable.map((entry) => entry.id),
			"registry entr(ies) reachable from no extension and no filename",
		).toEqual([]);
	});

	it("keeps grammarExtensions a subset of the entry's extensions", () => {
		const stray = LANGUAGES.flatMap((entry) =>
			(entry.grammarExtensions ?? []).filter(
				(extension) => !entry.extensions.includes(extension),
			),
		);
		expect(stray).toEqual([]);
	});

	it("declares a grammar for every entry that wires extensions to one", () => {
		const missing = LANGUAGES.filter(
			(entry) => entry.grammarExtensions !== undefined && !entry.grammar,
		);
		expect(missing.map((entry) => entry.id)).toEqual([]);
	});

	it("marks kindFallback only where a kind has several owners", () => {
		const owners = new Map<FileKind, LanguageEntry[]>();
		for (const entry of LANGUAGES) {
			if (!entry.kind) continue;
			owners.set(entry.kind, [...(owners.get(entry.kind) ?? []), entry]);
		}
		const bogus = LANGUAGES.filter(
			(entry) =>
				entry.kindFallback &&
				(!entry.kind || (owners.get(entry.kind) ?? []).length < 2),
		);
		expect(bogus.map((entry) => entry.id)).toEqual([]);
		for (const [kind, list] of owners) {
			const fallbacks = list.filter((entry) => entry.kindFallback);
			expect(
				fallbacks.length,
				`kind ${kind} has ${fallbacks.length} kindFallback entries`,
			).toBeLessThan(2);
		}
	});

	it("resolves filenames before extensions", () => {
		expect(resolveLanguage("Makefile")?.id).toBe("shell");
		expect(resolveLanguage("CMakeLists.txt")?.id).toBe("cmake");
		expect(resolveLanguage("infra/terragrunt.hcl")?.id).toBe("terragrunt");
		// The basename PATTERNS in file-kinds.ts (Dockerfile.<suffix>) are the
		// last resort, mapped through the kind they classify into.
		expect(resolveLanguage("infra/Dockerfile.dev")?.id).toBe("dockerfile");
		expect(resolveLanguage("src/App.tsx")?.id).toBe("typescriptreact");
	});

	it("routes .cuh through every C++ production projection (#2986)", () => {
		// #2986 recurrence guard: NVIDIA/HIP header convention `.cuh` is absent
		// from clang's driver table, but must still reach clangd, cpp grammar, and
		// cxx consumers as the surrounding `.cu` and `.hip` files do.
		const file = "fixture/kernel.cuh";
		const language = resolveLanguage(file);
		expect(language?.id).toBe("cpp");
		expect(language?.lspId ?? language?.id).toBe("cpp");
		expect(EXTENSION_TO_GRAMMAR[".cuh"]).toBe("cpp");
		expect(getFileKindsForExtension(".cuh")).toEqual(["cxx"]);
		expect(getServersForFile(file).map((server) => server.id)).toContain("cpp");
	});

	it("agrees with detectFileKind on every extension it owns", () => {
		const conflicts: string[] = [];
		const gaps: string[] = [];
		for (const entry of LANGUAGES) {
			for (const extension of entry.extensions) {
				const kind = detectFileKind(sample(extension));
				if (kind === undefined) {
					gaps.push(extension);
				} else if (kind !== entry.kind) {
					conflicts.push(`${extension}: registry ${entry.kind}, A ${kind}`);
				}
			}
		}
		expect(conflicts, "registry/FileKind disagreement").toEqual([]);
		expect(gaps.sort(), "unrecorded FileKind gap").toEqual(
			[...KIND_GAPS].sort(),
		);
	});

	it("owns every KIND_EXTENSIONS extension exactly once, with the same kind", () => {
		const missing: string[] = [];
		const mismatched: string[] = [];
		for (const [kind, extensions] of Object.entries(KIND_EXTENSIONS)) {
			for (const extension of extensions) {
				const owners = LANGUAGES.filter((entry) =>
					entry.extensions.includes(extension),
				);
				if (owners.length !== 1) {
					missing.push(`${extension} (${owners.length} owners)`);
					continue;
				}
				if (owners[0].kind !== kind) {
					mismatched.push(`${extension}: ${owners[0].kind} != ${kind}`);
				}
			}
		}
		expect(
			missing,
			"KIND_EXTENSIONS extension(s) without one registry owner",
		).toEqual([]);
		expect(mismatched).toEqual([]);
	});

	it("covers every SPECIAL_FILENAMES kind", () => {
		const unresolved = SPECIAL_FILENAMES.filter(
			({ kind }) => !LANGUAGES.some((entry) => entry.kind === kind),
		);
		expect(unresolved.map(({ pattern }) => pattern.source)).toEqual([]);
	});
});

describe("language registry <-> grammar manifest", () => {
	it("names only grammars that ship as wasm", () => {
		const unknown = LANGUAGES.filter(
			(entry) => entry.grammar && !(entry.grammar in LANGUAGE_TO_GRAMMAR),
		);
		expect(
			unknown.map((entry) => `${entry.id} -> ${entry.grammar}`),
			"registry grammar(s) with no LANGUAGE_TO_GRAMMAR entry",
		).toEqual([]);
	});

	it("reaches every LANGUAGE_TO_GRAMMAR key from some registry entry", () => {
		const reachable = new Set(
			LANGUAGES.map((entry) => entry.grammar).filter(Boolean),
		);
		const orphaned = Object.keys(LANGUAGE_TO_GRAMMAR).filter(
			(grammar) => !reachable.has(grammar),
		);
		expect(
			orphaned,
			"grammar wasm(s) no registry entry can reach (tsx/bash/vue were exactly this before #2424)",
		).toEqual([]);
	});
});

describe("consumer projections track the registry", () => {
	it("projects LSP language ids (clients/lsp/language.ts)", () => {
		expect(LANGUAGE_EXTENSIONS).toEqual({ ...EXTENSION_TO_LSP_ID });
		for (const entry of LANGUAGES) {
			for (const extension of entry.extensions) {
				expect(LANGUAGE_EXTENSIONS[extension], `LSP id for ${extension}`).toBe(
					lspLanguageId(entry),
				);
			}
		}
	});

	it("projects the ext -> grammar map (clients/tree-sitter-shared.ts)", () => {
		expect(EXT_TO_LANG).toEqual({ ...EXTENSION_TO_GRAMMAR });
		for (const entry of LANGUAGES) {
			for (const extension of grammarExtensionsOf(entry)) {
				expect(EXT_TO_LANG[extension], `grammar for ${extension}`).toBe(
					entry.grammar,
				);
			}
		}
	});

	it("projects the project scanner's map (project-diagnostics/scanner.ts)", () => {
		expect(TREE_SITTER_EXT_TO_LANG).toEqual({ ...EXTENSION_TO_GRAMMAR });
	});

	it("projects read expansion's map (clients/read-expansion.ts)", () => {
		for (const extension of Object.keys(EXTENSION_TO_GRAMMAR)) {
			expect(
				readExpansionLanguage(sample(extension)),
				`read expansion grammar for ${extension}`,
			).toBe(EXTENSION_TO_GRAMMAR[extension]);
		}
	});

	it("projects the kind -> grammar answer (review-graph + module-report)", () => {
		const symbolGrammars = new Set(getSymbolQueryLanguages());
		for (const extension of registryExtensions) {
			const path = sample(extension);
			const kind = detectFileKind(path);
			const expected =
				kind && KIND_TO_GRAMMAR[kind]
					? (EXTENSION_TO_GRAMMAR[extension] ?? KIND_TO_GRAMMAR[kind])
					: undefined;
			const wanted =
				expected && symbolGrammars.has(expected) ? expected : undefined;
			expect(
				mapKindToTreeSitterLanguage(kind, path),
				`review-graph grammar for ${extension}`,
			).toBe(wanted);
			// module-report answers identically for every kind but jsts, which it
			// resolves by path with a typescript default.
			if (kind !== "jsts") {
				expect(
					tsLangForFile(path, kind),
					`module-report grammar for ${extension}`,
				).toBe(wanted);
			}
		}
	});

	it("splits cxx headers the way both kind-keyed consumers used to inline", () => {
		expect(mapKindToTreeSitterLanguage("cxx", "src/main.c")).toBe("c");
		expect(mapKindToTreeSitterLanguage("cxx", "src/main.h")).toBe("c");
		expect(mapKindToTreeSitterLanguage("cxx", "src/main.cpp")).toBe("cpp");
		// The module-interface / Objective-C tail has no extension wiring and
		// falls back to the kind's declared grammar.
		expect(mapKindToTreeSitterLanguage("cxx", "src/view.mm")).toBe("cpp");
		expect(tsLangForFile("src/main.h", "cxx")).toBe("c");
		expect(tsLangForFile("src/view.mm", "cxx")).toBe("cpp");
	});

	it("keeps jsts resolving by path, never by kind", () => {
		expect(KIND_TO_GRAMMAR.jsts).toBeUndefined();
		expect(mapKindToTreeSitterLanguage("jsts", "src/App.tsx")).toBeUndefined();
		expect(tsLangForFile("src/App.tsx", "jsts")).toBe("tsx");
		expect(tsLangForFile("src/main.js", "jsts")).toBe("javascript");
		expect(tsLangForFile("src/App.vue", "jsts")).toBe("typescript");
	});

	// #2424 review, S2. `clients/lens-engine.ts` carried a NINTH hand-written
	// language -> extensions table for symbol_search's `lang` filter, keyed by
	// the ast_grep_search token vocabulary (tools/shared.ts's LANGUAGES) and
	// drifted from the registry in five places. It is now a projection via
	// `extensionsForLanguageToken`; these are that projection's guards.
	describe("symbol_search lang filter (clients/lens-engine.ts)", () => {
		// The token vocabulary symbol_search documents, mirrored (not imported —
		// clients/ never reaches into tools/). Every one must still select a
		// non-empty extension set, so folding the table cannot silently make a
		// documented `lang` value inert.
		const AST_GREP_LANG_TOKENS = [
			"bash",
			"c",
			"cpp",
			"csharp",
			"css",
			"elixir",
			"go",
			"haskell",
			"html",
			"java",
			"javascript",
			"json",
			"kotlin",
			"lua",
			"nix",
			"php",
			"python",
			"ruby",
			"rust",
			"scala",
			"swift",
			"tsx",
			"typescript",
			"yaml",
		];

		it("resolves every documented lang token to a non-empty extension set", () => {
			const inert = AST_GREP_LANG_TOKENS.filter(
				(token) => extensionsForLanguageToken(token).length === 0,
			);
			expect(
				inert,
				"lang token(s) that select no file at all after the registry fold",
			).toEqual([]);
		});

		it("resolves a token by grammar name first, then by canonical id", () => {
			// Grammar-spelled tokens (how ast_grep_search names them).
			expect(extensionsForLanguageToken("bash")).toEqual(
				GRAMMAR_TO_EXTENSIONS.bash,
			);
			expect(extensionsForLanguageToken("tsx")).toEqual([".tsx"]);
			// Id-spelled tokens for languages with no grammar at all.
			expect(extensionsForLanguageToken("haskell")).toEqual(
				extensionsForLanguage("haskell"),
			);
			// Both halves answer in the registry's declaration order, deduped —
			// never re-sorted, so no locale can reorder a frozen table.
			expect(extensionsForLanguageToken("scala")).toEqual([".scala", ".sc"]);
			// An unknown token selects nothing rather than everything.
			expect(extensionsForLanguageToken("solidity")).toEqual([]);
			expect(extensionsForLanguageToken("brainfuck")).toEqual([]);
		});

		it("groups every entry sharing a grammar under that grammar", () => {
			for (const [grammar, extensions] of Object.entries(
				GRAMMAR_TO_EXTENSIONS,
			)) {
				const expected = new Set(
					LANGUAGES.filter((entry) => entry.grammar === grammar).flatMap(
						(entry) => entry.extensions,
					),
				);
				expect(
					new Set(extensions),
					`extensions for grammar ${grammar}`,
				).toEqual(expected);
			}
			// `javascript` is the grouping case: two entries (javascript and
			// javascriptreact) share one grammar.
			expect(GRAMMAR_TO_EXTENSIONS.javascript).toContain(".jsx");
			expect(GRAMMAR_TO_EXTENSIONS.javascript).toContain(".mjs");
		});

		/**
		 * The five reconciled rows, pinned as old -> new so the decision is a
		 * review artifact and not an accident of the fold. Every narrowing is a
		 * language with no `SYMBOL_QUERIES` entry, so no real hit can be hidden:
		 * scss/less/jsonc files never parse under the css/json grammars and
		 * neither css nor json has symbol queries at all.
		 */
		/**
		 * The same reconciled rows asserted THROUGH lens-engine's own filter, so
		 * the guard covers the seam and not only the registry projection behind
		 * it. Red on the pre-fold head, where the local table answered:
		 * `.php3`/`.ru` false, `.scss`/`.jsonc`/`.sol` true.
		 */
		it("applies the reconciled decisions at the lens-engine seam", () => {
			expect(symbolSearchFileMatchesLang("src/Legacy.php3", "php")).toBe(true);
			expect(symbolSearchFileMatchesLang("config.ru", "ruby")).toBe(true);
			expect(symbolSearchFileMatchesLang("styles/app.scss", "css")).toBe(false);
			expect(symbolSearchFileMatchesLang("cfg/tsconfig.jsonc", "json")).toBe(
				false,
			);
			expect(
				symbolSearchFileMatchesLang("contracts/Token.sol", "solidity"),
			).toBe(false);
			// Unchanged rows still match.
			expect(symbolSearchFileMatchesLang("src/App.tsx", "tsx")).toBe(true);
			expect(symbolSearchFileMatchesLang("scripts/run.sh", "bash")).toBe(true);
			expect(symbolSearchFileMatchesLang("src/main.ts", "typescript")).toBe(
				true,
			);
			expect(symbolSearchFileMatchesLang("src/main.ts", "python")).toBe(false);
		});

		it("pins the reconciled lang -> extension decisions", () => {
			// Narrowed: .scss/.less are their own registry entries with no grammar.
			expect(extensionsForLanguageToken("css")).toEqual([".css"]);
			// Narrowed: .jsonc is its own entry with no grammar.
			expect(extensionsForLanguageToken("json")).toEqual([".json", ".json5"]);
			// Widened: the registry owns php's four alias extensions.
			expect(extensionsForLanguageToken("php")).toEqual([
				".php",
				".phtml",
				".php3",
				".php4",
				".php5",
			]);
			// Widened: the registry owns .ru (Rack config).
			expect(extensionsForLanguageToken("ruby")).toContain(".ru");
			// Widened: shell's .zsh, and the full cxx extension set for cpp.
			expect(extensionsForLanguageToken("bash")).toContain(".zsh");
			expect(extensionsForLanguageToken("cpp")).toContain(".ixx");
			// Dropped: no registry entry, no wasm grammar, no napi binding, no
			// symbol queries — a .sol file can never carry an indexed symbol.
			expect(LANGUAGES.some((entry) => entry.extensions.includes(".sol"))).toBe(
				false,
			);
		});
	});

	it("keeps the formatter policy table inside the registry's vocabulary", () => {
		const unknown = [...FORMATTER_POLICY_BY_EXTENSION.keys()].filter(
			(extension) => !resolveLanguage(sample(extension)),
		);
		expect(
			unknown.sort(),
			"formatter policy extension(s) no registry entry owns (#2424 non-goal: the policy VALUES stay in tool-policy.ts, only the vocabulary is bound)",
		).toEqual([...FORMATTER_ONLY_EXTENSIONS].sort());
	});
});

describe("language-identity golden snapshot", () => {
	// The fixture is the before/after table #2424 reconciled against: every
	// consumer's answer for every extension in the union of the old tables.
	// Regenerate with `node scripts/gen-language-snapshot.mjs` and justify the
	// diff; an unexplained row here is exactly the drift this slice removed.
	it("matches the committed fixture", () => {
		const fixture = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
		expect(buildSnapshot()).toEqual(fixture);
	});
});

describe("SCAN_LANGUAGE_PRIORITY (#2434 fold)", () => {
	// The frozen "before": tools/lsp-diagnostics.ts's LANG_EXTENSIONS table as
	// it stood on master (82c526c2), captured BEFORE the fold so this suite
	// compares the registry projection against a fixed target rather than
	// against itself. See tests/fixtures/lsp-diagnostics-lang-extensions.json.
	const golden = JSON.parse(
		readFileSync(
			new URL(
				"../fixtures/lsp-diagnostics-lang-extensions.json",
				import.meta.url,
			),
			"utf8",
		),
	) as { order: string[]; extensions: Record<string, string[]> };

	/**
	 * Every old key mapped to one or more registry ids, in the SAME relative
	 * order the old table tried them. Most rows are a single id whose
	 * `extensionsForLanguage` set equals the old key's value exactly.
	 *
	 * Three rows split one old key across two-or-three registry ids, because
	 * the old table bundled languages #2424 had already separated by grammar
	 * (`.ts`+`.tsx`, `.js`+`.jsx`) or by dedicated entry (`.css`+`.scss`+
	 * `.less`): `goldenKeys` names every old key whose value the ids replace
	 * (`.tsx` duplicated `.ts`'s value verbatim and is folded into the same
	 * row, not dropped). The UNION of those ids' extensions equals the old
	 * key's value — a directory containing only ONE side of the split still
	 * scans exactly as before; a directory mixing BOTH sides (e.g. `.ts` AND
	 * `.tsx` together) now scans as whichever id is tried first, not the old
	 * combined set — the one enumerated "Changed" row from the split.
	 *
	 * Five rows are a single id whose registry extension set is a SUPERSET of
	 * the old value: the registry entry is shared with every other consumer
	 * (grammar routing, LSP id, `resolveLanguage`), so narrowing it here to
	 * match the old table would mean re-forking a table #2424 just merged.
	 * `extra` names exactly the additional extensions, each individually
	 * justified in `.changelog/` under Changed.
	 */
	const FAMILIES: Array<{
		goldenKeys: string[];
		ids: LanguageId[];
		extra?: string[];
	}> = [
		{ goldenKeys: [".ts", ".tsx"], ids: ["typescript", "typescriptreact"] },
		{ goldenKeys: [".js"], ids: ["javascript", "javascriptreact"] },
		{ goldenKeys: [".py"], ids: ["python"] },
		{ goldenKeys: [".rs"], ids: ["rust"] },
		{ goldenKeys: [".go"], ids: ["go"] },
		// Widened: the registry's ruby entry also owns .ru (Rack config), the
		// same reconciled decision #2424 already made for lens-engine's `lang`
		// filter (line ~505 above).
		{ goldenKeys: [".rb"], ids: ["ruby"], extra: [".ru"] },
		{ goldenKeys: [".java"], ids: ["java"] },
		{ goldenKeys: [".kt"], ids: ["kotlin"] },
		{ goldenKeys: [".swift"], ids: ["swift"] },
		{ goldenKeys: [".cs"], ids: ["csharp"] },
		// Widened: the registry's cpp entry is the full clang extension table
		// (module-interface, Objective-C, OpenCL tail) minus the c/cpp split;
		// the old ad hoc list only ever named 5 of them.
		{
			goldenKeys: [".cpp"],
			ids: ["cpp"],
			extra: [
				".c++",
				".c++m",
				".cl",
				".clcpp",
				".cp",
				".cppm",
				".cu",
				// Deliberate CUDA/HIP community-header divergence from clang (#2986).
				".cuh",
				".cxxm",
				".hh",
				".hip",
				".inl",
				".ipp",
				".ixx",
				".m",
				".mm",
				".tpp",
				".txx",
			],
		},
		{ goldenKeys: [".c"], ids: ["c"] },
		{ goldenKeys: [".zig"], ids: ["zig"] },
		{ goldenKeys: [".hs"], ids: ["haskell"] },
		{ goldenKeys: [".ex"], ids: ["elixir"] },
		{ goldenKeys: [".gleam"], ids: ["gleam"] },
		{ goldenKeys: [".tf"], ids: ["terraform"] },
		{ goldenKeys: [".nix"], ids: ["nix"] },
		{ goldenKeys: [".sh"], ids: ["shell"] },
		// Widened: the registry's php entry also owns the four alias extensions
		// (.phtml/.php3/.php4/.php5), same reconciled decision as lens-engine's
		// `lang` filter.
		{
			goldenKeys: [".php"],
			ids: ["php"],
			extra: [".phtml", ".php3", ".php4", ".php5"],
		},
		{ goldenKeys: [".lua"], ids: ["lua"] },
		{ goldenKeys: [".dart"], ids: ["dart"] },
		{ goldenKeys: [".vue"], ids: ["vue"] },
		{ goldenKeys: [".svelte"], ids: ["svelte"] },
		{ goldenKeys: [".css"], ids: ["css", "scss", "less"] },
		{ goldenKeys: [".html"], ids: ["html"] },
		// Widened: the registry's json entry also owns .json5; .jsonc stays its
		// own entry (no grammar), same reconciled decision as lens-engine's
		// `lang` filter.
		{ goldenKeys: [".json"], ids: ["json", "jsonc"], extra: [".json5"] },
		{ goldenKeys: [".yaml"], ids: ["yaml"] },
		{ goldenKeys: [".toml"], ids: ["toml"] },
		{ goldenKeys: [".prisma"], ids: ["prisma"] },
	];

	it("covers exactly the golden table's keys, once each", () => {
		const covered = FAMILIES.flatMap((family) => family.goldenKeys).sort();
		expect(covered).toEqual([...golden.order].sort());
	});

	it("every golden key's value set collapses to one family (the .tsx/.ts duplicate included)", () => {
		for (const family of FAMILIES) {
			const sets = family.goldenKeys.map(
				(key) => new Set(golden.extensions[key]),
			);
			const [first, ...rest] = sets;
			for (const other of rest) {
				expect(
					other,
					`golden keys ${family.goldenKeys.join("/")} disagree on their extension set`,
				).toEqual(first);
			}
		}
	});

	// #2458 fix-round F3: this used to compare a FLAT SCAN_LANGUAGE_PRIORITY
	// against `FAMILIES.flatMap`, which collapsed family boundaries into one
	// array and so could not, by construction, catch a family being reordered
	// relative to its own golden position without ALSO catching plain id
	// reordering — the two failure modes were indistinguishable and neither
	// was independently pinned against a source outside this test file. Two
	// checks now: family-level order against `golden.order` directly (not
	// against `SCAN_LANGUAGE_PRIORITY`, so a bug that moves both in the same
	// wrong direction still reds), and the full nested shape (family order AND
	// intra-family id order) against `SCAN_LANGUAGE_PRIORITY` itself.
	it("FAMILIES' family-level order matches golden.order exactly (goldenKeys[0], deduplicated)", () => {
		// golden.order lists `.tsx` as its own entry even though it shares the
		// `.ts` family's value (the old table's one true key duplicate) — drop
		// every goldenKey that is not a family's FIRST one before comparing, or
		// this would spuriously expect a 31st family that doesn't exist.
		const nonLeadGoldenKeys = new Set(
			FAMILIES.flatMap((family) => family.goldenKeys.slice(1)),
		);
		const dedupedGoldenOrder = golden.order.filter(
			(key: string) => !nonLeadGoldenKeys.has(key),
		);
		expect(FAMILIES.map((family) => family.goldenKeys[0])).toEqual(
			dedupedGoldenOrder,
		);
	});

	it("SCAN_LANGUAGE_PRIORITY is exactly the families, family order AND intra-family id order both pinned", () => {
		expect(SCAN_LANGUAGE_PRIORITY).toEqual(
			FAMILIES.map((family) => family.ids),
		);
	});

	it("each family's projected extension set equals the golden value plus only its documented extras", () => {
		for (const family of FAMILIES) {
			const goldenSet = new Set(golden.extensions[family.goldenKeys[0]]);
			const projected = new Set(
				family.ids.flatMap((id) => extensionsForLanguage(id)),
			);
			const expected = new Set([...goldenSet, ...(family.extra ?? [])]);
			expect(
				projected,
				`family ${family.ids.join("+")} (golden ${family.goldenKeys.join("/")})`,
			).toEqual(expected);
		}
	});

	it("drops no extension the old table could ever scan", () => {
		const allGolden = new Set(Object.values(golden.extensions).flat());
		const allProjected = new Set(
			SCAN_LANGUAGE_PRIORITY.flatMap((family) =>
				family.flatMap((id) => extensionsForLanguage(id)),
			),
		);
		const missing = [...allGolden].filter((ext) => !allProjected.has(ext));
		expect(missing).toEqual([]);
	});

	// #2434 scope item 3: clients/lsp/server.ts's AST_GREP_KINDS carried a dead
	// "solidity" entry — not a FileKind, so KIND_EXTENSIONS never had a row for
	// it and it contributed zero extensions before or after removal (the
	// deletion is a no-op on AstGrepServer.extensions, which is why a runtime
	// assertion on that list can't guard the regression). Source-grep instead.
	it("clients/lsp/server.ts's AST_GREP_KINDS names no phantom 'solidity' entry", () => {
		const source = readFileSync(
			new URL("../../clients/lsp/server.ts", import.meta.url),
			"utf8",
		);
		const match = source.match(
			/const AST_GREP_KINDS = \[([\s\S]*?)\] as const;/,
		);
		expect(match, "AST_GREP_KINDS declaration not found").not.toBeNull();
		expect(match?.[1]).not.toContain("solidity");
	});

	// #2458 fix-round F5: `tools/shared.ts`'s `LANGUAGES` — spread into the
	// `lang` enum of four agent-facing tool schemas (ast_dump,
	// ast_grep_outline, ast_grep_replace, ast_grep_search) — carried the same
	// phantom "solidity" entry (#2424 review, S2's finding, never actually
	// swept from this table): not a registry id, not an ast-grep napi
	// language, not reachable from `extensionsForLanguageToken` (see the
	// `symbol_search lang filter` describe block above), so selecting it in
	// any of those four tools' `lang` param could only ever no-op. Runtime
	// assertion (not source-grep): `LANGUAGES` is a real array these tools
	// spread at schema-build time, so a reintroduction is directly observable.
	it("tools/shared.ts's LANGUAGES names no phantom 'solidity' entry", async () => {
		const { LANGUAGES } = await import("../../tools/shared.js");
		expect(LANGUAGES).not.toContain("solidity");
	});
});

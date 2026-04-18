import type { FileKind } from "./file-kinds.js";
import type { ProjectLanguageProfile } from "./language-profile.js";
import type { RunnerGroup } from "./dispatch/types.js";

interface StartupPolicy {
	defaults?: string[];
	heavyScansRequireConfig?: boolean;
}

interface LanguagePolicy {
	lspCapable: boolean;
	startup?: StartupPolicy;
}

export const LANGUAGE_POLICY: Record<FileKind, LanguagePolicy> = {
	jsts: {
		lspCapable: true,
		startup: {
			defaults: ["typescript-language-server", "biome"],
			heavyScansRequireConfig: true,
		},
	},
	python: {
		lspCapable: true,
		startup: {
			defaults: ["pyright", "ruff"],
		},
	},
	go: { lspCapable: true },
	rust: { lspCapable: true },
	cxx: { lspCapable: true },
	cmake: { lspCapable: true },
	shell: { lspCapable: true },
	json: { lspCapable: true },
	markdown: { lspCapable: false },
	css: { lspCapable: true },
	yaml: {
		lspCapable: true,
		startup: {
			defaults: ["yamllint"],
			heavyScansRequireConfig: true,
		},
	},
	sql: {
		lspCapable: false,
		startup: {
			defaults: ["sqlfluff"],
			heavyScansRequireConfig: true,
		},
	},
	ruby: { lspCapable: true },
	html: { lspCapable: true },
	docker: { lspCapable: true },
	php: { lspCapable: true },
	powershell: { lspCapable: true },
	prisma: { lspCapable: true },
	csharp: { lspCapable: true },
	fsharp: { lspCapable: true },
	java: { lspCapable: true },
	kotlin: { lspCapable: true },
	swift: { lspCapable: true },
	dart: { lspCapable: true },
	lua: { lspCapable: true },
	zig: { lspCapable: true },
	haskell: { lspCapable: true },
	elixir: { lspCapable: true },
	gleam: { lspCapable: true },
	ocaml: { lspCapable: true },
	clojure: { lspCapable: true },
	terraform: { lspCapable: true },
	nix: { lspCapable: true },
	toml: { lspCapable: true },
};

const PRIMARY_DISPATCH_GROUPS: Partial<Record<FileKind, RunnerGroup>> = {
	jsts: { mode: "fallback", runnerIds: ["lsp", "ts-lsp"], filterKinds: ["jsts"] },
	python: {
		mode: "fallback",
		runnerIds: ["lsp", "pyright"],
		filterKinds: ["python"],
	},
	go: { mode: "fallback", runnerIds: ["lsp", "go-vet"], filterKinds: ["go"] },
	rust: {
		mode: "fallback",
		runnerIds: ["lsp", "rust-clippy"],
		filterKinds: ["rust"],
	},
	ruby: {
		mode: "fallback",
		runnerIds: ["lsp", "rubocop"],
		filterKinds: ["ruby"],
	},
	cxx: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["cxx"] },
	cmake: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["cmake"] },
	shell: {
		mode: "fallback",
		runnerIds: ["lsp", "shellcheck"],
		filterKinds: ["shell"],
	},
	json: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["json"] },
	markdown: {
		mode: "fallback",
		runnerIds: ["spellcheck"],
		filterKinds: ["markdown"],
	},
	css: { mode: "fallback", runnerIds: ["lsp", "stylelint", "prettier-check"], filterKinds: ["css"] },
	yaml: {
		mode: "fallback",
		runnerIds: ["lsp", "yamllint"],
		filterKinds: ["yaml"],
	},
	sql: {
		mode: "fallback",
		runnerIds: ["sqlfluff"],
		filterKinds: ["sql"],
	},
	html: {
		mode: "fallback",
		runnerIds: ["lsp", "htmlhint", "prettier-check"],
		filterKinds: ["html"],
	},
	docker: {
		mode: "fallback",
		runnerIds: ["lsp", "hadolint"],
		filterKinds: ["docker"],
	},
	php: {
		mode: "fallback",
		runnerIds: ["lsp", "php-lint", "phpstan"],
		filterKinds: ["php"],
	},
	powershell: {
		mode: "fallback",
		runnerIds: ["lsp", "psscriptanalyzer"],
		filterKinds: ["powershell"],
	},
	prisma: {
		mode: "fallback",
		runnerIds: ["lsp", "prisma-validate"],
		filterKinds: ["prisma"],
	},
	csharp: {
		mode: "fallback",
		runnerIds: ["lsp", "dotnet-build"],
		filterKinds: ["csharp"],
	},
	fsharp: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["fsharp"] },
	java: {
		mode: "fallback",
		runnerIds: ["lsp", "javac"],
		filterKinds: ["java"],
	},
	kotlin: { mode: "fallback", runnerIds: ["lsp", "ktlint"], filterKinds: ["kotlin"] },
	swift: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["swift"] },
	dart: { mode: "fallback", runnerIds: ["lsp", "dart-analyze"], filterKinds: ["dart"] },
	lua: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["lua"] },
	zig: { mode: "fallback", runnerIds: ["lsp", "zig-check"], filterKinds: ["zig"] },
	haskell: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["haskell"] },
	elixir: { mode: "fallback", runnerIds: ["lsp", "credo"], filterKinds: ["elixir"] },
	gleam: { mode: "fallback", runnerIds: ["lsp", "gleam-check"], filterKinds: ["gleam"] },
	ocaml: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["ocaml"] },
	clojure: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["clojure"] },
	terraform: { mode: "fallback", runnerIds: ["lsp", "tflint"], filterKinds: ["terraform"] },
	nix: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["nix"] },
	toml: { mode: "fallback", runnerIds: ["lsp", "taplo"], filterKinds: ["toml"] },
};

export function getLspCapableKinds(): FileKind[] {
	return (Object.keys(LANGUAGE_POLICY) as FileKind[]).filter(
		(kind) => LANGUAGE_POLICY[kind].lspCapable,
	);
}

export function getPrimaryDispatchGroup(
	kind: FileKind,
	lspEnabled: boolean,
): RunnerGroup | undefined {
	const base = PRIMARY_DISPATCH_GROUPS[kind];
	if (!base) return undefined;

	const ids = lspEnabled
		? [...base.runnerIds]
		: base.runnerIds.filter((id) => id !== "lsp" && id !== "ts-lsp");
	if (ids.length === 0) return undefined;

	return {
		mode: base.mode,
		runnerIds: ids,
		filterKinds: base.filterKinds,
		semantic: base.semantic,
	};
}

export function getStartupDefaultsForProfile(
	profile: ProjectLanguageProfile,
): string[] {
	const tools = new Set<string>();

	for (const kind of Object.keys(LANGUAGE_POLICY) as FileKind[]) {
		if (!profile.present[kind]) continue;
		const defaults = LANGUAGE_POLICY[kind].startup?.defaults ?? [];
		for (const tool of defaults) {
			if (
				LANGUAGE_POLICY[kind].startup?.heavyScansRequireConfig &&
				!profile.configured[kind]
			) {
				continue;
			}
			tools.add(tool);
		}
	}

	return [...tools];
}

export function canRunStartupHeavyScans(
	profile: ProjectLanguageProfile,
	kind: FileKind,
): boolean {
	if (!profile.present[kind]) return false;
	const needsConfig = LANGUAGE_POLICY[kind].startup?.heavyScansRequireConfig;
	if (!needsConfig) return true;
	return !!profile.configured[kind];
}

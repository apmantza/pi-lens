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
	markdown: { lspCapable: true },
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
		runnerIds: ["lsp", "spellcheck"],
		filterKinds: ["markdown"],
	},
	css: { mode: "fallback", runnerIds: ["lsp"], filterKinds: ["css"] },
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
		runnerIds: ["lsp"],
		filterKinds: ["html"],
	},
	docker: {
		mode: "fallback",
		runnerIds: ["lsp"],
		filterKinds: ["docker"],
	},
	php: {
		mode: "fallback",
		runnerIds: ["lsp"],
		filterKinds: ["php"],
	},
	powershell: {
		mode: "fallback",
		runnerIds: ["lsp"],
		filterKinds: ["powershell"],
	},
	prisma: {
		mode: "fallback",
		runnerIds: ["lsp"],
		filterKinds: ["prisma"],
	},
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

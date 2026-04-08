import type { FileKind } from "./file-kinds.js";
import type { ProjectLanguageProfile } from "./language-profile.js";

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
			defaults: ["typescript-language-server"],
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
};

export function getLspCapableKinds(): FileKind[] {
	return (Object.keys(LANGUAGE_POLICY) as FileKind[]).filter(
		(kind) => LANGUAGE_POLICY[kind].lspCapable,
	);
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

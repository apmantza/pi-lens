export interface ToolProfile {
	dedupPriority: number;
	lintLike: boolean;
}

const DEFAULT_TOOL_PROFILE: ToolProfile = {
	dedupPriority: 50,
	lintLike: false,
};

const TOOL_PROFILE_MAP: Record<string, ToolProfile> = {
	"tree-sitter:silent-error": { dedupPriority: 200, lintLike: false },
	lsp: { dedupPriority: 120, lintLike: false },
	"ts-lsp": { dedupPriority: 120, lintLike: false },
	eslint: { dedupPriority: 110, lintLike: true },
	biome: { dedupPriority: 100, lintLike: true },
	"biome-check-json": { dedupPriority: 100, lintLike: true },
	"tree-sitter": { dedupPriority: 90, lintLike: false },
	"ast-grep-napi": { dedupPriority: 80, lintLike: false },
	"ast-grep": { dedupPriority: 80, lintLike: false },
	"ruff-lint": { dedupPriority: 95, lintLike: true },
	oxlint: { dedupPriority: 95, lintLike: true },
	rubocop: { dedupPriority: 95, lintLike: true },
	"go-vet": { dedupPriority: 95, lintLike: true },
	"golangci-lint": { dedupPriority: 95, lintLike: true },
	"rust-clippy": { dedupPriority: 95, lintLike: true },
	shellcheck: { dedupPriority: 95, lintLike: true },
	opengrep: { dedupPriority: 105, lintLike: false },
	"trivy-config": { dedupPriority: 105, lintLike: false },
};

export function getToolProfile(
	tool: string,
	defectClass?: string,
): ToolProfile {
	const t = tool.toLowerCase();
	if (defectClass === "silent-error" && t === "tree-sitter") {
		return TOOL_PROFILE_MAP["tree-sitter:silent-error"];
	}
	return TOOL_PROFILE_MAP[t] ?? DEFAULT_TOOL_PROFILE;
}

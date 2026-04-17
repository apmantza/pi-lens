import type { FileKind } from "../file-kinds.js";
import { getPrimaryDispatchGroup } from "../language-policy.js";
import type { RunnerGroup, ToolPlan } from "./types.js";

type CapabilityDimension =
	| "types"
	| "security"
	| "smells"
	| "format"
	| "lint"
	| "architecture"
	| "docs";

interface CapabilityMatrixEntry {
	name: string;
	capabilities: CapabilityDimension[];
	writeGroups: RunnerGroup[];
	fullOnlyGroups?: RunnerGroup[];
}

function primary(kind: FileKind): RunnerGroup {
	const group = getPrimaryDispatchGroup(kind, true);
	if (!group) {
		throw new Error(`Missing primary dispatch group for ${kind}`);
	}
	return group;
}

export const LANGUAGE_CAPABILITY_MATRIX: Record<FileKind, CapabilityMatrixEntry> = {
	jsts: {
		name: "JavaScript/TypeScript Linting",
		capabilities: ["types", "security", "smells", "format", "lint", "architecture"],
		writeGroups: [
			primary("jsts"),
			{ mode: "all", runnerIds: ["biome-check-json"], filterKinds: ["jsts"] },
			{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["jsts"] },
			{ mode: "all", runnerIds: ["ast-grep-napi"], filterKinds: ["jsts"] },
			{ mode: "fallback", runnerIds: ["type-safety"], filterKinds: ["jsts"] },
			{ mode: "fallback", runnerIds: ["similarity"], filterKinds: ["jsts"] },
			{ mode: "fallback", runnerIds: ["eslint"], filterKinds: ["jsts"] },
			{ mode: "fallback", runnerIds: ["architect"], filterKinds: ["jsts"] },
		],
		fullOnlyGroups: [
			{ mode: "fallback", runnerIds: ["biome-lint", "oxlint"], filterKinds: ["jsts"] },
		],
	},
	python: {
		name: "Python Linting",
		capabilities: ["types", "lint", "architecture", "smells"],
		writeGroups: [
			primary("python"),
			{ mode: "fallback", runnerIds: ["ruff-lint"], filterKinds: ["python"] },
			{ mode: "fallback", runnerIds: ["architect"], filterKinds: ["python"] },
		],
		fullOnlyGroups: [
			{ mode: "fallback", runnerIds: ["python-slop"], filterKinds: ["python"] },
		],
	},
	go: {
		name: "Go Linting",
		capabilities: ["types", "lint", "smells"],
		writeGroups: [
			primary("go"),
			{ mode: "fallback", runnerIds: ["go-vet"], filterKinds: ["go"] },
			{ mode: "fallback", runnerIds: ["golangci-lint"], filterKinds: ["go"] },
			{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["go"] },
		],
	},
	rust: {
		name: "Rust Linting",
		capabilities: ["types", "lint", "smells"],
		writeGroups: [
			primary("rust"),
			{ mode: "fallback", runnerIds: ["rust-clippy"], filterKinds: ["rust"] },
			{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["rust"] },
		],
	},
	ruby: {
		name: "Ruby Linting",
		capabilities: ["types", "lint", "smells"],
		writeGroups: [
			primary("ruby"),
			{ mode: "fallback", runnerIds: ["rubocop"], filterKinds: ["ruby"] },
			{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["ruby"] },
		],
	},
	cxx: {
		name: "C/C++ Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("cxx")],
	},
	cmake: {
		name: "CMake Processing",
		capabilities: ["lint"],
		writeGroups: [primary("cmake")],
	},
	shell: {
		name: "Shell Script Linting",
		capabilities: ["lint", "security"],
		writeGroups: [primary("shell")],
	},
	json: {
		name: "JSON Processing",
		capabilities: ["format"],
		writeGroups: [primary("json")],
	},
	markdown: {
		name: "Markdown Processing",
		capabilities: ["docs"],
		writeGroups: [primary("markdown")],
	},
	css: {
		name: "CSS Processing",
		capabilities: ["format", "lint"],
		writeGroups: [primary("css")],
	},
	yaml: {
		name: "YAML Processing",
		capabilities: ["format", "lint"],
		writeGroups: [primary("yaml")],
	},
	sql: {
		name: "SQL Processing",
		capabilities: ["format", "lint"],
		writeGroups: [primary("sql")],
	},
	html: {
		name: "HTML Linting",
		capabilities: ["lint"],
		writeGroups: [
			primary("html"),
			{ mode: "all", runnerIds: ["htmlhint"], filterKinds: ["html"] },
		],
	},
	docker: {
		name: "Dockerfile Linting",
		capabilities: ["lint"],
		writeGroups: [
			primary("docker"),
			{ mode: "all", runnerIds: ["hadolint"], filterKinds: ["docker"] },
		],
	},
	php: {
		name: "PHP Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("php")],
	},
	powershell: {
		name: "PowerShell Linting",
		capabilities: ["lint"],
		writeGroups: [primary("powershell")],
	},
	prisma: {
		name: "Prisma Schema Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("prisma")],
	},
};

function toWritePlan(entry: CapabilityMatrixEntry): ToolPlan {
	return {
		name: entry.name,
		groups: [...entry.writeGroups],
	};
}

function toFullPlan(kind: FileKind, entry: CapabilityMatrixEntry): ToolPlan {
	if (kind === "jsts") {
		const primaryGroup = primary("jsts");
		return {
			name: "JavaScript/TypeScript Full Lint",
			groups: [
				primaryGroup,
				{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["jsts"] },
				{ mode: "all", runnerIds: ["ast-grep-napi"], filterKinds: ["jsts"] },
				...(entry.fullOnlyGroups ?? []),
				{ mode: "fallback", runnerIds: ["type-safety"], filterKinds: ["jsts"] },
				{ mode: "fallback", runnerIds: ["similarity"], filterKinds: ["jsts"] },
				{ mode: "fallback", runnerIds: ["architect"], filterKinds: ["jsts"] },
				{ mode: "fallback", runnerIds: ["eslint"], filterKinds: ["jsts"] },
			],
		};
	}

	if (kind === "python") {
		const primaryGroup = primary("python");
		return {
			name: "Python Full Lint",
			groups: [
				primaryGroup,
				{ mode: "fallback", runnerIds: ["ruff-lint"], filterKinds: ["python"] },
				...(entry.fullOnlyGroups ?? []),
				{ mode: "fallback", runnerIds: ["architect"], filterKinds: ["python"] },
			],
		};
	}

	return {
		name: entry.name,
		groups: [...entry.writeGroups, ...(entry.fullOnlyGroups ?? [])],
	};
}

export const TOOL_PLANS: Record<string, ToolPlan> = Object.fromEntries(
	Object.entries(LANGUAGE_CAPABILITY_MATRIX).map(([kind, entry]) => [
		kind,
		toWritePlan(entry),
	]),
) as Record<string, ToolPlan>;

export function getToolPlan(kind: FileKind): ToolPlan | undefined {
	return TOOL_PLANS[kind];
}

export function getAllToolPlans(): Record<string, ToolPlan> {
	return TOOL_PLANS;
}

export const FULL_LINT_PLANS: Record<string, ToolPlan> = Object.fromEntries(
	Object.entries(LANGUAGE_CAPABILITY_MATRIX).map(([kind, entry]) => [
		kind,
		toFullPlan(kind as FileKind, entry),
	]),
) as Record<string, ToolPlan>;

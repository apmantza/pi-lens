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
		capabilities: ["format", "lint"],
		writeGroups: [primary("json")],
	},
	markdown: {
		name: "Markdown Processing",
		capabilities: ["docs", "format", "lint"],
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
		writeGroups: [primary("html")],
	},
	docker: {
		name: "Dockerfile Linting",
		capabilities: ["lint"],
		writeGroups: [primary("docker")],
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
	csharp: {
		name: "C# Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("csharp")],
	},
	fsharp: {
		name: "F# Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("fsharp")],
	},
	java: {
		name: "Java Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("java")],
	},
	kotlin: {
		name: "Kotlin Linting",
		capabilities: ["types", "lint", "format"],
		writeGroups: [primary("kotlin")],
	},
	swift: {
		name: "Swift Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("swift")],
	},
	dart: {
		name: "Dart Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("dart")],
	},
	lua: {
		name: "Lua Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("lua")],
	},
	zig: {
		name: "Zig Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("zig")],
	},
	haskell: {
		name: "Haskell Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("haskell")],
	},
	elixir: {
		name: "Elixir Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("elixir")],
	},
	gleam: {
		name: "Gleam Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("gleam")],
	},
	ocaml: {
		name: "OCaml Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("ocaml")],
	},
	clojure: {
		name: "Clojure Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("clojure")],
	},
	terraform: {
		name: "Terraform Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("terraform")],
	},
	nix: {
		name: "Nix Linting",
		capabilities: ["types", "lint"],
		writeGroups: [primary("nix")],
	},
	toml: {
		name: "TOML Linting",
		capabilities: ["lint", "format"],
		writeGroups: [primary("toml")],
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

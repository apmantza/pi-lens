/**
 * File Kind Detection for pi-lens
 *
 * Centralized file type detection to avoid duplication across clients.
 * Maps file extensions and paths to semantic file kinds.
 */

import { basename, extname } from "node:path";

// --- Types ---

export type FileKind =
	| "jsts" // JavaScript/TypeScript (js, jsx, ts, tsx, mjs, cjs)
	| "python" // Python (.py)
	| "go" // Go (.go)
	| "rust" // Rust (.rs)
	| "cxx" // C/C++ (.c, .cc, .cpp, .h, .hpp, .cxx, etc.)
	| "cmake" // CMake (.cmake, CMakeLists.txt)
	| "shell" // Shell (.sh, .bash)
	| "json" // JSON (.json)
	| "markdown" // Markdown (.md, .mdx)
	| "css" // CSS (.css, .scss, .less)
	| "yaml"; // YAML (.yaml, .yml)

// --- Extension Maps ---

const KIND_EXTENSIONS: Record<FileKind, readonly string[]> = {
	jsts: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".svelte"],
	python: [".py"],
	go: [".go"],
	rust: [".rs"],
	cxx: [
		".c",
		".cc",
		".cpp",
		".cxx",
		".h",
		".hh",
		".hpp",
		".hxx",
		".ixx",
		".ipp",
		".inl",
		".tpp",
		".txx",
	],
	cmake: [".cmake"],
	shell: [".sh", ".bash", ".zsh", ".fish"],
	json: [".json", ".jsonc", ".json5"],
	markdown: [".md", ".mdx"],
	css: [".css", ".scss", ".sass", ".less"],
	yaml: [".yaml", ".yml"],
};

// Reverse map: extension → file kind (for fast lookup)
const EXT_TO_KIND = new Map<string, FileKind>();
for (const [kind, exts] of Object.entries(KIND_EXTENSIONS)) {
	for (const ext of exts) {
		EXT_TO_KIND.set(ext.toLowerCase(), kind as FileKind);
	}
	// Also register without leading dot
	for (const ext of exts) {
		if (ext.startsWith(".")) {
			EXT_TO_KIND.set(ext.slice(1).toLowerCase(), kind as FileKind);
		}
	}
}

// Special filenames that indicate a file kind
const SPECIAL_FILENAMES: Array<{ pattern: RegExp; kind: FileKind }> = [
	{ pattern: /^CMakeLists\.txt$/i, kind: "cmake" },
	{ pattern: /^Makefile$/i, kind: "shell" },
	{ pattern: /^ Dockerfile(\.\w+)?$/i, kind: "shell" },
];

// --- Detection Functions ---

/**
 * Detect the file kind from a file path.
 * Returns the semantic file kind or undefined if unknown.
 */
export function detectFileKind(filePath: string): FileKind | undefined {
	if (!filePath || typeof filePath !== "string") {
		return undefined;
	}

	// Check special filenames first
	const base = basename(filePath);
	for (const { pattern, kind } of SPECIAL_FILENAMES) {
		if (pattern.test(base)) {
			return kind;
		}
	}

	// Check by extension
	const ext = extname(filePath).toLowerCase();
	return EXT_TO_KIND.get(ext);
}

/**
 * Check if a file kind is supported by a specific tool or capability.
 *
 * @example
 * // Check if TypeScript file
 * if (isFileKind(filePath, "jsts")) { ... }
 *
 * // Check for multiple kinds
 * if (isFileKind(filePath, ["jsts", "python"])) { ... }
 */
export function isFileKind(
	filePath: string,
	kind: FileKind | FileKind[],
): boolean {
	const detected = detectFileKind(filePath);
	if (!detected) return false;

	if (Array.isArray(kind)) {
		return kind.includes(detected);
	}

	return detected === kind;
}

/**
 * Get all file kinds that match a given file extension.
 * Useful for listing which tools might handle a file.
 */
export function getFileKindsForExtension(ext: string): FileKind[] {
	const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;
	const kind = EXT_TO_KIND.get(normalizedExt.toLowerCase());
	return kind ? [kind] : [];
}

/**
 * Check if a file kind represents a code file (not config/markdown).
 */
export function isCodeKind(kind: FileKind): boolean {
	return ["jsts", "python", "go", "rust", "cxx", "shell"].includes(kind);
}

/**
 * Check if a file kind represents a text/config file.
 */
export function isConfigKind(kind: FileKind): boolean {
	return ["json", "yaml", "markdown", "css"].includes(kind);
}

/**
 * Get human-readable description of a file kind.
 */
export function getFileKindLabel(kind: FileKind): string {
	const labels: Record<FileKind, string> = {
		jsts: "JavaScript/TypeScript",
		python: "Python",
		go: "Go",
		rust: "Rust",
		cxx: "C/C++",
		cmake: "CMake",
		shell: "Shell",
		json: "JSON",
		markdown: "Markdown",
		css: "CSS",
		yaml: "YAML",
	};
	return labels[kind] ?? kind;
}

/**
 * Get file extensions for a file kind.
 */
export function getExtensionsForKind(kind: FileKind): string[] {
	return [...(KIND_EXTENSIONS[kind] ?? [])];
}

/**
 * Check if a file should be scanned for linting/formatting.
 * Excludes test files, generated files, etc.
 */
export function isScannableFile(filePath: string): boolean {
	const kind = detectFileKind(filePath);
	if (!kind) return false;

	// Exclude test files for most kinds
	const base = basename(filePath);
	if (
		base.includes(".test.") ||
		base.includes(".spec.") ||
		base.startsWith("test-") ||
		base.startsWith("spec-")
	) {
		return false;
	}

	// Only scan code and config files
	return isCodeKind(kind) || isConfigKind(kind);
}

/**
 * Get the language identifier for LSP/tools that use language IDs.
 */
export function getLanguageId(kind: FileKind): string {
	const languageIds: Record<FileKind, string> = {
		jsts: "typescript",
		python: "python",
		go: "go",
		rust: "rust",
		cxx: "cpp",
		cmake: "cmake",
		shell: "shell",
		json: "json",
		markdown: "markdown",
		css: "css",
		yaml: "yaml",
	};
	return languageIds[kind] ?? "plaintext";
}

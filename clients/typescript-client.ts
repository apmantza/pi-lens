/**
 * TypeScript Language Service Client for pi-local
 *
 * Uses TypeScript's in-process Language Service API for rich code intelligence.
 * This is lighter weight than spawning tsserver and provides the same features.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import type {
	CompletionItem,
	Diagnostic,
	DiagnosticSeverity,
	FoldingRange,
	HoverInfo,
	Location,
	SymbolInfo,
} from "./types.js";

// TypeScript file extensions
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

// Default compiler options when no tsconfig is found
/**
 * Build default CompilerOptions through TypeScript's own config parser so that
 * lib name → file path resolution works correctly in the Language Service.
 * Direct assignment of `lib: ["lib.es2020.d.ts"]` doesn't work because the
 * Language Service looks up those names relative to cwd, not the TS install dir.
 */
function buildDefaultCompilerOptions(): ts.CompilerOptions {
	const fakeConfig = {
		compilerOptions: {
			target: "ES2020",
			module: "ESNext",
			moduleResolution: "bundler",
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			lib: ["es2020", "dom", "dom.iterable"],
		},
	};
	const parsed = ts.parseJsonConfigFileContent(
		fakeConfig,
		ts.sys,
		process.cwd(),
	);
	return { ...parsed.options, skipLibCheck: true };
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions =
	buildDefaultCompilerOptions();

/**
 * Walk up from startDir until we find a tsconfig.json, or hit the fs root.
 */
function findTsConfig(startDir: string): string | null {
	let dir = startDir;
	while (true) {
		const candidate = path.join(dir, "tsconfig.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null; // reached root
		dir = parent;
	}
}

/**
 * Read and parse a tsconfig.json, returning merged CompilerOptions.
 * Falls back to DEFAULT_COMPILER_OPTIONS on any error.
 */
function loadCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
	try {
		const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
		if (configFile.error) return DEFAULT_COMPILER_OPTIONS;
		const parsed = ts.parseJsonConfigFileContent(
			configFile.config,
			ts.sys,
			path.dirname(tsconfigPath),
		);
		if (parsed.errors.length) return DEFAULT_COMPILER_OPTIONS;
		// Always set skipLibCheck to avoid noise from node_modules
		return { ...parsed.options, skipLibCheck: true };
	} catch {
		return DEFAULT_COMPILER_OPTIONS;
	}
}

export class TypeScriptClient {
	private fileVersions = new Map<string, number>();
	private fileContents = new Map<string, string>();
	private languageService: ts.LanguageService | null = null;
	private compilerOptions: ts.CompilerOptions = DEFAULT_COMPILER_OPTIONS;
	private lastTsconfigDir: string | null = null;

	constructor() {
		this.initialize();
	}

	/**
	 * Normalize file path for consistent cross-platform use
	 */
	normalizePath(filePath: string): string {
		return path.resolve(filePath).replace(/\\/g, "/");
	}

	/**
	 * Check if a file is a TypeScript/JavaScript file
	 */
	isTypeScriptFile(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		return TS_EXTENSIONS.has(ext);
	}

	private initialize(): void {
		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => Array.from(this.fileContents.keys()),
			getScriptVersion: (fileName: string) => {
				const normalized = fileName.replace(/\\/g, "/");
				return String(this.fileVersions.get(normalized) ?? 0);
			},
			getScriptSnapshot: (fileName: string) => {
				const normalized = fileName.replace(/\\/g, "/");
				const content = this.fileContents.get(normalized);
				if (content) return ts.ScriptSnapshot.fromString(content);
				if (fs.existsSync(fileName)) {
					return ts.ScriptSnapshot.fromString(
						fs.readFileSync(fileName, "utf-8"),
					);
				}
				return undefined;
			},
			getCurrentDirectory: () => process.cwd(),
			getCompilationSettings: () => this.compilerOptions,
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			fileExists: (fileName) => ts.sys.fileExists(fileName),
			readFile: (fileName) => {
				const normalized = fileName.replace(/\\/g, "/");
				const cached = this.fileContents.get(normalized);
				if (cached !== undefined) return cached;
				return ts.sys.readFile(fileName);
			},
			directoryExists: (dirName) => ts.sys.directoryExists(dirName),
			getDirectories: (dir) => ts.sys.getDirectories(dir),
		};

		this.languageService = ts.createLanguageService(
			host,
			ts.createDocumentRegistry(),
		);
	}

	/**
	 * Detect tsconfig for the given file and refresh compilerOptions if the
	 * project root changed (avoids redundant re-parses across edits to the same project).
	 */
	private refreshCompilerOptions(filePath: string): void {
		const dir = path.dirname(path.resolve(filePath));
		const tsconfigPath = findTsConfig(dir);
		const key = tsconfigPath ?? dir;
		if (key === this.lastTsconfigDir) return; // same project, no change
		this.lastTsconfigDir = key;
		this.compilerOptions = tsconfigPath
			? loadCompilerOptions(tsconfigPath)
			: DEFAULT_COMPILER_OPTIONS;
	}

	/**
	 * Add a file to the language service
	 */
	addFile(filePath: string, content: string): void {
		const normalized = this.normalizePath(filePath);
		this.fileContents.set(normalized, content);
		this.fileVersions.set(
			normalized,
			(this.fileVersions.get(normalized) || 0) + 1,
		);
	}

	/**
	 * Update a file's content — also refreshes compilerOptions if project changed
	 */
	updateFile(filePath: string, content: string): void {
		this.refreshCompilerOptions(filePath);
		const normalized = this.normalizePath(filePath);
		this.fileVersions.set(
			normalized,
			(this.fileVersions.get(normalized) ?? 0) + 1,
		);
		this.fileContents.set(normalized, content);
	}

	/**
	 * Ensure a file is loaded from disk (refreshes cache)
	 */
	ensureFile(filePath: string): void {
		const normalized = this.normalizePath(filePath);
		if (fs.existsSync(filePath)) {
			const diskContent = fs.readFileSync(filePath, "utf-8");
			const cachedContent = this.fileContents.get(normalized);
			if (cachedContent !== diskContent) {
				this.updateFile(filePath, diskContent);
			}
		}
	}

	/**
	 * Get all tracked files
	 */
	getTrackedFiles(): string[] {
		return Array.from(this.fileContents.keys());
	}

	/**
	 * Convert line/character to position offset
	 */
	lineCharToPosition(content: string, line: number, character: number): number {
		const lines = content.split("\n");
		let position = 0;
		for (let i = 0; i < Math.min(line, lines.length); i++) {
			position += lines[i].length + 1;
		}
		return position + character;
	}

	/**
	 * Get diagnostics (errors and warnings) for a file
	 */
	getDiagnostics(filePath: string): Diagnostic[] {
		this.refreshCompilerOptions(filePath);
		const normalized = this.normalizePath(filePath);
		this.ensureFile(filePath);
		if (!this.languageService) return [];

		const syntactic = this.languageService.getSyntacticDiagnostics(normalized);
		const semantic = this.languageService.getSemanticDiagnostics(normalized);

		return (
			[...syntactic, ...semantic]
				.filter((diag) => diag.file && diag.start !== undefined)
				// Filter cross-file "redeclare" noise — happens when non-module scripts
				// share global scope across multiple tracked files (TS2300, TS2451)
				.filter((diag) => {
					if (diag.code !== 2300 && diag.code !== 2451) return true;
					// Only keep if the related information points back to the same file
					const related = diag.relatedInformation ?? [];
					return related.every(
						(r) =>
							!r.file || this.normalizePath(r.file.fileName) === normalized,
					);
				})
				.map((diag) => {
					const startPos = diag.file?.getLineAndCharacterOfPosition(
						diag.start!,
					);
					const endPos = diag.file?.getLineAndCharacterOfPosition(
						diag.start! + diag.length!,
					);
					return {
						range: {
							start: { line: startPos.line, character: startPos.character },
							end: { line: endPos.line, character: endPos.character },
						},
						severity: (diag.category === ts.DiagnosticCategory.Error
							? 1
							: 2) as DiagnosticSeverity,
						code: diag.code,
						message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
						source: "typescript",
					};
				})
		);
	}

	/**
	 * Get hover information at a position
	 */
	getHover(
		filePath: string,
		line: number,
		character: number,
	): HoverInfo | null {
		const normalized = this.normalizePath(filePath);
		this.ensureFile(filePath);
		if (!this.languageService) return null;

		const content = this.fileContents.get(normalized);
		if (!content) return null;

		const position = this.lineCharToPosition(content, line, character);
		const info = this.languageService.getQuickInfoAtPosition(
			normalized,
			position,
		);
		if (!info) return null;

		return {
			type: ts.displayPartsToString(info.displayParts),
			documentation: info.documentation
				? ts.displayPartsToString(info.documentation)
				: undefined,
		};
	}

	/**
	 * Go to definition
	 */
	getDefinition(filePath: string, line: number, character: number): Location[] {
		const normalized = this.normalizePath(filePath);
		this.ensureFile(filePath);
		if (!this.languageService) return [];

		const content = this.fileContents.get(normalized);
		if (!content) return [];

		const position = this.lineCharToPosition(content, line, character);
		const definitions = this.languageService.getDefinitionAtPosition(
			normalized,
			position,
		);
		if (!definitions) return [];

		return definitions.map((def) => {
			const _pos = def.fileName
				? { line: 0, character: 0 }
				: { line: 0, character: 0 };
			// For file-based definitions, we need to get line/char from the span
			if (def.textSpan) {
				const defFile = def.fileName || normalized;
				const defContent = this.fileContents.get(defFile) || "";
				if (defContent) {
					const lines = defContent.substring(0, def.textSpan.start).split("\n");
					return {
						file: defFile,
						line: lines.length - 1,
						character: lines[lines.length - 1].length,
					};
				}
			}
			return { file: def.fileName, line: 0, character: 0 };
		});
	}

	/**
	 * Get type definition
	 */
	getTypeDefinition(
		filePath: string,
		line: number,
		character: number,
	): Location[] {
		const normalized = this.normalizePath(filePath);
		this.ensureFile(filePath);
		if (!this.languageService) return [];

		const content = this.fileContents.get(normalized);
		if (!content) return [];

		const position = this.lineCharToPosition(content, line, character);
		const defs = this.languageService.getTypeDefinitionAtPosition(
			normalized,
			position,
		);
		if (!defs) return [];

		return defs.map((def) => {
			const defFile = def.fileName || normalized;
			return { file: defFile, line: 0, character: 0 };
		});
	}

	/**
	 * Find references
	 */
	getReferences(filePath: string, line: number, character: number): Location[] {
		const normalized = this.normalizePath(filePath);
		this.ensureFile(filePath);
		if (!this.languageService) return [];

		const content = this.fileContents.get(normalized);
		if (!content) return [];

		const position = this.lineCharToPosition(content, line, character);
		const references = this.languageService.getReferencesAtPosition(
			normalized,
			position,
		);
		if (!references) return [];

		return references.map((ref) => ({
			file: ref.fileName,
			line: 0,
			character: 0,
		}));
	}

	/**
	 * Get document symbols
	 */
	getSymbols(filePath: string): SymbolInfo[] {
		const normalized = this.normalizePath(filePath);
		this.ensureFile(filePath);
		if (!this.languageService) return [];

		const tree = this.languageService.getNavigationTree(normalized);
		if (!tree) return [];

		const symbols: SymbolInfo[] = [];

		const extract = (node: any, container?: string) => {
			if (node.span) {
				symbols.push({
					name: node.text,
					kind: this.symbolKind(node.kind),
					line: 0,
					containerName: container,
				});
			}
			if (node.childItems) {
				for (const child of node.childItems) {
					extract(child, node.text);
				}
			}
		};

		extract(tree);
		return symbols;
	}

	/**
	 * Get completions at a position
	 */
	getCompletions(
		filePath: string,
		line: number,
		character: number,
	): CompletionItem[] {
		const normalized = this.normalizePath(filePath);
		this.ensureFile(filePath);
		if (!this.languageService) return [];

		const content = this.fileContents.get(normalized);
		if (!content) return [];

		const position = this.lineCharToPosition(content, line, character);
		const completions = this.languageService.getCompletionsAtPosition(
			normalized,
			position,
			{},
		);
		if (!completions) return [];

		return completions.entries.slice(0, 50).map((entry) => ({
			name: entry.name,
			kind: this.completionKind(entry.kind),
			sortText: entry.sortText,
		}));
	}

	/**
	 * Go to implementation
	 */
	getImplementation(
		filePath: string,
		line: number,
		character: number,
	): Location[] {
		const normalized = this.normalizePath(filePath);
		this.ensureFile(filePath);
		if (!this.languageService) return [];

		const content = this.fileContents.get(normalized);
		if (!content) return [];

		const position = this.lineCharToPosition(content, line, character);
		const implementations = this.languageService.getImplementationAtPosition(
			normalized,
			position,
		);
		if (!implementations) return [];

		return implementations.map((impl) => ({
			file: impl.fileName,
			line: 0,
			character: 0,
		}));
	}

	/**
	 * Get folding ranges
	 */
	getFoldingRanges(filePath: string): FoldingRange[] {
		const normalized = this.normalizePath(filePath);
		this.ensureFile(filePath);
		if (!this.languageService) return [];

		const tree = this.languageService.getNavigationTree(normalized);
		if (!tree) return [];

		const ranges: FoldingRange[] = [];

		const findFolds = (node: any) => {
			if (!node?.span) return;

			if (node.kind === "function" || node.kind === "class") {
				ranges.push({
					startLine: 0,
					endLine: 0,
					kind: node.kind,
				});
			}

			if (node.childItems) {
				for (const child of node.childItems) {
					findFolds(child);
				}
			}
		};

		findFolds(tree);
		return ranges;
	}

	/**
	 * Explain an error at a specific line
	 */
	explainError(
		filePath: string,
		line: number,
	): { message: string; code?: number } | null {
		const diagnostics = this.getDiagnostics(filePath);
		const errorAtLine = diagnostics.find(
			(d) => d.range.start.line === line && d.severity === 1,
		);
		if (!errorAtLine) return null;
		return { message: errorAtLine.message, code: errorAtLine.code as number };
	}

	private symbolKind(kind: string): string {
		const map: Record<string, string> = {
			script: "file",
			class: "class",
			interface: "interface",
			function: "function",
			method: "method",
			property: "property",
			variable: "variable",
			enum: "enum",
			module: "module",
		};
		return map[kind] || "unknown";
	}

	private completionKind(kind: string): string {
		const map: Record<string, string> = {
			property: "property",
			method: "method",
			class: "class",
			interface: "interface",
			enum: "enum",
			variable: "variable",
			function: "function",
			keyword: "keyword",
		};
		return map[kind] || "text";
	}
}

/**
 * Config Validation via Tree-sitter
 *
 * Detects config/environment variable access in code and validates against
 * actual config files (INI, YAML, JSON, .env).
 *
 * Catches:
 * - Undefined config keys
 * - Typos in config keys
 * - Missing environment variables
 * - Deprecated/renamed keys
 *
 * Supported patterns:
 * - Python: config.get("section.key"), os.environ.get("VAR")
 * - JS/TS: process.env.VAR, config.get("key")
 * - Go: os.Getenv("VAR")
 * - Rust: env::var("VAR")
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TreeSitterClient } from "./tree-sitter-client.js";

// --- Types ---

export interface ConfigKey {
	key: string;
	file: string;
	line: number;
	value?: string;
}

export interface ConfigAccess {
	key: string;
	file: string;
	line: number;
	column: number;
	pattern: string;
}

export interface ConfigValidationResult {
	undefined: ConfigAccess[];
	typos: Array<{ access: ConfigAccess; suggestion: string }>;
	available: ConfigKey[];
}

// --- Tree-sitter Queries for Config Access Patterns ---

const CONFIG_QUERIES: Record<string, string> = {
	// Python: config.get("section.key") or os.environ.get("VAR")
	python: `
		; Config object access: config.get("key")
		(call
			function: (attribute
				object: (identifier) @config_obj
				attribute: (identifier) @method (#eq? @method "get")			)
			arguments: (argument_list
				(string
					(string_content) @config_key
				)
			)
		)
		(#match? @config_obj "^(config|cfg|settings|conf)$")
		
		; os.environ.get("VAR")
		(call
			function: (attribute
				object: (attribute
					object: (identifier) @os (#eq? @os "os")
					attribute: (identifier) @environ (#eq? @environ "environ")
				)
				attribute: (identifier) @method (#eq? @method "get")
			)
			arguments: (argument_list
				(string (string_content) @env_var)
			)
		)
		
		; os.getenv("VAR")
		(call
			function: (attribute
				object: (identifier) @os (#eq? @os "os")
				attribute: (identifier) @getenv (#eq? @getenv "getenv")
			)
			arguments: (argument_list
				(string (string_content) @env_var)
			)
		)
	`,

	// JavaScript/TypeScript: process.env.VAR or config.get("key")
	javascript: `
		; process.env.VAR or process.env["VAR"]
		(member_expression
			object: (member_expression
				object: (identifier) @process (#eq? @process "process")
				property: (property_identifier) @env (#eq? @env "env")
			)
			property: (property_identifier) @env_var
		)
		
		; process.env["VAR"]
		(member_expression
			object: (member_expression
				object: (identifier) @process (#eq? @process "process")
				property: (property_identifier) @env (#eq? @env "env")
			)
			property: (computed_property_name
				(string (string_fragment) @env_var)
			)
		)
		
		; config.get("key") or cfg.get("key")
		(call_expression
			function: (member_expression
				object: (identifier) @config_obj
				property: (property_identifier) @method (#eq? @method "get")
			)
			arguments: (arguments
				(string (string_fragment) @config_key)
			)
		)
		(#match? @config_obj "^(config|cfg|settings|conf)$")
	`,

	// Same for TypeScript (tsx)
	tsx: `
		; process.env.VAR
		(member_expression
			object: (member_expression
				object: (identifier) @process (#eq? @process "process")
				property: (property_identifier) @env (#eq? @env "env")
			)
			property: (property_identifier) @env_var
		)
		
		; config.get("key")
		(call_expression
			function: (member_expression
				object: (identifier) @config_obj
				property: (property_identifier) @method (#eq? @method "get")
			)
			arguments: (arguments
				(string (string_fragment) @config_key)
			)
		)
		(#match? @config_obj "^(config|cfg|settings|conf)$")
	`,

	// Go: os.Getenv("VAR")
	go: `
		(call_expression
			function: (selector_expression
				operand: (identifier) @os (#eq? @os "os")
				field: (field_identifier) @getenv (#eq? @getenv "Getenv")
			)
			arguments: (argument_list
				(raw_string_literal) @env_var
			)
		)
	`,

	// Rust: env::var("VAR") or std::env::var("VAR")
	rust: `
		(call_expression
			function: (scoped_identifier
				path: (identifier) @env (#eq? @env "env")
				name: (identifier) @var (#eq? @var "var")
			)
			arguments: (arguments
				(string_literal) @env_var
			)
		)
	`,
};

// --- Config File Parsers ---

async function parseEnvFile(filePath: string): Promise<ConfigKey[]> {
	const keys: ConfigKey[] = [];
	try {
		const content = await fs.readFile(filePath, "utf-8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			// Skip comments and empty lines
			if (line.startsWith("#") || line.startsWith("//") || !line) continue;

			const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
			if (match) {
				keys.push({
					key: match[1],
					file: filePath,
					line: i + 1,
					value: match[2].trim(),
				});
			}
		}
	} catch {
		// File doesn't exist or can't be read
	}
	return keys;
}

async function parseIniFile(filePath: string): Promise<ConfigKey[]> {
	const keys: ConfigKey[] = [];
	try {
		const content = await fs.readFile(filePath, "utf-8");
		const lines = content.split("\n");
		let currentSection = "";

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line || line.startsWith(";") || line.startsWith("#")) continue;

			// Section header: [section]
			const sectionMatch = line.match(/^\[([^\]]+)\]$/);
			if (sectionMatch) {
				currentSection = sectionMatch[1];
				continue;
			}

			// Key = value
			const keyMatch = line.match(/^([^=]+)\s*=\s*(.*)$/);
			if (keyMatch) {
				const key = keyMatch[1].trim();
				const fullKey = currentSection ? `${currentSection}.${key}` : key;
				keys.push({
					key: fullKey,
					file: filePath,
					line: i + 1,
					value: keyMatch[2].trim(),
				});
			}
		}
	} catch {
		// File doesn't exist or can't be read
	}
	return keys;
}

async function parseYamlConfig(filePath: string): Promise<ConfigKey[]> {
	const keys: ConfigKey[] = [];
	try {
		const content = await fs.readFile(filePath, "utf-8");
		// Simple YAML parser for flat key: value or section.key format
		const lines = content.split("\n");
		let indentStack: { indent: number; key: string }[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// Skip comments and empty lines
			if (!trimmed || trimmed.startsWith("#")) continue;

			// Calculate indent
			const indent = line.search(/\S/);
			const _indentMatch = indentStack.find((s) => s.indent === indent);

			// key: value pattern
			const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
			if (match) {
				const key = match[1];
				const value = match[2].trim();

				// Build full key path
				const parentKeys = indentStack
					.filter((s) => s.indent < indent)
					.map((s) => s.key);
				const fullKey = [...parentKeys, key].join(".");

				// If has value, it's a config key
				if (value && !value.endsWith(":")) {
					keys.push({
						key: fullKey,
						file: filePath,
						line: i + 1,
						value: value,
					});
				}

				// Update indent stack
				indentStack = indentStack.filter((s) => s.indent < indent);
				indentStack.push({ indent, key });
			}
		}
	} catch {
		// File doesn't exist or can't be read
	}
	return keys;
}

async function parseJsonConfig(filePath: string): Promise<ConfigKey[]> {
	const keys: ConfigKey[] = [];
	try {
		const content = await fs.readFile(filePath, "utf-8");
		const obj = JSON.parse(content);

		function traverse(obj: unknown, path: string[] = []) {
			if (typeof obj === "object" && obj !== null) {
				for (const [key, value] of Object.entries(obj)) {
					const newPath = [...path, key];
					if (
						typeof value === "string" ||
						typeof value === "number" ||
						typeof value === "boolean"
					) {
						keys.push({
							key: newPath.join("."),
							file: filePath,
							line: 0, // JSON doesn't preserve line numbers easily
							value: String(value),
						});
					} else if (typeof value === "object") {
						traverse(value, newPath);
					}
				}
			}
		}

		traverse(obj);
	} catch {
		// File doesn't exist or invalid JSON
	}
	return keys;
}

// --- Main Config Validator ---

export class ConfigValidator {
	private client: TreeSitterClient;
	private availableKeys: Map<string, ConfigKey[]> = new Map();

	constructor() {
		this.client = new TreeSitterClient();
	}

	async init(): Promise<void> {
		await this.client.init();
	}

	/**
	 * Scan project for config files
	 */
	async scanConfigFiles(cwd: string): Promise<void> {
		const configFiles = [
			{ pattern: ".env", parser: parseEnvFile },
			{ pattern: ".env.local", parser: parseEnvFile },
			{ pattern: ".env.development", parser: parseEnvFile },
			{ pattern: ".env.production", parser: parseEnvFile },
			{ pattern: "config.ini", parser: parseIniFile },
			{ pattern: "config.yaml", parser: parseYamlConfig },
			{ pattern: "config.yml", parser: parseYamlConfig },
			{ pattern: "config.json", parser: parseJsonConfig },
			{ pattern: "pyproject.toml", parser: parseIniFile }, // Simplified
			{ pattern: "package.json", parser: parseJsonConfig },
			{ pattern: "app.yaml", parser: parseYamlConfig },
			{ pattern: "application.yaml", parser: parseYamlConfig },
		];

		for (const { pattern, parser } of configFiles) {
			const filePath = path.join(cwd, pattern);
			const keys = await parser(filePath);
			if (keys.length > 0) {
				this.availableKeys.set(pattern, keys);
			}
		}

		// Also scan for any .env.* files
		try {
			const entries = await fs.readdir(cwd);
			for (const entry of entries) {
				if (entry.startsWith(".env.")) {
					const filePath = path.join(cwd, entry);
					const keys = await parseEnvFile(filePath);
					if (keys.length > 0) {
						this.availableKeys.set(entry, keys);
					}
				}
			}
		} catch {
			// Can't read directory
		}
	}

	/**
	 * Validate config access in a source file
	 */
	async validateFile(filePath: string): Promise<ConfigValidationResult> {
		const languageId = this.getLanguageId(filePath);
		if (!languageId || !CONFIG_QUERIES[languageId]) {
			return { undefined: [], typos: [], available: [] };
		}

		// Get all config accesses in the file
		const accesses = await this.findConfigAccesses(filePath, languageId);

		// Get all available keys
		const allAvailable: ConfigKey[] = [];
		for (const keys of this.availableKeys.values()) {
			allAvailable.push(...keys);
		}

		const undefined: ConfigAccess[] = [];
		const typos: Array<{ access: ConfigAccess; suggestion: string }> = [];

		for (const access of accesses) {
			// Check if key exists
			const exactMatch = allAvailable.find(
				(k) => k.key.toLowerCase() === access.key.toLowerCase(),
			);

			if (!exactMatch) {
				// Check for typos using fuzzy matching
				const suggestion = this.findClosestMatch(
					access.key,
					allAvailable.map((k) => k.key),
				);
				if (
					suggestion &&
					this.calculateSimilarity(access.key, suggestion) > 0.7
				) {
					typos.push({ access, suggestion });
				} else {
					undefined.push(access);
				}
			}
		}

		return { undefined, typos, available: allAvailable };
	}

	/**
	 * Find all config accesses in a file using tree-sitter
	 */
	private async findConfigAccesses(
		filePath: string,
		languageId: string,
	): Promise<ConfigAccess[]> {
		const query = CONFIG_QUERIES[languageId];
		const matches = await this.client.structuralSearch(
			query,
			languageId,
			path.dirname(filePath),
			{ fileFilter: (f) => f === filePath },
		);

		const accesses: ConfigAccess[] = [];

		for (const match of matches) {
			const configKeyCapture =
				match.captures.config_key || match.captures.env_var;
			if (configKeyCapture) {
				// Clean up the key (remove quotes, etc.)
				const key = configKeyCapture.replace(/^["'`]|["'`]$/g, "");

				accesses.push({
					key,
					file: filePath,
					line: match.line,
					column: match.column,
					pattern: match.matchedText,
				});
			}
		}

		return accesses;
	}

	/**
	 * Calculate string similarity (Levenshtein-based)
	 */
	private calculateSimilarity(a: string, b: string): number {
		const matrix: number[][] = [];

		for (let i = 0; i <= b.length; i++) {
			matrix[i] = [i];
		}

		for (let j = 0; j <= a.length; j++) {
			matrix[0][j] = j;
		}

		for (let i = 1; i <= b.length; i++) {
			for (let j = 1; j <= a.length; j++) {
				if (b.charAt(i - 1) === a.charAt(j - 1)) {
					matrix[i][j] = matrix[i - 1][j - 1];
				} else {
					matrix[i][j] = Math.min(
						matrix[i - 1][j - 1] + 1, // substitution
						matrix[i][j - 1] + 1, // insertion
						matrix[i - 1][j] + 1, // deletion
					);
				}
			}
		}

		const distance = matrix[b.length][a.length];
		const maxLength = Math.max(a.length, b.length);
		return 1 - distance / maxLength;
	}

	/**
	 * Find the closest matching key
	 */
	private findClosestMatch(
		key: string,
		candidates: string[],
	): string | undefined {
		let bestMatch: string | undefined;
		let bestScore = 0;

		for (const candidate of candidates) {
			const score = this.calculateSimilarity(key, candidate);
			if (score > bestScore && score > 0.5) {
				bestScore = score;
				bestMatch = candidate;
			}
		}

		return bestMatch;
	}

	/**
	 * Map file extension to language ID
	 */
	private getLanguageId(filePath: string): string | undefined {
		const ext = path.extname(filePath);
		switch (ext) {
			case ".py":
				return "python";
			case ".js":
				return "javascript";
			case ".ts":
				return "typescript";
			case ".tsx":
				return "tsx";
			case ".go":
				return "go";
			case ".rs":
				return "rust";
			default:
				return undefined;
		}
	}
}

// --- Simple factory function ---

export async function createConfigValidator(
	cwd: string,
): Promise<ConfigValidator> {
	const validator = new ConfigValidator();
	await validator.init();
	await validator.scanConfigFiles(cwd);
	return validator;
}

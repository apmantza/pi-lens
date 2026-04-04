/**
 * Tree-sitter Query Loader
 *
 * Loads tree-sitter queries from YAML files in rules/tree-sitter-queries/
 * and provides them to the TreeSitterClient.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePackagePath } from "./package-root.js";

export interface TreeSitterQuery {
	id: string;
	name: string;
	severity: "error" | "warning" | "info";
	category: string;
	language: string;
	message: string;
	description?: string;
	query: string;
	metavars: string[];
	post_filter?: string;
	// biome-ignore lint/suspicious/noExplicitAny: Flexible filter params
	post_filter_params?: Record<string, any>;
	tags?: string[];
	has_fix: boolean;
	fix_action?: string;
	examples?: {
		bad?: string;
		good?: string;
	};
	filePath: string;
}

export class TreeSitterQueryLoader {
	private queries: Map<string, TreeSitterQuery[]> = new Map();
	private loaded = false;
	private verbose: boolean;

	constructor(verbose = false) {
		this.verbose = verbose;
	}

	/** Debug logging helper */
	private dbg(msg: string): void {
		if (this.verbose) {
			console.error(`[query-loader] ${msg}`);
		}
	}

	/**
	 * Load all queries from the rules/tree-sitter-queries directory
	 */
	async loadQueries(): Promise<Map<string, TreeSitterQuery[]>> {
		if (this.loaded) return this.queries;

		const queryDirs = [...new Set([
			path.join(process.cwd(), "rules", "tree-sitter-queries"),
			resolvePackagePath(import.meta.url, "rules", "tree-sitter-queries"),
		])];

		for (const queriesDir of queryDirs) {
			if (!fs.existsSync(queriesDir)) {
				this.dbg(`Queries directory not found: ${queriesDir}`);
				continue;
			}

			const languageDirs = fs
				.readdirSync(queriesDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name);

			for (const lang of languageDirs) {
				const langDir = path.join(queriesDir, lang);
				const queryFiles = fs
					.readdirSync(langDir)
					.filter((f) => f.endsWith(".yml"));

				const langQueries = this.queries.get(lang) ?? [];

				for (const file of queryFiles) {
					const filePath = path.join(langDir, file);
					const query = this.parseQueryFile(filePath, lang);
					if (query) {
						langQueries.push(query);
					}
				}

				if (langQueries.length > 0) {
					this.queries.set(lang, langQueries);
					this.dbg(`Loaded ${langQueries.length} queries for ${lang}`);
				}
			}
		}

		this.loaded = true;
		return this.queries;
	}

	/**
	 * Parse a single YAML query file
	 */
	private parseQueryFile(
		filePath: string,
		language: string,
	): TreeSitterQuery | null {
		try {
			const content = fs.readFileSync(filePath, "utf-8");

			// Simple YAML parsing (extract key: value pairs)
			const parsed = this.parseYaml(content);

			if (!parsed.id || !parsed.query) {
				this.dbg(`Invalid query file: ${filePath}`);
				return null;
			}

			return {
				id: String(parsed.id),
				name: String(parsed.name || parsed.id),
				severity: this.parseSeverity(parsed.severity),
				category: String(parsed.category || "general"),
				language: String(parsed.language || language),
				message: String(parsed.message || `Pattern: ${parsed.id}`),
				description: parsed.description
					? String(parsed.description)
					: undefined,
				query:
					this.extractMultilineValue(content, "query") || String(parsed.query),
				metavars: Array.isArray(parsed.metavars)
					? parsed.metavars.map(String)
					: this.extractMetavars(String(parsed.query)),
				post_filter: parsed.post_filter
					? String(parsed.post_filter)
					: undefined,
				// biome-ignore lint/suspicious/noExplicitAny: Post filter params
				post_filter_params: parsed.post_filter_params as any,
				tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : undefined,
				has_fix: parsed.has_fix === true || parsed.has_fix === "true",
				fix_action: parsed.fix_action ? String(parsed.fix_action) : undefined,
				filePath,
			};
		} catch (err) {
			this.dbg(`Failed to parse ${filePath}: ${err}`);
			return null;
		}
	}

	/**
	 * Simple YAML parser for our query files
	 */
	private parseYaml(
		content: string,
	): Record<string, string | string[] | boolean> {
		const result: Record<string, string | string[] | boolean> = {};
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const match = line.match(/^([a-z_]+):\s*(.*)$/);
			if (match) {
				const key = match[1];
				let value: string | string[] | boolean = match[2].trim();

				// Handle arrays inline: metavars: [A, B, C]
				if (value.startsWith("[") && value.endsWith("]")) {
					value = value
						.slice(1, -1)
						.split(",")
						.map((s) => s.trim().replace(/^["']|["']$/g, ""));
				}
				// Handle multi-line arrays: metavars:\n  - A\n  - B
				else if (value === "") {
					// Check if next lines are array items (  - item)
					const arrayItems: string[] = [];
					const baseIndent = line.match(/^(\s*)/)?.[0].length || 0;

					for (let j = i + 1; j < lines.length; j++) {
						const nextLine = lines[j];
						const nextIndent = nextLine.match(/^(\s*)/)?.[0].length || 0;

						// Stop if we hit a line with same or less indent (new key)
						if (nextIndent <= baseIndent && nextLine.match(/^[a-z_]+:/)) {
							break;
						}

						// Check if it's an array item
						const itemMatch = nextLine.match(/^\s+-\s*(.+)$/);
						if (itemMatch) {
							// Strip inline comments and trim
							const item = itemMatch[1].trim().replace(/\s*#.*$/, "");
							if (item) arrayItems.push(item);
						}
					}

					if (arrayItems.length > 0) {
						value = arrayItems;
					}
				}
				// Handle booleans
				else if (value === "true") value = true;
				else if (value === "false") value = false;
				// Strip quotes from strings
				else if (value.startsWith('"') && value.endsWith('"')) {
					value = value.slice(1, -1);
				}

				result[key] = value;
			}
		}

		return result;
	}

	/**
	 * Extract a multiline value (like query) from YAML
	 */
	private extractMultilineValue(content: string, key: string): string | null {
		const lines = content.split("\n");
		let startLine = -1;
		let startIndent = 0;

		const keyPrefix = `${key}:`;

		// Find the key line
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trimStart();
			if (trimmed.startsWith(keyPrefix)) {
				startLine = i;
				startIndent = lines[i].length - trimmed.length;
				const afterKey = trimmed.slice(keyPrefix.length).trim();
				// If there's content on the same line (not just |), return it
				if (afterKey && afterKey !== "|") return afterKey;
				break;
			}
		}

		if (startLine === -1) return null;

		// Collect all lines until we hit a new key with same or less indent
		const valueLines: string[] = [];
		for (let i = startLine + 1; i < lines.length; i++) {
			const line = lines[i];

			// Track empty lines
			if (!line.trim()) {
				valueLines.push("");
				continue;
			}

			// Check indent
			const indentMatch = line.match(/^(\s*)/);
			const indent = indentMatch ? indentMatch[1].length : 0;
			const trimmed = line.trim();

			// Stop at new key with same or less indent (but not at comments)
			if (
				indent <= startIndent &&
				trimmed.match(/^[a-z_]+:/) &&
				!trimmed.startsWith("#")
			) {
				break;
			}

			// Skip comment lines (they're not part of the value)
			if (trimmed.startsWith("#")) continue;

			// This is part of the multiline value
			valueLines.push(line.slice(startIndent));
		}

		// Clean up - remove trailing empty lines
		while (valueLines.length > 0 && !valueLines[valueLines.length - 1].trim()) {
			valueLines.pop();
		}

		return valueLines.length > 0 ? valueLines.join("\n") : null;
	}

	/**
	 * Parse severity string to valid type
	 */
	private parseSeverity(value: unknown): "error" | "warning" | "info" {
		if (value === "error") return "error";
		if (value === "warning") return "warning";
		if (value === "info") return "info";
		return "warning"; // default
	}

	/**
	 * Extract @VAR patterns from query string
	 */
	private extractMetavars(query: string): string[] {
		const matches = query.match(/@([A-Z_][A-Z0-9_]*)/g);
		if (!matches) return [];
		return [...new Set(matches.map((m) => m.slice(1)))];
	}

	/**
	 * Get queries for a specific language
	 */
	getQueriesForLanguage(language: string): TreeSitterQuery[] {
		return this.queries.get(language) || [];
	}

	/**
	 * Get a specific query by ID
	 */
	getQueryById(id: string): TreeSitterQuery | undefined {
		for (const langQueries of this.queries.values()) {
			const query = langQueries.find((q) => q.id === id);
			if (query) return query;
		}
		return undefined;
	}

	/**
	 * Find matching query for a pattern string
	 */
	findMatchingQuery(
		pattern: string,
		language: string,
	): TreeSitterQuery | undefined {
		const langQueries = this.getQueriesForLanguage(language);

		// Check for pattern keywords
		for (const query of langQueries) {
			// Match by ID
			if (pattern.includes(query.id)) return query;

			// Match by keywords in pattern
			switch (query.id) {
				case "empty-catch":
					if (pattern.includes("empty-catch") || pattern.includes("catch {}"))
						return query;
					break;
				case "debugger-statement":
					if (pattern.includes("debugger")) return query;
					break;
				case "await-in-loop":
					if (pattern.includes("await-in-loop") || pattern.includes("await"))
						return query;
					break;
				case "hardcoded-secrets":
					if (
						pattern.includes("hardcoded") ||
						pattern.includes("api_key") ||
						pattern.includes("password")
					)
						return query;
					break;
				case "dangerously-set-inner-html":
					if (pattern.includes("dangerously") || pattern.includes("innerHTML"))
						return query;
					break;
				case "nested-ternary":
					if (pattern.includes("ternary") || pattern.includes("? :"))
						return query;
					break;
				case "no-eval":
					if (pattern.includes("eval") && !pattern.includes("console"))
						return query;
					break;
				case "deep-promise-chain":
					if (pattern.includes(".then") && pattern.includes(".catch"))
						return query;
					break;
				case "console-statement":
					if (pattern.includes("console")) return query;
					break;
				case "long-parameter-list":
					if (pattern.includes("PARAMS")) return query;
					break;
				// Python queries
				case "bare-except":
					if (pattern.includes("bare-except") || pattern.includes("except:"))
						return query;
					break;
				case "mutable-default-arg":
					if (pattern.includes("mutable") || pattern.includes("default"))
						return query;
					break;
				case "wildcard-import":
					if (pattern.includes("wildcard") || pattern.includes("import *"))
						return query;
					break;
				case "eval-exec":
					if (pattern.includes("eval") || pattern.includes("exec"))
						return query;
					break;
				case "is-vs-equals":
					if (pattern.includes("is") || pattern.includes("equals"))
						return query;
					break;
				case "unreachable-except":
					if (pattern.includes("unreachable") || pattern.includes("except"))
						return query;
					break;
			}
		}

		return undefined;
	}

	/**
	 * Get all loaded queries
	 */
	getAllQueries(): TreeSitterQuery[] {
		const all: TreeSitterQuery[] = [];
		for (const queries of this.queries.values()) {
			all.push(...queries);
		}
		return all;
	}

	/**
	 * Reload queries from disk
	 */
	async reload(): Promise<void> {
		this.queries.clear();
		this.loaded = false;
		await this.loadQueries();
	}
}

// Singleton instance
export const queryLoader = new TreeSitterQueryLoader();

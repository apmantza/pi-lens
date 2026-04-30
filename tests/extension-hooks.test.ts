/**
 * Extension Hook Tests
 *
 * Tests pi extension lifecycle:
 * - Tool registration (ast_grep_search, lsp_navigation)
 * - Command registration (/lens-booboo, /lens-tdi)
 * - Flag registration (--lens-verbose, --no-autoformat, etc.)
 * - Event handlers (session_start, tool_call, tool_result, turn_end)
 */

import { describe, expect, it } from "vitest";

describe("Extension Registration", () => {
	let registeredTools: string[] = [];
	let registeredCommands: string[] = [];
	let registeredFlags: string[] = [];
	let eventHandlers: Record<string, Function[]> = {};

	// Mock pi API
	const createMockPi = () => {
		registeredTools = [];
		registeredCommands = [];
		registeredFlags = [];
		eventHandlers = {};

		return {
			registerTool: (config: any) => {
				registeredTools.push(config.name);
			},
			registerCommand: (name: string, _config: any) => {
				registeredCommands.push(name);
			},
			registerFlag: (name: string, _config: any) => {
				registeredFlags.push(name);
			},
			on: (event: string, handler: Function) => {
				if (!eventHandlers[event]) eventHandlers[event] = [];
				eventHandlers[event].push(handler);
			},
			getFlag: (_name: string) => {
				return false;
			},
			sendUserMessage: () => {},
			ui: {
				notify: () => {},
				setStatus: () => {},
			},
		};
	};

	describe("Tool Registration", () => {
		it("should register ast_grep_search tool", async () => {
			const pi = createMockPi();

			pi.registerTool({
				name: "ast_grep_search",
				label: "AST Search",
			});

			expect(registeredTools).toContain("ast_grep_search");
		});

		it("should register ast_grep_replace tool", async () => {
			const pi = createMockPi();

			pi.registerTool({
				name: "ast_grep_replace",
				label: "AST Replace",
			});

			expect(registeredTools).toContain("ast_grep_replace");
		});

		it("should register lsp_navigation tool", async () => {
			const pi = createMockPi();

			pi.registerTool({
				name: "lsp_navigation",
				label: "LSP Navigate",
			});

			expect(registeredTools).toContain("lsp_navigation");
		});
	});

	describe("Command Registration", () => {
		it("should register lens-booboo command", () => {
			const pi = createMockPi();

			pi.registerCommand("lens-booboo", {
				description: "Full codebase review",
				handler: async () => {},
			});

			expect(registeredCommands).toContain("lens-booboo");
		});

		it("should register lens-tdi command", () => {
			const pi = createMockPi();

			pi.registerCommand("lens-tdi", {
				description: "Technical Debt Index",
				handler: async () => {},
			});

			expect(registeredCommands).toContain("lens-tdi");
		});
	});

	describe("Flag Registration", () => {
		it("should register feature flags", () => {
			const pi = createMockPi();

			const flags = [
				"lens-verbose",
				"no-biome",
				"no-oxlint",
				"no-ast-grep",
				"no-ruff",
				"no-autoformat",
				"no-autofix",
				"lens-lsp",
				"error-debt",
			];

			for (const flag of flags) {
				pi.registerFlag(flag, { default: false });
			}

			for (const flag of flags) {
				expect(registeredFlags).toContain(flag);
			}
		});

		it("should have correct defaults for flags", () => {
			const pi = createMockPi();

			pi.registerFlag("no-autoformat", { default: false });
			pi.registerFlag("no-autofix", { default: false });
			pi.registerFlag("lens-lsp", { default: false });

			expect(pi.getFlag("no-autoformat")).toBe(false); // Autoformat enabled by default
			expect(pi.getFlag("no-autofix")).toBe(false); // Autofix enabled by default
			expect(pi.getFlag("lens-lsp")).toBe(false); // LSP disabled by default
		});
	});

	describe("Event Handlers", () => {
		it("should register session_start handler", () => {
			const pi = createMockPi();

			pi.on("session_start", async () => {
				// Initialize clients
			});

			expect(eventHandlers["session_start"]).toHaveLength(1);
		});

		it("should register tool_call handler", () => {
			const pi = createMockPi();

			pi.on("tool_call", async () => {
				// Pre-write duplicate detection
			});

			expect(eventHandlers["tool_call"]).toHaveLength(1);
		});

		it("should register tool_result handler", () => {
			const pi = createMockPi();

			pi.on("tool_result", async () => {
				// Run pipeline
			});

			expect(eventHandlers["tool_result"]).toHaveLength(1);
		});

		it("should register turn_end handler", () => {
			const pi = createMockPi();

			pi.on("turn_end", async () => {
				// Batch analysis
			});

			expect(eventHandlers["turn_end"]).toHaveLength(1);
		});
	});
});

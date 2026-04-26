import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const tryLazyInstall = vi.fn(async () => true);
const supportsLSP = vi.fn();
const hasLSP = vi.fn();
const openFile = vi.fn();
const getDiagnostics = vi.fn();
const codeAction = vi.fn();
const readFileContent = vi.fn(() => "const x = 1;\n");

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock("../../../../clients/dispatch/runners/utils/lazy-installer.js", () => ({
	tryLazyInstall,
}));

vi.mock("../../../../clients/lsp/index.js", () => ({
	getLSPService: () => ({
		supportsLSP,
		hasLSP,
		openFile,
		getDiagnostics,
		codeAction,
		getClientForFile: vi.fn(),
	}),
}));

vi.mock("../../../../clients/dispatch/runners/utils.js", () => ({
	readFileContent,
}));

function ctx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "jsts",
		pi: {
			getFlag: (name: string) => name === "lens-lsp",
		},
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("runner status/semantic edge cases", () => {
	beforeEach(() => {
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		tryLazyInstall.mockClear();
		supportsLSP.mockReset();
		hasLSP.mockReset();
		openFile.mockReset();
		getDiagnostics.mockReset();
		codeAction.mockReset();
		readFileContent.mockReset();
		readFileContent.mockReturnValue("const x = 1;\n");
		supportsLSP.mockReturnValue(true);
	});

	it("golangci-lint returns failed/blocking for error diagnostics", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/golangci-lint.js")
		).default;
		const env = setupTestEnvironment("pi-lens-go-");
		try {
			const filePath = path.join(env.tmpDir, "main.go");
			fs.writeFileSync(
				path.join(env.tmpDir, ".golangci.yml"),
				"run:\n  timeout: 1m\n",
			);
			fs.writeFileSync(filePath, "package main\n");

			safeSpawn.mockReturnValueOnce({
				error: null,
				status: 0,
				stdout: "ok",
				stderr: "",
			});
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					Issues: [
						{
							FromLinter: "govet",
							Text: "suspicious",
							Severity: "error",
							Pos: { Filename: filePath, Line: 2, Column: 1 },
						},
					],
				}),
				stderr: "",
			});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
		} finally {
			env.cleanup();
		}
	});

	it("rust-clippy returns warning semantic for non-parseable output", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/rust-clippy.js")
		).default;
		const env = setupTestEnvironment("pi-lens-rs-");
		try {
			const cargoToml = path.join(env.tmpDir, "Cargo.toml");
			const filePath = path.join(env.tmpDir, "src", "main.rs");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(cargoToml, "[package]\nname='demo'\nversion='0.1.0'\n");
			fs.writeFileSync(filePath, "fn main() {}\n");

			safeSpawnAsync
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "cargo",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "clippy",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout: "cargo clippy failed without json",
					stderr: "",
				});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});

	it("rubocop returns failed/blocking for error offenses", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/rubocop.js")
		).default;
		const env = setupTestEnvironment("pi-lens-rb-");
		try {
			const filePath = path.join(env.tmpDir, "main.rb");
			fs.writeFileSync(filePath, "puts 'hi'\n");

			safeSpawnAsync
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "rubocop",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout: JSON.stringify({
						files: [
							{
								path: filePath,
								offenses: [
									{
										severity: "error",
										message: "Style/SomeCop",
										cop_name: "Style/SomeCop",
										correctable: true,
										location: { line: 1, column: 1 },
									},
								],
							},
						],
					}),
					stderr: "",
				});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner returns warning semantic when server open fails", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			hasLSP.mockResolvedValue(true);
			openFile.mockRejectedValue(new Error("connection failed"));
			getDiagnostics.mockResolvedValue([]);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.message).toContain("LSP server failed");
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner surfaces codeAction guidance for blocking diagnostics", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-fix-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const a: string = 1;\n");

			hasLSP.mockResolvedValue(true);
			openFile.mockResolvedValue(undefined);
			getDiagnostics.mockResolvedValue([
				{
					severity: 1,
					message: "Type 'number' is not assignable to type 'string'.",
					range: {
						start: { line: 0, character: 6 },
						end: { line: 0, character: 7 },
					},
					code: "2322",
				},
			]);
			codeAction.mockResolvedValue([
				{ title: "Change type of 'a' to 'number'", kind: "quickfix" },
				{ title: "Convert number to string", kind: "quickfix" },
			]);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.fixable).toBe(true);
			expect(result.diagnostics[0]?.fixSuggestion).toContain(
				"LSP quick fixes:",
			);
			expect(result.diagnostics[0]?.fixSuggestion).toContain(
				"Change type of 'a' to 'number'",
			);
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner ignores refactor-only code actions for fix guidance", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-refactor-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const a: string = 1;\n");

			hasLSP.mockResolvedValue(true);
			openFile.mockResolvedValue(undefined);
			getDiagnostics.mockResolvedValue([
				{
					severity: 1,
					message: "Type 'number' is not assignable to type 'string'.",
					range: {
						start: { line: 0, character: 6 },
						end: { line: 0, character: 7 },
					},
					code: "2322",
				},
			]);
			codeAction.mockResolvedValue([
				{ title: "Move to a new file", kind: "refactor.move.newFile" },
			]);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.fixable).toBe(false);
			expect(result.diagnostics[0]?.fixSuggestion).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

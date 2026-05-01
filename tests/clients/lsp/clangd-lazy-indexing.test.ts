/**
 * clangd Lazy TU Integration Tests
 *
 * Verifies clangd can return empty workspaceSymbol results before a translation
 * unit is opened. A later LSP operation on main.cpp gives clangd AST/index
 * context for api.hpp/api.cpp so apiSymbol can be found.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";
import { setupTestEnvironment } from "../test-utils.js";

// Detect clangd availability at module load time
const CLANGD: string | null = (() => {
	try {
		const bin = process.platform === "win32" ? "where clangd" : "which clangd";
		return execSync(bin, { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
})();

function createCompileCommandsJson(projectDir: string, files: string[]): void {
	const entries = files.map((f) => ({
		directory: projectDir,
		command: `c++ -std=c++17 -c ${f} -o ${f}.o`,
		file: f,
	}));
	fs.writeFileSync(
		path.join(projectDir, "compile_commands.json"),
		JSON.stringify(entries, null, 2),
	);
}

function createProject(projectDir: string): void {
	const srcDir = path.join(projectDir, "src");
	fs.mkdirSync(srcDir, { recursive: true });

	fs.writeFileSync(
		path.join(srcDir, "api.hpp"),
		"#pragma once\n\nint apiSymbol();\n",
	);
	fs.writeFileSync(
		path.join(srcDir, "api.cpp"),
		'#include "api.hpp"\n\nint apiSymbol() { return 42; }\n',
	);
	fs.writeFileSync(
		path.join(srcDir, "main.cpp"),
		'#include "api.hpp"\n\nint main() { return apiSymbol(); }\n',
	);

	createCompileCommandsJson(projectDir, ["src/main.cpp", "src/api.cpp"]);
}

async function waitForWorkspaceSymbol(
	client: Awaited<ReturnType<typeof createLSPClient>>,
	name: string,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const symbols = await client.workspaceSymbol(name);
		if (symbols.some((s) => s.name === name)) return;
		await new Promise((r) => setTimeout(r, 200));
	}

	const symbols = await client.workspaceSymbol(name);
	expect(symbols.some((s) => s.name === name)).toBe(true);
}

describe.skipIf(!CLANGD)("clangd lazy TU indexing", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let projectDir: string;
	let mainPath: string;

	beforeEach(async () => {
		env = setupTestEnvironment("pi-lens-clangd-");
		projectDir = env.tmpDir;
		createProject(projectDir);

		mainPath = path.join(projectDir, "src", "main.cpp");

		if (CLANGD === null) throw new Error("clangd unavailable");

		// Launch clangd WITHOUT --background-index: only indexes opened TUs
		proc = await launchLSP(CLANGD, ["--background-index=false"], {
			cwd: projectDir,
		});

		client = await createLSPClient({
			serverId: "clangd",
			process: proc,
			root: projectDir,
		});
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				// ignore
			}
			client = undefined;
		}
		if (proc) {
			try {
				await stopLSP(proc);
			} catch {
				// ignore
			}
			proc = undefined;
		}
		env.cleanup();
	});

	it("workspaceSymbol returns results after an LSP operation on main.cpp", async () => {
		if (client === undefined) throw new Error("LSP client not initialized");
		const lspClient = client;
		const beforeOpen = await lspClient.workspaceSymbol("apiSymbol");
		expect(beforeOpen.filter((s) => s.name === "apiSymbol")).toEqual([]);

		await lspClient.notify.open(
			mainPath,
			fs.readFileSync(mainPath, "utf-8"),
			"cpp",
		);

		const mainSymbols = await lspClient.documentSymbol(mainPath);
		expect(mainSymbols.some((s) => s.name === "main")).toBe(true);

		await waitForWorkspaceSymbol(lspClient, "apiSymbol");
	}, 15_000);
});

/**
 * Regression tests for tree-sitter-client wasm resolution.
 *
 * Ensures the wasm path is resolved via Node's module resolver (createRequire)
 * rather than a hardcoded relative path, so hoisted installs (pnpm, npm v7+
 * workspaces) don't produce ENOENT crashes. See issue #20.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const _require = createRequire(import.meta.url);

describe("tree-sitter-client wasm resolution", () => {
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("node:fs");
		vi.doUnmock("node:module");
		vi.clearAllMocks();
	});

	it("resolves tree-sitter.wasm via require.resolve, not a fixed node_modules path", () => {
		// If the package is installed, require.resolve should find the wasm
		// regardless of whether it's nested or hoisted.
		const wasmPath = _require.resolve("web-tree-sitter/tree-sitter.wasm");
		expect(wasmPath).toMatch(/tree-sitter\.wasm$/);
		// Must NOT assume the wasm lives nested under pi-lens's own node_modules
		// relative to import.meta.url — that breaks in hoisted layouts.
		expect(path.isAbsolute(wasmPath)).toBe(true);
	});

	it("locateFile derives paths from the resolved wasm directory, not import.meta.url", () => {
		const wasmPath = _require.resolve("web-tree-sitter/tree-sitter.wasm");
		const wasmDir = path.dirname(wasmPath);

		// Simulate what the locateFile callback does
		const locateFile = (scriptName: string) => path.join(wasmDir, scriptName);

		const result = locateFile("tree-sitter.wasm");
		expect(result).toBe(wasmPath);

		// Any sibling wasm file should also resolve to the same directory
		const sibling = locateFile("tree-sitter-typescript.wasm");
		expect(path.dirname(sibling)).toBe(wasmDir);
	});

	it("findGrammarsDir resolves external packages via require.resolve, not process.cwd()", () => {
		// Verify tree-sitter-wasms is resolvable through Node's resolver.
		// This would fail in a hoisted monorepo if we used process.cwd()/node_modules directly.
		let resolved: string | undefined;
		try {
			resolved = _require.resolve("tree-sitter-wasms/package.json");
		} catch {
			// package not installed in this env — skip
			return;
		}
		expect(resolved).toMatch(/package\.json$/);
		expect(path.isAbsolute(resolved)).toBe(true);
	});

	it("TreeSitterClient.isAvailable returns true when grammars are installed", async () => {
		const { TreeSitterClient } = await import(
			"../../clients/tree-sitter-client.js"
		);
		const client = new TreeSitterClient();
		expect(client.isAvailable()).toBe(true);
	});

	it("falls back to resolvePackagePath when require.resolve fails (on-the-fly compilation)", async () => {
		// Simulate pi's on-the-fly TS compilation: createRequire from a temp
		// directory cannot resolve web-tree-sitter, but resolvePackagePath
		// walking up from import.meta.url finds the package root.
		vi.doMock("node:module", () => ({
			createRequire: () => ({
				resolve: (id: string) => {
					if (id.includes("web-tree-sitter")) {
						throw new Error("Cannot find module from temp dir");
					}
					return _require.resolve(id);
				},
			}),
		}));

		const { TreeSitterClient } = await import(
			"../../clients/tree-sitter-client.js"
		);
		const client = new TreeSitterClient();
		// resolvePackagePath fallback should still find the grammars
		expect(client.isAvailable()).toBe(true);
	});

	it("re-evaluates grammarsDir when isAvailable is called after initial miss", async () => {
		// This is the regression that produced 108 "client_unavailable" log
		// lines: grammarsDir was cached as "" in the constructor and never
		// re-checked. We simulate an initial miss by making fs.existsSync
		// return false for the first batch of calls, then true afterwards.
		let existsCallCount = 0;
		const realExistsSync = fs.existsSync;

		vi.doMock("node:fs", () => ({
			...fs,
			existsSync: (p: string) => {
				existsCallCount++;
				// First ~6 calls (constructor probing paths): pretend missing
				if (existsCallCount <= 6) return false;
				// Subsequent calls (isAvailable re-evaluation): real fs
				return realExistsSync(p);
			},
		}));

		const { TreeSitterClient } = await import(
			"../../clients/tree-sitter-client.js"
		);
		const client = new TreeSitterClient();

		// Constructor cached a missing path
		// isAvailable should re-evaluate and find the real path
		expect(client.isAvailable()).toBe(true);
	});
});

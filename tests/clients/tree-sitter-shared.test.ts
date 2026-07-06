import { afterEach, describe, expect, it } from "vitest";
import {
	_resetSharedTreeSitterClientForTests,
	getSharedTreeSitterClient,
	isTreeSitterWasmAborted,
	markTreeSitterWasmAborted,
	resolveTreeSitterLanguage,
} from "../../clients/tree-sitter-shared.js";

afterEach(() => {
	_resetSharedTreeSitterClientForTests();
});

describe("resolveTreeSitterLanguage", () => {
	it.each([
		[".ts", "typescript"],
		[".mts", "typescript"],
		[".cts", "typescript"],
		[".tsx", "tsx"], // JSX-capable grammar (differs from the scanner's query-keyed map)
		[".js", "javascript"],
		[".mjs", "javascript"],
		[".cjs", "javascript"],
		[".jsx", "javascript"],
		[".py", "python"],
		[".go", "go"],
		[".rs", "rust"],
		[".rb", "ruby"],
		[".c", "c"],
		[".cpp", "cpp"],
		[".cs", "csharp"],
		[".php", "php"],
		[".css", "css"],
	])("maps %s -> %s", (ext, lang) => {
		expect(resolveTreeSitterLanguage(`src/file${ext}`)).toBe(lang);
	});

	it("is case-insensitive on the extension", () => {
		expect(resolveTreeSitterLanguage("SRC/FILE.TS")).toBe("typescript");
	});

	it("returns undefined for unsupported extensions", () => {
		expect(resolveTreeSitterLanguage("file.md")).toBeUndefined();
		expect(resolveTreeSitterLanguage("file")).toBeUndefined();
	});
});

describe("shared TreeSitterClient singleton", () => {
	it("returns the same instance across calls (one client per process)", () => {
		const a = getSharedTreeSitterClient();
		const b = getSharedTreeSitterClient();
		expect(a).not.toBeNull();
		expect(a).toBe(b);
	});

	it("poisons the singleton after a wasm abort (process-wide skip)", () => {
		expect(isTreeSitterWasmAborted()).toBe(false);
		expect(getSharedTreeSitterClient()).not.toBeNull();

		markTreeSitterWasmAborted();

		expect(isTreeSitterWasmAborted()).toBe(true);
		// Every consumer now gets null and must skip tree-sitter work.
		expect(getSharedTreeSitterClient()).toBeNull();
	});

	it("test reset restores a fresh, usable singleton", () => {
		markTreeSitterWasmAborted();
		expect(getSharedTreeSitterClient()).toBeNull();

		_resetSharedTreeSitterClientForTests();

		expect(isTreeSitterWasmAborted()).toBe(false);
		expect(getSharedTreeSitterClient()).not.toBeNull();
	});
});

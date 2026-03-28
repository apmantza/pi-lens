/**
 * Tests for file-kinds.ts
 * Centralized file type detection
 */

import { describe, expect, it } from "vitest";
import {
	detectFileKind,
	getExtensionsForKind,
	getFileKindLabel,
	getLanguageId,
	isCodeKind,
	isConfigKind,
	isFileKind,
	isScannableFile,
} from "./file-kinds.js";

describe("detectFileKind", () => {
	it("should detect JavaScript/TypeScript files", () => {
		expect(detectFileKind("src/app.ts")).toBe("jsts");
		expect(detectFileKind("src/app.tsx")).toBe("jsts");
		expect(detectFileKind("src/app.js")).toBe("jsts");
		expect(detectFileKind("src/app.jsx")).toBe("jsts");
		expect(detectFileKind("src/app.mjs")).toBe("jsts");
		expect(detectFileKind("src/app.cjs")).toBe("jsts");
	});

	it("should detect Python files", () => {
		expect(detectFileKind("app.py")).toBe("python");
		expect(detectFileKind("tests/test_app.py")).toBe("python");
	});

	it("should detect Go files", () => {
		expect(detectFileKind("main.go")).toBe("go");
		expect(detectFileKind("pkg/utils.go")).toBe("go");
	});

	it("should detect Rust files", () => {
		expect(detectFileKind("main.rs")).toBe("rust");
		expect(detectFileKind("lib/app.rs")).toBe("rust");
	});

	it("should detect C++ files", () => {
		expect(detectFileKind("main.cpp")).toBe("cxx");
		expect(detectFileKind("header.hpp")).toBe("cxx");
		expect(detectFileKind("file.cc")).toBe("cxx");
		expect(detectFileKind("file.hxx")).toBe("cxx");
	});

	it("should detect CMake files", () => {
		expect(detectFileKind("CMakeLists.txt")).toBe("cmake");
		expect(detectFileKind("build.cmake")).toBe("cmake");
	});

	it("should detect Shell files", () => {
		expect(detectFileKind("script.sh")).toBe("shell");
		expect(detectFileKind("script.bash")).toBe("shell");
		expect(detectFileKind("Makefile")).toBe("shell");
	});

	it("should detect JSON files", () => {
		expect(detectFileKind("config.json")).toBe("json");
		expect(detectFileKind("package.json")).toBe("json");
	});

	it("should detect Markdown files", () => {
		expect(detectFileKind("README.md")).toBe("markdown");
		expect(detectFileKind("docs/guide.mdx")).toBe("markdown");
	});

	it("should detect CSS files", () => {
		expect(detectFileKind("style.css")).toBe("css");
		expect(detectFileKind("style.scss")).toBe("css");
		expect(detectFileKind("style.less")).toBe("css");
	});

	it("should detect YAML files", () => {
		expect(detectFileKind("config.yaml")).toBe("yaml");
		expect(detectFileKind("config.yml")).toBe("yaml");
	});

	it("should return undefined for unknown extensions", () => {
		expect(detectFileKind("file.xyz")).toBeUndefined();
		expect(detectFileKind("file")).toBeUndefined();
	});

	it("should handle case-insensitive extensions", () => {
		expect(detectFileKind("file.TS")).toBe("jsts");
		expect(detectFileKind("file.PY")).toBe("python");
	});

	it("should handle paths with special characters", () => {
		expect(detectFileKind("/path/to/file.ts")).toBe("jsts");
		expect(detectFileKind("C:\\path\\to\\file.py")).toBe("python");
	});
});

describe("isFileKind", () => {
	it("should check single file kind", () => {
		expect(isFileKind("app.ts", "jsts")).toBe(true);
		expect(isFileKind("app.py", "jsts")).toBe(false);
	});

	it("should check multiple file kinds", () => {
		expect(isFileKind("app.ts", ["jsts", "python"])).toBe(true);
		expect(isFileKind("app.py", ["jsts", "python"])).toBe(true);
		expect(isFileKind("app.go", ["jsts", "python"])).toBe(false);
	});

	it("should return false for undefined file kind", () => {
		expect(isFileKind("file.xyz", "jsts")).toBe(false);
		expect(isFileKind("file.xyz", ["jsts", "python"])).toBe(false);
	});
});

describe("isCodeKind", () => {
	it("should identify code file kinds", () => {
		expect(isCodeKind("jsts")).toBe(true);
		expect(isCodeKind("python")).toBe(true);
		expect(isCodeKind("go")).toBe(true);
		expect(isCodeKind("rust")).toBe(true);
		expect(isCodeKind("cxx")).toBe(true);
		expect(isCodeKind("shell")).toBe(true);
	});

	it("should reject non-code file kinds", () => {
		expect(isCodeKind("json")).toBe(false);
		expect(isCodeKind("markdown")).toBe(false);
		expect(isCodeKind("css")).toBe(false);
	});
});

describe("isConfigKind", () => {
	it("should identify config file kinds", () => {
		expect(isConfigKind("json")).toBe(true);
		expect(isConfigKind("yaml")).toBe(true);
		expect(isConfigKind("markdown")).toBe(true);
		expect(isConfigKind("css")).toBe(true);
	});

	it("should reject non-config file kinds", () => {
		expect(isConfigKind("jsts")).toBe(false);
		expect(isConfigKind("python")).toBe(false);
		expect(isConfigKind("go")).toBe(false);
	});
});

describe("isScannableFile", () => {
	it("should return true for code files", () => {
		expect(isScannableFile("app.ts")).toBe(true);
		expect(isScannableFile("app.py")).toBe(true);
	});

	it("should return true for config files", () => {
		expect(isScannableFile("config.json")).toBe(true);
		expect(isScannableFile("README.md")).toBe(true);
	});

	it("should return false for test files", () => {
		expect(isScannableFile("app.test.ts")).toBe(false);
		expect(isScannableFile("app.spec.ts")).toBe(false);
		expect(isScannableFile("test-app.ts")).toBe(false);
	});

	it("should return false for unknown extensions", () => {
		expect(isScannableFile("file.xyz")).toBe(false);
	});
});

describe("getLanguageId", () => {
	it("should return correct language IDs", () => {
		expect(getLanguageId("jsts")).toBe("typescript");
		expect(getLanguageId("python")).toBe("python");
		expect(getLanguageId("go")).toBe("go");
		expect(getLanguageId("rust")).toBe("rust");
		expect(getLanguageId("cxx")).toBe("cpp");
		expect(getLanguageId("json")).toBe("json");
	});

	it("should return plaintext for unknown kinds", () => {
		expect(getLanguageId("unknown" as any)).toBe("plaintext");
	});
});

describe("getExtensionsForKind", () => {
	it("should return extensions for jsts", () => {
		const exts = getExtensionsForKind("jsts");
		expect(exts).toContain(".ts");
		expect(exts).toContain(".tsx");
		expect(exts).toContain(".js");
		expect(exts).toContain(".jsx");
	});

	it("should return extensions for python", () => {
		const exts = getExtensionsForKind("python");
		expect(exts).toEqual([".py"]);
	});
});

describe("getFileKindLabel", () => {
	it("should return human-readable labels", () => {
		expect(getFileKindLabel("jsts")).toBe("JavaScript/TypeScript");
		expect(getFileKindLabel("python")).toBe("Python");
		expect(getFileKindLabel("cxx")).toBe("C/C++");
	});

	it("should return kind as fallback", () => {
		expect(getFileKindLabel("unknown" as any)).toBe("unknown");
	});
});

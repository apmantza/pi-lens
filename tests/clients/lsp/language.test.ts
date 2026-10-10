import { describe, expect, it } from "vitest";
import { getLanguageId } from "../../../clients/lsp/language.js";

describe("lsp language mapping", () => {
	it("resolves extension-based language ids", () => {
		expect(getLanguageId("src/main.ts")).toBe("typescript");
		expect(getLanguageId("src/script.sh")).toBe("shellscript");
		expect(getLanguageId("src/config.fish")).toBe("fish");
		expect(getLanguageId("cmake/helpers.cmake")).toBe("cmake");
		expect(getLanguageId("src/Main.lean")).toBe("lean");
	});

	it("resolves basename-only language ids", () => {
		expect(getLanguageId("Dockerfile")).toBe("dockerfile");
		expect(getLanguageId("infra/Dockerfile")).toBe("dockerfile");
		expect(getLanguageId("CMakeLists.txt")).toBe("cmake");
		expect(getLanguageId("src/CMakeLists.txt")).toBe("cmake");
	});

	it("returns undefined when no mapping exists", () => {
		expect(getLanguageId("README")).toBeUndefined();
	});
});

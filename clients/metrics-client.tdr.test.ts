import { describe, expect, test } from "vitest";
import type { Diagnostic } from "./dispatch/types.js";
import {
	convertDiagnosticsToTDREntries,
	type TDREntry,
} from "./metrics-client.js";

describe("TDR conversion", () => {
	test("converts type errors to TDR entries", () => {
		const diagnostics: Diagnostic[] = [
			{
				id: "ts-lsp:TS2345:10",
				message: "Argument of type 'string' is not assignable",
				filePath: "/test/file.ts",
				line: 10,
				column: 5,
				severity: "error",
				semantic: "blocking",
				tool: "ts-lsp",
				rule: "TS2345",
				tdrCategory: "type_errors",
			},
		];

		const entries = convertDiagnosticsToTDREntries(diagnostics);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			category: "type_errors",
			count: 1,
			severity: "error",
		});
	});

	test("groups multiple diagnostics by category", () => {
		const diagnostics: Diagnostic[] = [
			{
				id: "1",
				message: "Type error 1",
				filePath: "/test.ts",
				severity: "error",
				semantic: "blocking",
				tool: "ts-lsp",
				tdrCategory: "type_errors",
			},
			{
				id: "2",
				message: "Type error 2",
				filePath: "/test.ts",
				severity: "error",
				semantic: "blocking",
				tool: "ts-lsp",
				tdrCategory: "type_errors",
			},
			{
				id: "3",
				message: "Security issue",
				filePath: "/test.ts",
				severity: "error",
				semantic: "blocking",
				tool: "ast-grep-napi",
				tdrCategory: "security",
			},
		];

		const entries = convertDiagnosticsToTDREntries(diagnostics);

		expect(entries).toHaveLength(2);
		expect(entries.find((e) => e.category === "type_errors")?.count).toBe(2);
		expect(entries.find((e) => e.category === "security")?.count).toBe(1);
	});

	test("auto-categorizes diagnostics without tdrCategory", () => {
		const diagnostics: Diagnostic[] = [
			{
				id: "1",
				message: "Unused variable",
				filePath: "/test.ts",
				severity: "warning",
				semantic: "warning",
				tool: "biome",
				rule: "no-unused",
			},
		];

		const entries = convertDiagnosticsToTDREntries(diagnostics);

		expect(entries).toHaveLength(1);
		expect(entries[0].category).toBe("dead_code");
	});
});

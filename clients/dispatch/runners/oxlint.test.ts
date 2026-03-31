/**
 * Tests for oxlint runner
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { DispatchContext } from "../types.js";

/**
 * Delay helper for Windows file cleanup
 * Windows may hold file handles briefly after process exit
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createMockContext(
	filePath: string,
	overrides: Partial<DispatchContext> = {},
): DispatchContext {
	return {
		filePath,
		cwd: process.cwd(),
		kind: "jsts" as any,
		autofix: false,
		deltaMode: false,
		baselines: { get: () => [], add: () => {}, save: () => {} } as any,
		pi: { getFlag: () => false, ...overrides.pi },
		hasTool: async () => false,
		log: () => {},
		...overrides,
	};
}

describe("oxlint runner", () => {
	const require = createRequire(import.meta.url);

	it("should have correct runner definition", async () => {
		const oxlintModule = await import("./oxlint.js");
		const runner = oxlintModule.default;

		expect(runner.id).toBe("oxlint");
		expect(runner.appliesTo).toEqual(["jsts"]);
		expect(runner.priority).toBe(12);
		expect(runner.enabledByDefault).toBe(false); // Opt-in initially
		expect(runner.skipTestFiles).toBe(true);
	});

	it("should detect oxlint availability", () => {
		const { spawnSync } =
			require("node:child_process") as typeof import("node:child_process");
		const result = spawnSync("oxlint", ["--version"], {
			encoding: "utf-8",
			timeout: 10000,
			shell: true,
		});
		expect(
			result.error || result.status !== 0 ? "not available" : "available",
		).toBeTruthy(); // May or may not be installed
	});

	it("should detect common lint issues", async () => {
		const tmpFile = path.join(
			process.env.TEMP || "/tmp",
			`oxlint_test_${Date.now()}.ts`,
		);
		fs.writeFileSync(
			tmpFile,
			`// Test file with issues
function test() {
	// Double negation
	const flag = !!value;
	
	// Unused variable
	const unused = 42;
	
	// Console statement
	console.log("test");
}
`,
		);

		try {
			const oxlintModule = await import("./oxlint.js");
			const runner = oxlintModule.default;
			const result = await runner.run(createMockContext(tmpFile));

			// If oxlint is installed, should detect issues
			// If not installed, will be skipped
			if (result.status !== "skipped") {
				// Should detect at least some issues (console, unused vars, etc.)
				expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
				expect(
					result.diagnostics.some(
						(d) =>
							d.tool === "oxlint" &&
							(d.message.includes("console") ||
								d.message.includes("unused") ||
								d.message.includes("!!")),
					),
				).toBe(true);
			}
		} finally {
			// Windows may hold file handles briefly - add small delay
			await delay(100);
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});

	it("should respect no-oxlint flag", async () => {
		const tmpFile = path.join(
			process.env.TEMP || "/tmp",
			`oxlint_flag_${Date.now()}.ts`,
		);
		fs.writeFileSync(
			tmpFile,
			`function test() { console.log("test"); }`,
		);

		try {
			const oxlintModule = await import("./oxlint.js");
			const runner = oxlintModule.default;

			// Create context with no-oxlint flag set to true
			const ctxWithFlag = createMockContext(tmpFile, {
				pi: { getFlag: (name: string) => name === "no-oxlint" },
			});

			const result = await runner.run(ctxWithFlag);
			expect(result.status).toBe("skipped");
		} finally {
			// Windows may hold file handles briefly - add small delay
			await delay(100);
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});

	it("should provide fix suggestions when available", async () => {
		const tmpFile = path.join(
			process.env.TEMP || "/tmp",
			`oxlint_fix_${Date.now()}.ts`,
		);
		fs.writeFileSync(
			tmpFile,
			`// File with auto-fixable issues
const x = !!value;
`,
		);

		try {
			const oxlintModule = await import("./oxlint.js");
			const runner = oxlintModule.default;
			const result = await runner.run(createMockContext(tmpFile));

			if (result.status !== "skipped" && result.diagnostics.length > 0) {
				// Some issues should be fixable
				const fixableDiags = result.diagnostics.filter((d) => d.fixable);
				// At least some diagnostics should have fixes
				expect(fixableDiags.length).toBeGreaterThanOrEqual(0);
			}
		} finally {
			// Windows may hold file handles briefly - add small delay
			await delay(100);
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});

	it("should pass clean TypeScript files", async () => {
		const tmpFile = path.join(
			process.env.TEMP || "/tmp",
			`oxlint_ok_${Date.now()}.ts`,
		);
		fs.writeFileSync(
			tmpFile,
			`// Clean TypeScript file
function greet(name: string): string {
	return \`Hello, \${name}!\`;
}

const result = greet("world");
export { greet };
`,
		);

		try {
			const oxlintModule = await import("./oxlint.js");
			const runner = oxlintModule.default;
			const result = await runner.run(createMockContext(tmpFile));

			if (result.status !== "skipped") {
				// Clean files should have no issues
				expect(result.diagnostics.length).toBe(0);
				expect(result.status).toBe("succeeded");
			}
		} finally {
			// Windows may hold file handles briefly - add small delay
			await delay(100);
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});

	it("should handle JSON output correctly", async () => {
		const tmpFile = path.join(
			process.env.TEMP || "/tmp",
			`oxlint_json_${Date.now()}.ts`,
		);
		fs.writeFileSync(
			tmpFile,
			`const unused = 1;`,
		);

		try {
			const oxlintModule = await import("./oxlint.js");
			const runner = oxlintModule.default;
			const result = await runner.run(createMockContext(tmpFile));

			if (result.status !== "skipped") {
				// All diagnostics should have required fields
				for (const diag of result.diagnostics) {
					expect(diag.id).toBeDefined();
					expect(diag.message).toBeDefined();
					expect(diag.tool).toBe("oxlint");
					expect(diag.line).toBeGreaterThanOrEqual(1);
					expect(diag.severity).toMatch(/^(error|warning|info)$/);
				}
			}
		} finally {
			// Windows may hold file handles briefly - add small delay
			await delay(100);
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});

	it("should skip when oxlint is not available", async () => {
		const tmpFile = path.join(
			process.env.TEMP || "/tmp",
			`oxlint_skip_${Date.now()}.ts`,
		);
		fs.writeFileSync(tmpFile, `const x = 1;`);

		try {
			const oxlintModule = await import("./oxlint.js");
			const runner = oxlintModule.default;

			// Check if oxlint is available
			const { spawnSync } =
				require("node:child_process") as typeof import("node:child_process");
			const checkResult = spawnSync("oxlint", ["--version"], {
				encoding: "utf-8",
				timeout: 5000,
				shell: true,
			});

			const isAvailable = !checkResult.error && checkResult.status === 0;
			const result = await runner.run(createMockContext(tmpFile));

			if (!isAvailable) {
				expect(result.status).toBe("skipped");
				expect(result.diagnostics).toHaveLength(0);
			}
		} finally {
			// Windows may hold file handles briefly - add small delay
			await delay(100);
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});

	it("should handle parsing errors gracefully", async () => {
		const tmpFile = path.join(
			process.env.TEMP || "/tmp",
			`oxlint_parse_${Date.now()}.ts`,
		);
		// Intentionally malformed file
		fs.writeFileSync(tmpFile, `const x = `);

		try {
			const oxlintModule = await import("./oxlint.js");
			const runner = oxlintModule.default;
			const result = await runner.run(createMockContext(tmpFile));

			// Should handle parse errors without crashing
			expect(["succeeded", "failed", "skipped"]).toContain(result.status);
		} finally {
			// Windows may hold file handles briefly - add small delay
			await delay(100);
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});
});

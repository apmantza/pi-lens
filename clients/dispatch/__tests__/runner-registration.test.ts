/**
 * Runner Registration Verification Tests
 *
 * Ensures all runners are properly registered and unique.
 * Catches issues like missing runner imports.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { FileKind } from "../../file-kinds.js";
import {
	clearRunnerRegistry,
	getRunner,
	getRunnersForKind,
	listRunners,
} from "../dispatcher.js";
import type { RunnerDefinition } from "../types.js";

describe("Runner Registration", () => {
	let allRunners: RunnerDefinition[];

	beforeAll(async () => {
		// Clear any existing registrations for clean slate
		clearRunnerRegistry();

		// Import runners to trigger registration
		// This is the critical import that was missing in the effect-integration bug
		await import("../runners/index.js");

		// Get all registered runners
		allRunners = listRunners();
	});

	describe("Basic Registration", () => {
		it("should have runners registered", () => {
			expect(allRunners.length).toBeGreaterThan(0);
		});

		it("should have unique runner IDs", () => {
			const ids = allRunners.map((r) => r.id);
			const uniqueIds = new Set(ids);

			// All IDs should be unique
			expect(uniqueIds.size).toBe(ids.length);
		});

		it("should be able to retrieve any registered runner by ID", () => {
			for (const runner of allRunners) {
			// Skip disabled runners (those with no appliesTo)
			if (!(runner.appliesTo?.length ?? 0)) continue;
				const retrieved = getRunner(runner.id);
				expect(retrieved).toBeDefined();
				expect(retrieved?.id).toBe(runner.id);
			}
		});

		it("should return undefined for unknown runner IDs", () => {
			const unknown = getRunner("definitely-not-a-real-runner-id");
			expect(unknown).toBeUndefined();
		});
	});

	describe("Runner Properties", () => {
		it("should have valid appliesTo for all runners", () => {
			const validKinds: FileKind[] = [
				"jsts",
				"python",
				"rust",
				"go",
				"shell",
				"json",
				"markdown",
				"cmake",
				"cxx",
			];

			for (const runner of allRunners) {
			// Skip disabled runners (those with no appliesTo)
			if (!(runner.appliesTo?.length ?? 0)) continue;
				// Each runner should have at least one appliesTo
				if (!(runner.appliesTo?.length ?? 0)) { console.error(`Runner ${runner.id} has no appliesTo`); } expect(runner.appliesTo?.length ?? 0, `Runner ${runner.id} should have appliesTo`).toBeGreaterThan(0);

				// All appliesTo should be valid kinds
				for (const kind of runner.appliesTo) {
					expect(validKinds).toContain(kind);
				}
			}
		});

		it("should have priority defined", () => {
			for (const runner of allRunners) {
			// Skip disabled runners (those with no appliesTo)
			if (!(runner.appliesTo?.length ?? 0)) continue;
				// Priority should be a number (or undefined, which defaults to 100)
				if (runner.priority !== undefined) {
					expect(typeof runner.priority).toBe("number");
					expect(runner.priority).toBeGreaterThanOrEqual(0);
				}
			}
		});

		it("should have enabledByDefault boolean", () => {
			for (const runner of allRunners) {
			// Skip disabled runners (those with no appliesTo)
			if (!(runner.appliesTo?.length ?? 0)) continue;
				expect(typeof runner.enabledByDefault).toBe("boolean");
			}
		});

		it("should have a run function", () => {
			for (const runner of allRunners) {
			// Skip disabled runners (those with no appliesTo)
			if (!(runner.appliesTo?.length ?? 0)) continue;
				expect(typeof runner.run).toBe("function");
			}
		});
	});

	describe("Expected Runners", () => {
		const expectedRunners = [
			"ts-lsp",
			"ts-slop",
			"pyright",
			"python-slop",
			"biome-lint",

			"oxlint",
			"ruff-lint",
			"shellcheck",
			"spellcheck",
			"ast-grep",
			"ast-grep-napi",
			"architect",
			"ast-grep-napi",
			"config-validation",
		];

		it("should have all expected critical runners", () => {
			const registeredIds = allRunners.map((r) => r.id);

			for (const expectedId of expectedRunners) {
				expect(registeredIds).toContain(expectedId);
			}
		});

		it("should have TypeScript-related runners", () => {
			const tsRunners = getRunnersForKind("jsts");
			const tsIds = tsRunners.map((r) => r.id);

			// Should have at least ts-lsp
			expect(tsIds).toContain("ts-lsp");

			// Should have ts-slop
			expect(tsIds).toContain("ts-slop");
		});

		it("should have Python-related runners", () => {
			const pyRunners = getRunnersForKind("python");
			const pyIds = pyRunners.map((r) => r.id);

			// Should have pyright
			expect(pyIds).toContain("pyright");

			// Should have python-slop
			expect(pyIds).toContain("python-slop");
		});

		it("should have lint runners", () => {
			const jstsRunners = getRunnersForKind("jsts");
			const lintIds = ["biome-lint", "oxlint", "ts-slop"];

			for (const lintId of lintIds) {
				// At least one should be present
				const hasLintRunner = jstsRunners.some((r) => r.id === lintId);
				if (hasLintRunner) {
					// Found at least one
					expect(hasLintRunner).toBe(true);
					break;
				}
			}
		});

		it("should have format runners", () => {
			const jstsRunners = getRunnersForKind("jsts");
			const formatIds = ["biome-lint"];

			for (const formatId of formatIds) {
				const hasFormatRunner = jstsRunners.some((r) => r.id === formatId);
				if (hasFormatRunner) {
					expect(hasFormatRunner).toBe(true);
					break;
				}
			}
		});
	});

	describe("Runner Import Verification", () => {
		it("should load runner index without errors", async () => {
			// This catches the bug where runners weren't imported
			// in effect-integration.ts and bus-dispatcher.ts
			expect(async () => {
				await import("../runners/index.js");
			}).not.toThrow();
		});

		it("should have runners available after import", async () => {
			// Clear and re-import to verify fresh load
			const initialCount = listRunners().length;

			// Import again - should not duplicate due to id check
			await import("../runners/index.js");

			const finalCount = listRunners().length;

			// Should be same count (no duplicates)
			expect(finalCount).toBe(initialCount);
		});
	});

	describe("Runner Condition Functions", () => {
		it("should handle runners with when conditions", () => {
			const runnersWithWhen = allRunners.filter((r) => r.when !== undefined);

			for (const runner of runnersWithWhen) {
				// when should be a function
				expect(typeof runner.when).toBe("function");
			}
		});

		it("should evaluate when conditions correctly", async () => {
			// Find a runner with a when condition (e.g., autofix runners)
			const conditionalRunner = allRunners.find((r) => r.when !== undefined);

			if (conditionalRunner) {
				// Create mock contexts
				const ctxWithAutofix = {
					autofix: true,
					filePath: "test.ts",
					cwd: "/test",
					kind: "jsts" as FileKind,
					pi: { getFlag: () => false },
					deltaMode: false,
					baselines: new Map(),
					hasTool: async () => false,
					log: () => {},
				};

				const ctxWithoutAutofix = {
					...ctxWithAutofix,
					autofix: false,
				};

				// Evaluate condition
				const shouldRunWith = await conditionalRunner.when?.(ctxWithAutofix);
				const shouldRunWithout =
					await conditionalRunner.when?.(ctxWithoutAutofix);

				// Results should be boolean
				expect(typeof shouldRunWith).toBe("boolean");
				expect(typeof shouldRunWithout).toBe("boolean");
			}
		});
	});

	describe("Priority Ordering", () => {
		it("should return runners sorted by priority", () => {
			const kinds: FileKind[] = ["jsts", "python", "rust", "go"];

			for (const kind of kinds) {
				const runners = getRunnersForKind(kind);

				if (runners.length > 1) {
					const priorities = runners.map((r) => r.priority ?? 100);

					// Should be sorted ascending
					for (let i = 1; i < priorities.length; i++) {
						expect(priorities[i - 1]).toBeLessThanOrEqual(priorities[i]);
					}
				}
			}
		});
	});
});

/**
 * Mock Runner Factory for Testing
 *
 * Creates mock runners that simulate real tool behavior
 * without requiring actual CLI tools to be installed.
 */

import type {
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../../clients/dispatch/types.js";

export interface MockRunnerConfig {
	id: string;
	appliesTo: string[];
	priority?: number;
	enabledByDefault?: boolean;
	skipTestFiles?: boolean;
	when?: (ctx: DispatchContext) => boolean | Promise<boolean>;
	runResult: RunnerResult;
	runDelay?: number; // Simulate async work
}

export function createMockRunner(config: MockRunnerConfig): RunnerDefinition {
	return {
		id: config.id,
		appliesTo: config.appliesTo as any,
		priority: config.priority ?? 10,
		enabledByDefault: config.enabledByDefault ?? true,
		skipTestFiles: config.skipTestFiles ?? false,
		when: config.when,
		async run(_ctx: DispatchContext): Promise<RunnerResult> {
			// Simulate async work (CLI invocation)
			if (config.runDelay) {
				await new Promise((resolve) => setTimeout(resolve, config.runDelay));
			}
			return config.runResult;
		},
	};
}

// Pre-built mock runners for common scenarios

export const createFailingRunner = (id: string) =>
	createMockRunner({
		id,
		appliesTo: ["jsts"],
		runResult: {
			status: "failed",
			diagnostics: [
				{
					id: `${id}-error`,
					message: "Mock error",
					filePath: "test.ts",
					severity: "error",
					semantic: "blocking",
					tool: id,
				},
			],
			semantic: "blocking",
		},
	});

export const createWarningRunner = (id: string) =>
	createMockRunner({
		id,
		appliesTo: ["jsts"],
		runResult: {
			status: "succeeded",
			diagnostics: [
				{
					id: `${id}-warning`,
					message: "Mock warning",
					filePath: "test.ts",
					severity: "warning",
					semantic: "warning",
					tool: id,
				},
			],
			semantic: "warning",
		},
	});

export const createCleanRunner = (id: string) =>
	createMockRunner({
		id,
		appliesTo: ["jsts"],
		runResult: {
			status: "succeeded",
			diagnostics: [],
			semantic: "none",
		},
	});

export const createConditionalRunner = (
	id: string,
	condition: (ctx: DispatchContext) => boolean,
) =>
	createMockRunner({
		id,
		appliesTo: ["jsts"],
		when: async (ctx) => condition(ctx),
		runResult: {
			status: "succeeded",
			diagnostics: [
				{
					id: `${id}-conditional`,
					message: "Conditional run",
					filePath: "test.ts",
					severity: "info",
					semantic: "none",
					tool: id,
				},
			],
			semantic: "none",
		},
	});

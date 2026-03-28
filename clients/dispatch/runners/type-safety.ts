/**
 * Type safety runner for dispatch system
 *
 * Checks for:
 * - Switch exhaustiveness
 * - Missing return statements
 * - Type safety issues
 */

import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { readFileContent } from "./utils.js";

const typeSafetyRunner: RunnerDefinition = {
	id: "type-safety",
	appliesTo: ["jsts"],
	priority: 20,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Only check TypeScript files
		if (!ctx.filePath.match(/\.tsx?$/)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const content = readFileContent(ctx.filePath);
		if (!content) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics: Diagnostic[] = [];

		// Check for switch exhaustiveness patterns
		diagnostics.push(...checkSwitchExhaustiveness(content, ctx.filePath));

		// Check for missing return patterns
		diagnostics.push(...checkMissingReturns(content, ctx.filePath));

		// Check for any type usage
		diagnostics.push(...checkAnyTypeUsage(content, ctx.filePath));

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

function checkSwitchExhaustiveness(
	content: string,
	filePath: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	const switchRegex = /switch\s*\(\s*(\w+)\s*\)\s*\{/g;
	let match;

	while ((match = switchRegex.exec(content)) !== null) {
		const switchStart = match.index;
		const switchVar = match[1];

		// Find the switch block
		let braceCount = 0;
		const blockStart = content.indexOf("{", switchStart);
		let blockEnd = blockStart;

		while (blockEnd < content.length && braceCount >= 0) {
			if (content[blockEnd] === "{") braceCount++;
			if (content[blockEnd] === "}") braceCount--;
			blockEnd++;
		}

		const switchBlock = content.slice(blockStart, blockEnd);

		// Check if it has a default case
		if (!/\bdefault\s*:/.test(switchBlock)) {
			const caseCount = (switchBlock.match(/\bcase\s+/g) || []).length;

			if (caseCount > 2) {
				const lineNum = content.slice(0, switchStart).split("\n").length;
				diagnostics.push({
					id: `switch-${lineNum}-${switchVar}`,
					message: `Switch on '${switchVar}' has ${caseCount} cases but no default`,
					filePath,
					line: lineNum,
					severity: "warning",
					semantic: "warning",
					tool: "type-safety",
					rule: "switch-exhaustiveness",
					fixSuggestion: "Add 'default: break;' or use exhaustive checking",
				});
			}
		}
	}

	return diagnostics;
}

function checkMissingReturns(content: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	const funcRegex = /function\s+(\w+)\s*\([^)]*\)\s*:\s*([^\s{]+)\s*\{/g;
	let match;

	while ((match = funcRegex.exec(content)) !== null) {
		const returnType = match[2].trim();

		if (
			returnType === "void" ||
			returnType === "never" ||
			returnType.includes("Promise<void>")
		) {
			continue;
		}

		const funcStart = match.index;
		const funcName = match[1];

		// Find function block
		let braceCount = 0;
		const blockStart = content.indexOf("{", funcStart);
		let blockEnd = blockStart;

		while (blockEnd < content.length && braceCount >= 0) {
			if (content[blockEnd] === "{") braceCount++;
			if (content[blockEnd] === "}") braceCount--;
			blockEnd++;
		}

		const funcBlock = content.slice(blockStart, blockEnd);

		if (!/\breturn\b/.test(funcBlock)) {
			const lineNum = content.slice(0, funcStart).split("\n").length;
			diagnostics.push({
				id: `missing-return-${lineNum}-${funcName}`,
				message: `Function '${funcName}' returns '${returnType}' but has no return statement`,
				filePath,
				line: lineNum,
				severity: "error",
				semantic: "blocking",
				tool: "type-safety",
				rule: "missing-return",
			});
		}
	}

	return diagnostics;
}

function checkAnyTypeUsage(content: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	const anyRegex = /:\s*any\b|as\s+any\b/g;
	let match;

	while ((match = anyRegex.exec(content)) !== null) {
		const lineNum = content.slice(0, match.index).split("\n").length;
		diagnostics.push({
			id: `any-type-${lineNum}`,
			message: "Avoid 'any' type — use 'unknown' or define a proper interface",
			filePath,
			line: lineNum,
			severity: "warning",
			semantic: "warning",
			tool: "type-safety",
			rule: "no-any-type",
		});
	}

	return diagnostics;
}

export default typeSafetyRunner;

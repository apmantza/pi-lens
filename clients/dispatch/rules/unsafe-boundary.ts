import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";
import type { FunctionSummary } from "../facts/function-facts.js";
import type { TryCatchSummary } from "../facts/try-catch-facts.js";

/**
 * Flags async functions that call IO/network/DB boundaries but have no
 * try/catch protection AND have non-trivial complexity.
 *
 * Rationale: boundary wrappers with high CC and no error handling are the
 * most common source of unhandled-rejection crashes and silent data loss.
 * Simple pass-throughs are excluded — they're expected to propagate errors.
 */

const IO_PREFIXES = [
	"fetch", "axios", "got", "request",
	"db.", "prisma.", "knex.", "mongoose.", "sequelize.",
	"fs.", "fs/promises", "readFile", "writeFile", "readdir",
	"http.", "https.", "net.", "dns.",
	"redis.", "mongo.", "pg.", "mysql.",
	"s3.", "storage.", "bucket.",
	"exec", "spawn", "execSync",
];

const CC_THRESHOLD = 4; // lower bar than high-complexity — IO makes it riskier

function callsToBoundary(outgoingCalls: string[]): string | undefined {
	for (const callee of outgoingCalls) {
		const lower = callee.toLowerCase();
		if (IO_PREFIXES.some((p) => lower.startsWith(p))) return callee;
	}
	return undefined;
}

function hasCatchCoverage(fn: FunctionSummary, catches: TryCatchSummary[]): boolean {
	// A try/catch is considered covering if it starts at or before the function
	// and is non-empty and non-obscuring (has rethrow or logging or uses catch param).
	return catches.some(
		(c) =>
			c.line >= fn.line &&
			!c.isEmpty &&
			(c.hasRethrow || c.hasLogging || c.catchParam === null),
	);
}

export const unsafeBoundaryRule: FactRule = {
	id: "unsafe-boundary",
	requires: ["file.functionSummaries", "file.tryCatchSummaries"],
	appliesTo(ctx) {
		return /\.tsx?$/.test(ctx.filePath);
	},
	evaluate(ctx, store) {
		const fns =
			store.getFileFact<FunctionSummary[]>(ctx.filePath, "file.functionSummaries") ?? [];
		const catches =
			store.getFileFact<TryCatchSummary[]>(ctx.filePath, "file.tryCatchSummaries") ?? [];

		const diagnostics: Diagnostic[] = [];

		for (const f of fns) {
			if (!f.isAsync) continue;
			if (f.isPassThroughWrapper) continue; // expected to propagate
			if (f.cyclomaticComplexity < CC_THRESHOLD) continue;

			const boundaryCalle = callsToBoundary(f.outgoingCalls);
			if (!boundaryCalle) continue;

			if (hasCatchCoverage(f, catches)) continue;

			diagnostics.push({
				id: `unsafe-boundary:${ctx.filePath}:${f.line}`,
				tool: "unsafe-boundary",
				rule: "unsafe-boundary",
				filePath: ctx.filePath,
				line: f.line,
				column: f.column,
				severity: "warning",
				semantic: "warning",
				message:
					`'${f.name}' is async, calls '${boundaryCalle}', has complexity ${f.cyclomaticComplexity}, but no try/catch — unhandled rejection risk`,
			});
		}

		return diagnostics;
	},
};

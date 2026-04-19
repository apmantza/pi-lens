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

// Entries ending with '.' are namespace prefixes (startsWith match).
// All other entries are exact callee names — prevents e.g. "spawn" matching "spawned.map"
// or "fetch" matching "fetchWithRetry".
const IO_NAMESPACE_PREFIXES = [
	"db.", "prisma.", "knex.", "mongoose.", "sequelize.",
	"http.", "https.", "net.", "dns.",
	"redis.", "mongo.", "pg.", "mysql.",
	"s3.", "storage.", "bucket.",
	"fs.promises.",
];

const IO_EXACT_CALLEES = new Set([
	"fetch", "axios", "got", "request",
	"spawn", "exec", "execSync", "spawnSync",
	"readFile", "writeFile", "appendFile", "readdir", "mkdir", "unlink", "stat",
]);

const CC_THRESHOLD = 6; // raised from 4 — avoids flagging simple async wrappers with one IO call

function callsToBoundary(outgoingCalls: string[]): string | undefined {
	for (const callee of outgoingCalls) {
		const lower = callee.toLowerCase();
		if (IO_EXACT_CALLEES.has(lower)) return callee;
		if (IO_NAMESPACE_PREFIXES.some((p) => lower.startsWith(p))) return callee;
	}
	return undefined;
}

function hasCatchCoverage(fn: FunctionSummary, catches: TryCatchSummary[]): boolean {
	// A catch block is considered covering if it is non-empty and does one of:
	// - rethrows the error
	// - logs it (console.error / logger.*)
	// - has no binding (catch {} — intentional swallow)
	// - returns a structured value (return { ... } / return false / return null)
	//   This handles the common "return structured error" pattern in IO helpers.
	// Also handles Promise-executor pattern: if the function body itself resolves/rejects
	// via new Promise((resolve) => {...}) we treat it as covered at the call site.
	if (fn.outgoingCalls.some((c) => c === "resolve" || c === "reject")) return true;

	return catches.some((c) => {
		if (c.line < fn.line) return false;
		if (c.isEmpty) return false;
		if (c.hasRethrow || c.hasLogging || c.catchParam === null) return true;
		// Catch body contains a return statement → structured error result
		if (/\breturn\b/.test(c.bodyText)) return true;
		return false;
	});
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

import type { FactProvider } from "../fact-provider-types.js";
import {
	extractFactsFromTree,
	firstChildOfType,
	walk,
} from "./tree-sitter-facts.js";

export interface TryCatchSummary {
	line: number;
	column: number;
	catchParam: string | null;
	bodyText: string;
	isEmpty: boolean;
	hasRethrow: boolean;
	hasLogging: boolean;
	/** Catch body only logs the error — no other side effects */
	catchLogsOnly: boolean;
	/** Catch body returns a fallback/default value (null, [], {}, false, 0, "") */
	catchReturnsDefault: boolean;
	/** Catch body returns a structured error object ({ success: false, error }) */
	catchReturnsStructuredError: boolean;
	/** Catch body is a documented intentional local fallback (has explaining comment) */
	isDocumentedLocalFallback: boolean;
	/** Try body only reads/resolves local values — no async IO or side effects */
	tryResolvesLocalValues: boolean;
	/** Pattern: try { existsSync / statSync / readFileSync } catch { return default } */
	isFilesystemExistenceProbe: boolean;
	/** Broad boundary category of the IO/network calls in the try block */
	boundaryCategory: "db" | "network" | "fs" | "process" | "unknown" | "none";
}

// --- Helpers ---

function isOnlyWhitespaceOrComments(text: string): boolean {
	let stripped = text.replace(/\/\*[\s\S]*?\*\//g, "");
	stripped = stripped.replace(/\/\/[^\n]*/g, "");
	return stripped.trim().length === 0;
}

const DEFAULT_VALUE_PATTERN =
	/\breturn\s+(null|undefined|false|true|0|""|''|``|\[\]|\{\}|new\s+\w+\(\))/;

const STRUCTURED_ERROR_PATTERN =
	/\breturn\s+\{[^}]*(?:success\s*:\s*false|error\s*:)/;

// Any non-trivial comment (≥ 4 non-space chars) counts as documented intent.
// This covers patterns like: // continue, /* not found */, // best-effort, etc.
const EXPLAINING_COMMENT_PATTERN =
	/(?:\/\/\s*\S.{3,}|\/\*\s*\S[\s\S]{3,}?\*\/)/;

const FS_PROBE_PATTERN =
	/\b(?:existsSync|statSync|lstatSync|readFileSync|accessSync)\b/;

const DB_PATTERN =
	/\b(?:query|execute|findOne|findMany|findById|insert|update|delete|select|prisma\.|knex\.|sequelize\.)/;
const NETWORK_PATTERN =
	/\b(?:fetch|axios|http\.|https\.|request\.|got\.|undici\.)/;
const FS_PATTERN =
	/\b(?:readFileSync?|writeFileSync?|appendFileSync?|readdirSync?|mkdirSync?|statSync?|unlinkSync?|existsSync|accessSync?|copyFileSync?|renameSync?)\b/;
const PROCESS_PATTERN = /\b(?:spawn|exec|execSync|spawnSync|child_process\.)\b/;

function detectBoundaryCategory(
	tryText: string,
): TryCatchSummary["boundaryCategory"] {
	if (DB_PATTERN.test(tryText)) return "db";
	if (NETWORK_PATTERN.test(tryText)) return "network";
	if (FS_PATTERN.test(tryText)) return "fs";
	if (PROCESS_PATTERN.test(tryText)) return "process";
	return "none";
}

function detectTryResolvesLocalValues(tryText: string): boolean {
	// Heuristic: no await, no IO calls, no mutations via known side-effectful APIs
	const hasAwait = /\bawait\b/.test(tryText);
	const hasIO =
		DB_PATTERN.test(tryText) ||
		NETWORK_PATTERN.test(tryText) ||
		FS_PATTERN.test(tryText) ||
		PROCESS_PATTERN.test(tryText);
	return !hasAwait && !hasIO;
}

// --- Provider ---

export const tryCatchFactProvider: FactProvider = {
	id: "tryCatchFacts",
	provides: ["file.tryCatchSummaries"],
	requires: ["file.content"],
	appliesTo(ctx) {
		return /\.tsx?$/.test(ctx.filePath);
	},
	async run(ctx, store) {
		await extractFactsFromTree(
			ctx,
			store,
			{ "file.tryCatchSummaries": [] },
			(root) => {
				const summaries: TryCatchSummary[] = [];

				walk(root, (node) => {
					if (node.type !== "try_statement") return;
					// The direct `statement_block` child is the try body; the catch/finally
					// blocks are nested inside their own clauses (not direct children).
					const tryBlock = firstChildOfType(node, "statement_block");
					const catchClause = firstChildOfType(node, "catch_clause");
					if (!tryBlock || !catchClause) return;

					const tryText = tryBlock.text;
					const tryResolvesLocalValues = detectTryResolvesLocalValues(tryText);
					const boundaryCategory = detectBoundaryCategory(tryText);

					// Catch binding: `catch (e)` → identifier param; `catch {}` or a destructuring
					// pattern → null (matching the old `ts.isIdentifier` gate).
					const paramNode = firstChildOfType(catchClause, "identifier");
					const catchParam = paramNode ? paramNode.text : null;

					const catchBody = firstChildOfType(catchClause, "statement_block");
					const bodyText = catchBody
						? catchBody.text.replace(/^\{/, "").replace(/\}$/, "").trim()
						: "";

					const isEmpty = isOnlyWhitespaceOrComments(bodyText);
					const hasRethrow = /\bthrow\b/.test(bodyText);
					const hasLogging =
						/\bconsole\.(log|warn|error)\b/.test(bodyText) ||
						/\blogger\./.test(bodyText);

					// Derived enrichment fields
					const catchReturnsDefault = DEFAULT_VALUE_PATTERN.test(bodyText);
					const catchReturnsStructuredError =
						STRUCTURED_ERROR_PATTERN.test(bodyText);
					const isDocumentedLocalFallback =
						EXPLAINING_COMMENT_PATTERN.test(bodyText);

					const catchLogsOnly =
						hasLogging &&
						!hasRethrow &&
						!catchReturnsDefault &&
						!catchReturnsStructuredError &&
						!/\b(?:set|update|notify|emit|dispatch|resolve|reject)\b/.test(
							bodyText,
						);

					// Filesystem existence probe: try reads a file/path, catch returns a default
					const isFilesystemExistenceProbe =
						boundaryCategory === "fs" &&
						FS_PROBE_PATTERN.test(tryText) &&
						catchReturnsDefault;

					summaries.push({
						line: catchClause.startPosition.row + 1,
						column: catchClause.startPosition.column + 1,
						catchParam,
						bodyText,
						isEmpty,
						hasRethrow,
						hasLogging,
						catchLogsOnly,
						catchReturnsDefault,
						catchReturnsStructuredError,
						isDocumentedLocalFallback,
						tryResolvesLocalValues,
						isFilesystemExistenceProbe,
						boundaryCategory,
					});
				});

				return { "file.tryCatchSummaries": summaries };
			},
		);
	},
};

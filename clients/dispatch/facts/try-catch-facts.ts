import * as ts from "typescript";
import type { FactProvider } from "../fact-provider-types.js";

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

const EXPLAINING_COMMENT_PATTERN =
  /\/\/[^\n]*(intentional|expected|ignore|ok|safe|fallback|known|silent|no-op)/i;

const FS_PROBE_PATTERN =
  /\b(?:existsSync|statSync|lstatSync|readFileSync|accessSync)\b/;

const DB_PATTERN = /\b(?:query|execute|findOne|findMany|findById|insert|update|delete|select|prisma\.|knex\.|sequelize\.)/;
const NETWORK_PATTERN = /\b(?:fetch|axios|http\.|https\.|request\.|got\.|undici\.)/;
const FS_PATTERN = /\b(?:readFile|writeFile|appendFile|readdir|mkdir|stat|unlink|existsSync|readFileSync)\b/;
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
  const hasIO = DB_PATTERN.test(tryText) || NETWORK_PATTERN.test(tryText) ||
    FS_PATTERN.test(tryText) || PROCESS_PATTERN.test(tryText);
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
  run(ctx, store) {
    const content = store.getFileFact<string>(ctx.filePath, "file.content");
    if (!content) {
      store.setFileFact(ctx.filePath, "file.tryCatchSummaries", []);
      return;
    }

    const sourceFile = ts.createSourceFile(
      ctx.filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const summaries: TryCatchSummary[] = [];

    function visit(node: ts.Node): void {
      if (ts.isTryStatement(node)) {
        const tryText = node.tryBlock.getText(sourceFile);
        const tryResolvesLocalValues = detectTryResolvesLocalValues(tryText);
        const boundaryCategory = detectBoundaryCategory(tryText);

        if (node.catchClause) {
          const clause = node.catchClause;
          const pos = sourceFile.getLineAndCharacterOfPosition(
            clause.getStart(sourceFile),
          );

          let catchParam: string | null = null;
          if (clause.variableDeclaration) {
            const name = clause.variableDeclaration.name;
            if (ts.isIdentifier(name)) {
              catchParam = name.text;
            }
          }

          const bodyText = clause.block
            .getText(sourceFile)
            .replace(/^\{/, "")
            .replace(/\}$/, "")
            .trim();

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
            line: pos.line + 1,
            column: pos.character + 1,
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
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    store.setFileFact(ctx.filePath, "file.tryCatchSummaries", summaries);
  },
};

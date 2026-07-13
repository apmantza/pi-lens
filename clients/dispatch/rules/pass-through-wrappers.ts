import { isTestFile } from "../../file-utils.js";
import type { FactRule } from "../fact-provider-types.js";
import type { CommentSummary } from "../facts/comment-facts.js";
import type { FunctionSummary } from "../facts/function-facts.js";
import type { Diagnostic } from "../types.js";

const ALIAS_COMMENT_RE =
  /\b(alias|backward\s*compat|backwards\s*compat|compatibility|shim|adapter)\b/i;

function hasAliasCommentNear(line: number, comments: CommentSummary[]): boolean {
  return comments.some(
    (comment) => comment.line >= line - 2 && comment.line <= line && ALIAS_COMMENT_RE.test(comment.text),
  );
}

export const passThroughWrappersRule: FactRule = {
  id: "pass-through-wrappers",
  requires: ["file.functionSummaries", "file.comments"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath) && !isTestFile(ctx.filePath);
  },
  evaluate(ctx, store) {
    const summaries = store.getFileFact<FunctionSummary[]>(
      ctx.filePath,
      "file.functionSummaries",
    );
    const comments = store.getFileFact<CommentSummary[]>(ctx.filePath, "file.comments");
    if (!summaries || !comments) return [];

    const diagnostics: Diagnostic[] = [];
    for (const fn of summaries) {
      if (!fn.isPassThroughWrapper || fn.statementCount !== 1 || fn.isBoundaryWrapper) {
        continue;
      }
      if (hasAliasCommentNear(fn.line, comments)) continue;

      diagnostics.push({
        id: `pass-through-wrapper:${ctx.filePath}:${fn.line}:${fn.column}`,
        tool: "fact-rules",
        filePath: ctx.filePath,
        line: fn.line,
        column: fn.column,
        severity: "warning",
        semantic: "warning",
        rule: "pass-through-wrappers",
        message: `Function '${fn.name}' is a trivial pass-through wrapper`,
      });
    }

    return diagnostics;
  },
};

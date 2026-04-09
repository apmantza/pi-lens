import { isTestFile } from "../../file-utils.js";
import type { FactRule } from "../fact-provider-types.js";
import type { CommentSummary } from "../facts/comment-facts.js";
import type { Diagnostic } from "../types.js";

const PLACEHOLDER_PATTERNS = [
  /add\s+more\s+validation/i,
  /handle\s+(additional|more)\s+cases?/i,
  /can\s+be\s+extended\s+in\s+the\s+future/i,
  /extend\s+this\s+(logic|function|method|handler|module)/i,
  /customize\s+this\s+(logic|behavior|function|method|handler)/i,
  /future\s+enhancement/i,
  /implement\s+.+\s+here/i,
];

export const placeholderCommentsRule: FactRule = {
  id: "placeholder-comments",
  requires: ["file.comments"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath) && !isTestFile(ctx.filePath);
  },
  evaluate(ctx, store) {
    const comments = store.getFileFact<CommentSummary[]>(ctx.filePath, "file.comments");
    if (!comments) return [];

    const diagnostics: Diagnostic[] = [];
    for (const comment of comments) {
      const matched = PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(comment.text));
      if (!matched) continue;

      diagnostics.push({
        id: `placeholder-comments:${ctx.filePath}:${comment.line}:1`,
        tool: "placeholder-comments",
        filePath: ctx.filePath,
        line: comment.line,
        column: 1,
        severity: "warning",
        semantic: "warning",
        rule: "placeholder-comments",
        message:
          "Placeholder comment detected. Prefer comments that describe current behavior over future intent.",
      });
    }

    return diagnostics;
  },
};

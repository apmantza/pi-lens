import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";
import type { TryCatchSummary } from "../facts/try-catch-facts.js";

export const errorObscuringRule: FactRule = {
  id: "error-obscuring",
  requires: ["file.tryCatchSummaries"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath);
  },
  evaluate(ctx, store) {
    const summaries = store.getFileFact<TryCatchSummary[]>(
      ctx.filePath,
      "file.tryCatchSummaries",
    );
    if (!summaries) return [];

    const diagnostics: Diagnostic[] = [];
    for (const s of summaries) {
      if (
        !s.isEmpty &&
        !s.hasRethrow &&
        s.catchParam !== null &&
        !s.bodyText.includes(s.catchParam)
      ) {
        diagnostics.push({
          id: `error-obscuring:${ctx.filePath}:${s.line}:${s.column}`,
          tool: "fact-rules",
          rule: "error-obscuring",
          filePath: ctx.filePath,
          line: s.line,
          column: s.column,
          severity: "warning",
          semantic: "warning",
          message: `Catch block catches '${s.catchParam}' but never references it — the error is obscured`,
        });
      }
    }
    return diagnostics;
  },
};

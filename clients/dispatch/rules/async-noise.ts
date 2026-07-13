import { isTestFile } from "../../file-utils.js";
import type { FactRule } from "../fact-provider-types.js";
import type { FunctionSummary } from "../facts/function-facts.js";
import type { Diagnostic } from "../types.js";

export const asyncNoiseRule: FactRule = {
  id: "async-noise",
  requires: ["file.functionSummaries"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath) && !isTestFile(ctx.filePath);
  },
  evaluate(ctx, store) {
    const summaries = store.getFileFact<FunctionSummary[]>(
      ctx.filePath,
      "file.functionSummaries",
    );
    if (!summaries) return [];

    const diagnostics: Diagnostic[] = [];
    // Function name patterns that legitimately declare async for interface compliance
    // or future-proofing (lifecycle hooks, event handlers, middleware, abstract stubs)
    const ASYNC_INTERFACE_PATTERN = /^(on[A-Z]|handle[A-Z]|before[A-Z]|after[A-Z]|setup|teardown|init|dispose|connect|disconnect|open|close|start|stop|run|execute|invoke|dispatch|middleware)/;

    for (const fn of summaries) {
      if (
        fn.isAsync &&
        !fn.hasAwait &&
        !fn.hasReturnAwaitCall &&
        !fn.isPassThroughWrapper &&
        !ASYNC_INTERFACE_PATTERN.test(fn.name) &&
        // Skip single-statement functions — likely interface stubs or thin wrappers
        fn.statementCount > 1
      ) {
        diagnostics.push({
          id: `async-noise:${ctx.filePath}:${fn.line}:${fn.column}`,
          tool: "fact-rules",
          filePath: ctx.filePath,
          line: fn.line,
          column: fn.column,
          severity: "warning",
          semantic: "warning",
          message: `Async function '${fn.name}' has no await and appears to add async noise`,
          rule: "async-noise",
        });
      }
    }

    return diagnostics;
  },
};

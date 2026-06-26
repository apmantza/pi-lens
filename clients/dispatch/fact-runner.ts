import type { FactProvider } from "./fact-provider-types.js";
import type { DispatchContext } from "./types.js";
import { registerRule } from "./fact-rule-runner.js";
import { scheduleProviders } from "./fact-scheduler.js";

const providers: FactProvider[] = [];

export function registerProvider(p: FactProvider): void {
  providers.push(p);
}

export function clearProviders(): void {
  providers.length = 0;
}

/**
 * The TypeScript-compiler-backed fact providers + rules are registered LAZILY,
 * the first time any dispatch actually runs — NOT at module import. This keeps
 * the 24 MB `typescript` dependency out of pi-lens's eager entry graph, so a
 * failure to resolve it (#285/#335: a package-manager layout the runtime can't
 * traverse) degrades to "no TS-based structural analysis" instead of crashing
 * the whole extension at load. `runProviders` is the single seam every dispatch
 * path funnels through, so registering here covers them all (integration's three
 * entries + the project scanner) with no per-caller wiring.
 */
let tsUnitsEnsured: Promise<void> | null = null;
export function ensureTypeScriptDispatchUnits(): Promise<void> {
  tsUnitsEnsured ??= (async () => {
    try {
      const [tryCatch, fn, comment, imp, quality, sonar] = await Promise.all([
        import("./facts/try-catch-facts.js"),
        import("./facts/function-facts.js"),
        import("./facts/comment-facts.js"),
        import("./facts/import-facts.js"),
        import("./rules/quality-rules.js"),
        import("./rules/sonar-rules.js"),
      ]);
      registerProvider(tryCatch.tryCatchFactProvider);
      registerProvider(fn.functionFactProvider);
      registerProvider(comment.commentFactProvider);
      registerProvider(imp.importFactProvider);
      registerRule(quality.highImportCouplingRule);
      registerRule(quality.noBooleanParamsRule);
      registerRule(quality.noComplexConditionalsRule);
      registerRule(sonar.commentedCredentialsRule);
      registerRule(sonar.commentedOutCodeRule);
      registerRule(sonar.corsWildcardRule);
      registerRule(sonar.duplicateStringLiteralRule);
      registerRule(sonar.dynamicRegexpRule);
      registerRule(sonar.functionInLoopRule);
      registerRule(sonar.maxSwitchCasesRule);
    } catch (err) {
      // Degrade, don't crash: name the failure + emit the install fingerprint
      // so a reporter has the full picture. tsUnitsEnsured stays resolved, so we
      // don't re-attempt (and re-log) on every subsequent dispatch.
      try {
        const { collectInstallDiagnostics, formatInstallDiagnostics } =
          await import("../install-diagnostics.js");
        console.error(
          `[pi-lens] TypeScript-based dispatch analysis disabled (degraded mode): ${
            (err as Error)?.message ?? String(err)
          }`,
        );
        console.error(
          formatInstallDiagnostics(collectInstallDiagnostics(), err),
        );
      } catch {
        console.error(
          `[pi-lens] TypeScript-based dispatch analysis disabled: ${
            (err as Error)?.message ?? String(err)
          }`,
        );
      }
    }
  })();
  return tsUnitsEnsured;
}

/** Test-only: drop the memoized lazy-registration so it can be re-exercised. */
export function _resetTypeScriptDispatchUnitsForTests(): void {
  tsUnitsEnsured = null;
}

export async function runProviders(ctx: DispatchContext): Promise<void> {
  await ensureTypeScriptDispatchUnits();
  const applicable = providers.filter((p) => p.appliesTo(ctx));
  const ordered = scheduleProviders(applicable);

  for (const provider of ordered) {
    // Skip if all provided facts are already present
    const allPresent = provider.provides.every((key) =>
      ctx.facts.hasFileFact(ctx.filePath, key),
    );
    if (allPresent) continue;

    await provider.run(ctx, ctx.facts);
  }
}

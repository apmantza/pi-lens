import type { FactProvider } from "./fact-provider-types.js";
import { scheduleProviders } from "./fact-scheduler.js";
import type { DispatchContext } from "./types.js";

const providers: FactProvider[] = [];

export function registerProvider(p: FactProvider): void {
  providers.push(p);
}

export function clearProviders(): void {
  providers.length = 0;
}

/**
 * Run the registered fact providers for `ctx`, in dependency order.
 *
 * Providers + fact rules are registered eagerly at `integration.ts` import (the
 * dispatch entry) — including the tree-sitter-backed providers. That's safe for
 * pi-lens's eager graph because the parsing stack loads `web-tree-sitter` (an
 * optional dep) via a dynamic `import()` inside `client.init()`, not at module
 * import, so an unavailable grammar/runtime degrades there rather than crashing
 * the extension at load. As of #402 nothing here uses the `typescript` compiler,
 * so the old lazy-import-with-degrade indirection (#285/#335) is gone.
 */
export async function runProviders(ctx: DispatchContext): Promise<void> {
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

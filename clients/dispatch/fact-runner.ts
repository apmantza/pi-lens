import type { FactProvider } from "./fact-provider-types.js";
import type { DispatchContext } from "./types.js";
import { scheduleProviders } from "./fact-scheduler.js";

const providers: FactProvider[] = [];

export function registerProvider(p: FactProvider): void {
  providers.push(p);
}

export function clearProviders(): void {
  providers.length = 0;
}

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

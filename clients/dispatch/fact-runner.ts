import type { FactProvider } from "./fact-provider-types.js";
import type { DispatchContext } from "./types.js";

const providers: FactProvider[] = [];

export function registerProvider(p: FactProvider): void {
  providers.push(p);
}

export async function runProviders(ctx: DispatchContext): Promise<void> {
  for (const provider of providers) {
    if (!provider.appliesTo(ctx)) continue;

    // Skip if all provided facts are already present
    const allPresent = provider.provides.every((key) =>
      ctx.facts.hasFileFact(ctx.filePath, key),
    );
    if (allPresent) continue;

    await provider.run(ctx, ctx.facts);
  }
}

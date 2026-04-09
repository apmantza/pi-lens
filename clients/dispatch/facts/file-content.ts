import * as fs from "node:fs/promises";
import type { FactProvider } from "../fact-provider-types.js";

export const fileContentProvider: FactProvider = {
  id: "fact.file.content",
  provides: ["file.content"],
  requires: [],
  appliesTo(_ctx) {
    return true;
  },
  async run(ctx, store) {
    let content: string | null;
    try {
      content = await fs.readFile(ctx.filePath, "utf-8");
    } catch {
      content = null;
    }
    store.setFileFact(ctx.filePath, "file.content", content);
  },
};

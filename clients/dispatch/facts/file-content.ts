import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FactProvider } from "../fact-provider-types.js";

function isPathWithinProject(filePath: string, projectRoot: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(projectRoot);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

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
      if (!isPathWithinProject(ctx.filePath, ctx.projectRoot)) {
        content = null;
      } else {
        content = await fs.readFile(ctx.filePath, "utf-8");
      }
    } catch {
      content = null;
    }
    store.setFileFact(ctx.filePath, "file.content", content);
  },
};

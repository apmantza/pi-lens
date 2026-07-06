import { describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
  commentFactProvider,
  type CommentSummary,
} from "../../../clients/dispatch/facts/comment-facts.js";

async function run(content: string): Promise<CommentSummary[]> {
  const facts = new FactStore();
  const filePath = "/tmp/c.ts";
  facts.setFileFact(filePath, "file.content", content);
  await commentFactProvider.run({ filePath } as never, facts);
  return facts.getFileFact<CommentSummary[]>(filePath, "file.comments") ?? [];
}

describe("commentFactProvider", () => {
  it("extracts single-line comments with 1-based line and full text", async () => {
    const c = await run(`const x = 1; // trailing\n// leading\nconst y = 2;\n`);
    const texts = c.map((e) => e.text);
    expect(texts).toContain("// trailing");
    expect(texts).toContain("// leading");
    const leading = c.find((e) => e.text === "// leading")!;
    expect(leading.line).toBe(2);
  });

  it("extracts multi-line block comments", async () => {
    const c = await run(`/* block\n   comment */\nconst z = 3;\n`);
    expect(c).toHaveLength(1);
    expect(c[0].text).toBe("/* block\n   comment */");
    expect(c[0].line).toBe(1);
  });

  it("returns comments in source order", async () => {
    const c = await run(`// first\nconst a = 1;\n// second\nconst b = 2;\n`);
    expect(c.map((e) => e.text)).toEqual(["// first", "// second"]);
  });

  it("returns empty for a file with no comments", async () => {
    expect(await run(`const a = 1;\n`)).toEqual([]);
  });

  it("returns empty on empty content", async () => {
    expect(await run("")).toEqual([]);
  });
});

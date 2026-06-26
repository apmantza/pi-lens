import { ts } from "../../deps/typescript.js";
import type { FactProvider } from "../fact-provider-types.js";

export interface CommentSummary {
  line: number;
  text: string;
}

export const commentFactProvider: FactProvider = {
  id: "fact.file.comments",
  provides: ["file.comments"],
  requires: ["file.content"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath);
  },
  run(ctx, store) {
    const content = store.getFileFact<string>(ctx.filePath, "file.content");
    if (!content) {
      store.setFileFact(ctx.filePath, "file.comments", []);
      return;
    }

    const sourceFile = ts.createSourceFile(
      ctx.filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const comments: CommentSummary[] = [];

    const pushComment = (pos: number, end: number): void => {
      const lc = sourceFile.getLineAndCharacterOfPosition(pos);
      comments.push({
        line: lc.line + 1,
        text: content.slice(pos, end),
      });
    };

    const scan = ts.createScanner(
      sourceFile.languageVersion,
      false,
      sourceFile.languageVariant,
      content,
    );
    let token = scan.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        pushComment(scan.getTokenPos(), scan.getTextPos());
      }
      token = scan.scan();
    }

    store.setFileFact(ctx.filePath, "file.comments", comments);
  },
};

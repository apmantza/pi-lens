import type { FactProvider } from "../fact-provider-types.js";
import { extractFactsFromTree, walk } from "./tree-sitter-facts.js";

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
	async run(ctx, store) {
		await extractFactsFromTree(ctx, store, { "file.comments": [] }, (root) => {
			// Tree-sitter attaches comments as `comment` nodes wherever they occur; a
			// pre-order walk yields them in source order (matching the old scanner pass).
			const comments: CommentSummary[] = [];
			walk(root, (node) => {
				if (node.type === "comment") {
					comments.push({ line: node.startPosition.row + 1, text: node.text });
				}
			});
			return { "file.comments": comments };
		});
	},
};

import * as fs from "node:fs";

export interface PartiallyApplicableEdit {
	oldText: string;
	newText: string | undefined;
	originalIndex: number;
}

export interface PartialEditApplyResult {
	appliedCount: number;
	appliedIndices: string;
	postEditOutput?: string;
}

function normalizeLf(value: string): string {
	return value.replace(/\r\n/g, "\n");
}

function replaceOnce(
	content: string,
	oldText: string,
	newText: string,
): {
	content: string;
	changed: boolean;
} {
	const idx = content.indexOf(oldText);
	if (idx === -1) return { content, changed: false };
	return {
		content:
			content.slice(0, idx) + newText + content.slice(idx + oldText.length),
		changed: true,
	};
}

/**
 * Applies already-resolved oldText edits from the preflight path, then invokes
 * the caller's normal post-edit bookkeeping/pipeline hook. The edits are exact
 * LF-normalized replacements; entries that no longer match are skipped rather
 * than logged as applied.
 */
export async function applyPartiallyApplicableEdits(args: {
	filePath: string;
	edits: PartiallyApplicableEdit[];
	afterWrite?: () => Promise<string | undefined>;
}): Promise<PartialEditApplyResult> {
	const raw = fs.readFileSync(args.filePath, "utf-8");
	const useCrlf = raw.includes("\r\n");
	let content = normalizeLf(raw);
	const applied: number[] = [];

	for (const edit of args.edits) {
		const oldText = normalizeLf(edit.oldText);
		const newText = normalizeLf(edit.newText ?? "");
		const replaced = replaceOnce(content, oldText, newText);
		if (!replaced.changed) continue;
		content = replaced.content;
		applied.push(edit.originalIndex);
	}

	if (applied.length > 0) {
		fs.writeFileSync(
			args.filePath,
			useCrlf ? content.replace(/\n/g, "\r\n") : content,
			"utf-8",
		);
	}

	const postEditOutput =
		applied.length > 0 ? await args.afterWrite?.() : undefined;
	return {
		appliedCount: applied.length,
		appliedIndices: applied.map((index) => `edits[${index}]`).join(", "),
		postEditOutput,
	};
}

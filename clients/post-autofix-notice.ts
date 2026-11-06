/**
 * The single post-autofix instruction about a written file (#1590).
 *
 * Two layers used to phrase this. `clients/pipeline.ts` claimed "the attached
 * full content is authoritative" from changed-file membership alone, and
 * `clients/runtime-tool-result.ts` — the only layer that sees the per-file
 * attachment cap and the per-command aggregate budget — appended "too large to
 * attach" for the same file. On a size-capped write the agent got both.
 *
 * The wording now lives here, and `handleToolResult` is the only caller: the
 * pipeline supplies the data (display paths it already resolved) and the layer
 * that made the attachment decision picks the sentence. Keeping the renderer
 * out of `pipeline.ts` also keeps it real in tests that mock the pipeline away.
 */

/** Display-path inputs for the post-autofix notice. */
export interface PostAutofixNotice {
	/** Display path of the write target this tool result is about. */
	targetPath: string;
	/** Display paths of every file this pipeline run changed. */
	changedFiles: string[];
}

/**
 * What `handleToolResult` did with the authoritative post-autofix bytes.
 *
 * `none` means no attachment was in play at all (deferred autofix, or a
 * format-only change), so the notice stays neutral.
 */
export type AuthoritativeAttachmentDecision =
	| "attached"
	| "size-capped"
	| "aggregate-budget-degraded"
	| "none";

/** Render the ONE post-autofix instruction for `decision`. */
export function renderPostAutofixNotice(
	notice: PostAutofixNotice,
	decision: AuthoritativeAttachmentDecision,
): string {
	const topFiles = notice.changedFiles
		.slice(0, 8)
		.map((f) => "  - " + f)
		.join("\n");
	const overflow =
		notice.changedFiles.length > 8
			? "\n  - ... and " + (notice.changedFiles.length - 8) + " more"
			: "";
	const fileList = notice.changedFiles.length
		? "\nModified files:\n" + topFiles + overflow
		: "";
	switch (decision) {
		case "attached":
			return `⚠️ **The attached full content for ${notice.targetPath} is authoritative after autofix. You MUST re-read any other modified side-effect files before editing them.**${fileList}`;
		case "size-capped":
			return `⚠️ **File was modified by auto-format/fix. You MUST re-read ${notice.targetPath} before making any further edits — the authoritative content is too large to attach.**${fileList}`;
		case "aggregate-budget-degraded":
			return `⚠️ **File was modified by auto-format/fix. You MUST re-read ${notice.targetPath} before making any further edits — the aggregate authoritative content for this command is too large to attach.**${fileList}`;
		case "none":
		default:
			return `⚠️ **File was modified by auto-format/fix. You MUST re-read modified file(s) before making any further edits — the content on disk has changed (whitespace, indentation, quotes, or code). Editing from memory will produce mismatches.**${fileList}`;
	}
}

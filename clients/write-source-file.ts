/**
 * The shared seam for a pi-lens writer of source files (#5417): the root guard
 * and the queue-and-record wrapper.
 *
 * `refuseOutOfRootWrites` is the guard. A file outside the session's writable
 * roots (an adopted sibling project, a vendor path, a path no project owns) is
 * refused, and the refusal is recorded once. The formatter, `ast_grep_replace`,
 * `lens_diagnostic_mark` and `applyWorkspaceEdit` call it at the point each
 * can still refuse before its first write.
 *
 * `writeSourceFile` is the wrapper. The writer's read-modify-write runs inside
 * pi's per-file mutation queue (an agent edit cannot land between its read and
 * its write), its own authorship record runs on EVERY exit of the write
 * (success, or a throw after some files were already written), and the
 * original error is rethrown after that record. Callers: `lens_diagnostic_mark`
 * (suppress), `ast_grep_replace` (both apply paths, via `AstGrepClient`) and
 * `applyWorkspaceEdit` (every LSP writer). The formatter and the autofix
 * writers keep their own queue entry (`FileMutationHold`, #3506): they enter
 * it after their command resolves, which an install can take minutes.
 */
import { canWriteAnalysisRoot, resolveAnalysisRoot } from "./analysis-root.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { withHostFileMutationQueues } from "./file-mutation-queue.js";

/**
 * The files of `filePaths` that `writer` must NOT write: each one's identity
 * is outside the session's writable roots (`canWriteAnalysisRoot`). The
 * refusal is the verdict, so it is recorded: one `adopted-root-writer-skipped`
 * row per (file, writer) per session. An empty answer means every path may be
 * written.
 */
export function refuseOutOfRootWrites(
	filePaths: readonly string[],
	sessionRoot: string,
	writer: string,
): string[] {
	return filePaths.filter((filePath) => {
		const mode = resolveAnalysisRoot(filePath, sessionRoot);
		if (canWriteAnalysisRoot(mode)) return false;
		recordDegradationOnce({
			kind: "adopted-root-writer-skipped",
			subject: `${filePath}:${writer}`,
			reason: `${writer} refused: the file's identity is outside the session's writable roots (${mode})`,
			metadata: { writer, mode },
		});
		return true;
	});
}

/** How a write ended: its value, or the error it threw. */
export type SourceWriteExit<T> =
	| { ok: true; value: T }
	| { ok: false; error: unknown };

/**
 * Run `write` inside the mutation queue of every path in `target.filePaths`,
 * then call `target.record` with how it ended. `record` runs after the queue
 * is released, on a throw as well as on success, and its throw replaces the
 * write's (a record is bookkeeping and does not throw). The write's own throw
 * is rethrown after the record.
 */
export async function writeSourceFile<T>(
	target: {
		/** Every path `write` may write: the queue keys. */
		filePaths: readonly string[];
		/** The writer's authorship record, called once per write. */
		record: (exit: SourceWriteExit<T>) => void | Promise<void>;
	},
	write: () => Promise<T>,
): Promise<T> {
	const exit = await withHostFileMutationQueues(
		target.filePaths,
		async (): Promise<SourceWriteExit<T>> => {
			try {
				return { ok: true, value: await write() };
			} catch (error) {
				// none: the error travels in the exit and is rethrown below.
				return { ok: false, error };
			}
		},
	);
	await target.record(exit);
	if (!exit.ok) throw exit.error;
	return exit.value;
}

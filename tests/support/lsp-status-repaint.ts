import { vi } from "vitest";

/**
 * Shared seams for the LSP status-repaint cases (#281, #3099).
 *
 * Both `index-lsp-idle-reset` and `index-integration` need the same two things:
 * an alive-server holder the idle-reset double can empty (that is what makes the
 * second repaint observable) and a recorder for the `pi-lens-lsp` status writes.
 * Keeping them here means a new status-repaint case does not restate the
 * harness, and the module-mock specifiers stay in the test file, where they
 * resolve against that file's directory.
 */

/**
 * Alive-server holder + the reset spy that empties it. `overrides` are the
 * alive-set members for `installLspServiceDouble`, and `resetLSPService` goes in
 * as its `beforeReset` hook, so the real `resetLSPService(options)` the
 * extension calls reaches the spy with the same options (#4709).
 */
export function aliveServerHolder(initialAliveIds: string[] = ["typescript"]) {
	let aliveIds = initialAliveIds;
	const resetLSPService = vi.fn((_options?: unknown) => {
		aliveIds = [];
	});
	const overrides = {
		getAliveClientCount: () => aliveIds.length,
		getAliveServerIds: () => aliveIds,
	};
	return { resetLSPService, overrides };
}

/**
 * Identity-theme `ctx.ui` double that records every `setStatus` call, plus
 * `statusesFor(id)` for the writes to one key. `lspStatuses()` is the
 * `pi-lens-lsp` shorthand.
 */
export function lspStatusRecorder() {
	const statusUpdates: Array<[string, string | undefined]> = [];
	const ui = {
		notify: vi.fn(),
		setStatus: (id: string, text: string | undefined) =>
			statusUpdates.push([id, text]),
		theme: { fg: (_color: string, text: string) => text },
	};
	const statusesFor = (id: string) =>
		statusUpdates.flatMap(([key, text]) => (key === id ? [text] : []));
	const lspStatuses = () => statusesFor("pi-lens-lsp");
	return { ui, lspStatuses, statusesFor };
}

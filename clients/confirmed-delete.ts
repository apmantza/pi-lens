/**
 * The confirmed-delete verdict (#1668), shared by the two producers that evict
 * a deleted file from the read guard and tell LSP clients it is gone: the
 * native bash `tool_result` path (`clients/runtime-tool-result.ts`) and the v2
 * bridge's `delete` facet (`clients/io-bridge.ts`, #3654). Each caller keeps
 * its own flag gates and its own answer for a non-confirmed verdict; the gate
 * order lives here once.
 *
 * A dependency leaf: the gates are injected, so neither caller imports the
 * other.
 */

export type ConfirmedDeleteVerdict =
	| "out-of-scope"
	| "ignored"
	| "untracked"
	| "on-disk"
	| "confirmed";

export interface ConfirmedDeleteGates {
	/** Gate 1: vendor, or outside every workspace root. */
	isExternalOrVendorFile(filePath: string): boolean;
	/** Gate 2: ignored by a project ignore file. */
	isPathIgnoredByProject(filePath: string): boolean;
	/** Gate 3: pi-lens read or wrote this path this session. */
	hasKnownPath(filePath: string): boolean;
	/** Gate 4: the path is still on disk. */
	existsSync(filePath: string): boolean;
}

/**
 * Judge one delete candidate, in production order. The existence probe runs
 * only for a known path, so an untouched path costs no `stat`.
 */
export function judgeConfirmedDelete(
	filePath: string,
	gates: ConfirmedDeleteGates,
): ConfirmedDeleteVerdict {
	if (gates.isExternalOrVendorFile(filePath)) return "out-of-scope";
	if (gates.isPathIgnoredByProject(filePath)) return "ignored";
	if (!gates.hasKnownPath(filePath)) return "untracked";
	// #1668 review F4: this is the ONLY gate standing between a merely NAMED
	// path and an actual confirmed delete. The bash path's candidates come from
	// parsing the command text, so it cannot tell `git rm --cached f`
	// (index-only, file still on disk) from a real delete, cannot see a
	// short-circuited `rm f && false` that never ran, and cannot resolve a
	// relative path run from a `cd`-ed subdirectory against the right cwd.
	// Every one of those is caught here, and only here: do not remove or
	// reorder this check.
	if (gates.existsSync(filePath)) return "on-disk";
	return "confirmed";
}

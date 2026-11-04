/**
 * Fix Worklog for pi-lens
 *
 * Appends auto-fixed and fixable diagnostics to the project data worklog
 * so repair history is preserved across sessions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic } from "./dispatch/types.js";
import { getProjectDataDir } from "./file-utils.js";
import { redactSecrets } from "./redact/secrets.js";

// --- Types ---

export interface WorklogEntry {
	timestamp: string;
	filePath: string;
	rule: string;
	tool: string;
	message: string;
	line: number;
	column?: number;
	fixable: boolean;
	fixSuggestion?: string;
	autoFixed: boolean;
	/** Model/provider that produced the code this diagnostic fired against
	 * (#1448). Optional — blank/omitted whenever the runtime doesn't know the
	 * active identity (e.g. project-wide scans outside a live agent turn).
	 * Old entries predate these fields entirely; readers must treat both as
	 * optional. */
	model?: string;
	provider?: string;
}

/** Identity to attribute a worklog append to, when known. */
export interface WorklogIdentity {
	model?: string;
	provider?: string;
}

// --- Paths ---

export function getWorklogPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "worklog.jsonl");
}

// --- Write ---

/**
 * Append diagnostics to the worklog. Pass `autoFixed: true` for
 * diagnostics that were already fixed by the tool, `false` for
 * diagnostics that are fixable but require agent action.
 */
export function appendToWorklog(
	cwd: string,
	diagnostics: Diagnostic[],
	autoFixed: boolean,
	identity?: WorklogIdentity,
): void {
	if (diagnostics.length === 0) return;

	const worklogPath = getWorklogPath(cwd);
	try {
		fs.mkdirSync(path.dirname(worklogPath), { recursive: true });
		const timestamp = new Date().toISOString();
		const model = identity?.model?.trim() || undefined;
		const provider = identity?.provider?.trim() || undefined;
		const lines =
			diagnostics
				.map((d) => {
					const entry: WorklogEntry = {
						timestamp,
						filePath: d.filePath,
						rule: d.rule ?? d.id ?? "unknown",
						tool: d.tool,
						message: d.message,
						line: d.line ?? 1,
						column: d.column,
						fixable: d.fixable ?? false,
						fixSuggestion: d.fixSuggestion,
						autoFixed,
						model,
						provider,
					};
					return JSON.stringify(entry);
				})
				.join("\n") + "\n";
		// Diagnostic messages can quote offending source lines (e.g. a
		// secret-scanner finding), so scrub credential-shaped text before the
		// worklog reaches disk — same boundary contract as the NDJSON loggers
		// (#327). Replacements are JSON-string-safe, so each line stays parseable.
		fs.appendFileSync(worklogPath, redactSecrets(lines), "utf8");
	} catch {
		// Non-fatal — worklog write failure should never surface to the agent
	}
}

// --- Read ---

export function readWorklog(cwd: string): WorklogEntry[] {
	const worklogPath = getWorklogPath(cwd);
	try {
		const raw = fs.readFileSync(worklogPath, "utf8");
		return raw
			.split(/\r?\n/)
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as WorklogEntry];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}
